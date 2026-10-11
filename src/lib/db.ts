import "server-only";

import {
  ensureServerDatabaseInitialized,
  getServerDatabase,
} from "@/lib/server/db";

// Facade sementara untuk service domain lama. Semua pemanggil kini memakai
// singleton dan aturan konfigurasi database server yang sama dengan Route Handler.
export const db = getServerDatabase();
export const ensureDbInitialized = ensureServerDatabaseInitialized;
