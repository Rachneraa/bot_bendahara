import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore
} from '@whiskeysockets/baileys';
import pino from 'pino';
import path from 'path';
import fs from 'fs';
import { isUserAdmin } from './adminHandler.js';
import { handleCommand, hasActiveSession, handleInteractiveChoice } from './commandHandler.js';
import { getSetting, setSetting } from '../services/messageService.js';
import { cleanPhoneNumber } from '../utils/formatter.js';

const AUTH_DIR = path.resolve('auth_info');
if (!fs.existsSync(AUTH_DIR)) {
  fs.mkdirSync(AUTH_DIR, { recursive: true });
}

// Global state bot yang dapat diakses oleh Web Dashboard
export const botState = {
  status: 'disconnected', // 'disconnected' | 'connecting' | 'waiting_code' | 'connected'
  pairingCode: null,
  botNumber: null,
  lastError: null,
  socket: null,
  qr: null
};

export async function initBaileys() {
  try {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version, isLatest } = await fetchLatestBaileysVersion();
    console.log(`[WA] Menggunakan Baileys v${version.join('.')} (Latest: ${isLatest})`);

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
      syncFullHistory: false
    });

    botState.socket = sock;
    botState.status = 'connecting';

    // Logika Pairing Code jika belum login
    if (!sock.authState.creds.registered) {
      setTimeout(async () => {
        try {
          // Ambil nomor dari database atau .env
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
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        botState.qr = qr;
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        botState.status = 'disconnected';
        botState.pairingCode = null;
        botState.lastError = `Disconnected (code: ${statusCode}, reason: ${lastDisconnect?.error?.message || 'unknown'})`;
        console.log(`[WA] Koneksi terputus (status: ${statusCode}). Mencoba rekoneksi: ${shouldReconnect}`);

        if (shouldReconnect) {
          setTimeout(initBaileys, 5000);
        } else {
          console.log('[WA] Sesi telah logout. Silakan hubungkan ulang nomor bot.');
          // Hapus auth_info jika logout permanen
          try {
            fs.rmSync(AUTH_DIR, { recursive: true, force: true });
            fs.mkdirSync(AUTH_DIR, { recursive: true });
          } catch (e) {
            console.error('Gagal reset auth_info:', e);
          }
          setTimeout(initBaileys, 3000);
        }
      } else if (connection === 'open') {
        botState.status = 'connected';
        botState.pairingCode = null;
        botState.botNumber = sock.user?.id ? sock.user.id.split(':')[0] : 'Aktif';
        console.log(`[WA] ✅ Bot berhasil terhubung! ID: ${sock.user?.id}`);
      }
    });

    // Event Listener Pesan Masuk
    sock.ev.on('messages.upsert', async (m) => {
      try {
        if (m.type !== 'notify') return;

        for (const msg of m.messages) {
          if (!msg.message || msg.key.fromMe) continue;

          // Ambil isi teks pesan
          const rawText = 
            msg.message.conversation ||
            msg.message.extendedTextMessage?.text ||
            msg.message.imageMessage?.caption ||
            '';

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
            // Abaikan tanpa membalas error (silent ignore)
            console.log(`[WA] Mengabaikan perintah dari non-admin: ${senderNumber}`);
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
      const metadata = await botState.socket.groupMetadata(targetGroupJid);
      mentions = metadata.participants.map(p => p.id);
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
  requestPairingCodeManual,
  sendGroupNotification
};
