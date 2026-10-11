export interface GeofenceSettings {
  enabled: boolean;
  latitude: number;
  longitude: number;
  radiusMeter: number;
}

export function validateGeofenceSettings(settings: GeofenceSettings) {
  const errors: Record<string, string> = {};
  if (
    !Number.isFinite(settings.latitude) ||
    settings.latitude < -90 ||
    settings.latitude > 90
  ) {
    errors.latitude = "Latitude harus berada antara -90 dan 90.";
  }
  if (
    !Number.isFinite(settings.longitude) ||
    settings.longitude < -180 ||
    settings.longitude > 180
  ) {
    errors.longitude = "Longitude harus berada antara -180 dan 180.";
  }
  if (
    !Number.isInteger(settings.radiusMeter) ||
    settings.radiusMeter < 10 ||
    settings.radiusMeter > 10_000
  ) {
    errors.radiusMeter =
      "Radius wajib berupa angka bulat antara 10-10.000 meter.";
  }
  if (settings.enabled && settings.latitude === 0 && settings.longitude === 0) {
    errors.latitude =
      "Tentukan koordinat kantor sebelum geofencing diaktifkan.";
  }
  return errors;
}
