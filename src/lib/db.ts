import "server-only";

import type { Client } from "@libsql/client";
import {
  ensureServerDatabaseInitialized,
  getServerDatabase,
} from "@/lib/server/db";

/**
 * Facade untuk service domain lama. Semua pemanggil memakai singleton dan
 * aturan konfigurasi database server yang sama dengan Route Handler.
 *
 * Koneksinya dibuat pada AKSES PERTAMA, bukan saat modul ini di-import.
 * `export const db = getServerDatabase()` menyelesaikan konfigurasi begitu
 * modul dimuat, sehingga build Desktop dan Mobile gagal: `next build`
 * mengumpulkan page data untuk setiap route `src/app/api/**`, route itu
 * mengimpor service, service mengimpor modul ini, lalu
 * `resolveServerDatabaseConfig` melempar "TURSO_DATABASE_URL wajib tersedia"
 * karena `NODE_ENV=production` di mesin build yang tidak punya kredensial cloud.
 * Route API tidak pernah ikut static export — Desktop dan Mobile memakai IPC.
 */
export const db: Client = new Proxy({} as Client, {
  get(_target, property, receiver) {
    // `await db` menyentuh `then`; menjawabnya tanpa membuka koneksi.
    if (property === "then") return undefined;

    const client = getServerDatabase();
    const value = Reflect.get(client, property, receiver);
    return typeof value === "function" ? value.bind(client) : value;
  },
  has(_target, property) {
    return Reflect.has(getServerDatabase(), property);
  },
});

export const ensureDbInitialized = ensureServerDatabaseInitialized;
