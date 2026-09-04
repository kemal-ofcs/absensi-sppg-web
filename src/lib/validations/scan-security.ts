/**
 * Sakelar induk keamanan absensi, tingkat perusahaan.
 *
 * Dua fitur baru — wajib foto bukti dan pembatasan alamat IP — TIDAK wajib
 * dipakai setiap perusahaan. Sakelar di sini yang menentukan apakah fiturnya
 * hidup sama sekali; sakelar per role di halaman Master Operator hanya memilih
 * role mana yang terkena ketika fiturnya memang dihidupkan.
 *
 * Aturan gabungannya satu kalimat: **fitur berlaku hanya bila sakelar induk
 * hidup DAN role-nya menyalakannya.** Dieja di tiga tempat yang wajib sama —
 * `scanner.rs` (Desktop/Mobile), `attendance-processor.ts` (Web), dan gerbang
 * UI di halaman scanner. Kalau salah satu berbeda, terminal akan menahan foto
 * untuk sesuatu yang tidak pernah diminta backend, atau sebaliknya.
 *
 * Nilainya disimpan di `setting_gex_system` yang ikut sinkronisasi, jadi satu
 * perubahan langsung berlaku di seluruh terminal. Bawaannya MATI: pemasangan
 * yang sudah berjalan tidak boleh tiba-tiba menuntut foto pada absensi
 * berikutnya hanya karena aplikasinya diperbarui.
 */

export const SCAN_PHOTO_ENABLED_KEY = "scan_photo_enabled";
export const SCAN_IP_RESTRICTION_ENABLED_KEY = "scan_ip_restriction_enabled";

export interface ScanSecuritySettings {
  /** Fitur foto bukti dipakai perusahaan ini. */
  photoEnabled: boolean;
  /** Fitur pembatasan alamat IP dipakai perusahaan ini. */
  ipRestrictionEnabled: boolean;
  /**
   * Jawaban tunggal untuk halaman scanner: "apakah SAYA wajib berfoto?".
   *
   * Sengaja dihitung backend (sakelar induk DAN sakelar role pemanggil), bukan
   * digabungkan lagi di frontend. Objek sesi di React dibekukan saat login,
   * jadi penggabungan di sana membuat perubahan role tidak pernah terlihat
   * sampai aplikasinya ditutup.
   */
  photoRequiredForMe: boolean;
  ipRestrictionRequiredForMe: boolean;
  /** Alamat/blok IP yang diizinkan. Kosong untuk pembaca non-Superadmin. */
  entries: string[];
  /** Alamat perangkat saat ini, untuk tombol "tambahkan IP ini". */
  deviceAddresses: string[];
  /** Pembaca ini boleh mengubah pengaturan (Superadmin). */
  canManage: boolean;
}

export function settingEnabled(value: string | null | undefined) {
  return (
    String(value ?? "")
      .trim()
      .toLowerCase() === "true"
  );
}

/** Apakah sebuah scan benar-benar wajib berfoto. */
export function scanPhotoRequired(
  featureEnabled: boolean,
  roleRequires: boolean,
) {
  return featureEnabled && roleRequires;
}

/** Apakah sebuah scan benar-benar dibatasi daftar IP. */
export function scanIpRestrictionRequired(
  featureEnabled: boolean,
  roleRequires: boolean,
) {
  return featureEnabled && roleRequires;
}
