import cron from 'node-cron';
import jadwalService from './jadwalService.js';
import messageService from './messageService.js';
import { sendGroupNotification, botState } from '../bot/baileys.js';

export function startScheduler() {
  console.log('[SCHEDULER] Layanan pengingat kelas otomatis (cron) diaktifkan (interval: 1 menit).');

  // Berjalan setiap menit
  cron.schedule('* * * * *', async () => {
    try {
      if (botState.status !== 'connected' || !botState.socket) {
        return;
      }

      const targetGroupJid = await messageService.getSetting('target_group_jid');
      if (!targetGroupJid) {
        return; // Belum diset grup target
      }

      const pending = await jadwalService.getPendingReminders(new Date());
      if (pending.length === 0) return;

      for (const item of pending) {
        const { schedule, type, todayDateStr } = item;
        const templateKey = type === '5_hours' ? 'reminder_5_hours' : 'reminder_h_0';
        const template = await messageService.getTemplate(templateKey);

        const defaultContent = type === '5_hours'
          ? '📢 *PENGINGAT KELAS (5 JAM LAGI)* 📢\n\n⏰ *Waktu*    : {jam} WIB\n📚 *Matkul*   : {matkul}\n👨‍🏫 *Dosen*    : {dosen}\n📝 *Catatan*  : {note}\n\nHarap persiapkan materi tepat waktu! 🚀'
          : '🚨 *KELAS DIMULAI SEKARANG!* 🚨\n\n⏰ *Waktu*    : {jam} WIB\n📚 *Matkul*   : {matkul}\n👨‍🏫 *Dosen*    : {dosen}\n📝 *Catatan*  : {note}\n\nSilakan segera bergabung ke kelas! 🎓';

        const content = template ? template.content : defaultContent;
        const messageText = messageService.buildReminderMessage(content, schedule);

        console.log(`[SCHEDULER] Mengirim notifikasi '${type}' untuk matkul '${schedule.course_name}' ke grup: ${targetGroupJid}`);

        await sendGroupNotification(targetGroupJid, messageText, true);
        await jadwalService.markReminderSent(schedule.id, type, todayDateStr);
      }
    } catch (err) {
      console.error('[SCHEDULER] Gagal memproses pengingat kelas:', err.message);
    }
  });
}

export default {
  startScheduler
};
