/**
 * Promosi database: memindahkan isi berkas hub lokal ke database bersama.
 *
 * Berbeda dari pemulihan cadangan, yang MENGGANTI seluruh isi database. Promosi
 * MENGGABUNGKAN — dan di situlah tabrakan constraint muncul. Dua perangkat yang
 * pernah berjalan sendiri-sendiri hampir pasti memakai `id` AUTOINCREMENT yang
 * sama untuk baris yang berbeda, dan bisa saja memakai kode karyawan atau
 * username yang sama untuk orang yang berbeda.
 *
 * Modul ini sengaja berisi keputusan, bukan I/O: urutan penyalinan yang
 * menghormati foreign key, deteksi tabrakan, dan pemetaan ulang id. Semuanya
 * murni sehingga bisa diuji tanpa database sungguhan — bagian yang paling mudah
 * salah justru bagian yang paling sulit diuji kalau tercampur dengan koneksi.
 */

export interface PromotionTable {
  readonly table: string;
  /**
   * Kolom kunci utama INTEGER AUTOINCREMENT.
   *
   * Nilainya berbeda arti di tiap perangkat, sehingga saat digabungkan ia WAJIB
   * dipetakan ulang dan setiap rujukannya ikut diperbarui. Tabel baru sejak
   * mode lokal ada memakai kunci TEXT buatan klien justru untuk menghindari ini.
   */
  readonly autoIncrementPk?: string;
  /** Kolom UNIQUE. Tabrakan di sini menghentikan promosi, bukan digabung diam-diam. */
  readonly uniqueColumns: readonly string[];
  /** Tabel yang WAJIB sudah tersalin lebih dulu. */
  readonly dependsOn: readonly string[];
}

/**
 * Urutan penyalinan.
 *
 * Foreign key yang benar-benar ada di skema cloud hanya lima:
 * `role_permission` → `app_role` + `app_permission`, `master_operator` →
 * `app_role`, `password_reset_request` → `master_operator`, `app_session` →
 * `master_operator`, dan `id_card` → `master_data`. Sisanya bebas urutan, tapi
 * tetap dieja di sini supaya penambahan tabel baru punya tempat yang jelas.
 */
export const PROMOTION_PLAN: readonly PromotionTable[] = [
  // Lapisan 1 — tanpa ketergantungan.
  { table: "app_permission", uniqueColumns: [], dependsOn: [] },
  {
    table: "app_role",
    autoIncrementPk: "id",
    uniqueColumns: ["role_key", "nama_role"],
    dependsOn: [],
  },
  {
    table: "master_data",
    uniqueColumns: ["kode_karyawan", "token_absensi"],
    dependsOn: [],
  },
  {
    table: "tbl_shift",
    autoIncrementPk: "id_shift",
    uniqueColumns: [],
    dependsOn: [],
  },
  {
    table: "tbl_hari_libur",
    autoIncrementPk: "id_libur",
    uniqueColumns: ["tanggal"],
    dependsOn: [],
  },
  { table: "setting_gex_system", uniqueColumns: [], dependsOn: [] },
  { table: "company_profile", uniqueColumns: [], dependsOn: [] },
  { table: "id_card_template", uniqueColumns: [], dependsOn: [] },
  { table: "app_mail_config", uniqueColumns: [], dependsOn: [] },
  { table: "hari_libur_whitelist", uniqueColumns: [], dependsOn: [] },

  // Lapisan 2 — bergantung pada lapisan 1.
  {
    table: "role_permission",
    uniqueColumns: [],
    dependsOn: ["app_role", "app_permission"],
  },
  {
    table: "master_operator",
    autoIncrementPk: "id",
    uniqueColumns: ["kode_operator", "username"],
    dependsOn: ["app_role"],
  },
  {
    table: "id_card",
    autoIncrementPk: "id_card_id",
    uniqueColumns: ["id_unik"],
    dependsOn: ["master_data"],
  },

  // Lapisan 3 — bergantung pada operator.
  {
    table: "password_reset_request",
    uniqueColumns: [],
    dependsOn: ["master_operator"],
  },

  // Lapisan 4 — data operasional, tanpa foreign key tetapi merujuk karyawan.
  {
    table: "absensi_harian",
    autoIncrementPk: "id_absensi",
    uniqueColumns: ["id_sesi"],
    dependsOn: ["master_data"],
  },
  { table: "absensi_foto", uniqueColumns: [], dependsOn: ["master_data"] },
  {
    table: "log_scan",
    autoIncrementPk: "id_log",
    uniqueColumns: [],
    dependsOn: ["master_data"],
  },
  {
    table: "koreksi_admin",
    autoIncrementPk: "id_koreksi",
    uniqueColumns: [],
    dependsOn: ["master_data"],
  },
  {
    table: "audit_absensi",
    autoIncrementPk: "id_audit",
    uniqueColumns: [],
    dependsOn: ["master_data"],
  },
  { table: "backup_karyawan", uniqueColumns: [], dependsOn: ["master_data"] },
  {
    table: "import_offline",
    autoIncrementPk: "id_import",
    uniqueColumns: [],
    dependsOn: ["master_data"],
  },

  // Lapisan 5 — payroll.
  { table: "salary_configs", uniqueColumns: [], dependsOn: ["master_data"] },
  { table: "overtime_tier_rules", uniqueColumns: [], dependsOn: [] },
  { table: "payroll_components", uniqueColumns: [], dependsOn: [] },
  { table: "tax_rules", uniqueColumns: [], dependsOn: [] },
  { table: "bpjs_rules", uniqueColumns: ["component_code"], dependsOn: [] },
  { table: "payroll_runs", uniqueColumns: ["idempotency_key"], dependsOn: [] },
  {
    table: "payroll_items",
    uniqueColumns: [],
    dependsOn: ["payroll_runs", "master_data"],
  },
  {
    table: "payroll_audit_logs",
    uniqueColumns: [],
    dependsOn: ["payroll_runs"],
  },
];

