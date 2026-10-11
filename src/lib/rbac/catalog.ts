export const PERMISSION_CATALOG = [
  { key: "home.view", name: "Lihat Home", group: "Utama" },
  { key: "scanner.use", name: "Gunakan QR Scanner", group: "Utama" },
  { key: "dashboard.view", name: "Lihat Dashboard", group: "Utama" },
  { key: "dashboard.export", name: "Export laporan", group: "Utama" },
  { key: "employees.view", name: "Lihat karyawan", group: "Manajemen" },
  { key: "employees.manage", name: "Kelola karyawan", group: "Manajemen" },
  { key: "shifts.view", name: "Lihat shift", group: "Manajemen" },
  { key: "shifts.manage", name: "Kelola shift", group: "Manajemen" },
  { key: "holidays.view", name: "Lihat hari libur", group: "Manajemen" },
  { key: "holidays.manage", name: "Kelola hari libur", group: "Manajemen" },
  {
    key: "corrections.view",
    name: "Lihat koreksi admin",
    group: "Operasional",
  },
  {
    key: "corrections.manage",
    name: "Kelola koreksi admin",
    group: "Operasional",
  },
  { key: "backups.view", name: "Lihat penugasan backup", group: "Operasional" },
  {
    key: "backups.manage",
    name: "Kelola penugasan backup",
    group: "Operasional",
  },
  {
    key: "alfa.trigger",
    name: "Jalankan Generate Alfa Manual",
    group: "Operasional",
  },
  {
    key: "attendance_audit.view",
    name: "Lihat audit absensi",
    group: "Operasional",
  },
  {
    key: "operational.edit",
    name: "Edit Data Operasional",
    group: "Operasional",
  },
  {
    key: "operational.delete",
    name: "Hapus Data Operasional",
    group: "Operasional",
  },
  {
    key: "history.edit",
    name: "Edit Riwayat Absensi",
    group: "Riwayat",
  },
  {
    key: "history.delete",
    name: "Hapus Riwayat Absensi",
    group: "Riwayat",
  },
  // MENGAJUKAN reset password tidak butuh izin apa pun — alur "Lupa Password"
  // memang terbuka untuk semua akun tanpa sesi login. Dua izin di bawah hanya
  // mengatur siapa yang boleh MELIHAT dan MENGHAPUS riwayat pengajuan itu,
  // karena riwayatnya menyimpan foto wajah pemohon.
  {
    key: "password_reset.view",
    name: "Lihat Riwayat Reset Password",
    group: "Sistem",
  },
  {
    key: "password_reset.delete",
    name: "Hapus Riwayat Reset Password",
    group: "Sistem",
  },
  // MENGAKTIFKAN 2FA untuk akun sendiri tidak butuh izin apa pun — setiap
  // operator berhak mengamankan akunnya, termasuk role paling terbatas.
  // Yang di-RBAC adalah MEMATIKAN 2FA milik orang lain.
  {
    key: "two_factor.reset",
    name: "Reset 2FA Operator Lain",
    group: "Sistem",
  },
  // Foto bukti absensi memperlihatkan wajah dan lokasi orang saat scan, jadi
  // membacanya adalah hak yang diberikan sadar — bukan bagian dari melihat
  // rekap absensi biasa. MENGAMBIL fotonya tidak butuh izin: kewajibannya
  // ditentukan sakelar role pada halaman Master Operator, bukan permission.
  {
    key: "attendance_photo.view",
    name: "Lihat Foto Bukti Absensi",
    group: "Sistem",
  },
  {
    key: "attendance_photo.delete",
    name: "Hapus Foto Bukti Absensi",
    group: "Sistem",
  },
  // Portabilitas data. MEMBUAT cadangan tidak butuh izin khusus di luar ini,
  // tetapi berkasnya memuat hash password, rahasia TOTP, dan foto absensi —
  // jadi mengeluarkannya dari perangkat adalah tindakan yang harus diberikan
  // sadar, bukan ikut paket bawaan.
  {
    key: "password_reset.approve",
    name: "Setujui Pemulihan Password",
    group: "Sistem",
  },
  {
    key: "database_backup.export",
    name: "Ekspor Cadangan Database",
    group: "Sistem",
  },
  {
    key: "database_backup.restore",
    name: "Pulihkan Database dari Cadangan",
    group: "Sistem",
  },
  { key: "operators.view", name: "Lihat Master Operator", group: "Sistem" },
  { key: "operators.manage", name: "Kelola Master Operator", group: "Sistem" },
  { key: "roles.manage", name: "Kelola Role & Akses", group: "Sistem" },
  {
    key: "settings.manage",
    name: "Kelola Pengaturan Sistem & Auto Alfa",
    group: "Sistem",
  },
  {
    key: "branding.manage",
    name: "Kelola identitas aplikasi",
    group: "Sistem",
  },
  { key: "sync.view", name: "Lihat status sinkronisasi", group: "Sistem" },
  { key: "sync.retry", name: "Ulangi sinkronisasi", group: "Sistem" },
  { key: "diagnostics.view", name: "Lihat diagnostik", group: "Sistem" },
  {
    key: "payroll.view",
    name: "Lihat Rekap & Estimasi Gaji",
    group: "Penggajian",
  },
  {
    key: "payroll.run.create",
    name: "Buat & Jalankan Batch Payroll",
    group: "Penggajian",
  },
  {
    key: "payroll.run.review",
    name: "Review Batch Payroll",
    group: "Penggajian",
  },
  {
    key: "payroll.run.approve",
    name: "Setujui Batch Payroll",
    group: "Penggajian",
  },
  {
    key: "payroll.run.disburse",
    name: "Tandai Dibayar & Kunci Slip",
    group: "Penggajian",
  },
  {
    key: "payroll.config.manage",
    name: "Kelola Tarif, Lembur & Pajak",
    group: "Penggajian",
  },
  {
    key: "payroll.export",
    name: "Export Laporan & Slip Gaji",
    group: "Penggajian",
  },
] as const;

