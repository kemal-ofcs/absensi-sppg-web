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
  catatLaporanDispatcher,
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
});
