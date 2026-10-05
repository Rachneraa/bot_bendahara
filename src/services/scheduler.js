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
        if (item.type === 'reminder_daily') {
          const { schedules, todayDateStr, day } = item;
          const template = await messageService.getTemplate('reminder_daily');
          const defaultContent =
            '📚 *JADWAL KULIAH HARI INI ({hari})* 📚\n\n' +
            'Berikut adalah jadwal perkuliahan hari ini:\n\n' +
            '{daftar_jadwal}\n\n' +
            'Semangat kuliahnya rekan-rekan! 🚀';

          const content = template ? template.content : defaultContent;
          const messageText = messageService.buildDailyScheduleMessage(content, schedules, day);

          console.log(`[SCHEDULER] Mengirim notifikasi harian 'reminder_daily' (${day.toUpperCase()}) ke grup: ${targetGroupJid}`);
          await sendGroupNotification(targetGroupJid, messageText, true);
          await jadwalService.markReminderSent(0, 'reminder_daily', todayDateStr);
        } else if (item.type === '3_hours') {
          const { schedule, todayDateStr } = item;
          const template = await messageService.getTemplate('reminder_3_hours');
          const defaultContent =
            '━━━━━━━━━━━━━━━\n📢 *PENGINGAT KULIAH (3 JAM LAGI)*\n━━━━━━━━━━━━━━━\n📖 *{matkul}*\n🕧 Waktu: {jam} WIB\n📍 Ruang: {lokasi}\n👩‍🏫 Dosen: {dosen}\n{tugas}\n━━━━━━━━━━━━━━━\nHarap persiapkan materi dan perlengkapan kelas! 🚀';

          const content = template ? template.content : defaultContent;
          const messageText = messageService.buildReminderMessage(content, schedule);

          console.log(`[SCHEDULER] Mengirim notifikasi '3_hours' untuk matkul '${schedule.course_name}' ke grup: ${targetGroupJid}`);
          await sendGroupNotification(targetGroupJid, messageText, true);
          await jadwalService.markReminderSent(schedule.id, '3_hours', todayDateStr);
        }
      }
    } catch (err) {
      console.error('[SCHEDULER] Gagal memproses pengingat kelas:', err.message);
    }
  });
}

export default {
  startScheduler
};
