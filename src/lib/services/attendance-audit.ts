import "server-only";

import type { Client } from "@libsql/client";
import {
  formatJamOperasional,
  formatTanggalOperasional,
  jenisShift,
  menitPenutupanScanMasuk,
  menitPenutupanScanPulang,
  type ShiftTimePolicy,
  selisihHariKalender,
} from "@/lib/attendance/time-policy";
import { db, ensureDbInitialized } from "@/lib/db";

export type KeparahanTemuan = "tinggi" | "sedang" | "rendah" | "info";

export interface TemuanAudit {
  idKaryawan: string;
  nama: string;
  divisi: string;
  namaShift: string;
  jamShift: string;
  kategori: string;
  keparahan: KeparahanTemuan;
  detail: string;
  jamMasuk: string;
  jamPulang: string;
  statusKehadiran: string;
  sumber: string;
}

export interface RingkasanAuditAbsensi {
  totalKaryawanAktif: number;
  wajibAbsen: number;
  hadir: number;
  alfa: number;
  izinSakit: number;
  belumScanMasuk: number;
  belumScanPulang: number;
  sedangBekerja: number;
  menungguJamAbsen: number;
  terlambat: number;
  jamKerjaKurang: number;
  perluVerifikasi: number;
  scanDitolak: number;
  koreksiAdmin: number;
  fleksibel: number;
  tanpaData: number;
  shiftTidakValid: number;
  karyawanBermasalah: number;
  skorKualitas: number;
}

export interface BarisLogAudit {
  waktu: string;
  jenis: string;
  nama: string;
  detail: string;
  status: string;
}

export interface HasilAuditAbsensi {
  tanggal: string;
  waktuAudit: string;
  hariLibur: string | null;
  ringkasan: RingkasanAuditAbsensi;
  temuan: TemuanAudit[];
  logAudit: BarisLogAudit[];
}

const PERINGKAT_KEPARAHAN: Record<KeparahanTemuan, number> = {
  tinggi: 0,
  sedang: 1,
  rendah: 2,
  info: 3,
};

/**
 * Ubah menit garis waktu tanggal kerja menjadi label jam yang bisa dibaca.
 * Menit di atas 1440 berarti hari berikutnya (shift malam).
 */
function labelMenit(minute: number): string {
  const hari = Math.floor(minute / 1440);
  const sisa = ((minute % 1440) + 1440) % 1440;
  const jam = `${String(Math.floor(sisa / 60)).padStart(2, "0")}:${String(
    sisa % 60,
  ).padStart(2, "0")}`;
  return hari > 0 ? `${jam} (H+${hari})` : jam;
}

interface BarisShift {
  namaShift: string;
  jamMasuk: string;
  jamPulang: string;
  batasMasukMenit: number;
  toleransiMasukMenit: number;
  batasPulangMenit: number;
  bufferShiftMalamMenit: number;
  jamKerjaNormalMenit: number;
}

interface BarisAbsensi {
  jamMasuk: string;
  jamPulang: string;
  statusKehadiran: string;
  sumber: string;
  menitTerlambat: number;
  jamKerjaKurang: number;
}

/**
 * Audit kualitas absensi untuk satu tanggal kerja.
 *
 * Murni baca — tidak menulis `absensi_harian` maupun memicu Generate Alfa,
 * supaya "melihat kualitas" tidak diam-diam mengubah data. Logikanya kembar
 * dengan `operational.rs::get_attendance_audit` pada jalur Desktop/Mobile.
 */
