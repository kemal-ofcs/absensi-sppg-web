/**
 * HRIS fase 7 (skema v42): rekrutmen — lowongan, pelamar, tahap seleksi,
 * berkas lamaran, jadikan karyawan, dan retensi data pelamar.
 *
 * Cermin `desktop/hr_rekrutmen.rs`: aturan murni, pesan galat, dan SQL WAJIB
 * identik, diuji dengan vektor yang sama (`hr-rekrutmen.test.ts` ↔ `mod
 * tests`). Keempat tabelnya KHUSUS CLOUD (Q-86); status lowongan dan pelamar
 * tidak disimpan. Penjelasan lengkap di kepala berkas Rust dan
 * `prd-hris.md` §22.3–§22.6.
 */
import {
  isValidOperatorEmail,
  isValidOperatorPhone,
  normalizeOperatorEmail,
  normalizeOperatorPhone,
} from "@/lib/operators/contact";
import type { PermissionKey } from "@/lib/rbac/catalog";
import { kunciNama, MAKS_NAMA, MAKS_TEKS, PENDIDIKAN, teksIsian } from "./hris";
import { isValidDate } from "./inventory";
import { createEmployeeIdentifiers } from "./stabilization";

// ── Konstanta ──────────────────────────────────────────────────────────────

export const MAKS_JUDUL = 100;
export const MAKS_JUMLAH = 999;
export const MAKS_KETERANGAN = 2000;
export const MIN_NAMA_PELAMAR = 2;
/** Sama dengan `MAKS_TEKS`: alamat menjadi isian awal `hr_profil` (Q-94). */
export const MAKS_ALAMAT = MAKS_TEKS;
export const MAKS_SUMBER = 100;
export const MAKS_CATATAN_PELAMAR = 2000;
export const MAKS_CATATAN_TAHAP = 1000;
export const MAKS_BERKAS_PER_PELAMAR = 3;

export const TAHAP_PROSES = [
  "Lamaran",
  "Seleksi Berkas",
  "Wawancara",
  "Tes",
  "Penawaran",
] as const;
export const TAHAP_AKHIR = ["Diterima", "Ditolak", "Mundur"] as const;
/** WAJIB sama dengan CHECK `hr_pelamar_tahap.tahap`. */
export const TAHAP = [...TAHAP_PROSES, ...TAHAP_AKHIR] as const;
export type Tahap = (typeof TAHAP)[number];
export const TAHAP_BERCATATAN = ["Ditolak", "Mundur"] as const;
/** Saran isian sumber; sumber tetap teks bebas (Q-90). */
export const SARAN_SUMBER = [
  "Jobstreet",
  "LinkedIn",
  "Glints",
  "Instagram",
  "Referensi Karyawan",
  "Datang Langsung",
  "Lainnya",
] as const;

export const IZIN_VIEW = "hr.recruit.view";
export const IZIN_MANAGE = "hr.recruit.manage";
export const IZIN_DELETE = "hr.recruit.delete";
/** Cermin `IZIN_JADIKAN_KARYAWAN`: wajib ketiganya (Q-100, aturan 44). */
export const IZIN_JADIKAN_KARYAWAN = [
  IZIN_MANAGE,
  "employees.manage",
  "hr.contract.manage",
] as const satisfies readonly PermissionKey[];

export const PESAN_SUDAH_KARYAWAN =
  "Pelamar ini sudah dijadikan karyawan; datanya tidak bisa diubah.";

// ── SQL kembar (diperiksa harfiah terhadap `hr_rekrutmen.rs`) ──────────────

/** Cermin makro `tutup_efektif_sql!`: tanggal tutup efektif lowongan alias `l`. */
export const TUTUP_EFEKTIF_SQL =
  "(CASE WHEN l.ditutup_pada IS NULL AND (l.tanggal_tutup IS NULL OR l.tanggal_tutup >= date('now', '+7 hours')) THEN NULL WHEN l.ditutup_pada IS NULL THEN l.tanggal_tutup WHEN l.tanggal_tutup IS NOT NULL AND l.tanggal_tutup < date('now', '+7 hours') AND l.tanggal_tutup < date(l.ditutup_pada, '+7 hours') THEN l.tanggal_tutup ELSE date(l.ditutup_pada, '+7 hours') END)";

