import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OperatorUser } from "@/lib/auth/operator-user";

mock.module("server-only", () => ({}));

const testDirectory = mkdtempSync(join(tmpdir(), "kos-hr-rekrutmen-"));
process.env.TURSO_DATABASE_URL = `file:${join(testDirectory, "test.db")}`;

const { db, ensureDbInitialized } = await import("@/lib/db");
const { tambahKaryawan } = await import("./employee");
const {
  bersihkanPelamar,
  catatTahap,
  daftarLowongan,
  daftarPelamar,
  hapusPelamar,
  jadikanKaryawan,
  simpanBerkas,
  simpanLowongan,
  simpanPelamar,
} = await import("./hr-rekrutmen");
const { IZIN_JADIKAN_KARYAWAN, PESAN_SUDAH_KARYAWAN, idDariPelamar } =
  await import("@/lib/validations/hr-rekrutmen");

// HRIS fase 7 (v42). Padanan Rust: `rekrutmen_cloud_tahap_berkas_dan_retensi`
// dan `tests_alur::alur_fase7_jadikan_karyawan` (`hr_rekrutmen.rs`).

const aktor = (permissions: string[]): OperatorUser =>
  ({
    id: 900,
    username: "hrd",
    isSuperadmin: false,
    permissions,
  }) as unknown as OperatorUser;
const hrd = aktor([...IZIN_JADIKAN_KARYAWAN]);

const tanggal = async (ubah: string) =>
  String(
    (
      await db.execute({
        sql: "SELECT date('now', '+7 hours', ?1) AS h;",
        args: [ubah],
      })
    ).rows[0]?.h ?? "",
  );
const angka = async (sql: string) =>
  Number((await db.execute(sql)).rows[0]?.n ?? -1);
