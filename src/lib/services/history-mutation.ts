import "server-only";

import type { Transaction } from "@libsql/client";
import {
  aturanShiftDariBaris,
  hitungUlangAbsensiDariJam,
} from "@/lib/attendance/time-policy";

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

import { db, ensureDbInitialized } from "@/lib/db";

export interface EditAbsensiHarianPatch {
  jam_masuk?: string; // e.g. "07:00" or "YYYY-MM-DD HH:mm:ss"
  jam_pulang?: string;
  status_kehadiran?: string; // "Hadir" | "Sakit" | "Izin" | "Dispen" | "Alfa"
  status_absen?: string; // "Lengkap" | "Belum Pulang" | "Tidak Hadir" | "Perlu Verifikasi"
  keterangan?: string;
}

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

const STATUS_TIDAK_HADIR = new Set(["Sakit", "Izin", "Dispen", "Alfa"]);

/**
 * Menyelaraskan absensi satu tanggal setelah log koreksi/import dihapus.
 *
 * Hanya sesi bersumber `sumberDihapus` pada tanggal itu yang disentuh. Versi
 * sebelumnya ikut menghapus absensi H-1 walau H-1 punya scan sendiri.
 * Kembar dengan `selaraskan_absensi_setelah_hapus` di `administration.rs`.
 */
