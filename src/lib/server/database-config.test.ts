import { describe, expect, test } from "bun:test";

import {
  databaseConfigIssue,
  resolveServerDatabaseConfig,
  type ServerDatabaseEnvironment,
} from "@/lib/server/database-config";

/**
 * Matriks konfigurasi database sisi server.
 *
 * Fungsi ini adalah satu-satunya pintu yang menentukan database mana yang
 * dipakai Route Handler Next.js, sekaligus penjaga aturan transportnya. Satu
 * cabang yang longgar di sini berarti sebuah deployment diam-diam mengirim Auth
 * Token dan data absensi tanpa enkripsi — tanpa seorang pun pernah memilihnya.
 */

function env(overrides: ServerDatabaseEnvironment): ServerDatabaseEnvironment {
  return { NODE_ENV: "production", ...overrides };
}

describe("mode lokal ditolak di sisi Web", () => {
  /**
   * Keputusan arsitektur: sisi Web SELALU memakai database remote. Kebutuhan
   * offline dilayani aplikasi Desktop dan Mobile yang memang menyimpan
   * berkasnya sendiri.
   *
   * Penolakan ini bukan sekadar kerapian. `local_file` melewati seluruh
   * pemeriksaan alamat di `reviewDatabaseEndpoint`, jadi membiarkannya lolos
   * berarti satu variabel lingkungan yang salah bisa mematikan aturan
   * transport untuk alamat remote mana pun.
   */
  test("provider local_file selalu ditolak, bahkan dengan URL yang sah", () => {
    expect(() =>
      resolveServerDatabaseConfig(
        env({
          SPPG_DATABASE_PROVIDER: "local_file",
          TURSO_DATABASE_URL: "libsql://db.turso.io",
          TURSO_AUTH_TOKEN: "token",
        }),
      ),
    ).toThrow(/local_file/);
  });

  test("penolakan berlaku juga di lingkungan pengembangan", () => {
    expect(() =>
      resolveServerDatabaseConfig({
        NODE_ENV: "development",
        SPPG_DATABASE_PROVIDER: "local_file",
      }),
    ).toThrow(/Desktop\/Mobile/);
  });
});

describe("Turso Cloud", () => {
  test("HTTPS dengan token diterima", () => {
    const config = resolveServerDatabaseConfig(
      env({
        SPPG_DATABASE_PROVIDER: "turso",
        TURSO_DATABASE_URL: "libsql://db.turso.io",
        TURSO_AUTH_TOKEN: "token-rahasia",
      }),
    );
    expect(config.isRemote).toBe(true);
    expect(config.provider).toBe("turso");
    expect(config.authToken).toBe("token-rahasia");
  });

  test("tanpa token ditolak di production", () => {
    expect(() =>
      resolveServerDatabaseConfig(
        env({
          SPPG_DATABASE_PROVIDER: "turso",
          TURSO_DATABASE_URL: "libsql://db.turso.io",
        }),
      ),
    ).toThrow(/TURSO_AUTH_TOKEN/);
  });

  test("HTTP ke alamat publik ditolak", () => {
    expect(() =>
      resolveServerDatabaseConfig(
        env({
          SPPG_DATABASE_PROVIDER: "turso",
          TURSO_DATABASE_URL: "http://203.0.113.10:8080",
          TURSO_AUTH_TOKEN: "token",
        }),
      ),
    ).toThrow();
  });
});

describe("server libSQL sendiri", () => {
  /** `sqld` di LAN lazim berjalan tanpa autentikasi sama sekali. */
  test("HTTP ke jaringan privat diterima tanpa token", () => {
    const config = resolveServerDatabaseConfig(
      env({
        SPPG_DATABASE_PROVIDER: "self_hosted",
        SPPG_DATABASE_URL: "http://192.168.1.10:8080",
      }),
    );
    expect(config.isRemote).toBe(true);
    expect(config.provider).toBe("self_hosted");
    expect(config.authToken).toBeUndefined();
  });

  /** HTTPS publik berarti terekspos internet: token satu-satunya penghalang. */
  test("HTTPS publik tanpa token ditolak di production", () => {
    expect(() =>
      resolveServerDatabaseConfig(
        env({
          SPPG_DATABASE_PROVIDER: "self_hosted",
          SPPG_DATABASE_URL: "https://db.kantor-anda.com",
        }),
      ),
    ).toThrow(/TURSO_AUTH_TOKEN/);
  });

  test("HTTP ke alamat publik ditolak tanpa izin eksplisit", () => {
    expect(() =>
      resolveServerDatabaseConfig(
        env({
          SPPG_DATABASE_PROVIDER: "self_hosted",
          SPPG_DATABASE_URL: "http://203.0.113.10:8080",
          SPPG_DATABASE_AUTH_TOKEN: "token",
        }),
      ),
    ).toThrow();
  });

  test("HTTP ke alamat publik diterima setelah izin eksplisit dinyatakan", () => {
    const config = resolveServerDatabaseConfig(
      env({
        SPPG_DATABASE_PROVIDER: "self_hosted",
        SPPG_DATABASE_URL: "http://203.0.113.10:8080",
        SPPG_DATABASE_AUTH_TOKEN: "token",
        SPPG_ALLOW_INSECURE_DATABASE: "1",
      }),
    );
    expect(config.isRemote).toBe(true);
  });
});

