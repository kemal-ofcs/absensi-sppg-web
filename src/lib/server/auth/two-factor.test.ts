import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { type Client, createClient } from "@libsql/client";
import { initDatabaseSchema } from "@/lib/db-schema";
import { insertOperator } from "@/lib/operators/operator-admin";
import { generateTotp } from "@/lib/security/totp";

mock.module("server-only", () => ({}));

const {
  beginTwoFactorSetup,
  confirmTwoFactorSetup,
  disableTwoFactor,
  evaluateTwoFactorGate,
  getTwoFactorStatus,
} = await import("@/lib/server/auth/two-factor");

let client: Client;
let operatorId: number;

/** Kode yang sah untuk detik ini, dihitung dari jam database yang sama. */
async function currentCode(secret: string) {
  const row = await client.execute(
    "SELECT CAST(strftime('%s','now') AS INTEGER) AS now;",
  );
  return generateTotp(secret, Number(row.rows[0]?.now));
}

async function enrolled() {
  const setup = await beginTwoFactorSetup(client, operatorId);
  const { recoveryCodes } = await confirmTwoFactorSetup(
    client,
    operatorId,
    await currentCode(setup.secret),
  );
  return { secret: setup.secret, recoveryCodes };
}

beforeAll(async () => {
  client = createClient({ url: "file::memory:" });
  await initDatabaseSchema(client);
  const roles = await client.execute(
    "SELECT id FROM app_role WHERE role_key = 'operator' LIMIT 1;",
  );
  const created = await insertOperator(client, {
    kodeOperator: "OPS2FA",
    name: "Operator 2FA",
    username: "operator2fa",
    email: "operator2fa@sppg.id",
    noHp: "081200000009",
    password: "PasswordUjiKuat1",
    roleId: Number(roles.rows[0]?.id),
    status: "Aktif",
  });
  operatorId = created.id;
});

beforeEach(async () => {
  await client.execute({
    sql: `
      UPDATE master_operator
      SET totp_secret = NULL, totp_enabled = 0, totp_confirmed_at = NULL,
          totp_recovery_codes = NULL
      WHERE id = ?;
    `,
    args: [operatorId],
  });
  await client.execute("UPDATE app_role SET require_totp = 0;");
});

afterAll(() => client.close());

describe("pendaftaran 2FA", () => {
  test("rahasia diterbitkan tetapi 2FA belum aktif sebelum dibuktikan", async () => {
    const setup = await beginTwoFactorSetup(client, operatorId);
    expect(setup.secret).toHaveLength(32);
    expect(setup.otpauthUri).toContain("otpauth://totp/");
    // Kalau aktif sejak sekarang, orang yang salah memindai QR akan terkunci
    // dari akunnya sendiri.
    expect((await getTwoFactorStatus(client, operatorId)).enabled).toBe(false);
  });

  test("kode yang benar mengaktifkan 2FA dan menerbitkan kode cadangan", async () => {
    const setup = await beginTwoFactorSetup(client, operatorId);
    const { recoveryCodes } = await confirmTwoFactorSetup(
      client,
      operatorId,
      await currentCode(setup.secret),
    );
    expect(recoveryCodes).toHaveLength(8);

    const status = await getTwoFactorStatus(client, operatorId);
    expect(status.enabled).toBe(true);
    expect(status.recoveryRemaining).toBe(8);
  });

  test("kode cadangan disimpan sebagai hash, bukan apa adanya", async () => {
    const { recoveryCodes } = await enrolled();
    const row = await client.execute({
      sql: "SELECT totp_recovery_codes FROM master_operator WHERE id = ?;",
      args: [operatorId],
    });
    const stored = String(row.rows[0]?.totp_recovery_codes);
    // Kebocoran database tidak boleh langsung menyerahkan jalan masuk kedua.
    for (const code of recoveryCodes) {
      expect(stored).not.toContain(code.replace("-", ""));
      expect(stored).not.toContain(code);
    }
  });

  test("kode yang salah tidak mengaktifkan apa pun", async () => {
    await beginTwoFactorSetup(client, operatorId);
    await expect(
      confirmTwoFactorSetup(client, operatorId, "000000"),
    ).rejects.toThrow("tidak cocok");
    expect((await getTwoFactorStatus(client, operatorId)).enabled).toBe(false);
  });

  test("mendaftar ulang saat 2FA masih aktif ditolak", async () => {
    await enrolled();
    await expect(beginTwoFactorSetup(client, operatorId)).rejects.toThrow(
      "sudah aktif",
    );
  });
});

