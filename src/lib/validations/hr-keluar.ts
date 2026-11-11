/**
 * HRIS fase 5 (skema v40): surat peringatan dan karyawan keluar.
 *
 * Cermin `desktop/hr_keluar.rs`, diuji dengan vektor yang sama. `hr_sp`,
 * `hr_keluar`, `hr_keluar_rincian`, dan `hr_keluar_alasan` KHUSUS CLOUD
 * (Q-63); yang tersinkron hanya `master_data.id_keluar`.
 */
import alasanBawaan from "./hr-keluar-alasan-bawaan.json";
import { tambahBulan, teksIsian } from "./hris";
import { isValidDate } from "./inventory";

export interface AlasanBawaan {
  id_alasan: string;
  nama: string;
  pengali_up: number;
  pengali_upmk: number;
  uph: boolean;
  kompensasi_pkwt: boolean;
  uang_pisah: boolean;
  dasar_hukum: string | null;
}

/** Angkanya dari PP 35/2021 dan wajib dicek ulang klien; bisa disunting. */
export const ALASAN_BAWAAN: readonly AlasanBawaan[] = alasanBawaan;

/** Cermin `SEED_ALASAN_SQL`. Alasan yang sudah disunting tidak ditimpa. */
export const SEED_ALASAN_SQL =
  "INSERT OR IGNORE INTO hr_keluar_alasan (id_alasan, nama, pengali_up, pengali_upmk, uph, kompensasi_pkwt, uang_pisah, dasar_hukum) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8);";

export function seedAlasanArgs(alasan: AlasanBawaan) {
  return [
    alasan.id_alasan,
    alasan.nama,
    alasan.pengali_up,
    alasan.pengali_upmk,
    alasan.uph ? 1 : 0,
    alasan.kompensasi_pkwt ? 1 : 0,
    alasan.uang_pisah ? 1 : 0,
    alasan.dasar_hukum,
  ];
}

// ── Aturan murni ───────────────────────────────────────────────────────────

export const TINGKAT_SP = ["SP1", "SP2", "SP3"] as const;
export type TingkatSp = (typeof TINGKAT_SP)[number];
/** WAJIB sama dengan CHECK `hr_keluar_rincian.komponen`; urutan = urutan tampil. */
export const KOMPONEN_RINCIAN = [
  "UP",
  "UPMK",
  "UPH Cuti",
  "UPH Ongkos Pulang",
  "UPH Lainnya",
  "Kompensasi PKWT",
  "Uang Pisah",
  "Lainnya",
] as const;
export type KomponenRincian = (typeof KOMPONEN_RINCIAN)[number];
export const MAKS_PELANGGARAN = 2000;
export const MAKS_TEKS_KELUAR = 1000;
export const MAKS_NOMOR_SP = 100;
export const MAKS_NAMA_KELUAR = 100;
export const MAKS_UPAH = 1_000_000_000;
export const MAKS_NOMINAL_RINCIAN = 100_000_000_000;
export const MAKS_PENGALI = 1000;
/** Upah sebulan pekerja harian = 30 × upah sehari (Q-66). */
export const HARI_UPAH_SEBULAN = 30;
/** Upah sebulan pekerja per jam = tarif × 173 (Q-66). */
export const JAM_UPAH_SEBULAN = 173;

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

function teksWajib(
  draft: Draft,
  kunci: string,
  label: string,
  maks: number,
): Hasil<string> {
  const t = teksOpsional(draft, kunci, label, maks);
  if (!t.ok) return t;
  return t.nilai ? ok(t.nilai) : gagal(`${label} wajib diisi.`);
}