describe("nilai bawaan dan alias", () => {
  test("provider yang tidak dikenal jatuh ke aturan paling ketat", () => {
    // Turso menuntut HTTPS dan token, sehingga tebakan yang salah menolak —
    // bukan meloloskan.
    expect(() =>
      resolveServerDatabaseConfig(
        env({
          SPPG_DATABASE_PROVIDER: "postgres",
          SPPG_DATABASE_URL: "http://192.168.1.10:8080",
        }),
      ),
    ).toThrow();
  });

  test("alias SPPG_DATABASE_URL setara dengan TURSO_DATABASE_URL", () => {
    const config = resolveServerDatabaseConfig(
      env({
        SPPG_DATABASE_URL: "libsql://db.turso.io",
        SPPG_DATABASE_AUTH_TOKEN: "token",
      }),
    );
    expect(config.url).toBe("libsql://db.turso.io");
    expect(config.authToken).toBe("token");
  });

  /**
   * Pemasangan baru memakai nama `KOS_*`. Nama itu harus MENANG, bukan sekadar
   * dibaca: `.env` yang masih menyimpan nama lama di samping nama baru tidak
   * boleh diam-diam menunjuk ke database yang lama.
   */
  test("KOS_* menang atas TURSO_* dan SPPG_*", () => {
    const config = resolveServerDatabaseConfig(
      env({
        KOS_DATABASE_URL: "http://192.168.1.10:8080",
        KOS_DATABASE_AUTH_TOKEN: "token-baru",
        KOS_DATABASE_PROVIDER: "self_hosted",
        TURSO_DATABASE_URL: "libsql://lama.turso.io",
        TURSO_AUTH_TOKEN: "token-lama",
        SPPG_DATABASE_URL: "libsql://lebih-lama.turso.io",
        SPPG_DATABASE_PROVIDER: "turso",
      }),
    );
    expect(config.url).toBe("http://192.168.1.10:8080");
    expect(config.authToken).toBe("token-baru");
    expect(config.provider).toBe("self_hosted");
  });

  test("KOS_ALLOW_INSECURE_DATABASE dibaca seperti nama lamanya", () => {
    const publik = {
      KOS_DATABASE_URL: "http://203.0.113.10:8080",
      KOS_DATABASE_PROVIDER: "self_hosted",
      KOS_DATABASE_AUTH_TOKEN: "token",
    };
    expect(() => resolveServerDatabaseConfig(env(publik))).toThrow(
      "Alamat database tidak dapat dipakai",
    );
    expect(
      resolveServerDatabaseConfig(
        env({ ...publik, KOS_ALLOW_INSECURE_DATABASE: "1" }),
      ).url,
    ).toBe("http://203.0.113.10:8080");
  });

  test("URL kosong ditolak di production", () => {
    expect(() => resolveServerDatabaseConfig(env({}))).toThrow(
      /wajib tersedia/,
    );
  });

  /**
   * Fallback berkas lokal SENGAJA hanya untuk pengembangan. Ia tidak melewati
   * pemeriksaan alamat karena memang bukan alamat — dan itulah alasan ia tidak
   * boleh pernah aktif di production.
   */
  test("tanpa URL di pengembangan memakai berkas lokal", () => {
    const config = resolveServerDatabaseConfig({ NODE_ENV: "development" });
    expect(config.url.startsWith("file:")).toBe(true);
    expect(config.isRemote).toBe(false);
  });
});

/**
 * `databaseConfigIssue` adalah `resolveServerDatabaseConfig` yang ditanya tanpa
 * melempar. Pesannya tampil di halaman login dan `/setup` SEBELUM siapa pun
 * login, jadi ia tidak boleh memuat nilai alamat atau token.
 */
describe("databaseConfigIssue", () => {
  test("konfigurasi yang sah tidak punya masalah", () => {
    expect(
      databaseConfigIssue(
        env({
          KOS_DATABASE_URL: "libsql://db.turso.io",
          KOS_DATABASE_AUTH_TOKEN: "token",
        }),
      ),
    ).toBeNull();
    // Pengembangan tanpa URL jatuh ke berkas lokal, bukan salah konfigurasi.
    expect(databaseConfigIssue({ NODE_ENV: "development" })).toBeNull();
  });

  test("production tanpa alamat menyebut variabel yang kurang", () => {
    expect(databaseConfigIssue(env({}))).toContain("KOS_DATABASE_URL");
  });

  test("pesan tidak pernah memuat nilai alamat atau token", () => {
    const alamat = "http://203.0.113.10:8080";
    const token = "token-sangat-rahasia";
    const kasus = [
      env({ KOS_DATABASE_URL: "libsql://db-rahasia.turso.io" }),
      env({
        KOS_DATABASE_URL: alamat,
        KOS_DATABASE_PROVIDER: "self_hosted",
        KOS_DATABASE_AUTH_TOKEN: token,
      }),
      env({
        KOS_DATABASE_URL: "libsql://db-rahasia.turso.io",
        KOS_DATABASE_AUTH_TOKEN: token,
        KOS_DATABASE_PROVIDER: "local_file",
      }),
    ];
    for (const lingkungan of kasus) {
      const masalah = databaseConfigIssue(lingkungan);
      expect(masalah).not.toBeNull();
      expect(masalah).not.toContain("db-rahasia");
      expect(masalah).not.toContain("203.0.113.10");
      expect(masalah).not.toContain(token);
    }
  });
});
