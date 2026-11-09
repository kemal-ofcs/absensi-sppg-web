/**
 * Perjalanan driver / surat jalan (v34): aturan murni, cermin
 * `desktop/driver.rs`.
 *
 * Status, kendaraan, dan driver yang bertugas TIDAK disimpan: diturunkan dari
 * `drv_laporan` (append-only). Cloud tidak pernah menolak laporan karena
 * urutan; urutan diperiksa di perangkat (`periksaUrutan`), dan kejanggalan
 * dari offline muncul sebagai tanda tinjau (`tandaTinjau`).
 *
 * Diuji dengan vektor yang sama di kedua bahasa (`driver.test.ts` ↔
 * `mod tests` di `driver.rs`). Pesan galatnya pun wajib identik.
 */

import { z } from "zod";
import {
  type Hasil,
  isValidDate,
  MAKS_JUMLAH,
} from "@/lib/validations/inventory";
import { base64Sah } from "@/lib/validations/inventory-pengajuan";

export const JENIS_LAPORAN = [
  "Berangkat",
  "Tiba Muat",
  "Selesai Muat",
  "Tiba Bongkar",
  "Selesai Bongkar",
  "Kendala",
  "Ganti Kendaraan",
  "Ganti Driver",
  "Disetujui",
  "Ditolak",
  "Tidak Jalan",
  "Dibatalkan",
  "Selesai",
] as const;
export type JenisLaporan = (typeof JENIS_LAPORAN)[number];
export const JENIS_KENDALA = [
  "Macet",
  "Kendaraan Rusak",
  "Ban",
  "Kecelakaan",
  "Cuaca",
  "Antre Muat/Bongkar",
  "Lainnya",
] as const;
export const JENIS_LOKASI = ["Pool", "Muat", "Bongkar", "Lainnya"] as const;
export const STATUS_PERJALANAN = [
  "Direncanakan",
  "Berjalan",
  "Selesai",
  "Dibatalkan",
  "Tidak Jalan",
] as const;
export type StatusPerjalanan = (typeof STATUS_PERJALANAN)[number];

/** Jenis yang dikirim dari HP driver (`trip.report`). Sisanya milik dispatcher. */
const JENIS_DRIVER: readonly string[] = [
  "Berangkat",
  "Tiba Muat",
  "Selesai Muat",
  "Tiba Bongkar",
  "Selesai Bongkar",
  "Kendala",
  "Ganti Kendaraan",
  "Ganti Driver",
  "Selesai",
];
const JENIS_DISPATCHER: readonly string[] = [
  "Ganti Kendaraan",
  "Ganti Driver",
  "Disetujui",
  "Ditolak",
  "Tidak Jalan",
  "Dibatalkan",
  "Selesai",
];

export const MAKS_NAMA_DAFTAR = 60;
export const MAKS_TARIF = 100_000_000;
export const MAKS_IDENTITAS = 20;
export const MAKS_NAMA_KENDARAAN = 60;
export const MAKS_CATATAN = 500;
export const MAKS_NAMA_LOKASI = 120;
export const MAKS_BARIS_MUATAN = 100;
export const MAKS_TEMPAT = 120;
export const MAKS_NAMA_BARANG = 120;
export const MAKS_JENIS_BARANG = 60;
export const MAKS_SATUAN = 20;
/** Berat ×100 (dua desimal): 1.000 ton. */
export const MAKS_BERAT_X100 = 100_000_000;
export const MAKS_KETERANGAN = 500;
export const MAKS_TERLAMBAT_MENIT = 10_080;
/** ±150 KB setelah didekode; foto 960 px kualitas 0,6 rata-rata ±100 KB. */
export const MAKS_FOTO_BASE64 = 200_000;
export const MIME_FOTO = "image/jpeg";
export const PREFIX_BAWAAN = "SJ";
export const MAKS_PREFIX = 8;
export const AKURASI_PERINGATAN_M = 100;
export const KECEPATAN_MUSTAHIL_KMJ = 150;
/** Jam perangkat boleh mendahului jam cloud sebanyak ini sebelum ditandai. */
export const TOLERANSI_JAM_MAJU_DETIK = 300;

function panjang(text: string): number {
  return Array.from(text).length;
}

function bersih(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed ? trimmed : null;
}

function teks(
  value: string | null | undefined,
  maks: number,
  pesan: string,
): Hasil<string | null> {
  const nilai = bersih(value);
  if (nilai !== null && panjang(nilai) > maks)
    return { ok: false, error: pesan };
  return { ok: true, value: nilai };
}

function wajib(
  value: string | null | undefined,
  maks: number,
  kosong: string,
  kepanjangan: string,
): Hasil<string> {
  const hasil = teks(value, maks, kepanjangan);
  if (!hasil.ok) return hasil;
  if (hasil.value === null) return { ok: false, error: kosong };
  return { ok: true, value: hasil.value };
}

function gagal(error: string): { ok: false; error: string } {
  return { ok: false, error };
}

// ── Absensi dan gaji harian (PRD §7.4) ─────────────────────────────────────
// Laporan perjalanan driver pada tanggal WIB D = bekerja pada D. Penjelasan
// lengkap di `desktop/driver.rs`; kedua SQL WAJIB identik dengan Rust.

/** Cermin `PELAPOR_PERJALANAN_SQL`. `?1` = tanggal WIB `YYYY-MM-DD`. */
export const PELAPOR_PERJALANAN_SQL = `SELECT DISTINCT id_karyawan FROM drv_laporan
     WHERE id_karyawan IS NOT NULL
       AND waktu_perangkat >= datetime(?1, '-7 hours')
       AND waktu_perangkat < datetime(?1, '+17 hours');`;

