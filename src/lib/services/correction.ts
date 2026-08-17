import "server-only";

import type { Transaction } from "@libsql/client";
import { db, ensureDbInitialized } from "@/lib/db";

export interface KoreksiInput {
  tanggal: string; // YYYY-MM-DD
  id_karyawan: string;
  jenis_koreksi:
    | "Sakit"
    | "Izin"
    | "Dispen"
    | "Alfa"
    | "Lupa Absen Masuk"
    | "Lupa Absen Pulang"
    | "Kendala Sistem - Jam Masuk"
    | "Kendala Sistem - Jam Pulang"
    | "Terlambat";
  jam_koreksi?: string; // HH:mm
  keterangan_admin?: string;
  kode_operator: string;
}

export function generateIdReferensiKoreksi(): string {
  const now = new Date();
  const dateStr = now.toISOString().split("T")[0].replace(/-/g, "");
  const randomNum = Math.floor(1000 + Math.random() * 9000);
  return `KOR-${dateStr}-${randomNum}`;
}

function normalizeDate(raw: string): string {
  const clean = raw.trim();
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(clean)) {
    const [d, m, y] = clean.split("/");
    return `${y}-${m}-${d}`;
  }
  return clean;
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

export async function prosesKoreksiAdmin(input: KoreksiInput) {
  await ensureDbInitialized();

  const date = normalizeDate(input.tanggal);

  if (
    [
      "Lupa Absen Masuk",
      "Lupa Absen Pulang",
      "Kendala Sistem - Jam Masuk",
      "Kendala Sistem - Jam Pulang",
      "Terlambat",
    ].includes(input.jenis_koreksi) &&
    !input.jam_koreksi
  ) {
    return {
      sukses: false,
      pesan: `Jam koreksi wajib diisi untuk '${input.jenis_koreksi}'.`,
    };
  }

  // 1. Validasi Operator
  const opRes = await db.execute({
    sql: "SELECT * FROM master_operator WHERE kode_operator = ? AND status = 'Aktif' LIMIT 1;",
    args: [input.kode_operator],
  });

  if (opRes.rows.length === 0) {
    return {
      sukses: false,
      pesan: `Gagal: Kode Operator '${input.kode_operator}' tidak valid atau nonaktif.`,
    };
  }

  // 2. Validasi Karyawan
  const empRes = await db.execute({
    sql: "SELECT * FROM master_data WHERE id_unik = ? OR kode_karyawan = ? LIMIT 1;",
    args: [input.id_karyawan, input.id_karyawan],
  });

  if (empRes.rows.length === 0) {
    return {
      sukses: false,
      pesan: `Gagal: Karyawan '${input.id_karyawan}' tidak ditemukan.`,
    };
  }

  const emp = empRes.rows[0] as Record<string, unknown>;
  const idUnik = String(emp.id_unik);
  const nama = String(emp.nama);
  const divisi = String(emp.divisi);
  const idShift = Number(emp.id_shift || 1);

  // Check backup_karyawan on date
  const backupRes = await db.execute({
    sql: `SELECT * FROM backup_karyawan WHERE tanggal_tugas = ? AND status_tugas = 'Aktif'
          AND (id_karyawan_asal = ? OR id_karyawan_pengganti = ?) LIMIT 1;`,
    args: [date, idUnik, idUnik],
  });
  const backup = backupRes.rows[0];
  if (backup && String(backup.id_karyawan_asal) === idUnik) {
    return {
      sukses: false,
      pesan: `Gagal: Karyawan '${nama}' sedang digantikan oleh karyawan lain pada tanggal ${date}. (ID Backup: ${backup.id_backup})`,
    };
  }

  let effectiveShiftId = idShift;
  let modeTugas = "NORMAL";
  let backupId = "";
  let originalId = "";

  if (backup) {
    const backupShiftId = Number(backup.id_shift_backup);
    const normalShiftId = idShift;

    const backupShiftRes = await db.execute({
      sql: "SELECT jam_masuk, jam_pulang, awal_absen_menit, batas_masuk_menit, toleransi_masuk_menit, batas_pulang_menit FROM tbl_shift WHERE id_shift = ? LIMIT 1;",
      args: [backupShiftId],
    });
    const normalShiftRes = await db.execute({
      sql: "SELECT jam_masuk, jam_pulang, awal_absen_menit, batas_masuk_menit, toleransi_masuk_menit, batas_pulang_menit FROM tbl_shift WHERE id_shift = ? LIMIT 1;",
      args: [normalShiftId],
    });
    const bShift = backupShiftRes.rows[0];
    const nShift = normalShiftRes.rows[0];

    const checkTime = input.jam_koreksi || "";
    const isCheckIn = [
      "Lupa Absen Masuk",
      "Kendala Sistem - Jam Masuk",
      "Terlambat",
    ].includes(input.jenis_koreksi);

    const checkShiftMatch = (s: Record<string, unknown> | undefined) => {
      if (!s || !checkTime) return false;
      const parts = checkTime.trim().split(":");
      const userMin = Number(parts[0] || 0) * 60 + Number(parts[1] || 0);
      if (isCheckIn) {
        const sParts = String(s.jam_masuk || "07:00").split(":");
        const sIn = Number(sParts[0] || 0) * 60 + Number(sParts[1] || 0);
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
      const sParts = String(s.jam_pulang || "15:00").split(":");
      const sOut = Number(sParts[0] || 0) * 60 + Number(sParts[1] || 0);
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
      modeTugas = "PENGGANTI";
      backupId = String(backup.id_backup);
      originalId = String(backup.id_karyawan_asal);
      effectiveShiftId = backupShiftId;
    } else {
      modeTugas = "NORMAL";
      effectiveShiftId = normalShiftId;
    }
  }

  let idSesi =
    modeTugas === "PENGGANTI"
      ? `${backupId}-PENGGANTI-${idUnik}`
      : `NORMAL-${date.replace(/-/g, "")}-${idUnik}-${effectiveShiftId}`;

  const existRes = await db.execute({
    sql: "SELECT * FROM absensi_harian WHERE id_sesi = ? LIMIT 1;",
    args: [idSesi],
  });
  let existRecord = (existRes.rows[0] as Record<string, unknown>) || null;

  let targetDate = date;

  // If not found by exact idSesi, check if there is an unclosed session for this employee on this date or yesterday
  if (!existRecord) {
    const isCheckout = [
      "Lupa Absen Pulang",
      "Kendala Sistem - Jam Pulang",
    ].includes(input.jenis_koreksi);

    const unclosedRes = await db.execute({
      sql: `SELECT * FROM absensi_harian 
            WHERE id_karyawan = ? AND tanggal = ? 
              AND ((jam_masuk != '' AND (jam_pulang IS NULL OR jam_pulang = '')) 
                OR ((jam_masuk IS NULL OR jam_masuk = '') AND jam_pulang != '')) 
            LIMIT 1;`,
      args: [idUnik, date],
    });
    if (unclosedRes.rows.length > 0) {
      existRecord = unclosedRes.rows[0] as Record<string, unknown>;
      idSesi = String(existRecord.id_sesi);
      modeTugas = String(existRecord.mode_tugas || "NORMAL");
      backupId = String(existRecord.id_backup || "");
      originalId = String(existRecord.id_karyawan_asal || "");
      effectiveShiftId = Number(existRecord.id_shift || effectiveShiftId);
      targetDate = String(existRecord.tanggal || date);
    } else if (isCheckout) {
      const prevDate = (() => {
        const d = new Date(date);
        d.setDate(d.getDate() - 1);
        return d.toISOString().slice(0, 10);
      })();
      const unclosedPrevRes = await db.execute({
        sql: `SELECT * FROM absensi_harian 
              WHERE id_karyawan = ? AND tanggal = ? 
                AND jam_masuk != '' AND (jam_pulang IS NULL OR jam_pulang = '') 
              LIMIT 1;`,
        args: [idUnik, prevDate],
      });
      if (unclosedPrevRes.rows.length > 0) {
        existRecord = unclosedPrevRes.rows[0] as Record<string, unknown>;
        idSesi = String(existRecord.id_sesi);
        modeTugas = String(existRecord.mode_tugas || "NORMAL");
        backupId = String(existRecord.id_backup || "");
        originalId = String(existRecord.id_karyawan_asal || "");
        effectiveShiftId = Number(existRecord.id_shift || effectiveShiftId);
        targetDate = prevDate;
      }
    }
  }

  // Ambil data shift untuk validasi dan kalkulasi metrik
  const shiftRes = await db.execute({
    sql: "SELECT jam_masuk, jam_pulang, nama_shift, jam_kerja_normal_menit, istirahat_menit, toleransi_masuk_menit, batas_masuk_menit, awal_absen_menit, batas_pulang_menit FROM tbl_shift WHERE id_shift = ? LIMIT 1;",
    args: [effectiveShiftId],
  });
  const shiftData = shiftRes.rows[0] as Record<string, unknown> | undefined;
  const toleransiShiftMin = Number(shiftData?.toleransi_masuk_menit ?? 0);
  const awalAbsenShiftMin = Number(shiftData?.awal_absen_menit ?? 120);
  const batasMasukShiftMin = Number(shiftData?.batas_masuk_menit ?? 60);
  const batasPulangShiftMin = Number(shiftData?.batas_pulang_menit ?? 240);
  const shiftJamMasukStr = String(shiftData?.jam_masuk || "07:00");
  const shiftJamPulangStr = String(shiftData?.jam_pulang || "15:00");

  // Validasi Rentang Shift untuk Koreksi Waktu
  if (
    ["Lupa Absen Masuk", "Kendala Sistem - Jam Masuk", "Terlambat"].includes(
      input.jenis_koreksi,
    )
  ) {
    if (input.jam_koreksi) {
      const userInMin = parseTimeToMinutes(input.jam_koreksi);
      const shiftInMin = parseTimeToMinutes(shiftJamMasukStr) ?? 420;
      if (userInMin !== null) {
        let diff = userInMin - shiftInMin;
        if (diff < -720) diff += 1440;
        if (diff > 720) diff -= 1440;
        if (
          diff < -awalAbsenShiftMin ||
          diff > batasMasukShiftMin + toleransiShiftMin
        ) {
          return {
            sukses: false,
            pesan: `Jam masuk (${input.jam_koreksi}) di luar rentang jadwal ${shiftData?.nama_shift || `Shift ${effectiveShiftId}`} (Jam Masuk: ${shiftJamMasukStr}).`,
          };
        }
      }
    }
  } else if (
    ["Lupa Absen Pulang", "Kendala Sistem - Jam Pulang"].includes(
      input.jenis_koreksi,
    )
  ) {
    if (input.jam_koreksi) {
      const userOutMin = parseTimeToMinutes(input.jam_koreksi);
      const shiftOutMin = parseTimeToMinutes(shiftJamPulangStr) ?? 900;
      if (userOutMin !== null) {
        let diff = userOutMin - shiftOutMin;
        if (diff < -720) diff += 1440;
        if (diff > 720) diff -= 1440;
        if (diff < -120 || diff > batasPulangShiftMin) {
          return {
            sukses: false,
            pesan: `Jam pulang (${input.jam_koreksi}) di luar rentang jadwal ${shiftData?.nama_shift || `Shift ${effectiveShiftId}`} (Jam Pulang: ${shiftJamPulangStr}).`,
          };
        }
      }
    }
  }

  const idReferensi = generateIdReferensiKoreksi();
  const nowStr = new Date().toISOString();

  // ── Atomic transaction: semua mutasi multi-tabel dalam satu unit ────────
  const transaction = await db.transaction("write");
  try {
    await _prosesKoreksiMutasi(transaction, {
      input,
      idReferensi,
      nowStr,
      idUnik,
      nama,
      divisi,
      date,
      targetDate,
      idSesi,
      effectiveShiftId,
      modeTugas,
      backupId,
      originalId,
      existRecord,
      shiftData,
    });
    await transaction.commit();
  } catch (err) {
    await transaction.rollback();
    throw err;
  } finally {
    transaction.close();
  }

  return {
    sukses: true,
    pesan: `Koreksi admin '${input.jenis_koreksi}' untuk ${nama} (${idUnik}) berhasil diproses.`,
    id_referensi: idReferensi,
  };
}

// Internal helper: jalankan seluruh mutasi koreksi dalam transaksi yang diberikan
async function _prosesKoreksiMutasi(
  transaction: Transaction,
  ctx: {
    input: KoreksiInput;
    idReferensi: string;
    nowStr: string;
    idUnik: string;
    nama: string;
    divisi: string;
    date: string;
    targetDate: string;
    idSesi: string;
    effectiveShiftId: number;
    modeTugas: string;
    backupId: string;
    originalId: string;
    existRecord: Record<string, unknown> | null;
    shiftData: Record<string, unknown> | undefined;
  },
) {
  const {
    input,
    idReferensi,
    nowStr,
    idUnik,
    nama,
    divisi,
    date,
    targetDate,
    idSesi,
    effectiveShiftId,
    modeTugas,
    backupId,
    originalId,
    existRecord,
    shiftData,
  } = ctx;
  let scanKind: string = input.jenis_koreksi;
  let calculatedLate = 0;
  let calculatedEarly = 0;

  const normalShiftMin = Number(shiftData?.jam_kerja_normal_menit ?? 480);
  const breakShiftMin = Number(shiftData?.istirahat_menit ?? 60);
  const shiftJamMasukStr = String(shiftData?.jam_masuk || "07:00");
  const shiftJamPulangStr = String(shiftData?.jam_pulang || "15:00");
  const shiftInMin = parseTimeToMinutes(shiftJamMasukStr) ?? 420;
  const shiftOutMin = parseTimeToMinutes(shiftJamPulangStr) ?? 900;
  const isOvernightShift = shiftOutMin < shiftInMin;

  const nextDate = (() => {
    const d = new Date(targetDate);
    d.setDate(d.getDate() + 1);
    return d.toISOString().slice(0, 10);
  })();

  const monthNames = [
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
  const dateObj = new Date(date);
  const bulanStr = monthNames[dateObj.getMonth()] || "Januari";
  const tahunNum = dateObj.getFullYear();

  // 3. Simpan ke tabel koreksi_admin
  await transaction.execute({
    sql: `
      INSERT INTO koreksi_admin (
        id_referensi, tanggal, id_karyawan, nama, divisi, jenis_koreksi,
        jam_koreksi, keterangan_admin, status_proses, timestamp, kode_operator
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Sudah Diproses', ?, ?);
    `,
    args: [
      idReferensi,
      targetDate,
      idUnik,
      nama,
      divisi,
      input.jenis_koreksi,
      input.jam_koreksi || "",
      input.keterangan_admin || input.jenis_koreksi,
      nowStr,
      input.kode_operator,
    ],
  });

  if (["Sakit", "Izin", "Dispen", "Alfa"].includes(input.jenis_koreksi)) {
    // ---- KOREKSI SAKIT / IZIN / DISPEN / ALFA ----
    if (existRecord) {
      await transaction.execute({
        sql: `UPDATE absensi_harian SET 
              jam_masuk = '', jam_pulang = '', status_kehadiran = ?, status_absen = 'Tidak Hadir',
              keterangan = ?, sumber = 'Koreksi Admin', update_terakhir = ?,
              menit_terlambat = 0, menit_datang_awal = 0, jam_kerja = 0, lembur = 0, jam_kerja_kurang = 0
              WHERE id_absensi = ?;`,
        args: [
          input.jenis_koreksi,
          input.keterangan_admin || input.jenis_koreksi,
          nowStr,
          Number(existRecord.id_absensi),
        ],
      });
    } else {
      await transaction.execute({
        sql: `INSERT INTO absensi_harian (
                tanggal, id_karyawan, nama, kelas_divisi, jam_masuk, jam_pulang,
                status_kehadiran, status_absen, keterangan, sumber, update_terakhir,
                menit_terlambat, menit_datang_awal, jam_kerja, lembur, jam_kerja_kurang,
                id_shift, bulan, tahun, id_sesi, mode_tugas, id_backup, id_karyawan_asal, tanggal_tugas
              ) VALUES (?, ?, ?, ?, '', '', ?, 'Tidak Hadir', ?, 'Koreksi Admin', ?, 0, 0, 0, 0, 0, ?, ?, ?, ?, ?, ?, ?, ?);`,
        args: [
          date,
          idUnik,
          nama,
          divisi,
          input.jenis_koreksi,
          input.keterangan_admin || input.jenis_koreksi,
          nowStr,
          effectiveShiftId,
          bulanStr,
          tahunNum,
          idSesi,
          modeTugas,
          backupId,
          originalId,
          modeTugas === "PENGGANTI" ? date : "",
        ],
      });
    }
  } else {
    // ---- KOREKSI WAKTU / JAM ----
    let checkInVal = existRecord ? String(existRecord.jam_masuk || "") : "";
    let checkOutVal = existRecord ? String(existRecord.jam_pulang || "") : "";

    if (
      input.jenis_koreksi === "Lupa Absen Masuk" ||
      input.jenis_koreksi === "Kendala Sistem - Jam Masuk" ||
      input.jenis_koreksi === "Terlambat"
    ) {
      scanKind = "Masuk";
      checkInVal = `${targetDate} ${input.jam_koreksi}:00`;
    } else if (
      input.jenis_koreksi === "Lupa Absen Pulang" ||
      input.jenis_koreksi === "Kendala Sistem - Jam Pulang"
    ) {
      scanKind = "Pulang";
      const outTimeMin = parseTimeToMinutes(input.jam_koreksi) ?? 0;
      const inTimeMin = parseTimeToMinutes(checkInVal);
      const isCrossDay =
        inTimeMin !== null
          ? outTimeMin < inTimeMin
          : isOvernightShift && outTimeMin < shiftInMin;
      const outDate = isCrossDay
        ? nextDate
        : targetDate !== date
          ? date
          : targetDate;
      checkOutVal = `${outDate} ${input.jam_koreksi}:00`;
    }

    const inMin = parseTimeToMinutes(checkInVal);
    const outMin = parseTimeToMinutes(checkOutVal);

    if (inMin !== null) {
      let userInTimeline = inMin;
      if (isOvernightShift && userInTimeline < shiftInMin - 720) {
        userInTimeline += 1440;
      }
      if (userInTimeline > shiftInMin) {
        calculatedLate = userInTimeline - shiftInMin;
      } else if (userInTimeline < shiftInMin) {
        calculatedEarly = shiftInMin - userInTimeline;
      }
    }

    let calculatedWork = 0;
    let calculatedOvertime = 0;
    let calculatedShortage = 0;

    if (inMin !== null && outMin !== null) {
      let duration = outMin - inMin;
      if (duration < 0) {
        duration += 1440;
      } else if (
        checkOutVal.startsWith(nextDate) &&
        checkInVal.startsWith(targetDate) &&
        nextDate !== targetDate
      ) {
        duration += 1440;
      }
      calculatedWork = Math.max(0, duration - breakShiftMin);
      calculatedOvertime = Math.max(0, calculatedWork - normalShiftMin);
      calculatedShortage = Math.max(0, normalShiftMin - calculatedWork);
    }

    const statusAbsen =
      checkInVal && checkOutVal
        ? "Lengkap"
        : checkInVal
          ? "Belum Pulang"
          : "Perlu Verifikasi";

    if (existRecord) {
      await transaction.execute({
        sql: `UPDATE absensi_harian SET 
              jam_masuk = ?, jam_pulang = ?, status_kehadiran = 'Hadir', 
              status_absen = ?, keterangan = ?, sumber = 'Koreksi Admin', update_terakhir = ?,
              menit_terlambat = ?, menit_datang_awal = ?, jam_kerja = ?, lembur = ?, jam_kerja_kurang = ?
              WHERE id_absensi = ?;`,
        args: [
          checkInVal,
          checkOutVal,
          statusAbsen,
          input.keterangan_admin || `Koreksi Admin - ${input.jenis_koreksi}`,
          nowStr,
          calculatedLate,
          calculatedEarly,
          calculatedWork,
          calculatedOvertime,
          calculatedShortage,
          Number(existRecord.id_absensi),
        ],
      });
    } else {
      await transaction.execute({
        sql: `INSERT INTO absensi_harian (
                tanggal, id_karyawan, nama, kelas_divisi, jam_masuk, jam_pulang,
                status_kehadiran, status_absen, keterangan, sumber, update_terakhir,
                menit_terlambat, menit_datang_awal, jam_kerja, lembur, jam_kerja_kurang,
                id_shift, bulan, tahun, id_sesi, mode_tugas, id_backup, id_karyawan_asal, tanggal_tugas
              ) VALUES (?, ?, ?, ?, ?, ?, 'Hadir', ?, ?, 'Koreksi Admin', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
        args: [
          targetDate,
          idUnik,
          nama,
          divisi,
          checkInVal,
          checkOutVal,
          statusAbsen,
          input.keterangan_admin || `Koreksi Admin - ${input.jenis_koreksi}`,
          nowStr,
          calculatedLate,
          calculatedEarly,
          calculatedWork,
          calculatedOvertime,
          calculatedShortage,
          effectiveShiftId,
          bulanStr,
          tahunNum,
          idSesi,
          modeTugas,
          backupId,
          originalId,
          modeTugas === "PENGGANTI" ? targetDate : "",
        ],
      });
    }
  }

  // 5. Audit Log ke log_scan (Deduplikasi log koreksi sebelumnya)
  await transaction.execute({
    sql: "DELETE FROM log_scan WHERE tanggal_kerja = ? AND id_karyawan = ? AND jenis_scan = ? AND sumber_data = 'Koreksi Admin' AND COALESCE(id_referensi, '') = ?;",
    args: [
      targetDate,
      idUnik,
      scanKind,
      modeTugas === "PENGGANTI" ? backupId : idReferensi,
    ],
  });

  await transaction.execute({
    sql: `INSERT INTO log_scan (
            timestamp_scan, tanggal_kerja, jam_scan, id_karyawan, nama, divisi,
            jenis_scan, status_proses, sumber_data, catatan_sistem, keterangan,
            menit_terlambat, menit_datang_awal, id_referensi, kode_operator
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'Berhasil', 'Koreksi Admin', ?, ?, ?, ?, ?, ?);`,
    args: [
      nowStr,
      targetDate,
      input.jam_koreksi ? `${input.jam_koreksi}:00` : "00:00:00",
      idUnik,
      nama,
      divisi,
      scanKind,
      `Koreksi Admin - ${input.jenis_koreksi}`,
      input.keterangan_admin || `Koreksi Admin - ${input.jenis_koreksi}`,
      scanKind === "Masuk" ? calculatedLate : 0,
      scanKind === "Masuk" ? calculatedEarly : 0,
      modeTugas === "PENGGANTI" ? backupId : idReferensi,
      input.kode_operator,
    ],
  });
}

export async function getDaftarKoreksi(filter?: {
  tanggal?: string;
  id_karyawan?: string;
}) {
  await ensureDbInitialized();

  let query = "SELECT * FROM koreksi_admin WHERE 1=1";
  const params: (string | number | boolean | null)[] = [];

  if (filter?.tanggal) {
    query += " AND tanggal = ?";
    params.push(filter.tanggal);
  }
  if (filter?.id_karyawan) {
    query += " AND id_karyawan = ?";
    params.push(filter.id_karyawan);
  }

  query += " ORDER BY id_koreksi DESC;";

  const res = await db.execute({ sql: query, args: params });
  return res.rows as unknown as Record<string, unknown>[];
}

export async function hapusKoreksiAdmin(
  idReferensi: string,
  kodeOperator = "SYSTEM",
) {
  await ensureDbInitialized();

  const korRes = await db.execute({
    sql: "SELECT * FROM koreksi_admin WHERE id_referensi = ? LIMIT 1;",
    args: [idReferensi],
  });

  if (korRes.rows.length === 0) {
    return {
      sukses: false,
      pesan: "Data koreksi admin tidak ditemukan.",
    };
  }

  const kor = korRes.rows[0] as Record<string, unknown>;
  const idKaryawan = String(kor.id_karyawan);
  const tanggal = String(kor.tanggal);
  const nowStr = new Date().toISOString();

  // 1. Hapus dari tabel koreksi_admin
  await db.execute({
    sql: "DELETE FROM koreksi_admin WHERE id_referensi = ?;",
    args: [idReferensi],
  });

  // 2. Hapus log scan terkait koreksi ini
  await db.execute({
    sql: "DELETE FROM log_scan WHERE id_referensi = ?;",
    args: [idReferensi],
  });

  // 3. Cek remaining scan logs untuk karyawan di tanggal tersebut
  const remainRes = await db.execute({
    sql: "SELECT * FROM log_scan WHERE id_karyawan = ? AND tanggal_kerja = ? ORDER BY timestamp_scan ASC;",
    args: [idKaryawan, tanggal],
  });

  const absRes = await db.execute({
    sql: "SELECT * FROM absensi_harian WHERE id_karyawan = ? AND (tanggal = ? OR tanggal = date(?, '-1 day')) ORDER BY (CASE WHEN tanggal = ? THEN 0 ELSE 1 END) ASC LIMIT 1;",
    args: [idKaryawan, tanggal, tanggal, tanggal],
  });

  if (absRes.rows.length > 0) {
    const abs = absRes.rows[0] as Record<string, unknown>;
    const idSesi = String(abs.id_sesi);

    if (remainRes.rows.length === 0) {
      await db.execute({
        sql: "DELETE FROM absensi_harian WHERE id_karyawan = ? AND (tanggal = ? OR tanggal = date(?, '-1 day'));",
        args: [idKaryawan, tanggal, tanggal],
      });
    } else {
      const inLog = remainRes.rows.find(
        (r) => String(r.jenis_scan) === "Masuk",
      );
      const outLog = remainRes.rows.find(
        (r) => String(r.jenis_scan) === "Pulang",
      );

      const inVal = inLog
        ? `${tanggal} ${String(inLog.jam_scan).slice(0, 8)}`
        : "";
      const outVal = outLog
        ? `${tanggal} ${String(outLog.jam_scan).slice(0, 8)}`
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
              jam_masuk = ?, jam_pulang = ?, status_kehadiran = 'Hadir',
              status_absen = ?, sumber = 'Scanner', update_terakhir = ?,
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

  // 4. Audit Log
  await db.execute({
    sql: `INSERT INTO audit_absensi (
          waktu, jenis, tanggal, id_karyawan, nama, baris_referensi, detail, status
        ) VALUES (?, 'Hapus Koreksi', ?, ?, ?, ?, ?, 'Berhasil');`,
    args: [
      nowStr,
      tanggal,
      idKaryawan,
      String(kor.nama),
      idReferensi,
      `Koreksi '${kor.jenis_koreksi}' dihapus oleh Operator ${kodeOperator}.`,
    ],
  });

  return {
    sukses: true,
    pesan: `Koreksi admin ${idReferensi} berhasil dihapus.`,
  };
}
