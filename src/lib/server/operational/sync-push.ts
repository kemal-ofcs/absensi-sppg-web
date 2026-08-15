import { createHash } from "node:crypto";
import type { Client, Transaction } from "@libsql/client";
import type { OperatorUser } from "@/lib/auth/operator-user";
import { assertActorPermission } from "@/lib/auth/permission-assertion";
import type { PermissionKey } from "@/lib/rbac/catalog";
import { isTransientDatabaseError } from "@/lib/server/database-retry";
import {
  type OperationalSyncEvent,
  safeParseOperationalSyncEvent,
} from "@/lib/server/operational/sync-schema";

export type { OperationalSyncEvent } from "@/lib/server/operational/sync-schema";

export interface OperationalSyncResult {
  eventId: string;
  status: "applied" | "rejected" | "conflict";
  message: string;
  serverRevision?: number;
  serverPayload?: unknown;
}

const DOMAIN_PERMISSION: Record<string, PermissionKey> = {
  employee: "employees.manage",
  shift: "shifts.manage",
  attendance: "scanner.use",
  correction: "corrections.manage",
  backup: "backups.manage",
  "offline-import": "corrections.manage",
  "id-card": "employees.manage",
};

function text(payload: Record<string, unknown>, key: string) {
  return typeof payload[key] === "string" ? payload[key].trim() : "";
}

function number(payload: Record<string, unknown>, key: string, fallback = 0) {
  const parsed = Number(payload[key]);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function payloadHash(event: OperationalSyncEvent) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        clientId: event.clientId,
        domain: event.domain,
        operation: event.operation,
        entityKey: event.entityKey,
        payload: event.payload,
        baseRevision: event.baseRevision ?? null,
        createdAt: event.createdAt,
      }),
    )
    .digest("hex");
}

function isRetryableLegacyDuplicate(
  event: OperationalSyncEvent,
  result: OperationalSyncResult,
) {
  if (event.operation !== "create" || result.status !== "conflict") {
    return false;
  }
  return (
    (event.domain === "shift" &&
      result.message.includes(
        "UNIQUE constraint failed: tbl_shift.kode_shift",
      )) ||
    (event.domain === "employee" &&
      result.message.includes("UNIQUE constraint failed: master_data.id_unik"))
  );
}

async function existingReceipt(
  transaction: Transaction,
  event: OperationalSyncEvent,
  hash: string,
): Promise<OperationalSyncResult | null> {
  const receipt = await transaction.execute({
    sql: `
      SELECT payload_hash, result_json FROM sync_operation_receipt
      WHERE event_id = ? LIMIT 1;
    `,
    args: [event.eventId],
  });
  if (receipt.rows.length === 0) return null;
  if (String(receipt.rows[0]?.payload_hash) !== hash) {
    return {
      eventId: event.eventId,
      status: "conflict",
      message: "Event ID sudah digunakan dengan payload yang berbeda.",
    };
  }
  try {
    const result = JSON.parse(
      String(receipt.rows[0]?.result_json),
    ) as OperationalSyncResult;
    if (isRetryableLegacyDuplicate(event, result)) {
      await transaction.execute({
        sql: "DELETE FROM sync_operation_receipt WHERE event_id = ?;",
        args: [event.eventId],
      });
      return null;
    }
    return result;
  } catch {
    return {
      eventId: event.eventId,
      status: "rejected",
      message: "Receipt sinkronisasi server tidak valid.",
    };
  }
}

async function currentEntityRevision(
  transaction: Transaction,
  domain: string,
  entityKey: string,
) {
  const result = await transaction.execute({
    sql: `
      SELECT COALESCE(MAX(revision), 0) AS revision
      FROM sync_change_log WHERE domain = ? AND entity_key = ?;
    `,
    args: [domain, entityKey],
  });
  return Number(result.rows[0]?.revision ?? 0);
}

async function recordResult(
  transaction: Transaction,
  actor: OperatorUser,
  event: OperationalSyncEvent,
  hash: string,
  result: OperationalSyncResult,
) {
  const now = new Date().toISOString();
  await transaction.execute({
    sql: `
      INSERT INTO sync_operation_receipt (
        event_id, client_id, domain, operation, entity_key, payload_hash,
        status, result_json, base_revision, server_revision,
        actor_operator_id, created_at, processed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
    `,
    args: [
      event.eventId,
      event.clientId,
      event.domain,
      event.operation,
      event.entityKey,
      hash,
      result.status,
      JSON.stringify(result),
      event.baseRevision ?? null,
      result.serverRevision ?? null,
      actor.id,
      new Date(event.createdAt * 1000).toISOString(),
      now,
    ],
  });
}

