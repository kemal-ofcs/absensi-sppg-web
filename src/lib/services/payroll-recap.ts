import "server-only";

import type { Client } from "@libsql/client";
import {
  type BpjsRule,
  calculateBpjs,
  calculateComponents,
  calculateOvertimeIndex,
  calculatePph21Ter,
  type OvertimeTierRule,
  type PayrollComponent,
  roundMoney,
  type TaxRule,
} from "@/lib/services/payroll-calculator";

export interface PayrollRecapRow {
  id_karyawan: string;
  nama_karyawan: string;
  divisi: string;
  rate_per_hour: number;
  ptkp_status: string;
  total_hadir: number;
  total_terlambat_menit: number;
  total_regular_hours: number;
  total_overtime_hours: number;
  total_overtime_index: number;
  /**
   * Seluruh jam kerja yang jatuh pada tanggal hari libur aktif.
   *
   * Menurut PP 35/2021 tidak ada "jam kerja biasa" pada hari libur resmi: SETIAP
   * jam yang dikerjakan hari itu dihitung lembur. Karena itu nilainya adalah
   * jam_kerja + lembur pada tanggal tersebut, dan ia sengaja TIDAK ikut
   * `total_regular_hours`/`total_overtime_hours`.
   */
  total_holiday_hours: number;
  /** Indeks hasil `total_holiday_hours` melewati jenjang HARI_LIBUR. */
  total_holiday_overtime_index: number;
  est_basic_salary: number;
  est_overtime_salary: number;
  est_gross_salary: number;
  est_total_allowance: number;
  est_total_deduction: number;
  est_bpjs_employee: number;
  est_pph21: number;
  est_net_salary: number;
  // Extra fields (not part of the Rust PayrollRecapRow response shape, but
  // needed by run creation to build payroll_items without recomputing).
  breakdown_snapshot: string;
  bpjs_company_total: number;
}

async function loadOvertimeTiers(
  client: Client,
  ruleType: string,
): Promise<OvertimeTierRule[]> {
  const result = await client.execute({
    sql: `SELECT id, rule_type, tier_order, hour_start, hour_end, multiplier, is_active
          FROM overtime_tier_rules
          WHERE rule_type = ? AND is_active = 1
          ORDER BY tier_order ASC;`,
    args: [ruleType],
  });
  return result.rows.map((row) => ({
    id: String(row.id),
    rule_type: String(row.rule_type),
    tier_order: Number(row.tier_order),
    hour_start: Number(row.hour_start),
    hour_end: row.hour_end === null ? null : Number(row.hour_end),
    multiplier: Number(row.multiplier),
    is_active: Number(row.is_active),
  }));
}

async function loadPayrollComponents(
  client: Client,
): Promise<PayrollComponent[]> {
  const result = await client.execute(
    `SELECT id, name, category, calc_type, default_value, applies_to, is_active
     FROM payroll_components
     WHERE is_active = 1
     ORDER BY category, name ASC;`,
  );
  return result.rows.map((row) => ({
    id: String(row.id),
    name: String(row.name),
    category: String(row.category),
    calc_type: String(row.calc_type),
    default_value: Number(row.default_value),
    applies_to: String(row.applies_to),
    is_active: Number(row.is_active),
  }));
}

async function loadTaxRules(client: Client): Promise<TaxRule[]> {
  const result = await client.execute(
    `SELECT id, category, bracket_min, bracket_max, rate_percentage, effective_date
     FROM tax_rules
     ORDER BY category, bracket_min ASC;`,
  );
  return result.rows.map((row) => ({
    id: String(row.id),
    category: String(row.category),
    bracket_min: Number(row.bracket_min),
    bracket_max: row.bracket_max === null ? null : Number(row.bracket_max),
    rate_percentage: Number(row.rate_percentage),
    effective_date: String(row.effective_date),
  }));
}

async function loadBpjsRules(client: Client): Promise<BpjsRule[]> {
  const result = await client.execute(
    `SELECT id, component_code, component_name, rate_percentage, wage_cap, effective_date
     FROM bpjs_rules
     ORDER BY component_code ASC;`,
  );
  return result.rows.map((row) => ({
    id: String(row.id),
    component_code: String(row.component_code),
    component_name: String(row.component_name),
    rate_percentage: Number(row.rate_percentage),
    wage_cap: row.wage_cap === null ? null : Number(row.wage_cap),
    effective_date: String(row.effective_date),
  }));
}

