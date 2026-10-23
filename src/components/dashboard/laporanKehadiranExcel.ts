"use client";

// Ikut disalin ke Mobile lewat `filesToCopy`, bersama `EksporLaporanKehadiran.tsx`.

import type { DownloadResult } from "@/lib/client/download";
import { saveFileWithPicker } from "@/lib/client/download";
import { AngkaExcel, buildXlsxWorkbook } from "@/lib/client/excel-export";
import { getLaporanKehadiran, getRekapHarian } from "@/lib/gateways/report";
import { hariIso, NAMA_HARI } from "@/lib/validations/hari-kerja";
import {
  KODE_LAPORAN,
  susunLaporanKehadiran,
} from "@/lib/validations/laporan-kehadiran";

const MIME_XLSX =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

const angka = (nilai: number) => new AngkaExcel(nilai);
const teks = (nilai: unknown) =>
  nilai === null || nilai === undefined ? "" : String(nilai);

/**
 * Tiga sheet: Rekap Kehadiran (karyawan × tanggal + total), Detail (setiap
 * sesi absen), dan Keterangan (arti kode dan daftar libur periode itu).
 */
export async function eksporLaporanKehadiran(
  mulai: string,
  selesai: string,
): Promise<DownloadResult> {
  const [data, harian] = await Promise.all([
    getLaporanKehadiran({ tanggal_mulai: mulai, tanggal_selesai: selesai }),
    getRekapHarian({ tanggal_mulai: mulai, tanggal_selesai: selesai }),
  ]);
  const { tanggal, baris } = susunLaporanKehadiran(data);
  const detail = [...harian].sort(
    (a, b) =>
      teks(a.nama).localeCompare(teks(b.nama), "id") ||
      teks(a.tanggal).localeCompare(teks(b.tanggal)) ||
      teks(a.jam_masuk).localeCompare(teks(b.jam_masuk)),
  );

  const satuBulan = mulai.slice(0, 7) === selesai.slice(0, 7);
  const judulTanggal = tanggal.map((t) => {
    const hari = NAMA_HARI[(hariIso(t) ?? 1) - 1].slice(0, 3);
    const tgl = Number(t.slice(8));
    return satuBulan
      ? `${tgl} ${hari}`
      : `${tgl}/${Number(t.slice(5, 7))} ${hari}`;
  });
  const judulTotal = [
    "Hadir",
    "Terlambat (kali)",
    "Menit Terlambat",
    "Sakit",
    "Izin",
    "Dispensasi",
    "Alfa",
    "Tanpa Data",
    "Libur",
    "Hari Wajib Masuk",
    "% Kehadiran",
  ];

  const isi = buildXlsxWorkbook([
    {
      nama: "Rekap Kehadiran",
      headers: ["No", "ID / NIK", "Nama", "Divisi"]
        .concat(judulTanggal)
        .concat(judulTotal),
      rows: baris.map((b, i) => [
        angka(i + 1),
        b.karyawan.kode || b.karyawan.id,
        b.karyawan.aktif ? b.karyawan.nama : `${b.karyawan.nama} (nonaktif)`,
        b.karyawan.divisi,
        ...b.sel,
        angka(b.hadir),
        angka(b.terlambat),
        angka(b.menitTerlambat),
        angka(b.sakit),
        angka(b.izin),
        angka(b.dispensasi),
        angka(b.alfa),
        angka(b.tanpaData),
        angka(b.libur),
        angka(b.wajibMasuk),
        b.persen === null ? "" : angka(b.persen),
      ]),
      lebar: [5, 14, 28, 16]
        .concat(tanggal.map(() => (satuBulan ? 7 : 9)))
        .concat(judulTotal.map((judul) => Math.max(8, judul.length + 2))),
      kolomBeku: 3,
    },
    {
      nama: "Detail",
      headers: [
        "Tanggal",
        "ID / NIK",
        "Nama",
        "Divisi",
        "Shift",
        "Jam Masuk",
        "Jam Pulang",
        "Status Kehadiran",
        "Menit Terlambat",
        "Jam Kerja (menit)",
        "Lembur (menit)",
        "Sumber",
        "Keterangan",
      ],
      rows: detail.map((row) => [
        teks(row.tanggal),
        teks(row.kode_karyawan) || teks(row.id_karyawan),
        teks(row.nama),
        teks(row.kelas_divisi),
        teks(row.nama_shift),
        teks(row.jam_masuk),
        teks(row.jam_pulang),
        teks(row.status_kehadiran),
        angka(Number(row.menit_terlambat) || 0),
        angka(Number(row.jam_kerja) || 0),
        angka(Number(row.lembur) || 0),
        teks(row.sumber),
        teks(row.keterangan),
      ]),
      lebar: [12, 14, 28, 16, 14, 10, 10, 16, 15, 16, 14, 16, 30],
      kolomBeku: 3,
    },
    {
      nama: "Keterangan",
      headers: ["Kode / Tanggal", "Keterangan"],
      rows: [
        ["Periode", `${mulai} s.d. ${selesai}`],
        ["Data per", `${data.hari_ini}; tanggal sesudahnya dikosongkan`],
        [
          "% Kehadiran",
          "Hadir (termasuk terlambat) dibagi Hari Wajib Masuk. Hari libur tidak dihitung.",
        ],
        ["", ""],
        ...KODE_LAPORAN.map(([kode, arti]) => [kode, arti]),
        ["", ""],
        ["Hari libur dalam periode", ""],
        ...(data.libur.length > 0
          ? data.libur.map((libur) => [libur.tanggal, libur.nama])
          : [["-", "Tidak ada"]]),
      ],
      lebar: [24, 70],
    },
  ]);

  const namaBerkas = `Laporan_Kehadiran_${mulai}_sd_${selesai}.xlsx`;
  return saveFileWithPicker(
    new Blob([isi as unknown as BlobPart], { type: MIME_XLSX }),
    namaBerkas,
    {
      description: "Spreadsheet Excel (.xlsx)",
      accept: { [MIME_XLSX]: [".xlsx"] },
    },
  );
}
