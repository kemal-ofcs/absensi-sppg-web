import type { Client, Transaction } from "@libsql/client";
import {
  type ExplicitInstant,
  formatJamOperasional,
  formatTanggalOperasional,
  formatTimestampOperasional,
  putuskanScanWaktu,
  type ScanHistory,
  type ShiftTimePolicy,
  type TimeScanDecision,
  tentukanTanggalKerja,
} from "@/lib/attendance/time-policy";
import type { ScanResult } from "@/lib/contracts/scanner";
import { hitungJarakHaversine, parseQrToken } from "@/lib/validations/scanner";

export interface ScanPayload {
  qrText: string;
  lat?: number | null;
  lng?: number | null;
  sumberScan?:
    | "Scanner"
    | "Koreksi Admin"
    | "Import Offline"
    | "Generate Sistem";
  kodeOperator?: string;
}

export interface WebScanContext {
  waktuScan: ExplicitInstant;
  actorOperatorId?: number;
}

type SourceData = NonNullable<ScanPayload["sumberScan"]>;
type Row = Record<string, unknown>;

interface EmployeeContext {
  id: string;
  nama: string;
  divisi: string;
  idShift: number;
  row: Row;
}

interface BackupContext {
  row: Row;
  shiftRow: Row | null;
}

interface SessionContext {
  modeTugas: "NORMAL" | "PENGGANTI";
  shiftEfektif: number;
  idBackup: string;
  idKaryawanAsal: string;
  tanggalTugas: string;
}

const DEFAULT_MULTI_SCAN_MINUTES = 5;
const MONTHS = [
  "Januari",
  "Februari",
  "Maret",
  "April",
  "Mei",
  "Juni",
  "Juli",
  "Agustus",
  "September",
  "Oktober",
  "November",
  "Desember",
];

export async function processWebAttendanceScan(
  client: Client,
  payload: ScanPayload,
  context: WebScanContext,
): Promise<ScanResult> {
  const waktuScan = explicitDate(context.waktuScan);
  const transaction = await client.transaction("write");

  try {
    const result = await processInTransaction(transaction, payload, waktuScan);
    const revision = context.actorOperatorId
      ? await recordScanChange(
          transaction,
          result,
          context.actorOperatorId,
          waktuScan,
        )
      : undefined;
    await transaction.commit();
    return revision === undefined ? result : { ...result, revision };
  } catch (error) {
    await transaction.rollback();
    throw error;
  } finally {
    transaction.close();
  }
}

