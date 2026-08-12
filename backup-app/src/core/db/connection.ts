import type { InValue } from "@libsql/client";
import type Database from "@tauri-apps/plugin-sql";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import { isTauri } from "../env";
import {
  type DatabaseLike,
  type MigrationOptions,
  runMigrations,
} from "./migrations";
import * as schema from "./schema";

/**
 * Hybrid database connection for the reusable starter.
 * Hybrid Desktop (SQLite) + Web (Turso/libSQL) abstraction
 */

export interface DatabaseConnection {
  select<T>(sql: string, params?: unknown[]): Promise<T[]>;
  execute(
    sql: string,
    params?: unknown[],
  ): Promise<{ rowsAffected: number; insertId: number | string }>;
}

type DrizzleDatabase = ReturnType<typeof drizzle<typeof schema>>;

type GlobalDatabaseCache = {
  db: DrizzleDatabase | null;
  sqliteRemote: Database | null;
  initializing: Promise<DrizzleDatabase> | null;
  webMigrations: Promise<void> | null;
  tauriMigrations: Promise<void> | null;
};

declare global {
  var __hybridStarterDbCache__: GlobalDatabaseCache | undefined;
}

if (!globalThis.__hybridStarterDbCache__) {
  globalThis.__hybridStarterDbCache__ = {
    db: null,
    sqliteRemote: null,
    initializing: null,
    webMigrations: null,
    tauriMigrations: null,
  };
}

const globalCache = globalThis.__hybridStarterDbCache__;

let _db = globalCache.db;
let _sqliteRemote = globalCache.sqliteRemote;
let _initializing = globalCache.initializing;

export interface DatabaseInitOptions extends MigrationOptions {}

function shouldUseSharedDbCache(options?: DatabaseInitOptions): boolean {
  return (
    (options?.seedData ?? true) === true &&
    options?.forceResetAdmin === undefined
  );
}

function normalizeLibsqlUrl(url: string): string {
  return url.startsWith("libsql://")
    ? url.replace("libsql://", "https://")
    : url;
}

const LIBSQL_SCHEMES = ["libsql:", "https:", "http:", "ws:", "wss:", "file:"];

function isSupportedLibsqlUrl(url: string): boolean {
  try {
    const parsed = new URL(normalizeLibsqlUrl(url));
    return LIBSQL_SCHEMES.includes(parsed.protocol);
  } catch {
    return false;
  }
}

function resolveServerDatabaseConfig() {
  const candidates = [
    process.env.AUTH_DATABASE_URL,
    process.env.TURSO_DATABASE_URL,
    process.env.DATABASE_URL,
  ].filter((value): value is string => Boolean(value));
  const url = candidates.find((value) => isSupportedLibsqlUrl(value));
  if (!url) {
    throw new Error(
      "Database URL is not configured for libSQL server runtime. Set AUTH_DATABASE_URL or TURSO_DATABASE_URL to a libsql/https URL. Ignore or remove Vercel Postgres DATABASE_URL for this app.",
    );
  }

  return {
    url: normalizeLibsqlUrl(url),
    authToken:
      process.env.AUTH_DATABASE_AUTH_TOKEN ||
      process.env.TURSO_AUTH_TOKEN ||
      process.env.TURSO_DATABASE_AUTH_TOKEN ||
      process.env.TURSO_DATABASE_TURSO_AUTH_TOKEN,
  };
}

function syncGlobalCache() {
  globalCache.db = _db;
  globalCache.sqliteRemote = _sqliteRemote;
  globalCache.initializing = _initializing;
}

