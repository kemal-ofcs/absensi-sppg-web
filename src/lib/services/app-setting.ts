import "server-only";

import { BRANDING } from "@/lib/constants/branding";
import { db, ensureDbInitialized } from "@/lib/db";

export async function getAppDisplayName(): Promise<string> {
  await ensureDbInitialized();
  const result = await db.execute({
    sql: "SELECT value FROM setting_gex_system WHERE key = 'app_display_name' LIMIT 1;",
    args: [],
  });
  if (result.rows.length === 0) {
    return BRANDING.appDisplayName;
  }
  const value = String(result.rows[0].value ?? "").trim();
  return value || BRANDING.appDisplayName;
}

export async function updateAppDisplayName(name: string): Promise<string> {
  await ensureDbInitialized();
  const resolved = name.trim() || BRANDING.appDisplayName;
  await db.execute({
    sql: `INSERT INTO setting_gex_system (key, value) VALUES ('app_display_name', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value;`,
    args: [resolved],
  });
  return resolved;
}
