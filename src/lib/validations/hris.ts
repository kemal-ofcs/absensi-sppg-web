// HRIS fase 1 (v36): organisasi, kontrak, profil, dan dokumen karyawan.
// Kembaran `desktop/hris.rs`: aturan murni, pesan galat, dan SQL WAJIB
// identik, diuji dengan vektor yang sama (`hris.test.ts` ↔ `mod tests`).
// Penjelasan lengkap ada di kepala berkas Rust dan `prd-hris.md` §16.

import {
  isValidOperatorPhone,
  normalizeOperatorPhone,
} from "@/lib/operators/contact";
import { isValidDate } from "@/lib/validations/inventory";
import { base64Sah } from "@/lib/validations/inventory-pengajuan";

// ── Konstanta ──────────────────────────────────────────────────────────────

export const MAKS_NAMA = 100;
export const MAKS_TEKS = 255;
export const MAKS_CATATAN = 1000;
export const MAKS_BERKAS_PER_DOKUMEN = 5;
/** 1 MB setelah didekode. Cermin `MAKS_BERKAS_BASE64`. */
export const MAKS_BERKAS_BASE64 = 1_398_104;
export const MIME_BERKAS = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/pdf",
] as const;
export const AGAMA = [
  "Islam",
  "Kristen",
  "Katolik",
  "Hindu",
  "Buddha",
  "Konghucu",
  "Lainnya",
] as const;
export const STATUS_NIKAH = [
  "Belum Kawin",
  "Kawin",
  "Cerai Hidup",
  "Cerai Mati",
] as const;
export const PENDIDIKAN = [
  "SD",
  "SMP",
  "SMA/SMK",
  "D1",
  "D2",
  "D3",
  "D4",
  "S1",
  "S2",
  "S3",
  "Lainnya",
] as const;
export const JENIS_KONTRAK = [
  "PKWTT",
  "PKWT",
  "Harian Lepas",
  "Magang",
] as const;
export type JenisKontrak = (typeof JENIS_KONTRAK)[number];

export const KUNCI_PERCOBAAN_MAKS_BULAN = "hr_percobaan_maks_bulan";
export const KUNCI_PKWT_MAKS_BULAN = "hr_pkwt_maks_bulan";
export const KUNCI_HARIAN_BATAS_HARI = "hr_harian_batas_hari";
export const KUNCI_HARIAN_BATAS_BULAN = "hr_harian_batas_bulan";
/** Masa berlaku SP dalam bulan (fase 5); dibekukan per SP saat dibuat. */
export const KUNCI_SP_MASA_BULAN = "hr_sp_masa_bulan";
/** Masa simpan data pelamar (fase 7, Q-33); berlaku surut saat diubah. */
export const KUNCI_PELAMAR_RETENSI_BULAN = "hr_pelamar_retensi_bulan";

export const KOLOM_PRIBADI = [
  "nik",
  "no_kk",
  "tempat_lahir",
  "tanggal_lahir",
  "agama",
  "status_nikah",
  "alamat_ktp",
  "alamat_domisili",
  "pendidikan",
  "darurat_nama",
  "darurat_hubungan",
  "darurat_hp",
] as const;
export const KOLOM_KEUANGAN = [
  "bank",
  "no_rekening",
  "nama_rekening",
  "npwp",
  "bpjs_kesehatan",
  "bpjs_ketenagakerjaan",
] as const;

// ── SQL kembar (harfiah di `hris.rs`) ──────────────────────────────────────

export const SEED_JENIS_DOKUMEN_SQL = `INSERT OR IGNORE INTO hr_dokumen_jenis (id_jenis, nama) VALUES
    ('dok-ktp', 'KTP'),
    ('dok-kk', 'KK'),
    ('dok-npwp', 'NPWP'),
    ('dok-ijazah', 'Ijazah'),
    ('dok-kontrak', 'Kontrak Kerja'),
    ('dok-sertifikat', 'Sertifikat'),
    ('dok-sim', 'SIM'),
    ('dok-surat-dokter', 'Surat Dokter'),
    ('dok-lainnya', 'Lainnya');`;

