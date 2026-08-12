import { timingSafeEqual } from "node:crypto";
import { isLoopbackHostname } from "@/lib/runtime/desktop-loopback-request";

export const DESKTOP_SYNC_REQUEST_HEADER = "x-hybrid-starter-sync";

export type DesktopSyncRequestMetadata = {
  host: string | null;
  origin: string | null;
  requestOrigin: string;
  header: string | null;
  userAgent: string | null;
  cookieToken: string;
  expectedToken: string;
};

function sameSecret(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

export function getDesktopSyncRejectionCode(
  metadata: DesktopSyncRequestMetadata,
) {
  if (!isLoopbackHostname(metadata.host)) return "SYNC_LOOPBACK_REQUIRED";
  if (!metadata.origin || metadata.origin !== metadata.requestOrigin) {
    return "SYNC_ORIGIN_MISMATCH";
  }
  if (metadata.header !== "1") return "SYNC_HEADER_REQUIRED";
  if (!metadata.userAgent?.includes("Tauri")) return "SYNC_TAURI_REQUIRED";
  if (
    !metadata.expectedToken ||
    !metadata.cookieToken ||
    !sameSecret(metadata.cookieToken, metadata.expectedToken)
  ) {
    return "SYNC_SESSION_INVALID";
  }
  return null;
}
