import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { type Client, createClient } from "@libsql/client";
import { hashSessionToken } from "@/lib/auth/session-token";
import { initDatabaseSchema } from "@/lib/db-schema";
import {
  type BootstrapSuperadminDraft,
  bootstrapSuperadmin,
  validateBootstrapDraft,
} from "@/lib/operators/operator-admin";
import { normalizeRecoveryCode } from "@/lib/security/totp";

let client: Client;

// Vektor yang sama dengan `bootstrap_requires_a_strong_non_default_password`
// di `turso.rs`. Mengubah satu sisi tanpa sisi lain membuat password yang
// diterima server ditolak aplikasi Desktop, atau sebaliknya.
const KUAT: BootstrapSuperadminDraft = {
  kodeOperator: "SPD001",
  name: "Pemilik Sekolah",
  username: "pemilik.sekolah",
  email: "Pemilik@Sekolah.id",
  noHp: "0812-3456-7890",
  password: "Aman-Sekali-2026!",
  status: "Aktif",
};

beforeAll(async () => {
  client = createClient({ url: "file::memory:" });
  await initDatabaseSchema(client);
});

beforeEach(async () => {
  await client.batch(
    ["DELETE FROM master_operator;", "DELETE FROM app_bootstrap_state;"],
    "write",
  );
});

afterAll(() => client.close());

describe("aturan draft Superadmin (cermin validate_bootstrap_draft)", () => {
  test("draft kuat diterima", () => {
    expect(() => validateBootstrapDraft(KUAT)).not.toThrow();
  });

  test("password lemah ditolak", () => {
    const lemah = [
      "admin123",
      "TanpaSimbol2026x",
      "tanpa-besar-2026!",
      "TANPA-KECIL-2026!",
      "Tanpa-Angka-Sama!",
      "Pemilik.Sekolah-2026!",
    ];
    for (const password of lemah) {
      expect(() => validateBootstrapDraft({ ...KUAT, password })).toThrow(
        "Password minimal 12 karakter",
      );
    }
  });

  test("kontak wajib, kode wajib SPD001", () => {
    expect(() => validateBootstrapDraft({ ...KUAT, email: "" })).toThrow(
      "Email operator wajib diisi.",
    );
    expect(() =>
      validateBootstrapDraft({ ...KUAT, kodeOperator: "SPD002" }),
    ).toThrow("wajib SPD001");
  });
});

describe("superadmin bootstrap", () => {
  test("membuat satu Superadmin, klaim, dan kode pemulihan", async () => {
    const result = await bootstrapSuperadmin(client, KUAT);
    expect(result.id).toBeGreaterThan(0);
    expect(result.recoveryCodes).toHaveLength(8);

    const record = await client.execute({
      sql: `
        SELECT m.kode_operator, m.email, m.no_hp, m.role, m.status,
               m.password_recovery_codes, r.role_key
        FROM master_operator m JOIN app_role r ON r.id = m.role_id
        WHERE m.id = ?;
      `,
      args: [result.id],
    });
    // Email dan nomor HP tersimpan dalam bentuk kanonik, bukan apa adanya:
    // pencarian akun pada "Lupa Password" mencocokkan bentuk kanonik itu.
    expect(record.rows[0]).toMatchObject({
      kode_operator: "SPD001",
      email: "pemilik@sekolah.id",
      no_hp: "+6281234567890",
      role: "Admin",
      status: "Aktif",
      role_key: "superadmin",
    });

    // Yang tersimpan hash-nya, dan hash itu cocok dengan kode yang dikembalikan:
    // kode yang dicetak di sini harus bisa dipakai memulihkan akun.
    const tersimpan = JSON.parse(
      String(record.rows[0]?.password_recovery_codes),
    ) as string[];
    expect(tersimpan).toEqual(
      await Promise.all(
        result.recoveryCodes.map((code) =>
          hashSessionToken(normalizeRecoveryCode(code)),
        ),
      ),
    );

    const klaim = await client.execute(
      "SELECT COUNT(*) AS total FROM app_bootstrap_state WHERE bootstrap_key = 'superadmin';",
    );
    expect(Number(klaim.rows[0]?.total)).toBe(1);

    await expect(
      bootstrapSuperadmin(client, {
        ...KUAT,
        name: "Pemilik Kedua",
        username: "pemilik-kedua",
        email: "kedua@sekolah.id",
      }),
    ).rejects.toThrow("Superadmin aktif sudah tersedia");
  });

  test("dua permintaan bersamaan: hanya satu yang menang", async () => {
    const hasil = await Promise.allSettled([
      bootstrapSuperadmin(client, KUAT),
      bootstrapSuperadmin(client, {
        ...KUAT,
        name: "Orang Lain",
        username: "orang.lain",
        email: "lain@sekolah.id",
      }),
    ]);
    expect(hasil.filter((item) => item.status === "fulfilled")).toHaveLength(1);

    const total = await client.execute(`
      SELECT COUNT(*) AS total
      FROM master_operator m JOIN app_role r ON r.id = m.role_id
      WHERE r.is_superadmin = 1;
    `);
    expect(Number(total.rows[0]?.total)).toBe(1);
  });

  test("klaim lama tanpa Superadmin aktif tetap menutup bootstrap", async () => {
    await client.execute(
      "INSERT INTO app_bootstrap_state (bootstrap_key, claimed_at) VALUES ('superadmin', datetime('now'));",
    );
    await expect(bootstrapSuperadmin(client, KUAT)).rejects.toThrow(
      "sudah pernah diklaim",
    );
    const total = await client.execute(
      "SELECT COUNT(*) AS total FROM master_operator;",
    );
    expect(Number(total.rows[0]?.total)).toBe(0);
  });
});
