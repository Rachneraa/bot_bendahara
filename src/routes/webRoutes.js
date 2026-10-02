import express from 'express';
import bcrypt from 'bcryptjs';
import { query } from '../../config/database.js';
import kasService from '../services/kasService.js';
import jadwalService from '../services/jadwalService.js';
import messageService from '../services/messageService.js';
import formatter from '../utils/formatter.js';
import { botState, requestPairingCodeManual, sendGroupNotification } from '../bot/baileys.js';

const router = express.Router();

// Middleware verifikasi session login
export function requireAuth(req, res, next) {
  if (req.session && req.session.user) {
    return next();
  }
  return res.redirect('/login');
}

// -------------------------------------------------------------
// 1. AUTENTIKASI (LOGIN & LOGOUT)
// -------------------------------------------------------------
router.get('/login', (req, res) => {
  if (req.session && req.session.user) {
    return res.redirect('/');
  }
  res.render('login', { error: null });
});

router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const users = await query('SELECT * FROM users WHERE username = ? LIMIT 1', [username.trim()]);

    if (users.length === 0) {
      return res.render('login', { error: 'Username atau password salah!' });
    }

    const user = users[0];
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) {
      return res.render('login', { error: 'Username atau password salah!' });
    }

    req.session.user = {
      id: user.id,
      username: user.username,
      fullName: user.full_name
    };

    res.redirect('/');
  } catch (err) {
    res.render('login', { error: 'Terjadi kesalahan sistem: ' + err.message });
  }
});

router.get('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/login');
  });
});

// -------------------------------------------------------------
// 2. DASHBOARD OVERVIEW
// -------------------------------------------------------------
router.get('/', requireAuth, async (req, res) => {
  try {
    const saldoSummary = await kasService.getSaldoSummary();
    const todayDay = formatter.getIndonesianDayName();
    const todaySchedules = await jadwalService.getTodaySchedules(todayDay);
    const members = await kasService.getMembers(true);
    const weeklyStatus = await kasService.getWeeklyStatus();
    const targetGroup = await messageService.getSetting('target_group_jid');
    const testGroup = await messageService.getSetting('test_group_jid');

    let currentBotState = botState;
    const isBridge = bridgeService.isBridgeMode();
    if (isBridge) {
      try {
        const remote = await bridgeService.callRemoteBot('/api/bridge/status');
        currentBotState = { ...remote, isRemote: true };
      } catch (e) {
        currentBotState = {
          status: 'disconnected',
          pairingCode: null,
          botNumber: null,
          lastError: 'Gagal terhubung ke bot server: ' + e.message,
          isRemote: true
        };
      }
    }

    res.render('dashboard', {
      user: req.session.user,
      botState: currentBotState,
      isBridge,
      saldoSummary,
      todayDay,
      todaySchedules,
      totalMembers: members.length,
      weeklyStatus,
      targetGroup,
      testGroup,
      formatter
    });
  } catch (err) {
    res.status(500).send('Error loading dashboard: ' + err.message);
  }
});

