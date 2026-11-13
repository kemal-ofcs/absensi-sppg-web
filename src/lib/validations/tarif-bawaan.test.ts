import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as T from "./tarif-bawaan";

describe("tarif bawaan (cermin payroll_seed.rs)", () => {
  test("TER A 44, B 40, C 41, Pasal 17 5 lapis, bersambung dan naik", () => {
    for (const [kategori, jumlah, tertinggi] of [
      ["TER_A", 44, 1_400_000_000],
      ["TER_B", 40, 1_405_000_000],
      ["TER_C", 41, 1_419_000_000],
      ["PASAL_17", 5, 5_000_000_000],
    ] as const) {
      const lapis = T.TARIF_PAJAK_BAWAAN.filter((t) => t.category === kategori);
      expect(lapis.length).toBe(jumlah);
      expect(lapis[0]?.bracket_min).toBe(0);
      for (let i = 1; i < lapis.length; i++) {
        expect(lapis[i]?.bracket_min).toBe(lapis[i - 1]?.bracket_max as number);
        expect(lapis[i]?.rate_percentage).toBeGreaterThan(
          lapis[i - 1]?.rate_percentage ?? 0,
        );
      }
      const akhir = lapis.at(-1);
      expect([akhir?.bracket_min, akhir?.bracket_max]).toEqual([
        tertinggi,
        null,
      ]);
    }
    expect(T.koreksiPajakArgs().length).toBe(55);
    expect(T.koreksiJpArgs()).toEqual([
      [11_086_300, "2026-03-01", "JP_EMP", 10_042_300],
      [11_086_300, "2026-03-01", "JP_CO", 10_042_300],
    ]);
  });

  test("SQL disalin harfiah ke payroll_seed.rs (Desktop dan Mobile)", () => {
    let diperiksa = 0;
    for (const dir of ["desktop", "mobile"]) {
      const lokasi = [
        join(import.meta.dir, `../../../src-tauri/src/${dir}/payroll_seed.rs`),
        join(
          import.meta.dir,
          `../../../../mobile/src-tauri/src/${dir}/payroll_seed.rs`,
        ),
      ].find(existsSync);
      if (!lokasi) continue;
      diperiksa++;
      const rust = readFileSync(lokasi, "utf8");
      for (const teks of [
        T.TAX_RULES_SEED_SQL,
        T.BPJS_RULES_SEED_SQL,
        T.KOREKSI_PAJAK_SQL,
        T.KOREKSI_JP_SQL,
      ]) {
        expect(rust).toContain(teks);
      }
    }
    expect(diperiksa).toBeGreaterThan(0);
  });
});
