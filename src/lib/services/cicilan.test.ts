import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Client, createClient } from "@libsql/client";
import { initDatabaseSchema } from "@/lib/db-schema";
import {
  AKUN_BEBAN_BUNGA,
  AKUN_PENDAPATAN_LAIN,
  AKUN_UTANG_CICILAN,
  alokasiJadwal,
  type Besaran,
  bagiPokokBunga,
  bayarDraftSchema,
  besaranCicilan,
  bungaKumulatif,
  idCicilan,
  idJurnalCicilan,
  keteranganJurnalCicilan,
  perluAccUlang,
  type Syarat,
  statusCicilan,
  susunJadwal,
  susunJurnalCicilan,
  syaratDraftSchema,
  validasiBayar,
  validasiSyarat,
  wajibTerimaPenuh,
} from "@/lib/validations/cicilan";

mock.module("server-only", () => ({}));
const { sidikSyarat, listCicilan, catatBayarCicilan, batalBayarCicilan } =
  await import("@/lib/services/cicilan");
const { decidePengajuan, listPengajuan, receivePengajuan, savePengajuan } =
  await import("@/lib/services/inventory-pengajuan");
const { cancelMutation, journalPost } = await import(
  "@/lib/services/inventory"
);

// Vektor yang sama dengan `mod tests` di `desktop/cicilan.rs`.

const tanggal = (baris: { jatuh_tempo: string }[]) =>
  baris.map((b) => b.jatuh_tempo);

function susun(...args: Parameters<typeof susunJadwal>) {
  const hasil = susunJadwal(...args);
  if (!hasil.ok) throw new Error(hasil.error);
  return hasil.value;
}

const draftBerkala = (uangMuka: number, tenor: number, nominal: number) =>
  syaratDraftSchema.parse({
    kreditur: " Toko Maju ",
    nomor_kontrak: "K-01",
    uang_muka: uangMuka,
    pola: "Berkala",
    jatuh_tempo_pertama: "2026-11-28",
    setiap: 1,
    satuan: "Bulan",
    tenor,
    nominal,
  });

