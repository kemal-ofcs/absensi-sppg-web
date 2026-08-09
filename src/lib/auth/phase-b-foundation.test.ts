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
});
