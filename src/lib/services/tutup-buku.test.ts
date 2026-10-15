import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Client, createClient } from "@libsql/client";
import { initDatabaseSchema } from "@/lib/db-schema";

mock.module("server-only", () => ({}));

const { postJournal } = await import("@/lib/services/accounting");
const { close, decide, reopen, review, revise, status } = await import(
  "@/lib/services/tutup-buku"
);

let client: Client;
let testDirectory: string;

beforeAll(async () => {
  testDirectory = mkdtempSync(join(tmpdir(), "kos-tutup-buku-"));
  client = createClient({ url: `file:${join(testDirectory, "test.db")}` });
  await initDatabaseSchema(client);
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

const jurnal = (tanggal: string) =>
  postJournal(client, "tu", {
    tanggal,
    keterangan: "Uji",
    baris: [
      { id_akun: "akun-kas", debit: 100000 },
      { id_akun: "akun-pendapatan-usaha", kredit: 100000 },
    ],
  });

// Cermin `tutup_tolak_lalu_buka_kembali` di `desktop/tutup_buku.rs`.
describe("tutup buku Web", () => {
  test("tutup, tolak, lalu buka kembali", async () => {
    await jurnal("2020-01-15");
    const hasil = await close(client, "kepala", "2020-01-31");
    expect(hasil.tutup.saldo_json).toContain(
      '{"id_akun":"akun-kas","debit":100000,"kredit":0}',
    );
    expect(hasil.tutup.kode_perangkat).toBe("WEB");
    expect(hasil.tutup.diterima_cloud).not.toBeNull();
    expect((await status(client)).batas).toBe("2020-01-31");

    await expect(jurnal("2020-01-31")).rejects.toThrow(
      "Tanggal 31/01/2020 masuk periode yang sudah ditutup",
    );
    await jurnal("2020-02-01");

    await expect(close(client, "kepala", "2020-01-31")).rejects.toThrow(
      "Buku sudah ditutup sampai 31/01/2020. Pilih tanggal sesudahnya.",
    );
    await expect(reopen(client, "kepala", " ")).rejects.toThrow(
      "Alasan membuka kembali wajib diisi.",
    );
    expect(
      (await reopen(client, "kepala", "Kuitansi Januari tertinggal")).batas,
    ).toBeNull();
    await jurnal("2020-01-20");
    await expect(reopen(client, "kepala", "Lagi")).rejects.toThrow(
      "Belum ada periode yang ditutup.",
    );
    const riwayat = (await status(client)).riwayat;
    expect(riwayat[0]?.status).toBe("Dibuka");
    expect(riwayat[0]?.alasan_buka).toBe("Kuitansi Januari tertinggal");
  });
});

// Cermin `transaksi_telat_ditinjau_lalu_ditutup_ulang` dan
// `versi_menunggu_dipakai_atau_ditolak` di `desktop/tutup_buku.rs`.
describe("tutup buku Web: Tahap 2", () => {
  test("transaksi telat ditinjau lalu ditutup ulang", async () => {
    await jurnal("2021-01-15");
    const lama = (await close(client, "kepala", "2021-01-31")).tutup.id_tutup;
    expect((await status(client)).perlu_perhatian).toBe(0);
    await client.batch(
      [
        `INSERT INTO keu_jurnal (id_jurnal, tanggal, seri, nomor_urut, nomor, keterangan, sumber, dibuat_oleh, created_at)
         VALUES ('jrn-telat', '2021-01-20', 'M1234', 1, 'JU/2021/M1234/0001', 'SPP dari HP offline', 'Manual', 'bendahara', datetime('now', '+1 minute'));`,
        `INSERT INTO keu_jurnal_baris (id_baris, id_jurnal, id_akun, debit, kredit, urutan) VALUES
           ('jrn-telat-1', 'jrn-telat', 'akun-kas', 50000, 0, 1),
           ('jrn-telat-2', 'jrn-telat', 'akun-pendapatan-usaha', 0, 50000, 2);`,
      ],
      "write",
    );
    const st = await status(client);
    expect(st.perlu_perhatian).toBe(1);
    expect(st.riwayat.find((t) => t.id_tutup === lama)?.perlu_ditinjau).toBe(
      true,
    );
    const tinjau = await review(client, lama);
    const kas = tinjau.selisih.find((b) => b.id_akun === "akun-kas");
    expect(kas?.sesudah).toBe((kas?.sebelum ?? 0) + 50000);
    expect(tinjau.jurnal[0]?.id_jurnal).toBe("jrn-telat");
    expect(tinjau.jurnal[0]?.total).toBe(50000);

    const baru = await revise(client, "kepala", lama, "");
    expect(baru.tutup.status).toBe("Aktif");
    expect((await status(client)).perlu_perhatian).toBe(0);
    const riwayat = (await status(client)).riwayat;
    const versiLama = riwayat.find((t) => t.id_tutup === lama);
    expect(versiLama?.status).toBe("Digantikan");
    expect(versiLama?.catatan_keputusan).toBe(
      "Ditutup ulang dengan saldo sekarang.",
    );
    await expect(
      revise(client, "kepala", baru.tutup.id_tutup, ""),
    ).rejects.toThrow("Saldo periode ini tidak berubah sejak ditutup.");
  });

  test("versi yang menunggu dipakai", async () => {
    const berlaku = (await status(client)).riwayat.find(
      (t) => t.status === "Aktif",
    );
    if (!berlaku) throw new Error("tidak ada tutup buku berlaku");
    await client.execute({
      sql: `INSERT INTO keu_tutup_buku (id_tutup, sampai_tanggal, dibuat_oleh, kode_perangkat, waktu_perangkat, diterima_cloud, saldo_json, status) VALUES
              ('tb-hp', ?, 'bendahara', 'A9F3', '2021-02-01 07:00:00', '2021-02-03 10:00:00', '[]', 'Menunggu');`,
      args: [berlaku.sampai_tanggal],
    });
    expect((await status(client)).perlu_perhatian).toBe(1);
    const tinjau = await review(client, "tb-hp");
    expect(tinjau.pembanding?.id_tutup).toBe(berlaku.id_tutup);
    expect(tinjau.selisih.length).toBeGreaterThan(0);
    await expect(
      decide(client, "kepala", "tb-hp", "abaikan", ""),
    ).rejects.toThrow("Keputusan tidak dikenal.");
    await expect(
      decide(client, "kepala", berlaku.id_tutup, "pakai", ""),
    ).rejects.toThrow(
      "Hanya tutup buku yang menunggu keputusan yang bisa diputuskan.",
    );
    await decide(client, "kepala", "tb-hp", "pakai", "Sesuai buku kas");
    const riwayat = (await status(client)).riwayat;
    expect(riwayat.find((t) => t.id_tutup === "tb-hp")?.status).toBe("Aktif");
    const digantikan = riwayat.find((t) => t.id_tutup === berlaku.id_tutup);
    expect(digantikan?.status).toBe("Digantikan");
    expect(digantikan?.diputuskan_oleh).toBe("kepala");
  });
});
