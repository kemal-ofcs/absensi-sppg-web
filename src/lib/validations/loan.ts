/**
 * Aturan kasbon karyawan (Fase K2), cermin `desktop/loan.rs`.
 *
 * Setiap fungsi di sini punya pasangan Rust bernama sama dalam snake_case dan
 * diuji dengan vektor yang sama (`loan.test.ts` ↔ `mod tests` di `loan.rs`).
 * Pesan galatnya pun wajib identik. Uang selalu rupiah bulat.
 */

import { z } from "zod";
import { formatRupiah, type Hasil } from "./accounting";

/** WAJIB sama dengan CHECK `keu_pinjaman.status` di ketiga DDL. */
export const STATUS_PINJAMAN = [
  "Diajukan",
  "Disetujui",
  "Ditolak",
  "Dibatalkan",
] as const;
/** WAJIB sama dengan CHECK `keu_pinjaman_mutasi.jenis` di ketiga DDL. */
export const JENIS_MUTASI_PINJAMAN = [
  "Pencairan",
  "Angsuran Gaji",
  "Pelunasan Tunai",
  "Pembatalan",
] as const;
export const AKSI_KEPUTUSAN = ["setujui", "tolak", "batalkan"] as const;

export const MAKS_POKOK = 1_000_000_000;
export const MAKS_KETERANGAN_PINJAMAN = 100;

/** Akun yang dipakai jurnal otomatis K2. Semuanya akun sistem di `akun-bawaan.json`. */
export const AKUN_PIUTANG_KARYAWAN = "akun-piutang-karyawan";
export const AKUN_BEBAN_GAJI = "akun-beban-gaji";
export const AKUN_BEBAN_BPJS = "akun-beban-bpjs";
export const AKUN_UTANG_PPH21 = "akun-utang-pph21";
export const AKUN_UTANG_BPJS = "akun-utang-bpjs";
export const AKUN_POTONGAN_GAJI = "akun-potongan-gaji";
export const AKUN_KAS = "akun-kas";

export type StatusPinjaman = (typeof STATUS_PINJAMAN)[number];
export type AksiKeputusan = (typeof AKSI_KEPUTUSAN)[number];

function panjang(value: string): number {
  return Array.from(value).length;
}

function rupiahPositif(nilai: number): boolean {
  return Number.isInteger(nilai) && nilai > 0;
}

/** Cermin `is_valid_periode`: `YYYY-MM`. */
export function isValidPeriode(value: string): boolean {
  const match = /^(\d{4})-(\d{2})$/.exec(value);
  if (!match) return false;
  const bulan = Number(match[2]);
  return Number(match[1]) >= 1900 && bulan >= 1 && bulan <= 12;
}

/** Id deterministik: dua perangkat yang mencatat hal yang sama menghasilkan PK yang sama. */
export const idTunda = (idPinjaman: string, periode: string) =>
  `tunda-${idPinjaman}-${periode}`;
export const idAngsuranGaji = (idItem: string, idPinjaman: string) =>
  `ang-${idItem}-${idPinjaman}`;
export const idPencairan = (idPinjaman: string) => `cair-${idPinjaman}`;
export const idPembatalanPinjaman = (idPinjaman: string) =>
  `batal-${idPinjaman}`;
export const idJurnalPencairan = (idPinjaman: string) =>
  `jrn-cair-${idPinjaman}`;
export const idJurnalPayroll = (idRun: string) => `pay-${idRun}`;

// ── Pengajuan ───────────────────────────────────────────────────────────────

export const pinjamanDraftSchema = z
  .object({
    id_pinjaman: z.string().nullish(),
    id_karyawan: z.string().default(""),
    pokok: z.number().default(0),
    cicilan: z.number().default(0),
    mulai_potong: z.string().default(""),
    keterangan: z.string().nullish(),
  })
  .strict();

export type PinjamanDraft = z.input<typeof pinjamanDraftSchema>;
type PinjamanDraftParsed = z.output<typeof pinjamanDraftSchema>;

