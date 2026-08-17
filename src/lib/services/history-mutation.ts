import "server-only";

import { db, ensureDbInitialized } from "@/lib/db";

export interface EditAbsensiHarianPatch {
  jam_masuk?: string; // e.g. "07:00" or "YYYY-MM-DD HH:mm:ss"
  jam_pulang?: string;
  status_kehadiran?: string; // "Hadir" | "Sakit" | "Izin" | "Dispen" | "Alfa"
  status_absen?: string; // "Lengkap" | "Belum Pulang" | "Tidak Hadir" | "Perlu Verifikasi"
  keterangan?: string;
}

const parseTimeToMinutes = (t: string | undefined | null): number | null => {
  if (!t) return null;
  const clean = t.includes(" ") ? t.split(" ")[1] : t;
  const parts = clean.split(":");
  if (parts.length < 2) return null;
  const h = Number(parts[0]);
  const m = Number(parts[1]);
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  return h * 60 + m;
};

function formatDateTime(dateStr: string, timeStr: string): string {
  if (!timeStr) return "";
  const cleanTime = timeStr.includes(" ")
    ? timeStr.split(" ")[1]
    : timeStr.includes("T")
      ? timeStr.split("T")[1]
      : timeStr;
  if (!cleanTime) return "";
  const parts = cleanTime.split(":");
  if (parts.length < 2) return "";
  const h = parts[0].padStart(2, "0");
  const m = parts[1].padStart(2, "0");
  const s = (parts[2] || "00").slice(0, 2).padStart(2, "0");
  return `${dateStr} ${h}:${m}:${s}`;
}

