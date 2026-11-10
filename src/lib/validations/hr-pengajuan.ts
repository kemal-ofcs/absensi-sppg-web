/**
 * HRIS fase 2: pengajuan cuti, izin, sakit dan jatah cuti (prd-hris.md §17).
 *
 * Cermin `desktop/hr_pengajuan.rs`: aturan murni, pesan galat, dan SQL WAJIB
 * identik, diuji dengan vektor yang sama (`hr-pengajuan.test.ts` ↔
 * `mod tests`). Status pengajuan dan jatah cuti TIDAK disimpan.
 */

import {
  hariIso,
  parseHariKerja,
  tanggalValid,
  wajibMasuk,
} from "./hari-kerja";
import {
  evaluateHolidayScan,
  type HolidayWhitelistEntry,
} from "./holiday-whitelist";
import jenisBawaan from "./hr-jenis-bawaan.json";
import { namaMaster, tambahBulan } from "./hris";

export interface JenisBawaan {
  id_jenis: string;
  nama: string;
  kelompok: string;
  potong_jatah: boolean;
  dampak_gaji: string;
  boleh_urgent: boolean;
  maks_hari: number | null;
  satuan_maks: string;
  wajib_dokumen: boolean;
}

/** Jenis pengajuan bawaan (§6.3), berkas yang sama dengan seed Rust. */
export const JENIS_BAWAAN = jenisBawaan as readonly JenisBawaan[];

/** Cermin `SEED_JENIS_SQL`. Idempoten: jenis yang sudah disunting tidak ditimpa. */
export const SEED_JENIS_SQL =
  "INSERT OR IGNORE INTO hr_jenis_pengajuan (id_jenis, nama, kelompok, izin_pemutus, boleh_urgent, potong_jatah, dampak_gaji, maks_hari, satuan_maks, wajib_dokumen, is_aktif) VALUES (?1, ?2, ?3, 'hr.request.decide', ?4, ?5, ?6, ?7, ?8, ?9, 1);";

/** Cermin `seed_jenis_args`. */
export function seedJenisArgs(jenis: JenisBawaan) {
  return [
    jenis.id_jenis,
    jenis.nama,
    jenis.kelompok,
    jenis.boleh_urgent ? 1 : 0,
    jenis.potong_jatah ? 1 : 0,
    jenis.dampak_gaji,
    jenis.maks_hari,
    jenis.satuan_maks,
    jenis.wajib_dokumen ? 1 : 0,
  ];
}

// ── Konstanta ──────────────────────────────────────────────────────────────

export const KELOMPOK_AKTIF = [
  "Cuti",
  "Izin",
  "Sakit",
  "Lembur",
  "Tukar Shift",
  "Dinas Luar",
] as const;
/** Cermin `KELOMPOK_TIDAK_HADIR`: menutup hari kerja (§18.3). */
export const KELOMPOK_TIDAK_HADIR = [
  "Cuti",
  "Izin",
  "Sakit",
  "Dinas Luar",
] as const;
/** Cermin `KELOMPOK_TANPA_GAJI`: tanpa dampak gaji dan jatah. */
export const KELOMPOK_TANPA_GAJI = ["Lembur", "Tukar Shift"] as const;
export const DAMPAK_GAJI = [
  "Dibayar",
  "Potong Gaji",
  "Tidak Berpengaruh",
] as const;
export const SATUAN_MAKS = ["Hari Kerja", "Hari Kalender"] as const;
export const IZIN_PEMUTUS_AKTIF = "hr.request.decide";
export const KEPUTUSAN_FINAL = ["Setujui", "Tolak", "Setujui Urgent"] as const;
export const AKSI_KEPUTUSAN = [
  "Setujui",
  "Tolak",
  "Diketahui",
  "Batal",
] as const;
export const MAKS_ALASAN = 500;
export const MAKS_RENTANG_HARI = 366;
export const MAKS_HARI_JENIS = 366;

export type StatusPengajuan =
  | "Menunggu"
  | "Disetujui"
  | "Disetujui (urgent)"
  | "Ditolak"
  | "Dibatalkan";

// ── Potongan SQL kembar (teks identik dengan Rust) ─────────────────────────

/** Cermin `PENGAJUAN_BERLAKU_SQL`: predikat "pengajuan berlaku" atas alias `p`. */
export const PENGAJUAN_BERLAKU_SQL =
  "NOT EXISTS (SELECT 1 FROM hr_pengajuan_keputusan b WHERE b.id_pengajuan = p.id_pengajuan AND b.jenis = 'Batal') AND (SELECT k.jenis FROM hr_pengajuan_keputusan k WHERE k.id_pengajuan = p.id_pengajuan AND k.sidik = p.sidik AND k.jenis IN ('Setujui', 'Tolak', 'Setujui Urgent') ORDER BY k.diterima_cloud IS NULL, k.diterima_cloud, k.waktu_perangkat, k.id_keputusan LIMIT 1) IN ('Setujui', 'Setujui Urgent')";

/** Cermin `PENGAJUAN_RENTANG_SQL`: berlaku dan bertumpuk dengan `?1`..`?2`. */
export const PENGAJUAN_RENTANG_SQL = `SELECT p.id_pengajuan, p.id_karyawan, p.tanggal_mulai, p.tanggal_selesai, p.kelompok, p.dampak_gaji, p.potong_jatah, p.setengah_hari FROM hr_pengajuan p WHERE p.tanggal_mulai <= ?2 AND p.tanggal_selesai >= ?1 AND p.kelompok IN ('Cuti', 'Izin', 'Sakit', 'Dinas Luar') AND ${PENGAJUAN_BERLAKU_SQL} ORDER BY p.id_karyawan, p.tanggal_mulai, p.id_pengajuan;`;

/** Cermin `LAPORAN_PENGAJUAN_SQL`: pengajuan berlaku untuk laporan kehadiran. */
export const LAPORAN_PENGAJUAN_SQL = `SELECT json_object('id', p.id_karyawan, 'mulai', p.tanggal_mulai, 'selesai', p.tanggal_selesai, 'kelompok', p.kelompok) FROM hr_pengajuan p WHERE p.tanggal_mulai <= ?2 AND p.tanggal_selesai >= ?1 AND p.kelompok IN ('Cuti', 'Izin', 'Sakit', 'Dinas Luar') AND ${PENGAJUAN_BERLAKU_SQL} ORDER BY p.id_karyawan, p.tanggal_mulai, p.id_pengajuan;`;

/** Cermin `SPL_RENTANG_SQL`: SPL berlaku, tanggal kerja dalam `?1`..`?2`. */
export const SPL_RENTANG_SQL = `SELECT p.id_karyawan, p.tanggal_mulai, p.jam_mulai, p.jam_selesai FROM hr_pengajuan p WHERE p.kelompok = 'Lembur' AND p.tanggal_mulai >= ?1 AND p.tanggal_mulai <= ?2 AND ${PENGAJUAN_BERLAKU_SQL} ORDER BY p.id_karyawan, p.tanggal_mulai, p.id_pengajuan;`;

