import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type Client, createClient } from "@libsql/client";
import { runDatabaseMigrations } from "@/lib/db-migrations";
import { initDatabaseSchema } from "@/lib/db-schema";
import { insertOperator, removeOperator } from "@/lib/operators/operator-admin";

/**
 * Penjagaan constraint di sekitar `master_operator` dan `password_reset_request`.
 *
 * Tiga kelas kesalahan yang diuji di sini pernah benar-benar ada atau nyaris
 * lolos: indeks unik yang dibuat sebelum kolomnya ada, penghapusan operator
 * yang diam-diam memusnahkan bukti foto lewat CASCADE, dan email kembar yang
 * hanya berbeda huruf besar-kecil.
 */

let client: Client;

async function operatorRoleId() {
  const roles = await client.execute(
    "SELECT id FROM app_role WHERE role_key = 'operator' LIMIT 1;",
  );
  return Number(roles.rows[0]?.id);
}

async function seedOperator(kode: string, username: string, email: string) {
  const result = await insertOperator(client, {
    kodeOperator: kode,
    name: `Operator ${kode}`,
    username,
    email,
    noHp: "081200000001",
    password: "PasswordUjiKuat1",
    roleId: await operatorRoleId(),
    status: "Aktif",
  });
  return result.id;
}

beforeEach(async () => {
  client = createClient({ url: "file::memory:" });
});

afterEach(() => client.close());

describe("foreign key ditegakkan", () => {
  test("libSQL menyalakan PRAGMA foreign_keys", async () => {
    await initDatabaseSchema(client);
    const pragma = await client.execute("PRAGMA foreign_keys;");
    // Kalau suatu saat nilai ini menjadi 0, seluruh asumsi CASCADE di bawah
    // runtuh dan baris yatim akan menumpuk tanpa terlihat.
    expect(Number(pragma.rows[0]?.foreign_keys)).toBe(1);
  });

  test("password_reset_request menunjuk master_operator dengan ON DELETE CASCADE", async () => {
    await initDatabaseSchema(client);
    const keys = await client.execute(
      "PRAGMA foreign_key_list(password_reset_request);",
    );
    expect(keys.rows).toHaveLength(1);
    expect(keys.rows[0]?.table).toBe("master_operator");
    expect(keys.rows[0]?.from).toBe("operator_id");
    expect(keys.rows[0]?.on_delete).toBe("CASCADE");
  });
});

describe("menghapus operator tidak boleh memusnahkan bukti foto", () => {
  test("removeOperator menolak akun yang punya riwayat reset", async () => {
    await initDatabaseSchema(client);
    const id = await seedOperator("OPS910", "uji910", "uji910@sppg.id");
    await client.execute({
      sql: `
        INSERT INTO password_reset_request (
          id, operator_id, identifier_used, contact_channel, contact_target,
          challenge_hash, challenge_sequence, status, photo_base64,
          requested_at, expires_at
        ) VALUES ('probe-1', ?, 'uji910', 'email', 'uji910@sppg.id',
          'h', '["KEDIP"]', 'Terpakai', 'Zm90bw==',
          datetime('now'), datetime('now', '+30 minutes'));
      `,
      args: [id],
    });

    await expect(removeOperator(client, 999_999, id)).rejects.toThrow(
      "riwayat pengajuan reset password",
    );

    const sisa = await client.execute(
      "SELECT COUNT(*) AS total FROM password_reset_request;",
    );
    expect(Number(sisa.rows[0]?.total)).toBe(1);
  });

  test("operator tanpa riwayat tetap dapat dihapus", async () => {
    await initDatabaseSchema(client);
    const id = await seedOperator("OPS911", "uji911", "uji911@sppg.id");
    await expect(removeOperator(client, 999_999, id)).resolves.toEqual({
      success: true,
    });
  });
});

