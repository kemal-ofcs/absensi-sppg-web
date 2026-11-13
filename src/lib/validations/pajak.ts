/**
 * PPh 21 dan BPJS per masa pajak (fase 13, `prd-hris.md` §29.3).
 *
 * Aturan murni, cermin `desktop/payroll/pajak.rs`, diuji dengan
 * `pajak.vektor.json` yang sama. Uang bilangan bulat rupiah, tarif dalam
 * basis per sepuluh ribu (`persenKeBasis`); hasil kali dihitung dengan
 * BigInt lalu dibulatkan menjauhi nol, tanpa `Math.round` atas pecahan.
 */
import pajakBawaan from "./pajak-bawaan.json";

/** Naik bila bentuk kunci `breakdown_snapshot.pajak` berubah. */
export const VERSI_PAJAK = 1;

export const STATUS_TETAP = "tetap";
export const STATUS_TIDAK_TETAP = "tidak_tetap";
export type StatusPph = typeof STATUS_TETAP | typeof STATUS_TIDAK_TETAP;

export const METODE_TER_BULANAN = "TER_BULANAN";
export const METODE_TER_HARIAN = "TER_HARIAN";
export const METODE_PASAL_17_HARIAN = "PASAL_17_HARIAN";
export const METODE_PASAL_17_TERAKHIR = "PASAL_17_TERAKHIR";
export type MetodePph =
  | typeof METODE_TER_BULANAN
  | typeof METODE_TER_HARIAN
  | typeof METODE_PASAL_17_HARIAN
  | typeof METODE_PASAL_17_TERAKHIR;

export type KategoriTer = "TER_A" | "TER_B" | "TER_C";

/**
 * Premi yang dibayar perusahaan dan masuk bruto pajak (PMK 168): JKK, JKM,
 * BPJS Kesehatan. Termasuk kode seed lama Web untuk item run lama.
 */
export const KODE_PREMI = [
  "JKK_CO",
  "JKM_CO",
  "BPJS_KES_CO",
  "JKK",
  "JKM",
  "KES_CO",
] as const;

/** Iuran pensiun/JHT/JP yang dibayar pegawai, pengurang di masa terakhir. */
export const KODE_IURAN_PENSIUN = ["JHT_EMP", "JP_EMP"] as const;

/** Urutan kanonik tanda PPh 21 (§29.3). Tanda tidak pernah menolak. */
export const TANDA_PAJAK = [
  "lebih_potong_masa",
  "lintas_bulan",
  "tanpa_hari",
  "tarif_tidak_ada",
  "rumus_lama",
  "status_pajak_berubah",
  "komponen_per_run",
] as const;
export type TandaPajak = (typeof TANDA_PAJAK)[number];

export const TANDA_BPJS_TARIF_TIDAK_SAH = "tarif_tidak_sah";

/**
 * Penolakan saat tarif pajak/BPJS disimpan (§29.3): yang tidak lolos
 * `persenKeBasis` tidak pernah masuk tabel. Cermin `PESAN_TARIF_TIDAK_SAH`.
 */
export const PESAN_TARIF_TIDAK_SAH =
  "Tarif harus angka 0 atau lebih dengan paling banyak dua desimal (contoh 0,25 atau 3,7).";

/** PTKP, biaya jabatan, dan TER harian (Q-187 (a)), berkas yang sama dengan Rust. */
export const PAJAK_BAWAAN = pajakBawaan;

/** Bentuk minimal baris `tax_rules` dan `bpjs_rules` yang dibaca di sini. */
export interface LapisPajak {
  category: string;
  bracket_min: number;
  bracket_max: number | null;
  rate_percentage: number;
}

export interface AturanBpjs {
  component_code: string;
  component_name: string;
  rate_percentage: number;
  wage_cap: number | null;
}

// ── Aritmetika ─────────────────────────────────────────────────────────────

function bilanganBulat(nilai: number): bigint {
  if (!Number.isSafeInteger(nilai)) {
    throw new Error(`Nilai uang harus bilangan bulat aman: ${nilai}`);
  }
  return BigInt(nilai);
}