export const MIGRASI_ORGANISASI_SQL = [
  "INSERT OR IGNORE INTO hr_cabang (id_cabang, nama) SELECT 'cab-pusat', 'Pusat' WHERE EXISTS (SELECT 1 FROM master_data);",
  "INSERT OR IGNORE INTO hr_divisi (id_divisi, nama) SELECT 'div-' || lower(hex(lower(trim(divisi)))), MIN(TRIM(divisi)) FROM master_data WHERE TRIM(COALESCE(divisi, '')) <> '' GROUP BY lower(trim(divisi));",
  "INSERT OR IGNORE INTO hr_divisi_nama (id_nama, id_divisi, nama) SELECT d.id_divisi || ':awal', d.id_divisi, d.nama FROM hr_divisi d WHERE NOT EXISTS (SELECT 1 FROM hr_divisi_nama n WHERE n.id_divisi = d.id_divisi);",
  "INSERT OR IGNORE INTO hr_jabatan (id_jabatan, nama) SELECT 'jab-' || lower(hex(lower(trim(jabatan_status)))), MIN(TRIM(jabatan_status)) FROM master_data WHERE TRIM(COALESCE(jabatan_status, '')) NOT IN ('', '-') GROUP BY lower(trim(jabatan_status));",
  "UPDATE master_data SET id_cabang = 'cab-pusat' WHERE COALESCE(id_cabang, '') = '' AND EXISTS (SELECT 1 FROM hr_cabang WHERE id_cabang = 'cab-pusat');",
  "UPDATE master_data SET id_divisi = 'div-' || lower(hex(lower(trim(divisi)))) WHERE COALESCE(id_divisi, '') = '' AND EXISTS (SELECT 1 FROM hr_divisi d WHERE d.id_divisi = 'div-' || lower(hex(lower(trim(master_data.divisi)))));",
  "UPDATE master_data SET id_jabatan = 'jab-' || lower(hex(lower(trim(jabatan_status)))) WHERE COALESCE(id_jabatan, '') = '' AND EXISTS (SELECT 1 FROM hr_jabatan j WHERE j.id_jabatan = 'jab-' || lower(hex(lower(trim(master_data.jabatan_status)))));",
] as const;

export const DIVISI_KINI_SQL =
  "COALESCE((SELECT d.nama FROM hr_divisi_nama n JOIN hr_divisi d ON d.id_divisi = n.id_divisi WHERE LOWER(TRIM(n.nama)) = LOWER(TRIM({kolom})) ORDER BY n.created_at, n.id_nama LIMIT 1), {kolom})";

/** Nama divisi SEKARANG untuk teks divisi riwayat. Cermin `divisi_kini`. */
export function divisiKini(kolom: string): string {
  return DIVISI_KINI_SQL.replaceAll("{kolom}", kolom);
}

export const UPSERT_CABANG_SQL = `INSERT INTO hr_cabang (id_cabang, nama, alamat, is_aktif, created_at, updated_at)
    VALUES (?1, ?2, ?3, ?4, COALESCE(?5, datetime('now')), datetime('now'))
    ON CONFLICT(id_cabang) DO UPDATE SET nama = excluded.nama, alamat = excluded.alamat, is_aktif = excluded.is_aktif, updated_at = excluded.updated_at;`;

export const UPSERT_DIVISI_SQL = `INSERT INTO hr_divisi (id_divisi, nama, is_aktif, created_at, updated_at)
    VALUES (?1, ?2, ?3, COALESCE(?4, datetime('now')), datetime('now'))
    ON CONFLICT(id_divisi) DO UPDATE SET nama = excluded.nama, is_aktif = excluded.is_aktif, updated_at = excluded.updated_at;`;

export const INSERT_NAMA_DIVISI_SQL = `INSERT INTO hr_divisi_nama (id_nama, id_divisi, nama, created_at)
    VALUES (?1, ?2, ?3, COALESCE(?4, datetime('now')))
    ON CONFLICT(id_nama) DO NOTHING;`;

export const UPSERT_JABATAN_SQL = `INSERT INTO hr_jabatan (id_jabatan, nama, is_aktif, created_at, updated_at)
    VALUES (?1, ?2, ?3, COALESCE(?4, datetime('now')), datetime('now'))
    ON CONFLICT(id_jabatan) DO UPDATE SET nama = excluded.nama, is_aktif = excluded.is_aktif, updated_at = excluded.updated_at;`;

export const SELARASKAN_DIVISI_SQL = [
  "UPDATE master_data SET id_divisi = ?1 WHERE COALESCE(id_divisi, '') = '' AND LOWER(TRIM(divisi)) IN (SELECT LOWER(TRIM(nama)) FROM hr_divisi_nama WHERE id_divisi = ?1);",
  "UPDATE master_data SET divisi = (SELECT nama FROM hr_divisi WHERE id_divisi = ?1) WHERE id_divisi = ?1;",
  "UPDATE id_card SET divisi = (SELECT nama FROM hr_divisi WHERE id_divisi = ?1) WHERE id_unik IN (SELECT id_unik FROM master_data WHERE id_divisi = ?1);",
] as const;

export const SELARASKAN_JABATAN_SQL = [
  "UPDATE master_data SET id_jabatan = ?1 WHERE COALESCE(id_jabatan, '') = '' AND LOWER(TRIM(jabatan_status)) = (SELECT LOWER(TRIM(nama)) FROM hr_jabatan WHERE id_jabatan = ?1);",
  "UPDATE master_data SET jabatan_status = (SELECT nama FROM hr_jabatan WHERE id_jabatan = ?1) WHERE id_jabatan = ?1;",
] as const;

