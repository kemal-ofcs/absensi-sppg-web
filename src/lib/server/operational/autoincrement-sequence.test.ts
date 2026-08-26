import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Client, createClient } from "@libsql/client";
import type { OperatorUser } from "@/lib/auth/operator-user";
import { initDatabaseSchema } from "@/lib/db-schema";
import {
  type OperationalSyncEvent,
  processOperationalSyncEvent,
} from "@/lib/server/operational/sync-push";

/**
 * Regresi bug "id melompat" (mis. tbl_shift.id_shift 7 -> 69 -> 111).
 *
 * SQLite/libSQL menaikkan counter AUTOINCREMENT pada SETIAP percobaan INSERT,
 * termasuk yang berakhir sebagai `DO UPDATE` atau di-`OR IGNORE`. Karena itu
 * setiap upsert ke tabel ber-AUTOINCREMENT menghabiskan satu nomor urut meski
 * tidak ada baris baru, dan baris berikutnya mendapat id yang jauh melompat.
 *
 * Perbaikannya: upsert wajib memasok kolom primary key lewat subquery pada
 * klausa VALUES dan memakai primary key itu sebagai conflict target, sehingga
 * jalur UPDATE tidak pernah mengalokasikan rowid baru.
 */

const actor: OperatorUser = {
  id: 1,
  kode_operator: "SPD001",
  nama_operator: "Superadmin",
  username: "superadmin",
  role: "Superadmin",
  roleId: 1,
  roleKey: "superadmin",
  isSuperadmin: true,
  permissions: [
    "sync.view",
    "employees.manage",
    "shifts.manage",
    "scanner.use",
    "corrections.manage",
  ],
  permissionRevision: 1,
};

const clients: Client[] = [];
const directories: string[] = [];

afterEach(async () => {
  while (clients.length > 0) clients.pop()?.close();
  await Bun.sleep(50);
  while (directories.length > 0) {
    const directory = directories.pop();
    if (!directory) continue;
    try {
      rmSync(directory, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 50,
      });
    } catch (error) {
      // libSQL di Windows dapat menahan file sesaat setelah client ditutup.
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== "EBUSY"
      ) {
        throw error;
      }
    }
  }
});

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "sppg-autoinc-test-"));
  directories.push(directory);
  const client = createClient({ url: `file:${join(directory, "test.db")}` });
  clients.push(client);
  await initDatabaseSchema(client);
  return client;
}

function attendanceEvent(
  sessionId: string,
  sequence: number,
): OperationalSyncEvent {
  return {
    eventId: `evt-${sequence.toString(16).padStart(64, "0")}`,
    clientId: `desktop-${"e".repeat(64)}`,
    domain: "attendance",
    operation: "create",
    entityKey: sessionId,
    payload: {
      attendance: {
        tanggal: "2026-08-10",
        id_karyawan: "K001",
        nama: "Karyawan Test",
        kelas_divisi: "Dapur",
        jam_masuk: "2026-08-10 07:00:00",
        jam_pulang: "",
        status_kehadiran: "Hadir",
        status_absen: "Belum Pulang",
        keterangan: `Revisi ${sequence}`,
        sumber: "Scanner",
        update_terakhir: "2026-08-10 07:00:00",
        menit_terlambat: 0,
        menit_datang_awal: 0,
        jam_kerja: 0,
        lembur: 0,
        jam_kerja_kurang: 0,
        id_shift: 1,
        bulan: "Agustus",
        tahun: 2026,
        id_sesi: sessionId,
        mode_tugas: "NORMAL",
        id_backup: "",
        id_karyawan_asal: "",
        tanggal_tugas: "2026-08-10",
      },
    },
    baseRevision: null,
    createdAt: 1_786_300_000,
  } satisfies OperationalSyncEvent;
}

async function idFor(client: Client, sessionId: string) {
  const res = await client.execute({
    sql: "SELECT id_absensi FROM absensi_harian WHERE id_sesi = ?;",
    args: [sessionId],
  });
  return Number(res.rows[0]?.id_absensi);
}

