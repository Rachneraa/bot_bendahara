import kasService from '../services/kasService.js';
import jadwalService from '../services/jadwalService.js';
import messageService from '../services/messageService.js';
import spinService from '../services/spinService.js';
import formatter from '../utils/formatter.js';
import { getCachedGroupMetadata } from './adminHandler.js';

export const pendingAmbiguousSessions = new Map();

export function hasActiveSession(sessionKey) {
  const session = pendingAmbiguousSessions.get(sessionKey);
  if (!session) return false;
  if (Date.now() - session.createdAt > 10 * 60 * 1000) {
    pendingAmbiguousSessions.delete(sessionKey);
    return false;
  }
  return true;
}

export const parseKasEntries = formatter.parseKasEntries;
export const parseAmount = formatter.parseAmount;

export function parseScheduleLines(rawText) {
  const textWithoutCmd = rawText.replace(/^!bot\s+jadwal\s+tambah\s*/i, '').trim();
  if (!textWithoutCmd) return [];

  const validDays = ['senin', 'selasa', 'rabu', 'kamis', 'jumat', 'sabtu', 'minggu'];

  // 1. Jika teks berformat pipa '|'
  if (textWithoutCmd.includes('|')) {
    const rawLines = textWithoutCmd.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const schedules = [];

    for (const rawLine of rawLines) {
      const cleanLine = rawLine
        .replace(/^[\d]+[\.\)\-\s]+\s*/, '')
        .replace(/^[*•\s-]+/, '')
        .trim();

      if (!cleanLine) continue;
      const parts = cleanLine.split('|');
      if (parts.length < 4) continue;

      const day = parts[0].trim().toLowerCase();
      if (!validDays.includes(day)) continue;

      const timeParts = parts[1].trim().split('-');
      if (timeParts.length !== 2) continue;

      const startTimeRaw = timeParts[0].trim().replace(/\./g, ':');
      const endTimeRaw = timeParts[1].trim().replace(/\./g, ':');

      const startTime = startTimeRaw.length === 5 ? `${startTimeRaw}:00` : (startTimeRaw.length === 4 ? `0${startTimeRaw}:00` : startTimeRaw);
      const endTime = endTimeRaw.length === 5 ? `${endTimeRaw}:00` : (endTimeRaw.length === 4 ? `0${endTimeRaw}:00` : endTimeRaw);

      schedules.push({
        day_of_week: day,
        start_time: startTime,
        end_time: endTime,
        course_name: parts[2].trim(),
        lecturer: parts[3].trim(),
        note: parts[4] ? parts[4].trim() : ''
      });
    }
    if (schedules.length > 0) return schedules;
  }

  // 2. Parser cerdas untuk format natural / emoji (seperti pesan WA jadwal kelas)
  const lines = textWithoutCmd.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const schedules = [];

  let currentDay = null;
  let currentItem = null;

  function pushCurrent() {
    if (currentItem && currentItem.course_name && currentItem.start_time && currentItem.end_time) {
      schedules.push({
        day_of_week: currentItem.day_of_week,
        start_time: currentItem.start_time,
        end_time: currentItem.end_time,
        course_name: currentItem.course_name,
        lecturer: currentItem.lecturer || '-',
        note: [currentItem.location, currentItem.mode].filter(Boolean).join(' • ')
      });
    }
    currentItem = null;
  }

  for (const line of lines) {
    const dayMatch = line.toLowerCase().replace(/[\*\_:\#-]/g, '').trim();
    if (validDays.includes(dayMatch)) {
      pushCurrent();
      currentDay = dayMatch;
      continue;
    }

    if (!currentDay) continue;

    const timeMatch = line.match(/(\d{1,2})[\.:](\d{2})\s*(?:s\.?d\.?|sampai|\-)\s*(\d{1,2})[\.:](\d{2})/i);
    if (timeMatch) {
      if (!currentItem) currentItem = { day_of_week: currentDay };
      const h1 = String(timeMatch[1]).padStart(2, '0');
      const m1 = String(timeMatch[2]).padStart(2, '0');
      const h2 = String(timeMatch[3]).padStart(2, '0');
      const m2 = String(timeMatch[4]).padStart(2, '0');
      currentItem.start_time = `${h1}:${m1}:00`;
      currentItem.end_time = `${h2}:${m2}:00`;
      continue;
    }

    if (line.includes('📍') || /^(?:ruang|r\d+|gedung)/i.test(line)) {
      if (!currentItem) currentItem = { day_of_week: currentDay };
      currentItem.location = line.replace(/^[📍*•\s-]+/u, '').trim();
      continue;
    }

    if (line.includes('💼') || /^(?:tatap muka|praktikum|online|hybrid)/i.test(line)) {
      if (!currentItem) currentItem = { day_of_week: currentDay };
      currentItem.mode = line.replace(/^[💼*•\s-]+/u, '').trim();
      continue;
    }

    if (/[\u{1F468}\u{1F469}]/u.test(line) || /^dosen\s*[:\-]/i.test(line)) {
      if (!currentItem) currentItem = { day_of_week: currentDay };
      currentItem.lecturer = line.replace(/^[👩👨🏫\u{1F468}\u{1F469}\u{1F3EB}\u200D*•\s-]+|[Dd]osen\s*[:\-]\s*/u, '').trim();
      continue;
    }

    if (/saran|mending|perhatian|note/i.test(line) && !line.includes('-')) {
      continue;
    }

    if (/^[\-*•\d]/.test(line)) {
      pushCurrent();
      currentItem = { day_of_week: currentDay };
      let cleaned = line.replace(/^[*•\s-]+/, '').replace(/^[*_]|[*_]$/g, '').trim();
      cleaned = cleaned.replace(/^\d{4,6}\s*[-:.]\s*/, '').trim();
      currentItem.course_name = cleaned;
      continue;
    }
  }

  pushCurrent();
  return schedules;
}

export async function handleInteractiveChoice(sock, messageInfo, sessionKey) {
  const { rawText, fromJid, senderNumber } = messageInfo;
  const reply = async (text, mentions = []) => {
    await sock.sendMessage(fromJid, { text, mentions }, { quoted: messageInfo.rawMsg });
  };

  const session = pendingAmbiguousSessions.get(sessionKey);
  if (!session) return false;

  if (Date.now() - session.createdAt > 10 * 60 * 1000) {
    pendingAmbiguousSessions.delete(sessionKey);
    await reply('⌛ Sesi konfirmasi telah kadaluarsa (lebih dari 10 menit). Silakan ulangi pencatatan kas.');
    return true;
  }

  const cleanInput = rawText.replace(/^!bot\s*/i, '').trim().toLowerCase();

  if (cleanInput === 'batal' || cleanInput === 'cancel') {
    session.queue.shift();
    if (session.queue.length > 0) {
      const nextItem = session.queue[0];
      const candText = nextItem.candidates.map((c, i) => `[${i + 1}] *${c.name}*`).join('\n');
      await reply(
        `⏭️ Pilihan sebelumnya dilewati.\n\n` +
        `⚠️ *KONFIRMASI BERIKUTNYA (${session.queue.length} tersisa):*\n` +
        `Nama "*${nextItem.inputName}*" (${formatter.formatRupiah(nextItem.amount)}) cocok dengan ${nextItem.candidates.length} mahasiswa:\n` +
        `${candText}\n\n` +
        `👉 _Balas angka pilihan (*1* sampai *${nextItem.candidates.length}*), atau ketik *batal*._`
      );
    } else {
      pendingAmbiguousSessions.delete(sessionKey);
      await reply('❌ Sesi konfirmasi pemilihan nama telah dibatalkan.');
    }
    return true;
  }

  const choice = parseInt(cleanInput, 10);
  const currentItem = session.queue[0];

  if (!choice || choice < 1 || choice > currentItem.candidates.length) {
    await reply(`⚠️ Pilihan tidak valid. Silakan balas dengan angka *1* sampai *${currentItem.candidates.length}*, atau ketik *batal*.`);
    return true;
  }

  const selectedMember = currentItem.candidates[choice - 1];
  const activeWeekSetting = await messageService.getSetting('active_semester_week', '1');
  const targetWeek = parseInt(activeWeekSetting, 10) || 1;
  const targetYear = new Date().getFullYear();

  const recRes = await kasService.recordIuranWeekly({
    member_id: selectedMember.id,
    week_number: targetWeek,
    year: targetYear,
    amount: currentItem.amount,
    created_by: senderNumber,
    source: 'bot_wa'
  });

  session.queue.shift();
  const summary = await kasService.getSaldoSummary();

  if (session.queue.length > 0) {
    const nextItem = session.queue[0];
    const candText = nextItem.candidates.map((c, i) => `[${i + 1}] *${c.name}*`).join('\n');
    await reply(
      `✅ Kas untuk *${selectedMember.name}* (${formatter.formatRupiah(currentItem.amount)}) berhasil dicatat!\n\n` +
      `⚠️ *KONFIRMASI BERIKUTNYA (${session.queue.length} tersisa):*\n` +
      `Nama "*${nextItem.inputName}*" (${formatter.formatRupiah(nextItem.amount)}) cocok dengan ${nextItem.candidates.length} mahasiswa:\n` +
      `${candText}\n\n` +
      `👉 _Balas angka pilihan (*1* sampai *${nextItem.candidates.length}*), atau ketik *batal*._`
    );
  } else {
    pendingAmbiguousSessions.delete(sessionKey);
    const statusNote = recRes.isLunas
      ? `Lunas Minggu ke-${targetWeek}`
      : `Cicil (Terkumpul ${formatter.formatRupiah(recRes.totalAccumulated)} / Target ${formatter.formatRupiah(recRes.target)} — Kurang ${formatter.formatRupiah(recRes.remaining)})`;
    await reply(
      `✅ *KONFIRMASI SELESAI!*\n\n` +
      `Kas untuk *${selectedMember.name}* (${formatter.formatRupiah(currentItem.amount)}) berhasil dicatat (${statusNote}).\n` +
      `💎 Saldo Kas Kini: *${formatter.formatRupiah(summary.saldo)}*`
    );
  }

  return true;
}

export async function handleTugasCommand(rawText, args, reply) {
  const action = (args[2] || '').toLowerCase();

  // 1. Tampilkan daftar tugas aktif jika tanpa argumen atau '!bot tugas list'
  if (!action || action === 'list') {
    const activeTasks = await jadwalService.getActiveTasks();

    if (activeTasks.length === 0) {
      await reply(
        `🎉 *TIDAK ADA TUGAS / BARANG BAWAAN* 🎉\n\n` +
        `_Saat ini belum ada catatan tugas atau barang khusus yang harus dibawa untuk semua perkuliahan. Kuliah berjalan seperti biasa!_ 🚀\n\n` +
        `💡 _Admin dapat menambah catatan dengan:_ \n\`!bot tugas <matkul/id> <catatan>\``
      );
      return;
    }

    let out = `📌 *DAFTAR TUGAS & BARANG BAWAAN KELAS* 📌\n\n`;
    activeTasks.forEach((s, idx) => {
      const dateStr = s.temp_note_date
        ? formatter.formatDateIndo(new Date(s.temp_note_date))
        : s.day_of_week.toUpperCase();
      out += `${idx + 1}. 📖 *${s.course_name}* (${s.lecturer})\n`;
      out += `   🗓️ Pertemuan: *${dateStr}* (${formatter.formatTime(s.start_time)} - ${formatter.formatTime(s.end_time)} WIB)\n`;
      if (s.note) out += `   📝 Ruangan/Lokasi: ${s.note}\n`;
      out += `   📌 *Tugas/Bawaan*: ${s.temp_note}\n\n`;
    });

    out += `💡 _Catatan di atas berlaku 1x dan akan otomatis terhapus setelah jam kuliah selesai._`;
    await reply(out.trim());
    return;
  }

  // 2. Hapus catatan tugas: !bot tugas hapus <matkul/id>
  if (action === 'hapus' || action === 'clear' || action === 'del') {
    const targetQuery = args.slice(3).join(' ').trim();
    if (!targetQuery) {
      await reply('❌ Masukkan nama mata kuliah atau ID jadwal yang ingin dihapus catatan tugasnya.\nContoh: `!bot tugas hapus kalkulus` atau `!bot tugas hapus 1`');
      return;
    }

    const schedule = await jadwalService.findScheduleByQuery(targetQuery);
    if (!schedule) {
      await reply(`❌ Jadwal untuk mata kuliah / ID "${targetQuery}" tidak ditemukan.\nKetik \`!bot jadwal\` untuk melihat daftar jadwal.`);
      return;
    }

    await jadwalService.clearTempNote(schedule.id);
    await reply(`✅ Catatan tugas/bawaan untuk mata kuliah *${schedule.course_name}* berhasil dihapus/dibersihkan.`);
    return;
  }

  // 3. Tambah atau update catatan tugas: !bot tugas <matkul/id> <catatan>
  const textAfterCmd = rawText.replace(/^!bot\s+(?:jadwal\s+)?tugas\s*/i, '').trim();
  let targetQuery = '';
  let noteContent = '';

  if (textAfterCmd.includes('|')) {
    const parts = textAfterCmd.split('|');
    targetQuery = parts[0].trim();
    noteContent = parts.slice(1).join('|').trim();
  } else if (/^\d+$/.test(args[2])) {
    targetQuery = args[2];
    noteContent = args.slice(3).join(' ').trim();
  } else {
    // Cari matkul yang paling cocok dari daftar jadwal
    const allSchedules = await jadwalService.getAllSchedules();
    const sorted = [...allSchedules].sort((a, b) => b.course_name.length - a.course_name.length);
    let matched = null;

    for (const s of sorted) {
      const cLower = s.course_name.toLowerCase();
      const textLower = textAfterCmd.toLowerCase();
      if (textLower.startsWith(cLower)) {
        matched = s;
        targetQuery = s.id;
        noteContent = textAfterCmd.slice(cLower.length).trim();
        break;
      }
    }

    if (!matched) {
      targetQuery = args[2];
      noteContent = args.slice(3).join(' ').trim();
    }
  }

  if (!noteContent) {
    await reply(
      `❌ Masukkan catatan tugas atau barang yang harus dibawa.\n\n` +
      `*Contoh Penggunaan:*\n` +
      `• \`!bot tugas kalkulus bawa modul bab 3 & kalkulator\`\n` +
      `• \`!bot tugas pemrograman web | bawa laptop terinstall nodejs\`\n` +
      `• \`!bot tugas 1 bawa modul\`\n\n` +
      `*Untuk Menghapus Tugas:*\n` +
      `• \`!bot tugas hapus kalkulus\``
    );
    return;
  }

  const schedule = await jadwalService.findScheduleByQuery(String(targetQuery));
  if (!schedule) {
    await reply(`❌ Jadwal mata kuliah "${targetQuery}" tidak ditemukan.\nKetik \`!bot jadwal\` untuk melihat daftar mata kuliah yang terdaftar.`);
    return;
  }

  const res = await jadwalService.setTempNote(schedule.id, noteContent);
  const meetingDateStr = res.temp_note_date
    ? formatter.formatDateIndo(new Date(res.temp_note_date))
    : schedule.day_of_week.toUpperCase();

  await reply(
    `✅ *CATATAN TUGAS / BAWAAN BERHASIL DISIMPAN!*\n\n` +
    `📖 *Mata Kuliah* : ${schedule.course_name}\n` +
    `👨‍🏫 *Dosen*       : ${schedule.lecturer}\n` +
    `🗓️ *Pertemuan*   : ${meetingDateStr} (${formatter.formatTime(schedule.start_time)} - ${formatter.formatTime(schedule.end_time)} WIB)\n` +
    `📌 *Tugas/Bawaan* : ${res.temp_note}\n\n` +
    `_Catatan ini berlaku 1x dan akan otomatis terhapus setelah jam kuliah selesai._`
  );
}

export async function handleSpinCommand(rawText, args, messageInfo, reply) {
  // Cek apakah ada parameter cewe: / cewek: / putri:
  let femaleNames = [];
  let cleanedRawText = rawText;

  // 1. Cek format inline (cewe: nama1, nama2...) pada 1 baris
  const inlineMatch = rawText.match(/(?:cewe|cewek|putri|perempuan)\s*:\s*([^\r\n]+)/i);
  if (inlineMatch && inlineMatch[1].trim()) {
    femaleNames = inlineMatch[1]
      .split(/[,]/)
      .map(n => n.replace(/^[-*•\d\.\)]+\s*/, '').trim())
      .filter(Boolean);
    cleanedRawText = rawText.replace(inlineMatch[0], '').trim();
  } else {
    // 2. Cek format blok baris (cewe:\nnama1\nnama2...)
    const blockMatch = rawText.match(/(?:cewe|cewek|putri|perempuan)\s*:\s*\r?\n([\s\S]+?)(?=\r?\n(?:cowok|laki|pria)\s*:|$)/i);
    if (blockMatch) {
      femaleNames = blockMatch[1]
        .split(/\r?\n/)
        .map(n => n.replace(/^[-*•\d\.\)]+\s*/, '').trim())
        .filter(Boolean);
      cleanedRawText = rawText.replace(blockMatch[0], '').trim();
    }
  }

  const lines = cleanedRawText.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const firstLine = lines[0] || '';
  const firstLineWords = firstLine.split(/\s+/);

  let mode = 'size'; // 'size' | 'count'
  let targetValue = 5;
  let customTitle = 'Acak Kelompok';

  const secondToken = (firstLineWords[2] || '').toLowerCase();
  if (['kelompok', 'group', 'grup'].includes(secondToken)) {
    mode = 'count';
    const num = parseInt(firstLineWords[3], 10);
    if (!num || num < 1) {
      await reply(
        `❌ Jumlah kelompok tidak valid.\n\n` +
        `*Format:* \`!bot spin kelompok <jumlah> [cewe: nama1, nama2...]\`\n` +
        `*Contoh:* \`!bot spin kelompok 4 cewe: Ani, Bunga\``
      );
      return;
    }
    targetValue = num;
    if (firstLineWords.slice(4).length > 0) {
      customTitle = firstLineWords.slice(4).join(' ');
    }
  } else {
    // Mode target size (orang per kelompok)
    const num = parseInt(firstLineWords[2], 10);
    if (!num || num < 1) {
      await reply(
        `🎲 *PANDUAN ACAK KELOMPOK (SPIN)* 🎲\n\n` +
        `• *Target Jumlah Orang per Kelompok:*\n` +
        `  \`!bot spin <jumlah>\`\n` +
        `  _Contoh:_ \`!bot spin 5\`\n` +
        `  _(Sisa anggota otomatis dilebur rata menjadi kelompok 5, 6, atau 7 orang)_\n\n` +
        `• *Target Total Kelompok:*\n` +
        `  \`!bot spin kelompok <jumlah>\`\n` +
        `  _Contoh:_ \`!bot spin kelompok 4\`\n\n` +
        `• *🌸 Pisahkan 1 Kelompok Full Cewek:*\n` +
        `  \`!bot spin <jumlah> cewe: nama1, nama2, nama3\`\n` +
        `  _Contoh:_ \`!bot spin 5 cewe: Ani, Bunga, Citra, Dewi\`\n` +
        `  _(Seluruh mahasiswi cewek otomatis jadi 1 kelompok khusus, sisanya diacak seimbang)_\n\n` +
        `💡 *Catatan:* Secara otomatis menggunakan seluruh mahasiswa aktif di kelas.`
      );
      return;
    }
    targetValue = num;
    if (firstLineWords.slice(3).length > 0) {
      customTitle = firstLineWords.slice(3).join(' ');
    }
  }

  // Dapatkan daftar anggota
  let memberNames = [];
  if (lines.length > 1) {
    memberNames = lines.slice(1).map(l => l.replace(/^[-*•\d\.\)]+\s*/, '').trim()).filter(Boolean);
    for (const fn of femaleNames) {
      if (!memberNames.some(m => m.toLowerCase() === fn.toLowerCase())) {
        memberNames.push(fn);
      }
    }
  } else {
    const dbMembers = await kasService.getMembers(true);
    memberNames = dbMembers.map(m => m.name);
  }

  if (memberNames.length < 2) {
    await reply('❌ Minimal diperlukan 2 orang mahasiswa untuk diacak ke dalam kelompok.');
    return;
  }

  // Pencocokan cerdas nama cewek terhadap memberNames
  const resolvedFemaleNames = [];
  if (femaleNames.length > 0) {
    for (const rawFn of femaleNames) {
      const lower = rawFn.toLowerCase();
      const match = memberNames.find(m => m.toLowerCase() === lower || m.toLowerCase().includes(lower));
      if (match) {
        resolvedFemaleNames.push(match);
      } else {
        resolvedFemaleNames.push(rawFn);
      }
    }
  }

  const result = spinService.distributeGroups(memberNames, mode, targetValue, {
    femaleMembers: resolvedFemaleNames,
    separateFemaleGroup: resolvedFemaleNames.length > 0
  });

  try {
    await spinService.saveSpinResult({
      title: customTitle,
      mode: result.mode,
      targetValue: result.targetValue,
      totalMembers: result.totalMembers,
      totalGroups: result.totalGroups,
      groupsData: result.groups,
      createdBy: messageInfo.senderNumber || 'admin_wa'
    });
  } catch (dbErr) {
    console.warn('[SPIN DB SAVE WARNING]', dbErr.message);
  }

  const outMsg = spinService.formatSpinWhatsAppMessage(customTitle, result.groups, result.totalMembers);
  await reply(outMsg);
}

