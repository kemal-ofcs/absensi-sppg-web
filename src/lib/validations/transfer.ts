/**
 * HRIS fase 12 (skema v44): berkas transfer gaji ke bank.
 *
 * Cermin `desktop/transfer.rs`, diuji dengan vektor yang sama
 * (`transfer.vektor.json`). `app_bank`, `app_bank_rekening`, dan
 * `app_bank_format` KHUSUS CLOUD (§27.2). Nominal = `payroll_items.net_salary`
 * apa adanya, dijumlahkan sebagai bilangan bulat (aturan 13). Baris yang tidak
 * bisa ditransfer ditandai, tidak ditolak.
 */
import type { PermissionKey } from "@/lib/rbac/catalog";
import bankBawaan from "./bank-bawaan.json";
import {
  kunciNama,
  MAKS_NAMA,
  MAKS_TEKS,
  nomorIdentitas,
  PANJANG_REKENING,
  teksIsian,
} from "./hris";
import { isValidDate } from "./inventory";

export interface BankBawaan {
  id_bank: string;
  nama: string;
  kode: string | null;
  alias: string[];
}

/** Kode BI diverifikasi 13 Nov 2026; semuanya bisa disunting di Pengaturan. */
export const BANK_BAWAAN: readonly BankBawaan[] = bankBawaan;

/** Cermin `SEED_BANK_SQL`. Bank yang sudah disunting tidak ditimpa. */
export const SEED_BANK_SQL =
  "INSERT OR IGNORE INTO app_bank (id_bank, nama, kode, alias, is_bawaan) VALUES (?1, ?2, ?3, ?4, 1);";

export function seedBankArgs(bank: BankBawaan) {
  return [bank.id_bank, bank.nama, bank.kode, JSON.stringify(bank.alias)];
}

// ── Konstanta ──────────────────────────────────────────────────────────────

/**
 * Cermin `IZIN_UNDUH`: mengunduh berkas membuka nomor rekening semua
 * karyawan, jadi wajib KEDUANYA (Q-157 (a)).
 */
export const IZIN_UNDUH = [
  "payroll.run.disburse",
  "hr.finance.view",
] as const satisfies readonly PermissionKey[];
/** Cermin `IZIN_PENGATURAN`: khusus Superadmin (Q-173 (a)). */
export const IZIN_PENGATURAN =
  "payroll.config.manage" as const satisfies PermissionKey;
/** Cermin `JENIS_PENGATURAN`: jenis isian simpan pengaturan. */
export const JENIS_PENGATURAN = ["bank", "rekening", "format"] as const;
export type JenisPengaturan = (typeof JENIS_PENGATURAN)[number];

export const MAKS_ALIAS = 20;
export const MAKS_KOLOM_FORMAT = 30;
export const MAKS_JUDUL_KOLOM = 60;
export const MAKS_TEKS_KOLOM = 100;
export const MAKS_PANJANG_BERITA = 200;
/** WAJIB sama dengan CHECK `app_bank_format.jenis`. */
export const JENIS_BERKAS = ["csv", "txt", "xlsx"] as const;
/** WAJIB sama dengan CHECK `app_bank_format.pemisah` (`char(9)` = tab). */
export const PEMISAH = [",", ";", "\t", "|"] as const;
/** WAJIB sama dengan CHECK `app_bank_format.cakupan`. */
export const CAKUPAN = ["semua", "sesama", "antarbank"] as const;
/** Isian yang boleh dipakai kolom format (§27.3). */
export const ISIAN_TRANSFER = [
  "nama_karyawan",
  "kode_karyawan",
  "nama_bank",
  "kode_bank",
  "no_rekening",
  "nama_rekening",
  "nominal",
  "berita",
  "rekening_debet",
  "nama_debet",
  "tanggal_efektif",
  "nomor_urut",
  "teks_tetap",
] as const;
export type IsianTransfer = (typeof ISIAN_TRANSFER)[number];
/** Tanda yang mengeluarkan baris dari berkas bank ("Perlu dibayar manual"). */
export const TANDA_MANUAL = [
  "tanpa_rekening",
  "bank_tidak_dikenal",
  "tanpa_kode_bank",
  "nominal_nol",
] as const;
/** Tanda peringatan: barisnya tetap masuk berkas. */
export const TANDA_PERINGATAN = ["nama_berbeda", "karyawan_keluar"] as const;
export type TandaTransfer =
  | (typeof TANDA_MANUAL)[number]
  | (typeof TANDA_PERINGATAN)[number];
