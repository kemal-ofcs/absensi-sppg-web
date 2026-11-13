/**
 * HRIS fase 7 (skema v42): pelatihan, peserta, dan sertifikat. Fase 11
 * (skema v43): pagu per divisi per tahun dan rencana pelatihan.
 *
 * Cermin `desktop/hr_pelatihan.rs`, diuji dengan vektor yang sama. Semua
 * tabelnya KHUSUS CLOUD (Q-87, Q-138); sertifikat = `hr_dokumen` berjenis
 * `dok-sertifikat` (Q-97); biaya satu total per pelatihan tanpa jurnal (Q-98).
 * Status rencana, realisasi, dan tanda pagu tidak disimpan (§26.4).
 */
import { teksIsian } from "./hris";
import { isValidDate } from "./inventory";

export const MAKS_NAMA_PELATIHAN = 100;
export const MAKS_PENYELENGGARA = 100;
export const MAKS_LOKASI = 100;
export const MAKS_BIAYA = 1_000_000_000;
export const MAKS_KETERANGAN = 2000;
export const MAKS_CATATAN_PESERTA = 1000;
/** WAJIB sama dengan CHECK `hr_pelatihan_peserta.hasil`. */
export const HASIL_PESERTA = ["Lulus", "Tidak Lulus", "Tidak Hadir"] as const;
export type HasilPeserta = (typeof HASIL_PESERTA)[number];
export const JENIS_SERTIFIKAT = "dok-sertifikat";

export const PESAN_SERTIFIKAT_NONAKTIF =
  "Aktifkan jenis dokumen Sertifikat di Organisasi.";
export const PESAN_PELATIHAN_BATAL = "Pelatihan ini sudah dibatalkan.";
export const PESAN_PESERTA_BERSERTIFIKAT =
  "Peserta ini punya sertifikat; hapus sertifikatnya dulu.";

export const MAKS_PESERTA_RENCANA = 9_999;
export const MAKS_PAGU = 100_000_000_000;
export const MAKS_CATATAN_PAGU = 1000;
/** Kunci kelompok tanpa divisi; tidak bertabrakan dengan id `div-…`. */
export const KELOMPOK_UMUM = "umum";

export const PESAN_RENCANA_TAHUN =
  "Tahun rencana harus sama dengan tahun tanggal mulai pelatihan; lepas tautan rencananya dulu.";
export const PESAN_RENCANA_TERTAUT =
  "Rencana ini masih punya pelatihan yang tidak dibatalkan; lepas tautannya atau batalkan pelatihannya dulu.";
export const PESAN_RENCANA_BATAL = "Rencana ini sudah dibatalkan.";
export const PESAN_RENCANA_TAHUN_TERKUNCI =
  "Tahun rencana tidak bisa diubah selama ada pelatihan yang tertaut.";

// ── SQL kembar (diperiksa harfiah terhadap `hr_pelatihan.rs`) ──────────────

export const DAFTAR_PELATIHAN_SQL =
  "SELECT l.*, (SELECT COUNT(*) FROM hr_pelatihan_peserta p WHERE p.id_pelatihan = l.id_pelatihan) AS jumlah_peserta FROM hr_pelatihan l WHERE strftime('%Y', l.tanggal_mulai) = ?1 ORDER BY l.tanggal_mulai DESC, l.id_pelatihan DESC;";

export const PESERTA_SQL =
  "SELECT p.*, m.nama, m.divisi, m.jabatan_status, m.status_aktif, d.nomor, d.tanggal_terbit, d.tanggal_kedaluwarsa, d.catatan AS catatan_sertifikat FROM hr_pelatihan_peserta p LEFT JOIN master_data m ON m.id_unik = p.id_karyawan LEFT JOIN hr_dokumen d ON d.id_dokumen = p.id_dokumen WHERE p.id_pelatihan = ?1 ORDER BY m.nama, p.id_karyawan;";

export const BERKAS_PESERTA_SQL =
  "SELECT b.id_berkas, b.id_dokumen, b.urutan, b.nama_berkas, b.mime_type, length(b.data_base64) AS panjang FROM hr_dokumen_berkas b JOIN hr_pelatihan_peserta p ON p.id_dokumen = b.id_dokumen WHERE p.id_pelatihan = ?1 ORDER BY b.id_dokumen, b.urutan;";

