import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type Client, createClient } from "@libsql/client";
import { runDatabaseMigrations } from "@/lib/db-migrations";
import { CURRENT_SCHEMA_VERSION, initDatabaseSchema } from "@/lib/db-schema";
import { insertOperator } from "@/lib/operators/operator-admin";

/**
 * Penjagaan constraint untuk schema versi 12 (verifikasi dua langkah).
 *
 * Kelas kesalahan yang diuji di sini sama dengan yang pernah nyaris merusak
 * pemasangan berjalan pada versi 11: kolom baru yang `NOT NULL` tanpa nilai
 * bawaan, indeks yang dibuat sebelum kolomnya ada, dan database lama yang
 * tidak tersembuhkan oleh migrasi.
 */

let client: Client;

beforeEach(() => {
  client = createClient({ url: "file::memory:" });
});

afterEach(() => client.close());

async function seedOperator(kode: string, username: string) {
  const roles = await client.execute(
    "SELECT id FROM app_role WHERE role_key = 'operator' LIMIT 1;",
  );
  const result = await insertOperator(client, {
    kodeOperator: kode,
    name: `Operator ${kode}`,
    username,
    email: `${username}@sppg.id`,
    noHp: "081200000001",
    password: "PasswordUjiKuat1",
    roleId: Number(roles.rows[0]?.id),
    status: "Aktif",
  });
  return result.id;
}

describe("kolom 2FA pada master_operator", () => {
  test("operator baru lahir dengan 2FA mati, bukan NULL", async () => {
    await initDatabaseSchema(client);
    const id = await seedOperator("OPS12A", "uji12a");
    const row = await client.execute({
      sql: "SELECT totp_secret, totp_enabled, totp_confirmed_at, totp_recovery_codes FROM master_operator WHERE id = ?;",
      args: [id],
    });
    // `totp_enabled` NOT NULL DEFAULT 0: kode di seluruh aplikasi membaca
    // kolom ini sebagai boolean, jadi NULL akan menjadi keadaan ketiga yang
    // tidak pernah ditangani siapa pun.
    expect(Number(row.rows[0]?.totp_enabled)).toBe(0);
    expect(row.rows[0]?.totp_secret).toBeNull();
    expect(row.rows[0]?.totp_confirmed_at).toBeNull();
    expect(row.rows[0]?.totp_recovery_codes).toBeNull();
  });

  test("totp_enabled menolak NULL", async () => {
    await initDatabaseSchema(client);
    const id = await seedOperator("OPS12B", "uji12b");
    await expect(
      client.execute({
        sql: "UPDATE master_operator SET totp_enabled = NULL WHERE id = ?;",
        args: [id],
      }),
    ).rejects.toThrow("NOT NULL");
  });

  test("menghapus operator ikut membuang rahasia 2FA-nya", async () => {
    await initDatabaseSchema(client);
    const id = await seedOperator("OPS12C", "uji12c");
    await client.execute({
      sql: "UPDATE master_operator SET totp_secret = 'RAHASIA', totp_enabled = 1 WHERE id = ?;",
      args: [id],
    });
    await client.execute({
      sql: "DELETE FROM master_operator WHERE id = ?;",
      args: [id],
    });
    const sisa = await client.execute(
      "SELECT COUNT(*) AS total FROM master_operator WHERE totp_secret IS NOT NULL;",
    );
    expect(Number(sisa.rows[0]?.total)).toBe(0);
  });
});

describe("app_role.require_totp", () => {
  test("role bawaan lahir tanpa kewajiban 2FA", async () => {
    await initDatabaseSchema(client);
    const rows = await client.execute(
      "SELECT role_key, require_totp FROM app_role;",
    );
    expect(rows.rows.length).toBeGreaterThan(0);
    for (const row of rows.rows) {
      // Menyalakannya secara bawaan akan mengunci setiap operator yang sudah
      // ada dari akunnya sendiri pada saat migrasi berjalan.
      expect(Number(row.require_totp)).toBe(0);
    }
  });

  test("require_totp menolak NULL", async () => {
    await initDatabaseSchema(client);
    await expect(
      client.execute("UPDATE app_role SET require_totp = NULL;"),
    ).rejects.toThrow("NOT NULL");
  });
});

describe("migrasi database versi 11 ke versi 12", () => {
  /**
   * Database yang sudah berjalan pada versi 11 tidak punya satu pun kolom 2FA.
   * Migrasi wajib menambahkannya tanpa merusak baris operator dan role yang
   * sudah ada — termasuk mengisi nilai bawaan untuk kolom `NOT NULL`.
   */
  test("menambah seluruh kolom 2FA pada database lama tanpa kehilangan data", async () => {
    await initDatabaseSchema(client);
    const id = await seedOperator("OLD12", "lama12");
    await client.execute(
      "UPDATE app_role SET require_totp = 1 WHERE role_key = 'admin';",
    );

    // Kembalikan ke bentuk versi 11.
    for (const column of [
      "totp_secret",
      "totp_enabled",
      "totp_confirmed_at",
      "totp_recovery_codes",
    ]) {
      await client.execute(
        `ALTER TABLE master_operator DROP COLUMN ${column};`,
      );
    }
    await client.execute("ALTER TABLE app_role DROP COLUMN require_totp;");
    await client.execute("DELETE FROM schema_migration WHERE version = 12;");

    const sebelum = await client.execute("PRAGMA table_info(master_operator);");
    expect(sebelum.rows.map((row) => String(row.name))).not.toContain(
      "totp_secret",
    );

    await runDatabaseMigrations(client);

    const kolomOperator = (
      await client.execute("PRAGMA table_info(master_operator);")
    ).rows.map((row) => String(row.name));
    for (const column of [
      "totp_secret",
      "totp_enabled",
      "totp_confirmed_at",
      "totp_recovery_codes",
    ]) {
      expect(kolomOperator).toContain(column);
    }
    const kolomRole = (
      await client.execute("PRAGMA table_info(app_role);")
    ).rows.map((row) => String(row.name));
    expect(kolomRole).toContain("require_totp");

    // Baris lama tetap utuh, dan kolom NOT NULL terisi nilai bawaan — bukan
    // NULL yang akan menjatuhkan setiap pembacaan setelahnya.
    const operator = await client.execute({
      sql: "SELECT kode_operator, totp_enabled FROM master_operator WHERE id = ?;",
      args: [id],
    });
    expect(operator.rows[0]?.kode_operator).toBe("OLD12");
    expect(Number(operator.rows[0]?.totp_enabled)).toBe(0);

    const role = await client.execute(
      "SELECT require_totp FROM app_role WHERE role_key = 'admin';",
    );
    expect(Number(role.rows[0]?.require_totp)).toBe(0);
  });

  test("versi skema tercatat dan cocok dengan konstanta aplikasi", async () => {
    await initDatabaseSchema(client);
    const row = await client.execute(
      "SELECT MAX(version) AS version FROM schema_migration;",
    );
    // Drift di sini membuat klien menolak sinkronisasi dengan pesan
    // "aplikasi perlu diperbarui" yang menyesatkan.
    expect(Number(row.rows[0]?.version)).toBe(CURRENT_SCHEMA_VERSION);
  });
});
