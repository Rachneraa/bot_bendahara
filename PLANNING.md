# 📋 Project Planning: Bot WhatsApp Bendahara, Pengingat Kelas & Web Dashboard

Dokumen perencanaan arsitektur, skema database, alur perintah bot WhatsApp, antarmuka web dashboard terintegrasi, sistem notifikasi, dan panduan deployment untuk cPanel.

---

## 1. Arsitektur & Spesifikasi Teknis

* **Runtime:** Node.js (v18+ / v20+)
* **WhatsApp Library:** `@whiskeysockets/baileys`
  * Berjalan murni dengan WebSocket (tanpa browser Chromium / Puppeteer).
  * Penggunaan RAM sangat efisien (~70MB - 120MB), ramah untuk shared/cloud hosting cPanel.
* **Web Server:** `Express.js`
  * Berjalan di satu proses bersama bot WhatsApp (otomatis mendeteksi port `process.env.PORT` dari Phusion Passenger cPanel).
  * Menggunakan **Vanilla CSS + HTML + JS Modern** dengan estetika premium (Glassmorphism, Dark Mode, Micro-animations, Google Fonts *Inter/Outfit*).
* **Database:** MySQL / MariaDB
  * Driver: `mysql2/promise`
  * Terintegrasi dengan phpMyAdmin cPanel dan Web Dashboard internal.
* **Autentikasi Dashboard:** Session-based (`express-session`) dengan password hash (`bcryptjs`) yang tersimpan di database MySQL.
* **Autentikasi WhatsApp:** Multi-file Auth State dengan **8-digit Pairing Code** yang dapat dipantau langsung dari Web Dashboard (tidak perlu membuka terminal/log cPanel).
* **Scheduler:** `node-cron`
  * Interval pengecekan per menit untuk notifikasi **H-5 Jam** dan **H-0 (saat kelas dimulai)** dengan fitur tag seluruh anggota (`@everyone`).

---

## 2. Struktur Proyek

```text
bot_bendahara/
├── auth_info/             # Direktori sesi Baileys (auto-generated, gitignored)
├── config/
│   └── database.js        # Pool koneksi MySQL (mysql2/promise)
├── database/
│   └── schema.sql         # Skrip pembuatan tabel database & data bawaan
├── public/                # Static assets web dashboard
│   ├── css/
│   │   └── style.css      # Desain modern, glassmorphism, dark mode & animasi
│   └── js/
│       ├── app.js         # Interaksi UI, fetch API & real-time update
│       └── dashboard.js   # Script logika visual web dashboard
├── views/                 # Template HTML (EJS / Server Rendered)
│   ├── layout.ejs         # Header, sidebar, navbar & modal
│   ├── login.ejs          # Halaman login modern
│   ├── dashboard.ejs      # Status bot, pairing code, ringkasan kas & jadwal
│   ├── members.ejs        # Manajemen nama anggota kelas & iuran
│   ├── schedules.ejs      # Manajemen jadwal kuliah (CRUD)
│   ├── messages.ejs       # Template pesan & live broadcast (mention @everyone)
│   └── kas.ejs            # Pencatatan kas masuk/keluar & mutasi
├── src/
│   ├── bot/
│   │   ├── baileys.js        # Core socket Baileys, state, event listener
│   │   ├── adminHandler.js   # Verifikasi hak akses admin grup & whitelist
│   │   └── commandHandler.js # Router perintah berawalan !bot
│   ├── controllers/
│   │   ├── authController.js    # Login/logout dashboard
│   │   ├── memberController.js  # API & web handler data anggota
│   │   ├── scheduleController.js# API & web handler data jadwal
│   │   ├── messageController.js # API & web handler template & broadcast
│   │   └── kasController.js     # API & web handler data kas
│   ├── services/
│   │   ├── kasService.js     # Query database terkait kas & iuran
│   │   ├── jadwalService.js  # Query database terkait jadwal
│   │   ├── messageService.js # Formatting pesan & template placeholder
│   │   └── scheduler.js      # Pengingat kelas otomatis (cron)
│   └── utils/
│       └── formatter.js      # Format mata uang Rupiah & waktu Indonesia
├── .env.example           # Template environment variable
├── .gitignore
├── index.js               # Main entry point (Express + Baileys + Scheduler)
├── package.json
└── PLANNING.md
```