export const RIWAYAT_SQL =
  "SELECT l.id_pelatihan, l.nama, l.penyelenggara, l.tanggal_mulai, l.tanggal_selesai, l.lokasi, p.hasil, p.catatan, p.id_dokumen, d.nomor, d.tanggal_kedaluwarsa FROM hr_pelatihan_peserta p JOIN hr_pelatihan l ON l.id_pelatihan = p.id_pelatihan LEFT JOIN hr_dokumen d ON d.id_dokumen = p.id_dokumen WHERE p.id_karyawan = ?1 AND l.dibatalkan_pada IS NULL ORDER BY l.tanggal_mulai DESC, l.id_pelatihan DESC;";

export const INSERT_PELATIHAN_SQL =
  "INSERT INTO hr_pelatihan (id_pelatihan, nama, penyelenggara, tanggal_mulai, tanggal_selesai, lokasi, biaya, keterangan, dicatat_oleh, id_rencana) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10);";

export const UBAH_PELATIHAN_SQL =
  "UPDATE hr_pelatihan SET nama = ?2, penyelenggara = ?3, tanggal_mulai = ?4, tanggal_selesai = ?5, lokasi = ?6, biaya = ?7, keterangan = ?8, diubah_oleh = ?9, diubah_pada = datetime('now'), id_rencana = ?10 WHERE id_pelatihan = ?1 AND dibatalkan_pada IS NULL;";

export const BATAL_PELATIHAN_SQL =
  "UPDATE hr_pelatihan SET dibatalkan_oleh = ?2, dibatalkan_pada = datetime('now'), alasan_batal = ?3 WHERE id_pelatihan = ?1 AND dibatalkan_pada IS NULL;";

export const TAMBAH_PESERTA_SQL =
  "INSERT INTO hr_pelatihan_peserta (id_peserta, id_pelatihan, id_karyawan, dicatat_oleh) SELECT ?1 || ':' || m.id_unik, ?1, m.id_unik, ?3 FROM master_data m WHERE m.id_unik = ?2 AND m.status_aktif = 'Aktif' AND EXISTS (SELECT 1 FROM hr_pelatihan l WHERE l.id_pelatihan = ?1 AND l.dibatalkan_pada IS NULL) ON CONFLICT(id_peserta) DO NOTHING;";

export const LEPAS_PESERTA_SQL =
  "DELETE FROM hr_pelatihan_peserta WHERE id_peserta = ?1 AND id_dokumen IS NULL;";

export const HASIL_PESERTA_SQL =
  "UPDATE hr_pelatihan_peserta SET hasil = ?2, catatan = ?3 WHERE id_peserta = ?1;";

export const TAUT_SERTIFIKAT_SQL =
  "UPDATE hr_pelatihan_peserta SET id_dokumen = ?2 WHERE id_peserta = ?1 AND (id_dokumen IS NULL OR id_dokumen = ?2);";

export const BERKAS_SERTIFIKAT_SQL =
  "SELECT b.id_berkas, b.nama_berkas, b.mime_type, b.data_base64 FROM hr_dokumen_berkas b WHERE b.id_berkas = ?1 AND EXISTS (SELECT 1 FROM hr_pelatihan_peserta p WHERE p.id_dokumen = b.id_dokumen);";

// Fase 11. `?1` = tahun (INTEGER). Nama divisi dibaca hidup lewat LEFT JOIN.

export const PAGU_SQL =
  "SELECT a.*, d.nama AS nama_divisi, d.is_aktif AS divisi_aktif FROM hr_pelatihan_anggaran a LEFT JOIN hr_divisi d ON d.id_divisi = a.id_divisi WHERE a.tahun = ?1 ORDER BY a.id_anggaran;";

export const RENCANA_SQL =
  "SELECT r.*, d.nama AS nama_divisi, d.is_aktif AS divisi_aktif FROM hr_pelatihan_rencana r LEFT JOIN hr_divisi d ON d.id_divisi = r.id_divisi WHERE r.tahun = ?1 ORDER BY r.bulan IS NULL, r.bulan, r.nama, r.id_rencana;";