describe("aturan murni cicilan", () => {
  test("jadwal bulanan mengikuti tanggal pertama", () => {
    expect(tanggal(susun("2027-01-31", 1, "Bulan", 4, 100))).toEqual([
      "2027-01-31",
      "2027-02-28",
      "2027-03-31",
      "2027-04-30",
    ]);
    expect(tanggal(susun("2028-01-31", 1, "Bulan", 2, 100))).toEqual([
      "2028-01-31",
      "2028-02-29",
    ]);
    expect(tanggal(susun("2028-02-29", 1, "Tahun", 2, 100))).toEqual([
      "2028-02-29",
      "2029-02-28",
    ]);
    expect(tanggal(susun("2026-12-28", 2, "Minggu", 2, 100))).toEqual([
      "2026-12-28",
      "2027-01-11",
    ]);
    expect(tanggal(susun("2026-12-31", 1, "Hari", 2, 100))).toEqual([
      "2026-12-31",
      "2027-01-01",
    ]);
  });

  test("jadwal menolak isian cacat", () => {
    expect(susunJadwal("2026-11-28", 1, "Bulan", 361, 100)).toEqual({
      ok: false,
      error: "Tenor harus 1–360 kali.",
    });
    expect(susunJadwal("2026-11-28", 0, "Bulan", 1, 100)).toEqual({
      ok: false,
      error: "Jarak angsuran harus 1–365.",
    });
    expect(susunJadwal("2026-11-28", 1, "Dekade", 1, 100)).toEqual({
      ok: false,
      error: "Satuan jarak angsuran tidak dikenal.",
    });
    expect(susunJadwal("2026-11-28", 1, "Bulan", 1, 0)).toEqual({
      ok: false,
      error: "Nominal per angsuran harus lebih dari 0.",
    });
    expect(susunJadwal("9999-01-01", 365, "Tahun", 2, 100)).toEqual({
      ok: false,
      error: "Jadwal terlalu panjang.",
    });
  });

  test("syarat contoh PRD", () => {
    const hasil = validasiSyarat(
      draftBerkala(2_000_000, 10, 1_150_000),
      12_000_000,
      "2026-10-28",
      "2026-10-28",
    );
    if (!hasil.ok) throw new Error(hasil.error);
    const syarat = hasil.value;
    expect(syarat.kreditur).toBe("Toko Maju");
    expect(syarat.jadwal).toHaveLength(11);
    expect(syarat.jadwal[0]).toEqual({
      ke: 0,
      jatuh_tempo: "2026-10-28",
      nominal: 2_000_000,
    });
    expect(syarat.jadwal[10]?.jatuh_tempo).toBe("2027-08-28");
    const b = besaranCicilan(12_000_000, syarat.jadwal);
    expect(b.total_bayar).toBe(13_500_000);
    expect(b.bunga).toBe(1_500_000);
    expect(sidikSyarat(syarat)).not.toBe(
      sidikSyarat({ ...syarat, nomor_kontrak: "K-02" }),
    );
  });

  test("syarat menolak bunga negatif, tanggal mundur, dan DP", () => {
    const cek = (draft: unknown, harga = 12_000_000) =>
      validasiSyarat(
        syaratDraftSchema.parse(draft),
        harga,
        "2026-10-28",
        "2026-10-28",
      );
    expect(cek(draftBerkala(2_000_000, 10, 900_000))).toEqual({
      ok: false,
      error:
        "Total angsuran kurang dari harga tunai dikurangi uang muka (bunga tidak boleh negatif).",
    });
    expect(cek(draftBerkala(12_000_000, 10, 1_150_000))).toEqual({
      ok: false,
      error: "Uang muka harus 0 atau lebih dan lebih kecil dari harga tunai.",
    });
    expect(cek(draftBerkala(0, 361, 1_150_000))).toEqual({
      ok: false,
      error: "Tenor harus 1–360 kali.",
    });
    expect(
      cek({
        kreditur: "Toko",
        pola: "Manual",
        jadwal: [
          { jatuh_tempo: "2026-12-01", nominal: 6_000_000 },
          { jatuh_tempo: "2026-12-01", nominal: 6_000_000 },
        ],
      }),
    ).toEqual({
      ok: false,
      error: "Angsuran 2: jatuh tempo harus setelah angsuran sebelumnya.",
    });
    expect(
      cek({
        kreditur: "Toko",
        pola: "Manual",
        jadwal: [{ jatuh_tempo: "2026-10-27", nominal: 12_000_000 }],
      }),
    ).toEqual({
      ok: false,
      error:
        "Jatuh tempo angsuran pertama tidak boleh sebelum tanggal pengajuan.",
    });
    expect(cek({ pola: "Manual" }, 1)).toEqual({
      ok: false,
      error: "Kreditur wajib diisi.",
    });
  });

  test("sidik syarat vektor", () => {
    const syarat: Syarat = {
      kreditur: "Toko Maju",
      nomor_kontrak: null,
      uang_muka: 100,
      pola: "Manual",
      setiap: null,
      satuan: null,
      jadwal: [
        { ke: 1, jatuh_tempo: "2026-12-01", nominal: 50 },
        { ke: 0, jatuh_tempo: "2026-11-01", nominal: 100 },
      ],
    };
    const kanonik =
      "Toko Maju\u001f\u001f100\u001fManual\u001f\u001f\u001e0\u001f2026-11-01\u001f100\u001e1\u001f2026-12-01\u001f50";
    expect(sidikSyarat(syarat)).toBe(
      createHash("sha256").update(kanonik, "utf8").digest("hex"),
    );
  });

  const contoh: Besaran = {
    harga_tunai: 12_000_000,
    uang_muka: 2_000_000,
    total_angsuran: 11_500_000,
    total_bayar: 13_500_000,
    bunga: 1_500_000,
  };

  test("pokok dan bunga contoh PRD", () => {
    expect(bagiPokokBunga(contoh, 0, 2_000_000)).toEqual([2_000_000, 0]);
    expect(bagiPokokBunga(contoh, 2_000_000, 3_150_000)).toEqual([
      1_000_000, 150_000,
    ]);
    expect(bagiPokokBunga(contoh, 8_900_000, 13_500_000)).toEqual([
      4_000_000, 600_000,
    ]);
    expect(bungaKumulatif(contoh, 13_500_000)).toBe(1_500_000);
    expect(bagiPokokBunga(contoh, 13_500_000, 14_000_000)).toEqual([
      500_000, 0,
    ]);
    const ganjil: Besaran = {
      harga_tunai: 100,
      uang_muka: 0,
      total_angsuran: 300,
      total_bayar: 300,
      bunga: 200,
    };
    expect(
      [
        [0, 100],
        [100, 200],
        [200, 300],
      ].map(([c0, c1]) => bagiPokokBunga(ganjil, c0 ?? 0, c1 ?? 0)[1]),
    ).toEqual([67, 66, 67]);
  });

  test("jurnal cicilan seimbang", () => {
    const akun = { utang: "U", bunga: "B", denda: "D", bayar: "K" };
    expect(
      susunJurnalCicilan("Bayar", 4_200_000, 400_000, 8_900_000, contoh, akun),
    ).toEqual([
      ["U", 4_000_000, 0],
      ["B", 200_000, 0],
      ["K", 0, 4_200_000],
    ]);
    expect(
      susunJurnalCicilan("Bayar", 1_000_000, 200_000, 2_000_000, contoh, akun),
    ).toEqual([
      ["U", 1_043_478, 0],
      ["K", 0, 1_000_000],
      [AKUN_PENDAPATAN_LAIN, 0, 43_478],
    ]);
    expect(susunJurnalCicilan("Denda", 50_000, 0, 0, contoh, akun)).toEqual([
      ["D", 50_000, 0],
      ["K", 0, 50_000],
    ]);
    for (const baris of [
      susunJurnalCicilan("Bayar", 1_150_000, 0, 2_000_000, contoh, akun),
      susunJurnalCicilan("Bayar", 0, 300_000, 3_150_000, contoh, akun),
    ]) {
      const debit = baris.reduce((t, [, d]) => t + d, 0);
      const kredit = baris.reduce((t, [, , k]) => t + k, 0);
      expect(debit).toBe(kredit);
    }
  });

  test("alokasi dan status", () => {
    const jadwal = [
      { ke: 0, jatuh_tempo: "2026-10-28", nominal: 2_000_000 },
      { ke: 1, jatuh_tempo: "2026-11-28", nominal: 1_150_000 },
      { ke: 2, jatuh_tempo: "2026-12-28", nominal: 1_150_000 },
    ];
    const alokasi = alokasiJadwal(jadwal, 2_500_000, "2026-12-01");
    expect(alokasi.map((a) => a.status)).toEqual([
      "Lunas",
      "Terlambat",
      "Belum",
    ]);
    expect(alokasi[1]?.terbayar).toBe(500_000);
    expect(alokasiJadwal(jadwal, 2_500_000, "2026-11-28")[1]?.status).toBe(
      "Sebagian",
    );

    const dasar = {
      pengajuan_batal: false,
      pengajuan_menunggu: false,
      pengajuan_ditutup: false,
      diterima_penuh: true,
      diaktifkan: true,
      ditutup: false,
      perlu_acc_ulang: false,
      tertutup: 0,
      total_bayar: 100,
      ada_terlambat: false,
    };
    expect(statusCicilan(dasar)).toBe("Berjalan");
    expect(statusCicilan({ ...dasar, ada_terlambat: true })).toBe("Menunggak");
    expect(
      statusCicilan({ ...dasar, tertutup: 100, ada_terlambat: true }),
    ).toBe("Lunas");
    expect(statusCicilan({ ...dasar, perlu_acc_ulang: true })).toBe(
      "Menunggu ACC ulang",
    );
    expect(statusCicilan({ ...dasar, diterima_penuh: false })).toBe(
      "Menunggu barang",
    );
    expect(
      statusCicilan({
        ...dasar,
        diterima_penuh: false,
        pengajuan_ditutup: true,
      }),
    ).toBe("Dibatalkan");
    expect(
      statusCicilan({ ...dasar, pengajuan_menunggu: true, diaktifkan: false }),
    ).toBe("Draf");
    expect(statusCicilan({ ...dasar, ditutup: true })).toBe("Ditutup");
    expect(statusCicilan({ ...dasar, pengajuan_batal: true })).toBe(
      "Dibatalkan",
    );

    expect(perluAccUlang(110, 100, "a", null)).toBe(true);
    expect(perluAccUlang(110, 100, "a", "a")).toBe(false);
    expect(perluAccUlang(110, 100, "b", "a")).toBe(true);
    expect(perluAccUlang(100, 100, "a", null)).toBe(false);
  });

  test("terima penuh dan bayar", () => {
    const acc: [string, number, number][] = [
      ["pgj-a-1", 1, 2],
      ["pgj-a-2", 2, 0],
    ];
    expect(wajibTerimaPenuh(acc, [["pgj-a-1", 2]]).ok).toBe(true);
    expect(wajibTerimaPenuh(acc, [["pgj-a-1", 1]])).toEqual({
      ok: false,
      error:
        "Baris 1: pengajuan cicilan wajib diterima penuh sesuai ACC dalam satu penerimaan.",
    });

    const bayar = (
      jenis: string,
      nominal: number,
      potongan: number,
      alasan: string | null,
      tgl = "2026-11-30",
    ) =>
      validasiBayar(
        bayarDraftSchema.parse({
          jenis,
          tanggal: tgl,
          nominal,
          potongan,
          alasan_potongan: alasan,
          keterangan: " telat 5 hari ",
        }),
        "2026-10-28",
        "2026-12-01",
        1_000_000,
      );
    expect(bayar("Bayar", 900_000, 100_000, null)).toEqual({
      ok: false,
      error: "Alasan potongan wajib diisi.",
    });
    expect(bayar("Bayar", 900_000, 100_001, "x")).toEqual({
      ok: false,
      error: "Nominal ditambah potongan melebihi sisa jadwal (Rp1.000.000).",
    });
    expect(bayar("Bayar", 0, 0, null)).toEqual({
      ok: false,
      error: "Isi nominal dibayar atau potongan.",
    });
    const sah = bayar("Bayar", 900_000, 100_000, "pelunasan dipercepat");
    expect(sah.ok && sah.value.alasan_potongan).toBe("pelunasan dipercepat");
    expect(sah.ok && sah.value.keterangan).toBeNull();
    const denda = bayar("Denda", 50_000, 0, null);
    expect(denda.ok && denda.value.keterangan).toBe("telat 5 hari");
    expect(bayar("Denda", 0, 0, null)).toEqual({
      ok: false,
      error: "Nominal denda harus lebih dari 0.",
    });
    expect(bayar("Bayar", 1, 0, null, "2026-10-27")).toEqual({
      ok: false,
      error: "Tanggal bayar tidak boleh sebelum tanggal pengajuan.",
    });
    expect(bayar("Bayar", 1, 0, null, "2026-12-02")).toEqual({
      ok: false,
      error: "Tanggal bayar tidak boleh setelah hari ini.",
    });
  });

  test("id turunan dan keterangan jurnal", () => {
    expect(idCicilan("pgj-a")).toBe("cil-pgj-a");
    expect(
      keteranganJurnalCicilan("Bayar", "Toko", "PGJ/2026/WEB/0001", null),
    ).toBe("Bayar cicilan Toko (PGJ/2026/WEB/0001)");
    expect(keteranganJurnalCicilan("Denda", "Toko", "PGJ", "telat")).toBe(
      "Denda cicilan Toko: telat",
    );
  });
});

