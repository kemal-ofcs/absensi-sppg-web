import type { NextRequest } from "next/server";
import { z } from "zod";
import { WEB_SESSION_COOKIE } from "@/lib/auth/web-session";
import { readWebSession } from "@/lib/server/auth/session";
import {
  ensureServerDatabaseInitialized,
  getServerDatabase,
} from "@/lib/server/db";
import {
  noStoreJson,
  readJsonBody,
  toApiErrorResponse,
} from "@/lib/server/http/api-response";
import { assertSameOriginMutation } from "@/lib/server/http/request-security";
import {
  checkInstallableLicense,
  isLicenseEnforced,
  resolveWebLicense,
  storeLicense,
  toLicenseStatus,
} from "@/lib/server/license";

export const runtime = "nodejs";

const bodySchema = z
  .object({ license: z.string().min(1).max(65_536) })
  .strict();

/**
 * Pasang lisensi dari teks `LIS1.…`. Padanan `desktop_install_license`, dengan
 * aturan yang sama:
 *
 * - Tanpa sesi hanya bila lisensi saat ini TIDAK aktif penuh. Saat itulah
 *   tidak ada yang bisa login untuk memasangnya. Yang membuatnya aman adalah
 *   tanda tangannya: hanya penerbit yang bisa membuat teks yang lolos.
 * - Mengganti lisensi yang masih aktif menuntut Superadmin.
 * - Hanya lisensi yang aktif penuh UNTUK SERVER INI yang diterima, supaya
 *   tidak ada yang mengunci dirinya keluar.
 */
export async function POST(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    if (!isLicenseEnforced()) {
      return noStoreJson(
        { sukses: false, pesan: "Pemasangan ini tidak memakai lisensi." },
        404,
      );
    }
    const parsed = bodySchema.safeParse(await readJsonBody(request, 70_000));
    if (!parsed.success) {
      return noStoreJson(
        { sukses: false, pesan: "Teks lisensi tidak valid." },
        400,
      );
    }

    await ensureServerDatabaseInitialized();
    const database = getServerDatabase();
    const current = await resolveWebLicense(database, request);
    if (current.evaluation.state === "active") {
      const actor = await readWebSession(
        request.cookies.get(WEB_SESSION_COOKIE)?.value ?? "",
      );
      if (!actor?.isSuperadmin) {
        return noStoreJson(
          {
            sukses: false,
            pesan:
              "Lisensi yang masih aktif hanya bisa diganti oleh Superadmin setelah login.",
          },
          403,
        );
      }
    }

    try {
      await checkInstallableLicense(database, request, parsed.data.license);
    } catch (error) {
      return noStoreJson(
        {
          sukses: false,
          pesan: error instanceof Error ? error.message : "Lisensi tidak sah.",
        },
        400,
      );
    }
    await storeLicense(database, parsed.data.license);

    const next = await resolveWebLicense(database, request);
    return noStoreJson({
      sukses: true,
      status: toLicenseStatus(next.evaluation, next.context),
    });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
