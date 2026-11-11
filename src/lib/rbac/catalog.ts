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
  // Wajah terdaftar untuk verifikasi 1:1 saat scan. MENGELOLANYA sensitif:
  // wajah orang lain yang didaftarkan di nama seseorang membuat kartu yang
  // dipinjamkan lolos pemeriksaan.
  {
    key: "face_template.view",
    name: "Lihat Pendaftaran Wajah",
    group: "Sistem",
  },
  {
    key: "face_template.manage",
    name: "Kelola Pendaftaran Wajah",
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
  { key: "inventory.view", name: "Lihat Inventaris", group: "Inventaris" },
  {
    key: "inventory.manage",
    name: "Kelola Master Barang",
    group: "Inventaris",
  },
  {
    key: "inventory.record",
    name: "Catat Barang Masuk, Keluar & Pindah",
    group: "Inventaris",
  },
  {
    key: "inventory.adjust",
    name: "Koreksi & Batalkan Mutasi Inventaris",
    group: "Inventaris",
  },
  {
    key: "inventory.column.delete",
    name: "Hapus Permanen Kolom Tambahan",
    group: "Inventaris",
  },
  {
    key: "inventory.item.delete",
    name: "Hapus Barang Inventaris",
    group: "Inventaris",
  },
  { key: "accounting.view", name: "Lihat Pembukuan", group: "Keuangan" },
  {
    key: "accounting.manage",
    name: "Kelola Akun & Catat Jurnal",
    group: "Keuangan",
  },
  { key: "accounting.reverse", name: "Batalkan Jurnal", group: "Keuangan" },
  { key: "accounting.close", name: "Tutup Buku", group: "Keuangan" },
  {
    key: "installment.cancel",
    name: "Batalkan Pembayaran & Tutup Kontrak Cicilan",
    group: "Keuangan",
  },
  { key: "loan.view", name: "Lihat Kasbon Karyawan", group: "Keuangan" },
  { key: "loan.manage", name: "Ajukan & Kelola Kasbon", group: "Keuangan" },
  {
    key: "loan.approve",
    name: "Setujui & Batalkan Kasbon",
    group: "Keuangan",
  },
  // Perjalanan driver / surat jalan (v34).
  {
    key: "trip.report",
    name: "Lapor Perjalanan dari HP Driver",
    group: "Perjalanan",
  },
  { key: "trip.view", name: "Lihat Perjalanan & Laporan", group: "Perjalanan" },
  {
    key: "trip.manage",
    name: "Buat Surat Jalan & Ganti Driver/Kendaraan",
    group: "Perjalanan",
  },
  {
    key: "trip.cancel",
    name: "Batalkan Perjalanan yang Berjalan",
    group: "Perjalanan",
  },
  {
    key: "fleet.manage",
    name: "Kelola Kendaraan, Kategori Tujuan & Lokasi",
    group: "Perjalanan",
  },
  {
    key: "trip.tariff",
    name: "Ubah Tarif & Penerima Upah Surat Jalan",
    group: "Perjalanan",
  },
  {
    key: "trip.pay",
    name: "Catat & Batalkan Pembayaran Upah Surat Jalan",
    group: "Perjalanan",
  },
  // HRIS fase 1 (v36). Sort order cermin seed `app_permission` Rust 1600+.
  { key: "hr.org.manage", name: "Kelola Organisasi", group: "Kepegawaian" },
  {
    key: "hr.personal.view",
    name: "Lihat Data Pribadi Karyawan",
    group: "Kepegawaian",
  },
  {
    key: "hr.personal.manage",
    name: "Ubah Data Pribadi Karyawan",
    group: "Kepegawaian",
  },
  {
    key: "hr.finance.view",
    name: "Lihat Data Keuangan Karyawan",
    group: "Kepegawaian",
  },
  {
    key: "hr.finance.manage",
    name: "Ubah Data Keuangan Karyawan",
    group: "Kepegawaian",
  },
  {
    key: "hr.contract.manage",
    name: "Kelola Kontrak Kerja",
    group: "Kepegawaian",
  },
  {
    key: "hr.document.view",
    name: "Lihat Dokumen Karyawan",
    group: "Kepegawaian",
  },
  {
    key: "hr.document.manage",
    name: "Kelola Dokumen Karyawan",
    group: "Kepegawaian",
  },
  // HRIS fase 2 (v37). Sort order cermin seed `app_permission` Rust 1608+.
  {
    key: "hr.request.view",
    name: "Lihat Pengajuan Cuti/Izin/Sakit",
    group: "Kepegawaian",
  },
  {
    key: "hr.request.submit",
    name: "Ajukan Cuti/Izin/Sakit",
    group: "Kepegawaian",
  },
  {
    key: "hr.request.urgent",
    name: "Ajukan dan Setujui Urgent",
    group: "Kepegawaian",
  },
  {
    key: "hr.request.decide",
    name: "Putuskan Pengajuan",
    group: "Kepegawaian",
  },
  {
    key: "hr.leave.adjust",
    name: "Sesuaikan Jatah Cuti",
    group: "Kepegawaian",
  },
  // HRIS fase 4 (v39). Sort order cermin seed `app_permission` Rust 1613.
  {
    key: "reimburse.decide",
    name: "Putuskan & Bayar Reimbursement",
    group: "Kepegawaian",
  },
  // HRIS fase 5 (v40). Sort order cermin seed `app_permission` Rust 1614–1618.
  {
    key: "hr.warning.view",
    name: "Lihat Surat Peringatan",
    group: "Kepegawaian",
  },
  {
    key: "hr.warning.manage",
    name: "Kelola Surat Peringatan",
    group: "Kepegawaian",
  },
  {
    key: "hr.warning.cancel",
    name: "Cabut Surat Peringatan",
    group: "Kepegawaian",
  },
  {
    key: "hr.offboard.view",
    name: "Lihat Karyawan Keluar",
    group: "Kepegawaian",
  },
  {
    key: "hr.offboard.manage",
    name: "Kelola Karyawan Keluar",
    group: "Kepegawaian",
  },
  // HRIS fase 6 (v41). Sort order cermin seed `app_permission` Rust 1619–1622.
  {
    key: "hr.performance.view",
    name: "Lihat Penilaian Kinerja",
    group: "Kepegawaian",
  },
  {
    key: "hr.performance.assess",
    name: "Nilai Kinerja Karyawan",
    group: "Kepegawaian",
  },
  {
    key: "hr.performance.config",
    name: "Atur Template Kinerja",
    group: "Kepegawaian",
  },
  {
    key: "hr.performance.finalize",
    name: "Finalkan Penilaian Kinerja",
    group: "Kepegawaian",
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
  // Wajah yang salah di nama seseorang meloloskan kartu yang dipinjamkan.
  "face_template.manage",
  // Memulihkan cadangan MENIMPA seluruh data perusahaan sekaligus — absensi,
  // payroll, operator, dan hak aksesnya. Tidak ada operasi lain di aplikasi ini
  // yang bisa menghapus sebanyak itu dalam satu langkah.
  "database_backup.restore",
  // Menyetujui pemulihan berarti menyerahkan kendali sebuah akun kepada orang
  // yang sedang berdiri di depan layar. Peninjaunya WAJIB sadar memikul itu,
  // jadi tidak ikut paket bawaan Admin.
  "password_reset.approve",
  // Opname, pembatalan, dan penghapusan stok (Rusak/Afkir, Hilang,
  // Kedaluwarsa) mengurangi stok tanpa ada yang menerima barangnya, jadi
  // ketiganya juga cara termudah menutupi barang yang diambil orang.
  "inventory.adjust",
  // Menghapus kolom tambahan memusnahkan isinya di SEMUA barang sekaligus, dan
  // tidak ada jalan mengembalikannya.
  "inventory.column.delete",
  // Menghapus barang mengeluarkannya dari daftar, label, dan impor di semua
  // perangkat, dan tidak bisa dikembalikan dari aplikasi.
  "inventory.item.delete",
  // Jurnal pembalik menghapus efek sebuah transaksi dari seluruh laporan
  // tanpa jejak uang yang benar-benar kembali.
  "accounting.reverse",
  // Menyetujui kasbon berarti mencairkan uang perusahaan ke seorang karyawan.
  "loan.approve",
  // Menutup buku mengunci jurnal seluruh perangkat untuk periode itu, dan
  // memutuskan bentrokan menentukan potret saldo mana yang berlaku.
  "accounting.close",
  // Membatalkan pembayaran cicilan membalik jurnalnya, dan menutup kontrak
  // membuat sisa utangnya hanya bisa dibereskan dengan jurnal manual.
  "installment.cancel",
  // Perjalanan yang dibatalkan tidak dibayar: membatalkannya memutus upah
  // driver yang mungkin sudah setengah jalan.
  "trip.cancel",
  // Tarif dan penerima upah menentukan uang yang dibayarkan per surat jalan.
  "trip.tariff",
  // Menandai upah dibayar mengunci surat jalannya dari pembayaran lain, dan
  // membatalkannya membuka jalan membayar surat jalan yang sama dua kali.
  "trip.pay",
  // Rekening bank menentukan ke mana gaji dikirim.
  "hr.finance.manage",
  // Urgent dan memutus pengajuan menentukan hari yang tidak di-Alfa-kan dan
  // dibayar; penyesuaian jatah menambah hak cuti atau menguangkannya.
  "hr.request.urgent",
  "hr.request.decide",
  "hr.leave.adjust",
  // Memutus klaim sekaligus membayarnya (pembayaran terpisah dan
  // pembatalannya): uang keluar ke karyawan (§19.5).
  "reimburse.decide",
  // Mencabut SP menghapus dasar eskalasi; memberlakukan atau membatalkan
  // karyawan keluar menonaktifkan orangnya, akunnya, dan menetapkan pesangon.
  "hr.warning.cancel",
  "hr.offboard.manage",
  // Memfinalkan dan mengoreksi penilaian kinerja menetapkan nilai resmi
  // seorang karyawan (Q-83).
  "hr.performance.finalize",
]);