---

## 3. Skema Database (MySQL)

### A. Tabel `users` (Admin Dashboard)
Autentikasi login admin untuk mengakses web dashboard.
* `id` (INT AUTO_INCREMENT PRIMARY KEY)
* `username` (VARCHAR(50) UNIQUE NOT NULL)
* `password_hash` (VARCHAR(255) NOT NULL)
* `full_name` (VARCHAR(100) NOT NULL)
* `created_at` (TIMESTAMP DEFAULT CURRENT_TIMESTAMP)

### B. Tabel `settings`
Menyimpan konfigurasi sistem:
* `key_name` (VARCHAR(50) PRIMARY KEY)
  * `target_group_jid` (ID grup WA tujuan pengingat)
  * `weekly_dues_amount` (Besaran iuran kas mingguan per orang)
  * `bot_phone_number` (Nomor bot untuk pairing)
* `value` (TEXT)
* `updated_at` (TIMESTAMP)

### C. Tabel `message_templates`
Template pesan yang dapat dikustomisasi secara leluasa lewat web dashboard:
* `key_name` (VARCHAR(50) PRIMARY KEY)
  * `reminder_5_hours` (Template pengingat 5 jam sebelum kelas)
  * `reminder_h_0` (Template pengingat saat kelas dimulai)
  * `broadcast_default` (Template pengumuman langsung)
* `title` (VARCHAR(100) NOT NULL)
* `content` (TEXT NOT NULL)
* `updated_at` (TIMESTAMP)

*Variabel Placeholder Tersedia:* `{matkul}`, `{dosen}`, `{jam}`, `{hari}`, `{note}`, `{group_name}`.

### D. Tabel `members`
Daftar seluruh mahasiswa kelas:
* `id` (INT AUTO_INCREMENT PRIMARY KEY)
* `name` (VARCHAR(100) NOT NULL)
* `phone_number` (VARCHAR(20) NULLABLE)
* `is_active` (BOOLEAN DEFAULT TRUE)
* `created_at` (TIMESTAMP DEFAULT CURRENT_TIMESTAMP)

### E. Tabel `kas_transactions`
Buku kas umum (masuk & keluar):
* `id` (INT AUTO_INCREMENT PRIMARY KEY)
* `type` (ENUM('masuk', 'keluar') NOT NULL)
* `amount` (DECIMAL(12, 2) NOT NULL)
* `member_id` (INT NULLABLE, FK ke `members.id`)
* `description` (VARCHAR(255) NOT NULL)
* `source` (ENUM('bot_wa', 'web_dashboard') DEFAULT 'web_dashboard')
* `created_by` (VARCHAR(50) NOT NULL)
* `created_at` (TIMESTAMP DEFAULT CURRENT_TIMESTAMP)

### F. Tabel `iuran_weekly`
Tracking iuran mingguan per anggota:
* `id` (INT AUTO_INCREMENT PRIMARY KEY)
* `member_id` (INT NOT NULL, FK ke `members.id`)
* `week_number` (INT NOT NULL)
* `year` (INT NOT NULL)
* `amount` (DECIMAL(12, 2) NOT NULL)
* `transaction_id` (INT NULLABLE, FK ke `kas_transactions.id`)
* `paid_at` (TIMESTAMP DEFAULT CURRENT_TIMESTAMP)
* *UNIQUE KEY:* `(member_id, week_number, year)`

### G. Tabel `schedules`
Jadwal mata kuliah mingguan:
* `id` (INT AUTO_INCREMENT PRIMARY KEY)
* `day_of_week` (ENUM('senin', 'selasa', 'rabu', 'kamis', 'jumat', 'sabtu', 'minggu') NOT NULL)
* `start_time` (TIME NOT NULL)
* `end_time` (TIME NOT NULL)
* `course_name` (VARCHAR(150) NOT NULL)
* `lecturer` (VARCHAR(150) NOT NULL)
* `note` (TEXT NULLABLE)
* `is_active` (BOOLEAN DEFAULT TRUE)
* `created_at` (TIMESTAMP DEFAULT CURRENT_TIMESTAMP)