/** Cermin `TUKAR_RENTANG_SQL`: shift yang dipakai tiap karyawan di tanggal tukar. */
export const TUKAR_RENTANG_SQL = `SELECT p.id_karyawan, p.tanggal_mulai, p.id_shift_tukar, p.id_pengajuan FROM hr_pengajuan p WHERE p.kelompok = 'Tukar Shift' AND p.tanggal_mulai >= ?1 AND p.tanggal_mulai <= ?2 AND ${PENGAJUAN_BERLAKU_SQL} UNION ALL SELECT p.id_karyawan_tukar, p.tanggal_mulai, p.id_shift_asal, p.id_pengajuan FROM hr_pengajuan p WHERE p.kelompok = 'Tukar Shift' AND p.tanggal_mulai >= ?1 AND p.tanggal_mulai <= ?2 AND ${PENGAJUAN_BERLAKU_SQL} ORDER BY 1, 2, 4;`;

/** Cermin `LAPORAN_TUKAR_SQL`: hari kerja dan kode shift tukar per karyawan. */
export const LAPORAN_TUKAR_SQL = `SELECT json_object('id', t.id, 'tanggal', t.tanggal, 'hari_kerja', s.hari_kerja, 'kode_shift', s.kode_shift) FROM (SELECT p.id_karyawan AS id, p.tanggal_mulai AS tanggal, p.id_shift_tukar AS id_shift, p.id_pengajuan AS urut FROM hr_pengajuan p WHERE p.kelompok = 'Tukar Shift' AND p.tanggal_mulai >= ?1 AND p.tanggal_mulai <= ?2 AND ${PENGAJUAN_BERLAKU_SQL} UNION ALL SELECT p.id_karyawan_tukar, p.tanggal_mulai, p.id_shift_asal, p.id_pengajuan FROM hr_pengajuan p WHERE p.kelompok = 'Tukar Shift' AND p.tanggal_mulai >= ?1 AND p.tanggal_mulai <= ?2 AND ${PENGAJUAN_BERLAKU_SQL}) t JOIN tbl_shift s ON s.id_shift = t.id_shift WHERE t.id IS NOT NULL ORDER BY t.id, t.tanggal, t.urut;`;

/** Cermin `BACKUP_TUKAR_SQL`. */
export const BACKUP_TUKAR_SQL =
  "SELECT id_backup FROM backup_karyawan WHERE status_tugas = 'Aktif' AND tanggal_tugas = ?1 AND (id_karyawan_asal IN (?2, ?3) OR id_karyawan_pengganti IN (?2, ?3)) LIMIT 1;";

const LIBUR_BARIS_SQL =
  "(hl.tanggal IS NOT NULL OR COALESCE(instr(COALESCE(NULLIF(TRIM(sh.hari_kerja), ''), '1,2,3,4,5,6,7'), replace(strftime('%w', ah.tanggal), '0', '7')), 1) = 0)";

/** Cermin `LEMBUR_HARIAN_SQL`: definisi libur sama dengan rekap gaji. */
export const LEMBUR_HARIAN_SQL = `SELECT ah.id_karyawan, ah.tanggal, COALESCE(SUM(CASE WHEN ${LIBUR_BARIS_SQL} THEN 0 ELSE COALESCE(ah.lembur, 0) END), 0), COALESCE(SUM(CASE WHEN ${LIBUR_BARIS_SQL} THEN COALESCE(ah.jam_kerja, 0) + COALESCE(ah.lembur, 0) ELSE 0 END), 0), COALESCE(SUM(CASE WHEN ${LIBUR_BARIS_SQL} THEN COALESCE(ah.jam_kerja, 0) ELSE 0 END), 0) FROM absensi_harian ah LEFT JOIN tbl_hari_libur hl ON hl.tanggal = ah.tanggal AND hl.status_aktif = 1 LEFT JOIN tbl_shift sh ON sh.id_shift = ah.id_shift WHERE ah.tanggal >= ?1 AND ah.tanggal <= ?2 GROUP BY ah.id_karyawan, ah.tanggal;`;

/** Cermin `TANGGAL_HADIR_SQL`: `(id_karyawan, tanggal)` hadir dalam `?1`..`?2`. */
export const TANGGAL_HADIR_SQL =
  "SELECT a.id_karyawan, a.tanggal FROM absensi_harian a WHERE a.tanggal >= ?1 AND a.tanggal <= ?2 AND a.status_kehadiran IN ('Hadir', 'PRESENT') UNION SELECT l.id_karyawan, date(l.waktu_perangkat, '+7 hours') FROM drv_laporan l WHERE l.id_karyawan IS NOT NULL AND l.waktu_perangkat >= datetime(?1, '-7 hours') AND l.waktu_perangkat < datetime(?2, '+17 hours');";

/** Cermin `PERIODE_DIBAYAR_SQL`: proses gaji `PAID` yang menyentuh `?1`..`?2`. */
export const PERIODE_DIBAYAR_SQL =
  "SELECT period_start, period_end FROM payroll_runs WHERE status = 'PAID' AND period_start <= ?2 AND period_end >= ?1 ORDER BY period_start LIMIT 1;";

// ── Pembantu ───────────────────────────────────────────────────────────────

type Hasil<T> = { ok: true; nilai: T } | { ok: false; pesan: string };
const ok = <T>(nilai: T): Hasil<T> => ({ ok: true, nilai });
const gagal = <T = never>(pesan: string): Hasil<T> => ({ ok: false, pesan });
const panjang = (teks: string) => [...teks].length;

type Draft = Record<string, unknown>;

/** Cermin `teks`. */
function teks(draft: Draft, kunci: string): string {
  const nilai = draft[kunci];
  if (typeof nilai === "string") return nilai.trim();
  if (typeof nilai === "number") return String(nilai);
  return "";
}

/** Cermin `bendera`. */
function bendera(draft: Draft, kunci: string): boolean {
  const nilai = draft[kunci];
  return nilai === true || nilai === 1;
}

const HARI_MS = 86_400_000;

function tambahHari(tanggal: string, n: number): string {
  return new Date(Date.parse(`${tanggal}T00:00:00Z`) + n * HARI_MS)
    .toISOString()
    .slice(0, 10);
}

function selisihHari(dari: string, ke: string): number {
  return Math.round(
    (Date.parse(`${ke}T00:00:00Z`) - Date.parse(`${dari}T00:00:00Z`)) / HARI_MS,
  );
}

/** Cermin `tanggal_rentang`: inklusif, paling banyak 400. */
export function tanggalRentang(mulai: string, selesai: string): string[] {
  const hasil: string[] = [];
  let t = mulai;
  while (t <= selesai && hasil.length < 400) {
    hasil.push(t);
    t = tambahHari(t, 1);
  }
  return hasil;
}

// ── Jenis pengajuan ────────────────────────────────────────────────────────

export interface JenisPengajuan {
  id_jenis: string;
  nama: string;
  kelompok: string;
  izin_pemutus: string;
  boleh_urgent: boolean;
  potong_jatah: boolean;
  dampak_gaji: string;
  maks_hari: number | null;
  satuan_maks: string;
  wajib_dokumen: boolean;
  is_aktif: boolean;
}