function isTruthyEnv(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function isNextBuildPhase(): boolean {
  return (
    process.env.NEXT_PHASE === "phase-production-build" ||
    process.env.npm_lifecycle_event === "build"
  );
}

function shouldRunServerMigrations(options?: DatabaseInitOptions): boolean {
  if (options?.seedData === false) {
    return true;
  }

  if (isTruthyEnv(process.env.HYBRID_STARTER_FORCE_SERVER_MIGRATIONS)) {
    return true;
  }

  return !isNextBuildPhase();
}

function shouldLogDatabaseDebug(): boolean {
  return isTruthyEnv(process.env.HYBRID_STARTER_DB_DEBUG);
}

function logDatabaseDebug(message: string, ...args: unknown[]) {
  if (shouldLogDatabaseDebug()) {
    console.info(message, ...args);
  }
}

function collectDatabaseErrorMessages(
  error: unknown,
  visited = new Set<unknown>(),
): string[] {
  if (!error || visited.has(error)) {
    return [];
  }

  visited.add(error);

  if (typeof error === "string") {
    return [error];
  }

  if (error instanceof Error) {
    return [
      error.message,
      ...collectDatabaseErrorMessages(
        (error as Error & { cause?: unknown }).cause,
        visited,
      ),
    ];
  }

  if (typeof error === "object") {
    const record = error as Record<string, unknown>;
    return [
      typeof record.message === "string" ? record.message : "",
      ...collectDatabaseErrorMessages(record.cause, visited),
      ...collectDatabaseErrorMessages(record.proto, visited),
    ].filter(Boolean);
  }

  return [];
}

function isExpectedMissingLegacyScheduleTableError(error: unknown) {
  return collectDatabaseErrorMessages(error).some((message) => {
    const normalized = message.toLowerCase();
    return (
      normalized.includes("no such table") && normalized.includes("schedule")
    );
  });
}

function isExpectedWebMigrationConnectivityError(error: unknown) {
  return collectDatabaseErrorMessages(error).some((message) => {
    const normalized = message.toLowerCase();
    return (
      normalized.includes("failed to fetch") ||
      normalized.includes("err_internet_disconnected") ||
      normalized.includes("enotfound") ||
      normalized.includes("getaddrinfo") ||
      normalized.includes("econnrefused") ||
      normalized.includes("network request failed")
    );
  });
}

function isSqliteLockedError(error: unknown) {
  return collectDatabaseErrorMessages(error).some((message) => {
    const normalized = message.toLowerCase();
    return (
      normalized.includes("database is locked") ||
      normalized.includes("database table is locked") ||
      normalized.includes("(code: 5)")
    );
  });
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withSqliteBusyRetry<T>(
  operation: () => Promise<T>,
  maxAttempts = 4,
  baseDelayMs = 120,
) {
  let attempt = 0;

  while (true) {
    try {
      return await operation();
    } catch (error) {
      attempt += 1;
      if (!isSqliteLockedError(error) || attempt >= maxAttempts) {
        throw error;
      }

      await sleep(baseDelayMs * attempt);
    }
  }
}

function isTransactionControlStatement(sql: string) {
  const normalized = sql.trim().toUpperCase();
  return (
    normalized === "BEGIN" ||
    normalized.startsWith("BEGIN ") ||
    normalized === "COMMIT" ||
    normalized === "ROLLBACK" ||
    normalized.startsWith("SAVEPOINT ") ||
    normalized.startsWith("RELEASE ") ||
    normalized.startsWith("ROLLBACK TO ")
  );
}

async function ensureWebMigrations(
  dbLike: DatabaseLike,
  options?: DatabaseInitOptions,
) {
  if (!globalCache.webMigrations) {
    globalCache.webMigrations = runMigrations(dbLike, options).catch(
      (error) => {
        globalCache.webMigrations = null;
        throw error;
      },
    );
  }

  await globalCache.webMigrations;
}

async function ensureTauriMigrations(
  dbLike: DatabaseLike,
  options?: DatabaseInitOptions,
) {
  if (!globalCache.tauriMigrations) {
    globalCache.tauriMigrations = runMigrations(dbLike, options).catch(
      (error) => {
        globalCache.tauriMigrations = null;
        throw error;
      },
    );
  }

  await globalCache.tauriMigrations;
}

/**
 * Initialize and get the database instance
 */
export const getDatabase = async (options?: DatabaseInitOptions) => {
  const useSharedCache = shouldUseSharedDbCache(options);

  if (useSharedCache && _db) return _db;
  if (useSharedCache && _initializing) return _initializing;

  const initialize = (async () => {
    if (isTauri()) {
      // Desktop: Native SQLite via Tauri Plugin SQL
      const { default: Database } = await import("@tauri-apps/plugin-sql");
      _sqliteRemote = await Database.load("sqlite:hybrid-starter.db");
      syncGlobalCache();

      // Set encryption key for SQLCipher (if provided)
      const key = process.env.TAURI_DB_KEY;
      if (key) {
        // Escape single quotes in key to prevent SQL injection
        const safeKey = key.replace(/'/g, "''");
        await _sqliteRemote.execute(`PRAGMA key = '${safeKey}';`);
      } else {
        console.warn(
          "⚠️ [DB] TAURI_DB_KEY not set. Using unencrypted database for development.",
        );
      }

      // Hardening & integrity defaults
      await _sqliteRemote.execute("PRAGMA foreign_keys = ON");
      await _sqliteRemote.execute("PRAGMA journal_mode = WAL");
      await _sqliteRemote.execute("PRAGMA busy_timeout = 5000");

      // Ensure schema exists before any query execution
      logDatabaseDebug("⚡ [DB] Starting migrations...");
      await ensureTauriMigrations(_sqliteRemote, options);
      logDatabaseDebug("✅ [DB] Migrations completed successfully.");

      const drizzleDb = drizzle(
        async (sql, params, method) => {
          try {
            if (!_sqliteRemote) throw new Error("DB not loaded");
            const sqliteRemote = _sqliteRemote;

            if (method === "run") {
              const executeRun = () =>
                sqliteRemote.execute(sql, params as unknown[]);
              const result = isTransactionControlStatement(sql)
                ? await executeRun()
                : await withSqliteBusyRetry(executeRun);
              const raw = result as {
                changes?: number;
                rowsAffected?: number;
                lastInsertRowid?: number | string;
                lastInsertId?: number | string;
              };
              return {
                rows: [],
                rowsAffected: raw.changes ?? raw.rowsAffected ?? 0,
                insertId: raw.lastInsertRowid ?? raw.lastInsertId ?? 0,
              };
            }

            const rows = await withSqliteBusyRetry(() =>
              sqliteRemote.select<Record<string, unknown>[]>(
                sql,
                params as unknown[],
              ),
            );

            // ALWAYS return array of arrays (values) for Drizzle proxy
            return { rows: rows.map((row) => Object.values(row)) };
          } catch (e) {
            if (!isExpectedMissingLegacyScheduleTableError(e)) {
              console.error("❌ [SQL_ERROR_TAURI]", e);
            }
            throw e;
          }
        },
        { schema },
      );

      if (useSharedCache) {
        _db = drizzleDb;
        syncGlobalCache();
      }

      return drizzleDb;
    } else {
      // Web/Server non-Tauri: libSQL over HTTP(S)
      try {
        const isServerRuntime = typeof window === "undefined";
        if (!isServerRuntime) {
          throw new Error(
            "Browser runtime cannot access the cloud database directly. Use a server route handler.",
          );
        }

        const dbConfig = resolveServerDatabaseConfig();

        logDatabaseDebug(
          `🌐 [DB] Connecting to libSQL at: ${dbConfig.url} (runtime: ${
            isServerRuntime ? "server" : "browser"
          }, token: ${dbConfig.authToken ? "present" : "missing"})`,
        );

        const client = isServerRuntime
          ? (await import("@libsql/client")).createClient({
              url: dbConfig.url,
              authToken: dbConfig.authToken,
            })
          : (await import("@libsql/client/web")).createClient({
              url: dbConfig.url,
              authToken: dbConfig.authToken,
            });

        logDatabaseDebug("🌐 [DB] libSQL client created");

        const drizzleDb = drizzle(
          async (sql, params, method) => {
            try {
              if (method === "run") {
                const result = await client.execute({
                  sql,
                  args: params as InValue[],
                });
                return {
                  rows: [],
                  rowsAffected: result.rowsAffected,
                  insertId: result.lastInsertRowid?.toString() ?? 0,
                };
              }

              const result = await client.execute({
                sql,
                args: params as InValue[],
              });
              return {
                rows: result.rows.map((row) =>
                  Object.values(row as Record<string, unknown>),
                ),
              };
            } catch (e) {
              console.error("❌ [SQL_ERROR_WEB]", e);
              throw e;
            }
          },
          { schema },
        );

        if (useSharedCache) {
          _db = drizzleDb;
          syncGlobalCache();
        }

        const dbLike: DatabaseLike = {
          execute: async (sql, params) => {
            const res = await client.execute({
              sql,
              args: (params || []) as InValue[],
            });
            return {
              rowsAffected: res.rowsAffected,
              lastInsertId: res.lastInsertRowid?.toString() || 0,
              rows: res.rows as unknown[],
            };
          },
          select: async <T>(sql: string, params?: unknown[]): Promise<T[]> => {
            const res = await client.execute({
              sql,
              args: (params || []) as InValue[],
            });
            return res.rows as T[];
          },
        };

        if (isServerRuntime && shouldRunServerMigrations(options)) {
          try {
            await ensureWebMigrations(dbLike, options);
          } catch (migrationError) {
            if (isExpectedWebMigrationConnectivityError(migrationError)) {
              console.warn(
                "⚠️ [DB_MIGRATION_WEB_SKIPPED] Web migration skipped because cloud database is unreachable in current runtime.",
                migrationError,
              );
            } else {
              console.error(
                "❌ [DB_MIGRATION_WEB_ERROR] Could not run migrations on web.",
                migrationError,
              );
            }
          }
        } else if (isServerRuntime && shouldLogDatabaseDebug()) {
          console.info(
            "ℹ️ [DB] Skipping server migrations during build/read-only runtime.",
          );
        }

        return drizzleDb;
      } catch (e) {
        console.error("❌ [DB_INIT_WEB_ERROR]", e);
        // Fallback or error
        throw e;
      }
    }
  })();

  if (useSharedCache) {
    _initializing = initialize;
    syncGlobalCache();
  }

  try {
    const db = await initialize;

    if (!db) {
      throw new Error("Failed to initialize database connection");
    }

    return db;
  } finally {
    if (useSharedCache) {
      _initializing = null;
      syncGlobalCache();
    }
  }
};

/**
 * Compatibility export for older getDb calls
 */
export const getDb = getDatabase;
