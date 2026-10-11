use rust_decimal::prelude::*;
use rust_decimal::Decimal;
use serde_json::json;

use super::models::{
    BpjsRule, OvertimeTierRule, PayrollComponent, TaxRule, SALARY_TYPE_FLAT_DAILY,
};

pub struct PayrollCalculator;

/// Aturan tarif yang berlaku untuk satu periode.
pub struct PayRules<'a> {
    pub overtime_tiers: &'a [OvertimeTierRule],
    pub holiday_tiers: &'a [OvertimeTierRule],
    pub components: &'a [PayrollComponent],
    pub tax_rules: &'a [TaxRule],
    pub bpjs_rules: &'a [BpjsRule],
}

/// Agregat absensi dan konfigurasi gaji satu karyawan dalam satu periode.
pub struct PayInput<'a> {
    pub id_karyawan: &'a str,
    pub ptkp_status: &'a str,
    pub salary_type: &'a str,
    pub rate_per_hour: i64,
    pub daily_rate: i64,
    pub days_present: i64,
    pub regular_minutes: i64,
    pub overtime_minutes: i64,
    pub holiday_minutes: i64,
}

pub struct EmployeePay {
    pub overtime_index: Decimal,
    pub holiday_index: Decimal,
    pub basic: Decimal,
    pub overtime: Decimal,
    pub allowance: Decimal,
    pub deduction: Decimal,
    pub gross: Decimal,
    pub bpjs_employee: Decimal,
    pub bpjs_company: Decimal,
    pub pph21: Decimal,
    pub net: Decimal,
    pub components: Vec<serde_json::Value>,
    pub bpjs: Vec<serde_json::Value>,
    pub tax: serde_json::Value,
}

/// Tarif/pengali tersimpan sebagai REAL. `Decimal::from_f64_retain` membawa
/// galat biner apa adanya (0.3 -> 0.29999999999999998889...), sehingga
/// 2.500 x 0,3% = 7,4999... dibulatkan ke 7, sementara Web mendapat 8.
/// `Display` f64 menghasilkan representasi desimal terpendek ("0.3"), jadi
/// nilai yang diparse sama persis dengan yang diketik admin.
fn exact_decimal(value: f64) -> Option<Decimal> {
    value.to_string().parse().ok()
}

