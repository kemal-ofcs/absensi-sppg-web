import "server-only";

import type { ScanResult } from "@/lib/contracts/scanner";
import { db, ensureDbInitialized } from "@/lib/db";
import {
  processWebAttendanceScan,
  type ScanPayload,
} from "@/lib/services/attendance-processor";

export type { ScanResult } from "@/lib/contracts/scanner";
export type { ScanPayload } from "@/lib/services/attendance-processor";
export { hitungJarakHaversine, parseQrToken } from "@/lib/validations/scanner";

export async function prosesScanAbsensi(
  payload: ScanPayload,
  options?: { actorOperatorId?: number },
): Promise<ScanResult> {
  await ensureDbInitialized();
  return processWebAttendanceScan(db, payload, {
    waktuScan: new Date(),
    actorOperatorId: options?.actorOperatorId,
  });
}
