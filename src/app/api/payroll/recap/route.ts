import type { NextRequest } from "next/server";
import { requireWebPermission } from "@/lib/server/auth/authorize";
import {
  ensureServerDatabaseInitialized,
  getServerDatabase,
} from "@/lib/server/db";
import {
  noStoreJson,
  readJsonBody,
  toApiErrorResponse,
} from "@/lib/server/http/api-response";
import { computePayrollRecap } from "@/lib/services/payroll-recap";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    await requireWebPermission(request, "payroll.view");
    await ensureServerDatabaseInitialized();
    const client = getServerDatabase();

    const body = await readJsonBody<{
      periodStart?: string;
      periodEnd?: string;
    }>(request);
    const periodStart =
      body.periodStart || new Date().toISOString().slice(0, 10);
    const periodEnd = body.periodEnd || new Date().toISOString().slice(0, 10);

    const recap = await computePayrollRecap(client, periodStart, periodEnd);

    const data = recap.map((row) => ({
      id_karyawan: row.id_karyawan,
      nama_karyawan: row.nama_karyawan,
      divisi: row.divisi,
      rate_per_hour: row.rate_per_hour,
      ptkp_status: row.ptkp_status,
      total_hadir: row.total_hadir,
      total_terlambat_menit: row.total_terlambat_menit,
      total_regular_hours: row.total_regular_hours,
      total_overtime_hours: row.total_overtime_hours,
      total_overtime_index: row.total_overtime_index,
      est_basic_salary: row.est_basic_salary,
      est_overtime_salary: row.est_overtime_salary,
      est_gross_salary: row.est_gross_salary,
      est_total_allowance: row.est_total_allowance,
      est_total_deduction: row.est_total_deduction,
      est_bpjs_employee: row.est_bpjs_employee,
      est_pph21: row.est_pph21,
      est_net_salary: row.est_net_salary,
    }));

    return noStoreJson({ data });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