// Satu klien per berkas: libsql Bun di Windows bisa crash bila berkas tes
// membuat klien baru setelah menutup klien lain.
let client: Client;
let testDirectory: string;

beforeAll(async () => {
  testDirectory = mkdtempSync(join(tmpdir(), "kos-cicilan-"));
  client = createClient({ url: `file:${join(testDirectory, "test.db")}` });
  await initDatabaseSchema(client);
});

beforeEach(async () => {
  await client.batch(
    [
      "DELETE FROM keu_cicilan_bayar_batal;",
      "DELETE FROM keu_cicilan_bayar;",
      "DELETE FROM keu_cicilan_jadwal;",
      "DELETE FROM keu_cicilan;",
      "DELETE FROM keu_jurnal_baris;",
      "DELETE FROM keu_jurnal;",
      "DELETE FROM inventory_penerimaan_foto;",
      "DELETE FROM inventory_penerimaan;",
      "DELETE FROM inventory_pengajuan_baris;",
      "DELETE FROM inventory_pengajuan;",
      "DELETE FROM inventory_mutasi;",
      "DELETE FROM inventory_barang;",
    ],
    "write",
  );
});

afterAll(async () => {
  client.close();
  await Bun.sleep(50);
  try {
    rmSync(testDirectory, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 50,
    });
  } catch {
    // Berkas sementara boleh tertinggal bila Windows masih menguncinya.
  }
});

