import "server-only";

import { randomUUID } from "node:crypto";
import type { Transaction } from "@libsql/client";
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
  const normalized = time.length === 5 ? `${time}:00` : time;
  if (!nextDay) return `${date} ${normalized}`;
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + 1);
  return `${value.toISOString().slice(0, 10)} ${normalized}`;
}

async function processRow(
  transaction: Transaction,
  row: OfflineImportRow,
  operator: string,
) {
  const eventKey = `IMP-${randomUUID()}`;
  const now = new Date().toISOString();
  const fail = async (message: string) => {
    await transaction.execute({
      sql: `INSERT INTO import_offline (event_key, timestamp_input, tanggal, id_unik,
            nama, divisi, jam_masuk, jam_pulang, status_kehadiran, status_absen,
            keterangan, status_proses, diproses_pada, pesan_error, kode_operator)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Gagal', ?, ?, ?);`,
      args: [
        eventKey,
        now,
        row.tanggal,
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
  if (!/^\d{4}-\d{2}-\d{2}$/.test(row.tanggal) || !row.id_unik)
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
    args: [row.tanggal, id, id],
  });
  const backup = backupResult.rows[0];
  if (backup && String(backup.id_karyawan_asal) === id)
    return fail(
      `Import ditolak: karyawan sedang digantikan. ID Backup: ${backup.id_backup}`,
    );
  if (backup) {
    mode = "PENGGANTI";
    backupId = String(backup.id_backup);
    originalId = String(backup.id_karyawan_asal);
    shiftId = Number(backup.id_shift_backup);
  }
  const sessionId =
    mode === "PENGGANTI"
      ? `${backupId}-PENGGANTI-${id}`
      : `NORMAL-${row.tanggal.replaceAll("-", "")}-${id}-${shiftId}`;
  const existingResult = await transaction.execute({
    sql: "SELECT * FROM absensi_harian WHERE id_sesi = ? LIMIT 1;",
    args: [sessionId],
  });
  const existing = existingResult.rows[0];
  if (existing && String(existing.sumber) === "Koreksi Admin")
    return fail("Data sudah dikoreksi admin; import tidak boleh menimpa.");
  const checkIn = row.jam_masuk
    ? timestamp(row.tanggal, row.jam_masuk)
    : String(existing?.jam_masuk ?? "");
  const nextDay = Boolean(
    row.jam_masuk && row.jam_pulang && row.jam_pulang < row.jam_masuk,
  );
  const checkOut = row.jam_pulang
    ? timestamp(row.tanggal, row.jam_pulang, nextDay)
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
  if (checkIn && checkOut)
    worked = Math.max(
      0,
      Math.floor(
        (new Date(`${checkOut.replace(" ", "T")}+07:00`).getTime() -
          new Date(`${checkIn.replace(" ", "T")}+07:00`).getTime()) /
          60000,
      ),
    );
  const shiftResult = await transaction.execute({
    sql: "SELECT id_shift, nama_shift, kode_shift, jam_masuk, jam_pulang, jam_kerja_normal_menit, istirahat_menit, toleransi_masuk_menit, awal_absen_menit, batas_masuk_menit, batas_pulang_menit FROM tbl_shift WHERE id_shift = ?;",
    args: [shiftId],
  });
  const shiftData = shiftResult.rows[0];
  if (!shiftData) return fail(`Shift #${shiftId} tidak ditemukan.`);

  const normal = Number(shiftData?.jam_kerja_normal_menit ?? 480);
  const breakMinutes = Number(shiftData?.istirahat_menit ?? 60);
  const toleransi = Number(shiftData?.toleransi_masuk_menit ?? 0);
  const awalAbsen = Number(shiftData?.awal_absen_menit ?? 60);
  const batasMasuk = Number(shiftData?.batas_masuk_menit ?? 360);
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

  if (row.jam_masuk) {
    const userMasukMin = parseTimeMin(row.jam_masuk);
    if (userMasukMin > shiftMasukMin + toleransi) {
      menitTerlambat = userMasukMin - shiftMasukMin;
    } else if (userMasukMin < shiftMasukMin) {
      menitDatangAwal = shiftMasukMin - userMasukMin;
    }
  }

  worked = worked > 0 ? Math.max(0, worked - breakMinutes) : 0;
  const overtime = Math.max(0, worked - normal);
  const shortage = checkIn && checkOut ? Math.max(0, normal - worked) : 0;
  const [year, month] = row.tanggal.split("-").map(Number);
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
      menit_terlambat = excluded.menit_terlambat, menit_datang_awal = excluded.menit_datang_awal,
      jam_kerja = excluded.jam_kerja, lembur = excluded.lembur,
      jam_kerja_kurang = excluded.jam_kerja_kurang;`,
    args: [
      row.tanggal,
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
      row.tanggal,
    ],
  });
  for (const [kind, time] of [
    ["Masuk", checkIn],
    ["Pulang", checkOut],
  ] as const) {
    if (!time) continue;
    await transaction.execute({
      sql: "DELETE FROM log_scan WHERE tanggal_kerja = ? AND id_karyawan = ? AND jenis_scan = ? AND sumber_data = 'Import Offline';",
      args: [row.tanggal, id, kind],
    });
    await transaction.execute({
      sql: `INSERT INTO log_scan (timestamp_scan, tanggal_kerja, jam_scan,
        id_karyawan, nama, divisi, jenis_scan, status_proses, sumber_data,
        catatan_sistem, keterangan, menit_terlambat, menit_datang_awal,
        id_referensi, kode_operator) VALUES (?, ?, ?, ?, ?, ?, ?, 'Berhasil',
        'Import Offline', ?, ?, ?, ?, ?, ?);`,
      args: [
        time,
        row.tanggal,
        time.slice(11),
        id,
        name,
        division,
        kind,
        backupId
          ? `Import Offline sebagai karyawan pengganti. ID Backup: ${backupId}`
          : "Import Offline",
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
      row.tanggal,
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
