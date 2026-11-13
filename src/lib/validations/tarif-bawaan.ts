/**
 * Tarif bawaan PPh 21 (TER A/B/C PP 58/2023, Pasal 17) dan BPJS.
 *
 * Cermin `desktop/payroll_seed.rs`; keduanya membaca `tarif-bawaan.json`.
 * Seed Web dulu hanya menanam Pasal 17 dan BPJS ber-id lama, sehingga
 * pemasangan Web saja tidak punya TER dan PPh 21 selalu 0 (§29.1 temuan 6).
 */
import tarifBawaan from "./tarif-bawaan.json";

export interface TarifPajak {
  id: string;
  category: "TER_A" | "TER_B" | "TER_C" | "PASAL_17";
  bracket_min: number;
  bracket_max: number | null;
  rate_percentage: number;
  effective_date: string;
}

export interface TarifBpjs {
  id: string;
  component_code: string;
  component_name: string;
  rate_percentage: number;
  wage_cap: number | null;
  effective_date: string;
}

interface TarifBawaanJson {
  pajak: TarifPajak[];
  bpjs: TarifBpjs[];
  id_lama: string[];
  koreksi_v45: {
    pajak_lama: Omit<TarifPajak, "category" | "effective_date">[];
    jp_wage_cap_lama: number;
  };
}

const TARIF = tarifBawaan as TarifBawaanJson;

export const TARIF_PAJAK_BAWAAN: readonly TarifPajak[] = TARIF.pajak;
export const TARIF_BPJS_BAWAAN: readonly TarifBpjs[] = TARIF.bpjs;

/** Id seed versi lama, dibuang di lokal maupun cloud (`LEGACY_RATE_IDS`). */
export const LEGACY_RATE_IDS: readonly string[] = TARIF.id_lama;

/** Cermin `TAX_RULES_SEED_SQL`. Idempoten: tarif yang disunting admin tidak ditimpa. */
export const TAX_RULES_SEED_SQL =
  "INSERT OR IGNORE INTO tax_rules (id, category, bracket_min, bracket_max, rate_percentage, effective_date) VALUES (?1, ?2, ?3, ?4, ?5, ?6);";

/** Cermin `BPJS_RULES_SEED_SQL`. Kode yang sudah dipakai baris lain dilewati (UNIQUE). */
export const BPJS_RULES_SEED_SQL =
  "INSERT OR IGNORE INTO bpjs_rules (id, component_code, component_name, rate_percentage, wage_cap, effective_date) VALUES (?1, ?2, ?3, ?4, ?5, ?6);";

/**
 * Cermin `KOREKSI_PAJAK_SQL` (v45): lapis TER B/C seed lama diganti hanya bila
 * ketiga nilainya masih persis seed lama (Q-186 (a)).
 */
export const KOREKSI_PAJAK_SQL =
  "UPDATE tax_rules SET bracket_min = ?1, bracket_max = ?2, rate_percentage = ?3 WHERE id = ?4 AND bracket_min = ?5 AND bracket_max IS ?6 AND rate_percentage = ?7;";

/** Cermin `KOREKSI_JP_SQL` (v45): batas upah JP hanya untuk baris seed lama. */
export const KOREKSI_JP_SQL =
  "UPDATE bpjs_rules SET wage_cap = ?1, effective_date = ?2 WHERE component_code = ?3 AND wage_cap = ?4;";

export function seedPajakArgs(t: TarifPajak) {
  return [
    t.id,
    t.category,
    t.bracket_min,
    t.bracket_max,
    t.rate_percentage,
    t.effective_date,
  ];
}

export function seedBpjsArgs(t: TarifBpjs) {
  return [
    t.id,
    t.component_code,
    t.component_name,
    t.rate_percentage,
    t.wage_cap,
    t.effective_date,
  ];
}

/** Cermin `koreksi_pajak_args`: nilai baru dari seed, nilai lama dari JSON. */
export function koreksiPajakArgs() {
  return TARIF.koreksi_v45.pajak_lama.map((lama) => {
    const baru = TARIF.pajak.find((t) => t.id === lama.id);
    if (!baru) throw new Error(`koreksi tanpa seed baru: ${lama.id}`);
    return [
      baru.bracket_min,
      baru.bracket_max,
      baru.rate_percentage,
      lama.id,
      lama.bracket_min,
      lama.bracket_max,
      lama.rate_percentage,
    ];
  });
}

/** Cermin `koreksi_jp_args` untuk `JP_EMP` dan `JP_CO`. */
export function koreksiJpArgs() {
  return TARIF.bpjs
    .filter((t) => t.component_code.startsWith("JP_"))
    .map((t) => [
      t.wage_cap,
      t.effective_date,
      t.component_code,
      TARIF.koreksi_v45.jp_wage_cap_lama,
    ]);
}