export const CLOUD_ORG_KARYAWAN_SQL = [
  `UPDATE master_data SET
        id_divisi = COALESCE((SELECT d.id_divisi FROM hr_divisi d WHERE d.id_divisi = NULLIF(?1, '')), (SELECT n.id_divisi FROM hr_divisi_nama n WHERE LOWER(TRIM(n.nama)) = LOWER(TRIM(master_data.divisi)) ORDER BY n.created_at, n.id_nama LIMIT 1)),
        id_jabatan = COALESCE((SELECT j.id_jabatan FROM hr_jabatan j WHERE j.id_jabatan = NULLIF(?2, '')), (SELECT j.id_jabatan FROM hr_jabatan j WHERE LOWER(TRIM(j.nama)) = LOWER(TRIM(master_data.jabatan_status)) ORDER BY j.created_at, j.id_jabatan LIMIT 1))
     WHERE id_unik = ?3;`,
] as const;

export const CLOUD_TEKS_KARYAWAN_SQL = [
  "UPDATE master_data SET divisi = (SELECT d.nama FROM hr_divisi d WHERE d.id_divisi = master_data.id_divisi) WHERE id_unik = ?1 AND EXISTS (SELECT 1 FROM hr_divisi d WHERE d.id_divisi = master_data.id_divisi);",
  "UPDATE master_data SET jabatan_status = (SELECT j.nama FROM hr_jabatan j WHERE j.id_jabatan = master_data.id_jabatan) WHERE id_unik = ?1 AND EXISTS (SELECT 1 FROM hr_jabatan j WHERE j.id_jabatan = master_data.id_jabatan);",
] as const;

export const JENIS_DARI_KONTRAK_SQL =
  "UPDATE master_data SET jenis_personil = COALESCE((SELECT CASE k.jenis WHEN 'PKWTT' THEN 'Pegawai' WHEN 'PKWT' THEN 'Kontrak' WHEN 'Harian Lepas' THEN 'Harian' ELSE 'Magang' END FROM hr_kontrak k WHERE k.id_karyawan = master_data.id_unik AND k.jenis <> 'Pembatalan' AND NOT EXISTS (SELECT 1 FROM hr_kontrak b WHERE b.id_kontrak = 'batal-' || k.id_kontrak) ORDER BY k.tanggal_mulai DESC, k.id_kontrak DESC LIMIT 1), jenis_personil) WHERE id_unik = ?1;";

/** Cermin `SIMPAN_DOKUMEN_SQL`; dipakai juga sertifikat pelatihan (fase 7). */
export const SIMPAN_DOKUMEN_SQL =
  "INSERT INTO hr_dokumen (id_dokumen, id_karyawan, id_jenis, nomor, tanggal_terbit, tanggal_kedaluwarsa, catatan, dicatat_oleh) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8) ON CONFLICT(id_dokumen) DO UPDATE SET id_jenis = excluded.id_jenis, nomor = excluded.nomor, tanggal_terbit = excluded.tanggal_terbit, tanggal_kedaluwarsa = excluded.tanggal_kedaluwarsa, catatan = excluded.catatan, updated_at = datetime('now');";

export const INSERT_BERKAS_DOKUMEN_SQL =
  "INSERT INTO hr_dokumen_berkas (id_berkas, id_dokumen, urutan, nama_berkas, mime_type, data_base64) VALUES (?1, ?2, ?3, ?4, ?5, ?6);";

/** Cermin `HAPUS_DOKUMEN_SQL`: juga melepas tautan sertifikat peserta. */
export const HAPUS_DOKUMEN_SQL = [
  "DELETE FROM hr_dokumen_berkas WHERE id_dokumen = ?1;",
  "UPDATE hr_pelatihan_peserta SET id_dokumen = NULL WHERE id_dokumen = ?1;",
  "DELETE FROM hr_dokumen WHERE id_dokumen = ?1;",
] as const;

export const INSERT_KONTRAK_SQL = `INSERT INTO hr_kontrak (
        id_kontrak, id_karyawan, jenis, id_ref, nomor, tanggal_mulai, tanggal_selesai,
        percobaan_selesai, catatan, dicatat_oleh, created_at
    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, COALESCE(?11, datetime('now')))
    ON CONFLICT(id_kontrak) DO NOTHING;`;

// ── Aturan murni ───────────────────────────────────────────────────────────

type Hasil<T> = { ok: true; nilai: T } | { ok: false; pesan: string };
const ok = <T>(nilai: T): Hasil<T> => ({ ok: true, nilai });
const gagal = <T = never>(pesan: string): Hasil<T> => ({ ok: false, pesan });

const panjang = (teks: string) => [...teks].length;

/** Cermin `payload_text`: teks dipangkas, kosong/bukan teks = undefined. */
export function teksIsian(nilai: unknown): string | undefined {
  if (typeof nilai !== "string") return undefined;
  const teks = nilai.trim();
  return teks === "" ? undefined : teks;
}

