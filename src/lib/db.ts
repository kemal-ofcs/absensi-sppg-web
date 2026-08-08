import { createClient } from "@libsql/client";
import { initDatabaseSchema } from "./db-schema";

const tursoUrl =
  process.env.NEXT_PUBLIC_TURSO_DATABASE_URL || process.env.TURSO_DATABASE_URL;

const tursoToken =
  process.env.NEXT_PUBLIC_TURSO_AUTH_TOKEN || process.env.TURSO_AUTH_TOKEN;

function createDbConnection() {
  // 1. Jika ada URL Turso Cloud (libsql:// atau https://), gunakan koneksi Turso
  if (tursoUrl) {
    return createClient({
      url: tursoUrl,
      authToken: tursoToken || undefined,
    });
  }

  // 2. Jika di lingkungan Node.js / Tauri Desktop (bukan browser web biasa), gunakan file SQLite lokal
  if (typeof window === "undefined") {
    return createClient({
      url: "file:local-app.db",
    });
  }

  // 3. Fallback jika dibuka di browser tanpa TURSO_DATABASE_URL di .env
  throw new Error(
    "TURSO_DATABASE_URL belum dikonfigurasi pada .env! Tambahkan NEXT_PUBLIC_TURSO_DATABASE_URL='libsql://...' di .env.",
  );
}

export const db = createDbConnection();

let isInitialized = false;

// Memastikan schema database dan tabel-tabel terbuat otomatis
export async function ensureDbInitialized() {
  if (!isInitialized) {
    await initDatabaseSchema();
    isInitialized = true;
  }
}

// Function manual sync saat aplikasi kembali online
export async function syncDatabase() {
  try {
    const clientSync = db as unknown as { sync?: () => Promise<void> };
    if (tursoUrl && typeof clientSync.sync === "function") {
      await clientSync.sync();
      console.log("Database berhasil disinkronkan dengan Turso Cloud.");
    }
  } catch (error) {
    console.warn("Aplikasi berjalan dalam mode offline / sync gagal:", error);
  }
}