impl PayrollCalculator {
    /// Gaji satu karyawan untuk satu periode — satu-satunya tempat rumusnya.
    ///
    /// Pratinjau rekap dan pembekuan run sama-sama memanggil fungsi ini, jadi
    /// angka yang disetujui admin dan angka yang dibekukan tidak bisa berbeda.
    /// Cerminan TS-nya ada di `payroll-recap.ts` dan wajib tetap sama.
    pub fn calculate_employee_pay(input: &PayInput, rules: &PayRules) -> EmployeePay {
        if input.salary_type == SALARY_TYPE_FLAT_DAILY {
            // Upah harian tetap: durasi kerja, lembur, BPJS, dan PPh 21 tidak
            // ikut. Hanya komponen milik karyawan ini sendiri yang berlaku;
            // komponen 'ALL' dirancang untuk skema per jam.
            let basic = Decimal::from(input.days_present.max(0))
                * Decimal::from(input.daily_rate.max(0));
            let personal: Vec<PayrollComponent> = rules
                .components
                .iter()
                .filter(|comp| comp.applies_to == input.id_karyawan)
                .cloned()
                .collect();
            let (allowance, deduction, components) =
                Self::calculate_components(basic, &personal, input.id_karyawan);
            let gross = basic + allowance;
            return EmployeePay {
                overtime_index: Decimal::ZERO,
                holiday_index: Decimal::ZERO,
                basic,
                overtime: Decimal::ZERO,
                allowance,
                deduction,
                gross,
                bpjs_employee: Decimal::ZERO,
                bpjs_company: Decimal::ZERO,
                pph21: Decimal::ZERO,
                net: (gross - deduction).max(Decimal::ZERO),
                components,
                bpjs: Vec::new(),
                tax: serde_json::Value::Null,
            };
        }

        let ot_hours = Decimal::from(input.overtime_minutes) / Decimal::from(60);
        let holiday_hours = Decimal::from(input.holiday_minutes) / Decimal::from(60);
        // Dua indeks, dua jenjang: jam lembur hari biasa memakai HARI_KERJA,
        // seluruh jam pada tanggal libur memakai HARI_LIBUR. Keduanya
        // dijumlahkan lalu dikalikan rate per jam SEKALI.
        let overtime_index = Self::calculate_overtime_index(ot_hours, rules.overtime_tiers);
        let holiday_index = Self::calculate_overtime_index(holiday_hours, rules.holiday_tiers);
        let basic = Self::wage_from_minutes(input.regular_minutes, input.rate_per_hour);
        let overtime = ((overtime_index + holiday_index) * Decimal::from(input.rate_per_hour))
            .round_dp_with_strategy(0, RoundingStrategy::MidpointAwayFromZero);
        let (allowance, deduction, components) =
            Self::calculate_components(basic, rules.components, input.id_karyawan);
        let gross = basic + overtime + allowance;
        let (bpjs_employee, bpjs_company, bpjs) = Self::calculate_bpjs(gross, rules.bpjs_rules);
        let (pph21, tax) = Self::calculate_pph21_ter(gross, input.ptkp_status, rules.tax_rules);
        EmployeePay {
            overtime_index,
            holiday_index,
            basic,
            overtime,
            allowance,
            deduction,
            gross,
            bpjs_employee,
            bpjs_company,
            pph21,
            net: (gross - deduction - bpjs_employee - pph21).max(Decimal::ZERO),
            components,
            bpjs,
            tax,
        }
    }

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

            let start = exact_decimal(tier.hour_start).unwrap_or(Decimal::ZERO);
            let multiplier = exact_decimal(tier.multiplier).unwrap_or(Decimal::ONE);

