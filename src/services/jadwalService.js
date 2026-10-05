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
 * Membersihkan otomatis catatan tugas 1x dan status perkuliahan khusus (batal/online/pindah)
 * setelah jam selesai perkuliahan lewat.
 */
export async function cleanExpiredOverrides() {
  try {
    // 1. Bersihkan temp_note yang sudah lewat
    await query(`
      UPDATE schedules 
      SET temp_note = NULL, temp_note_date = NULL 
      WHERE temp_note_date IS NOT NULL 
        AND TIMESTAMP(CONCAT(DATE_FORMAT(temp_note_date, '%Y-%m-%d'), ' ', end_time)) <= NOW()
    `);

    // 2. Bersihkan status override 'batal' dan 'online' yang sudah lewat
    await query(`
      UPDATE schedules 
      SET status_override = 'normal', status_note = NULL, override_date = NULL 
      WHERE status_override IN ('batal', 'online') 
        AND override_date IS NOT NULL 
        AND TIMESTAMP(CONCAT(DATE_FORMAT(override_date, '%Y-%m-%d'), ' ', end_time)) <= NOW()
    `);

    // 3. Bersihkan status override 'pindah' setelah jam selesai kuliah pengganti lewat
    await query(`
      UPDATE schedules 
      SET status_override = 'normal', status_note = NULL, override_date = NULL,
          override_day = NULL, override_start_time = NULL, override_end_time = NULL, override_location = NULL
      WHERE status_override = 'pindah' 
        AND override_date IS NOT NULL 
        AND TIMESTAMP(CONCAT(DATE_FORMAT(override_date, '%Y-%m-%d'), ' ', COALESCE(override_end_time, end_time))) <= NOW()
    `);
  } catch (err) {
    console.error('[JADWAL] Error cleaning expired overrides:', err.message);
  }
}

export const cleanExpiredTempNotes = cleanExpiredOverrides;