/** Cermin makro `retensi_bulan_sql!`: kosong atau di luar 1–60 = 12. */
export const RETENSI_BULAN_SQL =
  "COALESCE((SELECT CAST(trim(value) AS INTEGER) FROM setting_gex_system WHERE key = 'hr_pelamar_retensi_bulan' AND trim(value) <> '' AND trim(value) NOT GLOB '*[^0-9]*' AND CAST(trim(value) AS INTEGER) BETWEEN 1 AND 60), 12)";

/** Cermin makro `tanggal_hapus_sql!`: hari data pelamar lowongan `l` dihapus. */
export const TANGGAL_HAPUS_SQL = `date(${TUTUP_EFEKTIF_SQL}, '+' || ${RETENSI_BULAN_SQL} || ' months', '+1 day')`;

/** Cermin makro `pelamar_dihapus_sql!` (alias `p`; `?1` NULL = retensi). */
export const PELAMAR_DIHAPUS_SQL = `p.id_karyawan IS NULL AND (p.id_pelamar = ?1 OR (?1 IS NULL AND EXISTS (SELECT 1 FROM hr_lowongan l WHERE l.id_lowongan = p.id_lowongan AND ${TUTUP_EFEKTIF_SQL} IS NOT NULL AND ${TANGGAL_HAPUS_SQL} <= date('now', '+7 hours'))))`;

/** Cermin `HAPUS_PELAMAR_LAMA_SQL`: retensi (`?1` NULL) atau hapus satu pelamar. */
export const HAPUS_PELAMAR_LAMA_SQL = [
  `UPDATE hr_lowongan SET pelamar_dihapus = pelamar_dihapus + (SELECT COUNT(*) FROM hr_pelamar p WHERE p.id_lowongan = hr_lowongan.id_lowongan AND ${PELAMAR_DIHAPUS_SQL}) WHERE id_lowongan IN (SELECT p.id_lowongan FROM hr_pelamar p WHERE ${PELAMAR_DIHAPUS_SQL});`,
  `DELETE FROM hr_pelamar_berkas WHERE id_pelamar IN (SELECT p.id_pelamar FROM hr_pelamar p WHERE ${PELAMAR_DIHAPUS_SQL});`,
  `DELETE FROM hr_pelamar_tahap WHERE id_pelamar IN (SELECT p.id_pelamar FROM hr_pelamar p WHERE ${PELAMAR_DIHAPUS_SQL});`,
  `DELETE FROM hr_pelamar WHERE id_pelamar IN (SELECT p.id_pelamar FROM hr_pelamar p WHERE ${PELAMAR_DIHAPUS_SQL});`,
] as const;

/** Cermin `KLAIM_PELAMAR_SQL`: `?1` id pelamar, `?2` id karyawan, `?3` pencatat. */
export const KLAIM_PELAMAR_SQL = [
  "UPDATE hr_pelamar SET id_karyawan = ?2, dijadikan_oleh = ?3, dijadikan_pada = datetime('now') WHERE id_pelamar = ?1 AND id_karyawan IS NULL AND (SELECT t.tahap FROM hr_pelamar_tahap t WHERE t.id_pelamar = ?1 AND t.dibatalkan_pada IS NULL ORDER BY t.urutan DESC LIMIT 1) = 'Diterima';",
  "INSERT INTO hr_profil (id_karyawan, tanggal_lahir, alamat_domisili, pendidikan, pribadi_diubah_oleh, pribadi_diubah_pada) SELECT p.id_karyawan, p.tanggal_lahir, p.alamat, p.pendidikan, ?3, datetime('now') FROM hr_pelamar p WHERE p.id_pelamar = ?1 AND p.id_karyawan = ?2 AND (p.tanggal_lahir IS NOT NULL OR p.alamat IS NOT NULL OR p.pendidikan IS NOT NULL) ON CONFLICT(id_karyawan) DO NOTHING;",
] as const;

/** Cermin makro `status_pelamar_sql!`: tahap berlaku pelamar alias `p`. */
export const STATUS_PELAMAR_SQL =
  "(SELECT t.tahap FROM hr_pelamar_tahap t WHERE t.id_pelamar = p.id_pelamar AND t.dibatalkan_pada IS NULL ORDER BY t.urutan DESC LIMIT 1)";

/** Cermin `DAFTAR_LOWONGAN_SQL`. */
export const DAFTAR_LOWONGAN_SQL = `SELECT l.*, j.nama AS jabatan_nama, d.nama AS divisi_nama, c.nama AS cabang_nama, date(l.ditutup_pada, '+7 hours') AS tanggal_ditutup, ${TUTUP_EFEKTIF_SQL} AS tutup_efektif, ${TANGGAL_HAPUS_SQL} AS tanggal_hapus FROM hr_lowongan l LEFT JOIN hr_jabatan j ON j.id_jabatan = l.id_jabatan LEFT JOIN hr_divisi d ON d.id_divisi = l.id_divisi LEFT JOIN hr_cabang c ON c.id_cabang = l.id_cabang ORDER BY l.tanggal_buka DESC, l.id_lowongan DESC;`;