export function parsePindahInput(textWithoutCmd) {
  const validDays = ['senin', 'selasa', 'rabu', 'kamis', 'jumat', 'sabtu', 'minggu'];

  if (textWithoutCmd.includes('|')) {
    const parts = textWithoutCmd.split('|').map(p => p.trim());
    const courseQuery = parts[0];
    const newDay = (parts[1] || '').toLowerCase();
    const timeStr = parts[2] || '';
    const newLocation = parts[3] || '';

    const timeMatch = timeStr.match(/(\d{1,2}[:.]\d{2})\s*(?:-|s\.?d\.?)\s*(\d{1,2}[:.]\d{2})/i);
    if (!timeMatch || !validDays.includes(newDay)) {
      return null;
    }

    let start = timeMatch[1].replace(/\./g, ':');
    let end = timeMatch[2].replace(/\./g, ':');
    start = start.length === 5 ? `${start}:00` : (start.length === 4 ? `0${start}:00` : start);
    end = end.length === 5 ? `${end}:00` : (end.length === 4 ? `0${end}:00` : end);

    return { courseQuery, newDay, startTime: start, endTime: end, newLocation };
  }

  const timeRegex = /\b(\d{1,2}[:.]\d{2})\s*(?:-|s\.?d\.?)\s*(\d{1,2}[:.]\d{2})\b/i;
  const timeMatch = textWithoutCmd.match(timeRegex);
  if (!timeMatch) return null;

  let start = timeMatch[1].replace(/\./g, ':');
  let end = timeMatch[2].replace(/\./g, ':');
  start = start.length === 5 ? `${start}:00` : (start.length === 4 ? `0${start}:00` : start);
  end = end.length === 5 ? `${end}:00` : (end.length === 4 ? `0${end}:00` : end);

  const timeIndex = timeMatch.index;
  const timeEndIndex = timeIndex + timeMatch[0].length;
  const textBeforeTime = textWithoutCmd.slice(0, timeIndex).trim();
  const textAfterTime = textWithoutCmd.slice(timeEndIndex).trim();

  const words = textBeforeTime.split(/\s+/);
  let dayFound = null;
  let dayIdx = -1;

  for (let i = words.length - 1; i >= 0; i--) {
    const w = words[i].toLowerCase();
    if (validDays.includes(w)) {
      dayFound = w;
      dayIdx = i;
      break;
    }
  }

  if (!dayFound) return null;

  const courseQuery = words.slice(0, dayIdx).join(' ').trim();
  const newLocation = textAfterTime;

  if (!courseQuery) return null;

  return {
    courseQuery,
    newDay: dayFound,
    startTime: start,
    endTime: end,
    newLocation
  };
}

