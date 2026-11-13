import "server-only";

import {
  type HasilPph,
  hitungBpjsMasa,
  hitungPph,
  jumlahKode,
  KODE_IURAN_PENSIUN,
  KODE_PREMI,
  masa,
  masaTerakhir,
  type Pembanding,
  type RincianBpjs,
  STATUS_TETAP,
  statusPph,
} from "@/lib/validations/pajak";

// TS port of src-tauri/src/desktop/payroll/engine.rs + the PayrollStatus state
// machine in models.rs, so the web (Vercel) runtime computes payroll identically
// to the Tauri Desktop runtime. Rate/multiplier values are already f64 in the
// DB (Rust itself goes through Decimal::from_f64_retain from the same source),
// so plain JS number arithmetic is bit-for-bit equivalent — no decimal library.

export interface OvertimeTierRule {
  id: string;
  rule_type: string;
  tier_order: number;
  hour_start: number;
  hour_end: number | null;
  multiplier: number;
  is_active: number;
}

export interface PayrollComponent {
  id: string;
  name: string;
  category: string; // "ALLOWANCE" | "DEDUCTION"
  calc_type: string; // "FIXED" | "PERCENTAGE"
  default_value: number;
  applies_to: string; // "ALL" | id_karyawan
  is_active: number;
  /** 1 = tunjangan tetap, ikut dasar BPJS (v45, Q-181 (a)). */
  dasar_bpjs: number;
}

export interface TaxRule {
  id: string;
  category: string; // "TER_A" | "TER_B" | "TER_C" | "PASAL_17"
  bracket_min: number;
  bracket_max: number | null;
  rate_percentage: number;
  effective_date: string;
}

export interface BpjsRule {
  id: string;
  component_code: string;
  component_name: string;
  rate_percentage: number;
  wage_cap: number | null;
  effective_date: string;
}

// Round-half-away-from-zero to 0 decimals (whole Rupiah), matching Rust's
// RoundingStrategy::MidpointAwayFromZero.
export function roundMoney(value: number): number {
  return Math.sign(value) * Math.round(Math.abs(value));
}

// Round-half-away-from-zero to 2 decimals, for the overtime index.
export function roundIndex(value: number): number {
  return (Math.sign(value) * Math.round(Math.abs(value) * 100)) / 100;
}

export function calculateOvertimeIndex(
  overtimeHours: number,
  tiers: OvertimeTierRule[],
): number {
  if (overtimeHours <= 0 || tiers.length === 0) return 0;

  let remaining = overtimeHours;
  let totalIndex = 0;

  for (const tier of tiers) {
    if (tier.is_active === 0) continue;
    if (remaining <= 0) break;

    const start = tier.hour_start;
    const multiplier = tier.multiplier;
    const span =
      tier.hour_end !== null && tier.hour_end !== undefined
        ? tier.hour_end > start
          ? tier.hour_end - start
          : 0
        : remaining; // unbounded tier

    if (span <= 0) continue;

    const hoursInTier = Math.min(remaining, span);
    totalIndex += hoursInTier * multiplier;
    remaining -= hoursInTier;
  }

  return roundIndex(totalIndex);
}

export interface ComponentBreakdownEntry {
  id: string;
  name: string;
  category: string;
  calc_type: string;
  rate: number;
  nominal: number;
}

/** Cermin `calculate_components`; `dasarBpjs` = tunjangan bertanda tetap. */
export function calculateComponents(
  basicSalary: number,
  components: PayrollComponent[],
  idKaryawan: string,
): {
  allowance: number;
  deduction: number;
  dasarBpjs: number;
  breakdown: ComponentBreakdownEntry[];
} {
  let totalAllowance = 0;
  let totalDeduction = 0;
  let dasarBpjs = 0;
  const breakdown: ComponentBreakdownEntry[] = [];

  for (const comp of components) {
    if (comp.is_active === 0) continue;
    if (comp.applies_to !== "ALL" && comp.applies_to !== idKaryawan) continue;

    const nominal =
      comp.calc_type === "PERCENTAGE"
        ? roundMoney(basicSalary * (comp.default_value / 100))
        : roundMoney(comp.default_value);

    if (comp.category === "ALLOWANCE") {
      totalAllowance += nominal;
      if (comp.dasar_bpjs === 1) dasarBpjs += nominal;
    } else {
      totalDeduction += nominal;
    }

    breakdown.push({
      id: comp.id,
      name: comp.name,
      category: comp.category,
      calc_type: comp.calc_type,
      rate: comp.default_value,
      nominal,
    });
  }

  return {
    allowance: totalAllowance,
    deduction: totalDeduction,
    dasarBpjs,
    breakdown,
  };
}

/** Kunci `breakdown_snapshot.tax` bentuk lama, untuk slip lama. */
export interface Pph21Breakdown {
  method: string;
  category: string | null;
  ptkp_status: string;
  rate_percentage: number | null;
  pph21_amount: number;
}

