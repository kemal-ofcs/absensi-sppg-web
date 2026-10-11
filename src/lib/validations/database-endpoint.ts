/**
 * Aturan alamat database yang dipakai bersama oleh UI provisioning dan halaman
 * Pengaturan.
 *
 * Ini adalah cermin sisi klien dari `normalize_database_url` di
 * `src-tauri/src/desktop/turso.rs`. Backend Rust tetap menjadi penjaga
 * sebenarnya — modul ini hanya agar formulir bisa memberi tahu pengguna
 * sebelum tombol ditekan, bukan setelah perjalanan IPC gagal. Karena keduanya
 * harus setuju, perubahan aturan di satu sisi wajib diikuti sisi lainnya.
 */

export type DatabaseProvider = "turso" | "self_hosted" | "local_file";

export interface DatabaseProviderOption {
  readonly value: DatabaseProvider;
  readonly label: string;
  readonly description: string;
  readonly urlPlaceholder: string;
  readonly tokenPlaceholder: string;
  /** Apakah Auth Token selalu wajib untuk provider ini. */
  readonly tokenAlwaysRequired: boolean;
}

export const DATABASE_PROVIDER_OPTIONS: readonly DatabaseProviderOption[] = [
  {
    value: "turso",
    label: "Turso Cloud",
    description:
      "Database terkelola di turso.tech. Selalu terenkripsi dan selalu memerlukan Auth Token.",
    urlPlaceholder: "libsql://database-anda.turso.io",
    tokenPlaceholder: "Auth Token dari dashboard Turso",
    tokenAlwaysRequired: true,
  },
  {
    value: "self_hosted",
    label: "Server Database Sendiri",
    description:
      "Server libSQL (sqld) milik Anda sendiri: komputer kantor, NAS, server lokal, atau VPS. Auth Token opsional bila server berjalan tanpa autentikasi.",
    urlPlaceholder: "http://192.168.1.10:8080",
    tokenPlaceholder: "Kosongkan bila server tanpa autentikasi",
    tokenAlwaysRequired: false,
  },
  {
    value: "local_file",
    label: "Database Lokal (Tanpa Server)",
    description:
      "Berkas SQLite di perangkat ini. Tidak butuh internet, server, maupun Auth Token — cocok untuk satu perangkat yang berdiri sendiri.",
    urlPlaceholder: "",
    tokenPlaceholder: "",
    tokenAlwaysRequired: false,
  },
] as const;

export function isDatabaseProvider(value: unknown): value is DatabaseProvider {
  return value === "turso" || value === "self_hosted" || value === "local_file";
}

/**
 * Apakah provider ini membutuhkan alamat endpoint.
 *
 * Mode Database Lokal tidak punya alamat jaringan sama sekali, sehingga
 * formulir tidak boleh menampilkan — apalagi memvalidasi — kolom URL dan token
 * untuknya.
 */
export function providerNeedsEndpoint(provider: DatabaseProvider): boolean {
  return provider !== "local_file";
}

export function normalizeProvider(value: unknown): DatabaseProvider {
  // Nilai asing selalu jatuh ke Turso: aturan validasinya paling ketat,
  // sehingga default yang salah tebak tetap menolak, bukan meloloskan.
  return isDatabaseProvider(value) ? value : "turso";
}

export function describeProvider(
  provider: DatabaseProvider,
): DatabaseProviderOption {
  return (
    DATABASE_PROVIDER_OPTIONS.find((option) => option.value === provider) ??
    DATABASE_PROVIDER_OPTIONS[0]
  );
}

const IPV4_PATTERN = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function isPrivateIpv4(host: string): boolean {
  const match = IPV4_PATTERN.exec(host);
  if (!match) return false;
  const parts = match.slice(1).map((part) => Number(part));
  if (parts.some((part) => Number.isNaN(part) || part < 0 || part > 255)) {
    return false;
  }
  const [a, b] = parts;
  if (a === undefined || b === undefined) return false;
  if (a === 127) return true; // loopback
  if (a === 10) return true; // RFC1918 /8
  if (a === 192 && b === 168) return true; // RFC1918 /16
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918 /12
  if (a === 169 && b === 254) return true; // link-local
  return false;
}

/**
 * Alamat yang trafiknya tidak pernah meninggalkan perangkat atau LAN pengguna.
 *
 * Sengaja konservatif dan identik dengan `is_private_network_host` di Rust.
 * Kalau daftar ini lebih longgar daripada sisi Rust, UI akan menjanjikan
 * koneksi yang kemudian ditolak backend.
 */
export function isPrivateNetworkHost(rawHost: string): boolean {
  const host = rawHost
    .trim()
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .toLowerCase();
  if (!host) return false;
  if (host === "localhost" || host === "host.docker.internal") return true;
  if (host === "10.0.2.2") return true; // emulator Android -> mesin developer
  if (
    host.endsWith(".local") ||
    host.endsWith(".lan") ||
    host.endsWith(".internal")
  ) {
    return true;
  }
  if (host === "::1") return true;
  // fc00::/7 (unique local) dan fe80::/10 (link local)
  if (/^f[cd][0-9a-f]{2}:/.test(host)) return true;
  if (/^fe[89ab][0-9a-f]:/.test(host)) return true;
  return isPrivateIpv4(host);
}

