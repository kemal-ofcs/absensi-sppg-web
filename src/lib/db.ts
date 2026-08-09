import { createClient } from "@libsql/client";
import { initDatabaseSchema } from "./db-schema";

// Jalur ini dipertahankan sementara untuk service legacy selama migrasi Fase B.
// Environment tanpa prefix NEXT_PUBLIC hanya tersedia di Node/server dan tidak
// pernah dimasukkan ke bundle Web maupun WebView Desktop.
const tursoUrl = process.env.TURSO_DATABASE_URL;
const tursoToken = process.env.TURSO_AUTH_TOKEN;

function createDbConnection() {
  // 1. Jika ada URL Turso Cloud (libsql:// atau https://), gunakan koneksi Turso
  if (tursoUrl) {
    return createClient({
      url: tursoUrl,
      authToken: tursoToken || undefined,
    });
  }

  // 2. CLI Node/Bun menggunakan SQLite lokal jika Turso tidak dikonfigurasi.
  if (typeof window === "undefined") {
    return createClient({
      url: "file:local-app.db",
    });
  }

  // 3. Browser tidak pernah menerima credential database. Service Web akan
  // dipindahkan bertahap ke same-origin API, sedangkan Desktop ke command Rust.
  return createClient({
    url: "libsql://database-disabled.invalid",
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
          "Akses database langsung dari browser dinonaktifkan pada Fase B.",
        );
        return;
      }
      await initDatabaseSchema(db);
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