/** Cermin `nama_master`. */
export function namaMaster(masukan: string): Hasil<string> {
  const nama = masukan.split(/\s+/).filter(Boolean).join(" ");
  if (nama === "") return gagal("Nama wajib diisi.");
  if (panjang(nama) > MAKS_NAMA) {
    return gagal(`Nama maksimal ${MAKS_NAMA} karakter.`);
  }
  return ok(nama);
}

/** Cermin `kunci_nama`. */
export function kunciNama(nama: string): string {
  return nama.split(/\s+/).filter(Boolean).join(" ").toLowerCase();
}

/** Cermin `nomor_identitas`. */
export function nomorIdentitas(
  masukan: string | null | undefined,
  label: string,
  panjangSah: readonly number[],
): Hasil<string | null> {
  const teks = (masukan ?? "").trim();
  if (teks === "") return ok(null);
  const digit = teks.replace(/[ .\-/]/g, "");
  if (!/^[0-9]*$/.test(digit))
    return gagal(`${label} hanya boleh berisi angka.`);
  if (!panjangSah.includes(digit.length)) {
    if (panjangSah.length === 1)
      return gagal(`${label} harus ${panjangSah[0]} digit.`);
    if (panjangSah.length === 2) {
      return gagal(
        `${label} harus ${panjangSah[0]} atau ${panjangSah[1]} digit.`,
      );
    }
    return gagal(
      `${label} harus ${panjangSah[0]}–${panjangSah[panjangSah.length - 1]} digit.`,
    );
  }
  return ok(digit);
}

export const PANJANG_REKENING = Array.from({ length: 16 }, (_, i) => i + 5);

const LABEL_KOLOM: Record<string, string> = {
  nik: "NIK",
  no_kk: "Nomor KK",
  tempat_lahir: "Tempat lahir",
  tanggal_lahir: "Tanggal lahir",
  agama: "Agama",
  status_nikah: "Status nikah",
  alamat_ktp: "Alamat KTP",
  alamat_domisili: "Alamat domisili",
  pendidikan: "Pendidikan",
  darurat_nama: "Nama kontak darurat",
  darurat_hubungan: "Hubungan kontak darurat",
  darurat_hp: "Nomor HP kontak darurat",
  bank: "Bank",
  no_rekening: "Nomor rekening",
  nama_rekening: "Nama pemilik rekening",
  npwp: "NPWP",
  bpjs_kesehatan: "Nomor BPJS Kesehatan",
  bpjs_ketenagakerjaan: "Nomor BPJS Ketenagakerjaan",
};

function isianObjek(
  draft: unknown,
  kolom: readonly string[],
): Hasil<Map<string, string | null>> {
  if (!draft || typeof draft !== "object" || Array.isArray(draft)) {
    return gagal("Isian tidak valid.");
  }
  const hasil = new Map<string, string | null>();
  for (const [kunci, nilai] of Object.entries(draft)) {
    if (!kolom.includes(kunci)) return gagal(`Isian '${kunci}' tidak dikenal.`);
    if (nilai === null) {
      hasil.set(kunci, null);
    } else if (typeof nilai === "string") {
      hasil.set(kunci, nilai.trim() === "" ? null : nilai.trim());
    } else {
      return gagal(`${LABEL_KOLOM[kunci] ?? "Isian"} tidak valid.`);
    }
  }
  return ok(hasil);
}

function teksTerbatas(
  nilai: string | null | undefined,
  label: string,
  maks: number,
): Hasil<string | null> {
  if (nilai && panjang(nilai) > maks)
    return gagal(`${label} maksimal ${maks} karakter.`);
  return ok(nilai ?? null);
}

function pilihan(
  nilai: string | null | undefined,
  label: string,
  daftar: readonly string[],
): Hasil<string | null> {
  if (nilai && !daftar.includes(nilai)) return gagal(`${label} tidak dikenal.`);
  return ok(nilai ?? null);
}

/** Jalankan langkah berurutan; galat pertama menghentikan. */
function berurutan(
  langkah: Array<() => Hasil<string | null>>,
): Hasil<Array<string | null>> {
  const hasil: Array<string | null> = [];
  for (const l of langkah) {
    const r = l();
    if (!r.ok) return r;
    hasil.push(r.nilai);
  }
  return ok(hasil);
}

