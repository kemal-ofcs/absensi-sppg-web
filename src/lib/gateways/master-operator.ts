"use client";

import { requestWebApi } from "@/lib/client/api-client";
import type { OperatorDraft, OperatorRecord } from "@/lib/operators/types";
import type { PermissionKey } from "@/lib/rbac/catalog";
import type { RoleDraft, RoleRecord } from "@/lib/rbac/types";
import { isDesktopRuntime } from "@/lib/runtime/app-runtime";
import { invokeDesktop } from "@/lib/runtime/desktop-commands";

export async function getMasterOperators(actorId: number) {
  if (isDesktopRuntime()) {
    void actorId;
    return invokeDesktop<OperatorRecord[]>("desktop_get_master_operators");
  }
  const response = await requestWebApi<{ operators: OperatorRecord[] }>(
    "/api/operators/query",
    "POST",
  );
  return response.operators;
}

export async function createOperator(actorId: number, draft: OperatorDraft) {
  if (isDesktopRuntime()) {
    void actorId;
    return invokeDesktop<{ sukses: true; id: number }>(
      "desktop_create_operator",
      { draft },
    );
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
    void actorId;
    return invokeDesktop<{ sukses: true }>("desktop_update_operator", {
      operatorId,
      draft,
    });
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
    void actorId;
    return invokeDesktop<{ sukses: true }>("desktop_delete_operator", {
      operatorId,
    });
  }
  return requestWebApi<{ sukses: true }>("/api/operators", "DELETE", {
    operatorId,
  });
}

export async function getRoleRecords(actorId: number) {
  if (isDesktopRuntime()) {
    void actorId;
    return invokeDesktop<RoleRecord[]>("desktop_get_roles");
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
    void actorId;
    return invokeDesktop<{ sukses: true; id: number }>("desktop_create_role", {
      draft,
      permissionKeys: [...permissionKeys],
    });
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
    void actorId;
    return invokeDesktop<{ sukses: true }>("desktop_update_role", {
      roleId,
      draft,
    });
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
    void actorId;
    return invokeDesktop<{ sukses: true; revision: number }>(
      "desktop_set_role_permissions",
      { roleId, permissionKeys: [...permissionKeys] },
    );
  }
  return requestWebApi<{ sukses: true; revision: number }>(
    "/api/roles",
    "PUT",
    { roleId, permissionKeys },
  );
}

export async function deleteRole(actorId: number, roleId: number) {
  if (isDesktopRuntime()) {
    void actorId;
    return invokeDesktop<{ sukses: true }>("desktop_delete_role", { roleId });
  }
  return requestWebApi<{ sukses: true }>("/api/roles", "DELETE", { roleId });
}
