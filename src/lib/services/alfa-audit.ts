import "server-only";

import type { Client } from "@libsql/client";
import {
  formatJamOperasional,
  formatTanggalOperasional,
  formatTimestampOperasional,
} from "@/lib/attendance/time-policy";
import { db, ensureDbInitialized } from "@/lib/db";
import { cekHariLiburAktif } from "@/lib/services/holiday";

export interface RingkasanAlfa {
  jumlahAlfaDibuat: number;
  jumlahSudahAda: number;
  jumlahBelumWaktunya: number;
  jumlahFleksibel: number;
  jumlahNonaktif: number;
  status: string;
  pesan: string;
}

export async function getAutoAlfaSetting(client?: Client): Promise<boolean> {
  const targetDb = client ?? db;
  if (!client) await ensureDbInitialized();
  const settingRes = await targetDb.execute(
    "SELECT value FROM setting_gex_system WHERE key = 'auto_alfa_aktif' LIMIT 1;",
  );
  if (settingRes.rows.length === 0) return true;
  return String(settingRes.rows[0].value).toLowerCase() === "true";
}

export async function saveAutoAlfaSetting(
  enabled: boolean,
  client?: Client,
): Promise<{ sukses: boolean }> {
  const targetDb = client ?? db;
  if (!client) await ensureDbInitialized();
  await targetDb.execute({
    sql: `INSERT INTO setting_gex_system (key, value) VALUES ('auto_alfa_aktif', ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value;`,
    args: [enabled ? "true" : "false"],
  });
  return { sukses: true };
}

