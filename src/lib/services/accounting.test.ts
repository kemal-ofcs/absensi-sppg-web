import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Client, createClient } from "@libsql/client";
import { initDatabaseSchema } from "@/lib/db-schema";

mock.module("server-only", () => ({}));

const {
  listAccounts,
  listJournals,
  ledger,
  postJournal,
  reportActivity,
  reportCashflow,
  reportPosition,
  reverseJournal,
  saveAccount,
  trialBalance,
} = await import("@/lib/services/accounting");

// Berkas sungguhan, bukan `file::memory:`: transaksi libSQL lokal membuka
// koneksi baru, dan database memori di koneksi baru selalu kosong. Satu klien
// per berkas, pola `inventory.test.ts`.
let client: Client;
let testDirectory: string;

beforeAll(async () => {
  testDirectory = mkdtempSync(join(tmpdir(), "kos-accounting-web-"));
  client = createClient({ url: `file:${join(testDirectory, "test.db")}` });
  await initDatabaseSchema(client);
});

// Di Windows berkas SQLite bisa masih terkunci sesaat setelah `close()`.
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

function jurnal(
  tanggal: string,
  debitAkun: string,
  kreditAkun: string,
  nominal: number,
) {
  return postJournal(client, "bendahara", {
    tanggal,
    keterangan: "Uji",
    baris: [
      { id_akun: debitAkun, debit: nominal },
      { id_akun: kreditAkun, kredit: nominal },
    ],
  });
}

// Cermin `seed_akun_ditanam_tanpa_outbox`, `posting_pembalik_dan_laporan`,
// dan `akun_nonaktif_dan_kode_ganda_ditolak` di `desktop/accounting.rs`.
describe("akuntansi Web terhadap skema cloud asli", () => {
  test("bagan akun bawaan tertanam", async () => {
    const { items } = await listAccounts(client);
    expect(items.length).toBe(24);
    expect(items.find((akun) => akun.id_akun === "akun-kas")?.sistem).toBe(
      true,
    );
  });

  test("posting, pembatalan, neraca saldo, dan buku besar", async () => {
    const pertama = await jurnal(
      "2026-09-30",
      "akun-kas",
      "akun-modal",
      10_000_000,
    );
    const kedua = await jurnal(
      "2026-10-05",
      "akun-beban-atk",
      "akun-kas",
      250_000,
    );
    expect(pertama.nomor).toBe("JU/2026/WEB/0001");
    expect(kedua.nomor).toBe("JU/2026/WEB/0002");

    const batal = await reverseJournal(
      client,
      "kepala",
      kedua.id_jurnal,
      "Salah catat",
    );
    expect(batal.id_jurnal).toBe(`batal-${kedua.id_jurnal}`);
    await expect(
      reverseJournal(client, "kepala", kedua.id_jurnal, "Lagi"),
    ).rejects.toThrow("Jurnal ini sudah dibatalkan.");
    await expect(
      reverseJournal(client, "kepala", batal.id_jurnal, "x"),
    ).rejects.toThrow("Jurnal pembalik tidak bisa dibatalkan lagi.");

    const neraca = await trialBalance(client, "2099-12-31");
    expect(neraca.total_debit).toBe(neraca.total_kredit);
    const kas = neraca.items.find((item) => item.id_akun === "akun-kas");
    expect(kas?.debit).toBe(10_000_000);

    const buku = await ledger(client, "akun-kas", "2026-10-01", "2099-12-31");
    expect(buku.saldo_awal).toBe(10_000_000);
    expect(buku.saldo_akhir).toBe(10_000_000);
    expect(buku.baris.length).toBe(2);

    const { items } = await listJournals(
      client,
      "2026-01-01",
      "2099-12-31",
      "Manual",
    );
    expect(items.length).toBe(2);
    expect(items.some((item) => item.dibatalkan)).toBe(true);

    // Laporan keuangan (K4a), cermin asersi `posting_pembalik_dan_laporan`.
    const posisi = await reportPosition(client, "2099-12-31");
    expect(posisi.total_aset).toBe(10_000_000);
    expect(posisi.total_ekuitas).toBe(10_000_000);
    expect(posisi.laba_berjalan).toBe(0);
    expect(posisi.selisih).toBe(0);
    const aktivitas = await reportActivity(client, "2026-10-05", "2026-10-05");
    expect(aktivitas.total_beban).toBe(250_000);
    expect(aktivitas.laba_bersih).toBe(-250_000);
    const arus = await reportCashflow(client, "2026-10-01", "2099-12-31", [
      "akun-kas",
    ]);
    expect(arus.saldo_awal).toBe(10_000_000);
    expect(arus.kelompok.length).toBe(1);
    expect(arus.kelompok[0]?.label).toBe("Jurnal umum");
    expect(arus.kelompok[0]?.masuk).toBe(250_000);
    expect(arus.kelompok[0]?.keluar).toBe(250_000);
    expect(arus.saldo_akhir).toBe(10_000_000);
    await expect(
      reportCashflow(client, "2026-10-01", "2026-10-31", ["akun-beban-atk"]),
    ).rejects.toThrow("Akun kas harus akun aset.");
    await expect(
      reportCashflow(client, "2026-10-01", "2026-10-31", [" "]),
    ).rejects.toThrow("Pilih minimal satu akun kas.");
  });

  test("kode ganda dan akun nonaktif ditolak", async () => {
    await expect(
      saveAccount(client, {
        kode: "1-1100",
        nama: "Kas Kedua",
        kelompok: "Aset",
        saldo_normal: "Debit",
      }),
    ).rejects.toThrow("Kode akun sudah dipakai akun lain.");

    const baru = await saveAccount(client, {
      kode: "5-1700",
      nama: "Beban Transport",
      kelompok: "Beban",
      saldo_normal: "Debit",
      is_aktif: false,
    });
    await expect(
      postJournal(client, "bendahara", {
        tanggal: "2026-10-12",
        keterangan: "Ongkos",
        baris: [
          { id_akun: "akun-kas", kredit: 50_000 },
          { id_akun: baru.id_akun, debit: 50_000 },
        ],
      }),
    ).rejects.toThrow("Baris 2: akun tidak ditemukan atau nonaktif.");
  });

  test("akun sistem tidak bisa dinonaktifkan", async () => {
    await expect(
      saveAccount(client, {
        id_akun: "akun-kas",
        kode: "1-1100",
        nama: "Kas Besar",
        kelompok: "Aset",
        saldo_normal: "Debit",
        is_aktif: false,
      }),
    ).rejects.toThrow("Akun sistem tidak bisa dinonaktifkan.");
  });
});
