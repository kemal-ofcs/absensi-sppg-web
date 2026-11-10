/**
 * Laporan kehadiran per karyawan untuk ekspor Excel dasbor: satu baris per
 * karyawan, satu kolom per tanggal, lalu total.
 *
 * Backend (`getLaporanKehadiran` di `report.ts`, `laporan_kehadiran` di
 * `administration.rs`) hanya mengirim data mentah; matriksnya disusun di sini
 * sekali untuk ketiga build. Libur memakai `wajibMasuk` dan whitelist milik
 * auto-alfa, jadi laporan tidak pernah berselisih dengan keputusan alfa.
 */

import { parseHariKerja, tanggalValid, wajibMasuk } from "./hari-kerja";
import {
  evaluateHolidayScan,
  type HolidayWhitelistEntry,
} from "./holiday-whitelist";
import { kodeKelompok } from "./hr-pengajuan";

type Hasil<T> = { ok: true; value: T } | { ok: false; error: string };

/** Cermin `MAKS_HARI_LAPORAN` di `administration.rs`. */
export const MAKS_HARI_LAPORAN = 92;

export interface KaryawanLaporan {
  id: string;
  kode: string;
  nama: string;
  divisi: string;
  aktif: number;
  hari_kerja: string | null;
  kode_shift: number | string | null;
}

/** Satu karyawan pada satu tanggal, multi-sesi sudah digabung oleh SQL. */
export interface HariLaporan {
  id: string;
  tanggal: string;
  hadir: number;
  /** Menit terlambat sesi yang paling telat; > 0 berarti hari itu terlambat. */
  telat: number;
  /** Jumlah menit terlambat semua sesi hari itu. */
  menit: number;
  sakit: number;
  izin: number;
  dispensasi: number;
  alfa: number;
}

export interface DataLaporanKehadiran {
  mulai: string;
  selesai: string;
  hari_ini: string;
  karyawan: KaryawanLaporan[];
  hari: HariLaporan[];
  libur: { tanggal: string; nama: string }[];
  whitelist: HolidayWhitelistEntry[];
  /** Pengajuan cuti/izin/sakit/dinas luar yang berlaku (HRIS v37, v38). */
  pengajuan?: PengajuanLaporan[];
  /** Tukar shift berlaku (HRIS v38): jadwal tanggal itu dari shift tukar. */
  tukar?: TukarLaporan[];
}

export interface TukarLaporan {
  id: string;
  tanggal: string;
  hari_kerja: string | null;
  kode_shift: number | string | null;
}

export interface PengajuanLaporan {
  id: string;
  mulai: string;
  selesai: string;
  kelompok: string;
}

export const KODE_LAPORAN = [
  ["H", "Hadir tepat waktu"],
  ["T", "Hadir, terlambat"],
  ["S", "Sakit"],
  ["I", "Izin"],
  ["C", "Cuti (pengajuan HRIS)"],
  ["DL", "Dinas luar (pengajuan HRIS)"],
  ["D", "Dispensasi"],
  ["A", "Alfa (tidak hadir tanpa keterangan)"],
  ["L", "Hari libur dari halaman Hari Libur"],
  ["M", "Libur mingguan: di luar hari kerja shift"],
  ["-", "Seharusnya masuk, tetapi belum ada catatan absensi"],
] as const;

export interface BarisLaporan {
  karyawan: KaryawanLaporan;
  /** Sejajar `tanggal`; kosong untuk tanggal sesudah hari ini. */
  sel: string[];
  hadir: number;
  terlambat: number;
  menitTerlambat: number;
  sakit: number;
  izin: number;
  cuti: number;
  /** Dinas luar: hari wajib dan ikut persen kehadiran. */
  dinas: number;
  dispensasi: number;
  alfa: number;
  tanpaData: number;
  libur: number;
  wajibMasuk: number;
  /** (Hadir + dinas) ÷ hari wajib masuk, satu desimal; `null` bila tidak ada hari wajib. */
  persen: number | null;
}

/** Cermin `validate_rentang_laporan`; pesannya sama kata demi kata. */
export function validateRentangLaporan(
  mulai: string,
  selesai: string,
): Hasil<{ mulai: string; selesai: string }> {
  if (!tanggalValid(mulai) || !tanggalValid(selesai)) {
    return { ok: false, error: "Tanggal laporan tidak valid." };
  }
  const selisih =
    (Date.parse(`${selesai}T00:00:00Z`) - Date.parse(`${mulai}T00:00:00Z`)) /
    86_400_000;
  if (selisih < 0) {
    return {
      ok: false,
      error: "Tanggal selesai tidak boleh sebelum tanggal mulai.",
    };
  }
  if (selisih >= MAKS_HARI_LAPORAN) {
    return {
      ok: false,
      error: `Rentang laporan paling panjang ${MAKS_HARI_LAPORAN} hari.`,
    };
  }
  return { ok: true, value: { mulai, selesai } };
}

/** Setiap tanggal dari `mulai` sampai `selesai`, inklusif. */
export function daftarTanggal(mulai: string, selesai: string): string[] {
  const hasil: string[] = [];
  const awal = Date.parse(`${mulai}T00:00:00Z`);
  for (let i = 0; i <= MAKS_HARI_LAPORAN; i++) {
    const tanggal = new Date(awal + i * 86_400_000).toISOString().slice(0, 10);
    if (tanggal > selesai) break;
    hasil.push(tanggal);
  }
  return hasil;
}