/** Cermin `HARI_HADIR_SQL`: hari hadir gaji harian, periode `?1`..`?2`. */
export const HARI_HADIR_SQL = `(SELECT COUNT(*) FROM (
                SELECT a.tanggal FROM absensi_harian a
                WHERE a.id_karyawan = md.id_unik AND a.tanggal >= ?1 AND a.tanggal <= ?2
                  AND a.status_kehadiran IN ('Hadir', 'PRESENT')
                UNION
                SELECT date(l.waktu_perangkat, '+7 hours') FROM drv_laporan l
                WHERE l.id_karyawan = md.id_unik
                  AND l.waktu_perangkat >= datetime(?1, '-7 hours')
                  AND l.waktu_perangkat < datetime(?2, '+17 hours')
            ))`;

// ── Masa simpan foto 90 hari (PRD §6.3). Penjelasan di `desktop/driver.rs`. ──

/** Cermin `HAPUS_FOTO_LAMA_SQL`. */
export const HAPUS_FOTO_LAMA_SQL =
  "DELETE FROM drv_laporan_foto WHERE created_at < datetime('now', '-90 days');";

/** Cermin `FOTO_SEGERA_DIHAPUS_SQL`. */
export const FOTO_SEGERA_DIHAPUS_SQL = `SELECT COUNT(*) AS jumlah,
        MIN(date(l.waktu_perangkat, '+7 hours')) AS tanggal_tertua
     FROM drv_laporan_foto f LEFT JOIN drv_laporan l ON l.id_laporan = f.id_laporan
     WHERE f.created_at < datetime('now', '-83 days');`;

export interface FotoSegeraDihapus {
  jumlah: number;
  tanggal_tertua: string | null;
}

// ── Nomor surat jalan ──────────────────────────────────────────────────────

/** Cermin `normalisasi_prefix`. */
export function normalisasiPrefix(masukan: string): Hasil<string> {
  const prefix = masukan.trim().replace(/-+$/, "");
  if (!prefix) return gagal("Awalan nomor surat jalan wajib diisi.");
  if (panjang(prefix) > MAKS_PREFIX || !/^[A-Za-z0-9]+$/.test(prefix)) {
    return gagal(
      `Awalan nomor surat jalan hanya huruf dan angka, maksimal ${MAKS_PREFIX} karakter.`,
    );
  }
  return { ok: true, value: prefix.toUpperCase() };
}

/** Cermin `prefix_tersimpan`. */
export function prefixTersimpan(nilai: string | null | undefined): string {
  if (nilai == null) return PREFIX_BAWAAN;
  const hasil = normalisasiPrefix(nilai);
  return hasil.ok ? hasil.value : PREFIX_BAWAAN;
}

/** Cermin `format_nomor_surat_jalan`: `KRS-2611-WAB12-001`. */
export function formatNomorSuratJalan(
  prefix: string,
  tanggal: string,
  seri: string,
  nomorUrut: number,
): string {
  const yymm = tanggal.slice(2, 4) + tanggal.slice(5, 7);
  return `${prefix}-${yymm}-${seri}-${String(nomorUrut).padStart(3, "0")}`;
}

/** Cermin `id_muatan`. */
export function idMuatan(idPerjalanan: string, urutan: number): string {
  return `${idPerjalanan}-${urutan}`;
}

// ── Upah ───────────────────────────────────────────────────────────────────

/** Cermin `upah_surat_jalan`. */
export function upahSuratJalan(
  tarifKendaraan: number,
  tarifTujuan: number,
): number {
  return tarifKendaraan + tarifTujuan;
}

/** Cermin `penerima_upah`. */
export function penerimaUpah(
  status: string,
  idKaryawanUpah: string | null,
  laporan: readonly Laporan[],
  bertugas: string,
): string | null {
  if (status !== "Selesai") return null;
  const penutup =
    urutkan(laporan)
      .reverse()
      .find((l) => l.jenis === "Selesai")?.id_karyawan ?? null;
  return idKaryawanUpah ?? penutup ?? bertugas;
}

// ── Status dan penugasan turunan ───────────────────────────────────────────

/** Cermin `Laporan`: satu baris `drv_laporan` sebanyak yang dibutuhkan. */
export interface Laporan {
  id_laporan: string;
  jenis: string;
  mode_ganti?: string | null;
  id_ref?: string | null;
  waktu_perangkat: string;
  diterima_cloud?: string | null;
  id_karyawan?: string | null;
  id_karyawan_baru?: string | null;
  id_kendaraan_baru?: string | null;
  id_lokasi?: string | null;
  lat?: number | null;
  lng?: number | null;
  akurasi_m?: number | null;
  foto_sha256?: string | null;
}