/** Cermin `validasi_pribadi`. Hasil berurutan `KOLOM_PRIBADI`. */
export function validasiPribadi(draft: unknown): Hasil<Array<string | null>> {
  const isian = isianObjek(draft, KOLOM_PRIBADI);
  if (!isian.ok) return isian;
  const a = (k: string) => isian.nilai.get(k) ?? null;
  return berurutan([
    () => nomorIdentitas(a("nik"), "NIK", [16]),
    () => nomorIdentitas(a("no_kk"), "Nomor KK", [16]),
    () => teksTerbatas(a("tempat_lahir"), "Tempat lahir", MAKS_NAMA),
    () => {
      const t = a("tanggal_lahir");
      return t && !isValidDate(t) ? gagal("Tanggal lahir tidak valid.") : ok(t);
    },
    () => pilihan(a("agama"), "Agama", AGAMA),
    () => pilihan(a("status_nikah"), "Status nikah", STATUS_NIKAH),
    () => teksTerbatas(a("alamat_ktp"), "Alamat KTP", MAKS_TEKS),
    () => teksTerbatas(a("alamat_domisili"), "Alamat domisili", MAKS_TEKS),
    () => pilihan(a("pendidikan"), "Pendidikan", PENDIDIKAN),
    () => teksTerbatas(a("darurat_nama"), "Nama kontak darurat", MAKS_NAMA),
    () =>
      teksTerbatas(a("darurat_hubungan"), "Hubungan kontak darurat", MAKS_NAMA),
    () => {
      const t = a("darurat_hp");
      if (!t) return ok(null);
      const normal = normalizeOperatorPhone(t);
      return isValidOperatorPhone(normal)
        ? ok(normal)
        : gagal("Nomor HP kontak darurat tidak valid.");
    },
  ]);
}

/** Cermin `validasi_keuangan`. Hasil berurutan `KOLOM_KEUANGAN`. */
export function validasiKeuangan(draft: unknown): Hasil<Array<string | null>> {
  const isian = isianObjek(draft, KOLOM_KEUANGAN);
  if (!isian.ok) return isian;
  const a = (k: string) => isian.nilai.get(k) ?? null;
  return berurutan([
    () => teksTerbatas(a("bank"), "Bank", MAKS_NAMA),
    () => nomorIdentitas(a("no_rekening"), "Nomor rekening", PANJANG_REKENING),
    () => teksTerbatas(a("nama_rekening"), "Nama pemilik rekening", MAKS_NAMA),
    () => nomorIdentitas(a("npwp"), "NPWP", [15, 16]),
    () =>
      nomorIdentitas(
        a("bpjs_kesehatan"),
        "Nomor BPJS Kesehatan",
        PANJANG_REKENING,
      ),
    () =>
      nomorIdentitas(
        a("bpjs_ketenagakerjaan"),
        "Nomor BPJS Ketenagakerjaan",
        PANJANG_REKENING,
      ),
  ]);
}

export interface Kontrak {
  id_kontrak: string;
  jenis: string;
  id_ref: string | null;
  tanggal_mulai: string;
  tanggal_selesai: string | null;
  percobaan_selesai: string | null;
}

export interface KontrakSah {
  id_karyawan: string;
  jenis: JenisKontrak;
  nomor: string | null;
  tanggal_mulai: string;
  tanggal_selesai: string | null;
  percobaan_selesai: string | null;
  catatan: string | null;
}

/** Cermin `validasi_kontrak`. Hanya kelengkapan; angka hukum = tanda. */
export function validasiKontrak(
  draft: Record<string, unknown>,
): Hasil<KontrakSah> {
  const t = (k: string) => teksIsian(draft[k]);
  const id_karyawan = t("id_karyawan");
  if (!id_karyawan) return gagal("Karyawan wajib dipilih.");
  const jenis = t("jenis");
  if (!jenis || !(JENIS_KONTRAK as readonly string[]).includes(jenis)) {
    return gagal("Jenis kontrak tidak dikenal.");
  }
  const tanggal_mulai = t("tanggal_mulai");
  if (!tanggal_mulai || !isValidDate(tanggal_mulai)) {
    return gagal("Tanggal mulai tidak valid.");
  }
  const tanggal_selesai = t("tanggal_selesai") ?? null;
  if (tanggal_selesai) {
    if (!isValidDate(tanggal_selesai))
      return gagal("Tanggal selesai tidak valid.");
    if (tanggal_selesai < tanggal_mulai) {
      return gagal("Tanggal selesai tidak boleh sebelum tanggal mulai.");
    }
  }
  if ((jenis === "PKWT" || jenis === "Magang") && !tanggal_selesai) {
    return gagal("Kontrak PKWT dan Magang wajib punya tanggal selesai.");
  }
  if (jenis === "PKWTT" && tanggal_selesai) {
    return gagal("Kontrak PKWTT tidak punya tanggal selesai.");
  }
  const percobaan_selesai = t("percobaan_selesai") ?? null;
  if (percobaan_selesai) {
    if (jenis !== "PKWTT") return gagal("Masa percobaan hanya untuk PKWTT.");
    if (!isValidDate(percobaan_selesai) || percobaan_selesai < tanggal_mulai) {
      return gagal("Akhir masa percobaan tidak valid.");
    }
  }
  const nomor = teksTerbatas(t("nomor"), "Nomor kontrak", MAKS_NAMA);
  if (!nomor.ok) return nomor;
  const catatan = teksTerbatas(t("catatan"), "Catatan", MAKS_CATATAN);
  if (!catatan.ok) return catatan;
  return ok({
    id_karyawan,
    jenis: jenis as JenisKontrak,
    nomor: nomor.nilai,
    tanggal_mulai,
    tanggal_selesai,
    percobaan_selesai,
    catatan: catatan.nilai,
  });
}