async function appendChange(
  transaction: Transaction,
  actor: OperatorUser,
  event: OperationalSyncEvent,
  payload: unknown,
) {
  const result = await transaction.execute({
    sql: `
      INSERT INTO sync_change_log (
        domain, entity_key, operation, payload_json, changed_at,
        actor_operator_id
      ) VALUES (?, ?, ?, ?, ?, ?);
    `,
    args: [
      event.domain,
      event.entityKey,
      event.operation,
      JSON.stringify(payload),
      new Date().toISOString(),
      actor.id,
    ],
  });
  return Number(result.lastInsertRowid);
}

async function applyEmployee(
  transaction: Transaction,
  actor: OperatorUser,
  event: OperationalSyncEvent,
) {
  const payload = event.payload;
  if (event.operation === "create") {
    const id = text(payload, "id_unik");
    const code = text(payload, "kode_karyawan");
    const name = text(payload, "nama");
    const division = text(payload, "divisi");
    if (!id || !code || name.length < 2 || !division) {
      throw new Error("Data karyawan belum lengkap atau tidak valid.");
    }
    const existing = await transaction.execute({
      sql: `SELECT id_unik, kode_karyawan FROM master_data
            WHERE id_unik = ? OR kode_karyawan = ?;`,
      args: [id, code],
    });
    const sameEmployee = existing.rows.some(
      (row) => String(row.id_unik) === id,
    );
    const codeOwnedByAnotherEmployee = existing.rows.some(
      (row) => String(row.kode_karyawan) === code && String(row.id_unik) !== id,
    );
    if (!sameEmployee && codeOwnedByAnotherEmployee) {
      throw new Error("Kode karyawan sudah digunakan oleh karyawan lain.");
    }
    if (!sameEmployee) {
      await transaction.execute({
        sql: `
        INSERT INTO master_data (
          id_unik, kode_karyawan, nama, divisi, jabatan_status, no_hp, lp,
          id_shift, status_aktif, tanggal_daftar, catatan, token_absensi,
          qr_code, status_qr, jenis_personil, tanggal_mulai_aktif,
          tanggal_selesai_aktif, status_backup
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Generated', ?, ?, ?, 'NORMAL');
      `,
        args: [
          id,
          code,
          name,
          division,
          text(payload, "jabatan_status") || "-",
          text(payload, "no_hp"),
          text(payload, "lp") || "L",
          number(payload, "id_shift", 1),
          text(payload, "status_aktif") || "Aktif",
          text(payload, "tanggal_daftar") ||
            new Date().toISOString().slice(0, 10),
          text(payload, "catatan"),
          text(payload, "token_absensi"),
          text(payload, "qr_code"),
          text(payload, "jenis_personil") || "Pegawai",
          text(payload, "tanggal_mulai_aktif") ||
            new Date().toISOString().slice(0, 10),
          text(payload, "tanggal_selesai_aktif"),
        ],
      });
      await transaction.execute({
        sql: `
        INSERT OR IGNORE INTO id_card (
          id_unik, nama, divisi, idcard_status, tanggal_generate
        ) VALUES (?, ?, ?, 'Belum', ?);
      `,
        args: [id, name, division, new Date().toISOString().slice(0, 10)],
      });
    }
  } else if (event.operation === "update") {
    await transaction.execute({
      sql: `
        UPDATE master_data SET kode_karyawan = ?, nama = ?, divisi = ?,
          jabatan_status = ?, no_hp = ?, lp = ?, id_shift = ?,
          status_aktif = ?, catatan = ? WHERE id_unik = ?;
      `,
      args: [
        text(payload, "kode_karyawan"),
        text(payload, "nama"),
        text(payload, "divisi"),
        text(payload, "jabatan_status"),
        text(payload, "no_hp"),
        text(payload, "lp"),
        number(payload, "id_shift"),
        text(payload, "status_aktif"),
        text(payload, "catatan"),
        event.entityKey,
      ],
    });
    await transaction.execute({
      sql: "UPDATE id_card SET nama = ?, divisi = ? WHERE id_unik = ?;",
      args: [text(payload, "nama"), text(payload, "divisi"), event.entityKey],
    });
  } else if (event.operation === "status") {
    const status = text(payload, "status_aktif");
    if (status !== "Aktif" && status !== "Nonaktif") {
      throw new Error("Status karyawan tidak valid.");
    }
    await transaction.execute({
      sql: "UPDATE master_data SET status_aktif = ? WHERE id_unik = ?;",
      args: [status, event.entityKey],
    });
  } else if (event.operation === "token") {
    await transaction.execute({
      sql: `
        UPDATE master_data SET token_absensi = ?, qr_code = ?, status_qr = 'Generated'
        WHERE id_unik = ?;
      `,
      args: [
        text(payload, "token_absensi"),
        text(payload, "qr_code"),
        event.entityKey,
      ],
    });
  } else {
    throw new Error("Operasi Karyawan tidak dikenali.");
  }
  const revision = await appendChange(transaction, actor, event, payload);
  return {
    revision,
    payload: { id_unik: event.entityKey },
  };
}

