import { query } from '../../config/database.js';
import { getIndonesianDayName, formatTime } from '../utils/formatter.js';

/**
 * Menghitung tanggal pertemuan berikutnya untuk jadwal tertentu.
 * Jika hari ini adalah hari jadwal dan end_time belum lewat, return tanggal hari ini.
 * Jika end_time sudah lewat atau belum harinya, return tanggal pertemuan terdekat berikutnya.
 */
export function calculateNextMeetingDate(dayOfWeek, endTimeStr, now = new Date()) {
  const days = ['minggu', 'senin', 'selasa', 'rabu', 'kamis', 'jumat', 'sabtu'];
  const targetDayIdx = days.indexOf((dayOfWeek || '').toLowerCase().trim());
  if (targetDayIdx === -1) return null;

  const currentDayIdx = now.getDay();
  let diffDays = (targetDayIdx - currentDayIdx + 7) % 7;

  if (diffDays === 0 && endTimeStr) {
    const [endH, endM] = endTimeStr.split(':').map(Number);
    const currentH = now.getHours();
    const currentM = now.getMinutes();
    if (currentH > endH || (currentH === endH && currentM >= endM)) {
      diffDays = 7;
    }
  }

  const targetDate = new Date(now.getTime() + diffDays * 24 * 60 * 60 * 1000);
  const yyyy = targetDate.getFullYear();
  const mm = String(targetDate.getMonth() + 1).padStart(2, '0');
  const dd = String(targetDate.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Membersihkan otomatis catatan tugas/bawaan 1x pakai yang jam selesai kuliahnya sudah lewat
 */
export async function cleanExpiredTempNotes() {
  try {
    await query(`
      UPDATE schedules 
      SET temp_note = NULL, temp_note_date = NULL 
      WHERE temp_note_date IS NOT NULL 
        AND TIMESTAMP(CONCAT(DATE_FORMAT(temp_note_date, '%Y-%m-%d'), ' ', end_time)) <= NOW()
    `);
  } catch (err) {
    console.error('[JADWAL] Error cleaning expired temp notes:', err.message);
  }
}

export async function getAllSchedules(isActiveOnly = false) {
  await cleanExpiredTempNotes();
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
  await cleanExpiredTempNotes();
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

/**
 * Menyimpan catatan tugas / barang bawaan sementara (1x pakai).
 * Menghitung tanggal target pertemuan berikutnya secara otomatis.
 */
export async function setTempNote(id, note) {
  const schedule = await getScheduleById(id);
  if (!schedule) throw new Error('Jadwal perkuliahan tidak ditemukan');

  const cleanNote = note ? note.trim() : null;
  if (!cleanNote) {
    await clearTempNote(id);
    return { schedule, temp_note: null, temp_note_date: null };
  }

  const targetDate = calculateNextMeetingDate(schedule.day_of_week, schedule.end_time);
  await query(`
    UPDATE schedules 
    SET temp_note = ?, temp_note_date = ? 
    WHERE id = ?
  `, [cleanNote, targetDate, id]);

  return {
    schedule: { ...schedule, temp_note: cleanNote, temp_note_date: targetDate },
    temp_note: cleanNote,
    temp_note_date: targetDate
  };
}

/**
 * Menghapus/mereset catatan tugas sementara
 */
export async function clearTempNote(id) {
  await query(`
    UPDATE schedules 
    SET temp_note = NULL, temp_note_date = NULL 
    WHERE id = ?
  `, [id]);
}

/**
 * Mendapatkan semua tugas / bawaan yang masih aktif (belum expired)
 */
export async function getActiveTasks() {
  await cleanExpiredTempNotes();
  return await query(`
    SELECT * FROM schedules 
    WHERE is_active = TRUE 
      AND temp_note IS NOT NULL 
      AND TRIM(temp_note) != ''
    ORDER BY 
      temp_note_date ASC,
      start_time ASC
  `);
}

/**
 * Mencari jadwal berdasarkan ID atau nama mata kuliah (pencarian fleksibel)
 */
export async function findScheduleByQuery(queryStr) {
  if (!queryStr) return null;
  const clean = queryStr.trim().toLowerCase();

  // 1. Cek apakah input adalah angka ID
  if (/^\d+$/.test(clean)) {
    const s = await getScheduleById(parseInt(clean, 10));
    if (s) return s;
  }

  // 2. Cek berdasarkan nama mata kuliah
  const rows = await query(`
    SELECT * FROM schedules 
    WHERE LOWER(course_name) LIKE ? 
    ORDER BY is_active DESC, id ASC
  `, [`%${clean}%`]);

  if (rows.length === 0) return null;

  // Prioritaskan exact match jika ada
  const exact = rows.find(r => r.course_name.toLowerCase() === clean);
  return exact || rows[0];
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
  markReminderSent,
  calculateNextMeetingDate,
  cleanExpiredTempNotes,
  setTempNote,
  clearTempNote,
  getActiveTasks,
  findScheduleByQuery
};