/**
 * Kode hari yang punya catatan: Hadir menang atas Sakit/Izin/Dispensasi, yang
 * menang atas Alfa. `null` = tidak ada status yang dikenali, sehingga tanggal
 * itu dinilai dari jadwalnya.
 */
function kodeTercatat(hari: HariLaporan | undefined): string | null {
  if (!hari) return null;
  if (Number(hari.hadir) === 1) return Number(hari.telat) > 0 ? "T" : "H";
  if (Number(hari.sakit) === 1) return "S";
  if (Number(hari.izin) === 1) return "I";
  if (Number(hari.dispensasi) === 1) return "D";
  if (Number(hari.alfa) === 1) return "A";
  return null;
}

export function susunLaporanKehadiran(data: DataLaporanKehadiran): {
  tanggal: string[];
  baris: BarisLaporan[];
} {
  const tanggal = daftarTanggal(data.mulai, data.selesai);
  const libur = new Set(data.libur.map((item) => item.tanggal));
  const catatan = new Map(
    data.hari.map((hari) => [`${hari.id}|${hari.tanggal}`, hari]),
  );
  const kodeAjuan = new Map<string, string>();
  for (const p of data.pengajuan ?? []) {
    const kode = kodeKelompok(p.kelompok);
    if (!kode) continue;
    for (const t of tanggal) {
      if (t >= p.mulai && t <= p.selesai && !kodeAjuan.has(`${p.id}|${t}`)) {
        kodeAjuan.set(`${p.id}|${t}`, kode);
      }
    }
  }

  // Tukar pertama per karyawan per tanggal (urutan SQL), sama dengan Alfa.
  const tukar = new Map<string, TukarLaporan>();
  for (const x of data.tukar ?? []) {
    const kunci = `${x.id}|${x.tanggal}`;
    if (!tukar.has(kunci)) tukar.set(kunci, x);
  }

  const baris = data.karyawan.map((karyawan): BarisLaporan => {
    const dijadwalkanPada = (t: string) => {
      const shiftTukar = tukar.get(`${karyawan.id}|${t}`);
      const hariMasuk = parseHariKerja((shiftTukar ?? karyawan).hari_kerja);
      const kodeShift = Number((shiftTukar ?? karyawan).kode_shift);
      const tanggalLibur = libur.has(t);
      return wajibMasuk({
        tanggal: t,
        hariMasuk,
        libur: tanggalLibur,
        masukSaatLibur:
          tanggalLibur &&
          evaluateHolidayScan(data.whitelist, {
            tanggal: t,
            divisi: karyawan.divisi,
            kodeShift: Number.isFinite(kodeShift) ? kodeShift : null,
          }).allowed,
      });
    };
    const hasil: BarisLaporan = {
      karyawan,
      sel: [],
      hadir: 0,
      terlambat: 0,
      menitTerlambat: 0,
      sakit: 0,
      izin: 0,
      cuti: 0,
      dinas: 0,
      dispensasi: 0,
      alfa: 0,
      tanpaData: 0,
      libur: 0,
      wajibMasuk: 0,
      persen: null,
    };

    for (const t of tanggal) {
      if (t > data.hari_ini) {
        hasil.sel.push("");
        continue;
      }
      const hari = catatan.get(`${karyawan.id}|${t}`);
      const kode = kodeTercatat(hari);
      // Pengajuan berlaku kalah dari Hadir (Q-34) tetapi menang atas koreksi
      // Sakit/Izin/Dispen dan Alfa, dan hanya di tanggal yang dijadwalkan
      // atau yang punya catatan.
      const ajuan =
        kode === "H" || kode === "T"
          ? null
          : (kodeAjuan.get(`${karyawan.id}|${t}`) ?? null);
      if (ajuan && (kode || dijadwalkanPada(t))) {
        hasil.sel.push(ajuan);
        hasil.wajibMasuk++;
        if (ajuan === "S") hasil.sakit++;
        if (ajuan === "I") hasil.izin++;
        if (ajuan === "C") hasil.cuti++;
        if (ajuan === "DL") hasil.dinas++;
        continue;
      }
      if (kode) {
        hasil.sel.push(kode);
        hasil.wajibMasuk++;
        if (kode === "H" || kode === "T") hasil.hadir++;
        if (kode === "T") {
          hasil.terlambat++;
          hasil.menitTerlambat += Number(hari?.menit) || 0;
        }
        if (kode === "S") hasil.sakit++;
        if (kode === "I") hasil.izin++;
        if (kode === "D") hasil.dispensasi++;
        if (kode === "A") hasil.alfa++;
        continue;
      }

      const tanggalLibur = libur.has(t);
      if (dijadwalkanPada(t)) {
        hasil.sel.push("-");
        hasil.wajibMasuk++;
        hasil.tanpaData++;
      } else {
        // Tanggal libur yang jatuh di hari libur mingguan tetap "L": nama
        // liburnya lebih berguna daripada "bukan hari kerja".
        hasil.sel.push(tanggalLibur ? "L" : "M");
        hasil.libur++;
      }
    }

    if (hasil.wajibMasuk > 0) {
      hasil.persen =
        Math.round(((hasil.hadir + hasil.dinas) / hasil.wajibMasuk) * 1000) /
        10;
    }
    return hasil;
  });

  baris.sort(
    (a, b) =>
      a.karyawan.divisi.localeCompare(b.karyawan.divisi, "id") ||
      a.karyawan.nama.localeCompare(b.karyawan.nama, "id"),
  );
  return { tanggal, baris };
}
