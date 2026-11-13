// HRIS fase 12: perender berkas transfer gaji (prd-hris.md §27.3), sama untuk
// Web, Desktop, dan Mobile (§27.6). Murni: menerima `SusunanTransfer` dari
// backend dan mengembalikan isi berkas; menyimpannya urusan pemanggil
// (`saveFileWithPicker`, aturan 46). Nominal = bilangan bulat rupiah dari
// `net_salary`, tidak pernah dibagi atau dibulatkan (aturan 13).

import {
  type BarisTransfer,
  type IsianTransfer,
  type KolomFormat,
  LABEL_JENIS_TRANSFER,
  LABEL_TANDA_TRANSFER,
  type SusunanTransfer,
} from "@/lib/validations/transfer";
import {
  AngkaExcel,
  buildXlsxWorkbook,
  type LembarXlsx,
  type SelExcel,
} from "./excel-export";

export const MIME_XLSX =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/** Bagian format kustom yang dibaca perender. */
export interface FormatRender {
  nama: string;
  jenis: "csv" | "txt" | "xlsx";
  pemisah: string | null;
  pakai_judul: number;
  kutip: number;
  desimal: number;
  kolom: readonly KolomFormat[];
}

export interface RunRender {
  period_start: string;
  period_end: string;
  status: string;
}

export interface BerkasJadi {
  nama: string;
  mime: string;
  data: Uint8Array | string;
}

/** Isian yang ditulis sebagai angka (sel Angka di xlsx, tanpa kutip di teks). */
const ISIAN_ANGKA: ReadonlySet<IsianTransfer> = new Set([
  "nominal",
  "nomor_urut",
]);

function nilaiIsian(
  kolom: KolomFormat,
  r: BarisTransfer,
  s: SusunanTransfer,
): string | number {
  switch (kolom.isian) {
    case "nama_karyawan":
      return r.nama_karyawan;
    case "kode_karyawan":
      return r.kode_karyawan ?? "";
    case "nama_bank":
      return r.nama_bank ?? "";
    case "kode_bank":
      return r.kode_bank ?? "";
    case "no_rekening":
      return r.no_rekening ?? "";
    case "nama_rekening":
      return r.nama_rekening ?? "";
    case "nominal":
      return r.nominal;
    case "berita":
      return s.berita;
    case "rekening_debet":
      return s.rekening_debet;
    case "nama_debet":
      return s.nama_debet;
    case "tanggal_efektif":
      return s.tanggal_efektif;
    case "nomor_urut":
      return r.nomor_urut ?? 0;
    case "teks_tetap":
      return kolom.teks ?? "";
  }
}

/**
 * Judul dan nilai setiap kolom format untuk baris yang masuk berkas
 * (`susunan.baris`, sudah disaring cakupannya). Dipakai perender dan
 * pratinjau, jadi yang tampil sama dengan yang diunduh.
 */
export function selFormat(
  susunan: SusunanTransfer,
  format: Pick<FormatRender, "kolom">,
): { judul: string[]; baris: (string | number)[][] } {
  return {
    judul: format.kolom.map((k) => k.judul),
    baris: susunan.baris.map((r) =>
      format.kolom.map((k) => nilaiIsian(k, r, susunan)),
    ),
  };
}

/** Nominal teks: `1500000` atau `1500000.00` (penggabungan teks, bukan float). */
export function nominalTeks(nominal: number, desimal: boolean): string {
  return desimal ? `${nominal}.00` : String(nominal);
}

/**
 * Satu sel CSV/TXT. Teks dibungkus kutip bila format meminta; tanpa itu tetap
 * dibungkus bila memuat pemisah, kutip, atau baris baru, supaya kolom tidak
 * pernah bergeser (RFC 4180). Angka tidak pernah dikutip, dan `desimal` hanya
 * berlaku untuk nominal.
 */