/** Konteks masa pajak satu karyawan; cermin `KonteksPajak` di engine.rs. */
export interface KonteksPajak {
  periodStart: string;
  periodEnd: string;
  jenisPersonil: string | null;
  /** PTKP yang berlaku 1 Januari (Q-180), dari `KOLOM_PAJAK_SQL`. */
  ptkpAwalTahun: string;
  /** `tanggal_selesai_aktif` bila `id_keluar` terisi. */
  keluarPada: string | null;
  pembanding: Pembanding;
}

export interface PayInput {
  idKaryawan: string;
  salaryType: string;
  ratePerHour: number;
  dailyRate: number;
  daysPresent: number;
  regularMinutes: number;
  overtimeMinutes: number;
  holidayMinutes: number;
  pajak: KonteksPajak;
}

export interface PayRules {
  overtimeTiers: OvertimeTierRule[];
  holidayTiers: OvertimeTierRule[];
  components: PayrollComponent[];
  taxRules: TaxRule[];
  bpjsRules: BpjsRule[];
}

export interface EmployeePay {
  overtimeIndex: number;
  holidayIndex: number;
  basic: number;
  overtime: number;
  allowance: number;
  deduction: number;
  gross: number;
  bpjsEmployee: number;
  bpjsCompany: number;
  /** Boleh negatif di masa terakhir (pengembalian, Q-189). */
  pph21: number;
  net: number;
  components: ComponentBreakdownEntry[];
  bpjs: RincianBpjs[];
  tax: Pph21Breakdown;
  /** Kunci `breakdown_snapshot.pajak`. */
  pajak: HasilPph;
  /** Kunci `breakdown_snapshot.bpjs_masa`. */
  bpjsMasa: { dasar_run: number; dasar_masa: number; tanda: string[] };
}

/**
 * Gaji satu karyawan untuk satu periode. Cerminan persis
 * `PayrollCalculator::calculate_employee_pay` di `payroll/engine.rs`: sejak
 * fase 13 BPJS dan PPh 21 dihitung per masa pajak (`hitungBpjsMasa`,
 * `hitungPph`).
 */