async function processInTransaction(
  transaction: Transaction,
  payload: ScanPayload,
  waktuScan: Date,
): Promise<ScanResult> {
  const sumberData: SourceData = payload.sumberScan ?? "Scanner";
  const kodeOperator = payload.kodeOperator?.trim() ?? "";
  const parsed = parseQrToken(payload.qrText);

  if (!parsed.valid) {
    return resultDitolak({
      pesan: parsed.pesan,
      id: "",
      nama: "-",
      divisi: "-",
    });
  }

  const masterResult = await transaction.execute({
    sql: "SELECT * FROM master_data WHERE id_unik = ? OR kode_karyawan = ? LIMIT 1;",
    args: [parsed.idUnik, parsed.idUnik],
  });
  const master = masterResult.rows[0] as Row | undefined;

  if (!master) {
    return resultDitolak({
      pesan: `Gagal: ID Karyawan '${parsed.idUnik}' tidak ditemukan.`,
      id: parsed.idUnik,
      nama: "-",
      divisi: "-",
    });
  }

  const employee: EmployeeContext = {
    id: String(master.id_unik),
    nama: String(master.nama),
    divisi: String(master.divisi),
    idShift: Number(master.id_shift),
    row: master,
  };
  const baseShiftRow = await getShiftRow(transaction, employee.idShift);
  const tanggalLogAwal = safeWorkDate(waktuScan, baseShiftRow);

  if (String(master.status_aktif ?? "").toLowerCase() !== "aktif") {
    return logKnownRejection(transaction, {
      waktuScan,
      tanggalKerja: tanggalLogAwal,
      employee,
      sumberData,
      kodeOperator,
      catatanSistem: "Karyawan berstatus nonaktif",
      pesan: "Scan ditolak: Karyawan berstatus non-aktif.",
    });
  }

  if (String(master.token_absensi ?? "").trim() !== parsed.token) {
    return logKnownRejection(transaction, {
      waktuScan,
      tanggalKerja: tanggalLogAwal,
      employee,
      sumberData,
      kodeOperator,
      catatanSistem: "Token QR tidak valid atau sudah diperbarui",
      pesan: "Akses ditolak: Token QR tidak valid / sudah diperbarui.",
    });
  }

  const settings = await getSettings(transaction);
  const geofenceEnabled =
    settings.geofence_enabled === "true" ||
    (settings.geofence_enabled === undefined &&
      (settingNumber(settings.lat_kantor, 0) !== 0 ||
        settingNumber(settings.lng_kantor, 0) !== 0));

  if (geofenceEnabled && (payload.lat == null || payload.lng == null)) {
    return logKnownRejection(transaction, {
      waktuScan,
      tanggalKerja: tanggalLogAwal,
      employee,
      sumberData,
      kodeOperator,
      catatanSistem: "GPS Tidak Terdeteksi",
      pesan:
        "Scan ditolak: Lokasi GPS HP Anda tidak terdeteksi. Wajib mengaktifkan izin lokasi.",
    });
  }

  if (geofenceEnabled && payload.lat != null && payload.lng != null) {
    const latKantor = settingNumber(settings.lat_kantor, 0);
    const lngKantor = settingNumber(settings.lng_kantor, 0);
    const radiusMax = settingNumber(settings.radius_meter, 100);
    const jarak = hitungJarakHaversine(
      payload.lat,
      payload.lng,
      latKantor,
      lngKantor,
    );

    if (jarak > radiusMax) {
      return logKnownRejection(transaction, {
        waktuScan,
        tanggalKerja: tanggalLogAwal,
        employee,
        sumberData,
        kodeOperator,
        catatanSistem: `Di luar radius kantor (${jarak}m > ${radiusMax}m)`,
        pesan: `Scan ditolak: Posisi Anda di luar area kantor (${jarak}m dari kantor, batas max: ${radiusMax}m).`,
      });
    }
  }

  const backup = await findEffectiveBackup(transaction, employee.id, waktuScan);
  if (backup && String(backup.row.id_karyawan_asal) === employee.id) {
    const idBackup = String(backup.row.id_backup);
    return logKnownRejection(transaction, {
      waktuScan,
      tanggalKerja: String(backup.row.tanggal_tugas),
      employee,
      sumberData,
      kodeOperator,
      catatanSistem: `Karyawan asal sedang digantikan. ID Backup: ${idBackup}`,
      pesan: `Scan ditolak: Anda sedang digantikan oleh ${backup.row.nama_karyawan_pengganti} (ID Backup: ${idBackup}).`,
      idReferensi: idBackup,
    });
  }

  const session: SessionContext = backup
    ? {
        modeTugas: "PENGGANTI",
        shiftEfektif: Number(backup.row.id_shift_backup),
        idBackup: String(backup.row.id_backup),
        idKaryawanAsal: String(backup.row.id_karyawan_asal),
        tanggalTugas: String(backup.row.tanggal_tugas),
      }
    : {
        modeTugas: "NORMAL",
        shiftEfektif: employee.idShift,
        idBackup: "",
        idKaryawanAsal: "",
        tanggalTugas: "",
      };
  const shiftRow = backup?.shiftRow ?? baseShiftRow;

  if (!shiftRow) {
    return logKnownRejection(transaction, {
      waktuScan,
      tanggalKerja: formatTanggalOperasional(waktuScan),
      employee,
      sumberData,
      kodeOperator,
      catatanSistem: `Konfigurasi shift ${session.shiftEfektif} tidak ditemukan`,
      pesan: "Absensi ditolak. Konfigurasi shift tidak valid.",
      idReferensi: session.idBackup,
      shiftEfektif: session.shiftEfektif,
      modeTugas: session.modeTugas,
    });
  }

  let shiftPolicy: ShiftTimePolicy;
  let tanggalKerja: string;
  try {
    shiftPolicy = mapShiftPolicy(shiftRow);
    tanggalKerja = tentukanTanggalKerja(waktuScan, shiftPolicy);
  } catch (error) {
    return logKnownRejection(transaction, {
      waktuScan,
      tanggalKerja: formatTanggalOperasional(waktuScan),
      employee,
      sumberData,
      kodeOperator,
      catatanSistem: `Konfigurasi shift tidak valid: ${errorMessage(error)}`,
      pesan: "Absensi ditolak. Konfigurasi shift tidak valid.",
      idReferensi: session.idBackup,
      shiftEfektif: session.shiftEfektif,
      modeTugas: session.modeTugas,
    });
  }

  const idSesi =
    session.modeTugas === "PENGGANTI"
      ? `${session.idBackup}-PENGGANTI-${employee.id}`
      : `NORMAL-${tanggalKerja.replaceAll("-", "")}-${employee.id}-${session.shiftEfektif}`;
  const cooldownSeconds = settingNumber(settings.anti_double_scan_seconds, 60);
  const latestScanResult = await transaction.execute({
    sql: `SELECT timestamp_scan FROM log_scan
          WHERE id_karyawan = ? AND sumber_data = ?
            AND status_proses IN ('Berhasil', 'Perlu Verifikasi')
          ORDER BY id_log DESC LIMIT 1;`,
    args: [employee.id, sumberData],
  });
  const latestScanTimestamp = latestScanResult.rows[0]?.timestamp_scan;

  if (latestScanTimestamp && cooldownSeconds > 0) {
    const latestScan = explicitDate(
      storedOperationalInstant(latestScanTimestamp),
    );
    const elapsedSeconds = (waktuScan.getTime() - latestScan.getTime()) / 1000;
    if (elapsedSeconds >= 0 && elapsedSeconds < cooldownSeconds) {
      const remaining = Math.ceil(cooldownSeconds - elapsedSeconds);
      return logKnownRejection(transaction, {
        waktuScan,
        tanggalKerja,
        employee,
        sumberData,
        kodeOperator,
        catatanSistem: `Scan ganda dalam masa cooldown (${cooldownSeconds} detik)`,
        keterangan: "Duplikat diabaikan",
        pesan: `Scan ganda terdeteksi. Silakan tunggu ${remaining} detik sebelum scan ulang.`,
        idReferensi: session.idBackup,
        idSesi,
        shiftEfektif: session.shiftEfektif,
        modeTugas: session.modeTugas,
      });
    }
  }

  const attendanceResult = await transaction.execute({
    sql: "SELECT * FROM absensi_harian WHERE id_sesi = ? LIMIT 1;",
    args: [idSesi],
  });
  const attendance = attendanceResult.rows[0] as Row | undefined;

  if (attendance && String(attendance.sumber) === "Koreksi Admin") {
    return logKnownRejection(transaction, {
      waktuScan,
      tanggalKerja,
      employee,
      sumberData,
      kodeOperator,
      catatanSistem: "Data absensi sudah dikoreksi admin",
      pesan:
        "Scan ditolak: Data absensi sudah dikoreksi Admin dan tidak boleh ditimpa scanner.",
      idReferensi: session.idBackup,
      idSesi,
      shiftEfektif: session.shiftEfektif,
      modeTugas: session.modeTugas,
    });
  }

  const scanHistory = await getScanHistory(transaction, {
    attendance,
    tanggalKerja,
    employeeId: employee.id,
    idReferensi: session.idBackup,
  });
  const multiScanMinutes = settingNumber(
    settings.batas_multi_scan_menit ?? settings.BATAS_MULTI_SCAN_MENIT,
    DEFAULT_MULTI_SCAN_MINUTES,
  );
  const keputusan = putuskanScanWaktu({
    waktuScan,
    shift: shiftPolicy,
    riwayat: scanHistory,
    batasMultiScanMenit: Math.max(0, Math.trunc(multiScanMinutes)),
  });

  if (!keputusan.boleh) {
    await insertLog(transaction, {
      waktuScan,
      tanggalKerja,
      employee,
      jenisScan: keputusan.jenisScan,
      statusProses: keputusan.statusProses,
      sumberData,
      catatanSistem: keputusan.catatanSistem,
      keterangan: keputusan.keterangan,
      menitTerlambat: keputusan.menitTerlambat,
      menitDatangAwal: keputusan.menitDatangAwal,
      idReferensi: session.idBackup,
      kodeOperator,
    });
    return resultFromDecision(keputusan, employee, session, idSesi);
  }

  await writeAttendance(transaction, {
    attendance,
    keputusan,
    waktuScan,
    tanggalKerja,
    employee,
    sumberData,
    session: {
      ...session,
      tanggalTugas: session.tanggalTugas || tanggalKerja,
    },
    idSesi,
  });
  await insertLog(transaction, {
    waktuScan,
    tanggalKerja,
    employee,
    jenisScan: keputusan.jenisScan,
    statusProses: keputusan.statusProses,
    sumberData,
    catatanSistem:
      session.modeTugas === "PENGGANTI"
        ? `${keputusan.catatanSistem}. ID Backup: ${session.idBackup}`
        : keputusan.catatanSistem,
    keterangan: keputusan.keterangan,
    menitTerlambat: keputusan.menitTerlambat,
    menitDatangAwal: keputusan.menitDatangAwal,
    idReferensi: session.idBackup,
    kodeOperator,
  });

  return resultFromDecision(keputusan, employee, session, idSesi);
}

