import type { NextRequest } from "next/server";
import { requireWebPermission } from "@/lib/server/auth/authorize";
import { ensureServerDatabaseInitialized } from "@/lib/server/db";
import {
  ApiRequestError,
  noStoreJson,
  readJsonBody,
  toApiErrorResponse,
} from "@/lib/server/http/api-response";
import { assertSameOriginMutation } from "@/lib/server/http/request-security";
import {
  getDashboardMetrics,
  getRekapBulanan,
  getRekapHarian,
  getRiwayatScan,
  getTopKaryawanTerajin,
} from "@/lib/services/report";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    await requireWebPermission(request, "dashboard.view");
    const body = await readJsonBody<Record<string, unknown>>(request);
    await ensureServerDatabaseInitialized();
    if (body.kind === "metrics")
      return noStoreJson({ data: await getDashboardMetrics() });
    if (body.kind === "daily")
      return noStoreJson({
        data: await getRekapHarian({
          tanggal: typeof body.tanggal === "string" ? body.tanggal : undefined,
          tanggal_mulai:
            typeof body.tanggal_mulai === "string"
              ? body.tanggal_mulai
              : undefined,
          tanggal_selesai:
            typeof body.tanggal_selesai === "string"
              ? body.tanggal_selesai
              : undefined,
          divisi: typeof body.divisi === "string" ? body.divisi : undefined,
        }),
      });
    if (body.kind === "scan-history")
      return noStoreJson({
        data: await getRiwayatScan({
          tanggal: typeof body.tanggal === "string" ? body.tanggal : undefined,
          tanggal_mulai:
            typeof body.tanggal_mulai === "string"
              ? body.tanggal_mulai
              : undefined,
          tanggal_selesai:
            typeof body.tanggal_selesai === "string"
              ? body.tanggal_selesai
              : undefined,
          search: typeof body.search === "string" ? body.search : undefined,
          limit: Number(body.limit) || undefined,
          offset: Number(body.offset) || undefined,
        }),
      });
    if (body.kind === "monthly")
      return noStoreJson({
        data: await getRekapBulanan({
          bulan: typeof body.bulan === "string" ? body.bulan : undefined,
          tahun: Number.isSafeInteger(Number(body.tahun))
            ? Number(body.tahun)
            : undefined,
          divisi: typeof body.divisi === "string" ? body.divisi : undefined,
        }),
      });
    if (body.kind === "top")
      return noStoreJson({
        data: await getTopKaryawanTerajin(
          Math.min(50, Math.max(1, Number(body.limit) || 5)),
        ),
      });
    throw new ApiRequestError("Jenis data dashboard tidak dikenali.", 400);
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