const banding = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Cermin `kontrak_aktif`. */
export function kontrakAktif(kontrak: readonly Kontrak[]): Kontrak[] {
  const batal = new Set(
    kontrak
      .filter((k) => k.jenis === "Pembatalan" && k.id_ref)
      .map((k) => k.id_ref as string),
  );
  return kontrak
    .filter((k) => k.jenis !== "Pembatalan" && !batal.has(k.id_kontrak))
    .sort(
      (a, b) =>
        banding(a.tanggal_mulai, b.tanggal_mulai) ||
        banding(a.id_kontrak, b.id_kontrak),
    );
}

export interface StatusKerja {
  keadaan: "Berlaku" | "Berakhir" | "Tanpa kontrak";
  jenis?: string;
  id_kontrak?: string;
  sampai?: string | null;
  percobaan_sampai?: string | null;
}

/** Cermin `status_kerja`. */
export function statusKerja(
  kontrak: readonly Kontrak[],
  tanggal: string,
): StatusKerja {
  const k = kontrakAktif(kontrak)
    .filter((x) => x.tanggal_mulai <= tanggal)
    .at(-1);
  if (!k) return { keadaan: "Tanpa kontrak" };
  const berakhir = k.tanggal_selesai !== null && k.tanggal_selesai < tanggal;
  return {
    keadaan: berakhir ? "Berakhir" : "Berlaku",
    jenis: k.jenis,
    id_kontrak: k.id_kontrak,
    sampai: k.tanggal_selesai,
    percobaan_sampai:
      k.percobaan_selesai && k.percobaan_selesai >= tanggal
        ? k.percobaan_selesai
        : null,
  };
}

function ymd(tanggal: string): [number, number, number] | null {
  if (!isValidDate(tanggal)) return null;
  const [y, m, d] = tanggal.split("-").map(Number);
  return [y, m, d];
}

function hariDalamBulan(tahun: number, bulan: number): number {
  return new Date(Date.UTC(tahun, bulan, 0)).getUTCDate();
}

const dua = (n: number) => String(n).padStart(2, "0");

/** Cermin `tambah_bulan`. */
export function tambahBulan(tanggal: string, n: number): string | null {
  const t = ymd(tanggal);
  if (!t) return null;
  const total = t[0] * 12 + (t[1] - 1) + n;
  const ty = Math.floor(total / 12);
  const tm = total - ty * 12 + 1;
  return `${String(ty).padStart(4, "0")}-${dua(tm)}-${dua(Math.min(t[2], hariDalamBulan(ty, tm)))}`;
}

/** Cermin `nomor_hari`: hari sejak 1970-01-01. */
export function nomorHari(tanggal: string): number | null {
  const t = ymd(tanggal);
  if (!t) return null;
  return Math.round(Date.UTC(t[0], t[1] - 1, t[2]) / 86_400_000);
}

export interface PengaturanKontrak {
  hr_percobaan_maks_bulan: number;
  hr_pkwt_maks_bulan: number;
  hr_harian_batas_hari: number;
  hr_harian_batas_bulan: number;
  hr_sp_masa_bulan: number;
  hr_pelamar_retensi_bulan: number;
}

export const PENGATURAN_KONTRAK_BAWAAN: PengaturanKontrak = {
  hr_percobaan_maks_bulan: 3,
  hr_pkwt_maks_bulan: 60,
  hr_harian_batas_hari: 21,
  hr_harian_batas_bulan: 3,
  hr_sp_masa_bulan: 6,
  hr_pelamar_retensi_bulan: 12,
};

/** Cermin `BATAS_PENGATURAN`: [kunci, label, min, maks]. */
export const BATAS_PENGATURAN = [
  [KUNCI_PERCOBAAN_MAKS_BULAN, "Masa percobaan maksimal", 1, 12],
  [KUNCI_PKWT_MAKS_BULAN, "Total PKWT maksimal", 1, 120],
  [KUNCI_HARIAN_BATAS_HARI, "Batas hari kerja harian lepas", 1, 31],
  [KUNCI_HARIAN_BATAS_BULAN, "Batas bulan berturut-turut harian lepas", 1, 12],
  [KUNCI_SP_MASA_BULAN, "Masa berlaku SP (bulan)", 1, 12],
  [KUNCI_PELAMAR_RETENSI_BULAN, "Masa simpan data pelamar (bulan)", 1, 60],
] as const;

/** Cermin `PengaturanKontrak::dari_peta`: kosong/rusak = bawaan. */
export function pengaturanDariPeta(
  peta: Record<string, string>,
): PengaturanKontrak {
  const hasil = { ...PENGATURAN_KONTRAK_BAWAAN };
  for (const [kunci, , min, maks] of BATAS_PENGATURAN) {
    const teks = (peta[kunci] ?? "").trim();
    const n = /^-?\d+$/.test(teks) ? Number(teks) : Number.NaN;
    if (Number.isSafeInteger(n) && n >= min && n <= maks) hasil[kunci] = n;
  }
  return hasil;
}

