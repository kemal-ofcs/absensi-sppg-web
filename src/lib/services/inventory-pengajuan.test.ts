import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Client, createClient } from "@libsql/client";
import { initDatabaseSchema } from "@/lib/db-schema";
import {
  type BarisValid,
  formatNomorPengajuan,
  idBarangBaru,
  idBarisPengajuan,
  idPengajuanDariBaris,
  keputusanDraftSchema,
  nilaiBaris,
  penerimaanDraftSchema,
  pengajuanDraftSchema,
  statusPengajuan,
  validateFotoPenerimaan,
  validateKeputusan,
  validatePemutus,
  validatePenerimaan,
  validatePengajuan,
} from "@/lib/validations/inventory-pengajuan";

mock.module("server-only", () => ({}));
const {
  cancelPengajuan,
  closePengajuan,
  decidePengajuan,
  fotoPenerimaan,
  listPengajuan,
  receivePengajuan,
  savePengajuan,
  sidikBaris,
} = await import("./inventory-pengajuan");
const { journalPending, saveItem } = await import("./inventory");

// Vektor yang sama dengan `mod tests` di `inventory_pengajuan.rs`.

function baris(
  id_barang: string | null,
  nama_barang: string,
  satuan: string,
  desimal: boolean,
  jumlah: number,
  harga_satuan: number,
): BarisValid {
  return { id_barang, nama_barang, satuan, desimal, jumlah, harga_satuan };
}

