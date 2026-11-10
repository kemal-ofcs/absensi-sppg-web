import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OperatorUser } from "@/lib/auth/operator-user";

mock.module("server-only", () => ({}));

const testDirectory = mkdtempSync(join(tmpdir(), "kos-hr-pengajuan-fase3-"));
process.env.TURSO_DATABASE_URL = `file:${join(testDirectory, "test.db")}`;

const { db, ensureDbInitialized } = await import("@/lib/db");
const { generateAlfaHarian } = await import("./alfa-audit");
const { auditKualitasAbsensi } = await import("./attendance-audit");
const { computePayrollRecap } = await import("./payroll-recap");
const { muatSpl, muatTukar, putuskan, simpanPengajuan, daftarPengajuan } =
  await import("./hr-pengajuan");
const { PESAN_TUKAR_BACKUP, PESAN_TUKAR_SHIFT_SAMA, pesanBertumpuk } =
  await import("@/lib/validations/hr-pengajuan");

// HRIS fase 3 (v38). Padanan Rust: `tests_alur::alur_fase3_tukar_dan_lembur`
// (`hr_pengajuan.rs`) dan `tukar_shift_dan_lembur_saat_generate_alfa`
// (`operational.rs`), data yang sama.

const aktor = (username: string, permissions: string[], id = 0): OperatorUser =>
  ({
    id,
    username,
    isSuperadmin: false,
    permissions,
  }) as unknown as OperatorUser;

beforeAll(async () => {
  await ensureDbInitialized();
  await db.batch([
    `INSERT INTO tbl_shift (id_shift, kode_shift, nama_shift, jam_masuk, jam_pulang,
       jam_kerja_normal_menit, istirahat_menit, batas_pulang_menit,
       buffer_shift_malam_menit, offset_generate_alfa, hari_kerja)
     VALUES (1, 1, 'Kantor', '07:00', '15:00', 480, 60, 240, 120, 180, '1,2,3,4,5'),
            (2, 2, 'Jaga', '07:00', '15:00', 480, 60, 240, 120, 180, '1,2,3,4,5,6,7');`,
    `INSERT INTO master_data (id_unik, kode_karyawan, nama, divisi, id_shift, status_aktif) VALUES
       ('EMP-STAF', 'S1', 'Staf Kantor', 'Keuangan', 1, 'Aktif'),
       ('EMP-SATPAM', 'S2', 'Satpam', 'Keamanan', 2, 'Aktif'),
       ('EMP-LEMBUR', 'S3', 'Satpam Dua', 'Keamanan', 2, 'Aktif');`,
    `INSERT INTO hr_pengajuan (id_pengajuan, id_karyawan, id_jenis, kelompok, potong_jatah, dampak_gaji,
       tanggal_mulai, tanggal_selesai, setengah_hari, alasan, sidik, diajukan_oleh, waktu_perangkat,
       jam_mulai, jam_selesai, id_karyawan_tukar, id_shift_asal, id_shift_tukar)
     VALUES ('pgn-t', 'EMP-STAF', 'jns-tukar-shift', 'Tukar Shift', 0, 'Tidak Berpengaruh', '2026-10-17',
               '2026-10-17', 0, 'Tukar', 's-t', 'hrd', '2026-10-10 01:00:00', NULL, NULL, 'EMP-SATPAM', 1, 2),
            ('pgn-l', 'EMP-LEMBUR', 'jns-lembur', 'Lembur', 0, 'Tidak Berpengaruh', '2026-10-17',
               '2026-10-17', 0, 'Jaga', 's-l', 'hrd', '2026-10-10 01:00:00', '15:00', '18:00', NULL, NULL, NULL);`,
    `INSERT INTO hr_pengajuan_keputusan (id_keputusan, id_pengajuan, jenis, sidik, oleh, waktu_perangkat)
     VALUES ('k-t', 'pgn-t', 'Setujui', 's-t', 'hrd2', '2026-10-10 02:00:00'),
            ('k-l', 'pgn-l', 'Setujui', 's-l', 'hrd2', '2026-10-10 02:00:00');`,
    `INSERT INTO salary_configs (id, id_karyawan, rate_per_hour, effective_date, created_by,
       salary_type, daily_rate) VALUES ('sc-1', 'K1', 60000, '2026-01-01', 'uji', 'HOURLY', 0);`,
  ]);
});