/**
 * Tabel yang SENGAJA tidak ikut dipromosikan.
 *
 * Semuanya adalah keadaan sementara milik perangkat atau server tujuan, bukan
 * data perusahaan. Menyalinnya justru merusak: sesi yang dipindahkan tidak
 * pernah cocok dengan token di sisi lain, dan penghitung sinkronisasi yang
 * ditimpa membuat perangkat lain melewatkan perubahan.
 */
export const PROMOTION_EXCLUDED_TABLES: readonly string[] = [
  "schema_migration",
  "app_session",
  "auth_login_rate_limit",
  "app_bootstrap_state",
  "sync_change_log",
  "sync_changelog",
  "sync_operation_receipt",
  "sync_pulse",
  "role_permission_audit",
];

export interface UniqueCollision {
  readonly table: string;
  readonly column: string;
  readonly value: string;
  readonly sourceKey: string;
  readonly destinationKey: string;
}

type Row = Record<string, unknown>;

function rowKey(spec: PromotionTable, row: Row): string {
  const pk = spec.autoIncrementPk;
  return pk ? String(row[pk] ?? "") : JSON.stringify(row);
}

/**
 * Cari nilai UNIQUE yang sudah dipakai baris LAIN di tujuan.
 *
 * Nilai yang sama pada baris dengan kunci yang sama bukan tabrakan — itu baris
 * yang sama, dan promosi yang dijalankan ulang harus aman. Yang berbahaya
 * adalah nilai sama dengan kunci berbeda: dua orang berbeda memakai satu kode
 * karyawan.
 */
export function detectUniqueCollisions(
  spec: PromotionTable,
  sourceRows: readonly Row[],
  destinationRows: readonly Row[],
): UniqueCollision[] {
  const collisions: UniqueCollision[] = [];

  for (const column of spec.uniqueColumns) {
    const taken = new Map<string, string>();
    for (const row of destinationRows) {
      const value = row[column];
      if (value === null || value === undefined || value === "") continue;
      taken.set(String(value), rowKey(spec, row));
    }

    for (const row of sourceRows) {
      const value = row[column];
      if (value === null || value === undefined || value === "") continue;
      const existing = taken.get(String(value));
      if (existing === undefined) continue;

      const sourceKey = rowKey(spec, row);
      if (existing === sourceKey) continue;

      collisions.push({
        table: spec.table,
        column,
        value: String(value),
        sourceKey,
        destinationKey: existing,
      });
    }
  }

  return collisions;
}

/**
 * Petakan ulang kunci utama AUTOINCREMENT ke rentang yang belum terpakai.
 *
 * Baris yang id-nya belum dipakai tujuan dipertahankan apa adanya, supaya
 * rujukan yang sudah benar tidak diguncang tanpa perlu. Sisanya diberi id baru
 * di atas nilai tertinggi tujuan.
 */
export function planIdRemap(
  spec: PromotionTable,
  sourceRows: readonly Row[],
  destinationRows: readonly Row[],
): Map<number, number> {
  const remap = new Map<number, number>();
  const pk = spec.autoIncrementPk;
  if (!pk) return remap;

  const used = new Set<number>();
  let highest = 0;
  for (const row of destinationRows) {
    const id = Number(row[pk]);
    if (!Number.isFinite(id)) continue;
    used.add(id);
    if (id > highest) highest = id;
  }

  for (const row of sourceRows) {
    const id = Number(row[pk]);
    if (!Number.isFinite(id)) continue;
    if (!used.has(id)) {
      used.add(id);
      continue;
    }
    highest += 1;
    remap.set(id, highest);
    used.add(highest);
  }

  return remap;
}

/**
 * Pastikan setiap tabel muncul setelah tabel yang dirujuknya.
 *
 * Dijalankan sebagai pemeriksaan, bukan sekadar diyakini: menyalin
 * `master_operator` sebelum `app_role` akan gagal dengan pelanggaran foreign
 * key di tengah transaksi, setelah sebagian data sudah berpindah.
 */
export function assertPromotionOrder(
  plan: readonly PromotionTable[] = PROMOTION_PLAN,
): void {
  const seen = new Set<string>();
  for (const spec of plan) {
    for (const dependency of spec.dependsOn) {
      if (!seen.has(dependency)) {
        throw new Error(
          `Urutan promosi salah: '${spec.table}' disalin sebelum '${dependency}' yang dirujuknya.`,
        );
      }
    }
    seen.add(spec.table);
  }
}
