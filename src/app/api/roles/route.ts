import type { NextRequest } from "next/server";
import type { PermissionKey } from "@/lib/rbac/catalog";
import {
  editRole,
  insertRole,
  removeRole,
  replaceRolePermissions,
} from "@/lib/rbac/role-admin";
import type { RoleDraft } from "@/lib/rbac/types";
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

interface RoleMutationBody {
  roleId?: unknown;
  draft?: unknown;
  permissionKeys?: unknown;
}

function parseDraft(value: unknown): RoleDraft {
  const draft = (value ?? {}) as Record<string, unknown>;
  return {
    name: typeof draft.name === "string" ? draft.name : "",
    description: typeof draft.description === "string" ? draft.description : "",
    status: String(draft.status) as RoleDraft["status"],
  };
}

function parsePermissionKeys(value: unknown) {
  return Array.isArray(value)
    ? value.filter((key): key is PermissionKey => typeof key === "string")
    : [];
}

async function prepareMutation(request: NextRequest) {
  assertSameOriginMutation(request);
  return requireWebPermission(request, "roles.manage", true);
}

export async function POST(request: NextRequest) {
  try {
    const actor = await prepareMutation(request);
    const body = await readJsonBody<RoleMutationBody>(request);
    const result = await insertRole(
      getServerDatabase(),
      actor.id,
      parseDraft(body.draft),
      parsePermissionKeys(body.permissionKeys),
    );
    return noStoreJson({ sukses: true, ...result }, 201);
  } catch (error) {
    return toApiErrorResponse(error);
  }
}

export async function PATCH(request: NextRequest) {
  try {
    await prepareMutation(request);
    const body = await readJsonBody<RoleMutationBody>(request);
    await editRole(
      getServerDatabase(),
      parsePositiveId(body.roleId, "ID role"),
      parseDraft(body.draft),
    );
    return noStoreJson({ sukses: true });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}

export async function PUT(request: NextRequest) {
  try {
    const actor = await prepareMutation(request);
    const body = await readJsonBody<RoleMutationBody>(request);
    const result = await replaceRolePermissions(
      getServerDatabase(),
      actor.id,
      parsePositiveId(body.roleId, "ID role"),
      parsePermissionKeys(body.permissionKeys),
    );
    return noStoreJson({ sukses: true, ...result });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}

export async function DELETE(request: NextRequest) {
  try {
    await prepareMutation(request);
    const body = await readJsonBody<RoleMutationBody>(request);
    await removeRole(
      getServerDatabase(),
      parsePositiveId(body.roleId, "ID role"),
    );
    return noStoreJson({ sukses: true });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
