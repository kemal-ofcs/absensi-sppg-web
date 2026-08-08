import { ensureDbInitialized } from "@/lib/db";
import { jalankanAuditKualitasAbsensi } from "./services/alfa-audit";
import { buatPenugasanBackup } from "./services/backup";
import { prosesKoreksiAdmin } from "./services/correction";

export async function runTahap4Test() {
  try {
    await ensureDbInitialized();

    const todayStr = new Date().toISOString().split("T")[0];

    // 1. Test Koreksi Admin (Sakit untuk EMP_TEST_001)
    const koreksiResult = await prosesKoreksiAdmin({
      tanggal: todayStr,
      id_karyawan: "EMP_TEST_001",
      jenis_koreksi: "Sakit",
      keterangan_admin: "Surat Dokter terlampir",
      kode_operator: "OP001",
    });

    // 2. Test Penugasan Backup (EMP_TEST_002 menggantikan EMP_TEST_001)
    const backupResult = await buatPenugasanBackup({
      tanggal_tugas: todayStr,
      id_karyawan_asal: "EMP_TEST_001",
      id_karyawan_pengganti: "EMP_TEST_002",
      id_shift_backup: 1,
      alasan_backup: "Menggantikan Budi (Sakit)",
      kode_operator: "OP001",
    });

    // 3. Test Auto-Alfa Engine & System Audit
    const auditResult = await jalankanAuditKualitasAbsensi();

    return {
      sukses: true,
      pesan:
        "Modul Koreksi Admin, Backup Karyawan, & Auto-Alfa (Tahap 4) Berhasil Diuji!",
      koreksiResult,
      backupResult,
      auditResult,
    };
  } catch (error: unknown) {
    const errMessage = error instanceof Error ? error.message : String(error);
    return {
      sukses: false,
      pesan: `Pengujian Tahap 4 Gagal: ${errMessage}`,
    };
  }
}
