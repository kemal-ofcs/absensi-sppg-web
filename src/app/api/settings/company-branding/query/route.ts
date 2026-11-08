import type { NextRequest } from "next/server";
import { ensureServerDatabaseInitialized } from "@/lib/server/db";
import {
  noStoreJson,
  toApiErrorResponse,
} from "@/lib/server/http/api-response";
import { assertSameOriginMutation } from "@/lib/server/http/request-security";
import { getCompanyBranding } from "@/lib/services/company-profile";

export const runtime = "nodejs";

// Sengaja tanpa sesi: nama dan logo memang tampil di layar login. Jangan
// tambahkan kolom profil lain ke sini.
export async function POST(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    await ensureServerDatabaseInitialized();
    const data = await getCompanyBranding();
    return noStoreJson({ data });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