/** Cermin `validasi_jenis`. `id_jenis` diisi pemanggil. */
export function validasiJenis(draft: Draft): Hasil<JenisPengajuan> {
  const nama = namaMaster(teks(draft, "nama"));
  if (!nama.ok) return nama;
  const kelompok = teks(draft, "kelompok");
  if (!(KELOMPOK_AKTIF as readonly string[]).includes(kelompok)) {
    return gagal(
      "Kelompok harus Cuti, Izin, Sakit, Lembur, Tukar Shift, atau Dinas Luar.",
    );
  }
  const tanpaGaji = (KELOMPOK_TANPA_GAJI as readonly string[]).includes(
    kelompok,
  );
  const dampak = tanpaGaji ? "Tidak Berpengaruh" : teks(draft, "dampak_gaji");
  if (!(DAMPAK_GAJI as readonly string[]).includes(dampak)) {
    return gagal("Dampak gaji tidak dikenal.");
  }
  const satuan = teks(draft, "satuan_maks") || "Hari Kerja";
  if (!(SATUAN_MAKS as readonly string[]).includes(satuan)) {
    return gagal("Satuan batas hari tidak dikenal.");
  }
  const potongJatah = bendera(draft, "potong_jatah");
  if (potongJatah && kelompok !== "Cuti") {
    return gagal("Hanya kelompok Cuti yang bisa memotong jatah cuti.");
  }
  const mentah = draft.maks_hari;
  let maksHari: number | null = null;
  if (
    !tanpaGaji &&
    !(
      mentah === undefined ||
      mentah === null ||
      (typeof mentah === "string" && mentah.trim() === "")
    )
  ) {
    if (
      typeof mentah !== "number" ||
      !Number.isInteger(mentah) ||
      mentah < 1 ||
      mentah > MAKS_HARI_JENIS
    ) {
      return gagal(`Batas hari harus 1 sampai ${MAKS_HARI_JENIS}.`);
    }
    maksHari = mentah;
  }
  return ok({
    id_jenis: "",
    nama: nama.nilai,
    kelompok,
    izin_pemutus: IZIN_PEMUTUS_AKTIF,
    boleh_urgent: bendera(draft, "boleh_urgent"),
    potong_jatah: potongJatah,
    dampak_gaji: dampak,
    maks_hari: maksHari,
    satuan_maks: satuan,
    wajib_dokumen: bendera(draft, "wajib_dokumen"),
    is_aktif: draft.is_aktif === undefined || bendera(draft, "is_aktif"),
  });
}

// ── Isian pengajuan ────────────────────────────────────────────────────────

export interface PengajuanSah {
  id_karyawan: string;
  id_jenis: string;
  tanggal_mulai: string;
  tanggal_selesai: string;
  setengah_hari: boolean;
  alasan: string;
  urgent: boolean;
  /** Lembur: `HH:MM`, kosong untuk kelompok lain. */
  jam_mulai: string;
  jam_selesai: string;
  /** Tukar Shift: karyawan kedua, kosong untuk kelompok lain. */
  id_karyawan_tukar: string;
}

/** Cermin `validasi_pengajuan`: kelengkapan isian, tanpa data jenis. */
export function validasiPengajuan(draft: Draft): Hasil<PengajuanSah> {
  const idKaryawan = teks(draft, "id_karyawan");
  if (idKaryawan === "") return gagal("Pilih karyawan.");
  const idJenis = teks(draft, "id_jenis");
  if (idJenis === "") return gagal("Pilih jenis pengajuan.");
  const mulai = teks(draft, "tanggal_mulai");
  const selesai = teks(draft, "tanggal_selesai");
  if (!tanggalValid(mulai) || !tanggalValid(selesai)) {
    return gagal("Tanggal pengajuan tidak valid.");
  }
  if (selesai < mulai) {
    return gagal("Tanggal selesai tidak boleh sebelum tanggal mulai.");
  }
  if (selisihHari(mulai, selesai) >= MAKS_RENTANG_HARI) {
    return gagal(`Rentang pengajuan paling panjang ${MAKS_RENTANG_HARI} hari.`);
  }
  const setengah = bendera(draft, "setengah_hari");
  if (setengah && mulai !== selesai) {
    return gagal("Setengah hari hanya untuk satu tanggal.");
  }
  const alasan = teks(draft, "alasan");
  if (alasan === "") return gagal("Alasan wajib diisi.");
  if (panjang(alasan) > MAKS_ALASAN) {
    return gagal(`Alasan maksimal ${MAKS_ALASAN} karakter.`);
  }
  return ok({
    id_karyawan: idKaryawan,
    id_jenis: idJenis,
    tanggal_mulai: mulai,
    tanggal_selesai: selesai,
    setengah_hari: setengah,
    alasan,
    urgent: bendera(draft, "urgent"),
    jam_mulai: teks(draft, "jam_mulai"),
    jam_selesai: teks(draft, "jam_selesai"),
    id_karyawan_tukar: teks(draft, "id_karyawan_tukar"),
  });
}

/** Cermin `periksa_jenis`. */
export function periksaJenis(
  p: PengajuanSah,
  jenis: JenisPengajuan,
): Hasil<null> {
  if (!jenis.is_aktif) return gagal("Jenis pengajuan ini sudah nonaktif.");
  if (!(KELOMPOK_AKTIF as readonly string[]).includes(jenis.kelompok)) {
    return gagal("Jenis pengajuan ini belum bisa diajukan.");
  }
  if (p.setengah_hari && jenis.kelompok !== "Izin") {
    return gagal("Setengah hari hanya untuk kelompok Izin.");
  }
  if (p.urgent && !jenis.boleh_urgent) {
    return gagal("Jenis pengajuan ini tidak boleh urgent.");
  }
  const satuTanggal = p.tanggal_mulai === p.tanggal_selesai;
  if (jenis.kelompok === "Lembur") {
    if (!satuTanggal) return gagal("Lembur diajukan per tanggal kerja.");
    const durasi = durasiLembur(p.jam_mulai, p.jam_selesai);
    if (!durasi.ok) return durasi;
  } else if (jenis.kelompok === "Tukar Shift") {
    if (!satuTanggal) return gagal("Tukar shift diajukan per tanggal.");
    if (p.id_karyawan_tukar === "") {
      return gagal("Pilih karyawan yang diajak bertukar.");
    }
    if (p.id_karyawan_tukar === p.id_karyawan) {
      return gagal("Tukar shift harus dengan karyawan lain.");
    }
  }
  return ok(null);
}

/** Cermin `menit_jam`: menit dalam hari dari `HH:MM`. */
export function menitJam(jam: string): number | null {
  const m = /^(\d{2}):(\d{2})$/.exec(jam);
  if (!m) return null;
  const h = Number(m[1]);
  const menit = Number(m[2]);
  return h < 24 && menit < 60 ? h * 60 + menit : null;
}

/** Cermin `durasi_lembur`: menit SPL. Selesai ≤ mulai = lewat tengah malam. */
export function durasiLembur(
  jamMulai: string,
  jamSelesai: string,
): Hasil<number> {
  const a = menitJam(jamMulai);
  const b = menitJam(jamSelesai);
  if (a === null || b === null) {
    return gagal("Jam lembur harus berformat JJ:MM.");
  }
  if (a === b) return gagal("Jam mulai dan selesai lembur tidak boleh sama.");
  return ok(b > a ? b - a : b + 1440 - a);
}