/** Pelatihan bertahun mulai `?1`, ditambah pelatihan tahun lain yang menautkan rencana `?1`. */
export const REALISASI_SQL =
  "SELECT l.id_pelatihan, l.nama, l.tanggal_mulai, l.tanggal_selesai, l.biaya, l.dibatalkan_pada, r.id_rencana, r.id_divisi, d.nama AS nama_divisi, d.is_aktif AS divisi_aktif, (SELECT COUNT(*) FROM hr_pelatihan_peserta p WHERE p.id_pelatihan = l.id_pelatihan) AS jumlah_peserta FROM hr_pelatihan l LEFT JOIN hr_pelatihan_rencana r ON r.id_rencana = l.id_rencana LEFT JOIN hr_divisi d ON d.id_divisi = r.id_divisi WHERE CAST(strftime('%Y', l.tanggal_mulai) AS INTEGER) = ?1 OR r.tahun = ?1 ORDER BY l.tanggal_mulai, l.id_pelatihan;";

export const SIMPAN_PAGU_SQL =
  "INSERT INTO hr_pelatihan_anggaran (id_anggaran, tahun, id_divisi, nominal, catatan, dicatat_oleh) VALUES (?1, ?2, ?3, ?4, ?5, ?6) ON CONFLICT(id_anggaran) DO UPDATE SET nominal = excluded.nominal, catatan = excluded.catatan, diubah_oleh = excluded.dicatat_oleh, diubah_pada = datetime('now');";

export const HAPUS_PAGU_SQL =
  "DELETE FROM hr_pelatihan_anggaran WHERE id_anggaran = ?1;";

export const RENCANA_SATU_SQL =
  "SELECT r.*, d.nama AS nama_divisi, d.is_aktif AS divisi_aktif FROM hr_pelatihan_rencana r LEFT JOIN hr_divisi d ON d.id_divisi = r.id_divisi WHERE r.id_rencana = ?1;";

/** Semua pelatihan yang menautkan satu rencana (status, larangan batal/ubah tahun). */
export const TAUTAN_RENCANA_SQL =
  "SELECT tanggal_mulai, tanggal_selesai, dibatalkan_pada FROM hr_pelatihan WHERE id_rencana = ?1;";

export const INSERT_RENCANA_SQL =
  "INSERT INTO hr_pelatihan_rencana (id_rencana, tahun, nama, id_divisi, bulan, peserta_rencana, biaya_rencana, penyelenggara, keterangan, dicatat_oleh) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10);";

export const UBAH_RENCANA_SQL =
  "UPDATE hr_pelatihan_rencana SET tahun = ?2, nama = ?3, id_divisi = ?4, bulan = ?5, peserta_rencana = ?6, biaya_rencana = ?7, penyelenggara = ?8, keterangan = ?9, diubah_oleh = ?10, diubah_pada = datetime('now') WHERE id_rencana = ?1 AND dibatalkan_pada IS NULL AND (tahun = ?2 OR NOT EXISTS (SELECT 1 FROM hr_pelatihan l WHERE l.id_rencana = ?1 AND l.dibatalkan_pada IS NULL));";

export const BATAL_RENCANA_SQL =
  "UPDATE hr_pelatihan_rencana SET dibatalkan_oleh = ?2, dibatalkan_pada = datetime('now'), alasan_batal = ?3 WHERE id_rencana = ?1 AND dibatalkan_pada IS NULL AND NOT EXISTS (SELECT 1 FROM hr_pelatihan l WHERE l.id_rencana = ?1 AND l.dibatalkan_pada IS NULL);";

type Hasil<T> = { ok: true; nilai: T } | { ok: false; pesan: string };
const ok = <T>(nilai: T): Hasil<T> => ({ ok: true, nilai });
const gagal = <T = never>(pesan: string): Hasil<T> => ({ ok: false, pesan });
type Draft = Record<string, unknown>;

const panjang = (teks: string) => [...teks].length;

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

/** Cermin `bulat`: bilangan bulat min–maks; absen atau null = `bawaan`. */
function bulat(
  draft: Draft,
  kunci: string,
  min: number,
  maks: number,
  bawaan: number | null,
  pesan: string,
): Hasil<number | null> {
  const v = draft[kunci];
  if (v === undefined || v === null) return ok(bawaan);
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < min || v > maks)
    return gagal(pesan);
  return ok(v);
}

