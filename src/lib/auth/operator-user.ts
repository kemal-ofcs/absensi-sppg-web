import type { PermissionKey } from "@/lib/rbac/catalog";

export interface OperatorUser {
  id: number;
  kode_operator: string;
  nama_operator: string;
  username: string;
  role: string;
  roleId: number;
  roleKey: string;
  isSuperadmin: boolean;
  permissions: PermissionKey[];
  permissionRevision: number;
  loginAt?: string;
}