export type JenisTransfer = "sesama" | "antarbank";

/** Teks tanda untuk layar dan berkas Excel umum. */
export const LABEL_TANDA_TRANSFER: Record<TandaTransfer, string> = {
  tanpa_rekening: "Rekening belum diisi",
  bank_tidak_dikenal: "Bank tidak dikenal atau nonaktif",
  tanpa_kode_bank: "Bank belum punya kode",
  nominal_nol: "Gaji bersih 0",
  nama_berbeda: "Nama pemilik rekening berbeda",
  karyawan_keluar: "Karyawan sudah keluar",
};
export const LABEL_ISIAN_TRANSFER: Record<IsianTransfer, string> = {
  nama_karyawan: "Nama karyawan",
  kode_karyawan: "Kode karyawan",
  nama_bank: "Nama bank",
  kode_bank: "Kode bank BI",
  no_rekening: "Nomor rekening",
  nama_rekening: "Nama pemilik rekening",
  nominal: "Nominal",
  berita: "Berita",
  rekening_debet: "Rekening debet",
  nama_debet: "Nama rekening debet",
  tanggal_efektif: "Tanggal efektif",
  nomor_urut: "Nomor urut",
  teks_tetap: "Teks tetap",
};
export const LABEL_JENIS_TRANSFER: Record<JenisTransfer, string> = {
  sesama: "Sesama bank",
  antarbank: "Antarbank",
};

// ── SQL kembar (harfiah di `transfer.rs`) ──────────────────────────────────

export const BANK_SQL =
  "SELECT id_bank, nama, kode, alias, is_aktif, is_bawaan, diubah_oleh, created_at, updated_at FROM app_bank ORDER BY is_aktif DESC, nama, id_bank;";

export const REKENING_SQL =
  "SELECT r.*, b.nama AS nama_bank, b.kode AS kode_bank, b.is_aktif AS bank_aktif FROM app_bank_rekening r LEFT JOIN app_bank b ON b.id_bank = r.id_bank ORDER BY r.is_aktif DESC, b.nama, r.no_rekening, r.id_rekening;";

export const FORMAT_SQL =
  "SELECT f.*, b.nama AS nama_bank FROM app_bank_format f LEFT JOIN app_bank b ON b.id_bank = f.id_bank ORDER BY f.is_aktif DESC, f.nama, f.id_format;";

export const SIMPAN_BANK_SQL =
  "INSERT INTO app_bank (id_bank, nama, kode, alias, is_aktif, diubah_oleh) VALUES (?1, ?2, ?3, ?4, ?5, ?6) ON CONFLICT(id_bank) DO UPDATE SET nama = excluded.nama, kode = excluded.kode, alias = excluded.alias, is_aktif = excluded.is_aktif, diubah_oleh = excluded.diubah_oleh, updated_at = datetime('now');";

export const SIMPAN_REKENING_SQL =
  "INSERT INTO app_bank_rekening (id_rekening, id_bank, no_rekening, nama_rekening, keterangan, is_aktif, diubah_oleh) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) ON CONFLICT(id_rekening) DO UPDATE SET id_bank = excluded.id_bank, no_rekening = excluded.no_rekening, nama_rekening = excluded.nama_rekening, keterangan = excluded.keterangan, is_aktif = excluded.is_aktif, diubah_oleh = excluded.diubah_oleh, updated_at = datetime('now');";

export const SIMPAN_FORMAT_SQL =
  "INSERT INTO app_bank_format (id_format, nama, id_bank, jenis, pemisah, pakai_judul, kutip, desimal, cakupan, kolom, maks_berita, is_aktif, diubah_oleh) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13) ON CONFLICT(id_format) DO UPDATE SET nama = excluded.nama, id_bank = excluded.id_bank, jenis = excluded.jenis, pemisah = excluded.pemisah, pakai_judul = excluded.pakai_judul, kutip = excluded.kutip, desimal = excluded.desimal, cakupan = excluded.cakupan, kolom = excluded.kolom, maks_berita = excluded.maks_berita, is_aktif = excluded.is_aktif, diubah_oleh = excluded.diubah_oleh, updated_at = datetime('now');";

