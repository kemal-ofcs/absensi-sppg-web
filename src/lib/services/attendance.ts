import "server-only";

import type { ScanResult } from "@/lib/contracts/scanner";
import { db, ensureDbInitialized } from "@/lib/db";
import { hitungJarakHaversine, parseQrToken } from "@/lib/validations/scanner";

export type { ScanResult } from "@/lib/contracts/scanner";
export { hitungJarakHaversine, parseQrToken } from "@/lib/validations/scanner";

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

// ----------------------------------------------------
// 3. MESIN UTAMA PROSES SCAN ABSENSI
// ----------------------------------------------------
export async function prosesScanAbsensi(
  payload: ScanPayload,
): Promise<ScanResult> {
  await ensureDbInitialized();

  const sekarang = new Date();
  const sumberScan = payload.sumberScan || "Scanner";
  const kodeOperator = payload.kodeOperator || "";

  // 1. Parse Payload QR Code
  const parseResult = parseQrToken(payload.qrText);
  if (!parseResult.valid) {
    return {
      sukses: false,
      status: "Ditolak",
      jenisScan: "Scan Ditolak",
      idKaryawan: "",
      nama: "-",
      divisi: "-",
      pesan: parseResult.pesan,
    };
  }

  const { idUnik, token } = parseResult;

  // 2. Cari Data Karyawan di master_data
  const masterRes = await db.execute({
    sql: "SELECT * FROM master_data WHERE id_unik = ? OR kode_karyawan = ? LIMIT 1;",
    args: [idUnik, idUnik],
  });

  if (masterRes.rows.length === 0) {
    return {
      sukses: false,
      status: "Ditolak",
      jenisScan: "Scan Ditolak",
      idKaryawan: idUnik,
      nama: "-",
      divisi: "-",
      pesan: `Gagal: ID Karyawan '${idUnik}' tidak ditemukan.`,
    };
  }

  const user = masterRes.rows[0] as Record<string, unknown>;

  // 3. Validasi Token & Status Aktif
  if (String(user.status_aktif || "").toLowerCase() !== "aktif") {
    return {
      sukses: false,
      status: "Ditolak",
      jenisScan: "Scan Ditolak",
      idKaryawan: String(user.id_unik),
      nama: String(user.nama),
      divisi: String(user.divisi),
      pesan: "Scan ditolak: Karyawan berstatus non-aktif.",
    };
  }

  if (String(user.token_absensi || "").trim() !== token) {
    return {
      sukses: false,
      status: "Ditolak",
      jenisScan: "Scan Ditolak",
      idKaryawan: String(user.id_unik),
      nama: String(user.nama),
      divisi: String(user.divisi),
      pesan: "Akses ditolak: Token QR tidak valid / sudah diperbarui.",
    };
  }

  // 4. Validasi Geofencing (GPS Kantor)
  const settingsRes = await db.execute(
    "SELECT key, value FROM setting_gex_system;",
  );
  const settings: Record<string, string> = {};
  for (const row of settingsRes.rows) {
    settings[String(row.key)] = String(row.value);
  }

  const latKantor = Number(settings.lat_kantor || 0);
  const lngKantor = Number(settings.lng_kantor || 0);
  const radiusMax = Number(settings.radius_meter || 100);
  const geofenceEnabled =
    settings.geofence_enabled === "true" ||
    (settings.geofence_enabled === undefined &&
      (latKantor !== 0 || lngKantor !== 0));

  if (geofenceEnabled) {
    if (payload.lat == null || payload.lng == null) {
      const pesanGps =
        "Scan ditolak: Lokasi GPS HP Anda tidak terdeteksi. Wajib mengaktifkan izin lokasi.";
      await catatLogScan({
        timestamp: sekarang,
        tanggalKerja: formatTanggalIso(sekarang),
        jamScan: formatJamIso(sekarang),
        idKaryawan: String(user.id_unik),
        nama: String(user.nama),
        divisi: String(user.divisi),
        jenisScan: "Scan Ditolak",
        statusProses: "Ditolak",
        sumberData: sumberScan,
        catatanSistem: "GPS Tidak Terdeteksi",
        keterangan: "",
        menitTerlambat: 0,
        menitDatangAwal: 0,
        kodeOperator,
      });

      return {
        sukses: false,
        status: "Ditolak",
        jenisScan: "Scan Ditolak",
        idKaryawan: String(user.id_unik),
        nama: String(user.nama),
        divisi: String(user.divisi),
        pesan: pesanGps,
      };
    }

    const jarak = hitungJarakHaversine(
      payload.lat,
      payload.lng,
      latKantor,
      lngKantor,
    );
    if (jarak > radiusMax) {
      const pesanJarak = `Scan ditolak: Posisi Anda di luar area kantor (${jarak}m dari kantor, batas max: ${radiusMax}m).`;
      await catatLogScan({
        timestamp: sekarang,
        tanggalKerja: formatTanggalIso(sekarang),
        jamScan: formatJamIso(sekarang),
        idKaryawan: String(user.id_unik),
        nama: String(user.nama),
        divisi: String(user.divisi),
        jenisScan: "Scan Ditolak",
        statusProses: "Ditolak",
        sumberData: sumberScan,
        catatanSistem: `Di luar radius kantor (${jarak}m > ${radiusMax}m)`,
        keterangan: "",
        menitTerlambat: 0,
        menitDatangAwal: 0,
        kodeOperator,
      });

      return {
        sukses: false,
        status: "Ditolak",
        jenisScan: "Scan Ditolak",
        idKaryawan: String(user.id_unik),
        nama: String(user.nama),
        divisi: String(user.divisi),
        pesan: pesanJarak,
      };
    }
  }

  // 5. Anti Double-Scan Cooldown (Batas Cooldown 60 Detik)
  const cooldownSec = Number(settings.anti_double_scan_seconds || 60);
  const logTerakhirRes = await db.execute({
    sql: `SELECT timestamp_scan FROM log_scan
          WHERE id_karyawan = ? AND sumber_data = 'Scanner'
            AND status_proses IN ('Berhasil', 'Perlu Verifikasi')
          ORDER BY id_log DESC LIMIT 1;`,
    args: [String(user.id_unik)],
  });

  if (logTerakhirRes.rows.length > 0) {
    const lastScanTime = new Date(
      String(logTerakhirRes.rows[0].timestamp_scan),
    ).getTime();
    const selisihDetik = (sekarang.getTime() - lastScanTime) / 1000;
    if (selisihDetik >= 0 && selisihDetik < cooldownSec) {
      const sisa = Math.ceil(cooldownSec - selisihDetik);
      await catatLogScan({
        timestamp: sekarang,
        tanggalKerja: formatTanggalIso(sekarang),
        jamScan: formatJamIso(sekarang),
        idKaryawan: String(user.id_unik),
        nama: String(user.nama),
        divisi: String(user.divisi),
        jenisScan: "Scan Ditolak",
        statusProses: "Ditolak",
        sumberData: sumberScan,
        catatanSistem: `Scan ganda dalam masa cooldown (${cooldownSec} detik)`,
        keterangan: "Duplikat diabaikan",
        menitTerlambat: 0,
        menitDatangAwal: 0,
        kodeOperator,
      });
      return {
        sukses: false,
        status: "Ditolak",
        jenisScan: "Scan Ditolak",
        idKaryawan: String(user.id_unik),
        nama: String(user.nama),
        divisi: String(user.divisi),
        pesan: `Scan ganda terdeteksi. Silakan tunggu ${sisa} detik sebelum scan ulang.`,
      };
    }
  }

  // 6. Cek Penugasan Backup / Pengganti Karyawan
  const tanggalHariIniStr = formatTanggalIso(sekarang);
  const backupRes = await db.execute({
    sql: `SELECT * FROM backup_karyawan 
          WHERE (id_karyawan_asal = ? OR id_karyawan_pengganti = ?) 
          AND tanggal_tugas = ? AND status_tugas = 'Aktif' LIMIT 1;`,
    args: [String(user.id_unik), String(user.id_unik), tanggalHariIniStr],
  });

  let modeTugas: "NORMAL" | "PENGGANTI" = "NORMAL";
  let shiftEfektif = Number(user.id_shift || 1);
  let idBackup = "";
  let idKaryawanAsal = "";

  if (backupRes.rows.length > 0) {
    const backupData = backupRes.rows[0] as Record<string, unknown>;
    if (String(backupData.id_karyawan_asal) === String(user.id_unik)) {
      // User adalah karyawan asal yang sedang digantikan -> Tolak scan!
      const pesanAsal = `Scan ditolak: Anda sedang digantikan oleh ${backupData.nama_karyawan_pengganti} (ID Backup: ${backupData.id_backup}).`;
      await catatLogScan({
        timestamp: sekarang,
        tanggalKerja: tanggalHariIniStr,
        jamScan: formatJamIso(sekarang),
        idKaryawan: String(user.id_unik),
        nama: String(user.nama),
        divisi: String(user.divisi),
        jenisScan: "Scan Ditolak",
        statusProses: "Ditolak",
        sumberData: sumberScan,
        catatanSistem: `Sedang digantikan. ID Backup: ${backupData.id_backup}`,
        keterangan: "",
        menitTerlambat: 0,
        menitDatangAwal: 0,
        idReferensi: String(backupData.id_backup),
        kodeOperator,
      });

      return {
        sukses: false,
        status: "Ditolak",
        jenisScan: "Scan Ditolak",
        idKaryawan: String(user.id_unik),
        nama: String(user.nama),
        divisi: String(user.divisi),
        pesan: pesanAsal,
      };
    }

    if (String(backupData.id_karyawan_pengganti) === String(user.id_unik)) {
      // User bertindak sebagai Karyawan Pengganti!
      modeTugas = "PENGGANTI";
      shiftEfektif = Number(backupData.id_shift_backup);
      idBackup = String(backupData.id_backup);
      idKaryawanAsal = String(backupData.id_karyawan_asal);
    }
  }

  // 7. Ambil Aturan Shift dari tbl_shift
  const shiftRes = await db.execute({
    sql: "SELECT * FROM tbl_shift WHERE id_shift = ? LIMIT 1;",
    args: [shiftEfektif],
  });

  const shiftData = (shiftRes.rows[0] as Record<string, unknown>) || {
    jam_masuk: "07:00",
    jam_pulang: "15:00",
    jam_kerja_normal_menit: 480,
    istirahat_menit: 60,
    toleransi_masuk_menit: 0,
    offset_istirahat_mulai: 240,
  };

  // 8. Tentukan Jenis Scan (Masuk vs Pulang)
  const idSesi =
    modeTugas === "PENGGANTI"
      ? `${idBackup}-PENGGANTI-${user.id_unik}`
      : `NORMAL-${tanggalHariIniStr.replace(/-/g, "")}-${user.id_unik}-${shiftEfektif}`;

  const absensiRes = await db.execute({
    sql: "SELECT * FROM absensi_harian WHERE id_sesi = ? LIMIT 1;",
    args: [idSesi],
  });

  const absensiExist =
    absensiRes.rows.length > 0
      ? (absensiRes.rows[0] as Record<string, unknown>)
      : null;

  let jenisScan = "Masuk";
  let statusProses: "Berhasil" | "Perlu Verifikasi" = "Berhasil";
  const statusKehadiran = "Hadir";
  let keteranganStatus = "Tepat Waktu";
  let menitTerlambat = 0;
  let menitDatangAwal = 0;
  let jamKerja = 0;
  let lembur = 0;
  let jamKerjaKurang = 0;

  if (!absensiExist || !absensiExist.jam_masuk) {
    // ---- SCAN MASUK ----
    jenisScan = "Masuk";

    // Hitung Keterlambatan / Datang Awal berdasarkan jam_masuk shift
    const [hMasuk, mMasuk] = String(shiftData.jam_masuk || "07:00")
      .split(":")
      .map(Number);
    const targetMasukDate = new Date(
      sekarang.getFullYear(),
      sekarang.getMonth(),
      sekarang.getDate(),
      hMasuk,
      mMasuk,
      0,
    );

    const diffMinutes = Math.floor(
      (sekarang.getTime() - targetMasukDate.getTime()) / 60000,
    );
    const toleransi = Number(shiftData.toleransi_masuk_menit || 0);

    if (diffMinutes > toleransi) {
      keteranganStatus = "Terlambat";
      menitTerlambat = diffMinutes;
    } else if (diffMinutes < 0) {
      keteranganStatus = "Datang Lebih Awal";
      menitDatangAwal = Math.abs(diffMinutes);
    } else {
      keteranganStatus = "Tepat Waktu";
    }

    // Upsert ke absensi_harian
    const timestampStr = formatTimestampIso(sekarang);
    const bulanStr = getNamaBulanIndo(sekarang.getMonth());
    const tahunNum = sekarang.getFullYear();

    if (absensiExist) {
      await db.execute({
        sql: `UPDATE absensi_harian SET 
              jam_masuk = ?, status_kehadiran = ?, status_absen = 'Belum Pulang', 
              keterangan = ?, sumber = ?, update_terakhir = ?, menit_terlambat = ?, menit_datang_awal = ?
              WHERE id_sesi = ?;`,
        args: [
          timestampStr,
          statusKehadiran,
          keteranganStatus,
          sumberScan,
          timestampStr,
          menitTerlambat,
          menitDatangAwal,
          idSesi,
        ],
      });
    } else {
      await db.execute({
        sql: `INSERT INTO absensi_harian (
                tanggal, id_karyawan, nama, kelas_divisi, jam_masuk, jam_pulang,
                status_kehadiran, status_absen, keterangan, sumber, update_terakhir,
                menit_terlambat, menit_datang_awal, jam_kerja, lembur, jam_kerja_kurang,
                id_shift, bulan, tahun, id_sesi, mode_tugas, id_backup, id_karyawan_asal, tanggal_tugas
              ) VALUES (?, ?, ?, ?, ?, '', ?, 'Belum Pulang', ?, ?, ?, ?, ?, 0, 0, 0, ?, ?, ?, ?, ?, ?, ?, ?);`,
        args: [
          tanggalHariIniStr,
          String(user.id_unik),
          String(user.nama),
          String(user.divisi),
          timestampStr,
          statusKehadiran,
          keteranganStatus,
          sumberScan,
          timestampStr,
          menitTerlambat,
          menitDatangAwal,
          shiftEfektif,
          bulanStr,
          tahunNum,
          idSesi,
          modeTugas,
          idBackup,
          idKaryawanAsal,
          tanggalHariIniStr,
        ],
      });
    }
  } else {
    // ---- SCAN PULANG ----
    jenisScan = "Pulang";
    const waktuMasukDate = new Date(String(absensiExist.jam_masuk));

    if (Number.isNaN(waktuMasukDate.getTime())) {
      statusProses = "Perlu Verifikasi";
      keteranganStatus = "Scan pulang tanpa data masuk valid";
    } else {
      // Hitung Durasi Jam Kerja
      const totalDurasi = Math.floor(
        (sekarang.getTime() - waktuMasukDate.getTime()) / 60000,
      );
      const istirahat = Number(shiftData.istirahat_menit || 60);
      const kerjaNormal = Number(shiftData.jam_kerja_normal_menit || 480);

      const kerjaEfektif = Math.max(0, totalDurasi - istirahat);
      jamKerja = kerjaEfektif;

      if (kerjaEfektif > kerjaNormal) {
        lembur = kerjaEfektif - kerjaNormal;
        keteranganStatus = "Pulang Lembur";
      } else if (kerjaEfektif < kerjaNormal) {
        jamKerjaKurang = kerjaNormal - kerjaEfektif;
        keteranganStatus = "Pulang Lebih Awal";
      } else {
        keteranganStatus = "Pulang Normal";
      }
    }

    const timestampStr = formatTimestampIso(sekarang);
    await db.execute({
      sql: `UPDATE absensi_harian SET 
            jam_pulang = ?, status_absen = 'Lengkap', keterangan = ?, sumber = ?,
            update_terakhir = ?, jam_kerja = ?, lembur = ?, jam_kerja_kurang = ?
            WHERE id_sesi = ?;`,
      args: [
        timestampStr,
        keteranganStatus,
        sumberScan,
        timestampStr,
        jamKerja,
        lembur,
        jamKerjaKurang,
        idSesi,
      ],
    });
  }

  // 9. Catat Log ke log_scan
  const catatanSistem =
    modeTugas === "PENGGANTI"
      ? `Scan ${jenisScan.toLowerCase()} sebagai karyawan pengganti. ID Backup: ${idBackup}`
      : `Scan ${jenisScan.toLowerCase()} berhasil`;

  await catatLogScan({
    timestamp: sekarang,
    tanggalKerja: tanggalHariIniStr,
    jamScan: formatJamIso(sekarang),
    idKaryawan: String(user.id_unik),
    nama: String(user.nama),
    divisi: String(user.divisi),
    jenisScan,
    statusProses,
    sumberData: sumberScan,
    catatanSistem,
    keterangan: keteranganStatus,
    menitTerlambat,
    menitDatangAwal,
    idReferensi: idBackup,
    kodeOperator,
  });

  // 10. Susun Pesan Respon User
  let pesanRespon = `Jam ${jenisScan} ${user.nama} (${user.id_unik}) berhasil dicatat.\nStatus: ${keteranganStatus}`;
  if (menitTerlambat > 0)
    pesanRespon += `\nTerlambat: ${menitTerlambat} menit.`;
  if (menitDatangAwal > 0)
    pesanRespon += `\nDatang awal: ${menitDatangAwal} menit.`;
  if (lembur > 0) pesanRespon += `\nLembur: ${lembur} menit.`;
  if (jamKerjaKurang > 0)
    pesanRespon += `\nJam kerja kurang: ${jamKerjaKurang} menit.`;
  if (modeTugas === "PENGGANTI")
    pesanRespon += `\nMode Tugas: PENGGANTI (Shift Efektif: ${shiftEfektif})`;

  return {
    sukses: true,
    status: statusProses,
    jenisScan,
    idKaryawan: String(user.id_unik),
    nama: String(user.nama),
    divisi: String(user.divisi),
    pesan: pesanRespon,
    catatanSistem,
    keterangan: keteranganStatus,
    menitTerlambat,
    menitDatangAwal,
    jamKerja,
    lembur,
    jamKerjaKurang,
    shiftEfektif,
    modeTugas,
    idSesi,
  };
}

