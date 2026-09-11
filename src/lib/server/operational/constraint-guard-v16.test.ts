import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type Client, createClient } from "@libsql/client";
import { runDatabaseMigrations } from "@/lib/db-migrations";
import { CURRENT_SCHEMA_VERSION, initDatabaseSchema } from "@/lib/db-schema";

/**
 * Migrasi data schema versi 16 (aturan jam scan baru).
 *
 * Jam Kerja Normal dulu dihitung (Jam Pulang − Jam Masuk) − Istirahat +
 * Batas Masuk. Sekarang tanpa "+ Batas Masuk", dan nilai yang sudah tersimpan
 * dihitung ulang sekali. Vektornya sama dengan
 * `migrasi_v16_menghitung_ulang_jam_kerja_normal_sekali` di `turso.rs`, karena
 * database yang sama bisa dimigrasikan oleh jalur Web maupun Desktop.
 */

let client: Client;

beforeEach(() => {
  client = createClient({ url: "file::memory:" });
});

afterEach(() => client.close());

async function jamKerjaNormal(idShift: number): Promise<number> {
  const result = await client.execute({
    sql: "SELECT jam_kerja_normal_menit FROM tbl_shift WHERE id_shift = ?;",
    args: [idShift],
  });
  return Number(result.rows[0]?.jam_kerja_normal_menit);
}

describe("migrasi v16 jam kerja normal", () => {
  test("menghitung ulang shift reguler tanpa menyentuh penanda fleksibel", async () => {
    await initDatabaseSchema(client);
    await client.execute(`
      INSERT INTO tbl_shift (id_shift, kode_shift, nama_shift, jam_masuk, jam_pulang, jam_kerja_normal_menit, istirahat_menit) VALUES
        (1, 1, 'Pagi', '07:00', '15:00', 480, 60),
        (2, 2, 'Malam', '22:00:00', '06:00:00', 480, 60),
        (3, 3, 'Fleksibel', '00:00', '23:59', 1439, 0),
        (4, 4, 'Fleksibel Nol', '08:00', '17:00', 0, 60),
        (5, 5, 'Pendek', '07:00', '07:30', 30, 60);
    `);
    await client.execute("DELETE FROM schema_migration WHERE version = 16;");

    await runDatabaseMigrations(client);

    expect(await jamKerjaNormal(1)).toBe(420);
    expect(await jamKerjaNormal(2)).toBe(420);
    expect(await jamKerjaNormal(3)).toBe(1439);
    expect(await jamKerjaNormal(4)).toBe(0);
    expect(await jamKerjaNormal(5)).toBe(30);
  });

  test("hanya berjalan sekali", async () => {
    await initDatabaseSchema(client);
    await client.execute(`
      INSERT INTO tbl_shift (id_shift, kode_shift, nama_shift, jam_masuk, jam_pulang, jam_kerja_normal_menit, istirahat_menit)
      VALUES (1, 1, 'Pagi', '07:00', '15:00', 999, 60);
    `);

    // Versi 16 sudah tercatat oleh initDatabaseSchema, jadi nilai yang
    // ditulis sesudahnya tidak boleh ditimpa lagi.
    await runDatabaseMigrations(client);
    expect(await jamKerjaNormal(1)).toBe(999);
  });

  test("versi skema tercatat dan cocok dengan konstanta aplikasi", async () => {
    await initDatabaseSchema(client);
    const row = await client.execute(
      "SELECT MAX(version) AS version FROM schema_migration;",
    );
    expect(Number(row.rows[0]?.version)).toBe(CURRENT_SCHEMA_VERSION);
  });
});
