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
  documentInventaris,
  listInventory,
  listLoans,
  listRecipients,
  opnameHistory,
  procurement,
  recordMutation,
  recordOpname,
  registerUnits,
  saveCodePrefixes,
  deleteColumn,
  deleteItem,
  saveColumn,
  saveItem,
  saveUnit,
  stockCard,
} = await import("./inventory");

// Berkas sungguhan, bukan `file::memory:`: transaksi libSQL lokal membuka
// koneksi baru, dan database memori di koneksi baru selalu kosong.
let client: Client;
let testDirectory: string;

beforeAll(async () => {
  testDirectory = mkdtempSync(join(tmpdir(), "kos-inventory-web-"));
  client = createClient({ url: `file:${join(testDirectory, "test.db")}` });
  await initDatabaseSchema(client);
});

beforeEach(async () => {
  await client.batch(
    [
      "DELETE FROM inventory_mutasi;",
      "DELETE FROM inventory_barang;",
      "DELETE FROM inventory_unit;",
      "DELETE FROM inventory_kolom;",
      "DELETE FROM inventory_servis;",
      "DELETE FROM master_data;",
      "DELETE FROM setting_gex_system WHERE key = 'inventory_kode_prefix';",
    ],
    "write",
  );
});

// Di Windows berkas SQLite bisa masih terkunci sesaat setelah `close()`; pola
// pembersihan yang sama dengan `attendance-processor.test.ts`.
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

async function barangBaru(bisaExpired = false): Promise<string> {
  const result = await saveItem(client, {
    nama_barang: "Barang Uji",
    tipe: "Habis Pakai",
    satuan: "pcs",
    bisa_expired: bisaExpired,
    tempat_utama: "Gudang",
  });
  return result.id_barang;
}

async function stok(idBarang: string): Promise<number> {
  const daftar = await listInventory(client);
  return (
    daftar.barang.find((item) => item.id_barang === idBarang)?.stok_total ?? NaN
  );
}

async function mutasiMentah(
  id: string,
  idBarang: string,
  jenis: "Masuk" | "Keluar",
  jumlah: number,
) {
  await client.execute({
    sql: `INSERT INTO inventory_mutasi (id_mutasi, id_barang, jenis, alasan, tanggal, jumlah,
            tempat_asal, kondisi_asal, tempat_tujuan, kondisi_tujuan, dicatat_oleh)
          VALUES (?, ?, ?, ?, '2026-10-01', ?, ?, ?, ?, ?, 'uji');`,
    args: [
      id,
      idBarang,
      jenis,
      jenis === "Masuk" ? "Pengadaan" : "Pemakaian",
      jumlah,
      jenis === "Masuk" ? null : "Gudang",
      jenis === "Masuk" ? null : "Baik",
      jenis === "Masuk" ? "Gudang" : null,
      jenis === "Masuk" ? "Baik" : null,
    ],
  });
}