/**
 * Data rahasia karyawan (Q-23, Q-42): NIK, KK, rekening, NPWP, dan pindaian
 * dokumen. Tidak sensitif sebagai mutasi, tetapi TIDAK ikut paket Admin
 * bawaan (cermin `NOT IN` seed Admin Rust); hanya HRD dan Superadmin.
 */
export const CONFIDENTIAL_PERMISSIONS = new Set<PermissionKey>([
  "hr.personal.view",
  "hr.personal.manage",
  "hr.finance.view",
  "hr.finance.manage",
  "hr.document.view",
  "hr.document.manage",
  // Isi SP dan alasan keluar/pesangon (Q-69).
  "hr.warning.view",
  "hr.warning.manage",
  "hr.offboard.view",
  // Skor dan catatan penilai kinerja (Q-84); `config` tidak rahasia.
  "hr.performance.view",
  "hr.performance.assess",
]);

export const SYSTEM_ROLE_KEYS = [
  "superadmin",
  "admin",
  "operator",
  "scanner",
  "driver",
  "hrd",
  "atasan",
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
      !SENSITIVE_MUTATION_PERMISSIONS.has(key) &&
      !CONFIDENTIAL_PERMISSIONS.has(key),
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
  // Hanya melapor perjalanan yang sedang ditugaskan kepadanya (cakupan
  // diperiksa backend terhadap `master_operator.id_karyawan`).
  driver: ["trip.report"],
  // Cermin seed role HRD dan Atasan Rust (v36, v37).
  hrd: [
    "home.view",
    "employees.view",
    "employees.manage",
    "hr.org.manage",
    "hr.personal.view",
    "hr.personal.manage",
    "hr.finance.view",
    "hr.finance.manage",
    "hr.contract.manage",
    "hr.document.view",
    "hr.document.manage",
    "hr.request.view",
    "hr.request.submit",
    "hr.request.decide",
    "hr.warning.view",
    "hr.warning.manage",
    "hr.offboard.view",
    "hr.performance.view",
    "hr.performance.assess",
    "hr.performance.config",
    "hr.performance.finalize",
  ],
  atasan: [
    "home.view",
    "employees.view",
    "hr.request.view",
    "hr.request.submit",
    "hr.request.urgent",
    "hr.performance.assess",
  ],
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
