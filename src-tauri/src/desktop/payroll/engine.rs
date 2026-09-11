use rust_decimal::prelude::*;
use rust_decimal::Decimal;
use serde_json::json;

use super::models::{BpjsRule, OvertimeTierRule, PayrollComponent, TaxRule};

pub struct PayrollCalculator;

impl PayrollCalculator {
    /// Upah dari MENIT bulat dan tarif per jam.
    ///
    /// Urutannya menentukan, dan inilah satu-satunya tempat urutan itu dieja.
    /// Membagi lebih dulu — `Decimal::from(menit) / 60`, lalu dikalikan tarif —
    /// membuang presisi SEBELUM pembulatan: `11/60` bukan pecahan yang
    /// berhenti, jadi ia dipotong pada 28 digit menjadi sedikit di BAWAH nilai
    /// sebenarnya, dan hasil kalinya menjadi 3437,4999… Nilai yang seharusnya
    /// 3437,5 tepat lalu dibulatkan ke bawah, sehingga kebijakan
    /// `MidpointAwayFromZero` yang tertulis di bawah tidak pernah benar-benar
    /// berlaku pada titik tengah.
    ///
    /// Mengalikan lebih dulu membuat pembilangnya bilangan bulat eksak, dan
    /// hasil baginya oleh 60 selalu berhenti tepat ketika nilainya setengah
    /// bulat — persis kasus yang pembulatannya diperdebatkan. Cerminan TS-nya
    /// ada di `payroll-recap.ts` dan wajib tetap sama.
    pub fn wage_from_minutes(minutes: i64, rate_per_hour: i64) -> Decimal {
        ((Decimal::from(minutes) * Decimal::from(rate_per_hour)) / Decimal::from(60))
            .round_dp_with_strategy(0, RoundingStrategy::MidpointAwayFromZero)
    }

    /// Menghitung akumulasi indeks lembur berjenjang (PP 35/2021)
    /// Contoh Hari Kerja: 3 Jam Lembur -> Jam 1: 1.0 * 1.5 = 1.5; Jam 2-3: 2.0 * 2.0 = 4.0; Total Indeks = 5.5
    pub fn calculate_overtime_index(
        overtime_hours: Decimal,
        tiers: &[OvertimeTierRule],
    ) -> Decimal {
        if overtime_hours <= Decimal::ZERO || tiers.is_empty() {
            return Decimal::ZERO;
        }

        let mut remaining = overtime_hours;
        let mut total_index = Decimal::ZERO;

        for tier in tiers {
            if tier.is_active == 0 {
                continue;
            }
            if remaining <= Decimal::ZERO {
                break;
            }

            let start = Decimal::from_f64_retain(tier.hour_start).unwrap_or(Decimal::ZERO);
            let multiplier = Decimal::from_f64_retain(tier.multiplier).unwrap_or(Decimal::ONE);

            let span = match tier.hour_end {
                Some(end) => {
                    let end_dec = Decimal::from_f64_retain(end).unwrap_or(Decimal::ZERO);
                    if end_dec > start {
                        end_dec - start
                    } else {
                        Decimal::ZERO
                    }
                }
                None => remaining, // Tier tak berhingga
            };

            if span <= Decimal::ZERO {
                continue;
            }

            let hours_in_tier = remaining.min(span);
            total_index += hours_in_tier * multiplier;
            remaining -= hours_in_tier;
        }

        total_index.round_dp_with_strategy(2, RoundingStrategy::MidpointAwayFromZero)
    }

    /// Menghitung tunjangan dan potongan dinamis
    pub fn calculate_components(
        basic_salary: Decimal,
        components: &[PayrollComponent],
        id_karyawan: &str,
    ) -> (Decimal, Decimal, Vec<serde_json::Value>) {
        let mut total_allowance = Decimal::ZERO;
        let mut total_deduction = Decimal::ZERO;
        let mut breakdown = Vec::new();

        for comp in components {
            if comp.is_active == 0 {
                continue;
            }
            if comp.applies_to != "ALL" && comp.applies_to != id_karyawan {
                continue;
            }

            let default_val = Decimal::from_f64_retain(comp.default_value).unwrap_or(Decimal::ZERO);
            let nominal = if comp.calc_type == "PERCENTAGE" {
                (basic_salary * (default_val / Decimal::from(100)))
                    .round_dp_with_strategy(0, RoundingStrategy::MidpointAwayFromZero)
            } else {
                default_val.round_dp_with_strategy(0, RoundingStrategy::MidpointAwayFromZero)
            };

            if comp.category == "ALLOWANCE" {
                total_allowance += nominal;
            } else {
                total_deduction += nominal;
            }

            breakdown.push(json!({
                "id": comp.id,
                "name": comp.name,
                "category": comp.category,
                "calc_type": comp.calc_type,
                "rate": comp.default_value,
                "nominal": nominal.to_i64().unwrap_or(0)
            }));
        }

        (total_allowance, total_deduction, breakdown)
    }

    /// Menghitung BPJS Ketenagakerjaan & Kesehatan
    pub fn calculate_bpjs(
        gross_salary: Decimal,
        bpjs_rules: &[BpjsRule],
    ) -> (Decimal, Decimal, Vec<serde_json::Value>) {
        let mut total_emp = Decimal::ZERO;
        let mut total_co = Decimal::ZERO;
        let mut breakdown = Vec::new();

        for rule in bpjs_rules {
            let basis = match rule.wage_cap {
                Some(cap) if cap > 0 => {
                    let cap_dec = Decimal::from(cap);
                    gross_salary.min(cap_dec)
                }
                _ => gross_salary,
            };

            let rate = Decimal::from_f64_retain(rule.rate_percentage).unwrap_or(Decimal::ZERO);
            let nominal = (basis * (rate / Decimal::from(100)))
                .round_dp_with_strategy(0, RoundingStrategy::MidpointAwayFromZero);

            let is_employee = rule.component_code.ends_with("_EMP");
            if is_employee {
                total_emp += nominal;
            } else {
                total_co += nominal;
            }

            breakdown.push(json!({
                "code": rule.component_code,
                "name": rule.component_name,
                "rate": rule.rate_percentage,
                "wage_cap": rule.wage_cap,
                "nominal": nominal.to_i64().unwrap_or(0),
                "is_employee": is_employee
            }));
        }

        (total_emp, total_co, breakdown)
    }