            let span = match tier.hour_end {
                Some(end) => {
                    let end_dec = exact_decimal(end).unwrap_or(Decimal::ZERO);
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

            let default_val = exact_decimal(comp.default_value).unwrap_or(Decimal::ZERO);
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

            let rate = exact_decimal(rule.rate_percentage).unwrap_or(Decimal::ZERO);
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
            let rate = exact_decimal(rule.rate_percentage).unwrap_or(Decimal::ZERO);
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
    use super::{exact_decimal, PayrollCalculator};
    use rust_decimal::RoundingStrategy;
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

    use super::{PayInput, PayRules};
    use super::super::models::{BpjsRule, PayrollComponent};

    fn komponen(id: &str, category: &str, value: f64, applies_to: &str) -> PayrollComponent {
        PayrollComponent {
            id: id.to_string(),
            name: id.to_string(),
            category: category.to_string(),
            calc_type: "FIXED".to_string(),
            default_value: value,
            applies_to: applies_to.to_string(),
            is_active: 1,
        }
    }

    /// Vektor yang SAMA dieja di `payroll-calculator.test.ts`.
    /// (hari hadir, tarif harian, tunjangan pribadi, potongan pribadi, gross, net)
    const VEKTOR_HARIAN: &[(i64, i64, f64, f64, i64, i64)] = &[
        (20, 150_000, 0.0, 0.0, 3_000_000, 3_000_000),
        (20, 150_000, 200_000.0, 500_000.0, 3_200_000, 2_700_000),
        (0, 150_000, 0.0, 0.0, 0, 0),
        (1, 150_000, 0.0, 500_000.0, 150_000, 0),
    ];

    #[test]
    fn gaji_harian_tetap_mengabaikan_durasi_lembur_bpjs_dan_komponen_umum() {
        let bpjs = vec![BpjsRule {
            id: "jht".to_string(),
            component_code: "JHT_EMP".to_string(),
            component_name: "JHT".to_string(),
            rate_percentage: 2.0,
            wage_cap: None,
            effective_date: "2024-01-01".to_string(),
        }];
        for (hari, tarif, tunjangan, potongan, gross, net) in VEKTOR_HARIAN {
            let mut components = vec![
                // Komponen umum TIDAK berlaku untuk skema harian.
                komponen("umum", "ALLOWANCE", 999_999.0, "ALL"),
                // Komponen karyawan lain juga tidak.
                komponen("lain", "DEDUCTION", 1.0, "K999"),
            ];
            if *tunjangan > 0.0 {
                components.push(komponen("makan", "ALLOWANCE", *tunjangan, "K001"));
            }
            if *potongan > 0.0 {
                components.push(komponen("kasbon", "DEDUCTION", *potongan, "K001"));
            }
            let rules = PayRules {
                overtime_tiers: &[],
                holiday_tiers: &[],
                components: &components,
                tax_rules: &[],
                bpjs_rules: &bpjs,
            };
            let pay = PayrollCalculator::calculate_employee_pay(
                &PayInput {
                    id_karyawan: "K001",
                    ptkp_status: "TK/0",
                    salary_type: "FLAT_DAILY",
                    rate_per_hour: 50_000,
                    daily_rate: *tarif,
                    days_present: *hari,
                    // 14 jam per hari: tetap tidak menambah satu rupiah pun.
                    regular_minutes: hari * 480,
                    overtime_minutes: hari * 360,
                    holiday_minutes: 600,
                },
                &rules,
            );
            assert_eq!(pay.basic, Decimal::from(hari * tarif), "{hari} hari");
            assert_eq!(pay.overtime, Decimal::ZERO);
            assert_eq!(pay.bpjs_employee + pay.bpjs_company + pay.pph21, Decimal::ZERO);
            assert_eq!(pay.gross, Decimal::from(*gross), "{hari} hari gross");
            assert_eq!(pay.net, Decimal::from(*net), "{hari} hari net");
        }
    }

    #[test]
    fn gaji_per_jam_tetap_memotong_bpjs_dan_memakai_komponen_umum() {
        let components = vec![komponen("umum", "ALLOWANCE", 100_000.0, "ALL")];
        let bpjs = vec![BpjsRule {
            id: "jht".to_string(),
            component_code: "JHT_EMP".to_string(),
            component_name: "JHT".to_string(),
            rate_percentage: 2.0,
            wage_cap: None,
            effective_date: "2024-01-01".to_string(),
        }];
        let rules = PayRules {
            overtime_tiers: &[],
            holiday_tiers: &[],
            components: &components,
            tax_rules: &[],
            bpjs_rules: &bpjs,
        };
        let pay = PayrollCalculator::calculate_employee_pay(
            &PayInput {
                id_karyawan: "K001",
                ptkp_status: "TK/0",
                salary_type: "HOURLY",
                rate_per_hour: 18_750,
                daily_rate: 150_000,
                days_present: 1,
                regular_minutes: 480,
                overtime_minutes: 0,
                holiday_minutes: 0,
            },
            &rules,
        );
        assert_eq!(pay.basic, Decimal::from(150_000));
        assert_eq!(pay.gross, Decimal::from(250_000));
        assert_eq!(pay.bpjs_employee, Decimal::from(5_000));
        assert_eq!(pay.net, Decimal::from(245_000));
    }

    #[test]
    fn tarif_desimal_tidak_membawa_galat_biner() {
        let rate = exact_decimal(0.3).unwrap();
        let nominal = (Decimal::from(2500) * (rate / Decimal::from(100)))
            .round_dp_with_strategy(0, RoundingStrategy::MidpointAwayFromZero);
        assert_eq!(nominal, Decimal::from(8));
        assert_eq!(exact_decimal(f64::NAN), None);
    }
}