const galat = async (janji: Promise<unknown>) => {
  try {
    await janji;
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("harus ditolak");
};

beforeAll(async () => {
  await ensureDbInitialized();
  await db.batch([
    `INSERT INTO tbl_shift (id_shift, kode_shift, nama_shift, jam_masuk, jam_pulang, jam_kerja_normal_menit)
     VALUES (1, 1, 'Pagi', '07:00', '15:00', 480);`,
    "INSERT INTO hr_divisi (id_divisi, nama, is_aktif) VALUES ('div-1', 'Gudang', 1);",
    "INSERT INTO hr_divisi_nama (id_nama, id_divisi, nama) VALUES ('div-1:awal', 'div-1', 'Gudang');",
    `INSERT INTO master_data (id_unik, kode_karyawan, nama, divisi, id_shift, status_aktif)
     VALUES ('EMP_LAMA', 'KLAMA', 'Lama', 'Gudang', 1, 'Aktif');`,
  ]);
});

afterAll(() => {
  try {
    db.close();
    rmSync(testDirectory, { recursive: true, force: true });
  } catch {}
});

describe("HRIS fase 7: rekrutmen Web", () => {
  test("tahap, berkas, retensi, dan hapus lebih cepat", async () => {
    const low = (
      await simpanLowongan(db, hrd, {
        judul: "Staf Gudang",
        jumlah: 1,
        tanggal_buka: await tanggal("-30 days"),
      })
    ).id_lowongan;
    const pelamar = async (nama: string) => ({
      id_lowongan: low,
      nama,
      no_hp: "081234567890",
      tanggal_lamaran: await tanggal("-20 days"),
    });
    const a = (await simpanPelamar(db, hrd, await pelamar("Ani"))).id_pelamar;
    expect(
      await angka(
        "SELECT COUNT(*) AS n FROM hr_pelamar_tahap WHERE urutan = 1 AND tahap = 'Lamaran';",
      ),
    ).toBe(1);

    const tahap = async (nama: string, catatan: string | null = null) => ({
      id_pelamar: a,
      tahap: nama,
      tanggal: await tanggal("-10 days"),
      catatan,
    });
    expect((await catatTahap(db, hrd, await tahap("Wawancara"))).status).toBe(
      "Wawancara",
    );
    expect(
      (await catatTahap(db, hrd, await tahap("Ditolak", "Tidak cocok"))).status,
    ).toBe("Ditolak");
    expect(await galat(catatTahap(db, hrd, await tahap("Tes")))).toBe(
      "Pelamar sudah Ditolak; tahap baru tidak bisa dicatat.",
    );
    const batal = { id_pelamar: a, aksi: "batal", alasan: "Salah tekan" };
    expect((await catatTahap(db, hrd, batal)).status).toBe("Wawancara");
    expect((await catatTahap(db, hrd, batal)).status).toBe("Lamaran");
    expect(await galat(catatTahap(db, hrd, batal))).toBe(
      "Tahap Lamaran tidak bisa dibatalkan.",
    );
    await catatTahap(db, hrd, await tahap("Tes"));
    expect(await angka("SELECT MAX(urutan) AS n FROM hr_pelamar_tahap;")).toBe(
      4,
    );

    const berkas = {
      id_pelamar: a,
      mime_type: "application/pdf",
      data_base64: btoa("%PDF-1.7 cv"),
    };
    for (let i = 0; i < 3; i++) await simpanBerkas(db, berkas);
    expect(await galat(simpanBerkas(db, berkas))).toBe(
      "Satu pelamar maksimal 3 berkas.",
    );

    const b = (await simpanPelamar(db, hrd, await pelamar("Budi"))).id_pelamar;
    await db.execute({
      sql: "UPDATE hr_pelamar SET id_karyawan = 'EMP_B' WHERE id_pelamar = ?1;",
      args: [b],
    });
    expect(
      await galat(
        simpanPelamar(db, hrd, {
          ...(await pelamar("Budi S")),
          id_pelamar: b,
        }),
      ),
    ).toBe(PESAN_SUDAH_KARYAWAN);
    expect(await galat(hapusPelamar(db, b))).toBe(
      "Pelamar yang sudah dijadikan karyawan tidak bisa dihapus.",
    );
    const isi = await daftarPelamar(db, low);
    expect(isi.pelamar.length).toBe(2);
    expect(isi.pelamar.every((p) => p.mungkin_ganda === false)).toBe(true);

    expect((await bersihkanPelamar(db)).dihapus).toBe(0);
    await simpanLowongan(db, hrd, { id_lowongan: low, aksi: "tutup" });
    expect(
      await galat(simpanLowongan(db, hrd, { id_lowongan: low, aksi: "tutup" })),
    ).toBe("Lowongan sudah ditutup.");
    await db.batch([
      "UPDATE hr_lowongan SET ditutup_pada = datetime('now', '-13 months');",
      "INSERT OR REPLACE INTO setting_gex_system (key, value) VALUES ('hr_pelamar_retensi_bulan', '24');",
    ]);
    expect((await bersihkanPelamar(db)).dihapus).toBe(0);
    const daftar = await daftarLowongan(db);
    expect(daftar.lowongan[0]?.status).toBe("Ditutup");
    expect(daftar.lowongan[0]?.menggantung).toBe(1);
    expect(typeof daftar.lowongan[0]?.tanggal_hapus).toBe("string");
    await db.execute(
      "UPDATE setting_gex_system SET value = '12' WHERE key = 'hr_pelamar_retensi_bulan';",
    );
    expect((await bersihkanPelamar(db)).dihapus).toBe(1);
    expect((await bersihkanPelamar(db)).dihapus).toBe(0);
    expect([
      await angka("SELECT COUNT(*) AS n FROM hr_pelamar;"),
      await angka("SELECT COUNT(*) AS n FROM hr_pelamar_tahap;"),
      await angka("SELECT COUNT(*) AS n FROM hr_pelamar_berkas;"),
      await angka("SELECT pelamar_dihapus AS n FROM hr_lowongan;"),
    ]).toEqual([1, 1, 0, 1]);

    await simpanLowongan(db, hrd, { id_lowongan: low, aksi: "buka" });
    expect((await daftarLowongan(db)).lowongan[0]?.tanggal_hapus).toBeNull();
    const c = (await simpanPelamar(db, hrd, await pelamar("Citra"))).id_pelamar;
    await hapusPelamar(db, c);
    expect([
      await angka("SELECT COUNT(*) AS n FROM hr_pelamar;"),
      await angka("SELECT pelamar_dihapus AS n FROM hr_lowongan;"),
    ]).toEqual([1, 2]);
  });

  test("jadikan karyawan: satu transaksi, terkunci, Lanjutkan, izin", async () => {
    const low = (
      await simpanLowongan(db, hrd, {
        judul: "Admin",
        jumlah: 2,
        tanggal_buka: await tanggal("-30 days"),
      })
    ).id_lowongan;
    const pelamarBaru = async (nama: string) =>
      (
        await simpanPelamar(db, hrd, {
          id_lowongan: low,
          nama,
          no_hp: "081234567890",
          tanggal_lamaran: await tanggal("-20 days"),
          tanggal_lahir: "1995-05-05",
          alamat: "Jl. Mawar 1",
          pendidikan: "S1",
        })
      ).id_pelamar;
    const draft = async (idPelamar: string, kode?: string) => ({
      id_pelamar: idPelamar,
      karyawan: {
        nama: "Ani",
        kode_karyawan: kode,
        id_shift: 1,
        id_divisi: "div-1",
        lp: "P",
        tanggal_daftar: await tanggal("+0 days"),
      },
      kontrak: {
        jenis: "PKWT",
        tanggal_mulai: await tanggal("+0 days"),
        tanggal_selesai: await tanggal("+1 year"),
      },
    });
    const p = await pelamarBaru("Ani");
    expect(await galat(jadikanKaryawan(db, hrd, await draft(p)))).toBe(
      "Hanya pelamar berstatus Diterima yang bisa dijadikan karyawan.",
    );
    await catatTahap(db, hrd, {
      id_pelamar: p,
      tahap: "Diterima",
      tanggal: await tanggal("-1 days"),
    });
    const kurang = aktor(["hr.recruit.manage", "employees.manage"]);
    expect(await galat(jadikanKaryawan(db, kurang, await draft(p)))).toBe(
      "Akses ditolak untuk tindakan ini.",
    );
    expect(await galat(jadikanKaryawan(db, hrd, await draft(p, "KLAMA")))).toBe(
      "Kode karyawan KLAMA sudah dipakai karyawan lain.",
    );
    const klaim = async (id: string) =>
      (
        await db.execute({
          sql: "SELECT id_karyawan FROM hr_pelamar WHERE id_pelamar = ?1;",
          args: [id],
        })
      ).rows[0]?.id_karyawan ?? null;
    expect(await klaim(p)).toBeNull();

    const id = idDariPelamar(p);
    if (!id.ok) throw new Error(id.pesan);
    const hasil = await jadikanKaryawan(db, hrd, await draft(p));
    expect(hasil).toMatchObject({
      id_unik: id.nilai.id_unik,
      id_kontrak: id.nilai.id_kontrak,
      lanjutan: false,
    });
    expect(await klaim(p)).toBe(id.nilai.id_unik);
    const m = (
      await db.execute({
        sql: "SELECT kode_karyawan, qr_code, token_absensi, jenis_personil, id_divisi FROM master_data WHERE id_unik = ?1;",
        args: [id.nilai.id_unik],
      })
    ).rows[0];
    expect(m?.kode_karyawan).toBe(id.nilai.kode_karyawan);
    expect(m?.qr_code).toBe(`${id.nilai.id_unik}|${m?.token_absensi}`);
    expect([m?.jenis_personil, m?.id_divisi]).toEqual(["Kontrak", "div-1"]);
    expect(
      await angka(
        `SELECT COUNT(*) AS n FROM id_card WHERE id_unik = '${id.nilai.id_unik}';`,
      ),
    ).toBe(1);
    expect(
      await angka(
        `SELECT COUNT(*) AS n FROM hr_kontrak WHERE id_kontrak = '${id.nilai.id_kontrak}';`,
      ),
    ).toBe(1);
    const alamat = (
      await db.execute({
        sql: "SELECT alamat_domisili FROM hr_profil WHERE id_karyawan = ?1;",
        args: [id.nilai.id_unik],
      })
    ).rows[0]?.alamat_domisili;
    expect(alamat).toBe("Jl. Mawar 1");

    // Tekan kedua: karyawan sudah ada di cloud, tidak ditulis ulang.
    const lagi = await jadikanKaryawan(db, hrd, await draft(p));
    expect(lagi).toMatchObject({ sudah_ada: "cloud" });
    expect(
      await angka(
        `SELECT COUNT(*) AS n FROM hr_kontrak WHERE id_karyawan = '${id.nilai.id_unik}';`,
      ),
    ).toBe(1);

    // Terkunci sesudah menjadi karyawan.
    expect(
      await galat(
        catatTahap(db, hrd, { id_pelamar: p, aksi: "batal", alasan: "x" }),
      ),
    ).toBe(PESAN_SUDAH_KARYAWAN);

    // Klaim dari Desktop yang tertutup di tengah: Web menyelesaikannya.
    const q = await pelamarBaru("Budi");
    await catatTahap(db, hrd, {
      id_pelamar: q,
      tahap: "Diterima",
      tanggal: await tanggal("-1 days"),
    });
    const idQ = idDariPelamar(q);
    if (!idQ.ok) throw new Error(idQ.pesan);
    await db.execute({
      sql: "UPDATE hr_pelamar SET id_karyawan = ?2, dijadikan_oleh = 'perangkat-lain', dijadikan_pada = datetime('now') WHERE id_pelamar = ?1;",
      args: [q, idQ.nilai.id_unik],
    });
    const budi = await draft(q);
    budi.karyawan.nama = "Budi";
    expect(await jadikanKaryawan(db, hrd, budi)).toMatchObject({
      lanjutan: true,
    });

    // Klaim milik id lain: ditolak.
    const r = await pelamarBaru("Citra");
    await db.execute({
      sql: "UPDATE hr_pelamar SET id_karyawan = 'EMP_LAIN' WHERE id_pelamar = ?1;",
      args: [r],
    });
    expect(await galat(jadikanKaryawan(db, hrd, await draft(r)))).toBe(
      "Pelamar ini sudah dijadikan karyawan.",
    );

    // Gagal di tengah transaksi (divisi tak dikenal) tidak meninggalkan klaim.
    const s = await pelamarBaru("Dodi");
    await catatTahap(db, hrd, {
      id_pelamar: s,
      tahap: "Diterima",
      tanggal: await tanggal("-1 days"),
    });
    const rusak = await draft(s);
    (rusak.karyawan as Record<string, unknown>).id_divisi = "div-hilang";
    expect(await galat(jadikanKaryawan(db, hrd, rusak))).toBe(
      "Divisi tidak ditemukan.",
    );
    expect(await klaim(s)).toBeNull();
  });

  test("tambah karyawan biasa tetap jalan sebagai satu batch", async () => {
    const hasil = await tambahKaryawan({
      id_unik: "EMP_BIASA",
      kode_karyawan: "KBIASA",
      nama: "Eka",
      divisi: "Gudang",
      lp: "L",
      id_shift: 1,
    });
    const m = (
      await db.execute(
        "SELECT qr_code, id_divisi FROM master_data WHERE id_unik = 'EMP_BIASA';",
      )
    ).rows[0];
    expect(m?.qr_code).toBe(`EMP_BIASA|${hasil.token_absensi}`);
    expect(m?.id_divisi).toBe("div-1");
    expect(
      await angka(
        "SELECT COUNT(*) AS n FROM id_card WHERE id_unik = 'EMP_BIASA';",
      ),
    ).toBe(1);
  });
});
