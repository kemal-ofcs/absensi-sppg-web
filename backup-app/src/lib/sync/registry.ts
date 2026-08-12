import { z } from "zod";
import { AUTH_ROLES } from "@/core/auth/roles";

const idSchema = z.string().trim().min(1).max(128);
const epochSchema = z.number().int().nonnegative();
const nullableEpochSchema = epochSchema.nullable();
const commonFields = {
  id: idSchema,
  version: z.number().int().positive(),
  hlc: z.string().trim().max(128).nullable(),
  created_at: epochSchema,
  updated_at: epochSchema,
  deleted_at: nullableEpochSchema,
};

const roleSchema = z
  .object({
    ...commonFields,
    name: z.enum(AUTH_ROLES),
    description: z.string().max(500).nullable(),
  })
  .strict();

const permissionSchema = z
  .object({
    ...commonFields,
    name: z.string().trim().min(1).max(128),
    resource: z.string().trim().min(1).max(128),
    action: z.string().trim().min(1).max(128),
  })
  .strict();

const userSchema = z
  .object({
    ...commonFields,
    full_name: z.string().trim().min(1).max(200),
    email: z.string().trim().email().max(254),
    username: z.string().trim().min(1).max(100).nullable(),
    role: z.enum(AUTH_ROLES),
    password_hash: z.string().max(512).nullable(),
    is_active: z.union([z.literal(0), z.literal(1)]),
    last_login_at: nullableEpochSchema,
    provider: z.string().max(100).nullable(),
    provider_id: z.string().max(255).nullable(),
  })
  .strict();

const userRoleSchema = z
  .object({
    ...commonFields,
    user_id: idSchema,
    role_id: idSchema,
  })
  .strict();

const rolePermissionSchema = z
  .object({
    ...commonFields,
    role_id: idSchema,
    permission_id: idSchema,
  })
  .strict();

export type SyncDatabaseRecord = z.infer<typeof roleSchema> &
  Record<string, unknown>;

export type SyncTableConfig = {
  name: string;
  columns: readonly string[];
  schema: z.ZodType<Record<string, unknown>>;
  sensitiveColumns: readonly string[];
};

export const SYNC_TABLES = [
  {
    name: "roles",
    columns: [
      "id",
      "name",
      "description",
      "version",
      "hlc",
      "created_at",
      "updated_at",
      "deleted_at",
    ],
    schema: roleSchema,
    sensitiveColumns: [],
  },
  {
    name: "permissions",
    columns: [
      "id",
      "name",
      "resource",
      "action",
      "version",
      "hlc",
      "created_at",
      "updated_at",
      "deleted_at",
    ],
    schema: permissionSchema,
    sensitiveColumns: [],
  },
  {
    name: "users",
    columns: [
      "id",
      "full_name",
      "email",
      "username",
      "role",
      "password_hash",
      "is_active",
      "last_login_at",
      "provider",
      "provider_id",
      "version",
      "hlc",
      "created_at",
      "updated_at",
      "deleted_at",
    ],
    schema: userSchema,
    sensitiveColumns: ["password_hash"],
  },
  {
    name: "user_roles",
    columns: [
      "id",
      "user_id",
      "role_id",
      "version",
      "hlc",
      "created_at",
      "updated_at",
      "deleted_at",
    ],
    schema: userRoleSchema,
    sensitiveColumns: [],
  },
  {
    name: "role_permissions",
    columns: [
      "id",
      "role_id",
      "permission_id",
      "version",
      "hlc",
      "created_at",
      "updated_at",
      "deleted_at",
    ],
    schema: rolePermissionSchema,
    sensitiveColumns: [],
  },
] as const satisfies readonly SyncTableConfig[];

export function normalizeSyncRow(row: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key,
      typeof value === "bigint" ? Number(value) : value,
    ]),
  );
}

export function parseSyncRecord(
  table: SyncTableConfig,
  row: Record<string, unknown>,
) {
  return table.schema.parse(normalizeSyncRow(row));
}

export function redactSyncRecord(
  table: SyncTableConfig,
  row: Record<string, unknown>,
) {
  const copy = { ...row };
  for (const column of table.sensitiveColumns) {
    if (column in copy) copy[column] = "[REDACTED]";
  }
  return copy;
}
