import type { NextRequest } from "next/server";
import { requireWebPermission } from "@/lib/server/auth/authorize";
import {
  ensureServerDatabaseInitialized,
  getServerDatabase,
} from "@/lib/server/db";
import {
  ApiRequestError,
  noStoreJson,
  parsePositiveId,
  readJsonBody,
  toApiErrorResponse,
} from "@/lib/server/http/api-response";
import { assertSameOriginMutation } from "@/lib/server/http/request-security";
import { recordOperationalChange } from "@/lib/server/operational/change-log";
import {
  type HariLiburInput,
  hapusHariLibur,
  tambahHariLibur,
  updateHariLibur,
} from "@/lib/services/holiday";

export const runtime = "nodejs";

interface HolidayMutationBody {
  holidayId?: unknown;
  draft?: unknown;
}

function parseDraft(value: unknown): HariLiburInput {
  const draft = (value ?? {}) as Record<string, unknown>;
  const tanggal = typeof draft.tanggal === "string" ? draft.tanggal.trim() : "";
  const namaLibur =
    typeof draft.nama_libur === "string" ? draft.nama_libur.trim() : "";
  if (!tanggal || !namaLibur) {
    throw new ApiRequestError("Tanggal dan nama hari libur wajib diisi.", 400);
  }

  return {
    tanggal,
    nama_libur: namaLibur,
    jenis_libur:
      typeof draft.jenis_libur === "string"
        ? draft.jenis_libur.trim()
        : "Libur Nasional",
    keterangan:
      typeof draft.keterangan === "string" ? draft.keterangan.trim() : null,
    status_aktif:
      draft.status_aktif === false || Number(draft.status_aktif) === 0 ? 0 : 1,
  };
}

export async function POST(request: NextRequest) {
  try {
    const actor = await requireWebPermission(request, "holidays.manage");
    assertSameOriginMutation(request);
    await ensureServerDatabaseInitialized();

    const body = await readJsonBody<HolidayMutationBody>(request);
    const draft = parseDraft(body.draft);
    const result = await tambahHariLibur(draft);

    const client = getServerDatabase();
    await recordOperationalChange(client, {
      domain: "holiday",
      operation: "create",
      entityKey: String(result.id_libur),
      payload: { ...draft, id_libur: result.id_libur },
      actorOperatorId: actor.id,
    });

    return noStoreJson(result, 201);
  } catch (error) {
    return toApiErrorResponse(error);
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const actor = await requireWebPermission(request, "holidays.manage");
    assertSameOriginMutation(request);
    await ensureServerDatabaseInitialized();

    const body = await readJsonBody<HolidayMutationBody>(request);
    const holidayId = parsePositiveId(body.holidayId, "ID Hari Libur");
    const rawDraft = (body.draft ?? {}) as Record<string, unknown>;

    const updatePayload: Partial<HariLiburInput> = {};
    if (typeof rawDraft.tanggal === "string") {
      updatePayload.tanggal = rawDraft.tanggal.trim();
    }
    if (typeof rawDraft.nama_libur === "string") {
      updatePayload.nama_libur = rawDraft.nama_libur.trim();
    }
    if (typeof rawDraft.jenis_libur === "string") {
      updatePayload.jenis_libur = rawDraft.jenis_libur.trim();
    }
    if (rawDraft.keterangan !== undefined) {
      updatePayload.keterangan =
        typeof rawDraft.keterangan === "string"
          ? rawDraft.keterangan.trim()
          : null;
    }
    if (rawDraft.status_aktif !== undefined) {
      updatePayload.status_aktif =
        rawDraft.status_aktif === false || Number(rawDraft.status_aktif) === 0
          ? 0
          : 1;
    }

    const result = await updateHariLibur(holidayId, updatePayload);

    const client = getServerDatabase();
    await recordOperationalChange(client, {
      domain: "holiday",
      operation: "update",
      entityKey: String(holidayId),
      payload: { ...updatePayload, id_libur: holidayId },
      actorOperatorId: actor.id,
    });

    return noStoreJson(result);
  } catch (error) {
    return toApiErrorResponse(error);
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const actor = await requireWebPermission(request, "holidays.manage");
    assertSameOriginMutation(request);
    await ensureServerDatabaseInitialized();

    const body = await readJsonBody<HolidayMutationBody>(request);
    const holidayId = parsePositiveId(body.holidayId, "ID Hari Libur");

    const result = await hapusHariLibur(holidayId);

    const client = getServerDatabase();
    await recordOperationalChange(client, {
      domain: "holiday",
      operation: "delete",
      entityKey: String(holidayId),
      payload: { id_libur: holidayId },
      actorOperatorId: actor.id,
    });

    return noStoreJson(result);
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