// Skenario kembar dengan tes di `desktop/inventory.rs`.
describe("service inventaris Web", () => {
  test("divisi penerima memakai ejaan data personil", async () => {
    await client.execute(
      `INSERT INTO master_data (id_unik, nama, divisi, id_shift, status_aktif)
       VALUES ('k1', 'Ani', 'Keuangan', 1, 'Aktif'),
              ('k2', 'Budi', 'keuangan ', 1, 'Aktif'),
              ('k3', 'Cici', 'Gudang Lama', 1, 'Nonaktif');`,
    );
    const idBarang = await barangBaru();
    await mutasiMentah("mts-awal", idBarang, "Masuk", 10);

    const penerima = await listRecipients(client);
    expect(penerima.divisi).toEqual(["Keuangan"]);
    expect(penerima.personil[0]?.divisi).toBe("Keuangan");

    const keluar = (nama: string) =>
      recordMutation(client, "admin", {
        id_barang: idBarang,
        jenis: "Keluar",
        alasan: "Pemakaian",
        jumlah: 1,
        tempat_asal: "Gudang",
        penerima_tipe: "Divisi",
        penerima_nama: nama,
        keperluan: "Rapat",
      });
    const { id_mutasi } = await keluar("KEUANGAN");
    const tersimpan = await client.execute({
      sql: "SELECT penerima_nama, penerima_id FROM inventory_mutasi WHERE id_mutasi = ?;",
      args: [id_mutasi],
    });
    expect(tersimpan.rows[0]?.penerima_nama).toBe("Keuangan");
    expect(tersimpan.rows[0]?.penerima_id).toBeNull();

    // Divisi yang hanya dimiliki personil nonaktif tidak bisa dipilih.
    await expect(keluar("Gudang Lama")).rejects.toThrow(
      "Divisi tidak ditemukan.",
    );
    expect(await stok(idBarang)).toBe(9);

    // Ganti nama divisi (v36): tampilan memakai nama kini, baris mutasi tetap
    // menyimpan ejaan lama. Cermin tes Rust.
    await client.executeMultiple(
      `INSERT INTO hr_divisi (id_divisi, nama) VALUES ('div-keu', 'Finance');
       INSERT INTO hr_divisi_nama (id_nama, id_divisi, nama, created_at)
       VALUES ('div-keu:awal', 'div-keu', 'Keuangan', '2026-01-01 00:00:00'),
              ('div-keu:2', 'div-keu', 'Finance', '2026-02-01 00:00:00');`,
    );
    const kartu = await stockCard(
      client,
      idBarang,
      null,
      "2000-01-01",
      "2100-12-31",
    );
    expect(
      kartu.baris.find((b) => b.id_mutasi === id_mutasi)?.penerima_nama,
    ).toBe("Finance");
    expect((await documentInventaris(client, id_mutasi)).penerima_nama).toBe(
      "Finance",
    );
    const disimpan = await client.execute({
      sql: "SELECT penerima_nama FROM inventory_mutasi WHERE id_mutasi = ?;",
      args: [id_mutasi],
    });
    expect(disimpan.rows[0]?.penerima_nama).toBe("Keuangan");
  });

  test("dua perangkat offline mengeluarkan 2 dan 3 dari stok 10 menghasilkan 5", async () => {
    const idBarang = await barangBaru();
    await mutasiMentah("mts-masuk", idBarang, "Masuk", 10);
    await mutasiMentah("mts-hp-uks", idBarang, "Keluar", 2);
    await mutasiMentah("mts-laptop-tu", idBarang, "Keluar", 3);
    expect(await stok(idBarang)).toBe(5);
  });

  test("menolak pengeluaran melebihi saldo dan memakai ejaan tempat yang sudah ada", async () => {
    const idBarang = await barangBaru();
    await recordMutation(client, "admin", {
      id_barang: idBarang,
      jenis: "Masuk",
      alasan: "Pengadaan",
      jumlah: 4,
      tempat_tujuan: "gudang",
    });
    await expect(
      recordMutation(client, "admin", {
        id_barang: idBarang,
        jenis: "Keluar",
        alasan: "Pemakaian",
        jumlah: 5,
        tempat_asal: "Gudang",
        penerima_tipe: "Umum",
        keperluan: "Rapat",
      }),
    ).rejects.toThrow("Stok di Gudang (Baik) hanya 4 pcs.");
    expect((await listInventory(client)).tempat).toEqual(["Gudang"]);
  });

  test("dicatat_oleh dari body ditolak dan operator diambil dari sesi", async () => {
    const idBarang = await barangBaru();
    await expect(
      recordMutation(client, "admin", {
        id_barang: idBarang,
        jenis: "Masuk",
        alasan: "Pengadaan",
        jumlah: 1,
        tempat_tujuan: "Gudang",
        dicatat_oleh: "orang-lain",
      }),
    ).rejects.toThrow("Data mutasi tidak valid.");
    const { id_mutasi } = await recordMutation(client, "petugas-uks", {
      id_barang: idBarang,
      jenis: "Masuk",
      alasan: "Saldo Awal",
      jumlah: 1,
      tempat_tujuan: "UKS",
    });
    const row = await client.execute({
      sql: "SELECT dicatat_oleh FROM inventory_mutasi WHERE id_mutasi = ?;",
      args: [id_mutasi],
    });
    expect(row.rows[0]?.dicatat_oleh).toBe("petugas-uks");
  });

  test("batch barang ber-expired mengikuti id mutasi masuknya", async () => {
    const idBarang = await barangBaru(true);
    const masuk = await recordMutation(client, "admin", {
      id_barang: idBarang,
      jenis: "Masuk",
      alasan: "Pengadaan",
      jumlah: 10,
      tempat_tujuan: "Gudang",
      tanggal_expired: "2027-01-31",
    });
    await recordMutation(client, "admin", {
      id_barang: idBarang,
      jenis: "Pindah",
      alasan: "Distribusi",
      jumlah: 4,
      tempat_asal: "Gudang",
      tempat_tujuan: "UKS",
      id_batch: masuk.id_mutasi,
    });
    const item = (await listInventory(client)).barang.find(
      (barang) => barang.id_barang === idBarang,
    );
    expect(item?.stok_total).toBe(10);
    expect(item?.posisi).toHaveLength(2);
    expect(
      item?.posisi.every(
        (p) =>
          p.id_batch === masuk.id_mutasi && p.tanggal_expired === "2027-01-31",
      ),
    ).toBe(true);
  });

  test("pembatalan idempoten dan tidak membuat stok yang sudah terpakai minus", async () => {
    const idBarang = await barangBaru();
    const masuk = await recordMutation(client, "admin", {
      id_barang: idBarang,
      jenis: "Masuk",
      alasan: "Pengadaan",
      jumlah: 5,
      tempat_tujuan: "Gudang",
    });
    const keluar = await recordMutation(client, "admin", {
      id_barang: idBarang,
      jenis: "Keluar",
      alasan: "Pemakaian",
      jumlah: 3,
      tempat_asal: "Gudang",
      penerima_tipe: "Unit",
      penerima_nama: "TU",
      keperluan: "ATK",
    });
    await expect(
      cancelMutation(client, "admin", masuk.id_mutasi, "Salah input"),
    ).rejects.toThrow("tidak cukup untuk membatalkan");
    await cancelMutation(client, "admin", keluar.id_mutasi, "Salah input");
    expect(await stok(idBarang)).toBe(5);
    await expect(
      cancelMutation(client, "admin", keluar.id_mutasi, "Salah input"),
    ).rejects.toThrow("Mutasi ini sudah dibatalkan.");
  });

  test("kartu stok menghitung saldo berjalan dan saldo awal", async () => {
    const idBarang = await barangBaru();
    await mutasiMentah("mts-a", idBarang, "Masuk", 10);
    await mutasiMentah("mts-b", idBarang, "Keluar", 4);
    const kartu = await stockCard(
      client,
      idBarang,
      null,
      "2026-10-01",
      "2026-10-31",
    );
    expect(kartu.saldo_awal).toBe(0);
    expect(kartu.baris.map((baris) => baris.saldo)).toEqual([10, 6]);
    const nanti = await stockCard(
      client,
      idBarang,
      "gudang",
      "2026-10-02",
      "2026-10-31",
    );
    expect(nanti.saldo_awal).toBe(6);
    expect(nanti.baris).toHaveLength(0);
  });

  test("satuan terkunci setelah barang punya riwayat", async () => {
    const idBarang = await barangBaru();
    await mutasiMentah("mts-a", idBarang, "Masuk", 1);
    await expect(
      saveItem(client, {
        id_barang: idBarang,
        nama_barang: "Barang Uji",
        tipe: "Habis Pakai",
        satuan: "rim",
      }),
    ).rejects.toThrow("Tipe, satuan, desimal, dan pengaturan kedaluwarsa");
    await expect(
      saveItem(client, {
        id_barang: idBarang,
        nama_barang: "Barang Uji",
        tipe: "Aset",
        satuan: "pcs",
      }),
    ).rejects.toThrow("Tipe, satuan, desimal, dan pengaturan kedaluwarsa");
  });

  // Skenario kembar dengan `automatic_codes_are_sequential_per_prefix`.
  test("kode otomatis bernomor urut per awalan", async () => {
    await saveCodePrefixes(client, ["BRG", "UKS"]);
    const simpan = (kode_prefix: string | null) =>
      saveItem(client, {
        nama_barang: "Obat",
        tipe: "Habis Pakai",
        satuan: "strip",
        kode_prefix,
      });
    expect((await simpan("uks")).kode_barang).toBe("UKS-0001");
    expect((await simpan("UKS")).kode_barang).toBe("UKS-0002");
    expect((await simpan(null)).kode_barang).toBe("BRG-0001");
    await expect(simpan("LAB")).rejects.toThrow("Awalan kode tidak terdaftar.");
    expect((await listInventory(client)).kode_prefix).toEqual(["BRG", "UKS"]);
  });

  // Skenario kembar dengan `duplicate_codes_from_offline_devices_are_flagged`.
  test("kode kembar dari dua perangkat offline ditandai", async () => {
    await client.execute(
      `INSERT INTO inventory_barang (id_barang, kode_barang, nama_barang, tipe, satuan)
       VALUES ('brg-a', 'UKS-0005', 'Paracetamol', 'Habis Pakai', 'strip'),
              ('brg-b', 'uks-0005', 'Betadine', 'Habis Pakai', 'botol'),
              ('brg-c', 'UKS-0006', 'Perban', 'Habis Pakai', 'gulung');`,
    );
    const ganda = Object.fromEntries(
      (await listInventory(client)).barang.map((item) => [
        item.id_barang,
        item.kode_ganda,
      ]),
    );
    expect(ganda).toEqual({ "brg-a": true, "brg-b": true, "brg-c": false });
  });

  // Skenario kembar dengan `loans_track_partial_returns`.
  test("peminjaman melacak pengembalian sebagian", async () => {
    const idBarang = await barangBaru();
    await mutasiMentah("mts-awal", idBarang, "Masuk", 10);
    const { id_mutasi: idPinjam } = await recordMutation(client, "admin", {
      id_barang: idBarang,
      jenis: "Keluar",
      alasan: "Peminjaman",
      jumlah: 5,
      tempat_asal: "Gudang",
      penerima_tipe: "Unit",
      penerima_nama: "Lab IPA",
      keperluan: "KBM",
    });
    expect(await stok(idBarang)).toBe(5);
    const kembali = (jumlah: number) =>
      recordMutation(client, "admin", {
        id_barang: idBarang,
        jenis: "Masuk",
        alasan: "Pengembalian",
        jumlah,
        tempat_tujuan: "Gudang",
        id_ref: idPinjam,
      });
    await kembali(3);
    const daftar = await listLoans(client);
    expect(daftar.baris).toHaveLength(1);
    expect(daftar.baris[0]?.sisa).toBe(2);
    expect(daftar.baris[0]?.penerima_nama).toBe("Lab IPA");
    await expect(kembali(3)).rejects.toThrow(
      "Sisa yang belum kembali hanya 2 pcs.",
    );
    await expect(
      cancelMutation(client, "admin", idPinjam, "Salah"),
    ).rejects.toThrow("Batalkan dulu pengembalian peminjaman ini.");
    await kembali(2);
    expect((await listLoans(client)).baris).toHaveLength(0);
    expect(await stok(idBarang)).toBe(10);
  });

  // Skenario kembar dengan `expirable_return_goes_back_to_its_batch`.
  test("pengembalian barang ber-expired kembali ke batch asalnya", async () => {
    const idBarang = await barangBaru(true);
    const masuk = await recordMutation(client, "admin", {
      id_barang: idBarang,
      jenis: "Masuk",
      alasan: "Pengadaan",
      jumlah: 6,
      tempat_tujuan: "Gudang",
      tanggal_expired: "2027-03-01",
    });
    const pinjam = await recordMutation(client, "admin", {
      id_barang: idBarang,
      jenis: "Keluar",
      alasan: "Peminjaman",
      jumlah: 2,
      tempat_asal: "Gudang",
      id_batch: masuk.id_mutasi,
      penerima_tipe: "Umum",
      keperluan: "Praktik",
    });
    await recordMutation(client, "admin", {
      id_barang: idBarang,
      jenis: "Masuk",
      alasan: "Pengembalian",
      jumlah: 2,
      tempat_tujuan: "Gudang",
      id_ref: pinjam.id_mutasi,
    });
    const item = (await listInventory(client)).barang.find(
      (b) => b.id_barang === idBarang,
    );
    expect(item?.posisi).toHaveLength(1);
    expect(item?.posisi[0]?.saldo).toBe(6);
    expect(item?.posisi[0]?.id_batch).toBe(masuk.id_mutasi);
  });

  // Skenario kembar dengan `opname_writes_differences_with_one_document_number`.
  test("opname menulis selisih dengan satu nomor dokumen", async () => {
    const a = await barangBaru();
    const b = await barangBaru();
    await mutasiMentah("mts-a", a, "Masuk", 10);
    await mutasiMentah("mts-b", b, "Masuk", 4);
    const hasil = await recordOpname(client, "admin", {
      tempat: "gudang",
      baris: [
        { id_barang: a, fisik: 7 },
        { id_barang: b, fisik: 4 },
      ],
    });
    expect(hasil.jumlah_selisih).toBe(1);
    expect(hasil.nomor_dokumen.startsWith("OPN-")).toBe(true);
    expect(await stok(a)).toBe(7);
    expect(await stok(b)).toBe(4);
    const row = await client.execute({
      sql: "SELECT alasan, jumlah, nomor_dokumen FROM inventory_mutasi WHERE id_barang = ? AND jenis = 'Keluar';",
      args: [a],
    });
    expect(row.rows[0]?.alasan).toBe("Selisih Opname");
    expect(Number(row.rows[0]?.jumlah)).toBe(3);
    expect(row.rows[0]?.nomor_dokumen).toBe(hasil.nomor_dokumen);
  });

  // Skenario kembar dengan `list_reports_expiry_status_and_low_stock`.
  test("daftar melaporkan status kedaluwarsa dan stok menipis", async () => {
    const idBarang = await barangBaru(true);
    await client.execute({
      sql: "UPDATE inventory_barang SET stok_minimum = 10 WHERE id_barang = ?;",
      args: [idBarang],
    });
    await client.execute({
      sql: `INSERT INTO inventory_mutasi (id_mutasi, id_barang, jenis, alasan, tanggal, jumlah,
              tempat_tujuan, kondisi_tujuan, id_batch, tanggal_expired, dicatat_oleh)
            VALUES ('mts-lama', ?1, 'Masuk', 'Pengadaan', '2026-01-01', 3, 'UKS', 'Baik', 'mts-lama',
                    date('now', '+7 hours', '-1 day'), 'uji'),
                   ('mts-hampir', ?1, 'Masuk', 'Pengadaan', '2026-01-01', 2, 'UKS', 'Baik', 'mts-hampir',
                    date('now', '+7 hours'), 'uji');`,
      args: [idBarang],
    });
    const daftar = await listInventory(client);
    const item = daftar.barang.find((b) => b.id_barang === idBarang);
    expect(item?.stok_menipis).toBe(true);
    expect(
      item?.posisi.map((p) => [p.status_kedaluwarsa, p.sisa_hari]),
    ).toEqual([
      ["Kedaluwarsa", -1],
      ["Waspada", 0],
    ]);
    expect(/^\d{4}-\d{2}-\d{2}$/.test(daftar.hari_ini)).toBe(true);
  });

  // Skenario kembar dengan `document_groups_by_number_and_skips_cancelled_rows`.
  test("berita acara mengelompokkan nomor dokumen dan melewati baris batal", async () => {
    await client.execute(
      `INSERT OR REPLACE INTO company_profile (id, company_name, leader_name, leader_nip, updated_at)
       VALUES ('default_company', 'SMK Contoh', 'Ibu Kepala', '1987', datetime('now'));`,
    );
    const a = await barangBaru();
    const b = await barangBaru();
    await mutasiMentah("mts-a", a, "Masuk", 10);
    await mutasiMentah("mts-b", b, "Masuk", 10);
    const keluar = async (idBarang: string, nomor: string) =>
      (
        await recordMutation(client, "admin", {
          id_barang: idBarang,
          jenis: "Keluar",
          alasan: "Pemakaian",
          jumlah: 2,
          tempat_asal: "Gudang",
          penerima_tipe: "Unit",
          penerima_nama: "Panitia PTS",
          keperluan: "PTS Ganjil",
          nomor_dokumen: nomor,
        })
      ).id_mutasi;
    const pertama = await keluar(a, "BA-01");
    const kedua = await keluar(b, "BA-01");
    const lain = await keluar(a, "BA-02");
    await cancelMutation(client, "admin", kedua, "Salah barang");

    const dok = await documentInventaris(client, pertama);
    expect(dok.jenis).toBe("Serah Terima");
    expect(dok.nomor_dokumen).toBe("BA-01");
    expect(dok.penerima_nama).toBe("Panitia PTS");
    expect(dok.kop.nama).toBe("SMK Contoh");
    expect(dok.kop.kepala_nama).toBe("Ibu Kepala");
    expect(dok.baris.map((row) => row.id_mutasi)).toEqual([pertama]);
    expect(dok.baris.map((row) => row.id_mutasi)).not.toContain(lain);
    await expect(documentInventaris(client, kedua)).rejects.toThrow(
      "Mutasi ini sudah dibatalkan, berita acaranya tidak bisa dicetak.",
    );
    await expect(documentInventaris(client, "mts-a")).rejects.toThrow(
      "Mutasi ini tidak punya berita acara.",
    );
  });

  // Skenario kembar dengan `procurement_sums_value_per_source_without_cancelled_rows`.
  test("rekap pengadaan menjumlah nilai per sumber dana tanpa baris batal", async () => {
    const idBarang = await barangBaru();
    const masuk = async (
      jumlah: number,
      harga: number | null,
      sumber: string,
    ) =>
      (
        await recordMutation(client, "admin", {
          id_barang: idBarang,
          jenis: "Masuk",
          alasan: "Pengadaan",
          jumlah,
          tempat_tujuan: "Gudang",
          harga_satuan: harga,
          sumber_dana: sumber,
        })
      ).id_mutasi;
    await masuk(10, 5_000, "BOSP Reguler");
    await masuk(2, null, "Komite");
    const batal = await masuk(4, 1_000, "BOSP Reguler");
    await cancelMutation(client, "admin", batal, "Dobel");
    const hari = await client.execute(
      "SELECT date('now', '+7 hours') AS hari;",
    );
    const rekap = await procurement(
      client,
      "2000-01-01",
      String(hari.rows[0]?.hari),
    );
    expect(rekap.baris).toHaveLength(2);
    expect(rekap.total_nilai).toBe(50_000);
    expect(rekap.rekap[0]?.sumber_dana).toBe("BOSP Reguler");
    expect(rekap.rekap[1]?.tanpa_harga).toBe(1);
    await expect(
      procurement(client, "2026-02-01", "2026-01-01"),
    ).rejects.toThrow("Tanggal awal tidak boleh setelah tanggal akhir.");
  });

  // Skenario kembar dengan `opname_history_lists_sessions_with_differences`.
  test("riwayat opname mendaftar sesi yang punya selisih", async () => {
    const a = await barangBaru();
    await mutasiMentah("mts-a", a, "Masuk", 10);
    const hasil = await recordOpname(client, "admin", {
      tempat: "Gudang",
      baris: [{ id_barang: a, fisik: 8 }],
    });
    const { riwayat } = await opnameHistory(client);
    expect(riwayat).toHaveLength(1);
    expect(riwayat[0]?.nomor_dokumen).toBe(hasil.nomor_dokumen);
    expect(riwayat[0]?.tempat).toBe("Gudang");
    const dok = await documentInventaris(
      client,
      riwayat[0]?.id_mutasi as string,
    );
    expect(dok.jenis).toBe("Opname");
  });
});