export async function getAllSchedules(isActiveOnly = false) {
  await cleanExpiredOverrides();
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
  await cleanExpiredOverrides();
  const day = (customDay || getIndonesianDayName()).toLowerCase().trim();
  return await query(`
    SELECT * FROM schedules 
    WHERE is_active = TRUE 
      AND (
        (day_of_week = ? AND (status_override != 'pindah' OR status_override IS NULL))
        OR (status_override = 'pindah' AND override_day = ?)
      )
    ORDER BY 
      CASE 
        WHEN status_override = 'pindah' AND override_day = ? THEN override_start_time 
        ELSE start_time 
      END ASC
  `, [day, day, day]);
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
 * 1. Pengingat Hari-H (Jam 00:00 WIB): Mengirimkan 1 pesan rangkuman seluruh jadwal hari itu.
 * 2. Pengingat H-3 Jam Sebelum Kelas: Rentang 175 - 185 menit sebelum kelas dimulai.
 */
export async function getPendingReminders(now = new Date()) {
  await cleanExpiredOverrides();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const todayDateStr = `${yyyy}-${mm}-${dd}`;
  const day = getIndonesianDayName(now).toLowerCase().trim();
  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  const currentHour = now.getHours();
  const currentMinute = now.getMinutes();

  const schedules = await getTodaySchedules(day);
  const pending = [];

  // 1. Pengingat Jam 00:00 (H-0 / Hari Itu)
  // Window toleransi: 00:00 - 00:05 WIB
  if (currentHour === 0 && currentMinute >= 0 && currentMinute <= 5) {
    const alreadySentDaily = await isReminderSent(0, 'reminder_daily', todayDateStr);
    if (!alreadySentDaily) {
      // Hanya kirim jika ada matkul hari ini yang aktif / tidak dibatalkan
      const activeClasses = schedules.filter(s => s.status_override !== 'batal');
      if (activeClasses.length > 0) {
        pending.push({
          type: 'reminder_daily',
          schedules,
          todayDateStr,
          day
        });
      }
    }
  }

  // 2. Pengingat H-3 Jam Sebelum Kelas (Rentang 175 - 185 menit sebelum start_time)
  for (const s of schedules) {
    // JIKA KELAS DIBATALKAN / KOSONG: JANGAN KIRIM PENGINGAT
    if (s.status_override === 'batal') {
      continue;
    }

    const effectiveStartTime = (s.status_override === 'pindah' && s.override_day === day && s.override_start_time)
      ? s.override_start_time
      : s.start_time;

    const [startH, startM] = effectiveStartTime.split(':').map(Number);
    const startMinutes = startH * 60 + startM;
    const diff = startMinutes - currentMinutes;

    // Cek pengingat 3 Jam (antara 175 sampai 185 menit sebelum kelas)
    if (diff >= 175 && diff <= 185) {
      const alreadySent = await isReminderSent(s.id, '3_hours', todayDateStr);
      if (!alreadySent) {
        pending.push({
          schedule: s,
          type: '3_hours',
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

/**
 * Menandai kelas BATAL / KOSONG untuk 1x pertemuan terdekat
 */
export async function setClassCancelled(id, reason = '') {
  const schedule = await getScheduleById(id);
  if (!schedule) throw new Error('Jadwal perkuliahan tidak ditemukan');

  const targetDate = calculateNextMeetingDate(schedule.day_of_week, schedule.end_time);
  const cleanReason = reason ? reason.trim() : 'Dosen berhalangan hadir / kelas kosong';

  await query(`
    UPDATE schedules 
    SET status_override = 'batal', status_note = ?, override_date = ? 
    WHERE id = ?
  `, [cleanReason, targetDate, id]);

  return { ...schedule, status_override: 'batal', status_note: cleanReason, override_date: targetDate };
}

/**
 * Mengalihkan kelas menjadi KULIAH ONLINE (DARING) untuk 1x pertemuan terdekat
 */
export async function setClassOnline(id, linkInfo = '') {
  const schedule = await getScheduleById(id);
  if (!schedule) throw new Error('Jadwal perkuliahan tidak ditemukan');

  const targetDate = calculateNextMeetingDate(schedule.day_of_week, schedule.end_time);
  const cleanLink = linkInfo ? linkInfo.trim() : 'Via Zoom / Google Meet (link menyusul)';

  await query(`
    UPDATE schedules 
    SET status_override = 'online', status_note = ?, override_date = ? 
    WHERE id = ?
  `, [cleanLink, targetDate, id]);

  return { ...schedule, status_override: 'online', status_note: cleanLink, override_date: targetDate };
}

/**
 * Memindahkan jadwal perkuliahan (Kuliah Pengganti) untuk 1x pertemuan
 */
export async function setClassRescheduled(id, { newDay, startTime, endTime, newLocation = '' }) {
  const schedule = await getScheduleById(id);
  if (!schedule) throw new Error('Jadwal perkuliahan tidak ditemukan');

  const cleanDay = newDay.toLowerCase().trim();
  const cleanStart = startTime.length === 5 ? `${startTime}:00` : startTime;
  const cleanEnd = endTime.length === 5 ? `${endTime}:00` : endTime;
  const cleanLoc = newLocation ? newLocation.trim() : (schedule.note || 'Sesuai info');
  const targetDate = calculateNextMeetingDate(cleanDay, cleanEnd);
  const noteText = `Pindah ke ${cleanDay.toUpperCase()} (${startTime} - ${endTime} WIB) di ${cleanLoc}`;

  await query(`
    UPDATE schedules 
    SET status_override = 'pindah', 
        status_note = ?, 
        override_date = ?, 
        override_day = ?, 
        override_start_time = ?, 
        override_end_time = ?, 
        override_location = ?
    WHERE id = ?
  `, [noteText, targetDate, cleanDay, cleanStart, cleanEnd, cleanLoc, id]);

  return {
    ...schedule,
    status_override: 'pindah',
    status_note: noteText,
    override_date: targetDate,
    override_day: cleanDay,
    override_start_time: cleanStart,
    override_end_time: cleanEnd,
    override_location: cleanLoc
  };
}

/**
 * Mengembalikan status kelas ke NORMAL (Reguler)
 */
export async function resetClassStatus(id) {
  const schedule = await getScheduleById(id);
  if (!schedule) throw new Error('Jadwal perkuliahan tidak ditemukan');

  await query(`
    UPDATE schedules 
    SET status_override = 'normal', status_note = NULL, override_date = NULL,
        override_day = NULL, override_start_time = NULL, override_end_time = NULL, override_location = NULL
    WHERE id = ?
  `, [id]);

  return { ...schedule, status_override: 'normal', status_note: null };
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
  cleanExpiredOverrides,
  setTempNote,
  clearTempNote,
  getActiveTasks,
  findScheduleByQuery,
  setClassCancelled,
  setClassOnline,
  setClassRescheduled,
  resetClassStatus
};

