import { query } from '../../config/database.js';
import { formatTime } from '../utils/formatter.js';

export async function getTemplates() {
  return await query('SELECT * FROM message_templates ORDER BY key_name ASC');
}

export async function getTemplate(key_name) {
  const rows = await query('SELECT * FROM message_templates WHERE key_name = ?', [key_name]);
  return rows[0] || null;
}

export async function updateTemplate(key_name, { title, content }) {
  await query(`
    UPDATE message_templates 
    SET title = ?, content = ? 
    WHERE key_name = ?
  `, [title.trim(), content.trim(), key_name]);
}

export async function getSettings() {
  const rows = await query('SELECT * FROM settings');
  const map = {};
  for (const r of rows) {
    map[r.key_name] = r.value;
  }
  return map;
}

export async function getSetting(key_name, defaultValue = '') {
  const rows = await query('SELECT value FROM settings WHERE key_name = ?', [key_name]);
  return rows.length > 0 ? (rows[0].value || defaultValue) : defaultValue;
}

export async function setSetting(key_name, value) {
  await query(`
    INSERT INTO settings (key_name, value)
    VALUES (?, ?)
    ON DUPLICATE KEY UPDATE value = VALUES(value)
  `, [key_name, String(value)]);
}

/**
 * Mengganti variabel placeholder seperti {matkul}, {dosen}, {jam}, {note}, {hari}
 */
export function renderTemplate(templateStr, variables = {}) {
  let rendered = templateStr;
  for (const [key, val] of Object.entries(variables)) {
    const regex = new RegExp(`\\{${key}\\}`, 'gi');
    rendered = rendered.replace(regex, val !== null && val !== undefined ? String(val) : '-');
  }
  return rendered;
}

export function buildReminderMessage(templateStr, schedule) {
  const isPindah = schedule.status_override === 'pindah';
  const effectiveStart = isPindah && schedule.override_start_time ? schedule.override_start_time : schedule.start_time;
  const effectiveEnd = isPindah && schedule.override_end_time ? schedule.override_end_time : schedule.end_time;
  const jam = `${formatTime(effectiveStart)} s.d ${formatTime(effectiveEnd)}`;

  let lokasi = schedule.note ? schedule.note.trim() : 'Sesuai jadwal';
  if (schedule.status_override === 'online') {
    lokasi = `💻 KULIAH ONLINE (DARING)\n  🔗 Link: ${schedule.status_note || 'Via online'}`;
  } else if (isPindah) {
    lokasi = `${schedule.override_location || lokasi} (Kuliah Pengganti)`;
  }

  const hasTask = schedule.temp_note && schedule.temp_note.trim();
  const taskText = hasTask ? `📌 Tugas: ${schedule.temp_note.trim()}` : '';

  let rendered = templateStr;

  // Jika tidak ada tugas, sembunyikan baris {tugas} secara bersih
  if (!hasTask) {
    rendered = rendered.replace(/(\r?\n)?[^\S\r\n]*\{tugas\}[^\S\r\n]*/gi, '');
  } else {
    rendered = rendered.replace(/\{tugas\}/gi, taskText);
  }

  // Backwards compatibility untuk {note} jika masih digunakan
  let legacyNote = lokasi;
  if (hasTask) {
    legacyNote += `\n📌 *Tugas/Bawaan:* ${schedule.temp_note.trim()}`;
  }

  const hariDisplay = (isPindah && schedule.override_day ? schedule.override_day : schedule.day_of_week).toUpperCase();

  return renderTemplate(rendered, {
    matkul: schedule.course_name,
    dosen: schedule.lecturer,
    jam,
    lokasi,
    ruang: lokasi,
    note: legacyNote,
    hari: hariDisplay
  });
}

export function buildDailyScheduleMessage(templateStr, schedules, dayName) {
  let listStr = '';
  if (!schedules || schedules.length === 0) {
    listStr = '🎉 _Tidak ada perkuliahan hari ini!_';
  } else {
    listStr = schedules.map(s => {
      const isBatal = s.status_override === 'batal';
      const isOnline = s.status_override === 'online';
      const isPindah = s.status_override === 'pindah';

      if (isBatal) {
        let card = `• ❌ ~📖 *${s.course_name}*~ *(DIBATALKAN / KOSONG)*\n`;
        card += `  🕧 ${formatTime(s.start_time)} s.d ${formatTime(s.end_time)} WIB\n`;
        if (s.status_note) card += `  📝 Alasan: ${s.status_note}\n`;
        card += `  👩‍🏫 ${s.lecturer}`;
        return card;
      }

      if (isOnline) {
        let card = `• 💻 📖 *${s.course_name}* *(KULIAH ONLINE)*\n`;
        card += `  🕧 ${formatTime(s.start_time)} s.d ${formatTime(s.end_time)} WIB\n`;
        card += `  🔗 Link: ${s.status_note || 'Via daring'}\n`;
        card += `  👩‍🏫 ${s.lecturer}`;
        if (s.temp_note) card += `\n  📌 *Tugas/Bawaan:* ${s.temp_note}`;
        return card;
      }

      if (isPindah) {
        const effectiveStart = s.override_start_time || s.start_time;
        const effectiveEnd = s.override_end_time || s.end_time;
        const effectiveLoc = s.override_location || s.note || 'Sesuai info';
        let card = `• 🔄 📖 *${s.course_name}* *(KULIAH PENGGANTI)*\n`;
        card += `  🕧 ${formatTime(effectiveStart)} s.d ${formatTime(effectiveEnd)} WIB\n`;
        card += `  📍 Lokasi: ${effectiveLoc}\n`;
        card += `  👩‍🏫 ${s.lecturer}`;
        if (s.temp_note) card += `\n  📌 *Tugas/Bawaan:* ${s.temp_note}`;
        return card;
      }

      let card = `• 📖 *${s.course_name}*\n`;
      card += `  🕧 ${formatTime(s.start_time)} s.d ${formatTime(s.end_time)} WIB\n`;
      if (s.note) card += `  📍 ${s.note}\n`;
      card += `  👩‍🏫 ${s.lecturer}`;
      if (s.temp_note) card += `\n  📌 *Tugas/Bawaan:* ${s.temp_note}`;
      return card;
    }).join('\n\n');
  }

  let rendered = templateStr;
  rendered = rendered.replace(/\{hari\}/gi, (dayName || '').toUpperCase());
  rendered = rendered.replace(/\{daftar_jadwal\}/gi, listStr);
  return rendered;
}

export default {
  getTemplates,
  getTemplate,
  updateTemplate,
  getSettings,
  getSetting,
  setSetting,
  renderTemplate,
  buildReminderMessage,
  buildDailyScheduleMessage
};