describe("aturan murni pengajuan", () => {
  test("nomor, id, dan nilai", () => {
    expect(formatNomorPengajuan("2026", "WAB12", 7)).toBe(
      "PGJ/2026/WAB12/0007",
    );
    expect(formatNomorPengajuan("2026", "WEB", 12345)).toBe(
      "PGJ/2026/WEB/12345",
    );
    expect(idBarisPengajuan("pgj-ab", 3)).toBe("pgj-ab-3");
    expect(idPengajuanDariBaris("pgj-ab-3")).toBe("pgj-ab");
    expect(idPengajuanDariBaris("pgj-ab-x")).toBeNull();
    expect(idPengajuanDariBaris("tanpa")).toBeNull();
    expect(nilaiBaris(3, 55_000, false)).toBe(165_000);
    expect(nilaiBaris(250, 12_000, true)).toBe(30_000);
    expect(nilaiBaris(125, 999, true)).toBe(1_249);
  });

  test("sidik", () => {
    const isi = [
      baris("brg-1", "Spidol", "pcs", false, 10, 8_500),
      baris(null, "Kertas HVS", "rim", false, 5, 55_000),
    ];
    expect(sidikBaris(isi)).toBe(
      "92c7711b15b5bfc3dba4f63580b615ee35b6da937bf9d2b7e7fb585e19597620",
    );
    const ubah = isi.map((b) => ({ ...b }));
    (ubah[1] as BarisValid).harga_satuan = 60_000;
    expect(sidikBaris(ubah)).not.toBe(sidikBaris(isi));
  });

  test("status", () => {
    const k = (
      dibatalkan: boolean,
      ditolak: boolean,
      disetujui: boolean,
      ditutup: boolean,
      isi: [number, number][],
    ) =>
      statusPengajuan({
        dibatalkan,
        ditolak,
        disetujui,
        ditutup,
        baris: isi.map(([jumlah, diterima]) => ({ jumlah, diterima })),
      });
    expect(k(true, false, false, false, [[5, 0]])).toBe("Dibatalkan");
    expect(k(false, true, false, false, [[5, 0]])).toBe("Ditolak");
    expect(k(false, false, false, false, [[5, 0]])).toBe("Menunggu");
    expect(
      k(false, false, true, false, [
        [5, 0],
        [2, 0],
      ]),
    ).toBe("Disetujui");
    expect(
      k(false, false, true, false, [
        [5, 5],
        [2, 0],
      ]),
    ).toBe("Diterima sebagian");
    expect(
      k(false, false, true, false, [
        [5, 5],
        [2, 3],
      ]),
    ).toBe("Selesai");
    expect(k(false, false, true, true, [[5, 0]])).toBe("Selesai");
  });

  test("validasi", () => {
    const hari = "2026-10-28";
    const galat = (value: unknown) => {
      const hasil = validatePengajuan(pengajuanDraftSchema.parse(value), hari);
      return hasil.ok ? null : hasil.error;
    };
    const satu = [
      { nama_barang: "Kertas", satuan: "rim", jumlah: 5, harga_satuan: 55000 },
    ];
    expect(
      galat({ tanggal: "2026-10-29", keperluan: "ATK", baris: satu }),
    ).toBe("Tanggal pengajuan tidak boleh setelah hari ini.");
    expect(
      galat({ tanggal: "2026-02-30", keperluan: "ATK", baris: satu }),
    ).toBe("Tanggal pengajuan tidak valid.");
    expect(galat({ tanggal: hari, keperluan: "  ", baris: satu })).toBe(
      "Keperluan wajib diisi.",
    );
    expect(galat({ tanggal: hari, keperluan: "ATK", baris: [] })).toBe(
      "Isi minimal satu barang.",
    );
    expect(
      galat({
        tanggal: hari,
        keperluan: "ATK",
        baris: [
          { id_barang: "brg-1", jumlah: 1, harga_satuan: 0 },
          { id_barang: "brg-1", jumlah: 2, harga_satuan: 0 },
        ],
      }),
    ).toBe("Baris 2: barang ini sudah ada di baris 1.");
    expect(
      galat({
        tanggal: hari,
        keperluan: "ATK",
        baris: [{ satuan: "rim", jumlah: 1, harga_satuan: 0 }],
      }),
    ).toBe("Baris 1: nama barang wajib diisi.");
    expect(
      galat({
        tanggal: hari,
        keperluan: "ATK",
        baris: [{ nama_barang: "Kertas", jumlah: 1, harga_satuan: 0 }],
      }),
    ).toBe("Baris 1: satuan wajib diisi.");
    expect(
      galat({
        tanggal: hari,
        keperluan: "ATK",
        baris: [
          { nama_barang: "Kertas", satuan: "rim", jumlah: 0, harga_satuan: 0 },
        ],
      }),
    ).toBe("Baris 1: jumlah harus lebih dari 0.");
    expect(
      galat({
        tanggal: hari,
        keperluan: "ATK",
        baris: [
          {
            nama_barang: "Kertas",
            satuan: "rim",
            jumlah: 1,
            harga_satuan: -1,
          },
        ],
      }),
    ).toBe("Baris 1: harga satuan tidak valid.");
    expect(
      galat({
        tanggal: hari,
        keperluan: "ATK",
        baris: [
          {
            nama_barang: "Kertas",
            satuan: "rim",
            jumlah: 1_000_000_000,
            harga_satuan: 1_000_000_000_000,
          },
        ],
      }),
    ).toBe("Baris 1: nilai (jumlah × harga satuan) terlalu besar.");

    const valid = validatePengajuan(
      pengajuanDraftSchema.parse({
        tanggal: hari,
        keperluan: " ATK ",
        sumber_dana: " ",
        baris: [
          {
            id_barang: "brg-1",
            nama_barang: "diabaikan",
            jumlah: 10,
            harga_satuan: 8500,
          },
          {
            nama_barang: " Kertas HVS ",
            satuan: "rim",
            desimal: false,
            jumlah: 5,
            harga_satuan: 55000,
          },
        ],
      }),
      hari,
    );
    if (!valid.ok) throw new Error(valid.error);
    expect(valid.value.keperluan).toBe("ATK");
    expect(valid.value.sumber_dana).toBeNull();
    expect(valid.value.baris[0]).toEqual(
      baris("brg-1", "", "", false, 10, 8_500),
    );
    expect(valid.value.baris[1]).toEqual(
      baris(null, "Kertas HVS", "rim", false, 5, 55_000),
    );
  });

  test("pemutus", () => {
    const pesan = {
      ok: false as const,
      error:
        "Pengajuan ini kamu ajukan sendiri. Minta pemegang Keuangan lain untuk memutuskannya.",
    };
    expect(validatePemutus("sarpras", "sarpras", false)).toEqual(pesan);
    expect(validatePemutus("Sarpras", " sarpras ", false)).toEqual(pesan);
    expect(validatePemutus("sarpras", "sarpras", true).ok).toBe(true);
    expect(validatePemutus("sarpras", "bendahara", false).ok).toBe(true);
  });

  test("keputusan", () => {
    const k = (value: unknown) =>
      validateKeputusan(keputusanDraftSchema.parse(value));
    const sidik = "a".repeat(64);
    expect(
      k({
        id_pengajuan: "p",
        keputusan: "ACC",
        sidik_baris: sidik.toUpperCase(),
      }),
    ).toEqual({ ok: true, value: { keputusan: "ACC", sidik, catatan: null } });
    expect(
      k({ id_pengajuan: "p", keputusan: "ACC", sidik_baris: "abc" }),
    ).toEqual({
      ok: false,
      error: "Pengajuan tidak valid. Muat ulang daftarnya.",
    });
    expect(k({ id_pengajuan: "p", keputusan: "Tolak", catatan: " " })).toEqual({
      ok: false,
      error: "Alasan penolakan wajib diisi.",
    });
    expect(
      k({
        id_pengajuan: "p",
        keputusan: "Tolak",
        catatan: " Harga terlalu mahal ",
      }),
    ).toEqual({
      ok: true,
      value: { keputusan: "Tolak", alasan: "Harga terlalu mahal" },
    });
    expect(k({ id_pengajuan: "p", keputusan: "Setuju" })).toEqual({
      ok: false,
      error: "Keputusan tidak dikenal.",
    });
  });
});

