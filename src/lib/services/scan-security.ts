import "server-only";

import { db, ensureDbInitialized } from "@/lib/db";
import {
  IP_ALLOWLIST_SETTING_KEY,
  parseIpAllowlist,
  serializeIpAllowlist,
} from "@/lib/validations/ip-allowlist";
import {
  SCAN_IP_RESTRICTION_ENABLED_KEY,
  SCAN_PHOTO_ENABLED_KEY,
  type ScanSecuritySettings,
  settingEnabled,
} from "@/lib/validations/scan-security";

async function readSettings() {
  await ensureDbInitialized();
  const result = await db.execute({
    sql: "SELECT key, value FROM setting_gex_system WHERE key IN (?, ?, ?);",
    args: [
      SCAN_PHOTO_ENABLED_KEY,
      SCAN_IP_RESTRICTION_ENABLED_KEY,
      IP_ALLOWLIST_SETTING_KEY,
    ],
  });
  return new Map(
    result.rows.map((row) => [String(row.key), String(row.value ?? "")]),
  );
}

/**
 * Pengaturan keamanan absensi: sakelar induk fitur + daftar IP.
 *
 * `canManage` menentukan apakah daftar alamat ikut dikembalikan. Status
 * hidup/mati fiturnya boleh dibaca siapa pun yang punya sesi — halaman scanner
 * perlu tahu apakah harus menahan scan untuk foto — sedangkan daftar alamatnya
 * hanya untuk Superadmin.
 */
export async function getScanSecurity(
  canManage: boolean,
  currentAddress?: string,
  role?: { requireScanPhoto?: boolean; requireScanIpAllowlist?: boolean },
): Promise<ScanSecuritySettings> {
  const values = await readSettings();
  const address = (currentAddress ?? "").trim();
  const photoEnabled = settingEnabled(values.get(SCAN_PHOTO_ENABLED_KEY));
  const ipRestrictionEnabled = settingEnabled(
    values.get(SCAN_IP_RESTRICTION_ENABLED_KEY),
  );
  return {
    photoEnabled,
    ipRestrictionEnabled,
    photoRequiredForMe: photoEnabled && role?.requireScanPhoto === true,
    ipRestrictionRequiredForMe:
      ipRestrictionEnabled && role?.requireScanIpAllowlist === true,
    entries: canManage
      ? parseIpAllowlist(values.get(IP_ALLOWLIST_SETTING_KEY) ?? null)
      : [],
    deviceAddresses:
      canManage && address && address !== "unknown" ? [address] : [],
    canManage,
  };
}

export async function updateScanSecurity(
  input: {
    photoEnabled: boolean;
    ipRestrictionEnabled: boolean;
    entries: readonly string[];
  },
  currentAddress?: string,
): Promise<ScanSecuritySettings> {
  await ensureDbInitialized();
  await db.batch(
    [
      [SCAN_PHOTO_ENABLED_KEY, input.photoEnabled ? "true" : "false"],
      [
        SCAN_IP_RESTRICTION_ENABLED_KEY,
        input.ipRestrictionEnabled ? "true" : "false",
      ],
      // Disimpan dalam bentuk kanonik: entri tidak valid dibuang di sini supaya
      // tidak ada daftar berisi teks sampah yang diam-diam memblokir semua orang.
      [IP_ALLOWLIST_SETTING_KEY, serializeIpAllowlist(input.entries)],
    ].map(([key, value]) => ({
      sql: `INSERT INTO setting_gex_system (key, value) VALUES (?, ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value;`,
      args: [key, value],
    })),
    "write",
  );
  // Yang menyimpan pasti Superadmin; sakelar role-nya sendiri tidak relevan
  // untuk balasan formulir.
  return getScanSecurity(true, currentAddress);
}
