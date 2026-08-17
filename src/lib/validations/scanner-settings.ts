export interface ScannerSafetySettings {
  antiDoubleScanSeconds: number;
  batasMultiScanMenit: number;
}

export function validateScannerSafetySettings(
  settings: ScannerSafetySettings,
): Record<string, string> {
  const errors: Record<string, string> = {};

  if (
    typeof settings.antiDoubleScanSeconds !== "number" ||
    !Number.isFinite(settings.antiDoubleScanSeconds) ||
    settings.antiDoubleScanSeconds < 0 ||
    settings.antiDoubleScanSeconds > 600
  ) {
    errors.antiDoubleScanSeconds =
      "Cooldown anti double scan harus berupa angka antara 0 hingga 600 detik (10 menit).";
  }

  if (
    typeof settings.batasMultiScanMenit !== "number" ||
    !Number.isFinite(settings.batasMultiScanMenit) ||
    settings.batasMultiScanMenit < 0 ||
    settings.batasMultiScanMenit > 120
  ) {
    errors.batasMultiScanMenit =
      "Batas multi scan harus berupa angka antara 0 hingga 120 menit (2 jam).";
  }

  return errors;
}