// Satu klien per berkas: libsql Bun di Windows bisa crash bila berkas tes
// membuat klien baru setelah menutup klien lain.
let client: Client;
let testDirectory: string;

beforeAll(async () => {
  testDirectory = mkdtempSync(join(tmpdir(), "kos-inventory-pengajuan-"));
  client = createClient({ url: `file:${join(testDirectory, "test.db")}` });
  await initDatabaseSchema(client);
});

beforeEach(async () => {
  await client.batch(
    [
      "DELETE FROM inventory_penerimaan_foto;",
      "DELETE FROM inventory_penerimaan;",
      "DELETE FROM inventory_unit;",
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
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      error.code !== "EBUSY"
    ) {
      throw error;
    }
  }
});

async function hariIni(): Promise<string> {
  const hasil = await client.execute("SELECT date('now', '+7 hours') AS hari;");
  return String(hasil.rows[0]?.hari);
}

async function satuPengajuan(hari: string) {
  const daftar = await listPengajuan(client, hari, hari);
  const pengajuan = daftar.pengajuan[0];
  if (!pengajuan) throw new Error("pengajuan tidak ada");
  return pengajuan;
}

/** Masuk Pengadaan ber-`id_ref` = id baris, seperti yang ditulis penerimaan. */
async function terima(
  idMutasi: string,
  idBarang: string,
  idBaris: string,
  jumlah: number,
) {
  await client.execute({
    sql: `INSERT INTO inventory_mutasi (id_mutasi, id_barang, jenis, alasan, tanggal, jumlah,
            tempat_tujuan, kondisi_tujuan, id_ref, harga_satuan, dicatat_oleh)
          VALUES (?, ?, 'Masuk', 'Pengadaan', '2026-10-28', ?, 'Gudang', 'Baik', ?, 8500, 'sarpras');`,
    args: [idMutasi, idBarang, jumlah, idBaris],
  });
}