export const RUN_TRANSFER_SQL =
  "SELECT id, period_start, period_end, status, total_net_payout, total_employees FROM payroll_runs WHERE id = ?1;";

/** Rekening dibaca saat mengunduh, tidak dibekukan di run (§27.9). */
export const BARIS_TRANSFER_SQL =
  "SELECT i.id AS id_item, i.id_karyawan, i.nama_karyawan, m.kode_karyawan, i.net_salary, m.id_keluar, p.bank, p.no_rekening, p.nama_rekening FROM payroll_items i LEFT JOIN master_data m ON m.id_unik = i.id_karyawan LEFT JOIN hr_profil p ON p.id_karyawan = i.id_karyawan WHERE i.payroll_run_id = ?1 ORDER BY i.nama_karyawan, i.id;";

/** Jejak unduhan langsung di cloud (Q-156); status run tidak berubah. */
export const CATAT_UNDUH_SQL =
  "INSERT INTO payroll_audit_logs (id, payroll_run_id, action, old_status, new_status, performed_by, notes) VALUES (?1, ?2, 'TRANSFER_EXPORT', ?3, ?3, ?4, ?5);";

export const RIWAYAT_UNDUH_SQL =
  "SELECT id, performed_by, notes, created_at FROM payroll_audit_logs WHERE payroll_run_id = ?1 AND action = 'TRANSFER_EXPORT' ORDER BY created_at DESC, id DESC;";

// ── Aturan murni ───────────────────────────────────────────────────────────

type Hasil<T> = { ok: true; nilai: T } | { ok: false; pesan: string };
const ok = <T>(nilai: T): Hasil<T> => ({ ok: true, nilai });
const gagal = <T = never>(pesan: string): Hasil<T> => ({ ok: false, pesan });
type Draft = Record<string, unknown>;

const panjang = (teks: string) => [...teks].length;
const rapikan = (teks: string) => teks.split(/\s+/).filter(Boolean).join(" ");
/** Cermin `ada_kendali`: karakter di bawah spasi (tab, baris baru). */
const adaKendali = (teks: string) => [...teks].some((c) => c < " ");

/** Cermin `objek_ketat`: objek dengan kunci dari `kolom` saja (aturan 37). */
function objekKetat(draft: unknown, kolom: readonly string[]): Hasil<Draft> {
  if (!draft || typeof draft !== "object" || Array.isArray(draft)) {
    return gagal("Isian tidak valid.");
  }
  for (const kunci of Object.keys(draft)) {
    if (!kolom.includes(kunci)) return gagal(`Isian '${kunci}' tidak dikenal.`);
  }
  return ok(draft as Draft);
}

/** Cermin `teks_wajib`: spasi dirapikan, wajib, maksimal `maks`. */
function teksWajib(nilai: unknown, label: string, maks: number): Hasil<string> {
  const mentah = teksIsian(nilai);
  if (!mentah) return gagal(`${label} wajib diisi.`);
  const teks = rapikan(mentah);
  if (panjang(teks) > maks) return gagal(`${label} maksimal ${maks} karakter.`);
  return ok(teks);
}

/** Cermin `bendera`: true/false atau 0/1; absen atau null = `bawaan`. */
function bendera(nilai: unknown, label: string, bawaan: 0 | 1): Hasil<0 | 1> {
  if (nilai === undefined || nilai === null) return ok(bawaan);
  if (nilai === true || nilai === 1) return ok(1);
  if (nilai === false || nilai === 0) return ok(0);
  return gagal(`${label} tidak valid.`);
}

/** Cermin `baca_alias`: larik JSON teks; rusak = kosong. */
export function bacaAlias(teks: string | null | undefined): string[] {
  try {
    const nilai: unknown = JSON.parse(teks ?? "[]");
    return Array.isArray(nilai)
      ? nilai.filter((v): v is string => typeof v === "string")
      : [];
  } catch {
    return [];
  }
}

export interface BankSah {
  nama: string;
  kode: string | null;
  alias: string[];
  is_aktif: 0 | 1;
}

/**
 * Cermin `validasi_bank`. `namaLama` = nama tersimpan saat menyunting: bila
 * nama berubah, nama lama ditambahkan ke alias (Q-176) supaya profil
 * karyawan lama tetap cocok.
 */
