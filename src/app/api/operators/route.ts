import type { NextRequest } from "next/server";
import {
  editOperator,
  insertOperator,
  removeOperator,
} from "@/lib/operators/operator-admin";
import type { OperatorDraft } from "@/lib/operators/types";
import { requireWebPermission } from "@/lib/server/auth/authorize";
import { getServerDatabase } from "@/lib/server/db";
import {
  noStoreJson,
  parsePositiveId,
  readJsonBody,
  toApiErrorResponse,
} from "@/lib/server/http/api-response";
import { assertSameOriginMutation } from "@/lib/server/http/request-security";

export const runtime = "nodejs";

interface OperatorMutationBody {
  operatorId?: unknown;
  draft?: unknown;
}

function parseDraft(value: unknown): OperatorDraft {
  const draft = (value ?? {}) as Record<string, unknown>;
  return {
    kodeOperator:
      typeof draft.kodeOperator === "string" ? draft.kodeOperator : "",
    name: typeof draft.name === "string" ? draft.name : "",
    username: typeof draft.username === "string" ? draft.username : "",
    password: typeof draft.password === "string" ? draft.password : undefined,
    roleId: Number(draft.roleId),
    status: String(draft.status) as OperatorDraft["status"],
  };
}

async function prepareMutation(request: NextRequest) {
  assertSameOriginMutation(request);
  return requireWebPermission(request, "operators.manage", true);
}

export async function POST(request: NextRequest) {
  try {
    await prepareMutation(request);
    const body = await readJsonBody<OperatorMutationBody>(request);
    const result = await insertOperator(
      getServerDatabase(),
      parseDraft(body.draft),
    );
    return noStoreJson({ sukses: true, ...result }, 201);
  } catch (error) {
    return toApiErrorResponse(error);
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const actor = await prepareMutation(request);
    const body = await readJsonBody<OperatorMutationBody>(request);
    await editOperator(
      getServerDatabase(),
      actor.id,
      parsePositiveId(body.operatorId, "ID operator"),
      parseDraft(body.draft),
    );
    return noStoreJson({ sukses: true });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const actor = await prepareMutation(request);
    const body = await readJsonBody<OperatorMutationBody>(request);
    await removeOperator(
      getServerDatabase(),
      actor.id,
      parsePositiveId(body.operatorId, "ID operator"),
    );
    return noStoreJson({ sukses: true });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
