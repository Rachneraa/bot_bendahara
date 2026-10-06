import { query } from '../../config/database.js';

/**
 * Algoritma pengacakan Fisher-Yates
 */
export function shuffleArray(array) {
  const arr = [...array];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * Membagi daftar anggota menjadi kelompok seimbang secara acak.
 * Mendukung opsi pemisahan 1 kelompok khusus cewek (all-female group).
 * @param {Array} members List nama atau object anggota
 * @param {string} mode 'size' (target orang/kelompok) | 'count' (target jumlah kelompok)
 * @param {number} targetValue Nilai target
 * @param {object} options { femaleMembers: [], separateFemaleGroup: boolean }
 */
export function distributeGroups(members, mode = 'size', targetValue = 5, options = {}) {
  if (!members || members.length === 0) {
    throw new Error('Daftar anggota tidak boleh kosong.');
  }

  const { femaleMembers = [], separateFemaleGroup = false } = options;

  // Normalisasi list femaleMembers
  const femaleSet = new Set(
    (femaleMembers || [])
      .map(f => (typeof f === 'object' ? (f.name || f.nama || '') : String(f)).trim().toLowerCase())
      .filter(Boolean)
  );

  let activeFemaleGroup = null;
  let remainingMembers = [...members];

  if (separateFemaleGroup && femaleSet.size > 0) {
    const femalesInPool = [];
    const othersInPool = [];

    for (const m of members) {
      const name = (typeof m === 'object' ? (m.name || m.nama || '') : String(m)).trim().toLowerCase();
      if (femaleSet.has(name)) {
        femalesInPool.push(m);
      } else {
        othersInPool.push(m);
      }
    }

    if (femalesInPool.length > 0) {
      activeFemaleGroup = {
        groupNumber: 1,
        title: 'KELOMPOK 1 (KHUSUS CEWEK)',
        isFemaleGroup: true,
        members: shuffleArray(femalesInPool)
      };
      remainingMembers = othersInPool;
    }
  }

  // Jika semua anggota terpilih adalah cewek
  if (remainingMembers.length === 0 && activeFemaleGroup) {
    return {
      mode,
      targetValue: parseInt(targetValue, 10) || 1,
      totalMembers: members.length,
      totalGroups: 1,
      hasFemaleGroup: true,
      groups: [activeFemaleGroup]
    };
  }

  const shuffled = shuffleArray(remainingMembers);
  const total = shuffled.length;
  let numGroups = 1;

  if (mode === 'count') {
    const target = parseInt(targetValue, 10) || 1;
    const adjustedTarget = activeFemaleGroup ? Math.max(1, target - 1) : target;
    numGroups = Math.max(1, Math.min(total, adjustedTarget));
  } else {
    const targetSize = Math.max(1, parseInt(targetValue, 10) || 1);
    if (total <= targetSize) {
      numGroups = 1;
    } else {
      numGroups = Math.max(1, Math.floor(total / targetSize));
    }
  }

  const offset = activeFemaleGroup ? 1 : 0;
  const otherGroups = Array.from({ length: numGroups }, (_, i) => ({
    groupNumber: i + 1 + offset,
    title: `KELOMPOK ${i + 1 + offset}`,
    isFemaleGroup: false,
    members: []
  }));

  for (let i = 0; i < shuffled.length; i++) {
    otherGroups[i % numGroups].members.push(shuffled[i]);
  }

  const finalGroups = activeFemaleGroup ? [activeFemaleGroup, ...otherGroups] : otherGroups;

  return {
    mode,
    targetValue: parseInt(targetValue, 10) || 1,
    totalMembers: members.length,
    totalGroups: finalGroups.length,
    hasFemaleGroup: Boolean(activeFemaleGroup),
    groups: finalGroups
  };
}

/**
 * Menyimpan riwayat hasil spin ke database
 */
export async function saveSpinResult({ title = 'Acak Kelompok', mode = 'size', targetValue, totalMembers, totalGroups, groupsData, createdBy = 'admin' }) {
  const result = await query(`
    INSERT INTO spin_history (title, mode, target_value, total_members, total_groups, groups_data, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `, [
    title || 'Acak Kelompok',
    mode,
    targetValue,
    totalMembers,
    totalGroups,
    JSON.stringify(groupsData),
    createdBy
  ]);

  return result.insertId;
}

/**
 * Mengambil daftar riwayat spin
 */
export async function getSpinHistory(limit = 10) {
  const rows = await query(`
    SELECT * FROM spin_history 
    ORDER BY created_at DESC 
    LIMIT ?
  `, [limit]);

  return rows.map(r => ({
    ...r,
    groups_data: typeof r.groups_data === 'string' ? JSON.parse(r.groups_data) : r.groups_data
  }));
}

/**
 * Mengambil satu hasil spin berdasarkan ID
 */
export async function getSpinById(id) {
  const rows = await query(`
    SELECT * FROM spin_history WHERE id = ? LIMIT 1
  `, [id]);

  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    ...r,
    groups_data: typeof r.groups_data === 'string' ? JSON.parse(r.groups_data) : r.groups_data
  };
}

/**
 * Menghapus riwayat spin
 */
export async function deleteSpin(id) {
  await query('DELETE FROM spin_history WHERE id = ?', [id]);
}

/**
 * Memformat hasil kelompok menjadi pesan teks WhatsApp yang rapi dan elegan
 */
export function formatSpinWhatsAppMessage(title = 'Acak Kelompok', groups = [], totalMembers = 0) {
  const titleClean = (title && title.trim()) ? title.trim().toUpperCase() : 'HASIL PENGACAKAN KELOMPOK';
  let out = `🎲 *${titleClean}* 🎲\n\n`;
  out += `📋 *Total Mahasiswa:* ${totalMembers} Orang\n`;
  out += `👥 *Total Kelompok:* ${groups.length} Kelompok\n`;
  out += `━━━━━━━━━━━━━━━━━━━━━\n\n`;

  groups.forEach((g) => {
    if (g.isFemaleGroup) {
      out += `🌸 *KELOMPOK ${g.groupNumber} (KHUSUS CEWEK)* (${g.members.length} Orang):\n`;
    } else {
      out += `🏷️ *KELOMPOK ${g.groupNumber}* (${g.members.length} Orang):\n`;
    }
    g.members.forEach((m, idx) => {
      const name = typeof m === 'object' ? (m.name || m.nama || JSON.stringify(m)) : String(m);
      const nim = typeof m === 'object' && m.nim ? ` (NIM: ${m.nim})` : '';
      out += `  ${idx + 1}. ${name}${nim}\n`;
    });
    out += `\n`;
  });

  out += `━━━━━━━━━━━━━━━━━━━━━\n`;
  out += `✨ _Pengacakan dilakukan secara adil dan otomatis oleh Bot Kelas._`;
  return out.trim();
}

export default {
  shuffleArray,
  distributeGroups,
  saveSpinResult,
  getSpinHistory,
  getSpinById,
  deleteSpin,
  formatSpinWhatsAppMessage
};