export async function auditKualitasAbsensi(
  tanggal?: string,
  waktuSimulasi?: Date,
  client?: Client,
): Promise<HasilAuditAbsensi> {
  const targetDb = client ?? db;
  if (!client) await ensureDbInitialized();

  const sekarang = waktuSimulasi ?? new Date();
  const hariIni = formatTanggalOperasional(sekarang);
  const jamSekarang = formatJamOperasional(sekarang);

  const tanggalTarget =
    tanggal && tanggal.trim().length === 10 ? tanggal.trim() : hariIni;
  const hariIniJuga = tanggalTarget === hariIni;
  const masaDepan = tanggalTarget > hariIni;

  const [jamNow, menitNow] = jamSekarang.split(":").map(Number);
  // Garis waktu relatif tanggal kerja, rumus yang sama dipakai Generate Alfa.
  // Sentinel "tanggal lampau = semua jendela lewat" salah untuk shift malam:
  // jendela pulangnya baru tutup pukul 09:00 H+1, sehingga sesi yang masih
  // berjalan dilaporkan "Belum Scan Pulang" saat diaudit pagi harinya.
  const menitBerjalan =
    selisihHariKalender(tanggalTarget, hariIni) * 1440 + jamNow * 60 + menitNow;

  const liburRes = await targetDb.execute({
    sql: "SELECT nama_libur FROM tbl_hari_libur WHERE tanggal = ? AND status_aktif = 1 LIMIT 1;",
    args: [tanggalTarget],
  });
  const hariLibur =
    liburRes.rows.length > 0 ? String(liburRes.rows[0].nama_libur ?? "") : null;

  // ── Pre-load shift ────────────────────────────────────────────────────────
  const shiftRes = await targetDb.execute(
    `SELECT id_shift, nama_shift, jam_masuk, jam_pulang, batas_masuk_menit,
            toleransi_masuk_menit, batas_pulang_menit, buffer_shift_malam_menit,
            jam_kerja_normal_menit
     FROM tbl_shift;`,
  );
  const shifts = new Map<number, BarisShift>();
  for (const row of shiftRes.rows) {
    shifts.set(Number(row.id_shift), {
      namaShift: String(row.nama_shift ?? ""),
      jamMasuk: String(row.jam_masuk ?? ""),
      jamPulang: String(row.jam_pulang ?? ""),
      batasMasukMenit: Number(row.batas_masuk_menit ?? 60),
      toleransiMasukMenit: Number(row.toleransi_masuk_menit ?? 0),
      batasPulangMenit: Number(row.batas_pulang_menit ?? 240),
      bufferShiftMalamMenit: Number(row.buffer_shift_malam_menit ?? 120),
      jamKerjaNormalMenit: Number(row.jam_kerja_normal_menit ?? 0),
    });
  }

  // ── Pre-load absensi sesi NORMAL pada tanggal target ──────────────────────
  const absensiRes = await targetDb.execute({
    sql: `SELECT id_karyawan, jam_masuk, jam_pulang, status_kehadiran, sumber,
                 menit_terlambat, jam_kerja_kurang
          FROM absensi_harian
          WHERE tanggal = ?
            AND (mode_tugas = 'NORMAL' OR mode_tugas IS NULL OR mode_tugas = '');`,
    args: [tanggalTarget],
  });
  const absensi = new Map<string, BarisAbsensi>();
  for (const row of absensiRes.rows) {
    absensi.set(String(row.id_karyawan), {
      jamMasuk: String(row.jam_masuk ?? ""),
      jamPulang: String(row.jam_pulang ?? ""),
      statusKehadiran: String(row.status_kehadiran ?? ""),
      sumber: String(row.sumber ?? ""),
      menitTerlambat: Number(row.menit_terlambat ?? 0),
      jamKerjaKurang: Number(row.jam_kerja_kurang ?? 0),
    });
  }

  // ── Pre-load scan bermasalah pada tanggal target ──────────────────────────
  const scanRes = await targetDb.execute({
    sql: `SELECT id_karyawan, status_proses, COUNT(*) AS jumlah
          FROM log_scan
          WHERE tanggal_kerja = ? AND status_proses IN ('Perlu Verifikasi', 'Ditolak')
          GROUP BY id_karyawan, status_proses;`,
    args: [tanggalTarget],
  });
  const scanMasalah = new Map<
    string,
    { verifikasi: number; ditolak: number }
  >();
  for (const row of scanRes.rows) {
    const id = String(row.id_karyawan);
    const entry = scanMasalah.get(id) ?? { verifikasi: 0, ditolak: 0 };
    if (String(row.status_proses) === "Perlu Verifikasi") {
      entry.verifikasi += Number(row.jumlah ?? 0);
    } else {
      entry.ditolak += Number(row.jumlah ?? 0);
    }
    scanMasalah.set(id, entry);
  }

  const empRes = await targetDb.execute(
    "SELECT id_unik, nama, divisi, id_shift FROM master_data WHERE status_aktif = 'Aktif' ORDER BY nama;",
  );

  const ringkasan: RingkasanAuditAbsensi = {
    totalKaryawanAktif: empRes.rows.length,
    wajibAbsen: 0,
    hadir: 0,
    alfa: 0,
    izinSakit: 0,
    belumScanMasuk: 0,
    belumScanPulang: 0,
    sedangBekerja: 0,
    menungguJamAbsen: 0,
    terlambat: 0,
    jamKerjaKurang: 0,
    perluVerifikasi: 0,
    scanDitolak: 0,
    koreksiAdmin: 0,
    fleksibel: 0,
    tanpaData: 0,
    shiftTidakValid: 0,
    karyawanBermasalah: 0,
    skorKualitas: 100,
  };
  const temuan: TemuanAudit[] = [];

  for (const row of empRes.rows) {
    const idUnik = String(row.id_unik);
    const nama = String(row.nama ?? "");
    const divisi = String(row.divisi ?? "");
    const idShift = Number(row.id_shift ?? 1);

    const shift = shifts.get(idShift);
    if (!shift) {
      ringkasan.shiftTidakValid++;
      ringkasan.karyawanBermasalah++;
      temuan.push({
        idKaryawan: idUnik,
        nama,
        divisi,
        namaShift: `Shift ${idShift}`,
        jamShift: "-",
        kategori: "Shift Tidak Valid",
        keparahan: "tinggi",
        detail: `Shift id ${idShift} tidak ada di tabel shift, absensi karyawan ini tidak dapat dinilai.`,
        jamMasuk: "",
        jamPulang: "",
        statusKehadiran: "",
        sumber: "",
      });
      continue;
    }

    const jamShift = `${shift.jamMasuk} - ${shift.jamPulang}`;

    // Shift fleksibel tetap dinilai: bebas jam absen bukan berarti bebas tidak
    // absen. Jendela waktunya saja yang berbeda — baru tertutup di akhir hari
    // (lihat `menitPenutupanScanMasuk`), sehingga selama harinya berjalan
    // karyawan berstatus "Menunggu Jam Absen".
    const kindShift = jenisShift(
      shift.jamMasuk,
      shift.jamPulang,
      shift.jamKerjaNormalMenit,
    );
    if (kindShift === "flexible") {
      ringkasan.fleksibel++;
    }

    // Hari libur aktif: tidak ada kewajiban absen, jadi tidak dinilai.
    if (hariLibur !== null) continue;

    ringkasan.wajibAbsen++;

    const shiftPolicy: ShiftTimePolicy = {
      kind: kindShift,
      jamMasuk: shift.jamMasuk,
      jamPulang: shift.jamPulang,
      awalAbsenMenit: 0,
      batasMasukMenit: shift.batasMasukMenit,
      toleransiMasukMenit: shift.toleransiMasukMenit,
      batasPulangMenit: shift.batasPulangMenit,
      bufferShiftMalamMenit: shift.bufferShiftMalamMenit,
      offsetIstirahatMulai: 0,
      jamKerjaNormalMenit: shift.jamKerjaNormalMenit,
      istirahatMenit: 0,
    };

    let tutupMasuk: number | null = null;
    let tutupPulang: number | null = null;
    try {
      tutupMasuk = menitPenutupanScanMasuk(shiftPolicy);
      tutupPulang = menitPenutupanScanPulang(shiftPolicy);
    } catch {
      // Jam shift tidak terurai — jendela waktunya tidak bisa dinilai.
    }

    const record = absensi.get(idUnik);
    let bermasalah = false;

    const catat = (
      kategori: string,
      keparahan: KeparahanTemuan,
      detail: string,
    ) => {
      temuan.push({
        idKaryawan: idUnik,
        nama,
        divisi,
        namaShift: shift.namaShift,
        jamShift,
        kategori,
        keparahan,
        detail,
        jamMasuk: record?.jamMasuk ?? "",
        jamPulang: record?.jamPulang ?? "",
        statusKehadiran: record?.statusKehadiran ?? "",
        sumber: record?.sumber ?? "",
      });
    };

    if (!record) {
      if (masaDepan) {
        ringkasan.menungguJamAbsen++;
      } else if (tutupMasuk !== null && menitBerjalan < tutupMasuk) {
        ringkasan.menungguJamAbsen++;
        catat(
          "Menunggu Jam Absen",
          "info",
          `Belum scan masuk, tetapi jendela scan masuk baru tutup pukul ${labelMenit(tutupMasuk)}.`,
        );
      } else if (hariIniJuga) {
        ringkasan.belumScanMasuk++;
        bermasalah = true;
        catat(
          "Belum Scan Masuk",
          "tinggi",
          `Jendela scan masuk sudah tutup pukul ${
            tutupMasuk === null ? "-" : labelMenit(tutupMasuk)
          } dan belum ada satu pun scan.`,
        );
      } else {
        ringkasan.tanpaData++;
        bermasalah = true;
        catat(
          "Tanpa Data Absensi",
          "tinggi",
          "Tanggal kerja sudah lewat tetapi tidak ada baris absensi sama sekali.",
        );
      }
    } else {
      if (record.statusKehadiran === "Alfa") {
        ringkasan.alfa++;
        bermasalah = true;
        catat(
          "Alfa",
          "tinggi",
          `Tercatat Alfa melalui sumber "${record.sumber}".`,
        );
      } else if (record.statusKehadiran === "Hadir") {
        ringkasan.hadir++;
      } else {
        ringkasan.izinSakit++;
      }

      if (
        record.jamMasuk !== "" &&
        record.jamPulang === "" &&
        record.statusKehadiran !== "Alfa"
      ) {
        if (tutupPulang !== null && menitBerjalan > tutupPulang) {
          ringkasan.belumScanPulang++;
          bermasalah = true;
          catat(
            "Belum Scan Pulang",
            "sedang",
            `Sudah scan masuk ${record.jamMasuk} tetapi jendela scan pulang tutup pukul ${labelMenit(
              tutupPulang,
            )} tanpa scan pulang.`,
          );
        } else {
          ringkasan.sedangBekerja++;
        }
      }

      if (record.menitTerlambat > 0) {
        ringkasan.terlambat++;
        catat(
          "Terlambat",
          "rendah",
          `Terlambat ${record.menitTerlambat} menit dari jadwal shift.`,
        );
      }

      if (record.jamKerjaKurang > 0) {
        ringkasan.jamKerjaKurang++;
        catat(
          "Jam Kerja Kurang",
          "rendah",
          `Kekurangan ${record.jamKerjaKurang} menit dari jam kerja normal.`,
        );
      }

      if (record.sumber === "Koreksi Admin") {
        ringkasan.koreksiAdmin++;
        catat(
          "Koreksi Admin",
          "info",
          "Baris ini hasil koreksi manual admin, bukan scan karyawan.",
        );
      }
    }

    const masalahScan = scanMasalah.get(idUnik);
    if (masalahScan) {
      if (masalahScan.verifikasi > 0) {
        ringkasan.perluVerifikasi++;
        bermasalah = true;
        catat(
          "Perlu Verifikasi",
          "sedang",
          `Ada ${masalahScan.verifikasi} scan berstatus Perlu Verifikasi yang belum ditindaklanjuti.`,
        );
      }
      if (masalahScan.ditolak > 0) {
        ringkasan.scanDitolak++;
        bermasalah = true;
        catat(
          "Scan Ditolak",
          "sedang",
          `Ada ${masalahScan.ditolak} scan ditolak (geofence, multi-scan, atau di luar jendela).`,
        );
      }
    }

    if (bermasalah) ringkasan.karyawanBermasalah++;
  }

  temuan.sort(
    (a, b) =>
      PERINGKAT_KEPARAHAN[a.keparahan] - PERINGKAT_KEPARAHAN[b.keparahan] ||
      a.nama.localeCompare(b.nama) ||
      a.kategori.localeCompare(b.kategori),
  );

  ringkasan.skorKualitas =
    ringkasan.wajibAbsen <= 0
      ? 100
      : Math.round(
          (Math.max(0, ringkasan.wajibAbsen - ringkasan.karyawanBermasalah) *
            100) /
            ringkasan.wajibAbsen,
        );

  const logRes = await targetDb.execute({
    sql: "SELECT waktu, jenis, nama, detail, status FROM audit_absensi WHERE tanggal = ? ORDER BY id_audit DESC LIMIT 20;",
    args: [tanggalTarget],
  });

  return {
    tanggal: tanggalTarget,
    waktuAudit: `${hariIni} ${jamSekarang}`,
    hariLibur,
    ringkasan,
    temuan,
    logAudit: logRes.rows.map((row) => ({
      waktu: String(row.waktu ?? ""),
      jenis: String(row.jenis ?? ""),
      nama: String(row.nama ?? ""),
      detail: String(row.detail ?? ""),
      status: String(row.status ?? ""),
    })),
  };
}