export interface PinjamanValid {
  id_karyawan: string;
  pokok: number;
  cicilan: number;
  mulai_potong: string;
  keterangan: string | null;
}

/** Cermin `validate_pinjaman`. */
export function validatePinjaman(
  draft: PinjamanDraftParsed,
): Hasil<PinjamanValid> {
  const id_karyawan = draft.id_karyawan.trim();
  if (!id_karyawan) return { ok: false, error: "Karyawan wajib dipilih." };
  if (!rupiahPositif(draft.pokok)) {
    return {
      ok: false,
      error: "Pokok pinjaman harus rupiah bulat lebih dari nol.",
    };
  }
  if (draft.pokok > MAKS_POKOK) {
    return {
      ok: false,
      error: `Pokok pinjaman maksimal ${formatRupiah(MAKS_POKOK)}.`,
    };
  }
  if (!rupiahPositif(draft.cicilan)) {
    return { ok: false, error: "Cicilan harus rupiah bulat lebih dari nol." };
  }
  if (draft.cicilan > draft.pokok) {
    return {
      ok: false,
      error: "Cicilan tidak boleh melebihi pokok pinjaman.",
    };
  }
  if (!isValidPeriode(draft.mulai_potong)) {
    return { ok: false, error: "Bulan mulai potong tidak valid." };
  }
  const keterangan = draft.keterangan?.trim() || null;
  if (keterangan && panjang(keterangan) > MAKS_KETERANGAN_PINJAMAN) {
    return { ok: false, error: "Keterangan maksimal 100 karakter." };
  }
  return {
    ok: true,
    value: {
      id_karyawan,
      pokok: draft.pokok,
      cicilan: draft.cicilan,
      mulai_potong: draft.mulai_potong,
      keterangan,
    },
  };
}

/** Cermin `aturan_keputusan`: status baru, atau alasan penolakan. */
export function aturanKeputusan(
  status: string,
  aksi: string,
  adaAngsuran: boolean,
): Hasil<StatusPinjaman> {
  if (aksi === "setujui" || aksi === "tolak") {
    if (status !== "Diajukan") {
      return {
        ok: false,
        error: "Hanya pengajuan yang bisa disetujui atau ditolak.",
      };
    }
    return { ok: true, value: aksi === "setujui" ? "Disetujui" : "Ditolak" };
  }
  if (aksi === "batalkan") {
    if (status !== "Disetujui") {
      return {
        ok: false,
        error: "Hanya pinjaman yang sudah disetujui yang bisa dibatalkan.",
      };
    }
    if (adaAngsuran) {
      return {
        ok: false,
        error: "Pinjaman yang sudah diangsur tidak bisa dibatalkan.",
      };
    }
    return { ok: true, value: "Dibatalkan" };
  }
  return { ok: false, error: "Aksi tidak dikenal." };
}

/** Cermin `validate_pelunasan`. `sisa` adalah sisa efektif (lihat `sisa_efektif`). */
export function validatePelunasan(jumlah: number, sisa: number): Hasil<number> {
  if (!rupiahPositif(jumlah)) {
    return {
      ok: false,
      error: "Jumlah pelunasan harus rupiah bulat lebih dari nol.",
    };
  }
  if (jumlah > sisa) {
    return {
      ok: false,
      error: `Jumlah pelunasan melebihi sisa pinjaman ${formatRupiah(Math.max(0, sisa))}.`,
    };
  }
  return { ok: true, value: jumlah };
}

// ── Potongan gaji ───────────────────────────────────────────────────────────

export interface PinjamanAktif {
  id_pinjaman: string;
  cicilan: number;
  /** Pokok − angsuran tercatat − potongan di proses gaji lain yang belum dibayar. */
  sisa_efektif: number;
}

export interface PotonganKasbon {
  id_pinjaman: string;
  jumlah: number;
  /** Terpotong kurang dari cicilan karena gaji bersih tidak cukup. */
  sebagian: boolean;
}

