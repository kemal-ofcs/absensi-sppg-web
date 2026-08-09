import {
  prosesScanAbsensi,
  type ScanPayload,
  type ScanResult,
} from "./attendance";

export interface ScanTerminalInput {
  qrContent: string; // Format: ID_Unik|Token
  lat?: number;
  lng?: number;
  kodeOperator?: string;
  sumberData?:
    | "Scanner"
    | "Koreksi Admin"
    | "Import Offline"
    | "Generate Sistem";
}

export async function submitTerminalScan(
  input: ScanTerminalInput,
): Promise<ScanResult> {
  const payload: ScanPayload = {
    qrText: input.qrContent,
    lat: input.lat,
    lng: input.lng,
    sumberScan: input.sumberData || "Scanner",
    kodeOperator: input.kodeOperator || "OP001",
  };

  const result = await prosesScanAbsensi(payload);
  return result;
}

export function getCurrentCoordinates(): Promise<{
  lat: number;
  lng: number;
} | null> {
  return new Promise((resolve) => {
    if (typeof window === "undefined" || !navigator.geolocation) {
      resolve(null);
      return;
    }

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        resolve({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
        });
      },
      () => {
        resolve(null);
      },
      {
        enableHighAccuracy: true,
        timeout: 5000,
        maximumAge: 0,
      },
    );
  });
}
