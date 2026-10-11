"use client";

/**
 * Portabilitas database: mengeluarkan dan memasukkan kembali berkas hub.
 *
 * Hanya berlaku pada Mode Database Lokal. Pada mode cloud, data induknya berada
 * di server dan pencadangannya adalah urusan penyedia database — bukan aplikasi
 * ini. Karena itu jalur Web sengaja TIDAK disediakan: sejak Fase 04 dicoret,
 * sisi Web selalu memakai database remote.
 */

import { isDesktopRuntime, isMobileRuntime } from "@/lib/runtime/app-runtime";
import { invokeDesktop } from "@/lib/runtime/desktop-commands";

export interface ExportReport {
  path: string;
  fileName: string;
  sizeBytes: number;
  encrypted: boolean;
  /**
   * Lokasi salinan di folder yang benar-benar bisa dibuka pengguna.
   *
   * null berarti tidak ada folder publik yang menerima tulisan — keadaan nyata
   * pada Android 10. Berkasnya tetap ada di path, tetapi pengguna tidak akan
   * menemukannya tanpa bantuan.
   */
  publicPath: string | null;
}

export interface ImportReport {
  schemaVersion: number;
  tableCount: number;
  restoredFrom: string;
  previousBackup: string | null;
}

export interface DataFolderInfo {
  dataDir: string;
  hubPath: string;
}

/**
 * Hasil "Simpan ke perangkat" pada Android.
 *
 * `savedToDevice: false` berarti pengguna MENUTUP dialog pemilih lokasi. Itu
 * pembatalan, bukan kegagalan — berkasnya tetap ada di folder aplikasi, dan UI
 * wajib mengatakannya begitu alih-alih menampilkan pesan error.
 */
export interface DeviceExportReport {
  path: string;
  fileName: string;
  sizeBytes: number;
  encrypted: boolean;
  savedToDevice: boolean;
}

/**
 * Ekspor cadangan lalu serahkan ke pemilih "Simpan ke…" milik Android.
 *
 * HANYA ada pada build Mobile — `mobile_export_database_to_device` tidak
 * didaftarkan biner Desktop. Sejak Android 10 aplikasi tidak boleh lagi menulis
 * ke folder Unduhan, sehingga jalur `exportDatabase` biasa menghasilkan berkas
 * di folder privat yang tidak pernah ditemukan penggunanya. Storage Access
 * Framework membalik keadaannya: pengguna yang memilih tujuannya.
 */
export async function exportDatabaseToDevice(
  passphrase = "",
): Promise<DeviceExportReport> {
  // Guard POSITIF, bukan `if (!isMobileRuntime()) throw`. Bentuknya penting:
  // `audit:contract` memisahkan jalur per build dengan mengenali blok
  // `if (isMobileRuntime()) { ... }`, dan hanya di dalam blok itulah sebuah
  // command yang tidak didaftarkan biner Desktop boleh dipanggil.
  if (isMobileRuntime()) {
    return invokeDesktop<DeviceExportReport>(
      "mobile_export_database_to_device",
      { passphrase: passphrase.trim() ? passphrase : null },
    );
  }
  throw new Error(
    "Simpan ke perangkat hanya tersedia pada aplikasi Android. Di Desktop, berkas cadangan langsung tersimpan di folder Unduhan.",
  );
}

function assertTauriRuntime(): void {
  if (!isDesktopRuntime()) {
    throw new Error(
      "Ekspor dan pemulihan database hanya tersedia di aplikasi Desktop dan Mobile. Pada Web, data berada di database remote — cadangkan dari penyedia database Anda.",
    );
  }
}

/**
 * Keluarkan seluruh isi database ke satu berkas.
 *
 * Frasa sandi kosong menghasilkan berkas SQLite polos: bisa dibuka di DB
 * Browser untuk diagnosa, tetapi memuat hash password, rahasia TOTP, dan foto
 * absensi. Layar pemanggil WAJIB menyampaikan itu sebelum penggunanya memilih.
 */
export async function exportDatabase(passphrase = ""): Promise<ExportReport> {
  assertTauriRuntime();
  return invokeDesktop<ExportReport>("desktop_export_database", {
    passphrase: passphrase.trim() ? passphrase : null,
  });
}

/**
 * Pulihkan dari berkas yang dipilih pengguna lewat pemilih berkas WebView.
 *
 * Ini jalur yang berlaku di KEDUA platform. Android tidak pernah menyerahkan
 * lokasi berkas sebenarnya kepada halaman web — hanya isinya — sehingga varian
 * berbasis path di bawah hanya berguna di Desktop.
 */
export async function importDatabaseFile(
  file: File,
  passphrase = "",
): Promise<ImportReport> {
  assertTauriRuntime();
  const bytes = new Uint8Array(await file.arrayBuffer());

  // Dipotong per blok: memanggil String.fromCharCode dengan puluhan ribu
  // argumen sekaligus melampaui batas argumen dan melempar RangeError pada
  // berkas berukuran wajar sekalipun.
  const CHUNK_SIZE = 0x8000;
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += CHUNK_SIZE) {
    binary += String.fromCharCode(
      ...bytes.subarray(offset, offset + CHUNK_SIZE),
    );
  }

  return invokeDesktop<ImportReport>("desktop_import_database_bytes", {
    fileName: file.name,
    base64Data: btoa(binary),
    passphrase: passphrase.trim() ? passphrase : null,
  });
}

/**
 * Pulihkan dari berkas pada lokasi tertentu di disk.
 *
 * Hanya bermakna di Desktop, di mana pengguna bisa menyebutkan lokasi berkasnya
 * sendiri dan isinya tidak perlu melewati jembatan IPC sebagai teks base64.
 */
export async function importDatabase(
  sourcePath: string,
  passphrase = "",
): Promise<ImportReport> {
  assertTauriRuntime();
  return invokeDesktop<ImportReport>("desktop_import_database", {
    sourcePath,
    passphrase: passphrase.trim() ? passphrase : null,
  });
}

/**
 * Lokasi folder data aplikasi.
 *
 * Di Desktop pengguna bisa membukanya sendiri dan menyalin berkasnya secara
 * manual — asalkan aplikasi ditutup lebih dulu, karena mode WAL menyimpan
 * transaksi terakhir di berkas pendamping. Di Android folder ini privat dan
 * tidak terjangkau.
 */
export async function getDataFolder(): Promise<DataFolderInfo> {
  assertTauriRuntime();
  return invokeDesktop<DataFolderInfo>("desktop_get_data_folder", {});
}
