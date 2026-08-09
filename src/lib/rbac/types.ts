import type { PermissionKey } from "@/lib/rbac/catalog";

export interface RoleRecord {
  id: number;
  roleKey: string;
  name: string;
  description: string;
  isSystem: boolean;
  isSuperadmin: boolean;
  status: "Aktif" | "Nonaktif";
  operatorCount: number;
  permissions: PermissionKey[];
}

export interface RoleDraft {
  name: string;
  description?: string;
  status?: "Aktif" | "Nonaktif";
}