export async function selaraskanAbsensiSetelahHapus(
  transaction: Transaction,
  input: {
    idKaryawan: string;
    tanggal: string;
    sumberDihapus: string[];
    nowStr: string;
  },
) {
  const { idKaryawan, tanggal, sumberDihapus, nowStr } = input;
  const absRes = await transaction.execute({
    sql: `SELECT id_sesi, id_shift FROM absensi_harian
          WHERE id_karyawan = ? AND tanggal = ? AND sumber IN (${sumberDihapus.map(() => "?").join(", ")})
          ORDER BY update_terakhir DESC LIMIT 1;`,
    args: [idKaryawan, tanggal, ...sumberDihapus],
  });
  const abs = absRes.rows[0];
  if (!abs) return;
  const idSesi = String(abs.id_sesi);

  const sisa = (
    await transaction.execute({
      sql: "SELECT jenis_scan, jam_scan, sumber_data FROM log_scan WHERE id_karyawan = ? AND tanggal_kerja = ? ORDER BY jam_scan ASC;",
      args: [idKaryawan, tanggal],
    })
  ).rows;
  if (sisa.length === 0) {
    await transaction.execute({
      sql: "DELETE FROM absensi_harian WHERE id_sesi = ?;",
      args: [idSesi],
    });
    return;
  }

  const inLog = sisa.find((r) => String(r.jenis_scan) === "Masuk");
  const outLog = sisa.findLast((r) => String(r.jenis_scan) === "Pulang");
  const tidakHadir = sisa.find((r) =>
    STATUS_TIDAK_HADIR.has(String(r.jenis_scan)),
  );
  const sumber = String(sisa[0].sumber_data);

  if (!inLog && !outLog && tidakHadir) {
    // Yang tersisa koreksi Sakit/Izin/Dispen/Alfa: kembalikan status itu.
    await transaction.execute({
      sql: `UPDATE absensi_harian SET jam_masuk = '', jam_pulang = '', status_kehadiran = ?,
            status_absen = 'Tidak Hadir', sumber = ?, update_terakhir = ?,
            menit_terlambat = 0, menit_datang_awal = 0, jam_kerja = 0, lembur = 0, jam_kerja_kurang = 0
            WHERE id_sesi = ?;`,
      args: [String(tidakHadir.jenis_scan), sumber, nowStr, idSesi],
    });
    return;
  }

  const inVal = inLog ? formatDateTime(tanggal, String(inLog.jam_scan)) : "";
  const inMin = parseTimeToMinutes(inVal);
  const outJam = outLog ? String(outLog.jam_scan) : "";
  const outJamMin = parseTimeToMinutes(outJam);
  // Pulang lebih awal dari masuk berarti shift lintas hari.
  const tanggalPulang =
    inMin !== null && outJamMin !== null && outJamMin < inMin
      ? (() => {
          const d = new Date(`${tanggal}T00:00:00Z`);
          d.setUTCDate(d.getUTCDate() + 1);
          return d.toISOString().slice(0, 10);
        })()
      : tanggal;
  const outVal = outLog ? formatDateTime(tanggalPulang, outJam) : "";
  const outMin = parseTimeToMinutes(outVal);
  let duration: number | null = null;
  if (inMin !== null && outMin !== null) {
    duration = outMin - inMin;
    if (duration < 0) duration += 1440;
  }

  // Lima kolom yang sama dengan `load_shift_clock_rules` di Rust.
  const shiftRes = await transaction.execute({
    sql: "SELECT jam_masuk, jam_pulang, jam_kerja_normal_menit, istirahat_menit, offset_istirahat_mulai FROM tbl_shift WHERE id_shift = ? LIMIT 1;",
    args: [Number(abs.id_shift || 1)],
  });
  const hasil = hitungUlangAbsensiDariJam({
    masukMenit: inMin,
    durasiMenit: duration,
    shift: aturanShiftDariBaris(
      shiftRes.rows[0] as Record<string, unknown> | undefined,
    ),
  });
  const statusAbsen =
    inVal && outVal ? "Lengkap" : inVal ? "Belum Pulang" : "Perlu Verifikasi";

  await transaction.execute({
    sql: `UPDATE absensi_harian SET
          jam_masuk = ?, jam_pulang = ?, status_kehadiran = 'Hadir',
          status_absen = ?, sumber = ?, update_terakhir = ?,
          menit_terlambat = ?, menit_datang_awal = ?, jam_kerja = ?, lembur = ?, jam_kerja_kurang = ?
          WHERE id_sesi = ?;`,
    args: [
      inVal,
      outVal,
      statusAbsen,
      sumber,
      nowStr,
      hasil.menitTerlambat,
      hasil.menitDatangAwal,
      hasil.jamKerja,
      hasil.lembur,
      hasil.jamKerjaKurang,
      idSesi,
    ],
  });
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
    sql: "SELECT jam_masuk, jam_pulang, jam_kerja_normal_menit, istirahat_menit, offset_istirahat_mulai FROM tbl_shift WHERE id_shift = ? LIMIT 1;",
    args: [idShift],
  });
  const aturanShift = aturanShiftDariBaris(
    shiftRes.rows[0] as Record<string, unknown> | undefined,
  );
  const shiftInMin = parseTimeToMinutes(aturanShift.jamMasuk) ?? 420;
  const shiftOutMin = parseTimeToMinutes(aturanShift.jamPulang) ?? 900;
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

    let duration: number | null = null;
    if (inMin !== null && outMin !== null) {
      duration = outMin - inMin;
      if (duration < 0) {
        duration += 1440;
      } else if (
        checkOutVal.startsWith(nextDate) &&
        checkInVal.startsWith(tanggal) &&
        nextDate !== tanggal
      ) {
        duration += 1440;
      }
    }

    const hasil = hitungUlangAbsensiDariJam({
      masukMenit: inMin,
      durasiMenit: duration,
      shift: aturanShift,
    });
    calculatedLate = hasil.menitTerlambat;
    calculatedEarly = hasil.menitDatangAwal;
    calculatedWork = hasil.jamKerja;
    calculatedOvertime = hasil.lembur;
    calculatedShortage = hasil.jamKerjaKurang;
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
  const jenisScanDeleted = String(log.jenis_scan || "");
  const nowStr = new Date().toISOString();

  await db.execute({
    sql: "DELETE FROM log_scan WHERE id_log = ?;",
    args: [idLog],
  });

  const remainRes = await db.execute({
    sql: "SELECT * FROM log_scan WHERE id_karyawan = ? AND tanggal_kerja = ? ORDER BY jam_scan ASC;",
    args: [idKaryawan, tanggalKerja],
  });

  const absRes = await db.execute({
    sql: "SELECT * FROM absensi_harian WHERE id_karyawan = ? AND (tanggal = ? OR tanggal = date(?, '-1 day')) ORDER BY (CASE WHEN tanggal = ? THEN 0 ELSE 1 END) ASC LIMIT 1;",
    args: [idKaryawan, tanggalKerja, tanggalKerja, tanggalKerja],
  });

  let deletedAbsensiIdSesi: string | null = null;

  if (absRes.rows.length > 0) {
    const abs = absRes.rows[0] as Record<string, unknown>;
    const idSesi = String(abs.id_sesi);

    if (remainRes.rows.length === 0) {
      await db.execute({
        sql: "DELETE FROM absensi_harian WHERE id_karyawan = ? AND (tanggal = ? OR tanggal = date(?, '-1 day'));",
        args: [idKaryawan, tanggalKerja, tanggalKerja],
      });
      deletedAbsensiIdSesi = idSesi;
    } else {
      const inLog = remainRes.rows.find(
        (r) =>
          String(r.jenis_scan) === "Masuk" &&
          String(r.status_proses || "Berhasil") === "Berhasil",
      );
      const outLog = remainRes.rows.find(
        (r) =>
          String(r.jenis_scan) === "Pulang" &&
          String(r.status_proses || "Berhasil") === "Berhasil",
      );

      const existingIn = String(abs.jam_masuk || "");
      const existingOut = String(abs.jam_pulang || "");
      const existingLate = Number(abs.menit_terlambat || 0);
      const existingEarly = Number(abs.menit_datang_awal || 0);

      const inVal =
        jenisScanDeleted === "Masuk"
          ? inLog
            ? formatDateTime(tanggalKerja, String(inLog.jam_scan))
            : ""
          : inLog
            ? formatDateTime(tanggalKerja, String(inLog.jam_scan))
            : existingIn;

      const outVal =
        jenisScanDeleted === "Pulang"
          ? outLog
            ? formatDateTime(tanggalKerja, String(outLog.jam_scan))
            : ""
          : outLog
            ? formatDateTime(tanggalKerja, String(outLog.jam_scan))
            : existingOut;

      if (!inVal && !outVal) {
        await db.execute({
          sql: "DELETE FROM absensi_harian WHERE id_sesi = ?;",
          args: [idSesi],
        });
        deletedAbsensiIdSesi = idSesi;
      } else {
        const statusAbsen =
          inVal && outVal
            ? "Lengkap"
            : inVal
              ? "Belum Pulang"
              : "Perlu Verifikasi";

        const idShift = Number(abs.id_shift || 1);
        const shiftRes = await db.execute({
          sql: "SELECT jam_masuk, jam_pulang, jam_kerja_normal_menit, istirahat_menit, offset_istirahat_mulai FROM tbl_shift WHERE id_shift = ? LIMIT 1;",
          args: [idShift],
        });
        const aturanShift = aturanShiftDariBaris(
          shiftRes.rows[0] as Record<string, unknown> | undefined,
        );

        const inMin = inVal ? parseTimeToMinutes(inVal) : null;
        const outMin = outVal ? parseTimeToMinutes(outVal) : null;
        let duration: number | null = null;
        if (inMin !== null && outMin !== null) {
          duration = outMin - inMin;
          if (duration < 0) {
            duration += 1440;
          }
        }

        const hasil = hitungUlangAbsensiDariJam({
          masukMenit: inMin,
          durasiMenit: duration,
          shift: aturanShift,
        });
        // Log Pulang yang dihapus tidak mengubah kapan karyawannya masuk, jadi
        // terlambat/datang awal yang sudah tercatat dipertahankan.
        const pertahankanMasuk =
          jenisScanDeleted === "Pulang" && Boolean(inVal);
        const calculatedLate = pertahankanMasuk
          ? existingLate
          : hasil.menitTerlambat;
        const calculatedEarly = pertahankanMasuk
          ? existingEarly
          : hasil.menitDatangAwal;
        const calculatedWork = hasil.jamKerja;
        const calculatedOvertime = hasil.lembur;
        const calculatedShortage = hasil.jamKerjaKurang;

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
  }

  // Riwayat asal ikut terhapus begitu tidak ada lagi log yang merujuknya.
  // Selama masih ada log lain dengan referensi sama — misalnya satu import yang
  // membuat baris Masuk DAN Pulang — riwayatnya dipertahankan supaya log yang
  // tersisa tidak menggantung tanpa asal-usul.
  //
  // Prefiks id_referensi membedakan sumbernya: `KOR-` koreksi admin, `IMP-`
  // import manual. ID penugasan backup tidak berawalan keduanya, jadi penugasan
  // backup tidak pernah ikut terhapus.
  const referensi = String(log.id_referensi ?? "");
  if (referensi) {
    const sisaRes = await db.execute({
      sql: "SELECT COUNT(*) AS total FROM log_scan WHERE COALESCE(id_referensi, '') = ?;",
      args: [referensi],
    });
    const masihDirujuk = Number(sisaRes.rows[0]?.total ?? 0) > 0;

    if (!masihDirujuk) {
      if (referensi.startsWith("KOR-")) {
        await db.execute({
          sql: "DELETE FROM koreksi_admin WHERE id_referensi = ?;",
          args: [referensi],
        });
      } else if (referensi.startsWith("IMP-")) {
        await db.execute({
          sql: "DELETE FROM import_offline WHERE event_key = ?;",
          args: [referensi],
        });
      }
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
    deletedAbsensiIdSesi,
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

  const transaction = await db.transaction("write");
  try {
    await transaction.execute({
      sql: "DELETE FROM import_offline WHERE event_key = ?;",
      args: [eventKey],
    });

    // Baris Gagal tidak pernah menulis absensi maupun log scan.
    if (String(imp.status_proses) !== "Gagal") {
      // Log milik import INI saja: lewat event_key, atau — pada mode pengganti,
      // yang id_referensi-nya berisi ID backup — lewat stempel waktu yang sama
      // dengan baris importnya. Log tanpa referensi adalah data lama.
      await transaction.execute({
        sql: `DELETE FROM log_scan
              WHERE id_referensi = ?
                OR (sumber_data IN ('Import Offline', 'Import Manual')
                    AND id_karyawan = ? AND tanggal_kerja = ?
                    AND ((? <> '' AND timestamp_scan = ?
                          AND COALESCE(id_referensi, '') NOT LIKE 'IMP-%')
                      OR COALESCE(id_referensi, '') = ''));`,
        args: [
          eventKey,
          idUnik,
          tanggal,
          String(imp.timestamp_input ?? ""),
          String(imp.timestamp_input ?? ""),
        ],
      });
      await selaraskanAbsensiSetelahHapus(transaction, {
        idKaryawan: idUnik,
        tanggal,
        sumberDihapus: ["Import Manual", "Import Offline"],
        nowStr,
      });
    }

    await transaction.execute({
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
    await transaction.commit();
  } catch (error) {
    await transaction.rollback();
    throw error;
  } finally {
    transaction.close();
  }

  return { sukses: true, pesan: "Data import offline berhasil dihapus." };
}