export function validasiBank(
  draft: unknown,
  namaLama: string | null,
): Hasil<BankSah> {
  const isian = objekKetat(draft, ["nama", "kode", "alias", "is_aktif"]);
  if (!isian.ok) return isian;
  const d = isian.nilai;
  const nama = teksWajib(d.nama, "Nama bank", MAKS_NAMA);
  if (!nama.ok) return nama;
  let kode: string | null = null;
  if (d.kode !== undefined && d.kode !== null) {
    if (typeof d.kode !== "string") return gagal("Kode bank tidak valid.");
    const t = d.kode.trim();
    if (t !== "" && !/^[0-9]{3}$/.test(t))
      return gagal("Kode bank harus 3 digit angka.");
    kode = t === "" ? null : t;
  }
  const mentah = d.alias ?? [];
  if (!Array.isArray(mentah) || mentah.some((a) => typeof a !== "string")) {
    return gagal("Alias tidak valid.");
  }
  const alias: string[] = [];
  const dipakai = new Set([kunciNama(nama.nilai)]);
  const tambah = (teks: string) => {
    const a = rapikan(teks);
    if (a === "" || dipakai.has(kunciNama(a))) return;
    dipakai.add(kunciNama(a));
    alias.push(a);
  };
  for (const a of mentah as string[]) {
    if (panjang(rapikan(a)) > MAKS_NAMA) {
      return gagal(`Alias maksimal ${MAKS_NAMA} karakter.`);
    }
    tambah(a);
  }
  if (namaLama !== null) tambah(namaLama);
  if (alias.length > MAKS_ALIAS) {
    return gagal(`Alias maksimal ${MAKS_ALIAS} nama.`);
  }
  const aktif = bendera(d.is_aktif, "Status aktif", 1);
  if (!aktif.ok) return aktif;
  return ok({ nama: nama.nilai, kode, alias, is_aktif: aktif.nilai });
}

export interface BankBaris {
  id_bank: string;
  nama: string;
  kode: string | null;
  alias: string | null;
  is_aktif: number;
}

/**
 * Cermin `bank_bentrok`: nama atau alias `sah` sudah dipakai nama atau alias
 * bank lain (nama unik ditegakkan aplikasi, §27.2). Hasil = nama bank lain itu.
 */
export function bankBentrok(
  id: string | null,
  sah: BankSah,
  bank: readonly BankBaris[],
): string | null {
  const kunci = new Set([sah.nama, ...sah.alias].map(kunciNama));
  for (const b of bank) {
    if (b.id_bank === id) continue;
    if ([b.nama, ...bacaAlias(b.alias)].some((n) => kunci.has(kunciNama(n)))) {
      return b.nama;
    }
  }
  return null;
}

/**
 * Cermin `cocok_bank`: teks `hr_profil.bank` → bank, lewat nama lalu alias
 * sesudah huruf besar kecil dan spasi dirapikan. Bank nonaktif tetap cocok;
 * pemanggil menandainya `bank_tidak_dikenal`.
 */
export function cocokBank(
  teks: string | null | undefined,
  bank: readonly BankBaris[],
): BankBaris | null {
  const kunci = kunciNama(teks ?? "");
  if (kunci === "") return null;
  return (
    bank.find((b) => kunciNama(b.nama) === kunci) ??
    bank.find((b) => bacaAlias(b.alias).some((a) => kunciNama(a) === kunci)) ??
    null
  );
}

export interface RekeningSah {
  id_bank: string;
  no_rekening: string;
  nama_rekening: string;
  keterangan: string | null;
  is_aktif: 0 | 1;
}

