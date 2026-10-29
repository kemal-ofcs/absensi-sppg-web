/**
 * Aturan akuntansi (Fase K1), cermin `desktop/accounting.rs`.
 *
 * Setiap fungsi di sini punya pasangan Rust bernama sama dalam snake_case, dan
 * keduanya diuji dengan vektor yang sama (`accounting.test.ts` ↔ `mod tests`
 * di `accounting.rs`). Pesan galatnya pun wajib identik.
 *
 * Uang selalu rupiah bulat. Tidak ada float di sini: saldo dihitung dengan
 * penjumlahan bilangan bulat, dan `MAKS_NOMINAL` × `MAKS_BARIS_JURNAL` masih
 * jauh di bawah `Number.MAX_SAFE_INTEGER`.
 */

import { z } from "zod";
import akunBawaan from "./akun-bawaan.json";

/** WAJIB sama dengan CHECK `keu_akun.kelompok` di ketiga DDL. */
export const KELOMPOK_AKUN = [
  "Aset",
  "Kewajiban",
  "Ekuitas",
  "Pendapatan",
  "Beban",
] as const;
export const SALDO_NORMAL = ["Debit", "Kredit"] as const;
/** WAJIB sama dengan CHECK `keu_jurnal.sumber` di ketiga DDL. */
export const SUMBER_JURNAL = [
  "Manual",
  "Kasbon",
  "Payroll",
  "Inventaris",
  "Cicilan",
  "Pembatalan",
] as const;

export const MAKS_NOMINAL = 1_000_000_000_000;
export const MAKS_BARIS_JURNAL = 100;
export const MAKS_KETERANGAN = 200;
export const MAKS_ALASAN_BATAL = 150;
export const MAKS_KODE_AKUN = 20;
export const MAKS_NAMA_AKUN = 80;
/** Cermin `LIMIT 300` daftar jurnal di `accounting.rs` dan `services/accounting.ts`. */
export const BATAS_DAFTAR_JURNAL = 300;
/** Cermin `LIMIT 1000` buku besar di `accounting.rs` dan `services/accounting.ts`. */
export const MAKS_BARIS_BUKU_BESAR = 1000;
/** Seri nomor jurnal yang dicatat lewat aplikasi Web (satu server, satu deret). */
export const SERI_WEB = "WEB";

export type KelompokAkun = (typeof KELOMPOK_AKUN)[number];
export type SaldoNormal = (typeof SALDO_NORMAL)[number];
export type SumberJurnal = (typeof SUMBER_JURNAL)[number];
export type Hasil<T> = { ok: true; value: T } | { ok: false; error: string };

export interface AkunBawaan {
  id_akun: string;
  kode: string;
  nama: string;
  kelompok: KelompokAkun;
  saldo_normal: SaldoNormal;
  sistem: boolean;
}

/**
 * Bagan akun bawaan. Berkas JSON yang SAMA dibaca Rust lewat `include_str!`,
 * jadi seed lokal, seed cloud Rust, dan seed cloud Web tidak bisa menyimpang.
 */
export const AKUN_BAWAAN = akunBawaan as readonly AkunBawaan[];

/** Akun yang dipakai jurnal otomatis K2/K3: boleh diganti nama, tidak lebih. */
export const AKUN_SISTEM_IDS: ReadonlySet<string> = new Set(
  AKUN_BAWAAN.filter((akun) => akun.sistem).map((akun) => akun.id_akun),
);

/** Cermin `SEED_AKUN_SQL`. Idempoten: akun yang sudah diganti nama tidak ditimpa. */
export const SEED_AKUN_SQL =
  "INSERT OR IGNORE INTO keu_akun (id_akun, kode, nama, kelompok, saldo_normal, is_aktif) VALUES (?, ?, ?, ?, ?, 1);";

function panjang(value: string): number {
  return Array.from(value).length;
}

function bersih(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed ? trimmed : null;
}

