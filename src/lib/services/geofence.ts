import "server-only";

import { db, ensureDbInitialized } from "@/lib/db";
import type { GeofenceSettings } from "@/lib/validations/geofence";

export async function getGeofenceSettings(): Promise<GeofenceSettings> {
  await ensureDbInitialized();
  const result = await db.execute({
    sql: "SELECT key, value FROM setting_gex_system WHERE key IN (?, ?, ?, ?);",
    args: ["geofence_enabled", "lat_kantor", "lng_kantor", "radius_meter"],
  });
  const values = new Map(
    result.rows.map((row) => [String(row.key), String(row.value)]),
  );
  const latitude = Number(values.get("lat_kantor") || 0);
  const longitude = Number(values.get("lng_kantor") || 0);
  const storedEnabled = values.get("geofence_enabled");
  return {
    enabled:
      storedEnabled === undefined
        ? latitude !== 0 || longitude !== 0
        : storedEnabled === "true",
    latitude,
    longitude,
    radiusMeter: Number(values.get("radius_meter") || 100),
  };
}

export async function updateGeofenceSettings(settings: GeofenceSettings) {
  await ensureDbInitialized();
  const entries = [
    ["geofence_enabled", settings.enabled ? "true" : "false"],
    ["lat_kantor", String(settings.latitude)],
    ["lng_kantor", String(settings.longitude)],
    ["radius_meter", String(settings.radiusMeter)],
  ];
  await db.batch(
    entries.map(([key, value]) => ({
      sql: `INSERT INTO setting_gex_system (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value;`,
      args: [key, value],
    })),
    "write",
  );
  return getGeofenceSettings();
}