function tambahHari(tanggal: string, n: number): string {
  return new Date(Date.parse(`${tanggal}T00:00:00Z`) + n * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

/** Cermin `akhir_masa_sp`: hari terakhir SP berlaku (inklusif). */
export function akhirMasaSp(tanggal: string, masaBulan: number): string | null {
  const akhir = tambahBulan(tanggal, masaBulan);
  return akhir ? tambahHari(akhir, -1) : null;
}

export type StatusSp = "Dicabut" | "Berlaku" | "Berakhir";

/** Cermin `status_sp`. Tidak disimpan. */
export function statusSp(
  tanggal: string,
  berlakuSampai: string,
  dicabut: boolean,
  hariIni: string,
): StatusSp {
  if (dicabut) return "Dicabut";
  return tanggal <= hariIni && hariIni <= berlakuSampai
    ? "Berlaku"
    : "Berakhir";
}

export interface SpRingkas {
  tingkat: string;
  tanggal: string;
  berlaku_sampai: string;
  dicabut: boolean;
}

/**
 * Cermin `usulan_tingkat`: SP Berlaku tertinggi pada `tanggal` + 1, maksimal
 * SP3. `sp3_berlaku` benar bila SP3 masih Berlaku (saatnya proses keluar).
 */
export function usulanTingkat(
  sp: readonly SpRingkas[],
  tanggal: string,
): { tingkat: TingkatSp; sp3_berlaku: boolean } {
  let tertinggi = -1;
  for (const s of sp) {
    if (statusSp(s.tanggal, s.berlaku_sampai, s.dicabut, tanggal) !== "Berlaku")
      continue;
    tertinggi = Math.max(
      tertinggi,
      (TINGKAT_SP as readonly string[]).indexOf(s.tingkat),
    );
  }
  if (tertinggi < 0) return { tingkat: "SP1", sp3_berlaku: false };
  if (tertinggi === 0) return { tingkat: "SP2", sp3_berlaku: false };
  return { tingkat: "SP3", sp3_berlaku: tertinggi >= 2 };
}

export interface SpSah {
  id_sp: string | null;
  id_karyawan: string;
  tingkat: TingkatSp;
  tanggal: string;
  nomor: string | null;
  pelanggaran: string;
  harapan: string | null;
  alasan_tingkat: string | null;
  penanda_nama: string;
  penanda_jabatan: string;
}

/** Cermin `validasi_sp`. Usulan tingkat dan tanggal masuk diperiksa pemanggil. */
export function validasiSp(draft: Draft, hariIni: string): Hasil<SpSah> {
  const id_karyawan = teksIsian(draft.id_karyawan);
  if (!id_karyawan) return gagal("Karyawan wajib dipilih.");
  const tingkat = teksIsian(draft.tingkat);
  if (!tingkat || !(TINGKAT_SP as readonly string[]).includes(tingkat))
    return gagal("Tingkat SP tidak dikenal.");
  const tanggal = teksIsian(draft.tanggal);
  if (!tanggal || !isValidDate(tanggal))
    return gagal("Tanggal SP tidak valid.");
  if (tanggal > hariIni) return gagal("Tanggal SP tidak boleh di masa depan.");
  const nomor = teksOpsional(draft, "nomor", "Nomor surat", MAKS_NOMOR_SP);
  if (!nomor.ok) return nomor;
  const pelanggaran = teksWajib(
    draft,
    "pelanggaran",
    "Pelanggaran",
    MAKS_PELANGGARAN,
  );
  if (!pelanggaran.ok) return pelanggaran;
  const harapan = teksOpsional(
    draft,
    "harapan",
    "Perbaikan yang diminta",
    MAKS_TEKS_KELUAR,
  );
  if (!harapan.ok) return harapan;
  const alasan_tingkat = teksOpsional(
    draft,
    "alasan_tingkat",
    "Alasan tingkat",
    MAKS_TEKS_KELUAR,
  );
  if (!alasan_tingkat.ok) return alasan_tingkat;
  const penanda_nama = teksWajib(
    draft,
    "penanda_nama",
    "Nama penanda tangan",
    MAKS_NAMA_KELUAR,
  );
  if (!penanda_nama.ok) return penanda_nama;
  const penanda_jabatan = teksWajib(
    draft,
    "penanda_jabatan",
    "Jabatan penanda tangan",
    MAKS_NAMA_KELUAR,
  );
  if (!penanda_jabatan.ok) return penanda_jabatan;
  return ok({
    id_sp: teksIsian(draft.id_sp) ?? null,
    id_karyawan,
    tingkat: tingkat as TingkatSp,
    tanggal,
    nomor: nomor.nilai,
    pelanggaran: pelanggaran.nilai,
    harapan: harapan.nilai,
    alasan_tingkat: alasan_tingkat.nilai,
    penanda_nama: penanda_nama.nilai,
    penanda_jabatan: penanda_jabatan.nilai,
  });
}

/** Cermin `periksa_tingkat`: tingkat lain dari usulan wajib beralasan. */
export function periksaTingkat(
  tingkat: string,
  usulan: string,
  alasan: string | null,
): Hasil<null> {
  if (tingkat !== usulan && !alasan) {
    return gagal(
      `Tingkat berbeda dari usulan (${usulan}); alasannya wajib diisi.`,
    );
  }
  return ok(null);
}

export type StatusKeluar =
  | "Dibatalkan"
  | "Berlaku"
  | "Jatuh tempo"
  | "Dijadwalkan";

/** Cermin `status_keluar`. Tidak disimpan. */
export function statusKeluar(
  tanggalTerakhir: string,
  berlaku: boolean,
  dibatalkan: boolean,
  hariIni: string,
): StatusKeluar {
  if (dibatalkan) return "Dibatalkan";
  if (berlaku) return "Berlaku";
  return tanggalTerakhir <= hariIni ? "Jatuh tempo" : "Dijadwalkan";
}

/** Cermin `bulan_penuh`: n terbesar dengan `tambahBulan(mulai, n)` ≤ `akhir`. */
export function bulanPenuh(mulai: string, akhir: string): number {
  const ym = (t: string) => Number(t.slice(0, 4)) * 12 + Number(t.slice(5, 7));
  let n = ym(akhir) - ym(mulai);
  if (!Number.isFinite(n)) return 0;
  while (n > 0) {
    const t = tambahBulan(mulai, n);
    if (t !== null && t <= akhir) break;
    n -= 1;
  }
  return Math.max(n, 0);
}

/**
 * Cermin `masa_kerja_bulan`: bulan penuh dari `mulai` sampai hari sesudah
 * `tanggalTerakhir` (eksklusif).
 */
export function masaKerjaBulan(mulai: string, tanggalTerakhir: string): number {
  if (!isValidDate(mulai) || !isValidDate(tanggalTerakhir)) return 0;
  return bulanPenuh(mulai, tambahHari(tanggalTerakhir, 1));
}

/** Cermin `usulan_upah_pokok` (Q-66). */
export function usulanUpahPokok(
  salaryType: string,
  dailyRate: number,
  ratePerHour: number,
): number {
  const upah =
    salaryType === "FLAT_DAILY"
      ? Math.max(dailyRate, 0) * HARI_UPAH_SEBULAN
      : Math.max(ratePerHour, 0) * JAM_UPAH_SEBULAN;
  return Math.min(upah, MAKS_UPAH);
}

/** Kelipatan UP menurut tahun masa kerja (PP 35/2021 Pasal 40 ayat 2). */
export function kelipatanUp(tahun: number): number {
  return Math.min(Math.max(tahun + 1, 1), 9);
}

/** Kelipatan UPMK menurut tahun masa kerja (PP 35/2021 Pasal 40 ayat 3). */
export function kelipatanUpmk(tahun: number): number {
  if (tahun < 3) return 0;
  if (tahun >= 24) return 10;
  return Math.floor(tahun / 3) + 1;
}

export interface MasukanPesangon {
  /** Upah pokok + tunjangan tetap. */
  upah: number;
  masa_kerja_mulai: string | null;
  tanggal_terakhir: string;
  pengali_up: number;
  pengali_upmk: number;
  uph: boolean;
  kompensasi_pkwt: boolean;
  uang_pisah: boolean;
  sisa_cuti: number;
  upah_harian: number;
  /** Tanggal mulai kontrak PKWT yang berlaku pada tanggal terakhir. */
  pkwt_mulai: string | null;
}

export interface Usulan {
  komponen: KomponenRincian;
  dasar: string | null;
  usulan: number;
}

/**
 * Cermin `usulan_pesangon` (§20.5). Bilangan bulat (hasil antara < 2^53),
 * dibulatkan ke rupiah terdekat, setengah ke atas.
 */
export function usulanPesangon(m: MasukanPesangon): Usulan[] {
  const upah = Math.min(Math.max(m.upah, 0), MAKS_UPAH);
  const hasil: Usulan[] = [];
  const mulai =
    m.masa_kerja_mulai && isValidDate(m.masa_kerja_mulai)
      ? m.masa_kerja_mulai
      : null;
  if (mulai) {
    const tahun = Math.floor(masaKerjaBulan(mulai, m.tanggal_terakhir) / 12);
    for (const [komponen, kelipatan, pengali] of [
      ["UP", kelipatanUp(tahun), m.pengali_up],
      ["UPMK", kelipatanUpmk(tahun), m.pengali_upmk],
    ] as const) {
      hasil.push({
        komponen,
        dasar: `Masa kerja ${tahun} tahun: ${kelipatan} × upah × ${pengali}%`,
        usulan: Math.floor((upah * kelipatan * pengali + 50) / 100),
      });
    }
  } else {
    for (const komponen of ["UP", "UPMK"] as const) {
      hasil.push({ komponen, dasar: "Tanggal masuk kosong", usulan: 0 });
    }
  }
  if (m.uph) {
    const sisa = Math.max(m.sisa_cuti, 0);
    hasil.push({
      komponen: "UPH Cuti",
      dasar: `Sisa cuti ${sisa} hari × upah harian`,
      usulan: sisa * Math.max(m.upah_harian, 0),
    });
    for (const komponen of ["UPH Ongkos Pulang", "UPH Lainnya"] as const) {
      hasil.push({ komponen, dasar: null, usulan: 0 });
    }
  }
  if (m.kompensasi_pkwt && m.pkwt_mulai && isValidDate(m.pkwt_mulai)) {
    const bulan = Math.max(masaKerjaBulan(m.pkwt_mulai, m.tanggal_terakhir), 1);
    hasil.push({
      komponen: "Kompensasi PKWT",
      dasar: `PKWT ${bulan} bulan: upah × ${bulan} / 12`,
      usulan: Math.floor((upah * bulan + 6) / 12),
    });
  }
  if (m.uang_pisah) {
    hasil.push({ komponen: "Uang Pisah", dasar: null, usulan: 0 });
  }
  hasil.push({ komponen: "Lainnya", dasar: null, usulan: 0 });
  return hasil;
}

export interface IsianRincian {
  komponen: string;
  nominal: number;
  alasan_ubah: string | null;
}

export interface RincianSah extends Usulan {
  nominal: number;
  alasan_ubah: string | null;
  urutan: number;
}

/**
 * Cermin `susun_rincian`: setiap baris usulan mendapat nominalnya (bawaan =
 * usulan); nominal lain dari usulan wajib beralasan.
 */
export function susunRincian(
  usulan: readonly Usulan[],
  isian: readonly IsianRincian[],
): Hasil<RincianSah[]> {
  const asing = isian.find(
    (i) => !usulan.some((u) => u.komponen === i.komponen),
  );
  if (asing) {
    return gagal(
      `Komponen '${asing.komponen}' tidak berlaku untuk alasan ini.`,
    );
  }
  const hasil: RincianSah[] = [];
  for (const [indeks, u] of usulan.entries()) {
    const isi = isian.find((i) => i.komponen === u.komponen);
    const nominal = isi ? isi.nominal : u.usulan;
    if (
      !Number.isInteger(nominal) ||
      nominal < 0 ||
      nominal > MAKS_NOMINAL_RINCIAN
    ) {
      return gagal(`Nominal ${u.komponen} tidak valid.`);
    }
    const alasan_ubah =
      nominal !== u.usulan ? (isi?.alasan_ubah ?? null) : null;
    if (nominal !== u.usulan && !alasan_ubah) {
      return gagal(
        `Nominal ${u.komponen} berbeda dari usulan; alasannya wajib diisi.`,
      );
    }
    hasil.push({ ...u, nominal, alasan_ubah, urutan: indeks + 1 });
  }
  return ok(hasil);
}

export interface KeluarSah {
  id_keluar: string | null;
  id_karyawan: string;
  id_alasan: string;
  id_sp: string | null;
  tanggal_pemberitahuan: string | null;
  tanggal_terakhir: string;
  keterangan: string | null;
  /** Kosong = pakai usulan. */
  upah_pokok: number | null;
  alasan_upah: string | null;
  tunjangan_tetap: number;
  kartu_ditarik: boolean;
  catatan_checklist: string | null;
  rincian: IsianRincian[];
}

function rupiah(
  draft: Draft,
  kunci: string,
  label: string,
  maks: number,
): Hasil<number | null> {
  const nilai = draft[kunci];
  if (nilai === undefined || nilai === null) return ok(null);
  if (
    typeof nilai !== "number" ||
    !Number.isInteger(nilai) ||
    nilai < 0 ||
    nilai > maks
  ) {
    return gagal(`${label} tidak valid.`);
  }
  return ok(nilai);
}

/** Cermin `validasi_keluar`. Hanya bentuk isian; usulan dihitung pemanggil. */
export function validasiKeluar(draft: Draft): Hasil<KeluarSah> {
  const id_karyawan = teksIsian(draft.id_karyawan);
  if (!id_karyawan) return gagal("Karyawan wajib dipilih.");
  const id_alasan = teksIsian(draft.id_alasan);
  if (!id_alasan) return gagal("Alasan keluar wajib dipilih.");
  const tanggal_terakhir = teksIsian(draft.tanggal_terakhir);
  if (!tanggal_terakhir || !isValidDate(tanggal_terakhir))
    return gagal("Tanggal hari kerja terakhir tidak valid.");
  const tanggal_pemberitahuan = teksIsian(draft.tanggal_pemberitahuan) ?? null;
  if (tanggal_pemberitahuan) {
    if (!isValidDate(tanggal_pemberitahuan))
      return gagal("Tanggal pemberitahuan tidak valid.");
    if (tanggal_pemberitahuan > tanggal_terakhir) {
      return gagal(
        "Tanggal pemberitahuan tidak boleh sesudah hari kerja terakhir.",
      );
    }
  }
  const upah_pokok = rupiah(draft, "upah_pokok", "Upah pokok", MAKS_UPAH);
  if (!upah_pokok.ok) return upah_pokok;
  const tunjangan = rupiah(
    draft,
    "tunjangan_tetap",
    "Tunjangan tetap",
    MAKS_UPAH,
  );
  if (!tunjangan.ok) return tunjangan;
  const tunjangan_tetap = tunjangan.nilai ?? 0;
  if ((upah_pokok.nilai ?? 0) + tunjangan_tetap > MAKS_UPAH)
    return gagal("Upah pokok + tunjangan tetap terlalu besar.");
  const rincian: IsianRincian[] = [];
  const daftar = draft.rincian;
  if (daftar !== undefined && daftar !== null) {
    if (!Array.isArray(daftar)) return gagal("Rincian tidak valid.");
    for (const mentah of daftar) {
      const baris: Draft =
        mentah && typeof mentah === "object" ? (mentah as Draft) : {};
      const komponen = teksIsian(baris.komponen);
      if (
        !komponen ||
        !(KOMPONEN_RINCIAN as readonly string[]).includes(komponen)
      )
        return gagal("Komponen rincian tidak dikenal.");
      if (rincian.some((r) => r.komponen === komponen))
        return gagal(`Komponen ${komponen} tercantum dua kali.`);
      const nominal = rupiah(
        baris,
        "nominal",
        `Nominal ${komponen}`,
        MAKS_NOMINAL_RINCIAN,
      );
      if (!nominal.ok) return nominal;
      if (nominal.nilai === null)
        return gagal(`Nominal ${komponen} tidak valid.`);
      const alasan_ubah = teksOpsional(
        baris,
        "alasan_ubah",
        "Alasan perubahan",
        MAKS_TEKS_KELUAR,
      );
      if (!alasan_ubah.ok) return alasan_ubah;
      rincian.push({
        komponen,
        nominal: nominal.nilai,
        alasan_ubah: alasan_ubah.nilai,
      });
    }
  }
  const keterangan = teksOpsional(
    draft,
    "keterangan",
    "Keterangan",
    MAKS_TEKS_KELUAR,
  );
  if (!keterangan.ok) return keterangan;
  const alasan_upah = teksOpsional(
    draft,
    "alasan_upah",
    "Alasan upah",
    MAKS_TEKS_KELUAR,
  );
  if (!alasan_upah.ok) return alasan_upah;
  const catatan_checklist = teksOpsional(
    draft,
    "catatan_checklist",
    "Catatan checklist",
    MAKS_TEKS_KELUAR,
  );
  if (!catatan_checklist.ok) return catatan_checklist;
  return ok({
    id_keluar: teksIsian(draft.id_keluar) ?? null,
    id_karyawan,
    id_alasan,
    id_sp: teksIsian(draft.id_sp) ?? null,
    tanggal_pemberitahuan,
    tanggal_terakhir,
    keterangan: keterangan.nilai,
    upah_pokok: upah_pokok.nilai,
    alasan_upah: alasan_upah.nilai,
    tunjangan_tetap,
    kartu_ditarik: draft.kartu_ditarik === true,
    catatan_checklist: catatan_checklist.nilai,
    rincian,
  });
}

/** Cermin `periksa_upah`: upah pokok lain dari usulan wajib beralasan. */
export function periksaUpah(
  upahPokok: number,
  usulan: number,
  alasan: string | null,
): Hasil<null> {
  if (upahPokok !== usulan && !alasan) {
    return gagal("Upah pokok berbeda dari usulan; alasannya wajib diisi.");
  }
  return ok(null);
}

export interface AlasanSah {
  id_alasan: string | null;
  nama: string;
  pengali_up: number;
  pengali_upmk: number;
  uph: boolean;
  kompensasi_pkwt: boolean;
  uang_pisah: boolean;
  dasar_hukum: string | null;
  is_aktif: boolean;
}

/** Cermin `validasi_alasan`. */
export function validasiAlasan(draft: Draft): Hasil<AlasanSah> {
  const nama = teksWajib(draft, "nama", "Nama alasan", MAKS_NAMA_KELUAR);
  if (!nama.ok) return nama;
  const pengali = (kunci: string, label: string): Hasil<number> => {
    const n = draft[kunci];
    return typeof n === "number" &&
      Number.isInteger(n) &&
      n >= 0 &&
      n <= MAKS_PENGALI
      ? ok(n)
      : gagal(`${label} harus bilangan bulat 0–${MAKS_PENGALI} (persen).`);
  };
  const pengali_up = pengali("pengali_up", "Pengali UP");
  if (!pengali_up.ok) return pengali_up;
  const pengali_upmk = pengali("pengali_upmk", "Pengali UPMK");
  if (!pengali_upmk.ok) return pengali_upmk;
  const dasar_hukum = teksOpsional(
    draft,
    "dasar_hukum",
    "Dasar hukum",
    MAKS_TEKS_KELUAR,
  );
  if (!dasar_hukum.ok) return dasar_hukum;
  const benar = (kunci: string, bawaan: boolean) =>
    typeof draft[kunci] === "boolean" ? (draft[kunci] as boolean) : bawaan;
  return ok({
    id_alasan: teksIsian(draft.id_alasan) ?? null,
    nama: nama.nilai,
    pengali_up: pengali_up.nilai,
    pengali_upmk: pengali_upmk.nilai,
    uph: benar("uph", true),
    kompensasi_pkwt: benar("kompensasi_pkwt", false),
    uang_pisah: benar("uang_pisah", false),
    dasar_hukum: dasar_hukum.nilai,
    is_aktif: benar("is_aktif", true),
  });
}

// ── SQL kembar (teks diperiksa identik dengan `hr_keluar.rs`) ──────────────

/** Barang yang dipinjam satu personil dan belum kembali penuh (`?1` = id). */
export const PINJAMAN_PERSONIL_SQL =
  "SELECT * FROM (SELECT p.id_mutasi, b.nama_barang, b.kode_barang, b.satuan, p.tanggal, p.jumlah, COALESCE((SELECT SUM(r.jumlah) FROM inventory_mutasi r WHERE r.id_ref = p.id_mutasi AND r.alasan = 'Pengembalian' AND NOT EXISTS (SELECT 1 FROM inventory_mutasi rb WHERE rb.id_mutasi = 'batal-' || r.id_mutasi)), 0) AS kembali, b.desimal FROM inventory_mutasi p JOIN inventory_barang b ON b.id_barang = p.id_barang WHERE p.alasan = 'Peminjaman' AND p.penerima_tipe = 'Personil' AND p.penerima_id = ?1 AND NOT EXISTS (SELECT 1 FROM inventory_mutasi pb WHERE pb.id_mutasi = 'batal-' || p.id_mutasi)) WHERE jumlah > kembali ORDER BY tanggal, id_mutasi LIMIT 200;";

/**
 * Karyawan yang ikut rekap gaji (Q-67): Aktif, atau sudah keluar dengan hari
 * kerja terakhir pada/sesudah awal periode. `{mulai}` = awal periode.
 */
export const KARYAWAN_REKAP_SQL =
  "(md.status_aktif = 'Aktif' OR (COALESCE(md.id_keluar, '') <> '' AND md.tanggal_selesai_aktif >= {mulai}))";

export const karyawanRekap = (mulai: string) =>
  KARYAWAN_REKAP_SQL.replace("{mulai}", mulai);

/**
 * Status yang boleh ditulis jalur karyawan (melawan zombie, aturan 33):
 * selama `id_keluar` terisi, status tetap Nonaktif. `{baru}` = nilai kiriman.
 */
export const STATUS_AKTIF_KELUAR_SQL =
  "CASE WHEN COALESCE(master_data.id_keluar, '') <> '' THEN 'Nonaktif' ELSE {baru} END";
/** Padanan untuk `tanggal_selesai_aktif`. */
export const TANGGAL_SELESAI_KELUAR_SQL =
  "CASE WHEN COALESCE(master_data.id_keluar, '') <> '' THEN master_data.tanggal_selesai_aktif ELSE {baru} END";

export const PESAN_SUDAH_KELUAR =
  "Karyawan ini sudah keluar. Batalkan proses keluarnya di HRIS untuk mengaktifkannya lagi.";

/**
 * Pengajuan yang tidak dibatalkan/ditolak dan masih berjalan sesudah hari
 * kerja terakhir (`?1` = karyawan, `?2` = tanggal terakhir).
 */
export const PENGAJUAN_SESUDAH_SQL =
  "SELECT p.id_pengajuan, p.tanggal_mulai, p.tanggal_selesai, COALESCE(j.nama, p.kelompok) AS jenis FROM hr_pengajuan p LEFT JOIN hr_jenis_pengajuan j ON j.id_jenis = p.id_jenis WHERE p.id_karyawan = ?1 AND p.tanggal_selesai > ?2 AND p.kelompok <> 'Reimburse' AND NOT EXISTS (SELECT 1 FROM hr_pengajuan_keputusan b WHERE b.id_pengajuan = p.id_pengajuan AND b.jenis IN ('Batal', 'Tolak')) ORDER BY p.tanggal_mulai, p.id_pengajuan LIMIT 100;";

/**
 * Statement Berlakukan (cermin `BERLAKUKAN_SQL`): `?1` id keluar, `?2`
 * operator, `?3` potret checklist, `?4` id karyawan. Satu transaksi
 * menonaktifkan karyawan, mengisi tanggal keluar, dan menonaktifkan akunnya.
 */
export const BERLAKUKAN_SQL = [
  "UPDATE hr_keluar SET berlaku_oleh = ?2, berlaku_pada = datetime('now'), checklist_saat_berlaku = ?3 WHERE id_keluar = ?1 AND berlaku_pada IS NULL AND dibatalkan_pada IS NULL AND tanggal_terakhir <= date('now', '+7 hours');",
  "UPDATE master_data SET status_aktif = 'Nonaktif', tanggal_selesai_aktif = (SELECT k.tanggal_terakhir FROM hr_keluar k WHERE k.id_keluar = ?1), id_keluar = ?1 WHERE id_unik = ?4 AND EXISTS (SELECT 1 FROM hr_keluar k WHERE k.id_keluar = ?1 AND k.id_karyawan = ?4 AND k.berlaku_pada IS NOT NULL AND k.dibatalkan_pada IS NULL);",
  "UPDATE master_operator SET status = 'Nonaktif', updated_at = datetime('now') WHERE id_karyawan = ?4 AND status = 'Aktif' AND EXISTS (SELECT 1 FROM hr_keluar k WHERE k.id_keluar = ?1 AND k.id_karyawan = ?4 AND k.berlaku_pada IS NOT NULL AND k.dibatalkan_pada IS NULL);",
  "UPDATE app_session SET revoked_at = datetime('now'), revoked_reason = 'employee-offboarded' WHERE revoked_at IS NULL AND operator_id IN (SELECT id FROM master_operator WHERE id_karyawan = ?4) AND EXISTS (SELECT 1 FROM hr_keluar k WHERE k.id_keluar = ?1 AND k.id_karyawan = ?4 AND k.berlaku_pada IS NOT NULL AND k.dibatalkan_pada IS NULL);",
] as const;

/**
 * Statement Batalkan (cermin `BATALKAN_SQL`): `?1` id keluar, `?2` operator,
 * `?3` alasan. Akun operator tidak pernah diaktifkan lagi (Q-65).
 */
export const BATALKAN_SQL = [
  "UPDATE master_data SET status_aktif = 'Aktif', tanggal_selesai_aktif = NULL, id_keluar = NULL WHERE id_keluar = ?1 AND EXISTS (SELECT 1 FROM hr_keluar k WHERE k.id_keluar = ?1 AND k.dibatalkan_pada IS NULL);",
  "UPDATE hr_keluar SET dibatalkan_oleh = ?2, dibatalkan_pada = datetime('now'), alasan_batal = ?3 WHERE id_keluar = ?1 AND dibatalkan_pada IS NULL;",
] as const;

export const PESAN_SUPERADMIN_TERAKHIR =
  "Karyawan ini tertaut ke akun Superadmin aktif terakhir. Pindahkan peran Superadmin ke akun lain lebih dulu.";