/** Cermin `Ringkas`. */
export interface Ringkas {
  kelompok: string;
  id_karyawan: string;
  id_karyawan_tukar: string | null;
  tanggal_mulai: string;
  tanggal_selesai: string;
  setengah_hari: boolean;
  jam_mulai: string | null;
  jam_selesai: string | null;
}

const orangRingkas = (r: Ringkas) =>
  r.id_karyawan_tukar === null
    ? [r.id_karyawan]
    : [r.id_karyawan, r.id_karyawan_tukar];

function rentangJam(r: Ringkas): [number, number] | null {
  if (r.jam_mulai === null || r.jam_selesai === null) return null;
  const mulai = menitJam(r.jam_mulai);
  const durasi = durasiLembur(r.jam_mulai, r.jam_selesai);
  return mulai === null || !durasi.ok ? null : [mulai, mulai + durasi.nilai];
}

const tidakHadir = (kelompok: string) =>
  (KELOMPOK_TIDAK_HADIR as readonly string[]).includes(kelompok);

/** Cermin `bentrok_pengajuan`: matriks §18.3. */
export function bentrokPengajuan(a: Ringkas, b: Ringkas): boolean {
  const orangB = orangRingkas(b);
  const orangSama = orangRingkas(a).some((x) => orangB.includes(x));
  if (
    !orangSama ||
    a.tanggal_mulai > b.tanggal_selesai ||
    b.tanggal_mulai > a.tanggal_selesai
  ) {
    return false;
  }
  const lemburA = a.kelompok === "Lembur";
  const lemburB = b.kelompok === "Lembur";
  if (lemburA && lemburB) {
    if (a.id_karyawan !== b.id_karyawan) return false;
    const ra = rentangJam(a);
    const rb = rentangJam(b);
    return ra === null || rb === null ? true : ra[0] < rb[1] && rb[0] < ra[1];
  }
  if (
    (lemburA && b.kelompok === "Tukar Shift") ||
    (lemburB && a.kelompok === "Tukar Shift")
  ) {
    return false;
  }
  if (lemburA) return !(b.kelompok === "Izin" && b.setengah_hari);
  if (lemburB) return !(a.kelompok === "Izin" && a.setengah_hari);
  return (
    tidakHadir(a.kelompok) ||
    tidakHadir(b.kelompok) ||
    (a.kelompok === "Tukar Shift" && b.kelompok === "Tukar Shift")
  );
}

/** Cermin `senin_dari`. */
export function seninDari(tanggal: string): string | null {
  const hari = hariIso(tanggal);
  return hari === null ? null : tambahHari(tanggal, 1 - hari);
}

/** Cermin `lembur_lewat_batas`; batas dalam menit. */
export function lemburLewatBatas(
  spl: readonly (readonly [string, number])[],
  maksHarian: number,
  maksMingguan: number,
): Set<string> {
  const hari = new Map<string, number>();
  const minggu = new Map<string, number>();
  for (const [t, m] of spl) {
    hari.set(t, (hari.get(t) ?? 0) + m);
    const s = seninDari(t) ?? "";
    minggu.set(s, (minggu.get(s) ?? 0) + m);
  }
  return new Set(
    spl
      .filter(
        ([t]) =>
          (hari.get(t) ?? 0) > maksHarian ||
          (minggu.get(seninDari(t) ?? "") ?? 0) > maksMingguan,
      )
      .map(([t]) => t),
  );
}

/** Cermin `HariLembur` (menit). */
export interface HariLembur {
  lembur: number;
  libur_total: number;
  libur_jam_kerja: number;
  spl: number;
}

/** Cermin `PotongLembur` (menit). */
export interface PotongLembur {
  lembur: number;
  libur_total: number;
  libur_jam_kerja: number;
  tanpa_spl: number;
}

/** Cermin `potong_lembur_spl`: dibayar `min(SPL, jam)` per tanggal (Q-56). */
export function potongLemburSpl(hari: readonly HariLembur[]): PotongLembur {
  const hasil: PotongLembur = {
    lembur: 0,
    libur_total: 0,
    libur_jam_kerja: 0,
    tanpa_spl: 0,
  };
  for (const h of hari) {
    hasil.lembur += Math.max(0, h.lembur - h.spl);
    const lebihLibur = Math.max(0, h.libur_total - h.spl);
    const dariLembur = Math.min(
      lebihLibur,
      Math.max(0, h.libur_total - h.libur_jam_kerja),
    );
    hasil.libur_total += lebihLibur;
    hasil.libur_jam_kerja += lebihLibur - dariLembur;
    if (h.spl === 0) hasil.tanpa_spl += h.lembur + h.libur_total;
  }
  return hasil;
}

/** Cermin `periksa_maks`. */
export function periksaMaks(
  jenis: JenisPengajuan,
  hariKerja: number,
  hariKalender: number,
): Hasil<null> {
  if (jenis.maks_hari === null) return ok(null);
  const kalender = jenis.satuan_maks === "Hari Kalender";
  const jumlah = kalender ? hariKalender : hariKerja;
  if (jumlah > jenis.maks_hari) {
    const satuan = kalender ? "hari kalender" : "hari kerja";
    return gagal(`${jenis.nama} paling lama ${jenis.maks_hari} ${satuan}.`);
  }
  return ok(null);
}

/** Isi yang ikut sidik (`IsiPengajuan`). */
export interface IsiPengajuan {
  id_karyawan: string;
  id_jenis: string;
  kelompok: string;
  potong_jatah: boolean;
  dampak_gaji: string;
  tanggal_mulai: string;
  tanggal_selesai: string;
  setengah_hari: boolean;
  alasan: string;
  jam_mulai?: string | null;
  jam_selesai?: string | null;
  id_karyawan_tukar?: string | null;
  id_shift_asal?: number | null;
  id_shift_tukar?: number | null;
}

/**
 * Teks kanonik sidik; SHA-256-nya dihitung `sidikPengajuan` di service.
 * Sembilan bagian fase 2 tetap; Lembur dan Tukar Shift menambah isiannya.
 */
export function kanonikPengajuan(isi: IsiPengajuan): string {
  const bagian = [
    isi.id_karyawan,
    isi.id_jenis,
    isi.kelompok,
    isi.potong_jatah ? "1" : "0",
    isi.dampak_gaji,
    isi.tanggal_mulai,
    isi.tanggal_selesai,
    isi.setengah_hari ? "1" : "0",
    isi.alasan,
  ];
  if (isi.kelompok === "Lembur") {
    bagian.push(isi.jam_mulai ?? "", isi.jam_selesai ?? "");
  } else if (isi.kelompok === "Tukar Shift") {
    bagian.push(
      isi.id_karyawan_tukar ?? "",
      isi.id_shift_asal == null ? "" : String(isi.id_shift_asal),
      isi.id_shift_tukar == null ? "" : String(isi.id_shift_tukar),
    );
  }
  return bagian.join("\u001f");
}

// ── Status dan tanda ───────────────────────────────────────────────────────

export interface Keputusan {
  id_keputusan: string;
  jenis: string;
  sidik: string;
  oleh: string;
  waktu_perangkat: string;
  diterima_cloud: string | null;
}

