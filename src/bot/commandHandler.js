import kasService from '../services/kasService.js';
import jadwalService from '../services/jadwalService.js';
import messageService from '../services/messageService.js';
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

  const rawLines = textWithoutCmd.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const schedules = [];
  const validDays = ['senin', 'selasa', 'rabu', 'kamis', 'jumat', 'sabtu', 'minggu'];

  for (const rawLine of rawLines) {
    const cleanLine = rawLine
      .replace(/^[\d]+[\.\)\-\s]+\s*/, '')
      .replace(/^[\*\-\•\–\—]\s*/, '')
      .trim();

    if (!cleanLine) continue;
    const parts = cleanLine.split('|');
    if (parts.length < 4) continue;

    const day = parts[0].trim().toLowerCase();
    if (!validDays.includes(day)) continue;

    const timeParts = parts[1].trim().split('-');
    if (timeParts.length !== 2) continue;

    const startTimeRaw = timeParts[0].trim();
    const endTimeRaw = timeParts[1].trim();

    const startTime = startTimeRaw.length === 5 ? `${startTimeRaw}:00` : startTimeRaw;
    const endTime = endTimeRaw.length === 5 ? `${endTimeRaw}:00` : endTimeRaw;

    const courseName = parts[2].trim();
    const lecturer = parts[3].trim();
    const note = parts[4] ? parts[4].trim() : '';

    schedules.push({
      day_of_week: day,
      start_time: startTime,
      end_time: endTime,
      course_name: courseName,
      lecturer,
      note,
      originalLine: rawLine
    });
  }

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
    const isJadwalAdmin = subCmd === 'jadwal' && ['tambah', 'add', 'hapus', 'del'].includes((args[2] || '').toLowerCase());
    const isTugasAdmin = (subCmd === 'tugas' && args[2] && !['list'].includes(args[2].toLowerCase())) || (subCmd === 'jadwal' && (args[2] || '').toLowerCase() === 'tugas' && args[3] && !['list'].includes(args[3].toLowerCase()));

    const isRestricted = adminCommands.has(subCmd) || isKasAdmin || isMemberAdmin || isJadwalAdmin || isTugasAdmin;

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

*📚 JADWAL KULIAH*
• \`!bot jadwal\` : Lihat jadwal kuliah hari ini & mingguan.
• \`!bot jadwal tambah <hari>|<jam>|<matkul>|<dosen>|<note>\`
  _Contoh: \`!bot jadwal tambah senin|08:00-10:00|Kalkulus|Pak Budi|Bawa tugas 1\`_
• \`!bot jadwal hapus <id>\` : Hapus jadwal kuliah berdasarkan ID.

*📌 TUGAS & BARANG BAWAAN (1X PAKAI)*
• \`!bot tugas\` : Lihat seluruh daftar tugas & barang bawaan aktif.
• \`!bot tugas <matkul/id> <catatan>\` : Set tugas/bawaan 1x pertemuan berikutnya (Admin).
  _Contoh: \`!bot tugas kalkulus bawa modul bab 3 & kalkulator\`_
• \`!bot tugas hapus <matkul/id>\` : Hapus catatan tugas (Admin).

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
            outText += `⏰ *${formatter.formatTime(s.start_time)} - ${formatter.formatTime(s.end_time)}*\n`;
            outText += `📖 *${s.course_name}*\n`;
            outText += `👨‍🏫 Dosen: ${s.lecturer}\n`;
            if (s.note) outText += `📝 Ruang/Ket: ${s.note}\n`;
            if (s.temp_note) outText += `📌 *Tugas/Bawaan (Pertemuan Ini)*: ${s.temp_note}\n`;
            outText += `\n`;
          });
        }

        outText += `🗓️ *SELURUH JADWAL MINGGUAN:*\n`;
        if (allSchedules.length === 0) {
          outText += `_Belum ada jadwal yang terdaftar._`;
        } else {
          allSchedules.forEach((s) => {
            outText += `• [ID: ${s.id}] *${s.day_of_week.toUpperCase()}* (${formatter.formatTime(s.start_time)}-${formatter.formatTime(s.end_time)}) : *${s.course_name}* (${s.lecturer})`;
            if (s.temp_note) outText += ` [📌 Tugas: ${s.temp_note}]`;
            outText += `\n`;
          });
        }

        await reply(outText.trim());
      } else if (action === 'tugas') {
        await handleTugasCommand(rawText, ['!bot', 'tugas', ...args.slice(3)], reply);
      } else if (action === 'tambah') {
        const parsed = parseScheduleLines(rawText);

        if (parsed.length === 0) {
          await reply(
            `❌ Format salah!\n\n` +
            `*Contoh 1 Jadwal:*\n` +
            `\`!bot jadwal tambah senin|08:00-10:00|Kalkulus|Dr. Bambang|Ruang 301\`\n\n` +
            `*Contoh Banyak Jadwal Sekaligus:*\n` +
            `!bot jadwal tambah\n` +
            `- senin|08:00-10:00|Kalkulus|Dr. Bambang|Ruang 301\n` +
            `- selasa|10:00-12:00|Algoritma|Bu Siti|Lab 2\n` +
            `- rabu|13:00-15:00|Basis Data|Pak Joko`
          );
          return;
        }

        if (parsed.length === 1) {
          const s = parsed[0];
          const newId = await jadwalService.addSchedule(s);
          await reply(
            `✅ *JADWAL BERHASIL DITAMBAHKAN!*\n\n` +
            `ID: *${newId}*\n` +
            `Hari: *${s.day_of_week.toUpperCase()}*\n` +
            `Jam: *${formatter.formatTime(s.start_time)} - ${formatter.formatTime(s.end_time)}*\n` +
            `Matkul: *${s.course_name}*\n` +
            `Dosen: *${s.lecturer}*\n` +
            `Catatan: *${s.note || '-'}*`
          );
        } else {
          const inserted = await jadwalService.addBulkSchedules(parsed);
          let replyMsg = `✅ *BERHASIL MENAMBAHKAN ${inserted.length} JADWAL KULIAH SEKALIGUS!*\n\n`;
          inserted.forEach((s, idx) => {
            replyMsg += `${idx + 1}. [ID: ${s.id}] *${s.day_of_week.toUpperCase()}* (${formatter.formatTime(s.start_time)}-${formatter.formatTime(s.end_time)}) : *${s.course_name}* (${s.lecturer})\n`;
          });
          replyMsg += `\nKetik \`!bot jadwal\` untuk melihat seluruh jadwal kuliah.`;
          await reply(replyMsg.trim());
        }
      } else if (action === 'hapus') {
        const id = parseInt(args[3], 10);
        if (!id) {
          await reply('❌ Masukkan ID jadwal yang ingin dihapus.\nContoh: `!bot jadwal hapus 3`');
          return;
        }
        await jadwalService.deleteSchedule(id);
        await reply(`✅ Jadwal dengan ID *${id}* berhasil dihapus.`);
      } else {
        await reply('❌ Perintah jadwal tidak dikenali.\nPilihan:\n`!bot jadwal`\n`!bot jadwal tambah <hari>|<jam>|<matkul>|<dosen>|<note>`\n`!bot jadwal hapus <id>`\n`!bot tugas <matkul/id> <catatan>`');
      }
      break;
    }

    case 'tugas': {
      await handleTugasCommand(rawText, args, reply);
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