/** Cermin `validasi_rekening`: rekening debet perusahaan. */
export function validasiRekening(draft: unknown): Hasil<RekeningSah> {
  const isian = objekKetat(draft, [
    "id_bank",
    "no_rekening",
    "nama_rekening",
    "keterangan",
    "is_aktif",
  ]);
  if (!isian.ok) return isian;
  const d = isian.nilai;
  const id_bank = teksIsian(d.id_bank);
  if (!id_bank) return gagal("Bank wajib dipilih.");
  const no = d.no_rekening ?? null;
  if (no !== null && typeof no !== "string") {
    return gagal("Nomor rekening tidak valid.");
  }
  const nomor = nomorIdentitas(no, "Nomor rekening", PANJANG_REKENING);
  if (!nomor.ok) return nomor;
  if (nomor.nilai === null) return gagal("Nomor rekening wajib diisi.");
  const nama = teksWajib(d.nama_rekening, "Nama pemilik rekening", MAKS_NAMA);
  if (!nama.ok) return nama;
  const keterangan = teksIsian(d.keterangan) ?? null;
  if (keterangan && panjang(keterangan) > MAKS_TEKS) {
    return gagal(`Keterangan maksimal ${MAKS_TEKS} karakter.`);
  }
  const aktif = bendera(d.is_aktif, "Status aktif", 1);
  if (!aktif.ok) return aktif;
  return ok({
    id_bank,
    no_rekening: nomor.nilai,
    nama_rekening: nama.nilai,
    keterangan,
    is_aktif: aktif.nilai,
  });
}

/** Cermin `rekening_bentrok`: bank + nomor yang sama sudah tercatat. */
export function rekeningBentrok(
  id: string | null,
  sah: RekeningSah,
  rekening: ReadonlyArray<{
    id_rekening: string;
    id_bank: string;
    no_rekening: string;
  }>,
): boolean {
  return rekening.some(
    (r) =>
      r.id_rekening !== id &&
      r.id_bank === sah.id_bank &&
      r.no_rekening === sah.no_rekening,
  );
}

export interface KolomFormat {
  isian: IsianTransfer;
  judul: string;
  teks: string | null;
}

export interface FormatSah {
  nama: string;
  id_bank: string | null;
  jenis: (typeof JENIS_BERKAS)[number];
  pemisah: string | null;
  pakai_judul: 0 | 1;
  kutip: 0 | 1;
  desimal: 0 | 1;
  cakupan: (typeof CAKUPAN)[number];
  kolom: KolomFormat[];
  maks_berita: number | null;
  is_aktif: 0 | 1;
}

/** Cermin `validasi_kolom`: larik kolom format, juga untuk membaca ulang `kolom`. */
export function validasiKolom(mentah: unknown): Hasil<KolomFormat[]> {
  if (
    !Array.isArray(mentah) ||
    mentah.length === 0 ||
    mentah.length > MAKS_KOLOM_FORMAT
  ) {
    return gagal(`Format wajib punya 1–${MAKS_KOLOM_FORMAT} kolom.`);
  }
  const kolom: KolomFormat[] = [];
  for (const [i, item] of mentah.entries()) {
    const ke = `Kolom ke-${i + 1}`;
    const isian = objekKetat(item, ["isian", "judul", "teks"]);
    if (!isian.ok) return gagal(`${ke}: ${isian.pesan}`);
    const k = isian.nilai;
    if (
      typeof k.isian !== "string" ||
      !(ISIAN_TRANSFER as readonly string[]).includes(k.isian)
    ) {
      return gagal(`${ke}: isian tidak dikenal.`);
    }
    if (
      k.judul !== undefined &&
      k.judul !== null &&
      typeof k.judul !== "string"
    )
      return gagal(`${ke}: judul tidak valid.`);
    const judul = ((k.judul as string | null | undefined) ?? "").trim();
    if (judul === "") return gagal(`${ke}: judul wajib diisi.`);
    if (panjang(judul) > MAKS_JUDUL_KOLOM)
      return gagal(`${ke}: judul maksimal ${MAKS_JUDUL_KOLOM} karakter.`);
    if (adaKendali(judul))
      return gagal(`${ke}: judul tidak boleh berisi tab atau baris baru.`);
    if (k.teks !== undefined && k.teks !== null && typeof k.teks !== "string")
      return gagal(`${ke}: teks tidak valid.`);
    const teks = ((k.teks as string | null | undefined) ?? "").trim();
    if (k.isian !== "teks_tetap") {
      if (teks !== "")
        return gagal(`${ke}: teks hanya untuk isian teks tetap.`);
      kolom.push({ isian: k.isian as IsianTransfer, judul, teks: null });
      continue;
    }
    if (panjang(teks) > MAKS_TEKS_KOLOM)
      return gagal(`${ke}: teks maksimal ${MAKS_TEKS_KOLOM} karakter.`);
    if (adaKendali(teks))
      return gagal(`${ke}: teks tidak boleh berisi tab atau baris baru.`);
    kolom.push({ isian: "teks_tetap", judul, teks });
  }
  return ok(kolom);
}

