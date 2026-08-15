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
  hapusShift,
  kalkulasiJamKerjaNormalMenit,
  type ShiftInput,
  tambahShift,
  updateShift,
} from "@/lib/services/shift";
import {
  firstValidationMessage,
  validateShiftDraft,
} from "@/lib/validations/stabilization";

export const runtime = "nodejs";

interface ShiftMutationBody {
  shiftId?: unknown;
  draft?: unknown;
}

function parseDraft(value: unknown): ShiftInput {
  const draft = (value ?? {}) as Record<string, unknown>;
  const jamMasuk = typeof draft.jam_masuk === "string" ? draft.jam_masuk : "";
  const jamPulang =
    typeof draft.jam_pulang === "string" ? draft.jam_pulang : "";
  const awalAbsen = Number(draft.awal_absen_menit ?? 120);
  const batasMasuk = Number(draft.batas_masuk_menit ?? 60);
  const istirahat = Number(draft.istirahat_menit ?? 60);

  const parsed: ShiftInput = {
    kode_shift: Number(draft.kode_shift),
    nama_shift:
      typeof draft.nama_shift === "string" ? draft.nama_shift.trim() : "",
    jam_masuk: jamMasuk,
    jam_pulang: jamPulang,
    awal_absen_menit: awalAbsen,
    batas_masuk_menit: batasMasuk,
    toleransi_masuk_menit: Number(draft.toleransi_masuk_menit ?? 0),
    jam_kerja_normal_menit:
      draft.jam_kerja_normal_menit !== undefined &&
      Number(draft.jam_kerja_normal_menit) >= 0
        ? Number(draft.jam_kerja_normal_menit)
        : kalkulasiJamKerjaNormalMenit(
            jamMasuk,
            jamPulang,
            istirahat,
            batasMasuk,
          ),
    istirahat_menit: istirahat,
    batas_pulang_menit: Number(draft.batas_pulang_menit ?? 240),
    offset_istirahat_mulai: Number(draft.offset_istirahat_mulai ?? 240),
    offset_generate_alfa: Number(draft.offset_generate_alfa ?? 180),
    buffer_shift_malam_menit: Number(draft.buffer_shift_malam_menit ?? 120),
  };
  const message = firstValidationMessage(validateShiftDraft(parsed));
  if (message) throw new ApiRequestError(message, 400);
  return parsed;
}

async function prepare(request: NextRequest) {
  assertSameOriginMutation(request);
  const actor = await requireWebPermission(request, "shifts.manage");
  await ensureServerDatabaseInitialized();
  return actor;
}

export async function POST(request: NextRequest) {
  try {
    const actor = await prepare(request);
    const body = await readJsonBody<ShiftMutationBody>(request);
    const draft = parseDraft(body.draft);
    const result = await tambahShift(draft);
    const revision = await recordOperationalChange(getServerDatabase(), {
      domain: "shift",
      entityKey: String(result.id_shift),
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
    const body = await readJsonBody<ShiftMutationBody>(request);
    const shiftId = parsePositiveId(body.shiftId, "ID shift");
    const draft = parseDraft(body.draft);
    await updateShift(shiftId, draft);
    const revision = await recordOperationalChange(getServerDatabase(), {
      domain: "shift",
      entityKey: String(shiftId),
      operation: "update",
      payload: draft,
      actorOperatorId: actor.id,
    });
    return noStoreJson({ sukses: true, revision });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const actor = await prepare(request);
    const body = await readJsonBody<ShiftMutationBody>(request);
    const shiftId = parsePositiveId(body.shiftId, "ID shift");
    const result = await hapusShift(shiftId);
    if (!result.sukses) {
      throw new ApiRequestError(
        result.pesan ?? "Shift tidak dapat dihapus.",
        409,
      );
    }
    const revision = await recordOperationalChange(getServerDatabase(), {
      domain: "shift",
      entityKey: String(shiftId),
      operation: "delete",
      payload: { id_shift: shiftId },
      actorOperatorId: actor.id,
    });
    return noStoreJson({ sukses: true, revision });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