/** Cermin `nama_wajib`. */
function namaWajib(draft: Draft, label: string): Hasil<string> {
  const mentah = teksIsian(draft.nama);
  if (!mentah) return gagal(`${label} wajib diisi.`);
  const nama = mentah.split(/\s+/).filter(Boolean).join(" ");
  if (panjang(nama) > MAKS_NAMA_PELATIHAN)
    return gagal(`${label} maksimal ${MAKS_NAMA_PELATIHAN} karakter.`);
  return ok(nama);
}

/** Cermin `tahun_dari`: tahun dari `YYYY-MM-DD`, 0 bila rusak. */
function tahunDari(tanggal: string): number {
  const n = Number.parseInt(tanggal.slice(0, 4), 10);
  return Number.isNaN(n) ? 0 : n;
}

export interface PelatihanSah {
  id_pelatihan: string | null;
  nama: string;
  penyelenggara: string | null;
  tanggal_mulai: string;
  tanggal_selesai: string;
  lokasi: string | null;
  biaya: number;
  keterangan: string | null;
  /** Kosong = di luar rencana (dibebankan ke Umum). */
  id_rencana: string | null;
}

/**
 * Cermin `validasi_pelatihan`. Tanggal boleh di masa depan (terjadwal).
 * Rencana tertaut diperiksa pemanggil (`periksaRencanaPelatihan`).
 */
export function validasiPelatihan(draft: Draft): Hasil<PelatihanSah> {
  const namaSah = namaWajib(draft, "Nama pelatihan");
  if (!namaSah.ok) return namaSah;
  const nama = namaSah.nilai;
  const tanggal_mulai = teksIsian(draft.tanggal_mulai);
  if (!tanggal_mulai || !isValidDate(tanggal_mulai))
    return gagal("Tanggal mulai tidak valid.");
  const tanggal_selesai = teksIsian(draft.tanggal_selesai);
  if (!tanggal_selesai || !isValidDate(tanggal_selesai))
    return gagal("Tanggal selesai tidak valid.");
  if (tanggal_selesai < tanggal_mulai)
    return gagal("Tanggal selesai tidak boleh sebelum tanggal mulai.");
  const biaya = bulat(
    draft,
    "biaya",
    0,
    MAKS_BIAYA,
    0,
    "Biaya harus bilangan bulat 0–1.000.000.000.",
  );
  if (!biaya.ok) return biaya;
  const penyelenggara = teksOpsional(
    draft,
    "penyelenggara",
    "Penyelenggara",
    MAKS_PENYELENGGARA,
  );
  if (!penyelenggara.ok) return penyelenggara;
  const lokasi = teksOpsional(draft, "lokasi", "Lokasi", MAKS_LOKASI);
  if (!lokasi.ok) return lokasi;
  const keterangan = teksOpsional(
    draft,
    "keterangan",
    "Keterangan",
    MAKS_KETERANGAN,
  );
  if (!keterangan.ok) return keterangan;
  return ok({
    id_pelatihan: teksIsian(draft.id_pelatihan) ?? null,
    nama,
    penyelenggara: penyelenggara.nilai,
    tanggal_mulai,
    tanggal_selesai,
    lokasi: lokasi.nilai,
    biaya: biaya.nilai ?? 0,
    keterangan: keterangan.nilai,
    id_rencana: teksIsian(draft.id_rencana) ?? null,
  });
}

export type StatusPelatihan =
  | "Dibatalkan"
  | "Dijadwalkan"
  | "Selesai"
  | "Berlangsung";

/** Cermin `status_pelatihan`. `hariIni` tanggal WIB. */
export function statusPelatihan(
  tanggalMulai: string,
  tanggalSelesai: string,
  dibatalkan: boolean,
  hariIni: string,
): StatusPelatihan {
  if (dibatalkan) return "Dibatalkan";
  if (tanggalMulai > hariIni) return "Dijadwalkan";
  if (tanggalSelesai < hariIni) return "Selesai";
  return "Berlangsung";
}

/** Cermin `id_peserta`. */
export const idPeserta = (idPelatihan: string, idKaryawan: string) =>
  `${idPelatihan}:${idKaryawan}`;

export interface PesertaSah {
  id_karyawan: string;
  hasil: HasilPeserta | null;
  catatan: string | null;
}

