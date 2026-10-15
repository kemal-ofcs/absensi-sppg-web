import type { DownloadResult } from "@/lib/client/download";
import { exportToExcel } from "@/lib/client/excel-export";
import type {
  BukuBesar,
  LaporanAktivitas,
  LaporanArusKas,
  LaporanPosisiKeuangan,
  NeracaSaldo,
} from "@/lib/gateways/accounting";
import { formatRupiah } from "@/lib/validations/accounting";

/**
 * Laporan keuangan dalam bentuk tabel tunggal (Fase K4a). Layar, Excel, dan
 * PDF memakai baris yang sama dari fungsi `tabel*`, jadi ketiganya tidak bisa
 * menampilkan angka yang berbeda. Dipakai Web/Desktop dan Mobile (disalin
 * lewat `filesToCopy`).
 */

type Sel = string | number | boolean | null | undefined;

function saveWorkbook(spec: {
  headers: string[];
  rows: Record<string, unknown>[];
  filename: string;
  sheetName: string;
}): Promise<DownloadResult> {
  return exportToExcel(
    spec.filename,
    spec.sheetName,
    spec.headers,
    spec.rows.map((row) => spec.headers.map((header) => row[header] as Sel)),
  );
}

export interface BarisTabel {
  jenis: "bagian" | "akun" | "total";
  label: string;
  kode?: string;
  jumlah?: number;
}

export interface TabelLaporan {
  judul: string;
  periode: string;
  baris: BarisTabel[];
  /** Pesan yang wajib terlihat, misalnya laporan yang timpang. */
  peringatan: string | null;
  /** Keterangan netral di bawah periode, misalnya "sudah ditutup". */
  keterangan?: string;
}

function tanggal(teks: string): string {
  const [tahun, bulan, hari] = teks.split("-");
  return hari && bulan && tahun ? `${hari}/${bulan}/${tahun}` : teks;
}

function akunBaris(
  daftar: ReadonlyArray<{ kode: string; nama: string; saldo: number }>,
): BarisTabel[] {
  return daftar.map((a) => ({
    jenis: "akun",
    kode: a.kode,
    label: a.nama,
    jumlah: a.saldo,
  }));
}

export function tabelPosisi(d: LaporanPosisiKeuangan): TabelLaporan {
  return {
    judul: "Neraca",
    periode: `Per ${tanggal(d.sampai)}`,
    baris: [
      { jenis: "bagian", label: "Aset" },
      ...akunBaris(d.aset),
      { jenis: "total", label: "Jumlah aset", jumlah: d.total_aset },
      { jenis: "bagian", label: "Kewajiban" },
      ...akunBaris(d.kewajiban),
      { jenis: "total", label: "Jumlah kewajiban", jumlah: d.total_kewajiban },
      { jenis: "bagian", label: "Ekuitas" },
      ...akunBaris(d.ekuitas),
      {
        jenis: "akun",
        label: "Laba (rugi) berjalan",
        jumlah: d.laba_berjalan,
      },
      { jenis: "total", label: "Jumlah ekuitas", jumlah: d.total_ekuitas },
      {
        jenis: "total",
        label: "Jumlah kewajiban dan ekuitas",
        jumlah: d.total_kewajiban + d.total_ekuitas,
      },
    ],
    peringatan:
      d.selisih === 0
        ? null
        : `Laporan tidak seimbang: aset berselisih ${formatRupiah(d.selisih)} dari kewajiban dan ekuitas. Biasanya sebagian baris jurnal belum selesai tersinkron ke perangkat ini. Jalankan sinkronisasi lalu buka lagi.`,
  };
}

export function tabelAktivitas(d: LaporanAktivitas): TabelLaporan {
  return {
    judul: "Laporan Laba Rugi",
    periode: `${tanggal(d.dari)} s.d. ${tanggal(d.sampai)}`,
    baris: [
      { jenis: "bagian", label: "Pendapatan" },
      ...akunBaris(d.pendapatan),
      {
        jenis: "total",
        label: "Jumlah pendapatan",
        jumlah: d.total_pendapatan,
      },
      { jenis: "bagian", label: "Beban" },
      ...akunBaris(d.beban),
      { jenis: "total", label: "Jumlah beban", jumlah: d.total_beban },
      { jenis: "total", label: "Laba (rugi) bersih", jumlah: d.laba_bersih },
    ],
    peringatan: null,
  };
}

/**
 * Setiap kelompok tampil sekali, di sisi arah bersihnya: pembatalan
 * jurnal mengurangi baris penerimaannya, dan pindah dana
 * antarakun kas yang sama-sama dipilih saling meniadakan.
 */
