import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Client, createClient } from "@libsql/client";
import { AuthorizationError } from "@/lib/auth/permission-assertion";
import { initDatabaseSchema } from "@/lib/db-schema";
import type { OperatorDraft } from "@/lib/operators/types";

mock.module("server-only", () => ({}));
const {
  DAFTAR_JENIS_KENDARAAN,
  DAFTAR_KATEGORI_TUJUAN,
  aturPenerimaUpah,
  batalBayarUpah,
  catatBayarUpah,
  catatLaporanDispatcher,
  daftarBayarUpah,
  rekapUpah,
  simpanDaftarTarif,
  simpanKendaraan,
  simpanLokasi,
  simpanPerjalanan,
  tandaiDicetak,
  daftarPerjalanan,
  fotoLaporan,
  fotoSegeraDihapus,
  hapusFotoLama,
  masterPerjalanan,
  rincianPerjalanan,
  simpanPrefix,
} = await import("./driver");
const { editOperator, insertOperator } = await import(
  "@/lib/operators/operator-admin"
);

// Alur yang sama dengan `tests_lokal` di `desktop/driver.rs`, versi Web
// (dispatcher saja; laporan driver hanya dari aplikasi).

let client: Client;
let testDirectory: string;

beforeAll(async () => {
  testDirectory = mkdtempSync(join(tmpdir(), "kos-driver-"));
  client = createClient({ url: `file:${join(testDirectory, "test.db")}` });
  await initDatabaseSchema(client);
  await client.batch(
    [
      `INSERT INTO master_data (id_unik, nama, divisi, id_shift, status_aktif) VALUES
         ('d1', 'Budi', 'Armada', 1, 'Aktif'),
         ('d2', 'Joko', 'Armada', 1, 'Aktif'),
         ('d3', 'Lama', 'Armada', 1, 'Nonaktif');`,
      "INSERT OR REPLACE INTO setting_gex_system (key, value) VALUES ('sj_prefix', 'krs');",
    ],
    "write",
  );
});

afterAll(async () => {
  client.close();
  await Bun.sleep(50);
  try {
    rmSync(testDirectory, { recursive: true, force: true });
  } catch {
    // Windows kadang masih memegang berkasnya; direktori sementara dibiarkan.
  }
});

