import kasService from '../services/kasService.js';
import jadwalService from '../services/jadwalService.js';
import messageService from '../services/messageService.js';
import formatter from '../utils/formatter.js';

function parseAmount(str) {
  if (!str) return 0;
  let clean = str.toLowerCase().replace(/rp|\.|\,/g, '').trim();
  if (clean.endsWith('k') || clean.endsWith('rb')) {
    clean = clean.replace(/k|rb/g, '');
    return (parseFloat(clean) || 0) * 1000;
  }
  return parseFloat(clean) || 0;
}

export async function handleCommand(sock, messageInfo) {
  const { rawText, fromJid, isGroup, groupJid, senderNumber } = messageInfo;
  const reply = async (text, mentions = []) => {
    await sock.sendMessage(fromJid, { text, mentions }, { quoted: messageInfo.rawMsg });
  };

  const args = rawText.trim().split(/\s+/);
  const subCmd = (args[1] || '').toLowerCase();

  switch (subCmd) {
    case '':
    case 'help':
    case 'menu': {
      const menuText = `
🤖 *PANDUAN PERINTAH BOT BENDAHARA & KELAS*

*👑 PENGATURAN GRUP*
• \`!bot setgroup\` : Daftarkan grup ini sebagai Grup Kelas Utama (pengingat otomatis).
• \`!bot settestgroup\` : Daftarkan grup ini sebagai Grup Testing (uji coba fitur).
• \`!bot test reminder\` : Kirim simulasi pengingat kuliah ke grup testing.

*💰 KAS & IURAN*
• \`!bot kas saldo\` : Lihat total saldo kas & ringkasan.
• \`!bot kas masuk <nominal> [nama/ket]\` : Catat kas masuk / iuran.
  _Contoh: \`!bot kas masuk 20000 Budi\`_
• \`!bot kas keluar <nominal> <ket>\` : Catat pengeluaran kas.
  _Contoh: \`!bot kas keluar 30000 Beli spidol\`_
• \`!bot kas mutasi\` : Lihat 10 transaksi terakhir.
• \`!bot kas status [minggu]\` : Cek iuran mingguan (lunas/belum).

*👥 ANGGOTA KELAS*
• \`!bot member list\` : Daftar seluruh anggota kelas.
• \`!bot member tambah <nama>\` : Tambah anggota baru.

*📚 JADWAL KULIAH*
• \`!bot jadwal\` : Lihat jadwal kuliah hari ini & mingguan.
• \`!bot jadwal tambah <hari>|<jam>|<matkul>|<dosen>|<note>\`
  _Contoh: \`!bot jadwal tambah senin|08:00-10:00|Kalkulus|Pak Budi|Bawa tugas 1\`_
• \`!bot jadwal hapus <id>\` : Hapus jadwal kuliah berdasarkan ID.

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

    case 'settestgroup': {
      if (!isGroup) {
        await reply('❌ Perintah ini hanya bisa dijalankan di dalam grup WhatsApp.');
        return;
      }
      await messageService.setSetting('test_group_jid', groupJid);
      await reply(`🧪 Berhasil! Grup ini didaftarkan sebagai *Grup Testing / Uji Coba*.\n\nAnda dapat menguji fitur bot di sini tanpa mengganggu grup utama. Untuk simulasi pengingat jadwal, ketik:\n\`!bot test reminder\`\n\nID Grup Testing: \`${groupJid}\``);
      break;
    }

    case 'test': {
      const testAction = (args[2] || '').toLowerCase();
      if (testAction === 'reminder') {
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
          const metadata = await sock.groupMetadata(targetJid);
          mentions = metadata.participants.map(p => p.id);
        } catch (e) {
          // metadata error ignored
        }

        const msgContent = `🧪 *[SIMULASI UJI COBA REMINDER]*\n\n` + messageService.buildReminderMessage(template.content, sampleSchedule);
        await sock.sendMessage(targetJid, { text: msgContent, mentions });

        if (!isGroup || targetJid !== groupJid) {
          await reply(`✅ Simulasi pengingat kuliah berhasil dikirim ke grup testing (\`${targetJid}\`).`);
        }
      } else {
        await reply('ℹ️ Format uji coba tersedia:\n• `!bot test reminder` : Kirim simulasi pengingat kuliah ke grup testing.');
      }
      break;
    }

    case 'member': {
      const action = (args[2] || '').toLowerCase();
      if (action === 'list') {
        const members = await kasService.getMembers();
        if (members.length === 0) {
          await reply('ℹ️ Belum ada anggota kelas yang terdaftar.');
          return;
        }
        let listText = `📋 *DAFTAR ANGGOTA KELAS (${members.length})*\n\n`;
        members.forEach((m, idx) => {
          listText += `${idx + 1}. [ID: ${m.id}] *${m.name}* ${m.is_active ? '' : '(Nonaktif)'}\n`;
        });
        await reply(listText.trim());
      } else if (action === 'tambah') {
        const name = args.slice(3).join(' ');
        if (!name) {
          await reply('❌ Format salah! Gunakan: `!bot member tambah <nama>`');
          return;
        }
        const newId = await kasService.addMember({ name });
        await reply(`✅ Anggota berhasil ditambahkan!\nID: *${newId}*\nNama: *${name}*`);
      } else {
        await reply('❌ Format salah! Pilihan: `!bot member list` atau `!bot member tambah <nama>`');
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
        const amountStr = args[3];
        const nominal = parseAmount(amountStr);
        if (!nominal || nominal <= 0) {
          await reply('❌ Masukkan nominal yang valid!\nContoh: `!bot kas masuk 20000 Budi` atau `!bot kas masuk 50k Donasi`');
          return;
        }

        const remainingArgs = args.slice(4).join(' ').trim();
        let member = null;
        if (remainingArgs) {
          member = await kasService.findMemberByName(remainingArgs);
        }

        if (member) {
          const activeWeekSetting = await messageService.getSetting('active_semester_week', '1');
          const targetWeek = parseInt(activeWeekSetting, 10) || 1;
          const targetYear = new Date().getFullYear();

          await kasService.recordIuranWeekly({
            member_id: member.id,
            week_number: targetWeek,
            year: targetYear,
            amount: nominal,
            created_by: senderNumber,
            source: 'bot_wa'
          });
          const summary = await kasService.getSaldoSummary();
          await reply(`✅ *KAS MASUK (IURAN) BERHASIL DICATAT*\n\n👤 Anggota: *${member.name}*\n💵 Jumlah : *${formatter.formatRupiah(nominal)}*\n📅 Periode: Minggu ke-${targetWeek} (${targetYear})\n💎 Saldo Kas Kini: *${formatter.formatRupiah(summary.saldo)}*`);
        } else {
          const desc = remainingArgs || 'Pemasukan Kas';
          await kasService.addTransaction({
            type: 'masuk',
            amount: nominal,
            description: desc,
            source: 'bot_wa',
            created_by: senderNumber
          });
          const summary = await kasService.getSaldoSummary();
          await reply(`✅ *KAS MASUK BERHASIL DICATAT*\n\n📝 Ket    : *${desc}*\n💵 Jumlah : *${formatter.formatRupiah(nominal)}*\n💎 Saldo Kas Kini: *${formatter.formatRupiah(summary.saldo)}*`);
        }
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
      } else if (action === 'status' || action === 'iuran') {
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
        await reply('❌ Perintah kas tidak dikenali. Pilihan:\n`!bot kas saldo`\n`!bot kas masuk <nominal> [nama]`\n`!bot kas keluar <nominal> <ket>`\n`!bot kas mutasi`\n`!bot kas status [minggu]`');
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
            if (s.note) outText += `📝 Note: ${s.note}\n`;
            outText += `\n`;
          });
        }

        outText += `🗓️ *SELURUH JADWAL MINGGUAN:*\n`;
        if (allSchedules.length === 0) {
          outText += `_Belum ada jadwal yang terdaftar._`;
        } else {
          allSchedules.forEach((s) => {
            outText += `• [ID: ${s.id}] *${s.day_of_week.toUpperCase()}* (${formatter.formatTime(s.start_time)}-${formatter.formatTime(s.end_time)}) : *${s.course_name}* (${s.lecturer})\n`;
          });
        }

        await reply(outText.trim());
      } else if (action === 'tambah') {
        const fullParam = args.slice(3).join(' ');
        const parts = fullParam.split('|');

        if (parts.length < 4) {
          await reply(`❌ Format salah!\nGunakan: \`!bot jadwal tambah <hari>|<jam_mulai-selesai>|<matkul>|<dosen>|[note]\`\nContoh: \`!bot jadwal tambah senin|08:00-10:00|Kalkulus|Dr. Bambang|Ruang 301 Bawa kalkulator\``);
          return;
        }

        const day = parts[0].trim().toLowerCase();
        const validDays = ['senin', 'selasa', 'rabu', 'kamis', 'jumat', 'sabtu', 'minggu'];
        if (!validDays.includes(day)) {
          await reply(`❌ Hari tidak valid! Pilih: ${validDays.join(', ')}`);
          return;
        }

        const timeParts = parts[1].trim().split('-');
        if (timeParts.length !== 2) {
          await reply('❌ Format jam salah! Contoh: `08:00-10:00`');
          return;
        }

        const courseName = parts[2].trim();
        const lecturer = parts[3].trim();
        const note = parts[4] ? parts[4].trim() : '';

        const newId = await jadwalService.addSchedule({
          day_of_week: day,
          start_time: timeParts[0].trim() + ':00',
          end_time: timeParts[1].trim() + ':00',
          course_name: courseName,
          lecturer,
          note
        });

        await reply(`✅ *JADWAL BERHASIL DITAMBAHKAN!*\n\nID: *${newId}*\nHari: *${day.toUpperCase()}*\nJam: *${timeParts[0].trim()} - ${timeParts[1].trim()}*\nMatkul: *${courseName}*\nDosen: *${lecturer}*\nCatatan: *${note || '-'}*`);
      } else if (action === 'hapus') {
        const id = parseInt(args[3], 10);
        if (!id) {
          await reply('❌ Masukkan ID jadwal yang ingin dihapus.\nContoh: `!bot jadwal hapus 3`');
          return;
        }
        await jadwalService.deleteSchedule(id);
        await reply(`✅ Jadwal dengan ID *${id}* berhasil dihapus.`);
      } else {
        await reply('❌ Perintah jadwal tidak dikenali.\nPilihan:\n`!bot jadwal`\n`!bot jadwal tambah <hari>|<jam>|<matkul>|<dosen>|<note>`\n`!bot jadwal hapus <id>`');
      }
      break;
    }

    default: {
      await reply(`❓ Perintah \`!bot ${subCmd}\` tidak dikenali. Ketik \`!bot menu\` untuk melihat daftar perintah.`);
      break;
    }
  }
}

export default {
  handleCommand
};
