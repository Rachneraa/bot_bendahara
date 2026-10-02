import { getSetting } from '../services/messageService.js';
import { cleanPhoneNumber } from '../utils/formatter.js';

/**
 * Mengecek apakah pengirim pesan memiliki otoritas Admin.
 * - Di Grup: Harus berstatus admin/superadmin di grup ATAU nomornya ada di whitelist ADMIN_NUMBERS.
 * - Di Private Chat: Nomor pengirim harus ada di whitelist ADMIN_NUMBERS.
 */
export async function isUserAdmin(sock, messageInfo) {
  try {
    const isGroup = messageInfo.isGroup;
    const senderJid = messageInfo.senderJid; // e.g. 6281234567890:2@s.whatsapp.net
    const senderNumber = cleanPhoneNumber(senderJid);

    // 1. Cek nomor pengirim di whitelist .env dan database settings
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

    if (allWhitelist.has(senderNumber)) {
      return true;
    }

    // 2. Jika di grup WhatsApp, cek apakah dia admin grup
    if (isGroup && messageInfo.groupJid) {
      const groupMetadata = await sock.groupMetadata(messageInfo.groupJid);
      const sBare = (senderJid || '').split('@')[0].split(':')[0];

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

      if (participant && (participant.admin === 'admin' || participant.admin === 'superadmin')) {
        return true;
      }
    }

    return false;
  } catch (err) {
    console.error('[AUTH] Gagal memverifikasi status admin:', err.message);
    return false;
  }
}

export default {
  isUserAdmin
};