export function formatScheduleCard(s, isTodayView = false) {
  let card = '';
  const isBatal = s.status_override === 'batal';
  const isOnline = s.status_override === 'online';
  const isPindah = s.status_override === 'pindah';

  if (isBatal) {
    card += `• ❌ ~📖 *${s.course_name}*~ *(DIBATALKAN / KOSONG)*\n`;
    card += `  🕧 ${formatter.formatTime(s.start_time)} s.d ${formatter.formatTime(s.end_time)} WIB\n`;
    if (s.status_note) card += `  📝 Alasan: ${s.status_note}\n`;
    card += `  👩‍🏫 ${s.lecturer}\n`;
  } else if (isOnline) {
    card += `• 💻 📖 *${s.course_name}* *(KULIAH ONLINE)*\n`;
    card += `  🕧 ${formatter.formatTime(s.start_time)} s.d ${formatter.formatTime(s.end_time)} WIB\n`;
    card += `  🔗 Link: ${s.status_note || 'Via daring'}\n`;
    card += `  👩‍🏫 ${s.lecturer}\n`;
    if (s.temp_note) card += `  📌 *Tugas/Bawaan:* ${s.temp_note}\n`;
  } else if (isPindah) {
    const effectiveStart = s.override_start_time || s.start_time;
    const effectiveEnd = s.override_end_time || s.end_time;
    const effectiveLoc = s.override_location || s.note;
    card += `• 🔄 📖 *${s.course_name}* *(PINDAH JADWAL)*\n`;
    if (isTodayView) {
      card += `  🕧 ${formatter.formatTime(effectiveStart)} s.d ${formatter.formatTime(effectiveEnd)} WIB (Kuliah Pengganti)\n`;
      if (effectiveLoc) card += `  📍 ${effectiveLoc}\n`;
    } else {
      card += `  🕧 Jadwal Asli: ${formatter.formatTime(s.start_time)} s.d ${formatter.formatTime(s.end_time)} WIB\n`;
      card += `  ✨ Dipindah ke: *${(s.override_day || '').toUpperCase()}* (${formatter.formatTime(effectiveStart)} - ${formatter.formatTime(effectiveEnd)} WIB) di ${effectiveLoc || '-'}\n`;
    }
    card += `  👩‍🏫 ${s.lecturer}\n`;
    if (s.temp_note) card += `  📌 *Tugas/Bawaan:* ${s.temp_note}\n`;
  } else {
    card += `• 📖 *${s.course_name}*\n`;
    card += `  🕧 ${formatter.formatTime(s.start_time)} s.d ${formatter.formatTime(s.end_time)} WIB\n`;
    if (s.note) card += `  📍 ${s.note}\n`;
    card += `  👩‍🏫 ${s.lecturer}\n`;
    if (s.temp_note) card += `  📌 *Tugas/Bawaan:* ${s.temp_note}\n`;
  }
  return card.trimEnd();
}

async function broadcastAnnouncement(sock, messageInfo, annText, reply) {
  const { isGroup, groupJid } = messageInfo;
  if (isGroup && sock) {
    let mentions = [];
    try {
      const meta = await getCachedGroupMetadata(sock, groupJid);
      if (meta && Array.isArray(meta.participants)) {
        mentions = meta.participants.map(p => p.id);
      }
    } catch (_) {}
    await reply(annText, mentions);
  } else {
    await reply(`✅ Pengumuman status perkuliahan berhasil dibuat!\n\n` + annText);
    const targetGroupJid = await messageService.getSetting('target_group_jid');
    if (targetGroupJid && sock) {
      let mentions = [];
      try {
        const meta = await getCachedGroupMetadata(sock, targetGroupJid);
        if (meta && Array.isArray(meta.participants)) {
          mentions = meta.participants.map(p => p.id);
        }
      } catch (_) {}
      await sock.sendMessage(targetGroupJid, { text: annText, mentions });
    }
  }
}