// Skenario kembar dengan `per_unit_entry_creates_units_and_moves_them_one_by_one`
// dan `register_units_converts_pool_stock_without_changing_totals`.
describe("registri aset per unit Web", () => {
  async function asetBaru(): Promise<string> {
    const result = await saveItem(client, {
      nama_barang: "Laptop",
      tipe: "Aset",
      satuan: "pcs",
      tempat_utama: "Lab",
    });
    return result.id_barang;
  }
  async function unitDari(idBarang: string) {
    const daftar = await listInventory(client);
    const barang = daftar.barang.find((item) => item.id_barang === idBarang);
    return (barang?.posisi ?? []).filter((posisi) => posisi.kode_unit !== null);
  }

  test("masuk per unit membuat unit dan memindahkannya satu per satu", async () => {
    const idBarang = await asetBaru();
    await recordMutation(client, "admin", {
      id_barang: idBarang,
      jenis: "Masuk",
      alasan: "Pengadaan",
      jumlah: 3,
      tempat_tujuan: "Lab",
      per_unit: true,
    });
    const units = await unitDari(idBarang);
    expect(units.map((unit) => unit.kode_unit)).toEqual([
      "BRG-0001-01",
      "BRG-0001-02",
      "BRG-0001-03",
    ]);
    const nomor = await client.execute({
      sql: "SELECT COUNT(DISTINCT nomor_dokumen) AS n FROM inventory_mutasi WHERE id_barang = ? AND nomor_dokumen LIKE 'UNT-%';",
      args: [idBarang],
    });
    expect(Number(nomor.rows[0]?.n)).toBe(1);

    await expect(
      recordMutation(client, "admin", {
        id_barang: idBarang,
        jenis: "Pindah",
        alasan: "Distribusi",
        jumlah: 1,
        tempat_asal: "Lab",
        tempat_tujuan: "TU",
      }),
    ).rejects.toThrow("Pilih unit yang dicatat.");
    const kedua = units[1]?.id_batch as string;
    await recordMutation(client, "admin", {
      id_barang: idBarang,
      jenis: "Pindah",
      alasan: "Distribusi",
      jumlah: 1,
      tempat_asal: "Lab",
      tempat_tujuan: "TU",
      unit: [kedua],
    });
    expect(
      (await unitDari(idBarang)).find((u) => u.id_batch === kedua)?.tempat,
    ).toBe("TU");
    expect(await stok(idBarang)).toBe(3);
    await expect(
      recordMutation(client, "admin", {
        id_barang: idBarang,
        jenis: "Keluar",
        alasan: "Hilang",
        jumlah: 1,
        tempat_asal: "Lab",
        unit: [kedua],
      }),
    ).rejects.toThrow("Stok di Lab (Baik) hanya 0 pcs.");

    const pertama = units[0]?.id_batch as string;
    const pinjam = await recordMutation(client, "admin", {
      id_barang: idBarang,
      jenis: "Keluar",
      alasan: "Peminjaman",
      jumlah: 1,
      tempat_asal: "Lab",
      unit: [pertama],
      penerima_tipe: "Unit",
      penerima_nama: "Kelas X-A",
      keperluan: "Presentasi",
    });
    expect((await unitDari(idBarang)).some((u) => u.id_batch === pertama)).toBe(
      false,
    );
    await recordMutation(client, "admin", {
      id_barang: idBarang,
      jenis: "Masuk",
      alasan: "Pengembalian",
      jumlah: 1,
      tempat_tujuan: "Lab",
      id_ref: pinjam.id_mutasi,
    });
    expect(
      (await unitDari(idBarang)).some(
        (u) => u.id_batch === pertama && u.saldo === 1,
      ),
    ).toBe(true);

    const ketiga = units[2]?.id_batch as string;
    await saveUnit(client, { id_unit: ketiga, nomor_seri: "SN-778" });
    expect(
      (await unitDari(idBarang)).find((u) => u.id_batch === ketiga)?.nomor_seri,
    ).toBe("SN-778");
  });

  // Kembar `opname_counts_units_against_their_own_batch`.
  test("opname menghitung unit terhadap batch unitnya sendiri", async () => {
    const idBarang = await asetBaru();
    await recordMutation(client, "admin", {
      id_barang: idBarang,
      jenis: "Masuk",
      alasan: "Pengadaan",
      jumlah: 2,
      tempat_tujuan: "Lab",
      per_unit: true,
    });
    const units = await unitDari(idBarang);
    const baris = (fisik: [number, number]) =>
      units.map((unit, i) => ({
        id_barang: idBarang,
        kondisi: "Baik",
        id_batch: unit.id_batch,
        fisik: fisik[i] as number,
      }));
    const lengkap = await recordOpname(client, "admin", {
      tempat: "Lab",
      baris: baris([1, 1]),
    });
    expect(lengkap.jumlah_selisih).toBe(0);
    expect(await stok(idBarang)).toBe(2);
    await expect(
      recordOpname(client, "admin", {
        tempat: "Lab",
        baris: [{ ...baris([2, 1])[0] }],
      }),
    ).rejects.toThrow("Satu unit Laptop hanya bisa dihitung 0 atau 1.");
    const hilang = await recordOpname(client, "admin", {
      tempat: "Lab",
      baris: baris([1, 0]),
    });
    expect(hilang.jumlah_selisih).toBe(1);
    expect(await stok(idBarang)).toBe(1);
    expect((await unitDari(idBarang)).map((u) => u.id_batch)).toEqual([
      units[0]?.id_batch,
    ]);
  });

  test("pendaftaran unit mengubah stok lama tanpa mengubah jumlahnya", async () => {
    const idBarang = await asetBaru();
    await recordMutation(client, "admin", {
      id_barang: idBarang,
      jenis: "Masuk",
      alasan: "Saldo Awal",
      jumlah: 2,
      tempat_tujuan: "Lab",
    });
    await recordMutation(client, "admin", {
      id_barang: idBarang,
      jenis: "Masuk",
      alasan: "Saldo Awal",
      jumlah: 1,
      tempat_tujuan: "TU",
      kondisi_tujuan: "Rusak Ringan",
    });
    const hasil = await registerUnits(client, "admin", idBarang);
    expect(hasil.jumlah).toBe(3);
    expect(await stok(idBarang)).toBe(3);
    const daftar = await listInventory(client);
    const barang = daftar.barang.find((item) => item.id_barang === idBarang);
    expect(barang?.dilacak_unit).toBe(true);
    expect(barang?.posisi.every((posisi) => posisi.kode_unit !== null)).toBe(
      true,
    );
    expect(
      (await unitDari(idBarang)).filter((u) => u.tempat === "TU"),
    ).toHaveLength(1);

    await expect(registerUnits(client, "admin", idBarang)).rejects.toThrow(
      "Tidak ada stok yang belum terdaftar sebagai unit.",
    );
    const keluar = await client.execute({
      sql: "SELECT id_mutasi FROM inventory_mutasi WHERE id_barang = ? AND jenis = 'Keluar' AND alasan = 'Distribusi' LIMIT 1;",
      args: [idBarang],
    });
    await expect(
      cancelMutation(
        client,
        "admin",
        String(keluar.rows[0]?.id_mutasi),
        "salah",
      ),
    ).rejects.toThrow("Pendaftaran unit tidak bisa dibatalkan.");
    const habis = await barangBaru();
    await expect(registerUnits(client, "admin", habis)).rejects.toThrow(
      "Hanya aset tanpa kedaluwarsa yang bisa dicatat per unit.",
    );
  });
});

