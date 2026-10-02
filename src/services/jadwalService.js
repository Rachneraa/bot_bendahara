import { query } from '../../config/database.js';
import { getIndonesianDayName, formatTime } from '../utils/formatter.js';

export async function getAllSchedules(isActiveOnly = false) {
  const sql = isActiveOnly
    ? `SELECT * FROM schedules WHERE is_active = TRUE ORDER BY 
        FIELD(day_of_week, 'senin', 'selasa', 'rabu', 'kamis', 'jumat', 'sabtu', 'minggu'), 
        start_time ASC`
    : `SELECT * FROM schedules ORDER BY 
        FIELD(day_of_week, 'senin', 'selasa', 'rabu', 'kamis', 'jumat', 'sabtu', 'minggu'), 
        start_time ASC`;
  return await query(sql);
}

export async function getScheduleById(id) {
  const rows = await query('SELECT * FROM schedules WHERE id = ?', [id]);
  return rows[0] || null;
}

export async function getTodaySchedules(customDay = null) {
  const day = customDay || getIndonesianDayName();
  return await query(`
    SELECT * FROM schedules 
    WHERE day_of_week = ? AND is_active = TRUE 
    ORDER BY start_time ASC
  `, [day]);
}

export async function addSchedule({ day_of_week, start_time, end_time, course_name, lecturer, note = '' }) {
  const result = await query(`
    INSERT INTO schedules (day_of_week, start_time, end_time, course_name, lecturer, note, is_active)
    VALUES (?, ?, ?, ?, ?, ?, TRUE)
  `, [
    day_of_week.toLowerCase().trim(),
    start_time.trim(),
    end_time.trim(),
    course_name.trim(),
    lecturer.trim(),
    note ? note.trim() : null
  ]);
  return result.insertId;
}

export async function addBulkSchedules(list) {
  const inserted = [];
  for (const s of list) {
    const id = await addSchedule(s);
    inserted.push({ ...s, id });
  }
  return inserted;
}

export async function updateSchedule(id, { day_of_week, start_time, end_time, course_name, lecturer, note = '', is_active = true }) {
  await query(`
    UPDATE schedules 
    SET day_of_week = ?, start_time = ?, end_time = ?, course_name = ?, lecturer = ?, note = ?, is_active = ?
    WHERE id = ?
  `, [
    day_of_week.toLowerCase().trim(),
    start_time.trim(),
    end_time.trim(),
    course_name.trim(),
    lecturer.trim(),
    note ? note.trim() : null,
    is_active ? 1 : 0,
    id
  ]);
}

export async function deleteSchedule(id) {
  await query('DELETE FROM schedules WHERE id = ?', [id]);
}

export async function toggleSchedule(id) {
  await query('UPDATE schedules SET is_active = NOT is_active WHERE id = ?', [id]);
}

/**
 * Mencari jadwal yang perlu dikirimi notifikasi:
 * 1. H-5 Jam: Waktu saat ini berada di rentang 295 - 305 menit sebelum start_time
 * 2. H-0: Waktu saat ini berada di rentang 0 - 5 menit setelah start_time
 */
export async function getPendingReminders(now = new Date()) {
  const day = getIndonesianDayName(now);
  const todayDateStr = now.toISOString().slice(0, 10); // YYYY-MM-DD
  const currentMinutes = now.getHours() * 60 + now.getMinutes();

  const schedules = await getTodaySchedules(day);
  const pending = [];

  for (const s of schedules) {
    const [startH, startM] = s.start_time.split(':').map(Number);
    const startMinutes = startH * 60 + startM;
    const diff = startMinutes - currentMinutes;

    // Cek pengingat 5 Jam (antara 295 sampai 305 menit sebelum kelas)
    if (diff >= 295 && diff <= 305) {
      const alreadySent = await isReminderSent(s.id, '5_hours', todayDateStr);
      if (!alreadySent) {
        pending.push({
          schedule: s,
          type: '5_hours',
          todayDateStr
        });
      }
    }

    // Cek pengingat H-0 (antara -2 sampai 4 menit dari jam mulai)
    if (diff >= -2 && diff <= 4) {
      const alreadySent = await isReminderSent(s.id, 'h_0', todayDateStr);
      if (!alreadySent) {
        pending.push({
          schedule: s,
          type: 'h_0',
          todayDateStr
        });
      }
    }
  }

  return pending;
}

export async function isReminderSent(schedule_id, reminder_type, reminder_date) {
  const rows = await query(`
    SELECT id FROM reminder_logs 
    WHERE schedule_id = ? AND reminder_type = ? AND reminder_date = ?
    LIMIT 1
  `, [schedule_id, reminder_type, reminder_date]);
  return rows.length > 0;
}

export async function markReminderSent(schedule_id, reminder_type, reminder_date) {
  await query(`
    INSERT INTO reminder_logs (schedule_id, reminder_type, reminder_date)
    VALUES (?, ?, ?)
    ON DUPLICATE KEY UPDATE sent_at = CURRENT_TIMESTAMP
  `, [schedule_id, reminder_type, reminder_date]);
}

export default {
  getAllSchedules,
  getScheduleById,
  getTodaySchedules,
  addSchedule,
  addBulkSchedules,
  updateSchedule,
  deleteSchedule,
  toggleSchedule,
  getPendingReminders,
  isReminderSent,
  markReminderSent
};
