/**
 * HRIS fase 6 (skema v41): penilaian kinerja (prd-hris.md §21).
 *
 * Cermin `desktop/hr_kinerja.rs`: aturan murni, pesan galat, dan SQL WAJIB
 * identik, diuji dengan vektor yang sama (`hr-kinerja.test.ts` ↔
 * `mod tests`). Status, nilai berlaku, dan tanda TIDAK disimpan.
 */

import { parseHariKerja, wajibMasuk } from "./hari-kerja";
import { evaluateHolidayScan } from "./holiday-whitelist";
import {
  type Kalender,
  KELOMPOK_TIDAK_HADIR,
  PENGAJUAN_BERLAKU_SQL,
  tanggalRentang,
  urutKeputusan,
} from "./hr-pengajuan";
import { kunciNama, tambahBulan } from "./hris";
import { isValidDate } from "./inventory";
import type {
  HariLaporan,
  PengajuanLaporan,
  TukarLaporan,
} from "./laporan-kehadiran";

// ── Konstanta (WAJIB sama dengan CHECK DDL v41) ────────────────────────────

export const PERIODE_JENIS = [
  "Bulanan",
  "Kuartal",
  "Semester",
  "Tahunan",
] as const;
export const TIPE_MANUAL = "Manual";
export const TIPE_DISIPLIN = "Otomatis Disiplin";
export const TIPE_ASPEK = [TIPE_MANUAL, TIPE_DISIPLIN] as const;
export const JENIS_KEPUTUSAN = [
  "Ajukan",
  "Kembalikan",
  "Final",
  "Batal",
] as const;
export const AKSI_KINERJA = [
  "Simpan",
  "Koreksi",
  "Ajukan",
  "Kembalikan",
  "Final",
  "Batal",
] as const;

export const STATUS_DRAF = "Draf";
export const STATUS_DIAJUKAN = "Diajukan";
export const STATUS_FINAL = "Final";
export const STATUS_DIBATALKAN = "Dibatalkan";
export type StatusKinerja =
  | typeof STATUS_DRAF
  | typeof STATUS_DIAJUKAN
  | typeof STATUS_FINAL
  | typeof STATUS_DIBATALKAN;

export const MAKS_NAMA_TEMPLATE = 100;
export const MAKS_KETERANGAN = 1000;
export const MAKS_ASPEK = 100;
export const MAKS_ASPEK_AKTIF = 20;
export const MAKS_NAMA_ASPEK = 100;
export const MAKS_PANDUAN = 1000;
export const MAKS_JABATAN_TEMPLATE = 500;
export const TOTAL_BOBOT = 100;
export const MAKS_CATATAN_ASPEK = 1000;
export const MAKS_CATATAN = 2000;
export const MAKS_ALASAN = 500;
export const MAKS_ALASAN_KOREKSI = 1000;
/** Nilai akhir ×100 (Q-74): 0 sampai 10.000. */
export const NILAI_MAKS = 10_000;

export const KUNCI_PERIODE = "hr_kinerja_periode";
export const KUNCI_AMBANG = "hr_kinerja_ambang_disiplin";
export const KUNCI_PREDIKAT = "hr_kinerja_predikat";
export const PERIODE_BAWAAN = "Semester";
/** Permil minimal untuk skor 5, 4, 3, 2. */
export const AMBANG_BAWAAN: Ambang = [950, 900, 800, 700];
export const PREDIKAT_BAWAAN =
  "9000:Sangat Baik|7500:Baik|6000:Cukup|4000:Kurang|0:Sangat Kurang";
export const MAKS_NAMA_PREDIKAT = 50;

export const PESAN_DIRI_SENDIRI =
  "Penilaian kinerja dirimu sendiri harus dikerjakan orang lain.";
export const PESAN_IZIN = "Kamu tidak punya izin untuk aksi penilaian ini.";
export const PESAN_DISIPLIN_BERUBAH =
  "Angka disiplin berubah sejak draf disimpan. Periksa angka barunya, lalu ajukan sekali lagi.";
export const PESAN_AMBANG =
  "Ambang disiplin harus empat bilangan bulat 1 sampai 1000 yang turun, misalnya 950,900,800,700.";
export const PESAN_DISIPLIN_MANUAL =
  "Tidak ada hari yang bisa dinilai untuk aspek disiplin; isi catatan alasan skornya.";

// ── SQL masukan disiplin (§21.6). Argumen selalu ?1 mulai, ?2 selesai, ?3 id.

/** Cermin `DISIPLIN_KARYAWAN_SQL`: jadwal satu karyawan. */
export const DISIPLIN_KARYAWAN_SQL =
  "SELECT json_object('id', m.id_unik, 'divisi', COALESCE(m.divisi, ''), 'hari_kerja', sh.hari_kerja, 'kode_shift', sh.kode_shift) FROM master_data m LEFT JOIN tbl_shift sh ON sh.id_shift = m.id_shift WHERE m.id_unik = ?3;";

/** Cermin `DISIPLIN_HARI_SQL`: kolom `LAPORAN_KEHADIRAN_SQL.hari`, satu karyawan. */
export const DISIPLIN_HARI_SQL =
  "SELECT json_object('id', id_karyawan, 'tanggal', tanggal, 'hadir', MAX(CASE WHEN (COALESCE(TRIM(jam_masuk), '') <> '' AND COALESCE(status_kehadiran, '') <> 'Alfa') OR status_kehadiran IN ('Hadir', 'Terlambat') THEN 1 ELSE 0 END), 'telat', MAX(COALESCE(menit_terlambat, 0)), 'menit', SUM(COALESCE(menit_terlambat, 0)), 'sakit', MAX(CASE WHEN status_kehadiran = 'Sakit' THEN 1 ELSE 0 END), 'izin', MAX(CASE WHEN status_kehadiran = 'Izin' THEN 1 ELSE 0 END), 'dispensasi', MAX(CASE WHEN status_kehadiran IN ('Dispen', 'Dispensasi') THEN 1 ELSE 0 END), 'alfa', MAX(CASE WHEN status_kehadiran = 'Alfa' THEN 1 ELSE 0 END)) FROM absensi_harian WHERE id_karyawan = ?3 AND tanggal BETWEEN ?1 AND ?2 GROUP BY id_karyawan, tanggal ORDER BY tanggal;";

/** Cermin `DISIPLIN_PENGAJUAN_SQL`: `LAPORAN_PENGAJUAN_SQL` satu karyawan. */
export const DISIPLIN_PENGAJUAN_SQL = `SELECT json_object('id', p.id_karyawan, 'mulai', p.tanggal_mulai, 'selesai', p.tanggal_selesai, 'kelompok', p.kelompok) FROM hr_pengajuan p WHERE p.id_karyawan = ?3 AND p.tanggal_mulai <= ?2 AND p.tanggal_selesai >= ?1 AND p.kelompok IN ('Cuti', 'Izin', 'Sakit', 'Dinas Luar') AND ${PENGAJUAN_BERLAKU_SQL} ORDER BY p.tanggal_mulai, p.id_pengajuan;`;