const NOL = BigInt(0);
const DUA = BigInt(2);
const SEPULUH_RIBU = BigInt(10_000);

/** Pembilang dalam satuan rupiah × basis, dibagi 10.000, titik tengah menjauhi nol. */
function bulatkan(pembilang: bigint): number {
  const negatif = pembilang < NOL;
  const mutlak = negatif ? -pembilang : pembilang;
  const hasil = (mutlak * DUA + SEPULUH_RIBU) / (SEPULUH_RIBU * DUA);
  return Number(negatif ? -hasil : hasil);
}

/** `round(nilai × basis / 10.000)`, titik tengah menjauhi nol. */
export function kaliBasis(nilai: number, basis: number): number {
  return bulatkan(bilanganBulat(nilai) * bilanganBulat(basis));
}

/**
 * Persen tersimpan (REAL) → basis per sepuluh ribu: 0,25 → 25, 3,7 → 370.
 * Lebih dari dua desimal, negatif, atau bukan angka = `null`. `String(number)`
 * menulis desimal terpendek, sama dengan `Display` f64 di Rust.
 */
export function persenKeBasis(persen: number): number | null {
  if (!Number.isFinite(persen) || persen < 0) return null;
  const teks = String(persen);
  const [bulat = "", pecahan = "", ...lebih] = teks.split(".");
  if (
    lebih.length > 0 ||
    !/^\d+$/.test(bulat) ||
    pecahan.length > 2 ||
    !/^\d*$/.test(pecahan)
  ) {
    return null;
  }
  const nilai = Number(bulat) * 100 + Number(pecahan.padEnd(2, "0"));
  return Number.isSafeInteger(nilai) ? nilai : null;
}

// ── Status, PTKP, masa ─────────────────────────────────────────────────────

/** Q-178 (a): kontrak lebih dulu, lalu jenis gaji. */
export function statusPph(
  jenisPersonil: string | null,
  salaryType: string,
): StatusPph {
  const jenis = jenisPersonil?.trim();
  if (jenis === "Pegawai" || jenis === "Kontrak") return STATUS_TETAP;
  if (jenis === "Harian") return STATUS_TIDAK_TETAP;
  return salaryType === "FLAT_DAILY" ? STATUS_TIDAK_TETAP : STATUS_TETAP;
}

/** Status PTKP yang dirapikan; yang tidak dikenal dianggap TK/0. */
function bentukPtkp(ptkpStatus: string): [boolean, number] {
  const cocok = /^(TK|K)\/([0-3])$/.exec(ptkpStatus.trim().toUpperCase());
  if (!cocok) return [false, 0];
  return [cocok[1] === "K", Number(cocok[2])];
}

/** Peta PMK 168: TK/0, TK/1, K/0 → A; TK/2, TK/3, K/1, K/2 → B; K/3 → C. */
export function kategoriTer(ptkpStatus: string): KategoriTer {
  const [kawin, tanggungan] = bentukPtkp(ptkpStatus);
  if ((!kawin && tanggungan <= 1) || (kawin && tanggungan === 0)) {
    return "TER_A";
  }
  return kawin && tanggungan === 3 ? "TER_C" : "TER_B";
}

export function nilaiPtkp(ptkpStatus: string): number {
  const ptkp = PAJAK_BAWAAN.ptkp;
  const [kawin, tanggungan] = bentukPtkp(ptkpStatus);
  return (
    ptkp.dasar +
    (kawin ? ptkp.kawin : 0) +
    Math.min(tanggungan, ptkp.maks_tanggungan) * ptkp.per_tanggungan
  );
}

/** `YYYY-MM` dari tanggal `YYYY-MM-DD`. */
export function masa(tanggal: string): string {
  return Array.from(tanggal).slice(0, 7).join("");
}

