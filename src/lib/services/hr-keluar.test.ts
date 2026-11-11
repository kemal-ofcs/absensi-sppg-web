import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OperatorUser } from "@/lib/auth/operator-user";

mock.module("server-only", () => ({}));

const testDirectory = mkdtempSync(join(tmpdir(), "kos-hr-keluar-"));
process.env.TURSO_DATABASE_URL = `file:${join(testDirectory, "test.db")}`;

const { db, ensureDbInitialized } = await import("@/lib/db");
const { computePayrollRecap } = await import("./payroll-recap");
const { toggleStatusKaryawan, updateKaryawan } = await import("./employee");
const {
  batalkan,
  berlakukan,
  cabutSp,
  daftarKeluar,
  daftarSp,
  pratinjauKeluar,
  rincianKeluar,
  simpanKeluar,
  simpanSp,
} = await import("./hr-keluar");
const { PESAN_SUDAH_KELUAR } = await import("@/lib/validations/hr-keluar");

// HRIS fase 5 (v40). Padanan Rust: `keluar_berlaku_menahan_event_lama_dan_bisa_dibatalkan`
// (`turso.rs`) dan vektor `hr_keluar.rs`.

const aktor = (username: string, permissions: string[], id = 0): OperatorUser =>
  ({
    id,
    username,
    isSuperadmin: false,
    permissions,
  }) as unknown as OperatorUser;

const hrd = aktor("hrd", ["hr.warning.manage", "hr.offboard.manage"], 900);

const hariIni = async () =>
  String(
    (await db.execute("SELECT date('now', '+7 hours') AS h;")).rows[0]?.h ?? "",
  );
const geser = async (hari: number) =>
  String(
    (
      await db.execute({
        sql: "SELECT date('now', '+7 hours', ?1) AS h;",
        args: [`${hari} days`],
      })
    ).rows[0]?.h ?? "",
  );

beforeAll(async () => {
  await ensureDbInitialized();
  await db.batch([
    `INSERT INTO tbl_shift (id_shift, kode_shift, nama_shift, jam_masuk, jam_pulang,
       jam_kerja_normal_menit, istirahat_menit, batas_pulang_menit,
       buffer_shift_malam_menit, offset_generate_alfa, hari_kerja)
     VALUES (1, 1, 'Pagi', '07:00', '15:00', 480, 60, 240, 120, 180, '1,2,3,4,5');`,
    `INSERT INTO master_data (id_unik, kode_karyawan, nama, divisi, id_shift, status_aktif, tanggal_daftar)
     VALUES ('K1', 'K1', 'Ani', 'Gudang', 1, 'Aktif', '2020-01-01'),
            ('K2', 'K2', 'Budi', 'Gudang', 1, 'Aktif', '2020-01-01');`,
    `INSERT INTO salary_configs (id, id_karyawan, rate_per_hour, ptkp_status, effective_date, created_by, created_at, salary_type, daily_rate)
     VALUES ('sc-1', 'K1', 0, 'TK/0', '2020-01-01', 'uji', '2020-01-01', 'FLAT_DAILY', 150000);`,
    `INSERT INTO master_operator (kode_operator, nama_operator, username, password_hash, role, id_karyawan, status)
     VALUES ('O1', 'Ani', 'ani', 'x', 'Operator', 'K1', 'Aktif');`,
  ]);
});

afterAll(() => {
  try {
    db.close();
    rmSync(testDirectory, { recursive: true, force: true });
  } catch {}
});

