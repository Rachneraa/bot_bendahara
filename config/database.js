import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
import bcrypt from 'bcryptjs';

dotenv.config();

const dbConfig = {
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '3306', 10),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASS || '',
  database: process.env.DB_NAME || 'bot_bendahara',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  charset: 'utf8mb4',
  timezone: '+07:00'
};

export const pool = mysql.createPool(dbConfig);

// Helper query ringkas dengan auto-release koneksi
export async function query(sql, params = []) {
  const [rows] = await pool.execute(sql, params);
  return rows;
}

// Inisialisasi & verifikasi koneksi database + seed user admin awal jika kosong
export async function initDatabase() {
  try {
    const connection = await pool.getConnection();
    console.log(`[DB] Terhubung ke MySQL database '${dbConfig.database}' (${dbConfig.host}:${dbConfig.port})`);
    connection.release();

    // Pastikan user admin default ada jika tabel kosong
    try {
      const users = await query('SELECT id FROM users LIMIT 1');
      if (users.length === 0) {
        const defaultUser = process.env.ADMIN_DEFAULT_USER || 'admin';
        const defaultPass = process.env.ADMIN_DEFAULT_PASS || 'admin123';
        const defaultName = process.env.ADMIN_DEFAULT_NAME || 'Bendahara Kelas';

        const salt = await bcrypt.genSalt(10);
        const hash = await bcrypt.hash(defaultPass, salt);

        await query(
          'INSERT INTO users (username, password_hash, full_name) VALUES (?, ?, ?)',
          [defaultUser, hash, defaultName]
        );
        console.log(`[DB] User admin default dibuat: ${defaultUser} (Password: ${defaultPass})`);
      }
    } catch (err) {
      console.warn('[DB] Peringatan: Tabel users belum terpasang atau belum di-import schema.sql:', err.message);
    }

    return true;
  } catch (error) {
    console.error('[DB] Gagal terhubung ke MySQL:', error.message);
    console.error('[DB] Pastikan MySQL berjalan dan konfigurasi .env sesuai.');
    return false;
  }
}

export default {
  pool,
  query,
  initDatabase
};