async function applyShift(
  transaction: Transaction,
  actor: OperatorUser,
  event: OperationalSyncEvent,
) {
  const payload = event.payload;
  let entityKey = event.entityKey;
  let serverId = number(payload, "id_shift");
  if (event.operation === "create") {
    const code = number(payload, "kode_shift");
    const existing = await transaction.execute({
      sql: "SELECT id_shift FROM tbl_shift WHERE kode_shift = ? LIMIT 1;",
      args: [code],
    });
    if (existing.rows.length > 0) {
      serverId = Number(existing.rows[0]?.id_shift);
    } else {
      const result = await transaction.execute({
        sql: `
        INSERT INTO tbl_shift (
          kode_shift, nama_shift, jam_masuk, jam_pulang, awal_absen_menit,
          batas_masuk_menit, toleransi_masuk_menit, jam_kerja_normal_menit,
          istirahat_menit, batas_pulang_menit, offset_istirahat_mulai,
          offset_generate_alfa, buffer_shift_malam_menit
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
      `,
        args: [
          code,
          text(payload, "nama_shift"),
          text(payload, "jam_masuk"),
          text(payload, "jam_pulang"),
          number(payload, "awal_absen_menit", 120),
          number(payload, "batas_masuk_menit", 60),
          number(payload, "toleransi_masuk_menit"),
          number(payload, "jam_kerja_normal_menit", 480),
          number(payload, "istirahat_menit", 60),
          number(payload, "batas_pulang_menit", 240),
          number(payload, "offset_istirahat_mulai", 240),
          number(payload, "offset_generate_alfa", 180),
          number(payload, "buffer_shift_malam_menit", 120),
        ],
      });
      serverId = Number(result.lastInsertRowid);
    }
    entityKey = String(serverId);
  } else if (event.operation === "update") {
    serverId = Number(event.entityKey);
    await transaction.execute({
      sql: `
        UPDATE tbl_shift SET 
          nama_shift = ?, jam_masuk = ?, jam_pulang = ?,
          awal_absen_menit = ?, batas_masuk_menit = ?, toleransi_masuk_menit = ?,
          jam_kerja_normal_menit = ?, istirahat_menit = ?, batas_pulang_menit = ?,
          offset_istirahat_mulai = ?, offset_generate_alfa = ?, buffer_shift_malam_menit = ?
        WHERE id_shift = ?;
      `,
      args: [
        text(payload, "nama_shift"),
        text(payload, "jam_masuk"),
        text(payload, "jam_pulang"),
        number(payload, "awal_absen_menit", 120),
        number(payload, "batas_masuk_menit", 60),
        number(payload, "toleransi_masuk_menit"),
        number(payload, "jam_kerja_normal_menit", 480),
        number(payload, "istirahat_menit", 60),
        number(payload, "batas_pulang_menit", 240),
        number(payload, "offset_istirahat_mulai", 240),
        number(payload, "offset_generate_alfa", 180),
        number(payload, "buffer_shift_malam_menit", 120),
        serverId,
      ],
    });
  } else if (event.operation === "delete") {
    serverId = Number(event.entityKey);
    const used = await transaction.execute({
      sql: "SELECT COUNT(*) AS total FROM master_data WHERE id_shift = ?;",
      args: [serverId],
    });
    if (Number(used.rows[0]?.total ?? 0) > 0) {
      throw new Error("Shift masih digunakan oleh karyawan.");
    }
    await transaction.execute({
      sql: "DELETE FROM tbl_shift WHERE id_shift = ?;",
      args: [serverId],
    });
  } else {
    throw new Error("Operasi Shift tidak dikenali.");
  }
  const changeEvent = { ...event, entityKey };
  const revision = await appendChange(transaction, actor, changeEvent, payload);
  return {
    revision,
    payload: {
      id_shift: serverId,
      local_id_shift: number(payload, "local_id_shift"),
    },
  };
}

