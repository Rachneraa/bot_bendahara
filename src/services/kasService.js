import { query } from '../../config/database.js';
import { getWeekNumber, parseKasEntries, formatRupiah } from '../utils/formatter.js';
import { getSetting, setSetting } from './messageService.js';

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

export async function addMember({ name, nim = null, phone_number = null }) {
  const result = await query(
    'INSERT INTO members (name, nim, phone_number, is_active) VALUES (?, ?, ?, TRUE)',
    [name.trim(), nim ? String(nim).trim() : null, phone_number ? phone_number.trim() : null]
  );
  return result.insertId;
}

export async function addBulkMembers(memberList) {
  if (!memberList || memberList.length === 0) return 0;
  let count = 0;
  for (const m of memberList) {
    if (!m.name || !m.name.trim()) continue;
    const nameClean = m.name.trim();
    const nimClean = m.nim ? String(m.nim).trim() : null;
    const phoneClean = m.phone_number ? String(m.phone_number).trim() : null;

    // Cek apakah mahasiswa dengan nama ini sudah terdaftar
    const [existing] = await query('SELECT id, nim FROM members WHERE LOWER(TRIM(name)) = LOWER(TRIM(?)) LIMIT 1', [nameClean]);
    if (existing) {
      // Jika nama sudah ada dan ada NIM baru, perbarui NIM-nya
      if (nimClean && nimClean !== existing.nim) {
        await query('UPDATE members SET nim = ? WHERE id = ?', [nimClean, existing.id]);
      }
    } else {
      // Jika belum ada, buat baru
      await query(
        'INSERT INTO members (name, nim, phone_number, is_active) VALUES (?, ?, ?, TRUE)',
        [nameClean, nimClean, phoneClean]
      );
    }
    count++;
  }
  return count;
}

export async function updateMember(id, { name, nim = null, phone_number = null, is_active }) {
  await query(
    'UPDATE members SET name = ?, nim = ?, phone_number = ?, is_active = ? WHERE id = ?',
    [name.trim(), nim ? String(nim).trim() : null, phone_number ? phone_number.trim() : null, is_active ? 1 : 0, id]
  );
}

export async function updateMemberNim(idOrName, nim) {
  const cleanNim = nim ? String(nim).trim() : null;
  // Jika input adalah angka murni ID
  if (/^\d+$/.test(String(idOrName).trim())) {
    const id = parseInt(idOrName, 10);
    const [member] = await query('SELECT * FROM members WHERE id = ?', [id]);
    if (member) {
      await query('UPDATE members SET nim = ? WHERE id = ?', [cleanNim, id]);
      return { success: true, member: { ...member, nim: cleanNim } };
    }
  }

  // Jika input adalah nama mahasiswa, cari menggunakan fuzzy search
  const matchResult = await searchMemberFuzzy(idOrName);
  if (matchResult.status === 'single') {
    const member = matchResult.matches[0];
    await query('UPDATE members SET nim = ? WHERE id = ?', [cleanNim, member.id]);
    return { success: true, member: { ...member, nim: cleanNim } };
  }

  return { success: false, status: matchResult.status, matches: matchResult.matches || [] };
}

export async function deleteMember(id) {
  await query('DELETE FROM members WHERE id = ?', [id]);
}

export function levenshteinDistance(a, b) {
  const s1 = (a || '').toLowerCase().trim();
  const s2 = (b || '').toLowerCase().trim();
  const an = s1.length;
  const bn = s2.length;
  if (an === 0) return bn;
  if (bn === 0) return an;
  const matrix = Array.from({ length: bn + 1 }, () => new Array(an + 1));
  for (let i = 0; i <= an; i++) matrix[0][i] = i;
  for (let j = 0; j <= bn; j++) matrix[j][0] = j;
  for (let j = 1; j <= bn; j++) {
    for (let i = 1; i <= an; i++) {
      if (s2[j - 1] === s1[i - 1]) {
        matrix[j][i] = matrix[j - 1][i - 1];
      } else {
        matrix[j][i] = Math.min(
          matrix[j - 1][i] + 1,
          matrix[j][i - 1] + 1,
          matrix[j - 1][i - 1] + 1
        );
      }
    }
  }
  return matrix[bn][an];
}

