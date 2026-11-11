import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OperatorUser } from "@/lib/auth/operator-user";

mock.module("server-only", () => ({}));

const testDirectory = mkdtempSync(join(tmpdir(), "kos-hr-kinerja-"));
process.env.TURSO_DATABASE_URL = `file:${join(testDirectory, "test.db")}`;

const { db, ensureDbInitialized } = await import("@/lib/db");
const {
  daftarKinerja,
  putuskanKinerja,
  rincianKinerja,
  simpanKinerja,
  simpanPengaturanKinerja,
  simpanTemplateKinerja,
  templatesKinerja,
} = await import("./hr-kinerja");
const {
  IZIN_ASSESS,
  IZIN_CONFIG,
  IZIN_FINALIZE,
  IZIN_VIEW,
  KUNCI_AMBANG,
  KUNCI_PERIODE,
  KUNCI_PREDIKAT,
  PESAN_BELUM_FINAL_SENDIRI,
  PESAN_DIRI_SENDIRI,
  PESAN_DISIPLIN_BERUBAH,
  PESAN_IZIN,
  PESAN_TANPA_TEMPLATE,
  PREDIKAT_BAWAAN,
  STATUS_DIAJUKAN,
  STATUS_DRAF,
  STATUS_FINAL,
  pesanBertumpuk,
} = await import("@/lib/validations/hr-kinerja");

// HRIS fase 6 (v41). Padanan Rust: `tests_alur::alur_fase6_kinerja`
// (`hr_kinerja.rs`), data dan pesan sama.

const aktor = (username: string, permissions: string[], id: number) =>
  ({
    id,
    username,
    isSuperadmin: false,
    permissions,
  }) as unknown as OperatorUser;

const hrd = aktor(
  "hrd",
  [IZIN_VIEW, IZIN_ASSESS, IZIN_CONFIG, IZIN_FINALIZE],
  900,
);
const atasan = aktor("atasan", [IZIN_ASSESS], 901);
const ani = aktor("ani", [IZIN_ASSESS], 902);
const aniView = aktor("ani", [IZIN_VIEW], 902);

const hadir = (tanggal: string) =>
  db.execute({
    sql: `INSERT INTO absensi_harian (tanggal, id_karyawan, nama, kelas_divisi, status_kehadiran, status_absen, sumber,
            update_terakhir, id_shift, bulan, tahun, id_sesi, jam_masuk)
          VALUES (?1, 'K1', 'Ani', 'Gudang', 'Hadir', 'Valid', 'Scanner', ?1, 1, 'Januari', 2025, 'S-' || ?1, '07:55');`,
    args: [tanggal],
  });

const pesan = async (janji: Promise<unknown>) => {
  try {
    await janji;
    return "";
  } catch (error) {
    return (error as Error).message;
  }
};

type Baris = Record<string, unknown>;

beforeAll(async () => {
  await ensureDbInitialized();
  await db.batch([
    `INSERT INTO tbl_shift (id_shift, kode_shift, nama_shift, jam_masuk, jam_pulang,
       jam_kerja_normal_menit, istirahat_menit, batas_pulang_menit,
       buffer_shift_malam_menit, offset_generate_alfa, hari_kerja)
     VALUES (1, 1, 'Pagi', '07:00', '15:00', 480, 60, 240, 120, 180, '1,2,3,4,5');`,
    `INSERT INTO hr_jabatan (id_jabatan, nama, is_aktif) VALUES ('jbt-1', 'Staf Gudang', 1), ('jbt-2', 'Sopir', 1);`,
    `INSERT INTO master_data (id_unik, kode_karyawan, nama, divisi, id_shift, status_aktif, tanggal_daftar, id_jabatan, id_atasan)
     VALUES ('K1', 'K1', 'Ani', 'Gudang', 1, 'Aktif', '2024-01-02', 'jbt-1', 'K9'),
            ('K2', 'K2', 'Budi', 'Gudang', 1, 'Aktif', '2024-01-02', 'jbt-2', 'K9'),
            ('K9', 'K9', 'Sari', 'Gudang', 1, 'Aktif', '2020-01-02', NULL, NULL);`,
    `INSERT INTO master_operator (id, kode_operator, nama_operator, username, password_hash, role, id_karyawan, status)
     VALUES (901, 'O1', 'Sari', 'atasan', 'x', 'Operator', 'K9', 'Aktif'),
            (902, 'O2', 'Ani', 'ani', 'x', 'Operator', 'K1', 'Aktif');`,
  ]);
});

afterAll(() => {
  try {
    db.close();
    rmSync(testDirectory, { recursive: true, force: true });
  } catch {}
});