describe("alur pengajuan di database", () => {
  // Skenario yang sama dengan `alur_ajukan_ubah_acc_tutup` di Rust.
  test("ajukan, ubah, ACC dengan sidik basi ditolak, ACC, tutup", async () => {
    const hari = await hariIni();
    const { id_barang } = await saveItem(client, {
      nama_barang: "Spidol",
      tipe: "Habis Pakai",
      satuan: "pcs",
      tempat_utama: "Gudang",
    });
    const { id_pengajuan: id } = await savePengajuan(client, "sarpras", {
      tanggal: hari,
      keperluan: "ATK semester ganjil",
      baris: [
        {
          id_barang,
          nama_barang: "Spidol palsu",
          jumlah: 10,
          harga_satuan: 8500,
        },
        {
          nama_barang: "Kertas HVS",
          satuan: "rim",
          jumlah: 5,
          harga_satuan: 55000,
        },
        { nama_barang: "Map", satuan: "pcs", jumlah: 20, harga_satuan: 2000 },
      ],
    });
    let p = await satuPengajuan(hari);
    expect(p.status).toBe("Menunggu");
    expect(p.total).toBe(85_000 + 275_000 + 40_000);
    expect(p.nomor).toBe(`PGJ/${hari.slice(0, 4)}/WEB/0001`);
    expect(p.baris[0]?.nama_barang).toBe("Spidol");
    expect(p.baris[2]?.id_baris).toBe(`${id}-3`);
    const sidikLama = p.sidik_baris;

    await savePengajuan(client, "sarpras", {
      id_pengajuan: id,
      tanggal: hari,
      keperluan: "ATK",
      baris: [
        {
          nama_barang: "Kertas HVS",
          satuan: "rim",
          jumlah: 5,
          harga_satuan: 60000,
        },
      ],
    });
    p = await satuPengajuan(hari);
    expect(p.baris).toHaveLength(1);

    await expect(
      decidePengajuan(client, "bendahara", false, {
        id_pengajuan: id,
        keputusan: "ACC",
        sidik_baris: sidikLama,
      }),
    ).rejects.toThrow("berubah sejak");
    expect((await satuPengajuan(hari)).status).toBe("Menunggu");

    await expect(
      decidePengajuan(client, "sarpras", false, {
        id_pengajuan: id,
        keputusan: "ACC",
        sidik_baris: p.sidik_baris,
      }),
    ).rejects.toThrow("kamu ajukan sendiri");
    await decidePengajuan(client, "bendahara", false, {
      id_pengajuan: id,
      keputusan: "ACC",
      sidik_baris: p.sidik_baris,
    });
    await expect(
      savePengajuan(client, "sarpras", {
        id_pengajuan: id,
        tanggal: hari,
        keperluan: "ATK",
        baris: [
          { nama_barang: "Kertas", satuan: "rim", jumlah: 1, harga_satuan: 1 },
        ],
      }),
    ).rejects.toThrow("berstatus Disetujui");
    await expect(
      cancelPengajuan(client, "sarpras", id, "Salah"),
    ).rejects.toThrow("berstatus Disetujui");

    await closePengajuan(client, "sarpras", id, "Toko tutup");
    p = await satuPengajuan(hari);
    expect(p.status).toBe("Selesai");
    expect(p.alasan_tutup).toBe("Toko tutup");
  });

  test("status mengikuti Masuk Pengadaan ber-id_ref dan pembatalannya", async () => {
    const hari = await hariIni();
    const { id_barang } = await saveItem(client, {
      nama_barang: "Spidol",
      tipe: "Habis Pakai",
      satuan: "pcs",
      tempat_utama: "Gudang",
    });
    const { id_pengajuan: id } = await savePengajuan(client, "sarpras", {
      tanggal: hari,
      keperluan: "ATK",
      baris: [{ id_barang, jumlah: 10, harga_satuan: 8500 }],
    });
    const awal = await satuPengajuan(hari);
    await decidePengajuan(client, "bendahara", false, {
      id_pengajuan: id,
      keputusan: "ACC",
      sidik_baris: awal.sidik_baris,
    });
    const idBaris = idBarisPengajuan(id, 1);

    await terima("mts-a", id_barang, idBaris, 4);
    let p = await satuPengajuan(hari);
    expect(p.status).toBe("Diterima sebagian");
    expect(p.baris[0]?.diterima).toBe(4);

    await terima("mts-b", id_barang, idBaris, 6);
    expect((await satuPengajuan(hari)).status).toBe("Selesai");

    // Pembatalan mutasi mengembalikan baris ke belum penuh.
    await client.execute({
      sql: `INSERT INTO inventory_mutasi (id_mutasi, id_barang, jenis, alasan, tanggal, jumlah,
              tempat_asal, kondisi_asal, dicatat_oleh)
            VALUES ('batal-mts-b', ?, 'Keluar', 'Pembatalan', '2026-10-28', 6, 'Gudang', 'Baik', 'sarpras');`,
      args: [id_barang],
    });
    p = await satuPengajuan(hari);
    expect(p.status).toBe("Diterima sebagian");
    expect(p.baris[0]?.diterima).toBe(4);
  });

  test("pengajuan yang ditolak tidak bisa di-ACC, dan selesai di luar rentang tidak tampil", async () => {
    const hari = await hariIni();
    const { id_pengajuan: id } = await savePengajuan(client, "sarpras", {
      tanggal: hari,
      keperluan: "ATK",
      baris: [
        { nama_barang: "Map", satuan: "pcs", jumlah: 2, harga_satuan: 2000 },
      ],
    });
    await expect(
      decidePengajuan(client, "bendahara", false, {
        id_pengajuan: id,
        keputusan: "Tolak",
        catatan: "",
      }),
    ).rejects.toThrow("Alasan penolakan wajib diisi.");
    await decidePengajuan(client, "bendahara", false, {
      id_pengajuan: id,
      keputusan: "Tolak",
      catatan: "Stok masih ada",
    });
    const p = await satuPengajuan(hari);
    expect(p.status).toBe("Ditolak");
    expect(p.alasan_tolak).toBe("Stok masih ada");
    await expect(
      decidePengajuan(client, "bendahara", false, {
        id_pengajuan: id,
        keputusan: "ACC",
        sidik_baris: p.sidik_baris,
      }),
    ).rejects.toThrow("bukan Menunggu");
    const lalu = await listPengajuan(client, "2000-01-01", "2000-01-31");
    expect(lalu.pengajuan).toHaveLength(0);
  });
});

