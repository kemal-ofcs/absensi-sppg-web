import {
  type DatabaseProvider,
  normalizeProvider,
  reviewDatabaseEndpoint,
} from "@/lib/validations/database-endpoint";

export interface ServerDatabaseEnvironment {
  TURSO_DATABASE_URL?: string;
  TURSO_AUTH_TOKEN?: string;
  /** Alias yang lebih netral, dipakai turunan template non-Turso. */
  SPPG_DATABASE_URL?: string;
  SPPG_DATABASE_AUTH_TOKEN?: string;
  /** `turso` (default) atau `self_hosted` untuk server libSQL sendiri. */
  SPPG_DATABASE_PROVIDER?: string;
  /** Izin eksplisit memakai HTTP polos ke alamat publik. */
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
    environment.TURSO_DATABASE_URL ?? environment.SPPG_DATABASE_URL
  )?.trim();
  const authToken = (
    environment.TURSO_AUTH_TOKEN ?? environment.SPPG_DATABASE_AUTH_TOKEN
  )?.trim();
  const provider = normalizeProvider(
    environment.SPPG_DATABASE_PROVIDER?.trim(),
  );

  // Sisi Web SELALU memakai database remote — Turso Cloud atau libSQL
  // self-hosted. Kebutuhan offline tanpa internet dilayani aplikasi Desktop
  // dan Mobile, yang memang menyimpan berkasnya sendiri. Menolaknya di sini
  // penting karena `local_file` melewati pemeriksaan transport: membiarkannya
  // lolos berarti satu variabel lingkungan yang salah bisa mematikan seluruh
  // aturan keamanan alamat.
  if (provider === "local_file") {
    throw new Error(
      "SPPG_DATABASE_PROVIDER=local_file hanya berlaku untuk aplikasi Desktop/Mobile. Sisi Web memerlukan database remote (Turso atau libSQL self-hosted).",
    );
  }
  const allowInsecure = isTruthyFlag(environment.SPPG_ALLOW_INSECURE_DATABASE);
  const isProduction = environment.NODE_ENV === "production";

  if (url) {
    const isRemote = !url.startsWith("file:");

    if (isRemote) {
      const endpoint = reviewDatabaseEndpoint(url, provider, allowInsecure);
      if (!endpoint.valid) {
        throw new Error(
          `TURSO_DATABASE_URL tidak dapat dipakai: ${endpoint.issue?.message ?? "alamat tidak valid."}`,
        );
      }
      // Turso terkelola selalu wajib token. Server sendiri hanya wajib bila
      // endpoint-nya benar-benar terjangkau dari internet — server libSQL di
      // jaringan privat lazim berjalan tanpa autentikasi sama sekali.
      if (isProduction && endpoint.tokenRequired && !authToken) {
        throw new Error(
          "TURSO_AUTH_TOKEN wajib tersedia untuk database remote production.",
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
      "TURSO_DATABASE_URL wajib tersedia pada environment server production.",
    );
  }

  return {
    url: "file:local-app.db",
    isRemote: false,
    provider,
  };
}
