import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { type Client, createClient } from "@libsql/client";

mock.module("server-only", () => ({}));

import {
  CURRENT_SCHEMA_VERSION,
  initDatabaseSchema,
  isDatabaseSchemaReady,
  REQUIRED_TABLE_COUNT,
} from "@/lib/db-schema";
import {
  koreksiPajakArgs,
  LEGACY_RATE_IDS,
  TARIF_PAJAK_BAWAAN,
} from "@/lib/validations/tarif-bawaan";

let client: Client;

beforeAll(async () => {
  client = createClient({ url: "file::memory:" });
});

afterAll(() => client.close());

describe("Schema Consistency & Zero-Drift Guard", () => {
  test("inisialisasi skema lengkap menghasilkan seluruh tabel dan migrasi tanpa drift", async () => {
    await initDatabaseSchema(client);

    // 1. Cek jumlah tabel terdaftar
    const tablesRes = await client.execute(`
      SELECT COUNT(*) AS count FROM sqlite_master
      WHERE type = 'table' AND name IN (
        'master_data', 'id_card', 'master_operator', 'tbl_shift',
        'setting_gex_system', 'log_scan', 'absensi_harian',
        'backup_karyawan', 'koreksi_admin', 'audit_absensi', 'app_role',
        'app_permission', 'role_permission', 'app_session',
        'auth_login_rate_limit', 'sync_operation_receipt',
        'sync_change_log', 'sync_changelog', 'app_bootstrap_state',
        'import_offline', 'tbl_hari_libur',
        'company_profile', 'id_card_template',
        'salary_configs', 'overtime_tier_rules', 'payroll_components',
        'tax_rules', 'bpjs_rules', 'payroll_runs', 'payroll_items', 'payroll_audit_logs',
        'password_reset_request', 'app_mail_config', 'absensi_foto',
        'hari_libur_whitelist', 'personil_foto', 'personil_wajah',
        'inventory_barang', 'inventory_mutasi', 'inventory_unit', 'inventory_kolom', 'inventory_servis',
        'inventory_pengajuan', 'inventory_pengajuan_baris', 'inventory_penerimaan', 'inventory_penerimaan_foto',
        'keu_cicilan', 'keu_cicilan_jadwal', 'keu_cicilan_bayar', 'keu_cicilan_bayar_batal',
        'keu_akun', 'keu_jurnal', 'keu_jurnal_baris',
        'keu_pinjaman', 'keu_pinjaman_mutasi', 'keu_pinjaman_tunda',
        'keu_tutup_buku',
        'app_telegram_setting', 'notifikasi_telegram',
        'drv_jenis_kendaraan', 'drv_kategori_tujuan', 'drv_kendaraan', 'drv_lokasi', 'drv_perjalanan', 'drv_muatan', 'drv_laporan', 'drv_laporan_muatan', 'drv_laporan_foto',
        'drv_upah_bayar', 'drv_upah_bayar_baris',
        'hr_cabang', 'hr_divisi', 'hr_divisi_nama', 'hr_jabatan', 'hr_kontrak',
        'hr_profil', 'hr_dokumen_jenis', 'hr_dokumen', 'hr_dokumen_berkas',
        'hr_jenis_pengajuan', 'hr_pengajuan', 'hr_pengajuan_keputusan', 'hr_cuti_penyesuaian', 'hr_pengajuan_berkas',
        'hr_reimburse_bayar', 'hr_reimburse_bayar_baris',
        'hr_sp', 'hr_keluar', 'hr_keluar_rincian', 'hr_keluar_alasan',
        'hr_kinerja_template', 'hr_kinerja_aspek', 'hr_kinerja_jabatan', 'hr_kinerja_penilaian', 'hr_kinerja_nilai', 'hr_kinerja_keputusan',
        'hr_lowongan', 'hr_pelamar', 'hr_pelamar_tahap', 'hr_pelamar_berkas', 'hr_pelatihan', 'hr_pelatihan_peserta',
        'hr_pelatihan_anggaran', 'hr_pelatihan_rencana',
        'app_bank', 'app_bank_rekening', 'app_bank_format'
      );
    `);
    const tableCount = Number(tablesRes.rows[0]?.count ?? 0);
    expect(tableCount).toBe(REQUIRED_TABLE_COUNT);

    // 2. Cek schema_migration
    const migrationsRes = await client.execute(`
      SELECT MAX(version) AS max_version, COUNT(*) AS count FROM schema_migration;
    `);
    const maxMigrationVersion = Number(migrationsRes.rows[0]?.max_version ?? 0);

    // Assert: versi dan table count tidak boleh drift
    expect(CURRENT_SCHEMA_VERSION).toBe(maxMigrationVersion);
    expect(await isDatabaseSchemaReady(client)).toBe(true);
  });

  test("v45: database baru punya 125 lapis TER dan tarif bawaan ber-id baru", async () => {
    const tarif = await client.execute(`
      SELECT
        (SELECT COUNT(*) FROM tax_rules WHERE category LIKE 'TER_%') AS ter,
        (SELECT COUNT(*) FROM tax_rules WHERE category = 'PASAL_17') AS p17,
        (SELECT COUNT(*) FROM bpjs_rules) AS bpjs,
        (SELECT wage_cap FROM bpjs_rules WHERE component_code = 'JP_EMP') AS jp,
        (SELECT COUNT(*) FROM pragma_table_info('payroll_components') WHERE name = 'dasar_bpjs') AS kolom;
    `);
    expect({ ...tarif.rows[0] } as Record<string, unknown>).toEqual({
      ter: TARIF_PAJAK_BAWAAN.length - 5,
      p17: 5,
      bpjs: 8,
      jp: 11_086_300,
      kolom: 1,
    });
    expect(TARIF_PAJAK_BAWAAN.length - 5).toBe(125);
    const lama = await client.execute({
      sql: `SELECT COUNT(*) AS total FROM tax_rules WHERE id IN (${LEGACY_RATE_IDS.map(() => "?").join(", ")})`,
      args: [...LEGACY_RATE_IDS],
    });
    expect(Number(lama.rows[0]?.total)).toBe(0);
  });

  test("v45: database v44 dikoreksi hanya pada baris seed lama", async () => {
    const lama = createClient({ url: "file::memory:" });
    try {
      await initDatabaseSchema(lama);
      // Keadaan v44 milik Web: seed lama Web, TER B/C seed lama, satu lapis
      // dan satu batas JP disunting admin.
      await lama.batch(
        [
          ...koreksiPajakArgs().map((args) => ({
            sql: "UPDATE tax_rules SET bracket_min = ?, bracket_max = ?, rate_percentage = ? WHERE id = ?;",
            args: [args[4], args[5], args[6], args[3]],
          })),
          "DELETE FROM tax_rules WHERE id IN ('tax_ter_b_38', 'tax_ter_b_39', 'tax_ter_b_40', 'tax_ter_c_40', 'tax_ter_c_41');",
          "UPDATE tax_rules SET rate_percentage = 2.75 WHERE id = 'tax_ter_b_8';",
          "UPDATE bpjs_rules SET wage_cap = 10042300, effective_date = '2026-01-01' WHERE component_code = 'JP_EMP';",
          "UPDATE bpjs_rules SET wage_cap = 9999999, effective_date = '2026-01-01' WHERE component_code = 'JP_CO';",
          "DELETE FROM bpjs_rules WHERE component_code = 'JHT_EMP';",
          "INSERT INTO bpjs_rules (id, component_code, component_name, rate_percentage, wage_cap, effective_date) VALUES ('bpjs-jht-emp', 'JHT_EMP', 'JHT Karyawan', 2.0, NULL, '2024-01-01');",
          "INSERT INTO tax_rules (id, category, bracket_min, bracket_max, rate_percentage, effective_date) VALUES ('tax-p17-1', 'PASAL_17', 0, 60000000, 5.0, '2024-01-01');",
          "DELETE FROM schema_migration WHERE version = 45;",
        ],
        "write",
      );
      expect(await isDatabaseSchemaReady(lama)).toBe(false);
      await initDatabaseSchema(lama);

      const baris = await lama.execute(
        "SELECT id, bracket_min, bracket_max, rate_percentage FROM tax_rules;",
      );
      const peta = new Map(baris.rows.map((r) => [String(r.id), r]));
      expect(peta.size).toBe(TARIF_PAJAK_BAWAAN.length);
      for (const t of TARIF_PAJAK_BAWAAN) {
        const r = peta.get(t.id);
        const harapan =
          t.id === "tax_ter_b_8"
            ? [12_500_000, 13_750_000, 2.75]
            : [t.bracket_min, t.bracket_max, t.rate_percentage];
        expect([
          r?.bracket_min,
          r?.bracket_max,
          Number(r?.rate_percentage),
        ]).toEqual(harapan);
      }
      const bpjs = await lama.execute(
        "SELECT id, component_code, wage_cap, effective_date FROM bpjs_rules WHERE component_code IN ('JP_EMP', 'JP_CO', 'JHT_EMP') ORDER BY component_code;",
      );
      expect(
        bpjs.rows.map((r) => ({ ...r }) as Record<string, unknown>),
      ).toEqual([
        {
          id: "bpjs_jht_emp",
          component_code: "JHT_EMP",
          wage_cap: null,
          effective_date: "2026-01-01",
        },
        {
          id: "bpjs_jp_co",
          component_code: "JP_CO",
          wage_cap: 9_999_999,
          effective_date: "2026-01-01",
        },
        {
          id: "bpjs_jp_emp",
          component_code: "JP_EMP",
          wage_cap: 11_086_300,
          effective_date: "2026-03-01",
        },
      ]);
      const p17Lama = await lama.execute(
        "SELECT COUNT(*) AS total FROM tax_rules WHERE id = 'tax-p17-1';",
      );
      expect(Number(p17Lama.rows[0]?.total)).toBe(0);
    } finally {
      lama.close();
    }
  });
});