function tanggal(teks: string): [number, number, number] | null {
  const bagian = teks.split("-");
  if (bagian.length < 3) return null;
  const angka = bagian
    .slice(0, 3)
    .map((b) => (/^\d+$/.test(b) ? Number(b) : NaN));
  if (angka.some(Number.isNaN)) return null;
  return angka as [number, number, number];
}

function hariDalamBulan(tahun: number, bulan: number): number {
  if (bulan === 2) {
    return (tahun % 4 === 0 && tahun % 100 !== 0) || tahun % 400 === 0
      ? 29
      : 28;
  }
  return [4, 6, 9, 11].includes(bulan) ? 30 : 31;
}

/** Q-179: run tepat satu bulan kalender. */
export function bulanPenuh(periodStart: string, periodEnd: string): boolean {
  const awal = tanggal(periodStart);
  const akhir = tanggal(periodEnd);
  if (!awal || !akhir) return false;
  return (
    awal[0] === akhir[0] &&
    awal[1] === akhir[1] &&
    awal[2] === 1 &&
    akhir[2] === hariDalamBulan(akhir[0], akhir[1])
  );
}

/** Masa Desember, atau bulan tanggal selesai aktif karyawan yang keluar. */
export function masaTerakhir(
  masaRun: string,
  keluarPada: string | null,
): boolean {
  return (
    masaRun.endsWith("-12") ||
    (keluarPada !== null && masa(keluarPada) === masaRun)
  );
}

// ── Tarif ──────────────────────────────────────────────────────────────────

function lapisUrut(lapis: readonly LapisPajak[], kategori: string) {
  return lapis
    .filter((l) => l.category === kategori)
    .sort((a, b) => a.bracket_min - b.bracket_min);
}

/**
 * Basis TER bulanan. Batas atas inklusif; `bracket_min` = batas atas lapis
 * sebelumnya, jadi eksklusif kecuali lapis pertama (V12).
 */
export function tarifTer(
  kategori: string,
  bruto: number,
  lapis: readonly LapisPajak[],
): number | null {
  const cocok = lapisUrut(lapis, kategori).find(
    (l) =>
      (bruto > l.bracket_min || l.bracket_min === 0) &&
      (l.bracket_max === null || bruto <= l.bracket_max),
  );
  return cocok ? persenKeBasis(cocok.rate_percentage) : null;
}

/** Tarif progresif Pasal 17; `null` bila tidak ada lapis atau tarifnya tidak sah. */
export function pasal17(
  pkp: number,
  lapis: readonly LapisPajak[],
): number | null {
  const urut = lapisUrut(lapis, "PASAL_17");
  if (urut.length === 0) return null;
  let pembilang = NOL;
  for (const l of urut) {
    if (pkp <= l.bracket_min) break;
    const atas = l.bracket_max === null ? pkp : Math.min(pkp, l.bracket_max);
    const basis = persenKeBasis(l.rate_percentage);
    if (basis === null) return null;
    pembilang += bilanganBulat(atas - l.bracket_min) * bilanganBulat(basis);
  }
  return bulatkan(pembilang);
}

// ── PPh 21 satu item ───────────────────────────────────────────────────────

/** Masukan satu karyawan satu run; cermin `MasukanPph`. */
export interface MasukanPph {
  period_start: string;
  period_end: string;
  jenis_personil: string | null;
  salary_type: string;
  /** Status awal tahun pajak (Q-180), untuk kategori TER dan PTKP. */
  ptkp_status: string;
  gross: number;
  /** JKK, JKM, BPJS Kesehatan perusahaan run ini (`KODE_PREMI`). */
  premi: number;
  hari: number;
  /** `tanggal_selesai_aktif` bila `id_keluar` terisi saat run dibuat. */
  keluar_pada: string | null;
  bruto_masa_sebelum: number;
  pph_masa_sebelum: number;
  /** Item berstatus tetap tahun itu, di luar run ini. */
  bruto_tahun_sebelum: number;
  pph_tahun_sebelum: number;
  iuran_pensiun_sebelum: number;
  iuran_pensiun_run: number;
  /** Masa lain di tahun itu yang berbruto (untuk batas biaya jabatan). */
  masa_berbruto_lain: number;
  rumus_lama: boolean;
  status_pajak_berubah: boolean;
  komponen_per_run: boolean;
}