describe("alur kontrak cicilan (Web)", () => {
  // Skenario yang sama dengan `alur_kontrak_cicilan` di `cicilan.rs`.
  test("ajukan, ACC, terima, jurnal, bayar, batal", async () => {
    const hari = String(
      (await client.execute("SELECT date('now', '+7 hours') AS h;")).rows[0]?.h,
    );
    const syarat = {
      kreditur: "Toko Maju",
      uang_muka: 2_000_000,
      pola: "Berkala",
      jatuh_tempo_pertama: hari,
      setiap: 1,
      satuan: "Bulan",
      tenor: 10,
      nominal: 1_150_000,
    };
    const { id_pengajuan: id } = await savePengajuan(client, "pengaju", {
      tanggal: hari,
      keperluan: "Laptop staf",
      cara_bayar: "Cicilan",
      cicilan: syarat,
      baris: [
        {
          nama_barang: "Laptop",
          satuan: "unit",
          jumlah: 1,
          harga_satuan: 12_000_000,
        },
      ],
    });
    const p = (await listPengajuan(client, hari, hari)).pengajuan[0];
    expect(p?.cara_bayar).toBe("Cicilan");
    expect(p?.cicilan?.jadwal).toHaveLength(11);
    expect((await listCicilan(client)).kontrak[0]?.status).toBe("Draf");

    const keputusan = (sidikSyarat: string | null) => ({
      id_pengajuan: id,
      keputusan: "ACC",
      sidik_baris: p?.sidik_baris,
      sidik_syarat: sidikSyarat,
    });
    await expect(
      decidePengajuan(client, "bendahara", false, keputusan(null)),
    ).rejects.toThrow("Syarat cicilan berubah");
    await decidePengajuan(
      client,
      "bendahara",
      false,
      keputusan(p?.cicilan?.sidik_syarat ?? null),
    );
    let k = (await listCicilan(client)).kontrak[0];
    expect(k?.status).toBe("Menunggu barang");
    expect(k?.total_disetujui).toBe(13_500_000);

    await receivePengajuan(client, "pengaju", {
      id_pengajuan: id,
      tanggal: hari,
      cicilan: syarat,
      foto: [{ mime_type: "image/jpeg", data_base64: "QUJD" }],
      baris: [
        {
          id_baris: `${id}-1`,
          jumlah: 1,
          harga_satuan: 12_000_000,
          tempat: "Ruang Staf",
          tipe: "Aset",
          kategori: "Elektronik",
        },
      ],
    });
    k = (await listCicilan(client)).kontrak[0];
    expect(k?.status).toBe("Berjalan");
    expect(k?.bunga).toBe(1_500_000);
    expect(k?.penerimaan_dijurnal).toBe(false);

    const idC = idCicilan(id);
    const bayar = (nominal: number) => ({
      id_cicilan: idC,
      jenis: "Bayar",
      tanggal: hari,
      nominal,
      id_akun_bayar: "akun-kas",
    });
    await expect(
      catatBayarCicilan(client, "bendahara", bayar(2_000_000)),
    ).rejects.toThrow("Jurnal penerimaan");

    const mutasi = await client.execute(
      "SELECT id_mutasi FROM inventory_mutasi WHERE alasan = 'Pengadaan';",
    );
    const idMutasi = String(mutasi.rows[0]?.id_mutasi);
    await journalPost(client, "bendahara", {
      id_mutasi: [idMutasi],
      akun_debit_aset: "akun-peralatan",
      akun_debit_habis_pakai: "akun-beban-atk",
      akun_kredit_bayar: "akun-kas",
    });
    const kredit = await client.execute({
      sql: "SELECT id_akun FROM keu_jurnal_baris WHERE id_jurnal = ? AND kredit > 0;",
      args: [`jrn-inv-${idMutasi}`],
    });
    expect(String(kredit.rows[0]?.id_akun)).toBe(AKUN_UTANG_CICILAN);

    const dp = await catatBayarCicilan(client, "bendahara", bayar(2_000_000));
    const angsuran = await catatBayarCicilan(
      client,
      "bendahara",
      bayar(1_150_000),
    );
    const bunga = await client.execute({
      sql: "SELECT debit FROM keu_jurnal_baris WHERE id_jurnal = ? AND id_akun = ?;",
      args: [idJurnalCicilan(angsuran.id_bayar), AKUN_BEBAN_BUNGA],
    });
    expect(Number(bunga.rows[0]?.debit)).toBe(150_000);
    await expect(
      catatBayarCicilan(client, "bendahara", bayar(11_000_000)),
    ).rejects.toThrow("melebihi sisa jadwal");
    await expect(
      cancelMutation(client, "pengaju", idMutasi, "Salah harga"),
    ).rejects.toThrow("sudah punya pembayaran");

    await expect(
      batalBayarCicilan(client, "bendahara", dp.id_bayar, "Salah"),
    ).rejects.toThrow("Hanya pembayaran terakhir");
    await batalBayarCicilan(
      client,
      "bendahara",
      angsuran.id_bayar,
      "Salah nominal",
    );
    k = (await listCicilan(client)).kontrak[0];
    expect(k?.tertutup).toBe(2_000_000);
    expect(k?.bayar[1]?.batal?.alasan).toBe("Salah nominal");
  });
});
