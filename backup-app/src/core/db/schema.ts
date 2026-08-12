import { relations, sql } from "drizzle-orm";
import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { AUTH_ROLE_DEFAULT, AUTH_ROLES } from "@/core/auth/roles";

const syncMetadata = {
  version: integer("version").notNull().default(1),
  hlc: text("hlc"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(strftime('%s', 'now'))`),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(strftime('%s', 'now'))`),
  deletedAt: integer("deleted_at", { mode: "timestamp" }),
  syncStatus: text("sync_status", {
    enum: ["synced", "pending", "error"],
  })
    .notNull()
    .default("pending"),
};

const generateId = () => crypto.randomUUID();

export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey().$defaultFn(generateId),
    fullName: text("full_name").notNull(),
    email: text("email").notNull(),
    username: text("username"),
    role: text("role", { enum: AUTH_ROLES })
      .notNull()
      .default(AUTH_ROLE_DEFAULT),
    passwordHash: text("password_hash"),
    isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
    lastLoginAt: integer("last_login_at", { mode: "timestamp" }),
    provider: text("provider"),
    providerId: text("provider_id"),
    ...syncMetadata,
  },
  (table) => ({
    emailUnique: uniqueIndex("users_email_unique").on(table.email),
    usernameUnique: uniqueIndex("users_username_unique").on(table.username),
    syncQueueIndex: index("users_sync_queue_idx").on(
      table.syncStatus,
      table.updatedAt,
      table.id,
    ),
  }),
);

export const roles = sqliteTable(
  "roles",
  {
    id: text("id").primaryKey().$defaultFn(generateId),
    name: text("name").notNull().unique(),
    description: text("description"),
    ...syncMetadata,
  },
  (table) => ({
    syncQueueIndex: index("roles_sync_queue_idx").on(
      table.syncStatus,
      table.updatedAt,
      table.id,
    ),
  }),
);

export const permissions = sqliteTable(
  "permissions",
  {
    id: text("id").primaryKey().$defaultFn(generateId),
    name: text("name").notNull().unique(),
    resource: text("resource").notNull(),
    action: text("action").notNull(),
    ...syncMetadata,
  },
  (table) => ({
    syncQueueIndex: index("permissions_sync_queue_idx").on(
      table.syncStatus,
      table.updatedAt,
      table.id,
    ),
  }),
);

export const userRoles = sqliteTable(
  "user_roles",
  {
    id: text("id").primaryKey().$defaultFn(generateId),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    roleId: text("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "cascade" }),
    ...syncMetadata,
  },
  (table) => ({
    userRoleUnique: uniqueIndex("user_roles_user_role_unique").on(
      table.userId,
      table.roleId,
    ),
    syncQueueIndex: index("user_roles_sync_queue_idx").on(
      table.syncStatus,
      table.updatedAt,
      table.id,
    ),
  }),
);

export const rolePermissions = sqliteTable(
  "role_permissions",
  {
    id: text("id").primaryKey().$defaultFn(generateId),
    roleId: text("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "cascade" }),
    permissionId: text("permission_id")
      .notNull()
      .references(() => permissions.id, { onDelete: "cascade" }),
    ...syncMetadata,
  },
  (table) => ({
    rolePermissionUnique: uniqueIndex(
      "role_permissions_role_permission_unique",
    ).on(table.roleId, table.permissionId),
    syncQueueIndex: index("role_permissions_sync_queue_idx").on(
      table.syncStatus,
      table.updatedAt,
      table.id,
    ),
  }),
);

export const syncCursors = sqliteTable("sync_cursors", {
  tableName: text("table_name").primaryKey(),
  lastUpdatedAt: integer("last_updated_at").notNull().default(0),
  lastId: text("last_id").notNull().default(""),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(strftime('%s', 'now'))`),
});

export const syncRuns = sqliteTable("sync_runs", {
  id: text("id").primaryKey().$defaultFn(generateId),
  deviceId: text("device_id").notNull(),
  action: text("action", { enum: ["push", "pull", "full"] }).notNull(),
  status: text("status", {
    enum: ["running", "success", "error"],
  }).notNull(),
  uploaded: integer("uploaded").notNull().default(0),
  downloaded: integer("downloaded").notNull().default(0),
  conflicts: integer("conflicts").notNull().default(0),
  failed: integer("failed").notNull().default(0),
  error: text("error"),
  startedAt: integer("started_at", { mode: "timestamp" }).notNull(),
  finishedAt: integer("finished_at", { mode: "timestamp" }),
});

export const syncConflicts = sqliteTable("sync_conflicts", {
  id: text("id").primaryKey().$defaultFn(generateId),
  runId: text("run_id")
    .notNull()
    .references(() => syncRuns.id, { onDelete: "cascade" }),
  tableName: text("table_name").notNull(),
  recordId: text("record_id").notNull(),
  winner: text("winner", { enum: ["local", "remote"] }).notNull(),
  reason: text("reason").notNull(),
  localPayload: text("local_payload").notNull(),
  remotePayload: text("remote_payload").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});

export const usersRelations = relations(users, ({ many }) => ({
  userRoles: many(userRoles),
}));

export const rolesRelations = relations(roles, ({ many }) => ({
  userRoles: many(userRoles),
  rolePermissions: many(rolePermissions),
}));

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type RoleRecord = typeof roles.$inferSelect;
export type PermissionRecord = typeof permissions.$inferSelect;
