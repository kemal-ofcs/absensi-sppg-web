import "server-only";

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

export async function prosesKoreksiAdmin(input: KoreksiInput) {
  await ensureDbInitialized();

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

  const idReferensi = generateIdReferensiKoreksi();
  const nowStr = new Date().toISOString();

  // 3. Simpan ke tabel koreksi_admin
  await db.execute({
    sql: `
      INSERT INTO koreksi_admin (
        id_referensi, tanggal, id_karyawan, nama, divisi, jenis_koreksi,
        jam_koreksi, keterangan_admin, status_proses, timestamp, kode_operator
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Sudah Diproses', ?, ?);
    `,
    args: [
      idReferensi,
      input.tanggal,
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

  // 4. Update tabel absensi_harian
  const idSesi = `NORMAL-${input.tanggal.replace(/-/g, "")}-${idUnik}-${idShift}`;
  const existRes = await db.execute({
    sql: "SELECT * FROM absensi_harian WHERE id_sesi = ? OR (id_karyawan = ? AND tanggal = ?) LIMIT 1;",
    args: [idSesi, idUnik, input.tanggal],
  });

  const existRecord =
    existRes.rows.length > 0
      ? (existRes.rows[0] as Record<string, unknown>)
      : null;

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
  const dateObj = new Date(input.tanggal);
  const bulanStr = monthNames[dateObj.getMonth()] || "Januari";
  const tahunNum = dateObj.getFullYear();

  // Ambil data shift untuk kalkulasi metrik
  const shiftRes = await db.execute({
    sql: "SELECT jam_masuk, jam_pulang, jam_kerja_normal_menit, istirahat_menit, toleransi_masuk_menit, batas_masuk_menit FROM tbl_shift WHERE id_shift = ? LIMIT 1;",
    args: [idShift],
  });
  const shiftData = shiftRes.rows[0] as Record<string, unknown> | undefined;
  const normalShiftMin = Number(shiftData?.jam_kerja_normal_menit ?? 480);
  const breakShiftMin = Number(shiftData?.istirahat_menit ?? 60);
  const toleransiShiftMin = Number(shiftData?.toleransi_masuk_menit ?? 0);
  const shiftJamMasukStr = String(shiftData?.jam_masuk || "07:00");

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

  let scanKind: string = input.jenis_koreksi;
  let calculatedLate = 0;
  let calculatedEarly = 0;

  if (["Sakit", "Izin", "Dispen", "Alfa"].includes(input.jenis_koreksi)) {
    // ---- KOREKSI SAKIT / IZIN / DISPEN / ALFA ----
    if (existRecord) {
      await db.execute({
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
      await db.execute({
        sql: `INSERT INTO absensi_harian (
                tanggal, id_karyawan, nama, kelas_divisi, jam_masuk, jam_pulang,
                status_kehadiran, status_absen, keterangan, sumber, update_terakhir,
                menit_terlambat, menit_datang_awal, jam_kerja, lembur, jam_kerja_kurang,
                id_shift, bulan, tahun, id_sesi, mode_tugas
              ) VALUES (?, ?, ?, ?, '', '', ?, 'Tidak Hadir', ?, 'Koreksi Admin', ?, 0, 0, 0, 0, 0, ?, ?, ?, ?, 'NORMAL');`,
        args: [
          input.tanggal,
          idUnik,
          nama,
          divisi,
          input.jenis_koreksi,
          input.keterangan_admin || input.jenis_koreksi,
          nowStr,
          idShift,
          bulanStr,
          tahunNum,
          idSesi,
        ],
      });
    }
  } else {
    // ---- KOREKSI WAKTU / JAM ----
    let checkInVal = existRecord ? String(existRecord.jam_masuk || "") : "";
    let checkOutVal = existRecord ? String(existRecord.jam_pulang || "") : "";

    const shiftJamPulangStr = String(shiftData?.jam_pulang || "15:00");
    const shiftInMin = parseTimeToMinutes(shiftJamMasukStr) ?? 420;
    const shiftOutMin = parseTimeToMinutes(shiftJamPulangStr) ?? 900;
    const isOvernightShift = shiftOutMin < shiftInMin;

    const nextDate = (() => {
      const d = new Date(input.tanggal);
      d.setDate(d.getDate() + 1);
      return d.toISOString().slice(0, 10);
    })();

    if (
      input.jenis_koreksi === "Lupa Absen Masuk" ||
      input.jenis_koreksi === "Kendala Sistem - Jam Masuk" ||
      input.jenis_koreksi === "Terlambat"
    ) {
      scanKind = "Masuk";
      checkInVal = `${input.tanggal} ${input.jam_koreksi}:00`;
    } else if (
      input.jenis_koreksi === "Lupa Absen Pulang" ||
      input.jenis_koreksi === "Kendala Sistem - Jam Pulang"
    ) {
      scanKind = "Pulang";
      const outTimeMin = parseTimeToMinutes(input.jam_koreksi) ?? 0;
      const inTimeMin = parseTimeToMinutes(checkInVal) ?? shiftInMin;
      const isCrossDay = isOvernightShift || outTimeMin < inTimeMin;
      const targetDate = isCrossDay ? nextDate : input.tanggal;
      checkOutVal = `${targetDate} ${input.jam_koreksi}:00`;
    }

    const inMin = parseTimeToMinutes(checkInVal);
    const outMin = parseTimeToMinutes(checkOutVal);

    if (inMin !== null) {
      if (inMin > shiftInMin + toleransiShiftMin) {
        calculatedLate = inMin - shiftInMin;
      } else if (inMin < shiftInMin) {
        calculatedEarly = shiftInMin - inMin;
      }
    }

    let calculatedWork = 0;
    let calculatedOvertime = 0;
    let calculatedShortage = 0;

    if (inMin !== null && outMin !== null) {
      let duration = outMin - inMin;
      if (duration < 0 || isOvernightShift) {
        if (duration < 0) {
          duration += 1440;
        } else if (
          checkOutVal.startsWith(nextDate) &&
          checkInVal.startsWith(input.tanggal)
        ) {
          duration += 1440;
        }
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
      await db.execute({
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
      await db.execute({
        sql: `INSERT INTO absensi_harian (
                tanggal, id_karyawan, nama, kelas_divisi, jam_masuk, jam_pulang,
                status_kehadiran, status_absen, keterangan, sumber, update_terakhir,
                menit_terlambat, menit_datang_awal, jam_kerja, lembur, jam_kerja_kurang,
                id_shift, bulan, tahun, id_sesi, mode_tugas
              ) VALUES (?, ?, ?, ?, ?, ?, 'Hadir', ?, ?, 'Koreksi Admin', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'NORMAL');`,
        args: [
          input.tanggal,
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
          idShift,
          bulanStr,
          tahunNum,
          idSesi,
        ],
      });
    }
  }

  // 5. Audit Log ke log_scan (Deduplikasi log koreksi sebelumnya pada tanggal & jenis scan yang sama)
  await db.execute({
    sql: "DELETE FROM log_scan WHERE tanggal_kerja = ? AND id_karyawan = ? AND (jenis_scan = ? OR sumber_data = 'Koreksi Admin');",
    args: [input.tanggal, idUnik, scanKind],
  });

  await db.execute({
    sql: `INSERT INTO log_scan (
            timestamp_scan, tanggal_kerja, jam_scan, id_karyawan, nama, divisi,
            jenis_scan, status_proses, sumber_data, catatan_sistem, keterangan,
            menit_terlambat, menit_datang_awal, id_referensi, kode_operator
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'Berhasil', 'Koreksi Admin', ?, ?, ?, ?, ?, ?);`,
    args: [
      nowStr,
      input.tanggal,
      input.jam_koreksi ? `${input.jam_koreksi}:00` : "00:00:00",
      idUnik,
      nama,
      divisi,
      scanKind,
      `Koreksi Admin - ${input.jenis_koreksi}`,
      input.keterangan_admin || `Koreksi Admin - ${input.jenis_koreksi}`,
      calculatedLate,
      calculatedEarly,
      idReferensi,
      input.kode_operator,
    ],
  });

  return {
    sukses: true,
    pesan: `Koreksi admin '${input.jenis_koreksi}' untuk ${nama} (${idUnik}) berhasil diproses.`,
    id_referensi: idReferensi,
  };
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