    /// Menghitung PPh 21 Metode TER (PMK 168/2023)
    pub fn calculate_pph21_ter(
        gross_salary: Decimal,
        ptkp_status: &str,
        tax_rules: &[TaxRule],
    ) -> (Decimal, serde_json::Value) {
        // Tentukan Kategori TER berdasarkan PTKP
        let ter_category = match ptkp_status.trim().to_uppercase().as_str() {
            "TK/0" | "TK/1" | "K/0" => "TER_A",
            "TK/2" | "TK/3" | "K/1" | "K/2" => "TER_B",
            "K/3" => "TER_C",
            _ => "TER_A",
        };

        let gross_i64 = gross_salary.to_i64().unwrap_or(0);

        // Cari bracket TER yang cocok
        let matching_rule = tax_rules.iter().find(|rule| {
            if rule.category != ter_category {
                return false;
            }
            let min_ok = gross_i64 >= rule.bracket_min;
            let max_ok = match rule.bracket_max {
                Some(max) => gross_i64 <= max,
                None => true,
            };
            min_ok && max_ok
        });

        if let Some(rule) = matching_rule {
            let rate = Decimal::from_f64_retain(rule.rate_percentage).unwrap_or(Decimal::ZERO);
            let pph21 = (gross_salary * (rate / Decimal::from(100)))
                .round_dp_with_strategy(0, RoundingStrategy::MidpointAwayFromZero);

            (
                pph21,
                json!({
                    "method": "TER",
                    "category": ter_category,
                    "ptkp_status": ptkp_status,
                    "rate_percentage": rule.rate_percentage,
                    "pph21_amount": pph21.to_i64().unwrap_or(0)
                }),
            )
        } else {
            (
                Decimal::ZERO,
                json!({
                    "method": "TER",
                    "category": ter_category,
                    "ptkp_status": ptkp_status,
                    "rate_percentage": 0.0,
                    "pph21_amount": 0
                }),
            )
        }
    }
}

#[cfg(test)]
mod tests {
    use super::PayrollCalculator;
    use rust_decimal::Decimal;

    /// Vektor yang SAMA dieja di `payroll-calculator.test.ts`.
    ///
    /// Uang dihitung dua kali di repo ini — Rust untuk Desktop/Mobile, TypeScript
    /// untuk Web — dan keduanya menulis ke `payroll_items` yang sama. Yang
    /// menjaga keduanya tetap sepakat bukan komentar, melainkan vektor ini.
    ///
    /// Empat kasus pertama adalah titik tengah sejati: `menit x tarif` habis
    /// dibagi 30 tetapi tidak habis dibagi 60, sehingga nilainya tepat setengah
    /// rupiah. Di sanalah kebijakan `MidpointAwayFromZero` benar-benar diuji,
    /// dan di sanalah urutan bagi-lalu-kali yang lama selalu membulatkan ke
    /// BAWAH.
    const VEKTOR: &[(i64, i64, i64)] = &[
        // (menit, tarif per jam, upah yang benar)
        (11, 18_750, 3_438),
        (9, 18_750, 2_813),
        (7, 18_750, 2_188),
        (13, 18_750, 4_063),
        // Pembagian yang berhenti: tidak ada perdebatan pembulatan.
        (60, 25_000, 25_000),
        (30, 25_000, 12_500),
        (0, 25_000, 0),
        // Sehari penuh dan sebulan penuh.
        (480, 18_750, 150_000),
        (10_080, 21_875, 3_675_000),
    ];

    #[test]
    fn upah_dari_menit_membulatkan_titik_tengah_menjauhi_nol() {
        for (menit, tarif, harapan) in VEKTOR {
            let hasil = PayrollCalculator::wage_from_minutes(*menit, *tarif);
            assert_eq!(
                hasil,
                Decimal::from(*harapan),
                "{menit} menit pada tarif {tarif}/jam"
            );
        }
    }

    /// Membagi lebih dulu memang membuang titik tengahnya.
    ///
    /// Tes ini menahan bentuk lama supaya tidak diam-diam kembali: ia menuntut
    /// urutan bagi-lalu-kali benar-benar menghasilkan jawaban yang BERBEDA,
    /// sehingga siapa pun yang menyederhanakan `wage_from_minutes` kembali ke
    /// bentuk itu akan melihat tes ini gagal, bukan menemukannya berbulan
    /// kemudian di slip gaji.
    #[test]
    fn membagi_lebih_dulu_kehilangan_titik_tengahnya() {
        let menit = Decimal::from(11);
        let tarif = Decimal::from(18_750);
        let lewat_jam = (menit / Decimal::from(60) * tarif).round();
        assert_eq!(
            lewat_jam,
            Decimal::from(3_437),
            "bentuk lama membulatkan ke bawah"
        );
        assert_eq!(
            PayrollCalculator::wage_from_minutes(11, 18_750),
            Decimal::from(3_438),
            "bentuk sekarang membulatkan menjauhi nol"
        );
    }
}