function selTeks(
  nilai: string | number,
  isian: IsianTransfer | null,
  format: FormatRender,
): string {
  if (isian === "nominal")
    return nominalTeks(Number(nilai), format.desimal === 1);
  if (isian === "nomor_urut") return String(nilai);
  const teks = String(nilai);
  const pemisah = format.pemisah ?? ",";
  const perlu =
    teks.includes(pemisah) ||
    teks.includes('"') ||
    teks.includes("\n") ||
    teks.includes("\r");
  return format.kutip === 1 || perlu ? `"${teks.replaceAll('"', '""')}"` : teks;
}

/** Isi berkas CSV/TXT, baris diakhiri CRLF, UTF-8 tanpa BOM. */
export function renderTeks(
  susunan: SusunanTransfer,
  format: FormatRender,
): string {
  const pemisah = format.pemisah ?? ",";
  const { judul, baris } = selFormat(susunan, format);
  const isiBaris = baris.map((isi) =>
    isi
      .map((v, i) => selTeks(v, format.kolom[i]?.isian ?? null, format))
      .join(pemisah),
  );
  if (format.pakai_judul === 1) {
    // Judul selalu teks.
    isiBaris.unshift(judul.map((j) => selTeks(j, null, format)).join(pemisah));
  }
  return isiBaris.map((b) => `${b}\r\n`).join("");
}

/** Isi berkas xlsx format kustom: satu sheet, nominal sel Angka. */
export function renderXlsx(
  susunan: SusunanTransfer,
  format: FormatRender,
): Uint8Array {
  const { judul, baris } = selFormat(susunan, format);
  const angka = format.kolom.map((k) => ISIAN_ANGKA.has(k.isian));
  return buildXlsxWorkbook([
    {
      nama: "Transfer",
      headers: judul,
      rows: baris.map((isi) =>
        isi.map(
          (v, i): SelExcel =>
            angka[i] && typeof v === "number" ? new AngkaExcel(v) : String(v),
        ),
      ),
      tanpaJudul: format.pakai_judul !== 1,
    },
  ]);
}

function namaDasar(run: RunRender): string {
  return `Transfer_Gaji_${run.period_start}_${run.period_end}`;
}

/** Nama berkas aman: huruf, angka, garis bawah, minus, titik. */
const amankan = (teks: string) =>
  teks.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");

/** Berkas format kustom (§27.3 bentuk 2). */
export function berkasFormat(
  run: RunRender,
  susunan: SusunanTransfer,
  format: FormatRender,
): BerkasJadi {
  const nama = `${namaDasar(run)}_${amankan(format.nama) || "format"}`;
  if (format.jenis === "xlsx") {
    return {
      nama: `${nama}.xlsx`,
      mime: MIME_XLSX,
      data: renderXlsx(susunan, format),
    };
  }
  return {
    nama: `${nama}.${format.jenis}`,
    mime: format.jenis === "csv" ? "text/csv" : "text/plain",
    data: renderTeks(susunan, format),
  };
}

const tandaTeks = (r: BarisTransfer) =>
  r.tanda.map((t) => LABEL_TANDA_TRANSFER[t]).join("; ");
const rp = (n: number) => new AngkaExcel(n);

/**
 * Excel umum, selalu ada (§27.3 bentuk 1): sheet Transfer (semua isian),
 * Perlu dibayar manual, dan Ringkasan. Totalnya dijumlah backend.
 */
