import { db, ensureDbInitialized } from "@/lib/db";
import { prosesScanAbsensi } from "./services/attendance";

export async function runAttendanceEngineTest() {
  try {
    await ensureDbInitialized();

    // 1. Inisialisasi Data Dummy Karyawan untuk Pengujian
    const testEmpId = "EMP_TEST_001";
    const testToken = "TOKEN_TEST_999";

    await db.execute({
      sql: `INSERT OR REPLACE INTO master_data (
              id_unik, kode_karyawan, nama, divisi, jabatan_status, no_hp, lp,
              id_shift, status_aktif, tanggal_daftar, catatan, token_absensi, status_qr
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Aktif', '2026-08-08', 'Data Test', ?, 'Generated');`,
      args: [
        testEmpId,
        "K999",
        "Budi Santoso (Test)",
        "SPPG",
        "Staff",
        "08123456789",
        "L",
        1, // Shift 1 Pagi
        testToken,
      ],
    });

    // 2. Test Scan 1: Scan Masuk (Clock-In)
    const scanMasukResult = await prosesScanAbsensi({
      qrText: `${testEmpId}|${testToken}`,
      sumberScan: "Scanner",
      kodeOperator: "OP001",
    });

    // 3. Test Scan 2: Anti-Double Scan Cooldown (Harus Ditolak jika < 60s)
    const scanGandaResult = await prosesScanAbsensi({
      qrText: `${testEmpId}|${testToken}`,
      sumberScan: "Scanner",
      kodeOperator: "OP001",
    });

    // 4. Ambil log_scan & absensi_harian hasil pengujian
    const logRes = await db.execute({
      sql: "SELECT * FROM log_scan WHERE id_karyawan = ? ORDER BY id_log DESC LIMIT 2;",
      args: [testEmpId],
    });

    const absensiRes = await db.execute({
      sql: "SELECT * FROM absensi_harian WHERE id_karyawan = ? ORDER BY id_absensi DESC LIMIT 1;",
      args: [testEmpId],
    });

    return {
      sukses: true,
      pesan: "Mesin Absensi Utama (Tahap 2) Berhasil Diuji!",
      hasilScanMasuk: scanMasukResult,
      hasilScanGanda: scanGandaResult,
      logScanHistory: logRes.rows,
      absensiRecord: absensiRes.rows[0] || null,
    };
  } catch (error: unknown) {
    const errMessage = error instanceof Error ? error.message : String(error);
    return {
      sukses: false,
      pesan: `Pengujian Mesin Absensi Gagal: ${errMessage}`,
    };
  }
}