// Langkah 2: vektor yang sama dengan `validasi_foto_vektor` dan
// `validasi_penerimaan_vektor` di Rust.
describe("aturan penerimaan", () => {
  const foto = (mime_type: string, data_base64: string) => ({
    mime_type,
    data_base64,
  });

  test("foto", () => {
    expect(validateFotoPenerimaan([])).toEqual({
      ok: false,
      error: "Lampirkan minimal satu foto barang yang diterima.",
    });
    expect(
      validateFotoPenerimaan(
        Array.from({ length: 6 }, () => foto("image/jpeg", "QUJD")),
      ),
    ).toEqual({ ok: false, error: "Paling banyak 5 foto." });
    expect(
      validateFotoPenerimaan([
        foto("image/jpeg", "QUJD"),
        foto("image/gif", "QUJD"),
      ]),
    ).toEqual({
      ok: false,
      error: "Foto 2: format harus JPEG, PNG, atau WebP.",
    });
    expect(
      validateFotoPenerimaan([foto("image/jpeg", "A".repeat(600_004))]),
    ).toEqual({
      ok: false,
      error: "Foto 1 terlalu besar. Kompres ulang atau pilih foto lain.",
    });
    for (const rusak of ["", "QUJ", "QU=D", "QUJD===", "QU*D"]) {
      expect(validateFotoPenerimaan([foto("image/png", rusak)])).toEqual({
        ok: false,
        error: "Foto 1 tidak terbaca.",
      });
    }
    expect(
      validateFotoPenerimaan([
        foto("image/webp", "QUI="),
        foto("image/png", "QQ=="),
      ]).ok,
    ).toBe(true);
  });

  test("penerimaan", () => {
    const acc = [
      { id_baris: "p-1", urutan: 1, jumlah: 10, diterima: 4 },
      { id_baris: "p-2", urutan: 2, jumlah: 5, diterima: 0 },
    ];
    const f = [{ mime_type: "image/jpeg", data_base64: "QUJD" }];
    const cek = (value: unknown) =>
      validatePenerimaan(
        penerimaanDraftSchema.parse(value),
        "2026-10-20",
        "2026-10-28",
        acc,
      );
    expect(
      cek({
        tanggal: "2026-10-19",
        baris: [{ id_baris: "p-1", jumlah: 1 }],
        foto: f,
      }),
    ).toEqual({
      ok: false,
      error: "Tanggal terima tidak boleh sebelum tanggal ACC.",
    });
    expect(
      cek({
        tanggal: "2026-10-29",
        baris: [{ id_baris: "p-1", jumlah: 1 }],
        foto: f,
      }),
    ).toEqual({
      ok: false,
      error: "Tanggal terima tidak boleh setelah hari ini.",
    });
    expect(
      cek({
        tanggal: "2026-10-28",
        baris: [{ id_baris: "p-9", jumlah: 1 }],
        foto: f,
      }),
    ).toEqual({
      ok: false,
      error: "Barang penerimaan tidak dikenal. Muat ulang daftarnya.",
    });
    expect(
      cek({
        tanggal: "2026-10-28",
        baris: [{ id_baris: "p-1", jumlah: 7 }],
        foto: f,
      }),
    ).toEqual({
      ok: false,
      error: "Baris 1: jumlah diterima melebihi sisa yang di-ACC.",
    });
    expect(
      cek({
        tanggal: "2026-10-28",
        baris: [{ id_baris: "p-1", jumlah: 0 }],
        foto: f,
      }),
    ).toEqual({ ok: false, error: "Isi jumlah diterima minimal satu barang." });
    expect(
      cek({
        tanggal: "2026-10-28",
        baris: [{ id_baris: "p-2", jumlah: 5 }],
        foto: [],
      }),
    ).toEqual({
      ok: false,
      error: "Lampirkan minimal satu foto barang yang diterima.",
    });
    expect(
      cek({
        tanggal: "2026-10-28",
        catatan: " Kardus penyok ",
        baris: [
          { id_baris: "p-1", jumlah: 0 },
          { id_baris: "p-2", jumlah: 5, harga_satuan: 60000 },
        ],
        foto: f,
      }),
    ).toEqual({
      ok: true,
      value: { tanggal: "2026-10-28", catatan: "Kardus penyok", dicatat: [1] },
    });
    expect(idBarangBaru("pgj-a-2")).toBe("brg-pgj-a-2");
  });
});

