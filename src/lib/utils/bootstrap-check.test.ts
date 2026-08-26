import { describe, expect, test } from "bun:test";
import type { DatabaseCheckResult } from "@/lib/gateways/bootstrap";
import { summarizeDatabaseCheck } from "./bootstrap-check";

function buildCheck(
  overrides: Partial<DatabaseCheckResult> = {},
): DatabaseCheckResult {
  return {
    reachable: true,
    serverOrigin: "https://sppg-demo.turso.io",
    latencyMs: 120,
    emptyDatabase: false,
    schemaReady: true,
    missingTables: [],
    tableCount: 24,
    bootstrapClaimed: false,
    superadminExists: false,
    superadminCount: 0,
    superadminUsername: null,
    operatorCount: 0,
    karyawanCount: 0,
    attendanceCount: 0,
    companyName: null,
    errorCode: null,
    errorMessage: null,
    ...overrides,
  };
}

describe("summarizeDatabaseCheck", () => {
  test("database tak terjangkau menutup seluruh aksi provisioning", () => {
    const summary = summarizeDatabaseCheck(
      buildCheck({
        reachable: false,
        errorCode: "TURSO_HTTP_ERROR",
        errorMessage: "Auth token ditolak server.",
      }),
    );
    expect(summary.tone).toBe("danger");
    expect(summary.canCreateSuperadmin).toBe(false);
    expect(summary.canUseExisting).toBe(false);
    expect(summary.detail).toBe("Auth token ditolak server.");
  });

  test("superadmin aktif memblokir pembuatan akun baru", () => {
    const summary = summarizeDatabaseCheck(
      buildCheck({
        superadminExists: true,
        superadminCount: 1,
        superadminUsername: "sppg.owner",
        operatorCount: 4,
      }),
    );
    expect(summary.canCreateSuperadmin).toBe(false);
    expect(summary.canUseExisting).toBe(true);
    expect(summary.detail).toContain("sppg.owner");
  });

  test("database kosong tetap boleh diprovisioning tanpa konfirmasi tambahan", () => {
    const summary = summarizeDatabaseCheck(
      buildCheck({ emptyDatabase: true, schemaReady: false, tableCount: 0 }),
    );
    expect(summary.canCreateSuperadmin).toBe(true);
    expect(summary.requiresConfirmation).toBe(false);
  });

  test("skema asing wajib dikonfirmasi manual agar salah database tertahan", () => {
    const summary = summarizeDatabaseCheck(
      buildCheck({
        schemaReady: false,
        missingTables: ["master_operator", "log_scan"],
        tableCount: 9,
      }),
    );
    expect(summary.tone).toBe("danger");
    expect(summary.requiresConfirmation).toBe(true);
    expect(summary.detail).toContain("master_operator");
  });

  test("klaim bootstrap terpakai tanpa superadmin aktif ditandai bahaya", () => {
    const summary = summarizeDatabaseCheck(
      buildCheck({ bootstrapClaimed: true }),
    );
    expect(summary.tone).toBe("danger");
    expect(summary.requiresConfirmation).toBe(true);
  });

  test("skema lengkap tanpa superadmin siap diprovisioning", () => {
    const summary = summarizeDatabaseCheck(
      buildCheck({ companyName: "SPPG Bogor" }),
    );
    expect(summary.tone).toBe("success");
    expect(summary.canCreateSuperadmin).toBe(true);
    expect(summary.facts.some((fact) => fact.value === "SPPG Bogor")).toBe(
      true,
    );
  });
});