/**
 * Cermin `potong_kasbon`. Kasbon dipotong TERAKHIR, dari gaji bersih yang
 * tersisa setelah komponen, BPJS, dan PPh 21, pinjaman tertua lebih dulu.
 * Gaji bersih tidak pernah minus; kekurangannya terbawa ke proses berikutnya
 * karena sisa pinjamannya memang belum berkurang.
 */
export function potongKasbon(
  netTersedia: number,
  pinjaman: readonly PinjamanAktif[],
): { total: number; rincian: PotonganKasbon[] } {
  let sisaNet = Math.max(0, netTersedia);
  const rincian: PotonganKasbon[] = [];
  for (const item of pinjaman) {
    const target = Math.min(item.cicilan, item.sisa_efektif);
    if (target <= 0) continue;
    const jumlah = Math.min(target, sisaNet);
    if (jumlah <= 0) continue;
    sisaNet -= jumlah;
    rincian.push({
      id_pinjaman: item.id_pinjaman,
      jumlah,
      sebagian: jumlah < target,
    });
  }
  return {
    total: rincian.reduce((sum, item) => sum + item.jumlah, 0),
    rincian,
  };
}

/** Entri `breakdown_snapshot.components` supaya slip yang ada langsung menampilkan cicilan. */
export function komponenKasbon(rincian: readonly PotonganKasbon[]) {
  return rincian.map((item) => ({
    id: `kasbon-${item.id_pinjaman}`,
    name: item.sebagian
      ? "Cicilan Kasbon (dipotong sebagian)"
      : "Cicilan Kasbon",
    category: "DEDUCTION",
    calc_type: "KASBON",
    rate: 0,
    nominal: item.jumlah,
  }));
}

export interface ItemPayroll {
  gross: number;
  net: number;
  pph21: number;
  bpjs_karyawan: number;
  bpjs_perusahaan: number;
  kasbon: number;
}

export interface BarisJurnalOtomatis {
  id_akun: string;
  debit: number;
  kredit: number;
}

/**
 * Cermin `susun_jurnal_payroll`. Satu jurnal per proses gaji. Potongan
 * komponen (denda, koperasi, dan sejenisnya) adalah selisih yang tersisa,
 * sehingga jurnalnya seimbang karena konstruksinya, bukan karena kebetulan.
 */
export function susunJurnalPayroll(
  items: readonly ItemPayroll[],
  idAkunBayar: string,
): BarisJurnalOtomatis[] {
  const jumlah = (pilih: (item: ItemPayroll) => number) =>
    items.reduce((sum, item) => sum + pilih(item), 0);
  const gross = jumlah((item) => item.gross);
  const net = jumlah((item) => item.net);
  const pph21 = jumlah((item) => item.pph21);
  const bpjsKaryawan = jumlah((item) => item.bpjs_karyawan);
  const bpjsPerusahaan = jumlah((item) => item.bpjs_perusahaan);
  const kasbon = jumlah((item) => item.kasbon);
  const potonganLain = gross - net - pph21 - bpjsKaryawan - kasbon;

  const baris: BarisJurnalOtomatis[] = [
    { id_akun: AKUN_BEBAN_GAJI, debit: gross, kredit: 0 },
    { id_akun: AKUN_BEBAN_BPJS, debit: bpjsPerusahaan, kredit: 0 },
    { id_akun: idAkunBayar, debit: 0, kredit: net },
    { id_akun: AKUN_UTANG_PPH21, debit: 0, kredit: pph21 },
    {
      id_akun: AKUN_UTANG_BPJS,
      debit: 0,
      kredit: bpjsKaryawan + bpjsPerusahaan,
    },
    { id_akun: AKUN_PIUTANG_KARYAWAN, debit: 0, kredit: kasbon },
    {
      id_akun: AKUN_POTONGAN_GAJI,
      debit: Math.max(0, -potonganLain),
      kredit: Math.max(0, potonganLain),
    },
  ];
  return baris.filter((item) => item.debit > 0 || item.kredit > 0);
}
