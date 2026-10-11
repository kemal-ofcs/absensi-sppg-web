/**
 * Bentuk data lisensi, dipakai bersama oleh gateway (klien) dan server Web.
 * Berkas ini SENGAJA hanya berisi tipe, supaya server bisa memakainya tanpa
 * ikut menarik gateway maupun runtime Tauri.
 *
 * Bentuknya persis `LicenseStatus` / `LicensePayload` di `license.rs`
 * (serde camelCase; enum snake_case).
 */
export type LicenseState =
  | "active"
  | "read_only"
  | "missing"
  | "invalid"
  | "device_not_listed";

export type LicenseReadOnlyReason = "expired" | "version_not_covered";

export type LicenseKind = "beli_putus" | "sewa";

export type LicensePayload = {
  id: string;
  holder: string;
  kind: LicenseKind;
  issued: string;
  updatesUntil: string;
  validUntil: string | null;
  devices: string[];
  lockMobile: boolean;
  /** Kode instance server Web yang dicakup; `null` = tidak berlaku di Web. */
  webInstance: string | null;
  /** Alamat tempat versi Web boleh dilayani; kosong = alamat apa pun. */
  websites: string[];
};

export type LicenseStatus = {
  state: LicenseState;
  readOnlyReason: LicenseReadOnlyReason | null;
  message: string | null;
  license: LicensePayload | null;
  /** Sisa hari sewa, hari ini ikut dihitung (hari terakhir = 1). `null` untuk beli putus. */
  daysLeft: number | null;
  deviceCode: string;
  /**
   * Nama perangkat yang dikenali manusia (nama komputer, merek + model HP).
   * Hanya untuk dibaca, lisensi tidak pernah mengikatnya. Tidak ada di Web,
   * tempat yang diikat adalah server, bukan perangkat yang sedang dipakai.
   */
  deviceName?: string | null;
  deviceBound: boolean;
  buildDate: string;
};
