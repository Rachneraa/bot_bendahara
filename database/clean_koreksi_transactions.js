import { query } from '../config/database.js';

async function runCleanup() {
  console.log('🧹 Starting cleanup of old phantom koreksi transactions...');

  // 1. Vicky (member_id 61): id 41 had 10.000, id 43 had keluar 5.000.
  // Update id 41 to 5.000 and link iuran_weekly to 41.
  await query("UPDATE kas_transactions SET amount = 5000 WHERE id = 41");
  await query("UPDATE iuran_weekly SET transaction_id = 41 WHERE member_id = 61 AND week_number = 1 AND year = 2026");

  // 2. Aditiya (member_id 66): id 66 had 10, id 67 had masuk 9.990.
  // Update id 66 to 10.000 and link iuran_weekly to 66.
  await query("UPDATE kas_transactions SET amount = 10000 WHERE id = 66");
  await query("UPDATE iuran_weekly SET transaction_id = 66 WHERE member_id = 66 AND week_number = 1 AND year = 2026");

  // 3. Kiki (member_id 63): id 32 has true 10.000.
  await query("UPDATE iuran_weekly SET transaction_id = 32 WHERE member_id = 63 AND week_number = 1 AND year = 2026");

  // 4. Rouf (member_id 26): id 9 has true 10.000.
  await query("UPDATE iuran_weekly SET transaction_id = 9 WHERE member_id = 26 AND week_number = 1 AND year = 2026");

  // 5. Delete all phantom koreksi and redundant error entries
  const idsToDelete = [38, 40, 42, 43, 51, 52, 56, 57, 58, 59, 60, 67];
  await query(`DELETE FROM kas_transactions WHERE id IN (${idsToDelete.join(',')})`);

  console.log(`✅ Deleted phantom transaction IDs: ${idsToDelete.join(', ')}`);

  // Verify new balance
  const [row] = await query(`
    SELECT 
      COALESCE(SUM(CASE WHEN type = 'masuk' THEN amount ELSE 0 END), 0) AS total_masuk,
      COALESCE(SUM(CASE WHEN type = 'keluar' THEN amount ELSE 0 END), 0) AS total_keluar,
      COALESCE(SUM(CASE WHEN type = 'masuk' THEN amount ELSE -amount END), 0) AS saldo
    FROM kas_transactions
  `);

  console.log('📊 New Balance Summary:');
  console.log('- Total Pemasukan   : Rp', Number(row.total_masuk).toLocaleString('id-ID'));
  console.log('- Total Pengeluaran : Rp', Number(row.total_keluar).toLocaleString('id-ID'));
  console.log('- Sisa Saldo Kas    : Rp', Number(row.saldo).toLocaleString('id-ID'));

  process.exit(0);
}

runCleanup().catch(err => {
  console.error('❌ Cleanup failed:', err);
  process.exit(1);
});