describe("kolom tambahan Web", () => {
  test("nama unik, tipe terkunci, batas kolom aktif", async () => {
    const { id_kolom } = await saveColumn(client, {
      nama: "Merek",
      tipe: "Teks",
    });
    expect(id_kolom).toMatch(/^kol-[0-9a-f]{32}$/);
    await expect(
      saveColumn(client, { nama: " merek ", tipe: "Teks" }),
    ).rejects.toThrow("Nama kolom sudah dipakai kolom lain.");
    await expect(
      saveColumn(client, { id_kolom, nama: "Merek", tipe: "Angka" }),
    ).rejects.toThrow("Tipe kolom tidak bisa diubah setelah dibuat.");
    await saveColumn(client, {
      id_kolom,
      nama: "Merk",
      tipe: "Teks",
      is_aktif: false,
    });

    for (let i = 0; i < 20; i += 1) {
      await saveColumn(client, { nama: `Kolom ${i}`, tipe: "Teks" });
    }
    // Kolom nonaktif tidak bisa diaktifkan lagi saat 20 kolom sudah aktif.
    await expect(
      saveColumn(client, {
        id_kolom,
        nama: "Merk",
        tipe: "Teks",
        is_aktif: true,
      }),
    ).rejects.toThrow("Maksimal 20 kolom tambahan aktif.");
    const daftar = await listInventory(client);
    expect(daftar.kolom).toHaveLength(21);
    // `created_at` berpresisi detik: kolom yang dibuat bersamaan urut id acak.
    expect(
      daftar.kolom.find((item) => item.id_kolom === id_kolom),
    ).toMatchObject({
      nama: "Merk",
      is_aktif: false,
    });
  });

  test("isi kolom tersimpan, divalidasi tipenya, dan kosong dibuang", async () => {
    const { id_kolom: berat } = await saveColumn(client, {
      nama: "Berat",
      tipe: "Angka",
    });
    await expect(
      saveItem(client, {
        nama_barang: "Karung",
        tipe: "Aset",
        satuan: "unit",
        atribut: { [berat]: "2,5" },
      }),
    ).rejects.toThrow("Isi kolom Berat harus angka.");
    const { id_barang } = await saveItem(client, {
      nama_barang: "Karung",
      tipe: "Aset",
      satuan: "unit",
      atribut: { [berat]: "2.5", "kol-ff": "  " },
    });
    const daftar = await listInventory(client);
    expect(
      daftar.barang.find((item) => item.id_barang === id_barang)?.atribut,
    ).toEqual({
      [berat]: "2.5",
    });
  });
});

