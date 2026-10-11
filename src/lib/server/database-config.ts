import {
  type DatabaseProvider,
  normalizeProvider,
  reviewDatabaseEndpoint,
} from "@/lib/validations/database-endpoint";

export interface ServerDatabaseEnvironment {
  /**
   * Nama yang dipakai pemasangan baru. Bila diisi, ia MENANG atas dua nama
   * lama di bawah, yang tetap dibaca supaya `.env` yang sudah beredar tidak
   * perlu disunting.
   */
  KOS_DATABASE_URL?: string;
  KOS_DATABASE_AUTH_TOKEN?: string;
  /** `turso` (default) atau `self_hosted` untuk server libSQL sendiri. */
  KOS_DATABASE_PROVIDER?: string;
  /** Izin eksplisit memakai HTTP polos ke alamat publik. */
  KOS_ALLOW_INSECURE_DATABASE?: string;
  TURSO_DATABASE_URL?: string;
  TURSO_AUTH_TOKEN?: string;
  SPPG_DATABASE_URL?: string;
  SPPG_DATABASE_AUTH_TOKEN?: string;
  SPPG_DATABASE_PROVIDER?: string;
  SPPG_ALLOW_INSECURE_DATABASE?: string;
  NODE_ENV?: string;
}

export interface ServerDatabaseConfig {
  url: string;
  authToken?: string;
  isRemote: boolean;
  provider: DatabaseProvider;
}

function isTruthyFlag(raw: string | undefined): boolean {
  const value = raw?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

/**
 * Tentukan database yang dipakai Route Handler Next.js.
 *
 * Sisi web memakai environment, bukan vault perangkat, karena ia berjalan di
 * server (Vercel/Node) tanpa layar provisioning. Aturan transport-nya tetap
 * disamakan dengan sisi Rust lewat `reviewDatabaseEndpoint`, supaya satu
 * deployment tidak diam-diam lebih longgar daripada aplikasi desktop yang
 * menunjuk database yang sama.
 */
export function resolveServerDatabaseConfig(
  environment: ServerDatabaseEnvironment,
): ServerDatabaseConfig {
  const url = (
    environment.KOS_DATABASE_URL ??
    environment.TURSO_DATABASE_URL ??
    environment.SPPG_DATABASE_URL
  )?.trim();
  const authToken = (
    environment.KOS_DATABASE_AUTH_TOKEN ??
    environment.TURSO_AUTH_TOKEN ??
    environment.SPPG_DATABASE_AUTH_TOKEN
  )?.trim();
  const provider = normalizeProvider(
    (
      environment.KOS_DATABASE_PROVIDER ?? environment.SPPG_DATABASE_PROVIDER
    )?.trim(),
  );

  // Provider `local_file` milik Desktop/Mobile: di sana ia berarti berkas hub
  // per perangkat, lengkap dengan mesin sinkronisasinya. Menolaknya di sini
  // penting karena provider itu melewati pemeriksaan transport: membiarkannya
  // lolos berarti satu variabel lingkungan yang salah bisa mematikan seluruh
  // aturan keamanan alamat.
  //
  // Web tetap BOLEH memakai berkas SQLite, tetapi lewat alamatnya
  // (`KOS_DATABASE_URL=file:...`), bukan lewat provider. Itu jalur pemasangan
  // Web-saja di satu server tanpa internet dan tanpa server database terpisah:
  // aplikasi Desktop dan Mobile tidak bisa ikut terhubung ke berkas itu.
  if (provider === "local_file") {
    throw new Error(
      "KOS_DATABASE_PROVIDER=local_file hanya berlaku untuk aplikasi Desktop/Mobile. Sisi Web memerlukan database remote (Turso atau libSQL self-hosted).",
    );
  }
  const allowInsecure = isTruthyFlag(
    environment.KOS_ALLOW_INSECURE_DATABASE ??
      environment.SPPG_ALLOW_INSECURE_DATABASE,
  );
  const isProduction = environment.NODE_ENV === "production";

  if (url) {
    const isRemote = !url.startsWith("file:");

    if (isRemote) {
      const endpoint = reviewDatabaseEndpoint(url, provider, allowInsecure);
      if (!endpoint.valid) {
        throw new Error(
          `Alamat database tidak dapat dipakai: ${endpoint.issue?.message ?? "alamat tidak valid."}`,
        );
      }
      // Turso terkelola selalu wajib token. Server sendiri hanya wajib bila
      // endpoint-nya benar-benar terjangkau dari internet — server libSQL di
      // jaringan privat lazim berjalan tanpa autentikasi sama sekali.
      if (isProduction && endpoint.tokenRequired && !authToken) {
        throw new Error(
          "KOS_DATABASE_AUTH_TOKEN atau TURSO_AUTH_TOKEN wajib tersedia untuk database remote production.",
        );
      }
    }

    return {
      url,
      authToken: authToken || undefined,
      isRemote,
      provider,
    };
  }

  if (isProduction) {
    throw new Error(
      "KOS_DATABASE_URL atau TURSO_DATABASE_URL wajib tersedia pada environment server production.",
    );
  }

  return {
    url: "file:local-app.db",
    isRemote: false,
    provider,
  };
}

/**
 * Waktu tunggu saat berkas SQLite sedang dikunci proses lain.
 *
 * Bawaan klien libSQL adalah 0: tulisan kedua langsung gagal dengan
 * "database is locked". Pada pemasangan berkas (paket Windows), permintaan
 * yang bersamaan (login, scan, antrean WhatsApp) menulis ke berkas yang sama,
 * dan alat seperti `reset:superadmin` bisa membukanya dari proses lain. Lima
 * detik jauh di atas lama satu transaksi, dan masih di bawah batas sabar
 * pengguna.
 */
export const FILE_DATABASE_BUSY_TIMEOUT_MS = 5_000;

/** Opsi `createClient` tambahan untuk berkas SQLite; kosong untuk database remote. */
export function fileDatabaseOptions(config: ServerDatabaseConfig): {
  timeout?: number;
} {
  return config.isRemote ? {} : { timeout: FILE_DATABASE_BUSY_TIMEOUT_MS };
}

/**
 * Alasan konfigurasi database tidak bisa dipakai, atau `null` bila sah.
 *
 * Bukan aturan baru: ini `resolveServerDatabaseConfig` yang ditanya tanpa
 * melempar. Dipakai untuk memisahkan dua kegagalan yang jawabannya berlawanan.
 * Database yang TIDAK TERJANGKAU bersifat sementara, dan layar sengaja diam.
 * Database yang BELUM DIKONFIGURASI tidak akan pulih sendiri, jadi pemasangnya
 * harus diberi tahu apa yang kurang, bukan disuguhi form login yang buntu.
 *
 * Pesannya hanya menyebut nama variabel, tidak pernah nilai alamat atau token,
 * sehingga aman ditampilkan sebelum login.
 */
export function databaseConfigIssue(
  environment: ServerDatabaseEnvironment,
): string | null {
  try {
    resolveServerDatabaseConfig(environment);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** Jawaban route saat database belum dikonfigurasi. */
export const DATABASE_NOT_CONFIGURED_MESSAGE =
  "Server belum terhubung ke database. Isi KOS_DATABASE_URL dan KOS_DATABASE_AUTH_TOKEN di environment server, lalu deploy ulang.";
