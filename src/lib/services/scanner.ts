import "server-only";

import type { ScanTerminalInput } from "@/lib/contracts/scanner";
import type { ScanSecurityPolicy } from "@/lib/services/attendance-processor";
import {
  prosesScanAbsensi,
  type ScanPayload,
  type ScanResult,
} from "./attendance";

export type { ScanTerminalInput } from "@/lib/contracts/scanner";

export async function submitTerminalScan(
  input: ScanTerminalInput,
  options?: {
    actorOperatorId?: number;
    ipAddress?: string;
    policy?: ScanSecurityPolicy;
  },
): Promise<ScanResult> {
  const payload: ScanPayload = {
    qrText: input.qrContent,
    lat: input.lat,
    lng: input.lng,
    sumberScan: input.sumberData || "Scanner",
    kodeOperator: input.kodeOperator || "OP001",
    // Alamat IP berasal dari route handler (header proxy), bukan dari body.
    ipAddress: options?.ipAddress,
    fotoBase64: input.fotoBase64,
    fotoMime: input.fotoMime,
  };

  const result = await prosesScanAbsensi(payload, options);
  return result;
}
