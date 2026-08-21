import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Client, createClient } from "@libsql/client";
import type { OperatorUser } from "@/lib/auth/operator-user";
import { initDatabaseSchema } from "@/lib/db-schema";
import {
  type OperationalSyncEvent,
  processOperationalSyncEvent,
} from "@/lib/server/operational/sync-push";

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

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "sppg-sync-test-"));
  directories.push(directory);
  const client = createClient({ url: `file:${join(directory, "test.db")}` });
  clients.push(client);
  await initDatabaseSchema(client);
  return client;
}

function event(overrides: Partial<OperationalSyncEvent> = {}) {
  return {
    eventId: `evt-${"a".repeat(64)}`,
    clientId: `desktop-${"b".repeat(64)}`,
    domain: "shift",
    operation: "create",
    entityKey: "kode:90",
    payload: {
      local_id_shift: -90,
      kode_shift: 90,
      nama_shift: "Shift Sinkronisasi",
      jam_masuk: "08:00",
      jam_pulang: "16:00",
      toleransi_masuk_menit: 10,
      jam_kerja_normal_menit: 480,
      istirahat_menit: 60,
    },
    baseRevision: null,
    createdAt: 1_786_300_000,
    ...overrides,
  } satisfies OperationalSyncEvent;
}

function scanEvent(overrides: Partial<OperationalSyncEvent> = {}) {
  return {
    eventId: `evt-${"c".repeat(64)}`,
    clientId: `desktop-${"d".repeat(64)}`,
    domain: "attendance",
    operation: "scan",
    entityKey: "scan:-100",
    payload: {
      log: {
        timestamp_scan: "2026-08-10 08:00:00",
        tanggal_kerja: "2026-08-10",
        jam_scan: "08:00:00",
        id_karyawan: "K001",
        nama: "Karyawan Test",
        divisi: "Dapur",
        jenis_scan: "Scan Ditolak",
        status_proses: "Ditolak",
        sumber_data: "Scanner",
        catatan_sistem: "Scan ganda dalam masa cooldown (60 detik)",
        keterangan: "Duplikat diabaikan",
        menit_terlambat: 0,
        menit_datang_awal: 0,
      },
      attendance: null,
      attendanceBaseUpdatedAt: null,
    },
    baseRevision: null,
    createdAt: 1_786_300_001,
    ...overrides,
  } satisfies OperationalSyncEvent;
}

function successfulScanEvent(overrides: Partial<OperationalSyncEvent> = {}) {
  return scanEvent({
    eventId: `evt-${"4".repeat(64)}`,
    entityKey: "scan:-200",
    payload: {
      log: {
        timestamp_scan: "2026-08-10 15:00:00",
        tanggal_kerja: "2026-08-10",
        jam_scan: "15:00:00",
        id_karyawan: "K001",
        nama: "Karyawan Test",
        divisi: "Dapur",
        jenis_scan: "Pulang",
        status_proses: "Berhasil",
        sumber_data: "Scanner",
        catatan_sistem: "Pulang dalam jendela normal",
        keterangan: "Pulang Normal",
        menit_terlambat: 0,
        menit_datang_awal: 0,
        id_referensi: "",
      },
      attendance: {
        tanggal: "2026-08-10",
        id_karyawan: "K001",
        nama: "Karyawan Test",
        kelas_divisi: "Dapur",
        jam_masuk: "2026-08-10 07:00:00",
        jam_pulang: "2026-08-10 15:00:00",
        status_kehadiran: "Hadir",
        status_absen: "Lengkap",
        keterangan: "Pulang Normal",
        sumber: "Scanner",
        update_terakhir: "2026-08-10 15:00:00",
        menit_terlambat: 0,
        menit_datang_awal: 0,
        jam_kerja: 420,
        lembur: 0,
        jam_kerja_kurang: 0,
        id_shift: 1,
        bulan: "Agustus",
        tahun: 2026,
        id_sesi: "NORMAL-20260810-K001-1",
        mode_tugas: "NORMAL",
        id_backup: "",
        id_karyawan_asal: "",
        tanggal_tugas: "2026-08-10",
      },
      attendanceBaseUpdatedAt: null,
    },
    ...overrides,
  });
}

afterEach(async () => {
  while (clients.length > 0) clients.pop()?.close();
  await Bun.sleep(50);
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory) {
      try {
        rmSync(directory, {
          recursive: true,
          force: true,
          maxRetries: 10,
          retryDelay: 50,
        });
      } catch (error) {
        // libSQL Windows dapat menahan file sesaat setelah client ditutup.
        if (
          !(error instanceof Error) ||
          !("code" in error) ||
          error.code !== "EBUSY"
        ) {
          throw error;
        }
      }
    }
  }
});

