"use client";

import { requestWebApi } from "@/lib/client/api-client";
import type { OperatorDraft, OperatorRecord } from "@/lib/operators/types";
import type { PermissionKey } from "@/lib/rbac/catalog";
import type { RoleDraft, RoleRecord } from "@/lib/rbac/types";
import { isDesktopRuntime } from "@/lib/runtime/app-runtime";

export async function getMasterOperators(actorId: number) {
  if (isDesktopRuntime()) {
    const service = await import("@/lib/services/operator");
    return service.getMasterOperators(actorId);
  }
  const response = await requestWebApi<{ operators: OperatorRecord[] }>(
    "/api/operators/query",
    "POST",
  );
  return response.operators;
}

export async function createOperator(actorId: number, draft: OperatorDraft) {
  if (isDesktopRuntime()) {
    const service = await import("@/lib/services/operator");
    return service.createOperator(actorId, draft);
  }
  return requestWebApi<{ sukses: true; id: number }>("/api/operators", "POST", {
    draft,
  });
}

export async function updateMasterOperator(
  actorId: number,
  operatorId: number,
  draft: OperatorDraft,
) {
  if (isDesktopRuntime()) {
    const service = await import("@/lib/services/operator");
    return service.updateMasterOperator(actorId, operatorId, draft);
  }
  return requestWebApi<{ sukses: true }>("/api/operators", "PATCH", {
    operatorId,
    draft,
  });
}

export async function deleteMasterOperator(
  actorId: number,
  operatorId: number,
) {
  if (isDesktopRuntime()) {
    const service = await import("@/lib/services/operator");
    return service.deleteMasterOperator(actorId, operatorId);
  }
  return requestWebApi<{ sukses: true }>("/api/operators", "DELETE", {
    operatorId,
  });
}

export async function getRoleRecords(actorId: number) {
  if (isDesktopRuntime()) {
    const service = await import("@/lib/services/rbac");
    return service.getRoleRecords(actorId);
  }
  const response = await requestWebApi<{ roles: RoleRecord[] }>(
    "/api/roles/query",
    "POST",
  );
  return response.roles;
}

export async function createRole(
  actorId: number,
  draft: RoleDraft,
  permissionKeys: readonly PermissionKey[],
) {
  if (isDesktopRuntime()) {
    const service = await import("@/lib/services/rbac");
    return service.createRole(actorId, draft, permissionKeys);
  }
  return requestWebApi<{ sukses: true; id: number }>("/api/roles", "POST", {
    draft,
    permissionKeys,
  });
}

export async function updateRole(
  actorId: number,
  roleId: number,
  draft: RoleDraft,
) {
  if (isDesktopRuntime()) {
    const service = await import("@/lib/services/rbac");
    return service.updateRole(actorId, roleId, draft);
  }
  return requestWebApi<{ sukses: true }>("/api/roles", "PATCH", {
    roleId,
    draft,
  });
}

export async function setRolePermissions(
  actorId: number,
  roleId: number,
  permissionKeys: readonly PermissionKey[],
) {
  if (isDesktopRuntime()) {
    const service = await import("@/lib/services/rbac");
    return service.setRolePermissions(actorId, roleId, permissionKeys);
  }
  return requestWebApi<{ sukses: true; revision: number }>(
    "/api/roles",
    "PUT",
    { roleId, permissionKeys },
  );
}

export async function deleteRole(actorId: number, roleId: number) {
  if (isDesktopRuntime()) {
    const service = await import("@/lib/services/rbac");
    return service.deleteRole(actorId, roleId);
  }
  return requestWebApi<{ sukses: true }>("/api/roles", "DELETE", { roleId });
}