/** Cermin `validasi_pengaturan`. */
export function validasiPengaturan(
  draft: Record<string, unknown>,
): Hasil<PengaturanKontrak> {
  const asing = Object.keys(draft).find(
    (k) => !BATAS_PENGATURAN.some(([kunci]) => kunci === k),
  );
  if (asing) return gagal(`Isian '${asing}' tidak dikenal.`);
  const hasil = { ...PENGATURAN_KONTRAK_BAWAAN };
  for (const [kunci, label, min, maks] of BATAS_PENGATURAN) {
    const n = draft[kunci];
    if (
      typeof n !== "number" ||
      !Number.isSafeInteger(n) ||
      n < min ||
      n > maks
    ) {
      return gagal(`${label} harus bilangan bulat ${min}–${maks}.`);
    }
    hasil[kunci] = n;
  }
  return ok(hasil);
}

/** Cermin `bulan_penuh_terakhir`. */
export function bulanPenuhTerakhir(
  hariIni: string,
  n: number,
): Array<[string, string]> {
  if (hariIni.length < 7) return [];
  const awalBulanIni = `${hariIni.slice(0, 7)}-01`;
  const hasil: Array<[string, string]> = [];
  for (let i = n; i >= 1; i--) {
    const awal = tambahBulan(awalBulanIni, -i);
    const t = awal ? ymd(awal) : null;
    if (!awal || !t) continue;
    hasil.push([
      awal,
      `${String(t[0]).padStart(4, "0")}-${dua(t[1])}-${dua(hariDalamBulan(t[0], t[1]))}`,
    ]);
  }
  return hasil;
}

export type TandaKontrak =
  | "percobaan_lewat"
  | "pkwt_lewat"
  | "harian_perlu_pkwtt";

/** Cermin `tanda_kontrak`. */
export function tandaKontrak(
  kontrak: readonly Kontrak[],
  aturan: PengaturanKontrak,
  hariIni: string,
  hadirBulanan: readonly number[],
): TandaKontrak[] {
  const aktif = kontrakAktif(kontrak);
  const tanda: TandaKontrak[] = [];
  const percobaanLewat = aktif.some((k) => {
    if (!k.percobaan_selesai) return false;
    const batas = tambahBulan(k.tanggal_mulai, aturan.hr_percobaan_maks_bulan);
    return batas !== null && k.percobaan_selesai > batas;
  });
  if (percobaanLewat) tanda.push("percobaan_lewat");
  let sejak = 0;
  aktif.forEach((k, i) => {
    if (k.jenis === "PKWTT") sejak = i + 1;
  });
  const pkwt = aktif.slice(sejak).filter((k) => k.jenis === "PKWT");
  if (pkwt.length > 0) {
    let total = 0;
    for (const k of pkwt) {
      const akhir = k.tanggal_selesai ? nomorHari(k.tanggal_selesai) : null;
      const awal = nomorHari(k.tanggal_mulai);
      if (akhir !== null && awal !== null) total += akhir - awal + 1;
    }
    const mulai = pkwt[0].tanggal_mulai;
    const ujung = tambahBulan(mulai, aturan.hr_pkwt_maks_bulan);
    const a = nomorHari(mulai);
    const b = ujung ? nomorHari(ujung) : null;
    if (a !== null && b !== null && total > b - a) tanda.push("pkwt_lewat");
  }
  const status = statusKerja(kontrak, hariIni);
  const n = aturan.hr_harian_batas_bulan;
  if (
    status.keadaan === "Berlaku" &&
    status.jenis === "Harian Lepas" &&
    hadirBulanan.length >= n &&
    hadirBulanan
      .slice(hadirBulanan.length - n)
      .every((h) => h >= aturan.hr_harian_batas_hari)
  ) {
    tanda.push("harian_perlu_pkwtt");
  }
  return tanda;
}

/** Cermin `periksa_atasan`. `peta` = id karyawan → id atasannya. */
export function periksaAtasan(
  idKaryawan: string,
  idAtasan: string,
  peta: ReadonlyMap<string, string | null>,
): string | null {
  if (idAtasan === idKaryawan) return "Atasan tidak boleh dirinya sendiri.";
  if (!peta.has(idAtasan)) return "Atasan tidak ditemukan.";
  let kini: string | null = idAtasan;
  for (let i = 0; i <= peta.size; i++) {
    if (kini === null) return null;
    if (kini === idKaryawan)
      return "Pilihan atasan membentuk lingkaran atasan.";
    kini = peta.get(kini) ?? null;
  }
  return null;
}

/** Cermin `dalam_siklus_atasan`. */
export function dalamSiklusAtasan(
  peta: ReadonlyMap<string, string | null>,
): string[] {
  const hasil: string[] = [];
  for (const id of peta.keys()) {
    let kini = peta.get(id) ?? null;
    for (let i = 0; i < peta.size && kini !== null; i++) {
      if (kini === id) {
        hasil.push(id);
        break;
      }
      kini = peta.get(kini) ?? null;
    }
  }
  return hasil.sort();
}

