"use client";

import { requestWebApi } from "@/lib/client/api-client";
import { isDesktopRuntime } from "@/lib/runtime/app-runtime";
import { invokeDesktop } from "@/lib/runtime/desktop-commands";
import type { DatabaseProvider } from "@/lib/validations/database-endpoint";

export type BootstrapStatus = {
  configured: boolean;
  required: boolean;
  serverOrigin: string;
  /**
   * Apakah database cloud tersimpan benar-benar menjawab.
   *
   * `configured` hanya berarti perangkat menyimpan kredensial. Kredensial yang
   * menunjuk database Turso yang sudah dihapus tetap `configured: true` dengan
   * `reachable: false` — layar login memakai selisih itu untuk menawarkan
   * konfigurasi ulang database alih-alih membuntu di form login.
   */
  reachable: boolean;
  /** Alasan `reachable: false`, langsung dari klien Turso. */
  message: string | null;
};

export type BootstrapDraft = {
  kodeOperator: string;
  namaOperator: string;
  username: string;
  email: string;
  noHp: string;
  password: string;
  databaseUrl?: string;
  authToken?: string;
  provider?: DatabaseProvider;
  allowInsecureTransport?: boolean;
  /**
   * Teks lisensi `LIS1.…`. Wajib saat database masih baru: Rust menolak
   * membuat Superadmin sebelum lisensinya terbukti sah untuk perangkat ini.
   */
  license: string;
};

export type WebProvisioningStatus = {
  /**
   * `false` = database memang belum diprovisioning. `null` = tidak diketahui
   * (database tidak terjangkau), dan pada `null` layar WAJIB diam: kegagalan
   * jaringan sesaat tidak boleh menyuruh orang memprovisioning database yang
   * sebenarnya sudah berisi.
   */
  hasOperator: boolean | null;
  /** Server ini memasang `KOS_SETUP_TOKEN`, jadi `/setup` bisa dipakai. */
  setupEnabled: boolean;
  /**
   * `false` = alamat database belum diisi atau tidak sah di environment
   * server. Berbeda dari `hasOperator: null`: keadaan ini tidak pulih sendiri,
   * jadi layar WAJIB mengatakannya alih-alih diam.
   */
  databaseConfigured: boolean;
  /** Alasan dari server saat `databaseConfigured` bernilai `false`. */
  databaseIssue: string | null;
};

/**
 * Status provisioning database Web. `null` di Desktop/Mobile (keduanya punya
 * layar provisioning sendiri lewat `getBootstrapStatus`, dan endpoint di bawah
 * tidak ada pada static export) dan saat endpoint-nya gagal dijangkau.
 */
export async function getWebProvisioningStatus(): Promise<WebProvisioningStatus | null> {
  if (isDesktopRuntime()) return null;
  try {
    const response = await requestWebApi<{
      hasOperator: boolean | null;
      setupEnabled?: boolean;
      databaseConfigured?: boolean;
      databaseIssue?: string | null;
    }>("/api/auth/provisioning-status", "POST");
    return {
      hasOperator: response.hasOperator,
      setupEnabled: response.setupEnabled === true,
      databaseConfigured: response.databaseConfigured !== false,
      databaseIssue:
        typeof response.databaseIssue === "string"
          ? response.databaseIssue
          : null,
    };
  } catch {
    // Petunjuk ini pelengkap, bukan syarat untuk login. Endpoint yang gagal
    // cukup berarti "tidak diketahui": halaman login tetap berfungsi penuh.
    return null;
  }
}

export type WebSuperadminDraft = {
  /** Isi `KOS_SETUP_TOKEN` dari `.env` server. */
  setupToken: string;
  namaOperator: string;
  username: string;
  email: string;
  noHp: string;
  password: string;
  /** Teks `LIS1.…`; wajib pada build terkunci yang belum berlisensi. */
  license?: string;
};

/**
 * Buat Superadmin pertama dari browser. Khusus Web: Desktop dan Mobile memakai
 * `bootstrapSuperadmin` di bawah, yang juga menyimpan koneksi database.
 *
 * Mengembalikan kode pemulihan, yang hanya bisa dibaca SEKALI.
 */
