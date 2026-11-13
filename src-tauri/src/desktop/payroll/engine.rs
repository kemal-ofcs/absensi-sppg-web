use rust_decimal::prelude::*;
use rust_decimal::Decimal;
use serde_json::json;

use super::models::{
    BpjsRule, OvertimeTierRule, PayrollComponent, TaxRule, SALARY_TYPE_FLAT_DAILY,
};
use super::pajak::{self, HasilBpjs, HasilPph, MasukanPph, Pembanding, RincianBpjs};

pub struct PayrollCalculator;

/// Aturan tarif yang berlaku untuk satu periode.
pub struct PayRules<'a> {
    pub overtime_tiers: &'a [OvertimeTierRule],
    pub holiday_tiers: &'a [OvertimeTierRule],
    pub components: &'a [PayrollComponent],
    pub tax_rules: &'a [TaxRule],
    pub bpjs_rules: &'a [BpjsRule],
}

/// Konteks masa pajak satu karyawan (fase 13, §29.3): periode run, status,
/// PTKP awal tahun, tanggal keluar, dan ringkasan run pembanding.
pub struct KonteksPajak<'a> {
    pub period_start: &'a str,
    pub period_end: &'a str,
    pub jenis_personil: Option<&'a str>,
    /// PTKP yang berlaku 1 Januari (Q-180), dari `KOLOM_PAJAK_SQL`.
    pub ptkp_awal_tahun: &'a str,
    /// `tanggal_selesai_aktif` bila `id_keluar` terisi.
    pub keluar_pada: Option<&'a str>,
    pub pembanding: &'a Pembanding,
}

