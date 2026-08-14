import { randomUUID } from "node:crypto";
import { type Client, createClient, type InValue } from "@libsql/client";
import { type DatabaseLike, runMigrations } from "@/core/db/migrations";
import { compareSyncOrder, type SyncOrder } from "@/lib/sync/order";
import {
  parseSyncRecord,
  redactSyncRecord,
  SYNC_TABLES,
  type SyncTableConfig,
} from "@/lib/sync/registry";
import type {
  SyncAction,
  SyncResult,
  SyncRunSummary,
  SyncStatusResult,
  SyncTableRunSummary,
} from "@/lib/sync/types";

const BATCH_SIZE = 100;
const MAX_PULL_BATCHES = 50;

type SyncCounts = {
  uploaded: number;
  downloaded: number;
  conflicts: number;
  failed: number;
  tables: Map<string, SyncTableRunSummary>;
};

type SyncCountKey = "uploaded" | "downloaded" | "conflicts" | "failed";

function createSyncCounts(): SyncCounts {
  return {
    uploaded: 0,
    downloaded: 0,
    conflicts: 0,
    failed: 0,
    tables: new Map(
      SYNC_TABLES.map((table) => [
        table.name,
        {
          table: table.name,
          uploaded: 0,
          downloaded: 0,
          conflicts: 0,
          failed: 0,
        },
      ]),
    ),
  };
}

function incrementCount(counts: SyncCounts, table: string, key: SyncCountKey) {
  counts[key] += 1;
  const tableCounts = counts.tables.get(table);
  if (tableCounts) tableCounts[key] += 1;
}

function resultCounts(counts: SyncCounts) {
  return {
    uploaded: counts.uploaded,
    downloaded: counts.downloaded,
    conflicts: counts.conflicts,
    failed: counts.failed,
    tables: [...counts.tables.values()],
  };
}

type SyncClients = {
  local: Client;
  cloud: Client;
};

type SyncEngineCache = {
  clientsPromise: Promise<SyncClients> | null;
  activeRun: Promise<SyncResult> | null;
};

declare global {
  var __hybridStarterSyncEngine__: SyncEngineCache | undefined;
}

if (!globalThis.__hybridStarterSyncEngine__) {
  globalThis.__hybridStarterSyncEngine__ = {
    clientsPromise: null,
    activeRun: null,
  };
}

const cache = globalThis.__hybridStarterSyncEngine__;

export class SyncEngineError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "SyncEngineError";
  }
}

function isEmbeddedDesktopRuntime() {
  return (
    process.env.HYBRID_STARTER_DESKTOP_RUNTIME === "embedded-local-web-server"
  );
}

function resolveLocalUrl() {
  const url = process.env.AUTH_DATABASE_URL?.trim() ?? "";
  if (!isEmbeddedDesktopRuntime() || !url.startsWith("file:")) {
    throw new SyncEngineError(
      "SYNC_LOCAL_DB_UNAVAILABLE",
      "Sync hanya tersedia melalui embedded desktop runtime dengan SQLite lokal.",
    );
  }
  return url;
}

function resolveCloudConfig() {
  const url = process.env.SYNC_DATABASE_URL?.trim() ?? "";
  const authToken = process.env.SYNC_DATABASE_AUTH_TOKEN?.trim() ?? "";
  const testFileCloud =
    process.env.NODE_ENV === "test" && url.startsWith("file:");
  if (!url || !authToken || (url.startsWith("file:") && !testFileCloud)) {
    throw new SyncEngineError(
      "SYNC_NOT_CONFIGURED",
      "Turso belum dikonfigurasi. Simpan URL dan database token dari desktop settings, lalu restart aplikasi.",
    );
  }
  if (
    !testFileCloud &&
    !url.startsWith("libsql://") &&
    !url.startsWith("https://")
  ) {
    throw new SyncEngineError(
      "SYNC_INVALID_URL",
      "SYNC_DATABASE_URL harus memakai libsql:// atau https://.",
    );
  }
  return { url, authToken };
}

function asDatabaseLike(client: Client): DatabaseLike {
  return {
    async execute(sql, params) {
      const result = await client.execute({
        sql,
        args: (params ?? []) as InValue[],
      });
      return {
        rowsAffected: result.rowsAffected,
        lastInsertId: result.lastInsertRowid?.toString() ?? 0,
        rows: result.rows as unknown[],
      };
    },
    async select<T>(sql: string, params?: unknown[]) {
      const result = await client.execute({
        sql,
        args: (params ?? []) as InValue[],
      });
      return result.rows as T[];
    },
  };
}

