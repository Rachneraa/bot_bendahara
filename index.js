import express from 'express';
import session from 'express-session';
import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Global Crash & Exception Protection (mencegah Node 22 exit tiba-tiba karena unhandled rejection)
process.on('uncaughtException', (err) => {
  console.error('[UNCAUGHT EXCEPTION]', err);
  try {
    fs.appendFileSync(path.join(__dirname, 'crash.log'), `[${new Date().toISOString()}] [PID: ${process.pid}] UNCAUGHT: ${err.stack || err}\n`);
  } catch (_) {}
});

process.on('unhandledRejection', (reason) => {
  console.error('[UNHANDLED REJECTION]', reason);
  try {
    fs.appendFileSync(path.join(__dirname, 'crash.log'), `[${new Date().toISOString()}] [PID: ${process.pid}] REJECTION: ${reason?.stack || reason}\n`);
  } catch (_) {}
});

process.on('exit', (code) => {
  try {
    fs.appendFileSync(path.join(__dirname, 'crash.log'), `[${new Date().toISOString()}] [PID: ${process.pid}] EXIT WITH CODE: ${code}\n`);
  } catch (_) {}
});

import { initDatabase } from './config/database.js';
import { initBaileys, botState } from './src/bot/baileys.js';
import { startScheduler } from './src/services/scheduler.js';
import webRoutes from './src/routes/webRoutes.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware Body Parser
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Static Files
app.use(express.static(path.join(__dirname, 'public')));

// View Engine EJS
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Session Middleware
app.use(session({
  secret: process.env.SESSION_SECRET || 'bot_bendahara_default_secret_key',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 1000 * 60 * 60 * 24 * 7 // 7 hari
  }
}));

// Global template variables
app.locals.assetVersion = Date.now(); // cache-busting static JS per restart
app.use((req, res, next) => {
  res.locals.currentPath = req.path;
  next();
});

// Mount Routes
app.use('/', webRoutes);

// Error Handler
app.use((err, req, res, next) => {
  console.error('[SERVER ERROR]', err);
  res.status(500).send('Terjadi kesalahan internal pada server.');
});

// Server Initialization
async function bootstrap() {
  console.log('====================================================');
  console.log('🚀 MEMULAI BOT BENDAHARA & WEB DASHBOARD CPANEL');
  console.log('====================================================');

  // 1. Inisialisasi Database MySQL
  const dbConnected = await initDatabase();
  if (!dbConnected) {
    console.warn('[SERVER] Database MySQL belum siap, aplikasi tetap berjalan dalam mode terbatas.');
  }

  // 2. Jalankan Server Web Express
  app.listen(PORT, () => {
    console.log(`[WEB] Dashboard aktif di http://localhost:${PORT} (Port: ${PORT})`);
  });

  // 3. Inisialisasi Socket Baileys WhatsApp & Scheduler
  const enableWA = process.env.ENABLE_WHATSAPP !== 'false';
  if (enableWA) {
    await initBaileys();
    startScheduler();

    // Keepalive ping setiap 2 menit agar Phusion Passenger di cPanel tidak mematikan proses Node.js (idle shutdown)
    const keepaliveUrl = process.env.PUBLIC_URL || process.env.REMOTE_BOT_URL || `http://127.0.0.1:${PORT}`;
    setInterval(async () => {
      try {
        await fetch(`${keepaliveUrl}/api/health`).catch(() => {});
      } catch (e) {
        // silent
      }
    }, 120000);
  } else {
    console.log('[WA] 🟡 Mode dev lokal aktif (ENABLE_WHATSAPP=false).');
    console.log('[WA] Socket WhatsApp dinonaktifkan di lokal agar bot utama di server cPanel tidak terputus.');
    botState.status = 'disconnected';
    botState.lastError = 'WhatsApp dinonaktifkan di lokal (ENABLE_WHATSAPP=false). Bot WA berjalan di server cPanel.';
  }
}

bootstrap().catch(err => {
  console.error('Fatal startup error:', err);
});