export async function editAbsensiHarian(
  idSesi: string,
  patch: EditAbsensiHarianPatch,
  kodeOperator: string,
) {
  await ensureDbInitialized();

  const existRes = await db.execute({
    sql: "SELECT * FROM absensi_harian WHERE id_sesi = ? LIMIT 1;",
    args: [idSesi],
  });

  if (existRes.rows.length === 0) {
    return { sukses: false, pesan: "Data absensi harian tidak ditemukan." };
  }

  const current = existRes.rows[0] as Record<string, unknown>;
  const tanggal = String(current.tanggal);
  const idShift = Number(current.id_shift || 1);
  const nowStr = new Date().toISOString();

  // Fetch shift details
  const shiftRes = await db.execute({
    sql: "SELECT jam_masuk, jam_pulang, jam_kerja_normal_menit, istirahat_menit, toleransi_masuk_menit FROM tbl_shift WHERE id_shift = ? LIMIT 1;",
    args: [idShift],
  });
  const shiftData = shiftRes.rows[0] as Record<string, unknown> | undefined;
  const normalShiftMin = Number(shiftData?.jam_kerja_normal_menit ?? 480);
  const breakShiftMin = Number(shiftData?.istirahat_menit ?? 60);
  const toleransiShiftMin = Number(shiftData?.toleransi_masuk_menit ?? 0);
  const shiftJamMasukStr = String(shiftData?.jam_masuk || "07:00");
  const shiftJamPulangStr = String(shiftData?.jam_pulang || "15:00");
  const shiftInMin = parseTimeToMinutes(shiftJamMasukStr) ?? 420;
  const shiftOutMin = parseTimeToMinutes(shiftJamPulangStr) ?? 900;
  const isOvernightShift = shiftOutMin < shiftInMin;

  const nextDate = (() => {
    const d = new Date(tanggal);
    d.setDate(d.getDate() + 1);
    return d.toISOString().slice(0, 10);
  })();

  // Format jam masuk and jam pulang cleanly
  let checkInVal =
    patch.jam_masuk !== undefined
      ? patch.jam_masuk.trim()
      : String(current.jam_masuk || "");
  checkInVal = formatDateTime(tanggal, checkInVal);

  let checkOutVal =
    patch.jam_pulang !== undefined
      ? patch.jam_pulang.trim()
      : String(current.jam_pulang || "");
  if (checkOutVal) {
    const outMin = parseTimeToMinutes(checkOutVal) ?? 0;
    const inMin = parseTimeToMinutes(checkInVal);
    const isCross =
      inMin !== null ? outMin < inMin : isOvernightShift && outMin < shiftInMin;
    const outDate = isCross ? nextDate : tanggal;
    checkOutVal = formatDateTime(outDate, checkOutVal);
  }

  const statusKehadiran =
    patch.status_kehadiran !== undefined
      ? patch.status_kehadiran.trim()
      : String(current.status_kehadiran || "Hadir");

  const keterangan =
    patch.keterangan !== undefined
      ? patch.keterangan.trim()
      : String(current.keterangan || "");

  let calculatedLate = 0;
  let calculatedEarly = 0;
  let calculatedWork = 0;
  let calculatedOvertime = 0;
  let calculatedShortage = 0;

  if (["Sakit", "Izin", "Dispen", "Alfa"].includes(statusKehadiran)) {
    checkInVal = "";
    checkOutVal = "";
  } else {
    const inMin = parseTimeToMinutes(checkInVal);
    const outMin = parseTimeToMinutes(checkOutVal);

    if (inMin !== null) {
      let userInTimeline = inMin;
      if (isOvernightShift && userInTimeline < shiftInMin - 720) {
        userInTimeline += 1440;
      }
      if (userInTimeline > shiftInMin + toleransiShiftMin) {
        calculatedLate = userInTimeline - shiftInMin;
      } else if (userInTimeline < shiftInMin) {
        calculatedEarly = shiftInMin - userInTimeline;
      }
    }

    if (inMin !== null && outMin !== null) {
      let duration = outMin - inMin;
      if (duration < 0) {
        duration += 1440;
      } else if (
        checkOutVal.startsWith(nextDate) &&
        checkInVal.startsWith(tanggal) &&
        nextDate !== tanggal
      ) {
        duration += 1440;
      }
      calculatedWork = Math.max(0, duration - breakShiftMin);
      calculatedOvertime = Math.max(0, calculatedWork - normalShiftMin);
      calculatedShortage = Math.max(0, normalShiftMin - calculatedWork);
    }
  }

  const statusAbsen =
    patch.status_absen !== undefined
      ? patch.status_absen.trim()
      : ["Sakit", "Izin", "Dispen", "Alfa"].includes(statusKehadiran)
        ? "Tidak Hadir"
        : checkInVal && checkOutVal
          ? "Lengkap"
          : checkInVal
            ? "Belum Pulang"
            : "Perlu Verifikasi";

  // ── Atomic transaction: UPDATE absensi + INSERT audit trail ────────────
  const tx = await db.transaction("write");
  try {
    await tx.execute({
      sql: `UPDATE absensi_harian SET
            jam_masuk = ?,
            jam_pulang = ?,
            status_kehadiran = ?,
            status_absen = ?,
            keterangan = ?,
            update_terakhir = ?,
            menit_terlambat = ?,
            menit_datang_awal = ?,
            jam_kerja = ?,
            lembur = ?,
            jam_kerja_kurang = ?
          WHERE id_sesi = ?;`,
      args: [
        checkInVal,
        checkOutVal,
        statusKehadiran,
        statusAbsen,
        keterangan,
        nowStr,
        calculatedLate,
        calculatedEarly,
        calculatedWork,
        calculatedOvertime,
        calculatedShortage,
        idSesi,
      ],
    });

    // Audit trail
    await tx.execute({
      sql: `INSERT INTO audit_absensi (
            waktu, jenis, tanggal, id_karyawan, nama, baris_referensi, detail, status
          ) VALUES (?, 'Edit Absensi', ?, ?, ?, ?, ?, 'Berhasil');`,
      args: [
        nowStr,
        tanggal,
        String(current.id_karyawan),
        String(current.nama),
        idSesi,
        `Diedit oleh Operator ${kodeOperator}. Jam Masuk: '${checkInVal}', Jam Pulang: '${checkOutVal}', Status: '${statusKehadiran}/${statusAbsen}'.`,
      ],
    });

    await tx.commit();
  } catch (err) {
    await tx.rollback();
    throw err;
  } finally {
    tx.close();
  }

  return {
    sukses: true,
    pesan: "Data absensi harian berhasil diperbarui.",
  };
}

