import type { NextRequest } from "next/server";
import { requireWebPermission } from "@/lib/server/auth/authorize";
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
import { assertSameOriginMutation } from "@/lib/server/http/request-security";
import { recordOperationalChange } from "@/lib/server/operational/change-log";
import {
  generateTokenMassal,
  importKaryawanMassal,
  type KaryawanInput,
  tambahKaryawan,
  toggleStatusKaryawan,
  updateKaryawan,
} from "@/lib/services/employee";
import {
  firstValidationMessage,
  validateEmployeeDraft,
} from "@/lib/validations/stabilization";

export const runtime = "nodejs";

interface EmployeeMutationBody {
  action?: unknown;
  idUnik?: unknown;
  draft?: unknown;
  status?: unknown;
  drafts?: unknown;
}

function parseDraft(value: unknown): KaryawanInput {
  const draft = (value ?? {}) as Record<string, unknown>;
  const parsed: KaryawanInput = {
    id_unik: typeof draft.id_unik === "string" ? draft.id_unik.trim() : "",
    kode_karyawan:
      typeof draft.kode_karyawan === "string" ? draft.kode_karyawan.trim() : "",
    nama: typeof draft.nama === "string" ? draft.nama.trim() : "",
    divisi: typeof draft.divisi === "string" ? draft.divisi.trim() : "",
    jabatan_status:
      typeof draft.jabatan_status === "string"
        ? draft.jabatan_status.trim()
        : undefined,
    no_hp: typeof draft.no_hp === "string" ? draft.no_hp.trim() : undefined,
    lp: draft.lp === "P" ? "P" : "L",
    id_shift: Number(draft.id_shift),
    status_aktif: draft.status_aktif === "Nonaktif" ? "Nonaktif" : "Aktif",
    tanggal_daftar:
      typeof draft.tanggal_daftar === "string"
        ? draft.tanggal_daftar
        : undefined,
    catatan:
      typeof draft.catatan === "string" ? draft.catatan.trim() : undefined,
    jenis_personil:
      typeof draft.jenis_personil === "string"
        ? draft.jenis_personil.trim()
        : undefined,
    tanggal_mulai_aktif:
      typeof draft.tanggal_mulai_aktif === "string"
        ? draft.tanggal_mulai_aktif
        : undefined,
    tanggal_selesai_aktif:
      typeof draft.tanggal_selesai_aktif === "string"
        ? draft.tanggal_selesai_aktif
        : undefined,
  };
  const message = firstValidationMessage(validateEmployeeDraft(parsed));
  if (message) throw new ApiRequestError(message, 400);
  return parsed;
}

async function prepare(request: NextRequest) {
  assertSameOriginMutation(request);
  const actor = await requireWebPermission(request, "employees.manage");
  await ensureServerDatabaseInitialized();
  return actor;
}

export async function POST(request: NextRequest) {
  try {
    const actor = await prepare(request);
    const body = await readJsonBody<EmployeeMutationBody>(request, 10_485_760);
    const draft = parseDraft(body.draft);
    const result = await tambahKaryawan(draft);
    const revision = await recordOperationalChange(getServerDatabase(), {
      domain: "employee",
      entityKey: draft.id_unik,
      operation: "create",
      payload: draft,
      actorOperatorId: actor.id,
    });
    return noStoreJson({ ...result, revision }, 201);
  } catch (error) {
    return toApiErrorResponse(error);
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const actor = await prepare(request);
    const body = await readJsonBody<EmployeeMutationBody>(request, 10_485_760);
    const idUnik = typeof body.idUnik === "string" ? body.idUnik.trim() : "";
    if (!idUnik) throw new ApiRequestError("ID karyawan tidak valid.", 400);
    const draft = parseDraft(body.draft);
    await updateKaryawan(idUnik, draft);
    const revision = await recordOperationalChange(getServerDatabase(), {
      domain: "employee",
      entityKey: idUnik,
      operation: "update",
      payload: draft,
      actorOperatorId: actor.id,
    });
    return noStoreJson({ sukses: true, revision });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}

export async function PUT(request: NextRequest) {
  try {
    const actor = await prepare(request);
    const body = await readJsonBody<EmployeeMutationBody>(request, 10_485_760);
    if (body.action === "generate-tokens") {
      const result = await generateTokenMassal();
      const revision = await recordOperationalChange(getServerDatabase(), {
        domain: "employee",
        entityKey: "*",
        operation: "generate-tokens",
        payload: result,
        actorOperatorId: actor.id,
      });
      return noStoreJson({ ...result, revision });
    }
    if (body.action === "import") {
      if (!Array.isArray(body.drafts) || body.drafts.length > 500) {
        throw new ApiRequestError(
          "Import harus berisi 1-500 baris karyawan.",
          400,
        );
      }
      const drafts = body.drafts.map(parseDraft);
      const uniqueIds = new Set(drafts.map((draft) => draft.id_unik));
      const uniqueCodes = new Set(drafts.map((draft) => draft.kode_karyawan));
      if (
        uniqueIds.size !== drafts.length ||
        uniqueCodes.size !== drafts.length
      ) {
        throw new ApiRequestError(
          "File memuat ID atau kode karyawan duplikat.",
          400,
        );
      }
      const result = await importKaryawanMassal(drafts);
      const revision = await recordOperationalChange(getServerDatabase(), {
        domain: "employee",
        entityKey: "*",
        operation: "import",
        payload: result,
        actorOperatorId: actor.id,
      });
      return noStoreJson({ ...result, revision });
    }
    const idUnik = typeof body.idUnik === "string" ? body.idUnik.trim() : "";
    if (!idUnik || (body.status !== "Aktif" && body.status !== "Nonaktif")) {
      throw new ApiRequestError("Perubahan status karyawan tidak valid.", 400);
    }
    await toggleStatusKaryawan(idUnik, body.status);
    const revision = await recordOperationalChange(getServerDatabase(), {
      domain: "employee",
      entityKey: idUnik,
      operation: "status",
      payload: { status_aktif: body.status },
      actorOperatorId: actor.id,
    });
    return noStoreJson({ sukses: true, revision });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