/** Cermin `DISIPLIN_TUKAR_SQL`: `LAPORAN_TUKAR_SQL` satu karyawan. */
export const DISIPLIN_TUKAR_SQL = `SELECT json_object('id', t.id, 'tanggal', t.tanggal, 'hari_kerja', s.hari_kerja, 'kode_shift', s.kode_shift) FROM (SELECT p.id_karyawan AS id, p.tanggal_mulai AS tanggal, p.id_shift_tukar AS id_shift, p.id_pengajuan AS urut FROM hr_pengajuan p WHERE p.kelompok = 'Tukar Shift' AND p.tanggal_mulai >= ?1 AND p.tanggal_mulai <= ?2 AND ${PENGAJUAN_BERLAKU_SQL} UNION ALL SELECT p.id_karyawan_tukar, p.tanggal_mulai, p.id_shift_asal, p.id_pengajuan FROM hr_pengajuan p WHERE p.kelompok = 'Tukar Shift' AND p.tanggal_mulai >= ?1 AND p.tanggal_mulai <= ?2 AND ${PENGAJUAN_BERLAKU_SQL}) t JOIN tbl_shift s ON s.id_shift = t.id_shift WHERE t.id = ?3 ORDER BY t.tanggal, t.urut;`;

/** Cermin `DISIPLIN_PERJALANAN_SQL`: batas sama dengan `PELAPOR_PERJALANAN_SQL`. */
export const DISIPLIN_PERJALANAN_SQL =
  "SELECT DISTINCT json_object('tanggal', date(waktu_perangkat, '+7 hours')) FROM drv_laporan WHERE id_karyawan = ?3 AND waktu_perangkat >= datetime(?1, '-7 hours') AND waktu_perangkat < datetime(?2, '+17 hours');";

// ── Pembantu isian ─────────────────────────────────────────────────────────

type Hasil<T> = { ok: true; nilai: T } | { ok: false; pesan: string };
const ok = <T>(nilai: T): Hasil<T> => ({ ok: true, nilai });
const gagal = <T = never>(pesan: string): Hasil<T> => ({ ok: false, pesan });
type Draft = Record<string, unknown>;

const panjang = (teks: string) => [...teks].length;
const bandingTeks = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function objek(nilai: unknown): Draft {
  return nilai && typeof nilai === "object" && !Array.isArray(nilai)
    ? (nilai as Draft)
    : {};
}

function teks(draft: Draft, kunci: string): string {
  const v = draft[kunci];
  if (typeof v === "string") return v.trim();
  if (typeof v === "number") return String(v);
  return "";
}

function bendera(draft: Draft, kunci: string): boolean {
  const v = draft[kunci];
  return v === true || v === 1;
}

/** Bilangan bulat JSON (bukan teks). */
function bulat(nilai: unknown): number | null {
  return typeof nilai === "number" && Number.isSafeInteger(nilai)
    ? nilai
    : null;
}

function opsional(
  draft: Draft,
  kunci: string,
  label: string,
  maks: number,
): Hasil<string | null> {
  const t = teks(draft, kunci);
  if (panjang(t) > maks) return gagal(`${label} maksimal ${maks} karakter.`);
  return ok(t === "" ? null : t);
}

function namaRapi(masukan: string, label: string, maks: number): Hasil<string> {
  const nama = masukan.split(/\s+/).filter(Boolean).join(" ");
  if (nama === "") return gagal(`${label} wajib diisi.`);
  if (panjang(nama) > maks) return gagal(`${label} maksimal ${maks} karakter.`);
  return ok(nama);
}

const samaOrang = (a: string, b: string) =>
  a.trim().toLowerCase() === b.trim().toLowerCase();