export async function generateAlfaHarian(
  waktuSimulasi?: Date,
  client?: Client,
): Promise<RingkasanAlfa> {
  const targetDb = client ?? db;
  if (!client) await ensureDbInitialized();

  const sekarang = waktuSimulasi || new Date();

  // 1. Cek Setting system auto_alfa_aktif
  const autoAlfaAktif = await getAutoAlfaSetting(client);
  if (!autoAlfaAktif) {
    return {
      jumlahAlfaDibuat: 0,
      jumlahSudahAda: 0,
      jumlahBelumWaktunya: 0,
      jumlahFleksibel: 0,
      jumlahNonaktif: 0,
      status: "NONAKTIF",
      pesan: "Generate Alfa dimatikan melalui Pengaturan",
    };
  }

  // 2. Ambil Karyawan Aktif & Nonaktif
  const nonaktifRes = await targetDb.execute(
    "SELECT COUNT(*) as count FROM master_data WHERE status_aktif != 'Aktif';",
  );
  const jumlahNonaktif = Number(nonaktifRes.rows[0]?.count || 0);

  const empRes = await targetDb.execute(
    "SELECT * FROM master_data WHERE status_aktif = 'Aktif';",
  );

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

  const nowStr = formatTimestampOperasional(sekarang);
  const tanggalOperasionalStr = formatTanggalOperasional(sekarang);
  const jamOperasionalStr = formatJamOperasional(sekarang);
  const [hSekarang, mSekarang] = jamOperasionalStr.split(":").map(Number);
  const menitSekarang = hSekarang * 60 + mSekarang;

  let jumlahAlfaDibuat = 0;
  let jumlahSudahAda = 0;
  let jumlahBelumWaktunya = 0;
  let jumlahFleksibel = 0;

  for (const row of empRes.rows) {
    const emp = row as Record<string, unknown>;
    const idUnik = String(emp.id_unik);
    const nama = String(emp.nama);
    const divisi = String(emp.divisi);
    const idShift = Number(emp.id_shift || 1);

    // Ambil Aturan Shift dari tbl_shift
    const shiftRes = await targetDb.execute({
      sql: "SELECT * FROM tbl_shift WHERE id_shift = ? LIMIT 1;",
      args: [idShift],
    });

    const shift = (shiftRes.rows[0] as Record<string, unknown>) || {
      jam_masuk: "07:00",
      jam_pulang: "15:00",
      offset_generate_alfa: 180,
    };

    const jamMasukStr = String(shift.jam_masuk || "07:00");
    const jamPulangStr = String(shift.jam_pulang || "15:00");
    const offsetAlfaMenit = Number(shift.offset_generate_alfa || 180);

    // Shift Fleksibel (contoh id_shift 4 atau jam_masuk == '00:00' && jam_pulang == '23:59')
    if (
      idShift === 4 ||
      (jamMasukStr === "00:00" && jamPulangStr === "23:59") ||
      Number(shift.jam_kerja_normal_menit) === 0
    ) {
      jumlahFleksibel++;
      continue;
    }

    // Tentukan Tanggal Kerja berdasarkan Shift
    const [hMasuk, mMasuk] = jamMasukStr.split(":").map(Number);
    const [hPulang, mPulang] = jamPulangStr.split(":").map(Number);
    const menitMasuk = hMasuk * 60 + mMasuk;
    const menitPulang = hPulang * 60 + mPulang;

    let tanggalStr = tanggalOperasionalStr;
    const isOvernight = menitPulang < menitMasuk;

    // Untuk shift malam (jam_pulang < jam_masuk), sebelum jam masuk berikutnya berkaitan dengan tanggal kerja H-1
    if (isOvernight && menitSekarang < menitMasuk) {
      const [y, m, d] = tanggalOperasionalStr.split("-").map(Number);
      const prevDate = new Date(y, m - 1, d - 1);
      tanggalStr = `${prevDate.getFullYear()}-${String(prevDate.getMonth() + 1).padStart(2, "0")}-${String(prevDate.getDate()).padStart(2, "0")}`;
    }

    // Cek apakah tanggal kerja ini adalah Hari Libur Aktif
    const holiday = await cekHariLiburAktif(tanggalStr, client);
    if (holiday) {
      // Jika hari libur, skip generate alfa untuk shift ini
      continue;
    }

    // Hitung Cutoff Threshold Menit
    const cutoffTimelineMinute = isOvernight
      ? menitPulang + 1440 - offsetAlfaMenit
      : menitPulang - offsetAlfaMenit;

    const currentTimelineMinute =
      isOvernight && tanggalOperasionalStr > tanggalStr
        ? 1440 + menitSekarang
        : menitSekarang;

    if (currentTimelineMinute < cutoffTimelineMinute) {
      jumlahBelumWaktunya++;
      continue;
    }

    // Cek apakah sudah ada rekaman absensi sesi NORMAL atau koreksi prioritas
    const idSesiNormal = `NORMAL-${tanggalStr.replace(/-/g, "")}-${idUnik}-${idShift}`;
    const existRes = await targetDb.execute({
      sql: `SELECT id_absensi, status_kehadiran FROM absensi_harian 
            WHERE id_karyawan = ? AND tanggal = ? AND (mode_tugas = 'NORMAL' OR mode_tugas IS NULL OR mode_tugas = '') 
            LIMIT 1;`,
      args: [idUnik, tanggalStr],
    });

    if (existRes.rows.length > 0) {
      jumlahSudahAda++;
      continue;
    }

    const [tY, tM] = tanggalStr.split("-").map(Number);
    const bulanStr = monthNames[tM - 1] || "Januari";
    const tahunNum = tY;

    // Buat Rekaman ALFA Otomatis
    await targetDb.execute({
      sql: `INSERT INTO absensi_harian (
              tanggal, id_karyawan, nama, kelas_divisi, jam_masuk, jam_pulang,
              status_kehadiran, status_absen, keterangan, sumber, update_terakhir,
              menit_terlambat, menit_datang_awal, jam_kerja, lembur, jam_kerja_kurang,
              id_shift, bulan, tahun, id_sesi, mode_tugas
            ) VALUES (?, ?, ?, ?, '', '', 'Alfa', 'Tidak Hadir', 'Generate Alfa otomatis - belum ada absensi atau koreksi Sakit/Izin/Dispen', 'Generate Sistem', ?, 0, 0, 0, 0, 0, ?, ?, ?, ?, 'NORMAL');`,
      args: [
        tanggalStr,
        idUnik,
        nama,
        divisi,
        nowStr,
        idShift,
        bulanStr,
        tahunNum,
        idSesiNormal,
      ],
    });

    // Catat Audit Absensi
    await targetDb.execute({
      sql: `INSERT INTO audit_absensi (waktu, jenis, tanggal, id_karyawan, nama, baris_referensi, detail, status)
            VALUES (?, 'Generate Alfa', ?, ?, ?, ?, 'Alfa sesi NORMAL dibuat karena belum ada absensi atau koreksi Sakit/Izin/Dispen.', 'Selesai');`,
      args: [nowStr, tanggalStr, idUnik, nama, idSesiNormal],
    });

    jumlahAlfaDibuat++;
  }

  const todayHoliday = await cekHariLiburAktif(tanggalOperasionalStr, client);
  const statusSummary = todayHoliday
    ? "LIBUR"
    : jumlahAlfaDibuat > 0
      ? "SELESAI"
      : "IDLE";
  const pesan = todayHoliday
    ? `Hari ini Hari Libur (${todayHoliday.nama_libur}). Generate Alfa dilewati untuk hari ini.`
    : `Generate Alfa Selesai. Dibuat: ${jumlahAlfaDibuat}, Sudah Ada: ${jumlahSudahAda}, Belum Waktunya: ${jumlahBelumWaktunya}`;

  return {
    jumlahAlfaDibuat,
    jumlahSudahAda,
    jumlahBelumWaktunya,
    jumlahFleksibel,
    jumlahNonaktif,
    status: statusSummary,
    pesan,
  };
}

export async function jalankanAuditKualitasAbsensi(client?: Client) {
  const targetDb = client ?? db;
  if (!client) await ensureDbInitialized();

  const ringkasan = await generateAlfaHarian(undefined, client);

  const auditRes = await targetDb.execute(
    "SELECT * FROM audit_absensi ORDER BY id_audit DESC LIMIT 50;",
  );

  return {
    sukses: true,
    ringkasan,
    logs: auditRes.rows as unknown as Record<string, unknown>[],
    pesan: "Audit Kualitas Absensi berhasil dijalankan.",
  };
}