/**
 * Mencari data mahasiswa dengan sistem cerdas bertingkat:
 * 1. Exact match (nama persis)
 * 2. Substring match (potongan nama / kata)
 * 3. Fuzzy match (toleransi typo huruf)
 *
 * Return: { status: 'single' | 'ambiguous' | 'not_found', matches: [Member, ...] }
 */
export async function searchMemberFuzzy(keyword) {
  if (!keyword || !keyword.trim()) {
    return { status: 'not_found', matches: [] };
  }

  const queryClean = keyword.toLowerCase().trim();
  const allMembers = await getMembers(true);

  if (allMembers.length === 0) {
    return { status: 'not_found', matches: [] };
  }

  // 0. Exact NIM Match (jika keyword cocok persis dengan NIM mahasiswa)
  const cleanKeyword = queryClean.replace(/\s+/g, '');
  const nimMatches = allMembers.filter(m => m.nim && m.nim.toLowerCase().trim() === cleanKeyword);
  if (nimMatches.length === 1) {
    return { status: 'single', matches: nimMatches, type: 'nim' };
  }

  // 1. Exact Match
  const exactMatches = allMembers.filter(m => m.name.toLowerCase().trim() === queryClean);
  if (exactMatches.length === 1) {
    return { status: 'single', matches: exactMatches, type: 'exact' };
  }
  if (exactMatches.length > 1) {
    return { status: 'ambiguous', matches: exactMatches, type: 'exact' };
  }

  // 2. Substring / Word Match
  const substringMatches = allMembers.filter(m => {
    const fullName = m.name.toLowerCase().trim();
    if (fullName.includes(queryClean)) return true;
    const words = fullName.split(/\s+/);
    return words.some(w => w.startsWith(queryClean));
  });

  if (substringMatches.length === 1) {
    return { status: 'single', matches: substringMatches, type: 'substring' };
  }
  if (substringMatches.length > 1) {
    return { status: 'ambiguous', matches: substringMatches, type: 'substring' };
  }

  // 3. Fuzzy Typo Match (Levenshtein Distance)
  const maxDistance = queryClean.length <= 4 ? 1 : 2;
  const fuzzyCandidates = [];

  for (const m of allMembers) {
    const fullName = m.name.toLowerCase().trim();
    const words = fullName.split(/\s+/);
    let minWordDist = 999;

    for (const w of words) {
      const dist = levenshteinDistance(queryClean, w);
      if (dist < minWordDist) minWordDist = dist;
    }

    const fullDist = levenshteinDistance(queryClean, fullName);
    const bestDist = Math.min(minWordDist, fullDist);

    if (bestDist <= maxDistance) {
      fuzzyCandidates.push({ member: m, dist: bestDist });
    }
  }

  if (fuzzyCandidates.length === 0) {
    return { status: 'not_found', matches: [] };
  }

  fuzzyCandidates.sort((a, b) => a.dist - b.dist);
  const bestScore = fuzzyCandidates[0].dist;
  const topMatches = fuzzyCandidates.filter(c => c.dist === bestScore).map(c => c.member);

  if (topMatches.length === 1) {
    return { status: 'single', matches: topMatches, type: 'fuzzy' };
  }

  return { status: 'ambiguous', matches: topMatches, type: 'fuzzy' };
}

