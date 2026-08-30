import "server-only";

import type { NextRequest } from "next/server";
import {
  AuthorizationError,
  assertActorPermission,
} from "@/lib/auth/permission-assertion";
import { WEB_SESSION_COOKIE } from "@/lib/auth/web-session";
import type { PermissionKey } from "@/lib/rbac/catalog";
import { readWebSession } from "@/lib/server/auth/session";

/**
 * Sesi login yang sah, tanpa menuntut izin tertentu.
 *
 * Dipakai tindakan yang hanya menyentuh akun milik pemanggil sendiri —
 * mendaftarkan atau mematikan verifikasi dua langkahnya sendiri. Memaksakan
 * sebuah izin di sini akan salah: setiap operator berhak mengamankan akunnya,
 * termasuk role paling terbatas sekalipun.
 */
export async function requireWebSession(request: NextRequest) {
  const token = request.cookies.get(WEB_SESSION_COOKIE)?.value ?? "";
  const actor = await readWebSession(token);
  if (!actor) {
    throw new AuthorizationError("Sesi login tidak ditemukan.", 401);
  }
  return actor;
}

export async function requireWebPermission(
  request: NextRequest,
  permission: PermissionKey,
  superadminOnly = false,
) {
  const token = request.cookies.get(WEB_SESSION_COOKIE)?.value ?? "";
  const actor = await readWebSession(token);
  return assertActorPermission(actor, permission, superadminOnly);
}