describe("penerimaan di database", () => {
  // Skenario yang sama dengan `penerimaan_bertahap_membuat_barang_sekali` di Rust.
  test("bertahap, barang baru terbuat sekali, harga sebenarnya, foto", async () => {
    const hari = await hariIni();
    const { id_barang } = await saveItem(client, {
      nama_barang: "Spidol",
      tipe: "Habis Pakai",
      satuan: "pcs",
      tempat_utama: "Gudang",
    });
    const { id_pengajuan: id } = await savePengajuan(client, "sarpras", {
      tanggal: hari,
      keperluan: "ATK",
      baris: [
        { id_barang, jumlah: 10, harga_satuan: 8500 },
        {
          nama_barang: "Kertas HVS",
          satuan: "rim",
          jumlah: 5,
          harga_satuan: 55000,
        },
        {
          nama_barang: "Proyektor",
          satuan: "unit",
          jumlah: 2,
          harga_satuan: 4000000,
        },
      ],
    });
    const foto = [
      { mime_type: "image/jpeg", data_base64: "QUJD" },
      { mime_type: "image/jpeg", data_base64: "QUJD" },
    ];
    await expect(
      receivePengajuan(client, "sarpras", {
        id_pengajuan: id,
        tanggal: hari,
        baris: [{ id_baris: `${id}-1`, jumlah: 1 }],
        foto,
      }),
    ).rejects.toThrow("Disetujui atau Diterima sebagian");

    const awal = await satuPengajuan(hari);
    await decidePengajuan(client, "bendahara", false, {
      id_pengajuan: id,
      keputusan: "ACC",
      sidik_baris: awal.sidik_baris,
    });

    const terima = await receivePengajuan(client, "sarpras", {
      id_pengajuan: id,
      tanggal: hari,
      baris: [
        {
          id_baris: `${id}-1`,
          jumlah: 10,
          harga_satuan: 9000,
          tempat: "Gudang",
        },
        {
          id_baris: `${id}-3`,
          jumlah: 2,
          harga_satuan: 4000000,
          tempat: "Lab",
          tipe: "Aset",
          kategori: "Elektronik",
          per_unit: true,
        },
      ],
      foto,
    });
    expect(terima.label[1]?.id_barang).toBe(`brg-${id}-3`);
    expect(terima.label[1]?.mutasi).toHaveLength(2);

    let p = await satuPengajuan(hari);
    expect(p.status).toBe("Diterima sebagian");
    expect(p.baris[0]?.diterima).toBe(10);
    expect(p.baris[0]?.harga_diterima[0]?.harga_satuan).toBe(9000);
    expect(p.baris[2]?.barang_terdaftar).toBe(`brg-${id}-3`);
    expect(p.penerimaan[0]?.jumlah_foto).toBe(2);

    await expect(
      receivePengajuan(client, "sarpras", {
        id_pengajuan: id,
        tanggal: hari,
        baris: [
          {
            id_baris: `${id}-2`,
            jumlah: 6,
            harga_satuan: 55000,
            tempat: "Gudang",
            tipe: "Habis Pakai",
          },
        ],
        foto,
      }),
    ).rejects.toThrow("melebihi sisa");
    await receivePengajuan(client, "sarpras", {
      id_pengajuan: id,
      tanggal: hari,
      baris: [
        {
          id_baris: `${id}-2`,
          jumlah: 5,
          harga_satuan: 55000,
          tempat: "Gudang",
          tipe: "Habis Pakai",
        },
      ],
      foto,
    });
    p = await satuPengajuan(hari);
    expect(p.status).toBe("Selesai");

    const barangBaru = await client.execute(
      "SELECT COUNT(*) AS n FROM inventory_barang WHERE id_barang LIKE 'brg-pgj-%';",
    );
    expect(Number(barangBaru.rows[0]?.n)).toBe(2);
    const satu = await fotoPenerimaan(client, `${terima.id_penerimaan}-2`);
    expect(satu?.data_base64).toBe("QUJD");
    expect(
      await fotoPenerimaan(client, `${terima.id_penerimaan}-3`),
    ).toBeNull();

    const pending = await journalPending(client, "2000-01-01", hari);
    expect(pending.baris.every((b) => b.id_pengajuan === id)).toBe(true);
    expect(pending.baris.length).toBeGreaterThan(0);
  });
});