describe("HRIS fase 6: penilaian kinerja Web", () => {
  test("alur: buat, ajukan, kembalikan, final, koreksi, keluar", async () => {
    // Template untuk Staf Gudang; Sopir tanpa template dan tanpa bawaan.
    const t = await simpanTemplateKinerja(db, hrd, {
      nama: "Staf",
      jabatan: ["jbt-1"],
      aspek: [
        { nama: "Kerja sama", tipe: "Manual", bobot: 60 },
        { nama: "Disiplin", tipe: "Otomatis Disiplin", bobot: 40 },
      ],
    });
    expect(
      await pesan(
        simpanTemplateKinerja(db, hrd, {
          nama: " staf ",
          aspek: [{ nama: "A", tipe: "Manual", bobot: 100 }],
        }),
      ),
    ).toBe('Template "staf" sudah ada.');
    const daftarT = await templatesKinerja(db);
    expect(daftarT.template[0]?.jabatan).toEqual(["jbt-1"]);
    expect(daftarT.template[0]?.id_template).toBe(t.id_template);
    await simpanPengaturanKinerja(db, {
      [KUNCI_PERIODE]: "Bulanan",
      [KUNCI_AMBANG]: "950,900,800,700",
      [KUNCI_PREDIKAT]: PREDIKAT_BAWAAN,
    });

    // Januari 2025: 23 hari kerja, hadir dua hari → D 23, P 86, skor 1.
    await hadir("2025-01-02");
    await hadir("2025-01-03");
    const idAspek = (daftarT.template[0]?.aspek as Baris[]).map((a) =>
      String(a.id_aspek),
    );
    const draf = (nilai: unknown[]): Baris => ({
      id_karyawan: "K1",
      periode_jenis: "Bulanan",
      periode_mulai: "2025-01-01",
      nilai,
    });
    const isian = [{ id_aspek: idAspek[0], skor: 4, catatan: "Rapi" }];
    expect(await pesan(simpanKinerja(db, ani, draf(isian)))).toBe(
      PESAN_DIRI_SENDIRI,
    );
    const hasil = await simpanKinerja(db, atasan, draf(isian));
    const id = hasil.id_penilaian;
    expect(hasil.disiplin?.rincian).toBe("23|2|0|0|21|0|86|950,900,800,700");
    expect(
      await pesan(
        simpanKinerja(db, atasan, { ...draf(isian), periode_jenis: "Kuartal" }),
      ),
    ).toBe(pesanBertumpuk("2025-01-01", "2025-01-31"));
    expect(
      await pesan(
        simpanKinerja(db, atasan, { ...draf([]), id_karyawan: "K2" }),
      ),
    ).toBe(PESAN_TANPA_TEMPLATE);

    // Absensi baru masuk sesudah draf disimpan: Ajukan ditolak, lalu lolos
    // setelah simpan ulang menghitung disiplin dari data baru.
    await hadir("2025-01-06");
    const aksi = (op: OperatorUser, a: string, alasan = "") =>
      putuskanKinerja(db, op, { id_penilaian: id, aksi: a, alasan });
    expect(await pesan(aksi(atasan, "Ajukan"))).toBe(PESAN_DISIPLIN_BERUBAH);
    const ubah = { ...draf(isian), id_penilaian: id };
    const ulang = await simpanKinerja(db, atasan, ubah);
    expect(ulang.disiplin?.tepat).toBe(3);
    expect((await aksi(atasan, "Ajukan")).status).toBe(STATUS_DIAJUKAN);
    expect(await pesan(simpanKinerja(db, atasan, ubah))).toBe(
      "Penilaian yang sudah diajukan atau selesai tidak bisa disunting.",
    );
    expect(await pesan(aksi(atasan, "Final"))).toBe(PESAN_IZIN);
    expect(await pesan(aksi(hrd, "Kembalikan"))).toBe(
      "Alasan pengembalian wajib diisi.",
    );
    expect(
      (await aksi(hrd, "Kembalikan", "Skor kerja sama terlalu tinggi")).status,
    ).toBe(STATUS_DRAF);
    expect((await aksi(atasan, "Ajukan")).status).toBe(STATUS_DIAJUKAN);
    expect((await aksi(hrd, "Final")).status).toBe(STATUS_FINAL);
    // 60 × 25 × 3 + 40 × 25 × 0 = 4.500 → Kurang.
    const r = await rincianKinerja(db, hrd, id);
    expect([r.penilaian.nilai_teks, r.penilaian.predikat]).toEqual([
      "45,00",
      "Kurang",
    ]);
    expect(r.boleh.Koreksi).toBe(true);
    expect(r.sp).toEqual([]);
    expect(await pesan(aksi(hrd, "Batal", "x"))).toBe(
      "Penilaian final tidak bisa dibatalkan; buat koreksi.",
    );
    // Diri sendiri: tanpa `view` tidak terbaca, dengan `view` terbaca setelah Final.
    expect(await pesan(rincianKinerja(db, ani, id))).toBe(
      PESAN_BELUM_FINAL_SENDIRI,
    );
    expect(await pesan(rincianKinerja(db, aniView, id))).toBe("");

    // Koreksi: hanya `finalize`, merujuk akar, nilai disalin dari yang berlaku.
    const koreksi = {
      ...draf([]),
      id_ref: id,
      alasan_koreksi: "Salah ketik skor",
    };
    expect(await pesan(simpanKinerja(db, atasan, koreksi))).toBe(PESAN_IZIN);
    const k1 = await simpanKinerja(db, hrd, koreksi);
    const idK = k1.id_penilaian;
    expect(await pesan(simpanKinerja(db, hrd, koreksi))).toBe(
      "Penilaian ini masih punya koreksi yang belum selesai.",
    );
    let rk = await rincianKinerja(db, hrd, idK);
    expect(rk.nilai[0]?.skor).toBe(4);
    expect(rk.id_akar).toBe(id);
    await simpanKinerja(db, hrd, {
      ...koreksi,
      id_penilaian: idK,
      nilai: [{ id_aspek: idAspek[0], skor: 5 }],
    });
    await putuskanKinerja(db, hrd, { id_penilaian: idK, aksi: "Ajukan" });
    await putuskanKinerja(db, hrd, { id_penilaian: idK, aksi: "Final" });
    rk = await rincianKinerja(db, hrd, idK);
    expect(rk.id_berlaku).toBe(idK);
    expect(rk.penilaian.nilai_teks).toBe("60,00");
    expect(rk.penilaian.tanda).toEqual([
      "dinilai_dan_difinalkan_sama",
      "bukan_atasan_langsung",
    ]);
    const keputusanCloud = await db.execute(
      "SELECT COUNT(*) AS n FROM hr_kinerja_keputusan WHERE diterima_cloud IS NULL;",
    );
    expect(Number(keputusanCloud.rows[0]?.n)).toBe(0);

    // Daftar: K2 belum dinilai (tanpa template), K9 (sesi atasan) tidak ikut.
    const d = await daftarKinerja(db, atasan, {
      periode_jenis: "Bulanan",
      periode_mulai: "2025-01-01",
    });
    expect(d.penilaian).toHaveLength(2);
    expect(d.penilaian[0]?.atasan_saya).toBe(true);
    expect(d.belum_dinilai).toEqual([
      {
        id_karyawan: "K2",
        nama: "Budi",
        divisi: "Gudang",
        jabatan_nama: "Sopir",
        id_template: null,
        template_nama: null,
        atasan_saya: true,
      },
    ]);
    const dAni = await daftarKinerja(db, ani, { periode_mulai: "2025-01-01" });
    expect(dAni.penilaian).toHaveLength(0);

    // Keluar berlaku: penilaian baru ditolak, draf yang ada tetap selesai.
    const feb = await simpanKinerja(db, atasan, {
      id_karyawan: "K1",
      periode_jenis: "Bulanan",
      periode_mulai: "2025-02-01",
      nilai: [{ id_aspek: idAspek[0], skor: 3 }],
    });
    await db.execute(
      "UPDATE master_data SET id_keluar = 'klr-1', status_aktif = 'Nonaktif' WHERE id_unik = 'K1';",
    );
    expect(
      await pesan(
        simpanKinerja(db, atasan, {
          id_karyawan: "K1",
          periode_jenis: "Bulanan",
          periode_mulai: "2025-03-01",
        }),
      ),
    ).toBe("Karyawan ini sudah keluar; penilaian baru tidak bisa dibuat.");
    await putuskanKinerja(db, atasan, {
      id_penilaian: feb.id_penilaian,
      aksi: "Ajukan",
    });
    expect(
      (
        await putuskanKinerja(db, hrd, {
          id_penilaian: feb.id_penilaian,
          aksi: "Final",
        })
      ).status,
    ).toBe(STATUS_FINAL);

    // Riwayat satu karyawan: koreksi menggantikan akarnya sebagai nilai berlaku.
    const riwayat = await daftarKinerja(db, hrd, { id_karyawan: "K1" });
    const berlaku = new Map(
      riwayat.penilaian.map((p) => [String(p.id_penilaian), p.berlaku]),
    );
    expect(berlaku).toEqual(
      new Map([
        [feb.id_penilaian, true],
        [id, false],
        [idK, true],
      ]),
    );
    expect(riwayat.belum_dinilai).toEqual([]);
  });
});
