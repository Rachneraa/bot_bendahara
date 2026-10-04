import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestWaWebVersion,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  Browsers
} from '@whiskeysockets/baileys';
import pino from 'pino';
import path from 'path';
import fs from 'fs';
import { isUserAdmin, getCachedGroupMetadata } from './adminHandler.js';
import { handleCommand, hasActiveSession, handleInteractiveChoice } from './commandHandler.js';
import { getSetting, setSetting } from '../services/messageService.js';
import { cleanPhoneNumber } from '../utils/formatter.js';

import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const AUTH_DIR = path.resolve(__dirname, '../../auth_info');
if (!fs.existsSync(AUTH_DIR)) {
  fs.mkdirSync(AUTH_DIR, { recursive: true });
}

// Global state bot yang dapat diakses oleh Web Dashboard & Health Check
export const botState = {
  status: 'disconnected', // 'disconnected' | 'connecting' | 'waiting_code' | 'connected'
  step: 'idle',
  pairingCode: null,
  pairingCodeCreatedAt: null,
  botNumber: null,
  lastError: null,
  socket: null,
  qr: null,
  lastActivePing: null
};

export const recentMessageLogs = [];
export function addMessageLog(entry) {
  recentMessageLogs.unshift({
    time: new Date().toISOString(),
    ...entry
  });
  if (recentMessageLogs.length > 30) recentMessageLogs.pop();
}

let isInitializing = false;
let watchdogInterval = null;
let lastPingTime = 0;

/**
 * Hancurkan socket lama tanpa memicu event loop rekoneksi
 */
function destroySocket(sock, reason = 'Socket destroyed') {
  if (!sock) return;
  try {
    sock.ev?.removeAllListeners('connection.update');
    sock.ev?.removeAllListeners('creds.update');
    sock.ev?.removeAllListeners('messages.upsert');
  } catch (_) {}
  try { sock.ws?.terminate(); } catch (_) {}
  try { sock.end(new Error(reason)); } catch (_) {}
}

/**
 * Ekstrak teks pesan WhatsApp secara komprehensif,
 * mendukung ephemeral (pesan sementara), view-once, caption media, dan pesan biasa.
 */
export function extractMessageText(msg) {
  if (!msg || !msg.message) return '';
  const m = msg.message;
  const inner =
    m.ephemeralMessage?.message ||
    m.viewOnceMessage?.message ||
    m.viewOnceMessageV2?.message ||
    m.documentWithCaptionMessage?.message ||
    m;

  return (
    inner.conversation ||
    inner.extendedTextMessage?.text ||
    inner.imageMessage?.caption ||
    inner.videoMessage?.caption ||
    inner.documentMessage?.caption ||
    m.conversation ||
    m.extendedTextMessage?.text ||
    ''
  );
}

/**
 * Memaksa pembersihan socket lama dan melakukan inisialisasi ulang
 */
export async function forceReconnect(reason = 'Manual/Watchdog Reconnect') {
  if (isInitializing) {
    console.log(`[WA] Inisialisasi sedang berlangsung, lewati forceReconnect (${reason})`);
    return botState.socket;
  }
  console.log(`[WA] 🔄 Memicu forceReconnect: ${reason}`);
  const oldSock = botState.socket;
  botState.socket = null;
  destroySocket(oldSock, reason);

  botState.status = 'disconnected';
  botState.step = 'disconnected';
  botState.lastError = reason;
  return await initBaileys();
}

/**
 * Cek apakah socket WebSocket Baileys benar-benar berstatus OPEN
 */
export function isSocketOpen(sock) {
  if (!sock || !sock.ws) return false;
  return sock.ws.isOpen === true || sock.ws.socket?.readyState === 1;
}

/**
 * Background Watchdog untuk mendeteksi TCP half-open (zombie connection)
 * Menjaga NAT router/cPanel tidak memutus idle socket selama berjam-jam
 */
