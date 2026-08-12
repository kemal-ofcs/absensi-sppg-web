import { AUTH_ROLES } from "@/core/auth/roles";
import { getDefaultAdminHash } from "@/lib/auth/hash";

export interface DatabaseLike {
  select<T>(sql: string, params?: unknown[]): Promise<T[]>;
  execute(
    sql: string,
    params?: unknown[],
  ): Promise<{
    rowsAffected?: number;
    lastInsertId?: number | string;
    changes?: number;
    rows?: unknown[];
  }>;
}

export interface MigrationOptions {
  seedData?: boolean;
  forceResetAdmin?: boolean;
}

const DEFAULT_ADMIN_ID = "starter-user-admin";
const DEFAULT_ADMIN_EMAIL = "admin@starter.local";

async function createIdentityTables(db: DatabaseLike) {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY NOT NULL,
      full_name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      username TEXT UNIQUE,
      role TEXT NOT NULL DEFAULT 'staff',
      password_hash TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      last_login_at INTEGER,
      provider TEXT,
      provider_id TEXT,
      version INTEGER NOT NULL DEFAULT 1,
      hlc TEXT,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
      deleted_at INTEGER,
      sync_status TEXT NOT NULL DEFAULT 'pending'
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS roles (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL UNIQUE,
      description TEXT,
      version INTEGER NOT NULL DEFAULT 1,
      hlc TEXT,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
      deleted_at INTEGER,
      sync_status TEXT NOT NULL DEFAULT 'pending'
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS permissions (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL UNIQUE,
      resource TEXT NOT NULL,
      action TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      hlc TEXT,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
      deleted_at INTEGER,
      sync_status TEXT NOT NULL DEFAULT 'pending'
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS user_roles (
      id TEXT PRIMARY KEY NOT NULL,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
      version INTEGER NOT NULL DEFAULT 1,
      hlc TEXT,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
      deleted_at INTEGER,
      sync_status TEXT NOT NULL DEFAULT 'pending',
      UNIQUE(user_id, role_id)
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS role_permissions (
      id TEXT PRIMARY KEY NOT NULL,
      role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
      permission_id TEXT NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
      version INTEGER NOT NULL DEFAULT 1,
      hlc TEXT,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
      deleted_at INTEGER,
      sync_status TEXT NOT NULL DEFAULT 'pending',
      UNIQUE(role_id, permission_id)
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS auth_rate_limits (
      scope TEXT NOT NULL,
      key TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      first_attempt_at INTEGER NOT NULL,
      blocked_until INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (scope, key)
    )
  `);

  for (const table of [
    "users",
    "roles",
    "permissions",
    "user_roles",
    "role_permissions",
  ]) {
    await db.execute(`
      CREATE INDEX IF NOT EXISTS ${table}_sync_queue_idx
      ON ${table}(sync_status, updated_at, id)
    `);
  }

  await db.execute(`
    CREATE TABLE IF NOT EXISTS sync_cursors (
      table_name TEXT PRIMARY KEY NOT NULL,
      last_updated_at INTEGER NOT NULL DEFAULT 0,
      last_id TEXT NOT NULL DEFAULT '',
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS sync_runs (
      id TEXT PRIMARY KEY NOT NULL,
      device_id TEXT NOT NULL,
      action TEXT NOT NULL,
      status TEXT NOT NULL,
      uploaded INTEGER NOT NULL DEFAULT 0,
      downloaded INTEGER NOT NULL DEFAULT 0,
      conflicts INTEGER NOT NULL DEFAULT 0,
      failed INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      started_at INTEGER NOT NULL,
      finished_at INTEGER
    )
  `);

  await db.execute(`
    CREATE INDEX IF NOT EXISTS sync_runs_started_at_idx
    ON sync_runs(started_at DESC)
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS sync_conflicts (
      id TEXT PRIMARY KEY NOT NULL,
      run_id TEXT NOT NULL REFERENCES sync_runs(id) ON DELETE CASCADE,
      table_name TEXT NOT NULL,
      record_id TEXT NOT NULL,
      winner TEXT NOT NULL,
      reason TEXT NOT NULL,
      local_payload TEXT NOT NULL,
      remote_payload TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);

  await db.execute(`
    CREATE INDEX IF NOT EXISTS sync_conflicts_record_idx
    ON sync_conflicts(table_name, record_id, created_at DESC)
  `);
}

async function seedRoles(db: DatabaseLike) {
  const now = Math.floor(Date.now() / 1000);
  for (const role of AUTH_ROLES) {
    await db.execute(
      `INSERT INTO roles (id, name, description, created_at, updated_at, sync_status)
       VALUES (?, ?, ?, ?, ?, 'pending')
       ON CONFLICT(name) DO NOTHING`,
      [`starter-role-${role}`, role, `Built-in ${role} role`, now, now],
    );
  }
}

async function seedAdmin(db: DatabaseLike, forceResetAdmin: boolean) {
  const rows = await db.select<{ id: string }>(
    "SELECT id FROM users WHERE email = ? LIMIT 1",
    [DEFAULT_ADMIN_EMAIL],
  );
  if (rows.length > 0 && !forceResetAdmin) {
    return;
  }

  const passwordHash = await getDefaultAdminHash();
  const now = Math.floor(Date.now() / 1000);
  await db.execute(
    `INSERT INTO users (
       id, full_name, email, username, role, password_hash, is_active,
       version, created_at, updated_at, sync_status
     ) VALUES (?, ?, ?, ?, 'super_admin', ?, 1, 1, ?, ?, 'pending')
     ON CONFLICT(email) DO UPDATE SET
       password_hash = excluded.password_hash,
       is_active = 1,
       deleted_at = NULL,
       updated_at = excluded.updated_at,
       sync_status = 'pending'`,
    [
      DEFAULT_ADMIN_ID,
      "Starter Administrator",
      DEFAULT_ADMIN_EMAIL,
      "admin",
      passwordHash,
      now,
      now,
    ],
  );

  await db.execute(
    `INSERT INTO user_roles (
       id, user_id, role_id, version, created_at, updated_at, sync_status
     ) VALUES (?, ?, ?, 1, ?, ?, 'pending')
     ON CONFLICT(user_id, role_id) DO NOTHING`,
    [
      "starter-user-role-admin",
      DEFAULT_ADMIN_ID,
      "starter-role-super_admin",
      now,
      now,
    ],
  );
}

export async function runMigrations(
  db: DatabaseLike,
  options: MigrationOptions = {},
) {
  await createIdentityTables(db);

  if (options.seedData ?? true) {
    await seedRoles(db);
    await seedAdmin(db, options.forceResetAdmin ?? false);
  }
}
