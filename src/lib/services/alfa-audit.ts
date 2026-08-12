import "server-only";

import { db, ensureDbInitialized } from "@/lib/db";

export interface RingkasanAlfa {
  jumlahAlfaDibuat: number;
  jumlahSudahAda: number;
  jumlahBelumWaktunya: number;
  jumlahFleksibel: number;
  jumlahNonaktif: number;
  status: string;
  pesan: string;
}

export async function generateAlfaHarian(
  waktuSimulasi?: Date,
): Promise<RingkasanAlfa> {
  await ensureDbInitialized();

  const sekarang = waktuSimulasi || new Date();

  // 1. Cek Setting system auto_alfa_aktif
  const settingRes = await db.execute(
    "SELECT value FROM setting_gex_system WHERE key = 'auto_alfa_aktif' LIMIT 1;",
  );

  const autoAlfaAktif =
    settingRes.rows.length > 0
      ? String(settingRes.rows[0].value).toLowerCase() === "true"
      : true;

  if (!autoAlfaAktif) {
    return {
      jumlahAlfaDibuat: 0,
      jumlahSudahAda: 0,
      jumlahBelumWaktunya: 0,
      jumlahFleksibel: 0,
      jumlahNonaktif: 0,
      status: "NONAKTIF",
      pesan: "Generate Alfa dimatikan melalui SETTING",
    };
  }

  // 2. Ambil Karyawan Aktif
  const empRes = await db.execute(
    "SELECT * FROM master_data WHERE status_aktif = 'Aktif';",
  );

  const nonaktifRes = await db.execute(
    "SELECT COUNT(*) as count FROM master_data WHERE status_aktif != 'Aktif';",
  );
  const jumlahNonaktif = Number(nonaktifRes.rows[0]?.count || 0);

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

  const tanggalStr = sekarang.toISOString().split("T")[0];
  const bulanStr = monthNames[sekarang.getMonth()] || "Januari";
  const tahunNum = sekarang.getFullYear();
  const nowStr = sekarang.toISOString();

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

    // Shift 4 = Fleksibel -> Skip Alfa
    if (idShift === 4) {
      jumlahFleksibel++;
      continue;
    }

    // Ambil Aturan Shift dari tbl_shift
    const shiftRes = await db.execute({
      sql: "SELECT * FROM tbl_shift WHERE id_shift = ? LIMIT 1;",
      args: [idShift],
    });

    const shift = (shiftRes.rows[0] as Record<string, unknown>) || {
      jam_masuk: "07:00",
      offset_generate_alfa: 180,
    };

    // Hitung Waktu Cutoff Alfa
    const [hMasuk, mMasuk] = String(shift.jam_masuk || "07:00")
      .split(":")
      .map(Number);
    const offsetAlfaMenit = Number(shift.offset_generate_alfa || 180);

    const deadlineAlfaDate = new Date(
      sekarang.getFullYear(),
      sekarang.getMonth(),
      sekarang.getDate(),
      hMasuk,
      mMasuk + offsetAlfaMenit,
      0,
    );

    if (sekarang.getTime() < deadlineAlfaDate.getTime()) {
      jumlahBelumWaktunya++;
      continue;
    }

    // Cek apakah sudah ada rekaman absensi_harian (sesi NORMAL)
    const idSesiNormal = `NORMAL-${tanggalStr.replace(/-/g, "")}-${idUnik}-${idShift}`;
    const existRes = await db.execute({
      sql: "SELECT id_absensi FROM absensi_harian WHERE id_sesi = ? LIMIT 1;",
      args: [idSesiNormal],
    });

    if (existRes.rows.length > 0) {
      jumlahSudahAda++;
      continue;
    }

    // Buat Rekaman ALFA Otomatis
    await db.execute({
      sql: `INSERT INTO absensi_harian (
              tanggal, id_karyawan, nama, kelas_divisi, jam_masuk, jam_pulang,
              status_kehadiran, status_absen, keterangan, sumber, update_terakhir,
              menit_terlambat, menit_datang_awal, jam_kerja, lembur, jam_kerja_kurang,
              id_shift, bulan, tahun, id_sesi, mode_tugas
            ) VALUES (?, ?, ?, ?, '', '', 'Alfa', 'Tidak Hadir', 'Generate alfa otomatis', 'Generate Sistem', ?, 0, 0, 0, 0, 0, ?, ?, ?, ?, 'NORMAL');`,
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
    await db.execute({
      sql: `INSERT INTO audit_absensi (waktu, jenis, tanggal, id_karyawan, nama, baris_referensi, detail, status)
            VALUES (?, 'Generate Alfa', ?, ?, ?, ?, 'Generasi Alfa otomatis oleh sistem', 'Selesai');`,
      args: [nowStr, tanggalStr, idUnik, nama, idSesiNormal],
    });

    jumlahAlfaDibuat++;
  }

  return {
    jumlahAlfaDibuat,
    jumlahSudahAda,
    jumlahBelumWaktunya,
    jumlahFleksibel,
    jumlahNonaktif,
    status: "SELESAI",
    pesan: `Generate Alfa Selesai. Dibuat: ${jumlahAlfaDibuat}, Sudah Ada: ${jumlahSudahAda}`,
  };
}

export async function jalankanAuditKualitasAbsensi() {
  await ensureDbInitialized();

  const ringkasan = await generateAlfaHarian();

  const auditRes = await db.execute(
    "SELECT * FROM audit_absensi ORDER BY id_audit DESC LIMIT 50;",
  );

  return {
    sukses: true,
    ringkasan,
    logs: auditRes.rows as unknown as Record<string, unknown>[],
    pesan: "Audit Kualitas Absensi berhasil dijalankan.",
  };
}
