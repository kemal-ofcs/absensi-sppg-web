import { describe, expect, test } from "bun:test";
import {
  createOpaqueSessionToken,
  hashSessionToken,
} from "@/lib/auth/session-token";
import { getWebSessionCookieOptions } from "@/lib/auth/web-session";
import { resolveServerDatabaseConfig } from "@/lib/server/database-config";

describe("Phase B web security foundation", () => {
  test("token session acak tidak disimpan sebagai nilai asli", async () => {
    const first = createOpaqueSessionToken();
    const second = createOpaqueSessionToken();

    expect(first).not.toBe(second);
    expect(first.length).toBeGreaterThanOrEqual(40);
    expect(await hashSessionToken(first)).toHaveLength(64);
    expect(await hashSessionToken(first)).not.toBe(first);
  });

  test("cookie session bersifat HttpOnly dan Secure pada production", () => {
    expect(getWebSessionCookieOptions(true)).toMatchObject({
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
    });
  });

  test("database server tidak menerima fallback environment publik", () => {
    const publicOnlyEnvironment = {
      NODE_ENV: "production",
      NEXT_PUBLIC_TURSO_DATABASE_URL: "libsql://public.example.invalid",
      NEXT_PUBLIC_TURSO_AUTH_TOKEN: "public-token",
    };

    expect(() => resolveServerDatabaseConfig(publicOnlyEnvironment)).toThrow(
      "TURSO_DATABASE_URL wajib tersedia",
    );
  });

  test("development tanpa Turso memakai SQLite lokal", () => {
    expect(resolveServerDatabaseConfig({ NODE_ENV: "development" })).toEqual({
      url: "file:local-app.db",
      isRemote: false,
      provider: "turso",
    });
  });

  test("database remote production wajib memiliki token server", () => {
    expect(() =>
      resolveServerDatabaseConfig({
        NODE_ENV: "production",
        TURSO_DATABASE_URL: "libsql://secure.example.invalid",
      }),
    ).toThrow("TURSO_AUTH_TOKEN wajib tersedia");
  });

  test("server database sendiri di jaringan privat boleh tanpa token", () => {
    expect(
      resolveServerDatabaseConfig({
        NODE_ENV: "production",
        TURSO_DATABASE_URL: "http://192.168.1.10:8080",
        SPPG_DATABASE_PROVIDER: "self_hosted",
      }),
    ).toEqual({
      url: "http://192.168.1.10:8080",
      authToken: undefined,
      isRemote: true,
      provider: "self_hosted",
    });
  });

  test("server database sendiri ber-HTTPS publik tetap wajib token", () => {
    expect(() =>
      resolveServerDatabaseConfig({
        NODE_ENV: "production",
        TURSO_DATABASE_URL: "https://db.kantor-anda.invalid",
        SPPG_DATABASE_PROVIDER: "self_hosted",
      }),
    ).toThrow("TURSO_AUTH_TOKEN wajib tersedia");
  });

  test("HTTP polos ke alamat publik ditolak sampai diizinkan eksplisit", () => {
    const insecureEnvironment = {
      NODE_ENV: "production",
      TURSO_DATABASE_URL: "http://203.0.113.10:8080",
      TURSO_AUTH_TOKEN: "token",
      SPPG_DATABASE_PROVIDER: "self_hosted",
    };

    expect(() => resolveServerDatabaseConfig(insecureEnvironment)).toThrow(
      "TURSO_DATABASE_URL tidak dapat dipakai",
    );
    expect(
      resolveServerDatabaseConfig({
        ...insecureEnvironment,
        SPPG_ALLOW_INSECURE_DATABASE: "1",
      }).isRemote,
    ).toBe(true);
  });

  test("provider tak dikenal tidak melonggarkan aturan Turso", () => {
    // Salah ketik pada variabel environment tidak boleh berubah menjadi izin
    // memakai HTTP polos; nilai asing wajib jatuh ke aturan paling ketat.
    expect(() =>
      resolveServerDatabaseConfig({
        NODE_ENV: "production",
        TURSO_DATABASE_URL: "http://203.0.113.10:8080",
        TURSO_AUTH_TOKEN: "token",
        SPPG_DATABASE_PROVIDER: "self-hostedd",
        SPPG_ALLOW_INSECURE_DATABASE: "1",
      }),
    ).toThrow("TURSO_DATABASE_URL tidak dapat dipakai");
  });
});
