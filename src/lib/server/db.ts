import "server-only";

import { type Client, createClient } from "@libsql/client";
import { initDatabaseSchema } from "@/lib/db-schema";
import {
  fileDatabaseOptions,
  resolveServerDatabaseConfig,
} from "@/lib/server/database-config";

interface ServerDatabaseState {
  client: Client | null;
  initialization: Promise<void> | null;
}

const globalDatabase = globalThis as typeof globalThis & {
  __sppgServerDatabase?: ServerDatabaseState;
};

if (!globalDatabase.__sppgServerDatabase) {
  globalDatabase.__sppgServerDatabase = { client: null, initialization: null };
}
const state = globalDatabase.__sppgServerDatabase;

export function getServerDatabase() {
  if (!state.client) {
    const config = resolveServerDatabaseConfig(process.env);
    state.client = createClient({
      url: config.url,
      authToken: config.authToken,
      ...fileDatabaseOptions(config),
    });
  }

  return state.client;
}

async function siapkanDatabase() {
  const client = getServerDatabase();
  // WAL membuat pembaca tidak menghalangi penulis, dan sebaliknya. Pada paket
  // Windows databasenya berkas SQLite: tanpa WAL, laporan panjang yang sedang
  // dibaca menahan login dan scan. Setelannya tersimpan di berkas database.
  if (!resolveServerDatabaseConfig(process.env).isRemote) {
    await client.execute("PRAGMA journal_mode = WAL;");
  }
  await initDatabaseSchema(client);
}

export async function ensureServerDatabaseInitialized() {
  if (!state.initialization) {
    state.initialization = siapkanDatabase().catch((error) => {
      state.initialization = null;
      throw error;
    });
  }

  await state.initialization;
}
