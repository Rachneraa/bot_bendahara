import kasService from '../services/kasService.js';
import jadwalService from '../services/jadwalService.js';
import messageService from '../services/messageService.js';
import formatter from '../utils/formatter.js';

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

function parseAmount(str) {
  if (!str) return 0;
  let clean = str.toLowerCase().replace(/rp|\.|\,/g, '').trim();
  if (clean.endsWith('k') || clean.endsWith('rb')) {
    clean = clean.replace(/k|rb/g, '');
    return (parseFloat(clean) || 0) * 1000;
  }
  return parseFloat(clean) || 0;
}

export function parseKasEntries(rawText) {
  let body = rawText.replace(/^!bot\s+kas\s+masuk\s*/i, '').trim();
  if (!body) return [];

  let lines = body.split(/\r?\n/).map(l => l.trim()).filter(Boolean);

  if (lines.length === 1 && lines[0].includes(',')) {
    lines = lines[0].split(',').map(l => l.trim()).filter(Boolean);
  }

  const entries = [];

  for (let rawLine of lines) {
    let cleanLine = rawLine
      .replace(/^[\d]+[\.\)\-\s]+\s*/, '')
      .replace(/^[\*\-\•\–\—]\s*/, '')
      .trim();

    if (!cleanLine) continue;

    const tokens = cleanLine.split(/\s+/);
    let amount = 0;
    let nameTokens = [];
    let foundAmount = false;

    const firstAmount = parseAmount(tokens[0]);
    if (firstAmount > 0 && /\d/.test(tokens[0])) {
      amount = firstAmount;
      nameTokens = tokens.slice(1);
      foundAmount = true;
    } else {
      const lastToken = tokens[tokens.length - 1];
      const lastAmount = parseAmount(lastToken);
      if (lastAmount > 0 && /\d/.test(lastToken)) {
        amount = lastAmount;
        nameTokens = tokens.slice(0, -1);
        foundAmount = true;
      } else {
        for (let i = 0; i < tokens.length; i++) {
          const val = parseAmount(tokens[i]);
          if (val > 0 && /\d/.test(tokens[i])) {
            amount = val;
            nameTokens = tokens.filter((_, idx) => idx !== i);
            foundAmount = true;
            break;
          }
        }
      }
    }

    let name = nameTokens.join(' ').replace(/\//g, ' ').trim();
    if (foundAmount && amount > 0 && name) {
      entries.push({ amount, name, originalLine: rawLine });
    } else if (cleanLine) {
      entries.push({ amount: 0, name: cleanLine, originalLine: rawLine });
    }
  }

  return entries;
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

  await kasService.recordIuranWeekly({
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
    await reply(
      `✅ *KONFIRMASI SELESAI!*\n\n` +
      `Kas untuk *${selectedMember.name}* (${formatter.formatRupiah(currentItem.amount)}) berhasil dicatat (Lunas Minggu ke-${targetWeek}).\n` +
      `💎 Saldo Kas Kini: *${formatter.formatRupiah(summary.saldo)}*`
    );
  }

  return true;
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

*👑 PENGATURAN GRUP & PENGUJIAN*
• \`!bot setgroup\` : Daftarkan grup ini sebagai Grup Kelas Utama (pengingat otomatis).
• \`!bot settestgroup\` : Daftarkan grup ini sebagai Grup Testing (uji coba fitur).
• \`!bot test start\` : Mulai sesi uji coba fitur (merekam snapshot database).
• \`!bot test reminder\` : Kirim simulasi pengingat kuliah ke grup testing.
• \`!bot test reset\` : Hapus seluruh data tes & kembalikan database bersih.

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
      if (testAction === 'start') {
        const session = await kasService.startTestSession();
        await reply(
          `🧪 *SESI UJI COBA RESMI DIMULAI!*\n\n` +
          `• Snapshot Data: Mahasiswa ID *${session.maxM}*, Transaksi ID *${session.maxT}*\n` +
          `• Waktu Mulai: ${new Date().toLocaleTimeString('id-ID')}\n\n` +
          `Semua data mahasiswa dan transaksi yang dibuat mulai sekarang ditandai sebagai data tes.\n` +
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
            `• Catatan iuran tes dihapus: *${res.deletedIuran} catatan*\n\n` +
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
            `• Transaksi kas yang dibuat: *${status.testTxCount} transaksi*\n\n` +
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
            await kasService.recordIuranWeekly({
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
              isTypo: matchResult.type === 'fuzzy'
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
          await reply(
            `✅ *KAS MASUK (IURAN) BERHASIL DICATAT*\n\n` +
            `👤 Anggota: *${s.member.name}*${typoNote}\n` +
            `💵 Jumlah : *${formatter.formatRupiah(s.amount)}*\n` +
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
            report += `${idx + 1}. *${s.member.name}* (${formatter.formatRupiah(s.amount)}) - Lunas Minggu ${targetWeek}${typoNote}\n`;
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
