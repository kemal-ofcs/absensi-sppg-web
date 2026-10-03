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

mock.module("server-only", () => ({}));
mock.module("@/lib/server/db", () => ({
  getServerDatabase: () => client,
  ensureServerDatabaseInitialized: async () => {},
}));

const { POST } = await import("@/app/api/auth/bootstrap/route");
const { invalidateLicenseCache } = await import("@/lib/server/license");

const TOKEN = "k7Qm2vXw9Lr4Tz8Bn1Hc6Yd3Fs5Gj0Pa";
const DRAFT = {
  setupToken: TOKEN,
  namaOperator: "Pemilik Sekolah",
  username: "pemilik.sekolah",
  email: "pemilik@sekolah.id",
  noHp: "081234567890",
  password: "Aman-Sekali-2026!",
};

function kirim(body: unknown, origin = "http://localhost") {
  return POST(
    new NextRequest("http://localhost/api/auth/bootstrap", {
      method: "POST",
      headers: {
        origin,
        host: "localhost",
        "content-type": "application/json",
        "x-forwarded-for": "203.0.113.7",
      },
      body: JSON.stringify(body),
    }),
  );
}

async function jumlahOperator() {
  const result = await client.execute(
    "SELECT COUNT(*) AS total FROM master_operator;",
  );
  return Number(result.rows[0]?.total);
}

beforeAll(async () => {
  client = createClient({ url: "file::memory:" });
  await initDatabaseSchema(client);
});

beforeEach(async () => {
  process.env.KOS_SETUP_TOKEN = TOKEN;
  delete process.env.KOS_LICENSE_ENFORCED;
  invalidateLicenseCache();
  await client.batch(
    [
      "DELETE FROM master_operator;",
      "DELETE FROM app_bootstrap_state;",
      "DELETE FROM auth_login_rate_limit;",
      "DELETE FROM setting_gex_system WHERE key IN ('app_license', 'web_instance_id');",
    ],
    "write",
  );
});

afterAll(() => {
  delete process.env.KOS_SETUP_TOKEN;
  delete process.env.KOS_LICENSE_ENFORCED;
  client.close();
});

describe("POST /api/auth/bootstrap", () => {
  test("tanpa KOS_SETUP_TOKEN endpoint tertutup", async () => {
    delete process.env.KOS_SETUP_TOKEN;
    const response = await kirim(DRAFT);
    expect(response.status).toBe(404);
    expect(await jumlahOperator()).toBe(0);
  });

  test("token yang terlalu pendek tidak membuka endpoint, walau cocok", async () => {
    process.env.KOS_SETUP_TOKEN = "pendek";
    const response = await kirim({ ...DRAFT, setupToken: "pendek" });
    expect(response.status).toBe(404);
    expect(await jumlahOperator()).toBe(0);
  });

  test("origin lain ditolak", async () => {
    const response = await kirim(DRAFT, "https://penyerang.example");
    expect(response.status).toBe(403);
    expect(await jumlahOperator()).toBe(0);
  });

  test("token salah ditolak tanpa membocorkan pesan validasi", async () => {
    const response = await kirim({
      ...DRAFT,
      setupToken: "x".repeat(40),
      password: "lemah",
    });
    expect(response.status).toBe(403);
    expect((await response.json()).pesan).toBe("Token pemasangan tidak cocok.");
    expect(await jumlahOperator()).toBe(0);
  });

  test("kolom asing ditolak", async () => {
    const response = await kirim({ ...DRAFT, roleId: 1 });
    expect(response.status).toBe(400);
    expect(await jumlahOperator()).toBe(0);
  });

  test("token benar membuat Superadmin sekali, lalu tertutup", async () => {
    const pertama = await kirim(DRAFT);
    expect(pertama.status).toBe(201);
    const body = await pertama.json();
    expect(body.recoveryCodes).toHaveLength(8);
    expect(await jumlahOperator()).toBe(1);

    const kedua = await kirim({ ...DRAFT, username: "orang.lain" });
    expect(kedua.status).toBe(400);
    expect((await kedua.json()).pesan).toContain(
      "Superadmin aktif sudah tersedia",
    );
    expect(await jumlahOperator()).toBe(1);
  });

  // Jalur lisensi yang SAH diuji di `license.test.ts` dengan kunci uji; kunci
  // privat produk tidak ada di repo, jadi di sini hanya penolakannya.
  test("build terkunci: tanpa lisensi tidak ada Superadmin yang dibuat", async () => {
    process.env.KOS_LICENSE_ENFORCED = "1";
    const response = await kirim(DRAFT);
    expect(response.status).toBe(400);
    expect((await response.json()).pesan).toContain("Teks lisensi wajib diisi");
    expect(await jumlahOperator()).toBe(0);
  });

  test("build terkunci: lisensi yang tidak sah ditolak sebelum akun dibuat", async () => {
    process.env.KOS_LICENSE_ENFORCED = "1";
    const response = await kirim({ ...DRAFT, license: "LIS1.palsu.palsu" });
    expect(response.status).toBe(400);
    expect((await response.json()).pesan).toContain("Lisensi tidak sah");
    expect(await jumlahOperator()).toBe(0);
  });

  test("build terkunci: pesan lisensi tidak sampai ke orang tanpa token", async () => {
    process.env.KOS_LICENSE_ENFORCED = "1";
    const response = await kirim({ ...DRAFT, setupToken: "x".repeat(40) });
    expect(response.status).toBe(403);
    expect((await response.json()).pesan).toBe("Token pemasangan tidak cocok.");
  });

  describe("database belum dikonfigurasi", () => {
    const environment = process.env as Record<string, string | undefined>;
    const kunci = [
      "KOS_DATABASE_URL",
      "TURSO_DATABASE_URL",
      "SPPG_DATABASE_URL",
      "NODE_ENV",
    ];
    let tersimpan: Record<string, string | undefined> = {};

    beforeEach(() => {
      tersimpan = Object.fromEntries(kunci.map((k) => [k, environment[k]]));
      for (const k of kunci) delete environment[k];
      environment.NODE_ENV = "production";
    });

    afterEach(() => {
      for (const k of kunci) {
        if (tersimpan[k] === undefined) delete environment[k];
        else environment[k] = tersimpan[k];
      }
    });

    test("pemegang token diberi tahu apa yang kurang", async () => {
      const response = await kirim(DRAFT);
      expect(response.status).toBe(503);
      expect((await response.json()).pesan).toContain(
        "Server belum terhubung ke database",
      );
      expect(await jumlahOperator()).toBe(0);
    });

    test("tanpa token yang benar, jawabannya tetap soal token", async () => {
      const response = await kirim({ ...DRAFT, setupToken: "x".repeat(40) });
      expect(response.status).toBe(403);
      expect((await response.json()).pesan).toBe(
        "Token pemasangan tidak cocok.",
      );
    });
  });

  test("penebak token dikunci, dan token benar pun menunggu", async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await kirim({
        ...DRAFT,
        setupToken: `tebakan-${attempt}`.padEnd(40, "x"),
      });
    }
    const terkunci = await kirim(DRAFT);
    expect(terkunci.status).toBe(429);
    expect(terkunci.headers.get("Retry-After")).not.toBeNull();
    expect(await jumlahOperator()).toBe(0);
  });

  test("pemegang token tidak terkunci oleh salah isi form", async () => {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const response = await kirim({ ...DRAFT, password: "lemah" });
      expect(response.status).toBe(400);
    }
    expect((await kirim(DRAFT)).status).toBe(201);
  });
});
