import "server-only";

import type { Client, Row } from "@libsql/client";

function plainRows(rows: Row[]) {
  return rows.map((row) => Object.fromEntries(Object.entries(row)));
}

export async function readOperationalSnapshot(client: Client) {
  const [
    employees,
    idCards,
    shifts,
    holidays,
    settings,
    companyProfiles,
    idCardTemplates,
    backups,
    corrections,
    imports,
    attendance,
    scanLogs,
    revision,
  ] = await client.batch(
    [
      `
      SELECT id_unik, kode_karyawan, nama, divisi, jabatan_status, no_hp, lp,
             id_shift, status_aktif, tanggal_daftar, catatan, token_absensi,
             qr_code, status_qr, jenis_personil, tanggal_mulai_aktif,
             tanggal_selesai_aktif, status_backup
      FROM master_data;
    `,
      "SELECT * FROM id_card ORDER BY nama;",
      "SELECT * FROM tbl_shift ORDER BY kode_shift;",
      "SELECT * FROM tbl_hari_libur ORDER BY tanggal ASC;",
      "SELECT key, value FROM setting_gex_system;",
      "SELECT * FROM company_profile;",
      "SELECT * FROM id_card_template ORDER BY created_at ASC;",
      `
      SELECT * FROM backup_karyawan
      WHERE status_tugas = 'Aktif'
         OR datetime(waktu_input) >= datetime('now', '-31 days');
    `,
      `
      SELECT * FROM koreksi_admin
      WHERE date(tanggal) >= date('now', '-31 days')
      ORDER BY id_koreksi DESC;
    `,
      `SELECT * FROM import_offline
        WHERE datetime(timestamp_input) >= datetime('now', '-31 days')
        ORDER BY id_import DESC;`,
      `
      SELECT * FROM absensi_harian
      WHERE date(tanggal) >= date('now', '-31 days');
    `,
      `
      SELECT * FROM log_scan
      WHERE date(tanggal_kerja) >= date('now', '-31 days')
      ORDER BY id_log DESC
      LIMIT 5000;
    `,
      "SELECT COALESCE(MAX(revision), 0) AS revision FROM sync_change_log;",
    ],
    "read",
  );

  return {
    revision: Number(revision.rows[0]?.revision ?? 0),
    generatedAt: new Date().toISOString(),
    employees: plainRows(employees.rows),
    idCards: plainRows(idCards.rows),
    shifts: plainRows(shifts.rows),
    holidays: plainRows(holidays.rows),
    settings: plainRows(settings.rows),
    companyProfiles: plainRows(companyProfiles.rows),
    idCardTemplates: plainRows(idCardTemplates.rows),
    backups: plainRows(backups.rows),
    corrections: plainRows(corrections.rows),
    imports: plainRows(imports.rows),
    attendance: plainRows(attendance.rows),
    scanLogs: plainRows(scanLogs.rows),
  };
}
