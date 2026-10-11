import "server-only";

import type { Client } from "@libsql/client";
import {
  formatJamOperasional,
  formatTanggalOperasional,
  formatTimestampOperasional,
  jenisShift,
  MENIT_AKHIR_HARI,
  menitGenerateAlfa,
  type ShiftTimePolicy,
  selisihHariKalender,
} from "@/lib/attendance/time-policy";
import { db, ensureDbInitialized } from "@/lib/db";

export interface RingkasanAlfa {
  jumlahAlfaDibuat: number;
  jumlahSudahAda: number;
  jumlahBelumWaktunya: number;
  jumlahFleksibel: number;
  jumlahNonaktif: number;
  /** Karyawan yang dilewati karena tanggal kerjanya hari libur aktif. */
  jumlahLibur: number;
  /** Karyawan yang dilewati karena shift-nya hilang / jam shift tidak terurai. */
  jumlahShiftTidakValid: number;
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
      jumlahLibur: 0,
      jumlahShiftTidakValid: 0,
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

  // ── Pre-load semua shift ke Map (eliminasi N+1 per karyawan) ────────────
  const allShiftsRes = await targetDb.execute(
    `SELECT id_shift, jam_masuk, jam_pulang, offset_generate_alfa,
            jam_kerja_normal_menit, batas_pulang_menit, buffer_shift_malam_menit
     FROM tbl_shift;`,
  );
  const shiftMap = new Map<number, Record<string, unknown>>();
  for (const s of allShiftsRes.rows) {
    shiftMap.set(Number(s.id_shift), s as Record<string, unknown>);
  }

  // ── Pre-load semua tanggal libur aktif ke Set (eliminasi N+1 per karyawan) ──
  const allLiburRes = await targetDb.execute(
    "SELECT tanggal FROM tbl_hari_libur WHERE status_aktif = 1;",
  );
  const liburSet = new Set<string>(
    allLiburRes.rows.map((r) => String(r.tanggal).trim()),
  );

  let jumlahAlfaDibuat = 0;
  let jumlahSudahAda = 0;
  let jumlahBelumWaktunya = 0;
  let jumlahFleksibel = 0;
  // Dulu dua kondisi ini keluar lewat "continue" tanpa jejak, sehingga
  // ringkasan hanya menampilkan nol tanpa alasan.
  let jumlahLibur = 0;
  let jumlahShiftTidakValid = 0;