/** Cermin `STATUS_SEMUA_PELAMAR_SQL`. */
export const STATUS_SEMUA_PELAMAR_SQL = `SELECT p.id_lowongan, p.id_karyawan, ${STATUS_PELAMAR_SQL} AS status FROM hr_pelamar p;`;

/** Cermin makro `pilih_pelamar_sql!`: kolom daftar pelamar tanpa isi berkas. */
export const PILIH_PELAMAR_SQL = `SELECT p.*, ${STATUS_PELAMAR_SQL} AS status, (SELECT COUNT(*) FROM hr_pelamar_berkas b WHERE b.id_pelamar = p.id_pelamar) AS jumlah_berkas, EXISTS (SELECT 1 FROM master_data m WHERE m.id_unik = p.id_karyawan) AS karyawan_ada FROM hr_pelamar p WHERE `;
export const PELAMAR_LOWONGAN_SQL = `${PILIH_PELAMAR_SQL}p.id_lowongan = ?1 ORDER BY p.tanggal_lamaran DESC, p.id_pelamar;`;
export const PELAMAR_SATU_SQL = `${PILIH_PELAMAR_SQL}p.id_pelamar = ?1;`;

export const INSERT_LOWONGAN_SQL =
  "INSERT INTO hr_lowongan (id_lowongan, judul, id_jabatan, id_divisi, id_cabang, jumlah, tanggal_buka, tanggal_tutup, keterangan, dicatat_oleh) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10);";

export const UBAH_LOWONGAN_SQL =
  "UPDATE hr_lowongan SET judul = ?2, id_jabatan = ?3, id_divisi = ?4, id_cabang = ?5, jumlah = ?6, tanggal_buka = ?7, tanggal_tutup = ?8, keterangan = ?9, diubah_oleh = ?10, diubah_pada = datetime('now') WHERE id_lowongan = ?1 AND ditutup_pada IS NULL;";

export const TUTUP_LOWONGAN_SQL =
  "UPDATE hr_lowongan SET ditutup_pada = datetime('now'), ditutup_oleh = ?2 WHERE id_lowongan = ?1 AND ditutup_pada IS NULL;";

export const BUKA_LOWONGAN_SQL =
  "UPDATE hr_lowongan SET ditutup_pada = NULL, ditutup_oleh = NULL, tanggal_tutup = ?2, diubah_oleh = ?3, diubah_pada = datetime('now') WHERE id_lowongan = ?1;";

export const INSERT_PELAMAR_SQL =
  "INSERT INTO hr_pelamar (id_pelamar, id_lowongan, nama, no_hp, email, lp, tanggal_lahir, alamat, pendidikan, sumber, tanggal_lamaran, catatan, dicatat_oleh) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13);";

export const UBAH_PELAMAR_SQL =
  "UPDATE hr_pelamar SET nama = ?2, no_hp = ?3, email = ?4, lp = ?5, tanggal_lahir = ?6, alamat = ?7, pendidikan = ?8, sumber = ?9, tanggal_lamaran = ?10, catatan = ?11, diubah_oleh = ?12, diubah_pada = datetime('now') WHERE id_pelamar = ?1 AND id_karyawan IS NULL;";

export const INSERT_TAHAP_SQL =
  "INSERT INTO hr_pelamar_tahap (id_tahap, id_pelamar, urutan, tahap, tanggal, catatan, oleh) SELECT ?1 || ':' || ?2, ?1, ?2, ?3, ?4, ?5, ?6 WHERE EXISTS (SELECT 1 FROM hr_pelamar WHERE id_pelamar = ?1 AND id_karyawan IS NULL);";

export const BATAL_TAHAP_SQL =
  "UPDATE hr_pelamar_tahap SET dibatalkan_oleh = ?3, dibatalkan_pada = datetime('now'), alasan_batal = ?4 WHERE id_pelamar = ?1 AND urutan = ?2 AND urutan > 1 AND dibatalkan_pada IS NULL AND NOT EXISTS (SELECT 1 FROM hr_pelamar_tahap t WHERE t.id_pelamar = ?1 AND t.urutan > ?2 AND t.dibatalkan_pada IS NULL) AND EXISTS (SELECT 1 FROM hr_pelamar WHERE id_pelamar = ?1 AND id_karyawan IS NULL);";

