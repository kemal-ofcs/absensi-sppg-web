import "server-only";

import { randomUUID } from "node:crypto";
import type { InValue, Transaction } from "@libsql/client";
import { db, ensureDbInitialized } from "@/lib/db";

export interface OfflineImportRow {
  tanggal: string;
  id_unik: string;
  nama?: string;
  divisi?: string;
  jam_masuk?: string;
  jam_pulang?: string;
  status_kehadiran?: string;
  status_absen?: string;
  keterangan?: string;
}

const TIME = /^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/;
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

function timestamp(date: string, time: string, nextDay = false) {
  const clean = time.trim();
  const parts = clean.split(":");
  const h = (parts[0] || "00").padStart(2, "0");
  const m = (parts[1] || "00").padStart(2, "0");
  const s = parts[2] ? parts[2].slice(0, 2).padStart(2, "0") : "00";
  const normalized = `${h}:${m}:${s}`;
  if (!nextDay) return `${date} ${normalized}`;
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + 1);
  return `${value.toISOString().slice(0, 10)} ${normalized}`;
}

function normalizeDate(raw: string): string {
  const clean = raw.trim();
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(clean)) {
    const [d, m, y] = clean.split("/");
    return `${y}-${m}-${d}`;
  }
  return clean;
}

async function processRow(
  transaction: Transaction,
  row: OfflineImportRow,
  operator: string,
) {
  const eventKey = `IMP-${randomUUID()}`;
  const now = new Date().toISOString();
  let date = normalizeDate(row.tanggal);
  const fail = async (message: string) => {
    await transaction.execute({
      sql: `INSERT INTO import_offline (event_key, timestamp_input, tanggal, id_unik,
            nama, divisi, jam_masuk, jam_pulang, status_kehadiran, status_absen,
            keterangan, status_proses, diproses_pada, pesan_error, kode_operator)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Gagal', ?, ?, ?);`,
      args: [
        eventKey,
        now,
        date,
        row.id_unik,
        row.nama ?? "",
        row.divisi ?? "",
        row.jam_masuk ?? "",
        row.jam_pulang ?? "",
        row.status_kehadiran ?? "",
        row.status_absen ?? "",
        row.keterangan ?? "",
        now,
        message,
        operator,
      ],
    });
    return { sukses: false, eventKey, pesan: message };
  };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !row.id_unik)
    return fail("Tanggal atau ID tidak valid.");
  if (
    (!row.jam_masuk && !row.jam_pulang) ||
    (row.jam_masuk && !TIME.test(row.jam_masuk)) ||
    (row.jam_pulang && !TIME.test(row.jam_pulang))
  )
    return fail("Jam masuk/pulang tidak valid.");
  const employeeResult = await transaction.execute({
    sql: "SELECT id_unik, nama, divisi, id_shift, status_aktif FROM master_data WHERE id_unik = ? OR kode_karyawan = ? LIMIT 1;",
    args: [row.id_unik, row.id_unik],
  });
  const employee = employeeResult.rows[0];
  if (!employee || String(employee.status_aktif) !== "Aktif")
    return fail("Karyawan tidak ditemukan atau nonaktif.");
  const id = String(employee.id_unik);
  const name = row.nama?.trim() || String(employee.nama);
  const division = row.divisi?.trim() || String(employee.divisi);
  let shiftId = Number(employee.id_shift);
  let mode = "NORMAL";
  let backupId = "";
  let originalId = "";
  const backupResult = await transaction.execute({
    sql: `SELECT * FROM backup_karyawan WHERE tanggal_tugas = ? AND status_tugas = 'Aktif'
          AND (id_karyawan_asal = ? OR id_karyawan_pengganti = ?) LIMIT 1;`,
    args: [date, id, id],
  });
  const backup = backupResult.rows[0];
  if (backup && String(backup.id_karyawan_asal) === id)
    return fail(
      `Import ditolak: karyawan sedang digantikan. ID Backup: ${backup.id_backup}`,
    );
  if (backup) {
    const backupShiftId = Number(backup.id_shift_backup);
    const normalShiftId = Number(employee.id_shift);

    const backupShiftRes = await transaction.execute({
      sql: "SELECT jam_masuk, jam_pulang, awal_absen_menit, batas_masuk_menit, toleransi_masuk_menit, batas_pulang_menit FROM tbl_shift WHERE id_shift = ?;",
      args: [backupShiftId],
    });
    const normalShiftRes = await transaction.execute({
      sql: "SELECT jam_masuk, jam_pulang, awal_absen_menit, batas_masuk_menit, toleransi_masuk_menit, batas_pulang_menit FROM tbl_shift WHERE id_shift = ?;",
      args: [normalShiftId],
    });
    const bShift = backupShiftRes.rows[0];
    const nShift = normalShiftRes.rows[0];

    const checkTime = row.jam_masuk || row.jam_pulang || "";
    const isCheckIn = Boolean(row.jam_masuk);

    const checkShiftMatch = (s: Record<string, unknown> | undefined) => {
      if (!s || !checkTime) return false;
      const parseMin = (t: string) => {
        const parts = t.trim().split(":");
        return Number(parts[0] || 0) * 60 + Number(parts[1] || 0);
      };
      const userMin = parseMin(checkTime);
      if (isCheckIn) {
        const sIn = parseMin(String(s.jam_masuk || "07:00"));
        let diff = userMin - sIn;
        if (diff < -720) diff += 1440;
        if (diff > 720) diff -= 1440;
        return (
          diff >= -Number(s.awal_absen_menit ?? 60) &&
          diff <=
            Number(s.batas_masuk_menit ?? 360) +
              Number(s.toleransi_masuk_menit ?? 0)
        );
      }
      const sOut = parseMin(String(s.jam_pulang || "15:00"));
      let diff = userMin - sOut;
      if (diff < -720) diff += 1440;
      if (diff > 720) diff -= 1440;
      return diff >= -120 && diff <= Number(s.batas_pulang_menit ?? 360);
    };

    const matchesBackup = checkShiftMatch(
      bShift as Record<string, unknown> | undefined,
    );
    const matchesNormal = checkShiftMatch(
      nShift as Record<string, unknown> | undefined,
    );

    if (matchesBackup && !matchesNormal) {
      mode = "PENGGANTI";
      backupId = String(backup.id_backup);
      originalId = String(backup.id_karyawan_asal);
      shiftId = backupShiftId;
    } else {
      mode = "NORMAL";
      shiftId = normalShiftId;
    }
  }

  let sessionId =
    mode === "PENGGANTI"
      ? `${backupId}-PENGGANTI-${id}`
      : `NORMAL-${date.replaceAll("-", "")}-${id}-${shiftId}`;

  const existingResult = await transaction.execute({
    sql: "SELECT * FROM absensi_harian WHERE id_sesi = ? LIMIT 1;",
    args: [sessionId],
  });
  let existing = existingResult.rows[0] as Record<string, unknown> | undefined;

  // If not found by exact sessionId, and this row is completing a partial record (e.g. only jam_pulang or only jam_masuk):
  if (
    !existing &&
    ((!row.jam_masuk && row.jam_pulang) || (row.jam_masuk && !row.jam_pulang))
  ) {
    const unclosedResult = await transaction.execute({
      sql: `SELECT * FROM absensi_harian 
            WHERE id_karyawan = ? AND tanggal = ? 
              AND ((jam_masuk != '' AND (jam_pulang IS NULL OR jam_pulang = '')) 
                OR ((jam_masuk IS NULL OR jam_masuk = '') AND jam_pulang != '')) 
            LIMIT 1;`,
      args: [id, date],
    });
    if (unclosedResult.rows.length > 0) {
      existing = unclosedResult.rows[0] as Record<string, unknown>;
      sessionId = String(existing.id_sesi);
      mode = String(existing.mode_tugas || "NORMAL");
      backupId = String(existing.id_backup || "");
      originalId = String(existing.id_karyawan_asal || "");
      shiftId = Number(existing.id_shift || shiftId);
      date = String(existing.tanggal || date);
    } else if (!row.jam_masuk && row.jam_pulang) {
      const prevDate = (() => {
        const d = new Date(date);
        d.setDate(d.getDate() - 1);
        return d.toISOString().slice(0, 10);
      })();
      const unclosedPrevRes = await transaction.execute({
        sql: `SELECT * FROM absensi_harian 
              WHERE id_karyawan = ? AND tanggal = ? 
                AND jam_masuk != '' AND (jam_pulang IS NULL OR jam_pulang = '') 
              LIMIT 1;`,
        args: [id, prevDate],
      });
      if (unclosedPrevRes.rows.length > 0) {
        existing = unclosedPrevRes.rows[0] as Record<string, unknown>;
        sessionId = String(existing.id_sesi);
        mode = String(existing.mode_tugas || "NORMAL");
        backupId = String(existing.id_backup || "");
        originalId = String(existing.id_karyawan_asal || "");
        shiftId = Number(existing.id_shift || shiftId);
        date = prevDate;
      }
    }
  }

  if (existing && String(existing.sumber) === "Koreksi Admin")
    return fail("Data sudah dikoreksi admin; import tidak boleh menimpa.");

  const shiftResult = await transaction.execute({
    sql: "SELECT id_shift, nama_shift, kode_shift, jam_masuk, jam_pulang, jam_kerja_normal_menit, istirahat_menit, toleransi_masuk_menit, awal_absen_menit, batas_masuk_menit, batas_pulang_menit FROM tbl_shift WHERE id_shift = ?;",
    args: [shiftId],
  });
  const shiftRowData = shiftResult.rows[0] as
    | Record<string, unknown>
    | undefined;
  const isOvernightShift = Boolean(
    shiftRowData?.jam_masuk &&
      shiftRowData?.jam_pulang &&
      String(shiftRowData.jam_pulang) < String(shiftRowData.jam_masuk),
  );

  const checkIn = row.jam_masuk
    ? timestamp(date, row.jam_masuk)
    : String(existing?.jam_masuk ?? "");
  const inTimeStr = row.jam_masuk || String(shiftRowData?.jam_masuk || "07:00");
  const nextDay = Boolean(
    row.jam_pulang &&
      ((row.jam_masuk && row.jam_pulang < row.jam_masuk) ||
        (isOvernightShift && row.jam_pulang < inTimeStr)),
  );
  const checkOut = row.jam_pulang
    ? timestamp(date, row.jam_pulang, nextDay)
    : String(existing?.jam_pulang ?? "");

  const statusAttendance = row.status_kehadiran?.trim() || "Hadir";
  const statusRecord =
    row.status_absen?.trim() ||
    (checkIn && checkOut
      ? "Lengkap"
      : checkIn
        ? "Belum Pulang"
        : "Perlu Verifikasi");
  let worked = 0;
  if (checkIn && checkOut) {
    const inDate = new Date(`${checkIn.replace(" ", "T")}+07:00`).getTime();
    const outDate = new Date(`${checkOut.replace(" ", "T")}+07:00`).getTime();
    let diffMinutes = Math.floor((outDate - inDate) / 60000);
    if (diffMinutes < 0) {
      diffMinutes += 1440;
    }
    worked = Math.max(0, diffMinutes);
  }

  const shiftData = shiftResult.rows[0];
  if (!shiftData) return fail(`Shift #${shiftId} tidak ditemukan.`);

  const normal = Number(shiftData?.jam_kerja_normal_menit ?? 480);
  const breakMinutes = Number(shiftData?.istirahat_menit ?? 60);
  const toleransi = Number(shiftData?.toleransi_masuk_menit ?? 0);
  const awalAbsen = Number(shiftData?.awal_absen_menit ?? 60);
  const batasMasuk = Number(shiftData?.batas_masuk_menit ?? 0);
  const batasPulang = Number(shiftData?.batas_pulang_menit ?? 360);
  const shiftJamMasuk = String(shiftData?.jam_masuk || "07:00");
  const shiftJamPulang = String(shiftData?.jam_pulang || "15:00");

  const parseTimeMin = (t: string) => {
    const parts = t.trim().split(":");
    return Number(parts[0] || 0) * 60 + Number(parts[1] || 0);
  };
  const shiftMasukMin = parseTimeMin(shiftJamMasuk);
  const shiftPulangMin = parseTimeMin(shiftJamPulang);

  // Shift Window Validation for Hadir
  if (statusAttendance === "Hadir") {
    if (row.jam_masuk) {
      const userMasukMin = parseTimeMin(row.jam_masuk);
      let diff = userMasukMin - shiftMasukMin;
      if (diff < -720) diff += 1440;
      if (diff > 720) diff -= 1440;
      if (diff < -awalAbsen || diff > batasMasuk + toleransi) {
        return fail(
          `Jam masuk (${row.jam_masuk}) di luar rentang jadwal ${shiftData.nama_shift || `Shift ${shiftId}`} (Jam Masuk: ${shiftJamMasuk}).`,
        );
      }
    }
    if (row.jam_pulang) {
      const userPulangMin = parseTimeMin(row.jam_pulang);
      let diff = userPulangMin - shiftPulangMin;
      if (diff < -720) diff += 1440;
      if (diff > 720) diff -= 1440;
      if (diff < -120 || diff > batasPulang) {
        return fail(
          `Jam pulang (${row.jam_pulang}) di luar rentang jadwal ${shiftData.nama_shift || `Shift ${shiftId}`} (Jam Pulang: ${shiftJamPulang}).`,
        );
      }
    }
  }

  let menitTerlambat = 0;
  let menitDatangAwal = 0;

  if (checkIn) {
    const checkInTime = checkIn.includes(" ") ? checkIn.split(" ")[1] : checkIn;
    let userMasukMin = parseTimeMin(checkInTime);
    if (isOvernightShift && userMasukMin < shiftMasukMin - 720) {
      userMasukMin += 1440;
    }
    const batasNormalMasuk = shiftMasukMin + batasMasuk;
    if (userMasukMin < shiftMasukMin) {
      menitDatangAwal = shiftMasukMin - userMasukMin;
    } else if (userMasukMin <= batasNormalMasuk) {
      menitTerlambat = 0;
      menitDatangAwal = 0;
    } else {
      menitTerlambat = userMasukMin - batasNormalMasuk;
    }
  }

  worked = worked > 0 ? Math.max(0, worked - breakMinutes) : 0;
  const overtime = Math.max(0, worked - normal);
  const shortage = checkIn && checkOut ? Math.max(0, normal - worked) : 0;
  const [year, month] = date.split("-").map(Number);
  await transaction.execute({
    sql: `INSERT INTO absensi_harian (tanggal, id_karyawan, nama, kelas_divisi,
      jam_masuk, jam_pulang, status_kehadiran, status_absen, keterangan, sumber,
      update_terakhir, menit_terlambat, menit_datang_awal, jam_kerja, lembur,
      jam_kerja_kurang, id_shift, bulan, tahun, id_sesi, mode_tugas, id_backup,
      id_karyawan_asal, tanggal_tugas)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'Import Manual', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id_sesi) DO UPDATE SET jam_masuk = excluded.jam_masuk,
      jam_pulang = excluded.jam_pulang, status_kehadiran = excluded.status_kehadiran,
      status_absen = excluded.status_absen, keterangan = excluded.keterangan,
      sumber = 'Import Manual', update_terakhir = excluded.update_terakhir,
      menit_terlambat = excluded.menit_terlambat, menit_datang_awal = excluded.menit_datang_awal,
      jam_kerja = excluded.jam_kerja, lembur = excluded.lembur,
      jam_kerja_kurang = excluded.jam_kerja_kurang;`,
    args: [
      date,
      id,
      name,
      division,
      checkIn,
      checkOut,
      statusAttendance,
      statusRecord,
      row.keterangan ?? "",
      now,
      menitTerlambat,
      menitDatangAwal,
      worked,
      overtime,
      shortage,
      shiftId,
      MONTHS[month - 1] ?? "Januari",
      year,
      sessionId,
      mode,
      backupId,
      originalId,
      mode === "PENGGANTI" ? date : "",
    ],
  });
  for (const [kind, time] of [
    ["Masuk", checkIn],
    ["Pulang", checkOut],
  ] as const) {
    if (!time) continue;
    await transaction.execute({
      sql: "DELETE FROM log_scan WHERE tanggal_kerja = ? AND id_karyawan = ? AND jenis_scan = ? AND COALESCE(id_referensi, '') = ? AND (sumber_data = 'Import Offline' OR sumber_data = 'Import Manual');",
      args: [date, id, kind, backupId],
    });
    await transaction.execute({
      sql: `INSERT INTO log_scan (timestamp_scan, tanggal_kerja, jam_scan,
        id_karyawan, nama, divisi, jenis_scan, status_proses, sumber_data,
        catatan_sistem, keterangan, menit_terlambat, menit_datang_awal,
        id_referensi, kode_operator) VALUES (?, ?, ?, ?, ?, ?, ?, 'Berhasil',
        'Import Manual', ?, ?, ?, ?, ?, ?);`,
      args: [
        time,
        date,
        time.slice(11),
        id,
        name,
        division,
        kind,
        backupId
          ? `Import Manual sebagai karyawan pengganti. ID Backup: ${backupId}`
          : "Import Manual",
        row.keterangan ?? statusAttendance,
        kind === "Masuk" ? menitTerlambat : 0,
        kind === "Masuk" ? menitDatangAwal : 0,
        backupId,
        operator,
      ],
    });
  }

  await transaction.execute({
    sql: `INSERT INTO import_offline (event_key, timestamp_input, tanggal, id_unik,
      nama, divisi, jam_masuk, jam_pulang, status_kehadiran, status_absen,
      keterangan, status_proses, diproses_pada, pesan_error, kode_operator)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Sudah Diproses', ?, '', ?);`,
    args: [
      eventKey,
      now,
      date,
      id,
      name,
      division,
      row.jam_masuk ?? "",
      row.jam_pulang ?? "",
      statusAttendance,
      statusRecord,
      row.keterangan ?? "",
      now,
      operator,
    ],
  });
  return {
    sukses: true,
    eventKey,
    pesan: `Import ${id} berhasil diproses.`,
    sessionId,
  };
}