function banding(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Cermin `urutkan`: jam perangkat, id sebagai penentu seri. */
export function urutkan<T extends Laporan>(laporan: readonly T[]): T[] {
  return [...laporan].sort(
    (a, b) =>
      banding(a.waktu_perangkat, b.waktu_perangkat) ||
      banding(a.id_laporan, b.id_laporan),
  );
}

const JENIS_JALAN: readonly string[] = [
  "Berangkat",
  "Tiba Muat",
  "Selesai Muat",
  "Tiba Bongkar",
  "Selesai Bongkar",
];

/** Cermin `status_perjalanan`, diperiksa berurutan. */
export function statusPerjalanan(
  laporan: readonly Laporan[],
): StatusPerjalanan {
  const ada = (jenis: string) => laporan.some((l) => l.jenis === jenis);
  if (ada("Tidak Jalan")) return "Tidak Jalan";
  if (ada("Dibatalkan")) return "Dibatalkan";
  if (ada("Selesai")) return "Selesai";
  if (laporan.some((l) => JENIS_JALAN.includes(l.jenis))) return "Berjalan";
  return "Direncanakan";
}

function keputusanTerakhir(
  laporan: readonly Laporan[],
  idGanti: string,
): string | null {
  return (
    urutkan(laporan)
      .reverse()
      .find(
        (l) =>
          (l.jenis === "Disetujui" || l.jenis === "Ditolak") &&
          l.id_ref === idGanti,
      )?.jenis ?? null
  );
}

/** Cermin `ganti_berlaku`. */
export function gantiBerlaku(
  laporan: readonly Laporan[],
  ganti: Laporan,
): boolean {
  if (ganti.mode_ganti === "Langsung" || ganti.mode_ganti === "Darurat") {
    return true;
  }
  if (ganti.mode_ganti === "Minta Izin") {
    return keputusanTerakhir(laporan, ganti.id_laporan) === "Disetujui";
  }
  return false;
}

export interface Penugasan {
  id_karyawan: string;
  id_kendaraan: string;
}

/** Cermin `penugasan`. */
export function penugasan(
  awalKaryawan: string,
  awalKendaraan: string,
  laporan: readonly Laporan[],
): Penugasan {
  const hasil = { id_karyawan: awalKaryawan, id_kendaraan: awalKendaraan };
  for (const l of urutkan(laporan)) {
    if (!gantiBerlaku(laporan, l)) continue;
    if (l.jenis === "Ganti Driver" && l.id_karyawan_baru) {
      hasil.id_karyawan = l.id_karyawan_baru;
    } else if (l.jenis === "Ganti Kendaraan" && l.id_kendaraan_baru) {
      hasil.id_kendaraan = l.id_kendaraan_baru;
    }
  }
  return hasil;
}

/** Cermin `ganti_menunggu`. */
export function gantiMenunggu(laporan: readonly Laporan[]): string[] {
  return urutkan(laporan)
    .filter((l) => l.mode_ganti === "Darurat" || l.mode_ganti === "Minta Izin")
    .filter((l) => keputusanTerakhir(laporan, l.id_laporan) === null)
    .map((l) => l.id_laporan);
}

/** Cermin `jenis_titik`. */
function jenisTitik(jenis: string): "muat" | "bongkar" | null {
  if (jenis === "Tiba Muat" || jenis === "Selesai Muat") return "muat";
  if (jenis === "Tiba Bongkar" || jenis === "Selesai Bongkar") return "bongkar";
  return null;
}

/** Cermin `titik_terbuka`. */
export function titikTerbuka(
  laporan: readonly Laporan[],
): "muat" | "bongkar" | null {
  const terakhir = urutkan(laporan)
    .reverse()
    .find((l) => jenisTitik(l.jenis) !== null);
  return terakhir?.jenis.startsWith("Tiba ")
    ? jenisTitik(terakhir.jenis)
    : null;
}

/** Cermin `periksa_urutan`. HANYA di perangkat. */
export function periksaUrutan(
  laporan: readonly Laporan[],
  jenis: string,
): Hasil<null> {
  if (jenis === "Disetujui" || jenis === "Ditolak")
    return { ok: true, value: null };
  const status = statusPerjalanan(laporan);
  if (
    status === "Selesai" ||
    status === "Dibatalkan" ||
    status === "Tidak Jalan"
  ) {
    return gagal("Perjalanan sudah ditutup.");
  }
  const berangkat = status === "Berjalan";
  const terbuka = titikTerbuka(laporan);
  if (jenis === "Berangkat" && berangkat)
    return gagal("Perjalanan sudah berangkat.");
  if (jenis === "Tidak Jalan" && berangkat) {
    return gagal(
      "Perjalanan yang sudah berangkat tidak bisa ditandai Tidak Jalan. Pakai Dibatalkan.",
    );
  }
  if (jenis === "Dibatalkan" && !berangkat) {
    return gagal("Perjalanan belum berangkat. Pakai Tidak Jalan.");
  }
  if (
    jenis === "Tiba Muat" ||
    jenis === "Tiba Bongkar" ||
    jenis === "Selesai"
  ) {
    if (!berangkat) return gagal("Laporkan Berangkat lebih dulu.");
    if (terbuka)
      return gagal(`Selesaikan dulu titik ${terbuka} yang sedang terbuka.`);
  }
  if (jenis === "Selesai Muat" && terbuka !== "muat") {
    return gagal("Laporkan Tiba Muat lebih dulu.");
  }
  if (jenis === "Selesai Bongkar" && terbuka !== "bongkar") {
    return gagal("Laporkan Tiba Bongkar lebih dulu.");
  }
  return { ok: true, value: null };
}

/** Cermin `validate_keputusan`. */
export function validateKeputusan(
  laporan: readonly Laporan[],
  idRef: string,
): Hasil<null> {
  const ganti = laporan.find(
    (l) => l.id_laporan === idRef && l.jenis.startsWith("Ganti "),
  );
  if (!ganti) return gagal("Laporan ganti tidak ditemukan.");
  if (ganti.mode_ganti !== "Darurat" && ganti.mode_ganti !== "Minta Izin") {
    return gagal("Ganti ini tidak memerlukan persetujuan.");
  }
  if (keputusanTerakhir(laporan, idRef) !== null) {
    return gagal("Ganti ini sudah diputuskan.");
  }
  return { ok: true, value: null };
}

// ── Waktu dan jarak ────────────────────────────────────────────────────────

/** Cermin `detik_utc`: `YYYY-MM-DD HH:MM:SS` (UTC) menjadi detik epoch. */
export function detikUtc(waktu: string): number | null {
  const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(waktu);
  if (!m || !isValidDate(m[1])) return null;
  const [jam, menit, detik] = [Number(m[2]), Number(m[3]), Number(m[4])];
  if (jam > 23 || menit > 59 || detik > 59) return null;
  const [y, bln, tgl] = m[1].split("-").map(Number);
  return Date.UTC(y, bln - 1, tgl, jam, menit, detik) / 1000;
}

/** Cermin `jarak_meter` (Haversine, jari-jari bumi 6.371 km). */
export function jarakMeter(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const rad = (v: number) => (v * Math.PI) / 180;
  const dlat = rad(lat2 - lat1);
  const dlng = rad(lng2 - lng1);
  const a =
    Math.sin(dlat / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dlng / 2) ** 2;
  return 2 * 6_371_000 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ── Tanda tinjau ───────────────────────────────────────────────────────────

export interface LokasiTerdaftar {
  id_lokasi: string;
  lat: number;
  lng: number;
  radius_m: number;
}

export interface MuatanRencana {
  id_muatan: string;
  qty: number;
}

export interface MuatanLapor {
  id_laporan: string;
  id_muatan: string;
  qty: number;
}

export const KODE_TANDA = [
  "urutan_janggal",
  "jam_maju",
  "tanpa_gps",
  "tanpa_foto",
  "akurasi_nol",
  "akurasi_buruk",
  "luar_radius",
  "kecepatan_mustahil",
  "menunggu_persetujuan",
  "muat_beda",
  "sisa_muatan",
] as const;
export type KodeTanda = (typeof KODE_TANDA)[number];

/** `id` = id laporan, atau id muatan untuk `muat_beda` dan `sisa_muatan`. */
export interface Tanda {
  kode: KodeTanda;
  id: string;
}

/** Cermin `tanda_tinjau`. Tidak ada yang ditolak, semua masuk "Perlu ditinjau". */
export function tandaTinjau(
  laporan: readonly Laporan[],
  lokasi: readonly LokasiTerdaftar[],
  rencana: readonly MuatanRencana[],
  dilapor: readonly MuatanLapor[],
  ambangAkurasiM: number,
): Tanda[] {
  const urut = urutkan(laporan);
  const hasil: Tanda[] = [];

  let jalan = false;
  let tutup = false;
  let terbuka: string | null = null;
  for (const l of urut) {
    let janggal = false;
    switch (l.jenis) {
      case "Berangkat":
        janggal = jalan || tutup;
        jalan = true;
        break;
      case "Tiba Muat":
      case "Tiba Bongkar":
        janggal = !jalan || tutup || terbuka !== null;
        terbuka = jenisTitik(l.jenis);
        break;
      case "Selesai Muat":
      case "Selesai Bongkar":
        janggal = terbuka !== jenisTitik(l.jenis);
        terbuka = null;
        break;
      case "Selesai":
      case "Dibatalkan":
        janggal = !jalan || tutup || terbuka !== null;
        tutup = true;
        break;
      case "Tidak Jalan":
        janggal = jalan || tutup;
        tutup = true;
        break;
    }
    if (janggal) hasil.push({ kode: "urutan_janggal", id: l.id_laporan });
  }

  for (const l of urut) {
    const perangkat = detikUtc(l.waktu_perangkat);
    const cloud = l.diterima_cloud ? detikUtc(l.diterima_cloud) : null;
    if (
      perangkat !== null &&
      cloud !== null &&
      perangkat - cloud > TOLERANSI_JAM_MAJU_DETIK
    ) {
      hasil.push({ kode: "jam_maju", id: l.id_laporan });
    }
    const dariDriver = l.id_karyawan != null;
    if (dariDriver && (l.lat == null || l.lng == null)) {
      hasil.push({ kode: "tanpa_gps", id: l.id_laporan });
    }
    if (dariDriver && l.foto_sha256 == null) {
      hasil.push({ kode: "tanpa_foto", id: l.id_laporan });
    }
    if (l.akurasi_m === 0) {
      hasil.push({ kode: "akurasi_nol", id: l.id_laporan });
    } else if (l.akurasi_m != null && l.akurasi_m > ambangAkurasiM) {
      hasil.push({ kode: "akurasi_buruk", id: l.id_laporan });
    }
    if (l.id_lokasi != null && l.lat != null && l.lng != null) {
      const titik = lokasi.find((t) => t.id_lokasi === l.id_lokasi);
      if (titik) {
        const jarak =
          jarakMeter(l.lat, l.lng, titik.lat, titik.lng) - (l.akurasi_m ?? 0);
        if (jarak > titik.radius_m) {
          hasil.push({ kode: "luar_radius", id: l.id_laporan });
        }
      }
    }
  }

  const berkoordinat = urut.flatMap((l) => {
    const t = detikUtc(l.waktu_perangkat);
    return l.lat != null && l.lng != null && t !== null
      ? [{ l, lat: l.lat, lng: l.lng, t }]
      : [];
  });
  for (let i = 1; i < berkoordinat.length; i++) {
    const a = berkoordinat[i - 1];
    const b = berkoordinat[i];
    const meleset = (a.l.akurasi_m ?? 0) + (b.l.akurasi_m ?? 0);
    const jarak = Math.max(jarakMeter(a.lat, a.lng, b.lat, b.lng) - meleset, 0);
    const kmj = (jarak / Math.max(b.t - a.t, 1)) * 3.6;
    if (kmj > KECEPATAN_MUSTAHIL_KMJ) {
      hasil.push({ kode: "kecepatan_mustahil", id: b.l.id_laporan });
    }
  }

  for (const id of gantiMenunggu(laporan)) {
    hasil.push({ kode: "menunggu_persetujuan", id });
  }

  const jumlah = (jenis: string, idMuatan: string) => {
    const baris = dilapor
      .filter((m) => m.id_muatan === idMuatan)
      .filter((m) =>
        laporan.some((l) => l.id_laporan === m.id_laporan && l.jenis === jenis),
      )
      .map((m) => m.qty);
    return { ada: baris.length > 0, total: baris.reduce((s, q) => s + q, 0) };
  };
  const selesai = statusPerjalanan(laporan) === "Selesai";
  for (const m of rencana) {
    const muat = jumlah("Selesai Muat", m.id_muatan);
    if ((muat.ada || selesai) && muat.total !== m.qty) {
      hasil.push({ kode: "muat_beda", id: m.id_muatan });
    }
    if (
      selesai &&
      muat.total !== jumlah("Selesai Bongkar", m.id_muatan).total
    ) {
      hasil.push({ kode: "sisa_muatan", id: m.id_muatan });
    }
  }
  return hasil;
}

// ── Validasi isian ─────────────────────────────────────────────────────────

/** Cermin `DaftarTarifDraft` (`deny_unknown_fields`). */
export const daftarTarifDraftSchema = z
  .object({
    id: z.string().max(160).nullable().optional(),
    nama: z.string().max(1000).nullable().optional(),
    tarif: z.number().int().default(0),
    status_aktif: z.boolean().default(true),
  })
  .strict();
export type DaftarTarifDraft = z.output<typeof daftarTarifDraftSchema>;

export interface DaftarTarifValid {
  nama: string;
  tarif: number;
  status_aktif: boolean;
}

/** Cermin `validate_daftar_tarif`. */
export function validateDaftarTarif(
  draft: DaftarTarifDraft,
  label: string,
): Hasil<DaftarTarifValid> {
  const nama = wajib(
    draft.nama,
    MAKS_NAMA_DAFTAR,
    `Nama ${label} wajib diisi.`,
    `Nama ${label} maksimal ${MAKS_NAMA_DAFTAR} karakter.`,
  );
  if (!nama.ok) return nama;
  if (draft.tarif < 0 || draft.tarif > MAKS_TARIF) {
    return gagal("Tarif harus 0 sampai Rp100.000.000.");
  }
  return {
    ok: true,
    value: {
      nama: nama.value,
      tarif: draft.tarif,
      status_aktif: draft.status_aktif,
    },
  };
}

/** Cermin `normalisasi_identitas`. */
export function normalisasiIdentitas(identitas: string): string {
  return identitas.split(/\s+/).filter(Boolean).join(" ").toUpperCase();
}

/** Cermin `KendaraanDraft`. */
export const kendaraanDraftSchema = z
  .object({
    id_kendaraan: z.string().max(160).nullable().optional(),
    id_jenis: z.string().max(160).nullable().optional(),
    identitas: z.string().max(200).nullable().optional(),
    nama: z.string().max(1000).nullable().optional(),
    catatan: z.string().max(4000).nullable().optional(),
    status_aktif: z.boolean().default(true),
  })
  .strict();
export type KendaraanDraft = z.output<typeof kendaraanDraftSchema>;

export interface KendaraanValid {
  id_jenis: string;
  identitas: string;
  nama: string | null;
  catatan: string | null;
  status_aktif: boolean;
}

/** Cermin `validate_kendaraan`. */
export function validateKendaraan(
  draft: KendaraanDraft,
): Hasil<KendaraanValid> {
  const id_jenis = bersih(draft.id_jenis);
  if (!id_jenis) return gagal("Pilih jenis kendaraan.");
  const identitas = normalisasiIdentitas(draft.identitas ?? "");
  if (!identitas) return gagal("Plat atau nomor kendaraan wajib diisi.");
  if (panjang(identitas) > MAKS_IDENTITAS) {
    return gagal(
      `Plat atau nomor kendaraan maksimal ${MAKS_IDENTITAS} karakter.`,
    );
  }
  const nama = teks(
    draft.nama,
    MAKS_NAMA_KENDARAAN,
    `Nama kendaraan maksimal ${MAKS_NAMA_KENDARAAN} karakter.`,
  );
  if (!nama.ok) return nama;
  const catatan = teks(
    draft.catatan,
    MAKS_CATATAN,
    `Catatan maksimal ${MAKS_CATATAN} karakter.`,
  );
  if (!catatan.ok) return catatan;
  return {
    ok: true,
    value: {
      id_jenis,
      identitas,
      nama: nama.value,
      catatan: catatan.value,
      status_aktif: draft.status_aktif,
    },
  };
}

function koordinatSah(lat: number, lng: number): boolean {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= -90 &&
    lat <= 90 &&
    lng >= -180 &&
    lng <= 180
  );
}

/** Cermin `LokasiDraft`. */
export const lokasiDraftSchema = z
  .object({
    id_lokasi: z.string().max(160).nullable().optional(),
    nama: z.string().max(1000).nullable().optional(),
    jenis: z.string().max(40).default(""),
    lat: z.number().default(0),
    lng: z.number().default(0),
    radius_m: z.number().int().default(200),
    status_aktif: z.boolean().default(true),
  })
  .strict();
export type LokasiDraft = z.output<typeof lokasiDraftSchema>;

export interface LokasiValid {
  nama: string;
  jenis: string;
  lat: number;
  lng: number;
  radius_m: number;
  status_aktif: boolean;
}

/** Cermin `validate_lokasi`. */
export function validateLokasi(draft: LokasiDraft): Hasil<LokasiValid> {
  const nama = wajib(
    draft.nama,
    MAKS_NAMA_LOKASI,
    "Nama lokasi wajib diisi.",
    `Nama lokasi maksimal ${MAKS_NAMA_LOKASI} karakter.`,
  );
  if (!nama.ok) return nama;
  if (!(JENIS_LOKASI as readonly string[]).includes(draft.jenis)) {
    return gagal("Pilih jenis lokasi.");
  }
  if (!koordinatSah(draft.lat, draft.lng))
    return gagal("Koordinat tidak valid.");
  if (draft.lat === 0 && draft.lng === 0) {
    return gagal("Ambil koordinat lokasi lebih dulu.");
  }
  if (draft.radius_m < 10 || draft.radius_m > 10_000) {
    return gagal("Radius 10 sampai 10.000 meter.");
  }
  return {
    ok: true,
    value: {
      nama: nama.value,
      jenis: draft.jenis,
      lat: draft.lat,
      lng: draft.lng,
      radius_m: draft.radius_m,
      status_aktif: draft.status_aktif,
    },
  };
}

/** Cermin `MuatanDraft`. */
const muatanDraftSchema = z
  .object({
    tempat_muat: z.string().max(1000).nullable().optional(),
    tempat_bongkar: z.string().max(1000).nullable().optional(),
    nama_barang: z.string().max(1000).nullable().optional(),
    jenis_barang: z.string().max(1000).nullable().optional(),
    qty: z.number().int().default(0),
    satuan: z.string().max(200).nullable().optional(),
    berat_kg_x100: z.number().int().nullable().optional(),
  })
  .strict();

/** Cermin `PerjalananDraft`. */
export const perjalananDraftSchema = z
  .object({
    id_perjalanan: z.string().max(160).nullable().optional(),
    tanggal: z.string().max(10).default(""),
    id_karyawan: z.string().max(160).nullable().optional(),
    id_kendaraan: z.string().max(160).nullable().optional(),
    id_kategori: z.string().max(160).nullable().optional(),
    catatan: z.string().max(4000).nullable().optional(),
    // Batas longgar penahan beban; pesan batas sebenarnya dari validatePerjalanan.
    muatan: z.array(muatanDraftSchema).max(1000).default([]),
  })
  .strict();
export type PerjalananDraft = z.output<typeof perjalananDraftSchema>;

export interface MuatanValid {
  tempat_muat: string;
  tempat_bongkar: string | null;
  nama_barang: string;
  jenis_barang: string | null;
  qty: number;
  satuan: string;
  berat_kg_x100: number | null;
}

export interface PerjalananValid {
  tanggal: string;
  id_karyawan: string;
  id_kendaraan: string;
  id_kategori: string;
  catatan: string | null;
  muatan: MuatanValid[];
}

function beratSah(berat: number | null | undefined): boolean {
  return berat == null || (berat >= 0 && berat <= MAKS_BERAT_X100);
}

/** Cermin `validate_perjalanan`. */
export function validatePerjalanan(
  draft: PerjalananDraft,
): Hasil<PerjalananValid> {
  const tanggal = draft.tanggal.trim();
  if (!isValidDate(tanggal)) return gagal("Tanggal surat jalan tidak valid.");
  const id_karyawan = bersih(draft.id_karyawan);
  if (!id_karyawan) return gagal("Pilih driver.");
  const id_kendaraan = bersih(draft.id_kendaraan);
  if (!id_kendaraan) return gagal("Pilih kendaraan.");
  const id_kategori = bersih(draft.id_kategori);
  if (!id_kategori) return gagal("Pilih kategori tujuan.");
  const catatan = teks(
    draft.catatan,
    MAKS_CATATAN,
    `Catatan maksimal ${MAKS_CATATAN} karakter.`,
  );
  if (!catatan.ok) return catatan;
  if (draft.muatan.length === 0)
    return gagal("Isi minimal satu barang muatan.");
  if (draft.muatan.length > MAKS_BARIS_MUATAN) {
    return gagal(`Paling banyak ${MAKS_BARIS_MUATAN} baris muatan.`);
  }
  const muatan: MuatanValid[] = [];
  for (const [indeks, m] of draft.muatan.entries()) {
    const n = indeks + 1;
    const kepanjangan = (label: string, maks: number) =>
      `Baris ${n}: ${label} maksimal ${maks} karakter.`;
    const tempat_muat = wajib(
      m.tempat_muat,
      MAKS_TEMPAT,
      `Baris ${n}: tempat muat wajib diisi.`,
      kepanjangan("tempat muat", MAKS_TEMPAT),
    );
    if (!tempat_muat.ok) return tempat_muat;
    const tempat_bongkar = teks(
      m.tempat_bongkar,
      MAKS_TEMPAT,
      kepanjangan("tempat bongkar", MAKS_TEMPAT),
    );
    if (!tempat_bongkar.ok) return tempat_bongkar;
    const nama_barang = wajib(
      m.nama_barang,
      MAKS_NAMA_BARANG,
      `Baris ${n}: nama barang wajib diisi.`,
      kepanjangan("nama barang", MAKS_NAMA_BARANG),
    );
    if (!nama_barang.ok) return nama_barang;
    const jenis_barang = teks(
      m.jenis_barang,
      MAKS_JENIS_BARANG,
      kepanjangan("jenis barang", MAKS_JENIS_BARANG),
    );
    if (!jenis_barang.ok) return jenis_barang;
    if (m.qty < 1 || m.qty > MAKS_JUMLAH) {
      return gagal(`Baris ${n}: jumlah harus lebih dari 0.`);
    }
    const satuan = wajib(
      m.satuan,
      MAKS_SATUAN,
      `Baris ${n}: satuan wajib diisi.`,
      kepanjangan("satuan", MAKS_SATUAN),
    );
    if (!satuan.ok) return satuan;
    if (!beratSah(m.berat_kg_x100))
      return gagal(`Baris ${n}: berat tidak valid.`);
    muatan.push({
      tempat_muat: tempat_muat.value,
      tempat_bongkar: tempat_bongkar.value,
      nama_barang: nama_barang.value,
      jenis_barang: jenis_barang.value,
      qty: m.qty,
      satuan: satuan.value,
      berat_kg_x100: m.berat_kg_x100 ?? null,
    });
  }
  return {
    ok: true,
    value: {
      tanggal,
      id_karyawan,
      id_kendaraan,
      id_kategori,
      catatan: catatan.value,
      muatan,
    },
  };
}

/** Cermin `LaporanMuatanDraft`. */
const laporanMuatanDraftSchema = z
  .object({
    id_muatan: z.string().max(200).nullable().optional(),
    qty: z.number().int().default(0),
    berat_kg_x100: z.number().int().nullable().optional(),
  })
  .strict();

/** Cermin `LaporanDraft`. */
export const laporanDraftSchema = z
  .object({
    id_laporan: z.string().max(160).nullable().optional(),
    id_perjalanan: z.string().max(160).nullable().optional(),
    jenis: z.string().max(40).default(""),
    mode_ganti: z.string().max(40).nullable().optional(),
    id_ref: z.string().max(160).nullable().optional(),
    jenis_kendala: z.string().max(40).nullable().optional(),
    terlambat_menit: z.number().int().nullable().optional(),
    id_lokasi: z.string().max(160).nullable().optional(),
    nama_lokasi: z.string().max(1000).nullable().optional(),
    lat: z.number().nullable().optional(),
    lng: z.number().nullable().optional(),
    akurasi_m: z.number().nullable().optional(),
    waktu_perangkat: z.string().max(40).default(""),
    waktu_gps: z.string().max(40).nullable().optional(),
    id_karyawan_baru: z.string().max(160).nullable().optional(),
    id_kendaraan_baru: z.string().max(160).nullable().optional(),
    keterangan: z.string().max(4000).nullable().optional(),
    muatan: z.array(laporanMuatanDraftSchema).max(1000).default([]),
  })
  .strict();
export type LaporanDraft = z.output<typeof laporanDraftSchema>;

export interface LaporanMuatanValid {
  id_muatan: string;
  qty: number;
  berat_kg_x100: number | null;
}

export interface LaporanValid {
  id_perjalanan: string;
  jenis: string;
  mode_ganti: string | null;
  id_ref: string | null;
  jenis_kendala: string | null;
  terlambat_menit: number | null;
  id_lokasi: string | null;
  nama_lokasi: string | null;
  lat: number | null;
  lng: number | null;
  akurasi_m: number | null;
  waktu_perangkat: string;
  waktu_gps: string | null;
  id_karyawan_baru: string | null;
  id_kendaraan_baru: string | null;
  keterangan: string | null;
  muatan: LaporanMuatanValid[];
}

/** Cermin `validate_laporan`. */
export function validateLaporan(
  draft: LaporanDraft,
  olehDriver: boolean,
  adaFoto: boolean,
): Hasil<LaporanValid> {
  const jenis = draft.jenis;
  if (!(JENIS_LAPORAN as readonly string[]).includes(jenis)) {
    return gagal("Jenis laporan tidak dikenal.");
  }
  if (olehDriver && !JENIS_DRIVER.includes(jenis)) {
    return gagal("Jenis laporan ini hanya untuk dispatcher.");
  }
  if (!olehDriver && !JENIS_DISPATCHER.includes(jenis)) {
    return gagal("Jenis laporan ini hanya dari HP driver.");
  }
  const id_perjalanan = bersih(draft.id_perjalanan);
  if (!id_perjalanan) return gagal("Surat jalan wajib dipilih.");
  const ket = teks(
    draft.keterangan,
    MAKS_KETERANGAN,
    `Keterangan maksimal ${MAKS_KETERANGAN} karakter.`,
  );
  if (!ket.ok) return ket;
  const keterangan = ket.value;

  const ganti = jenis.startsWith("Ganti ");
  let mode_ganti: string | null = null;
  if (ganti && !olehDriver) mode_ganti = "Langsung";
  if (ganti && olehDriver) {
    if (draft.mode_ganti !== "Darurat" && draft.mode_ganti !== "Minta Izin") {
      return gagal("Pilih Darurat atau Minta Izin.");
    }
    mode_ganti = draft.mode_ganti;
  }
  let id_karyawan_baru: string | null = null;
  if (jenis === "Ganti Driver") {
    id_karyawan_baru = bersih(draft.id_karyawan_baru);
    if (!id_karyawan_baru) return gagal("Pilih driver pengganti.");
  }
  let id_kendaraan_baru: string | null = null;
  if (jenis === "Ganti Kendaraan") {
    id_kendaraan_baru = bersih(draft.id_kendaraan_baru);
    if (!id_kendaraan_baru) return gagal("Pilih kendaraan pengganti.");
  }
  let id_ref: string | null = null;
  if (jenis === "Disetujui" || jenis === "Ditolak") {
    id_ref = bersih(draft.id_ref);
    if (!id_ref) return gagal("Laporan yang diputuskan wajib dipilih.");
  }

  let jenis_kendala: string | null = null;
  let terlambat_menit: number | null = null;
  if (jenis === "Kendala") {
    const kendala = draft.jenis_kendala ?? "";
    if (!(JENIS_KENDALA as readonly string[]).includes(kendala)) {
      return gagal("Pilih jenis kendala.");
    }
    if (kendala === "Lainnya" && keterangan === null) {
      return gagal("Keterangan kendala wajib diisi.");
    }
    const menit = draft.terlambat_menit ?? null;
    if (menit !== null && (menit < 0 || menit > MAKS_TERLAMBAT_MENIT)) {
      return gagal(
        `Perkiraan terlambat 0 sampai ${MAKS_TERLAMBAT_MENIT} menit.`,
      );
    }
    jenis_kendala = kendala;
    terlambat_menit = menit;
  }

  const butuhAlasan =
    jenis === "Tidak Jalan" ||
    jenis === "Dibatalkan" ||
    jenis === "Ditolak" ||
    (ganti && olehDriver) ||
    (jenis === "Selesai" && !olehDriver);
  if (butuhAlasan && keterangan === null) return gagal("Alasan wajib diisi.");

  let lat: number | null = null;
  let lng: number | null = null;
  let akurasi_m: number | null = null;
  if (olehDriver) {
    if (draft.lat == null || draft.lng == null) {
      return gagal("Lokasi GPS belum didapat. Nyalakan GPS lalu coba lagi.");
    }
    if (!koordinatSah(draft.lat, draft.lng))
      return gagal("Koordinat tidak valid.");
    const akurasi = draft.akurasi_m;
    if (akurasi == null || !Number.isFinite(akurasi) || akurasi < 0) {
      return gagal("Akurasi GPS tidak valid.");
    }
    lat = draft.lat;
    lng = draft.lng;
    akurasi_m = akurasi;
  }
  const id_lokasi = olehDriver ? bersih(draft.id_lokasi) : null;
  let nama_lokasi: string | null = null;
  if (olehDriver) {
    const nama = teks(
      draft.nama_lokasi,
      MAKS_NAMA_LOKASI,
      `Nama tempat maksimal ${MAKS_NAMA_LOKASI} karakter.`,
    );
    if (!nama.ok) return nama;
    nama_lokasi = nama.value;
  }
  if (
    (jenis === "Tiba Muat" || jenis === "Tiba Bongkar") &&
    nama_lokasi === null
  ) {
    return gagal("Nama tempat wajib diisi.");
  }

  const waktu_perangkat = draft.waktu_perangkat.trim();
  if (detikUtc(waktu_perangkat) === null)
    return gagal("Waktu laporan tidak valid.");
  const waktuGps = bersih(draft.waktu_gps);
  if (olehDriver && waktuGps !== null && detikUtc(waktuGps) === null) {
    return gagal("Waktu GPS tidak valid.");
  }
  const waktu_gps = olehDriver ? waktuGps : null;

  const catatMuatan = jenis === "Selesai Muat" || jenis === "Selesai Bongkar";
  if (!catatMuatan && draft.muatan.length > 0) {
    return gagal(
      "Rincian muatan hanya untuk Selesai Muat atau Selesai Bongkar.",
    );
  }
  if (catatMuatan && draft.muatan.length === 0) {
    return gagal(
      jenis === "Selesai Muat"
        ? "Konfirmasi jumlah barang yang dimuat."
        : "Catat barang yang diturunkan.",
    );
  }
  if (draft.muatan.length > MAKS_BARIS_MUATAN) {
    return gagal(`Paling banyak ${MAKS_BARIS_MUATAN} baris muatan.`);
  }
  const muatan: LaporanMuatanValid[] = [];
  for (const m of draft.muatan) {
    const id_muatan = bersih(m.id_muatan);
    if (!id_muatan) return gagal("Barang muatan tidak dikenal.");
    if (muatan.some((x) => x.id_muatan === id_muatan)) {
      return gagal("Barang yang sama tercatat dua kali.");
    }
    if (m.qty < 0 || m.qty > MAKS_JUMLAH)
      return gagal("Jumlah barang tidak valid.");
    if (!beratSah(m.berat_kg_x100)) return gagal("Berat barang tidak valid.");
    muatan.push({
      id_muatan,
      qty: m.qty,
      berat_kg_x100: m.berat_kg_x100 ?? null,
    });
  }

  if (olehDriver && !adaFoto) return gagal("Ambil foto lebih dulu.");

  return {
    ok: true,
    value: {
      id_perjalanan,
      jenis,
      mode_ganti,
      id_ref,
      jenis_kendala,
      terlambat_menit,
      id_lokasi,
      nama_lokasi,
      lat,
      lng,
      akurasi_m,
      waktu_perangkat,
      waktu_gps,
      id_karyawan_baru,
      id_kendaraan_baru,
      keterangan,
      muatan,
    },
  };
}

/** Cermin `validate_foto_laporan`. */
export function validateFotoLaporan(
  mimeType: string,
  dataBase64: string,
): Hasil<null> {
  if (mimeType !== MIME_FOTO) return gagal("Foto harus JPEG.");
  if (dataBase64.length > MAKS_FOTO_BASE64)
    return gagal("Foto terlalu besar. Ambil ulang.");
  if (!base64Sah(dataBase64)) return gagal("Foto tidak terbaca.");
  return { ok: true, value: null };
}

// ── Bentuk data layar dispatcher (cermin `master_perjalanan`, `kumpulkan`,
// `rincian_perjalanan` di Rust) ──────────────────────────────────────────

/** Cermin `MAKS_DAFTAR_PERJALANAN`. */
export const MAKS_DAFTAR_PERJALANAN = 500;

export interface DaftarTarifBaris {
  nama: string;
  tarif: number;
  status_aktif: number;
}

export interface MasterPerjalanan {
  prefix: string;
  jenis: (DaftarTarifBaris & { id_jenis: string })[];
  kategori: (DaftarTarifBaris & { id_kategori: string })[];
  kendaraan: {
    id_kendaraan: string;
    id_jenis: string;
    identitas: string;
    nama: string | null;
    catatan: string | null;
    status_aktif: number;
  }[];
  lokasi: {
    id_lokasi: string;
    nama: string;
    jenis: string;
    lat: number;
    lng: number;
    radius_m: number;
    status_aktif: number;
  }[];
  personil: { id_unik: string; nama: string; divisi: string }[];
}

export interface PerjalananItem {
  id_perjalanan: string;
  tanggal: string;
  nomor: string;
  status: StatusPerjalanan;
  catatan: string | null;
  dicetak_pada: string | null;
  dibuat_oleh: string;
  id_karyawan_awal: string;
  id_kendaraan_awal: string;
  /** Driver dan kendaraan yang sedang bertugas (ganti berlaku terakhir). */
  id_karyawan: string;
  nama_karyawan: string | null;
  id_kendaraan: string;
  identitas_kendaraan: string | null;
  id_jenis: string;
  id_kategori: string;
  nama_kategori: string | null;
  tarif_kendaraan: number;
  tarif_tujuan: number;
  upah: number;
  id_karyawan_upah: string | null;
  penerima_upah: string | null;
  nama_penerima_upah: string | null;
  jumlah_muatan: number;
  laporan_terakhir: { jenis: string; waktu_perangkat: string } | null;
  menunggu_persetujuan: string[];
  tanda: Tanda[];
}

export interface MuatanBaris {
  id_muatan: string;
  id_perjalanan: string;
  urutan: number;
  tempat_muat: string;
  tempat_bongkar: string | null;
  nama_barang: string;
  jenis_barang: string | null;
  qty: number;
  satuan: string;
  berat_kg_x100: number | null;
}

export interface LaporanBaris extends Laporan {
  id_perjalanan: string;
  jenis_kendala: string | null;
  terlambat_menit: number | null;
  nama_lokasi: string | null;
  waktu_gps: string | null;
  keterangan: string | null;
  dilaporkan_oleh: string;
  /** 1 = foto ada di perangkat/server ini tanpa unduhan tambahan. */
  foto_lokal: number;
  muatan: {
    id_laporan: string;
    id_muatan: string;
    qty: number;
    berat_kg_x100: number | null;
  }[];
}

export interface RincianPerjalanan {
  item: PerjalananItem;
  muatan: MuatanBaris[];
  laporan: LaporanBaris[];
}

/** Cermin `perjalanan_saya`: layar driver, disaring di backend. */
export interface PerjalananSaya {
  id_karyawan: string;
  nama: string | null;
  saya: PerjalananItem[];
  /** Perjalanan terbuka milik driver lain, untuk ambil alih darurat. */
  lain: Pick<
    PerjalananItem,
    | "id_perjalanan"
    | "tanggal"
    | "nomor"
    | "status"
    | "nama_karyawan"
    | "identitas_kendaraan"
  >[];
  lokasi: {
    id_lokasi: string;
    nama: string;
    jenis: string;
    lat: number;
    lng: number;
    radius_m: number;
  }[];
  kendaraan: {
    id_kendaraan: string;
    identitas: string;
    nama_jenis: string | null;
  }[];
  personil: { id_unik: string; nama: string }[];
}
