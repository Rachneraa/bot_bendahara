import { query } from '../config/database.js';

async function migrate() {
  console.log('Running spin_history migration...');
  await query(`
    CREATE TABLE IF NOT EXISTS spin_history (
      id INT AUTO_INCREMENT PRIMARY KEY,
      title VARCHAR(255) NOT NULL DEFAULT 'Acak Kelompok',
      mode ENUM('size', 'count') NOT NULL DEFAULT 'size',
      target_value INT NOT NULL DEFAULT 5,
      total_members INT NOT NULL DEFAULT 0,
      total_groups INT NOT NULL DEFAULT 0,
      groups_data JSON NOT NULL,
      created_by VARCHAR(100) DEFAULT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);
  console.log('✅ TABLE spin_history READY');
  process.exit(0);
}

migrate().catch(err => {
  console.error('Migration error:', err);
  process.exit(1);
});