describe("gerbang 2FA saat login", () => {
  test("akun tanpa 2FA lewat tanpa diminta apa pun", async () => {
    expect(await evaluateTwoFactorGate(client, operatorId, undefined)).toEqual({
      outcome: "not_required",
    });
  });

  test("akun ber-2FA tanpa kode diminta memasukkan kode", async () => {
    await enrolled();
    expect(await evaluateTwoFactorGate(client, operatorId, undefined)).toEqual({
      outcome: "code_required",
    });
    expect(await evaluateTwoFactorGate(client, operatorId, "   ")).toEqual({
      outcome: "code_required",
    });
  });

  test("kode autentikator yang benar diterima", async () => {
    const { secret } = await enrolled();
    expect(
      await evaluateTwoFactorGate(
        client,
        operatorId,
        await currentCode(secret),
      ),
    ).toEqual({ outcome: "accepted" });
  });

  test("kode yang salah ditolak", async () => {
    await enrolled();
    expect(await evaluateTwoFactorGate(client, operatorId, "000000")).toEqual({
      outcome: "code_invalid",
    });
  });

  test("kode cadangan diterima dan hanya bisa dipakai sekali", async () => {
    const { recoveryCodes } = await enrolled();
    const code = recoveryCodes[0] as string;
    expect(await evaluateTwoFactorGate(client, operatorId, code)).toEqual({
      outcome: "accepted",
    });
    // Sekali pakai berarti sekali pakai, dan penghapusannya terjadi pada
    // percobaan yang berhasil itu juga.
    expect(await evaluateTwoFactorGate(client, operatorId, code)).toEqual({
      outcome: "code_invalid",
    });
    expect(
      (await getTwoFactorStatus(client, operatorId)).recoveryRemaining,
    ).toBe(7);
  });

  test("role yang mewajibkan 2FA menahan operator yang belum mendaftar", async () => {
    await client.execute("UPDATE app_role SET require_totp = 1;");
    expect(await evaluateTwoFactorGate(client, operatorId, undefined)).toEqual({
      outcome: "enrollment_required",
    });
  });
});

describe("mematikan 2FA", () => {
  test("operator sendiri wajib membuktikan dengan kode", async () => {
    const { secret } = await enrolled();
    await expect(
      disableTwoFactor(client, operatorId, {
        requireProof: true,
        code: "000000",
      }),
    ).rejects.toThrow("tidak cocok");
    // Tanpa syarat ini, siapa pun yang menumpang sesi terbuka bisa melucuti
    // lapisan kedua itu.
    expect((await getTwoFactorStatus(client, operatorId)).enabled).toBe(true);

    await disableTwoFactor(client, operatorId, {
      requireProof: true,
      code: await currentCode(secret),
    });
    expect((await getTwoFactorStatus(client, operatorId)).enabled).toBe(false);
  });

  test("Admin dapat mematikannya tanpa kode untuk operator yang kehilangan ponsel", async () => {
    await enrolled();
    await disableTwoFactor(client, operatorId, { requireProof: false });
    const status = await getTwoFactorStatus(client, operatorId);
    expect(status.enabled).toBe(false);
    expect(status.recoveryRemaining).toBe(0);
  });

  test("rahasia benar-benar dihapus, bukan sekadar ditandai nonaktif", async () => {
    await enrolled();
    await disableTwoFactor(client, operatorId, { requireProof: false });
    const row = await client.execute({
      sql: "SELECT totp_secret FROM master_operator WHERE id = ?;",
      args: [operatorId],
    });
    expect(row.rows[0]?.totp_secret).toBeNull();
  });
});