async function createSyncClients() {
  const local = createClient({ url: resolveLocalUrl() });
  const cloudConfig = resolveCloudConfig();
  const cloud = createClient(cloudConfig);

  await Promise.all([
    runMigrations(asDatabaseLike(local), { seedData: false }),
    runMigrations(asDatabaseLike(cloud), { seedData: false }),
  ]);

  return { local, cloud };
}

async function getSyncClients() {
  if (!cache.clientsPromise) {
    cache.clientsPromise = createSyncClients().catch((error) => {
      cache.clientsPromise = null;
      throw error;
    });
  }
  return cache.clientsPromise;
}

function quotedColumns(columns: readonly string[]) {
  return columns.map((column) => `"${column}"`).join(", ");
}

function recordArgs(
  columns: readonly string[],
  record: Record<string, unknown>,
) {
  return columns.map((column) => record[column] as InValue);
}

function cloudUpsertSql(table: SyncTableConfig) {
  const columns = table.columns;
  const updates = columns
    .filter((column) => column !== "id" && column !== "created_at")
    .map((column) => `"${column}" = excluded."${column}"`)
    .join(", ");

  return `INSERT INTO "${table.name}" (${quotedColumns(columns)})
          VALUES (${columns.map(() => "?").join(", ")})
          ON CONFLICT("id") DO UPDATE SET ${updates}
          WHERE excluded.version > "${table.name}".version
             OR (excluded.version = "${table.name}".version
                 AND COALESCE(excluded.hlc, '') > COALESCE("${table.name}".hlc, ''))
             OR (excluded.version = "${table.name}".version
                 AND COALESCE(excluded.hlc, '') = COALESCE("${table.name}".hlc, '')
                 AND excluded.updated_at >= "${table.name}".updated_at)`;
}

function localUpsertSql(table: SyncTableConfig) {
  const columns = [...table.columns, "sync_status"];
  const updates = columns
    .filter((column) => column !== "id" && column !== "created_at")
    .map((column) => `"${column}" = excluded."${column}"`)
    .join(", ");
  return `INSERT INTO "${table.name}" (${quotedColumns(columns)})
          VALUES (${columns.map(() => "?").join(", ")})
          ON CONFLICT("id") DO UPDATE SET ${updates}`;
}

function toOrder(record: Record<string, unknown>): SyncOrder {
  return {
    id: String(record.id),
    version: Number(record.version),
    hlc: typeof record.hlc === "string" ? record.hlc : null,
    updated_at: Number(record.updated_at),
  };
}

async function selectRecord(
  client: Client,
  table: SyncTableConfig,
  id: string,
) {
  const result = await client.execute({
    sql: `SELECT ${quotedColumns(table.columns)} FROM "${table.name}" WHERE id = ? LIMIT 1`,
    args: [id],
  });
  const row = result.rows[0] as Record<string, unknown> | undefined;
  return row ? parseSyncRecord(table, row) : null;
}

async function selectLocalRecord(
  client: Client,
  table: SyncTableConfig,
  id: string,
) {
  const result = await client.execute({
    sql: `SELECT ${quotedColumns(table.columns)}, sync_status FROM "${table.name}" WHERE id = ? LIMIT 1`,
    args: [id],
  });
  const raw = result.rows[0] as Record<string, unknown> | undefined;
  if (!raw) return null;
  const { sync_status: syncStatus, ...record } = raw;
  return {
    record: parseSyncRecord(table, record),
    syncStatus: String(syncStatus ?? "synced"),
  };
}

async function applyRemoteRecord(
  local: Client,
  table: SyncTableConfig,
  record: Record<string, unknown>,
) {
  const localRecord = { ...record, sync_status: "synced" };
  const columns = [...table.columns, "sync_status"];
  await local.execute({
    sql: localUpsertSql(table),
    args: recordArgs(columns, localRecord),
  });
}

async function markLocalSynced(local: Client, table: string, id: string) {
  await local.execute({
    sql: `UPDATE "${table}" SET sync_status = 'synced' WHERE id = ?`,
    args: [id],
  });
}

async function markLocalError(local: Client, table: string, id: string) {
  await local.execute({
    sql: `UPDATE "${table}" SET sync_status = 'error' WHERE id = ?`,
    args: [id],
  });
}