export async function handleKuliahCommand(rawText, args, messageInfo, reply, isAdmin = false, sock = null) {
  const action = (args[2] || '').toLowerCase();

  // 1. Status overview jika tanpa aksi atau 'list' / 'status'
  if (!action || action === 'list' || action === 'status') {
    const allSchedules = await jadwalService.getAllSchedules(true);
    const overrides = allSchedules.filter(s => s.status_override && s.status_override !== 'normal');

    if (overrides.length === 0) {
      await reply(
        `🎓 *STATUS PERKULIAHAN KELAS* 🎓\n\n` +
        `✅ Seluruh perkuliahan saat ini berjalan *NORMAL (REGULER)* sesuai jadwal mingguan.\n\n` +
        `*Panduan Pengaturan Status (Khusus Pertemuan Terdekat):*\n` +
        `• Kelas Kosong/Batal: \`!bot kuliah batal <matkul> [alasan]\`\n` +
        `• Kuliah Online: \`!bot kuliah online <matkul> <link/info>\`\n` +
        `• Pindah Jadwal: \`!bot kuliah pindah <matkul> <hari> <jam> [ruang]\`\n` +
        `• Kembalikan Normal: \`!bot kuliah normal <matkul>\``
      );
      return;
    }

    let out = `🎓 *STATUS KHUSUS PERKULIAHAN AKTIF* 🎓\n\n`;
    overrides.forEach((s, idx) => {
      let badge = '';
      if (s.status_override === 'batal') badge = '❌ DIBATALKAN / KOSONG';
      else if (s.status_override === 'online') badge = '💻 KULIAH ONLINE (DARING)';
      else if (s.status_override === 'pindah') badge = '🔄 PINDAH JADWAL (PENGGANTI)';

      out += `${idx + 1}. 📖 *${s.course_name}* (${s.lecturer})\n`;
      out += `   🏷️ Status: *${badge}*\n`;
      out += `   🗓️ Jadwal Asli: ${s.day_of_week.toUpperCase()} (${formatter.formatTime(s.start_time)} - ${formatter.formatTime(s.end_time)} WIB)\n`;
      if (s.status_override === 'pindah') {
        out += `   ✨ Jadwal Baru: *${(s.override_day || '').toUpperCase()}* (${formatter.formatTime(s.override_start_time || s.start_time)} - ${formatter.formatTime(s.override_end_time || s.end_time)} WIB)\n`;
        out += `   📍 Lokasi Baru: ${s.override_location || '-'}\n`;
      } else {
        out += `   📝 Keterangan: ${s.status_note || '-'}\n`;
      }
      out += `\n`;
    });

    out += `💡 _Status di atas hanya berlaku 1x dan akan otomatis normal kembali setelah jam kuliah selesai._`;
    await reply(out.trim());
    return;
  }

  // 2. Pembatalan Kelas (Kelas Kosong)
  if (action === 'batal' || action === 'cancel' || action === 'kosong') {
    const textAfter = rawText.replace(/^!bot\s+(?:jadwal\s+|kuliah\s+)(?:batal|cancel|kosong)\s*/i, '').trim();
    if (!textAfter) {
      await reply(
        `❌ Masukkan nama mata kuliah yang dibatalkan / kosong.\n\n` +
        `*Format:* \`!bot kuliah batal <matkul> [alasan]\`\n` +
        `*Contoh:* \`!bot kuliah batal kalkulus dosen berhalangan hadir\``
      );
      return;
    }

    let courseQuery = '';
    let reason = '';
    if (textAfter.includes('|')) {
      const parts = textAfter.split('|');
      courseQuery = parts[0].trim();
      reason = parts.slice(1).join('|').trim();
    } else {
      const allSchedules = await jadwalService.getAllSchedules();
      const sorted = [...allSchedules].sort((a, b) => b.course_name.length - a.course_name.length);
      let matched = null;
      for (const s of sorted) {
        if (textAfter.toLowerCase().startsWith(s.course_name.toLowerCase())) {
          matched = s;
          courseQuery = s.id;
          reason = textAfter.slice(s.course_name.length).trim();
          break;
        }
      }
      if (!matched) {
        const words = textAfter.split(/\s+/);
        courseQuery = words[0];
        reason = words.slice(1).join(' ').trim();
      }
    }

    const schedule = await jadwalService.findScheduleByQuery(String(courseQuery));
    if (!schedule) {
      await reply(`❌ Jadwal mata kuliah "${courseQuery}" tidak ditemukan.\nKetik \`!bot jadwal\` untuk melihat daftar jadwal.`);
      return;
    }

    const res = await jadwalService.setClassCancelled(schedule.id, reason);
    const meetingDateStr = res.override_date
      ? formatter.formatDateIndo(new Date(res.override_date))
      : schedule.day_of_week.toUpperCase();

    const annText =
      `📢 *PENGUMUMAN: KELAS KOSONG / DIBATALKAN* 📢\n\n` +
      `Diberitahukan kepada seluruh rekan kelas bahwa perkuliahan berikut ditiadakan untuk pertemuan terdekat:\n\n` +
      `📖 *Mata Kuliah* : *${schedule.course_name}*\n` +
      `👩‍🏫 *Dosen*       : ${schedule.lecturer}\n` +
      `🗓️ *Pertemuan*   : *${schedule.day_of_week.toUpperCase()}* (${meetingDateStr})\n` +
      `🕧 *Waktu*       : ${formatter.formatTime(schedule.start_time)} s.d ${formatter.formatTime(schedule.end_time)} WIB\n` +
      `❌ *Status*      : *DIBATALKAN / KOSONG*\n` +
      `📝 *Keterangan*  : ${res.status_note}\n\n` +
      `_Pengingat otomatis untuk pertemuan ini dinonaktifkan. Jadwal akan otomatis kembali normal setelah jam perkuliahan selesai._ 🚀`;

    await broadcastAnnouncement(sock, messageInfo, annText, reply);
    return;
  }

  // 3. Kuliah Online (Daring)
  if (action === 'online' || action === 'daring' || action === 'zoom') {
    const textAfter = rawText.replace(/^!bot\s+(?:jadwal\s+|kuliah\s+)(?:online|daring|zoom)\s*/i, '').trim();
    if (!textAfter) {
      await reply(
        `❌ Masukkan nama mata kuliah dan link/media online.\n\n` +
        `*Format:* \`!bot kuliah online <matkul> <link/info>\`\n` +
        `*Contoh:* \`!bot kuliah online kalkulus https://zoom.us/j/123456\`\n` +
        `*Atau:* \`!bot kuliah online logika komputasi | via Google Meet link menyusul\``
      );
      return;
    }

    let courseQuery = '';
    let linkInfo = '';
    if (textAfter.includes('|')) {
      const parts = textAfter.split('|');
      courseQuery = parts[0].trim();
      linkInfo = parts.slice(1).join('|').trim();
    } else {
      const allSchedules = await jadwalService.getAllSchedules();
      const sorted = [...allSchedules].sort((a, b) => b.course_name.length - a.course_name.length);
      let matched = null;
      for (const s of sorted) {
        if (textAfter.toLowerCase().startsWith(s.course_name.toLowerCase())) {
          matched = s;
          courseQuery = s.id;
          linkInfo = textAfter.slice(s.course_name.length).trim();
          break;
        }
      }
      if (!matched) {
        const words = textAfter.split(/\s+/);
        courseQuery = words[0];
        linkInfo = words.slice(1).join(' ').trim();
      }
    }

    const schedule = await jadwalService.findScheduleByQuery(String(courseQuery));
    if (!schedule) {
      await reply(`❌ Jadwal mata kuliah "${courseQuery}" tidak ditemukan.\nKetik \`!bot jadwal\` untuk melihat daftar jadwal.`);
      return;
    }

    const res = await jadwalService.setClassOnline(schedule.id, linkInfo);
    const meetingDateStr = res.override_date
      ? formatter.formatDateIndo(new Date(res.override_date))
      : schedule.day_of_week.toUpperCase();

    const annText =
      `📢 *PENGUMUMAN: KULIAH ONLINE (DARING)* 💻\n\n` +
      `Diberitahukan bahwa perkuliahan berikut dialihkan menjadi *ONLINE* untuk pertemuan terdekat:\n\n` +
      `📖 *Mata Kuliah* : *${schedule.course_name}*\n` +
      `👩‍🏫 *Dosen*       : ${schedule.lecturer}\n` +
      `🗓️ *Pertemuan*   : *${schedule.day_of_week.toUpperCase()}* (${meetingDateStr})\n` +
      `🕧 *Waktu*       : ${formatter.formatTime(schedule.start_time)} s.d ${formatter.formatTime(schedule.end_time)} WIB\n` +
      `💻 *Media/Link*  : ${res.status_note}\n\n` +
      `_Pengingat otomatis H-5 & H-0 akan disesuaikan dengan info online. Status otomatis normal kembali setelah jam perkuliahan selesai._ 🚀`;

    await broadcastAnnouncement(sock, messageInfo, annText, reply);
    return;
  }

  // 4. Pindah Jadwal (Kuliah Pengganti)
  if (action === 'pindah' || action === 'ganti' || action === 'reschedule') {
    const textAfter = rawText.replace(/^!bot\s+(?:jadwal\s+|kuliah\s+)(?:pindah|ganti|reschedule)\s*/i, '').trim();
    const parsed = parsePindahInput(textAfter);

    if (!parsed) {
      await reply(
        `❌ Format pindah jadwal tidak valid!\n\n` +
        `*Format Pipa:* \`!bot kuliah pindah <matkul> | <hari> | <jam> | [ruang]\`\n` +
        `*Contoh:* \`!bot kuliah pindah kalkulus | kamis | 09:00-11:00 | R5305\`\n\n` +
        `*Format Alami:* \`!bot kuliah pindah <matkul> <hari> <jam> [ruang]\`\n` +
        `*Contoh:* \`!bot kuliah pindah kalkulus kamis 09:00-11:00 R5305\``
      );
      return;
    }

    const schedule = await jadwalService.findScheduleByQuery(String(parsed.courseQuery));
    if (!schedule) {
      await reply(`❌ Jadwal mata kuliah "${parsed.courseQuery}" tidak ditemukan.\nKetik \`!bot jadwal\` untuk melihat daftar jadwal.`);
      return;
    }

    const res = await jadwalService.setClassRescheduled(schedule.id, parsed);
    const meetingDateStr = res.override_date
      ? formatter.formatDateIndo(new Date(res.override_date))
      : parsed.newDay.toUpperCase();

    const annText =
      `📢 *PENGUMUMAN: PERUBAHAN JADWAL KULIAH (PENGGANTI)* 🔄\n\n` +
      `Diberitahukan kepada seluruh rekan kelas bahwa perkuliahan:\n` +
      `📖 *Mata Kuliah*      : *${schedule.course_name}*\n` +
      `👩‍🏫 *Dosen*            : ${schedule.lecturer}\n` +
      `🗓️ *Jadwal Semula*     : ${schedule.day_of_week.toUpperCase()} (${formatter.formatTime(schedule.start_time)} - ${formatter.formatTime(schedule.end_time)} WIB)\n\n` +
      `✨ *DIALIHKAN KE JADWAL PENGGANTI:* ✨\n` +
      `🗓️ *Hari/Tanggal*      : *${parsed.newDay.toUpperCase()}* (${meetingDateStr})\n` +
      `🕧 *Waktu*             : *${formatter.formatTime(parsed.startTime)} s.d ${formatter.formatTime(parsed.endTime)} WIB*\n` +
      `📍 *Ruangan/Lokasi*    : *${parsed.newLocation || schedule.note || 'Sesuai info dosen'}*\n\n` +
      `_Pengingat otomatis pada jadwal semula dinonaktifkan dan dialihkan ke jadwal pengganti. Status akan otomatis normal kembali setelah kuliah selesai._ 🚀`;

    await broadcastAnnouncement(sock, messageInfo, annText, reply);
    return;
  }

  // 5. Kembalikan ke Normal
  if (action === 'normal' || action === 'reset') {
    const textAfter = rawText.replace(/^!bot\s+(?:jadwal\s+|kuliah\s+)(?:normal|reset)\s*/i, '').trim();
    if (!textAfter) {
      await reply('❌ Masukkan nama mata kuliah yang ingin dikembalikan ke status normal.\nContoh: `!bot kuliah normal kalkulus`');
      return;
    }

    const schedule = await jadwalService.findScheduleByQuery(textAfter);
    if (!schedule) {
      await reply(`❌ Jadwal mata kuliah "${textAfter}" tidak ditemukan.`);
      return;
    }

    await jadwalService.resetClassStatus(schedule.id);
    await reply(`✅ Status perkuliahan *${schedule.course_name}* (${schedule.day_of_week.toUpperCase()}) telah dikembalikan ke *NORMAL (REGULER)*.`);
    return;
  }

  await reply(
    `❌ Perintah kuliah tidak dikenali.\n\nPilihan:\n` +
    `• \`!bot kuliah\` : Cek status khusus kuliah aktif\n` +
    `• \`!bot kuliah batal <matkul> [alasan]\`\n` +
    `• \`!bot kuliah online <matkul> <link/info>\`\n` +
    `• \`!bot kuliah pindah <matkul> <hari> <jam> [ruang]\`\n` +
    `• \`!bot kuliah normal <matkul>\``
  );
}