### H. Tabel `reminder_logs`
Mencegah spam/duplikasi notifikasi pada jadwal yang sama di hari yang sama:
* `id` (INT AUTO_INCREMENT PRIMARY KEY)
* `schedule_id` (INT NOT NULL)
* `reminder_type` (ENUM('5_hours', 'h_0') NOT NULL)
* `reminder_date` (DATE NOT NULL)
* `sent_at` (TIMESTAMP DEFAULT CURRENT_TIMESTAMP)
* *UNIQUE KEY:* `(schedule_id, reminder_type, reminder_date)`

---

## 4. Antarmuka Web Dashboard (HTML / CSS / JS)

Web dashboard dirancang dengan visual modern bertema **Dark Slate & Violet Glow**:
1. **Halaman Login (`/login`):**
   * Tampilan login elegan dengan animasi kartu kaca (glassmorphism) dan validasi aman.
2. **Dashboard Overview (`/`):**
   * **Widget Status WhatsApp:** Menampilkan status koneksi (Connected / Disconnected / Waiting for Pairing).
   * **Widget 8-Digit Pairing Code:** Menampilkan kode pairing otomatis jika belum tersambung, sehingga admin cukup menyalin kode dari web ke WA HP.
   * **Quick Stats:** Total Saldo Kas, Jadwal Kuliah Hari Ini, Persentase Pembayaran Iuran Minggu Ini.
3. **Manajemen Anggota (`/members`):**
   * Tabel daftar nama mahasiswa.
   * Modal tambah & edit nama anggota / status keaktifan.
   * Matriks centang pembayaran iuran mingguan.
4. **Manajemen Jadwal Kuliah (`/schedules`):**
   * Filter per hari (Senin s.d. Minggu).
   * Form tambah/edit jadwal: Hari, Jam Mulai, Jam Selesai, Mata Kuliah, Dosen, Catatan (Ruangan/Tugas).
   * Saklar aktif/nonaktif jadwal tanpa harus menghapus.
5. **Manajemen Template Pesan & Broadcast (`/messages`):**
   * Editor template pesan pengingat 5 Jam & H-0 dengan bantuan tag variabel instan (`{matkul}`, `{dosen}`, dll).
   * **Form Live Broadcast:** Kirim pesan langsung ke grup kelas dengan satu klik, dilengkapi opsi checklist **Tag Seluruh Anggota (@everyone)**.
6. **Buku Kas & Keuangan (`/kas`):**
   * Form pencatatan kas masuk & pengeluaran.
   * Tabel mutasi kas lengkap dengan pencarian & filter tanggal.

---

## 5. Fitur Bot WhatsApp (`!bot`)

Bot merespon perintah hanya dari Admin grup WhatsApp atau nomor whitelist di `.env`:
* **Bantuan & Status:**
  * `!bot` / `!bot menu` — Menampilkan seluruh perintah yang tersedia.
  * `!bot setgroup` — Menjadikan grup saat ini sebagai target pengingat kelas.
* **Kas & Iuran:**
  * `!bot kas masuk <nominal> [nama/keterangan]`
  * `!bot kas keluar <nominal> <keterangan>`
  * `!bot kas saldo`
  * `!bot kas mutasi`
  * `!bot kas status [minggu_ke]`
  * `!bot member list`
  * `!bot member tambah <nama>`
* **Jadwal Kuliah:**
  * `!bot jadwal` — Menampilkan jadwal hari ini atau sepekan.
  * `!bot jadwal tambah <hari>|<jam_mulai-selesai>|<matkul>|<dosen>|<note>`
  * `!bot jadwal hapus <id>`

---

## 6. Mesin Pengingat Kelas (Cron Scheduler)