export const INSERT_BERKAS_SQL =
  "INSERT INTO hr_pelamar_berkas (id_berkas, id_pelamar, urutan, nama_berkas, mime_type, data_base64) SELECT ?1, ?2, ?3, ?4, ?5, ?6 WHERE EXISTS (SELECT 1 FROM hr_pelamar WHERE id_pelamar = ?2 AND id_karyawan IS NULL);";

export const HAPUS_BERKAS_SQL =
  "DELETE FROM hr_pelamar_berkas WHERE id_berkas = ?1 AND id_pelamar IN (SELECT id_pelamar FROM hr_pelamar WHERE id_karyawan IS NULL);";

// ── Aturan murni ───────────────────────────────────────────────────────────

type Hasil<T> = { ok: true; nilai: T } | { ok: false; pesan: string };
const ok = <T>(nilai: T): Hasil<T> => ({ ok: true, nilai });
const gagal = <T = never>(pesan: string): Hasil<T> => ({ ok: false, pesan });
type Draft = Record<string, unknown>;

const panjang = (teks: string) => [...teks].length;
const spasiRapi = (teks: string) => teks.split(/\s+/).filter(Boolean).join(" ");

function teksOpsional(
  draft: Draft,
  kunci: string,
  label: string,
  maks: number,
): Hasil<string | null> {
  const t = teksIsian(draft[kunci]);
  if (t && panjang(t) > maks)
    return gagal(`${label} maksimal ${maks} karakter.`);
  return ok(t ?? null);
}

const termasuk = (daftar: readonly string[], nilai: string) =>
  daftar.includes(nilai);

export interface LowonganSah {
  id_lowongan: string | null;
  judul: string;
  id_jabatan: string | null;
  id_divisi: string | null;
  id_cabang: string | null;
  jumlah: number;
  tanggal_buka: string;
  tanggal_tutup: string | null;
  keterangan: string | null;
}

/** Cermin `validasi_lowongan`. Master organisasi diperiksa pemanggil. */
export function validasiLowongan(draft: Draft): Hasil<LowonganSah> {
  const judulMentah = teksIsian(draft.judul);
  if (!judulMentah) return gagal("Judul lowongan wajib diisi.");
  const judul = spasiRapi(judulMentah);
  if (panjang(judul) > MAKS_JUDUL)
    return gagal(`Judul lowongan maksimal ${MAKS_JUDUL} karakter.`);
  const jumlah = draft.jumlah;
  if (
    typeof jumlah !== "number" ||
    !Number.isSafeInteger(jumlah) ||
    jumlah < 1 ||
    jumlah > MAKS_JUMLAH
  )
    return gagal("Jumlah dibutuhkan harus bilangan bulat 1–999.");
  const tanggal_buka = teksIsian(draft.tanggal_buka);
  if (!tanggal_buka || !isValidDate(tanggal_buka))
    return gagal("Tanggal buka tidak valid.");
  const tanggal_tutup = teksIsian(draft.tanggal_tutup) ?? null;
  if (tanggal_tutup) {
    if (!isValidDate(tanggal_tutup)) return gagal("Tanggal tutup tidak valid.");
    if (tanggal_tutup < tanggal_buka)
      return gagal("Tanggal tutup tidak boleh sebelum tanggal buka.");
  }
  const keterangan = teksOpsional(
    draft,
    "keterangan",
    "Keterangan",
    MAKS_KETERANGAN,
  );
  if (!keterangan.ok) return keterangan;
  return ok({
    id_lowongan: teksIsian(draft.id_lowongan) ?? null,
    judul,
    id_jabatan: teksIsian(draft.id_jabatan) ?? null,
    id_divisi: teksIsian(draft.id_divisi) ?? null,
    id_cabang: teksIsian(draft.id_cabang) ?? null,
    jumlah,
    tanggal_buka,
    tanggal_tutup,
    keterangan: keterangan.nilai,
  });
}

export type StatusLowongan = "Ditutup" | "Dijadwalkan" | "Dibuka";

/** Cermin `status_lowongan` (Q-88). `hariIni` tanggal WIB. */
export function statusLowongan(
  tanggalBuka: string,
  tanggalTutup: string | null,
  ditutup: boolean,
  hariIni: string,
): StatusLowongan {
  if (ditutup || (tanggalTutup !== null && tanggalTutup < hariIni))
    return "Ditutup";
  if (tanggalBuka > hariIni) return "Dijadwalkan";
  return "Dibuka";
}