export async function computePayrollRecap(
  client: Client,
  periodStart: string,
  periodEnd: string,
): Promise<PayrollRecapRow[]> {
  const [
    overtimeTiers,
    holidayTiers,
    components,
    taxRules,
    bpjsRules,
    aggResult,
  ] = await Promise.all([
    loadOvertimeTiers(client, "HARI_KERJA"),
    // Jenjang lembur hari libur dikonfigurasi terpisah oleh user di menu
    // "Aturan Jenjang Lembur" (rule_type = 'HARI_LIBUR'). Sebelum ini jenjang
    // itu tersimpan dan bisa disunting, tetapi tidak pernah dibaca siapa pun.
    loadOvertimeTiers(client, "HARI_LIBUR"),
    loadPayrollComponents(client),
    loadTaxRules(client),
    loadBpjsRules(client),
    client.execute({
      sql: `
          SELECT
            md.id_unik,
            md.nama,
            md.divisi,
            COALESCE(sc.rate_per_hour, 0) AS rate_per_hour,
            COALESCE(sc.ptkp_status, 'TK/0') AS ptkp_status,
            COUNT(CASE WHEN ah.status_kehadiran IN ('Hadir', 'PRESENT') THEN 1 END) AS total_hadir,
            COALESCE(SUM(ah.menit_terlambat), 0) AS total_terlambat_menit,
            COALESCE(SUM(CASE WHEN hl.tanggal IS NULL THEN ah.jam_kerja ELSE 0 END), 0) AS total_jam_kerja_menit,
            COALESCE(SUM(CASE WHEN hl.tanggal IS NULL THEN ah.lembur ELSE 0 END), 0) AS total_lembur_menit,
            COALESCE(SUM(CASE WHEN hl.tanggal IS NOT NULL
              THEN COALESCE(ah.jam_kerja, 0) + COALESCE(ah.lembur, 0) ELSE 0 END), 0) AS total_libur_menit
          FROM master_data md
          LEFT JOIN salary_configs sc ON sc.id_karyawan = md.id_unik
            AND sc.effective_date = (
              SELECT MAX(effective_date) FROM salary_configs
              WHERE id_karyawan = md.id_unik AND effective_date <= ?
            )
          LEFT JOIN absensi_harian ah ON ah.id_karyawan = md.id_unik
            AND ah.tanggal >= ? AND ah.tanggal <= ?
          -- Penanda hari libur diambil dari tanggal kerja barisnya, BUKAN dari
          -- kolom pada absensi_harian. Kolom tbl_hari_libur.tanggal UNIQUE sehingga
          -- join ini tidak pernah menggandakan baris, dan absensi lama otomatis
          -- ikut terhitung benar begitu admin melengkapi daftar hari liburnya.
          LEFT JOIN tbl_hari_libur hl ON hl.tanggal = ah.tanggal AND hl.status_aktif = 1
          WHERE md.status_aktif = 'Aktif'
          GROUP BY md.id_unik
          ORDER BY md.nama ASC;
        `,
      args: [periodEnd, periodStart, periodEnd],
    }),
  ]);

  return aggResult.rows.map((row) => {
    const idKaryawan = String(row.id_unik);
    const jamKerjaMenit = Number(row.total_jam_kerja_menit || 0);
    const lemburMenit = Number(row.total_lembur_menit || 0);
    const ratePerHour = Number(row.rate_per_hour || 0);
    const ptkpStatus = String(row.ptkp_status || "TK/0");

    const liburMenit = Number(row.total_libur_menit || 0);

    const regHours = jamKerjaMenit / 60;
    const otHours = lemburMenit / 60;
    const holidayHours = liburMenit / 60;

    // Dua indeks, dua jenjang: jam lembur hari biasa memakai HARI_KERJA,
    // seluruh jam pada tanggal libur memakai HARI_LIBUR. Keduanya dijumlahkan
    // lalu dikalikan rate per jam SEKALI, supaya pembulatannya identik dengan
    // `desktop_get_payroll_recap` di payroll/commands.rs.
    const otIndex = calculateOvertimeIndex(otHours, overtimeTiers);
    const holidayIndex = calculateOvertimeIndex(holidayHours, holidayTiers);
    const basicSalary = roundMoney(regHours * ratePerHour);
    const overtimeSalary = roundMoney((otIndex + holidayIndex) * ratePerHour);

    const {
      allowance,
      deduction,
      breakdown: compBreakdown,
    } = calculateComponents(basicSalary, components, idKaryawan);

    const gross = basicSalary + overtimeSalary + allowance;
    const {
      employee: bpjsEmployee,
      company: bpjsCompany,
      breakdown: bpjsBreakdown,
    } = calculateBpjs(gross, bpjsRules);
    const { pph21Amount, breakdown: taxBreakdown } = calculatePph21Ter(
      gross,
      ptkpStatus,
      taxRules,
    );

    const net = Math.max(0, gross - deduction - bpjsEmployee - pph21Amount);

    const breakdownSnapshot = JSON.stringify({
      rate_per_hour: ratePerHour,
      regular_hours: regHours,
      overtime_hours: otHours,
      overtime_index: otIndex,
      holiday_hours: holidayHours,
      holiday_overtime_index: holidayIndex,
      basic_salary: basicSalary,
      overtime_salary: overtimeSalary,
      components: compBreakdown,
      bpjs: bpjsBreakdown,
      tax: taxBreakdown,
      calculated_at: new Date().toISOString(),
    });

    return {
      id_karyawan: idKaryawan,
      nama_karyawan: String(row.nama || ""),
      divisi: String(row.divisi || ""),
      rate_per_hour: ratePerHour,
      ptkp_status: ptkpStatus,
      total_hadir: Number(row.total_hadir || 0),
      total_terlambat_menit: Number(row.total_terlambat_menit || 0),
      total_regular_hours: regHours,
      total_overtime_hours: otHours,
      total_overtime_index: otIndex,
      total_holiday_hours: holidayHours,
      total_holiday_overtime_index: holidayIndex,
      est_basic_salary: basicSalary,
      est_overtime_salary: overtimeSalary,
      est_gross_salary: gross,
      est_total_allowance: allowance,
      est_total_deduction: deduction,
      est_bpjs_employee: bpjsEmployee,
      est_pph21: pph21Amount,
      est_net_salary: net,
      breakdown_snapshot: breakdownSnapshot,
      bpjs_company_total: bpjsCompany,
    };
  });
}
