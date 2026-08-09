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

  // 3. Jika dibuka di browser Web Vercel tanpa TURSO_DATABASE_URL di .env, gunakan fallback dummy client
  // agar tidak melemparkan Unhandled Exception yang menyebabkan error "This page couldn't load"
  return createClient({
    url: "libsql://dummy-offline.turso.io",
  });
}

export const db = createDbConnection();

let isInitialized = false;

// Memastikan schema database dan tabel-tabel terbuat otomatis
export async function ensureDbInitialized() {
  if (!isInitialized) {
    try {
      if (!tursoUrl && typeof window !== "undefined") {
        console.warn(
          "NEXT_PUBLIC_TURSO_DATABASE_URL belum dikonfigurasi pada Environment Variables Vercel.",
        );
        return;
      }
      await initDatabaseSchema();
      isInitialized = true;
    } catch (error) {
      console.warn("Gagal inisialisasi schema database:", error);
    }
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
