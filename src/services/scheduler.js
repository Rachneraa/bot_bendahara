import cron from 'node-cron';
import jadwalService from './jadwalService.js';
import messageService from './messageService.js';
import { sendGroupNotification, botState } from '../bot/baileys.js';
import { formatTime } from '../utils/formatter.js';

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

      const now = new Date();

      // 1. PROSES PENGINGAT KULIAH REGULER
      const pendingClasses = await jadwalService.getPendingReminders(now);
      for (const item of pendingClasses) {
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
          let messageText = messageService.buildReminderMessage(content, schedule);

          if (schedule.isSweatWeekException) {
            messageText = `⚠️ *[KULIAH PENGGANTI DI MINGGU TENANG]*\n\n` + messageText;
          }

          console.log(`[SCHEDULER] Mengirim notifikasi '3_hours' untuk matkul '${schedule.course_name}' ke grup: ${targetGroupJid}`);
          await sendGroupNotification(targetGroupJid, messageText, true);
          await jadwalService.markReminderSent(schedule.id, '3_hours', todayDateStr);
        }
      }

      // 2. PROSES PENGINGAT JADWAL UJIAN (UTS / UAS)
      const pendingExams = await jadwalService.getPendingExamReminders(now);
      for (const item of pendingExams) {
        if (item.type === 'exam_h1') {
          const { exams, examDateStr, todayDateStr } = item;
          const examTitle = (exams[0].exam_type || 'uts').toUpperCase();

          let listStr = '';
          exams.forEach((ex, idx) => {
            const jam = `${formatTime(ex.start_time)} s.d ${formatTime(ex.end_time)}`;
            listStr += `${idx + 1}. *${ex.course_name}*\n`;
            listStr += `   🕧 Waktu : ${jam} WIB\n`;
            listStr += `   📍 Ruang : *${ex.room}*\n`;
            listStr += `   📝 Sifat : ${ex.exam_format || 'Tatap Muka'}\n`;
            if (ex.notes) listStr += `   🎒 Catatan: ${ex.notes}\n`;
            listStr += '\n';
          });

          const msg =
            `📚 *PENGINGAT ${examTitle} BESOK (H-1 MALAM)* 📚\n\n` +
            `Diberitahukan kepada seluruh rekan kelas bahwa *BESOK* (${examDateStr}) akan dilaksanakan ujian:\n\n` +
            `${listStr.trim()}\n\n` +
            `⚠️ *PERSIAPAN UJIAN:*\n` +
            `• Wajib membawa Kartu Peserta Ujian (KPU) & KTM\n` +
            `• Bawa alat tulis lengkap & perlengkapan pendukung\n` +
            `• Hadir di ruangan minimal 15 menit sebelum ujian dimulai\n\n` +
            `_Semoga ujian besok dilancarkan dan mendapatkan hasil terbaik!_ 🌟`;

          console.log(`[SCHEDULER] Mengirim pengingat H-1 Ujian (${examTitle}) ke grup: ${targetGroupJid}`);
          await sendGroupNotification(targetGroupJid, msg, true);
          await jadwalService.markExamReminderSent(0, 'exam_h1', todayDateStr);
        } else if (item.type === 'exam_3_hours') {
          const { exam, todayDateStr } = item;
          const examTitle = (exam.exam_type || 'uts').toUpperCase();
          const jam = `${formatTime(exam.start_time)} s.d ${formatTime(exam.end_time)}`;
          const noteStr = exam.notes ? `\n🎒 *Catatan/Bawaan:* ${exam.notes}` : '';

          const msg =
            `━━━━━━━━━━━━━━━━━━━━━━━\n` +
            `📢 *PENGINGAT UJIAN ${examTitle} (3 JAM LAGI)*\n` +
            `━━━━━━━━━━━━━━━━━━━━━━━\n` +
            `📖 Mata Kuliah : *${exam.course_name}*\n` +
            `🕧 Waktu       : ${jam} WIB\n` +
            `📍 Ruangan     : *${exam.room}*\n` +
            `📝 Sifat Ujian : ${exam.exam_format || 'Tatap Muka'}${noteStr}\n` +
            `━━━━━━━━━━━━━━━━━━━━━━━\n` +
            `Segera bersiap-siap menuju kampus / ruang ujian dan jangan lupa bawa Kartu Ujian! 🚀`;

          console.log(`[SCHEDULER] Mengirim pengingat 3_hours Ujian '${exam.course_name}' (${examTitle}) ke grup: ${targetGroupJid}`);
          await sendGroupNotification(targetGroupJid, msg, true);
          await jadwalService.markExamReminderSent(exam.id, 'exam_3_hours', todayDateStr);
        }
      }
    } catch (err) {
      console.error('[SCHEDULER] Gagal memproses pengingat kelas/ujian:', err.message);
    }
  });
}

export default {
  startScheduler
};