export async function hapusAbsensiHarian(
  idSesi: string,
  kodeOperator = "SYSTEM",
) {
  await ensureDbInitialized();

  const existRes = await db.execute({
    sql: "SELECT id_karyawan, tanggal, nama FROM absensi_harian WHERE id_sesi = ? LIMIT 1;",
    args: [idSesi],
  });

  if (existRes.rows.length === 0) {
    return { sukses: false, pesan: "Data absensi harian tidak ditemukan." };
  }

  const current = existRes.rows[0] as Record<string, unknown>;
  const idKaryawan = String(current.id_karyawan);
  const tanggal = String(current.tanggal);
  const nama = String(current.nama);
  const nowStr = new Date().toISOString();

  await db.execute({
    sql: "DELETE FROM absensi_harian WHERE id_sesi = ?;",
    args: [idSesi],
  });

  await db.execute({
    sql: `INSERT INTO audit_absensi (
          waktu, jenis, tanggal, id_karyawan, nama, baris_referensi, detail, status
        ) VALUES (?, 'Hapus Absensi', ?, ?, ?, ?, ?, 'Berhasil');`,
    args: [
      nowStr,
      tanggal,
      idKaryawan,
      nama,
      idSesi,
      `Dihapus oleh Operator ${kodeOperator}.`,
    ],
  });

  return {
    sukses: true,
    pesan: "Data absensi harian berhasil dihapus.",
  };
}

export async function hapusLogScan(
  idLog: number | string,
  kodeOperator = "SYSTEM",
) {
  await ensureDbInitialized();

  const logRes = await db.execute({
    sql: "SELECT * FROM log_scan WHERE id_log = ? LIMIT 1;",
    args: [idLog],
  });

  if (logRes.rows.length === 0) {
    return { sukses: false, pesan: "Log scan tidak ditemukan." };
  }

  const log = logRes.rows[0] as Record<string, unknown>;
  const idKaryawan = String(log.id_karyawan);
  const tanggalKerja = String(log.tanggal_kerja);
  const nowStr = new Date().toISOString();

  await db.execute({
    sql: "DELETE FROM log_scan WHERE id_log = ?;",
    args: [idLog],
  });

  const remainRes = await db.execute({
    sql: "SELECT * FROM log_scan WHERE id_karyawan = ? AND tanggal_kerja = ? ORDER BY timestamp_scan ASC;",
    args: [idKaryawan, tanggalKerja],
  });

  const absRes = await db.execute({
    sql: "SELECT * FROM absensi_harian WHERE id_karyawan = ? AND (tanggal = ? OR tanggal = date(?, '-1 day')) ORDER BY (CASE WHEN tanggal = ? THEN 0 ELSE 1 END) ASC LIMIT 1;",
    args: [idKaryawan, tanggalKerja, tanggalKerja, tanggalKerja],
  });

  if (absRes.rows.length > 0) {
    const abs = absRes.rows[0] as Record<string, unknown>;
    const idSesi = String(abs.id_sesi);

    if (remainRes.rows.length === 0) {
      await db.execute({
        sql: "DELETE FROM absensi_harian WHERE id_karyawan = ? AND (tanggal = ? OR tanggal = date(?, '-1 day'));",
        args: [idKaryawan, tanggalKerja, tanggalKerja],
      });
    } else {
      const inLog = remainRes.rows.find(
        (r) => String(r.jenis_scan) === "Masuk",
      );
      const outLog = remainRes.rows.find(
        (r) => String(r.jenis_scan) === "Pulang",
      );

      const inVal = inLog
        ? formatDateTime(tanggalKerja, String(inLog.jam_scan))
        : "";
      const outVal = outLog
        ? formatDateTime(tanggalKerja, String(outLog.jam_scan))
        : "";
      const statusAbsen =
        inVal && outVal
          ? "Lengkap"
          : inVal
            ? "Belum Pulang"
            : "Perlu Verifikasi";

      const idShift = Number(abs.id_shift || 1);
      const shiftRes = await db.execute({
        sql: "SELECT jam_masuk, jam_pulang, jam_kerja_normal_menit, istirahat_menit, toleransi_masuk_menit FROM tbl_shift WHERE id_shift = ? LIMIT 1;",
        args: [idShift],
      });
      const shiftData = shiftRes.rows[0] as Record<string, unknown> | undefined;
      const normalShiftMin = Number(shiftData?.jam_kerja_normal_menit ?? 480);
      const breakShiftMin = Number(shiftData?.istirahat_menit ?? 60);
      const toleransiShiftMin = Number(shiftData?.toleransi_masuk_menit ?? 0);
      const shiftJamMasukStr = String(shiftData?.jam_masuk || "07:00");
      const shiftJamPulangStr = String(shiftData?.jam_pulang || "15:00");
      const shiftInMin = parseTimeToMinutes(shiftJamMasukStr) ?? 420;
      const shiftOutMin = parseTimeToMinutes(shiftJamPulangStr) ?? 900;
      const isOvernightShift = shiftOutMin < shiftInMin;

      let calculatedLate = 0;
      let calculatedEarly = 0;
      let calculatedWork = 0;
      let calculatedOvertime = 0;
      let calculatedShortage = 0;

      const inMin = parseTimeToMinutes(inVal);
      const outMin = parseTimeToMinutes(outVal);

      if (inMin !== null) {
        let userInTimeline = inMin;
        if (isOvernightShift && userInTimeline < shiftInMin - 720) {
          userInTimeline += 1440;
        }
        if (userInTimeline > shiftInMin + toleransiShiftMin) {
          calculatedLate = userInTimeline - shiftInMin;
        } else if (userInTimeline < shiftInMin) {
          calculatedEarly = shiftInMin - userInTimeline;
        }
      }

      if (inMin !== null && outMin !== null) {
        let duration = outMin - inMin;
        if (duration < 0) {
          duration += 1440;
        }
        calculatedWork = Math.max(0, duration - breakShiftMin);
        calculatedOvertime = Math.max(0, calculatedWork - normalShiftMin);
        calculatedShortage = Math.max(0, normalShiftMin - calculatedWork);
      }

      await db.execute({
        sql: `UPDATE absensi_harian SET
              jam_masuk = ?, jam_pulang = ?, status_absen = ?, update_terakhir = ?,
              menit_terlambat = ?, menit_datang_awal = ?, jam_kerja = ?, lembur = ?, jam_kerja_kurang = ?
              WHERE id_sesi = ?;`,
        args: [
          inVal,
          outVal,
          statusAbsen,
          nowStr,
          calculatedLate,
          calculatedEarly,
          calculatedWork,
          calculatedOvertime,
          calculatedShortage,
          idSesi,
        ],
      });
    }
  }

  await db.execute({
    sql: `INSERT INTO audit_absensi (
          waktu, jenis, tanggal, id_karyawan, nama, baris_referensi, detail, status
        ) VALUES (?, 'Hapus Log Scan', ?, ?, ?, ?, ?, 'Berhasil');`,
    args: [
      nowStr,
      tanggalKerja,
      idKaryawan,
      String(log.nama),
      String(idLog),
      `Log scan ${log.jenis_scan} (${log.jam_scan}) dihapus oleh Operator ${kodeOperator}.`,
    ],
  });

  return {
    sukses: true,
    pesan: "Log scan berhasil dihapus dan absensi telah diperbarui.",
  };
}

