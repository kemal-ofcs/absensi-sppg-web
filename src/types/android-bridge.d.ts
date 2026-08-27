export interface AndroidNativeBridgeInterface {
  isNativeAvailable?: () => boolean;
  shareImage?: (base64Data: string, filename: string, title: string) => string;
  saveImage?: (base64Data: string, filename: string) => string;
  /**
   * Membuka URI eksternal (tel:, https://wa.me/..., mailto:, dsb) lewat Intent
   * Android. Mengembalikan JSON string `{ sukses: boolean; error?: string }`.
   * Hanya tersedia di APK Mobile; lihat `mobile/src/lib/client/external-link.ts`.
   */
  openExternal?: (url: string) => string;
}

declare global {
  interface Window {
    AndroidBridge?: AndroidNativeBridgeInterface;
  }
}
