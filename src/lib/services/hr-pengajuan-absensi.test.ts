import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

mock.module("server-only", () => ({}));

const testDirectory = mkdtempSync(join(tmpdir(), "kos-hr-pengajuan-absensi-"));
process.env.TURSO_DATABASE_URL = `file:${join(testDirectory, "test.db")}`;

const { db, ensureDbInitialized } = await import("@/lib/db");
const { generateAlfaHarian } = await import("./alfa-audit");
const { auditKualitasAbsensi } = await import("./attendance-audit");
const { computePayrollRecap } = await import("./payroll-recap");

// Pengajuan berlaku (HRIS v37): tidak di-Alfa-kan, tidak diaudit (A-3), dan
// `Dibayar` masuk rekap gaji (A-4). Padanan Rust: `tests_alur` di
// `desktop/hr_pengajuan.rs` (`pengaju_tanggal`, `cuti_dibayar`).

beforeAll(async () => {
  await ensureDbInitialized();
  const ajuan = (
    id: string,
    karyawan: string,
    kelompok: string,
    dampak: string,
    mulai: string,
    selesai: string,
    setengah: number,
  ) =>
    `INSERT INTO hr_pengajuan (id_pengajuan, id_karyawan, id_jenis, kelompok, potong_jatah,
       dampak_gaji, tanggal_mulai, tanggal_selesai, setengah_hari, alasan, sidik,
       diajukan_oleh, waktu_perangkat)
     VALUES ('${id}', '${karyawan}', 'jns-x', '${kelompok}', 0, '${dampak}', '${mulai}',
       '${selesai}', ${setengah}, 'uji', 's-${id}', 'atasan', '2026-08-17 00:00:00');`;
  const setuju = (id: string) =>
    `INSERT INTO hr_pengajuan_keputusan (id_keputusan, id_pengajuan, jenis, sidik, oleh, waktu_perangkat)
     VALUES ('k-${id}', '${id}', 'Setujui', 's-${id}', 'hrd', '2026-08-17 01:00:00');`;
  await db.batch([
    `INSERT INTO tbl_shift (
       id_shift, kode_shift, nama_shift, jam_masuk, jam_pulang,
       awal_absen_menit, batas_masuk_menit, toleransi_masuk_menit,
       jam_kerja_normal_menit, istirahat_menit, batas_pulang_menit,
       offset_istirahat_mulai, offset_generate_alfa, buffer_shift_malam_menit,
       izinkan_multi_sesi
     ) VALUES (1, 1, 'Shift Pagi', '07:00', '15:00', 60, 15, 30, 420, 60, 60, 240, 60, 120, 0);`,
    `INSERT INTO master_data (id_unik, kode_karyawan, nama, divisi, id_shift, status_aktif) VALUES
       ('K1', 'E1', 'Harian Sakit', 'Gudang', 1, 'Aktif'),
       ('K2', 'E2', 'Per Jam Izin', 'Gudang', 1, 'Aktif'),
       ('K3', 'E3', 'Izin Tanpa Upah', 'Gudang', 1, 'Aktif'),
       ('K4', 'E4', 'Ditolak', 'Gudang', 1, 'Aktif');`,
    ajuan("p1", "K1", "Sakit", "Dibayar", "2026-08-18", "2026-08-19", 0),
    setuju("p1"),
    ajuan("p2", "K2", "Izin", "Dibayar", "2026-08-18", "2026-08-18", 1),
    setuju("p2"),
    ajuan("p3", "K3", "Izin", "Potong Gaji", "2026-08-18", "2026-08-18", 0),
    setuju("p3"),
    // Ditolak: tetap dinilai dan bisa di-Alfa-kan.
    ajuan("p4", "K4", "Izin", "Dibayar", "2026-08-18", "2026-08-18", 0),
    `INSERT INTO hr_pengajuan_keputusan (id_keputusan, id_pengajuan, jenis, sidik, alasan, oleh, waktu_perangkat)
     VALUES ('k-p4', 'p4', 'Tolak', 's-p4', 'Tidak cukup alasan', 'hrd', '2026-08-17 01:00:00');`,
    // K1 tetap scan Hadir tanggal 19: Hadir menang (Q-34), tidak dibayar dobel.
    `INSERT INTO absensi_harian (tanggal, id_karyawan, nama, kelas_divisi, jam_masuk, jam_pulang,
       status_kehadiran, status_absen, sumber, update_terakhir, jam_kerja, lembur,
       id_shift, bulan, tahun, id_sesi, mode_tugas)
     VALUES ('2026-08-19', 'K1', 'Harian Sakit', 'Gudang', '07:00', '15:00', 'Hadir',
       'Tepat Waktu', 'Scanner', 'x', 420, 0, 1, 'Agustus', 2026, 'S-19', 'NORMAL');`,
    `INSERT INTO salary_configs (id, id_karyawan, rate_per_hour, effective_date, created_by,
       salary_type, daily_rate) VALUES
       ('sc-1', 'K1', 0, '2026-01-01', 'uji', 'FLAT_DAILY', 100000),
       ('sc-2', 'K2', 60000, '2026-01-01', 'uji', 'HOURLY', 0);`,
  ]);
});

afterAll(() => {
  try {
    db.close();
    rmSync(testDirectory, { recursive: true, force: true });
  } catch {}
});

describe("pengajuan berlaku di absensi dan gaji", () => {
  test("audit absensi tidak menilai tanggal yang ditutup pengajuan", async () => {
    const hasil = await auditKualitasAbsensi(
      "2026-08-18",
      new Date("2026-08-18T18:00:00+07:00"),
      db,
    );
    expect(hasil.ringkasan.wajibAbsen).toBe(1);
  });

  test("Generate Alfa melewati pengajuan berlaku, bukan yang ditolak", async () => {
    const hasil = await generateAlfaHarian(
      new Date("2026-08-18T18:00:00+07:00"),
      db,
    );
    expect(hasil.jumlahPengajuan).toBe(3);
    expect(hasil.jumlahAlfaDibuat).toBe(1);
    const alfa = await db.execute(
      "SELECT id_karyawan FROM absensi_harian WHERE status_kehadiran = 'Alfa';",
    );
    expect(alfa.rows.map((r) => String(r.id_karyawan))).toEqual(["K4"]);
  });

  test("Dibayar menambah hari harian dan jam per jam; Potong Gaji tidak", async () => {
    const rekap = await computePayrollRecap(db, "2026-08-01", "2026-08-31");
    const per = new Map(rekap.map((b) => [b.id_karyawan, b]));
    // K1: scan 19 + sakit 18 (19 sudah hadir).
    expect(per.get("K1")?.days_present).toBe(2);
    expect(per.get("K1")?.cuti_dibayar_hari).toBe(1);
    // K2: setengah hari = ½ × 420 menit = 3,5 jam reguler.
    expect(per.get("K2")?.cuti_dibayar_menit).toBe(210);
    expect(per.get("K2")?.total_regular_hours).toBe(3.5);
    expect(per.get("K2")?.est_basic_salary).toBe(210_000);
    expect(per.get("K3")?.cuti_dibayar_hari).toBe(0);
    expect(per.get("K4")?.cuti_dibayar_hari).toBe(0);
  });
});
