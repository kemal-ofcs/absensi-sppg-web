import type { NextRequest } from "next/server";
import {
  requireWebPermission,
  requireWebSession,
} from "@/lib/server/auth/authorize";
import {
  ensureServerDatabaseInitialized,
  getServerDatabase,
} from "@/lib/server/db";
import {
  ApiRequestError,
  noStoreJson,
  readJsonBody,
  toApiErrorResponse,
} from "@/lib/server/http/api-response";
import {
  assertSameOriginMutation,
  getClientAddress,
} from "@/lib/server/http/request-security";
import { recordOperationalChange } from "@/lib/server/operational/change-log";
import {
  getScanSecurity,
  updateScanSecurity,
} from "@/lib/services/scan-security";
import {
  MAX_IP_ALLOWLIST_ENTRIES,
  validateIpAllowlistEntries,
} from "@/lib/validations/ip-allowlist";
import {
  SCAN_IP_RESTRICTION_ENABLED_KEY,
  SCAN_PHOTO_ENABLED_KEY,
} from "@/lib/validations/scan-security";

export const runtime = "nodejs";

interface ScanSecurityBody {
  photoEnabled?: unknown;
  ipRestrictionEnabled?: unknown;
  entries?: unknown;
}

function parseEntries(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : [];
  if (raw.length > MAX_IP_ALLOWLIST_ENTRIES) {
    throw new ApiRequestError(
      `Maksimal ${MAX_IP_ALLOWLIST_ENTRIES} entri IP.`,
      400,
    );
  }
  const entries = raw.map((item) => String(item ?? "").trim());
  const message = Object.values(validateIpAllowlistEntries(entries))[0];
  if (message) throw new ApiRequestError(message, 400);
  return entries;
}

/**
 * Pembacaan pengaturan keamanan absensi.
 *
 * Hanya butuh sesi yang sah: halaman scanner perlu tahu apakah fitur fotonya
 * hidup supaya bisa menahan scan pada saat yang tepat. Daftar alamat IP-nya
 * sendiri hanya ikut untuk Superadmin.
 */
export async function POST(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    const actor = await requireWebSession(request);
    await ensureServerDatabaseInitialized();
    return noStoreJson({
      data: await getScanSecurity(
        actor.isSuperadmin,
        getClientAddress(request),
        {
          requireScanPhoto: actor.requireScanPhoto,
          requireScanIpAllowlist: actor.requireScanIpAllowlist,
        },
      ),
    });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}

export async function PUT(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    const actor = await requireWebPermission(request, "settings.manage", true);
    await ensureServerDatabaseInitialized();
    const body = await readJsonBody<ScanSecurityBody>(request);
    const data = await updateScanSecurity(
      {
        photoEnabled: body.photoEnabled === true,
        ipRestrictionEnabled: body.ipRestrictionEnabled === true,
        entries: parseEntries(body.entries),
      },
      getClientAddress(request),
    );
    // Ketiganya hidup di `setting_gex_system` yang ikut sinkronisasi, jadi
    // perubahannya wajib tercatat sebagai perubahan operasional agar terminal
    // Desktop/Mobile menariknya pada siklus sync berikutnya.
    const revision = await recordOperationalChange(getServerDatabase(), {
      domain: "setting",
      entityKey: SCAN_PHOTO_ENABLED_KEY,
      operation: "update",
      payload: {
        [SCAN_PHOTO_ENABLED_KEY]: data.photoEnabled,
        [SCAN_IP_RESTRICTION_ENABLED_KEY]: data.ipRestrictionEnabled,
        entries: data.entries,
      },
      actorOperatorId: actor.id,
    });
    return noStoreJson({ data, revision });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
