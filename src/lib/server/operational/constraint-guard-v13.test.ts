import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type Client, createClient } from "@libsql/client";
import { runDatabaseMigrations } from "@/lib/db-migrations";
import { CURRENT_SCHEMA_VERSION, initDatabaseSchema } from "@/lib/db-schema";

/**
 * Penjagaan constraint untuk schema versi 13 (keamanan absensi per role).
 *
 * Kelas kesalahan yang diuji sama dengan versi 11 dan 12: kolom baru `NOT NULL`
 * tanpa nilai bawaan, tabel yang hanya lahir di satu jalur provisioning, dan
 * database lama yang tidak tersembuhkan oleh migrasi. Ketiganya baru terlihat
 * di lapangan — setelah pemasangan berjalan gagal menyimpan absensi.
 */

let client: Client;

beforeEach(() => {
  client = createClient({ url: "file::memory:" });
});

afterEach(() => client.close());

describe("sakelar keamanan absensi pada app_role", () => {
  test("role bawaan lahir dengan kedua sakelar mati, bukan NULL", async () => {
    await initDatabaseSchema(client);
    const roles = await client.execute(
      "SELECT role_key, require_scan_photo, require_scan_ip_allowlist FROM app_role;",
    );
    expect(roles.rows.length).toBeGreaterThan(0);
    for (const row of roles.rows) {
      // Seluruh aplikasi membaca kolom ini sebagai boolean; NULL akan menjadi
      // keadaan ketiga yang tidak pernah ditangani siapa pun.
      expect(Number(row.require_scan_photo)).toBe(0);
      expect(Number(row.require_scan_ip_allowlist)).toBe(0);
    }
  });

  test("kedua kolom menolak NULL", async () => {
    await initDatabaseSchema(client);
    await expect(
      client.execute("UPDATE app_role SET require_scan_photo = NULL;"),
    ).rejects.toThrow("NOT NULL");
    await expect(
      client.execute("UPDATE app_role SET require_scan_ip_allowlist = NULL;"),
    ).rejects.toThrow("NOT NULL");
  });
});

describe("tabel absensi_foto", () => {
  test("dibuat jalur provisioning Web dengan seluruh kolomnya", async () => {
    await initDatabaseSchema(client);
    const columns = (
      await client.execute("PRAGMA table_info(absensi_foto);")
    ).rows.map((row) => String(row.name));
    // Daftar ini WAJIB identik dengan DDL `turso.rs` dan `storage.rs`. Satu
    // kolom yang hilang di salah satu sisi membuat push foto gagal permanen
    // pada database yang lahir dari jalur provisioning yang lain.
    expect(columns).toEqual([
      "id_foto",
      "id_sesi",
      "tanggal_kerja",
      "id_karyawan",
      "nama",
      "divisi",
      "jenis_scan",
      "timestamp_scan",
      "sumber_data",
      "kode_operator",
      "ip_perangkat",
      "client_id",
      "foto_mime",
      "foto_base64",
      "created_at",
    ]);
  });

  test("id_foto unik: event yang sama dikirim dua kali tidak menggandakan foto", async () => {
    await initDatabaseSchema(client);
    const insert = async () =>
      client.execute({
        sql: `INSERT INTO absensi_foto (
                id_foto, id_sesi, tanggal_kerja, id_karyawan, nama, divisi,
                jenis_scan, timestamp_scan, sumber_data, kode_operator,
                ip_perangkat, client_id, foto_mime, foto_base64, created_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(id_foto) DO NOTHING;`,
        args: [
          "klien-a:-1",
          "SESI-1",
          "2026-09-02",
          "K001",
          "Karyawan Uji",
          "Dapur",
          "Masuk",
          "2026-09-02 07:00:00",
          "Scanner",
          "SPD001",
          "192.168.1.20",
          "klien-a",
          "image/jpeg",
          "Zm90bw==",
          "2026-09-02 07:00:00",
        ],
      });
    await insert();
    await insert();
    const total = await client.execute(
      "SELECT COUNT(*) AS total FROM absensi_foto;",
    );
    expect(Number(total.rows[0]?.total)).toBe(1);
  });

  test("foto wajib punya isi: foto_base64 NOT NULL", async () => {
    await initDatabaseSchema(client);
    await expect(
      client.execute({
        sql: `INSERT INTO absensi_foto (
                id_foto, tanggal_kerja, id_karyawan, nama, jenis_scan,
                timestamp_scan, foto_base64, created_at
              ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?);`,
        args: [
          "klien-a:-2",
          "2026-09-02",
          "K001",
          "Karyawan Uji",
          "Masuk",
          "2026-09-02 07:00:00",
          "2026-09-02 07:00:00",
        ],
      }),
    ).rejects.toThrow("NOT NULL");
  });
});

describe("migrasi database versi 12 ke versi 13", () => {
  /**
   * Database yang sudah berjalan pada versi 12 tidak punya kolom sakelar
   * maupun tabel foto. Migrasi wajib menambahkan keduanya tanpa merusak baris
   * role yang sudah ada — termasuk mengisi nilai bawaan kolom `NOT NULL`.
   */
  test("menambah kolom dan tabel baru pada database lama tanpa kehilangan data", async () => {
    await initDatabaseSchema(client);
    await client.execute(
      "UPDATE app_role SET require_totp = 1 WHERE role_key = 'admin';",
    );

    // Kembalikan ke bentuk versi 12.
    await client.execute(
      "ALTER TABLE app_role DROP COLUMN require_scan_photo;",
    );
    await client.execute(
      "ALTER TABLE app_role DROP COLUMN require_scan_ip_allowlist;",
    );
    await client.execute("DROP TABLE absensi_foto;");
    await client.execute("DELETE FROM schema_migration WHERE version = 13;");

    await runDatabaseMigrations(client);

    const kolomRole = (
      await client.execute("PRAGMA table_info(app_role);")
    ).rows.map((row) => String(row.name));
    expect(kolomRole).toContain("require_scan_photo");
    expect(kolomRole).toContain("require_scan_ip_allowlist");

    const tabel = await client.execute(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'absensi_foto';",
    );
    expect(tabel.rows.length).toBe(1);

    // Baris lama tetap utuh, dan kolom baru terisi nilai bawaan — bukan NULL
    // yang akan menjatuhkan setiap pembacaan setelahnya.
    const role = await client.execute(
      "SELECT require_totp, require_scan_photo, require_scan_ip_allowlist FROM app_role WHERE role_key = 'admin';",
    );
    expect(Number(role.rows[0]?.require_totp)).toBe(1);
    expect(Number(role.rows[0]?.require_scan_photo)).toBe(0);
    expect(Number(role.rows[0]?.require_scan_ip_allowlist)).toBe(0);
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