/** Cermin `validasi_format`: format kustom dari Pengaturan (§27.3). */
export function validasiFormat(draft: unknown): Hasil<FormatSah> {
  const isian = objekKetat(draft, [
    "nama",
    "id_bank",
    "jenis",
    "pemisah",
    "pakai_judul",
    "kutip",
    "desimal",
    "cakupan",
    "kolom",
    "maks_berita",
    "is_aktif",
  ]);
  if (!isian.ok) return isian;
  const d = isian.nilai;
  const nama = teksWajib(d.nama, "Nama format", MAKS_NAMA);
  if (!nama.ok) return nama;
  const id_bank = teksIsian(d.id_bank) ?? null;
  const jenis = d.jenis;
  if (
    typeof jenis !== "string" ||
    !(JENIS_BERKAS as readonly string[]).includes(jenis)
  ) {
    return gagal("Jenis berkas tidak dikenal.");
  }
  // Pemisah tidak dipangkas: tab adalah spasi.
  const pemisah = d.pemisah ?? null;
  if (jenis === "xlsx") {
    if (pemisah !== null && pemisah !== "")
      return gagal("Berkas Excel tidak memakai pemisah.");
  } else if (
    typeof pemisah !== "string" ||
    !(PEMISAH as readonly string[]).includes(pemisah)
  ) {
    return gagal("Pemisah tidak dikenal.");
  }
  const pakai_judul = bendera(d.pakai_judul, "Baris judul", 1);
  if (!pakai_judul.ok) return pakai_judul;
  const kutip = bendera(d.kutip, "Kutip", 0);
  if (!kutip.ok) return kutip;
  const desimal = bendera(d.desimal, "Desimal", 0);
  if (!desimal.ok) return desimal;
  const cakupan = d.cakupan ?? "semua";
  if (
    typeof cakupan !== "string" ||
    !(CAKUPAN as readonly string[]).includes(cakupan)
  ) {
    return gagal("Cakupan tidak dikenal.");
  }
  const kolom = validasiKolom(d.kolom);
  if (!kolom.ok) return kolom;
  const maks = d.maks_berita;
  if (
    maks !== undefined &&
    maks !== null &&
    (typeof maks !== "number" ||
      !Number.isSafeInteger(maks) ||
      maks < 1 ||
      maks > MAKS_PANJANG_BERITA)
  ) {
    return gagal(
      `Panjang berita harus bilangan bulat 1–${MAKS_PANJANG_BERITA}.`,
    );
  }
  const aktif = bendera(d.is_aktif, "Status aktif", 1);
  if (!aktif.ok) return aktif;
  return ok({
    nama: nama.nilai,
    id_bank,
    jenis: jenis as FormatSah["jenis"],
    pemisah: jenis === "xlsx" ? null : (pemisah as string),
    pakai_judul: pakai_judul.nilai,
    kutip: kutip.nilai,
    desimal: desimal.nilai,
    cakupan: cakupan as FormatSah["cakupan"],
    kolom: kolom.nilai,
    maks_berita: (maks as number | null | undefined) ?? null,
    is_aktif: aktif.nilai,
  });
}

/** Cermin `kolom_teks`: bentuk tersimpan `app_bank_format.kolom`. */
export function kolomTeks(kolom: readonly KolomFormat[]): string {
  return JSON.stringify(
    kolom.map((k) => ({ isian: k.isian, judul: k.judul, teks: k.teks })),
  );
}

// ── Susun baris transfer ───────────────────────────────────────────────────

export interface ItemTransfer {
  id_karyawan: string;
  nama_karyawan: string;
  kode_karyawan: string | null;
  net_salary: number;
  id_keluar: string | null;
  bank: string | null;
  no_rekening: string | null;
  nama_rekening: string | null;
}

export interface RunTransfer {
  period_start: string;
  period_end: string;
}

export interface DebetTransfer {
  id_bank: string;
  no_rekening: string;
  nama_rekening: string;
}