afterAll(() => {
  try {
    db.close();
    rmSync(testDirectory, { recursive: true, force: true });
  } catch {}
});

describe("HRIS fase 3", () => {
  test("Generate Alfa memakai shift tukar; SPL tidak menutup Alfa", async () => {
    await generateAlfaHarian(new Date("2026-10-17T23:30:00+07:00"), db);
    const alfa = await db.execute(
      "SELECT id_karyawan, id_shift FROM absensi_harian WHERE tanggal = '2026-10-17' ORDER BY id_karyawan;",
    );
    expect(
      alfa.rows.map((r) => [String(r.id_karyawan), Number(r.id_shift)]),
    ).toEqual([
      ["EMP-LEMBUR", 2],
      ["EMP-STAF", 2],
    ]);
    await generateAlfaHarian(new Date("2026-10-17T23:45:00+07:00"), db);
    const ulang = await db.execute(
      "SELECT COUNT(*) AS n FROM absensi_harian WHERE tanggal = '2026-10-17';",
    );
    expect(Number(ulang.rows[0]?.n)).toBe(2);
  });

  test("audit menilai tanggal tukar dengan shift tukar", async () => {
    const hasil = await auditKualitasAbsensi(
      "2026-10-17",
      new Date("2026-10-17T23:30:00+07:00"),
      db,
    );
    // Staf (shift Jaga) dan satpam lembur wajib; satpam bertukar libur.
    expect(hasil.ringkasan.wajibAbsen).toBe(2);
  });

  test("Web: tukar shift, lembur, bentrok, dan potongan SPL", async () => {
    await db.execute(
      `INSERT INTO master_data (id_unik, kode_karyawan, nama, divisi, id_shift, status_aktif) VALUES
         ('K1', 'S4', 'Ani', 'Gudang', 1, 'Aktif'),
         ('K2', 'S5', 'Budi', 'Gudang', 2, 'Aktif'),
         ('K3', 'S6', 'Cici', 'Gudang', 1, 'Aktif');`,
    );
    const hrd = aktor("hrd", ["hr.request.submit"]);
    const pemutus = aktor("hrd2", ["hr.request.decide"]);
    const ajukan = async (draft: Record<string, unknown>) =>
      (await simpanPengajuan(db, hrd, draft)).id_pengajuan;
    const setujui = (id: string) =>
      putuskan(db, pemutus, { id_pengajuan: id, aksi: "Setujui" });
    const gagal = async (draft: Record<string, unknown>) =>
      simpanPengajuan(db, hrd, draft).then(
        () => "lolos",
        (e: Error) => e.message,
      );

    const idTukar = await ajukan({
      id_karyawan: "K1",
      id_jenis: "jns-tukar-shift",
      tanggal_mulai: "2026-11-03",
      tanggal_selesai: "2026-11-03",
      alasan: "Acara keluarga",
      id_karyawan_tukar: "K2",
    });
    expect((await muatTukar(db, "2026-11-03", "2026-11-03")).size).toBe(0);
    await setujui(idTukar);
    expect([...(await muatTukar(db, "2026-11-02", "2026-11-04"))]).toEqual([
      ["K1|2026-11-03", 2],
      ["K2|2026-11-03", 1],
    ]);
    expect(
      await gagal({
        id_karyawan: "K1",
        id_jenis: "jns-tukar-shift",
        tanggal_mulai: "2026-11-04",
        tanggal_selesai: "2026-11-04",
        alasan: "x",
        id_karyawan_tukar: "K3",
      }),
    ).toBe(PESAN_TUKAR_SHIFT_SAMA);
    expect(
      await gagal({
        id_karyawan: "K2",
        id_jenis: "jns-cuti-tahunan",
        tanggal_mulai: "2026-11-03",
        tanggal_selesai: "2026-11-03",
        alasan: "x",
      }),
    ).toBe(pesanBertumpuk("2026-11-03", "2026-11-03"));
    await db.execute(
      `INSERT INTO backup_karyawan (id_backup, tanggal_tugas, id_karyawan_asal, nama_karyawan_asal, divisi_asal,
         id_shift_asal, id_karyawan_pengganti, nama_karyawan_pengganti, divisi_pengganti, id_shift_normal_pengganti,
         id_shift_backup, status_tugas, kode_operator, waktu_input)
       VALUES ('BCK-1', '2026-11-06', 'K3', 'Cici', 'Gudang', 1, 'K1', 'Ani', 'Gudang', 1, 1, 'Aktif', 'op', '2026-11-01');`,
    );
    expect(
      await gagal({
        id_karyawan: "K1",
        id_jenis: "jns-tukar-shift",
        tanggal_mulai: "2026-11-06",
        tanggal_selesai: "2026-11-06",
        alasan: "x",
        id_karyawan_tukar: "K2",
      }),
    ).toBe(PESAN_TUKAR_BACKUP);

    const lembur = (tanggal: string, a: string, b: string) => ({
      id_karyawan: "K1",
      id_jenis: "jns-lembur",
      tanggal_mulai: tanggal,
      tanggal_selesai: tanggal,
      alasan: "Opname",
      jam_mulai: a,
      jam_selesai: b,
    });
    await setujui(await ajukan(lembur("2026-11-03", "17:00", "19:00")));
    expect(await gagal(lembur("2026-11-03", "18:00", "20:00"))).toBe(
      pesanBertumpuk("2026-11-03", "2026-11-03"),
    );
    await ajukan(lembur("2026-11-03", "19:00", "20:00"));
    await setujui(await ajukan(lembur("2026-11-07", "08:00", "12:00")));
    expect([...(await muatSpl(db, "2026-11-01", "2026-11-30"))]).toEqual([
      ["K1|2026-11-03", 120],
      ["K1|2026-11-07", 240],
    ]);
    const d = await daftarPengajuan(db, { id_karyawan: "K1" });
    const tukar = d.pengajuan.find((b) => b.pengajuan.id_pengajuan === idTukar);
    expect(tukar?.nama_karyawan_tukar).toBe("Budi");
    expect(tukar?.tanda).toEqual([]);

    await db.execute(
      `INSERT INTO absensi_harian (tanggal, id_karyawan, nama, kelas_divisi, status_kehadiran, status_absen, sumber,
         update_terakhir, jam_kerja, lembur, id_shift, bulan, tahun, id_sesi) VALUES
         ('2026-11-03', 'K1', 'Ani', 'Gudang', 'Hadir', 'Lengkap', 'Scanner', 'x', 480, 180, 2, 'November', 2026, 's1'),
         ('2026-11-04', 'K1', 'Ani', 'Gudang', 'Hadir', 'Lengkap', 'Scanner', 'x', 480, 30, 1, 'November', 2026, 's2'),
         ('2026-11-07', 'K1', 'Ani', 'Gudang', 'Hadir', 'Lengkap', 'Scanner', 'x', 300, 0, 1, 'November', 2026, 's3');`,
    );
    const total = (b: {
      total_regular_hours: number;
      total_overtime_hours: number;
      total_holiday_hours: number;
    }) =>
      Math.round(
        (b.total_regular_hours +
          b.total_overtime_hours +
          b.total_holiday_hours) *
          60,
      );
    const otomatis = (
      await computePayrollRecap(db, "2026-11-01", "2026-11-30")
    ).find((b) => b.id_karyawan === "K1");
    expect(otomatis?.lembur_mode).toBe("otomatis");
    expect(otomatis?.lembur_dipotong_menit).toBe(0);
    await db.execute(
      "INSERT INTO setting_gex_system (key, value) VALUES ('hr_lembur_mode', 'spl');",
    );
    const spl = (
      await computePayrollRecap(db, "2026-11-01", "2026-11-30")
    ).find((b) => b.id_karyawan === "K1");
    // 11-03: 180 − 120; 11-04 tanpa SPL 30; Sabtu 300 − 240 dari jam kerja.
    expect(spl?.lembur_dipotong_menit).toBe(150);
    expect(spl?.lembur_tanpa_spl_menit).toBe(30);
    expect(otomatis && spl ? total(otomatis) - total(spl) : null).toBe(150);
    expect(JSON.parse(spl?.breakdown_snapshot ?? "{}").lembur_spl).toEqual({
      mode: "spl",
      dipotong_menit: 150,
      tanpa_spl_menit: 30,
    });
  });
});