const bandingTeks = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Cermin `urut_keputusan`, sama dengan ORDER BY `PENGAJUAN_BERLAKU_SQL`. */
export function urutKeputusan(a: Keputusan, b: Keputusan): number {
  const tundaA = a.diterima_cloud === null ? 1 : 0;
  const tundaB = b.diterima_cloud === null ? 1 : 0;
  return (
    tundaA - tundaB ||
    bandingTeks(a.diterima_cloud ?? "", b.diterima_cloud ?? "") ||
    bandingTeks(a.waktu_perangkat, b.waktu_perangkat) ||
    bandingTeks(a.id_keputusan, b.id_keputusan)
  );
}

const isFinal = (k: Keputusan) =>
  (KEPUTUSAN_FINAL as readonly string[]).includes(k.jenis);

/** Cermin `keputusan_berlaku`. */
export function keputusanBerlaku(
  sidik: string,
  keputusan: readonly Keputusan[],
): Keputusan | null {
  const sah = keputusan
    .filter((k) => isFinal(k) && k.sidik === sidik)
    .sort(urutKeputusan);
  return sah[0] ?? null;
}

/** Cermin `status_pengajuan`. */
export function statusPengajuan(
  sidik: string,
  keputusan: readonly Keputusan[],
): StatusPengajuan {
  if (keputusan.some((k) => k.jenis === "Batal")) return "Dibatalkan";
  switch (keputusanBerlaku(sidik, keputusan)?.jenis) {
    case "Tolak":
      return "Ditolak";
    case "Setujui":
      return "Disetujui";
    case "Setujui Urgent":
      return "Disetujui (urgent)";
    default:
      return "Menunggu";
  }
}

export function statusBerlaku(status: string): boolean {
  return status === "Disetujui" || status === "Disetujui (urgent)";
}

const samaOrang = (a: string, b: string) =>
  a.trim().toLowerCase() === b.trim().toLowerCase();

/** Cermin `tanda_keputusan`. */
export function tandaKeputusan(
  sidik: string,
  diajukanOleh: string,
  keputusan: readonly Keputusan[],
): string[] {
  const status = statusPengajuan(sidik, keputusan);
  const tanda: string[] = [];
  if (
    status === "Disetujui (urgent)" &&
    !keputusan.some((k) => k.jenis === "Diketahui")
  ) {
    tanda.push("perlu_diketahui");
  }
  const finals = keputusan.filter(isFinal);
  const sah = finals.filter((k) => k.sidik === sidik);
  if (
    sah.some((k) => k.jenis === "Tolak") &&
    sah.some((k) => k.jenis !== "Tolak")
  ) {
    tanda.push("keputusan_ganda");
  }
  if (status !== "Dibatalkan" && finals.length > 0 && sah.length === 0) {
    tanda.push("keputusan_gugur");
  }
  if (status !== "Dibatalkan") {
    const berlaku = keputusanBerlaku(sidik, keputusan);
    // Urgent memang diputus pengajunya; Q-28 hanya untuk Setujui/Tolak.
    if (
      berlaku &&
      berlaku.jenis !== "Setujui Urgent" &&
      samaOrang(berlaku.oleh, diajukanOleh)
    ) {
      tanda.push("diputus_sendiri");
    }
  }
  return tanda;
}

export const LABEL_TANDA_PENGAJUAN: Record<string, string> = {
  perlu_diketahui: "Urgent, belum diketahui HRD",
  keputusan_ganda: "Diputus berbeda oleh dua pemutus",
  keputusan_gugur: "Isinya diubah setelah diputus",
  diputus_sendiri: "Diajukan dan diputus orang yang sama",
  bertumpuk: "Bertumpuk dengan pengajuan lain",
  tanpa_dokumen: "Dokumen pendukung belum dilampirkan",
  hadir_saat_cuti: "Hadir di tanggal pengajuan",
  jatah_minus: "Jatah cuti minus",
  lembur_lewat_batas: "Lembur melewati batas harian atau mingguan",
};

// ── Aturan aksi (§17.4) ────────────────────────────────────────────────────

export interface KeadaanAksi {
  status: string;
  sudah_diketahui: boolean;
  pengaju_sendiri: boolean;
  superadmin: boolean;
  karyawan_sendiri: boolean;
  boleh_putus: boolean;
}

const PESAN_IZIN_PUTUS = "Kamu tidak punya izin memutus jenis pengajuan ini.";
const PESAN_DIRI_SENDIRI =
  "Pengajuan untuk dirimu sendiri harus diputus orang lain.";

/** Cermin `periksa_aksi`. */
export function periksaAksi(
  aksi: string,
  alasan: string,
  k: KeadaanAksi,
): Hasil<null> {
  if (!(AKSI_KEPUTUSAN as readonly string[]).includes(aksi)) {
    return gagal("Keputusan tidak dikenal.");
  }
  if (panjang(alasan.trim()) > MAKS_ALASAN) {
    return gagal(`Alasan maksimal ${MAKS_ALASAN} karakter.`);
  }
  const tanpaAlasan = alasan.trim() === "";
  if (aksi === "Setujui" || aksi === "Tolak") {
    if (k.status !== "Menunggu") {
      return gagal("Pengajuan ini tidak lagi menunggu keputusan.");
    }
    if (!k.boleh_putus) return gagal(PESAN_IZIN_PUTUS);
    if (k.karyawan_sendiri) return gagal(PESAN_DIRI_SENDIRI);
    if (aksi === "Tolak" && tanpaAlasan) {
      return gagal("Alasan penolakan wajib diisi.");
    }
  } else if (aksi === "Diketahui") {
    if (k.status !== "Disetujui (urgent)" || k.sudah_diketahui) {
      return gagal(
        "Hanya pengajuan urgent yang belum diketahui yang bisa ditandai.",
      );
    }
    if (!k.boleh_putus) return gagal(PESAN_IZIN_PUTUS);
    if (k.karyawan_sendiri) return gagal(PESAN_DIRI_SENDIRI);
  } else {
    if (tanpaAlasan) return gagal("Alasan pembatalan wajib diisi.");
    if (k.status === "Menunggu") {
      if (!k.pengaju_sendiri && !k.superadmin) {
        return gagal(
          "Hanya pengaju yang bisa membatalkan pengajuan yang masih menunggu.",
        );
      }
    } else if (statusBerlaku(k.status)) {
      if (!k.boleh_putus) return gagal(PESAN_IZIN_PUTUS);
      if (k.karyawan_sendiri) return gagal(PESAN_DIRI_SENDIRI);
    } else {
      return gagal(
        "Pengajuan yang ditolak atau dibatalkan tidak bisa dibatalkan lagi.",
      );
    }
  }
  return ok(null);
}

/** Cermin `periksa_sunting`. */
export function periksaSunting(
  status: string,
  pengajuSendiri: boolean,
  superadmin: boolean,
): Hasil<null> {
  if (status !== "Menunggu") {
    return gagal("Pengajuan yang sudah diputus tidak bisa disunting.");
  }
  if (!pengajuSendiri && !superadmin) {
    return gagal("Hanya pengaju yang bisa menyunting pengajuan ini.");
  }
  return ok(null);
}

/** Cermin `periksa_urgent`. */
export function periksaUrgent(karyawanSendiri: boolean): Hasil<null> {
  return karyawanSendiri
    ? gagal(
        "Pengajuan urgent untuk dirimu sendiri tidak bisa disetujui sendiri.",
      )
    : ok(null);
}