/** Cermin `validasi_peserta`. Status Aktif diperiksa pemanggil. */
export function validasiPeserta(draft: Draft): Hasil<PesertaSah> {
  const id_karyawan = teksIsian(draft.id_karyawan);
  if (!id_karyawan) return gagal("Karyawan wajib dipilih.");
  const hasil = teksIsian(draft.hasil) ?? null;
  if (hasil !== null && !(HASIL_PESERTA as readonly string[]).includes(hasil))
    return gagal("Hasil pelatihan tidak dikenal.");
  const catatan = teksOpsional(
    draft,
    "catatan",
    "Catatan",
    MAKS_CATATAN_PESERTA,
  );
  if (!catatan.ok) return catatan;
  return ok({
    id_karyawan,
    hasil: hasil as HasilPeserta | null,
    catatan: catatan.nilai,
  });
}

/** Cermin `validasi_batal_pelatihan`. */
export function validasiBatalPelatihan(
  draft: Draft,
  sudahDibatalkan: boolean,
): Hasil<string> {
  if (sudahDibatalkan) return gagal(PESAN_PELATIHAN_BATAL);
  const alasan = teksOpsional(
    draft,
    "alasan",
    "Alasan pembatalan",
    MAKS_KETERANGAN,
  );
  if (!alasan.ok) return alasan;
  return alasan.nilai === null
    ? gagal("Alasan pembatalan wajib diisi.")
    : ok(alasan.nilai);
}

// ── Rencana dan pagu (fase 11) ─────────────────────────────────────────────

export interface RencanaSah {
  id_rencana: string | null;
  tahun: number;
  nama: string;
  /** Kosong = Umum. Ada dan aktif diperiksa pemanggil. */
  id_divisi: string | null;
  bulan: number | null;
  peserta_rencana: number;
  biaya_rencana: number;
  penyelenggara: string | null;
  keterangan: string | null;
}

const PESAN_TAHUN = "Tahun harus 2000–2100.";

function tahunWajib(draft: Draft): Hasil<number> {
  const tahun = bulat(draft, "tahun", 2000, 2100, null, PESAN_TAHUN);
  if (!tahun.ok) return tahun;
  return tahun.nilai === null ? gagal(PESAN_TAHUN) : ok(tahun.nilai);
}

/** Cermin `validasi_rencana` (§26.3, Q-144). */
export function validasiRencana(draft: Draft): Hasil<RencanaSah> {
  const tahun = tahunWajib(draft);
  if (!tahun.ok) return tahun;
  const nama = namaWajib(draft, "Nama rencana");
  if (!nama.ok) return nama;
  const bulan = bulat(draft, "bulan", 1, 12, null, "Bulan harus 1–12.");
  if (!bulan.ok) return bulan;
  const peserta = bulat(
    draft,
    "peserta_rencana",
    0,
    MAKS_PESERTA_RENCANA,
    0,
    "Jumlah peserta rencana harus bilangan bulat 0–9.999.",
  );
  if (!peserta.ok) return peserta;
  const biaya = bulat(
    draft,
    "biaya_rencana",
    0,
    MAKS_BIAYA,
    0,
    "Estimasi biaya harus bilangan bulat 0–1.000.000.000.",
  );
  if (!biaya.ok) return biaya;
  const penyelenggara = teksOpsional(
    draft,
    "penyelenggara",
    "Penyelenggara",
    MAKS_PENYELENGGARA,
  );
  if (!penyelenggara.ok) return penyelenggara;
  const keterangan = teksOpsional(
    draft,
    "keterangan",
    "Keterangan",
    MAKS_KETERANGAN,
  );
  if (!keterangan.ok) return keterangan;
  return ok({
    id_rencana: teksIsian(draft.id_rencana) ?? null,
    tahun: tahun.nilai,
    nama: nama.nilai,
    id_divisi: teksIsian(draft.id_divisi) ?? null,
    bulan: bulan.nilai,
    peserta_rencana: peserta.nilai ?? 0,
    biaya_rencana: biaya.nilai ?? 0,
    penyelenggara: penyelenggara.nilai,
    keterangan: keterangan.nilai,
  });
}

export interface PaguSah {
  tahun: number;
  id_divisi: string | null;
  nominal: number;
  catatan: string | null;
}

