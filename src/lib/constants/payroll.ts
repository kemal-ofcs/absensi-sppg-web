/**
 * Konstanta skema gaji, dipakai bersama UI, gateway, dan route Web.
 *
 * Cerminan `SALARY_TYPE_*` dan `DAILY_RATE_MIN/MAX` di payroll/models.rs —
 * kedua sisi WAJIB sama, karena keduanya memvalidasi baris yang akan ditolak
 * CHECK constraint cloud bila lolos.
 */
export const SALARY_TYPES = ["HOURLY", "FLAT_DAILY"] as const;
export type SalaryType = (typeof SALARY_TYPES)[number];

/** Batas atas menangkap salah ketik satu nol. */
export const DAILY_RATE_MIN = 1_000;
export const DAILY_RATE_MAX = 10_000_000;
