import {
  AngkaExcel,
  buildXlsxWorkbook,
  type LembarXlsx,
} from "@/lib/client/excel-export";
import type {
  PembayaranUpahItem,
  PerjalananItem,
} from "@/lib/validations/driver";

/**
 * Rekap upah surat jalan (PRD §4.1c, Q-31, Q-32). Murni: semua angka datang
 * dari backend (`upah`, `penerima_upah`, `bayar`), di sini hanya dikelompokkan.
 * Per kendaraan memakai kendaraan AWAL (dasar tarif), per tanggal memakai
 * tanggal surat jalan, supaya laporan offline yang telat tidak menggesernya.
 */

export type DasarRekap = "driver" | "kendaraan" | "tanggal";

export const JUDUL_DASAR: Record<DasarRekap, string> = {
  driver: "Driver",
  kendaraan: "Kendaraan",
  tanggal: "Tanggal",
};

export interface BarisRekap {
  kunci: string;
  label: string;
  selesai: number;
  belumSelesai: number;
  tidakJalan: number;
  dibatalkan: number;
  /** Rupiah, hanya surat jalan Selesai. */
  upah: number;
  dibayar: number;
  belumDibayar: number;
}

const dibayar = (i: PerjalananItem) => i.bayar.length > 0;

/** Driver rekap: penerima upah untuk Selesai, driver yang bertugas selainnya. */
function driverRekap(i: PerjalananItem): [string, string] {
  if (i.status === "Selesai" && i.penerima_upah) {
    return [i.penerima_upah, i.nama_penerima_upah ?? i.penerima_upah];
  }
  return [i.id_karyawan, i.nama_karyawan ?? i.id_karyawan];
}

function kunciRekap(i: PerjalananItem, dasar: DasarRekap): [string, string] {
  if (dasar === "driver") return driverRekap(i);
  if (dasar === "kendaraan") {
    return [
      i.id_kendaraan_awal,
      i.identitas_kendaraan_awal ?? i.id_kendaraan_awal,
    ];
  }
  return [i.tanggal, i.tanggal];
}

export function kelompokRekap(
  items: readonly PerjalananItem[],
  dasar: DasarRekap,
): BarisRekap[] {
  const peta = new Map<string, BarisRekap>();
  for (const i of items) {
    const [kunci, label] = kunciRekap(i, dasar);
    const baris = peta.get(kunci) ?? {
      kunci,
      label,
      selesai: 0,
      belumSelesai: 0,
      tidakJalan: 0,
      dibatalkan: 0,
      upah: 0,
      dibayar: 0,
      belumDibayar: 0,
    };
    if (i.status === "Selesai") {
      baris.selesai++;
      baris.upah += i.upah;
      if (dibayar(i)) baris.dibayar += i.upah;
      else baris.belumDibayar += i.upah;
    } else if (i.status === "Tidak Jalan") baris.tidakJalan++;
    else if (i.status === "Dibatalkan") baris.dibatalkan++;
    else baris.belumSelesai++;
    peta.set(kunci, baris);
  }
  const hasil = [...peta.values()];
  return dasar === "tanggal"
    ? hasil.sort((a, b) => a.kunci.localeCompare(b.kunci))
    : hasil.sort((a, b) => a.label.localeCompare(b.label, "id"));
}

export interface TagihanDriver {
  id_karyawan: string;
  nama: string;
  items: PerjalananItem[];
  total: number;
}

/** Surat jalan Selesai yang belum masuk pembayaran mana pun, per penerima upah. */
export function belumDibayarPerDriver(
  items: readonly PerjalananItem[],
): TagihanDriver[] {
  const peta = new Map<string, TagihanDriver>();
  for (const i of items) {
    if (i.status !== "Selesai" || !i.penerima_upah || dibayar(i)) continue;
    const tagihan = peta.get(i.penerima_upah) ?? {
      id_karyawan: i.penerima_upah,
      nama: i.nama_penerima_upah ?? i.penerima_upah,
      items: [],
      total: 0,
    };
    tagihan.items.push(i);
    tagihan.total += i.upah;
    peta.set(i.penerima_upah, tagihan);
  }
  for (const t of peta.values()) {
    t.items.sort(
      (a, b) =>
        a.tanggal.localeCompare(b.tanggal) || a.nomor.localeCompare(b.nomor),
    );
  }
  return [...peta.values()].sort((a, b) => a.nama.localeCompare(b.nama, "id"));
}

