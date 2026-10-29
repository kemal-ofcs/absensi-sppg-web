/**
 * Pembelian barang secara cicilan (v31), cermin `desktop/cicilan.rs`. Sidik
 * syarat ada di `services/cicilan.ts` karena butuh `node:crypto`.
 *
 * Diuji dengan vektor yang sama di kedua bahasa (`cicilan.test.ts` ↔
 * `mod tests` di `cicilan.rs`). Pesan galatnya pun wajib identik.
 */

import { z } from "zod";
import { formatRupiah, MAKS_KETERANGAN, MAKS_NOMINAL } from "./accounting";
import { type Hasil, isValidDate } from "./inventory";

export const MAKS_KREDITUR = 100;
export const MAKS_NOMOR_KONTRAK = 50;
export const MAKS_TENOR = 360;
export const MAKS_SETIAP = 365;
/** Alasan potongan dan keterangan denda. */
export const MAKS_ALASAN_BAYAR = 150;
export const MAKS_REFERENSI = 50;
/** Cermin `MAKS_DAFTAR_CICILAN`. */
export const MAKS_DAFTAR_CICILAN = 500;
export const POLA_JADWAL = ["Berkala", "Manual"] as const;
/** WAJIB sama dengan CHECK `keu_cicilan.satuan`. */
export const SATUAN_JADWAL = ["Hari", "Minggu", "Bulan", "Tahun"] as const;
/** WAJIB sama dengan CHECK `keu_cicilan_bayar.jenis`. */
export const JENIS_BAYAR = ["Bayar", "Denda"] as const;
export const AKUN_UTANG_CICILAN = "akun-utang-cicilan";
export const AKUN_BEBAN_BUNGA = "akun-beban-bunga";
export const AKUN_BEBAN_DENDA = "akun-beban-denda";
/** Potongan yang melebihi bunga selalu masuk akun ini (PRD §4.4). */
export const AKUN_PENDAPATAN_LAIN = "akun-pendapatan-lain";

export const STATUS_CICILAN = [
  "Draf",
  "Menunggu barang",
  "Menunggu ACC ulang",
  "Berjalan",
  "Menunggak",
  "Lunas",
  "Ditutup",
  "Dibatalkan",
] as const;
export type StatusCicilan = (typeof STATUS_CICILAN)[number];
export type StatusJadwal = "Lunas" | "Sebagian" | "Belum" | "Terlambat";

/** Cermin `id_cicilan`. Satu kontrak per pengajuan. */
export function idCicilan(idPengajuan: string): string {
  return `cil-${idPengajuan}`;
}

/** Cermin `id_jadwal`. */
export function idJadwal(idCicilan: string, ke: number): string {
  return `${idCicilan}-${ke}`;
}

/** Cermin `id_jurnal_cicilan`. */
export function idJurnalCicilan(idBayar: string): string {
  return `jrn-${idBayar}`;
}

function panjang(value: string): number {
  return Array.from(value).length;
}

function bersih(value: string | null | undefined): string | null {
  const isi = value?.trim();
  return isi ? isi : null;
}

function hariDalamBulan(tahun: number, bulan: number): number {
  const kabisat = (tahun % 4 === 0 && tahun % 100 !== 0) || tahun % 400 === 0;
  if (bulan === 2) return kabisat ? 29 : 28;
  return [4, 6, 9, 11].includes(bulan) ? 30 : 31;
}

function formatTanggal(tahun: number, bulan: number, hari: number): string {
  return `${String(tahun).padStart(4, "0")}-${String(bulan).padStart(2, "0")}-${String(hari).padStart(2, "0")}`;
}

function tambahBulan(tanggal: string, bulan: number): string {
  const tahun = Number(tanggal.slice(0, 4));
  const bln = Number(tanggal.slice(5, 7));
  const hari = Number(tanggal.slice(8, 10));
  const total = tahun * 12 + (bln - 1) + bulan;
  const tahunBaru = Math.floor(total / 12);
  const bulanBaru = total - tahunBaru * 12 + 1;
  return formatTanggal(
    tahunBaru,
    bulanBaru,
    Math.min(hari, hariDalamBulan(tahunBaru, bulanBaru)),
  );
}