/** Isi `breakdown_snapshot.pajak`; cermin `HasilPph`. */
export interface HasilPph {
  versi: number;
  masa: string;
  status: StatusPph;
  metode: MetodePph;
  kategori: KategoriTer | null;
  /** Basis per sepuluh ribu (125 = 1,25%); `null` untuk Pasal 17. */
  tarif: number | null;
  bruto_pajak: number;
  premi: number;
  bruto_masa: number | null;
  sudah_dipotong: number;
  hari: number | null;
  bruto_tahun: number | null;
  biaya_jabatan: number | null;
  iuran_pensiun: number | null;
  ptkp: number | null;
  pkp: number | null;
  pph_setahun: number | null;
  /** Potongan run ini; negatif = pengembalian di masa terakhir (Q-189). */
  pph: number;
  tanda: TandaPajak[];
}

export function hitungPph(
  m: MasukanPph,
  lapis: readonly LapisPajak[],
): HasilPph {
  const status = statusPph(m.jenis_personil, m.salary_type);
  const masaRun = masa(m.period_start);
  const bruto = m.gross + m.premi;
  const kategori = kategoriTer(m.ptkp_status);
  const aktif = new Set<TandaPajak>();
  if (masaRun !== masa(m.period_end)) aktif.add("lintas_bulan");
  const hasil: HasilPph = {
    versi: VERSI_PAJAK,
    masa: masaRun,
    status,
    metode: METODE_TER_BULANAN,
    kategori,
    tarif: null,
    bruto_pajak: bruto,
    premi: m.premi,
    bruto_masa: null,
    sudah_dipotong: 0,
    hari: null,
    bruto_tahun: null,
    biaya_jabatan: null,
    iuran_pensiun: null,
    ptkp: null,
    pkp: null,
    pph_setahun: null,
    pph: 0,
    tanda: [],
  };

  if (
    status === STATUS_TIDAK_TETAP &&
    !bulanPenuh(m.period_start, m.period_end)
  ) {
    // §29.3 (5): TER harian atas bruto run, tanpa masa dan rekonsiliasi.
    const harian = PAJAK_BAWAAN.ter_harian;
    let hari = 0;
    if (m.hari > 0) {
      hari = m.hari;
    } else if (bruto > 0) {
      aktif.add("tanpa_hari");
      hari = 1;
    }
    hasil.kategori = null;
    hasil.hari = hari;
    hasil.metode = METODE_TER_HARIAN;
    if (bruto <= harian.batas_nol * hari) {
      hasil.tarif = 0;
    } else if (bruto <= harian.batas_tarif * hari) {
      hasil.tarif = harian.basis;
      hasil.pph = kaliBasis(bruto, harian.basis);
    } else {
      hasil.metode = METODE_PASAL_17_HARIAN;
      const pph = pasal17(kaliBasis(bruto, harian.basis_dasar_pasal_17), lapis);
      if (pph === null) aktif.add("tarif_tidak_ada");
      else hasil.pph = pph;
    }
  } else {
    const brutoMasa = m.bruto_masa_sebelum + bruto;
    hasil.bruto_masa = brutoMasa;
    if (status === STATUS_TETAP && masaTerakhir(masaRun, m.keluar_pada)) {
      // §29.3 (4): Pasal 17 setahun dikurangi yang sudah dipotong.
      const bawaan = PAJAK_BAWAAN;
      const brutoTahun = m.bruto_tahun_sebelum + bruto;
      const jumlahMasa = m.masa_berbruto_lain + (brutoMasa > 0 ? 1 : 0);
      const biayaJabatan = Math.min(
        kaliBasis(brutoTahun, bawaan.biaya_jabatan.basis),
        bawaan.biaya_jabatan.maks_per_masa * jumlahMasa,
      );
      const iuran = m.iuran_pensiun_sebelum + m.iuran_pensiun_run;
      const ptkp = nilaiPtkp(m.ptkp_status);
      const sisa = brutoTahun - biayaJabatan - iuran - ptkp;
      const pkp =
        sisa > 0
          ? Math.floor(sisa / bawaan.pembulatan_pkp) * bawaan.pembulatan_pkp
          : 0;
      hasil.metode = METODE_PASAL_17_TERAKHIR;
      hasil.sudah_dipotong = m.pph_tahun_sebelum;
      hasil.bruto_tahun = brutoTahun;
      hasil.biaya_jabatan = biayaJabatan;
      hasil.iuran_pensiun = iuran;
      hasil.ptkp = ptkp;
      hasil.pkp = pkp;
      const setahun = pasal17(pkp, lapis);
      if (setahun === null) {
        aktif.add("tarif_tidak_ada");
      } else {
        hasil.pph_setahun = setahun;
        hasil.pph = setahun - m.pph_tahun_sebelum;
      }
    } else {
      // §29.3 (3) dan (6): TER bulanan atas bruto sebulan.
      hasil.sudah_dipotong = m.pph_masa_sebelum;
      const basis = tarifTer(kategori, brutoMasa, lapis);
      if (basis === null) {
        aktif.add("tarif_tidak_ada");
      } else {
        const pphMasa = kaliBasis(brutoMasa, basis);
        hasil.tarif = basis;
        hasil.pph = Math.max(0, pphMasa - m.pph_masa_sebelum);
        if (m.pph_masa_sebelum > pphMasa) aktif.add("lebih_potong_masa");
      }
    }
  }

  if (m.rumus_lama) aktif.add("rumus_lama");
  if (m.status_pajak_berubah) aktif.add("status_pajak_berubah");
  if (m.komponen_per_run) aktif.add("komponen_per_run");
  hasil.tanda = TANDA_PAJAK.filter((t) => aktif.has(t));
  return hasil;
}