/**
 * Matriks yang sama diuji pada sisi Rust oleh
 * `operator_deletion_guards_match_the_web_path` di `turso.rs`. Dua berkas uji
 * yang menguji keadaan yang sama persis adalah cara paritas ini dijaga: dulu
 * jalur Desktop hanya menolak Superadmin dan sama sekali tidak memeriksa
 * histori transaksi, sehingga operator yang di Web ditolak tetap terhapus dari
 * Desktop.
 */
describe("paritas penjagaan penghapusan operator", () => {
  async function superadminRoleId() {
    const roles = await client.execute(
      "SELECT id FROM app_role WHERE role_key = 'superadmin' LIMIT 1;",
    );
    return Number(roles.rows[0]?.id);
  }

  async function seedSuperadmin(kode: string, username: string) {
    const result = await insertOperator(
      client,
      {
        kodeOperator: kode,
        name: `Superadmin ${kode}`,
        username,
        email: `${username}@sppg.id`,
        noHp: "081200000002",
        password: "PasswordUjiKuat1",
        roleId: await superadminRoleId(),
        status: "Aktif",
      },
      true,
    );
    return result.id;
  }

  test("akun yang sedang dipakai tidak dapat menghapus dirinya sendiri", async () => {
    await initDatabaseSchema(client);
    const id = await seedOperator("OPS940", "uji940", "uji940@sppg.id");
    await expect(removeOperator(client, id, id)).rejects.toThrow(
      "Akun yang sedang digunakan tidak dapat dihapus.",
    );
  });

  test("operator yang tidak ada ditolak", async () => {
    await initDatabaseSchema(client);
    await expect(removeOperator(client, 1, 999_999)).rejects.toThrow(
      "Operator tidak ditemukan.",
    );
  });

  test("Superadmin aktif terakhir tidak dapat dihapus", async () => {
    await initDatabaseSchema(client);
    const id = await seedSuperadmin("SPD940", "super940");
    await expect(removeOperator(client, 999_999, id)).rejects.toThrow(
      "Superadmin aktif terakhir tidak dapat dihapus.",
    );
  });

  test("Superadmin kedua tetap dapat dihapus", async () => {
    await initDatabaseSchema(client);
    await seedSuperadmin("SPD941", "super941");
    const kedua = await seedSuperadmin("SPD942", "super942");
    await expect(removeOperator(client, 999_999, kedua)).resolves.toEqual({
      success: true,
    });
  });

  test("operator dengan histori transaksi ditolak sebelum riwayat reset", async () => {
    await initDatabaseSchema(client);
    const id = await seedOperator("OPS943", "uji943", "uji943@sppg.id");
    await client.execute(`
      INSERT INTO log_scan (
        timestamp_scan, tanggal_kerja, jam_scan, id_karyawan, nama, divisi,
        jenis_scan, status_proses, sumber_data, kode_operator
      ) VALUES (
        datetime('now'), date('now'), '08:00', 'K001', 'Karyawan', 'Dapur',
        'Masuk', 'Diproses', 'Scanner', 'OPS943'
      );
    `);
    await expect(removeOperator(client, 999_999, id)).rejects.toThrow(
      "Operator memiliki histori transaksi.",
    );
  });
});

describe("indeks unik email operator", () => {
  test("menolak email kembar walau beda huruf besar-kecil", async () => {
    await initDatabaseSchema(client);
    await seedOperator("OPS920", "uji920", "kembar@sppg.id");
    await expect(
      seedOperator("OPS921", "uji921", "KEMBAR@SPPG.ID"),
    ).rejects.toThrow("UNIQUE");
  });

  test("beberapa operator lama tanpa email tidak saling bentrok", async () => {
    await initDatabaseSchema(client);
    const roleId = await operatorRoleId();
    // Baris seperti ini lahir dari database sebelum kolom email ada: indeks
    // uniknya parsial, jadi NULL boleh berulang.
    for (const kode of ["LEG001", "LEG002"]) {
      await client.execute({
        sql: `
          INSERT INTO master_operator (
            kode_operator, nama_operator, username, password_hash, role, role_id, status
          ) VALUES (?, ?, ?, 'x', 'Operator', ?, 'Aktif');
        `,
        args: [kode, `Legacy ${kode}`, kode.toLowerCase(), roleId],
      });
    }
    const total = await client.execute(
      "SELECT COUNT(*) AS total FROM master_operator WHERE email IS NULL;",
    );
    expect(Number(total.rows[0]?.total)).toBe(2);
  });
});

