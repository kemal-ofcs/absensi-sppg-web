import { describe, expect, mock, test } from "bun:test";

// `payroll-calculator.ts` menarik `server-only`; tes ini murni aritmetika.
mock.module("server-only", () => ({}));

/**
 * Vektor yang SAMA dieja di `payroll/engine.rs` (`mod tests`).
 *
 * Uang dihitung dua kali di repo ini — Rust untuk Desktop/Mobile, TypeScript
 * untuk Web — dan keduanya menulis ke `payroll_items` yang sama. Yang menjaga
 * keduanya tetap sepakat bukan komentar, melainkan vektor ini. Menambah kasus
 * di satu sisi tanpa sisi lain akan membuat salah satunya diam-diam menyimpang,
 * dan bentuk penyimpangannya adalah selisih rupiah di slip gaji orang.
 *
 * Empat kasus pertama adalah titik tengah sejati: `menit x tarif` habis dibagi
 * 30 tetapi tidak habis dibagi 60, sehingga nilainya tepat setengah rupiah. Di
 * sanalah kebijakan pembulatan benar-benar diuji, dan di sanalah urutan
 * bagi-lalu-kali yang lama selalu membulatkan ke BAWAH.
 */
const VEKTOR: Array<[menit: number, tarif: number, upah: number]> = [
  [11, 18750, 3438],
  [9, 18750, 2813],
  [7, 18750, 2188],
  [13, 18750, 4063],
  [60, 25000, 25000],
  [30, 25000, 12500],
  [0, 25000, 0],
  [480, 18750, 150000],
  [10080, 21875, 3675000],
];

/** Cerminan `PayrollCalculator::wage_from_minutes` di `payroll/engine.rs`. */
async function upahDariMenit(
  menit: number,
  tarifPerJam: number,
): Promise<number> {
  const { roundMoney } = await import("./payroll-calculator");
  return roundMoney((menit * tarifPerJam) / 60);
}

describe("upah dari menit", () => {
  test("membulatkan titik tengah menjauhi nol", async () => {
    for (const [menit, tarif, upah] of VEKTOR) {
      expect(await upahDariMenit(menit, tarif)).toBe(upah);
    }
  });

  /**
   * Menahan bentuk lama supaya tidak diam-diam kembali.
   *
   * `(menit / 60) * tarif` menempuh dua operasi pecahan dan galat pembagiannya
   * membuat nilai yang seharusnya jatuh tepat di titik tengah mendarat sedikit
   * di bawahnya. Tes ini menuntut perbedaan itu benar-benar ada, sehingga siapa
   * pun yang "menyederhanakan" perhitungannya kembali akan melihat tes gagal —
   * bukan menemukannya berbulan kemudian di slip gaji.
   */
  test("membagi lebih dulu kehilangan titik tengahnya", async () => {
    const { roundMoney } = await import("./payroll-calculator");
    expect(roundMoney((11 / 60) * 18750)).toBe(3437);
    expect(await upahDariMenit(11, 18750)).toBe(3438);
  });
});

/** Vektor yang SAMA dengan `VEKTOR_HARIAN` di `payroll/engine.rs`. */
const VEKTOR_HARIAN: Array<
  [
    hari: number,
    tarif: number,
    tunjangan: number,
    potongan: number,
    gross: number,
    net: number,
  ]
> = [
  [20, 150000, 0, 0, 3000000, 3000000],
  [20, 150000, 200000, 500000, 3200000, 2700000],
  [0, 150000, 0, 0, 0, 0],
  [1, 150000, 0, 500000, 150000, 0],
];

function komponen(
  id: string,
  category: string,
  value: number,
  appliesTo: string,
) {
  return {
    id,
    name: id,
    category,
    calc_type: "FIXED",
    default_value: value,
    applies_to: appliesTo,
    is_active: 1,
  };
}

const BPJS_JHT = [
  {
    id: "jht",
    component_code: "JHT_EMP",
    component_name: "JHT",
    rate_percentage: 2,
    wage_cap: null,
    effective_date: "2024-01-01",
  },
];

describe("gaji harian tetap", () => {
  test("mengabaikan durasi, lembur, BPJS, dan komponen umum", async () => {
    const { calculateEmployeePay } = await import("./payroll-calculator");
    for (const [
      hari,
      tarif,
      tunjangan,
      potongan,
      gross,
      net,
    ] of VEKTOR_HARIAN) {
      const components = [
        // Komponen umum dan milik karyawan lain TIDAK berlaku.
        komponen("umum", "ALLOWANCE", 999999, "ALL"),
        komponen("lain", "DEDUCTION", 1, "K999"),
      ];
      if (tunjangan > 0) {
        components.push(komponen("makan", "ALLOWANCE", tunjangan, "K001"));
      }
      if (potongan > 0) {
        components.push(komponen("kasbon", "DEDUCTION", potongan, "K001"));
      }
      const pay = calculateEmployeePay(
        {
          idKaryawan: "K001",
          ptkpStatus: "TK/0",
          salaryType: "FLAT_DAILY",
          ratePerHour: 50000,
          dailyRate: tarif,
          daysPresent: hari,
          // 14 jam per hari: tetap tidak menambah satu rupiah pun.
          regularMinutes: hari * 480,
          overtimeMinutes: hari * 360,
          holidayMinutes: 600,
        },
        {
          overtimeTiers: [],
          holidayTiers: [],
          components,
          taxRules: [],
          bpjsRules: BPJS_JHT,
        },
      );
      expect(pay.basic).toBe(hari * tarif);
      expect(pay.overtime).toBe(0);
      expect(pay.bpjsEmployee + pay.bpjsCompany + pay.pph21).toBe(0);
      expect(pay.gross).toBe(gross);
      expect(pay.net).toBe(net);
    }
  });

  test("gaji per jam tetap memotong BPJS dan memakai komponen umum", async () => {
    const { calculateEmployeePay } = await import("./payroll-calculator");
    const pay = calculateEmployeePay(
      {
        idKaryawan: "K001",
        ptkpStatus: "TK/0",
        salaryType: "HOURLY",
        ratePerHour: 18750,
        dailyRate: 150000,
        daysPresent: 1,
        regularMinutes: 480,
        overtimeMinutes: 0,
        holidayMinutes: 0,
      },
      {
        overtimeTiers: [],
        holidayTiers: [],
        components: [komponen("umum", "ALLOWANCE", 100000, "ALL")],
        taxRules: [],
        bpjsRules: BPJS_JHT,
      },
    );
    expect(pay.basic).toBe(150000);
    expect(pay.gross).toBe(250000);
    expect(pay.bpjsEmployee).toBe(5000);
    expect(pay.net).toBe(245000);
  });
});

// Vektor kembar `jam_hari_libur_tanpa_jenjang_dibayar_seperti_hari_biasa`.
test("jam hari libur tanpa jenjang dibayar seperti hari biasa", async () => {
  const { applyHolidayFallback } = await import("./payroll-calculator");
  expect(applyHolidayFallback(480, 60, 540, 480, true)).toEqual([480, 60, 540]);
  expect(applyHolidayFallback(480, 60, 540, 480, false)).toEqual([960, 120, 0]);
  expect(applyHolidayFallback(0, 0, 0, 0, false)).toEqual([0, 0, 0]);
});
