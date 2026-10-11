"use client";

import { requestWebApi } from "@/lib/client/api-client";
import type { OperatorDraft, OperatorRecord } from "@/lib/operators/types";
import type { PermissionKey } from "@/lib/rbac/catalog";
import type { RoleDraft, RoleRecord } from "@/lib/rbac/types";
import { isDesktopRuntime } from "@/lib/runtime/app-runtime";
import { invokeDesktop } from "@/lib/runtime/desktop-commands";

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function arrayPayload(value: unknown, key: string): JsonRecord[] {
  if (Array.isArray(value)) return value.map(record);
  const nested = record(value)[key];
  return Array.isArray(nested) ? nested.map(record) : [];
}

function roleKey(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function normalizeOperator(value: JsonRecord): OperatorRecord {
  return {
    id: Number(value.id ?? 0),
    kodeOperator: String(value.kodeOperator ?? value.kode_operator ?? ""),
    name: String(value.name ?? value.nama_operator ?? ""),
    username: String(value.username ?? ""),
    email: String(value.email ?? ""),
    noHp: String(value.noHp ?? value.no_hp ?? ""),
    totpEnabled:
      value.totpEnabled === true || Number(value.totp_enabled ?? 0) === 1,
    roleId: Number(value.roleId ?? value.role_id ?? 0),
    roleKey: String(value.roleKey ?? value.role_key ?? "operator"),
    roleName: String(
      value.roleName ?? value.nama_role ?? value.role ?? "Operator",
    ),
    isSuperadmin: Boolean(
      value.isSuperadmin ?? Number(value.is_superadmin ?? 0) === 1,
    ),
    status: value.status === "Nonaktif" ? "Nonaktif" : "Aktif",
  };
}

function normalizeRole(value: JsonRecord): RoleRecord {
  const permissions = Array.isArray(value.permissions)
    ? value.permissions.filter(
        (item): item is PermissionKey => typeof item === "string",
      )
    : [];
  return {
    id: Number(value.id ?? 0),
    roleKey: String(value.roleKey ?? value.role_key ?? ""),
    name: String(value.name ?? value.nama_role ?? ""),
    description: String(value.description ?? value.deskripsi ?? ""),
    isSystem: Boolean(value.isSystem ?? Number(value.is_system ?? 0) === 1),
    isSuperadmin: Boolean(
      value.isSuperadmin ?? Number(value.is_superadmin ?? 0) === 1,
    ),
    status: value.status === "Nonaktif" ? "Nonaktif" : "Aktif",
    requireTotp:
      value.requireTotp === true || Number(value.require_totp ?? 0) === 1,
    requireScanPhoto:
      value.requireScanPhoto === true ||
      Number(value.require_scan_photo ?? 0) === 1,
    requireScanIpAllowlist:
      value.requireScanIpAllowlist === true ||
      Number(value.require_scan_ip_allowlist ?? 0) === 1,
    operatorCount: Number(value.operatorCount ?? value.operator_count ?? 0),
    permissions,
  };
}

export async function getMasterOperators(actorId: number) {
  if (isDesktopRuntime()) {
    void actorId;
    const payload = await invokeDesktop<unknown>(
      "desktop_get_master_operators",
    );
    return arrayPayload(payload, "operators").map(normalizeOperator);
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
    const response = await invokeDesktop<JsonRecord>(
      "desktop_create_operator",
      {
        draft: {
          kode_operator: draft.kodeOperator,
          nama_operator: draft.name,
          username: draft.username,
          email: draft.email,
          no_hp: draft.noHp,
          password: draft.password,
          role_id: draft.roleId,
          status: draft.status,
        },
      },
    );
    return {
      sukses: true as const,
      id: Number(response.id ?? record(response.operator).id ?? 0),
    };
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
      draft: {
        nama_operator: draft.name,
        email: draft.email,
        no_hp: draft.noHp,
        password: draft.password,
        role_id: draft.roleId,
        status: draft.status,
      },
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
    const payload = await invokeDesktop<unknown>("desktop_get_roles");
    return arrayPayload(payload, "roles").map(normalizeRole);
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
    const response = await invokeDesktop<JsonRecord>("desktop_create_role", {
      draft: {
        role_key: roleKey(draft.name),
        nama_role: draft.name,
        deskripsi: draft.description,
        status: draft.status,
      },
      permissionKeys: [...permissionKeys],
    });
    return {
      sukses: true as const,
      id: Number(response.id ?? response.role_id ?? 0),
    };
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
  options?: { isSuperadmin?: boolean },
) {
  if (isDesktopRuntime()) {
    void actorId;
    // Role Superadmin hanya menerima dua kewajiban operasional; mengirim nama
    // atau status untuknya akan ditolak backend.
    const draftPayload = options?.isSuperadmin
      ? {
          require_scan_photo: draft.requireScanPhoto === true,
          require_scan_ip_allowlist: draft.requireScanIpAllowlist === true,
        }
      : {
          nama_role: draft.name,
          deskripsi: draft.description,
          status: draft.status,
          require_totp: draft.requireTotp === true,
          require_scan_photo: draft.requireScanPhoto === true,
          require_scan_ip_allowlist: draft.requireScanIpAllowlist === true,
        };
    return invokeDesktop<{ sukses: true }>("desktop_update_role", {
      roleId,
      draft: draftPayload,
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