/** Cermin `validasi_pagu` (§26.4, Q-140). Divisi aktif diperiksa pemanggil. */
export function validasiPagu(draft: Draft): Hasil<PaguSah> {
  const PESAN = "Pagu harus bilangan bulat 0–100.000.000.000.";
  const tahun = tahunWajib(draft);
  if (!tahun.ok) return tahun;
  const nominal = bulat(draft, "nominal", 0, MAKS_PAGU, null, PESAN);
  if (!nominal.ok) return nominal;
  if (nominal.nilai === null) return gagal(PESAN);
  const catatan = teksOpsional(draft, "catatan", "Catatan", MAKS_CATATAN_PAGU);
  if (!catatan.ok) return catatan;
  return ok({
    tahun: tahun.nilai,
    id_divisi: teksIsian(draft.id_divisi) ?? null,
    nominal: nominal.nilai,
    catatan: catatan.nilai,
  });
}

/** Cermin `id_anggaran`: satu pagu per tahun per divisi (atau Umum). */
export const idAnggaran = (tahun: number, idDivisi: string | null) =>
  `${tahun}:${idDivisi ?? KELOMPOK_UMUM}`;

/** Cermin `periksa_rencana_pelatihan`: rencana yang ditautkan ke pelatihan. */
export function periksaRencanaPelatihan(
  tanggalMulai: string,
  tahunRencana: number,
  dibatalkan: boolean,
): Hasil<null> {
  if (dibatalkan) return gagal(PESAN_RENCANA_BATAL);
  if (tahunDari(tanggalMulai) !== tahunRencana)
    return gagal(PESAN_RENCANA_TAHUN);
  return ok(null);
}

/** Cermin `periksa_ubah_rencana`. */
export function periksaUbahRencana(
  tahunLama: number,
  tahunBaru: number,
  dibatalkan: boolean,
  tertaut: number,
): Hasil<null> {
  if (dibatalkan) return gagal(PESAN_RENCANA_BATAL);
  if (tahunLama !== tahunBaru && tertaut > 0)
    return gagal(PESAN_RENCANA_TAHUN_TERKUNCI);
  return ok(null);
}

/** Cermin `validasi_batal_rencana`. */
export function validasiBatalRencana(
  draft: Draft,
  sudahDibatalkan: boolean,
  tertaut: number,
): Hasil<string> {
  if (sudahDibatalkan) return gagal(PESAN_RENCANA_BATAL);
  if (tertaut > 0) return gagal(PESAN_RENCANA_TERTAUT);
  const alasan = teksOpsional(
    draft,
    "alasan",
    "Alasan pembatalan",
    MAKS_KETERANGAN,
  );
  if (!alasan.ok) return alasan;
  return alasan.nilai === null
    ? gagal("Alasan pembatalan wajib diisi.")
    : ok(alasan.nilai);
}

export type StatusRencana =
  | "Dibatalkan"
  | "Terlaksana"
  | "Berlangsung"
  | "Dijadwalkan"
  | "Terlewat"
  | "Belum dijadwalkan";

/** Cermin `status_rencana` (§26.3). `hariIni` tanggal WIB jam database. */
export function statusRencana(
  dibatalkan: boolean,
  tahun: number,
  bulan: number | null,
  statusTertaut: readonly string[],
  hariIni: string,
): StatusRencana {
  if (dibatalkan) return "Dibatalkan";
  if (statusTertaut.includes("Selesai")) return "Terlaksana";
  if (statusTertaut.includes("Berlangsung")) return "Berlangsung";
  if (statusTertaut.includes("Dijadwalkan")) return "Dijadwalkan";
  const tahunIni = tahunDari(hariIni);
  const bulanIni = Number.parseInt(hariIni.slice(5, 7), 10) || 0;
  const bulanLewat =
    bulan !== null &&
    (tahun < tahunIni || (tahun === tahunIni && bulan < bulanIni));
  return tahun < tahunIni || bulanLewat ? "Terlewat" : "Belum dijadwalkan";
}

export type TandaPagu = "lewat_pagu" | "rencana_lewat_pagu" | "tanpa_pagu";
export type TandaRencana = "lewat_estimasi" | "beda_tahun";

/** Cermin `tanda_pagu`: melewati pagu tidak pernah ditolak. */
function tandaPagu(
  pagu: number | null,
  direncanakan: number,
  terikat: number,
  terpakai: number,
): TandaPagu[] {
  const tanda: TandaPagu[] = [];
  if (pagu !== null) {
    if (terikat + terpakai > pagu) tanda.push("lewat_pagu");
    if (direncanakan > pagu) tanda.push("rencana_lewat_pagu");
  } else if (terikat + terpakai > 0) tanda.push("tanpa_pagu");
  return tanda;
}