/** Cermin `pesan_periode_dibayar`. */
export function pesanPeriodeDibayar(mulai: string, selesai: string): string {
  return `Gaji periode ${mulai} s.d. ${selesai} sudah dibayar; pengajuan di tanggal itu tidak bisa diubah.`;
}

/** Cermin `pesan_bertumpuk`. */
export function pesanBertumpuk(mulai: string, selesai: string): string {
  return `Tanggal itu bertumpuk dengan pengajuan lain karyawan ini (${mulai} s.d. ${selesai}).`;
}

/** Cermin `kode_kelompok`: kode laporan kehadiran (§17.5). */
export function kodeKelompok(kelompok: string): string | null {
  if (kelompok === "Dinas Luar") return "DL";
  if (kelompok === "Cuti") return "C";
  if (kelompok === "Izin") return "I";
  if (kelompok === "Sakit") return "S";
  return null;
}

// ── Hari wajib (§17.5) ─────────────────────────────────────────────────────

export interface Jadwal {
  hari_masuk: number[];
  divisi: string;
  kode_shift: number | null;
  jam_normal_menit: number;
}

export interface Kalender {
  libur: Set<string>;
  whitelist: HolidayWhitelistEntry[];
}

/** Baris mentah jadwal dari kueri `muatJadwal`. */
export function jadwalDariBaris(baris: {
  divisi: unknown;
  hari_kerja: unknown;
  kode_shift: unknown;
  jam_kerja_normal_menit: unknown;
}): Jadwal {
  const kode = baris.kode_shift;
  return {
    divisi: String(baris.divisi ?? ""),
    hari_masuk: parseHariKerja(
      typeof baris.hari_kerja === "string" ? baris.hari_kerja : null,
    ),
    kode_shift:
      kode === null || kode === undefined || kode === "" ? null : Number(kode),
    jam_normal_menit: Number(baris.jam_kerja_normal_menit ?? 0),
  };
}

/** Cermin `tanggal_wajib`. */
export function tanggalWajib(
  jadwal: Jadwal,
  kalender: Kalender,
  mulai: string,
  selesai: string,
): string[] {
  return tanggalRentang(mulai, selesai).filter((t) => {
    const libur = kalender.libur.has(t);
    const masukSaatLibur =
      libur &&
      evaluateHolidayScan(kalender.whitelist, {
        tanggal: t,
        divisi: jadwal.divisi,
        kodeShift: jadwal.kode_shift,
      }).allowed;
    return wajibMasuk({
      tanggal: t,
      hariMasuk: jadwal.hari_masuk,
      libur,
      masukSaatLibur,
    });
  });
}

// ── Dampak gaji (§17.6) ────────────────────────────────────────────────────

/** Cermin `hitung_cuti_dibayar`: `[hari, menit]`. */
export function hitungCutiDibayar(
  tanggal: readonly (readonly [string, boolean])[],
  hadir: ReadonlySet<string>,
  jamNormalMenit: number,
): [number, number] {
  const perTanggal = new Map<string, boolean>();
  for (const [t, setengah] of tanggal) {
    const lama = perTanggal.get(t);
    perTanggal.set(t, lama === undefined ? setengah : lama && setengah);
  }
  const normal = Math.max(0, jamNormalMenit);
  let hari = 0;
  let menit = 0;
  for (const [t, setengah] of perTanggal) {
    const sudahHadir = hadir.has(t);
    if (setengah) {
      menit += Math.floor(normal / 2);
      if (!sudahHadir) hari += 1;
    } else if (!sudahHadir) {
      hari += 1;
      menit += normal;
    }
  }
  return [hari, menit];
}

/** Cermin `upah_harian`. */
export function upahHarian(
  salaryType: string,
  dailyRate: number,
  ratePerHour: number,
  jamNormalMenit: number,
): number {
  if (salaryType === "FLAT_DAILY") return Math.max(0, dailyRate);
  return Math.floor(
    (Math.max(0, ratePerHour) * Math.max(0, jamNormalMenit) + 30) / 60,
  );
}

// ── Jatah cuti (§17.7) ─────────────────────────────────────────────────────

export const KUNCI_CUTI_PERIODE = "hr_cuti_periode";
export const KUNCI_CUTI_HAK = "hr_cuti_hak";
export const KUNCI_CUTI_SYARAT_BULAN = "hr_cuti_syarat_bulan";
export const KUNCI_CUTI_PRORATA = "hr_cuti_prorata";
export const KUNCI_CUTI_SISA = "hr_cuti_sisa";
export const KUNCI_CUTI_BAWA_MAKS = "hr_cuti_bawa_maks";
export const KUNCI_CUTI_BAWA_BULAN = "hr_cuti_bawa_bulan";
export const PERIODE_CUTI = ["kalender", "ulang_tahun_kerja"] as const;
export const SISA_CUTI = ["hangus", "dibawa", "diuangkan"] as const;

/** Cermin `BATAS_CUTI`: [kunci, label, min, maks]. */
export const BATAS_CUTI = [
  [KUNCI_CUTI_HAK, "Hak cuti tahunan", 0, 60],
  [KUNCI_CUTI_SYARAT_BULAN, "Masa kerja minimum", 0, 24],
  [KUNCI_CUTI_PRORATA, "Prorata", 0, 1],
  [KUNCI_CUTI_BAWA_MAKS, "Sisa maksimal dibawa", 0, 60],
  [KUNCI_CUTI_BAWA_BULAN, "Batas pakai sisa dibawa", 1, 12],
] as const;

export interface AturanCuti {
  periode: string;
  hak: number;
  syarat_bulan: number;
  prorata: boolean;
  sisa: string;
  bawa_maks: number;
  bawa_bulan: number;
}

export const ATURAN_CUTI_BAWAAN: AturanCuti = {
  periode: "ulang_tahun_kerja",
  hak: 12,
  syarat_bulan: 12,
  prorata: false,
  sisa: "hangus",
  bawa_maks: 6,
  bawa_bulan: 3,
};

/** Cermin `AturanCuti::dari_peta`. Kosong atau di luar batas = bawaan. */
export function aturanCutiDariPeta(
  peta: ReadonlyMap<string, string> | Record<string, string>,
): AturanCuti {
  const baca = (kunci: string) =>
    peta instanceof Map
      ? peta.get(kunci)
      : (peta as Record<string, string>)[kunci];
  const angka = (kunci: string, bawaan: number) => {
    const batas = BATAS_CUTI.find(([k]) => k === kunci);
    const teksNilai = baca(kunci)?.trim() ?? "";
    if (!/^-?\d+$/.test(teksNilai)) return bawaan;
    const n = Number(teksNilai);
    return batas && (n < batas[2] || n > batas[3]) ? bawaan : n;
  };
  const pilih = (kunci: string, daftar: readonly string[], bawaan: string) => {
    const nilai = baca(kunci)?.trim() ?? "";
    return daftar.includes(nilai) ? nilai : bawaan;
  };
  const b = ATURAN_CUTI_BAWAAN;
  return {
    periode: pilih(KUNCI_CUTI_PERIODE, PERIODE_CUTI, b.periode),
    hak: angka(KUNCI_CUTI_HAK, b.hak),
    syarat_bulan: angka(KUNCI_CUTI_SYARAT_BULAN, b.syarat_bulan),
    prorata: angka(KUNCI_CUTI_PRORATA, b.prorata ? 1 : 0) === 1,
    sisa: pilih(KUNCI_CUTI_SISA, SISA_CUTI, b.sisa),
    bawa_maks: angka(KUNCI_CUTI_BAWA_MAKS, b.bawa_maks),
    bawa_bulan: angka(KUNCI_CUTI_BAWA_BULAN, b.bawa_bulan),
  };
}

