/**
 * Whitelist Shift/Divisi untuk absensi di HARI LIBUR.
 *
 * Sebelum ini scanner menolak SEMUA scan pada tanggal yang terdaftar di
 * `tbl_hari_libur`. Padahal sebagian peran memang tetap masuk saat libur —
 * Satpam, Keamanan, Maintenance, Teknisi. Modul ini adalah satu-satunya tempat
 * aturan "siapa yang boleh scan saat libur" dieja untuk sisi TypeScript, dan
 * ia **sengaja tanpa dependensi** supaya cerminan Rust-nya di `scanner.rs`
 * (`normalize_whitelist_scope_type`/`normalize_whitelist_scope_value`/
 * `is_holiday_scan_allowed`) bisa diuji dengan vektor yang sama persis —
 * pola yang dipakai `ip-allowlist.ts` dan `totp.ts`.
 *
 * Kenapa cakupannya `kode_shift` dan NAMA divisi, bukan `id_shift`/id divisi:
 * `id_shift` adalah AUTOINCREMENT lokal yang nilainya berbeda antar perangkat,
 * sedangkan `kode_shift` UNIQUE dan ikut sinkronisasi apa adanya. Menyimpan
 * `id_shift` akan membuat whitelist menunjuk shift yang salah begitu baris
 * dibuat di perangkat lain.
 */

export const HOLIDAY_WHITELIST_SCOPES = ["SHIFT", "DIVISI"] as const;

export type HolidayWhitelistScope = (typeof HOLIDAY_WHITELIST_SCOPES)[number];

export interface HolidayWhitelistEntry {
  id: string;
  scope_type: string;
  scope_value: string;
  /** NULL/kosong = berlaku untuk SEMUA hari libur; terisi = hanya tanggal itu. */
  tanggal_libur: string | null;
  keterangan: string | null;
  status_aktif: number;
}

export interface HolidayScanContext {
  /** Tanggal kerja yang sedang dinilai, format YYYY-MM-DD. */
  tanggal: string;
  /** `master_data.divisi` milik karyawan. */
  divisi: string;
  /** `tbl_shift.kode_shift` milik shift karyawan; null bila shift tak dikenal. */
  kodeShift: number | null;
}

export interface HolidayScanDecision {
  allowed: boolean;
  /** Entri whitelist yang mengizinkan, bila ada. */
  matched: HolidayWhitelistEntry | null;
  /** Ringkasan siap-tampil, mis. "Divisi Keamanan". */
  reason: string;
}

/** Trim + rapatkan spasi ganda + lowercase. Dipakai untuk pembandingan saja. */
export function foldWhitelistText(raw: string): string {
  return raw.trim().replace(/\s+/g, " ").toLowerCase();
}

export function normalizeScopeType(raw: string): HolidayWhitelistScope | null {
  const value = raw.trim().toUpperCase();
  if (value === "SHIFT") return "SHIFT";
  if (value === "DIVISI") return "DIVISI";
  return null;
}

/**
 * Bentuk kanonik nilai cakupan.
 *
 * SHIFT  -> `kode_shift` sebagai desimal tanpa nol di depan ("04" -> "4"),
 *           supaya "4" dan "04" tidak pernah menjadi dua baris berbeda.
 * DIVISI -> nama divisi yang dirapikan spasinya, huruf aslinya dipertahankan
 *           karena nilai ini juga yang ditampilkan di layar.
 */
export function normalizeScopeValue(
  scopeType: HolidayWhitelistScope,
  raw: string,
): string | null {
  const trimmed = raw.trim().replace(/\s+/g, " ");
  if (trimmed === "") return null;

  if (scopeType === "SHIFT") {
    if (!/^\d{1,9}$/.test(trimmed)) return null;
    const parsed = Number.parseInt(trimmed, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return null;
    return String(parsed);
  }

  return trimmed;
}

/** Menerima YYYY-MM-DD (opsional dengan bagian waktu). Selain itu -> null. */
export function normalizeHolidayDate(
  raw: string | null | undefined,
): string | null {
  if (raw === null || raw === undefined) return null;
  const value = String(raw).trim().split("T")[0]?.trim() ?? "";
  if (value === "") return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const month = Number.parseInt(value.slice(5, 7), 10);
  const day = Number.parseInt(value.slice(8, 10), 10);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return value;
}

/** Satu entri whitelist cocok dengan konteks scan? */
export function matchesHolidayWhitelist(
  entry: HolidayWhitelistEntry,
  context: HolidayScanContext,
): boolean {
  if (Number(entry.status_aktif) !== 1) return false;

  const scope = normalizeScopeType(entry.scope_type);
  if (scope === null) return false;

  // tanggal_libur kosong = berlaku untuk setiap hari libur.
  const scopedDate = normalizeHolidayDate(entry.tanggal_libur);
  if (scopedDate !== null) {
    const target = normalizeHolidayDate(context.tanggal);
    if (target === null || target !== scopedDate) return false;
  }

  const value = normalizeScopeValue(scope, entry.scope_value ?? "");
  if (value === null) return false;

  if (scope === "SHIFT") {
    if (context.kodeShift === null || context.kodeShift === undefined)
      return false;
    return value === String(context.kodeShift);
  }

  return foldWhitelistText(value) === foldWhitelistText(context.divisi ?? "");
}

/**
 * Vonis akhir: karyawan ini boleh scan pada hari libur?
 *
 * Daftar KOSONG berarti tidak ada yang dikecualikan, jadi vonisnya menolak —
 * ini kebalikan dari `scan_ip_allowlist` (kosong = belum diatur = izinkan),
 * dan memang disengaja: perilaku bawaan aplikasi sejak dulu adalah menolak
 * semua scan di hari libur, sehingga daftar kosong harus mempertahankannya.
 */
export function evaluateHolidayScan(
  entries: HolidayWhitelistEntry[],
  context: HolidayScanContext,
): HolidayScanDecision {
  for (const entry of entries) {
    if (!matchesHolidayWhitelist(entry, context)) continue;
    const scope = normalizeScopeType(entry.scope_type);
    const label =
      scope === "SHIFT"
        ? `Shift kode ${normalizeScopeValue("SHIFT", entry.scope_value ?? "")}`
        : `Divisi ${normalizeScopeValue("DIVISI", entry.scope_value ?? "")}`;
    return { allowed: true, matched: entry, reason: label };
  }
  return { allowed: false, matched: null, reason: "" };
}
