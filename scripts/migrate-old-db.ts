import Database from "bun:sqlite";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function migrationEventId(identity: string) {
  return `evt-${sha256(`absensi-sppg-migration:${identity}`)}`;
}

let sourceDbPath = path.resolve(process.cwd(), "../absensi-sppg.db");
if (!fs.existsSync(sourceDbPath)) {
  sourceDbPath = path.resolve(process.cwd(), "../absensi-sppg-app.db");
}

const localAppData =
  process.env.LOCALAPPDATA ||
  path.resolve(process.env.USERPROFILE || "", "AppData/Local");
const targetDbPath = path.join(
  localAppData,
  "id.sppg.absensi",
  "desktop-security.db",
);

console.log(
  "=== Absensi SPPG - Skrip Migrasi & Outbox Enqueue Database Lama ===",
);
console.log(`Database Sumber : ${sourceDbPath}`);
console.log(`Database Tujuan : ${targetDbPath}`);

if (!fs.existsSync(sourceDbPath)) {
  console.error(
    `Error: File database sumber tidak ditemukan di ${sourceDbPath}`,
  );
  process.exit(1);
}

if (!fs.existsSync(targetDbPath)) {
  console.error(
    `Error: File database tujuan Desktop tidak ditemukan di ${targetDbPath}.`,
  );
  console.error(
    "Pastikan Anda sudah pernah membuka aplikasi Desktop minimal sekali.",
  );
  process.exit(1);
}

const sourceDb = new Database(sourceDbPath);
const targetDb = new Database(targetDbPath);

const tablesToMigrate = [
  "master_data",
  "id_card",
  "tbl_shift",
  "tbl_hari_libur",
  "setting_gex_system",
  "company_profile",
  "id_card_template",
  "backup_karyawan",
  "koreksi_admin",
  "import_offline",
  "absensi_harian",
  "log_scan",
];

targetDb.run("PRAGMA foreign_keys = OFF;");

let totalMigratedRows = 0;
const migrationFailures: string[] = [];

for (const table of tablesToMigrate) {
  try {
    const rows = sourceDb.query(`SELECT * FROM ${table}`).all() as Record<
      string,
      string | number | boolean | null
    >[];
    if (!rows || rows.length === 0) {
      console.log(`- ${table}: 0 baris (dilewati)`);
      continue;
    }

    const columns = Object.keys(rows[0]);
    const placeholders = columns.map(() => "?").join(", ");
    const colNames = columns.join(", ");

    const insertStmt = targetDb.prepare(
      `INSERT OR REPLACE INTO ${table} (${colNames}) VALUES (${placeholders});`,
    );

    targetDb.transaction(() => {
      for (const row of rows) {
        const values = columns.map((col) => row[col]);
        insertStmt.run(...values);
      }
    })();

    console.log(`✓ ${table}: ${rows.length} baris berhasil disalin ke lokal.`);
    totalMigratedRows += rows.length;
  } catch (error) {
    const message = `${table}: ${(error as Error).message}`;
    migrationFailures.push(message);
    console.error(`! ${message}`);
  }
}

if (migrationFailures.length > 0) {
  targetDb.run("PRAGMA foreign_keys = ON;");
  sourceDb.close();
  targetDb.close();
  throw new Error(
    `Migrasi dihentikan karena ${migrationFailures.length} tabel gagal disalin: ${migrationFailures.join("; ")}`,
  );
}

// Enqueue ke outbox agar otomatis terdorong ke Turso Cloud saat sync
console.log(
  "\n-> Mendaftarkan seluruh data ke antrean outbox sinkronisasi cloud...",
);

// Ambil client_id
let clientId = `desktop-${sha256(`migration-client:${targetDbPath}`)}`;
try {
  const row = targetDb
    .query("SELECT client_id FROM desktop_client_identity LIMIT 1")
    .get() as { client_id: string } | null;
  if (row?.client_id && /^desktop-[a-f0-9]{64}$/.test(row.client_id)) {
    clientId = row.client_id;
  }
} catch (error) {
  throw new Error("Identitas client lokal tidak dapat dibaca.", {
    cause: error,
  });
}

const nowEpoch = Math.floor(Date.now() / 1000);
let outboxEnqueued = 0;

