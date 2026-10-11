import type { NextRequest } from "next/server";
import { requireWebPermission } from "@/lib/server/auth/authorize";
import { ensureServerDatabaseInitialized } from "@/lib/server/db";
import {
  noStoreJson,
  readJsonBody,
  toApiErrorResponse,
} from "@/lib/server/http/api-response";
import { assertSameOriginMutation } from "@/lib/server/http/request-security";
import { getDaftarKaryawan } from "@/lib/services/employee";

export const runtime = "nodejs";

interface EmployeeQueryBody {
  search?: unknown;
  divisi?: unknown;
  status_aktif?: unknown;
}

export async function POST(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    await requireWebPermission(request, "employees.view");
    const body = await readJsonBody<EmployeeQueryBody>(request);
    await ensureServerDatabaseInitialized();
    const value = (input: unknown, maximum: number) =>
      typeof input === "string" ? input.trim().slice(0, maximum) : undefined;
    return noStoreJson({
      sukses: true,
      employees: await getDaftarKaryawan({
        search: value(body.search, 100),
        divisi: value(body.divisi, 100),
        status_aktif: value(body.status_aktif, 16),
      }),
    });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