async function galat(janji: Promise<unknown>): Promise<string> {
  try {
    await janji;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("diharapkan galat");
}

describe("penulisan Web perjalanan driver", () => {
  test("master, surat jalan, dan laporan dispatcher", async () => {
    const tanpaIzin = simpanDaftarTarif(client, DAFTAR_JENIS_KENDARAAN, false, {
      nama: "Truk",
      tarif: 150000,
    });
    expect(tanpaIzin).rejects.toBeInstanceOf(AuthorizationError);
    await tanpaIzin.catch(() => undefined);
    const jenis = (
      await simpanDaftarTarif(client, DAFTAR_JENIS_KENDARAAN, true, {
        nama: "Truk",
        tarif: 150000,
      })
    ).id;
    const kategori = (
      await simpanDaftarTarif(client, DAFTAR_KATEGORI_TUJUAN, true, {
        nama: "Luar Kota",
        tarif: 200000,
      })
    ).id;
    expect(
      await galat(
        simpanDaftarTarif(client, DAFTAR_KATEGORI_TUJUAN, true, {
          nama: " luar kota ",
        }),
      ),
    ).toBe("Nama kategori tujuan sudah dipakai.");
    const k1 = (
      await simpanKendaraan(client, {
        id_jenis: jenis,
        identitas: "b 1234 xyz",
      })
    ).id;
    expect(
      await galat(
        simpanKendaraan(client, { id_jenis: jenis, identitas: "B 1234  XYZ" }),
      ),
    ).toBe("Plat atau nomor kendaraan sudah terdaftar.");
    const k2 = (
      await simpanKendaraan(client, {
        id_jenis: jenis,
        identitas: "B 5678 ABC",
      })
    ).id;
    await simpanLokasi(client, {
      nama: "Pool Cikarang",
      jenis: "Pool",
      lat: -6.28,
      lng: 107.17,
    });

    const muatan = [
      {
        tempat_muat: "Gudang A",
        tempat_bongkar: "Toko B",
        nama_barang: "Semen",
        qty: 10,
        satuan: "sak",
        berat_kg_x100: 50000,
      },
      {
        tempat_muat: "Gudang A",
        nama_barang: "Pasir",
        qty: 2,
        satuan: "karung",
      },
    ];
    const surat = (id: string | null, driver: string, isi: unknown[]) => ({
      id_perjalanan: id,
      tanggal: "2026-11-09",
      id_karyawan: driver,
      id_kendaraan: k1,
      id_kategori: kategori,
      muatan: isi,
    });
    expect(
      await galat(simpanPerjalanan(client, "admin", surat(null, "d3", muatan))),
    ).toBe("Driver tidak ditemukan atau nonaktif.");
    const trp = (
      await simpanPerjalanan(client, "admin", surat(null, "d1", muatan))
    ).id_perjalanan;
    await simpanPerjalanan(client, "admin", surat(null, "d2", muatan));
    const nomor = await client.execute(
      "SELECT nomor, tarif_kendaraan, tarif_tujuan FROM drv_perjalanan ORDER BY nomor_urut;",
    );
    expect(nomor.rows.map((r) => String(r.nomor))).toEqual([
      "KRS-2611-WEB-001",
      "KRS-2611-WEB-002",
    ]);
    expect([
      Number(nomor.rows[0]?.tarif_kendaraan),
      Number(nomor.rows[0]?.tarif_tujuan),
    ]).toEqual([150_000, 200_000]);

    // Sunting selama Direncanakan: muatan yang dibuang ikut hilang, cetak ulang.
    await tandaiDicetak(client, trp);
    await simpanPerjalanan(client, "admin", surat(trp, "d1", [muatan[0]]));
    const setelah = await client.execute({
      sql: `SELECT (SELECT COUNT(*) FROM drv_muatan WHERE id_perjalanan = ?) AS n,
                   (SELECT dicetak_pada FROM drv_perjalanan WHERE id_perjalanan = ?) AS cetak;`,
      args: [trp, trp],
    });
    expect(Number(setelah.rows[0]?.n)).toBe(1);
    expect(setelah.rows[0]?.cetak).toBeNull();

    // Laporan dispatcher: tanpa GPS dan foto, ganti selalu Langsung.
    expect(
      await galat(
        catatLaporanDispatcher(client, "admin", {
          id_perjalanan: trp,
          jenis: "Dibatalkan",
          keterangan: "Batal order",
          waktu_perangkat: "2026-11-09 01:00:00",
        }),
      ),
    ).toBe("Perjalanan belum berangkat. Pakai Tidak Jalan.");
    expect(
      await galat(
        catatLaporanDispatcher(client, "admin", {
          id_perjalanan: trp,
          jenis: "Ganti Kendaraan",
          id_kendaraan_baru: k1,
          waktu_perangkat: "2026-11-09 01:00:00",
        }),
      ),
    ).toBe("Kendaraan pengganti sama dengan kendaraan yang bertugas.");
    const ganti = {
      id_laporan: "lap-ganti",
      id_perjalanan: trp,
      jenis: "Ganti Kendaraan",
      mode_ganti: "Darurat",
      id_kendaraan_baru: k2,
      waktu_perangkat: "2026-11-09 01:00:00",
    };
    await catatLaporanDispatcher(client, "admin", ganti);
    expect(
      (await catatLaporanDispatcher(client, "admin", ganti)).sudah_tercatat,
    ).toBe(true);
    const tersimpan = await client.execute({
      sql: "SELECT mode_ganti, diterima_cloud, lat FROM drv_laporan WHERE id_laporan = 'lap-ganti';",
    });
    expect(tersimpan.rows[0]?.mode_ganti).toBe("Langsung");
    expect(tersimpan.rows[0]?.diterima_cloud).not.toBeNull();
    expect(tersimpan.rows[0]?.lat).toBeNull();

    expect(await galat(aturPenerimaUpah(client, trp, "d2"))).toBe(
      "Upah hanya untuk surat jalan yang Selesai.",
    );
    await catatLaporanDispatcher(client, "admin", {
      id_perjalanan: trp,
      jenis: "Tidak Jalan",
      keterangan: "Pelanggan menunda",
      waktu_perangkat: "2026-11-09 02:00:00",
    });
    expect(
      await galat(simpanPerjalanan(client, "admin", surat(trp, "d1", muatan))),
    ).toBe("Surat jalan yang sudah berjalan atau ditutup tidak bisa diubah.");
  });

  test("tautan akun Driver ke personil", async () => {
    const role = await client.execute(
      "SELECT id FROM app_role WHERE role_key = 'driver';",
    );
    const roleId = Number(role.rows[0]?.id);
    const izin = await client.execute({
      sql: "SELECT permission_key FROM role_permission WHERE role_id = ?;",
      args: [roleId],
    });
    expect(izin.rows.map((r) => String(r.permission_key))).toEqual([
      "trip.report",
    ]);

    const draft = (
      kode: string,
      idKaryawan?: string | null,
    ): OperatorDraft => ({
      kodeOperator: kode,
      name: `Driver ${kode}`,
      username: kode.toLowerCase(),
      email: `${kode.toLowerCase()}@contoh.id`,
      noHp: "0812-3456-7890",
      password: "Rahasia-Driver-2026!",
      roleId,
      status: "Aktif",
      idKaryawan,
    });
    expect(await galat(insertOperator(client, draft("DRV01", "d3")))).toBe(
      "Personil tidak ditemukan atau nonaktif.",
    );
    const { id } = await insertOperator(client, draft("DRV01", "d1"));
    expect(await galat(insertOperator(client, draft("DRV02", "d1")))).toBe(
      "Personil ini sudah punya akun aktif lain.",
    );

    // Personil dinonaktifkan: akun tetap bisa disunting (mis. dinonaktifkan),
    // tetapi tidak bisa ditautkan ulang ke personil nonaktif lain.
    await client.execute(
      "UPDATE master_data SET status_aktif = 'Nonaktif' WHERE id_unik = 'd1';",
    );
    await editOperator(client, 1, id, {
      ...draft("DRV01"),
      status: "Nonaktif",
    });
    expect(await galat(editOperator(client, 1, id, draft("DRV01", "d3")))).toBe(
      "Personil tidak ditemukan atau nonaktif.",
    );
    await editOperator(client, 1, id, draft("DRV01", null));
    const lepas = await client.execute({
      sql: "SELECT id_karyawan FROM master_operator WHERE id = ?;",
      args: [id],
    });
    expect(lepas.rows[0]?.id_karyawan).toBeNull();
  });

  test("pembacaan layar dispatcher (cermin tes Rust)", async () => {
    const master = await masterPerjalanan(client);
    expect(master.prefix).toBe("KRS");
    expect(master.jenis.map((j) => j.nama)).toEqual(["Truk"]);
    expect(master.kendaraan).toHaveLength(2);

    const { items } = await daftarPerjalanan(
      client,
      "2026-11-01",
      "2026-11-30",
    );
    expect(items).toHaveLength(2);
    const tidakJalan = items.find((i) => i.nomor === "KRS-2611-WEB-001");
    expect(tidakJalan?.status).toBe("Tidak Jalan");
    // Ganti kendaraan dari dispatcher langsung berlaku.
    expect(tidakJalan?.identitas_kendaraan).toBe("B 5678 ABC");
    expect(tidakJalan?.upah).toBe(350_000);
    expect(tidakJalan?.penerima_upah).toBeNull();
    expect(tidakJalan?.laporan_terakhir?.jenis).toBe("Tidak Jalan");

    const rincian = await rincianPerjalanan(
      client,
      String(tidakJalan?.id_perjalanan),
    );
    expect(rincian.muatan).toHaveLength(1);
    expect(rincian.laporan.map((l) => l.jenis)).toEqual([
      "Ganti Kendaraan",
      "Tidak Jalan",
    ]);
    expect(rincian.laporan[0]?.foto_lokal).toBe(0);
    expect(await fotoLaporan(client, "lap-ganti")).toBeNull();
    expect(
      await galat(daftarPerjalanan(client, "2026-11-30", "2026-11-01")),
    ).toBe("Rentang tanggal tidak valid.");

    await simpanPrefix(client, "kos-");
    expect((await masterPerjalanan(client)).prefix).toBe("KOS");
  });

  test("foto dihapus setelah 90 hari menurut jam database", async () => {
    await client.execute(
      `INSERT INTO drv_laporan_foto (id_laporan, mime_type, data_base64, created_at) VALUES
         ('lap-ganti', 'image/jpeg', 'AAAA', datetime('now', '-91 days')),
         ('lap-x', 'image/jpeg', 'AAAA', datetime('now', '-85 days')),
         ('lap-y', 'image/jpeg', 'AAAA', datetime('now', '-10 days'));`,
    );
    expect(await fotoSegeraDihapus(client)).toEqual({
      jumlah: 2,
      tanggal_tertua: "2026-11-09",
    });
    expect(await hapusFotoLama(client)).toEqual({ cloud: 1 });
    expect(await fotoLaporan(client, "lap-ganti")).toBeNull();
    expect(await fotoLaporan(client, "lap-x")).not.toBeNull();
    expect((await fotoSegeraDihapus(client)).jumlah).toBe(1);
    const laporan = await client.execute(
      "SELECT COUNT(*) AS n FROM drv_laporan WHERE id_laporan = 'lap-ganti';",
    );
    expect(Number(laporan.rows[0]?.n)).toBe(1);
  });

  test("pembayaran upah (cermin tes Rust)", async () => {
    await client.batch(
      [
        `INSERT INTO drv_perjalanan (id_perjalanan, tanggal, seri, nomor_urut, nomor,
           id_karyawan, id_kendaraan, id_jenis, id_kategori, tarif_kendaraan, tarif_tujuan, dibuat_oleh)
         VALUES ('u1', '2027-01-09', 'WEB', 1, 'KRS-1', 'd1', 'k1', 'j1', 'c1', 150000, 200000, 'admin'),
                ('u2', '2027-01-09', 'WEB', 2, 'KRS-2', 'd1', 'k1', 'j1', 'c1', 100000, 50000, 'admin'),
                ('u3', '2027-01-10', 'WEB', 3, 'KRS-3', 'd1', 'k1', 'j1', 'c1', 100000, 0, 'admin');`,
        `INSERT INTO drv_laporan (id_laporan, id_perjalanan, jenis, waktu_perangkat, id_karyawan, dilaporkan_oleh)
         VALUES ('us1', 'u1', 'Selesai', '2027-01-09 10:00:00', 'd1', 'd1'),
                ('us2', 'u2', 'Selesai', '2027-01-09 12:00:00', 'd1', 'd1');`,
      ],
      "write",
    );
    const bayar = (driver: string, ids: string[]) =>
      catatBayarUpah(client, "kasir", {
        id_karyawan: driver,
        tanggal: "2027-01-31",
        id_perjalanan: ids,
      });

    expect(await galat(bayar("d1", ["u1", "u3"]))).toBe(
      "Surat jalan KRS-3 berstatus Direncanakan; hanya surat jalan Selesai yang dibayar.",
    );
    expect(await galat(bayar("d2", ["u1"]))).toBe(
      "Upah surat jalan KRS-1 bukan milik driver ini.",
    );
    expect(await galat(catatBayarUpah(client, "kasir", { total: 1 }))).toBe(
      "Data pembayaran tidak valid.",
    );

    const hasil = await bayar("d1", ["u1", "u2"]);
    expect(hasil.total).toBe(500_000);
    expect(await galat(bayar("d1", ["u1"]))).toBe(
      "Surat jalan KRS-1 sudah dibayar.",
    );
    expect(await galat(aturPenerimaUpah(client, "u1", "d2"))).toBe(
      "Upah surat jalan ini sudah dibayar. Batalkan pembayarannya dulu.",
    );

    const { items } = await daftarPerjalanan(
      client,
      "2027-01-01",
      "2027-01-31",
    );
    const u1 = items.find((i) => i.id_perjalanan === "u1");
    expect(u1?.bayar).toEqual([hasil.id_bayar]);
    expect(u1?.identitas_kendaraan_awal).toBeNull();
    expect(
      (await rekapUpah(client, "2027-01-01", "2027-01-31")).items,
    ).toHaveLength(3);
    let riwayat = (await daftarBayarUpah(client, "2027-01-31", "2027-01-31"))
      .items;
    expect(riwayat[0]?.total).toBe(500_000);
    expect(riwayat[0]?.nama_karyawan).toBe("Budi");
    expect(riwayat[0]?.dicatat_oleh).toBe("kasir");
    expect(riwayat[0]?.surat_jalan).toHaveLength(2);
    expect(riwayat[0]?.alasan_batal).toBeNull();

    const batal = (alasan: string) =>
      batalBayarUpah(client, "kasir", { id_bayar: hasil.id_bayar, alasan });
    expect(await galat(batal(" "))).toBe("Alasan pembatalan wajib diisi.");
    expect((await batal("Salah driver")).id_bayar).toBe(
      `batal-${hasil.id_bayar}`,
    );
    expect(await galat(batal("Lagi"))).toBe("Pembayaran ini sudah dibatalkan.");
    riwayat = (await daftarBayarUpah(client, "2027-01-31", "2027-01-31")).items;
    expect(riwayat[0]?.alasan_batal).toBe("Salah driver");
    await aturPenerimaUpah(client, "u1", null);

    // Pembayaran dari perangkat lain yang offline.
    await bayar("d1", ["u1"]);
    await client.batch(
      [
        `INSERT INTO drv_upah_bayar (id_bayar, jenis, id_karyawan, tanggal, total, dicatat_oleh)
         VALUES ('ux', 'Bayar', 'd1', '2027-01-31', 350000, 'lain'),
                ('uy', 'Bayar', 'd2', '2027-01-31', 150000, 'lain');`,
        `INSERT INTO drv_upah_bayar_baris (id_baris, id_bayar, id_perjalanan, upah)
         VALUES ('ux:u1', 'ux', 'u1', 350000), ('uy:u2', 'uy', 'u2', 150000);`,
      ],
      "write",
    );
    const sesudah = (await daftarPerjalanan(client, "2027-01-01", "2027-01-31"))
      .items;
    const kode = (id: string) =>
      (sesudah.find((i) => i.id_perjalanan === id)?.tanda ?? [])
        .map((t) => t.kode)
        .filter((k) => k === "dibayar_ganda" || k === "upah_berubah");
    expect(kode("u1")).toEqual(["dibayar_ganda"]);
    expect(kode("u2")).toEqual(["upah_berubah"]);
  });
});