function startWatchdog() {
  if (watchdogInterval) clearInterval(watchdogInterval);
  watchdogInterval = setInterval(async () => {
    try {
      if (process.env.ENABLE_WHATSAPP === 'false') return;

      const sock = botState.socket;
      if (!sock) return;

      if (botState.status === 'connected') {
        if (!isSocketOpen(sock)) {
          console.warn('[WATCHDOG] ⚠️ WebSocket tidak dalam status OPEN. Memaksa rekoneksi...');
          await forceReconnect('WebSocket state not OPEN');
          return;
        }

        // Catat waktu aktif. TCP keepalive sudah dijaga otomatis oleh WebSocket transport (keepAliveIntervalMs: 15_000)
        // Jangan panggil sendPresenceUpdate('available') di interval berkala karena akan memicu deteksi bot WhatsApp (Logout 401).
        botState.lastActivePing = new Date().toISOString();
      }
    } catch (err) {
      console.error('[WATCHDOG] Error watchdog:', err.message);
    }
  }, 30_000); // Evaluasi tiap 30 detik
}

const LOCK_FILE = path.join(AUTH_DIR, 'bot.pid');

export function acquireBotLock() {
  try {
    if (fs.existsSync(LOCK_FILE)) {
      const existingPid = parseInt(fs.readFileSync(LOCK_FILE, 'utf-8').trim(), 10);
      if (existingPid && existingPid !== process.pid) {
        try {
          process.kill(existingPid, 0);
          console.warn(`[WA] ⚠️ Sesi bot Baileys sudah aktif di proses PID: ${existingPid}. Mencegah socket ganda.`);
          botState.status = 'disconnected';
          botState.lastError = `Bot sedang aktif di proses PID: ${existingPid}. Matikan proses lama terlebih dahulu agar tidak saling kick/logout.`;
          return false;
        } catch (_) {
          // Process lama sudah mati, boleh ambil alih lock
        }
      }
    }
    fs.writeFileSync(LOCK_FILE, String(process.pid));
    return true;
  } catch (err) {
    console.warn('[WA] Gagal mengunci bot.pid:', err.message);
    return true;
  }
}

export function releaseBotLock() {
  try {
    if (fs.existsSync(LOCK_FILE)) {
      const existingPid = parseInt(fs.readFileSync(LOCK_FILE, 'utf-8').trim(), 10);
      if (existingPid === process.pid) {
        fs.unlinkSync(LOCK_FILE);
      }
    }
  } catch (_) {}
}

process.on('exit', releaseBotLock);
process.on('SIGINT', () => { releaseBotLock(); process.exit(0); });
process.on('SIGTERM', () => { releaseBotLock(); process.exit(0); });