function dekodeAwal(dataBase64: string): Uint8Array | null {
  try {
    const biner = atob(dataBase64.slice(0, 24));
    return Uint8Array.from(biner, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

const awalan = (bita: Uint8Array, tanda: readonly number[], dari = 0) =>
  tanda.every((b, i) => bita[dari + i] === b);

/** Cermin `validasi_berkas`. */
export function validasiBerkas(
  mime: string,
  dataBase64: string,
): string | null {
  if (!(MIME_BERKAS as readonly string[]).includes(mime)) {
    return "Jenis berkas harus JPEG, PNG, WEBP, atau PDF.";
  }
  if (dataBase64.length > MAKS_BERKAS_BASE64) return "Berkas maksimal 1 MB.";
  if (!base64Sah(dataBase64)) return "Isi berkas tidak terbaca.";
  const bita = dekodeAwal(dataBase64);
  if (!bita) return "Isi berkas tidak terbaca.";
  const cocok =
    mime === "application/pdf"
      ? awalan(bita, [0x25, 0x50, 0x44, 0x46])
      : mime === "image/jpeg"
        ? awalan(bita, [0xff, 0xd8])
        : mime === "image/png"
          ? awalan(bita, [0x89, 0x50, 0x4e, 0x47])
          : bita.length >= 12 &&
            awalan(bita, [0x52, 0x49, 0x46, 0x46]) &&
            awalan(bita, [0x57, 0x45, 0x42, 0x50], 8);
  return cocok ? null : "Isi berkas tidak cocok dengan jenisnya.";
}

export interface DokumenSah {
  id_dokumen: string | null;
  id_karyawan: string;
  id_jenis: string;
  nomor: string | null;
  tanggal_terbit: string | null;
  tanggal_kedaluwarsa: string | null;
  catatan: string | null;
}

/** Cermin `validasi_dokumen`. */
export function validasiDokumen(
  draft: Record<string, unknown>,
): Hasil<DokumenSah> {
  const t = (k: string) => teksIsian(draft[k]) ?? null;
  const id_karyawan = t("id_karyawan");
  if (!id_karyawan) return gagal("Karyawan wajib dipilih.");
  const id_jenis = t("id_jenis");
  if (!id_jenis) return gagal("Jenis dokumen wajib dipilih.");
  const tanggal_terbit = t("tanggal_terbit");
  if (tanggal_terbit && !isValidDate(tanggal_terbit)) {
    return gagal("Tanggal terbit tidak valid.");
  }
  const tanggal_kedaluwarsa = t("tanggal_kedaluwarsa");
  if (tanggal_kedaluwarsa && !isValidDate(tanggal_kedaluwarsa)) {
    return gagal("Tanggal kedaluwarsa tidak valid.");
  }
  if (
    tanggal_terbit &&
    tanggal_kedaluwarsa &&
    tanggal_kedaluwarsa < tanggal_terbit
  ) {
    return gagal("Tanggal kedaluwarsa tidak boleh sebelum tanggal terbit.");
  }
  const nomor = teksTerbatas(t("nomor"), "Nomor dokumen", MAKS_NAMA);
  if (!nomor.ok) return nomor;
  const catatan = teksTerbatas(t("catatan"), "Catatan", MAKS_CATATAN);
  if (!catatan.ok) return catatan;
  return ok({
    id_dokumen: t("id_dokumen"),
    id_karyawan,
    id_jenis,
    nomor: nomor.nilai,
    tanggal_terbit,
    tanggal_kedaluwarsa,
    catatan: catatan.nilai,
  });
}

/** Cermin `nama_bentrok`. `lain` = pasangan [id, nama]. */
export function namaBentrok(
  id: string | null,
  nama: string,
  lain: ReadonlyArray<readonly [string, string]>,
): boolean {
  const kunci = kunciNama(nama);
  return lain.some(
    ([idLain, namaLain]) => idLain !== id && kunciNama(namaLain) === kunci,
  );
}

/** Cermin `kunci_dibawa`: undefined = tidak dibawa, null = dikosongkan. */
export function kunciDibawa(
  draft: Record<string, unknown>,
  kunci: string,
): string | null | undefined {
  const nilai = draft[kunci];
  if (typeof nilai !== "string") return undefined;
  return nilai.trim() === "" ? null : nilai.trim();
}

/** Label tanda untuk layar. */
export const LABEL_TANDA_HRIS: Record<string, string> = {
  percobaan_lewat: "Masa percobaan melebihi batas",
  pkwt_lewat: "Total PKWT melebihi batas",
  harian_perlu_pkwtt: "Harian lepas perlu diangkat PKWTT",
  nama_ganda: "Nama kembar dari perangkat offline",
  atasan_siklus: "Atasan membentuk lingkaran",
};
