-- ==========================================================
-- Skema Database: Bot WhatsApp Bendahara & Pengingat Kelas
-- Kompatibel dengan MySQL 5.7+ / MariaDB 10.3+ (cPanel & Lokal)
-- ==========================================================

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

-- 1. Tabel Users (Admin Web Dashboard)
CREATE TABLE IF NOT EXISTS `users` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `username` VARCHAR(50) NOT NULL UNIQUE,
  `password_hash` VARCHAR(255) NOT NULL,
  `full_name` VARCHAR(100) NOT NULL,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 2. Tabel Settings (Pengaturan Dinamis Bot)
CREATE TABLE IF NOT EXISTS `settings` (
  `key_name` VARCHAR(50) PRIMARY KEY,
  `value` TEXT NULL,
  `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 3. Tabel Message Templates (Template Pesan Dinamis)
CREATE TABLE IF NOT EXISTS `message_templates` (
  `key_name` VARCHAR(50) PRIMARY KEY,
  `title` VARCHAR(100) NOT NULL,
  `content` TEXT NOT NULL,
  `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 4. Tabel Members (Daftar Mahasiswa/Anggota Kelas)
CREATE TABLE IF NOT EXISTS `members` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `name` VARCHAR(100) NOT NULL,
  `phone_number` VARCHAR(20) NULL,
  `is_active` BOOLEAN DEFAULT TRUE,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 5. Tabel Kas Transactions (Buku Kas Masuk & Keluar)
CREATE TABLE IF NOT EXISTS `kas_transactions` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `type` ENUM('masuk', 'keluar') NOT NULL,
  `amount` DECIMAL(12, 2) NOT NULL,
  `member_id` INT NULL,
  `description` VARCHAR(255) NOT NULL,
  `source` ENUM('bot_wa', 'web_dashboard') DEFAULT 'web_dashboard',
  `created_by` VARCHAR(100) NOT NULL,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX `idx_created_at` (`created_at`),
  INDEX `idx_member_id` (`member_id`),
  CONSTRAINT `fk_kas_member` FOREIGN KEY (`member_id`) REFERENCES `members` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 6. Tabel Iuran Weekly (Pencatatan Iuran Mingguan per Anggota)
CREATE TABLE IF NOT EXISTS `iuran_weekly` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `member_id` INT NOT NULL,
  `week_number` INT NOT NULL,
  `year` INT NOT NULL,
  `amount` DECIMAL(12, 2) NOT NULL,
  `transaction_id` INT NULL,
  `paid_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY `unique_member_week_year` (`member_id`, `week_number`, `year`),
  INDEX `idx_week_year` (`week_number`, `year`),
  CONSTRAINT `fk_iuran_member` FOREIGN KEY (`member_id`) REFERENCES `members` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_iuran_transaction` FOREIGN KEY (`transaction_id`) REFERENCES `kas_transactions` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 7. Tabel Schedules (Jadwal Mata Kuliah Mingguan)
CREATE TABLE IF NOT EXISTS `schedules` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `day_of_week` ENUM('senin', 'selasa', 'rabu', 'kamis', 'jumat', 'sabtu', 'minggu') NOT NULL,
  `start_time` TIME NOT NULL,
  `end_time` TIME NOT NULL,
  `course_name` VARCHAR(150) NOT NULL,
  `lecturer` VARCHAR(150) NOT NULL,
  `note` TEXT NULL,
  `is_active` BOOLEAN DEFAULT TRUE,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX `idx_day_time` (`day_of_week`, `start_time`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 8. Tabel Reminder Logs (Mencegah Notifikasi Ganda / Spam)
CREATE TABLE IF NOT EXISTS `reminder_logs` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `schedule_id` INT NOT NULL,
  `reminder_type` ENUM('5_hours', 'h_0') NOT NULL,
  `reminder_date` DATE NOT NULL,
  `sent_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY `unique_reminder` (`schedule_id`, `reminder_type`, `reminder_date`),
  CONSTRAINT `fk_reminder_schedule` FOREIGN KEY (`schedule_id`) REFERENCES `schedules` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ==========================================================
-- Data Default Awal (Seed Data)
-- ==========================================================

-- Template Pesan Default
INSERT INTO `message_templates` (`key_name`, `title`, `content`) VALUES
('reminder_5_hours', 'Pengingat 5 Jam Sebelum Kelas', '📢 *PENGINGAT KELAS (5 JAM LAGI)* 📢\n\n⏰ *Waktu*    : {jam} WIB\n📚 *Matkul*   : {matkul}\n👨‍🏫 *Dosen*    : {dosen}\n📝 *Catatan*  : {note}\n\nHarap persiapkan materi dan tugas tepat waktu! 🚀'),
('reminder_h_0', 'Pengingat Saat Kelas Dimulai', '🚨 *KELAS DIMULAI SEKARANG!* 🚨\n\n⏰ *Waktu*    : {jam} WIB\n📚 *Matkul*   : {matkul}\n👨‍🏫 *Dosen*    : {dosen}\n📝 *Catatan*  : {note}\n\nSilakan segera memasuki ruangan / link kelas! 🎓'),
('broadcast_default', 'Format Pengumuman Broadcast', '📢 *PENGUMUMAN KELAS* 📢\n\n{pesan}\n\n— Pengurus Kelas')
ON DUPLICATE KEY UPDATE `title` = VALUES(`title`);

-- Pengaturan Sistem Default
INSERT INTO `settings` (`key_name`, `value`) VALUES
('target_group_jid', ''),
('weekly_dues_amount', '10000'),
('bot_phone_number', ''),
('admin_numbers', '')
ON DUPLICATE KEY UPDATE `key_name` = VALUES(`key_name`);

SET FOREIGN_KEY_CHECKS = 1;