export async function initBaileys() {
  if (isInitializing) {
    console.log('[WA] Inisialisasi Baileys sedang berlangsung...');
    return botState.socket;
  }

  if (!acquireBotLock()) {
    return null;
  }

  isInitializing = true;
  botState.step = 'starting';
  botState.status = 'connecting';

  // Bersihkan socket lama tanpa memicu listener rekoneksi ganda
  if (botState.socket) {
    const oldSock = botState.socket;
    botState.socket = null;
    destroySocket(oldSock, 'Replaced by initBaileys');
  }

  try {
    botState.step = 'loading_auth';
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

    botState.step = 'fetching_version';
    let version = [2, 3000, 1049240009];
    try {
      const vPromise = typeof fetchLatestWaWebVersion === 'function' ? fetchLatestWaWebVersion() : fetchLatestBaileysVersion();
      const tPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000));
      const res = await Promise.race([vPromise, tPromise]);
      if (res && res.version) version = res.version;
    } catch (e) {
      console.warn('[WA] Menggunakan fallback WhatsApp Web version:', e.message);
    }

    console.log(`[WA] Menggunakan Baileys WhatsApp Web v${version.join('.')}`);
    botState.step = 'creating_socket';

    const logger = pino({ level: 'silent' });

    const sock = makeWASocket({
      version,
      logger,
      printQRInTerminal: false,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger)
      },
      browser: Browsers.ubuntu('Chrome'),
      generateHighQualityLinkPreview: true,
      syncFullHistory: false,
      keepAliveIntervalMs: 25_000,
      connectTimeoutMs: 60_000,
      defaultQueryTimeoutMs: 60_000,
      retryRequestDelayMs: 500
    });

    botState.socket = sock;
    botState.step = sock.authState.creds.registered ? 'waiting_connection_open' : 'unregistered';

    // Jalankan watchdog heartbeat
    startWatchdog();

    // Event Listener Kredensial
    sock.ev.on('creds.update', saveCreds);

    // Event Listener Koneksi
    sock.ev.on('connection.update', async (update) => {
      // Pastikan event ini hanya milik socket aktif saat ini
      if (botState.socket !== sock) {
        return;
      }

      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        botState.qr = qr;
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        botState.status = 'disconnected';
        botState.step = 'disconnected';
        if (!botState.pairingCodeCreatedAt || Date.now() - botState.pairingCodeCreatedAt > 60_000) {
          botState.pairingCode = null;
          botState.pairingCodeCreatedAt = null;
        }
        botState.lastError = `Disconnected (code: ${statusCode}, reason: ${lastDisconnect?.error?.message || 'unknown'})`;
        console.log(`[WA] Koneksi terputus (status: ${statusCode}). Mencoba rekoneksi...`);

        // Mencoba reconnect secara berkala tanpa menghapus auth_info sembarangan
        // Kredensial hanya dihapus bersih jika admin sengaja menekan tombol 'Reset Sesi' di Web Dashboard
        setTimeout(() => {
          if (botState.status === 'disconnected') {
            initBaileys().catch(e => console.error('[WA] Reconnect error:', e.message));
          }
        }, 5000);
      } else if (connection === 'open') {
        botState.status = 'connected';
        botState.step = 'connected';
        botState.pairingCode = null;
        botState.pairingCodeCreatedAt = null;
        botState.lastError = null;
        botState.botNumber = sock.user?.id ? sock.user.id.split(':')[0] : 'Aktif';
        botState.lastActivePing = new Date().toISOString();
        lastPingTime = Date.now();
        console.log(`[WA] ✅ Bot berhasil terhubung! ID: ${sock.user?.id}`);
      }
    });

    // Event Listener Pesan Masuk
    sock.ev.on('messages.upsert', async (m) => {
      try {
        if (botState.socket !== sock) return;
        if (m.type !== 'notify') return;

        for (const msg of m.messages) {
          if (!msg.message || msg.key.fromMe) continue;

          // Ambil isi teks pesan secara komprehensif
          const rawText = extractMessageText(msg);

          const fromJid = msg.key.remoteJid;
          const isGroup = fromJid.endsWith('@g.us');
          const senderJid = isGroup ? (msg.key.participant || msg.participant) : fromJid;
          const senderNumber = cleanPhoneNumber(senderJid);

          const messageInfo = {
            rawText,
            fromJid,
            isGroup,
            groupJid: isGroup ? fromJid : null,
            senderJid,
            senderNumber,
            rawMsg: msg
          };

          const sessionKey = `${fromJid}_${senderNumber}`;
          const isPending = hasActiveSession(sessionKey);
          const trimmed = rawText.trim().toLowerCase();
          const isChoiceInput = /^(?:!bot\s+)?(\d+|batal|cancel)$/i.test(trimmed);

          // Jika ada sesi konfirmasi nama aktif dan admin membalas pilihan (misal: 1, 2, batal)
          if (isPending && isChoiceInput) {
            const isAdmin = await isUserAdmin(sock, messageInfo);
            if (isAdmin) {
              await handleInteractiveChoice(sock, messageInfo, sessionKey);
              continue;
            }
          }

          // Hanya proses pesan yang diawali '!bot'
          if (!trimmed.startsWith('!bot')) {
            continue;
          }

          // Verifikasi hak akses Admin (Admin Grup atau Whitelist)
          let isAdmin = false;
          try {
            isAdmin = await isUserAdmin(sock, messageInfo);
          } catch (authErr) {
            console.error('[AUTH ERROR]', authErr.message);
          }

          addMessageLog({
            fromJid,
            isGroup,
            senderJid,
            senderNumber,
            pushName: msg.pushName || null,
            rawText,
            isAdmin
          });

          // Eksekusi router perintah (perintah publik tetap berjalan, perintah admin diproteksi di router)
          await handleCommand(sock, messageInfo, isAdmin);
        }
      } catch (err) {
        console.error('[WA] Error saat memproses pesan:', err);
      }
    });

    return sock;
  } catch (error) {
    console.error('[WA] Gagal inisialisasi Baileys:', error);
    botState.status = 'disconnected';
    botState.lastError = error.message;
    return null;
  } finally {
    isInitializing = false;
  }
}