describe("AUTOINCREMENT sequence guard", () => {
  test("upsert absensi_harian yang berulang tidak membuat id baris berikutnya melompat", async () => {
    const client = await fixture();

    const first = await processOperationalSyncEvent(
      client,
      actor,
      attendanceEvent("SESI-A", 1),
    );
    expect(first.status).not.toBe("rejected");
    const firstId = await idFor(client, "SESI-A");
    expect(firstId).toBeGreaterThan(0);

    // Push ulang sesi yang sama berkali-kali: semuanya harus berujung UPDATE.
    for (let i = 0; i < 25; i++) {
      const result = await processOperationalSyncEvent(
        client,
        actor,
        attendanceEvent("SESI-A", 100 + i),
      );
      expect(result.status).not.toBe("rejected");
    }

    const rowCount = await client.execute(
      "SELECT COUNT(*) AS total FROM absensi_harian;",
    );
    expect(Number(rowCount.rows[0]?.total)).toBe(1);
    expect(await idFor(client, "SESI-A")).toBe(firstId);

    // Baris benar-benar baru harus lanjut berurutan, bukan melompat 25 nomor.
    const second = await processOperationalSyncEvent(
      client,
      actor,
      attendanceEvent("SESI-B", 2),
    );
    expect(second.status).not.toBe("rejected");
    expect(await idFor(client, "SESI-B")).toBe(firstId + 1);
  });

  test("tbl_shift kosong setelah inisialisasi agar counter AUTOINCREMENT belum terpakai", async () => {
    // Shift tidak lagi di-seed secara otomatis. Pengguna membuat shift secara manual
    // agar tidak ada inkonsistensi antara data default desktop vs cloud.
    // Test ini memastikan tabel kosong sehingga counter AUTOINCREMENT mulai dari 1
    // saat shift pertama dibuat, dan tidak ada nomor yang "terbuang" oleh seed.
    const client = await fixture();
    const res = await client.execute(
      "SELECT COUNT(*) AS total FROM tbl_shift;",
    );
    expect(Number(res.rows[0]?.total ?? -1)).toBe(0);
  });
});

/**
 * Penjaga statis: setiap upsert / `OR IGNORE` ke tabel ber-AUTOINCREMENT wajib
 * menyebut kolom primary key-nya. Tanpa itu counter AUTOINCREMENT ikut terpakai
 * pada jalur UPDATE dan bug "id melompat" muncul kembali.
 */
const AUTOINCREMENT_PRIMARY_KEYS: Record<string, string> = {
  id_card: "id_card_id",
  tbl_shift: "id_shift",
  log_scan: "id_log",
  absensi_harian: "id_absensi",
  koreksi_admin: "id_koreksi",
  audit_absensi: "id_audit",
  tbl_hari_libur: "id_libur",
  import_offline: "id_import",
  master_operator: "id",
};

function collectSourceFiles(directory: string, extensions: string[]) {
  const files: string[] = [];
  if (!existsSync(directory)) return files;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "target") continue;
      files.push(...collectSourceFiles(full, extensions));
      continue;
    }
    if (entry.name.includes(".test.")) continue;
    if (extensions.some((extension) => entry.name.endsWith(extension))) {
      files.push(full);
    }
  }
  return files;
}

describe("AUTOINCREMENT static guard", () => {
  test("tidak ada upsert / OR IGNORE ke tabel AUTOINCREMENT tanpa kolom primary key", () => {
    const files = [
      ...collectSourceFiles(join("src", "lib"), [".ts"]),
      ...collectSourceFiles(join("src", "app", "api"), [".ts"]),
      ...collectSourceFiles(join("src-tauri", "src"), [".rs"]),
    ];
    expect(files.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    const tables = Object.keys(AUTOINCREMENT_PRIMARY_KEYS).join("|");
    const pattern = new RegExp(
      `INSERT(\\s+OR\\s+(?:IGNORE|REPLACE))?\\s+INTO\\s+(${tables})\\s*\\(([^)]*)\\)([\\s\\S]{0,4000}?);`,
      "gi",
    );

    for (const file of files) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(pattern)) {
        const modifier = match[1];
        const table = (match[2] ?? "").toLowerCase();
        const primaryKey = AUTOINCREMENT_PRIMARY_KEYS[table];
        const columns = (match[3] ?? "")
          .split(",")
          .map((column) => column.trim());
        const body = match[4] ?? "";
        const isUpsert = /ON\s+CONFLICT/i.test(body);
        const isIgnoring = Boolean(modifier);
        if (!isUpsert && !isIgnoring) continue;
        if (primaryKey && columns.includes(primaryKey)) continue;
        offenders.push(`${file}: INSERT INTO ${table} tanpa ${primaryKey}`);
      }
    }

    expect(offenders).toEqual([]);
  });
});