export async function createWebSuperadmin(
  draft: WebSuperadminDraft,
): Promise<string[]> {
  if (isDesktopRuntime()) {
    throw new Error(
      "Provisioning lewat browser hanya tersedia pada versi Web.",
    );
  }
  const response = await requestWebApi<{ recoveryCodes?: unknown }>(
    "/api/auth/bootstrap",
    "POST",
    draft,
  );
  return Array.isArray(response.recoveryCodes)
    ? response.recoveryCodes.map((code) => String(code))
    : [];
}

export async function getBootstrapStatus(): Promise<BootstrapStatus | null> {
  if (!isDesktopRuntime()) return null;
  return invokeDesktop<BootstrapStatus>("desktop_get_bootstrap_status");
}

/**
 * Buat Superadmin pertama, lalu terima kode pemulihannya.
 *
 * Kodenya hanya bisa dibaca SEKALI: database memegang hash-nya saja. Layar
 * pemanggil WAJIB menampilkannya sampai pengguna menyatakan sudah menyimpan —
 * membuangnya diam-diam berarti pemasangan tanpa jaringan kehilangan satu-
 * satunya jalan pulih bila password Superadmin terlupa.
 */
export async function bootstrapSuperadmin(
  draft: BootstrapDraft,
): Promise<string[]> {
  if (!isDesktopRuntime()) {
    throw new Error("Bootstrap hanya tersedia pada aplikasi desktop/mobile.");
  }
  const response = await invokeDesktop<{ recoveryCodes?: unknown }>(
    "desktop_bootstrap_superadmin",
    {
      draft: {
        kode_operator: draft.kodeOperator,
        nama_operator: draft.namaOperator,
        username: draft.username,
        email: draft.email,
        no_hp: draft.noHp,
        password: draft.password,
      },
      databaseUrl: draft.databaseUrl?.trim() || null,
      authToken: draft.authToken?.trim() || null,
      provider: draft.provider ?? null,
      allowInsecureTransport: draft.allowInsecureTransport ?? null,
      license: draft.license.trim() || null,
    },
  );
  return Array.isArray(response.recoveryCodes)
    ? response.recoveryCodes.map((code) => String(code))
    : [];
}

export type DatabaseCheckResult = {
  reachable: boolean;
  serverOrigin: string;
  latencyMs: number | null;
  emptyDatabase: boolean;
  schemaReady: boolean;
  missingTables: string[];
  tableCount: number;
  bootstrapClaimed: boolean;
  superadminExists: boolean;
  superadminCount: number;
  superadminUsername: string | null;
  operatorCount: number;
  karyawanCount: number;
  attendanceCount: number;
  companyName: string | null;
  errorCode: string | null;
  errorMessage: string | null;
};

export type DatabaseCredentials = {
  databaseUrl?: string;
  authToken?: string;
  /**
   * Provider yang dipilih di formulir. Dikirim eksplisit supaya alamat LAN
   * ber-HTTP tidak divalidasi memakai aturan Turso — yang akan menolaknya.
   */
  provider?: DatabaseProvider;
  allowInsecureTransport?: boolean;
};

function credentialArgs(credentials: DatabaseCredentials) {
  return {
    databaseUrl: credentials.databaseUrl?.trim() || null,
    authToken: credentials.authToken?.trim() || null,
    provider: credentials.provider ?? null,
    allowInsecureTransport: credentials.allowInsecureTransport ?? null,
  };
}

/**
 * Pemeriksaan read-only database cloud sebelum Superadmin dibuat.
 * Tidak menulis apa pun sehingga salah input URL tidak mencemari database lain.
 */
export async function checkBootstrapDatabase(
  credentials: DatabaseCredentials = {},
): Promise<DatabaseCheckResult> {
  if (!isDesktopRuntime()) {
    throw new Error(
      "Pemeriksaan database hanya tersedia pada aplikasi desktop/mobile.",
    );
  }
  return invokeDesktop<DatabaseCheckResult>(
    "desktop_check_bootstrap_database",
    credentialArgs(credentials),
  );
}

/** Memakai database yang sudah punya Superadmin aktif tanpa membuat akun baru. */
export async function linkBootstrapDatabase(
  credentials: DatabaseCredentials = {},
): Promise<DatabaseCheckResult> {
  if (!isDesktopRuntime()) {
    throw new Error(
      "Konfigurasi database hanya tersedia pada aplikasi desktop/mobile.",
    );
  }
  return invokeDesktop<DatabaseCheckResult>(
    "desktop_link_bootstrap_database",
    credentialArgs(credentials),
  );
}
