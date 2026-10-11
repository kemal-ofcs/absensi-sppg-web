import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { type Client, createClient } from "@libsql/client";
import { NextRequest } from "next/server";
import { initDatabaseSchema } from "@/lib/db-schema";

let client: Client;
let databaseTouched = 0;

mock.module("server-only", () => ({}));
mock.module("@/lib/server/db", () => ({
  getServerDatabase: () => {
    databaseTouched += 1;
    return client;
  },
  ensureServerDatabaseInitialized: async () => {},
}));

const { POST } = await import("@/app/api/auth/provisioning-status/route");

/** Variabel yang menentukan database; `bun test` memuat `.env` workspace ini. */
const DATABASE_KEYS = [
  "KOS_DATABASE_URL",
  "KOS_DATABASE_AUTH_TOKEN",
  "KOS_DATABASE_PROVIDER",
  "TURSO_DATABASE_URL",
  "TURSO_AUTH_TOKEN",
  "SPPG_DATABASE_URL",
  "SPPG_DATABASE_AUTH_TOKEN",
  "SPPG_DATABASE_PROVIDER",
  "NODE_ENV",
] as const;
const environment = process.env as Record<string, string | undefined>;
let saved: Record<string, string | undefined> = {};

function tanya(origin = "http://localhost") {
  return POST(
    new NextRequest("http://localhost/api/auth/provisioning-status", {
      method: "POST",
      headers: { origin, host: "localhost" },
    }),
  );
}

beforeAll(async () => {
  client = createClient({ url: "file::memory:" });
  await initDatabaseSchema(client);
});

beforeEach(async () => {
  saved = Object.fromEntries(
    DATABASE_KEYS.map((key) => [key, environment[key]]),
  );
  for (const key of DATABASE_KEYS) delete environment[key];
  databaseTouched = 0;
  await client.execute("DELETE FROM master_operator;");
});

afterEach(() => {
  for (const key of DATABASE_KEYS) {
    if (saved[key] === undefined) delete environment[key];
    else environment[key] = saved[key];
  }
});

afterAll(() => client.close());

describe("POST /api/auth/provisioning-status", () => {
  test("alamat database belum diisi: dilaporkan tanpa menyentuh database", async () => {
    environment.NODE_ENV = "production";
    const body = await (await tanya()).json();
    expect(body).toMatchObject({
      sukses: true,
      hasOperator: null,
      databaseConfigured: false,
    });
    expect(body.databaseIssue).toContain("KOS_DATABASE_URL");
    expect(databaseTouched).toBe(0);
  });

  test("token wajib tetapi kosong juga dihitung belum dikonfigurasi", async () => {
    environment.NODE_ENV = "production";
    environment.KOS_DATABASE_URL = "libsql://contoh-rahasia.turso.io";
    const body = await (await tanya()).json();
    expect(body.databaseConfigured).toBe(false);
    expect(body.databaseIssue).toContain("KOS_DATABASE_AUTH_TOKEN");
    // Yang disebut hanya nama variabel, bukan alamatnya.
    expect(body.databaseIssue).not.toContain("contoh-rahasia");
    expect(databaseTouched).toBe(0);
  });

  test("database terkonfigurasi dan masih kosong: belum ada akun", async () => {
    const body = await (await tanya()).json();
    expect(body).toMatchObject({
      hasOperator: false,
      databaseConfigured: true,
      databaseIssue: null,
    });
    expect(databaseTouched).toBe(1);
  });

  test("tabel belum ada tetap berarti belum ada akun, bukan belum dikonfigurasi", async () => {
    const kosong = createClient({ url: "file::memory:" });
    const asli = client;
    client = kosong;
    try {
      const body = await (await tanya()).json();
      expect(body).toMatchObject({
        hasOperator: false,
        databaseConfigured: true,
      });
    } finally {
      client = asli;
      kosong.close();
    }
  });

  test("origin lain ditolak", async () => {
    expect((await tanya("https://penyerang.example")).status).toBe(403);
  });
});