async function findEffectiveBackup(
  transaction: Transaction,
  employeeId: string,
  waktuScan: Date,
): Promise<BackupContext | null> {
  const calendarDate = formatTanggalOperasional(waktuScan);
  const previousDate = addDays(calendarDate, -1);
  const result = await transaction.execute({
    sql: `SELECT * FROM backup_karyawan
          WHERE status_tugas = 'Aktif'
            AND tanggal_tugas IN (?, ?)
            AND (id_karyawan_asal = ? OR id_karyawan_pengganti = ?)
          ORDER BY tanggal_tugas DESC, id_backup DESC;`,
    args: [calendarDate, previousDate, employeeId, employeeId],
  });

  for (const candidate of result.rows as Row[]) {
    const shiftRow = await getShiftRow(
      transaction,
      Number(candidate.id_shift_backup),
    );
    if (!shiftRow) {
      if (String(candidate.tanggal_tugas) === calendarDate) {
        return { row: candidate, shiftRow: null };
      }
      continue;
    }

    if (String(candidate.id_karyawan_asal) === employeeId) {
      try {
        const date = tentukanTanggalKerja(waktuScan, mapShiftPolicy(shiftRow));
        if (date === String(candidate.tanggal_tugas)) {
          return { row: candidate, shiftRow };
        }
      } catch {
        if (String(candidate.tanggal_tugas) === calendarDate) {
          return { row: candidate, shiftRow };
        }
      }
      continue;
    }

    // Employee is replacement (pengganti)
    const backupSessionId = `${candidate.id_backup}-PENGGANTI-${employeeId}`;
    const openRes = await transaction.execute({
      sql: "SELECT 1 FROM absensi_harian WHERE id_sesi = ? AND jam_masuk != '' AND (jam_pulang IS NULL OR jam_pulang = '') LIMIT 1;",
      args: [backupSessionId],
    });
    if (openRes.rows.length > 0) {
      return { row: candidate, shiftRow };
    }

    try {
      const date = tentukanTanggalKerja(waktuScan, mapShiftPolicy(shiftRow));
      if (date === String(candidate.tanggal_tugas)) {
        return { row: candidate, shiftRow };
      }
    } catch {
      // ignore
    }
  }

  return null;
}

