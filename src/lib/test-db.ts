import { db, ensureDbInitialized } from "./db";

export async function runDatabaseTest() {
  try {
    // 1. Inisialisasi database schema & seeders
    await ensureDbInitialized();

    // 2. Ambil daftar tabel yang ada di SQLite
    const tablesResult = await db.execute(`
      SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%';
    `);
    const tables = tablesResult.rows.map((row) => String(row.name));

    // 3. Ambil data seeder default dari tabel utama
    const shiftsResult = await db.execute("SELECT * FROM tbl_shift;");
    const operatorsResult = await db.execute(
      "SELECT id, kode_operator, nama_operator, role, status FROM master_operator;",
    );
    const settingsResult = await db.execute(
      "SELECT * FROM setting_gex_system;",
    );
    const masterDataCount = await db.execute(
      "SELECT COUNT(*) as count FROM master_data;",
    );
    const idCardCount = await db.execute(
      "SELECT COUNT(*) as count FROM id_card;",
    );

    return {
      sukses: true,
      pesan: "Database SQLite & Schema berhasil diinisialisasi!",
      total_tabel: tables.length,
      daftar_tabel: tables,
      ringkasan_seeder: {
        total_shift: shiftsResult.rows.length,
        shift_list: shiftsResult.rows,
        operator_list: operatorsResult.rows,
        settings_list: settingsResult.rows,
        total_karyawan: Number(masterDataCount.rows[0]?.count || 0),
        total_id_card: Number(idCardCount.rows[0]?.count || 0),
      },
    };
  } catch (error: unknown) {
    const errMessage = error instanceof Error ? error.message : String(error);
    return {
      sukses: false,
      pesan: `Pengujian Database Gagal: ${errMessage}`,
    };
  }
}