describe("hapus permanen kolom tambahan Web", () => {
  test("isi dibuang dari barang, nama bisa dipakai lagi, tidak bisa dihidupkan", async () => {
    const { id_kolom } = await saveColumn(client, {
      nama: "Merek",
      tipe: "Teks",
    });
    const draft = {
      nama_barang: "Spidol",
      tipe: "Habis Pakai",
      satuan: "pcs",
      atribut: { [id_kolom]: "Pilot" },
    };
    const { id_barang } = await saveItem(client, draft);
    await saveItem(client, {
      nama_barang: "Kapur",
      tipe: "Habis Pakai",
      satuan: "pcs",
    });

    expect(await deleteColumn(client, id_kolom)).toEqual({
      sukses: true,
      barang_dibersihkan: 1,
    });
    const daftar = await listInventory(client);
    expect(daftar.kolom).toEqual([]);
    expect(
      daftar.barang.find((item) => item.id_barang === id_barang)?.atribut,
    ).toEqual({});

    // Isi lama dari perangkat yang belum sinkron dibuang saat disimpan.
    await saveItem(client, { ...draft, id_barang });
    const ulang = await listInventory(client);
    expect(
      ulang.barang.find((item) => item.id_barang === id_barang)?.atribut,
    ).toEqual({});

    await expect(
      saveColumn(client, { id_kolom, nama: "Merek", tipe: "Teks" }),
    ).rejects.toThrow("Kolom ini sudah dihapus.");
    await expect(deleteColumn(client, id_kolom)).rejects.toThrow(
      "Kolom ini sudah dihapus.",
    );
    await saveColumn(client, { nama: "Merek", tipe: "Teks" });
  });
});