// ── BPJS satu item ─────────────────────────────────────────────────────────

/** Satu baris `breakdown_snapshot.bpjs`, bentuk sama dengan rumus lama. */
export interface RincianBpjs {
  code: string;
  name: string;
  rate: number;
  wage_cap: number | null;
  nominal: number;
  is_employee: boolean;
}

export interface HasilBpjs {
  karyawan: number;
  perusahaan: number;
  rincian: RincianBpjs[];
  dasar_run: number;
  dasar_masa: number;
  tanda: (typeof TANDA_BPJS_TARIF_TIDAK_SAH)[];
}

/**
 * §29.3 (1): iuran sebulan atas dasar masa yang dibatasi, dikurangi yang
 * sudah dipotong per kode di run pembanding, paling kecil 0.
 */
export function hitungBpjsMasa(
  dasarRun: number,
  dasarMasaSebelum: number,
  aturan: readonly AturanBpjs[],
  sudah: Readonly<Record<string, number>>,
): HasilBpjs {
  const dasarMasa = dasarMasaSebelum + dasarRun;
  const hasil: HasilBpjs = {
    karyawan: 0,
    perusahaan: 0,
    rincian: [],
    dasar_run: dasarRun,
    dasar_masa: dasarMasa,
    tanda: [],
  };
  for (const rule of aturan) {
    let basis = persenKeBasis(rule.rate_percentage);
    if (basis === null) {
      if (hasil.tanda.length === 0)
        hasil.tanda.push(TANDA_BPJS_TARIF_TIDAK_SAH);
      basis = 0;
    }
    const dasar =
      rule.wage_cap !== null && rule.wage_cap > 0
        ? Math.min(dasarMasa, rule.wage_cap)
        : dasarMasa;
    const sebelumnya = sudah[rule.component_code] ?? 0;
    const nominal = Math.max(0, kaliBasis(dasar, basis) - sebelumnya);
    const isEmployee = rule.component_code.endsWith("_EMP");
    if (isEmployee) hasil.karyawan += nominal;
    else hasil.perusahaan += nominal;
    hasil.rincian.push({
      code: rule.component_code,
      name: rule.component_name,
      rate: rule.rate_percentage,
      wage_cap: rule.wage_cap,
      nominal,
      is_employee: isEmployee,
    });
  }
  return hasil;
}