// Endpoint minta pairing code via dashboard
router.post('/api/bot/pair', requireAuth, async (req, res) => {
  try {
    const { phoneNumber } = req.body;
    if (!phoneNumber) {
      return res.status(400).json({ success: false, message: 'Nomor telepon wajib diisi.' });
    }
    const code = await requestPairingCodeManual(phoneNumber);
    res.json({ success: true, code });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

import bridgeService from '../services/bridgeService.js';

function verifyBridge(req, res, next) {
  const secret = process.env.BRIDGE_SECRET || 'bot_bendahara_bridge_2026';
  const token = req.headers['x-bridge-token'] || req.query.token;
  if (token !== secret) {
    return res.status(403).json({ success: false, message: 'Invalid bridge secret token' });
  }
  next();
}

// -------------------------------------------------------------
// ENDPOINT BRIDGE UNTUK AKSES BOT DARI LOKAL KE CPANEL
// -------------------------------------------------------------
router.get('/api/bridge/status', verifyBridge, (req, res) => {
  res.json({
    status: botState.status,
    pairingCode: botState.pairingCode,
    botNumber: botState.botNumber,
    lastError: botState.lastError
  });
});

router.post('/api/bridge/send', verifyBridge, async (req, res) => {
  try {
    const { targetGroupJid, messageText, mentionAll } = req.body;
    await sendGroupNotification(targetGroupJid, messageText, Boolean(mentionAll));
    res.json({ success: true, message: 'Pesan terkirim ke WhatsApp' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/api/bridge/test-reminder', verifyBridge, async (req, res) => {
  try {
    const { templateKey, targetGroupJid } = req.body;
    let target = targetGroupJid;
    if (!target) {
      target = (await messageService.getSetting('test_group_jid')) || (await messageService.getSetting('target_group_jid'));
    }
    if (!target) {
      return res.status(400).json({ success: false, message: 'Target group JID belum disetel di server.' });
    }

    const template = await messageService.getTemplate(templateKey);
    const schedules = await jadwalService.getAllSchedules(true);
    const sampleSchedule = schedules[0] || {
      day_of_week: 'senin',
      start_time: '08:00:00',
      end_time: '10:00:00',
      course_name: 'Contoh Mata Kuliah (Testing)',
      lecturer: 'Dosen Contoh, M.Kom',
      note: 'Ini adalah pesan uji coba dari dashboard'
    };

    const text = `🧪 *[SIMULASI UJI COBA REMINDER]*\n\n` + messageService.buildReminderMessage(template ? template.content : '', sampleSchedule);
    await sendGroupNotification(target, text, true);
    res.json({ success: true, message: 'Tes pengingat terkirim ke WhatsApp' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Endpoint minta pairing code via dashboard
router.post('/api/bot/pair', requireAuth, async (req, res) => {
  try {
    const { phoneNumber } = req.body;
    if (!phoneNumber) {
      return res.status(400).json({ success: false, message: 'Nomor telepon wajib diisi.' });
    }
    const code = await requestPairingCodeManual(phoneNumber);
    res.json({ success: true, code });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Endpoint status bot untuk polling / live update status
router.get('/api/bot/status', requireAuth, async (req, res) => {
  if (bridgeService.isBridgeMode()) {
    try {
      const remote = await bridgeService.callRemoteBot('/api/bridge/status');
      return res.json({
        ...remote,
        isRemote: true
      });
    } catch (e) {
      return res.json({
        status: 'disconnected',
        pairingCode: null,
        botNumber: null,
        lastError: 'Gagal terhubung ke bot server: ' + e.message,
        isRemote: true
      });
    }
  }

  res.json({
    status: botState.status,
    pairingCode: botState.pairingCode,
    botNumber: botState.botNumber,
    lastError: botState.lastError,
    isRemote: false
  });
});

// -------------------------------------------------------------
// 3. MANAJEMEN NAMA ANGGOTA (MEMBERS)
// -------------------------------------------------------------
router.get('/members', requireAuth, async (req, res) => {
  try {
    const members = await kasService.getMembers();
    const activeSetting = await messageService.getSetting('active_semester_week', '1');
    const activeWeek = parseInt(activeSetting, 10) || 1;
    const selectedWeek = req.query.week ? parseInt(req.query.week, 10) : activeWeek;
    const selectedYear = req.query.year ? parseInt(req.query.year, 10) : new Date().getFullYear();

    const weeklyStatus = await kasService.getWeeklyStatus(selectedWeek, selectedYear);

    res.render('members', {
      user: req.session.user,
      members,
      weeklyStatus,
      selectedWeek,
      selectedYear,
      activeWeek,
      bulkStatus: req.query.status || null,
      bulkCount: req.query.count || 0,
      formatter
    });
  } catch (err) {
    res.status(500).send('Error: ' + err.message);
  }
});

router.post('/members/set-active-week', requireAuth, async (req, res) => {
  try {
    const { active_week } = req.body;
    if (active_week) {
      await messageService.setSetting('active_semester_week', active_week);
    }
    res.redirect('/members?week=' + active_week);
  } catch (err) {
    res.redirect('/members?error=' + encodeURIComponent(err.message));
  }
});

router.post('/members/add', requireAuth, async (req, res) => {
  try {
    const { name, phone_number } = req.body;
    if (name) {
      await kasService.addMember({ name, phone_number });
    }
    res.redirect('/members');
  } catch (err) {
    res.redirect('/members?error=' + encodeURIComponent(err.message));
  }
});

router.post('/members/add-bulk', requireAuth, async (req, res) => {
  try {
    const { bulk_data } = req.body;
    if (!bulk_data || !bulk_data.trim()) {
      return res.redirect('/members?error=' + encodeURIComponent('Data nama mahasiswa tidak boleh kosong.'));
    }

    const lines = bulk_data.split(/\r?\n/);
    const parsedList = [];

    for (let rawLine of lines) {
      let line = rawLine.trim();
      if (!line) continue;

      // Bersihkan awalan penomoran seperti "1. ", "1) ", "1 - ", "* ", "- ", "• "
      line = line.replace(/^[\d]+[\.\)\-\s]+\s*/, '');
      line = line.replace(/^[\*\-\•\–\—]\s*/, '').trim();

      if (!line) continue;

      let name = line;
      let phone_number = null;

      // Cek pemisah koma, tab, atau titik koma (misal: "Ahmad Dani, 081234567890")
      if (line.includes(',') || line.includes('\t') || line.includes(';')) {
        const delimiter = line.includes('\t') ? '\t' : (line.includes(',') ? ',' : ';');
        const parts = line.split(delimiter);
        name = parts[0].trim();
        phone_number = parts.slice(1).join('').trim() || null;
      }

      if (name) {
        parsedList.push({ name, phone_number });
      }
    }

    if (parsedList.length === 0) {
      return res.redirect('/members?error=' + encodeURIComponent('Tidak ada nama valid yang ditemukan.'));
    }

    const count = await kasService.addBulkMembers(parsedList);
    res.redirect('/members?status=bulk_added&count=' + count);
  } catch (err) {
    res.redirect('/members?error=' + encodeURIComponent(err.message));
  }
});

router.post('/members/edit/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, phone_number, is_active } = req.body;
    await kasService.updateMember(id, {
      name,
      phone_number,
      is_active: is_active === '1' || is_active === 'on' || is_active === true
    });
    res.redirect('/members');
  } catch (err) {
    res.redirect('/members?error=' + encodeURIComponent(err.message));
  }
});

router.post('/members/delete/:id', requireAuth, async (req, res) => {
  try {
    await kasService.deleteMember(req.params.id);
    res.redirect('/members');
  } catch (err) {
    res.redirect('/members?error=' + encodeURIComponent(err.message));
  }
});

// Bayar iuran cepat dari web
router.post('/members/pay-iuran', requireAuth, async (req, res) => {
  try {
    const { member_id, amount, week_number, year } = req.body;
    const nominal = parseFloat(amount) || 10000;
    const week = parseInt(week_number, 10);
    const yr = parseInt(year, 10);

    await kasService.recordIuranWeekly({
      member_id,
      week_number: week,
      year: yr,
      amount: nominal,
      created_by: req.session.user.username,
      source: 'web_dashboard'
    });

    res.redirect('/members');
  } catch (err) {
    res.redirect('/members?error=' + encodeURIComponent(err.message));
  }
});

// -------------------------------------------------------------
// 4. MANAJEMEN JADWAL KULIAH (SCHEDULES)
// -------------------------------------------------------------
router.get('/schedules', requireAuth, async (req, res) => {
  try {
    const schedules = await jadwalService.getAllSchedules();
    res.render('schedules', {
      user: req.session.user,
      schedules,
      formatter
    });
  } catch (err) {
    res.status(500).send('Error: ' + err.message);
  }
});

router.post('/schedules/add', requireAuth, async (req, res) => {
  try {
    const { day_of_week, start_time, end_time, course_name, lecturer, note } = req.body;
    await jadwalService.addSchedule({
      day_of_week,
      start_time: start_time + ':00',
      end_time: end_time + ':00',
      course_name,
      lecturer,
      note
    });
    res.redirect('/schedules');
  } catch (err) {
    res.redirect('/schedules?error=' + encodeURIComponent(err.message));
  }
});

router.post('/schedules/edit/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { day_of_week, start_time, end_time, course_name, lecturer, note, is_active } = req.body;
    await jadwalService.updateSchedule(id, {
      day_of_week,
      start_time: start_time.length === 5 ? start_time + ':00' : start_time,
      end_time: end_time.length === 5 ? end_time + ':00' : end_time,
      course_name,
      lecturer,
      note,
      is_active: is_active === '1' || is_active === 'on' || is_active === true
    });
    res.redirect('/schedules');
  } catch (err) {
    res.redirect('/schedules?error=' + encodeURIComponent(err.message));
  }
});

router.post('/schedules/delete/:id', requireAuth, async (req, res) => {
  try {
    await jadwalService.deleteSchedule(req.params.id);
    res.redirect('/schedules');
  } catch (err) {
    res.redirect('/schedules?error=' + encodeURIComponent(err.message));
  }
});

router.post('/schedules/toggle/:id', requireAuth, async (req, res) => {
  try {
    await jadwalService.toggleSchedule(req.params.id);
    res.redirect('/schedules');
  } catch (err) {
    res.redirect('/schedules?error=' + encodeURIComponent(err.message));
  }
});

// -------------------------------------------------------------
// 5. MANAJEMEN TEMPLATE PESAN & LIVE BROADCAST
// -------------------------------------------------------------
router.get('/messages', requireAuth, async (req, res) => {
  try {
    const templates = await messageService.getTemplates();
    const settings = await messageService.getSettings();

    res.render('messages', {
      user: req.session.user,
      templates,
      settings,
      botState,
      msgStatus: req.query.status || null
    });
  } catch (err) {
    res.status(500).send('Error: ' + err.message);
  }
});

router.post('/messages/template/update', requireAuth, async (req, res) => {
  try {
    const { key_name, title, content } = req.body;
    await messageService.updateTemplate(key_name, { title, content });
    res.redirect('/messages?status=template_saved');
  } catch (err) {
    res.redirect('/messages?error=' + encodeURIComponent(err.message));
  }
});

router.post('/messages/settings/update', requireAuth, async (req, res) => {
  try {
    const { target_group_jid, test_group_jid, admin_numbers, weekly_dues_amount } = req.body;
    if (target_group_jid !== undefined) await messageService.setSetting('target_group_jid', target_group_jid.trim());
    if (test_group_jid !== undefined) await messageService.setSetting('test_group_jid', test_group_jid.trim());
    if (admin_numbers !== undefined) await messageService.setSetting('admin_numbers', admin_numbers.trim());
    if (weekly_dues_amount !== undefined) await messageService.setSetting('weekly_dues_amount', weekly_dues_amount.trim());
    res.redirect('/messages?status=settings_saved');
  } catch (err) {
    res.redirect('/messages?error=' + encodeURIComponent(err.message));
  }
});

router.post('/messages/broadcast', requireAuth, async (req, res) => {
  try {
    const { message_text, mention_all, target } = req.body;
    const targetGroup = await messageService.getSetting('target_group_jid');
    const testGroup = await messageService.getSetting('test_group_jid');

    const targetList = [];
    if (target === 'test') {
      if (!testGroup) {
        return res.redirect('/messages?error=' + encodeURIComponent('Grup testing belum didaftarkan! Gunakan !bot settestgroup di grup testing atau atur di Pengaturan.'));
      }
      targetList.push(testGroup);
    } else if (target === 'all') {
      if (targetGroup) targetList.push(targetGroup);
      if (testGroup) targetList.push(testGroup);
      if (targetList.length === 0) {
        return res.redirect('/messages?error=' + encodeURIComponent('Belum ada grup yang didaftarkan. Daftarkan grup kelas atau grup testing terlebih dahulu.'));
      }
    } else {
      if (!targetGroup) {
        return res.redirect('/messages?error=' + encodeURIComponent('Grup target WhatsApp utama belum disetel! Ketik !bot setgroup di grup atau atur di Pengaturan.'));
      }
      targetList.push(targetGroup);
    }

    if (!message_text || !message_text.trim()) {
      return res.redirect('/messages?error=' + encodeURIComponent('Isi pesan pengumuman tidak boleh kosong.'));
    }

    const shouldMention = mention_all === '1' || mention_all === 'on';

    if (bridgeService.isBridgeMode()) {
      for (const jid of targetList) {
        await bridgeService.callRemoteBot('/api/bridge/send', 'POST', {
          targetGroupJid: jid,
          messageText: message_text.trim(),
          mentionAll: shouldMention
        });
      }
      return res.redirect('/messages?status=broadcast_sent');
    }

    for (const jid of targetList) {
      await sendGroupNotification(jid, message_text.trim(), shouldMention);
    }
    res.redirect('/messages?status=broadcast_sent');
  } catch (err) {
    res.redirect('/messages?error=' + encodeURIComponent(err.message));
  }
});

router.post('/messages/test-reminder', requireAuth, async (req, res) => {
  try {
    const { template_key, target } = req.body;
    const targetGroup = await messageService.getSetting('target_group_jid');
    const testGroup = await messageService.getSetting('test_group_jid');

    let destJid = target === 'main' ? targetGroup : (testGroup || targetGroup);

    if (!destJid) {
      return res.redirect('/messages?error=' + encodeURIComponent('Belum ada grup yang disetel! Daftarkan grup testing dengan !bot settestgroup atau grup utama dengan !bot setgroup.'));
    }

    if (bridgeService.isBridgeMode()) {
      await bridgeService.callRemoteBot('/api/bridge/test-reminder', 'POST', {
        templateKey: template_key,
        targetGroupJid: destJid
      });
      return res.redirect('/messages?status=test_sent');
    }

    const template = await messageService.getTemplate(template_key);
    const schedules = await jadwalService.getAllSchedules(true);
    const sampleSchedule = schedules[0] || {
      day_of_week: 'senin',
      start_time: '08:00:00',
      end_time: '10:00:00',
      course_name: 'Contoh Mata Kuliah (Testing)',
      lecturer: 'Dosen Contoh, M.Kom',
      note: 'Ini adalah pesan uji coba dari dashboard'
    };
    const text = `🧪 *[SIMULASI UJI COBA REMINDER]*\n\n` + messageService.buildReminderMessage(template ? template.content : '', sampleSchedule);
    await sendGroupNotification(destJid, text, true);
    res.redirect('/messages?status=test_sent');
  } catch (err) {
    res.redirect('/messages?error=' + encodeURIComponent(err.message));
  }
});

// -------------------------------------------------------------
// 6. BUKU KAS & MUTASI
// -------------------------------------------------------------
router.get('/kas', requireAuth, async (req, res) => {
  try {
    const saldoSummary = await kasService.getSaldoSummary();
    const transactions = await kasService.getRecentTransactions(50);
    const members = await kasService.getMembers(true);

    res.render('kas', {
      user: req.session.user,
      saldoSummary,
      transactions,
      members,
      formatter
    });
  } catch (err) {
    res.status(500).send('Error: ' + err.message);
  }
});

router.post('/kas/add', requireAuth, async (req, res) => {
  try {
    const { type, amount, member_id, description } = req.body;
    const nominal = parseFloat(amount);

    if (!nominal || nominal <= 0 || !description) {
      return res.redirect('/kas?error=' + encodeURIComponent('Nominal dan deskripsi transaksi wajib diisi dengan benar.'));
    }

    await kasService.addTransaction({
      type,
      amount: nominal,
      member_id: member_id ? parseInt(member_id, 10) : null,
      description: description.trim(),
      source: 'web_dashboard',
      created_by: req.session.user.username
    });

    res.redirect('/kas');
  } catch (err) {
    res.redirect('/kas?error=' + encodeURIComponent(err.message));
  }
});

// -------------------------------------------------------------
// PANDUAN PENGGUNAAN (GUIDE)
// -------------------------------------------------------------
router.get('/guide', requireAuth, (req, res) => {
  res.render('guide', {
    user: req.session.user
  });
});

export default router;