function tambahHari(tanggal: string, n: number): string {
  return new Date(Date.parse(`${tanggal}T00:00:00Z`) + n * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

// ── Template, aspek, pemetaan (§21.3) ──────────────────────────────────────

export interface AspekSah {
  /** Kosong = aspek baru; id dibuat pemanggil (`<id_template>:<acak>`). */
  id_aspek: string;
  nama: string;
  tipe: string;
  bobot: number;
  panduan: string | null;
  urutan: number;
  is_aktif: boolean;
}

export interface TemplateSah {
  nama: string;
  keterangan: string | null;
  is_bawaan: boolean;
  is_aktif: boolean;
  aspek: AspekSah[];
  /** Jabatan yang dipetakan ke template ini. */
  jabatan: string[];
}

/** Cermin `validasi_template`. */
export function validasiTemplate(masukan: unknown): Hasil<TemplateSah> {
  const draft = objek(masukan);
  const nama = namaRapi(
    teks(draft, "nama"),
    "Nama template",
    MAKS_NAMA_TEMPLATE,
  );
  if (!nama.ok) return nama;
  const keterangan = opsional(
    draft,
    "keterangan",
    "Keterangan",
    MAKS_KETERANGAN,
  );
  if (!keterangan.ok) return keterangan;
  const is_aktif = draft.is_aktif === undefined || bendera(draft, "is_aktif");
  const is_bawaan = bendera(draft, "is_bawaan");
  if (is_bawaan && !is_aktif) {
    return gagal(
      "Template bawaan tidak bisa dinonaktifkan. Jadikan template lain bawaan dulu.",
    );
  }
  const daftar = Array.isArray(draft.aspek) ? draft.aspek : [];
  if (daftar.length > MAKS_ASPEK) {
    return gagal(`Paling banyak ${MAKS_ASPEK} aspek per template.`);
  }
  const aspek: AspekSah[] = [];
  const idDipakai = new Set<string>();
  const namaDipakai = new Set<string>();
  for (const [i, isi] of daftar.entries()) {
    const a = objek(isi);
    const namaAspek = namaRapi(teks(a, "nama"), "Nama aspek", MAKS_NAMA_ASPEK);
    if (!namaAspek.ok) return namaAspek;
    const id_aspek = teks(a, "id_aspek");
    if (id_aspek !== "") {
      if (idDipakai.has(id_aspek)) {
        return gagal("Aspek ganda dalam satu template.");
      }
      idDipakai.add(id_aspek);
    }
    const tipe = teks(a, "tipe");
    if (!(TIPE_ASPEK as readonly string[]).includes(tipe)) {
      return gagal("Tipe aspek harus Manual atau Otomatis Disiplin.");
    }
    const bobot = bulat(a.bobot);
    if (bobot === null || bobot < 1 || bobot > TOTAL_BOBOT) {
      return gagal(
        `Bobot aspek ${namaAspek.nilai} harus bilangan bulat 1 sampai 100.`,
      );
    }
    const panduan = opsional(a, "panduan", "Panduan aspek", MAKS_PANDUAN);
    if (!panduan.ok) return panduan;
    const aktif = a.is_aktif === undefined || bendera(a, "is_aktif");
    if (aktif) {
      const kunci = kunciNama(namaAspek.nilai);
      if (namaDipakai.has(kunci)) {
        return gagal(`Nama aspek ${namaAspek.nilai} dipakai dua kali.`);
      }
      namaDipakai.add(kunci);
    }
    aspek.push({
      id_aspek,
      nama: namaAspek.nilai,
      tipe,
      bobot,
      panduan: panduan.nilai,
      urutan: i,
      is_aktif: aktif,
    });
  }
  const aktif = aspek.filter((a) => a.is_aktif);
  if (aktif.length === 0) {
    return gagal("Template butuh minimal satu aspek aktif.");
  }
  if (aktif.length > MAKS_ASPEK_AKTIF) {
    return gagal(`Paling banyak ${MAKS_ASPEK_AKTIF} aspek aktif.`);
  }
  const total = aktif.reduce((n, a) => n + a.bobot, 0);
  if (total !== TOTAL_BOBOT) {
    return gagal(`Total bobot aspek aktif harus 100, sekarang ${total}.`);
  }
  if (aktif.filter((a) => a.tipe === TIPE_DISIPLIN).length > 1) {
    return gagal("Paling banyak satu aspek Otomatis Disiplin.");
  }
  const jabatan: string[] = [];
  if (draft.jabatan !== undefined && draft.jabatan !== null) {
    if (!Array.isArray(draft.jabatan)) {
      return gagal("Daftar jabatan tidak valid.");
    }
    for (const j of draft.jabatan) {
      const id = typeof j === "string" ? j.trim() : "";
      if (id === "") return gagal("Daftar jabatan tidak valid.");
      if (!jabatan.includes(id)) jabatan.push(id);
    }
  }
  if (jabatan.length > MAKS_JABATAN_TEMPLATE) {
    return gagal(
      `Paling banyak ${MAKS_JABATAN_TEMPLATE} jabatan per template.`,
    );
  }
  return ok({
    nama: nama.nilai,
    keterangan: keterangan.nilai,
    is_bawaan,
    is_aktif,
    aspek,
    jabatan,
  });
}

/** Cermin `periksa_aspek_lama`. `lama` = `[id_aspek, tipe]` yang tersimpan. */
export function periksaAspekLama(
  baru: readonly AspekSah[],
  lama: readonly (readonly [string, string])[],
): Hasil<null> {
  for (const a of baru) {
    if (a.id_aspek !== "" && !lama.some(([id]) => id === a.id_aspek)) {
      return gagal("Aspek tidak dikenal; muat ulang template.");
    }
  }
  for (const [id, tipe] of lama) {
    const a = baru.find((x) => x.id_aspek === id);
    if (!a) return gagal("Aspek lama tidak boleh dihapus; nonaktifkan saja.");
    if (a.tipe !== tipe) {
      return gagal(`Tipe aspek ${a.nama} tidak bisa diubah setelah dibuat.`);
    }
  }
  return ok(null);
}

/** Cermin `nama_template_dipakai`. `lain` = `[id_template, nama]`. */
export function namaTemplateDipakai(
  nama: string,
  idTemplate: string,
  lain: readonly (readonly [string, string])[],
): boolean {
  const kunci = kunciNama(nama);
  return lain.some(([id, n]) => id !== idTemplate && kunciNama(n) === kunci);
}

/** Cermin `nama_ganda`. */
export function namaGanda(
  template: readonly (readonly [string, string])[],
): Set<string> {
  return new Set(
    template
      .filter(([id, nama]) => namaTemplateDipakai(nama, id, template))
      .map(([id]) => id),
  );
}

export interface TemplateRingkas {
  id_template: string;
  is_aktif: boolean;
  is_bawaan: boolean;
}

/** Cermin `template_karyawan` (Q-79). */
export function templateKaryawan(
  idJabatan: string | null,
  pemetaan: ReadonlyMap<string, string | null>,
  template: readonly TemplateRingkas[],
): string | null {
  const aktif = (id: string) =>
    template.some((t) => t.id_template === id && t.is_aktif);
  const jabatan = idJabatan?.trim() ?? "";
  const dipetakan = jabatan === "" ? null : (pemetaan.get(jabatan) ?? null);
  if (dipetakan && aktif(dipetakan)) return dipetakan;
  // Dua bawaan hanya mungkin sebelum cloud menyelaraskannya; ambil yang terkecil.
  const bawaan = template
    .filter((t) => t.is_aktif && t.is_bawaan)
    .map((t) => t.id_template)
    .sort(bandingTeks);
  return bawaan[0] ?? null;
}

// ── Periode (§21.4) ────────────────────────────────────────────────────────

function bulanPeriode(jenis: string): number | null {
  switch (jenis) {
    case "Bulanan":
      return 1;
    case "Kuartal":
      return 3;
    case "Semester":
      return 6;
    case "Tahunan":
      return 12;
    default:
      return null;
  }
}

/** Cermin `periode_rentang`. */
export function periodeRentang(
  jenis: string,
  mulai: string,
): Hasil<[string, string]> {
  const n = bulanPeriode(jenis);
  if (n === null) {
    return gagal(
      "Jenis periode harus Bulanan, Kuartal, Semester, atau Tahunan.",
    );
  }
  if (!isValidDate(mulai)) return gagal("Tanggal mulai periode tidak valid.");
  const [, bulan, hari] = mulai.split("-").map(Number);
  if (hari !== 1 || (bulan - 1) % n !== 0) {
    return gagal(`Tanggal ${mulai} bukan awal periode ${jenis.toLowerCase()}.`);
  }
  const akhir = tambahBulan(mulai, n);
  if (!akhir) return gagal("Tanggal mulai periode tidak valid.");
  return ok([mulai, tambahHari(akhir, -1)]);
}

/** Cermin `awal_periode`. */
export function awalPeriode(jenis: string, tanggal: string): string | null {
  const n = bulanPeriode(jenis);
  if (n === null || !isValidDate(tanggal)) return null;
  const [tahun, bulan] = tanggal.split("-").map(Number);
  const awal = Math.floor((bulan - 1) / n) * n + 1;
  return `${String(tahun).padStart(4, "0")}-${String(awal).padStart(2, "0")}-01`;
}

export interface RentangAktif {
  mulai: string;
  akhir: string;
  /** `false` = tanda `periode_tidak_penuh`. */
  penuh: boolean;
}

/** Cermin `rentang_aktif` (Q-80). */
export function rentangAktif(
  periodeMulai: string,
  periodeSelesai: string,
  tanggalDaftar: string | null,
  tanggalSelesaiAktif: string | null,
): RentangAktif | null {
  const sah = (t: string | null) => {
    const x = t?.trim() ?? "";
    return isValidDate(x) ? x : null;
  };
  const daftar = sah(tanggalDaftar);
  const selesai = sah(tanggalSelesaiAktif);
  const mulai = daftar && daftar > periodeMulai ? daftar : periodeMulai;
  const akhir = selesai && selesai < periodeSelesai ? selesai : periodeSelesai;
  if (mulai > akhir) return null;
  return {
    mulai,
    akhir,
    penuh: mulai === periodeMulai && akhir === periodeSelesai,
  };
}

/** Cermin `periksa_buat` (§21.4): hanya untuk penilaian akar baru. */
export function periksaBuat(
  aktif: boolean,
  sudahKeluar: boolean,
  periodeMulai: string,
  hariIni: string,
  rentang: RentangAktif | null,
): Hasil<null> {
  if (sudahKeluar) {
    return gagal(
      "Karyawan ini sudah keluar; penilaian baru tidak bisa dibuat.",
    );
  }
  if (!aktif) return gagal("Karyawan nonaktif tidak bisa dinilai.");
  if (periodeMulai > hariIni) return gagal("Periode ini belum dimulai.");
  if (!rentang) return gagal("Karyawan ini tidak aktif selama periode itu.");
  return ok(null);
}

export interface RingkasPenilaian {
  id_penilaian: string;
  id_karyawan: string;
  id_ref: string | null;
  periode_mulai: string;
  periode_selesai: string;
  dibatalkan: boolean;
}

const akarHidup = (p: RingkasPenilaian) => p.id_ref === null && !p.dibatalkan;

/** Cermin `bentrok_periode` (Q-73). */
export function bentrokPeriode(
  baru: RingkasPenilaian,
  lain: readonly RingkasPenilaian[],
): RingkasPenilaian | null {
  if (baru.id_ref !== null) return null;
  return (
    lain.find(
      (p) =>
        p.id_penilaian !== baru.id_penilaian &&
        akarHidup(p) &&
        p.id_karyawan === baru.id_karyawan &&
        p.periode_mulai <= baru.periode_selesai &&
        p.periode_selesai >= baru.periode_mulai,
    ) ?? null
  );
}

/** Cermin `penilaian_ganda`. */
export function penilaianGanda(
  semua: readonly RingkasPenilaian[],
): Set<string> {
  return new Set(
    semua
      .filter((p) => akarHidup(p) && bentrokPeriode(p, semua) !== null)
      .map((p) => p.id_penilaian),
  );
}

/** Cermin `pesan_bertumpuk`. */
export function pesanBertumpuk(mulai: string, selesai: string): string {
  return `Karyawan ini sudah punya penilaian untuk periode ${mulai} s.d. ${selesai}.`;
}

// ── Isian penilaian dan baris nilai (§21.5) ────────────────────────────────

export interface IsianNilai {
  id_aspek: string;
  skor: number | null;
  catatan: string | null;
}

export interface PenilaianSah {
  id_karyawan: string;
  id_ref: string | null;
  alasan_koreksi: string | null;
  periode_jenis: string;
  periode_mulai: string;
  periode_selesai: string;
  catatan: string | null;
  nilai: IsianNilai[];
}

/** Cermin `validasi_penilaian`. */
export function validasiPenilaian(masukan: unknown): Hasil<PenilaianSah> {
  const draft = objek(masukan);
  const id_karyawan = teks(draft, "id_karyawan");
  if (id_karyawan === "") return gagal("Pilih karyawan.");
  const periode_jenis = teks(draft, "periode_jenis");
  const periode = periodeRentang(periode_jenis, teks(draft, "periode_mulai"));
  if (!periode.ok) return periode;
  const catatan = opsional(draft, "catatan", "Catatan penilaian", MAKS_CATATAN);
  if (!catatan.ok) return catatan;
  const id_ref = teks(draft, "id_ref") || null;
  const alasan = opsional(
    draft,
    "alasan_koreksi",
    "Alasan koreksi",
    MAKS_ALASAN_KOREKSI,
  );
  if (!alasan.ok) return alasan;
  if (id_ref !== null && alasan.nilai === null) {
    return gagal("Alasan koreksi wajib diisi.");
  }
  let daftar: unknown[] = [];
  if (draft.nilai !== undefined && draft.nilai !== null) {
    if (!Array.isArray(draft.nilai)) return gagal("Isian nilai tidak valid.");
    daftar = draft.nilai;
  }
  if (daftar.length > MAKS_ASPEK) return gagal("Isian nilai tidak valid.");
  const nilai: IsianNilai[] = [];
  for (const isi of daftar) {
    const n = objek(isi);
    const id_aspek = teks(n, "id_aspek");
    if (id_aspek === "") return gagal("Isian nilai tidak valid.");
    if (nilai.some((x) => x.id_aspek === id_aspek)) {
      return gagal("Aspek ganda dalam isian nilai.");
    }
    let skor: number | null = null;
    const mentah = n.skor;
    const kosong =
      mentah === undefined ||
      mentah === null ||
      (typeof mentah === "string" && mentah.trim() === "");
    if (!kosong) {
      skor = bulat(mentah);
      if (skor === null || skor < 1 || skor > 5) {
        return gagal("Skor harus bilangan bulat 1 sampai 5.");
      }
    }
    const catatanAspek = opsional(
      n,
      "catatan",
      "Catatan aspek",
      MAKS_CATATAN_ASPEK,
    );
    if (!catatanAspek.ok) return catatanAspek;
    nilai.push({ id_aspek, skor, catatan: catatanAspek.nilai });
  }
  return ok({
    id_karyawan,
    id_ref,
    alasan_koreksi: id_ref === null ? null : alasan.nilai,
    periode_jenis,
    periode_mulai: periode.nilai[0],
    periode_selesai: periode.nilai[1],
    catatan: catatan.nilai,
    nilai,
  });
}

/** Satu baris `hr_kinerja_nilai` tanpa `id_nilai`/`id_penilaian`. */
export interface BarisNilai {
  id_aspek: string;
  aspek_nama: string;
  tipe: string;
  bobot: number;
  urutan: number;
  skor: number | null;
  catatan: string | null;
  rincian: string | null;
}

export function idNilai(idPenilaian: string, idAspek: string): string {
  return `${idPenilaian}:${idAspek}`;
}

const urutBaris = (
  a: { urutan: number; id_aspek: string },
  b: { urutan: number; id_aspek: string },
) => a.urutan - b.urutan || bandingTeks(a.id_aspek, b.id_aspek);

/** Cermin `salinan_aspek` (Q-78). */
export function salinanAspek(aspek: readonly AspekSah[]): BarisNilai[] {
  return aspek
    .filter((a) => a.is_aktif)
    .sort(urutBaris)
    .map((a) => ({
      id_aspek: a.id_aspek,
      aspek_nama: a.nama,
      tipe: a.tipe,
      bobot: a.bobot,
      urutan: a.urutan,
      skor: null,
      catatan: null,
      rincian: null,
    }));
}

/** Cermin `muat_ulang_template`. */
export function muatUlangTemplate(
  baru: readonly BarisNilai[],
  lama: readonly BarisNilai[],
): BarisNilai[] {
  return baru.map((b) => {
    const l = lama.find((x) => x.id_aspek === b.id_aspek);
    return l ? { ...b, skor: l.skor, catatan: l.catatan } : { ...b };
  });
}

/** Cermin `susun_nilai`. */
export function susunNilai(
  baris: readonly BarisNilai[],
  isian: readonly IsianNilai[],
  disiplin: Disiplin | null,
): Hasil<BarisNilai[]> {
  if (isian.some((i) => !baris.some((b) => b.id_aspek === i.id_aspek))) {
    return gagal("Aspek penilaian tidak dikenal; muat ulang template.");
  }
  const hasil: BarisNilai[] = [];
  for (const b of baris) {
    const isi = isian.find((i) => i.id_aspek === b.id_aspek);
    const baru: BarisNilai = {
      ...b,
      skor: isi?.skor ?? null,
      catatan: isi?.catatan ?? null,
      rincian: null,
    };
    if (b.tipe === TIPE_DISIPLIN) {
      if (!disiplin) return gagal("Angka disiplin belum dihitung.");
      baru.rincian = disiplin.rincian;
      if (disiplin.skor !== null) baru.skor = disiplin.skor;
      else if (baru.skor !== null && baru.catatan === null) {
        return gagal(PESAN_DISIPLIN_MANUAL);
      }
    }
    hasil.push(baru);
  }
  return ok(hasil);
}

export function skorLengkap(baris: readonly BarisNilai[]): boolean {
  return baris.length > 0 && baris.every((b) => b.skor !== null);
}

/** Isi yang ikut sidik. Penilai tidak ikut. */
export interface IsiPenilaian {
  id_karyawan: string;
  id_ref: string | null;
  periode_mulai: string;
  periode_selesai: string;
  id_template: string;
  catatan: string | null;
  nilai: readonly BarisNilai[];
}

/**
 * Cermin `kanonik_penilaian`; SHA-256-nya dihitung `sidikPenilaian` di
 * service (pola `kanonikPengajuan`).
 */
export function kanonikPenilaian(isi: IsiPenilaian): string {
  const bagian = [
    isi.id_karyawan,
    isi.id_ref ?? "",
    isi.periode_mulai,
    isi.periode_selesai,
    isi.id_template,
    isi.catatan ?? "",
  ];
  for (const n of [...isi.nilai].sort(urutBaris)) {
    bagian.push(
      n.id_aspek,
      n.tipe,
      String(n.bobot),
      n.skor === null ? "" : String(n.skor),
      n.catatan ?? "",
      n.rincian ?? "",
    );
  }
  return bagian.join("\u001f");
}

// ── Status, aksi, tanda (§21.5) ────────────────────────────────────────────

export interface KeputusanKinerja {
  id_keputusan: string;
  jenis: string;
  sidik: string;
  oleh: string;
  waktu_perangkat: string;
  diterima_cloud: string | null;
  nilai_akhir?: number | null;
  predikat?: string | null;
}

/** Cermin `final_berlaku`. Urutannya `urutKeputusan` milik pengajuan. */
export function finalBerlaku(
  sidik: string,
  keputusan: readonly KeputusanKinerja[],
): KeputusanKinerja | null {
  return (
    keputusan
      .filter((k) => k.jenis === "Final" && k.sidik === sidik)
      .sort(urutKeputusan)[0] ?? null
  );
}

/** Cermin `status_kinerja` (§21.5, berurutan). */
export function statusKinerja(
  sidik: string,
  keputusan: readonly KeputusanKinerja[],
): StatusKinerja {
  if (keputusan.some((k) => k.jenis === "Batal")) return STATUS_DIBATALKAN;
  if (finalBerlaku(sidik, keputusan)) return STATUS_FINAL;
  const terakhir = (jenis: string) =>
    keputusan
      .filter((k) => k.jenis === jenis && k.sidik === sidik)
      .sort(urutKeputusan)
      .at(-1) ?? null;
  const ajukan = terakhir("Ajukan");
  const kembali = terakhir("Kembalikan");
  if (ajukan && (!kembali || urutKeputusan(ajukan, kembali) > 0)) {
    return STATUS_DIAJUKAN;
  }
  return STATUS_DRAF;
}

/** Cermin `KeadaanKinerja`. Semua dinilai backend. */
export interface KeadaanKinerja {
  /** Kosong = belum ada (penilaian baru). */
  status: string;
  koreksi: boolean;
  karyawan_sendiri: boolean;
  boleh_assess: boolean;
  boleh_finalize: boolean;
  skor_lengkap: boolean;
  /** `periode_selesai` ≤ hari ini (tanggal WIB). */
  periode_selesai: boolean;
  disiplin_sama: boolean;
  akar_final: boolean;
  koreksi_terbuka: boolean;
}

/** Cermin `periksa_aksi_kinerja` (§21.5). */
export function periksaAksiKinerja(
  aksi: string,
  alasan: string,
  k: KeadaanKinerja,
): Hasil<null> {
  if (!(AKSI_KINERJA as readonly string[]).includes(aksi)) {
    return gagal("Aksi penilaian tidak dikenal.");
  }
  if (panjang(alasan.trim()) > MAKS_ALASAN) {
    return gagal(`Alasan maksimal ${MAKS_ALASAN} karakter.`);
  }
  if (k.karyawan_sendiri) return gagal(PESAN_DIRI_SENDIRI);
  const tanpaAlasan = alasan.trim() === "";
  // Koreksi diisi pemegang assess atau finalize (§21.7).
  const pengisi = k.boleh_assess || (k.koreksi && k.boleh_finalize);
  switch (aksi) {
    case "Simpan":
      if (!pengisi) return gagal(PESAN_IZIN);
      if (!(k.status === "" || k.status === STATUS_DRAF)) {
        return gagal(
          "Penilaian yang sudah diajukan atau selesai tidak bisa disunting.",
        );
      }
      break;
    case "Koreksi":
      if (!k.boleh_finalize) return gagal(PESAN_IZIN);
      if (!k.akar_final) {
        return gagal("Koreksi hanya untuk penilaian yang sudah final.");
      }
      if (k.koreksi_terbuka) {
        return gagal("Penilaian ini masih punya koreksi yang belum selesai.");
      }
      break;
    case "Ajukan":
      if (!pengisi) return gagal(PESAN_IZIN);
      if (k.status !== STATUS_DRAF)
        return gagal("Hanya draf yang bisa diajukan.");
      if (!k.skor_lengkap) {
        return gagal("Isi skor semua aspek sebelum mengajukan.");
      }
      if (!k.periode_selesai) {
        return gagal(
          "Penilaian baru bisa diajukan sejak hari terakhir periode.",
        );
      }
      if (!k.disiplin_sama) return gagal(PESAN_DISIPLIN_BERUBAH);
      break;
    case "Kembalikan":
    case "Final":
      if (!k.boleh_finalize) return gagal(PESAN_IZIN);
      if (k.status !== STATUS_DIAJUKAN) {
        return gagal("Penilaian ini tidak sedang diajukan.");
      }
      if (aksi === "Kembalikan" && tanpaAlasan) {
        return gagal("Alasan pengembalian wajib diisi.");
      }
      break;
    default:
      if (!(k.boleh_assess || k.boleh_finalize)) return gagal(PESAN_IZIN);
      if (k.status === STATUS_FINAL) {
        return gagal("Penilaian final tidak bisa dibatalkan; buat koreksi.");
      }
      if (k.status !== STATUS_DRAF && k.status !== STATUS_DIAJUKAN) {
        return gagal("Penilaian ini sudah dibatalkan.");
      }
      if (tanpaAlasan) return gagal("Alasan pembatalan wajib diisi.");
  }
  return ok(null);
}

export interface InfoTanda {
  sidik: string;
  keputusan: readonly KeputusanKinerja[];
  penilai_oleh: string;
  id_penilai: string | null;
  /** `master_data.id_atasan` karyawan yang dinilai. */
  id_atasan: string | null;
  /** `rincian` baris Otomatis Disiplin, bila ada. */
  rincian_disiplin: string | null;
  periode_penuh: boolean;
  /** Hasil `penilaianGanda`. */
  ganda: boolean;
}

/** Cermin `tanda_kinerja`. `disiplin_berubah` dihitung terpisah di rincian. */
export function tandaKinerja(i: InfoTanda): string[] {
  const status = statusKinerja(i.sidik, i.keputusan);
  const adaFinal = i.keputusan.some((k) => k.jenis === "Final");
  const berlaku = finalBerlaku(i.sidik, i.keputusan);
  const tanda: string[] = [];
  if (i.ganda) tanda.push("penilaian_ganda");
  if (status !== STATUS_DIBATALKAN && adaFinal && !berlaku) {
    tanda.push("final_gugur");
  }
  if (status === STATUS_DIBATALKAN && adaFinal) tanda.push("final_dibatalkan");
  if (
    status === STATUS_FINAL &&
    berlaku &&
    samaOrang(berlaku.oleh, i.penilai_oleh)
  ) {
    tanda.push("dinilai_dan_difinalkan_sama");
  }
  const atasan = i.id_atasan?.trim() ?? "";
  if (atasan !== "" && i.id_penilai?.trim() !== atasan) {
    tanda.push("bukan_atasan_langsung");
  }
  if (i.rincian_disiplin?.startsWith("0|")) tanda.push("disiplin_manual");
  if (!i.periode_penuh) tanda.push("periode_tidak_penuh");
  return tanda;
}

/** Cermin `kinerja_berlaku` (§21.7). */
export function kinerjaBerlaku(
  kandidat: readonly { id_penilaian: string; final: KeputusanKinerja }[],
): string | null {
  const urut = [...kandidat].sort((a, b) => urutKeputusan(a.final, b.final));
  return urut.at(-1)?.id_penilaian ?? null;
}

// ── Disiplin otomatis (§21.6) ──────────────────────────────────────────────

/** Baris `DISIPLIN_KARYAWAN_SQL`. */
export interface KaryawanDisiplin {
  divisi: string;
  hari_kerja: string | null;
  kode_shift: number | string | null;
}

/** Cermin `angka_json`: bilangan bulat dari angka atau teks angka. */
function angkaJson(nilai: unknown): number | null {
  if (typeof nilai === "number")
    return Number.isSafeInteger(nilai) ? nilai : null;
  if (typeof nilai === "string" && /^[+-]?\d+$/.test(nilai.trim())) {
    return Number(nilai.trim());
  }
  return null;
}

export interface MasukanDisiplin {
  /** Rentang aktif (§21.4); dipotong `hari_ini`. */
  mulai: string;
  selesai: string;
  hari_ini: string;
  karyawan: KaryawanDisiplin;
  hari: readonly HariLaporan[];
  pengajuan: readonly PengajuanLaporan[];
  tukar: readonly TukarLaporan[];
  /** Tanggal WIB berlaporan perjalanan. */
  perjalanan: ReadonlySet<string>;
  kalender: Kalender;
  ambang: Ambang;
}

export type Ambang = [number, number, number, number];

export interface Disiplin {
  /** D = tepat + telat + alfa + kosong. */
  hari: number;
  tepat: number;
  telat: number;
  alfa: number;
  kosong: number;
  dikecualikan: number;
  /** Permil; `null` bila D = 0. */
  permil: number | null;
  ambang: Ambang;
  /** `null` bila D = 0: penilai mengisi manual dengan catatan. */
  skor: number | null;
  /** `D|tepat|telat|alfa|kosong|dikecualikan|P|a5,a4,a3,a2`; P kosong bila D = 0. */
  rincian: string;
}

/** Cermin `kode_tercatat`, sama dengan `kodeTercatat` laporan kehadiran. */
function kodeTercatat(hari: HariLaporan | undefined): string | null {
  if (!hari) return null;
  if (angkaJson(hari.hadir) === 1) {
    return (angkaJson(hari.telat) ?? 0) > 0 ? "T" : "H";
  }
  if (angkaJson(hari.sakit) === 1) return "S";
  if (angkaJson(hari.izin) === 1) return "I";
  if (angkaJson(hari.dispensasi) === 1) return "D";
  if (angkaJson(hari.alfa) === 1) return "A";
  return null;
}

/** Cermin `skor_disiplin`. */
export function skorDisiplin(permil: number, ambang: Ambang): number {
  const i = ambang.findIndex((a) => permil >= a);
  return i === -1 ? 1 : 5 - i;
}

/** Cermin `hitung_disiplin` (Q-75, Q-76). */
export function hitungDisiplin(m: MasukanDisiplin): Disiplin {
  const akhir = m.selesai < m.hari_ini ? m.selesai : m.hari_ini;
  const tanggal = m.mulai <= akhir ? tanggalRentang(m.mulai, akhir) : [];
  const catatan = new Map(m.hari.map((h) => [h.tanggal, h]));
  const tukar = new Map<string, TukarLaporan>();
  for (const t of m.tukar) if (!tukar.has(t.tanggal)) tukar.set(t.tanggal, t);
  const dijadwalkan = (t: string) => {
    const jadwal = tukar.get(t) ?? m.karyawan;
    const kodeShift = angkaJson(jadwal.kode_shift);
    const libur = m.kalender.libur.has(t);
    const masukSaatLibur =
      libur &&
      evaluateHolidayScan(m.kalender.whitelist, {
        tanggal: t,
        divisi: m.karyawan.divisi,
        kodeShift,
      }).allowed;
    return wajibMasuk({
      tanggal: t,
      hariMasuk: parseHariKerja(jadwal.hari_kerja),
      libur,
      masukSaatLibur,
    });
  };
  const ajuan = (t: string) =>
    m.pengajuan.some(
      (p) =>
        (KELOMPOK_TIDAK_HADIR as readonly string[]).includes(p.kelompok) &&
        p.mulai <= t &&
        t <= p.selesai,
    );
  let tepat = 0;
  let telat = 0;
  let alfa = 0;
  let kosong = 0;
  let dikecualikan = 0;
  for (const t of tanggal) {
    const kode = kodeTercatat(catatan.get(t));
    if (kode === "H") tepat++;
    else if (kode === "T") telat++;
    else if (m.perjalanan.has(t)) tepat++;
    else if (ajuan(t) && (kode !== null || dijadwalkan(t))) dikecualikan++;
    else if (kode === "S" || kode === "I" || kode === "D") dikecualikan++;
    else if (kode !== null) alfa++;
    else if (dijadwalkan(t)) kosong++;
  }
  const hari = tepat + telat + alfa + kosong;
  const permil =
    hari > 0 ? Math.floor(((2 * tepat + telat) * 1000) / (2 * hari)) : null;
  const a = m.ambang;
  return {
    hari,
    tepat,
    telat,
    alfa,
    kosong,
    dikecualikan,
    permil,
    ambang: [a[0], a[1], a[2], a[3]],
    skor: permil === null ? null : skorDisiplin(permil, a),
    rincian: `${hari}|${tepat}|${telat}|${alfa}|${kosong}|${dikecualikan}|${permil ?? ""}|${a.join(",")}`,
  };
}

/** Cermin `rincian_sah`. */
export function rincianSah(rincian: string): boolean {
  const bagian = rincian.split("|");
  if (bagian.length !== 8) return false;
  const angka = bagian
    .slice(0, 6)
    .map((s) => (/^\d+$/.test(s) ? Number(s) : null));
  if (angka.some((n) => n === null)) return false;
  const [d, tepat, telat, alfa, kosong] = angka as number[];
  if (d !== tepat + telat + alfa + kosong) return false;
  const p = bagian[6];
  const permilSah = d === 0 ? p === "" : /^\d+$/.test(p) && Number(p) <= 1000;
  return permilSah && bacaAmbang(bagian[7]).ok;
}

// ── Nilai akhir dan predikat (§21.7) ───────────────────────────────────────

/** Cermin `nilai_akhir` (Q-74). `null` bila ada skor kosong. */
export function nilaiAkhir(baris: readonly BarisNilai[]): number | null {
  let total = 0;
  for (const b of baris) {
    if (b.skor === null) return null;
    total += b.bobot * 25 * (b.skor - 1);
  }
  return total;
}

/** Cermin `format_nilai`: 7750 → `77,50`. */
export function formatNilai(nilai: number): string {
  return `${Math.trunc(nilai / 100)},${String(nilai % 100).padStart(2, "0")}`;
}

export interface Predikat {
  /** Nilai akhir ×100 minimal. */
  ambang: number;
  nama: string;
}

/** Cermin `predikat`. */
export function predikatNilai(
  nilai: number,
  daftar: readonly Predikat[],
): string {
  return (daftar.find((p) => p.ambang <= nilai) ?? daftar.at(-1))?.nama ?? "";
}

// ── Pengaturan (§21.2) ─────────────────────────────────────────────────────

/** Cermin `baca_ambang`. */
export function bacaAmbang(teks: string): Hasil<Ambang> {
  const bagian = teks.split(",").map((s) => s.trim());
  const angka = bagian.map((s) => (/^[+-]?\d+$/.test(s) ? Number(s) : null));
  if (angka.length === 4 && angka.every((n) => n !== null)) {
    const [a5, a4, a3, a2] = angka as number[];
    if (a5 >= 1 && a5 <= 1000 && a5 > a4 && a4 > a3 && a3 > a2 && a2 >= 1) {
      return ok([a5, a4, a3, a2]);
    }
  }
  return gagal(PESAN_AMBANG);
}

/** Cermin `baca_predikat`. */
export function bacaPredikat(teks: string): Hasil<Predikat[]> {
  const bagian = teks.split("|");
  if (bagian.length < 2 || bagian.length > 7) {
    return gagal("Predikat harus 2 sampai 7 tingkat.");
  }
  const pesanBentuk =
    "Setiap predikat berbentuk ambang:nama, misalnya 7500:Baik.";
  const pesanUrut = "Ambang predikat harus turun dan yang terakhir 0.";
  const hasil: Predikat[] = [];
  for (const b of bagian) {
    const titik = b.indexOf(":");
    if (titik === -1) return gagal(pesanBentuk);
    const ambangTeks = b.slice(0, titik).trim();
    const ambang = /^[+-]?\d+$/.test(ambangTeks) ? Number(ambangTeks) : null;
    if (ambang === null || ambang < 0 || ambang > NILAI_MAKS) {
      return gagal(pesanBentuk);
    }
    const nama = b.slice(titik + 1).trim();
    if (
      nama === "" ||
      panjang(nama) > MAKS_NAMA_PREDIKAT ||
      nama.includes(":")
    ) {
      return gagal("Nama predikat 1 sampai 50 karakter, tanpa tanda : dan |.");
    }
    const sebelum = hasil.at(-1);
    if (sebelum && sebelum.ambang <= ambang) return gagal(pesanUrut);
    hasil.push({ ambang, nama });
  }
  if (hasil.at(-1)?.ambang !== 0) return gagal(pesanUrut);
  return ok(hasil);
}

export interface PengaturanKinerja {
  periode: string;
  ambang: Ambang;
  predikat: Predikat[];
}

/** Cermin `PengaturanKinerja::dari_peta`. Kosong atau rusak = bawaan. */
export function pengaturanKinerjaDariPeta(
  peta: ReadonlyMap<string, string>,
): PengaturanKinerja {
  const periode = peta.get(KUNCI_PERIODE)?.trim() ?? "";
  const ambang = bacaAmbang(peta.get(KUNCI_AMBANG) ?? "");
  const predikat = bacaPredikat(peta.get(KUNCI_PREDIKAT) ?? "");
  const bawaan = bacaPredikat(PREDIKAT_BAWAAN);
  return {
    periode: (PERIODE_JENIS as readonly string[]).includes(periode)
      ? periode
      : PERIODE_BAWAAN,
    ambang: ambang.ok ? ambang.nilai : [...AMBANG_BAWAAN],
    predikat: predikat.ok ? predikat.nilai : bawaan.ok ? bawaan.nilai : [],
  };
}

/** Cermin `validasi_pengaturan_kinerja`: pasangan kunci-nilai kanonik. */
export function validasiPengaturanKinerja(
  masukan: unknown,
): Hasil<[string, string][]> {
  const draft = objek(masukan);
  const periode = teks(draft, KUNCI_PERIODE);
  if (!(PERIODE_JENIS as readonly string[]).includes(periode)) {
    return gagal(
      "Jenis periode harus Bulanan, Kuartal, Semester, atau Tahunan.",
    );
  }
  const ambang = bacaAmbang(teks(draft, KUNCI_AMBANG));
  if (!ambang.ok) return ambang;
  const predikat = bacaPredikat(teks(draft, KUNCI_PREDIKAT));
  if (!predikat.ok) return predikat;
  return ok([
    [KUNCI_PERIODE, periode],
    [KUNCI_AMBANG, ambang.nilai.join(",")],
    [
      KUNCI_PREDIKAT,
      predikat.nilai.map((p) => `${p.ambang}:${p.nama}`).join("|"),
    ],
  ]);
}

// ── SQL penulisan cloud dan pembacaan (§21.2, §21.9). Teks WAJIB sama dengan
// `desktop/hr_kinerja.rs`; Web menulis langsung ke database cloud.

export const CLOUD_UPSERT_TEMPLATE_SQL =
  "INSERT INTO hr_kinerja_template (id_template, nama, keterangan, is_bawaan, is_aktif, diubah_oleh, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, COALESCE(?7, datetime('now')), datetime('now')) ON CONFLICT(id_template) DO UPDATE SET nama = excluded.nama, keterangan = excluded.keterangan, is_bawaan = excluded.is_bawaan, is_aktif = excluded.is_aktif, diubah_oleh = excluded.diubah_oleh, updated_at = datetime('now');";
export const CLOUD_SATU_BAWAAN_SQL =
  "UPDATE hr_kinerja_template SET is_bawaan = 0, updated_at = datetime('now') WHERE is_bawaan = 1 AND id_template <> ?1;";
export const CLOUD_UPSERT_ASPEK_SQL =
  "INSERT INTO hr_kinerja_aspek (id_aspek, id_template, nama, tipe, bobot, panduan, urutan, is_aktif, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, COALESCE(?9, datetime('now')), datetime('now')) ON CONFLICT(id_aspek) DO UPDATE SET nama = excluded.nama, bobot = excluded.bobot, panduan = excluded.panduan, urutan = excluded.urutan, is_aktif = excluded.is_aktif, updated_at = datetime('now');";
export const CLOUD_UPSERT_JABATAN_SQL =
  "INSERT INTO hr_kinerja_jabatan (id_jabatan, id_template, diubah_oleh, updated_at) VALUES (?1, ?2, ?3, datetime('now')) ON CONFLICT(id_jabatan) DO UPDATE SET id_template = excluded.id_template, diubah_oleh = excluded.diubah_oleh, updated_at = datetime('now') WHERE excluded.id_template IS NOT NULL OR hr_kinerja_jabatan.id_template = ?4;";
export const CLOUD_UPSERT_PENILAIAN_SQL =
  "INSERT INTO hr_kinerja_penilaian (id_penilaian, id_karyawan, id_ref, alasan_koreksi, periode_jenis, periode_mulai, periode_selesai, id_template, template_nama, id_jabatan, jabatan_nama, id_penilai, penilai_oleh, catatan, sidik, dibuat_oleh, waktu_perangkat, created_at, updated_at) SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, COALESCE(?18, datetime('now')), datetime('now') WHERE NOT EXISTS (SELECT 1 FROM hr_kinerja_keputusan k WHERE k.id_penilaian = ?1 AND k.jenis IN ('Final', 'Batal')) ON CONFLICT(id_penilaian) DO UPDATE SET alasan_koreksi = excluded.alasan_koreksi, id_template = excluded.id_template, template_nama = excluded.template_nama, id_jabatan = excluded.id_jabatan, jabatan_nama = excluded.jabatan_nama, id_penilai = excluded.id_penilai, penilai_oleh = excluded.penilai_oleh, catatan = excluded.catatan, sidik = excluded.sidik, waktu_perangkat = excluded.waktu_perangkat, updated_at = datetime('now');";
export const CLOUD_BUANG_NILAI_SQL =
  "DELETE FROM hr_kinerja_nilai WHERE id_penilaian = ?1 AND id_nilai NOT IN (SELECT value FROM json_each(?2)) AND NOT EXISTS (SELECT 1 FROM hr_kinerja_keputusan k WHERE k.id_penilaian = ?1 AND k.jenis IN ('Final', 'Batal'));";
export const CLOUD_UPSERT_NILAI_SQL =
  "INSERT INTO hr_kinerja_nilai (id_nilai, id_penilaian, id_aspek, aspek_nama, tipe, bobot, urutan, skor, catatan, rincian) SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10 WHERE NOT EXISTS (SELECT 1 FROM hr_kinerja_keputusan k WHERE k.id_penilaian = ?2 AND k.jenis IN ('Final', 'Batal')) ON CONFLICT(id_nilai) DO UPDATE SET aspek_nama = excluded.aspek_nama, tipe = excluded.tipe, bobot = excluded.bobot, urutan = excluded.urutan, skor = excluded.skor, catatan = excluded.catatan, rincian = excluded.rincian;";
export const CLOUD_INSERT_KEPUTUSAN_SQL =
  "INSERT INTO hr_kinerja_keputusan (id_keputusan, id_penilaian, jenis, sidik, alasan, nilai_akhir, predikat, oleh, waktu_perangkat, diterima_cloud, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, datetime('now'), COALESCE(?10, datetime('now'))) ON CONFLICT(id_keputusan) DO NOTHING;";
export const SP_PERIODE_SQL =
  "SELECT id_sp, tingkat, tanggal, berlaku_sampai, nomor, pelanggaran FROM hr_sp WHERE id_karyawan = ?1 AND dicabut_pada IS NULL AND tanggal <= ?3 AND berlaku_sampai >= ?2 ORDER BY tanggal, id_sp;";
export const WAKTU_KEPUTUSAN_SQL =
  "SELECT strftime('%Y-%m-%d %H:%M:%f', MAX(julianday('now'), COALESCE((SELECT julianday(MAX(waktu_perangkat)) FROM hr_kinerja_keputusan WHERE id_penilaian = ?1), 0) + 0.0015 / 86400.0));";
export const KARYAWAN_KINERJA_SQL =
  "SELECT m.id_unik, m.nama, COALESCE(m.divisi, ''), COALESCE(m.status_aktif, 'Aktif'), m.id_keluar, m.tanggal_daftar, m.tanggal_selesai_aktif, m.id_jabatan, COALESCE(j.nama, m.jabatan_status), m.id_atasan FROM master_data m LEFT JOIN hr_jabatan j ON j.id_jabatan = m.id_jabatan WHERE (?1 IS NULL OR m.id_unik = ?1) ORDER BY m.nama;";
export const IZIN_VIEW = "hr.performance.view";
export const IZIN_ASSESS = "hr.performance.assess";
export const IZIN_CONFIG = "hr.performance.config";
export const IZIN_FINALIZE = "hr.performance.finalize";
export const PESAN_TANPA_TEMPLATE =
  "Belum ada template untuk jabatan karyawan ini, dan belum ada template bawaan.";
export const PESAN_FINAL_LAMA =
  "Penilaian ini punya keputusan Final versi lama; isinya tidak bisa diubah lagi. Ajukan lalu finalkan versi sekarang.";
export const PESAN_BELUM_FINAL_SENDIRI =
  "Penilaian atas dirimu sendiri baru bisa dilihat setelah final.";
export const PESAN_SP_OFFLINE = "SP butuh koneksi ke database pusat.";