// Kembar `delete_item_only_when_every_mutation_is_cancelled`,
// `delete_item_refuses_items_with_units`, dan
// `delete_inactive_item_once_used_up_keeps_its_code` di inventory.rs.
describe("hapus barang Web", () => {
  test("hanya bila setiap mutasinya dibatalkan, lalu kodenya bebas", async () => {
    const idBarang = await barangBaru();
    const masuk = await recordMutation(client, "admin", {
      id_barang: idBarang,
      jenis: "Masuk",
      alasan: "Saldo Awal",
      jumlah: 3,
      tempat_tujuan: "Gudang",
    });
    await expect(deleteItem(client, idBarang)).rejects.toThrow(
      "Barang ini belum bisa dihapus",
    );
    await cancelMutation(client, "admin", masuk.id_mutasi, "Salah input");
    expect(await deleteItem(client, idBarang)).toEqual({ sukses: true });

    expect((await listInventory(client)).barang).toEqual([]);
    await expect(deleteItem(client, idBarang)).rejects.toThrow(
      "Barang ini sudah dihapus.",
    );
    await expect(
      saveItem(client, {
        id_barang: idBarang,
        nama_barang: "Ganti",
        tipe: "Habis Pakai",
        satuan: "pcs",
      }),
    ).rejects.toThrow("Barang ini sudah dihapus.");
    await saveItem(client, {
      kode_barang: "BRG-0001",
      nama_barang: "Pengganti",
      tipe: "Habis Pakai",
      satuan: "pcs",
    });

    // Mutasi dari perangkat yang offline saat barangnya dihapus.
    await mutasiMentah("mts-telat", idBarang, "Masuk", 2);
    const barang = (await listInventory(client)).barang.find(
      (item) => item.id_barang === idBarang,
    );
    expect(barang?.bisa_dihapus).toBe(false);
    expect(barang?.status_aktif).toBe(false);
  });

  test("menolak barang yang sudah punya unit", async () => {
    const idBarang = await barangBaru();
    await client.execute({
      sql: "INSERT INTO inventory_unit (id_unit, id_barang, kode_unit) VALUES ('unit-1', ?, 'BRG-0001-001');",
      args: [idBarang],
    });
    await expect(deleteItem(client, idBarang)).rejects.toThrow();
  });
  test("barang nonaktif yang habis dipakai bisa dihapus, kodenya tetap dicadangkan", async () => {
    const idBarang = await barangBaru();
    const setAktif = (aktif: number) =>
      client.execute({
        sql: "UPDATE inventory_barang SET status_aktif = ? WHERE id_barang = ?;",
        args: [aktif, idBarang],
      });
    await mutasiMentah("mts-awal", idBarang, "Masuk", 10);
    const { id_mutasi: idPinjam } = await recordMutation(client, "admin", {
      id_barang: idBarang,
      jenis: "Keluar",
      alasan: "Peminjaman",
      jumlah: 4,
      tempat_asal: "Gudang",
      penerima_tipe: "Unit",
      penerima_nama: "Lab IPA",
      keperluan: "KBM",
    });
    await mutasiMentah("mts-pakai", idBarang, "Keluar", 6);
    await setAktif(0);
    // Stok 0, tetapi 4 masih dipinjam.
    await expect(deleteItem(client, idBarang)).rejects.toThrow(
      "Barang ini belum bisa dihapus",
    );

    // Barang nonaktif tidak menerima barang masuk, termasuk pengembalian.
    await setAktif(1);
    await recordMutation(client, "admin", {
      id_barang: idBarang,
      jenis: "Masuk",
      alasan: "Pengembalian",
      jumlah: 4,
      tempat_tujuan: "Gudang",
      id_ref: idPinjam,
    });
    await setAktif(0);
    await expect(deleteItem(client, idBarang)).rejects.toThrow(
      "Barang ini belum bisa dihapus",
    );

    await mutasiMentah("mts-habis", idBarang, "Keluar", 4);
    await client.execute({
      sql: `INSERT INTO inventory_servis (id_servis, id_barang, jumlah, tempat, kondisi_awal,
              tanggal_mulai, keluhan, dibuka_oleh)
            VALUES ('srv-1', ?, 1, 'Gudang', 'Rusak Ringan', '2026-10-01', 'Retak', 'uji');`,
      args: [idBarang],
    });
    await expect(deleteItem(client, idBarang)).rejects.toThrow(
      "Barang ini belum bisa dihapus",
    );
    await client.execute(
      "UPDATE inventory_servis SET dibatalkan_pada = datetime('now') WHERE id_servis = 'srv-1';",
    );

    await setAktif(1);
    await expect(deleteItem(client, idBarang)).rejects.toThrow(
      "Barang ini belum bisa dihapus",
    );
    await setAktif(0);
    expect(await deleteItem(client, idBarang)).toEqual({ sukses: true });

    expect((await listInventory(client)).barang).toEqual([]);
    await expect(
      saveItem(client, {
        kode_barang: "BRG-0001",
        nama_barang: "Pengganti",
        tipe: "Habis Pakai",
        satuan: "pcs",
      }),
    ).rejects.toThrow("Kode barang sudah dipakai barang lain");
    // Nomor otomatis melompati kode yang dicadangkan.
    const baru = await saveItem(client, {
      nama_barang: "Pengganti",
      tipe: "Habis Pakai",
      satuan: "pcs",
    });
    expect(baru.kode_barang).not.toBe("BRG-0001");
  });
});