async function applyAttendance(
  transaction: Transaction,
  actor: OperatorUser,
  event: OperationalSyncEvent,
) {
  if (event.operation !== "scan") {
    throw new Error("Operasi absensi tidak dikenali.");
  }
  const log = event.payload.log;
  if (!log || typeof log !== "object" || Array.isArray(log)) {
    throw new Error("Payload LOG_SCAN tidak valid.");
  }
  const logData = log as Record<string, unknown>;
  const idKaryawan = text(logData, "id_karyawan");
  const timestamp = text(logData, "timestamp_scan");
  if (!idKaryawan || !timestamp || !text(logData, "jenis_scan")) {
    throw new Error("Data LOG_SCAN belum lengkap.");
  }

  const attendance = event.payload.attendance;
  if (
    attendance &&
    typeof attendance === "object" &&
    !Array.isArray(attendance)
  ) {
    const data = attendance as Record<string, unknown>;
    const idSesi = text(data, "id_sesi");
    if (!idSesi || !text(data, "tanggal")) {
      throw new Error("Data ABSENSI_HARIAN belum lengkap.");
    }
    const existing = await transaction.execute({
      sql: `SELECT sumber, update_terakhir
            FROM absensi_harian WHERE id_sesi = ? LIMIT 1;`,
      args: [idSesi],
    });
    const current = existing.rows[0];
    if (current && String(current.sumber) === "Koreksi Admin") {
      throw new Error(
        "Data absensi sudah dikoreksi admin dan tidak boleh ditimpa scanner.",
      );
    }
    const baseUpdatedAt = text(event.payload, "attendanceBaseUpdatedAt");
    if (
      (current && !baseUpdatedAt) ||
      (current && String(current.update_terakhir) !== baseUpdatedAt) ||
      (!current && baseUpdatedAt)
    ) {
      throw new Error(
        "Data absensi server berubah setelah scan lokal diproses.",
      );
    }
  }

  const logResult = await transaction.execute({
    sql: `
      INSERT INTO log_scan (
        timestamp_scan, tanggal_kerja, jam_scan, id_karyawan, nama, divisi,
        jenis_scan, status_proses, sumber_data, catatan_sistem, keterangan,
        menit_terlambat, menit_datang_awal, id_referensi, kode_operator
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
    `,
    args: [
      timestamp,
      text(logData, "tanggal_kerja"),
      text(logData, "jam_scan"),
      idKaryawan,
      text(logData, "nama"),
      text(logData, "divisi"),
      text(logData, "jenis_scan"),
      text(logData, "status_proses"),
      "Scanner",
      text(logData, "catatan_sistem"),
      text(logData, "keterangan"),
      number(logData, "menit_terlambat"),
      number(logData, "menit_datang_awal"),
      text(logData, "id_referensi"),
      actor.kode_operator,
    ],
  });

  let idSesi = "";
  if (
    attendance &&
    typeof attendance === "object" &&
    !Array.isArray(attendance)
  ) {
    const data = attendance as Record<string, unknown>;
    idSesi = text(data, "id_sesi");
    await transaction.execute({
      sql: `
        INSERT INTO absensi_harian (
          tanggal, id_karyawan, nama, kelas_divisi, jam_masuk, jam_pulang,
          status_kehadiran, status_absen, keterangan, sumber, update_terakhir,
          menit_terlambat, menit_datang_awal, jam_kerja, lembur,
          jam_kerja_kurang, id_shift, bulan, tahun, id_sesi, mode_tugas,
          id_backup, id_karyawan_asal, tanggal_tugas
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'Scanner', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id_sesi) DO UPDATE SET
          jam_masuk = excluded.jam_masuk,
          jam_pulang = excluded.jam_pulang,
          status_kehadiran = excluded.status_kehadiran,
          status_absen = excluded.status_absen,
          keterangan = excluded.keterangan,
          sumber = 'Scanner',
          update_terakhir = excluded.update_terakhir,
          menit_terlambat = excluded.menit_terlambat,
          menit_datang_awal = excluded.menit_datang_awal,
          jam_kerja = excluded.jam_kerja,
          lembur = excluded.lembur,
          jam_kerja_kurang = excluded.jam_kerja_kurang;
      `,
      args: [
        text(data, "tanggal"),
        text(data, "id_karyawan"),
        text(data, "nama"),
        text(data, "kelas_divisi"),
        text(data, "jam_masuk"),
        text(data, "jam_pulang"),
        text(data, "status_kehadiran"),
        text(data, "status_absen"),
        text(data, "keterangan"),
        text(data, "update_terakhir"),
        number(data, "menit_terlambat"),
        number(data, "menit_datang_awal"),
        number(data, "jam_kerja"),
        number(data, "lembur"),
        number(data, "jam_kerja_kurang"),
        number(data, "id_shift", 1),
        text(data, "bulan"),
        number(data, "tahun"),
        idSesi,
        text(data, "mode_tugas") || "NORMAL",
        text(data, "id_backup"),
        text(data, "id_karyawan_asal"),
        text(data, "tanggal_tugas"),
      ],
    });
  }
  const revision = await appendChange(transaction, actor, event, event.payload);
  return {
    revision,
    payload: { id_log: Number(logResult.lastInsertRowid), id_sesi: idSesi },
  };
}

