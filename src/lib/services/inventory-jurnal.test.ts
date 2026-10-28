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

mock.module("server-only", () => ({}));
const { cancelMutation, journalPending, journalPost, procurement, saveItem } =
  await import("./inventory");

// Jurnal pengadaan (v28). Satu klien per berkas: libsql Bun di Windows bisa
// crash bila berkas tes membuat klien baru setelah menutup klien lain.
let client: Client;
let testDirectory: string;

beforeAll(async () => {
  testDirectory = mkdtempSync(join(tmpdir(), "kos-inventory-jurnal-"));
  client = createClient({ url: `file:${join(testDirectory, "test.db")}` });
  await initDatabaseSchema(client);
});

beforeEach(async () => {
  await client.batch(
    [
      "DELETE FROM inventory_mutasi;",
      "DELETE FROM inventory_barang;",
      "DELETE FROM keu_jurnal_baris;",
      "DELETE FROM keu_jurnal;",
      "DELETE FROM keu_tutup_buku;",
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

const AKUN = {
  akun_debit_aset: "akun-peralatan",
  akun_debit_habis_pakai: "akun-beban-atk",
  akun_kredit_bayar: "akun-kas",
  akun_kredit_hibah: "akun-pendapatan-lain",
};

async function barang(tipe: "Aset" | "Habis Pakai", desimal = false) {
  const hasil = await saveItem(client, {
    nama_barang: tipe === "Aset" ? "Proyektor" : "Kertas HVS",
    tipe,
    satuan: tipe === "Aset" ? "unit" : desimal ? "kg" : "rim",
    tempat_utama: "Gudang",
    desimal,
  });
  return hasil.id_barang;
}

async function masuk(
  id: string,
  idBarang: string,
  alasan: "Pengadaan" | "Hibah" | "Saldo Awal",
  jumlah: number,
  harga: number | null,
  tanggal = "2026-10-01",
) {
  await client.execute({
    sql: `INSERT INTO inventory_mutasi (id_mutasi, id_barang, jenis, alasan, tanggal, jumlah,
            tempat_tujuan, kondisi_tujuan, harga_satuan, nomor_dokumen, dicatat_oleh)
          VALUES (?, ?, 'Masuk', ?, ?, ?, 'Gudang', 'Baik', ?, 'BA-01', 'sarpras');`,
    args: [id, idBarang, alasan, tanggal, jumlah, harga],
  });
}

async function barisJurnal(idJurnal: string) {
  const hasil = await client.execute({
    sql: "SELECT id_akun, debit, kredit FROM keu_jurnal_baris WHERE id_jurnal = ? ORDER BY urutan;",
    args: [idJurnal],
  });
  return hasil.rows.map((row) => [
    String(row.id_akun),
    Number(row.debit),
    Number(row.kredit),
  ]);
}

describe("jurnal pengadaan inventaris Web", () => {
  test("hanya Pengadaan dan Hibah berharga yang masuk daftar, lalu dijurnal per baris", async () => {
    const hvs = await barang("Habis Pakai");
    const proyektor = await barang("Aset");
    await masuk("m-hvs", hvs, "Pengadaan", 3, 55_000);
    await masuk("m-hibah", proyektor, "Hibah", 1, 4_000_000);
    await masuk("m-awal", hvs, "Saldo Awal", 10, 50_000);
    await masuk("m-tanpa-harga", hvs, "Pengadaan", 2, null);

    const daftar = await journalPending(client, "2026-01-01", "2026-12-31");
    expect(daftar.baris.map((b) => b.id_mutasi).sort()).toEqual([
      "m-hibah",
      "m-hvs",
    ]);

    const hasil = await journalPost(client, "bendahara", {
      id_mutasi: ["m-hvs", "m-hibah"],
      ...AKUN,
    });
    expect(hasil).toEqual({ sukses: true, dijurnal: 2, dibalik: 0 });
    expect(await barisJurnal("jrn-inv-m-hvs")).toEqual([
      ["akun-beban-atk", 165_000, 0],
      ["akun-kas", 0, 165_000],
    ]);
    expect(await barisJurnal("jrn-inv-m-hibah")).toEqual([
      ["akun-peralatan", 4_000_000, 0],
      ["akun-pendapatan-lain", 0, 4_000_000],
    ]);
    const header = await client.execute(
      "SELECT tanggal, sumber, id_sumber, keterangan FROM keu_jurnal WHERE id_jurnal = 'jrn-inv-m-hvs';",
    );
    expect(header.rows[0]).toMatchObject({
      tanggal: "2026-10-01",
      sumber: "Inventaris",
      id_sumber: "m-hvs",
      keterangan: "Pengadaan Kertas HVS 3 rim (BA-01)",
    });

    expect(
      (await journalPending(client, "2026-01-01", "2026-12-31")).baris,
    ).toEqual([]);
    const rekap = await procurement(client, "2026-01-01", "2026-12-31");
    const nomor = rekap.baris.find(
      (b) => b.alasan === "Pengadaan" && b.harga_satuan,
    )?.nomor_jurnal;
    expect(nomor).toMatch(/^JU\/2026\/WEB\//);

    // Baris yang sudah dijurnal (misal oleh perangkat lain) menolak seluruh tekan.
    await expect(
      journalPost(client, "bendahara", { id_mutasi: ["m-hvs"], ...AKUN }),
    ).rejects.toThrow("sudah dijurnal");
  });

  test("barang desimal dijurnal dengan nilai yang sama dengan rekap pengadaan", async () => {
    const beras = await barang("Habis Pakai", true);
    await masuk("m-beras", beras, "Pengadaan", 250, 12_345);
    await journalPost(client, "bendahara", { id_mutasi: ["m-beras"], ...AKUN });
    expect(await barisJurnal("jrn-inv-m-beras")).toEqual([
      ["akun-beban-atk", 30_863, 0],
      ["akun-kas", 0, 30_863],
    ]);
  });

  test("akun salah kelompok dan periode tertutup ditolak tanpa menulis apa pun", async () => {
    const hvs = await barang("Habis Pakai");
    await masuk("m-1", hvs, "Pengadaan", 1, 10_000, "2026-10-01");
    await masuk("m-lama", hvs, "Pengadaan", 1, 10_000, "2026-01-05");

    await expect(
      journalPost(client, "bendahara", {
        id_mutasi: ["m-1"],
        ...AKUN,
        akun_kredit_bayar: "akun-beban-atk",
      }),
    ).rejects.toThrow("Aset atau Kewajiban");

    await client.execute(
      `INSERT INTO keu_tutup_buku (id_tutup, sampai_tanggal, dibuat_oleh, kode_perangkat,
         waktu_perangkat, saldo_json, status)
       VALUES ('tb-1', '2026-03-31', 'kepala', 'WEB', '2026-04-01 08:00:00', '[]', 'Aktif');`,
    );
    const daftar = await journalPending(client, "2026-01-01", "2026-12-31");
    expect(
      daftar.baris.find((b) => b.id_mutasi === "m-lama")?.periode_tertutup,
    ).toBe(true);
    await expect(
      journalPost(client, "bendahara", {
        id_mutasi: ["m-1", "m-lama"],
        ...AKUN,
      }),
    ).rejects.toThrow("sudah ditutup");
    const jumlah = await client.execute(
      "SELECT COUNT(*) AS n FROM keu_jurnal;",
    );
    expect(Number(jumlah.rows[0]?.n)).toBe(0);
  });

  test("membatalkan mutasi yang sudah dijurnal membalik jurnalnya sekali", async () => {
    const hvs = await barang("Habis Pakai");
    await masuk("m-batal", hvs, "Pengadaan", 2, 20_000);
    await journalPost(client, "bendahara", { id_mutasi: ["m-batal"], ...AKUN });
    await cancelMutation(client, "sarpras", "m-batal", "Salah input");

    expect(await barisJurnal("batal-jrn-inv-m-batal")).toEqual([
      ["akun-beban-atk", 0, 40_000],
      ["akun-kas", 40_000, 0],
    ]);
    const pembalik = await client.execute(
      "SELECT sumber, id_jurnal_batal FROM keu_jurnal WHERE id_jurnal = 'batal-jrn-inv-m-batal';",
    );
    expect(pembalik.rows[0]).toMatchObject({
      sumber: "Pembatalan",
      id_jurnal_batal: "jrn-inv-m-batal",
    });
    const daftar = await journalPending(client, "2026-01-01", "2026-12-31");
    expect(daftar.baris).toEqual([]);
    expect(daftar.perlu_dibalik).toEqual([]);
  });

  test("jurnal yang mutasinya dibatalkan perangkat lain muncul dan bisa dibalik", async () => {
    const hvs = await barang("Habis Pakai");
    await masuk("m-yatim", hvs, "Pengadaan", 1, 15_000);
    await journalPost(client, "bendahara", { id_mutasi: ["m-yatim"], ...AKUN });
    // Pembatalan dari perangkat yang belum menarik jurnalnya: hanya baris mutasi.
    await client.execute(
      `INSERT INTO inventory_mutasi (id_mutasi, id_barang, jenis, alasan, tanggal, jumlah,
         tempat_asal, kondisi_asal, id_ref, dicatat_oleh)
       VALUES ('batal-m-yatim', ?, 'Keluar', 'Pembatalan', '2026-10-02', 1, 'Gudang', 'Baik', 'm-yatim', 'hp');`,
      [hvs],
    );

    const daftar = await journalPending(client, "2026-01-01", "2026-12-31");
    expect(daftar.perlu_dibalik.map((j) => j.id_jurnal)).toEqual([
      "jrn-inv-m-yatim",
    ]);
    await expect(
      journalPost(client, "bendahara", { balik: ["jrn-inv-tidak-ada"] }),
    ).rejects.toThrow("Muat ulang daftarnya");
    expect(
      await journalPost(client, "bendahara", { balik: ["jrn-inv-m-yatim"] }),
    ).toEqual({ sukses: true, dijurnal: 0, dibalik: 1 });
    expect(
      (await journalPending(client, "2026-01-01", "2026-12-31")).perlu_dibalik,
    ).toEqual([]);
  });
});
