/**
 * HRIS fase 7 (skema v42): pelatihan, peserta, dan sertifikat.
 *
 * Cermin `desktop/hr_pelatihan.rs`, diuji dengan vektor yang sama. Kedua
 * tabelnya KHUSUS CLOUD (Q-87); sertifikat = `hr_dokumen` berjenis
 * `dok-sertifikat` (Q-97); biaya satu total per pelatihan tanpa jurnal (Q-98).
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
  "INSERT INTO hr_pelatihan (id_pelatihan, nama, penyelenggara, tanggal_mulai, tanggal_selesai, lokasi, biaya, keterangan, dicatat_oleh) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9);";

export const UBAH_PELATIHAN_SQL =
  "UPDATE hr_pelatihan SET nama = ?2, penyelenggara = ?3, tanggal_mulai = ?4, tanggal_selesai = ?5, lokasi = ?6, biaya = ?7, keterangan = ?8, diubah_oleh = ?9, diubah_pada = datetime('now') WHERE id_pelatihan = ?1 AND dibatalkan_pada IS NULL;";

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

export interface PelatihanSah {
  id_pelatihan: string | null;
  nama: string;
  penyelenggara: string | null;
  tanggal_mulai: string;
  tanggal_selesai: string;
  lokasi: string | null;
  biaya: number;
  keterangan: string | null;
}

/** Cermin `validasi_pelatihan`. Tanggal boleh di masa depan (terjadwal). */
export function validasiPelatihan(draft: Draft): Hasil<PelatihanSah> {
  const namaMentah = teksIsian(draft.nama);
  if (!namaMentah) return gagal("Nama pelatihan wajib diisi.");
  const nama = namaMentah.split(/\s+/).filter(Boolean).join(" ");
  if (panjang(nama) > MAKS_NAMA_PELATIHAN)
    return gagal(`Nama pelatihan maksimal ${MAKS_NAMA_PELATIHAN} karakter.`);
  const tanggal_mulai = teksIsian(draft.tanggal_mulai);
  if (!tanggal_mulai || !isValidDate(tanggal_mulai))
    return gagal("Tanggal mulai tidak valid.");
  const tanggal_selesai = teksIsian(draft.tanggal_selesai);
  if (!tanggal_selesai || !isValidDate(tanggal_selesai))
    return gagal("Tanggal selesai tidak valid.");
  if (tanggal_selesai < tanggal_mulai)
    return gagal("Tanggal selesai tidak boleh sebelum tanggal mulai.");
  const mentah = draft.biaya;
  let biaya = 0;
  if (mentah !== undefined && mentah !== null) {
    if (
      typeof mentah !== "number" ||
      !Number.isSafeInteger(mentah) ||
      mentah < 0 ||
      mentah > MAKS_BIAYA
    )
      return gagal("Biaya harus bilangan bulat 0–1.000.000.000.");
    biaya = mentah;
  }
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
    biaya,
    keterangan: keterangan.nilai,
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
