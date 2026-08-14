import "server-only";

import type { ScanTerminalInput } from "@/lib/contracts/scanner";
import {
  prosesScanAbsensi,
  type ScanPayload,
  type ScanResult,
} from "./attendance";

export type { ScanTerminalInput } from "@/lib/contracts/scanner";

export async function submitTerminalScan(
  input: ScanTerminalInput,
  options?: { actorOperatorId?: number },
): Promise<ScanResult> {
  const payload: ScanPayload = {
    qrText: input.qrContent,
    lat: input.lat,
    lng: input.lng,
    sumberScan: input.sumberData || "Scanner",
    kodeOperator: input.kodeOperator || "OP001",
  };

  const result = await prosesScanAbsensi(payload, options);
  return result;
}