// ----------------------------------------------------
// HELPER INTERNAL
// ----------------------------------------------------
async function catatLogScan(data: {
  timestamp: Date;
  tanggalKerja: string;
  jamScan: string;
  idKaryawan: string;
  nama: string;
  divisi: string;
  jenisScan: string;
  statusProses: string;
  sumberData: string;
  catatanSistem: string;
  keterangan: string;
  menitTerlambat: number;
  menitDatangAwal: number;
  idReferensi?: string;
  kodeOperator?: string;
}) {
  await db.execute({
    sql: `INSERT INTO log_scan (
            timestamp_scan, tanggal_kerja, jam_scan, id_karyawan, nama, divisi,
            jenis_scan, status_proses, sumber_data, catatan_sistem, keterangan,
            menit_terlambat, menit_datang_awal, id_referensi, kode_operator
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
    args: [
      formatTimestampIso(data.timestamp),
      data.tanggalKerja,
      data.jamScan,
      data.idKaryawan,
      data.nama,
      data.divisi,
      data.jenisScan,
      data.statusProses,
      data.sumberData,
      data.catatanSistem,
      data.keterangan,
      data.menitTerlambat,
      data.menitDatangAwal,
      data.idReferensi || "",
      data.kodeOperator || "",
    ],
  });
}

function formatTanggalIso(d: Date): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function formatJamIso(d: Date): string {
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function formatTimestampIso(d: Date): string {
  return `${formatTanggalIso(d)} ${formatJamIso(d)}`;
}

function getNamaBulanIndo(monthIdx: number): string {
  const bulan = [
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
  return bulan[monthIdx] || "Januari";
}