/** Cermin `is_valid_date` (`inventory.rs`). */
export function isValidDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1900 || month < 1 || month > 12) return false;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const maxDay =
    month === 2 ? (leap ? 29 : 28) : [4, 6, 9, 11].includes(month) ? 30 : 31;
  return day >= 1 && day <= maxDay;
}

/** Cermin `format_rupiah`. Tanpa `Intl`: hasilnya harus sama byte per byte dengan Rust. */
export function formatRupiah(nilai: number): string {
  const tanda = nilai < 0 ? "-" : "";
  const digit = String(Math.abs(nilai));
  const kelompok: string[] = [];
  for (let akhir = digit.length; akhir > 0; akhir -= 3) {
    kelompok.unshift(digit.slice(Math.max(0, akhir - 3), akhir));
  }
  return `${tanda}Rp${kelompok.join(".")}`;
}

/** Cermin `saldo_normal_bawaan`: Aset dan Beban bertambah di debit. */
export function saldoNormalBawaan(kelompok: KelompokAkun): SaldoNormal {
  return kelompok === "Aset" || kelompok === "Beban" ? "Debit" : "Kredit";
}

/** Cermin `format_nomor_jurnal`. */
export function formatNomorJurnal(
  tahun: string,
  seri: string,
  nomorUrut: number,
): string {
  return `JU/${tahun}/${seri}/${String(nomorUrut).padStart(4, "0")}`;
}

/** Cermin `id_pembalik`: id deterministik, sehingga pembatalan ganda dari dua perangkat menghasilkan PK yang sama. */
export function idPembalik(id: string): string {
  return `batal-${id}`;
}

/** Cermin `saldo_akun`: saldo bertanda menurut saldo normalnya. */
export function saldoAkun(
  saldoNormal: SaldoNormal,
  debit: number,
  kredit: number,
): number {
  return saldoNormal === "Debit" ? debit - kredit : kredit - debit;
}

/** Cermin `saldo_berjalan`: saldo setelah setiap baris buku besar. */
export function saldoBerjalan(
  saldoNormal: SaldoNormal,
  saldoAwal: number,
  baris: readonly { debit: number; kredit: number }[],
): number[] {
  let saldo = saldoAwal;
  return baris.map((item) => {
    saldo += saldoAkun(saldoNormal, item.debit, item.kredit);
    return saldo;
  });
}

/** Cermin `kolom_neraca_saldo`: selisih bersih ditaruh di kolom sisi yang lebih besar. */
export function kolomNeracaSaldo(
  totalDebit: number,
  totalKredit: number,
): { debit: number; kredit: number } {
  const bersihnya = totalDebit - totalKredit;
  return bersihnya >= 0
    ? { debit: bersihnya, kredit: 0 }
    : { debit: 0, kredit: -bersihnya };
}

// ── Akun ────────────────────────────────────────────────────────────────────

export const akunDraftSchema = z
  .object({
    id_akun: z.string().nullish(),
    kode: z.string().default(""),
    nama: z.string().default(""),
    kelompok: z.string().default(""),
    saldo_normal: z.string().default(""),
    is_aktif: z.boolean().default(true),
  })
  .strict();

export type AkunDraft = z.input<typeof akunDraftSchema>;
type AkunDraftParsed = z.output<typeof akunDraftSchema>;

export interface AkunValid {
  kode: string;
  nama: string;
  kelompok: KelompokAkun;
  saldo_normal: SaldoNormal;
  is_aktif: boolean;
}

/** Cermin `validate_akun`. */
export function validateAkun(draft: AkunDraftParsed): Hasil<AkunValid> {
  const kode = draft.kode.trim();
  if (!kode) return { ok: false, error: "Kode akun wajib diisi." };
  if (panjang(kode) > MAKS_KODE_AKUN) {
    return { ok: false, error: "Kode akun maksimal 20 karakter." };
  }
  const nama = draft.nama.trim();
  if (!nama) return { ok: false, error: "Nama akun wajib diisi." };
  if (panjang(nama) > MAKS_NAMA_AKUN) {
    return { ok: false, error: "Nama akun maksimal 80 karakter." };
  }
  if (!(KELOMPOK_AKUN as readonly string[]).includes(draft.kelompok)) {
    return { ok: false, error: "Kelompok akun tidak dikenal." };
  }
  if (!(SALDO_NORMAL as readonly string[]).includes(draft.saldo_normal)) {
    return { ok: false, error: "Saldo normal harus Debit atau Kredit." };
  }
  return {
    ok: true,
    value: {
      kode,
      nama,
      kelompok: draft.kelompok as KelompokAkun,
      saldo_normal: draft.saldo_normal as SaldoNormal,
      is_aktif: draft.is_aktif,
    },
  };
}

