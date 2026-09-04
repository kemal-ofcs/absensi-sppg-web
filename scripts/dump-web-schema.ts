/**
 * Cetak struktur skema yang BENAR-BENAR dibangun jalur Web, sebagai JSON.
 *
 * Dipakai `bun run audit:schema` di root. Jalur Web dan jalur Rust membangun
 * database Turso yang sama, tetapi `CREATE TABLE IF NOT EXISTS` tidak pernah
 * memperbaiki tabel yang sudah ada — sehingga satu perbedaan kolom akan
 * merusak permanen sisi mana pun yang tidak sempat membuat tabelnya. Audit
 * membandingkan hasil nyata kedua jalur, bukan teks sumbernya, dan skrip ini
 * adalah sisi Web dari perbandingan itu.
 *
 * Dijalankan dari dalam `web-desktop/` supaya alias `@/*` di tsconfig ikut
 * ter-resolve. Keluarannya JSON murni di stdout; seluruh catatan proses
 * ditulis ke stderr agar tidak mencemari hasil yang diparse pemanggil.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { initDatabaseSchema } from "@/lib/db-schema";

const workDir = mkdtempSync(join(tmpdir(), "sppg-web-schema-"));
const databasePath = join(workDir, "audit.db");

try {
  const client = createClient({ url: `file:${databasePath}` });
  await initDatabaseSchema(client);

  const tables = await client.execute(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name;",
  );

  const schema: Record<string, string[]> = {};
  for (const row of tables.rows) {
    const name = String(row.name);
    const columns = await client.execute(`PRAGMA table_info("${name}");`);
    schema[name] = columns.rows.map((column) => String(column.name));
  }

  client.close();
  process.stdout.write(JSON.stringify(schema));
} catch (error) {
  process.stderr.write(
    `Gagal membangun skema Web: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
} finally {
  // Windows menahan handle berkas SQLite sesaat setelah `close()`, sehingga
  // penghapusan bisa gagal dengan EBUSY. Itu bukan kegagalan audit — direktori
  // sementara akan dibersihkan sistem — jadi jangan biarkan ia menjatuhkan
  // exit code dan menutupi hasil perbandingan skema yang sebenarnya.
  try {
    rmSync(workDir, { recursive: true, force: true });
  } catch {
    /* biarkan sistem operasi yang membersihkan */
  }
}
