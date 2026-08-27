export function isDesktopRuntime() {
  if (process.env.NEXT_PUBLIC_SPPG_RUNTIME === "desktop") return true;
  return (
    typeof window !== "undefined" &&
    "__TAURI_INTERNALS__" in (window as unknown as Record<string, unknown>)
  );
}

/**
 * Build Tauri Mobile (Android/iOS).
 *
 * `isDesktopRuntime()` bernilai true juga di Mobile — namanya berarti "berjalan
 * sebagai aplikasi Tauri", bukan "Desktop". Sebagian command Rust hanya
 * terdaftar di salah satu build, sehingga gateway bersama perlu bercabang
 * alih-alih memanggil command yang tidak ada di binary Mobile.
 */
export function isMobileRuntime() {
  return (
    process.env.NEXT_PUBLIC_SPPG_RUNTIME === "mobile" &&
    typeof window !== "undefined" &&
    "__TAURI_INTERNALS__" in (window as unknown as Record<string, unknown>)
  );
}