// ── Run pembanding ─────────────────────────────────────────────────────────

/**
 * Item setiap karyawan di run TAHUN itu sampai masa run ini, kecuali
 * `REJECTED` (Q-190; `DRAFT` ikut, preseden kasbon). Himpunan masa diambil
 * dari hasil yang sama (`masa` = bulan `period_start`, Q-177). ?1 =
 * `period_start` run yang dihitung; run itu sendiri belum tertulis.
 * Cermin `RUN_TAHUN_SQL` di `pajak.rs`.
 */
export const RUN_TAHUN_SQL =
  "SELECT pi.id_karyawan AS id_karyawan, substr(pr.period_start, 1, 7) AS masa, pi.gross_salary AS gross_salary, pi.pph21_amount AS pph21_amount, pi.salary_type AS salary_type, pi.breakdown_snapshot AS breakdown_snapshot FROM payroll_items pi JOIN payroll_runs pr ON pr.id = pi.payroll_run_id WHERE pr.status <> 'REJECTED' AND substr(pr.period_start, 1, 4) = substr(?1, 1, 4) AND substr(pr.period_start, 1, 7) <= substr(?1, 1, 7) ORDER BY pi.id_karyawan, pr.period_start, pr.id;";

/**
 * Kolom rekap untuk pajak, disisipkan ke SELECT rekap (`md` = `master_data`,
 * ?1/?2 = awal/akhir periode). PTKP awal tahun (Q-180): konfigurasi yang
 * berlaku 1 Januari, atau konfigurasi pertama tahun itu. Tanggal keluar hanya
 * bila `id_keluar` terisi (fase 5). Cermin `KOLOM_PAJAK_SQL`.
 */
export const KOLOM_PAJAK_SQL =
  "md.jenis_personil AS jenis_personil, CASE WHEN COALESCE(md.id_keluar, '') <> '' THEN md.tanggal_selesai_aktif END AS keluar_pada, COALESCE((SELECT s.ptkp_status FROM salary_configs s WHERE s.id_karyawan = md.id_unik AND s.effective_date <= substr(?1, 1, 4) || '-01-01' ORDER BY s.effective_date DESC LIMIT 1), (SELECT s.ptkp_status FROM salary_configs s WHERE s.id_karyawan = md.id_unik AND s.effective_date <= ?2 ORDER BY s.effective_date ASC LIMIT 1), 'TK/0') AS ptkp_awal_tahun";

/** Satu baris `RUN_TAHUN_SQL` untuk satu karyawan. */
export interface ItemPembanding {
  masa: string;
  gross_salary: number;
  pph21_amount: number;
  salary_type: string;
  breakdown_snapshot: string;
}

/** Angka "sudah dipotong" untuk `hitungPph` dan `hitungBpjsMasa`. */
export interface Pembanding {
  bruto_masa: number;
  pph_masa: number;
  dasar_bpjs_masa: number;
  bpjs_masa: Record<string, number>;
  run_masa: number;
  /** Hanya item berstatus tetap (Q-192). */
  bruto_tahun: number;
  pph_tahun: number;
  iuran_pensiun_tahun: number;
  masa_berbruto_lain: number;
  /** Item masa ini / tahun ini tanpa kunci `pajak` (dibuat rumus lama). */
  rumus_lama_masa: boolean;
  rumus_lama_tahun: boolean;
  /** Ada item tahun ini yang status pajaknya berbeda dengan sekarang. */
  status_berubah: boolean;
}

export const PEMBANDING_KOSONG: Readonly<Pembanding> = {
  bruto_masa: 0,
  pph_masa: 0,
  dasar_bpjs_masa: 0,
  bpjs_masa: {},
  run_masa: 0,
  bruto_tahun: 0,
  pph_tahun: 0,
  iuran_pensiun_tahun: 0,
  masa_berbruto_lain: 0,
  rumus_lama_masa: false,
  rumus_lama_tahun: false,
  status_berubah: false,
};

