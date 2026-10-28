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
const {
  cancelMutation,
  cancelService,
  closeService,
  journalPending,
  journalPost,
  listInventory,
  saveItem,
  saveService,
  serviceHistory,
} = await import("./inventory");

// Servis aset (v29). Satu klien per berkas: libsql Bun di Windows bisa crash
// bila berkas tes membuat klien baru setelah menutup klien lain.
let client: Client;
let testDirectory: string;

beforeAll(async () => {
  testDirectory = mkdtempSync(join(tmpdir(), "kos-inventory-servis-"));
  client = createClient({ url: `file:${join(testDirectory, "test.db")}` });
  await initDatabaseSchema(client);
});

beforeEach(async () => {
  await client.batch(
    [
      "DELETE FROM inventory_servis;",
      "DELETE FROM inventory_mutasi;",
      "DELETE FROM inventory_unit;",
      "DELETE FROM inventory_barang;",
      "DELETE FROM keu_jurnal_baris;",
      "DELETE FROM keu_jurnal;",
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

async function aset(nama: string): Promise<string> {
  const hasil = await saveItem(client, {
    nama_barang: nama,
    tipe: "Aset",
    satuan: "unit",
    tempat_utama: "Gudang",
  });
  return hasil.id_barang;
}

async function masuk(
  id: string,
  idBarang: string,
  jumlah: number,
  kondisi: string,
  idBatch: string | null = null,
) {
  await client.execute({
    sql: `INSERT INTO inventory_mutasi (id_mutasi, id_barang, jenis, alasan, tanggal, jumlah,
            tempat_tujuan, kondisi_tujuan, id_batch, dicatat_oleh)
          VALUES (?, ?, 'Masuk', 'Saldo Awal', '2026-01-02', ?, 'Gudang', ?, ?, 'sarpras');`,
    args: [id, idBarang, jumlah, kondisi, idBatch],
  });
}

async function stok(idBarang: string, kondisi: string): Promise<number> {
  const daftar = await listInventory(client);
  return (
    daftar.barang
      .find((b) => b.id_barang === idBarang)
      ?.posisi.filter((p) => p.kondisi === kondisi)
      .reduce((n, p) => n + p.saldo, 0) ?? Number.NaN
  );
}

describe("servis aset Web", () => {
  test("buka, tutup dengan kondisi baru, lalu biayanya dijurnal", async () => {
    const hari = await hariIni();
    const kursi = await aset("Kursi");
    await masuk("m-kursi", kursi, 3, "Rusak Ringan");

    const { id_servis: id } = await saveService(client, "sarpras", {
      id_barang: kursi,
      jumlah: 2,
      tempat: "gudang",
      kondisi_awal: "Rusak Ringan",
      tanggal_mulai: hari,
      penyedia: "Bengkel Jati",
      keluhan: "Kaki patah",
    });
    const daftar = await listInventory(client);
    expect(daftar.servis.map((s) => [s.id_servis, s.tempat, s.status])).toEqual(
      [[id, "Gudang", "Sedang diservis"]],
    );
    // Stok tidak berubah selama servis, dan yang sudah diservis tidak bisa diambil lagi.
    expect(await stok(kursi, "Rusak Ringan")).toBe(3);
    await expect(
      saveService(client, "sarpras", {
        id_barang: kursi,
        jumlah: 2,
        tempat: "Gudang",
        kondisi_awal: "Rusak Ringan",
        tanggal_mulai: hari,
        keluhan: "Goyang",
      }),
    ).rejects.toThrow("yang belum diservis tinggal 1 unit");

    await closeService(client, "sarpras", {
      id_servis: id,
      tanggal_selesai: hari,
      hasil: "Baik",
      biaya: 350_000,
    });
    expect(await stok(kursi, "Baik")).toBe(2);
    expect(await stok(kursi, "Rusak Ringan")).toBe(1);
    expect((await listInventory(client)).servis).toEqual([]);
    await expect(
      closeService(client, "sarpras", {
        id_servis: id,
        tanggal_selesai: hari,
        hasil: "Baik",
        biaya: 0,
      }),
    ).rejects.toThrow("sudah ditutup");
    await expect(
      cancelMutation(client, "sarpras", `${id}-kondisi`, "Salah"),
    ).rejects.toThrow("penutupan servis");

    const pending = await journalPending(client, "2026-01-01", hari);
    expect(pending.servis.map((s) => [s.id_servis, s.nilai])).toEqual([
      [id, 350_000],
    ]);
    await journalPost(client, "bendahara", {
      id_servis: [id],
      akun_debit_servis: "akun-beban-pemeliharaan",
      akun_kredit_bayar: "akun-kas",
    });
    const baris = await client.execute({
      sql: "SELECT id_akun, debit, kredit FROM keu_jurnal_baris WHERE id_jurnal = ? ORDER BY urutan;",
      args: [`jrn-${id}`],
    });
    expect(
      baris.rows.map((r) => [
        String(r.id_akun),
        Number(r.debit),
        Number(r.kredit),
      ]),
    ).toEqual([
      ["akun-beban-pemeliharaan", 350_000, 0],
      ["akun-kas", 0, 350_000],
    ]);
    expect((await journalPending(client, "2026-01-01", hari)).servis).toEqual(
      [],
    );
  });

  test("unit: wajib dipilih, tidak bisa diservis dua kali, dan Tidak Bisa Diperbaiki tidak mengubah stok", async () => {
    const hari = await hariIni();
    const proyektor = await aset("Proyektor");
    await client.execute({
      sql: `INSERT INTO inventory_unit (id_unit, id_barang, kode_unit) VALUES ('u-1', ?, 'PRJ-01');`,
      args: [proyektor],
    });
    await masuk("u-1", proyektor, 1, "Rusak Berat", "u-1");

    await expect(
      saveService(client, "sarpras", {
        id_barang: proyektor,
        jumlah: 1,
        tempat: "Gudang",
        kondisi_awal: "Rusak Berat",
        tanggal_mulai: hari,
        keluhan: "Mati",
      }),
    ).rejects.toThrow("Pilih unit");
    const { id_servis: id } = await saveService(client, "sarpras", {
      id_barang: proyektor,
      id_unit: "u-1",
      tanggal_mulai: hari,
      keluhan: "Mati total",
    });
    await expect(
      saveService(client, "sarpras", {
        id_barang: proyektor,
        id_unit: "u-1",
        tanggal_mulai: hari,
        keluhan: "Lagi",
      }),
    ).rejects.toThrow("masih dalam servis");

    await closeService(client, "sarpras", {
      id_servis: id,
      tanggal_selesai: hari,
      hasil: "Tidak Bisa Diperbaiki",
      biaya: 0,
    });
    expect(await stok(proyektor, "Rusak Berat")).toBe(1);
    const mutasi = await client.execute({
      sql: "SELECT COUNT(*) AS n FROM inventory_mutasi WHERE id_mutasi = ?;",
      args: [`${id}-kondisi`],
    });
    expect(Number(mutasi.rows[0]?.n)).toBe(0);
  });

  test("ubah, batal, riwayat, dan tanggal setelah hari ini ditolak", async () => {
    const hari = await hariIni();
    const meja = await aset("Meja");
    await masuk("m-meja", meja, 1, "Rusak Ringan");
    const isi = {
      id_barang: meja,
      jumlah: 1,
      tempat: "Gudang",
      kondisi_awal: "Rusak Ringan",
      keluhan: "Retak",
    };
    await expect(
      saveService(client, "sarpras", { ...isi, tanggal_mulai: "2999-01-01" }),
    ).rejects.toThrow("setelah hari ini");
    const { id_servis: id } = await saveService(client, "sarpras", {
      ...isi,
      tanggal_mulai: hari,
    });
    await saveService(client, "sarpras", {
      id_servis: id,
      id_barang: meja,
      tanggal_mulai: hari,
      penyedia: "Pak Budi",
      keluhan: "Retak di kaki",
    });
    await cancelService(client, "sarpras", id, "Tidak jadi dibawa");
    await expect(cancelService(client, "sarpras", id, "Lagi")).rejects.toThrow(
      "sudah ditutup, dibatalkan",
    );
    const riwayat = await serviceHistory(client, "2026-01-01", hari, meja);
    expect(
      riwayat.baris.map((s) => [
        s.status,
        s.penyedia,
        s.keluhan,
        s.alasan_batal,
      ]),
    ).toEqual([
      ["Dibatalkan", "Pak Budi", "Retak di kaki", "Tidak jadi dibawa"],
    ]);
  });
});
