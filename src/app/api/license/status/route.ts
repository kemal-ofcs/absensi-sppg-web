import type { NextRequest } from "next/server";
import { WEB_SESSION_COOKIE } from "@/lib/auth/web-session";
import { readWebSession } from "@/lib/server/auth/session";
import {
  ensureServerDatabaseInitialized,
  getServerDatabase,
} from "@/lib/server/db";
import {
  noStoreJson,
  toApiErrorResponse,
} from "@/lib/server/http/api-response";
import { assertSameOriginMutation } from "@/lib/server/http/request-security";
import {
  isLicenseEnforced,
  resolveWebLicense,
  toLicenseStatus,
} from "@/lib/server/license";

export const runtime = "nodejs";

/**
 * Status lisensi server ini. Padanan `desktop_get_license_status`.
 *
 * Bisa dipanggil TANPA login, karena layar aktivasi harus tampil justru saat
 * tidak ada yang bisa masuk. Karena itu jawabannya dibatasi:
 *
 * 1. Build yang tidak menegakkan lisensi menjawab `status: null`, dan seluruh
 *    antarmuka lisensi tidak merender apa pun.
 *
 * 2. Kode server ikut dikirim: ia bukan rahasia, dan pemasang membutuhkannya
 *    untuk meminta lisensi.
 *
 * 3. Daftar perangkat, kode instance, dan alamat yang tercantum di lisensi
 *    HANYA dikirim kepada Superadmin. Pengunjung tanpa sesi cukup tahu siapa
 *    pemegangnya dan sampai kapan berlakunya.
 */
export async function POST(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    if (!isLicenseEnforced()) {
      return noStoreJson({ sukses: true, status: null });
    }

    await ensureServerDatabaseInitialized();
    const { evaluation, context } = await resolveWebLicense(
      getServerDatabase(),
      request,
    );
    const status = toLicenseStatus(evaluation, context);
    const actor = await readWebSession(
      request.cookies.get(WEB_SESSION_COOKIE)?.value ?? "",
    );
    if (status.license && !actor?.isSuperadmin) {
      status.license = {
        ...status.license,
        devices: [],
        webInstance: null,
        websites: [],
      };
    }
    return noStoreJson({ sukses: true, status });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