export function tabelArusKas(d: LaporanArusKas): TabelLaporan {
  const masuk = d.kelompok.filter((k) => k.bersih > 0);
  const keluar = d.kelompok.filter((k) => k.bersih < 0);
  const totalMasuk = masuk.reduce((n, k) => n + k.bersih, 0);
  const totalKeluar = keluar.reduce((n, k) => n - k.bersih, 0);
  return {
    judul: "Laporan Arus Kas",
    periode: `${tanggal(d.dari)} s.d. ${tanggal(d.sampai)}, akun ${d.akun_kas
      .map((a) => a.nama)
      .join(", ")}`,
    baris: [
      { jenis: "bagian", label: "Penerimaan kas" },
      ...masuk.map((k) => ({
        jenis: "akun" as const,
        label: k.label,
        jumlah: k.bersih,
      })),
      { jenis: "total", label: "Jumlah penerimaan", jumlah: totalMasuk },
      { jenis: "bagian", label: "Pengeluaran kas" },
      ...keluar.map((k) => ({
        jenis: "akun" as const,
        label: k.label,
        jumlah: -k.bersih,
      })),
      { jenis: "total", label: "Jumlah pengeluaran", jumlah: totalKeluar },
      {
        jenis: "total",
        label: "Kenaikan (penurunan) kas",
        jumlah: totalMasuk - totalKeluar,
      },
      { jenis: "akun", label: "Saldo awal kas", jumlah: d.saldo_awal },
      { jenis: "total", label: "Saldo akhir kas", jumlah: d.saldo_akhir },
    ],
    peringatan: null,
  };
}

function namaBerkas(judul: string, periode: string, ekstensi: string): string {
  return `${judul}-${periode}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80)
    .concat(`.${ekstensi}`);
}

export function eksporTabelExcel(t: TabelLaporan): Promise<DownloadResult> {
  const headers = ["Keterangan", "Kode", "Jumlah"];
  const rows: Record<string, unknown>[] = [
    { Keterangan: t.judul },
    { Keterangan: t.periode },
    ...(t.keterangan ? [{ Keterangan: t.keterangan }] : []),
    {},
    ...t.baris.map((b) => ({
      Keterangan: b.jenis === "akun" ? `  ${b.label}` : b.label,
      Kode: b.kode ?? "",
      Jumlah: b.jumlah ?? null,
    })),
  ];
  if (t.peringatan) rows.push({}, { Keterangan: t.peringatan });
  return saveWorkbook({
    headers,
    rows,
    filename: namaBerkas(t.judul, t.periode, "xlsx"),
    sheetName: t.judul.replace(/^Laporan /, ""),
  });
}

export function eksporBukuBesar(
  data: BukuBesar,
  dari: string,
  sampai: string,
): Promise<DownloadResult> {
  const headers = [
    "Tanggal",
    "Nomor",
    "Keterangan",
    "Debit",
    "Kredit",
    "Saldo",
  ];
  const rows: Record<string, unknown>[] = [
    { Tanggal: `Buku besar ${data.akun.kode} ${data.akun.nama}` },
    { Tanggal: `${tanggal(dari)} s.d. ${tanggal(sampai)}` },
    {},
    { Keterangan: "Saldo awal", Saldo: data.saldo_awal },
    ...data.baris.map((b) => ({
      Tanggal: b.tanggal,
      Nomor: b.nomor,
      Keterangan: b.keterangan,
      Debit: b.debit,
      Kredit: b.kredit,
      Saldo: b.saldo,
    })),
    {
      Keterangan: "Jumlah",
      Debit: data.total_debit,
      Kredit: data.total_kredit,
      Saldo: data.saldo_akhir,
    },
  ];
  if (data.terpotong) {
    rows.push(
      {},
      {
        Tanggal:
          "Daftar baris terpotong; saldo akhir tetap dihitung dari seluruh jurnal.",
      },
    );
  }
  return saveWorkbook({
    headers,
    rows,
    filename: namaBerkas(
      `buku-besar-${data.akun.kode}`,
      `${dari}-${sampai}`,
      "xlsx",
    ),
    sheetName: "Buku Besar",
  });
}

export function eksporNeracaSaldo(
  data: NeracaSaldo,
  sampai: string,
): Promise<DownloadResult> {
  const headers = ["Kode", "Akun", "Kelompok", "Debit", "Kredit"];
  const rows: Record<string, unknown>[] = [
    { Kode: `Neraca saldo per ${tanggal(sampai)}` },
    {},
    ...data.items.map((i) => ({
      Kode: i.kode,
      Akun: i.nama,
      Kelompok: i.kelompok,
      Debit: i.debit,
      Kredit: i.kredit,
    })),
    { Akun: "Jumlah", Debit: data.total_debit, Kredit: data.total_kredit },
  ];
  return saveWorkbook({
    headers,
    rows,
    filename: namaBerkas("neraca-saldo", sampai, "xlsx"),
    sheetName: "Neraca Saldo",
  });
}
