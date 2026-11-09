import { describe, expect, test } from "bun:test";
import type {
  PembayaranUpahItem,
  PerjalananItem,
  StatusPerjalanan,
} from "@/lib/validations/driver";
import {
  belumDibayarPerDriver,
  bukuRekapUpah,
  kelompokRekap,
} from "./rekapUpah";

function sj(
  id: string,
  tanggal: string,
  status: StatusPerjalanan,
  ubah: Partial<PerjalananItem> = {},
): PerjalananItem {
  return {
    id_perjalanan: id,
    tanggal,
    nomor: `KRS-${id}`,
    status,
    catatan: null,
    dicetak_pada: null,
    dibuat_oleh: "admin",
    id_karyawan_awal: "d1",
    id_kendaraan_awal: "k1",
    identitas_kendaraan_awal: "B 1 A",
    id_karyawan: "d1",
    nama_karyawan: "Budi",
    id_kendaraan: "k2",
    identitas_kendaraan: "B 2 B",
    id_jenis: "j1",
    id_kategori: "c1",
    nama_kategori: "Luar Kota",
    tarif_kendaraan: 150_000,
    tarif_tujuan: 200_000,
    upah: 350_000,
    bayar: [],
    id_karyawan_upah: null,
    penerima_upah: status === "Selesai" ? "d1" : null,
    nama_penerima_upah: status === "Selesai" ? "Budi" : null,
    jumlah_muatan: 0,
    laporan_terakhir: null,
    menunggu_persetujuan: [],
    tanda: [],
    ...ubah,
  };
}

const items = [
  sj("1", "2026-11-02", "Selesai", { bayar: ["upb-1"] }),
  sj("2", "2026-11-01", "Selesai"),
  // Upah dipindah ke Joko; kendaraan awal tetap k1 walau yang bertugas k2.
  sj("3", "2026-11-02", "Selesai", {
    penerima_upah: "d2",
    nama_penerima_upah: "Joko",
    upah: 100_000,
  }),
  sj("4", "2026-11-02", "Tidak Jalan", {
    id_kendaraan_awal: "k9",
    identitas_kendaraan_awal: null,
  }),
  sj("5", "2026-11-03", "Dibatalkan"),
  sj("6", "2026-11-03", "Berjalan"),
];

describe("rekap upah surat jalan", () => {
  test("per driver: penerima upah untuk Selesai, bertugas selainnya", () => {
    expect(kelompokRekap(items, "driver")).toEqual([
      {
        kunci: "d1",
        label: "Budi",
        selesai: 2,
        belumSelesai: 1,
        tidakJalan: 1,
        dibatalkan: 1,
        upah: 700_000,
        dibayar: 350_000,
        belumDibayar: 350_000,
      },
      {
        kunci: "d2",
        label: "Joko",
        selesai: 1,
        belumSelesai: 0,
        tidakJalan: 0,
        dibatalkan: 0,
        upah: 100_000,
        dibayar: 0,
        belumDibayar: 100_000,
      },
    ]);
  });

  test("per kendaraan awal dan per tanggal surat jalan", () => {
    expect(
      kelompokRekap(items, "kendaraan").map((b) => [b.label, b.selesai]),
    ).toEqual([
      ["B 1 A", 3],
      ["k9", 0],
    ]);
    expect(
      kelompokRekap(items, "tanggal").map((b) => [b.kunci, b.upah]),
    ).toEqual([
      ["2026-11-01", 350_000],
      ["2026-11-02", 450_000],
      ["2026-11-03", 0],
    ]);
  });

  test("belum dibayar per penerima, urut tanggal", () => {
    const tagihan = belumDibayarPerDriver(items);
    expect(
      tagihan.map((t) => [
        t.nama,
        t.items.map((i) => i.id_perjalanan),
        t.total,
      ]),
    ).toEqual([
      ["Budi", ["2"], 350_000],
      ["Joko", ["3"], 100_000],
    ]);
  });

  test("buku Excel berisi lima sheet", () => {
    const pembayaran: PembayaranUpahItem[] = [
      {
        id_bayar: "upb-1",
        id_karyawan: "d1",
        nama_karyawan: "Budi",
        tanggal: "2026-11-30",
        total: 350_000,
        keterangan: null,
        dicatat_oleh: "kasir",
        created_at: "2026-11-30 03:00:00",
        tanggal_batal: null,
        alasan_batal: null,
        dibatalkan_oleh: null,
        surat_jalan: [
          {
            id_bayar: "upb-1",
            id_perjalanan: "1",
            upah: 350_000,
            nomor: "KRS-1",
            tanggal: "2026-11-02",
          },
        ],
      },
    ];
    const isi = new TextDecoder("latin1").decode(
      bukuRekapUpah(items, pembayaran),
    );
    for (const nama of [
      "Per Driver",
      "Per Kendaraan",
      "Per Tanggal",
      "Rincian Surat Jalan",
      "Pembayaran",
    ]) {
      expect(isi).toContain(`name="${nama}"`);
    }
    expect(isi).toContain("xl/worksheets/sheet5.xml");
  });
});
