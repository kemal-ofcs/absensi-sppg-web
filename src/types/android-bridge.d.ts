export interface AndroidNativeBridgeInterface {
  isNativeAvailable?: () => boolean;
  shareImage?: (base64Data: string, filename: string, title: string) => string;
  saveImage?: (base64Data: string, filename: string) => string;
}

declare global {
  interface Window {
    AndroidBridge?: AndroidNativeBridgeInterface;
  }
}
