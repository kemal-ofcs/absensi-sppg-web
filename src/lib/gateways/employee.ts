"use client";

import { requestWebApi } from "@/lib/client/api-client";
import { isDesktopRuntime } from "@/lib/runtime/app-runtime";
import { invokeDesktop } from "@/lib/runtime/desktop-commands";
import type { KaryawanInput } from "@/lib/services/employee";

export type { KaryawanInput } from "@/lib/services/employee";

interface EmployeeFilter {
  search?: string;
  divisi?: string;
  status_aktif?: string;
}

function kickDesktopSync() {
  void invokeDesktop("desktop_sync_now").catch(() => undefined);
}

export async function getDaftarKaryawan(filter?: EmployeeFilter) {
  if (isDesktopRuntime()) {
    return invokeDesktop<Record<string, unknown>[]>("desktop_get_employees", {
      filter: filter ?? {},
    });
  }
  const response = await requestWebApi<{
    employees: Record<string, unknown>[];
  }>("/api/employees/query", "POST", filter ?? {});
  return response.employees;
}

export async function tambahKaryawan(draft: KaryawanInput) {
  if (isDesktopRuntime()) {
    const result = await invokeDesktop<{ sukses: true; id_unik: string }>(
      "desktop_create_employee",
      { draft },
    );
    kickDesktopSync();
    return result;
  }
  return requestWebApi<{ sukses: true; id_unik: string }>(
    "/api/employees",
    "POST",
    { draft },
  );
}

export async function updateKaryawan(
  idUnik: string,
  draft: Partial<KaryawanInput>,
) {
  if (isDesktopRuntime()) {
    const result = await invokeDesktop<{ sukses: true }>(
      "desktop_update_employee",
      {
        idUnik,
        draft,
      },
    );
    kickDesktopSync();
    return result;
  }
  return requestWebApi<{ sukses: true }>("/api/employees", "PATCH", {
    idUnik,
    draft,
  });
}

export async function toggleStatusKaryawan(
  idUnik: string,
  status: "Aktif" | "Nonaktif",
) {
  if (isDesktopRuntime()) {
    const result = await invokeDesktop<{ sukses: true }>(
      "desktop_set_employee_status",
      {
        idUnik,
        status,
      },
    );
    kickDesktopSync();
    return result;
  }
  return requestWebApi<{ sukses: true }>("/api/employees", "PUT", {
    idUnik,
    status,
  });
}

export async function generateTokenMassal() {
  if (isDesktopRuntime()) {
    const result = await invokeDesktop<{
      sukses: true;
      total_generated: number;
    }>("desktop_generate_employee_tokens");
    kickDesktopSync();
    return result;
  }
  return requestWebApi<{ sukses: true; total_generated: number }>(
    "/api/employees",
    "PUT",
    { action: "generate-tokens" },
  );
}

export async function importKaryawanMassal(drafts: KaryawanInput[]) {
  if (isDesktopRuntime()) {
    const result = await invokeDesktop<{
      sukses: boolean;
      berhasil: number;
      dilewati: number;
    }>("desktop_import_employees", { drafts });
    kickDesktopSync();
    return {
      sukses: true as const,
      berhasil: result.berhasil,
      dilewati: result.dilewati,
    };
  }
  return requestWebApi<{
    sukses: true;
    berhasil: number;
    dilewati: number;
  }>("/api/employees", "PUT", { action: "import", drafts });
}