export async function hapusImportOffline(
  eventKey: string,
  kodeOperator: string,
) {
  await ensureDbInitialized();

  const importRes = await db.execute({
    sql: "SELECT * FROM import_offline WHERE event_key = ? LIMIT 1;",
    args: [eventKey],
  });

  if (importRes.rows.length === 0) {
    return { sukses: false, pesan: "Data import offline tidak ditemukan." };
  }

  const imp = importRes.rows[0] as Record<string, unknown>;
  const idUnik = String(imp.id_unik);
  const tanggal = String(imp.tanggal);
  const nowStr = new Date().toISOString();

  // Delete import_offline row
  await db.execute({
    sql: "DELETE FROM import_offline WHERE event_key = ?;",
    args: [eventKey],
  });

  // Delete related log_scan
  await db.execute({
    sql: "DELETE FROM log_scan WHERE id_referensi = ? OR (id_karyawan = ? AND tanggal_kerja = ? AND sumber_data = 'Import Offline');",
    args: [eventKey, idUnik, tanggal],
  });

  // Check remaining scan logs
  const remRes = await db.execute({
    sql: "SELECT * FROM log_scan WHERE id_karyawan = ? AND tanggal_kerja = ? ORDER BY timestamp_scan ASC;",
    args: [idUnik, tanggal],
  });

  const absRes = await db.execute({
    sql: "SELECT * FROM absensi_harian WHERE id_karyawan = ? AND (tanggal = ? OR tanggal = date(?, '-1 day')) ORDER BY (CASE WHEN tanggal = ? THEN 0 ELSE 1 END) ASC LIMIT 1;",
    args: [idUnik, tanggal, tanggal, tanggal],
  });

  if (absRes.rows.length > 0) {
    const abs = absRes.rows[0] as Record<string, unknown>;
    const idSesi = String(abs.id_sesi);

    if (remRes.rows.length === 0) {
      await db.execute({
        sql: "DELETE FROM absensi_harian WHERE id_karyawan = ? AND (tanggal = ? OR tanggal = date(?, '-1 day'));",
        args: [idUnik, tanggal, tanggal],
      });
    } else {
      const inLog = remRes.rows.find((r) => String(r.jenis_scan) === "Masuk");
      const outLog = remRes.rows.find((r) => String(r.jenis_scan) === "Pulang");

      const inVal = inLog
        ? formatDateTime(tanggal, String(inLog.jam_scan))
        : "";
      const outVal = outLog
        ? formatDateTime(tanggal, String(outLog.jam_scan))
        : "";
      const statusAbsen =
        inVal && outVal
          ? "Lengkap"
          : inVal
            ? "Belum Pulang"
            : "Perlu Verifikasi";

      const idShift = Number(abs.id_shift || 1);
      const shiftRes = await db.execute({
        sql: "SELECT jam_masuk, jam_pulang, jam_kerja_normal_menit, istirahat_menit, toleransi_masuk_menit FROM tbl_shift WHERE id_shift = ? LIMIT 1;",
        args: [idShift],
      });
      const shiftData = shiftRes.rows[0] as Record<string, unknown> | undefined;
      const normalShiftMin = Number(shiftData?.jam_kerja_normal_menit ?? 480);
      const breakShiftMin = Number(shiftData?.istirahat_menit ?? 60);
      const toleransiShiftMin = Number(shiftData?.toleransi_masuk_menit ?? 0);
      const shiftJamMasukStr = String(shiftData?.jam_masuk || "07:00");
      const shiftJamPulangStr = String(shiftData?.jam_pulang || "15:00");
      const shiftInMin = parseTimeToMinutes(shiftJamMasukStr) ?? 420;
      const shiftOutMin = parseTimeToMinutes(shiftJamPulangStr) ?? 900;
      const isOvernightShift = shiftOutMin < shiftInMin;

      let calculatedLate = 0;
      let calculatedEarly = 0;
      let calculatedWork = 0;
      let calculatedOvertime = 0;
      let calculatedShortage = 0;

      const inMin = parseTimeToMinutes(inVal);
      const outMin = parseTimeToMinutes(outVal);

      if (inMin !== null) {
        let userInTimeline = inMin;
        if (isOvernightShift && userInTimeline < shiftInMin - 720) {
          userInTimeline += 1440;
        }
        if (userInTimeline > shiftInMin + toleransiShiftMin) {
          calculatedLate = userInTimeline - shiftInMin;
        } else if (userInTimeline < shiftInMin) {
          calculatedEarly = shiftInMin - userInTimeline;
        }
      }

      if (inMin !== null && outMin !== null) {
        let duration = outMin - inMin;
        if (duration < 0) duration += 1440;
        calculatedWork = Math.max(0, duration - breakShiftMin);
        calculatedOvertime = Math.max(0, calculatedWork - normalShiftMin);
        calculatedShortage = Math.max(0, normalShiftMin - calculatedWork);
      }

      await db.execute({
        sql: `UPDATE absensi_harian SET
              jam_masuk = ?, jam_pulang = ?, status_absen = ?, update_terakhir = ?,
              menit_terlambat = ?, menit_datang_awal = ?, jam_kerja = ?, lembur = ?, jam_kerja_kurang = ?
              WHERE id_sesi = ?;`,
        args: [
          inVal,
          outVal,
          statusAbsen,
          nowStr,
          calculatedLate,
          calculatedEarly,
          calculatedWork,
          calculatedOvertime,
          calculatedShortage,
          idSesi,
        ],
      });
    }
  }

  await db.execute({
    sql: `INSERT INTO audit_absensi (
          waktu, jenis, tanggal, id_karyawan, nama, baris_referensi, detail, status
        ) VALUES (?, 'Hapus Import Offline', ?, ?, ?, ?, ?, 'Berhasil');`,
    args: [
      nowStr,
      tanggal,
      idUnik,
      String(imp.nama || "-"),
      eventKey,
      `Baris import offline dihapus oleh Operator ${kodeOperator}.`,
    ],
  });

  return { sukses: true, pesan: "Data import offline berhasil dihapus." };
}