export async function prosesImportOffline(
  rows: OfflineImportRow[],
  operator: string,
) {
  await ensureDbInitialized();

  const results = [];
  for (const row of rows) {
    const transaction = await db.transaction("write");
    try {
      const result = await processRow(transaction, row, operator);
      await transaction.commit();
      results.push(result);
    } catch (error) {
      await transaction.rollback();
      results.push({
        sukses: false,
        pesan: error instanceof Error ? error.message : "Import gagal.",
      });
    } finally {
      transaction.close();
    }
  }
  return {
    sukses: results.some((item) => item.sukses),
    berhasil: results.filter((item) => item.sukses).length,
    gagal: results.filter((item) => !item.sukses).length,
    results,
  };
}

export async function getDaftarImport(
  filter: { tanggal?: string; id_karyawan?: string; search?: string } = {},
) {
  await ensureDbInitialized();
  let sql = "SELECT * FROM import_offline WHERE 1=1";
  const args: InValue[] = [];
  if (filter.tanggal) {
    sql += " AND tanggal = ?";
    args.push(filter.tanggal);
  }
  if (filter.id_karyawan) {
    sql += " AND id_unik = ?";
    args.push(filter.id_karyawan);
  }
  if (filter.search) {
    sql += " AND (id_unik LIKE ? OR nama LIKE ?)";
    args.push(`%${filter.search}%`, `%${filter.search}%`);
  }
  sql += " ORDER BY id_import DESC LIMIT 200;";
  const result = await db.execute({ sql, args });
  return result.rows as unknown as Record<string, unknown>[];
}