/** Bagian format yang menentukan isi baris; null = Excel umum. */
export interface FormatSusun {
  cakupan: string;
  kolom: ReadonlyArray<{ isian: string }>;
  maks_berita: number | null;
}

export interface BarisTransfer {
  nomor_urut: number | null;
  id_karyawan: string;
  nama_karyawan: string;
  kode_karyawan: string | null;
  nama_bank: string | null;
  kode_bank: string | null;
  no_rekening: string | null;
  nama_rekening: string | null;
  nominal: number;
  jenis: JenisTransfer | null;
  tanda: TandaTransfer[];
}

interface Jumlah {
  jumlah: number;
  total: number;
}

export interface SusunanTransfer {
  berita: string;
  rekening_debet: string;
  nama_debet: string;
  tanggal_efektif: string;
  baris: BarisTransfer[];
  manual: BarisTransfer[];
  luar_cakupan: BarisTransfer[];
  ringkasan: {
    jumlah_baris: number;
    total: number;
    total_run: number;
    selisih: number;
    jumlah_manual: number;
    total_manual: number;
    jumlah_luar_cakupan: number;
    total_luar_cakupan: number;
    per_bank: Array<{ nama_bank: string } & Jumlah>;
    per_jenis: { sesama: Jumlah; antarbank: Jumlah };
  };
}

/** Cermin `berita_transfer`: dipangkas per karakter ke `maks`. */
export function beritaTransfer(run: RunTransfer, maks: number | null): string {
  const teks = `Gaji ${run.period_start} s.d. ${run.period_end}`;
  return maks === null ? teks : [...teks].slice(0, maks).join("");
}

/**
 * Cermin `susun_transfer` (§27.3). Urutan pemeriksaan: tanda manual yang
 * tidak bergantung format, lalu cakupan, lalu `tanpa_kode_bank`. Baris di luar
 * cakupan bukan "manual": berkas lain (sesama/antarbank) memuatnya.
 */
export function susunTransfer(masukan: {
  run: RunTransfer;
  item: readonly ItemTransfer[];
  bank: readonly BankBaris[];
  debet: DebetTransfer;
  format: FormatSusun | null;
  tanggal_efektif: string;
}): SusunanTransfer {
  const { run, item, bank, debet, format } = masukan;
  const pakaiKode = format?.kolom.some((k) => k.isian === "kode_bank") ?? false;
  const cakupan = format?.cakupan ?? "semua";
  const baris: BarisTransfer[] = [];
  const manual: BarisTransfer[] = [];
  const luar: BarisTransfer[] = [];
  for (const it of item) {
    const no_rekening = teksIsian(it.no_rekening) ?? null;
    const nama_rekening = teksIsian(it.nama_rekening) ?? null;
    const teksBank = teksIsian(it.bank) ?? null;
    const b = cocokBank(teksBank, bank);
    const dikenal = b !== null && b.is_aktif === 1;
    const jenis: JenisTransfer | null = dikenal
      ? b.id_bank === debet.id_bank
        ? "sesama"
        : "antarbank"
      : null;
    const tanda: TandaTransfer[] = [];
    if (teksBank === null || no_rekening === null) tanda.push("tanpa_rekening");
    else if (!dikenal) tanda.push("bank_tidak_dikenal");
    if (it.net_salary <= 0) tanda.push("nominal_nol");
    const keluarCakupan =
      tanda.length === 0 && cakupan !== "semua" && jenis !== cakupan;
    if (tanda.length === 0 && !keluarCakupan && pakaiKode && !b?.kode) {
      tanda.push("tanpa_kode_bank");
    }
    const masuk = tanda.length === 0 && !keluarCakupan;
    if (
      nama_rekening !== null &&
      kunciNama(nama_rekening) !== kunciNama(it.nama_karyawan)
    ) {
      tanda.push("nama_berbeda");
    }
    if (teksIsian(it.id_keluar)) tanda.push("karyawan_keluar");
    const r: BarisTransfer = {
      nomor_urut: masuk ? baris.length + 1 : null,
      id_karyawan: it.id_karyawan,
      nama_karyawan: it.nama_karyawan,
      kode_karyawan: it.kode_karyawan,
      nama_bank: b?.nama ?? teksBank,
      kode_bank: b?.kode ?? null,
      no_rekening,
      nama_rekening,
      nominal: it.net_salary,
      jenis,
      tanda,
    };
    if (masuk) baris.push(r);
    else if (keluarCakupan) luar.push(r);
    else manual.push(r);
  }
  const jumlahkan = (daftar: readonly BarisTransfer[]): Jumlah => ({
    jumlah: daftar.length,
    total: daftar.reduce((s, r) => s + r.nominal, 0),
  });
  const perBank: Array<{ nama_bank: string } & Jumlah> = [];
  for (const r of baris) {
    const nama = r.nama_bank ?? "";
    let kelompok = perBank.find((k) => k.nama_bank === nama);
    if (!kelompok) {
      kelompok = { nama_bank: nama, jumlah: 0, total: 0 };
      perBank.push(kelompok);
    }
    kelompok.jumlah += 1;
    kelompok.total += r.nominal;
  }
  const isi = jumlahkan(baris);
  const totalRun = item.reduce((s, it) => s + it.net_salary, 0);
  const m = jumlahkan(manual);
  const l = jumlahkan(luar);
  return {
    berita: beritaTransfer(run, format?.maks_berita ?? null),
    rekening_debet: debet.no_rekening,
    nama_debet: debet.nama_rekening,
    tanggal_efektif: masukan.tanggal_efektif,
    baris,
    manual,
    luar_cakupan: luar,
    ringkasan: {
      jumlah_baris: isi.jumlah,
      total: isi.total,
      total_run: totalRun,
      selisih: totalRun - isi.total,
      jumlah_manual: m.jumlah,
      total_manual: m.total,
      jumlah_luar_cakupan: l.jumlah,
      total_luar_cakupan: l.total,
      per_bank: perBank,
      per_jenis: {
        sesama: jumlahkan(baris.filter((r) => r.jenis === "sesama")),
        antarbank: jumlahkan(baris.filter((r) => r.jenis === "antarbank")),
      },
    },
  };
}

