import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type Client, createClient } from "@libsql/client";
import { initDatabaseSchema } from "@/lib/db-schema";
import { bootstrapSuperadmin } from "@/lib/operators/operator-admin";

let client: Client;

beforeAll(async () => {
  client = createClient({ url: "file::memory:" });
  await initDatabaseSchema(client);
});

afterAll(() => client.close());

describe("superadmin bootstrap", () => {
  test("membuat satu Superadmin dan menutup bootstrap berikutnya", async () => {
    const result = await bootstrapSuperadmin(client, {
      kodeOperator: "SPD001",
      name: "Pemilik Aplikasi",
      username: "pemilik",
      password: "BootstrapKuat123",
      status: "Aktif",
    });
    expect(result.id).toBeGreaterThan(0);

    const record = await client.execute(`
      SELECT m.kode_operator, r.role_key
      FROM master_operator m JOIN app_role r ON r.id = m.role_id
      WHERE m.id = ${result.id};
    `);
    expect(record.rows[0]).toMatchObject({
      kode_operator: "SPD001",
      role_key: "superadmin",
    });

    await expect(
      bootstrapSuperadmin(client, {
        kodeOperator: "SPD001",
        name: "Pemilik Kedua",
        username: "pemilik-kedua",
        password: "BootstrapKedua456",
        status: "Aktif",
      }),
    ).rejects.toThrow("Superadmin aktif sudah tersedia");
  });
});