async function applyCorrection(
  transaction: Transaction,
  actor: OperatorUser,
  event: OperationalSyncEvent,
) {
  if (event.operation !== "create") {
    throw new Error("Operasi Koreksi Admin tidak dikenali.");
  }
  const correction = event.payload.correction;
  const attendance = event.payload.attendance;
  const log = event.payload.log;
  if (
    !correction ||
    typeof correction !== "object" ||
    Array.isArray(correction) ||
    !attendance ||
    typeof attendance !== "object" ||
    Array.isArray(attendance) ||
    !log ||
    typeof log !== "object" ||
    Array.isArray(log)
  ) {
    throw new Error("Payload Koreksi Admin tidak valid.");
  }
  const data = correction as Record<string, unknown>;
  const daily = attendance as Record<string, unknown>;
  const logData = log as Record<string, unknown>;
  const reference = text(data, "id_referensi");
  const sessionId = text(daily, "id_sesi");
  if (!reference || !sessionId || !text(data, "jenis_koreksi")) {
    throw new Error("Data Koreksi Admin belum lengkap.");
  }
  const existing = await transaction.execute({
    sql: "SELECT update_terakhir FROM absensi_harian WHERE id_sesi = ? LIMIT 1;",
    args: [sessionId],
  });
  const current = existing.rows[0];
  const base = text(event.payload, "attendanceBaseUpdatedAt");
  if (
    (current && !base) ||
    (current && String(current.update_terakhir) !== base) ||
    (!current && base)
  ) {
    throw new Error(
      "Data absensi server berubah setelah Koreksi Admin lokal dibuat.",
    );
  }
  const correctionResult = await transaction.execute({
    sql: `INSERT INTO koreksi_admin (
      id_referensi, tanggal, id_karyawan, nama, divisi, jenis_koreksi,
      jam_koreksi, keterangan_admin, status_proses, timestamp, kode_operator
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Sudah Diproses', ?, ?);`,
    args: [
      reference,
      text(data, "tanggal"),
      text(data, "id_karyawan"),
      text(data, "nama"),
      text(data, "divisi"),
      text(data, "jenis_koreksi"),
      text(data, "jam_koreksi"),
      text(data, "keterangan_admin"),
      text(data, "timestamp"),
      actor.kode_operator,
    ],
  });
  const logResult = await transaction.execute({
    sql: `INSERT INTO log_scan (
      timestamp_scan, tanggal_kerja, jam_scan, id_karyawan, nama, divisi,
      jenis_scan, status_proses, sumber_data, catatan_sistem, keterangan,
      menit_terlambat, menit_datang_awal, id_referensi, kode_operator
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'Berhasil', 'Koreksi Admin', ?, ?, ?, ?, ?, ?);`,
    args: [
      text(logData, "timestamp_scan"),
      text(logData, "tanggal_kerja"),
      text(logData, "jam_scan"),
      text(logData, "id_karyawan"),
      text(logData, "nama"),
      text(logData, "divisi"),
      text(logData, "jenis_scan"),
      text(logData, "catatan_sistem"),
      text(logData, "keterangan"),
      number(logData, "menit_terlambat"),
      number(logData, "menit_datang_awal"),
      reference,
      actor.kode_operator,
    ],
  });
  await transaction.execute({
    sql: `INSERT INTO absensi_harian (
      tanggal, id_karyawan, nama, kelas_divisi, jam_masuk, jam_pulang,
      status_kehadiran, status_absen, keterangan, sumber, update_terakhir,
      menit_terlambat, menit_datang_awal, jam_kerja, lembur,
      jam_kerja_kurang, id_shift, bulan, tahun, id_sesi, mode_tugas,
      id_backup, id_karyawan_asal, tanggal_tugas
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'Koreksi Admin', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id_sesi) DO UPDATE SET
      jam_masuk = excluded.jam_masuk, jam_pulang = excluded.jam_pulang,
      status_kehadiran = excluded.status_kehadiran,
      status_absen = excluded.status_absen, keterangan = excluded.keterangan,
      sumber = 'Koreksi Admin', update_terakhir = excluded.update_terakhir,
      menit_terlambat = excluded.menit_terlambat,
      menit_datang_awal = excluded.menit_datang_awal,
      jam_kerja = excluded.jam_kerja, lembur = excluded.lembur,
      jam_kerja_kurang = excluded.jam_kerja_kurang;`,
    args: [
      text(daily, "tanggal"),
      text(daily, "id_karyawan"),
      text(daily, "nama"),
      text(daily, "kelas_divisi"),
      text(daily, "jam_masuk"),
      text(daily, "jam_pulang"),
      text(daily, "status_kehadiran"),
      text(daily, "status_absen"),
      text(daily, "keterangan"),
      text(daily, "update_terakhir"),
      number(daily, "menit_terlambat"),
      number(daily, "menit_datang_awal"),
      number(daily, "jam_kerja"),
      number(daily, "lembur"),
      number(daily, "jam_kerja_kurang"),
      number(daily, "id_shift", 1),
      text(daily, "bulan"),
      number(daily, "tahun"),
      sessionId,
      text(daily, "mode_tugas") || "NORMAL",
      text(daily, "id_backup"),
      text(daily, "id_karyawan_asal"),
      text(daily, "tanggal_tugas"),
    ],
  });
  const revision = await appendChange(transaction, actor, event, event.payload);
  return {
    revision,
    payload: {
      id_koreksi: Number(correctionResult.lastInsertRowid),
      id_log: Number(logResult.lastInsertRowid),
      id_referensi: reference,
      id_sesi: sessionId,
    },
  };
}