async function recordConflict(params: {
  local: Client;
  runId: string;
  table: SyncTableConfig;
  localRecord: Record<string, unknown>;
  remoteRecord: Record<string, unknown>;
  winner: "local" | "remote";
  reason: string;
}) {
  await params.local.execute({
    sql: `INSERT INTO sync_conflicts (
            id, run_id, table_name, record_id, winner, reason,
            local_payload, remote_payload, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      randomUUID(),
      params.runId,
      params.table.name,
      String(params.localRecord.id),
      params.winner,
      params.reason,
      JSON.stringify(redactSyncRecord(params.table, params.localRecord)),
      JSON.stringify(redactSyncRecord(params.table, params.remoteRecord)),
      Math.floor(Date.now() / 1000),
    ],
  });
}

async function pushTable(
  clients: SyncClients,
  table: SyncTableConfig,
  runId: string,
  counts: SyncCounts,
) {
  let lastUpdatedAt = -1;
  let lastId = "";
  while (true) {
    const result = await clients.local.execute({
      sql: `SELECT ${quotedColumns(table.columns)} FROM "${table.name}"
            WHERE sync_status IN ('pending', 'error')
              AND (updated_at > ? OR (updated_at = ? AND id > ?))
            ORDER BY updated_at, id LIMIT ${BATCH_SIZE}`,
      args: [lastUpdatedAt, lastUpdatedAt, lastId],
    });
    if (result.rows.length === 0) return;

    for (const raw of result.rows) {
      let localRecord: Record<string, unknown> | null = null;
      const rawRecord = raw as Record<string, unknown>;
      lastUpdatedAt = Number(rawRecord.updated_at ?? lastUpdatedAt);
      lastId = String(rawRecord.id ?? lastId);
      try {
        localRecord = parseSyncRecord(table, rawRecord);
        const id = String(localRecord.id);
        const remoteRecord = await selectRecord(clients.cloud, table, id);

        if (remoteRecord) {
          const comparison = compareSyncOrder(
            toOrder(localRecord),
            toOrder(remoteRecord),
          );
          if (comparison < 0) {
            await recordConflict({
              local: clients.local,
              runId,
              table,
              localRecord,
              remoteRecord,
              winner: "remote",
              reason: "Remote version/HLC is newer than pending local row.",
            });
            await applyRemoteRecord(clients.local, table, remoteRecord);
            incrementCount(counts, table.name, "conflicts");
            incrementCount(counts, table.name, "downloaded");
            continue;
          }
          if (comparison === 0) {
            await markLocalSynced(clients.local, table.name, id);
            continue;
          }
        }

        const uploadResult = await clients.cloud.execute({
          sql: cloudUpsertSql(table),
          args: recordArgs(table.columns, localRecord),
        });
        if (uploadResult.rowsAffected === 0) {
          const latestRemote = await selectRecord(clients.cloud, table, id);
          const latestComparison = latestRemote
            ? compareSyncOrder(toOrder(latestRemote), toOrder(localRecord))
            : null;
          if (
            latestRemote &&
            latestComparison !== null &&
            latestComparison > 0
          ) {
            await recordConflict({
              local: clients.local,
              runId,
              table,
              localRecord,
              remoteRecord: latestRemote,
              winner: "remote",
              reason: "Remote row changed during optimistic cloud upload.",
            });
            await applyRemoteRecord(clients.local, table, latestRemote);
            incrementCount(counts, table.name, "conflicts");
            incrementCount(counts, table.name, "downloaded");
            continue;
          }
          if (!latestRemote) {
            throw new Error("Cloud upsert did not persist the record.");
          }
          if (latestComparison !== 0) {
            throw new Error(
              "Cloud rejected a newer local record; row remains queued for retry.",
            );
          }
        }
        await markLocalSynced(clients.local, table.name, id);
        incrementCount(counts, table.name, "uploaded");
      } catch (error) {
        incrementCount(counts, table.name, "failed");
        const failedId = localRecord?.id ?? rawRecord.id;
        if (failedId) {
          await markLocalError(
            clients.local,
            table.name,
            String(failedId),
          ).catch(() => undefined);
        }
        console.error(`[SYNC_PUSH:${table.name}]`, error);
      }
    }

    if (result.rows.length < BATCH_SIZE) return;
  }
}

async function readCursor(local: Client, table: string) {
  const result = await local.execute({
    sql: "SELECT last_updated_at, last_id FROM sync_cursors WHERE table_name = ? LIMIT 1",
    args: [table],
  });
  const row = result.rows[0] as Record<string, unknown> | undefined;
  return {
    lastUpdatedAt: Math.max(0, Number(row?.last_updated_at ?? 0)),
    lastId: String(row?.last_id ?? ""),
  };
}

async function saveCursor(
  local: Client,
  table: string,
  updatedAt: number,
  id: string,
) {
  await local.execute({
    sql: `INSERT INTO sync_cursors (table_name, last_updated_at, last_id, updated_at)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(table_name) DO UPDATE SET
            last_updated_at = excluded.last_updated_at,
            last_id = excluded.last_id,
            updated_at = excluded.updated_at`,
    args: [table, updatedAt, id, Math.floor(Date.now() / 1000)],
  });
}

async function pullTable(
  clients: SyncClients,
  table: SyncTableConfig,
  runId: string,
  counts: SyncCounts,
) {
  let cursor = await readCursor(clients.local, table.name);

  for (let batch = 0; batch < MAX_PULL_BATCHES; batch += 1) {
    const result = await clients.cloud.execute({
      sql: `SELECT ${quotedColumns(table.columns)} FROM "${table.name}"
            WHERE updated_at > ? OR (updated_at = ? AND id > ?)
            ORDER BY updated_at, id LIMIT ${BATCH_SIZE}`,
      args: [cursor.lastUpdatedAt, cursor.lastUpdatedAt, cursor.lastId],
    });
    if (result.rows.length === 0) return;

    for (const raw of result.rows) {
      const rawRecord = raw as Record<string, unknown>;
      const nextCursor = {
        lastUpdatedAt: Number(rawRecord.updated_at ?? cursor.lastUpdatedAt),
        lastId: String(rawRecord.id ?? cursor.lastId),
      };
      try {
        const remoteRecord = parseSyncRecord(table, rawRecord);
        const id = String(remoteRecord.id);
        const localState = await selectLocalRecord(clients.local, table, id);

        if (!localState) {
          await applyRemoteRecord(clients.local, table, remoteRecord);
          incrementCount(counts, table.name, "downloaded");
        } else {
          const comparison = compareSyncOrder(
            toOrder(localState.record),
            toOrder(remoteRecord),
          );
          const localIsPending = ["pending", "error"].includes(
            localState.syncStatus,
          );

          if (localIsPending && comparison > 0) {
            await recordConflict({
              local: clients.local,
              runId,
              table,
              localRecord: localState.record,
              remoteRecord,
              winner: "local",
              reason: "Pending local version/HLC is newer than remote row.",
            });
            incrementCount(counts, table.name, "conflicts");
          } else if (comparison < 0) {
            if (localIsPending) {
              await recordConflict({
                local: clients.local,
                runId,
                table,
                localRecord: localState.record,
                remoteRecord,
                winner: "remote",
                reason: "Remote version/HLC is newer than pending local row.",
              });
              incrementCount(counts, table.name, "conflicts");
            }
            await applyRemoteRecord(clients.local, table, remoteRecord);
            incrementCount(counts, table.name, "downloaded");
          } else if (comparison === 0 && localIsPending) {
            await markLocalSynced(clients.local, table.name, id);
          }
        }
        cursor = nextCursor;
      } catch (error) {
        incrementCount(counts, table.name, "failed");
        console.error(`[SYNC_PULL:${table.name}]`, error);
        await saveCursor(
          clients.local,
          table.name,
          cursor.lastUpdatedAt,
          cursor.lastId,
        );
        throw new SyncEngineError(
          "SYNC_PULL_ROW_FAILED",
          `Pull ${table.name} berhenti pada record ${nextCursor.lastId}; cursor tidak dimajukan agar data tidak terlewat.`,
        );
      }
    }

    await saveCursor(
      clients.local,
      table.name,
      cursor.lastUpdatedAt,
      cursor.lastId,
    );
    if (result.rows.length < BATCH_SIZE) return;
  }

  throw new SyncEngineError(
    "SYNC_PULL_LIMIT_REACHED",
    `Pull ${table.name} dihentikan setelah batas batch; jalankan sync lagi.`,
  );
}

async function createRun(local: Client, action: SyncAction) {
  const id = randomUUID();
  await local.execute({
    sql: `INSERT INTO sync_runs (
            id, device_id, action, status, started_at
          ) VALUES (?, ?, ?, 'running', ?)`,
    args: [
      id,
      process.env.HYBRID_STARTER_DEVICE_ID?.trim() || "desktop-device",
      action,
      Math.floor(Date.now() / 1000),
    ],
  });
  return id;
}

async function finishRun(
  local: Client,
  runId: string,
  status: "success" | "error",
  counts: SyncCounts,
  error: string | null,
) {
  await local.execute({
    sql: `UPDATE sync_runs SET
            status = ?, uploaded = ?, downloaded = ?, conflicts = ?,
            failed = ?, error = ?, finished_at = ?
          WHERE id = ?`,
    args: [
      status,
      counts.uploaded,
      counts.downloaded,
      counts.conflicts,
      counts.failed,
      error,
      Math.floor(Date.now() / 1000),
      runId,
    ],
  });
}

async function executeSync(action: SyncAction): Promise<SyncResult> {
  const clients = await getSyncClients();
  const counts = createSyncCounts();
  const runId = await createRun(clients.local, action);

  try {
    if (action === "push" || action === "full") {
      for (const table of SYNC_TABLES) {
        await pushTable(clients, table, runId, counts);
      }
    }
    if (action === "pull" || action === "full") {
      for (const table of SYNC_TABLES) {
        await pullTable(clients, table, runId, counts);
      }
    }

    if (counts.failed > 0) {
      throw new SyncEngineError(
        "SYNC_PARTIAL_FAILURE",
        `Sinkronisasi belum selesai: ${counts.failed} record gagal dan tetap dijadwalkan untuk dicoba ulang.`,
      );
    }

    await finishRun(clients.local, runId, "success", counts, null);
    return {
      status: "success",
      message: `Sync selesai: ${counts.uploaded} upload, ${counts.downloaded} download, ${counts.conflicts} konflik.`,
      runId,
      ...resultCounts(counts),
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Sinkronisasi gagal diproses.";
    await finishRun(clients.local, runId, "error", counts, message).catch(
      () => undefined,
    );
    throw error;
  }
}

export function runServerSync(action: SyncAction) {
  if (cache.activeRun) {
    throw new SyncEngineError(
      "SYNC_ALREADY_RUNNING",
      "Sinkronisasi lain masih berjalan.",
    );
  }

  const run = executeSync(action).finally(() => {
    if (cache.activeRun === run) cache.activeRun = null;
  });
  cache.activeRun = run;
  return run;
}

function mapRun(row: Record<string, unknown>): SyncRunSummary {
  return {
    id: String(row.id),
    action: row.action as SyncAction,
    status: row.status as SyncRunSummary["status"],
    uploaded: Number(row.uploaded),
    downloaded: Number(row.downloaded),
    conflicts: Number(row.conflicts),
    failed: Number(row.failed),
    error: typeof row.error === "string" ? row.error : null,
    startedAt: Number(row.started_at),
    finishedAt:
      row.finished_at === null || row.finished_at === undefined
        ? null
        : Number(row.finished_at),
  };
}

export async function getServerSyncStatus(): Promise<SyncStatusResult> {
  if (!isEmbeddedDesktopRuntime()) {
    return {
      available: false,
      configured: false,
      message: "Web runtime memakai database cloud secara langsung.",
      pending: 0,
      failed: 0,
      tables: [],
      lastRun: null,
    };
  }

  const local = createClient({ url: resolveLocalUrl() });
  try {
    await runMigrations(asDatabaseLike(local), { seedData: false });
    let pending = 0;
    let failed = 0;
    const tables: SyncStatusResult["tables"] = [];
    for (const table of SYNC_TABLES) {
      const result = await local.execute(
        `SELECT
           SUM(CASE WHEN sync_status = 'pending' THEN 1 ELSE 0 END) AS pending,
           SUM(CASE WHEN sync_status = 'error' THEN 1 ELSE 0 END) AS failed
         FROM "${table.name}"`,
      );
      const tablePending = Number(result.rows[0]?.pending ?? 0);
      const tableFailed = Number(result.rows[0]?.failed ?? 0);
      pending += tablePending;
      failed += tableFailed;
      tables.push({
        table: table.name,
        pending: tablePending,
        failed: tableFailed,
      });
    }

    const lastRunResult = await local.execute(
      "SELECT * FROM sync_runs ORDER BY started_at DESC LIMIT 1",
    );
    const lastRunRow = lastRunResult.rows[0] as
      | Record<string, unknown>
      | undefined;
    let configured = true;
    try {
      resolveCloudConfig();
    } catch {
      configured = false;
    }

    return {
      available: true,
      configured,
      message: configured
        ? "Turso siap; perubahan lokal akan disinkronkan dari server desktop."
        : "Turso belum dikonfigurasi atau aplikasi belum direstart.",
      pending,
      failed,
      tables,
      lastRun: lastRunRow ? mapRun(lastRunRow) : null,
    };
  } finally {
    local.close();
  }
}

export async function resetSyncEngineForTests() {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("Sync engine reset is test-only.");
  }
  const clients = await cache.clientsPromise?.catch(() => null);
  await clients?.local.close();
  await clients?.cloud.close();
  cache.clientsPromise = null;
  cache.activeRun = null;
}