/// Agregat absensi dan konfigurasi gaji satu karyawan dalam satu periode.
pub struct PayInput<'a> {
    pub id_karyawan: &'a str,
    pub salary_type: &'a str,
    pub rate_per_hour: i64,
    pub daily_rate: i64,
    pub days_present: i64,
    pub regular_minutes: i64,
    pub overtime_minutes: i64,
    pub holiday_minutes: i64,
    pub pajak: KonteksPajak<'a>,
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
    /// Boleh negatif di masa terakhir (pengembalian, Q-189).
    pub pph21: Decimal,
    pub net: Decimal,
    pub components: Vec<serde_json::Value>,
    pub bpjs: Vec<RincianBpjs>,
    /// Kunci `breakdown_snapshot.tax` bentuk lama, untuk slip lama.
    pub tax: serde_json::Value,
    /// Kunci `breakdown_snapshot.pajak`.
    pub pajak: HasilPph,
    /// Kunci `breakdown_snapshot.bpjs_masa` (`dasar_run`, `dasar_masa`, `tanda`).
    pub bpjs_masa: serde_json::Value,
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
    ///
    /// Sejak fase 13 BPJS dan PPh 21 dihitung per masa pajak
    /// (`pajak::hitung_bpjs_masa`, `pajak::hitung_pph`): run lain di bulan
    /// yang sama dan, di masa terakhir, setahun ikut diperhitungkan.
    pub fn calculate_employee_pay(input: &PayInput, rules: &PayRules) -> EmployeePay {
        let flat = input.salary_type == SALARY_TYPE_FLAT_DAILY;
        let (overtime_index, holiday_index, basic, overtime, allowance, deduction, dasar_tunjangan, components) =
            if flat {
                // Upah harian tetap: durasi kerja dan lembur tidak ikut. Hanya
                // komponen milik karyawan ini sendiri yang berlaku; komponen
                // 'ALL' dirancang untuk skema per jam.
                let basic = Decimal::from(input.days_present.max(0))
                    * Decimal::from(input.daily_rate.max(0));
                let personal: Vec<PayrollComponent> = rules
                    .components
                    .iter()
                    .filter(|comp| comp.applies_to == input.id_karyawan)
                    .cloned()
                    .collect();
                let (allowance, deduction, dasar, components) =
                    Self::calculate_components(basic, &personal, input.id_karyawan);
                (Decimal::ZERO, Decimal::ZERO, basic, Decimal::ZERO, allowance, deduction, dasar, components)
            } else {
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
                let (allowance, deduction, dasar, components) =
                    Self::calculate_components(basic, rules.components, input.id_karyawan);
                (overtime_index, holiday_index, basic, overtime, allowance, deduction, dasar, components)
            };
        let gross = basic + overtime + allowance;
        let gross_i64 = gross.to_i64().unwrap_or(0);
        let konteks = &input.pajak;
        let pembanding = konteks.pembanding;

        // BPJS per masa atas gaji pokok + tunjangan tetap, tanpa lembur
        // (Q-181 (a)). `FLAT_DAILY` tetap tanpa BPJS (Q-182).
        let bpjs: HasilBpjs = if flat {
            pajak::hitung_bpjs_masa(0, 0, &[], &Default::default())
        } else {
            let dasar_run = (basic + dasar_tunjangan).to_i64().unwrap_or(0);
            pajak::hitung_bpjs_masa(dasar_run, pembanding.dasar_bpjs_masa, rules.bpjs_rules, &pembanding.bpjs_masa)
        };
        let kode = |daftar: &[&str]| {
            pajak::jumlah_kode(bpjs.rincian.iter().map(|r| (r.code.as_str(), r.nominal)), daftar)
        };
        let premi = kode(&pajak::KODE_PREMI);
        let iuran_pensiun_run = kode(&pajak::KODE_IURAN_PENSIUN);

        let status = pajak::status_pph(konteks.jenis_personil, input.salary_type);
        let terakhir = status == pajak::STATUS_TETAP
            && pajak::masa_terakhir(&pajak::masa(konteks.period_start), konteks.keluar_pada);
        // Q-184 (a): komponen FIXED tetap per run, ditandai bila bulan ini
        // sudah punya run lain.
        let komponen_tetap = components.iter().any(|c| {
            c["calc_type"] == "FIXED" && c["nominal"].as_i64().unwrap_or(0) > 0
        });
        let hasil_pph = pajak::hitung_pph(
            &MasukanPph {
                period_start: konteks.period_start.to_owned(),
                period_end: konteks.period_end.to_owned(),
                jenis_personil: konteks.jenis_personil.map(str::to_owned),
                salary_type: input.salary_type.to_owned(),
                ptkp_status: konteks.ptkp_awal_tahun.to_owned(),
                gross: gross_i64,
                premi,
                hari: input.days_present,
                keluar_pada: konteks.keluar_pada.map(str::to_owned),
                bruto_masa_sebelum: pembanding.bruto_masa,
                pph_masa_sebelum: pembanding.pph_masa,
                bruto_tahun_sebelum: pembanding.bruto_tahun,
                pph_tahun_sebelum: pembanding.pph_tahun,
                iuran_pensiun_sebelum: pembanding.iuran_pensiun_tahun,
                iuran_pensiun_run,
                masa_berbruto_lain: pembanding.masa_berbruto_lain,
                rumus_lama: pembanding.rumus_lama_masa || (terakhir && pembanding.rumus_lama_tahun),
                status_pajak_berubah: terakhir && pembanding.status_berubah,
                komponen_per_run: pembanding.run_masa > 0 && komponen_tetap,
            },
            rules.tax_rules,
        );

        let bpjs_employee = Decimal::from(bpjs.karyawan);
        let bpjs_company = Decimal::from(bpjs.perusahaan);
        let pph21 = Decimal::from(hasil_pph.pph);
        let tax = json!({
            "method": hasil_pph.metode,
            "category": hasil_pph.kategori,
            "ptkp_status": konteks.ptkp_awal_tahun,
            "rate_percentage": hasil_pph.tarif.map(|t| Decimal::new(t, 2).to_f64().unwrap_or(0.0)),
            "pph21_amount": hasil_pph.pph
        });
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
            // PPh negatif (pengembalian) menambah gaji bersih.
            net: (gross - deduction - bpjs_employee - pph21).max(Decimal::ZERO),
            components,
            bpjs_masa: json!({
                "dasar_run": bpjs.dasar_run,
                "dasar_masa": bpjs.dasar_masa,
                "tanda": bpjs.tanda,
            }),
            bpjs: bpjs.rincian,
            tax,
            pajak: hasil_pph,
        }
    }

    /// Tanpa jenjang HARI_LIBUR yang aktif, jam di hari libur dibayar seperti
    /// hari biasa: jam kerjanya reguler, sisanya lembur HARI_KERJA. Tanpa ini
    /// indeksnya nol dan jam itu tidak dibayar sama sekali, padahal maksudnya
    /// hanya "tidak ada tarif khusus hari libur". Mengembalikan menit
    /// `(reguler, lembur, libur)`. Cermin `applyHolidayFallback`.
    pub fn apply_holiday_fallback(
        regular_minutes: i64,
        overtime_minutes: i64,
        holiday_total_minutes: i64,
        holiday_regular_minutes: i64,
        holiday_tiers_active: bool,
    ) -> (i64, i64, i64) {
        if holiday_tiers_active {
            (regular_minutes, overtime_minutes, holiday_total_minutes)
        } else {
            (
                regular_minutes + holiday_regular_minutes,
                overtime_minutes + holiday_total_minutes - holiday_regular_minutes,
                0,
            )
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

    /// Menghitung tunjangan dan potongan dinamis. Nilai ketiga = jumlah
    /// tunjangan bertanda `dasar_bpjs` (tunjangan tetap, Q-181 (a)).
    pub fn calculate_components(
        basic_salary: Decimal,
        components: &[PayrollComponent],
        id_karyawan: &str,
    ) -> (Decimal, Decimal, Decimal, Vec<serde_json::Value>) {
        let mut total_allowance = Decimal::ZERO;
        let mut total_deduction = Decimal::ZERO;
        let mut dasar_bpjs = Decimal::ZERO;
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
                if comp.dasar_bpjs == 1 {
                    dasar_bpjs += nominal;
                }
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

        (total_allowance, total_deduction, dasar_bpjs, breakdown)
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

    use super::{KonteksPajak, PayInput, PayRules};
    use super::super::models::{BpjsRule, PayrollComponent};
    use super::super::pajak::Pembanding;

    fn konteks(pembanding: &Pembanding) -> KonteksPajak<'_> {
        KonteksPajak {
            period_start: "2026-01-01",
            period_end: "2026-01-31",
            jenis_personil: None,
            ptkp_awal_tahun: "TK/0",
            keluar_pada: None,
            pembanding,
        }
    }

    fn komponen(id: &str, category: &str, value: f64, applies_to: &str) -> PayrollComponent {
        PayrollComponent {
            id: id.to_string(),
            name: id.to_string(),
            category: category.to_string(),
            calc_type: "FIXED".to_string(),
            default_value: value,
            applies_to: applies_to.to_string(),
            is_active: 1,
            dasar_bpjs: 0,
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
            let pembanding = Pembanding::default();
            let pay = PayrollCalculator::calculate_employee_pay(
                &PayInput {
                    id_karyawan: "K001",
                    salary_type: "FLAT_DAILY",
                    rate_per_hour: 50_000,
                    daily_rate: *tarif,
                    days_present: *hari,
                    // 14 jam per hari: tetap tidak menambah satu rupiah pun.
                    regular_minutes: hari * 480,
                    overtime_minutes: hari * 360,
                    holiday_minutes: 600,
                    pajak: konteks(&pembanding),
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

    /// Sejak fase 13 dasar BPJS = gaji pokok + tunjangan bertanda tetap
    /// (Q-181 (a)), bukan bruto; tunjangan tanpa tanda tidak ikut.
    #[test]
    fn gaji_per_jam_tetap_memotong_bpjs_dan_memakai_komponen_umum() {
        for (dasar_bpjs, iuran) in [(0, 3_000), (1, 5_000)] {
        let mut umum = komponen("umum", "ALLOWANCE", 100_000.0, "ALL");
        umum.dasar_bpjs = dasar_bpjs;
        let components = vec![umum];
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
        let pembanding = Pembanding::default();
        let pay = PayrollCalculator::calculate_employee_pay(
            &PayInput {
                id_karyawan: "K001",
                salary_type: "HOURLY",
                rate_per_hour: 18_750,
                daily_rate: 150_000,
                days_present: 1,
                regular_minutes: 480,
                overtime_minutes: 0,
                holiday_minutes: 0,
                pajak: konteks(&pembanding),
            },
            &rules,
        );
        assert_eq!(pay.basic, Decimal::from(150_000));
        assert_eq!(pay.gross, Decimal::from(250_000));
        assert_eq!(pay.bpjs_employee, Decimal::from(iuran), "dasar_bpjs {dasar_bpjs}");
        // Tanpa lapis tarif: PPh 0, ditandai, tidak diam-diam.
        assert_eq!(pay.pajak.tanda, vec!["tarif_tidak_ada"]);
        assert_eq!(pay.net, Decimal::from(250_000 - iuran));
        }
    }

    #[test]
    fn tarif_desimal_tidak_membawa_galat_biner() {
        let rate = exact_decimal(0.3).unwrap();
        let nominal = (Decimal::from(2500) * (rate / Decimal::from(100)))
            .round_dp_with_strategy(0, RoundingStrategy::MidpointAwayFromZero);
        assert_eq!(nominal, Decimal::from(8));
        assert_eq!(exact_decimal(f64::NAN), None);
    }

    // Vektor kembar `applyHolidayFallback` di `payroll-calculator.test.ts`.
    #[test]
    fn jam_hari_libur_tanpa_jenjang_dibayar_seperti_hari_biasa() {
        assert_eq!(
            PayrollCalculator::apply_holiday_fallback(480, 60, 540, 480, true),
            (480, 60, 540)
        );
        assert_eq!(
            PayrollCalculator::apply_holiday_fallback(480, 60, 540, 480, false),
            (960, 120, 0)
        );
        assert_eq!(
            PayrollCalculator::apply_holiday_fallback(0, 0, 0, 0, false),
            (0, 0, 0)
        );
    }
}