const outboxStmt = targetDb.prepare(`
  INSERT INTO desktop_sync_outbox (
    event_id, client_id, domain, operation, entity_key, payload_json, base_revision, status, attempt_count, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)
  ON CONFLICT(event_id) DO NOTHING;
`);

targetDb.transaction(() => {
  // 1. Shift
  try {
    const shifts = targetDb.query("SELECT * FROM tbl_shift").all() as Record<
      string,
      unknown
    >[];
    for (const shift of shifts) {
      const entityKey = String(shift.kode_shift || shift.id_shift);
      const eventId = migrationEventId(`shift:create:${entityKey}`);
      outboxStmt.run(
        eventId,
        clientId,
        "shift",
        "create",
        entityKey,
        JSON.stringify(shift),
        null,
        nowEpoch,
        nowEpoch,
      );
      outboxEnqueued++;
    }
  } catch (error) {
    throw new Error("Outbox shift gagal dibuat.", { cause: error });
  }

  // 2. Setting
  try {
    const settings = targetDb
      .query("SELECT * FROM setting_gex_system")
      .all() as { key: string; value: string }[];
    for (const setting of settings) {
      const eventId = migrationEventId(`setting:update:${setting.key}`);
      outboxStmt.run(
        eventId,
        clientId,
        "setting",
        "update",
        setting.key,
        JSON.stringify(setting),
        null,
        nowEpoch,
        nowEpoch,
      );
      outboxEnqueued++;
    }
  } catch (error) {
    throw new Error("Outbox setting gagal dibuat.", { cause: error });
  }

  // 3. Holiday
  try {
    const holidays = targetDb
      .query("SELECT * FROM tbl_hari_libur")
      .all() as Record<string, unknown>[];
    for (const hol of holidays) {
      const eventId = migrationEventId(`holiday:create:${hol.tanggal}`);
      outboxStmt.run(
        eventId,
        clientId,
        "holiday",
        "create",
        String(hol.tanggal),
        JSON.stringify(hol),
        null,
        nowEpoch,
        nowEpoch,
      );
      outboxEnqueued++;
    }
  } catch (error) {
    throw new Error("Outbox hari libur gagal dibuat.", { cause: error });
  }

  // 4. Company Profile
  try {
    const cp = targetDb
      .query("SELECT * FROM company_profile LIMIT 1")
      .get() as Record<string, unknown> | null;
    if (cp) {
      const eventId = migrationEventId("company-profile:update:default");
      outboxStmt.run(
        eventId,
        clientId,
        "company-profile",
        "update",
        String(cp.id || "default_company"),
        JSON.stringify(cp),
        null,
        nowEpoch,
        nowEpoch,
      );
      outboxEnqueued++;
    }
  } catch (error) {
    throw new Error("Outbox profil perusahaan gagal dibuat.", { cause: error });
  }

  // 5. ID Card Template
  try {
    const tmpl = targetDb
      .query("SELECT * FROM id_card_template LIMIT 1")
      .get() as Record<string, unknown> | null;
    if (tmpl) {
      const eventId = migrationEventId("id-card-template:save:default");
      outboxStmt.run(
        eventId,
        clientId,
        "id-card-template",
        "save",
        String(tmpl.id || "default_template"),
        JSON.stringify(tmpl),
        null,
        nowEpoch,
        nowEpoch,
      );
      outboxEnqueued++;
    }
  } catch (error) {
    throw new Error("Outbox template ID card gagal dibuat.", { cause: error });
  }

  // 6. Employees
  try {
    const employees = targetDb
      .query("SELECT * FROM master_data")
      .all() as Record<string, unknown>[];
    for (const emp of employees) {
      const eventId = migrationEventId(`employee:create:${emp.id_unik}`);
      outboxStmt.run(
        eventId,
        clientId,
        "employee",
        "create",
        String(emp.id_unik),
        JSON.stringify(emp),
        null,
        nowEpoch,
        nowEpoch,
      );
      outboxEnqueued++;
    }
  } catch (error) {
    throw new Error("Outbox karyawan gagal dibuat.", { cause: error });
  }

  // 7. ID Cards
  try {
    const idCards = targetDb.query("SELECT * FROM id_card").all() as Record<
      string,
      unknown
    >[];
    for (const idc of idCards) {
      const eventId = migrationEventId(`id-card:update:${idc.id_unik}`);
      outboxStmt.run(
        eventId,
        clientId,
        "id-card",
        "update",
        String(idc.id_unik),
        JSON.stringify(idc),
        null,
        nowEpoch,
        nowEpoch,
      );
      outboxEnqueued++;
    }
  } catch (error) {
    throw new Error("Outbox ID card gagal dibuat.", { cause: error });
  }

  // 8. Backups
  try {
    const backups = targetDb
      .query("SELECT * FROM backup_karyawan")
      .all() as Record<string, unknown>[];
    for (const bkp of backups) {
      const eventId = migrationEventId(`backup:create:${bkp.id_backup}`);
      outboxStmt.run(
        eventId,
        clientId,
        "backup",
        "create",
        String(bkp.id_backup),
        JSON.stringify(bkp),
        null,
        nowEpoch,
        nowEpoch,
      );
      outboxEnqueued++;
    }
  } catch (error) {
    throw new Error("Outbox penugasan backup gagal dibuat.", { cause: error });
  }

  // 9. Corrections
  try {
    const corrections = targetDb
      .query("SELECT * FROM koreksi_admin")
      .all() as Record<string, unknown>[];
    for (const cor of corrections) {
      const eventId = migrationEventId(`correction:create:${cor.id_referensi}`);
      outboxStmt.run(
        eventId,
        clientId,
        "correction",
        "create",
        String(cor.id_referensi),
        JSON.stringify(cor),
        null,
        nowEpoch,
        nowEpoch,
      );
      outboxEnqueued++;
    }
  } catch (error) {
    throw new Error("Outbox koreksi gagal dibuat.", { cause: error });
  }

  // 10. Imports
  try {
    const imports = targetDb
      .query("SELECT * FROM import_offline")
      .all() as Record<string, unknown>[];
    for (const imp of imports) {
      const eventId = migrationEventId(`offline-import:row:${imp.event_key}`);
      outboxStmt.run(
        eventId,
        clientId,
        "offline-import",
        "row",
        String(imp.event_key),
        JSON.stringify(imp),
        null,
        nowEpoch,
        nowEpoch,
      );
      outboxEnqueued++;
    }
  } catch (error) {
    throw new Error("Outbox import offline gagal dibuat.", { cause: error });
  }

  // 11. Attendance
  try {
    const attendances = targetDb
      .query("SELECT * FROM absensi_harian")
      .all() as Record<string, unknown>[];
    for (const att of attendances) {
      const eventId = migrationEventId(`attendance:create:${att.id_sesi}`);
      outboxStmt.run(
        eventId,
        clientId,
        "attendance",
        "create",
        String(att.id_sesi),
        JSON.stringify(att),
        null,
        nowEpoch,
        nowEpoch,
      );
      outboxEnqueued++;
    }
  } catch (error) {
    throw new Error("Outbox absensi gagal dibuat.", { cause: error });
  }

  // 12. Scan Logs
  try {
    const scanLogs = targetDb.query("SELECT * FROM log_scan").all() as Record<
      string,
      unknown
    >[];
    for (const log of scanLogs) {
      const eventId = migrationEventId(
        `log-scan:create:${log.id_log || log.timestamp_scan}:${log.id_karyawan}`,
      );
      outboxStmt.run(
        eventId,
        clientId,
        "log-scan",
        "create",
        String(log.id_log || log.timestamp_scan),
        JSON.stringify(log),
        null,
        nowEpoch,
        nowEpoch,
      );
      outboxEnqueued++;
    }
  } catch (error) {
    throw new Error("Outbox log scan gagal dibuat.", { cause: error });
  }
})();

targetDb.run("PRAGMA foreign_keys = ON;");
sourceDb.close();
targetDb.close();

console.log(
  `✓ ${outboxEnqueued} event berhasil didaftarkan ke antrean outbox sinkronisasi.`,
);
console.log("\n=======================================================");
console.log(
  `Migrasi Selesai! Total ${totalMigratedRows} baris data disalin & ${outboxEnqueued} event siap didorong.`,
);
console.log(
  "Silakan buka aplikasi Desktop (`bun run tauri:dev`), lalu klik 'Sinkronkan sekarang'. Seluruh data akan otomatis terdorong ke Cloud Turso dan siap dibaca oleh Mobile Android!",
);
console.log("=======================================================\n");