describe("operational sync idempotency", () => {
  test("event rusak ditolak sebelum transaksi dan tidak membuat receipt", async () => {
    const client = await fixture();
    const result = await processOperationalSyncEvent(client, actor, {
      eventId: `evt-${"f".repeat(64)}`,
      clientId: `desktop-${"1".repeat(64)}`,
      domain: "shift",
      operation: "create",
      entityKey: "kode:91",
      payload: {
        kode_shift: 91,
        nama_shift: "Shift Tidak Valid",
        jam_masuk: "08:00",
        jam_pulang: "16:00",
        unexpected: "field liar",
      },
      createdAt: 1_786_300_002,
    });

    expect(result.status).toBe("rejected");
    const shifts = await client.execute(
      "SELECT COUNT(*) AS total FROM tbl_shift WHERE kode_shift = 91;",
    );
    const receipts = await client.execute(
      "SELECT COUNT(*) AS total FROM sync_operation_receipt WHERE event_id = ?;",
      [result.eventId],
    );
    expect(Number(shifts.rows[0]?.total)).toBe(0);
    expect(Number(receipts.rows[0]?.total)).toBe(0);
  });

  test("retry event yang sama mengembalikan receipt tanpa membuat shift ganda", async () => {
    const client = await fixture();
    const input = event();

    const first = await processOperationalSyncEvent(client, actor, input);
    const retry = await processOperationalSyncEvent(client, actor, input);

    expect(first.status).toBe("applied");
    expect(retry).toEqual(first);
    const shifts = await client.execute(
      "SELECT COUNT(*) AS total FROM tbl_shift WHERE kode_shift = 90;",
    );
    const receipts = await client.execute(
      "SELECT COUNT(*) AS total FROM sync_operation_receipt WHERE event_id = ?;",
      [input.eventId],
    );
    expect(Number(shifts.rows[0]?.total)).toBe(1);
    expect(Number(receipts.rows[0]?.total)).toBe(1);
  });

  test("create shift dengan kode bawaan dipetakan ke shift server", async () => {
    const client = await fixture();
    const input = event({
      eventId: `evt-${"2".repeat(64)}`,
      entityKey: "kode:1",
      payload: {
        ...event().payload,
        local_id_shift: -1,
        kode_shift: 1,
        nama_shift: "Salinan Shift Lokal",
      },
    });

    const result = await processOperationalSyncEvent(client, actor, input);

    expect(result.status).toBe("applied");
    const shifts = await client.execute(
      "SELECT id_shift, nama_shift FROM tbl_shift WHERE kode_shift = 1;",
    );
    expect(shifts.rows.length).toBe(1);
    expect(result.serverPayload).toMatchObject({
      id_shift: Number(shifts.rows[0]?.id_shift),
      local_id_shift: -1,
    });
    expect(shifts.rows[0]?.nama_shift).toBe("Shift 1 - Pagi Normal");
  });

  test("event attendance create Auto-Alfa diterapkan dan idempoten", async () => {
    const client = await fixture();
    const attendance = successfulScanEvent().payload.attendance;
    const input = event({
      eventId: `evt-${"8".repeat(64)}`,
      domain: "attendance",
      operation: "create",
      entityKey: "alfa:NORMAL-20260810-K001-1",
      payload: { attendance },
    });

    const first = await processOperationalSyncEvent(client, actor, input);
    const retry = await processOperationalSyncEvent(client, actor, input);

    expect(first.status).toBe("applied");
    expect(retry).toEqual(first);
    const rows = await client.execute(
      "SELECT COUNT(*) AS total FROM absensi_harian WHERE id_sesi = 'NORMAL-20260810-K001-1';",
    );
    expect(Number(rows.rows[0]?.total)).toBe(1);
  });

  test("receipt konflik duplicate lama dibuka ulang dan karyawan server dipertahankan", async () => {
    const client = await fixture();
    await client.execute({
      sql: `INSERT INTO master_data (
        id_unik, kode_karyawan, nama, divisi, id_shift, status_aktif,
        token_absensi, qr_code, status_qr
      ) VALUES (?, ?, ?, ?, 1, 'Aktif', ?, ?, 'Generated');`,
      args: [
        "USR001",
        "USR001",
        "Nama dari Server",
        "Dapur",
        "token-server",
        "USR001|token-server",
      ],
    });
    const input = event({
      eventId: `evt-${"3".repeat(64)}`,
      domain: "employee",
      operation: "create",
      entityKey: "USR001",
      payload: {
        id_unik: "USR001",
        kode_karyawan: "USR001",
        nama: "Nama dari Desktop",
        divisi: "Produksi",
        id_shift: 1,
        token_absensi: "token-desktop",
        qr_code: "USR001|token-desktop",
      },
    });
    const first = await processOperationalSyncEvent(client, actor, input);
    expect(first.status).toBe("applied");
    await client.execute({
      sql: `UPDATE sync_operation_receipt SET status = 'conflict', result_json = ?
            WHERE event_id = ?;`,
      args: [
        JSON.stringify({
          eventId: input.eventId,
          status: "conflict",
          message:
            "SQLITE_CONSTRAINT: UNIQUE constraint failed: master_data.id_unik",
        }),
        input.eventId,
      ],
    });

    const retry = await processOperationalSyncEvent(client, actor, input);

    expect(retry.status).toBe("applied");
    const employees = await client.execute(
      "SELECT nama, divisi FROM master_data WHERE id_unik = 'USR001';",
    );
    expect(employees.rows.length).toBe(1);
    expect(employees.rows[0]?.nama).toBe("Nama dari Server");
    expect(employees.rows[0]?.divisi).toBe("Dapur");
  });

  test("event ID yang dipakai ulang dengan payload berbeda menjadi konflik", async () => {
    const client = await fixture();
    const input = event();
    await processOperationalSyncEvent(client, actor, input);

    const conflict = await processOperationalSyncEvent(client, actor, {
      ...input,
      payload: { ...input.payload, nama_shift: "Payload Berbeda" },
    });

    expect(conflict).toMatchObject({
      eventId: input.eventId,
      status: "conflict",
    });
  });

  test("retry log scan ditolak tidak menggandakan LOG_SCAN", async () => {
    const client = await fixture();
    const input = scanEvent();

    const first = await processOperationalSyncEvent(client, actor, input);
    const retry = await processOperationalSyncEvent(client, actor, input);

    expect(first.status).toBe("applied");
    expect(retry).toEqual(first);
    const logs = await client.execute(
      "SELECT COUNT(*) AS total FROM log_scan WHERE id_karyawan = 'K001';",
    );
    const attendance = await client.execute(
      "SELECT COUNT(*) AS total FROM absensi_harian WHERE id_karyawan = 'K001';",
    );
    expect(Number(logs.rows[0]?.total)).toBe(1);
    expect(Number(attendance.rows[0]?.total)).toBe(0);
  });

  test("retry scan berhasil tidak menggandakan LOG_SCAN atau ABSENSI_HARIAN", async () => {
    const client = await fixture();
    const input = successfulScanEvent();

    const first = await processOperationalSyncEvent(client, actor, input);
    const retry = await processOperationalSyncEvent(client, actor, input);

    expect(first.status).toBe("applied");
    expect(retry).toEqual(first);
    const logs = await client.execute(
      "SELECT COUNT(*) AS total FROM log_scan WHERE id_karyawan = 'K001';",
    );
    const attendance = await client.execute(
      `SELECT COUNT(*) AS total, MAX(status_absen) AS status_absen,
              MAX(jam_kerja) AS jam_kerja
       FROM absensi_harian WHERE id_sesi = 'NORMAL-20260810-K001-1';`,
    );
    expect(Number(logs.rows[0]?.total)).toBe(1);
    expect(Number(attendance.rows[0]?.total)).toBe(1);
    expect(attendance.rows[0]?.status_absen).toBe("Lengkap");
    expect(Number(attendance.rows[0]?.jam_kerja)).toBe(420);
  });

  test("scan lokal tidak menimpa data hadir hasil Koreksi Admin", async () => {
    const client = await fixture();
    await client.execute(`
      INSERT INTO absensi_harian (
        tanggal, id_karyawan, nama, kelas_divisi, jam_masuk, jam_pulang,
        status_kehadiran, status_absen, keterangan, sumber, update_terakhir,
        menit_terlambat, menit_datang_awal, jam_kerja, lembur,
        jam_kerja_kurang, id_shift, bulan, tahun, id_sesi, mode_tugas,
        id_backup, id_karyawan_asal, tanggal_tugas
      ) VALUES (
        '2026-08-10', 'K001', 'Karyawan Test', 'Dapur', '', '',
        'Hadir', 'Lengkap', 'Jam dikoreksi admin', 'Koreksi Admin',
        '2026-08-10 07:30:00', 0, 0, 0, 0, 0, 1, 'Agustus', 2026,
        'NORMAL-20260810-K001-1', 'NORMAL', '', '', '2026-08-10'
      );
    `);
    const input = scanEvent({
      eventId: `evt-${"e".repeat(64)}`,
      entityKey: "scan:-101",
      payload: {
        ...(scanEvent().payload as Record<string, unknown>),
        attendanceBaseUpdatedAt: "2026-08-10 07:30:00",
        attendance: {
          tanggal: "2026-08-10",
          id_karyawan: "K001",
          nama: "Karyawan Test",
          kelas_divisi: "Dapur",
          jam_masuk: "2026-08-10 08:00:00",
          jam_pulang: "",
          status_kehadiran: "Hadir",
          status_absen: "Belum Pulang",
          keterangan: "Tepat Waktu",
          update_terakhir: "2026-08-10 08:00:00",
          id_shift: 1,
          bulan: "Agustus",
          tahun: 2026,
          id_sesi: "NORMAL-20260810-K001-1",
          mode_tugas: "NORMAL",
        },
      },
    });

    const result = await processOperationalSyncEvent(client, actor, input);
    expect(result.status).toBe("conflict");
    const attendance = await client.execute(
      "SELECT status_kehadiran, sumber FROM absensi_harian WHERE id_sesi = 'NORMAL-20260810-K001-1';",
    );
    const logs = await client.execute(
      "SELECT COUNT(*) AS total FROM log_scan WHERE id_karyawan = 'K001';",
    );
    expect(attendance.rows[0]?.status_kehadiran).toBe("Hadir");
    expect(attendance.rows[0]?.sumber).toBe("Koreksi Admin");
    expect(Number(logs.rows[0]?.total)).toBe(0);
  });

  test("event correction create dengan tahun integer diterapkan dan receipt dibuat", async () => {
    const client = await fixture();
    const event = {
      clientId: `desktop-${"b".repeat(64)}`,
      eventId: `evt-${"f".repeat(64)}`,
      domain: "correction" as const,
      operation: "create" as const,
      entityKey: "KOR-20260810-ABC123XYZ",
      createdAt: Date.now(),
      payload: {
        correction: {
          id_referensi: "KOR-20260810-ABC123XYZ",
          tanggal: "2026-08-10",
          id_karyawan: "K001",
          nama: "Karyawan Test",
          divisi: "Dapur",
          jenis_koreksi: "Lupa Absen Masuk",
          jam_koreksi: "08:00",
          keterangan_admin: "Koreksi masuk",
          status_proses: "Sudah Diproses",
          timestamp: "2026-08-10 08:00:00",
          kode_operator: "SPD001",
        },
        attendance: {
          tanggal: "2026-08-10",
          id_karyawan: "K001",
          nama: "Karyawan Test",
          kelas_divisi: "Dapur",
          jam_masuk: "2026-08-10 08:00:00",
          jam_pulang: "2026-08-10 16:00:00",
          status_kehadiran: "Hadir",
          status_absen: "Lengkap",
          keterangan: "Koreksi masuk",
          update_terakhir: "2026-08-10 16:00:00",
          id_shift: 1,
          bulan: "Agustus",
          tahun: 2026,
          id_sesi: "NORMAL-20260810-K001-1",
          mode_tugas: "NORMAL",
        },
        log: {
          timestamp_scan: "2026-08-10 08:00:00",
          tanggal_kerja: "2026-08-10",
          jam_scan: "08:00:00",
          id_karyawan: "K001",
          nama: "Karyawan Test",
          divisi: "Dapur",
          jenis_scan: "Masuk",
          catatan_sistem: "Koreksi Admin",
          keterangan: "Koreksi masuk",
          menit_terlambat: 0,
          menit_datang_awal: 0,
          id_referensi: "KOR-20260810-ABC123XYZ",
          kode_operator: "SPD001",
        },
      },
    };

    const result = await processOperationalSyncEvent(client, actor, event);
    expect(result.status).toBe("applied");
    const correction = await client.execute(
      "SELECT id_referensi, jenis_koreksi FROM koreksi_admin WHERE id_referensi = 'KOR-20260810-ABC123XYZ';",
    );
    const attendance = await client.execute(
      "SELECT status_kehadiran, sumber, tahun, bulan FROM absensi_harian WHERE id_sesi = 'NORMAL-20260810-K001-1';",
    );
    expect(correction.rows[0]?.id_referensi).toBe("KOR-20260810-ABC123XYZ");
    expect(attendance.rows[0]?.status_kehadiran).toBe("Hadir");
    expect(attendance.rows[0]?.sumber).toBe("Koreksi Admin");
    expect(Number(attendance.rows[0]?.tahun)).toBe(2026);
    expect(attendance.rows[0]?.bulan).toBe("Agustus");
  });
});
