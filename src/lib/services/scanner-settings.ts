import "server-only";

import { db, ensureDbInitialized } from "@/lib/db";
import type { ScannerSafetySettings } from "@/lib/validations/scanner-settings";

export async function getScannerSafetySettings(): Promise<ScannerSafetySettings> {
  await ensureDbInitialized();
  const result = await db.execute({
    sql: "SELECT key, value FROM setting_gex_system WHERE key IN (?, ?);",
    args: ["anti_double_scan_seconds", "batas_multi_scan_menit"],
  });
  const values = new Map(
    result.rows.map((row) => [String(row.key), String(row.value)]),
  );

  const antiDoubleScanSeconds = Number(
    values.get("anti_double_scan_seconds") ?? 60,
  );
  const batasMultiScanMenit = Number(values.get("batas_multi_scan_menit") ?? 5);

  return {
    antiDoubleScanSeconds: Number.isNaN(antiDoubleScanSeconds)
      ? 60
      : Math.max(0, antiDoubleScanSeconds),
    batasMultiScanMenit: Number.isNaN(batasMultiScanMenit)
      ? 5
      : Math.max(0, batasMultiScanMenit),
  };
}

export async function updateScannerSafetySettings(
  settings: ScannerSafetySettings,
): Promise<ScannerSafetySettings> {
  await ensureDbInitialized();
  const entries = [
    ["anti_double_scan_seconds", String(settings.antiDoubleScanSeconds)],
    ["batas_multi_scan_menit", String(settings.batasMultiScanMenit)],
  ];
  await db.batch(
    entries.map(([key, value]) => ({
      sql: `INSERT INTO setting_gex_system (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value;`,
      args: [key, value],
    })),
    "write",
  );
  return getScannerSafetySettings();
}
