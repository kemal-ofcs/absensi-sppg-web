import { describe, expect, it } from "vitest";
import { getDesktopSyncRejectionCode } from "@/lib/sync/security-policy";

const validRequest = {
  host: "127.0.0.1:3310",
  origin: "http://127.0.0.1:3310",
  requestOrigin: "http://127.0.0.1:3310",
  header: "1",
  userAgent: "Mozilla/5.0 Tauri/2.0",
  cookieToken: "desktop-secret",
  expectedToken: "desktop-secret",
};

describe("desktop sync request security", () => {
  it("accepts an authenticated same-origin Tauri loopback request", () => {
    expect(getDesktopSyncRejectionCode(validRequest)).toBeNull();
  });

  it("rejects cross-origin and invalid session requests", () => {
    expect(
      getDesktopSyncRejectionCode({
        ...validRequest,
        origin: "https://malicious.example",
      }),
    ).toBe("SYNC_ORIGIN_MISMATCH");
    expect(
      getDesktopSyncRejectionCode({
        ...validRequest,
        cookieToken: "wrong-secret",
      }),
    ).toBe("SYNC_SESSION_INVALID");
  });
});
