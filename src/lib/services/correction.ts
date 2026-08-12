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

  if (["Sakit", "Izin", "Dispen", "Alfa"].includes(input.jenis_koreksi)) {
    // ---- KOREKSI SAKIT / IZIN / DISPEN / ALFA ----
    if (existRecord) {
      await db.execute({
        sql: `UPDATE absensi_harian SET 
              jam_masuk = '', jam_pulang = '', status_kehadiran = ?, status_absen = 'Tidak Hadir',
              keterangan = ?, sumber = 'Koreksi Admin', update_terakhir = ?
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
  } else if (
    input.jenis_koreksi === "Lupa Absen Masuk" ||
    input.jenis_koreksi === "Kendala Sistem - Jam Masuk"
  ) {
    // ---- KOREKSI LUPA ABSEN MASUK ----
    const jamMasukKoreksi = `${input.tanggal} ${input.jam_koreksi}:00`;

    if (existRecord) {
      await db.execute({
        sql: `UPDATE absensi_harian SET 
              jam_masuk = ?, status_kehadiran = 'Hadir', 
              status_absen = CASE WHEN jam_pulang != '' THEN 'Lengkap' ELSE 'Belum Pulang' END,
              keterangan = ?, sumber = 'Koreksi Admin', update_terakhir = ?
              WHERE id_absensi = ?;`,
        args: [
          jamMasukKoreksi,
          input.keterangan_admin || `Koreksi Admin - ${input.jenis_koreksi}`,
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
              ) VALUES (?, ?, ?, ?, ?, '', 'Hadir', 'Belum Pulang', ?, 'Koreksi Admin', ?, 0, 0, 0, 0, 0, ?, ?, ?, ?, 'NORMAL');`,
        args: [
          input.tanggal,
          idUnik,
          nama,
          divisi,
          jamMasukKoreksi,
          input.keterangan_admin || `Koreksi Admin - ${input.jenis_koreksi}`,
          nowStr,
          idShift,
          bulanStr,
          tahunNum,
          idSesi,
        ],
      });
    }
  } else if (
    input.jenis_koreksi === "Lupa Absen Pulang" ||
    input.jenis_koreksi === "Kendala Sistem - Jam Pulang"
  ) {
    // ---- KOREKSI LUPA ABSEN PULANG ----
    const jamPulangKoreksi = `${input.tanggal} ${input.jam_koreksi}:00`;

    if (existRecord) {
      await db.execute({
        sql: `UPDATE absensi_harian SET 
              jam_pulang = ?, status_absen = 'Lengkap', 
              keterangan = ?, sumber = 'Koreksi Admin', update_terakhir = ?
              WHERE id_absensi = ?;`,
        args: [
          jamPulangKoreksi,
          input.keterangan_admin || `Koreksi Admin - ${input.jenis_koreksi}`,
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
              ) VALUES (?, ?, ?, ?, '', ?, 'Hadir', 'Lengkap', ?, 'Koreksi Admin', ?, 0, 0, 0, 0, 0, ?, ?, ?, ?, 'NORMAL');`,
        args: [
          input.tanggal,
          idUnik,
          nama,
          divisi,
          jamPulangKoreksi,
          input.keterangan_admin || `Koreksi Admin - ${input.jenis_koreksi}`,
          nowStr,
          idShift,
          bulanStr,
          tahunNum,
          idSesi,
        ],
      });
    }
  } else if (input.jenis_koreksi === "Terlambat") {
    const shiftRes = await db.execute({
      sql: "SELECT jam_masuk, batas_masuk_menit FROM tbl_shift WHERE id_shift = ? LIMIT 1;",
      args: [idShift],
    });
    if (shiftRes.rows.length === 0) {
      return { sukses: false, pesan: "Konfigurasi shift tidak ditemukan." };
    }
    const [hour, minute] = String(input.jam_koreksi).split(":").map(Number);
    const [shiftHour, shiftMinute] = String(shiftRes.rows[0].jam_masuk)
      .split(":")
      .map(Number);
    const arrivalMinutes = hour * 60 + minute;
    const shiftMinutes = shiftHour * 60 + shiftMinute;
    const normalLimit =
      shiftMinutes + Number(shiftRes.rows[0].batas_masuk_menit ?? 0);
    const menitTerlambat = Math.max(0, arrivalMinutes - normalLimit);
    const menitDatangAwal = Math.max(0, shiftMinutes - arrivalMinutes);
    const jamMasukKoreksi = `${input.tanggal} ${input.jam_koreksi}:00`;
    if (existRecord) {
      await db.execute({
        sql: `UPDATE absensi_harian SET jam_masuk = ?, status_kehadiran = 'Hadir',
              status_absen = CASE WHEN jam_pulang != '' THEN 'Lengkap' ELSE 'Belum Pulang' END,
              keterangan = ?, sumber = 'Koreksi Admin', update_terakhir = ?,
              menit_terlambat = ?, menit_datang_awal = ? WHERE id_absensi = ?;`,
        args: [
          jamMasukKoreksi,
          input.keterangan_admin || "Koreksi Admin - Terlambat",
          nowStr,
          menitTerlambat,
          menitDatangAwal,
          Number(existRecord.id_absensi),
        ],
      });
    } else {
      await db.execute({
        sql: `INSERT INTO absensi_harian (
                tanggal, id_karyawan, nama, kelas_divisi, jam_masuk, jam_pulang,
                status_kehadiran, status_absen, keterangan, sumber, update_terakhir,
                menit_terlambat, menit_datang_awal, jam_kerja, lembur,
                jam_kerja_kurang, id_shift, bulan, tahun, id_sesi, mode_tugas
              ) VALUES (?, ?, ?, ?, ?, '', 'Hadir', 'Belum Pulang', ?,
                'Koreksi Admin', ?, ?, ?, 0, 0, 0, ?, ?, ?, ?, 'NORMAL');`,
        args: [
          input.tanggal,
          idUnik,
          nama,
          divisi,
          jamMasukKoreksi,
          input.keterangan_admin || "Koreksi Admin - Terlambat",
          nowStr,
          menitTerlambat,
          menitDatangAwal,
          idShift,
          bulanStr,
          tahunNum,
          idSesi,
        ],
      });
    }
  }

  // 5. Audit Log ke log_scan
  await db.execute({
    sql: `INSERT INTO log_scan (
            timestamp_scan, tanggal_kerja, jam_scan, id_karyawan, nama, divisi,
            jenis_scan, status_proses, sumber_data, catatan_sistem, keterangan,
            menit_terlambat, menit_datang_awal, id_referensi, kode_operator
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'Berhasil', 'Koreksi Admin', ?, ?, 0, 0, ?, ?);`,
    args: [
      nowStr,
      input.tanggal,
      input.jam_koreksi || "00:00:00",
      idUnik,
      nama,
      divisi,
      input.jenis_koreksi,
      `Koreksi Admin - ${input.jenis_koreksi}`,
      input.keterangan_admin || input.jenis_koreksi,
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
