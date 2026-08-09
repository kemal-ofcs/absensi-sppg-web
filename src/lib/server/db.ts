import "server-only";

import { type Client, createClient } from "@libsql/client";
import { initDatabaseSchema } from "@/lib/db-schema";
import { resolveServerDatabaseConfig } from "@/lib/server/database-config";

let serverClient: Client | null = null;
let initialization: Promise<void> | null = null;

export function getServerDatabase() {
  if (!serverClient) {
    const config = resolveServerDatabaseConfig(process.env);
    serverClient = createClient({
      url: config.url,
      authToken: config.authToken,
    });
  }

  return serverClient;
}

export async function ensureServerDatabaseInitialized() {
  if (!initialization) {
    initialization = initDatabaseSchema(getServerDatabase()).catch((error) => {
      initialization = null;
      throw error;
    });
  }

  await initialization;
}