function bilanganUtuh(nilai: unknown): number | null {
  return typeof nilai === "number" && Number.isSafeInteger(nilai)
    ? nilai
    : null;
}

function objek(nilai: unknown): Record<string, unknown> {
  return typeof nilai === "object" && nilai !== null && !Array.isArray(nilai)
    ? (nilai as Record<string, unknown>)
    : {};
}

/**
 * Bruto pajak, status, dan dasar BPJS satu item; cermin `baca_item`. Item
 * rumus lama (tanpa `pajak`) dihitung ulang: bruto + premi dari
 * `breakdown_snapshot.bpjs`, status dari jenis gaji, dasar BPJS = bruto
 * (`FLAT_DAILY` tanpa BPJS).
 */
function bacaItem(item: ItemPembanding) {
  let snapshot: Record<string, unknown> = {};
  try {
    snapshot = objek(JSON.parse(item.breakdown_snapshot));
  } catch {
    snapshot = {};
  }
  const rincian: { code: string; nominal: number }[] = [];
  if (Array.isArray(snapshot.bpjs)) {
    for (const r of snapshot.bpjs) {
      const baris = objek(r);
      const nominal = bilanganUtuh(baris.nominal);
      if (typeof baris.code === "string" && nominal !== null) {
        rincian.push({ code: baris.code, nominal });
      }
    }
  }
  const statusLama = statusPph(null, item.salary_type);
  const dasar =
    bilanganUtuh(objek(snapshot.bpjs_masa).dasar_run) ??
    (item.salary_type === "FLAT_DAILY" ? 0 : item.gross_salary);
  const pajak = objek(snapshot.pajak);
  const bruto = bilanganUtuh(pajak.bruto_pajak);
  if (bruto !== null) {
    const status: StatusPph =
      pajak.status === STATUS_TIDAK_TETAP || pajak.status === STATUS_TETAP
        ? pajak.status
        : statusLama;
    return { bruto, status, dasar, rincian, lama: false };
  }
  return {
    bruto: item.gross_salary + jumlahKode(rincian, KODE_PREMI),
    status: statusLama,
    dasar,
    rincian,
    lama: true,
  };
}

/**
 * Ringkasan run pembanding satu karyawan untuk run bermasa `masaRun` dan
 * berstatus `status`. Cermin `ringkas_pembanding`.
 */
export function ringkasPembanding(
  items: readonly ItemPembanding[],
  masaRun: string,
  status: StatusPph,
): Pembanding {
  const hasil: Pembanding = { ...PEMBANDING_KOSONG, bpjs_masa: {} };
  const masaLain = new Set<string>();
  for (const item of items) {
    const { bruto, status: statusItem, dasar, rincian, lama } = bacaItem(item);
    if (item.masa === masaRun) {
      hasil.bruto_masa += bruto;
      hasil.pph_masa += item.pph21_amount;
      hasil.dasar_bpjs_masa += dasar;
      for (const r of rincian) {
        hasil.bpjs_masa[r.code] = (hasil.bpjs_masa[r.code] ?? 0) + r.nominal;
      }
      hasil.run_masa += 1;
      hasil.rumus_lama_masa ||= lama;
    }
    hasil.rumus_lama_tahun ||= lama;
    hasil.status_berubah ||= statusItem !== status;
    if (statusItem === STATUS_TETAP) {
      hasil.bruto_tahun += bruto;
      hasil.pph_tahun += item.pph21_amount;
      hasil.iuran_pensiun_tahun += jumlahKode(rincian, KODE_IURAN_PENSIUN);
      if (item.masa !== masaRun && bruto > 0) masaLain.add(item.masa);
    }
  }
  hasil.masa_berbruto_lain = masaLain.size;
  return hasil;
}