export async function handleCommand(sock, messageInfo, isAdmin = false) {
  const { rawText, fromJid, isGroup, groupJid, senderNumber, senderJid } = messageInfo;
  const reply = async (text, mentions = []) => {
    try {
      await sock.sendMessage(fromJid, { text, mentions }, { quoted: messageInfo.rawMsg });
    } catch (_) {
      // Fallback jika quote gagal karena struktur pesan khusus
      await sock.sendMessage(fromJid, { text, mentions });
    }
  };

  try {
    const args = rawText.trim().split(/\s+/);
    const firstToken = (args[0] || '').toLowerCase();
    const subCmd = firstToken === '!tampil' ? 'tampil' : (args[1] || '').toLowerCase();

    // Daftar perintah yang memerlukan otorisasi Admin
    const adminCommands = new Set([
      'setgroup', 'delgroup', 'unsetgroup',
      'settestgroup', 'deltestgroup', 'unsettestgroup',
      'test'
    ]);

    const isKasAdmin = subCmd === 'kas' && ['masuk', 'keluar', 'del', 'hapus', 'reset', 'koreksi'].includes((args[2] || '').toLowerCase());
    const isMemberAdmin = (subCmd === 'member' && ['tambah', 'add', 'hapus', 'del'].includes((args[2] || '').toLowerCase())) || (subCmd === 'member' && (args[2] || '').toLowerCase() === 'nim' && args[4]);
    const isJadwalAdmin = subCmd === 'jadwal' && ['tambah', 'add', 'hapus', 'del', 'batal', 'online', 'pindah', 'normal', 'reset', 'cancel', 'kosong', 'daring', 'zoom', 'ganti', 'reschedule'].includes((args[2] || '').toLowerCase());
    const isKuliahAdmin = subCmd === 'kuliah' && ['batal', 'online', 'pindah', 'normal', 'reset', 'cancel', 'kosong', 'daring', 'zoom', 'ganti', 'reschedule'].includes((args[2] || '').toLowerCase());
    const isTugasAdmin = (subCmd === 'tugas' && args[2] && !['list'].includes(args[2].toLowerCase())) || (subCmd === 'jadwal' && (args[2] || '').toLowerCase() === 'tugas' && args[3] && !['list'].includes(args[3].toLowerCase()));
    const isSpinAdmin = ['spin', 'acak'].includes(subCmd);

    const isRestricted = adminCommands.has(subCmd) || isKasAdmin || isMemberAdmin || isJadwalAdmin || isKuliahAdmin || isTugasAdmin || isSpinAdmin;

    if (isRestricted && !isAdmin) {
      await reply(
        `⚠️ *AKSES KHUSUS ADMIN*\n\n` +
        `Perintah \`!bot ${subCmd}\` hanya dapat dijalankan oleh *Admin Grup* atau nomor yang terdaftar di whitelist bot.\n\n` +
        `📱 _Nomor Anda terdeteksi: \`${senderNumber || senderJid}\`_\n` +
        `💡 Ketik \`!bot\` untuk melihat perintah publik yang dapat Anda gunakan.`
      );
      return;
    }

  switch (subCmd) {
    case '':
    case 'help':
    case 'menu': {
      const menuText = `
🤖 *PANDUAN PERINTAH BOT BENDAHARA & KELAS*

*👑 PENGATURAN GRUP & PENGUJIAN*
• \`!bot setgroup\` : Daftarkan grup ini sebagai Grup Kelas Utama (pengingat otomatis).
• \`!bot delgroup\` : Hapus pendaftaran Grup Kelas Utama.
• \`!bot settestgroup\` : Daftarkan grup ini sebagai Grup Testing (uji coba fitur).
• \`!bot deltestgroup\` : Hapus pendaftaran Grup Testing.
• \`!bot test start\` : Mulai sesi uji coba fitur (merekam snapshot database).
• \`!bot test reminder\` : Kirim simulasi pengingat kuliah ke grup testing.
• \`!bot test reset\` : Hapus seluruh data tes & kembalikan database bersih.

*💰 KAS & IURAN*
• \`!bot kas saldo\` : Lihat total saldo kas & ringkasan.
• \`!bot kas bulan [1-12]\` : Cek list yang sudah & belum bayar uang kas per bulan.
  _Contoh: \`!bot kas bulan 1\` atau \`!bot kas bulan oktober\`_
• \`!bot kas lunas [bulan]\` : List khusus yang sudah lunas uang kas.
• \`!bot kas cicil [bulan]\` : List khusus yang masih nyicil / bayar sebagian.
• \`!bot kas belum [bulan]\` : List khusus yang belum bayar di bulan tertentu.
• \`!bot kas masuk <nominal> [nama/ket]\` : Catat kas masuk / iuran.
  _Contoh: \`!bot kas masuk 20000 Budi\`_
• \`!bot kas koreksi <nama> <nominal>\` : Koreksi/ubah nominal kas anggota jika salah catat.
  _Contoh: \`!bot kas koreksi kiki 10000\` atau \`!bot kas koreksi kiki 10k\`_
• \`!bot kas keluar <nominal> <ket>\` : Catat pengeluaran kas.
  _Contoh: \`!bot kas keluar 30000 Beli spidol\`_
• \`!bot kas mutasi\` : Lihat 10 transaksi terakhir.
• \`!bot kas status [minggu]\` : Cek iuran mingguan (lunas/belum).

*👥 ANGGOTA KELAS & NIM*
• \`!bot member list\` : Daftar seluruh anggota kelas.
• \`!tampil nim\` atau \`!bot member list nim\` : Daftar mahasiswa beserta NIM.
• \`!bot member nim <nama/id> <nim>\` : Atur/ubah NIM mahasiswa.
• \`!bot member tambah <nama>\` : Tambah anggota baru.

*📚 JADWAL KULIAH & STATUS PERTEMUAN*
• \`!bot jadwal\` : Lihat jadwal kuliah hari ini & mingguan.
• \`!bot jadwal tambah <hari>|<jam>|<matkul>|<dosen>|<note>\`
• \`!bot jadwal hapus <matkul>\` : Hapus jadwal perkuliahan.
• \`!bot kuliah\` : Cek status perkuliahan khusus (batal/online/pindah).
• \`!bot kuliah batal <matkul> [alasan]\` : Tandai kelas kosong/batal 1x (Admin).
• \`!bot kuliah online <matkul> <link>\` : Alihkan kelas jadi online 1x (Admin).
• \`!bot kuliah pindah <matkul> <hari> <jam> [ruang]\` : Pindah jadwal/kuliah pengganti 1x (Admin).
• \`!bot kuliah normal <matkul>\` : Kembalikan status kuliah ke normal (Admin).

*📌 TUGAS & BARANG BAWAAN (1X PAKAI)*
• \`!bot tugas\` : Lihat seluruh daftar tugas & barang bawaan aktif.
• \`!bot tugas <matkul/id> <catatan>\` : Set tugas/bawaan 1x pertemuan berikutnya (Admin).
  _Contoh: \`!bot tugas kalkulus bawa modul bab 3 & kalkulator\`_
• \`!bot tugas hapus <matkul/id>\` : Hapus catatan tugas (Admin).

*🎰 ACAK KELOMPOK (SPIN)*
• \`!bot spin <jumlah>\` : Bagi kelompok berdasarkan target jumlah orang/kelompok (Admin).
  _Sisa otomatis dilebur seimbang (misal jadi 5, 6, atau 7 orang per kelompok)._
• \`!bot spin <jumlah> cewe: nama1, nama2...\` : Pisahkan seluruh cewek jadi 1 kelompok khusus (Admin).
  _Contoh: \`!bot spin 5 cewe: Ani, Bunga, Citra, Dewi\`_
• \`!bot spin kelompok <jumlah>\` : Bagi rata seluruh mahasiswa ke N kelompok (Admin).
  _Contoh: \`!bot spin kelompok 4\`_

🌐 _Anda juga dapat mengelola data lewat Web Dashboard._
`.trim();
      await reply(menuText);
      break;
    }

    case 'setgroup': {
      if (!isGroup) {
        await reply('❌ Perintah ini hanya bisa dijalankan di dalam grup WhatsApp.');
        return;
      }
      await messageService.setSetting('target_group_jid', groupJid);
      await reply(`✅ Berhasil! Grup ini didaftarkan sebagai *Grup Kelas Utama* untuk pengingat otomatis.\n\nID Grup: \`${groupJid}\``);
      break;
    }

    case 'delgroup':
    case 'unsetgroup': {
      await messageService.setSetting('target_group_jid', '');
      await reply('✅ Pendaftaran *Grup Kelas Utama* berhasil dihapus. Bot tidak akan mengirimkan pengingat jadwal ke grup ini lagi.');
      break;
    }

    case 'settestgroup': {
      if (!isGroup) {
        await reply('❌ Perintah ini hanya bisa dijalankan di dalam grup WhatsApp.');
        return;
      }
      await messageService.setSetting('test_group_jid', groupJid);
      await reply(`🧪 Berhasil! Grup ini didaftarkan sebagai *Grup Testing / Uji Coba*.\n\nAnda dapat menguji fitur bot di sini tanpa mengganggu grup utama. Untuk simulasi pengingat jadwal, ketik:\n\`!bot test reminder\`\n\nID Grup Testing: \`${groupJid}\``);
      break;
    }

    case 'deltestgroup':
    case 'unsettestgroup': {
      await messageService.setSetting('test_group_jid', '');
      await reply('✅ Pendaftaran *Grup Testing* berhasil dihapus.');
      break;
    }

    case 'test': {
      const testAction = (args[2] || '').toLowerCase();
      if (testAction === 'start') {
        const session = await kasService.startTestSession();
        await reply(
          `🧪 *SESI UJI COBA RESMI DIMULAI!*\n\n` +
          `• Snapshot Data: Mahasiswa ID *${session.maxM}*, Transaksi ID *${session.maxT}*, Jadwal ID *${session.maxS || 0}*\n` +
          `• Waktu Mulai: ${new Date().toLocaleTimeString('id-ID')}\n\n` +
          `Semua data mahasiswa, transaksi, dan jadwal baru yang dibuat mulai sekarang ditandai sebagai data tes.\n` +
          `Silakan ikuti skenario pengujian fitur.\n\n` +
          `👉 *Selesai uji coba?* Cukup ketik:\n\`!bot test reset\`\nuntuk menghapus bersih semua data tes ini!`
        );
      } else if (testAction === 'reset' || testAction === 'cleanup') {
        const res = await kasService.resetTestSession();
        if (!res.success) {
          await reply(`⚠️ ${res.message}\nKetik \`!bot test start\` untuk membuka sesi uji coba baru.`);
        } else {
          const summary = await kasService.getSaldoSummary();
          await reply(
            `🧹 *PEMBERSIHAN DATA TES SELESAI!*\n\n` +
            `• Mahasiswa tes dihapus: *${res.deletedMembers} orang*\n` +
            `• Transaksi kas tes dihapus: *${res.deletedTransactions} transaksi*\n` +
            `• Catatan iuran tes dihapus: *${res.deletedIuran} catatan*\n` +
            `• Jadwal kuliah tes dihapus: *${res.deletedSchedules || 0} jadwal*\n\n` +
            `💎 Sisa Saldo Kas Bersih: *${formatter.formatRupiah(summary.saldo)}*\n` +
            `✅ Database telah bersih kembali ke kondisi semula sebelum sesi uji coba dimulai!`
          );
        }
      } else if (testAction === 'status') {
        const status = await kasService.getTestSessionStatus();
        if (!status.active) {
          await reply('ℹ️ Saat ini belum ada sesi uji coba yang aktif.\nKetik `!bot test start` untuk memulai.');
        } else {
          await reply(
            `🧪 *STATUS SESI UJI COBA AKTIF*\n\n` +
            `• Waktu mulai: ${status.startedAt}\n` +
            `• Mahasiswa baru yang dibuat: *${status.testMembersCount} orang*\n` +
            `• Transaksi kas yang dibuat: *${status.testTxCount} transaksi*\n` +
            `• Jadwal baru yang dibuat: *${status.testSchedulesCount || 0} jadwal*\n\n` +
            `Ketik \`!bot test reset\` kapan saja untuk menghapus semua data tes ini.`
          );
        }
      } else if (testAction === 'reminder') {
        const testGroupJid = await messageService.getSetting('test_group_jid');
        const targetJid = isGroup ? groupJid : (testGroupJid || null);

        if (!targetJid) {
          await reply('❌ Grup testing belum didaftarkan. Jalankan perintah ini di dalam grup testing atau daftarkan dengan `!bot settestgroup`.');
          return;
        }

        const todaySchedules = await jadwalService.getTodaySchedules();
        let sampleSchedule = todaySchedules[0];
        if (!sampleSchedule) {
          const allSchedules = await jadwalService.getAllSchedules();
          sampleSchedule = allSchedules[0] || {
            course_name: 'Simulasi Algoritma & Pemrograman',
            lecturer: 'Dosen Pembimbing, M.Kom',
            start_time: '08:00:00',
            end_time: '10:30:00',
            note: 'Ruang Lab Komputer / Simulasi',
            day_of_week: 'senin'
          };
        }

        const template = await messageService.getTemplate('reminder_5h') || {
          content: '⏳ [PENGINGAT KULIAH H-5 JAM]\n\n📚 Mata Kuliah: *{matkul}*\n👨‍🏫 Dosen: *{dosen}*\n⏰ Jam: *{jam}*\n📝 Ruangan / Catatan: *{note}*\n\n_Pengingat ini otomatis dari Bot Kelas._'
        };

        let mentions = [];
        try {
          const metadata = await getCachedGroupMetadata(sock, targetJid);
          if (metadata && Array.isArray(metadata.participants)) {
            mentions = metadata.participants.map(p => p.id);
          }
        } catch (e) {
          // metadata error ignored
        }

        const msgContent = `🧪 *[SIMULASI UJI COBA REMINDER]*\n\n` + messageService.buildReminderMessage(template.content, sampleSchedule);
        await sock.sendMessage(targetJid, { text: msgContent, mentions });

        if (!isGroup || targetJid !== groupJid) {
          await reply(`✅ Simulasi pengingat kuliah berhasil dikirim ke grup testing (\`${targetJid}\`).`);
        }
      } else {
        await reply(
          'ℹ️ *MENU PERINTAH PENGUJIAN (TEST SUITE):*\n\n' +
          '• `!bot test start` : Memulai sesi uji coba (merekam snapshot database).\n' +
          '• `!bot test status` : Cek jumlah data tes yang dibuat selama sesi.\n' +
          '• `!bot test reminder` : Kirim simulasi pengingat jadwal kuliah ke grup testing.\n' +
          '• `!bot test reset` : Hapus seluruh data tes & pulihkan database bersih!'
        );
      }
      break;
    }

    case 'tampil': {
      const target = (firstToken === '!tampil' ? args[1] : args[2] || '').toLowerCase();
      if (target === 'nim') {
        const members = await kasService.getMembers();
        if (members.length === 0) {
          await reply('ℹ️ Belum ada anggota kelas yang terdaftar.');
          return;
        }
        let listText = `📋 *DAFTAR MAHASISWA & NIM (${members.length})*\n\n`;
        members.forEach((m, idx) => {
          const nimTag = m.nim ? `[${m.nim}]` : `[-]`;
          listText += `${idx + 1}. ${nimTag} *${m.name}* ${m.is_active ? '' : '(Nonaktif)'}\n`;
        });
        await reply(listText.trim());
      } else {
        await reply('❌ Format perintah salah! Gunakan: `!tampil nim`');
      }
      break;
    }

    case 'member': {
      const action = (args[2] || '').toLowerCase();
      if (action === 'list') {
        const isNimMode = (args[3] || '').toLowerCase() === 'nim';
        const members = await kasService.getMembers();
        if (members.length === 0) {
          await reply('ℹ️ Belum ada anggota kelas yang terdaftar.');
          return;
        }
        let listText = isNimMode 
          ? `📋 *DAFTAR MAHASISWA & NIM (${members.length})*\n\n`
          : `📋 *DAFTAR ANGGOTA KELAS (${members.length})*\n\n`;

        members.forEach((m, idx) => {
          if (isNimMode) {
            const nimTag = m.nim ? `[${m.nim}]` : `[-]`;
            listText += `${idx + 1}. ${nimTag} *${m.name}* ${m.is_active ? '' : '(Nonaktif)'}\n`;
          } else {
            listText += `${idx + 1}. [ID: ${m.id}] *${m.name}* ${m.is_active ? '' : '(Nonaktif)'}\n`;
          }
        });
        await reply(listText.trim());
      } else if (action === 'nim') {
        const targetParam = args[3];
        const nimParam = args[4];

        // Jika hanya !bot member nim tanpa parameter, tampilkan list ber-NIM
        if (!targetParam) {
          const members = await kasService.getMembers();
          if (members.length === 0) {
            await reply('ℹ️ Belum ada anggota kelas yang terdaftar.');
            return;
          }
          let listText = `📋 *DAFTAR MAHASISWA & NIM (${members.length})*\n\n`;
          members.forEach((m, idx) => {
            const nimTag = m.nim ? `[${m.nim}]` : `[-]`;
            listText += `${idx + 1}. ${nimTag} *${m.name}* ${m.is_active ? '' : '(Nonaktif)'}\n`;
          });
          await reply(listText.trim());
          return;
        }

        if (!nimParam) {
          await reply('❌ Format salah!\nGunakan: `!bot member nim <nama/id> <nim>`\nContoh: `!bot member nim kiki 10123026`');
          return;
        }

        const res = await kasService.updateMemberNim(targetParam, nimParam);
        if (res.success) {
          await reply(`✅ Berhasil! NIM untuk *${res.member.name}* telah diatur menjadi *${res.member.nim}*.`);
        } else if (res.status === 'ambiguous') {
          const candList = res.matches.map((c, i) => `${i + 1}. *${c.name}* (ID: ${c.id})`).join('\n');
          await reply(
            `⚠️ Ditemukan beberapa nama yang mirip dengan "*${targetParam}*":\n${candList}\n\n` +
            `Gunakan ID untuk lebih spesifik, contoh:\n\`!bot member nim ${res.matches[0].id} ${nimParam}\``
          );
        } else {
          await reply(`❌ Mahasiswa dengan nama/ID "*${targetParam}*" tidak ditemukan.`);
        }
      } else if (action === 'tambah') {
        const raw = args.slice(3).join(' ');
        if (!raw) {
          await reply('❌ Format salah! Gunakan: `!bot member tambah <nama>` atau pisahkan koma untuk banyak nama');
          return;
        }
        const names = raw.split(',').map(n => n.trim()).filter(Boolean);
        if (names.length === 1) {
          const newId = await kasService.addMember({ name: names[0] });
          await reply(`✅ Anggota berhasil ditambahkan!\nID: *${newId}*\nNama: *${names[0]}*`);
        } else {
          const count = await kasService.addBulkMembers(names.map(n => ({ name: n })));
          await reply(`✅ Berhasil menambahkan *${count} mahasiswa* sekaligus ke kelas!`);
        }
      } else {
        await reply('❌ Format salah! Pilihan:\n`!bot member list`\n`!tampil nim` (atau `!bot member list nim`)\n`!bot member nim <nama> <nim>`\n`!bot member tambah <nama>`');
      }
      break;
    }

    case 'kas': {
      const action = (args[2] || '').toLowerCase();

      if (action === 'saldo') {
        const summary = await kasService.getSaldoSummary();
        const text = `
💰 *RINGKASAN BUKU KAS KELAS*

💵 *Total Pemasukan* : ${formatter.formatRupiah(summary.totalMasuk)}
💸 *Total Pengeluaran* : ${formatter.formatRupiah(summary.totalKeluar)}
--------------------------------
💎 *SISA SALDO KAS*   : *${formatter.formatRupiah(summary.saldo)}*
`.trim();
        await reply(text);
      } else if (action === 'masuk') {
        const entries = parseKasEntries(rawText);

        if (entries.length === 0) {
          await reply(
            '❌ Format salah!\n\n' +
            '*Contoh 1 Mahasiswa:*\n`!bot kas masuk 10000 Rouf`\n\n' +
            '*Contoh Banyak Mahasiswa (Bebas Baris/Poin):*\n' +
            '!bot kas masuk\n' +
            '- 10k Rouf\n' +
            '- 10000 Budi\n' +
            '- 10k Siti'
          );
          return;
        }

        const activeWeekSetting = await messageService.getSetting('active_semester_week', '1');
        const targetWeek = parseInt(activeWeekSetting, 10) || 1;
        const targetYear = new Date().getFullYear();

        const successList = [];
        const ambiguousList = [];
        const notFoundList = [];
        const invalidList = [];

        for (const entry of entries) {
          if (!entry.amount || entry.amount <= 0) {
            invalidList.push(entry);
            continue;
          }

          const matchResult = await kasService.searchMemberFuzzy(entry.name);

          if (matchResult.status === 'single') {
            const member = matchResult.matches[0];
            const rec = await kasService.recordIuranWeekly({
              member_id: member.id,
              week_number: targetWeek,
              year: targetYear,
              amount: entry.amount,
              created_by: senderNumber,
              source: 'bot_wa'
            });
            successList.push({
              member,
              amount: entry.amount,
              inputName: entry.name,
              isTypo: matchResult.type === 'fuzzy',
              isLunas: rec.isLunas,
              totalAccumulated: rec.totalAccumulated,
              target: rec.target,
              remaining: rec.remaining
            });
          } else if (matchResult.status === 'ambiguous') {
            ambiguousList.push({
              amount: entry.amount,
              inputName: entry.name,
              candidates: matchResult.matches
            });
          } else {
            notFoundList.push({
              amount: entry.amount,
              inputName: entry.name
            });
          }
        }

        const summary = await kasService.getSaldoSummary();

        // 1. Jika hanya 1 entri dan sukses
        if (entries.length === 1 && successList.length === 1) {
          const s = successList[0];
          const typoNote = s.isTypo ? ` _(Otomatis mencocokkan dari '${s.inputName}')_` : '';
          const statusText = s.isLunas
            ? '🎉 *Lunas*'
            : `🟡 *Cicilan* (Masuk: ${formatter.formatRupiah(s.totalAccumulated)} / Target ${formatter.formatRupiah(s.target)} — Kurang: *${formatter.formatRupiah(s.remaining)}*)`;
          await reply(
            `✅ *KAS MASUK BERHASIL DICATAT*\n\n` +
            `👤 Anggota: *${s.member.name}*${typoNote}\n` +
            `💵 Jumlah : *${formatter.formatRupiah(s.amount)}*\n` +
            `📊 Status : ${statusText}\n` +
            `📅 Periode: Minggu ke-${targetWeek} (${targetYear})\n` +
            `💎 Saldo Kas Kini: *${formatter.formatRupiah(summary.saldo)}*`
          );
          return;
        }

        // 1b. Jika hanya 1 entri dan tidak ditemukan
        if (entries.length === 1 && notFoundList.length === 1) {
          await reply(`❌ Nama "*${notFoundList[0].inputName}*" tidak terdaftar, harap cek ulang atau tambahkan baru di Data Mahasiswa.`);
          return;
        }

        // 2. Susun laporan rekap gabungan
        let report = `💰 *REKAP PENCATATAN KAS MASUK*\n`;

        if (successList.length > 0) {
          report += `\n✅ *BERHASIL DICATAT (${successList.length}):*\n`;
          successList.forEach((s, idx) => {
            const typoNote = s.isTypo ? ` _(dari '${s.inputName}')_` : '';
            const statusLabel = s.isLunas ? 'Lunas' : `Cicil (Kurang ${formatter.formatRupiah(s.remaining)})`;
            report += `${idx + 1}. *${s.member.name}* (${formatter.formatRupiah(s.amount)}) - ${statusLabel}${typoNote}\n`;
          });
          report += `💎 Saldo Kas Kini: *${formatter.formatRupiah(summary.saldo)}*\n`;
        }

        if (notFoundList.length > 0) {
          report += `\n❌ *TIDAK TERDAFTAR (${notFoundList.length}):*\n`;
          notFoundList.forEach((nf) => {
            report += `• Nama "*${nf.inputName}*" (${formatter.formatRupiah(nf.amount)}) tidak terdaftar, harap cek ulang atau tambahkan baru.\n`;
          });
        }

        if (invalidList.length > 0) {
          report += `\n⚠️ *NOMINAL TIDAK VALID (${invalidList.length}):*\n`;
          invalidList.forEach((inv) => {
            report += `• "${inv.originalLine}" (Nominal tidak terbaca)\n`;
          });
        }

        // 3. Jika ada nama yang ambigu, buka sesi interaktif
        if (ambiguousList.length > 0) {
          const sessionKey = `${fromJid}_${senderNumber}`;
          pendingAmbiguousSessions.set(sessionKey, {
            queue: ambiguousList,
            createdAt: Date.now()
          });

          const firstAmb = ambiguousList[0];
          let candList = firstAmb.candidates.map((c, i) => `[${i + 1}] *${c.name}*`).join('\n');

          report += `\n⚠️ *KONFIRMASI DIPERLUKAN (1 dari ${ambiguousList.length}):*\n`;
          report += `Nama "*${firstAmb.inputName}*" (${formatter.formatRupiah(firstAmb.amount)}) cocok dengan ${firstAmb.candidates.length} mahasiswa:\n`;
          report += `${candList}\n\n`;
          report += `👉 _Balas chat ini dengan angka pilihan (*1* sampai *${firstAmb.candidates.length}*), atau ketik *batal*._`;
        }

        await reply(report.trim());
      } else if (action === 'keluar') {
        const amountStr = args[3];
        const nominal = parseAmount(amountStr);
        const desc = args.slice(4).join(' ').trim();

        if (!nominal || nominal <= 0 || !desc) {
          await reply('❌ Format salah!\nGunakan: `!bot kas keluar <nominal> <keterangan>`\nContoh: `!bot kas keluar 25000 Beli spidol & penghapus`');
          return;
        }

        await kasService.addTransaction({
          type: 'keluar',
          amount: nominal,
          description: desc,
          source: 'bot_wa',
          created_by: senderNumber
        });

        const summary = await kasService.getSaldoSummary();
        await reply(`✅ *PENGELUARAN KAS DICATAT*\n\n📝 Ket    : *${desc}*\n💸 Jumlah : *${formatter.formatRupiah(nominal)}*\n💎 Saldo Kas Kini: *${formatter.formatRupiah(summary.saldo)}*`);
      } else if (action === 'koreksi' || action === 'edit' || action === 'ubah') {
        const rawParams = args.slice(3).join(' ').trim();
        const entries = formatter.parseKasEntries(rawParams);

        if (entries.length === 0) {
          await reply(
            '❌ Format koreksi salah!\n\n' +
            '*Gunakan:*\n`!bot kas koreksi <nama> <nominal_baru>`\n' +
            'atau\n`!bot kas koreksi <nominal_baru> <nama>`\n\n' +
            '*Contoh:*\n' +
            '• `!bot kas koreksi kiki 10000`\n' +
            '• `!bot kas koreksi kiki 10k`\n' +
            '• `!bot kas koreksi 10k kiki`\n' +
            '• `!bot kas koreksi kiki 0` _(reset ke 0 jika salah catat)_'
          );
          return;
        }

        const entry = entries[0];
        const matchResult = await kasService.searchMemberFuzzy(entry.name);

        if (matchResult.status === 'not_found' || matchResult.matches.length === 0) {
          await reply(`❌ Mahasiswa dengan nama "*${entry.name}*" tidak ditemukan. Pastikan nama sesuai data kelas.`);
          return;
        }

        if (matchResult.status === 'ambiguous' && matchResult.matches.length > 1) {
          const candList = matchResult.matches.map((c, i) => `${i + 1}. *${c.name}*`).join('\n');
          await reply(
            `⚠️ Ditemukan beberapa nama yang mirip dengan "*${entry.name}*":\n${candList}\n\n` +
            `Silakan ketik nama lebih spesifik, contoh:\n` +
            `\`!bot kas koreksi ${matchResult.matches[0].name} ${entry.amount}\``
          );
          return;
        }

        const member = matchResult.matches[0];
        const activeWeekSetting = await messageService.getSetting('active_semester_week', '1');
        const targetWeek = parseInt(activeWeekSetting, 10) || 1;
        const targetYear = new Date().getFullYear();

        const result = await kasService.correctMemberIuran({
          member_id: member.id,
          new_amount: entry.amount,
          week_number: targetWeek,
          year: targetYear,
          created_by: senderNumber,
          source: 'bot_wa'
        });

        if (result.unchanged) {
          await reply(`ℹ️ Nominal iuran *${member.name}* sudah bernilai *${formatter.formatRupiah(result.newAmount)}*, tidak ada perubahan.`);
          return;
        }

        const summary = await kasService.getSaldoSummary();
        const diffText = result.diff < 0
          ? `🔴 Berkurang: -${formatter.formatRupiah(Math.abs(result.diff))}`
          : `🟢 Bertambah: +${formatter.formatRupiah(result.diff)}`;

        const statusText = result.isLunas
          ? '🎉 *Lunas*'
          : (result.newAmount > 0
              ? `🟡 *Cicilan* (Masuk: ${formatter.formatRupiah(result.newAmount)} / Target ${formatter.formatRupiah(result.target)} — Kurang: *${formatter.formatRupiah(result.remaining)}*)`
              : '❌ *Belum Bayar*'
            );

        await reply(
          `✅ *KOREKSI IURAN KAS BERHASIL*\n\n` +
          `👤 Mahasiswa : *${member.name}*\n` +
          `💵 Nominal Lama : ${formatter.formatRupiah(result.oldAmount)}\n` +
          `💵 Nominal Baru : *${formatter.formatRupiah(result.newAmount)}*\n` +
          `⚖️ Penyesuaian  : ${diffText}\n` +
          `📊 Status Iuran : ${statusText}\n` +
          `📅 Periode      : Minggu ke-${targetWeek} (${targetYear})\n` +
          `💎 Saldo Kas Kini: *${formatter.formatRupiah(summary.saldo)}*`
        );
      } else if (action === 'mutasi' || action === 'riwayat') {
        const txs = await kasService.getRecentTransactions(10);
        if (txs.length === 0) {
          await reply('ℹ️ Belum ada riwayat mutasi kas.');
          return;
        }

        let mutasiText = `📊 *10 MUTASI KAS TERAKHIR*\n\n`;
        txs.forEach((t) => {
          const icon = t.type === 'masuk' ? '🟢 +' : '🔴 -';
          const memberTag = t.member_name ? ` (${t.member_name})` : '';
          mutasiText += `${icon} *${formatter.formatRupiah(t.amount)}*\n   📝 ${t.description}${memberTag}\n\n`;
        });
        await reply(mutasiText.trim());
      } else if (action === 'bulan' || action === 'bulanan') {
        const monthInput = args.slice(3).join(' ');
        const targetMonth = formatter.parseMonthInput(monthInput);
        const status = await kasService.getMonthlyStatus(targetMonth, null, monthInput);

        let outText = `📋 *STATUS UANG KAS BULAN ${status.monthLabel || status.monthName.toUpperCase()} (${status.year})*\n`;
        outText += `👥 Total: ${status.totalMembers} | ✅ Lunas: ${status.totalPaid} | 🟡 Cicil: ${status.totalPartial} | ❌ Belum: ${status.totalUnpaid}\n`;
        outText += `💰 Terkumpul: *${formatter.formatRupiah(status.totalAmountPaid)}*\n\n`;

        outText += `*✅ LUNAS (${status.totalPaid}):*\n`;
        if (status.paidMembers.length === 0) {
          outText += `_Belum ada yang melunasi kas di bulan ${status.monthName}._\n`;
        } else {
          status.paidMembers.forEach((m, idx) => {
            outText += `${idx + 1}. *${m.name}* — ${formatter.formatRupiah(m.allocated)}\n`;
          });
        }

        if (status.partialMembers.length > 0) {
          outText += `\n*🟡 MENYICIL / SEBAGIAN (${status.totalPartial}):*\n`;
          status.partialMembers.forEach((m, idx) => {
            outText += `${idx + 1}. *${m.name}* — Masuk: ${formatter.formatRupiah(m.allocated)} (Kurang: *${formatter.formatRupiah(m.remaining)}*)\n`;
          });
        }

        outText += `\n*❌ BELUM MEMBAYAR (${status.totalUnpaid}):*\n`;
        if (status.unpaidMembers.length === 0) {
          outText += `🎉 _Luar biasa! Tidak ada tunggakan di bulan ini._\n`;
        } else {
          status.unpaidMembers.forEach((m, idx) => {
            outText += `${idx + 1}. ${m.name}\n`;
          });
        }

        await reply(outText.trim());
      } else if (action === 'lunas') {
        const monthInput = args.slice(3).join(' ');
        const targetMonth = formatter.parseMonthInput(monthInput);
        const status = await kasService.getMonthlyStatus(targetMonth, null, monthInput);

        let outText = `✅ *DAFTAR LUNAS UANG KAS - BULAN ${status.monthLabel || status.monthName.toUpperCase()} (${status.year})*\n`;
        outText += `👥 Total: ${status.totalPaid} dari ${status.totalMembers} anggota | 💰 Terkumpul: *${formatter.formatRupiah(status.totalAmountPaid)}*\n\n`;

        if (status.paidMembers.length === 0) {
          outText += `_Belum ada anggota yang melunasi uang kas di bulan ${status.monthName}._`;
        } else {
          status.paidMembers.forEach((m, idx) => {
            outText += `${idx + 1}. *${m.name}* — ${formatter.formatRupiah(m.allocated)}\n`;
          });
        }

        await reply(outText.trim());
      } else if (action === 'cicil' || action === 'nyicil') {
        const monthInput = args.slice(3).join(' ');
        const targetMonth = formatter.parseMonthInput(monthInput);
        const status = await kasService.getMonthlyStatus(targetMonth, null, monthInput);

        let outText = `🟡 *DAFTAR CICILAN UANG KAS - BULAN ${status.monthLabel || status.monthName.toUpperCase()} (${status.year})*\n`;
        outText += `👥 Anggota Menyicil: ${status.totalPartial} orang | Target Kas: *${formatter.formatRupiah(status.target)}*\n\n`;

        if (status.partialMembers.length === 0) {
          outText += `🎉 _Tidak ada anggota yang berstatus cicilan di bulan ${status.monthName}._`;
        } else {
          status.partialMembers.forEach((m, idx) => {
            outText += `${idx + 1}. *${m.name}*\n   💵 Masuk : ${formatter.formatRupiah(m.allocated)}\n   ⚠️ Kurang: *${formatter.formatRupiah(m.remaining)}*\n\n`;
          });
        }

        await reply(outText.trim());
      } else if (action === 'belum') {
        const monthInput = args.slice(3).join(' ');
        const targetMonth = formatter.parseMonthInput(monthInput);
        const status = await kasService.getMonthlyStatus(targetMonth, null, monthInput);

        let outText = `❌ *DAFTAR BELUM BAYAR UANG KAS - BULAN ${status.monthLabel || status.monthName.toUpperCase()} (${status.year})*\n`;
        outText += `👥 Total Belum: ${status.totalUnpaid} dari ${status.totalMembers} anggota\n\n`;

        if (status.unpaidMembers.length === 0) {
          outText += `🎉 _Semua anggota telah membayar uang kas bulan ${status.monthName}!_`;
        } else {
          status.unpaidMembers.forEach((m, idx) => {
            outText += `${idx + 1}. ${m.name}\n`;
          });
        }

        await reply(outText.trim());
      } else if (action === 'status' || action === 'iuran') {
        const inputParam = args.slice(3).join(' ').trim().toLowerCase();
        
        // Cek jika user menyertakan keyword bulan (contoh: !bot kas status bulan 1, !bot kas status oktober)
        if (inputParam.startsWith('bulan') || /^(jan|feb|mar|apr|mei|jun|jul|agu|agt|sep|okt|nov|des)/i.test(inputParam)) {
          const targetMonth = formatter.parseMonthInput(inputParam);
          const status = await kasService.getMonthlyStatus(targetMonth, null, inputParam);

          let outText = `📋 *STATUS UANG KAS BULAN ${status.monthLabel || status.monthName.toUpperCase()} (${status.year})*\n`;
          outText += `👥 Total: ${status.totalMembers} | ✅ Lunas: ${status.totalPaid} | 🟡 Cicil: ${status.totalPartial} | ❌ Belum: ${status.totalUnpaid}\n`;
          outText += `💰 Terkumpul: *${formatter.formatRupiah(status.totalAmountPaid)}*\n\n`;

          outText += `*✅ LUNAS (${status.totalPaid}):*\n`;
          if (status.paidMembers.length === 0) {
            outText += `_Belum ada yang melunasi kas di bulan ${status.monthName}._\n`;
          } else {
            status.paidMembers.forEach((m, idx) => {
              outText += `${idx + 1}. *${m.name}* — ${formatter.formatRupiah(m.allocated)}\n`;
            });
          }

          if (status.partialMembers.length > 0) {
            outText += `\n*🟡 MENYICIL / SEBAGIAN (${status.totalPartial}):*\n`;
            status.partialMembers.forEach((m, idx) => {
              outText += `${idx + 1}. *${m.name}* — Masuk: ${formatter.formatRupiah(m.allocated)} (Kurang: *${formatter.formatRupiah(m.remaining)}*)\n`;
            });
          }

          outText += `\n*❌ BELUM MEMBAYAR (${status.totalUnpaid}):*\n`;
          if (status.unpaidMembers.length === 0) {
            outText += `🎉 _Luar biasa! Seluruh anggota telah lunas di bulan ini._\n`;
          } else {
            status.unpaidMembers.forEach((m, idx) => {
              outText += `${idx + 1}. ${m.name}\n`;
            });
          }

          await reply(outText.trim());
          return;
        }

        const targetWeek = args[3] ? parseInt(args[3], 10) : null;
        const status = await kasService.getWeeklyStatus(targetWeek);

        let statusText = `📋 *STATUS IURAN MINGGU KE-${status.week} (${status.year})*\n`;
        statusText += `👥 Total: ${status.totalMembers} | ✅ Lunas: ${status.totalPaid} | ❌ Belum: ${status.totalUnpaid}\n\n`;

        statusText += `*❌ BELUM BAYAR (${status.totalUnpaid}):*\n`;
        if (status.unpaidMembers.length === 0) {
          statusText += `🎉 _Semua anggota telah lunas!_\n`;
        } else {
          status.unpaidMembers.forEach((m, idx) => {
            statusText += `${idx + 1}. ${m.name}\n`;
          });
        }

        statusText += `\n*✅ SUDAH BAYAR (${status.totalPaid}):*\n`;
        if (status.paidMembers.length === 0) {
          statusText += `_Belum ada yang membayar._\n`;
        } else {
          status.paidMembers.forEach((m, idx) => {
            statusText += `${idx + 1}. ${m.name} (${formatter.formatRupiah(m.amount)})\n`;
          });
        }

        await reply(statusText.trim());
      } else {
        await reply('❌ Perintah kas tidak dikenali. Pilihan:\n`!bot kas saldo`\n`!bot kas bulan [1-12/nama bulan]`\n`!bot kas lunas [bulan]`\n`!bot kas cicil [bulan]`\n`!bot kas belum [bulan]`\n`!bot kas masuk <nominal> [nama]`\n`!bot kas koreksi <nama> <nominal>`\n`!bot kas keluar <nominal> <ket>`\n`!bot kas mutasi`\n`!bot kas status [minggu]`');
      }
      break;
    }

    case 'jadwal': {
      const action = (args[2] || '').toLowerCase();

      if (!action || action === 'list') {
        const todayDay = formatter.getIndonesianDayName();
        const todaySchedules = await jadwalService.getTodaySchedules(todayDay);
        const allSchedules = await jadwalService.getAllSchedules(true);

        let outText = `📚 *JADWAL KULIAH HARI INI (${todayDay.toUpperCase()})*\n\n`;
        if (todaySchedules.length === 0) {
          outText += `🎉 _Tidak ada perkuliahan hari ini!_\n\n`;
        } else {
          todaySchedules.forEach((s) => {
            outText += formatScheduleCard(s, true) + '\n\n';
          });
        }

        outText += `🗓️ *SELURUH JADWAL PERKULIAHAN*\n\n`;
        if (allSchedules.length === 0) {
          outText += `_Belum ada jadwal yang terdaftar._`;
        } else {
          const dayOrder = ['senin', 'selasa', 'rabu', 'kamis', 'jumat', 'sabtu', 'minggu'];
          const grouped = {};
          for (const s of allSchedules) {
            const d = s.day_of_week.toLowerCase();
            if (!grouped[d]) grouped[d] = [];
            grouped[d].push(s);
          }

          for (const d of dayOrder) {
            if (grouped[d] && grouped[d].length > 0) {
              outText += `*${d.toUpperCase()}*\n\n`;
              for (const s of grouped[d]) {
                outText += formatScheduleCard(s, false) + '\n\n';
              }
            }
          }
        }

        await reply(outText.trim());
      } else if (action === 'tugas') {
        await handleTugasCommand(rawText, ['!bot', 'tugas', ...args.slice(3)], reply);
      } else if (['batal', 'online', 'pindah', 'normal', 'reset', 'cancel', 'kosong', 'daring', 'zoom', 'ganti', 'reschedule'].includes(action)) {
        await handleKuliahCommand(rawText, ['!bot', 'kuliah', ...args.slice(2)], messageInfo, reply, isAdmin, sock);
      } else if (action === 'tambah') {
        const parsed = parseScheduleLines(rawText);

        if (parsed.length === 0) {
          await reply(
            `❌ Format tidak terbaca!\n\n` +
            `*Contoh Format Bebas / Rapi:*\n` +
            `!bot jadwal tambah\n` +
            `*SENIN*\n` +
            `- Kalkulus\n` +
            `🕧 07.00 s.d 09.30\n` +
            `📍 R5406 (Gedung Miracle)\n` +
            `💼 Tatap muka\n` +
            `👩‍🏫 Kania Evita Dewi, S.Pd., M.Si\n\n` +
            `*Atau Format Ringkas (Pipa):*\n` +
            `\`!bot jadwal tambah senin|07:00-09:30|Kalkulus|Kania Evita Dewi|R5406\``
          );
          return;
        }

        if (parsed.length === 1) {
          const s = parsed[0];
          await jadwalService.addSchedule(s);
          await reply(
            `✅ *JADWAL BERHASIL DITAMBAHKAN!*\n\n` +
            `*${s.day_of_week.toUpperCase()}*\n` +
            `• 📖 *${s.course_name}*\n` +
            `  🕧 ${formatter.formatTime(s.start_time)} s.d ${formatter.formatTime(s.end_time)} WIB\n` +
            (s.note ? `  📍 ${s.note}\n` : '') +
            `  👩‍🏫 ${s.lecturer}`
          );
        } else {
          const inserted = await jadwalService.addBulkSchedules(parsed);
          let replyMsg = `✅ *BERHASIL MENAMBAHKAN ${inserted.length} JADWAL KULIAH!*\n\n`;
          const dayOrder = ['senin', 'selasa', 'rabu', 'kamis', 'jumat', 'sabtu', 'minggu'];
          const grouped = {};
          for (const s of inserted) {
            const d = s.day_of_week.toLowerCase();
            if (!grouped[d]) grouped[d] = [];
            grouped[d].push(s);
          }

          for (const d of dayOrder) {
            if (grouped[d] && grouped[d].length > 0) {
              replyMsg += `*${d.toUpperCase()}*\n`;
              for (const s of grouped[d]) {
                replyMsg += `• *${s.course_name}* (${formatter.formatTime(s.start_time)} s.d ${formatter.formatTime(s.end_time)} WIB)\n`;
                if (s.note) replyMsg += `  📍 ${s.note}\n`;
              }
              replyMsg += `\n`;
            }
          }
          replyMsg += `Ketik \`!bot jadwal\` untuk melihat jadwal lengkap.`;
          await reply(replyMsg.trim());
        }
      } else if (action === 'hapus') {
        const queryStr = args.slice(3).join(' ').trim();
        if (!queryStr) {
          await reply('❌ Masukkan nama mata kuliah yang ingin dihapus.\nContoh: `!bot jadwal hapus kalkulus`');
          return;
        }
        const s = await jadwalService.findScheduleByQuery(queryStr);
        if (!s) {
          await reply(`❌ Jadwal untuk "${queryStr}" tidak ditemukan.\nKetik \`!bot jadwal\` untuk melihat daftar jadwal.`);
          return;
        }
        await jadwalService.deleteSchedule(s.id);
        await reply(`✅ Jadwal perkuliahan *${s.course_name}* (${s.day_of_week.toUpperCase()}) berhasil dihapus.`);
      } else {
        await reply(
          '❌ Perintah jadwal tidak dikenali.\n\nPilihan:\n' +
          '• `!bot jadwal`\n' +
          '• `!bot jadwal tambah <format>`\n' +
          '• `!bot jadwal hapus <nama matkul>`\n' +
          '• `!bot kuliah batal/online/pindah/normal`\n' +
          '• `!bot tugas <matkul> <catatan>`'
        );
      }
      break;
    }

    case 'kuliah': {
      await handleKuliahCommand(rawText, args, messageInfo, reply, isAdmin, sock);
      break;
    }

    case 'tugas': {
      await handleTugasCommand(rawText, args, reply);
      break;
    }

    case 'spin':
    case 'acak': {
      await handleSpinCommand(rawText, args, messageInfo, reply);
      break;
    }

    default: {
      await reply(`❓ Perintah \`!bot ${subCmd}\` tidak dikenali. Ketik \`!bot menu\` untuk melihat daftar perintah.`);
      break;
    }
  }
} catch (err) {
  console.error('[COMMAND ERROR]', err);
  await reply(`❌ Terjadi kesalahan saat memproses perintah:\n_${err.message}_`);
}
}

export default {
  handleCommand
};