export async function findMemberByName(keyword) {
  const result = await searchMemberFuzzy(keyword);
  if (result.status === 'single') {
    return result.matches[0];
  }
  return null;
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
      amount = amount + VALUES(amount), -- cicilan di minggu yang sama dijumlahkan, bukan ditimpa
      transaction_id = VALUES(transaction_id),
      paid_at = CURRENT_TIMESTAMP
  `, [member_id, week_number, year, amount, txId]);

  const [iwRow] = await query(
    'SELECT amount FROM iuran_weekly WHERE member_id = ? AND week_number = ? AND year = ?',
    [member_id, week_number, year]
  );
  const totalAccumulated = Number(iwRow?.amount || amount);
  const target = await getKasTarget();

  return {
    txId,
    memberName,
    totalAccumulated,
    target,
    isLunas: totalAccumulated >= target,
    remaining: Math.max(0, target - totalAccumulated)
  };
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
      m.nim,
      m.phone_number,
      m.is_active,
      iw.amount,
      iw.paid_at,
      CASE WHEN iw.id IS NOT NULL AND iw.amount > 0 THEN 1 ELSE 0 END AS is_paid
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

const MONTH_NAMES = [
  '', 'Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni',
  'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'
];
const DEFAULT_KAS_TARGET = 10000;

// Indeks bulan absolut (tahun*12 + bulan) agar mudah menghitung selisih bulan lintas tahun
function periodIndex(year, month) {
  return year * 12 + (month - 1);
}

function periodStartSql(idx) {
  const y = Math.floor(idx / 12);
  const m = (idx % 12) + 1;
  return `${y}-${String(m).padStart(2, '0')}-01 00:00:00`;
}

export async function getKasTarget() {
  const v = parseInt(await getSetting('kas_monthly_target', String(DEFAULT_KAS_TARGET)), 10);
  return v > 0 ? v : DEFAULT_KAS_TARGET;
}

export async function setKasTarget(amount) {
  const v = parseInt(amount, 10);
  if (!v || v <= 0) throw new Error('Nominal target kas tidak valid.');
  await setSetting('kas_monthly_target', String(v));
  return v;
}

/**
 * Bulan pertama kewajiban kas. Default: bulan pembayaran kas anggota paling awal.
 */
export async function getKasStartPeriod() {
  const saved = await getSetting('kas_start_period', '');
  const match = /^(\d{4})-(\d{2})$/.exec(saved || '');
  if (match) {
    return { year: parseInt(match[1], 10), month: parseInt(match[2], 10), isDefault: false };
  }
  const [row] = await query(
    "SELECT MIN(created_at) AS first_at FROM kas_transactions WHERE type = 'masuk' AND member_id IS NOT NULL"
  );
  const d = row?.first_at ? new Date(row.first_at) : new Date();
  return { year: d.getFullYear(), month: d.getMonth() + 1, isDefault: true };
}

export async function setKasStartPeriod(month, year) {
  const m = parseInt(month, 10);
  const y = parseInt(year, 10);
  if (!m || m < 1 || m > 12 || !y || y < 2000 || y > 2100) {
    throw new Error('Bulan/tahun mulai kas tidak valid.');
  }
  await setSetting('kas_start_period', `${y}-${String(m).padStart(2, '0')}`);
  return { year: y, month: m };
}

/**
 * Status kas bulanan dengan dukungan cicilan.
 * Semua pembayaran anggota (sejak bulan mulai) dijumlahkan lalu dialokasikan ke bulan
 * paling lama dulu: kelebihan otomatis jadi bayar dimuka bulan berikutnya,
 * dan pembayaran telat otomatis melunasi tunggakan bulan sebelumnya.
 */
export async function getMonthlyStatus(month = null, year = null, rawInput = '') {
  const now = new Date();
  const start = await getKasStartPeriod();

  let targetMonth = month ? parseInt(month, 10) : (now.getMonth() + 1);
  let targetYear = year ? parseInt(year, 10) : now.getFullYear();

  let isRelativeMonth = false;
  let relativeIndex = null;

  const cleanInput = String(rawInput || '').trim().toLowerCase();
  const isNamedMonth = /^(jan|feb|mar|apr|mei|jun|jul|agu|agt|sep|okt|nov|des)/i.test(cleanInput);

  // Jika input berupa nomor urut (contoh: 1, 2) atau teks ordinal (pertama, kedua)
  // dan kas kelas dimulai di bulan selain Januari (misal Oktober):
  // Nomor urut 1 berarti Bulan ke-1 Periode Kas (Oktober), 2 = November, dst.
  if (start.month > 1 && !isNamedMonth && cleanInput) {
    const numMatch = cleanInput.match(/^(?:bulan\s*)?([1-9]|1[0-2])$/i);
    const numVal = numMatch 
      ? parseInt(numMatch[1], 10) 
      : (/^(pertama|kesatu|satu)/i.test(cleanInput) ? 1 : null);

    if (numVal && numVal >= 1 && numVal < start.month) {
      const absoluteIdx = periodIndex(start.year, start.month) + (numVal - 1);
      targetYear = Math.floor(absoluteIdx / 12);
      targetMonth = (absoluteIdx % 12) + 1;
      isRelativeMonth = true;
      relativeIndex = numVal;
    }
  }

  const target = await getKasTarget();
  const startIdx = periodIndex(start.year, start.month);
  const monthIdx = periodIndex(targetYear, targetMonth);
  const monthsBefore = monthIdx - startIdx; // negatif = sebelum periode kas dimulai

  const rows = await query(`
    SELECT 
      m.id,
      m.name,
      m.nim,
      m.phone_number,
      m.is_active,
      COALESCE(SUM(CASE WHEN kt.type = 'masuk' THEN kt.amount ELSE -kt.amount END), 0) AS paid_total,
      COALESCE(SUM(CASE WHEN kt.created_at >= ? AND kt.created_at < ? THEN (CASE WHEN kt.type = 'masuk' THEN kt.amount ELSE -kt.amount END) ELSE 0 END), 0) AS paid_this_month
    FROM members m
    LEFT JOIN kas_transactions kt 
      ON m.id = kt.member_id 
      AND kt.created_at >= ?
    WHERE m.is_active = TRUE
    GROUP BY m.id, m.name, m.nim, m.phone_number, m.is_active
    ORDER BY m.name ASC
  `, [periodStartSql(monthIdx), periodStartSql(monthIdx + 1), periodStartSql(startIdx)]);

  const all = rows.map((r) => {
    const paidTotal = Number(r.paid_total || 0);
    const paidThisMonth = Number(r.paid_this_month || 0);
    let allocated = 0;
    let credit = 0;
    let arrears = 0;

    if (monthsBefore >= 0) {
      const owedBefore = target * monthsBefore;
      allocated = Math.min(target, Math.max(0, paidTotal - owedBefore));
      credit = Math.max(0, paidTotal - owedBefore - target);
      arrears = Math.max(0, owedBefore - paidTotal);
    }

    const status = allocated >= target ? 'lunas' : (allocated > 0 ? 'cicil' : 'belum');
    return {
      ...r,
      paid_total: paidTotal,
      paid_this_month: paidThisMonth,
      total_paid: paidThisMonth,
      allocated,
      remaining: target - allocated,
      credit,
      arrears,
      status,
      is_paid: status === 'lunas' ? 1 : 0
    };
  });

  const paidMembers = all.filter(r => r.status === 'lunas');
  const partialMembers = all.filter(r => r.status === 'cicil');
  const unpaidMembers = all.filter(r => r.status === 'belum');
  const totalAmountPaid = all.reduce((sum, r) => sum + r.paid_this_month, 0);

  const monthName = MONTH_NAMES[targetMonth] || `Bulan ${targetMonth}`;
  const monthLabel = isRelativeMonth 
    ? `${monthName.toUpperCase()} (Bulan ke-${relativeIndex} Kas)` 
    : monthName.toUpperCase();

  return {
    month: targetMonth,
    monthName,
    monthLabel,
    isRelativeMonth,
    relativeIndex,
    year: targetYear,
    target,
    startPeriod: start,
    beforeStart: monthsBefore < 0,
    totalMembers: all.length,
    totalPaid: paidMembers.length,
    totalPartial: partialMembers.length,
    totalUnpaid: unpaidMembers.length,
    totalAmountPaid,
    paidMembers,
    partialMembers,
    unpaidMembers,
    all
  };
}

export async function startTestSession() {
  const [mRow] = await query('SELECT COALESCE(MAX(id), 0) AS max_m FROM members');
  const [tRow] = await query('SELECT COALESCE(MAX(id), 0) AS max_t FROM kas_transactions');
  const [sRow] = await query('SELECT COALESCE(MAX(id), 0) AS max_s FROM schedules');
  const maxM = mRow?.max_m || 0;
  const maxT = tRow?.max_t || 0;
  const maxS = sRow?.max_s || 0;
  const now = new Date().toISOString();

  await setSetting('test_session_started_at', now);
  await setSetting('test_session_min_member_id', String(maxM));
  await setSetting('test_session_min_tx_id', String(maxT));
  await setSetting('test_session_min_schedule_id', String(maxS));

  return { maxM, maxT, maxS, startedAt: now };
}

export async function resetTestSession() {
  const startedAt = await getSetting('test_session_started_at', '');
  if (!startedAt) {
    return { success: false, message: 'Tidak ada sesi uji coba yang sedang aktif.' };
  }

  const minMemberId = parseInt(await getSetting('test_session_min_member_id', '0'), 10);
  const minTxId = parseInt(await getSetting('test_session_min_tx_id', '0'), 10);
  const minScheduleId = parseInt(await getSetting('test_session_min_schedule_id', '0'), 10);

  const [iwCount] = await query('SELECT COUNT(*) AS total FROM iuran_weekly WHERE transaction_id > ? OR member_id > ?', [minTxId, minMemberId]);
  const [txCount] = await query('SELECT COUNT(*) AS total FROM kas_transactions WHERE id > ?', [minTxId]);
  const [mCount] = await query('SELECT COUNT(*) AS total FROM members WHERE id > ?', [minMemberId]);
  const [sCount] = await query('SELECT COUNT(*) AS total FROM schedules WHERE id > ?', [minScheduleId]);

  await query('DELETE FROM iuran_weekly WHERE transaction_id > ? OR member_id > ?', [minTxId, minMemberId]);
  await query('DELETE FROM kas_transactions WHERE id > ?', [minTxId]);
  await query('DELETE FROM members WHERE id > ?', [minMemberId]);
  await query('DELETE FROM schedules WHERE id > ?', [minScheduleId]);

  await query("DELETE FROM settings WHERE key_name IN ('test_session_started_at', 'test_session_min_member_id', 'test_session_min_tx_id', 'test_session_min_schedule_id')");

  return {
    success: true,
    deletedMembers: mCount?.total || 0,
    deletedTransactions: txCount?.total || 0,
    deletedIuran: iwCount?.total || 0,
    deletedSchedules: sCount?.total || 0
  };
}

export async function getTestSessionStatus() {
  const startedAt = await getSetting('test_session_started_at', '');
  if (!startedAt) return { active: false };

  const minMemberId = parseInt(await getSetting('test_session_min_member_id', '0'), 10);
  const minTxId = parseInt(await getSetting('test_session_min_tx_id', '0'), 10);
  const minScheduleId = parseInt(await getSetting('test_session_min_schedule_id', '0'), 10);

  const [txCount] = await query('SELECT COUNT(*) AS total FROM kas_transactions WHERE id > ?', [minTxId]);
  const [mCount] = await query('SELECT COUNT(*) AS total FROM members WHERE id > ?', [minMemberId]);
  return {
    active: true,
    startedAt,
    testMembersCount: mCount?.total || 0,
    testTxCount: txCount?.total || 0,
    testSchedulesCount: sCount?.total || 0
  };
}

export async function recordBulkKasChecklist({ member_ids, amount, week_number, year, created_by, source = 'web_dashboard' }) {
  const successList = [];
  let totalAmount = 0;
  const numAmount = parseFloat(amount) || 10000;
  const week = parseInt(week_number, 10) || 1;
  const yr = parseInt(year, 10) || new Date().getFullYear();

  for (const mId of (member_ids || [])) {
    const id = parseInt(mId, 10);
    if (!id) continue;
    const res = await recordIuranWeekly({
      member_id: id,
      week_number: week,
      year: yr,
      amount: numAmount,
      created_by,
      source
    });
    successList.push({
      member_id: id,
      name: res.memberName,
      amount: numAmount
    });
    totalAmount += numAmount;
  }

  return {
    count: successList.length,
    totalAmount,
    week,
    year: yr,
    successList
  };
}

export async function recordBulkKasText({ raw_text, week_number, year, created_by, source = 'web_dashboard' }) {
  const entries = parseKasEntries(raw_text || '');
  const week = parseInt(week_number, 10) || 1;
  const yr = parseInt(year, 10) || new Date().getFullYear();

  const successList = [];
  const generalList = [];
  let totalAmount = 0;

  for (const entry of entries) {
    if (!entry.amount || entry.amount <= 0) continue;

    const matchResult = await searchMemberFuzzy(entry.name);
    if (matchResult.status === 'single' || (matchResult.status === 'ambiguous' && matchResult.matches.length > 0)) {
      const member = matchResult.matches[0];
      const res = await recordIuranWeekly({
        member_id: member.id,
        week_number: week,
        year: yr,
        amount: entry.amount,
        created_by,
        source
      });
      successList.push({
        member_id: member.id,
        name: member.name,
        amount: entry.amount,
        isTypo: matchResult.type === 'fuzzy'
      });
      totalAmount += entry.amount;
    } else {
      await addTransaction({
        type: 'masuk',
        amount: entry.amount,
        member_id: null,
        description: `Kas Masuk - ${entry.name}`,
        source,
        created_by
      });
      generalList.push({
        name: entry.name,
        amount: entry.amount
      });
      totalAmount += entry.amount;
    }
  }

  return {
    count: successList.length + generalList.length,
    totalAmount,
    week,
    year: yr,
    successList,
    generalList
  };
}

export async function correctMemberIuran({ member_id, new_amount, week_number = null, year = null, created_by, source = 'bot_wa' }) {
  const [member] = await query('SELECT id, name FROM members WHERE id = ?', [member_id]);
  if (!member) throw new Error('Mahasiswa tidak ditemukan');

  const targetYear = year ? parseInt(year, 10) : new Date().getFullYear();
  let targetWeek = week_number ? parseInt(week_number, 10) : null;
  if (!targetWeek) {
    const [row] = await query("SELECT value FROM settings WHERE key_name = 'active_semester_week' LIMIT 1");
    targetWeek = row && row.value ? parseInt(row.value, 10) : 1;
  }

  // Hitung total iuran mahasiswa saat ini dari mutasi kas
  const [sumRow] = await query(`
    SELECT COALESCE(SUM(CASE WHEN type = 'masuk' THEN amount ELSE -amount END), 0) AS current_paid
    FROM kas_transactions
    WHERE member_id = ?
  `, [member_id]);

  const currentPaid = Number(sumRow?.current_paid || 0);
  const targetNewAmount = Math.max(0, parseInt(new_amount, 10) || 0);
  const target = await getKasTarget();

  if (currentPaid === targetNewAmount) {
    return {
      unchanged: true,
      member,
      oldAmount: currentPaid,
      newAmount: targetNewAmount,
      diff: 0,
      target,
      isLunas: targetNewAmount >= target,
      remaining: Math.max(0, target - targetNewAmount)
    };
  }

  const diff = targetNewAmount - currentPaid;
  let txId = null;

  if (diff < 0) {
    // Pengurangan iuran -> catat transaksi keluar sebagai audit trail
    txId = await addTransaction({
      type: 'keluar',
      amount: Math.abs(diff),
      member_id,
      description: `Koreksi iuran kas ${member.name}: penyesuaian nominal (${formatRupiah(currentPaid)} -> ${formatRupiah(targetNewAmount)})`,
      source,
      created_by
    });
  } else if (diff > 0) {
    // Penambahan iuran -> catat transaksi masuk
    txId = await addTransaction({
      type: 'masuk',
      amount: diff,
      member_id,
      description: `Koreksi iuran kas ${member.name}: penambahan nominal (${formatRupiah(currentPaid)} -> ${formatRupiah(targetNewAmount)})`,
      source,
      created_by
    });
  }

  // Sinkronkan catatan di iuran_weekly
  if (targetNewAmount === 0) {
    await query(`
      DELETE FROM iuran_weekly 
      WHERE member_id = ? AND week_number = ? AND year = ?
    `, [member_id, targetWeek, targetYear]);
  } else {
    await query(`
      INSERT INTO iuran_weekly (member_id, week_number, year, amount, transaction_id)
      VALUES (?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE 
        amount = VALUES(amount),
        transaction_id = VALUES(transaction_id),
        paid_at = CURRENT_TIMESTAMP
    `, [member_id, targetWeek, targetYear, targetNewAmount, txId]);
  }

  return {
    unchanged: false,
    member,
    oldAmount: currentPaid,
    newAmount: targetNewAmount,
    diff,
    txId,
    target,
    isLunas: targetNewAmount >= target,
    remaining: Math.max(0, target - targetNewAmount)
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
  updateMemberNim,
  deleteMember,
  findMemberByName,
  searchMemberFuzzy,
  levenshteinDistance,
  recordIuranWeekly,
  recordBulkKasChecklist,
  recordBulkKasText,
  correctMemberIuran,
  getWeeklyStatus,
  getMonthlyStatus,
  getKasTarget,
  setKasTarget,
  getKasStartPeriod,
  setKasStartPeriod,
  startTestSession,
  resetTestSession,
  getTestSessionStatus
};
