import { query } from '../../config/database.js';
import { getWeekNumber } from '../utils/formatter.js';

export async function getSaldoSummary() {
  const [row] = await query(`
    SELECT 
      COALESCE(SUM(CASE WHEN type = 'masuk' THEN amount ELSE 0 END), 0) AS total_masuk,
      COALESCE(SUM(CASE WHEN type = 'keluar' THEN amount ELSE 0 END), 0) AS total_keluar,
      COALESCE(SUM(CASE WHEN type = 'masuk' THEN amount ELSE -amount END), 0) AS saldo
    FROM kas_transactions
  `);
  return {
    totalMasuk: Number(row?.total_masuk || 0),
    totalKeluar: Number(row?.total_keluar || 0),
    saldo: Number(row?.saldo || 0)
  };
}

export async function getRecentTransactions(limit = 10) {
  const rows = await query(`
    SELECT 
      t.id,
      t.type,
      t.amount,
      t.description,
      t.source,
      t.created_by,
      t.created_at,
      m.name AS member_name
    FROM kas_transactions t
    LEFT JOIN members m ON t.member_id = m.id
    ORDER BY t.created_at DESC, t.id DESC
    LIMIT ?
  `, [limit]);
  return rows;
}

export async function addTransaction({ type, amount, member_id = null, description, source = 'web_dashboard', created_by }) {
  const result = await query(`
    INSERT INTO kas_transactions (type, amount, member_id, description, source, created_by)
    VALUES (?, ?, ?, ?, ?, ?)
  `, [type, amount, member_id, description, source, created_by]);

  return result.insertId;
}

export async function getMembers(isActiveOnly = false) {
  const sql = isActiveOnly 
    ? 'SELECT * FROM members WHERE is_active = TRUE ORDER BY name ASC'
    : 'SELECT * FROM members ORDER BY name ASC';
  return await query(sql);
}

export async function addMember({ name, phone_number = null }) {
  const result = await query(
    'INSERT INTO members (name, phone_number, is_active) VALUES (?, ?, TRUE)',
    [name.trim(), phone_number ? phone_number.trim() : null]
  );
  return result.insertId;
}

export async function addBulkMembers(memberList) {
  if (!memberList || memberList.length === 0) return 0;
  let count = 0;
  for (const m of memberList) {
    if (!m.name || !m.name.trim()) continue;
    await query(
      'INSERT INTO members (name, phone_number, is_active) VALUES (?, ?, TRUE)',
      [m.name.trim(), m.phone_number ? m.phone_number.trim() : null]
    );
    count++;
  }
  return count;
}

export async function updateMember(id, { name, phone_number, is_active }) {
  await query(
    'UPDATE members SET name = ?, phone_number = ?, is_active = ? WHERE id = ?',
    [name.trim(), phone_number ? phone_number.trim() : null, is_active ? 1 : 0, id]
  );
}

export async function deleteMember(id) {
  await query('DELETE FROM members WHERE id = ?', [id]);
}

export async function findMemberByName(keyword) {
  const rows = await query(
    'SELECT * FROM members WHERE LOWER(name) LIKE ? AND is_active = TRUE LIMIT 1',
    [`%${keyword.toLowerCase().trim()}%`]
  );
  return rows[0] || null;
}

export async function recordIuranWeekly({ member_id, week_number, year, amount, created_by, source = 'bot_wa' }) {
  const [member] = await query('SELECT name FROM members WHERE id = ?', [member_id]);
  const memberName = member ? member.name : `Member #${member_id}`;
  const desc = `Iuran Kas Minggu ke-${week_number} (${year}) - ${memberName}`;

  // Catat transaksi kas
  const txId = await addTransaction({
    type: 'masuk',
    amount,
    member_id,
    description: desc,
    source,
    created_by
  });

  // Simpan record iuran weekly
  await query(`
    INSERT INTO iuran_weekly (member_id, week_number, year, amount, transaction_id)
    VALUES (?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE 
      amount = VALUES(amount),
      transaction_id = VALUES(transaction_id),
      paid_at = CURRENT_TIMESTAMP
  `, [member_id, week_number, year, amount, txId]);

  return { txId, memberName };
}

export async function getWeeklyStatus(week_number = null, year = null) {
  let targetWeek = week_number ? parseInt(week_number, 10) : null;
  if (!targetWeek) {
    const [row] = await query("SELECT value FROM settings WHERE key_name = 'active_semester_week' LIMIT 1");
    targetWeek = row && row.value ? parseInt(row.value, 10) : 1;
  }
  const targetYear = year ? parseInt(year, 10) : new Date().getFullYear();

  const rows = await query(`
    SELECT 
      m.id,
      m.name,
      m.phone_number,
      m.is_active,
      iw.amount,
      iw.paid_at,
      CASE WHEN iw.id IS NOT NULL THEN 1 ELSE 0 END AS is_paid
    FROM members m
    LEFT JOIN iuran_weekly iw 
      ON m.id = iw.member_id 
      AND iw.week_number = ? 
      AND iw.year = ?
    WHERE m.is_active = TRUE
    ORDER BY m.name ASC
  `, [targetWeek, targetYear]);

  const paidMembers = rows.filter(r => r.is_paid === 1);
  const unpaidMembers = rows.filter(r => r.is_paid === 0);

  return {
    week: targetWeek,
    year: targetYear,
    totalMembers: rows.length,
    totalPaid: paidMembers.length,
    totalUnpaid: unpaidMembers.length,
    paidMembers,
    unpaidMembers,
    all: rows
  };
}

export default {
  getSaldoSummary,
  getRecentTransactions,
  addTransaction,
  getMembers,
  addMember,
  addBulkMembers,
  updateMember,
  deleteMember,
  findMemberByName,
  recordIuranWeekly,
  getWeeklyStatus
};