function tambahHari(tanggal: string, jumlah: number): string {
  const waktu = Date.UTC(
    Number(tanggal.slice(0, 4)),
    Number(tanggal.slice(5, 7)) - 1,
    Number(tanggal.slice(8, 10)) + jumlah,
  );
  const d = new Date(waktu);
  return formatTanggal(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

/** Cermin `susun_jadwal` (PRD §3.2): baris angsuran ke-1..tenor. */
export function susunJadwal(
  pertama: string,
  setiap: number,
  satuan: string,
  tenor: number,
  nominal: number,
): Hasil<{ jatuh_tempo: string; nominal: number }[]> {
  if (!isValidDate(pertama)) {
    return { ok: false, error: "Jatuh tempo pertama tidak valid." };
  }
  if (!Number.isInteger(setiap) || setiap < 1 || setiap > MAKS_SETIAP) {
    return { ok: false, error: `Jarak angsuran harus 1–${MAKS_SETIAP}.` };
  }
  if (!(SATUAN_JADWAL as readonly string[]).includes(satuan)) {
    return { ok: false, error: "Satuan jarak angsuran tidak dikenal." };
  }
  if (!Number.isInteger(tenor) || tenor < 1 || tenor > MAKS_TENOR) {
    return { ok: false, error: `Tenor harus 1–${MAKS_TENOR} kali.` };
  }
  if (!Number.isInteger(nominal) || nominal <= 0) {
    return { ok: false, error: "Nominal per angsuran harus lebih dari 0." };
  }
  if (nominal > MAKS_NOMINAL) {
    return { ok: false, error: "Nominal per angsuran terlalu besar." };
  }
  const baris: { jatuh_tempo: string; nominal: number }[] = [];
  for (let indeks = 0; indeks < tenor; indeks++) {
    const langkah = indeks * setiap;
    const tanggal =
      satuan === "Hari"
        ? tambahHari(pertama, langkah)
        : satuan === "Minggu"
          ? tambahHari(pertama, langkah * 7)
          : satuan === "Bulan"
            ? tambahBulan(pertama, langkah)
            : tambahBulan(pertama, langkah * 12);
    if (!isValidDate(tanggal)) {
      return { ok: false, error: "Jadwal terlalu panjang." };
    }
    baris.push({ jatuh_tempo: tanggal, nominal });
  }
  return { ok: true, value: baris };
}

/** Cermin `JadwalDraft` (`deny_unknown_fields`). */
const jadwalDraftSchema = z
  .object({
    jatuh_tempo: z.string().max(10).default(""),
    nominal: z.number().int().default(0),
  })
  .strict();

/** Cermin `SyaratDraft` (`deny_unknown_fields`). */
export const syaratDraftSchema = z
  .object({
    kreditur: z.string().max(1000).default(""),
    nomor_kontrak: z.string().max(500).nullable().optional(),
    uang_muka: z.number().int().default(0),
    pola: z.string().max(20).default(""),
    jatuh_tempo_pertama: z.string().max(10).nullable().optional(),
    setiap: z.number().int().nullable().optional(),
    satuan: z.string().max(20).nullable().optional(),
    tenor: z.number().int().nullable().optional(),
    nominal: z.number().int().nullable().optional(),
    // Batas longgar penahan beban; batas sebenarnya dari validasiSyarat.
    jadwal: z.array(jadwalDraftSchema).max(1000).default([]),
  })
  .strict();
export type SyaratDraft = z.input<typeof syaratDraftSchema>;
export type SyaratDraftParsed = z.output<typeof syaratDraftSchema>;

export interface BarisJadwal {
  ke: number;
  jatuh_tempo: string;
  nominal: number;
}

export interface Syarat {
  kreditur: string;
  nomor_kontrak: string | null;
  uang_muka: number;
  pola: string;
  setiap: number | null;
  satuan: string | null;
  /** Urut `ke`; ke-0 = DP. */
  jadwal: BarisJadwal[];
}

/**
 * Cermin `validate_syarat` (PRD §3.2, keputusan K). `tanggalAwal` = tanggal
 * pengajuan; `tanggalDp` = jatuh tempo baris DP (tanggal pengajuan selama
 * Draf, tanggal terima saat aktivasi).
 */
export function validasiSyarat(
  draft: SyaratDraftParsed,
  hargaTunai: number,
  tanggalAwal: string,
  tanggalDp: string,
): Hasil<Syarat> {
  const kreditur = draft.kreditur.trim();
  if (!kreditur) return { ok: false, error: "Kreditur wajib diisi." };
  if (panjang(kreditur) > MAKS_KREDITUR) {
    return {
      ok: false,
      error: `Kreditur maksimal ${MAKS_KREDITUR} karakter.`,
    };
  }
  const nomorKontrak = bersih(draft.nomor_kontrak);
  if (nomorKontrak !== null && panjang(nomorKontrak) > MAKS_NOMOR_KONTRAK) {
    return {
      ok: false,
      error: `Nomor kontrak maksimal ${MAKS_NOMOR_KONTRAK} karakter.`,
    };
  }
  if (hargaTunai <= 0) {
    return {
      ok: false,
      error: "Harga tunai harus lebih dari 0 untuk pembelian cicilan.",
    };
  }
  if (draft.uang_muka < 0 || draft.uang_muka >= hargaTunai) {
    return {
      ok: false,
      error: "Uang muka harus 0 atau lebih dan lebih kecil dari harga tunai.",
    };
  }
  let pola: string;
  let setiap: number | null = null;
  let satuan: string | null = null;
  let angsuran: { jatuh_tempo: string; nominal: number }[];
  const polaDraft = draft.pola.trim();
  if (polaDraft === "Berkala") {
    satuan = bersih(draft.satuan) ?? "";
    setiap = draft.setiap ?? 0;
    const susun = susunJadwal(
      (draft.jatuh_tempo_pertama ?? "").trim(),
      setiap,
      satuan,
      draft.tenor ?? 0,
      draft.nominal ?? 0,
    );
    if (!susun.ok) return susun;
    pola = "Berkala";
    angsuran = susun.value;
  } else if (polaDraft === "Manual") {
    if (draft.jadwal.length === 0) {
      return { ok: false, error: "Isi minimal satu angsuran." };
    }
    if (draft.jadwal.length > MAKS_TENOR) {
      return { ok: false, error: `Tenor harus 1–${MAKS_TENOR} kali.` };
    }
    angsuran = [];
    for (const [indeks, isian] of draft.jadwal.entries()) {
      const nomor = indeks + 1;
      const tanggal = isian.jatuh_tempo.trim();
      if (!isValidDate(tanggal)) {
        return {
          ok: false,
          error: `Angsuran ${nomor}: tanggal jatuh tempo tidak valid.`,
        };
      }
      if (isian.nominal <= 0) {
        return {
          ok: false,
          error: `Angsuran ${nomor}: nominal harus lebih dari 0.`,
        };
      }
      if (isian.nominal > MAKS_NOMINAL) {
        return {
          ok: false,
          error: `Angsuran ${nomor}: nominal terlalu besar.`,
        };
      }
      angsuran.push({ jatuh_tempo: tanggal, nominal: isian.nominal });
    }
    pola = "Manual";
  } else {
    return { ok: false, error: "Pola jadwal tidak dikenal." };
  }
  for (let indeks = 1; indeks < angsuran.length; indeks++) {
    if (
      (angsuran[indeks]?.jatuh_tempo ?? "") <=
      (angsuran[indeks - 1]?.jatuh_tempo ?? "")
    ) {
      return {
        ok: false,
        error: `Angsuran ${indeks + 1}: jatuh tempo harus setelah angsuran sebelumnya.`,
      };
    }
  }
  if ((angsuran[0]?.jatuh_tempo ?? "") < tanggalAwal) {
    return {
      ok: false,
      error:
        "Jatuh tempo angsuran pertama tidak boleh sebelum tanggal pengajuan.",
    };
  }
  const totalAngsuran = angsuran.reduce((jumlah, b) => jumlah + b.nominal, 0);
  if (draft.uang_muka + totalAngsuran > MAKS_NOMINAL) {
    return { ok: false, error: "Total bayar terlalu besar." };
  }
  if (totalAngsuran < hargaTunai - draft.uang_muka) {
    return {
      ok: false,
      error:
        "Total angsuran kurang dari harga tunai dikurangi uang muka (bunga tidak boleh negatif).",
    };
  }
  return {
    ok: true,
    value: {
      kreditur,
      nomor_kontrak: nomorKontrak,
      uang_muka: draft.uang_muka,
      pola,
      setiap,
      satuan,
      jadwal: [
        { ke: 0, jatuh_tempo: tanggalDp, nominal: draft.uang_muka },
        ...angsuran.map((b, indeks) => ({ ke: indeks + 1, ...b })),
      ],
    },
  };
}

/** Bentuk kanonik untuk `sidikSyarat` (cermin `sidik_syarat`). */
export function kanonikSyarat(syarat: Syarat): string {
  const kepala = [
    syarat.kreditur,
    syarat.nomor_kontrak ?? "",
    String(syarat.uang_muka),
    syarat.pola,
    syarat.setiap === null ? "" : String(syarat.setiap),
    syarat.satuan ?? "",
  ].join("\u001f");
  const jadwal = [...syarat.jadwal]
    .sort((a, b) => a.ke - b.ke)
    .map((b) =>
      [String(b.ke), b.jatuh_tempo, String(b.nominal)].join("\u001f"),
    );
  return [kepala, ...jadwal].join("\u001e");
}

export interface Besaran {
  harga_tunai: number;
  uang_muka: number;
  total_angsuran: number;
  total_bayar: number;
  bunga: number;
}

/** Cermin `besaran` (PRD §4.1). */
export function besaranCicilan(
  hargaTunai: number,
  jadwal: readonly BarisJadwal[],
): Besaran {
  let uangMuka = 0;
  let totalAngsuran = 0;
  for (const b of jadwal) {
    if (b.ke === 0) uangMuka += b.nominal;
    else totalAngsuran += b.nominal;
  }
  const totalBayar = uangMuka + totalAngsuran;
  return {
    harga_tunai: hargaTunai,
    uang_muka: uangMuka,
    total_angsuran: totalAngsuran,
    total_bayar: totalBayar,
    bunga: Math.max(totalBayar - hargaTunai, 0),
  };
}

/**
 * Cermin `bunga_kumulatif`: bunga yang sudah diakui saat jadwal tertutup
 * sebesar `tertutup`, dibulatkan setengah ke atas dengan BigInt supaya hasil
 * kali di atas 2^53 tetap tepat.
 */
export function bungaKumulatif(b: Besaran, tertutup: number): number {
  if (b.total_angsuran <= 0) return 0;
  const angsuran = BigInt(
    Math.min(Math.max(tertutup - b.uang_muka, 0), b.total_angsuran),
  );
  const tj = BigInt(b.total_angsuran);
  const dua = BigInt(2);
  return Number((dua * angsuran * BigInt(b.bunga) + tj) / (dua * tj));
}

/** Cermin `bagi_pokok_bunga` (PRD §4.2): `[pokok, bunga]`. */
export function bagiPokokBunga(
  b: Besaran,
  c0: number,
  c1: number,
): [number, number] {
  const bunga = bungaKumulatif(b, c1) - bungaKumulatif(b, c0);
  return [c1 - c0 - bunga, bunga];
}

export interface AkunJurnalCicilan {
  utang: string;
  bunga: string;
  denda: string;
  bayar: string;
}

/**
 * Cermin `susun_jurnal_cicilan` (PRD §4.3): `[id_akun, debit, kredit]`,
 * baris bernilai 0 dibuang. Seimbang karena konstruksinya.
 */
export function susunJurnalCicilan(
  jenis: string,
  nominal: number,
  potongan: number,
  c0: number,
  b: Besaran,
  akun: AkunJurnalCicilan,
): [string, number, number][] {
  let baris: [string, number, number][];
  if (jenis === "Denda") {
    baris = [
      [akun.denda, nominal, 0],
      [akun.bayar, 0, nominal],
    ];
  } else {
    const [pokok, bunga] = bagiPokokBunga(b, c0, c0 + nominal + potongan);
    baris = [
      [akun.utang, pokok, 0],
      [akun.bunga, Math.max(bunga - potongan, 0), 0],
      [akun.bayar, 0, nominal],
      [AKUN_PENDAPATAN_LAIN, 0, Math.max(potongan - bunga, 0)],
    ];
  }
  return baris.filter(([, debit, kredit]) => debit !== 0 || kredit !== 0);
}

/** Cermin `keterangan_jurnal_cicilan`, dipotong ke batas keterangan jurnal. */
export function keteranganJurnalCicilan(
  jenis: string,
  kreditur: string,
  nomorPengajuan: string,
  keterangan: string | null,
): string {
  const teks =
    jenis === "Denda"
      ? `Denda cicilan ${kreditur}: ${keterangan ?? ""}`
      : `Bayar cicilan ${kreditur} (${nomorPengajuan})`;
  return Array.from(teks).slice(0, MAKS_KETERANGAN).join("");
}

export interface BarisAlokasi {
  terbayar: number;
  status: StatusJadwal;
}

/** Cermin `alokasi_jadwal`: tertutup mengisi baris dari `ke` terkecil. */
export function alokasiJadwal(
  jadwal: readonly BarisJadwal[],
  tertutup: number,
  hariIni: string,
): BarisAlokasi[] {
  let sisa = Math.max(tertutup, 0);
  return jadwal.map((baris) => {
    const terbayar = Math.min(sisa, baris.nominal);
    sisa -= terbayar;
    const status: StatusJadwal =
      terbayar >= baris.nominal
        ? "Lunas"
        : baris.jatuh_tempo < hariIni
          ? "Terlambat"
          : terbayar > 0
            ? "Sebagian"
            : "Belum";
    return { terbayar, status };
  });
}

/** Cermin `perlu_acc_ulang` (PRD §3.4). */
export function perluAccUlang(
  totalBayar: number,
  totalDisetujui: number | null,
  sidik: string,
  sidikDisetujuiUlang: string | null,
): boolean {
  return (
    totalDisetujui !== null &&
    totalBayar > totalDisetujui &&
    sidikDisetujuiUlang !== sidik
  );
}

export interface KeadaanCicilan {
  /** Pengajuan Dibatalkan atau Ditolak. */
  pengajuan_batal: boolean;
  pengajuan_menunggu: boolean;
  pengajuan_ditutup: boolean;
  diterima_penuh: boolean;
  diaktifkan: boolean;
  ditutup: boolean;
  perlu_acc_ulang: boolean;
  tertutup: number;
  total_bayar: number;
  ada_terlambat: boolean;
}

/** Cermin `status_cicilan` (PRD §3.8), diperiksa berurutan. */
export function statusCicilan(k: KeadaanCicilan): StatusCicilan {
  const aktif = k.diterima_penuh && k.diaktifkan;
  if (k.pengajuan_batal || (!aktif && k.pengajuan_ditutup)) return "Dibatalkan";
  if (k.ditutup) return "Ditutup";
  if (k.pengajuan_menunggu) return "Draf";
  if (!aktif) return "Menunggu barang";
  if (k.perlu_acc_ulang) return "Menunggu ACC ulang";
  if (k.tertutup >= k.total_bayar) return "Lunas";
  if (k.ada_terlambat) return "Menunggak";
  return "Berjalan";
}

/**
 * Cermin `wajib_terima_penuh` (keputusan C). `acc` = [id_baris, urutan,
 * sisa]; `kiriman` = [id_baris, jumlah].
 */
export function wajibTerimaPenuh(
  acc: readonly [string, number, number][],
  kiriman: readonly [string, number][],
): Hasil<null> {
  for (const [idBaris, urutan, sisa] of acc) {
    const jumlah = kiriman
      .filter(([id]) => id.trim() === idBaris)
      .reduce((total, [, n]) => total + n, 0);
    if (jumlah !== sisa) {
      return {
        ok: false,
        error: `Baris ${urutan}: pengajuan cicilan wajib diterima penuh sesuai ACC dalam satu penerimaan.`,
      };
    }
  }
  return { ok: true, value: null };
}

/** Cermin `BayarDraft` (`deny_unknown_fields`). */
export const bayarDraftSchema = z
  .object({
    id_cicilan: z.string().max(200).default(""),
    jenis: z.string().max(20).default(""),
    tanggal: z.string().max(10).default(""),
    nominal: z.number().int().default(0),
    potongan: z.number().int().default(0),
    alasan_potongan: z.string().max(2000).nullable().optional(),
    keterangan: z.string().max(2000).nullable().optional(),
    referensi: z.string().max(500).nullable().optional(),
    id_akun_bayar: z.string().max(160).default(""),
  })
  .strict();
export type BayarDraft = z.input<typeof bayarDraftSchema>;

export interface BayarValid {
  jenis: "Bayar" | "Denda";
  tanggal: string;
  nominal: number;
  potongan: number;
  alasan_potongan: string | null;
  keterangan: string | null;
  referensi: string | null;
}

/**
 * Cermin `validate_bayar` (PRD §3.6). `sisa` = total jadwal − tertutup,
 * hanya diperiksa di perangkat/Web; cloud tidak pernah menolak pembayaran.
 */
export function validasiBayar(
  draft: z.output<typeof bayarDraftSchema>,
  tanggalAwal: string,
  hariIni: string,
  sisa: number,
): Hasil<BayarValid> {
  const tanggal = draft.tanggal.trim();
  if (!isValidDate(tanggal)) {
    return { ok: false, error: "Tanggal bayar tidak valid." };
  }
  if (tanggal > hariIni) {
    return { ok: false, error: "Tanggal bayar tidak boleh setelah hari ini." };
  }
  if (tanggal < tanggalAwal) {
    return {
      ok: false,
      error: "Tanggal bayar tidak boleh sebelum tanggal pengajuan.",
    };
  }
  const referensi = bersih(draft.referensi);
  if (referensi !== null && panjang(referensi) > MAKS_REFERENSI) {
    return {
      ok: false,
      error: `Referensi maksimal ${MAKS_REFERENSI} karakter.`,
    };
  }
  const jenis = draft.jenis.trim();
  if (jenis === "Bayar") {
    if (draft.nominal < 0 || draft.nominal > MAKS_NOMINAL) {
      return { ok: false, error: "Nominal dibayar tidak valid." };
    }
    if (draft.potongan < 0 || draft.potongan > MAKS_NOMINAL) {
      return { ok: false, error: "Potongan tidak valid." };
    }
    let alasanPotongan: string | null = null;
    if (draft.potongan > 0) {
      alasanPotongan = bersih(draft.alasan_potongan);
      if (alasanPotongan === null) {
        return { ok: false, error: "Alasan potongan wajib diisi." };
      }
      if (panjang(alasanPotongan) > MAKS_ALASAN_BAYAR) {
        return {
          ok: false,
          error: `Alasan potongan maksimal ${MAKS_ALASAN_BAYAR} karakter.`,
        };
      }
    }
    const total = draft.nominal + draft.potongan;
    if (total === 0) {
      return { ok: false, error: "Isi nominal dibayar atau potongan." };
    }
    if (total > sisa) {
      return {
        ok: false,
        error: `Nominal ditambah potongan melebihi sisa jadwal (${formatRupiah(Math.max(sisa, 0))}).`,
      };
    }
    return {
      ok: true,
      value: {
        jenis: "Bayar",
        tanggal,
        nominal: draft.nominal,
        potongan: draft.potongan,
        alasan_potongan: alasanPotongan,
        keterangan: null,
        referensi,
      },
    };
  }
  if (jenis === "Denda") {
    if (draft.nominal <= 0) {
      return { ok: false, error: "Nominal denda harus lebih dari 0." };
    }
    if (draft.nominal > MAKS_NOMINAL) {
      return { ok: false, error: "Nominal denda terlalu besar." };
    }
    if (draft.potongan !== 0) {
      return { ok: false, error: "Denda tidak memakai potongan." };
    }
    const keterangan = bersih(draft.keterangan);
    if (keterangan === null) {
      return { ok: false, error: "Keterangan denda wajib diisi." };
    }
    if (panjang(keterangan) > MAKS_ALASAN_BAYAR) {
      return {
        ok: false,
        error: `Keterangan denda maksimal ${MAKS_ALASAN_BAYAR} karakter.`,
      };
    }
    return {
      ok: true,
      value: {
        jenis: "Denda",
        tanggal,
        nominal: draft.nominal,
        potongan: 0,
        alasan_potongan: null,
        keterangan,
        referensi,
      },
    };
  }
  return { ok: false, error: "Jenis pembayaran tidak dikenal." };
}

/** Sidik kiriman layar: 64 hex huruf kecil, atau `null` bila kosong/cacat. */
export function normalSidik(sidik: string | null | undefined): string | null {
  const isi = sidik?.trim().toLowerCase() ?? "";
  return /^[0-9a-f]{64}$/.test(isi) ? isi : null;
}

/** Cermin `AccUlangDraft`. */
export const accUlangDraftSchema = z
  .object({
    id_cicilan: z.string().max(200).default(""),
    sidik_syarat: z.string().max(200).default(""),
  })
  .strict();

/** Syarat yang menempel di daftar pengajuan. */
export interface SyaratPengajuan {
  kreditur: string;
  nomor_kontrak: string | null;
  uang_muka: number;
  pola: "Berkala" | "Manual";
  setiap: number | null;
  satuan: (typeof SATUAN_JADWAL)[number] | null;
  sidik_syarat: string;
  id_akun_utang: string;
  id_akun_bunga: string;
  id_akun_denda: string;
  total_disetujui: number | null;
  diaktifkan_pada: string | null;
  jadwal: BarisJadwal[];
}

export interface BayarCicilan {
  id_bayar: string;
  id_cicilan: string;
  jenis: "Bayar" | "Denda";
  tanggal: string;
  nominal: number;
  potongan: number;
  alasan_potongan: string | null;
  keterangan: string | null;
  referensi: string | null;
  id_akun_bayar: string;
  dicatat_oleh: string;
  created_at: string;
  batal: { alasan: string; oleh: string; pada: string } | null;
  nomor_jurnal: string | null;
}

export interface KontrakCicilan {
  id_cicilan: string;
  id_pengajuan: string;
  nomor_pengajuan: string;
  tanggal_pengajuan: string;
  keperluan: string;
  barang: string;
  diajukan_oleh: string;
  kreditur: string;
  nomor_kontrak: string | null;
  uang_muka: number;
  pola: "Berkala" | "Manual";
  setiap: number | null;
  satuan: string | null;
  id_akun_utang: string;
  id_akun_bunga: string;
  id_akun_denda: string;
  sidik_syarat: string;
  total_disetujui: number | null;
  diaktifkan_pada: string | null;
  disetujui_ulang_pada: string | null;
  disetujui_ulang_oleh: string | null;
  ditutup_pada: string | null;
  ditutup_oleh: string | null;
  alasan_tutup: string | null;
  status: StatusCicilan;
  harga_tunai: number;
  total_angsuran: number;
  total_bayar: number;
  bunga: number;
  tertutup: number;
  sisa_pokok: number;
  sisa_bunga: number;
  lebih_bayar: number;
  total_denda: number;
  penerimaan_dijurnal: boolean;
  jadwal: (BarisJadwal & BarisAlokasi)[];
  bayar: BayarCicilan[];
}

export interface DaftarCicilan {
  kontrak: KontrakCicilan[];
  terpotong: boolean;
  hari_ini: string;
}

/** Besaran langsung dari isian layar (formulir syarat). */
export function ringkasSyarat(
  hargaTunai: number,
  hasil: Hasil<Syarat>,
): Besaran | null {
  return hasil.ok ? besaranCicilan(hargaTunai, hasil.value.jadwal) : null;
}

/**
 * Tanda angka tab Cicilan (§7.2): kontrak Menunggak, Menunggu ACC ulang,
 * lebih bayar, dan angsuran yang jatuh tempo dalam 7 hari.
 */
export function jumlahPerhatianCicilan(daftar: DaftarCicilan): number {
  const batas = tambahHari(daftar.hari_ini, 7);
  let jumlah = 0;
  for (const k of daftar.kontrak) {
    if (k.status === "Menunggak" || k.status === "Menunggu ACC ulang") jumlah++;
    if (k.lebih_bayar > 0) jumlah++;
    if (k.status === "Berjalan" || k.status === "Menunggak") {
      jumlah += k.jadwal.filter(
        (b) =>
          b.status !== "Lunas" &&
          b.jatuh_tempo >= daftar.hari_ini &&
          b.jatuh_tempo <= batas,
      ).length;
    }
  }
  return jumlah;
}

/** Proyeksi kas keluar per bulan dari sisa jadwal; tunggakan masuk bulan pertama. */
export function proyeksiKas(
  daftar: DaftarCicilan,
  bulan = 3,
): { bulan: string; jumlah: number }[] {
  const awal = daftar.hari_ini.slice(0, 7);
  const kunci = Array.from({ length: bulan }, (_, i) =>
    tambahBulan(`${awal}-01`, i).slice(0, 7),
  );
  const hasil = kunci.map((b) => ({ bulan: b, jumlah: 0 }));
  for (const k of daftar.kontrak) {
    if (k.status !== "Berjalan" && k.status !== "Menunggak") continue;
    for (const b of k.jadwal) {
      const sisa = b.nominal - b.terbayar;
      const bln = b.jatuh_tempo.slice(0, 7);
      if (sisa <= 0 || bln > (kunci[bulan - 1] ?? "")) continue;
      const target = hasil[bln < awal ? 0 : kunci.indexOf(bln)];
      if (target) target.jumlah += sisa;
    }
  }
  return hasil;
}