  for (const row of empRes.rows) {
    const emp = row as Record<string, unknown>;
    const idUnik = String(emp.id_unik);
    const nama = String(emp.nama);
    const divisi = String(emp.divisi);
    const idShift = Number(emp.id_shift || 1);

    // Ambil Aturan Shift dari Map (bukan query ke DB). Shift yang tidak ada
    // TIDAK boleh diganti default karangan — jalur Desktop melewatinya, dan
    // menebak "07:00-15:00" di web membuat kedua jalur menghasilkan Alfa yang
    // berbeda untuk karyawan yang sama.
    const shift = shiftMap.get(idShift);
    if (!shift) {
      jumlahShiftTidakValid++;
      await targetDb.execute({
        sql: `INSERT INTO audit_absensi (waktu, jenis, tanggal, id_karyawan, nama, baris_referensi, detail, status)
              VALUES (?, 'Skip Generate Alfa', ?, ?, ?, '', ?, 'Gagal');`,
        args: [
          nowStr,
          tanggalOperasionalStr,
          idUnik,
          nama,
          `Shift id ${idShift} tidak ditemukan di tbl_shift.`,
        ],
      });
      continue;
    }

    const jamMasukStr = String(shift.jam_masuk ?? "");
    const jamPulangStr = String(shift.jam_pulang ?? "");
    const offsetAlfaMenit = Number(shift.offset_generate_alfa ?? 180);
    const jamKerjaNormalMenit = Number(shift.jam_kerja_normal_menit ?? 0);

    // Shift fleksibel tidak lagi dilewati. Karyawannya bebas absen jam berapa
    // saja, jadi ketidakhadiran baru boleh dinilai setelah hari kalendernya
    // habis — yang di-generate adalah hari kemarin, sama seperti shift malam
    // yang diselesaikan pagi harinya.
    const kindShift = jenisShift(
      jamMasukStr,
      jamPulangStr,
      jamKerjaNormalMenit,
    );
    const isFleksibel = kindShift === "flexible";
    if (isFleksibel) {
      jumlahFleksibel++;
    }

    // Tentukan Tanggal Kerja berdasarkan Shift
    const [hMasuk, mMasuk] = jamMasukStr.split(":").map(Number);
    const [hPulang, mPulang] = jamPulangStr.split(":").map(Number);
    const menitMasuk = hMasuk * 60 + mMasuk;
    const menitPulang = hPulang * 60 + mPulang;
    if (
      !isFleksibel &&
      (!Number.isFinite(menitMasuk) || !Number.isFinite(menitPulang))
    ) {
      jumlahShiftTidakValid++;
      continue;
    }

    let tanggalStr = tanggalOperasionalStr;
    const isOvernight = !isFleksibel && menitPulang < menitMasuk;

    // Hari kerja yang dinilai mundur satu hari selama kita masih berada di
    // dalam shift yang belum selesai: shift malam sebelum jam masuk berikutnya,
    // shift fleksibel sepanjang harinya belum berganti tanggal.
    const masihDiHariSebelumnya = isFleksibel
      ? menitSekarang < MENIT_AKHIR_HARI
      : isOvernight && menitSekarang < menitMasuk;

    if (masihDiHariSebelumnya) {
      const [y, m, d] = tanggalOperasionalStr.split("-").map(Number);
      const prevDate = new Date(y, m - 1, d - 1);
      tanggalStr = `${prevDate.getFullYear()}-${String(prevDate.getMonth() + 1).padStart(2, "0")}-${String(prevDate.getDate()).padStart(2, "0")}`;
    }

    // Cek apakah tanggal kerja ini adalah Hari Libur Aktif (dari Set, bukan query)
    if (liburSet.has(tanggalStr)) {
      jumlahLibur++;
      continue;
    }

    // Alfa baru boleh dibuat setelah jendela scan pulang benar-benar tertutup
    // (jam pulang + batas pulang + buffer shift malam), lalu ditambah
    // offset_generate_alfa. Rumus lama "jam_pulang - offset" mengabaikan
    // batas_pulang_menit dan membuat Alfa selagi karyawan masih berhak scan pulang.
    const shiftPolicy: ShiftTimePolicy = {
      kind: kindShift,
      jamMasuk: jamMasukStr,
      jamPulang: jamPulangStr,
      awalAbsenMenit: 0,
      batasMasukMenit: 0,
      toleransiMasukMenit: 0,
      batasPulangMenit: Number(shift.batas_pulang_menit ?? 240),
      bufferShiftMalamMenit: Number(shift.buffer_shift_malam_menit ?? 120),
      offsetIstirahatMulai: 0,
      jamKerjaNormalMenit,
      istirahatMenit: 0,
    };

    let cutoffTimelineMinute: number;
    try {
      cutoffTimelineMinute = menitGenerateAlfa(shiftPolicy, offsetAlfaMenit);
    } catch {
      jumlahShiftTidakValid++;
      continue;
    }

    const currentTimelineMinute =
      selisihHariKalender(tanggalStr, tanggalOperasionalStr) * 1440 +
      menitSekarang;

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

  const todayHoliday = liburSet.has(tanggalOperasionalStr)
    ? (allLiburRes.rows.find(
        (r) => String(r.tanggal).trim() === tanggalOperasionalStr,
      ) as Record<string, unknown> | undefined)
    : null;
  const statusSummary = todayHoliday
    ? "LIBUR"
    : jumlahAlfaDibuat > 0
      ? "SELESAI"
      : "IDLE";
  const pesan = todayHoliday
    ? `Hari ini Hari Libur (${String(todayHoliday.nama_libur || "")}). Generate Alfa dilewati untuk hari ini.`
    : `Generate Alfa Selesai. Dibuat: ${jumlahAlfaDibuat}, Sudah Ada: ${jumlahSudahAda}, Belum Waktunya: ${jumlahBelumWaktunya}, Fleksibel: ${jumlahFleksibel}, Libur: ${jumlahLibur}, Shift Tidak Valid: ${jumlahShiftTidakValid}`;

  return {
    jumlahAlfaDibuat,
    jumlahSudahAda,
    jumlahBelumWaktunya,
    jumlahFleksibel,
    jumlahNonaktif,
    jumlahLibur,
    jumlahShiftTidakValid,
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