/** Cermin `tutup_efektif`, padanan murni `TUTUP_EFEKTIF_SQL`. */
export function tutupEfektif(
  tanggalTutup: string | null,
  tanggalDitutup: string | null,
  hariIni: string,
): string | null {
  const lewat =
    tanggalTutup !== null && tanggalTutup < hariIni ? tanggalTutup : null;
  if (lewat !== null && tanggalDitutup !== null)
    return lewat < tanggalDitutup ? lewat : tanggalDitutup;
  return lewat ?? tanggalDitutup;
}

export interface PelamarSah {
  id_pelamar: string | null;
  id_lowongan: string;
  nama: string;
  no_hp: string | null;
  email: string | null;
  lp: "L" | "P" | null;
  tanggal_lahir: string | null;
  alamat: string | null;
  pendidikan: string | null;
  sumber: string | null;
  tanggal_lamaran: string;
  catatan: string | null;
}

/** Cermin `validasi_pelamar`. `tanggalBuka` milik lowongannya. */
export function validasiPelamar(
  draft: Draft,
  tanggalBuka: string,
  hariIni: string,
): Hasil<PelamarSah> {
  const id_lowongan = teksIsian(draft.id_lowongan);
  if (!id_lowongan) return gagal("Lowongan wajib dipilih.");
  const nama = spasiRapi(teksIsian(draft.nama) ?? "");
  if (panjang(nama) < MIN_NAMA_PELAMAR)
    return gagal("Nama pelamar minimal 2 karakter.");
  if (panjang(nama) > MAKS_NAMA)
    return gagal(`Nama pelamar maksimal ${MAKS_NAMA} karakter.`);
  let no_hp: string | null = null;
  const hp = teksIsian(draft.no_hp);
  if (hp) {
    no_hp = normalizeOperatorPhone(hp);
    if (!isValidOperatorPhone(no_hp)) return gagal("Nomor HP tidak valid.");
  }
  let email: string | null = null;
  const surel = teksIsian(draft.email);
  if (surel) {
    if (!isValidOperatorEmail(surel)) return gagal("Email tidak valid.");
    email = normalizeOperatorEmail(surel);
  }
  const lp = teksIsian(draft.lp) ?? null;
  if (lp !== null && lp !== "L" && lp !== "P")
    return gagal("Jenis kelamin tidak dikenal.");
  const tanggal_lahir = teksIsian(draft.tanggal_lahir) ?? null;
  if (tanggal_lahir && (!isValidDate(tanggal_lahir) || tanggal_lahir > hariIni))
    return gagal("Tanggal lahir tidak valid.");
  const pendidikan = teksIsian(draft.pendidikan) ?? null;
  if (pendidikan && !termasuk(PENDIDIKAN, pendidikan))
    return gagal("Pendidikan tidak dikenal.");
  const tanggal_lamaran = teksIsian(draft.tanggal_lamaran);
  if (!tanggal_lamaran || !isValidDate(tanggal_lamaran))
    return gagal("Tanggal lamaran tidak valid.");
  if (tanggal_lamaran > hariIni)
    return gagal("Tanggal lamaran tidak boleh di masa depan.");
  if (tanggal_lamaran < tanggalBuka)
    return gagal("Tanggal lamaran tidak boleh sebelum lowongan dibuka.");
  const alamat = teksOpsional(draft, "alamat", "Alamat", MAKS_ALAMAT);
  if (!alamat.ok) return alamat;
  const sumber = teksOpsional(draft, "sumber", "Sumber", MAKS_SUMBER);
  if (!sumber.ok) return sumber;
  const catatan = teksOpsional(
    draft,
    "catatan",
    "Catatan",
    MAKS_CATATAN_PELAMAR,
  );
  if (!catatan.ok) return catatan;
  return ok({
    id_pelamar: teksIsian(draft.id_pelamar) ?? null,
    id_lowongan,
    nama,
    no_hp,
    email,
    lp,
    tanggal_lahir,
    alamat: alamat.nilai,
    pendidikan,
    sumber: sumber.nilai,
    tanggal_lamaran,
    catatan: catatan.nilai,
  });
}

export interface TahapRingkas {
  urutan: number;
  tahap: string;
  dibatalkan: boolean;
}