describe("migrasi database lama", () => {
  /**
   * Skenario yang nyaris merusak seluruh pemasangan yang sudah berjalan:
   * `master_operator` sudah ada TANPA kolom `email`, lalu migrasi mencoba
   * membuat indeks unik di atas kolom itu. Urutan yang benar adalah
   * ALTER TABLE dulu, baru CREATE INDEX.
   */
  test("menambah kolom kontak dan indeksnya pada tabel yang sudah ada", async () => {
    await initDatabaseSchema(client);
    await client.execute(`
      INSERT INTO master_operator (
        kode_operator, nama_operator, username, password_hash, role, status
      ) VALUES ('OLD001', 'Operator Lama', 'lama', 'hash-lama', 'Operator', 'Aktif');
    `);

    // Kembalikan tabel ke bentuknya sebelum schema versi 11. Indeksnya dibuang
    // lebih dulu karena ia bergantung pada kolom yang akan dihapus.
    await client.execute("DROP INDEX IF EXISTS idx_master_operator_email;");
    await client.execute("ALTER TABLE master_operator DROP COLUMN email;");
    await client.execute("ALTER TABLE master_operator DROP COLUMN no_hp;");
    const sebelum = await client.execute("PRAGMA table_info(master_operator);");
    expect(sebelum.rows.map((row) => String(row.name))).not.toContain("email");

    // Inilah yang dulu gagal: CREATE INDEX di atas kolom yang belum ada.
    await runDatabaseMigrations(client);

    const columns = await client.execute("PRAGMA table_info(master_operator);");
    const names = columns.rows.map((row) => String(row.name));
    expect(names).toContain("email");
    expect(names).toContain("no_hp");

    const index = await client.execute(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_master_operator_email';",
    );
    expect(index.rows).toHaveLength(1);

    // Baris lama tetap utuh: migrasi tidak boleh membuang data operator.
    const legacy = await client.execute(
      "SELECT kode_operator, email FROM master_operator WHERE kode_operator = 'OLD001';",
    );
    expect(legacy.rows[0]?.kode_operator).toBe("OLD001");
    expect(legacy.rows[0]?.email).toBeNull();
  });
});

describe("CHECK constraint", () => {
  test("status riwayat di luar daftar ditolak", async () => {
    await initDatabaseSchema(client);
    const id = await seedOperator("OPS930", "uji930", "uji930@sppg.id");
    await client.execute({
      sql: `
        INSERT INTO password_reset_request (
          id, operator_id, identifier_used, contact_channel, contact_target,
          challenge_hash, challenge_sequence, status, requested_at, expires_at
        ) VALUES ('probe-2', ?, 'uji930', 'email', 'uji930@sppg.id',
          'h', '["KEDIP"]', 'Terkirim', datetime('now'), datetime('now', '+30 minutes'));
      `,
      args: [id],
    });
    await expect(
      client.execute(
        "UPDATE password_reset_request SET status = 'Ngawur' WHERE id = 'probe-2';",
      ),
    ).rejects.toThrow("CHECK constraint failed");
  });

  test("penyedia email dan is_active dijaga CHECK", async () => {
    await initDatabaseSchema(client);
    await expect(
      client.execute(
        "UPDATE app_mail_config SET provider = 'gmail' WHERE id = 'default';",
      ),
    ).rejects.toThrow("CHECK constraint failed");
    await expect(
      client.execute(
        "UPDATE app_mail_config SET is_active = 7 WHERE id = 'default';",
      ),
    ).rejects.toThrow("CHECK constraint failed");
  });
});