type Baris = Record<string, unknown>;

/** Cermin `teks_baris`. */
const teksBaris = (b: Baris, k: string): string | null => {
  const v = b[k];
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t === "" ? null : t;
};
/** Cermin `angka_baris`. */
const angkaBaris = (b: Baris, k: string): number => {
  const v = b[k];
  return typeof v === "number" && Number.isSafeInteger(v) ? v : 0;
};

export interface KelompokAnggaran {
  kunci: string;
  id_divisi: string | null;
  nama: string;
  divisi_aktif: boolean | null;
  id_anggaran: string | null;
  pagu: number | null;
  catatan: string | null;
  direncanakan: number;
  terikat: number;
  terpakai: number;
  sisa: number | null;
  tanda: TandaPagu[];
}

export interface PelatihanTertaut {
  id_pelatihan: string | null;
  nama: string | null;
  tanggal_mulai: string | null;
  biaya: number;
  jumlah_peserta: number;
  status: StatusPelatihan;
}

export type RencanaRingkas = Baris & {
  status: StatusRencana;
  realisasi: number;
  jumlah_pelatihan: number;
  peserta_aktual: number;
  pelatihan: PelatihanTertaut[];
  tanda: TandaRencana[];
};

export interface RingkasanAnggaran {
  kelompok: KelompokAnggaran[];
  total: Omit<
    KelompokAnggaran,
    "kunci" | "id_divisi" | "nama" | "divisi_aktif" | "id_anggaran" | "catatan"
  >;
  rencana: RencanaRingkas[];
  di_luar_rencana: {
    jumlah_pelatihan: number;
    realisasi: number;
    peserta_aktual: number;
  };
}

/**
 * Cermin `ringkas_anggaran` (§26.4, Q-140 sampai Q-143). Masukannya baris
 * `PAGU_SQL`, `RENCANA_SQL`, dan `REALISASI_SQL` untuk `tahun`. Kelompok:
 * Umum lebih dulu, lalu urut nama dan id divisi (perbandingan teks biasa,
 * sama dengan urutan bita Rust untuk huruf Latin).
 */
