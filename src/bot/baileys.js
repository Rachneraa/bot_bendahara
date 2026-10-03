import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore
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
  botNumber: null,
  lastError: null,
  socket: null,
  qr: null,
  lastActivePing: null
};

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

      const ws = sock.ws;
      // 0: CONNECTING, 1: OPEN, 2: CLOSING, 3: CLOSED
      if (botState.status === 'connected') {
        if (!ws || ws.readyState !== 1) {
          console.warn(`[WATCHDOG] ⚠️ WebSocket tidak dalam status OPEN (readyState: ${ws?.readyState}). Memaksa rekoneksi...`);
          await forceReconnect('WebSocket readyState not OPEN');
          return;
        }

        // Setiap 60 detik kirim presence ping untuk menjaga socket TCP NAT tetap hidup
        const now = Date.now();
        if (now - lastPingTime >= 60_000) {
          lastPingTime = now;
          try {
            await sock.sendPresenceUpdate('available');
            botState.lastActivePing = new Date().toISOString();
          } catch (pingErr) {
            console.warn('[WATCHDOG] ⚠️ Ping presence gagal! Socket zombie terdeteksi:', pingErr.message);
            await forceReconnect('Ping presence failed: ' + pingErr.message);
          }
        }
      }
    } catch (err) {
      console.error('[WATCHDOG] Error watchdog:', err.message);
    }
  }, 30_000); // Evaluasi tiap 30 detik
}

export async function initBaileys() {
  if (isInitializing) {
    console.log('[WA] Inisialisasi Baileys sedang berlangsung...');
    return botState.socket;
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
    let version = [2, 3000, 1043857760];
    try {
      const vPromise = fetchLatestBaileysVersion();
      const tPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3500));
      const res = await Promise.race([vPromise, tPromise]);
      if (res && res.version) version = res.version;
    } catch (e) {
      console.warn('[WA] Menggunakan fallback Baileys version:', e.message);
    }

    console.log(`[WA] Menggunakan Baileys v${version.join('.')}`);
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
      browser: ['Ubuntu', 'Chrome', '20.0.04'],
      generateHighQualityLinkPreview: true,
      syncFullHistory: false,
      keepAliveIntervalMs: 15_000, // Ping frame tiap 15 detik agar koneksi NAT tidak ditutup firewall
      connectTimeoutMs: 30_000,
      defaultQueryTimeoutMs: 30_000,
      markOnlineOnConnect: true,
      retryRequestDelayMs: 250,
      maxMsgRetryCount: 3
    });

    botState.socket = sock;
    botState.step = sock.authState.creds.registered ? 'waiting_connection_open' : 'unregistered';

    // Jalankan watchdog heartbeat
    startWatchdog();

    // Logika Pairing Code jika belum login
    if (!sock.authState.creds.registered) {
      setTimeout(async () => {
        try {
          if (botState.socket !== sock) return; // Abaikan jika socket sudah diganti
          let targetPhone = await getSetting('bot_phone_number');
          if (!targetPhone) {
            targetPhone = process.env.BOT_PHONE_NUMBER || '';
          }

          if (targetPhone) {
            const cleaned = cleanPhoneNumber(targetPhone);
            console.log(`[WA] Meminta Pairing Code untuk nomor: ${cleaned}`);
            const code = await sock.requestPairingCode(cleaned);
            botState.pairingCode = code;
            botState.status = 'waiting_code';
            botState.botNumber = cleaned;

            console.log('\n=========================================');
            console.log(`🔑 PAIRING CODE WHATSAPP: ${code}`);
            console.log('Tautkan di WhatsApp > Perangkat Tertaut > Tautkan dengan nomor telepon');
            console.log('=========================================\n');
          } else {
            console.log('[WA] Belum ada nomor bot terdaftar. Masukkan nomor di Web Dashboard untuk meminta Pairing Code.');
            botState.status = 'disconnected';
          }
        } catch (err) {
          console.error('[WA] Gagal meminta Pairing Code:', err.message);
          botState.lastError = err.message;
        }
      }, 5000);
    }

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
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        botState.status = 'disconnected';
        botState.step = 'disconnected';
        botState.pairingCode = null;
        botState.lastError = `Disconnected (code: ${statusCode}, reason: ${lastDisconnect?.error?.message || 'unknown'})`;
        console.log(`[WA] Koneksi terputus (status: ${statusCode}). Mencoba rekoneksi: ${shouldReconnect}`);

        if (shouldReconnect) {
          setTimeout(() => {
            if (botState.status === 'disconnected') {
              initBaileys().catch(e => console.error('[WA] Reconnect error:', e.message));
            }
          }, 5000);
        } else {
          console.log('[WA] Sesi telah logout. Silakan hubungkan ulang nomor bot.');
          try {
            fs.rmSync(AUTH_DIR, { recursive: true, force: true });
            fs.mkdirSync(AUTH_DIR, { recursive: true });
          } catch (e) {
            console.error('Gagal reset auth_info:', e);
          }
          setTimeout(() => {
            initBaileys().catch(e => console.error('[WA] Re-init after logout error:', e.message));
          }, 3000);
        }
      } else if (connection === 'open') {
        botState.status = 'connected';
        botState.step = 'connected';
        botState.pairingCode = null;
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
          const isAdmin = await isUserAdmin(sock, messageInfo);
          if (!isAdmin) {
            console.log(`[WA] Mengabaikan perintah dari non-admin: ${senderNumber} (JID: ${senderJid})`);
            continue;
          }

          // Eksekusi router perintah
          await handleCommand(sock, messageInfo);
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
  if (!botState.socket) {
    throw new Error('Socket bot belum diinisialisasi.');
  }
  const cleaned = cleanPhoneNumber(phoneNumber);
  await setSetting('bot_phone_number', cleaned);
  const code = await botState.socket.requestPairingCode(cleaned);
  botState.pairingCode = code;
  botState.status = 'waiting_code';
  botState.botNumber = cleaned;
  return code;
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
  sendGroupNotification,
  extractMessageText
};
