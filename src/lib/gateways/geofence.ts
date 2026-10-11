"use client";

import { requestWebApi } from "@/lib/client/api-client";
import { isDesktopRuntime } from "@/lib/runtime/app-runtime";
import { invokeDesktop } from "@/lib/runtime/desktop-commands";
import type { GeofenceSettings } from "@/lib/validations/geofence";

export type { GeofenceSettings } from "@/lib/validations/geofence";

export async function getGeofenceSettings() {
  if (isDesktopRuntime()) {
    return invokeDesktop<GeofenceSettings>("desktop_get_geofence_settings");
  }
  const response = await requestWebApi<{ data: GeofenceSettings }>(
    "/api/settings/geofence",
    "POST",
    {},
  );
  return response.data;
}

export async function saveGeofenceSettings(settings: GeofenceSettings) {
  if (isDesktopRuntime()) {
    return invokeDesktop<GeofenceSettings>("desktop_update_geofence_settings", {
      settings,
    });
  }
  const response = await requestWebApi<{ data: GeofenceSettings }>(
    "/api/settings/geofence",
    "PUT",
    settings,
  );
  return response.data;
}