export interface AkunLama {
  kelompok: string;
  saldo_normal: string;
  sistem: boolean;
  punya_jurnal: boolean;
}

/** Cermin `aturan_ubah_akun`. Akun tidak pernah dihapus, hanya dinonaktifkan. */
export function aturanUbahAkun(lama: AkunLama, baru: AkunValid): Hasil<null> {
  const strukturBerubah =
    lama.kelompok !== baru.kelompok || lama.saldo_normal !== baru.saldo_normal;
  if (lama.sistem) {
    if (strukturBerubah) {
      return {
        ok: false,
        error: "Kelompok dan saldo normal akun sistem tidak bisa diubah.",
      };
    }
    if (!baru.is_aktif) {
      return { ok: false, error: "Akun sistem tidak bisa dinonaktifkan." };
    }
  }
  if (lama.punya_jurnal && strukturBerubah) {
    return {
      ok: false,
      error:
        "Kelompok dan saldo normal tidak bisa diubah setelah akun dipakai jurnal.",
    };
  }
  return { ok: true, value: null };
}

// ── Jurnal ──────────────────────────────────────────────────────────────────

export const jurnalDraftSchema = z
  .object({
    tanggal: z.string().default(""),
    keterangan: z.string().default(""),
    baris: z
      .array(
        z
          .object({
            id_akun: z.string().default(""),
            debit: z.number().default(0),
            kredit: z.number().default(0),
            keterangan: z.string().nullish(),
          })
          .strict(),
      )
      .default([]),
  })
  .strict();

export type JurnalDraft = z.input<typeof jurnalDraftSchema>;
type JurnalDraftParsed = z.output<typeof jurnalDraftSchema>;

export interface BarisJurnalValid {
  id_akun: string;
  debit: number;
  kredit: number;
  keterangan: string | null;
}

export interface JurnalValid {
  tanggal: string;
  keterangan: string;
  baris: BarisJurnalValid[];
  total: number;
}

function nominalSah(nilai: number): boolean {
  return Number.isInteger(nilai) && nilai >= 0;
}

/**
 * Cermin `validate_jurnal`. Keberadaan dan status aktif akun diperiksa
 * pemanggil, karena butuh database.
 */