function lembarRekap(
  items: readonly PerjalananItem[],
  dasar: DasarRekap,
): LembarXlsx {
  const baris = kelompokRekap(items, dasar);
  return {
    nama: `Per ${JUDUL_DASAR[dasar]}`,
    headers: [
      JUDUL_DASAR[dasar],
      "Selesai",
      "Belum Selesai",
      "Tidak Jalan",
      "Dibatalkan",
      "Upah Selesai (Rp)",
      "Sudah Dibayar (Rp)",
      "Belum Dibayar (Rp)",
    ],
    rows: baris.map((b) => [
      b.label,
      new AngkaExcel(b.selesai),
      new AngkaExcel(b.belumSelesai),
      new AngkaExcel(b.tidakJalan),
      new AngkaExcel(b.dibatalkan),
      new AngkaExcel(b.upah),
      new AngkaExcel(b.dibayar),
      new AngkaExcel(b.belumDibayar),
    ]),
    lebar: [28, 10, 14, 12, 12, 18, 18, 18],
    kolomBeku: 1,
  };
}

/** Satu berkas: tiga rekap, rincian surat jalan, dan riwayat pembayaran. */
export function bukuRekapUpah(
  items: readonly PerjalananItem[],
  pembayaran: readonly PembayaranUpahItem[],
): Uint8Array {
  const urut = [...items].sort(
    (a, b) =>
      a.tanggal.localeCompare(b.tanggal) || a.nomor.localeCompare(b.nomor),
  );
  return buildXlsxWorkbook([
    lembarRekap(items, "driver"),
    lembarRekap(items, "kendaraan"),
    lembarRekap(items, "tanggal"),
    {
      nama: "Rincian Surat Jalan",
      headers: [
        "Tanggal",
        "Nomor",
        "Status",
        "Driver Bertugas",
        "Penerima Upah",
        "Kendaraan Awal",
        "Kategori Tujuan",
        "Upah (Rp)",
        "Status Bayar",
      ],
      rows: urut.map((i) => [
        i.tanggal,
        i.nomor,
        i.status,
        i.nama_karyawan ?? i.id_karyawan,
        i.status === "Selesai" ? (i.nama_penerima_upah ?? i.penerima_upah) : "",
        i.identitas_kendaraan_awal ?? i.id_kendaraan_awal,
        i.nama_kategori ?? i.id_kategori,
        i.status === "Selesai" ? new AngkaExcel(i.upah) : "",
        i.status !== "Selesai"
          ? "Tidak dibayar"
          : dibayar(i)
            ? "Dibayar"
            : "Belum dibayar",
      ]),
      lebar: [12, 22, 12, 24, 24, 16, 18, 14, 14],
      kolomBeku: 2,
    },
    {
      nama: "Pembayaran",
      headers: [
        "Tanggal Bayar",
        "Driver",
        "Jumlah Surat Jalan",
        "Total (Rp)",
        "Keterangan",
        "Dicatat Oleh",
        "Status",
        "Alasan Batal",
        "Nomor Surat Jalan",
      ],
      rows: pembayaran.map((p) => [
        p.tanggal,
        p.nama_karyawan ?? p.id_karyawan,
        new AngkaExcel(p.surat_jalan.length),
        new AngkaExcel(p.total),
        p.keterangan ?? "",
        p.dicatat_oleh,
        p.alasan_batal === null ? "Berlaku" : "Dibatalkan",
        p.alasan_batal ?? "",
        p.surat_jalan.map((s) => s.nomor ?? s.id_perjalanan).join(", "),
      ]),
      lebar: [14, 24, 12, 16, 28, 16, 12, 28, 40],
    },
  ]);
}