export interface DatabaseEndpointIssue {
  readonly code:
    | "EMPTY"
    | "MALFORMED"
    | "SCHEME"
    | "CREDENTIALS"
    | "INSECURE_PUBLIC";
  readonly message: string;
}

export interface DatabaseEndpointReview {
  /** Endpoint bisa dipakai apa adanya. */
  readonly valid: boolean;
  /** Alasan endpoint ditolak, bila ada. */
  readonly issue: DatabaseEndpointIssue | null;
  /** Host berada di jaringan privat/LAN. */
  readonly privateNetwork: boolean;
  /** Endpoint memakai HTTP polos (tanpa TLS). */
  readonly plaintext: boolean;
  /**
   * Auth Token wajib diisi untuk endpoint ini — Turso selalu, server sendiri
   * hanya bila endpoint-nya benar-benar terjangkau dari internet.
   */
  readonly tokenRequired: boolean;
}

function rejected(
  code: DatabaseEndpointIssue["code"],
  message: string,
): DatabaseEndpointReview {
  return {
    valid: false,
    issue: { code, message },
    privateNetwork: false,
    plaintext: false,
    tokenRequired: true,
  };
}

/**
 * Periksa alamat database menurut provider yang dipilih.
 *
 * Mengembalikan alasan penolakan yang bisa langsung ditampilkan, bukan sekadar
 * boolean, supaya formulir tidak perlu menyusun ulang pesan yang sudah punya
 * padanan di backend.
 */
export function reviewDatabaseEndpoint(
  rawUrl: string,
  provider: DatabaseProvider,
  allowInsecureTransport = false,
): DatabaseEndpointReview {
  // Mode lokal DITOLAK di sini, bukan diloloskan. Kalau ia diloloskan begitu
  // saja, sebuah alamat remote yang kebetulan dipasangkan dengan provider
  // `local_file` akan melewati seluruh aturan transport di bawah tanpa satu
  // pun pemeriksaan. Pemanggil memakai `providerNeedsEndpoint` untuk tahu
  // bahwa fungsi ini memang tidak berlaku.
  if (provider === "local_file") {
    return rejected(
      "SCHEME",
      "Mode Database Lokal tidak memakai URL database.",
    );
  }

  const trimmed = rawUrl.trim();
  if (!trimmed) {
    return rejected("EMPTY", "URL database tidak boleh kosong.");
  }

  // `libsql://` dan `ws(s)://` adalah ejaan lain dari endpoint HTTP yang sama.
  let candidate = trimmed;
  if (candidate.startsWith("libsql://")) {
    candidate = `https://${candidate.slice("libsql://".length)}`;
  } else if (candidate.startsWith("wss://")) {
    candidate = `https://${candidate.slice("wss://".length)}`;
  } else if (candidate.startsWith("ws://")) {
    candidate = `http://${candidate.slice("ws://".length)}`;
  }

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return rejected(
      "MALFORMED",
      provider === "turso"
        ? "Format URL database Turso tidak valid (contoh: libsql://db-name.turso.io)."
        : "Format URL server database tidak valid (contoh: http://192.168.1.10:8080).",
    );
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return rejected(
      "SCHEME",
      "URL database harus memakai protokol libsql://, https://, atau http://.",
    );
  }
  if (!parsed.hostname || parsed.username || parsed.password) {
    return rejected(
      "CREDENTIALS",
      "URL database harus memiliki host dan tidak boleh memuat kredensial.",
    );
  }

  const privateNetwork = isPrivateNetworkHost(parsed.hostname);
  const plaintext = parsed.protocol === "http:";

  if (plaintext && !privateNetwork) {
    if (provider === "turso") {
      return rejected(
        "SCHEME",
        'URL database Turso wajib memakai HTTPS. Kalau ini server database Anda sendiri, pilih mode "Server Database Sendiri" terlebih dahulu.',
      );
    }
    if (!allowInsecureTransport) {
      return {
        valid: false,
        issue: {
          code: "INSECURE_PUBLIC",
          message:
            'Alamat ini berada di luar jaringan privat, sehingga HTTP polos akan mengirim Auth Token dan data absensi tanpa enkripsi. Pasang HTTPS di server, pakai alamat LAN/VPN, atau centang "Izinkan koneksi tanpa enkripsi".',
        },
        privateNetwork,
        plaintext,
        tokenRequired: true,
      };
    }
  }

  return {
    valid: true,
    issue: null,
    privateNetwork,
    plaintext,
    tokenRequired: provider === "turso" || (!plaintext && !privateNetwork),
    // `local_file` tidak pernah sampai ke sini.
  };
}
