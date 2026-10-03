import { getSetting } from '../services/messageService.js';
import { cleanPhoneNumber } from '../utils/formatter.js';

// Cache in-memory untuk metadata grup agar terhindar dari rate-overlimit (429) Baileys
const groupMetadataCache = new Map();
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 menit

/**
 * Mengambil metadata grup dengan strategi cache + stale fallback
 */
export async function getCachedGroupMetadata(sock, groupJid) {
  if (!groupJid) return null;
  const now = Date.now();
  const cached = groupMetadataCache.get(groupJid);

  if (cached && (now - cached.timestamp) < CACHE_TTL_MS) {
    return cached.data;
  }

  try {
    const data = await sock.groupMetadata(groupJid);
    if (data && data.participants) {
      groupMetadataCache.set(groupJid, { data, timestamp: now });
      return data;
    }
  } catch (err) {
    console.warn(`[AUTH] Gagal fetch groupMetadata(${groupJid}): ${err.message}`);
    // Jika WhatsApp melempar rate-overlimit, gunakan stale cache jika tersedia
    if (cached && cached.data) {
      console.log(`[AUTH] Menggunakan data stale cache untuk grup: ${groupJid}`);
      return cached.data;
    }
  }

  return cached ? cached.data : null;
}

/**
 * Mengecek apakah pengirim pesan memiliki otoritas Admin.
 * - Di Grup: Harus berstatus admin/superadmin di grup ATAU nomornya ada di whitelist ADMIN_NUMBERS.
 * - Di Private Chat: Nomor pengirim harus ada di whitelist ADMIN_NUMBERS.
 */
export async function isUserAdmin(sock, messageInfo) {
  try {
    const isGroup = messageInfo.isGroup;
    const senderJid = messageInfo.senderJid || ''; // e.g. 6281234567890:2@s.whatsapp.net atau 12345@lid
    const senderNumber = cleanPhoneNumber(senderJid);

    // 1. Ambil nomor whitelist dari .env dan database settings
    const envAdmins = (process.env.ADMIN_NUMBERS || '')
      .split(',')
      .map(n => cleanPhoneNumber(n))
      .filter(Boolean);

    const dbAdminsStr = await getSetting('admin_numbers', '');
    const dbAdmins = dbAdminsStr
      .split(',')
      .map(n => cleanPhoneNumber(n))
      .filter(Boolean);

    const allWhitelist = new Set([...envAdmins, ...dbAdmins]);

    // Jika nomor pengirim langsung cocok dengan whitelist
    if (senderNumber && allWhitelist.has(senderNumber)) {
      return true;
    }

    // 2. Jika di dalam grup testing yang terdaftar, izinkan eksekusi
    const testGroupJid = await getSetting('test_group_jid', '');
    if (isGroup && testGroupJid && messageInfo.groupJid === testGroupJid) {
      return true;
    }

    // 3. Jika di grup WhatsApp, cek hak admin grup atau cocokkan LID ke nomor asli peserta
    if (isGroup && messageInfo.groupJid) {
      const groupMetadata = await getCachedGroupMetadata(sock, messageInfo.groupJid);
      
      if (groupMetadata && Array.isArray(groupMetadata.participants)) {
        const sBare = senderJid.split('@')[0].split(':')[0];

        const participant = groupMetadata.participants.find(p => {
          const pBare = (p.id || '').split('@')[0].split(':')[0];
          const pLidBare = (p.lid || '').split('@')[0].split(':')[0];
          const pNum = cleanPhoneNumber(p.id);

          return (
            (pBare && pBare === sBare) ||
            (pLidBare && pLidBare === sBare) ||
            (pNum && senderNumber && pNum === senderNumber)
          );
        });

        if (participant) {
          // Cek apakah nomor telepon asli dari participant ada di whitelist admin
          const participantNum = cleanPhoneNumber(participant.id);
          if (participantNum && allWhitelist.has(participantNum)) {
            return true;
          }

          // Cek apakah berstatus admin atau superadmin di grup WhatsApp
          if (participant.admin === 'admin' || participant.admin === 'superadmin') {
            return true;
          }
        }
      }
    }

    return false;
  } catch (err) {
    console.error('[AUTH] Gagal memverifikasi status admin:', err.message);
    return false;
  }
}

export default {
  isUserAdmin,
  getCachedGroupMetadata
};