/** Cermin `validasi_aturan_cuti`. */
export function validasiAturanCuti(
  draft: Draft,
): Hasil<Array<[string, string]>> {
  const periode = teks(draft, KUNCI_CUTI_PERIODE);
  if (!(PERIODE_CUTI as readonly string[]).includes(periode)) {
    return gagal("Periode cuti harus kalender atau ulang tahun kerja.");
  }
  const sisa = teks(draft, KUNCI_CUTI_SISA);
  if (!(SISA_CUTI as readonly string[]).includes(sisa)) {
    return gagal("Sisa cuti harus hangus, dibawa, atau diuangkan.");
  }
  const hasil: Array<[string, string]> = [
    [KUNCI_CUTI_PERIODE, periode],
    [KUNCI_CUTI_SISA, sisa],
  ];
  for (const [kunci, label, min, maks] of BATAS_CUTI) {
    const nilai = draft[kunci];
    if (
      typeof nilai !== "number" ||
      !Number.isInteger(nilai) ||
      nilai < min ||
      nilai > maks
    ) {
      return gagal(`${label} harus ${min} sampai ${maks}.`);
    }
    hasil.push([kunci, String(nilai)]);
  }
  return ok(hasil);
}

export const KUNCI_LEMBUR_MODE = "hr_lembur_mode";
export const KUNCI_LEMBUR_MAKS_HARIAN = "hr_lembur_maks_harian";
export const KUNCI_LEMBUR_MAKS_MINGGUAN = "hr_lembur_maks_mingguan";
export const MODE_LEMBUR = ["otomatis", "spl"] as const;

/** Cermin `BATAS_LEMBUR` (jam): [kunci, label, min, maks, bawaan]. */
export const BATAS_LEMBUR = [
  [KUNCI_LEMBUR_MAKS_HARIAN, "Batas lembur harian", 1, 12, 4],
  [KUNCI_LEMBUR_MAKS_MINGGUAN, "Batas lembur mingguan", 1, 72, 18],
] as const;

export interface AturanLembur {
  mode: string;
  maks_harian: number;
  maks_mingguan: number;
}

/** Cermin `AturanLembur::dari_peta`. Kosong atau di luar batas = bawaan. */
export function aturanLemburDariPeta(
  peta: ReadonlyMap<string, string> | Record<string, string>,
): AturanLembur {
  const baca = (kunci: string) =>
    (peta instanceof Map
      ? peta.get(kunci)
      : (peta as Record<string, string>)[kunci]
    )?.trim() ?? "";
  const angka = (i: 0 | 1) => {
    const [kunci, , min, maks, bawaan] = BATAS_LEMBUR[i];
    const nilai = baca(kunci);
    if (!/^-?\d+$/.test(nilai)) return bawaan;
    const n = Number(nilai);
    return n < min || n > maks ? bawaan : n;
  };
  const mode = baca(KUNCI_LEMBUR_MODE);
  return {
    mode: (MODE_LEMBUR as readonly string[]).includes(mode) ? mode : "otomatis",
    maks_harian: angka(0),
    maks_mingguan: angka(1),
  };
}

/** Cermin `validasi_aturan_lembur`. */
export function validasiAturanLembur(
  draft: Draft,
): Hasil<Array<[string, string]>> {
  const mode = teks(draft, KUNCI_LEMBUR_MODE);
  if (!(MODE_LEMBUR as readonly string[]).includes(mode)) {
    return gagal("Mode lembur harus otomatis atau SPL.");
  }
  const hasil: Array<[string, string]> = [[KUNCI_LEMBUR_MODE, mode]];
  for (const [kunci, label, min, maks] of BATAS_LEMBUR) {
    const nilai = draft[kunci];
    if (
      typeof nilai !== "number" ||
      !Number.isInteger(nilai) ||
      nilai < min ||
      nilai > maks
    ) {
      return gagal(`${label} harus ${min} sampai ${maks} jam.`);
    }
    hasil.push([kunci, String(nilai)]);
  }
  return ok(hasil);
}

export interface PeriodeCuti {
  mulai: string;
  selesai: string;
  sebelum_berhak: boolean;
  hak: number;
  bawaan: number;
  bawaan_hangus: number;
  bawaan_sampai: string | null;
  penyesuaian: number;
  terpakai: number;
  sisa: number;
}

/** Cermin `periode_cuti`. */
export function periodeCuti(
  tanggalMasuk: string | null,
  aturan: AturanCuti,
  terpakai: readonly string[],
  penyesuaian: readonly (readonly [string, number])[],
  hariIni: string,
): PeriodeCuti[] {
  if (!tanggalMasuk || !tanggalValid(tanggalMasuk)) return [];
  const masuk = tanggalMasuk;
  const berhak = tambahBulan(masuk, aturan.syarat_bulan);
  if (!berhak) return [];
  let akhir = hariIni;
  for (const t of terpakai) if (t > akhir) akhir = t;
  for (const [p] of penyesuaian) if (p > akhir) akhir = p;

  const batas: Array<[string, string, number, boolean]> = [];
  const pemakaianAwal = terpakai.some((t) => t < berhak);
  if (masuk < berhak || pemakaianAwal) {
    const sebelumMasuk = terpakai.filter((t) => t < masuk).sort();
    const mulai = sebelumMasuk[0] ?? masuk;
    const selesai = tambahHari(berhak, -1);
    if (mulai <= selesai) batas.push([mulai, selesai, 0, true]);
  }
  if (aturan.periode === "kalender") {
    const tahun = Number(berhak.slice(0, 4));
    const bulan = Number(berhak.slice(5, 7));
    const hari = Number(berhak.slice(8, 10));
    const tersisa = hari === 1 ? 13 - bulan : 12 - bulan;
    const hakPertama = aturan.prorata
      ? Math.floor((aturan.hak * tersisa) / 12)
      : aturan.hak;
    batas.push([
      berhak,
      `${String(tahun).padStart(4, "0")}-12-31`,
      hakPertama,
      false,
    ]);
    let y = tahun + 1;
    while (
      `${String(y).padStart(4, "0")}-01-01` <= akhir &&
      batas.length < 200
    ) {
      const ty = String(y).padStart(4, "0");
      batas.push([`${ty}-01-01`, `${ty}-12-31`, aturan.hak, false]);
      y += 1;
    }
  } else {
    for (let k = 0; batas.length < 200; k++) {
      const mulai = tambahBulan(berhak, 12 * k);
      const berikut = tambahBulan(berhak, 12 * (k + 1));
      if (!mulai || !berikut || mulai > akhir) break;
      batas.push([mulai, tambahHari(berikut, -1), aturan.hak, false]);
    }
  }

  const hasil: PeriodeCuti[] = [];
  for (const [mulai, selesai, hak, sebelumBerhak] of batas) {
    const pakai = terpakai.filter((t) => t >= mulai && t <= selesai).length;
    const adj = penyesuaian
      .filter(([p]) => p === mulai)
      .reduce((n, [, h]) => n + h, 0);
    const sebelumnya = hasil.at(-1);
    const bawaan =
      sebelumnya && !sebelumnya.sebelum_berhak && aturan.sisa === "dibawa"
        ? Math.min(Math.max(sebelumnya.sisa, 0), aturan.bawa_maks)
        : 0;
    let hangus = 0;
    let sampai: string | null = null;
    if (bawaan > 0) {
      const batasBawa = tambahBulan(mulai, aturan.bawa_bulan);
      if (batasBawa) {
        const awal = terpakai.filter((t) => t >= mulai && t < batasBawa).length;
        if (hariIni >= batasBawa) hangus = bawaan - Math.min(bawaan, awal);
        sampai = tambahHari(batasBawa, -1);
      }
    }
    hasil.push({
      mulai,
      selesai,
      sebelum_berhak: sebelumBerhak,
      hak,
      bawaan,
      bawaan_hangus: hangus,
      bawaan_sampai: sampai,
      penyesuaian: adj,
      terpakai: pakai,
      sisa: hak + adj + bawaan - hangus - pakai,
    });
  }
  return hasil.filter(
    (p) => !p.sebelum_berhak || p.terpakai !== 0 || p.penyesuaian !== 0,
  );
}