async function getScanHistory(
  transaction: Transaction,
  input: {
    attendance?: Row;
    tanggalKerja: string;
    employeeId: string;
    idReferensi: string;
  },
): Promise<ScanHistory> {
  const result = await transaction.execute({
    sql: `SELECT timestamp_scan, jenis_scan FROM log_scan
          WHERE tanggal_kerja = ? AND id_karyawan = ?
            AND COALESCE(id_referensi, '') = ?
            AND status_proses IN ('Berhasil', 'Perlu Verifikasi')
            AND jenis_scan IN ('Masuk', 'Pulang')
          ORDER BY id_log DESC LIMIT 1;`,
    args: [input.tanggalKerja, input.employeeId, input.idReferensi],
  });

  const latest = result.rows[0];

  return {
    waktuMasuk: input.attendance?.jam_masuk
      ? storedOperationalInstant(input.attendance.jam_masuk)
      : null,
    waktuPulang: input.attendance?.jam_pulang
      ? storedOperationalInstant(input.attendance.jam_pulang)
      : null,
    scanTerakhir: latest?.timestamp_scan
      ? storedOperationalInstant(latest.timestamp_scan)
      : null,
    jenisScanTerakhir:
      latest?.jenis_scan === "Masuk" || latest?.jenis_scan === "Pulang"
        ? latest.jenis_scan
        : null,
  };
}