1. **Jadwal Pengecekan:** Dijalankan setiap menit (`* * * * *`).
2. **Kondisi Notifikasi:**
   * **H-5 Jam (300 Menit Sebelum Kelas):** Mengambil data jadwal hari ini di mana `start_time - waktu_sekarang = 5 jam`.
   * **H-0 (Saat Kelas Dimulai):** Mengambil jadwal di mana `start_time = waktu_sekarang`.
3. **Format Pengiriman:**
   * Membaca template dari tabel `message_templates`.
   * Mengganti variabel `{matkul}`, `{dosen}`, `{jam}`, `{note}` dengan data asli.
   * Mengambil seluruh ID anggota grup (`groupMetadata.participants.map(p => p.id)`).
   * Mengirim pesan dengan parameter `mentions` agar seluruh anggota menerima tag notifikasi.
   * Mencatat ke `reminder_logs` agar tidak terkirim dua kali.

---

## 7. Panduan Deployment cPanel Step-by-Step

1. **Setup Database:**
   * Di cPanel, buka **MySQL® Databases**, buat database (misal: `user_botdb`) dan user database. Hubungkan user ke database dengan privileges **ALL PRIVILEGES**.
   * Buka **phpMyAdmin**, pilih database tersebut, lalu import file `database/schema.sql`.
2. **Setup Node.js App:**
   * Buka menu **Setup Node.js App** di cPanel.
   * Klik **Create Application**:
     * Node.js version: **18.x** atau **20.x**
     * Application mode: **Production**
     * Application root: `bot` (atau nama folder tempat project diletakkan)
     * Application startup file: `index.js`
   * Klik **Create**.
3. **Konfigurasi Environment (`.env`):**
   * Edit file `.env` di cPanel File Manager:
     * Kredensial MySQL (`DB_HOST=localhost`, `DB_USER=...`, `DB_PASS=...`, `DB_NAME=...`)
     * Kredensial Admin Web (`ADMIN_DEFAULT_USER=admin`, `ADMIN_DEFAULT_PASS=admin123`)
     * Nomor Bot (`BOT_PHONE_NUMBER=628xxxx`)
     * Nomor Admin Whitelist (`ADMIN_NUMBERS=628xxxx,628yyyy`)
     * Secret Session (`SESSION_SECRET=koderahasiasession`)
4. **Instalasi Dependencies & Menjalankan Bot:**
   * Buka Terminal cPanel, masuk ke folder project, jalankan:
     ```bash
     npm install
     ```
   * Klik **Restart** di menu Setup Node.js App cPanel.
5. **Pairing WhatsApp:**
   * Buka URL aplikasi di browser (domain atau subdomain yang dihubungkan ke Node.js App).
   * Login menggunakan username & password admin.
   * Pada halaman dashboard utama, kode pairing 8 digit akan langsung muncul.
   * Buka WhatsApp di HP > Perangkat Tertaut > Tautkan dengan nomor telepon > Masukkan 8 digit kode tersebut. Bot langsung aktif!

---

## 8. Urutan Implementasi (Checklist)

- [ ] **Fase 1:** Konfigurasi Proyek & Database (`package.json`, `.env.example`, `config/database.js`, `database/schema.sql`).
- [ ] **Fase 2:** Backend Core (Express server, session auth, layout EJS).
- [ ] **Fase 3:** Integrasi WhatsApp Baileys (`src/bot/baileys.js`) dengan fitur auto pairing code ke web session.
- [ ] **Fase 4:** Command & Admin Handler WhatsApp (`!bot` router, group admin checker).
- [ ] **Fase 5:** Modul Kas & Iuran (Service, Controller, Command WA, dan UI Web).
- [ ] **Fase 6:** Modul Jadwal & Pengingat (Service, Controller, Cron Scheduler H-5 & H-0 dengan mention all).
- [ ] **Fase 7:** Modul Broadcast & Template Pesan di Web Dashboard.
- [ ] **Fase 8:** Desain UI/UX Dashboard (Dark mode glassmorphism, responsive, Google Fonts, micro-animations).
- [ ] **Fase 9:** Pengujian menyeluruh & dokumentasi `README.md`.