// Kembar `decimal_items_lock_after_history_and_round_procurement_value` di inventory.rs.
describe("barang desimal Web", () => {
  test("terkunci sejak mutasi pertama, nilai pengadaan dibulatkan per baris", async () => {
    const simpan = (extra: Record<string, unknown>) =>
      saveItem(client, {
        nama_barang: "Beras",
        tipe: "Habis Pakai",
        satuan: "kg",
        tempat_utama: "Gudang",
        desimal: true,
        ...extra,
      });
    const { id_barang: idBarang } = await simpan({});
    await simpan({ id_barang: idBarang, desimal: false });
    await simpan({ id_barang: idBarang, desimal: true });

    for (const [jumlah, harga] of [
      [1025, 12_345],
      [5, 10],
    ] as const) {
      await recordMutation(client, "admin", {
        id_barang: idBarang,
        jenis: "Masuk",
        alasan: "Pengadaan",
        jumlah,
        tempat_tujuan: "Gudang",
        harga_satuan: harga,
      });
    }
    const hari = await client.execute(
      "SELECT date('now', '+7 hours') AS hari;",
    );
    const rekap = await procurement(
      client,
      "2000-01-01",
      String(hari.rows[0]?.hari),
    );
    expect(rekap.total_nilai).toBe(126_537);
    expect(rekap.baris[0]?.desimal).toBe(true);

    const barang = (await listInventory(client)).barang[0];
    expect(barang?.stok_total).toBe(1030);
    expect(barang?.desimal).toBe(true);
    expect(barang?.punya_mutasi).toBe(true);
    await expect(
      simpan({ id_barang: idBarang, desimal: false }),
    ).rejects.toThrow("Tipe, satuan, desimal, dan pengaturan kedaluwarsa");
    await expect(simpan({ tipe: "Aset" })).rejects.toThrow(
      "Jumlah desimal hanya untuk barang Habis Pakai.",
    );
  });
});
