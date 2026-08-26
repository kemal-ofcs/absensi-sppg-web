import "server-only";

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

export function calculateComponents(
  basicSalary: number,
  components: PayrollComponent[],
  idKaryawan: string,
): {
  allowance: number;
  deduction: number;
  breakdown: ComponentBreakdownEntry[];
} {
  let totalAllowance = 0;
  let totalDeduction = 0;
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

  return { allowance: totalAllowance, deduction: totalDeduction, breakdown };
}

export interface BpjsBreakdownEntry {
  code: string;
  name: string;
  rate: number;
  wage_cap: number | null;
  nominal: number;
  is_employee: boolean;
}

export function calculateBpjs(
  grossSalary: number,
  bpjsRules: BpjsRule[],
): { employee: number; company: number; breakdown: BpjsBreakdownEntry[] } {
  let totalEmployee = 0;
  let totalCompany = 0;
  const breakdown: BpjsBreakdownEntry[] = [];

  for (const rule of bpjsRules) {
    const basis =
      rule.wage_cap !== null && rule.wage_cap !== undefined && rule.wage_cap > 0
        ? Math.min(grossSalary, rule.wage_cap)
        : grossSalary;

    const nominal = roundMoney(basis * (rule.rate_percentage / 100));
    const isEmployee = rule.component_code.endsWith("_EMP");
    if (isEmployee) {
      totalEmployee += nominal;
    } else {
      totalCompany += nominal;
    }

    breakdown.push({
      code: rule.component_code,
      name: rule.component_name,
      rate: rule.rate_percentage,
      wage_cap: rule.wage_cap,
      nominal,
      is_employee: isEmployee,
    });
  }

  return { employee: totalEmployee, company: totalCompany, breakdown };
}

export interface Pph21Breakdown {
  method: "TER";
  category: string;
  ptkp_status: string;
  rate_percentage: number;
  pph21_amount: number;
}

export function calculatePph21Ter(
  grossSalary: number,
  ptkpStatus: string,
  taxRules: TaxRule[],
): { pph21Amount: number; breakdown: Pph21Breakdown } {
  const terCategory = (() => {
    switch (ptkpStatus.trim().toUpperCase()) {
      case "TK/0":
      case "TK/1":
      case "K/0":
        return "TER_A";
      case "TK/2":
      case "TK/3":
      case "K/1":
      case "K/2":
        return "TER_B";
      case "K/3":
        return "TER_C";
      default:
        return "TER_A";
    }
  })();

  const grossInt = Math.trunc(grossSalary);
  const rule = taxRules.find((r) => {
    if (r.category !== terCategory) return false;
    const minOk = grossInt >= r.bracket_min;
    const maxOk =
      r.bracket_max === null || r.bracket_max === undefined
        ? true
        : grossInt <= r.bracket_max;
    return minOk && maxOk;
  });

  if (rule) {
    const pph21 = roundMoney(grossSalary * (rule.rate_percentage / 100));
    return {
      pph21Amount: pph21,
      breakdown: {
        method: "TER",
        category: terCategory,
        ptkp_status: ptkpStatus,
        rate_percentage: rule.rate_percentage,
        pph21_amount: pph21,
      },
    };
  }

  return {
    pph21Amount: 0,
    breakdown: {
      method: "TER",
      category: terCategory,
      ptkp_status: ptkpStatus,
      rate_percentage: 0,
      pph21_amount: 0,
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