export function validateJurnal(draft: JurnalDraftParsed): Hasil<JurnalValid> {
  if (!isValidDate(draft.tanggal)) {
    return { ok: false, error: "Tanggal jurnal tidak valid." };
  }
  const keterangan = draft.keterangan.trim();
  if (!keterangan) {
    return { ok: false, error: "Keterangan jurnal wajib diisi." };
  }
  if (panjang(keterangan) > MAKS_KETERANGAN) {
    return { ok: false, error: "Keterangan jurnal maksimal 200 karakter." };
  }
  if (draft.baris.length < 2) {
    return { ok: false, error: "Jurnal minimal dua baris." };
  }
  if (draft.baris.length > MAKS_BARIS_JURNAL) {
    return { ok: false, error: "Jurnal maksimal 100 baris." };
  }

  const baris: BarisJurnalValid[] = [];
  let totalDebit = 0;
  let totalKredit = 0;
  for (const [indeks, item] of draft.baris.entries()) {
    const n = indeks + 1;
    const idAkun = item.id_akun.trim();
    if (!idAkun) {
      return { ok: false, error: `Baris ${n}: akun wajib dipilih.` };
    }
    if (!nominalSah(item.debit) || !nominalSah(item.kredit)) {
      return {
        ok: false,
        error: `Baris ${n}: nominal harus rupiah bulat dan tidak negatif.`,
      };
    }
    if (item.debit > 0 === item.kredit > 0) {
      return {
        ok: false,
        error: `Baris ${n}: isi debit atau kredit, salah satu saja.`,
      };
    }
    if (item.debit > MAKS_NOMINAL || item.kredit > MAKS_NOMINAL) {
      return {
        ok: false,
        error: `Baris ${n}: nominal maksimal ${formatRupiah(MAKS_NOMINAL)}.`,
      };
    }
    const keteranganBaris = bersih(item.keterangan);
    if (keteranganBaris && panjang(keteranganBaris) > MAKS_KETERANGAN) {
      return {
        ok: false,
        error: `Baris ${n}: keterangan maksimal 200 karakter.`,
      };
    }
    totalDebit += item.debit;
    totalKredit += item.kredit;
    baris.push({
      id_akun: idAkun,
      debit: item.debit,
      kredit: item.kredit,
      keterangan: keteranganBaris,
    });
  }
  if (totalDebit !== totalKredit) {
    return {
      ok: false,
      error: `Total debit ${formatRupiah(totalDebit)} tidak sama dengan total kredit ${formatRupiah(totalKredit)}.`,
    };
  }
  return {
    ok: true,
    value: { tanggal: draft.tanggal, keterangan, baris, total: totalDebit },
  };
}

export interface JurnalAsal {
  id_jurnal: string;
  nomor: string;
  sumber: string;
  baris: readonly {
    id_baris: string;
    id_akun: string;
    debit: number;
    kredit: number;
    keterangan: string | null;
    urutan: number;
  }[];
}

export interface Pembalik {
  id_jurnal: string;
  keterangan: string;
  baris: {
    id_baris: string;
    id_akun: string;
    debit: number;
    kredit: number;
    keterangan: string | null;
    urutan: number;
  }[];
}

/**
 * Cermin `susun_pembalik`. Hanya jurnal Manual yang dibatalkan dari layar
 * Keuangan; jurnal modul dibatalkan dari modulnya, supaya transaksi sumbernya
 * ikut batal. Apakah jurnal ini SUDAH dibatalkan diperiksa pemanggil.
 */
export function susunPembalik(
  asal: JurnalAsal,
  alasan: string,
): Hasil<Pembalik> {
  if (asal.sumber === "Pembatalan") {
    return { ok: false, error: "Jurnal pembalik tidak bisa dibatalkan lagi." };
  }
  if (asal.sumber !== "Manual") {
    return {
      ok: false,
      error: `Jurnal dari modul ${asal.sumber} dibatalkan dari modulnya.`,
    };
  }
  const alasanBersih = alasan.trim();
  if (!alasanBersih) {
    return { ok: false, error: "Alasan pembatalan wajib diisi." };
  }
  if (panjang(alasanBersih) > MAKS_ALASAN_BATAL) {
    return { ok: false, error: "Alasan pembatalan maksimal 150 karakter." };
  }
  return {
    ok: true,
    value: {
      id_jurnal: idPembalik(asal.id_jurnal),
      keterangan: `Pembatalan ${asal.nomor}: ${alasanBersih}`,
      baris: asal.baris.map((item) => ({
        id_baris: idPembalik(item.id_baris),
        id_akun: item.id_akun,
        debit: item.kredit,
        kredit: item.debit,
        keterangan: item.keterangan,
        urutan: item.urutan,
      })),
    },
  };
}

// ── Laporan keuangan perusahaan (Fase K4a) ─────────────────────────────────────

export const MAKS_AKUN_KAS = 20;

/** Satu akun beserta jumlah debit dan kredit dalam rentang laporan. */
export interface AkunSaldo {
  id_akun: string;
  kode: string;
  nama: string;
  kelompok: string;
  saldo_normal: string;
  debit: number;
  kredit: number;
}

export interface BarisLaporan {
  id_akun: string;
  kode: string;
  nama: string;
  saldo: number;
}