/** Cermin `status_pelamar`: tahap ber-`urutan` terbesar yang tidak dibatalkan. */
export function statusPelamar(
  tahap: readonly TahapRingkas[],
): TahapRingkas | null {
  let terakhir: TahapRingkas | null = null;
  for (const t of tahap) {
    if (!t.dibatalkan && (terakhir === null || t.urutan > terakhir.urutan))
      terakhir = t;
  }
  return terakhir;
}

export interface TahapSah {
  tahap: Tahap;
  tanggal: string;
  catatan: string | null;
}

/** Cermin `periksa_tahap` (Q-91). `status` = tahap berlaku sekarang. */
export function periksaTahap(
  draft: Draft,
  status: string,
  tanggalLamaran: string,
  hariIni: string,
): Hasil<TahapSah> {
  if (termasuk(TAHAP_AKHIR, status))
    return gagal(`Pelamar sudah ${status}; tahap baru tidak bisa dicatat.`);
  const tahap = teksIsian(draft.tahap);
  if (!tahap || !termasuk(TAHAP, tahap)) return gagal("Tahap tidak dikenal.");
  const tanggal = teksIsian(draft.tanggal);
  if (!tanggal || !isValidDate(tanggal))
    return gagal("Tanggal tahap tidak valid.");
  if (tanggal > hariIni)
    return gagal("Tanggal tahap tidak boleh di masa depan.");
  if (tanggal < tanggalLamaran)
    return gagal("Tanggal tahap tidak boleh sebelum tanggal lamaran.");
  const catatan = teksOpsional(draft, "catatan", "Catatan", MAKS_CATATAN_TAHAP);
  if (!catatan.ok) return catatan;
  if (catatan.nilai === null && termasuk(TAHAP_BERCATATAN, tahap))
    return gagal("Catatan wajib diisi untuk tahap Ditolak dan Mundur.");
  return ok({ tahap: tahap as Tahap, tanggal, catatan: catatan.nilai });
}

/** Cermin `periksa_batal_tahap`: hasil = urutan yang dibatalkan + alasan. */
export function periksaBatalTahap(
  tahap: readonly TahapRingkas[],
  sudahKaryawan: boolean,
  draft: Draft,
): Hasil<[number, string]> {
  if (sudahKaryawan) return gagal(PESAN_SUDAH_KARYAWAN);
  const terakhir = statusPelamar(tahap);
  if (!terakhir) return gagal("Pelamar belum punya tahap.");
  if (terakhir.urutan <= 1)
    return gagal("Tahap Lamaran tidak bisa dibatalkan.");
  const alasan = teksOpsional(
    draft,
    "alasan",
    "Alasan pembatalan",
    MAKS_CATATAN_TAHAP,
  );
  if (!alasan.ok) return alasan;
  if (alasan.nilai === null) return gagal("Alasan pembatalan wajib diisi.");
  return ok([terakhir.urutan, alasan.nilai]);
}

export interface IdDariPelamar {
  id_unik: string;
  kode_karyawan: string;
  id_kontrak: string;
}

/** Cermin `id_dari_pelamar`: `createEmployeeIdentifiers` atas bagian acak id. */
export function idDariPelamar(idPelamar: string): Hasil<IdDariPelamar> {
  const acak = idPelamar.startsWith("plm-") ? idPelamar.slice(4) : idPelamar;
  if (acak.replace(/[^a-z0-9]/gi, "").length < 12)
    return gagal("Id pelamar tidak valid.");
  const id = createEmployeeIdentifiers(acak);
  return ok({
    id_unik: id.idUnik,
    kode_karyawan: id.kodeKaryawan,
    id_kontrak: `ktr-${idPelamar}`,
  });
}

/** Cermin `pelamar_ganda`: nama (tanpa beda huruf/spasi) + no. HP sama. */
export function pelamarGanda(
  pelamar: ReadonlyArray<[string, string, string | null]>,
): string[] {
  const hitung = new Map<string, number>();
  const kunci = (nama: string, hp: string) => `${kunciNama(nama)}\u0000${hp}`;
  for (const [, nama, hp] of pelamar) {
    if (hp !== null)
      hitung.set(kunci(nama, hp), (hitung.get(kunci(nama, hp)) ?? 0) + 1);
  }
  const hasil: string[] = [];
  for (const [id, nama, hp] of pelamar) {
    if (
      hp !== null &&
      (hitung.get(kunci(nama, hp)) ?? 0) > 1 &&
      !hasil.includes(id)
    )
      hasil.push(id);
  }
  return hasil;
}