/**
 * Jumlah nominal rincian BPJS berkode tertentu (`KODE_PREMI`,
 * `KODE_IURAN_PENSIUN`), juga untuk `breakdown_snapshot.bpjs` item lama.
 */
export function jumlahKode(
  rincian: readonly { code: string; nominal: number }[],
  kode: readonly string[],
): number {
  return rincian
    .filter((r) => kode.includes(r.code))
    .reduce((total, r) => total + r.nominal, 0);
}

// ── Tampilan (slip, rincian run) ───────────────────────────────────────────

/**
 * Kunci `pajak` dari `breakdown_snapshot`; `null` untuk item rumus lama.
 * Hanya dibaca layar, tidak ada kembaran Rust.
 */
export function bacaPajakSnapshot(snapshot: string): HasilPph | null {
  try {
    const pajak = objek(objek(JSON.parse(snapshot)).pajak);
    return bilanganUtuh(pajak.bruto_pajak) === null
      ? null
      : (pajak as unknown as HasilPph);
  } catch {
    return null;
  }
}

/** Basis per sepuluh ribu → "1,25%". */
export function formatTarif(basis: number): string {
  const sen = basis % 100;
  const pecahan =
    sen === 0 ? "" : `,${String(sen).padStart(2, "0").replace(/0$/, "")}`;
  return `${Math.trunc(basis / 100)}${pecahan}%`;
}

const LABEL_KATEGORI: Record<KategoriTer, string> = {
  TER_A: "TER A",
  TER_B: "TER B",
  TER_C: "TER C",
};

/** Label baris PPh 21 di slip dan rincian run (§29.4). */
export function labelPph(
  pajak: HasilPph | null,
  pph: number,
  ptkpStatus: string,
): string {
  if (pph < 0) return "Pengembalian PPh 21";
  if (!pajak) return `PPh 21 (TER ${ptkpStatus})`;
  switch (pajak.metode) {
    case METODE_PASAL_17_TERAKHIR:
      return "PPh 21 masa terakhir (Pasal 17)";
    case METODE_PASAL_17_HARIAN:
      return "PPh 21 harian (Pasal 17 atas 50%)";
    case METODE_TER_HARIAN:
      return `PPh 21 TER harian ${formatTarif(pajak.tarif ?? 0)}`;
    default:
      return pajak.kategori && pajak.tarif !== null
        ? `PPh 21 ${LABEL_KATEGORI[pajak.kategori]} ${formatTarif(pajak.tarif)}`
        : "PPh 21";
  }
}

export const LABEL_TANDA_PAJAK: Record<TandaPajak, string> = {
  lebih_potong_masa: "Lebih potong bulan ini, diselesaikan di masa terakhir",
  lintas_bulan: "Periode melintasi dua bulan; masa = bulan awal",
  tanpa_hari: "Tanpa hari hadir, dihitung 1 hari",
  tarif_tidak_ada: "Tarif PPh tidak ditemukan; PPh 0",
  rumus_lama: "Ada proses gaji lama (rumus sebelum v45) di masa ini",
  status_pajak_berubah: "Status pajak berubah tahun ini",
  komponen_per_run:
    "Komponen tetap dibayar lagi di proses gaji kedua bulan ini",
};

/**
 * Ringkasan rincian run (§29.7): berapa slip dihitung rumus lama, atau
 * bersama proses gaji rumus lama di masa yang sama. `null` = tidak ada.
 */
export function catatanPajakRun(snapshots: readonly string[]): string | null {
  const pajak = snapshots.map(bacaPajakSnapshot);
  const lama = pajak.filter((p) => p === null).length;
  if (lama === pajak.length && lama > 0) {
    return "Proses gaji ini dihitung dengan rumus pajak lama (sebelum v45); PPh 21 dan BPJS-nya tidak dihitung ulang.";
  }
  const bertanda = pajak.filter((p) => p?.tanda.includes("rumus_lama")).length;
  return bertanda > 0
    ? `${bertanda} slip dihitung bersama proses gaji rumus lama di masa yang sama; selisihnya dikoreksi di masa terakhir.`
    : null;
}
