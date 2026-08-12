import "server-only";

import { type Client, createClient } from "@libsql/client";
import { initDatabaseSchema } from "@/lib/db-schema";
import { resolveServerDatabaseConfig } from "@/lib/server/database-config";

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
    });
  }

  return state.client;
}

export async function ensureServerDatabaseInitialized() {
  if (!state.initialization) {
    state.initialization = initDatabaseSchema(getServerDatabase()).catch(
      (error) => {
        state.initialization = null;
        throw error;
      },
    );
  }

  await state.initialization;
}