async function applyBackup(
  transaction: Transaction,
  actor: OperatorUser,
  event: OperationalSyncEvent,
) {
  if (event.operation === "create") {
    const source = event.payload.backup;
    if (!source || typeof source !== "object" || Array.isArray(source)) {
      throw new Error("Payload penugasan backup tidak valid.");
    }
    const data = source as Record<string, unknown>;
    const id = text(data, "id_backup");
    if (
      !id ||
      !text(data, "id_karyawan_asal") ||
      !text(data, "id_karyawan_pengganti")
    ) {
      throw new Error("Data penugasan backup belum lengkap.");
    }
    const employees = await transaction.execute({
      sql: `SELECT COUNT(*) AS total FROM master_data WHERE status_aktif = 'Aktif'
            AND id_unik IN (?, ?);`,
      args: [
        text(data, "id_karyawan_asal"),
        text(data, "id_karyawan_pengganti"),
      ],
    });
    if (Number(employees.rows[0]?.total ?? 0) !== 2) {
      throw new Error("Karyawan asal atau pengganti tidak aktif di server.");
    }
    await transaction.execute({
      sql: `INSERT INTO backup_karyawan (
        id_backup, tanggal_tugas, id_karyawan_asal, nama_karyawan_asal,
        divisi_asal, id_shift_asal, id_karyawan_pengganti,
        nama_karyawan_pengganti, divisi_pengganti, id_shift_normal_pengganti,
        id_shift_backup, alasan_backup, status_tugas, kode_operator,
        waktu_input, catatan
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Aktif', ?, ?, ?);`,
      args: [
        id,
        text(data, "tanggal_tugas"),
        text(data, "id_karyawan_asal"),
        text(data, "nama_karyawan_asal"),
        text(data, "divisi_asal"),
        number(data, "id_shift_asal"),
        text(data, "id_karyawan_pengganti"),
        text(data, "nama_karyawan_pengganti"),
        text(data, "divisi_pengganti"),
        number(data, "id_shift_normal_pengganti"),
        number(data, "id_shift_backup"),
        text(data, "alasan_backup"),
        actor.kode_operator,
        text(data, "waktu_input"),
        text(data, "catatan"),
      ],
    });
  } else if (event.operation === "cancel") {
    const changed = await transaction.execute({
      sql: `UPDATE backup_karyawan SET status_tugas = 'Dibatalkan',
            waktu_dibatalkan = ?, operator_pembatalan = ?
            WHERE id_backup = ? AND status_tugas = 'Aktif';`,
      args: [
        text(event.payload, "waktu_dibatalkan"),
        actor.kode_operator,
        event.entityKey,
      ],
    });
    if (changed.rowsAffected === 0) {
      throw new Error("Penugasan backup aktif tidak ditemukan di server.");
    }
  } else {
    throw new Error("Operasi penugasan backup tidak dikenali.");
  }
  const revision = await appendChange(transaction, actor, event, event.payload);
  return { revision, payload: { id_backup: event.entityKey } };
}

