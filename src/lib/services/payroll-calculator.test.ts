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