export type PermissionKey = (typeof PERMISSION_CATALOG)[number]["key"];

export const SUPERADMIN_ONLY_PERMISSIONS = new Set<PermissionKey>([
  "operators.view",
  "operators.manage",
  "roles.manage",
  "payroll.config.manage",
]);

export const SENSITIVE_MUTATION_PERMISSIONS = new Set<PermissionKey>([
  "history.edit",
  "history.delete",
  "operational.edit",
  "operational.delete",
  // Menghapus riwayat reset menghilangkan satu-satunya jejak siapa yang pernah
  // mengajukan pemulihan beserta foto wajahnya. Tidak ikut paket bawaan Admin —
  // harus diberikan sadar lewat Role & Akses, sama seperti hak hapus data
  // operasional.
  "password_reset.delete",
  // Mematikan 2FA orang lain melucuti lapisan kedua akunnya. Berguna ketika
  // ponsel hilang, tetapi juga jalan pintas bagi siapa pun yang ingin
  // melemahkan akun sebelum menyerangnya — jadi harus diberikan sadar.
  "two_factor.reset",
  // Menghapus foto bukti absensi menghilangkan satu-satunya bukti visual bahwa
  // sebuah scan benar dilakukan orang yang bersangkutan.
  "attendance_photo.delete",
  // Memulihkan cadangan MENIMPA seluruh data perusahaan sekaligus — absensi,
  // payroll, operator, dan hak aksesnya. Tidak ada operasi lain di aplikasi ini
  // yang bisa menghapus sebanyak itu dalam satu langkah.
  "database_backup.restore",
  // Menyetujui pemulihan berarti menyerahkan kendali sebuah akun kepada orang
  // yang sedang berdiri di depan layar. Peninjaunya WAJIB sadar memikul itu,
  // jadi tidak ikut paket bawaan Admin.
  "password_reset.approve",
]);

export const SYSTEM_ROLE_KEYS = [
  "superadmin",
  "admin",
  "operator",
  "scanner",
] as const;

export type SystemRoleKey = (typeof SYSTEM_ROLE_KEYS)[number];

export const DEFAULT_ROLE_PERMISSIONS: Record<
  Exclude<SystemRoleKey, "superadmin">,
  readonly PermissionKey[]
> = {
  admin: PERMISSION_CATALOG.filter(
    ({ key }) =>
      !SUPERADMIN_ONLY_PERMISSIONS.has(key) &&
      key !== "diagnostics.view" &&
      !SENSITIVE_MUTATION_PERMISSIONS.has(key),
  ).map(({ key }) => key),
  operator: [
    "home.view",
    "scanner.use",
    "dashboard.view",
    "employees.view",
    "shifts.view",
    "sync.view",
  ],
  scanner: ["home.view", "scanner.use", "sync.view"],
};

export function normalizeRoleKey(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function isPermissionKey(value: string): value is PermissionKey {
  return PERMISSION_CATALOG.some(({ key }) => key === value);
}