// ── SQL tulis dan penyesuaian (kembar `desktop/hr_pengajuan.rs`) ───────────

export const UPSERT_JENIS_SQL =
  "INSERT INTO hr_jenis_pengajuan (id_jenis, nama, kelompok, izin_pemutus, boleh_urgent, potong_jatah, dampak_gaji, maks_hari, satuan_maks, wajib_dokumen, is_aktif, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, COALESCE(?12, datetime('now')), datetime('now')) ON CONFLICT(id_jenis) DO UPDATE SET nama = excluded.nama, kelompok = excluded.kelompok, izin_pemutus = excluded.izin_pemutus, boleh_urgent = excluded.boleh_urgent, potong_jatah = excluded.potong_jatah, dampak_gaji = excluded.dampak_gaji, maks_hari = excluded.maks_hari, satuan_maks = excluded.satuan_maks, wajib_dokumen = excluded.wajib_dokumen, is_aktif = excluded.is_aktif, updated_at = datetime('now');";

export const UPSERT_PENGAJUAN_SQL =
  "INSERT INTO hr_pengajuan (id_pengajuan, id_karyawan, id_jenis, kelompok, potong_jatah, dampak_gaji, tanggal_mulai, tanggal_selesai, setengah_hari, alasan, sidik, diajukan_oleh, waktu_perangkat, created_at, updated_at, jam_mulai, jam_selesai, id_karyawan_tukar, id_shift_asal, id_shift_tukar) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, COALESCE(?14, datetime('now')), datetime('now'), ?15, ?16, ?17, ?18, ?19) ON CONFLICT(id_pengajuan) DO UPDATE SET id_karyawan = excluded.id_karyawan, id_jenis = excluded.id_jenis, kelompok = excluded.kelompok, potong_jatah = excluded.potong_jatah, dampak_gaji = excluded.dampak_gaji, tanggal_mulai = excluded.tanggal_mulai, tanggal_selesai = excluded.tanggal_selesai, setengah_hari = excluded.setengah_hari, alasan = excluded.alasan, sidik = excluded.sidik, waktu_perangkat = excluded.waktu_perangkat, updated_at = datetime('now'), jam_mulai = excluded.jam_mulai, jam_selesai = excluded.jam_selesai, id_karyawan_tukar = excluded.id_karyawan_tukar, id_shift_asal = excluded.id_shift_asal, id_shift_tukar = excluded.id_shift_tukar;";

export const PESAN_TUKAR_NONAKTIF =
  "Karyawan yang diajak bertukar tidak ditemukan atau nonaktif.";
export const PESAN_TUKAR_SHIFT_SAMA =
  "Kedua karyawan memakai shift yang sama; tidak ada yang ditukar.";
export const PESAN_TUKAR_SHIFT_HILANG =
  "Shift salah satu karyawan tidak ditemukan.";
export const PESAN_TUKAR_BACKUP =
  "Salah satu karyawan punya penugasan backup aktif di tanggal itu.";

/** Web menulis langsung ke cloud: `diterima_cloud` jam database cloud. */
export const CLOUD_INSERT_KEPUTUSAN_SQL =
  "INSERT INTO hr_pengajuan_keputusan (id_keputusan, id_pengajuan, jenis, sidik, alasan, oleh, waktu_perangkat, diterima_cloud, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, datetime('now'), COALESCE(?8, datetime('now'))) ON CONFLICT(id_keputusan) DO NOTHING;";

export const INSERT_PENYESUAIAN_SQL =
  "INSERT INTO hr_cuti_penyesuaian (id_penyesuaian, id_karyawan, periode, jenis, id_ref, hari, nominal, alasan, dicatat_oleh, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, COALESCE(?10, datetime('now'))) ON CONFLICT(id_penyesuaian) DO NOTHING;";

export const PESAN_TANPA_HARI_KERJA =
  "Rentang itu tidak berisi hari kerja karyawan ini.";
export const JENIS_PENYESUAIAN = ["Saldo Awal", "Koreksi"] as const;
export const MAKS_LAMPIRAN = 5;

/** Cermin `validasi_penyesuaian`. */
export function validasiPenyesuaian(draft: Draft): Hasil<{
  id_karyawan: string;
  periode: string;
  jenis: string;
  hari: number;
  alasan: string;
}> {
  const idKaryawan = teks(draft, "id_karyawan");
  if (idKaryawan === "") return gagal("Pilih karyawan.");
  const periode = teks(draft, "periode");
  if (!tanggalValid(periode)) return gagal("Periode tidak valid.");
  const jenis = teks(draft, "jenis");
  if (!(JENIS_PENYESUAIAN as readonly string[]).includes(jenis)) {
    return gagal("Jenis penyesuaian harus Saldo Awal atau Koreksi.");
  }
  const hari = draft.hari;
  if (
    typeof hari !== "number" ||
    !Number.isInteger(hari) ||
    hari === 0 ||
    Math.abs(hari) > MAKS_HARI_JENIS
  ) {
    return gagal(
      `Jumlah hari harus bilangan bulat selain 0, paling banyak ${MAKS_HARI_JENIS}.`,
    );
  }
  const alasan = teks(draft, "alasan");
  if (alasan === "") return gagal("Alasan wajib diisi.");
  if (panjang(alasan) > MAKS_ALASAN) {
    return gagal(`Alasan maksimal ${MAKS_ALASAN} karakter.`);
  }
  return ok({ id_karyawan: idKaryawan, periode, jenis, hari, alasan });
}

/** Cermin `id_uang`: dua perangkat menghasilkan PK yang sama. */
export function idUang(idKaryawan: string, periode: string): string {
  return `uang:${idKaryawan}:${periode}`;
}

/** Selisih hari kalender inklusif untuk `periksaMaks`. */
export function hariKalender(mulai: string, selesai: string): number {
  return selisihHari(mulai, selesai) + 1;
}