export function calculateEmployeePay(
  input: PayInput,
  rules: PayRules,
): EmployeePay {
  const flat = input.salaryType === "FLAT_DAILY";
  let overtimeIndex = 0;
  let holidayIndex = 0;
  let basic: number;
  let overtime = 0;
  let hasilKomponen: ReturnType<typeof calculateComponents>;
  if (flat) {
    // Upah harian tetap: durasi kerja dan lembur tidak ikut. Hanya komponen
    // milik karyawan ini sendiri yang berlaku; komponen 'ALL' dirancang untuk
    // skema per jam. Hasil kalinya bilangan bulat eksak.
    basic = Math.max(0, input.daysPresent) * Math.max(0, input.dailyRate);
    hasilKomponen = calculateComponents(
      basic,
      rules.components.filter((comp) => comp.applies_to === input.idKaryawan),
      input.idKaryawan,
    );
  } else {
    // Dua indeks, dua jenjang: jam lembur hari biasa memakai HARI_KERJA,
    // seluruh jam pada tanggal libur memakai HARI_LIBUR.
    overtimeIndex = calculateOvertimeIndex(
      input.overtimeMinutes / 60,
      rules.overtimeTiers,
    );
    holidayIndex = calculateOvertimeIndex(
      input.holidayMinutes / 60,
      rules.holidayTiers,
    );
    // Uang diturunkan dari MENIT BULAT, bukan dari jam yang sudah dibagi:
    // `menit * tarif` bilangan bulat eksak, sehingga titik tengahnya terwakili
    // persis dan `roundMoney` sepakat dengan `Decimal` di Rust.
    basic = roundMoney((input.regularMinutes * input.ratePerHour) / 60);
    // Indeks sudah dibulatkan ke 2 desimal, jadi seratus kalinya bilangan bulat
    // dan perkaliannya menjadi eksak.
    const indeksRatusan = Math.round((overtimeIndex + holidayIndex) * 100);
    overtime = roundMoney((indeksRatusan * input.ratePerHour) / 100);
    hasilKomponen = calculateComponents(
      basic,
      rules.components,
      input.idKaryawan,
    );
  }
  const {
    allowance,
    deduction,
    dasarBpjs,
    breakdown: components,
  } = hasilKomponen;
  const gross = basic + overtime + allowance;
  const konteks = input.pajak;
  const pembanding = konteks.pembanding;

  // BPJS per masa atas gaji pokok + tunjangan tetap, tanpa lembur
  // (Q-181 (a)). `FLAT_DAILY` tetap tanpa BPJS (Q-182).
  const bpjs = flat
    ? hitungBpjsMasa(0, 0, [], {})
    : hitungBpjsMasa(
        basic + dasarBpjs,
        pembanding.dasar_bpjs_masa,
        rules.bpjsRules,
        pembanding.bpjs_masa,
      );
  const premi = jumlahKode(bpjs.rincian, KODE_PREMI);
  const iuranPensiunRun = jumlahKode(bpjs.rincian, KODE_IURAN_PENSIUN);

  const status = statusPph(konteks.jenisPersonil, input.salaryType);
  const terakhir =
    status === STATUS_TETAP &&
    masaTerakhir(masa(konteks.periodStart), konteks.keluarPada);
  // Q-184 (a): komponen FIXED tetap per run, ditandai bila bulan ini sudah
  // punya run lain.
  const komponenTetap = components.some(
    (c) => c.calc_type === "FIXED" && c.nominal > 0,
  );
  const pajak = hitungPph(
    {
      period_start: konteks.periodStart,
      period_end: konteks.periodEnd,
      jenis_personil: konteks.jenisPersonil,
      salary_type: input.salaryType,
      ptkp_status: konteks.ptkpAwalTahun,
      gross,
      premi,
      hari: input.daysPresent,
      keluar_pada: konteks.keluarPada,
      bruto_masa_sebelum: pembanding.bruto_masa,
      pph_masa_sebelum: pembanding.pph_masa,
      bruto_tahun_sebelum: pembanding.bruto_tahun,
      pph_tahun_sebelum: pembanding.pph_tahun,
      iuran_pensiun_sebelum: pembanding.iuran_pensiun_tahun,
      iuran_pensiun_run: iuranPensiunRun,
      masa_berbruto_lain: pembanding.masa_berbruto_lain,
      rumus_lama:
        pembanding.rumus_lama_masa || (terakhir && pembanding.rumus_lama_tahun),
      status_pajak_berubah: terakhir && pembanding.status_berubah,
      komponen_per_run: pembanding.run_masa > 0 && komponenTetap,
    },
    rules.taxRules,
  );

  return {
    overtimeIndex,
    holidayIndex,
    basic,
    overtime,
    allowance,
    deduction,
    gross,
    bpjsEmployee: bpjs.karyawan,
    bpjsCompany: bpjs.perusahaan,
    pph21: pajak.pph,
    // PPh negatif (pengembalian) menambah gaji bersih.
    net: Math.max(0, gross - deduction - bpjs.karyawan - pajak.pph),
    components,
    bpjs: bpjs.rincian,
    tax: {
      method: pajak.metode,
      category: pajak.kategori,
      ptkp_status: konteks.ptkpAwalTahun,
      rate_percentage: pajak.tarif === null ? null : pajak.tarif / 100,
      pph21_amount: pajak.pph,
    },
    pajak,
    bpjsMasa: {
      dasar_run: bpjs.dasar_run,
      dasar_masa: bpjs.dasar_masa,
      tanda: bpjs.tanda,
    },
  };
}

const PAYROLL_STATUS_TRANSITIONS: Record<string, string[]> = {
  DRAFT: ["SUBMITTED"],
  SUBMITTED: ["REVIEWED", "REJECTED"],
  REVIEWED: ["APPROVED", "REJECTED"],
  APPROVED: ["PAID"],
  PAID: [],
  REJECTED: ["DRAFT"],
};

export const PAYROLL_STATUSES = [
  "DRAFT",
  "SUBMITTED",
  "REVIEWED",
  "APPROVED",
  "PAID",
  "REJECTED",
] as const;

/**
 * Tanpa jenjang HARI_LIBUR yang aktif, jam di hari libur dibayar seperti hari
 * biasa: jam kerjanya reguler, sisanya lembur HARI_KERJA. Tanpa ini indeksnya
 * nol dan jam itu tidak dibayar sama sekali. Mengembalikan menit
 * `[reguler, lembur, libur]`. Cermin `apply_holiday_fallback` di engine.rs.
 */
export function applyHolidayFallback(
  regularMinutes: number,
  overtimeMinutes: number,
  holidayTotalMinutes: number,
  holidayRegularMinutes: number,
  holidayTiersActive: boolean,
): [number, number, number] {
  if (holidayTiersActive) {
    return [regularMinutes, overtimeMinutes, holidayTotalMinutes];
  }
  return [
    regularMinutes + holidayRegularMinutes,
    overtimeMinutes + holidayTotalMinutes - holidayRegularMinutes,
    0,
  ];
}

export function isValidPayrollStatus(value: string): boolean {
  return (PAYROLL_STATUSES as readonly string[]).includes(value.toUpperCase());
}

// Mirrors PayrollStatus::can_transition_to in models.rs exactly.
export function canTransitionPayrollStatus(
  current: string,
  next: string,
): boolean {
  const from = current.trim().toUpperCase();
  const to = next.trim().toUpperCase();
  return PAYROLL_STATUS_TRANSITIONS[from]?.includes(to) ?? false;
}