async function applyOfflineImport(
  transaction: Transaction,
  actor: OperatorUser,
  event: OperationalSyncEvent,
) {
  const importValue = event.payload.import;
  const attendanceValue = event.payload.attendance;
  const logsValue = event.payload.logs;
  if (
    event.operation !== "row" ||
    !importValue ||
    typeof importValue !== "object" ||
    Array.isArray(importValue) ||
    !attendanceValue ||
    typeof attendanceValue !== "object" ||
    Array.isArray(attendanceValue) ||
    !Array.isArray(logsValue)
  ) {
    throw new Error("Payload Import Offline tidak valid.");
  }
  const imported = importValue as Record<string, unknown>;
  const daily = attendanceValue as Record<string, unknown>;
  const sessionId = text(daily, "id_sesi");
  const currentResult = await transaction.execute({
    sql: "SELECT sumber, update_terakhir FROM absensi_harian WHERE id_sesi = ? LIMIT 1;",
    args: [sessionId],
  });
  const current = currentResult.rows[0];
  if (current && String(current.sumber) === "Koreksi Admin") {
    throw new Error("Data sudah dikoreksi admin; import tidak boleh menimpa.");
  }
  const base = text(event.payload, "attendanceBaseUpdatedAt");
  if (
    (current && !base) ||
    (current && String(current.update_terakhir) !== base) ||
    (!current && base)
  ) {
    throw new Error(
      "Data absensi server berubah setelah Import Offline lokal dibuat.",
    );
  }
  const importResult = await transaction.execute({
    sql: `INSERT INTO import_offline (event_key, timestamp_input, tanggal, id_unik,
      nama, divisi, jam_masuk, jam_pulang, status_kehadiran, status_absen,
      keterangan, status_proses, diproses_pada, pesan_error, kode_operator)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Sudah Diproses', ?, '', ?);`,
    args: [
      text(imported, "event_key"),
      text(imported, "timestamp_input"),
      text(imported, "tanggal"),
      text(imported, "id_unik"),
      text(imported, "nama"),
      text(imported, "divisi"),
      text(imported, "jam_masuk"),
      text(imported, "jam_pulang"),
      text(imported, "status_kehadiran"),
      text(imported, "status_absen"),
      text(imported, "keterangan"),
      text(imported, "diproses_pada"),
      actor.kode_operator,
    ],
  });
  const logIds: number[] = [];
  for (const value of logsValue) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const log = value as Record<string, unknown>;
    const result = await transaction.execute({
      sql: `INSERT INTO log_scan (timestamp_scan, tanggal_kerja, jam_scan,
        id_karyawan, nama, divisi, jenis_scan, status_proses, sumber_data,
        catatan_sistem, keterangan, menit_terlambat, menit_datang_awal,
        id_referensi, kode_operator) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Import Offline',
        ?, ?, ?, ?, ?, ?);`,
      args: [
        text(log, "timestamp_scan"),
        text(log, "tanggal_kerja"),
        text(log, "jam_scan"),
        text(log, "id_karyawan"),
        text(log, "nama"),
        text(log, "divisi"),
        text(log, "jenis_scan"),
        text(log, "status_proses") || "Berhasil",
        text(log, "catatan_sistem"),
        text(log, "keterangan"),
        number(log, "menit_terlambat"),
        number(log, "menit_datang_awal"),
        text(log, "id_referensi"),
        actor.kode_operator,
      ],
    });
    logIds.push(Number(result.lastInsertRowid));
  }
  await transaction.execute({
    sql: `INSERT INTO absensi_harian (tanggal, id_karyawan, nama, kelas_divisi,
      jam_masuk, jam_pulang, status_kehadiran, status_absen, keterangan, sumber,
      update_terakhir, menit_terlambat, menit_datang_awal, jam_kerja, lembur,
      jam_kerja_kurang, id_shift, bulan, tahun, id_sesi, mode_tugas, id_backup,
      id_karyawan_asal, tanggal_tugas)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'Import Offline', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id_sesi) DO UPDATE SET jam_masuk = excluded.jam_masuk,
      jam_pulang = excluded.jam_pulang, status_kehadiran = excluded.status_kehadiran,
      status_absen = excluded.status_absen, keterangan = excluded.keterangan,
      sumber = 'Import Offline', update_terakhir = excluded.update_terakhir,
      menit_terlambat = excluded.menit_terlambat,
      menit_datang_awal = excluded.menit_datang_awal, jam_kerja = excluded.jam_kerja,
      lembur = excluded.lembur, jam_kerja_kurang = excluded.jam_kerja_kurang;`,
    args: [
      text(daily, "tanggal"),
      text(daily, "id_karyawan"),
      text(daily, "nama"),
      text(daily, "kelas_divisi"),
      text(daily, "jam_masuk"),
      text(daily, "jam_pulang"),
      text(daily, "status_kehadiran"),
      text(daily, "status_absen"),
      text(daily, "keterangan"),
      text(daily, "update_terakhir"),
      number(daily, "menit_terlambat"),
      number(daily, "menit_datang_awal"),
      number(daily, "jam_kerja"),
      number(daily, "lembur"),
      number(daily, "jam_kerja_kurang"),
      number(daily, "id_shift", 1),
      text(daily, "bulan"),
      number(daily, "tahun"),
      sessionId,
      text(daily, "mode_tugas") || "NORMAL",
      text(daily, "id_backup"),
      text(daily, "id_karyawan_asal"),
      text(daily, "tanggal_tugas"),
    ],
  });
  const revision = await appendChange(transaction, actor, event, event.payload);
  return {
    revision,
    payload: {
      id_import: Number(importResult.lastInsertRowid),
      log_ids: logIds,
      event_key: event.entityKey,
      id_sesi: sessionId,
    },
  };
}