export function berkasUmum(
  run: RunRender,
  susunan: SusunanTransfer,
): BerkasJadi {
  const s = susunan;
  const r = s.ringkasan;
  const lembar: LembarXlsx[] = [
    {
      nama: "Transfer",
      headers: [
        "No",
        "Kode Karyawan",
        "Nama Karyawan",
        "Bank",
        "Kode Bank",
        "No. Rekening",
        "Nama Pemilik Rekening",
        "Nominal",
        "Jenis",
        "Berita",
        "Rekening Debet",
        "Nama Rekening Debet",
        "Tanggal Efektif",
        "Catatan",
      ],
      rows: s.baris.map((b) => [
        rp(b.nomor_urut ?? 0),
        b.kode_karyawan ?? "",
        b.nama_karyawan,
        b.nama_bank ?? "",
        b.kode_bank ?? "",
        b.no_rekening ?? "",
        b.nama_rekening ?? "",
        rp(b.nominal),
        b.jenis ? LABEL_JENIS_TRANSFER[b.jenis] : "",
        s.berita,
        s.rekening_debet,
        s.nama_debet,
        s.tanggal_efektif,
        tandaTeks(b),
      ]),
      lebar: [6, 14, 28, 18, 10, 20, 28, 16, 12, 30, 20, 28, 14, 36],
      kolomBeku: 3,
    },
    {
      nama: "Perlu dibayar manual",
      headers: [
        "Kode Karyawan",
        "Nama Karyawan",
        "Bank (profil)",
        "No. Rekening",
        "Nama Pemilik Rekening",
        "Nominal",
        "Alasan",
      ],
      rows: s.manual.map((b) => [
        b.kode_karyawan ?? "",
        b.nama_karyawan,
        b.nama_bank ?? "",
        b.no_rekening ?? "",
        b.nama_rekening ?? "",
        rp(b.nominal),
        tandaTeks(b),
      ]),
      lebar: [14, 28, 18, 20, 28, 16, 40],
      kolomBeku: 2,
    },
    {
      nama: "Ringkasan",
      headers: ["Keterangan", "Jumlah", "Total"],
      rows: [
        ["Periode", `${run.period_start} s.d. ${run.period_end}`, ""],
        ["Status proses gaji", run.status, ""],
        ["Rekening debet", `${s.rekening_debet} a.n. ${s.nama_debet}`, ""],
        ["Tanggal efektif", s.tanggal_efektif, ""],
        ["Masuk berkas", rp(r.jumlah_baris), rp(r.total)],
        ["Perlu dibayar manual", rp(r.jumlah_manual), rp(r.total_manual)],
        [
          "Di luar cakupan berkas ini",
          rp(r.jumlah_luar_cakupan),
          rp(r.total_luar_cakupan),
        ],
        ["Total gaji bersih proses gaji", "", rp(r.total_run)],
        ["Selisih (tidak masuk berkas)", "", rp(r.selisih)],
        [
          LABEL_JENIS_TRANSFER.sesama,
          rp(r.per_jenis.sesama.jumlah),
          rp(r.per_jenis.sesama.total),
        ],
        [
          LABEL_JENIS_TRANSFER.antarbank,
          rp(r.per_jenis.antarbank.jumlah),
          rp(r.per_jenis.antarbank.total),
        ],
        ...r.per_bank.map((b) => [
          `Bank ${b.nama_bank}`,
          rp(b.jumlah),
          rp(b.total),
        ]),
      ],
      lebar: [34, 30, 18],
    },
  ];
  return {
    nama: `${namaDasar(run)}_umum.xlsx`,
    mime: MIME_XLSX,
    data: buildXlsxWorkbook(lembar),
  };
}

/** `payroll_audit_logs.action` jejak unduhan berkas (Q-156). */
export const AKSI_UNDUH_TRANSFER = "TRANSFER_EXPORT";

const RUPIAH = new Intl.NumberFormat("id-ID", {
  style: "currency",
  currency: "IDR",
  maximumFractionDigits: 0,
});

/**
 * Ringkasan terbaca dari `notes` jejak unduhan (JSON dari backend). Catatan
 * yang tidak bisa dibaca dikembalikan apa adanya.
 */
export function ringkasCatatanUnduhan(notes: string | null): string | null {
  if (!notes) return null;
  try {
    const c = JSON.parse(notes) as Record<string, unknown>;
    const format = typeof c.format === "string" ? c.format : "Excel umum";
    return [
      `Format ${format}`,
      `rekening debet ${String(c.rekening_debet ?? "-")}`,
      `tanggal efektif ${String(c.tanggal_efektif ?? "-")}`,
      `${Number(c.jumlah_baris ?? 0)} baris`,
      RUPIAH.format(Number(c.total ?? 0)),
    ].join(" · ");
  } catch {
    return notes;
  }
}