// ── Pilihan unduhan dan pesan kembar ───────────────────────────────────────

export const PESAN_STATUS_RUN =
  "Berkas transfer hanya untuk proses gaji yang sudah disetujui (APPROVED) atau dibayar (PAID).";
export const PESAN_DEBET_NONAKTIF =
  "Rekening debet tidak ditemukan atau sudah nonaktif.";
export const PESAN_FORMAT_NONAKTIF =
  "Format berkas tidak ditemukan atau sudah nonaktif.";
export const PESAN_REKENING_GANDA = "Rekening ini sudah tercatat.";
export const PESAN_FORMAT_GANDA = "Nama format sudah dipakai.";
/** Cermin `STATUS_RUN_TRANSFER`: status run yang boleh diunduh (Q-154 (a)). */
export const STATUS_RUN_TRANSFER = ["APPROVED", "PAID"] as const;

/** Cermin `pesan_bank_ganda`. */
export function pesanBankGanda(nama: string): string {
  return `Nama atau alias sudah dipakai bank ${nama}.`;
}

export interface PilihanTransfer {
  run_id: string;
  id_rekening: string;
  id_format: string | null;
  tanggal_efektif: string | null;
  catat: boolean;
}

/** Cermin `validasi_pilihan_transfer`. Format kosong = Excel umum. */
export function validasiPilihanTransfer(
  draft: unknown,
): Hasil<PilihanTransfer> {
  const isian = objekKetat(draft, [
    "run_id",
    "id_rekening",
    "id_format",
    "tanggal_efektif",
    "catat",
  ]);
  if (!isian.ok) return isian;
  const d = isian.nilai;
  const run_id = teksIsian(d.run_id);
  if (!run_id) return gagal("Proses gaji wajib dipilih.");
  const id_rekening = teksIsian(d.id_rekening);
  if (!id_rekening) return gagal("Rekening debet wajib dipilih.");
  const tanggal_efektif = teksIsian(d.tanggal_efektif) ?? null;
  if (tanggal_efektif !== null && !isValidDate(tanggal_efektif)) {
    return gagal("Tanggal efektif tidak valid.");
  }
  const catat = d.catat ?? false;
  if (typeof catat !== "boolean") return gagal("Catat unduhan tidak valid.");
  return ok({
    run_id,
    id_rekening,
    id_format: teksIsian(d.id_format) ?? null,
    tanggal_efektif,
    catat,
  });
}
