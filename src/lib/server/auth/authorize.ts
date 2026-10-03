import "server-only";

import type { NextRequest } from "next/server";
import {
  AuthorizationError,
  assertActorPermission,
} from "@/lib/auth/permission-assertion";
import { WEB_SESSION_COOKIE } from "@/lib/auth/web-session";
import type { PermissionKey } from "@/lib/rbac/catalog";
import { readWebSession } from "@/lib/server/auth/session";
import { getServerDatabase } from "@/lib/server/db";
import { licenseRejection } from "@/lib/server/license";

/**
 * Gerbang lisensi untuk satu permintaan: melempar 403 dengan pesan lisensinya
 * bila ditolak. Tidak berbuat apa pun pada build yang tidak menegakkan lisensi.
 */
export async function assertWebLicense(
  request: Request,
  permission: string | null,
) {
  const rejection = await licenseRejection(
    getServerDatabase(),
    request,
    permission,
  );
  if (rejection !== null) throw new AuthorizationError(rejection, 403);
}

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
  await assertWebLicense(request, null);
  return actor;
}

export async function requireWebPermission(
  request: NextRequest,
  permission: PermissionKey,
  superadminOnly = false,
) {
  const token = request.cookies.get(WEB_SESSION_COOKIE)?.value ?? "";
  const actor = assertActorPermission(
    await readWebSession(token),
    permission,
    superadminOnly,
  );
  // Gerbang lisensi ada di SINI, satu kali untuk setiap route yang menuntut
  // izin, sama seperti `require_any_permission` di Rust. Tanggal berakhirnya
  // dibandingkan pada setiap permintaan, bukan hanya saat login: sesi bisa
  // hidup melewati hari terakhir sewa. Pada build yang tidak menegakkan
  // lisensi, pemanggilan ini tidak menyentuh database.
  await assertWebLicense(request, permission);
  return actor;
}