export function ringkasAnggaran(
  pagu: readonly Baris[],
  rencana: readonly Baris[],
  pelatihan: readonly Baris[],
  tahun: number,
  hariIni: string,
): RingkasanAnggaran {
  type Kelompok = Omit<KelompokAnggaran, "sisa" | "tanda">;
  const daftar: Kelompok[] = [];
  const kelompok = (baris: Baris): Kelompok => {
    const id_divisi = teksBaris(baris, "id_divisi");
    const kunci = id_divisi ?? KELOMPOK_UMUM;
    const ada = daftar.find((k) => k.kunci === kunci);
    if (ada) return ada;
    const aktif = id_divisi === null ? 0 : baris.divisi_aktif;
    const baru: Kelompok = {
      kunci,
      id_divisi,
      nama:
        id_divisi === null
          ? "Umum"
          : (teksBaris(baris, "nama_divisi") ?? id_divisi),
      divisi_aktif:
        id_divisi !== null &&
        typeof aktif === "number" &&
        Number.isSafeInteger(aktif)
          ? aktif === 1
          : null,
      id_anggaran: null,
      pagu: null,
      catatan: null,
      direncanakan: 0,
      terikat: 0,
      terpakai: 0,
    };
    daftar.push(baru);
    return baru;
  };
  kelompok({});
  for (const baris of pagu) {
    const k = kelompok(baris);
    k.id_anggaran = teksBaris(baris, "id_anggaran");
    k.pagu = angkaBaris(baris, "nominal");
    k.catatan = teksBaris(baris, "catatan");
  }
  const status = pelatihan.map((l) =>
    statusPelatihan(
      teksBaris(l, "tanggal_mulai") ?? "",
      teksBaris(l, "tanggal_selesai") ?? "",
      teksBaris(l, "dibatalkan_pada") !== null,
      hariIni,
    ),
  );
  const tahunPelatihan = (i: number) =>
    tahunDari(teksBaris(pelatihan[i] ?? {}, "tanggal_mulai") ?? "");
  const rincianRencana: RencanaRingkas[] = rencana.map((r) => {
    const id = teksBaris(r, "id_rencana");
    const dibatalkan = teksBaris(r, "dibatalkan_pada") !== null;
    const biayaRencana = angkaBaris(r, "biaya_rencana");
    if (!dibatalkan) kelompok(r).direncanakan += biayaRencana;
    const tertaut = pelatihan.flatMap((l, i) =>
      status[i] !== "Dibatalkan" &&
      id !== null &&
      teksBaris(l, "id_rencana") === id
        ? [i]
        : [],
    );
    const realisasi = tertaut.reduce(
      (n, i) => n + angkaBaris(pelatihan[i] ?? {}, "biaya"),
      0,
    );
    const tahunRencana = angkaBaris(r, "tahun");
    const tanda: TandaRencana[] = [];
    if (realisasi > biayaRencana) tanda.push("lewat_estimasi");
    if (tertaut.some((i) => tahunPelatihan(i) !== tahunRencana))
      tanda.push("beda_tahun");
    const bulan =
      typeof r.bulan === "number" && Number.isSafeInteger(r.bulan)
        ? r.bulan
        : null;
    return {
      ...r,
      status: statusRencana(
        dibatalkan,
        tahunRencana,
        bulan,
        tertaut.map((i) => status[i] ?? "Dibatalkan"),
        hariIni,
      ),
      realisasi,
      jumlah_pelatihan: tertaut.length,
      peserta_aktual: tertaut.reduce(
        (n, i) => n + angkaBaris(pelatihan[i] ?? {}, "jumlah_peserta"),
        0,
      ),
      pelatihan: tertaut.map((i) => {
        const l = pelatihan[i] ?? {};
        return {
          id_pelatihan: teksBaris(l, "id_pelatihan"),
          nama: teksBaris(l, "nama"),
          tanggal_mulai: teksBaris(l, "tanggal_mulai"),
          biaya: angkaBaris(l, "biaya"),
          jumlah_peserta: angkaBaris(l, "jumlah_peserta"),
          status: status[i] ?? "Dibatalkan",
        };
      }),
      tanda,
    };
  });
  const luar = { jumlah_pelatihan: 0, realisasi: 0, peserta_aktual: 0 };
  pelatihan.forEach((l, i) => {
    if (status[i] === "Dibatalkan" || tahunPelatihan(i) !== tahun) return;
    const biaya = angkaBaris(l, "biaya");
    if (teksBaris(l, "id_rencana") === null) {
      luar.jumlah_pelatihan += 1;
      luar.realisasi += biaya;
      luar.peserta_aktual += angkaBaris(l, "jumlah_peserta");
    }
    const k = kelompok(l);
    if (status[i] === "Dijadwalkan") k.terikat += biaya;
    else k.terpakai += biaya;
  });
  const [umum, ...lain] = daftar;
  lain.sort((a, b) =>
    a.nama !== b.nama
      ? a.nama < b.nama
        ? -1
        : 1
      : a.kunci < b.kunci
        ? -1
        : a.kunci > b.kunci
          ? 1
          : 0,
  );
  const urut = umum ? [umum, ...lain] : lain;
  const jumlah = (f: (k: Kelompok) => number) =>
    urut.reduce((n, k) => n + f(k), 0);
  const totalPagu = urut.some((k) => k.pagu !== null)
    ? jumlah((k) => k.pagu ?? 0)
    : null;
  const direncanakan = jumlah((k) => k.direncanakan);
  const terikat = jumlah((k) => k.terikat);
  const terpakai = jumlah((k) => k.terpakai);
  return {
    kelompok: urut.map((k) => ({
      ...k,
      sisa: k.pagu === null ? null : k.pagu - k.terikat - k.terpakai,
      tanda: tandaPagu(k.pagu, k.direncanakan, k.terikat, k.terpakai),
    })),
    total: {
      pagu: totalPagu,
      direncanakan,
      terikat,
      terpakai,
      sisa: totalPagu === null ? null : totalPagu - terikat - terpakai,
      tanda: tandaPagu(totalPagu, direncanakan, terikat, terpakai),
    },
    rencana: rincianRencana,
    di_luar_rencana: luar,
  };
}