function kelompokLaporan(
  akun: readonly AkunSaldo[],
  kelompok: string,
): { baris: BarisLaporan[]; total: number } {
  let total = 0;
  const baris: BarisLaporan[] = [];
  for (const a of akun) {
    if (a.kelompok !== kelompok) continue;
    const saldo = saldoAkun(a.saldo_normal as SaldoNormal, a.debit, a.kredit);
    if (saldo === 0) continue;
    total += saldo;
    baris.push({ id_akun: a.id_akun, kode: a.kode, nama: a.nama, saldo });
  }
  return { baris, total };
}

/**
 * Cermin `susun_posisi_keuangan`. Tutup buku belum ada, jadi selisih
 * pendapatan dan beban sepanjang masa tampil sebagai "Laba (rugi) bersih
 * berjalan" di ekuitas. Akun bersaldo nol tidak ditampilkan.
 */
export function susunPosisiKeuangan(akun: readonly AkunSaldo[]) {
  const aset = kelompokLaporan(akun, "Aset");
  const kewajiban = kelompokLaporan(akun, "Kewajiban");
  const ekuitas = kelompokLaporan(akun, "Ekuitas");
  const laba_bersih =
    kelompokLaporan(akun, "Pendapatan").total -
    kelompokLaporan(akun, "Beban").total;
  const totalEkuitas = ekuitas.total + laba_bersih;
  return {
    aset: aset.baris,
    kewajiban: kewajiban.baris,
    ekuitas: ekuitas.baris,
    laba_berjalan: laba_bersih,
    total_aset: aset.total,
    total_kewajiban: kewajiban.total,
    total_ekuitas: totalEkuitas,
    selisih: aset.total - (kewajiban.total + totalEkuitas),
  };
}

/** Cermin `susun_aktivitas`: Laporan Laba Rugi satu rentang. */
export function susunAktivitas(akun: readonly AkunSaldo[]) {
  const pendapatan = kelompokLaporan(akun, "Pendapatan");
  const beban = kelompokLaporan(akun, "Beban");
  return {
    pendapatan: pendapatan.baris,
    beban: beban.baris,
    total_pendapatan: pendapatan.total,
    total_beban: beban.total,
    laba_bersih: pendapatan.total - beban.total,
  };
}

/** Cermin `label_sumber_kas`. */
export function labelSumberKas(sumber: string): string {
  switch (sumber) {
    case "Payroll":
      return "Pembayaran gaji";
    case "Kasbon":
      return "Kasbon karyawan";
    case "Inventaris":
      return "Pembelian barang dan servis";
    case "Cicilan":
      return "Pembayaran cicilan pembelian";
    case "Manual":
      return "Jurnal umum";
    default:
      return "Pembatalan";
  }
}

/**
 * Cermin `susun_arus_kas`: arus kas metode langsung per sumber jurnal,
 * berurutan seperti `SUMBER_JURNAL`. Pembatalan sudah dipetakan pemanggil ke
 * sumber jurnal yang dibatalkannya.
 */
export function susunArusKas(
  saldoAwal: number,
  mutasi: ReadonlyArray<{ sumber: string; debit: number; kredit: number }>,
) {
  const kelompok: Array<{
    sumber: string;
    label: string;
    masuk: number;
    keluar: number;
    bersih: number;
  }> = [];
  let totalMasuk = 0;
  let totalKeluar = 0;
  for (const sumber of SUMBER_JURNAL) {
    let masuk = 0;
    let keluar = 0;
    for (const m of mutasi) {
      if (m.sumber !== sumber) continue;
      masuk += m.debit;
      keluar += m.kredit;
    }
    if (masuk === 0 && keluar === 0) continue;
    totalMasuk += masuk;
    totalKeluar += keluar;
    kelompok.push({
      sumber,
      label: labelSumberKas(sumber),
      masuk,
      keluar,
      bersih: masuk - keluar,
    });
  }
  return {
    saldo_awal: saldoAwal,
    kelompok,
    total_masuk: totalMasuk,
    total_keluar: totalKeluar,
    saldo_akhir: saldoAwal + totalMasuk - totalKeluar,
  };
}