async function applyIdCard(
  transaction: Transaction,
  actor: OperatorUser,
  event: OperationalSyncEvent,
) {
  if (event.operation !== "update")
    throw new Error("Operasi ID Card tidak dikenali.");
  const status = text(event.payload, "idcard_status");
  if (!event.entityKey || !["Belum", "Berhasil", "Gagal"].includes(status)) {
    throw new Error("Data ID Card tidak valid.");
  }
  const changed = await transaction.execute({
    sql: `UPDATE id_card SET idcard_status = ?, tanggal_generate = ?,
      idcard_last_generate = ?, idcard_pdf_url = ?, link_qr_png = ?,
      idcard_catatan = ? WHERE id_unik = ?;`,
    args: [
      status,
      text(event.payload, "tanggal_generate"),
      text(event.payload, "idcard_last_generate"),
      text(event.payload, "idcard_pdf_url"),
      text(event.payload, "link_qr_png"),
      text(event.payload, "idcard_catatan"),
      event.entityKey,
    ],
  });
  if (changed.rowsAffected === 0)
    throw new Error("ID Card karyawan tidak ditemukan.");
  const revision = await appendChange(transaction, actor, event, event.payload);
  return { revision, payload: { id_unik: event.entityKey } };
}

async function applyEvent(
  transaction: Transaction,
  actor: OperatorUser,
  event: OperationalSyncEvent,
) {
  if (event.domain === "employee") {
    return applyEmployee(transaction, actor, event);
  }
  if (event.domain === "shift") {
    return applyShift(transaction, actor, event);
  }
  if (event.domain === "attendance") {
    return applyAttendance(transaction, actor, event);
  }
  if (event.domain === "correction") {
    return applyCorrection(transaction, actor, event);
  }
  if (event.domain === "backup") {
    return applyBackup(transaction, actor, event);
  }
  if (event.domain === "offline-import") {
    return applyOfflineImport(transaction, actor, event);
  }
  if (event.domain === "id-card") return applyIdCard(transaction, actor, event);
  throw new Error(
    `Domain '${event.domain}' belum didukung oleh endpoint sync.`,
  );
}

export async function processOperationalSyncEvent(
  client: Client,
  actor: OperatorUser,
  eventInput: unknown,
): Promise<OperationalSyncResult> {
  const parsedEvent = safeParseOperationalSyncEvent(eventInput);
  if (!parsedEvent.success) {
    const candidate =
      eventInput && typeof eventInput === "object" && "eventId" in eventInput
        ? Reflect.get(eventInput, "eventId")
        : null;
    return {
      eventId: typeof candidate === "string" ? candidate : "invalid",
      status: "rejected",
      message: "Format event sinkronisasi tidak valid.",
    };
  }
  const event = parsedEvent.data as OperationalSyncEvent;
  const permission = DOMAIN_PERMISSION[event.domain];
  if (!permission) {
    return {
      eventId: event.eventId,
      status: "rejected",
      message: "Domain sinkronisasi tidak dikenali.",
    };
  }
  assertActorPermission(actor, permission);
  const hash = payloadHash(event);
  const transaction = await client.transaction("write");
  try {
    const receipt = await existingReceipt(transaction, event, hash);
    if (receipt) {
      await transaction.rollback();
      return receipt;
    }
    const currentRevision = await currentEntityRevision(
      transaction,
      event.domain,
      event.entityKey,
    );
    if (
      event.baseRevision !== null &&
      event.baseRevision !== undefined &&
      currentRevision > event.baseRevision
    ) {
      const result: OperationalSyncResult = {
        eventId: event.eventId,
        status: "conflict",
        message: "Data server berubah setelah snapshot lokal dibuat.",
        serverRevision: currentRevision,
      };
      await recordResult(transaction, actor, event, hash, result);
      await transaction.commit();
      return result;
    }
    try {
      const applied = await applyEvent(transaction, actor, event);
      const result: OperationalSyncResult = {
        eventId: event.eventId,
        status: "applied",
        message: "Event operasional berhasil disinkronkan.",
        serverRevision: applied.revision,
        serverPayload: applied.payload,
      };
      await recordResult(transaction, actor, event, hash, result);
      await transaction.commit();
      return result;
    } catch (error) {
      if (isTransientDatabaseError(error)) throw error;
      const result: OperationalSyncResult = {
        eventId: event.eventId,
        status: "conflict",
        message:
          error instanceof Error
            ? error.message
            : "Event bertentangan dengan data server.",
        serverRevision: currentRevision,
      };
      await transaction.rollback();
      const conflictTransaction = await client.transaction("write");
      try {
        const receipt = await existingReceipt(conflictTransaction, event, hash);
        if (receipt) {
          await conflictTransaction.rollback();
          return receipt;
        }
        await recordResult(conflictTransaction, actor, event, hash, result);
        await conflictTransaction.commit();
      } finally {
        conflictTransaction.close();
      }
      return result;
    }
  } finally {
    transaction.close();
  }
}