describe("HRIS fase 5: SP dan karyawan keluar Web", () => {
  test("SP: eskalasi, alasan tingkat, ubah teks, cabut", async () => {
    const tanggal = await hariIni();
    const dasar = {
      id_karyawan: "K1",
      tanggal,
      pelanggaran: "Terlambat 5 kali",
      penanda_nama: "Sari",
      penanda_jabatan: "HRD",
    };
    await expect(
      simpanSp(db, hrd, { ...dasar, tingkat: "SP2" }),
    ).rejects.toThrow(
      "Tingkat berbeda dari usulan (SP1); alasannya wajib diisi.",
    );
    const { id_sp } = await simpanSp(db, hrd, { ...dasar, tingkat: "SP1" });
    let daftar = await daftarSp(db, "K1");
    expect(daftar.usulan?.tingkat).toBe("SP2");
    expect(daftar.sp[0]?.status).toBe("Berlaku");
    expect(daftar.penanda_terakhir?.nama).toBe("Sari");

    await simpanSp(db, hrd, {
      ...dasar,
      id_sp,
      tingkat: "SP1",
      pelanggaran: "Terlambat 6 kali",
    });
    await expect(
      simpanSp(db, hrd, { ...dasar, id_sp, tingkat: "SP2" }),
    ).rejects.toThrow("Tingkat dan tanggal SP tidak bisa diubah.");

    // Tidak untuk diri sendiri: aktor tertaut ke K1 lewat akun `ani`.
    const ani = aktor("ani", ["hr.warning.cancel"], 1);
    const idAni = Number(
      (
        await db.execute(
          "SELECT id FROM master_operator WHERE username = 'ani';",
        )
      ).rows[0]?.id,
    );
    await expect(
      cabutSp(db, { ...ani, id: idAni } as OperatorUser, {
        id_sp,
        alasan: "x",
      }),
    ).rejects.toThrow("Tindakan ini tidak bisa dilakukan untuk diri sendiri.");
    await expect(cabutSp(db, hrd, { id_sp })).rejects.toThrow(
      "Alasan pencabutan wajib diisi.",
    );
    await cabutSp(db, hrd, { id_sp, alasan: "Keliru catat" });
    daftar = await daftarSp(db, "K1");
    expect(daftar.sp[0]?.status).toBe("Dicabut");
    expect(daftar.usulan?.tingkat).toBe("SP1");
  });

  test("catat, berlakukan, tahan aktifkan, batalkan", async () => {
    const pratinjau = await pratinjauKeluar(
      db,
      "K1",
      "klr-resign",
      await geser(3),
    );
    expect(pratinjau.data.usulan_upah_pokok).toBe(4_500_000);
    expect(pratinjau.usulan.map((u) => u.komponen)).toEqual([
      "UP",
      "UPMK",
      "UPH Cuti",
      "UPH Ongkos Pulang",
      "UPH Lainnya",
      "Uang Pisah",
      "Lainnya",
    ]);
    expect(pratinjau.akun.map((a) => a.username)).toEqual(["ani"]);

    await expect(
      simpanKeluar(db, hrd, {
        id_karyawan: "K1",
        id_alasan: "klr-resign",
        tanggal_terakhir: await geser(3),
        upah_pokok: 5_000_000,
      }),
    ).rejects.toThrow("Upah pokok berbeda dari usulan; alasannya wajib diisi.");
    const { id_keluar } = await simpanKeluar(db, hrd, {
      id_karyawan: "K1",
      id_alasan: "klr-resign",
      tanggal_terakhir: await geser(3),
      rincian: [
        { komponen: "Uang Pisah", nominal: 1_000_000, alasan_ubah: "PKB" },
      ],
    });
    await expect(
      simpanKeluar(db, hrd, {
        id_karyawan: "K1",
        id_alasan: "klr-resign",
        tanggal_terakhir: await geser(3),
      }),
    ).rejects.toThrow(
      "Karyawan ini sudah punya proses keluar yang belum dibatalkan.",
    );
    expect((await daftarKeluar(db)).keluar[0]?.status).toBe("Dijadwalkan");
    await expect(berlakukan(db, hrd, id_keluar)).rejects.toThrow(
      "Proses keluar baru bisa diberlakukan pada hari kerja terakhir.",
    );

    // Ubah ke kemarin: Jatuh tempo, lalu Berlakukan.
    await simpanKeluar(db, hrd, {
      id_keluar,
      id_karyawan: "K1",
      id_alasan: "klr-resign",
      tanggal_terakhir: await geser(-1),
      rincian: [
        { komponen: "Uang Pisah", nominal: 1_000_000, alasan_ubah: "PKB" },
      ],
    });
    const rincian = await rincianKeluar(db, id_keluar);
    expect(rincian.keluar.status).toBe("Jatuh tempo");
    expect(
      rincian.rincian.find((r) => r.komponen === "Uang Pisah")?.nominal,
    ).toBe(1_000_000);
    await berlakukan(db, hrd, id_keluar);
    const md = async () =>
      (
        await db.execute(
          "SELECT m.status_aktif, m.tanggal_selesai_aktif, m.id_keluar, o.status AS akun FROM master_data m JOIN master_operator o ON o.id_karyawan = m.id_unik WHERE m.id_unik = 'K1';",
        )
      ).rows[0];
    let baris = await md();
    expect([baris?.status_aktif, baris?.id_keluar, baris?.akun]).toEqual([
      "Nonaktif",
      id_keluar,
      "Nonaktif",
    ]);
    expect(baris?.tanggal_selesai_aktif).toBe(await geser(-1));
    await expect(berlakukan(db, hrd, id_keluar)).rejects.toThrow(
      "Proses keluar ini sudah berlaku.",
    );
    await expect(
      simpanKeluar(db, hrd, {
        id_keluar,
        id_karyawan: "K1",
        id_alasan: "klr-resign",
        tanggal_terakhir: await geser(-1),
      }),
    ).rejects.toThrow("Proses keluar yang sudah berlaku tidak bisa diubah.");

    // Halaman Karyawan tidak bisa mengaktifkannya; tanggal keluar tetap.
    await expect(toggleStatusKaryawan("K1", "Aktif")).rejects.toThrow(
      PESAN_SUDAH_KELUAR,
    );
    await updateKaryawan("K1", { tanggal_selesai_aktif: "" });
    expect((await md())?.tanggal_selesai_aktif).toBe(await geser(-1));

    // Rekap gaji periode yang memuat hari terakhir tetap memuat K1.
    const awal = `${(await geser(-1)).slice(0, 8)}01`;
    const rekap = await computePayrollRecap(db, awal, await hariIni());
    expect(rekap.map((r) => r.id_karyawan)).toContain("K1");
    const rekapNanti = await computePayrollRecap(
      db,
      "2999-01-01",
      "2999-01-31",
    );
    expect(rekapNanti.map((r) => r.id_karyawan)).not.toContain("K1");

    await expect(batalkan(db, hrd, { id_keluar })).rejects.toThrow(
      "Alasan pembatalan wajib diisi.",
    );
    await batalkan(db, hrd, { id_keluar, alasan: "Batal resign" });
    baris = await md();
    expect([baris?.status_aktif, baris?.id_keluar, baris?.akun]).toEqual([
      "Aktif",
      null,
      "Nonaktif",
    ]);
    expect((await daftarKeluar(db)).keluar[0]?.status).toBe("Dibatalkan");
  });
});
