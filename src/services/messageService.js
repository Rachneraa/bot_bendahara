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
  const jam = `${formatTime(schedule.start_time)} - ${formatTime(schedule.end_time)}`;
  return renderTemplate(templateStr, {
    matkul: schedule.course_name,
    dosen: schedule.lecturer,
    jam,
    note: schedule.note || 'Tidak ada catatan',
    hari: schedule.day_of_week.toUpperCase()
  });
}

export default {
  getTemplates,
  getTemplate,
  updateTemplate,
  getSettings,
  getSetting,
  setSetting,
  renderTemplate,
  buildReminderMessage
};