async function writeAttendance(
  transaction: Transaction,
  input: {
    attendance?: Row;
    keputusan: TimeScanDecision;
    waktuScan: Date;
    tanggalKerja: string;
    employee: EmployeeContext;
    sumberData: SourceData;
    session: SessionContext;
    idSesi: string;
  },
): Promise<void> {
  const timestamp = formatTimestampOperasional(input.waktuScan);
  const [year, month] = input.tanggalKerja.split("-").map(Number);
  const isEntry = input.keputusan.jenisScan === "Masuk";
  const statusAbsen = isEntry
    ? "Belum Pulang"
    : input.keputusan.statusProses === "Perlu Verifikasi"
      ? "Perlu Verifikasi"
      : "Lengkap";

  if (!input.attendance) {
    await transaction.execute({
      sql: `INSERT INTO absensi_harian (
              tanggal, id_karyawan, nama, kelas_divisi, jam_masuk, jam_pulang,
              status_kehadiran, status_absen, keterangan, sumber, update_terakhir,
              menit_terlambat, menit_datang_awal, jam_kerja, lembur,
              jam_kerja_kurang, id_shift, bulan, tahun, id_sesi, mode_tugas,
              id_backup, id_karyawan_asal, tanggal_tugas
            ) VALUES (?, ?, ?, ?, ?, ?, 'Hadir', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      args: [
        input.tanggalKerja,
        input.employee.id,
        input.employee.nama,
        input.employee.divisi,
        isEntry ? timestamp : "",
        isEntry ? "" : timestamp,
        statusAbsen,
        input.keputusan.keterangan,
        input.sumberData,
        timestamp,
        input.keputusan.menitTerlambat,
        input.keputusan.menitDatangAwal,
        input.keputusan.perhitungan.jamKerjaMenit,
        input.keputusan.perhitungan.lemburMenit,
        input.keputusan.perhitungan.jamKerjaKurangMenit,
        input.session.shiftEfektif,
        MONTHS[month - 1] ?? "Januari",
        year,
        input.idSesi,
        input.session.modeTugas,
        input.session.idBackup,
        input.session.idKaryawanAsal,
        input.session.tanggalTugas,
      ],
    });
    return;
  }

  const updateResult = isEntry
    ? await transaction.execute({
        sql: `UPDATE absensi_harian SET
              jam_masuk = ?, status_kehadiran = 'Hadir', status_absen = ?,
              keterangan = ?, sumber = ?, update_terakhir = ?,
              menit_terlambat = ?, menit_datang_awal = ?, id_shift = ?,
              mode_tugas = ?, id_backup = ?, id_karyawan_asal = ?, tanggal_tugas = ?
              WHERE id_sesi = ? AND sumber <> 'Koreksi Admin';`,
        args: [
          timestamp,
          statusAbsen,
          input.keputusan.keterangan,
          input.sumberData,
          timestamp,
          input.keputusan.menitTerlambat,
          input.keputusan.menitDatangAwal,
          input.session.shiftEfektif,
          input.session.modeTugas,
          input.session.idBackup,
          input.session.idKaryawanAsal,
          input.session.tanggalTugas,
          input.idSesi,
        ],
      })
    : await transaction.execute({
        sql: `UPDATE absensi_harian SET
              jam_pulang = ?, status_kehadiran = 'Hadir', status_absen = ?,
              keterangan = ?, sumber = ?, update_terakhir = ?, jam_kerja = ?,
              lembur = ?, jam_kerja_kurang = ?, id_shift = ?, mode_tugas = ?,
              id_backup = ?, id_karyawan_asal = ?, tanggal_tugas = ?
              WHERE id_sesi = ? AND sumber <> 'Koreksi Admin';`,
        args: [
          timestamp,
          statusAbsen,
          input.keputusan.keterangan,
          input.sumberData,
          timestamp,
          input.keputusan.perhitungan.jamKerjaMenit,
          input.keputusan.perhitungan.lemburMenit,
          input.keputusan.perhitungan.jamKerjaKurangMenit,
          input.session.shiftEfektif,
          input.session.modeTugas,
          input.session.idBackup,
          input.session.idKaryawanAsal,
          input.session.tanggalTugas,
          input.idSesi,
        ],
      });

  if (updateResult.rowsAffected !== 1) {
    throw new Error(
      "ABSENSI_HARIAN tidak dapat diperbarui karena data berubah selama scan.",
    );
  }
}

async function logKnownRejection(
  transaction: Transaction,
  input: {
    waktuScan: Date;
    tanggalKerja: string;
    employee: EmployeeContext;
    sumberData: SourceData;
    kodeOperator: string;
    catatanSistem: string;
    pesan: string;
    keterangan?: string;
    idReferensi?: string;
    idSesi?: string;
    shiftEfektif?: number;
    modeTugas?: "NORMAL" | "PENGGANTI";
  },
): Promise<ScanResult> {
  await insertLog(transaction, {
    waktuScan: input.waktuScan,
    tanggalKerja: input.tanggalKerja,
    employee: input.employee,
    jenisScan: "Scan Ditolak",
    statusProses: "Ditolak",
    sumberData: input.sumberData,
    catatanSistem: input.catatanSistem,
    keterangan: input.keterangan ?? "",
    menitTerlambat: 0,
    menitDatangAwal: 0,
    idReferensi: input.idReferensi ?? "",
    kodeOperator: input.kodeOperator,
  });
  return resultDitolak({
    pesan: input.pesan,
    id: input.employee.id,
    nama: input.employee.nama,
    divisi: input.employee.divisi,
    catatanSistem: input.catatanSistem,
    keterangan: input.keterangan,
    idSesi: input.idSesi,
    shiftEfektif: input.shiftEfektif,
    modeTugas: input.modeTugas,
  });
}

async function insertLog(
  transaction: Transaction,
  input: {
    waktuScan: Date;
    tanggalKerja: string;
    employee: EmployeeContext;
    jenisScan: string;
    statusProses: string;
    sumberData: SourceData;
    catatanSistem: string;
    keterangan: string;
    menitTerlambat: number;
    menitDatangAwal: number;
    idReferensi: string;
    kodeOperator: string;
  },
): Promise<void> {
  await transaction.execute({
    sql: `INSERT INTO log_scan (
            timestamp_scan, tanggal_kerja, jam_scan, id_karyawan, nama, divisi,
            jenis_scan, status_proses, sumber_data, catatan_sistem, keterangan,
            menit_terlambat, menit_datang_awal, id_referensi, kode_operator
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
    args: [
      formatTimestampOperasional(input.waktuScan),
      input.tanggalKerja,
      formatJamOperasional(input.waktuScan),
      input.employee.id,
      input.employee.nama,
      input.employee.divisi,
      input.jenisScan,
      input.statusProses,
      input.sumberData,
      input.catatanSistem,
      input.keterangan,
      input.menitTerlambat,
      input.menitDatangAwal,
      input.idReferensi,
      input.kodeOperator,
    ],
  });
}

async function recordScanChange(
  transaction: Transaction,
  result: ScanResult,
  actorOperatorId: number,
  waktuScan: Date,
): Promise<number> {
  const entityKey =
    result.idSesi ??
    `scan:${waktuScan.getTime()}:${result.idKaryawan || "tidak-dikenal"}`;
  const changeResult = await transaction.execute({
    sql: `INSERT INTO sync_change_log (
            domain, entity_key, operation, payload_json, changed_at,
            actor_operator_id
          ) VALUES ('attendance', ?, 'scan', ?, ?, ?);`,
    args: [
      entityKey,
      JSON.stringify(result),
      waktuScan.toISOString(),
      actorOperatorId,
    ],
  });
  return Number(changeResult.lastInsertRowid);
}

async function getSettings(
  transaction: Transaction,
): Promise<Record<string, string>> {
  const result = await transaction.execute(
    "SELECT key, value FROM setting_gex_system;",
  );
  return Object.fromEntries(
    result.rows.map((row) => [String(row.key), String(row.value)]),
  );
}

async function getShiftRow(
  transaction: Transaction,
  idShift: number,
): Promise<Row | null> {
  const result = await transaction.execute({
    sql: "SELECT * FROM tbl_shift WHERE id_shift = ? OR kode_shift = ? LIMIT 1;",
    args: [idShift, idShift],
  });
  return (result.rows[0] as Row | undefined) ?? null;
}

function mapShiftPolicy(row: Row): ShiftTimePolicy {
  const kodeShift = Number(row.kode_shift);
  const normalMinutes = Number(row.jam_kerja_normal_menit ?? 0);
  const flexible = kodeShift === 4 || normalMinutes === 0;
  return {
    kind: flexible ? "flexible" : "regular",
    jamMasuk: String(row.jam_masuk ?? ""),
    jamPulang: String(row.jam_pulang ?? ""),
    awalAbsenMenit: Number(row.awal_absen_menit ?? 120),
    batasMasukMenit: Number(row.batas_masuk_menit ?? 60),
    toleransiMasukMenit: Number(row.toleransi_masuk_menit ?? 0),
    batasPulangMenit: Number(row.batas_pulang_menit ?? 240),
    bufferShiftMalamMenit: Number(row.buffer_shift_malam_menit ?? 120),
    offsetIstirahatMulai: Number(row.offset_istirahat_mulai ?? 240),
    jamKerjaNormalMenit: normalMinutes,
    istirahatMenit: Number(row.istirahat_menit ?? 60),
  };
}

function safeWorkDate(waktuScan: Date, shiftRow: Row | null): string {
  if (!shiftRow) return formatTanggalOperasional(waktuScan);
  try {
    return tentukanTanggalKerja(waktuScan, mapShiftPolicy(shiftRow));
  } catch {
    return formatTanggalOperasional(waktuScan);
  }
}

function resultFromDecision(
  keputusan: TimeScanDecision,
  employee: EmployeeContext,
  session: SessionContext,
  idSesi: string,
): ScanResult {
  let pesan = keputusan.boleh
    ? `Jam ${keputusan.jenisScan} ${employee.nama} (${employee.id}) berhasil dicatat.\nStatus: ${keputusan.keterangan}`
    : rejectedDecisionMessage(keputusan);
  if (keputusan.menitTerlambat > 0) {
    pesan += `\nTerlambat: ${keputusan.menitTerlambat} menit.`;
  }
  if (keputusan.menitDatangAwal > 0) {
    pesan += `\nDatang awal: ${keputusan.menitDatangAwal} menit.`;
  }
  if (keputusan.perhitungan.lemburMenit > 0) {
    pesan += `\nLembur: ${keputusan.perhitungan.lemburMenit} menit.`;
  }
  if (keputusan.perhitungan.jamKerjaKurangMenit > 0) {
    pesan += `\nJam kerja kurang: ${keputusan.perhitungan.jamKerjaKurangMenit} menit.`;
  }

  return {
    sukses: keputusan.boleh,
    status: keputusan.statusProses,
    jenisScan: keputusan.jenisScan,
    idKaryawan: employee.id,
    nama: employee.nama,
    divisi: employee.divisi,
    pesan,
    catatanSistem: keputusan.catatanSistem,
    keterangan: keputusan.keterangan,
    menitTerlambat: keputusan.menitTerlambat,
    menitDatangAwal: keputusan.menitDatangAwal,
    jamKerja: keputusan.perhitungan.jamKerjaMenit,
    lembur: keputusan.perhitungan.lemburMenit,
    jamKerjaKurang: keputusan.perhitungan.jamKerjaKurangMenit,
    shiftEfektif: session.shiftEfektif,
    modeTugas: session.modeTugas,
    idSesi,
  };
}

function resultDitolak(input: {
  pesan: string;
  id: string;
  nama: string;
  divisi: string;
  catatanSistem?: string;
  keterangan?: string;
  idSesi?: string;
  shiftEfektif?: number;
  modeTugas?: "NORMAL" | "PENGGANTI";
}): ScanResult {
  return {
    sukses: false,
    status: "Ditolak",
    jenisScan: "Scan Ditolak",
    idKaryawan: input.id,
    nama: input.nama,
    divisi: input.divisi,
    pesan: input.pesan,
    catatanSistem: input.catatanSistem,
    keterangan: input.keterangan,
    idSesi: input.idSesi,
    shiftEfektif: input.shiftEfektif,
    modeTugas: input.modeTugas,
  };
}

function rejectedDecisionMessage(keputusan: TimeScanDecision): string {
  switch (keputusan.alasan) {
    case "TOO_EARLY":
      return "Absensi belum dibuka untuk shift ini.";
    case "ENTRY_WINDOW_CLOSED":
      return "Waktu absensi masuk sudah ditutup. Silakan hubungi operator.";
    case "MULTI_SCAN":
      return "Scan ditolak. Kemungkinan Anda melakukan scan masuk ulang.";
    case "CHECKOUT_TOO_LATE":
      return "Scan ditolak. Batas waktu pulang shift sudah berakhir.";
    case "ALREADY_CHECKED_OUT":
      return "Scan pulang sudah tercatat sebelumnya.";
    default:
      return "Scan ditolak oleh aturan waktu shift.";
  }
}

function explicitDate(value: ExplicitInstant): Date {
  const date =
    value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("Waktu scan tidak valid.");
  return date;
}

function storedOperationalInstant(value: unknown): string {
  const text = String(value ?? "").trim();
  if (/(?:Z|[+-]\d{2}:\d{2})$/i.test(text)) return text;
  const normalized = text.replace(" ", "T");
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(normalized)) {
    return `${normalized.length === 16 ? `${normalized}:00` : normalized}+07:00`;
  }
  throw new Error("Timestamp riwayat absensi tidak valid.");
}

function settingNumber(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Error tidak dikenal";
}