/**
 * Meminta pairing code baru berdasarkan nomor yang diinput dari Web Dashboard
 */
export async function requestPairingCodeManual(phoneNumber) {
  const cleaned = cleanPhoneNumber(phoneNumber);
  await setSetting('bot_phone_number', cleaned);

  if (!botState.socket || !isSocketOpen(botState.socket)) {
    console.log('[WA] Menginisialisasi socket bot untuk pairing...');
    await initBaileys();
    for (let i = 0; i < 20; i++) {
      if (botState.socket && isSocketOpen(botState.socket)) break;
      await new Promise(r => setTimeout(r, 400));
    }
  }

  if (!botState.socket) {
    throw new Error('Socket bot belum siap. Silakan tunggu beberapa detik dan coba lagi.');
  }

  console.log(`[WA] Meminta Pairing Code untuk nomor: ${cleaned}`);
  const code = await botState.socket.requestPairingCode(cleaned);
  botState.pairingCode = code;
  botState.pairingCodeCreatedAt = Date.now();
  botState.status = 'waiting_code';
  botState.botNumber = cleaned;
  return code;
}

/**
 * Reset total sesi WhatsApp (menghapus folder auth_info dan membuat socket segar)
 */
export async function resetAuthSession() {
  console.log('[WA] 🧹 Membersihkan sesi WhatsApp (auth_info)...');
  if (botState.socket) {
    const oldSock = botState.socket;
    botState.socket = null;
    destroySocket(oldSock, 'Manual session reset');
  }
  try {
    fs.rmSync(AUTH_DIR, { recursive: true, force: true });
    fs.mkdirSync(AUTH_DIR, { recursive: true });
  } catch (e) {
    console.error('[WA] Gagal hapus auth_info:', e.message);
  }
  botState.status = 'disconnected';
  botState.step = 'disconnected';
  botState.pairingCode = null;
  botState.lastError = 'Sesi telah direset. Silakan minta pairing code baru.';
  return await initBaileys();
}

/**
 * Mengirim pesan ke grup target dengan opsi mention seluruh anggota (@everyone)
 */
export async function sendGroupNotification(targetGroupJid, text, mentionAll = true) {
  if (!botState.socket || botState.status !== 'connected') {
    throw new Error('Bot belum terhubung ke WhatsApp.');
  }

  let mentions = [];
  if (mentionAll) {
    try {
      const metadata = await getCachedGroupMetadata(botState.socket, targetGroupJid);
      if (metadata && Array.isArray(metadata.participants)) {
        mentions = metadata.participants.map(p => p.id);
      }
    } catch (e) {
      console.warn('[WA] Gagal mengambil metadata grup untuk mention all:', e.message);
    }
  }

  return await botState.socket.sendMessage(targetGroupJid, {
    text,
    mentions
  });
}

export default {
  botState,
  initBaileys,
  forceReconnect,
  requestPairingCodeManual,
  resetAuthSession,
  sendGroupNotification,
  extractMessageText,
  isSocketOpen,
  recentMessageLogs
};
