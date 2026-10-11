use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum PayrollStatus {
    Draft,
    Submitted,
    Reviewed,
    Approved,
    Paid,
    Rejected,
}

impl PayrollStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            PayrollStatus::Draft => "DRAFT",
            PayrollStatus::Submitted => "SUBMITTED",
            PayrollStatus::Reviewed => "REVIEWED",
            PayrollStatus::Approved => "APPROVED",
            PayrollStatus::Paid => "PAID",
            PayrollStatus::Rejected => "REJECTED",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        match s.trim().to_uppercase().as_str() {
            "DRAFT" => Some(PayrollStatus::Draft),
            "SUBMITTED" => Some(PayrollStatus::Submitted),
            "REVIEWED" => Some(PayrollStatus::Reviewed),
            "APPROVED" => Some(PayrollStatus::Approved),
            "PAID" => Some(PayrollStatus::Paid),
            "REJECTED" => Some(PayrollStatus::Rejected),
            _ => None,
        }
    }

    pub fn can_transition_to(&self, next: &PayrollStatus) -> bool {
        match (self, next) {
            (PayrollStatus::Draft, PayrollStatus::Submitted) => true,
            (PayrollStatus::Submitted, PayrollStatus::Reviewed) => true,
            (PayrollStatus::Submitted, PayrollStatus::Rejected) => true,
            (PayrollStatus::Reviewed, PayrollStatus::Approved) => true,
            (PayrollStatus::Reviewed, PayrollStatus::Rejected) => true,
            (PayrollStatus::Approved, PayrollStatus::Paid) => true,
            (PayrollStatus::Rejected, PayrollStatus::Draft) => true,
            _ => false,
        }
    }
}

fn default_applies_to() -> String {
    "ALL".to_string()
}

fn default_active() -> i64 {
    1
}

pub const SALARY_TYPE_HOURLY: &str = "HOURLY";
pub const SALARY_TYPE_FLAT_DAILY: &str = "FLAT_DAILY";
/// Rentang tarif harian yang diterima. Batas atasnya menangkap salah ketik
/// satu nol; cerminannya ada di route `config/salary` (Web).
pub const DAILY_RATE_MIN: i64 = 1_000;
pub const DAILY_RATE_MAX: i64 = 10_000_000;
pub const PTKP_STATUSES: [&str; 8] = ["TK/0", "TK/1", "TK/2", "TK/3", "K/0", "K/1", "K/2", "K/3"];

fn default_salary_type() -> String {
    SALARY_TYPE_HOURLY.to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OvertimeTierRule {
    #[serde(default)]
    pub id: String,
    pub rule_type: String, // "HARI_KERJA" | "HARI_LIBUR"
    pub tier_order: i64,
    pub hour_start: f64,
    #[serde(default)]
    pub hour_end: Option<f64>,
    pub multiplier: f64,
    #[serde(default = "default_active")]
    pub is_active: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PayrollComponent {
    #[serde(default)]
    pub id: String,
    pub name: String,
    pub category: String,  // "ALLOWANCE" | "DEDUCTION"
    pub calc_type: String, // "FIXED" | "PERCENTAGE"
    pub default_value: f64,
    #[serde(default = "default_applies_to")]
    pub applies_to: String, // "ALL" | id_karyawan
    #[serde(default = "default_active")]
    pub is_active: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaxRule {
    #[serde(default)]
    pub id: String,
    pub category: String, // "TER_A" | "TER_B" | "TER_C" | "PASAL_17"
    pub bracket_min: i64,
    #[serde(default)]
    pub bracket_max: Option<i64>,
    pub rate_percentage: f64,
    #[serde(default)]
    pub effective_date: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BpjsRule {
    #[serde(default)]
    pub id: String,
    pub component_code: String,
    pub component_name: String,
    pub rate_percentage: f64,
    #[serde(default)]
    pub wage_cap: Option<i64>,
    #[serde(default)]
    pub effective_date: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SalaryConfig {
    #[serde(default)]
    pub id: String,
    pub id_karyawan: String,
    pub rate_per_hour: i64,
    #[serde(default)]
    pub ptkp_status: String,
    #[serde(default)]
    pub effective_date: String,
    #[serde(default)]
    pub created_by: String,
    #[serde(default)]
    pub created_at: String,
    /// `HOURLY` (per jam + lembur) atau `FLAT_DAILY` (tarif harian tetap).
    #[serde(default = "default_salary_type")]
    pub salary_type: String,
    /// Hanya bermakna untuk `FLAT_DAILY`; selain itu selalu 0.
    #[serde(default)]
    pub daily_rate: i64,
}

impl SalaryConfig {
    /// Validasi dan normalisasi SEBELUM menyentuh SQLite dan outbox.
    ///
    /// Nilai yang lolos di SQLite lokal (tipenya longgar) tetapi ditolak
    /// CHECK constraint cloud membuat event outbox gagal permanen. Aturan yang
    /// sama ditegakkan route `config/salary` di Web.
    pub fn normalized(&self) -> Result<SalaryConfig, String> {
        let id_karyawan = self.id_karyawan.trim();
        if id_karyawan.is_empty() {
            return Err("Karyawan wajib dipilih.".into());
        }
        let effective_date = self.effective_date.trim();
        if !super::super::time_policy::is_calendar_date(effective_date) {
            return Err("Tanggal berlaku harus berformat YYYY-MM-DD.".into());
        }
        let ptkp_status = if self.ptkp_status.trim().is_empty() {
            "TK/0".to_string()
        } else {
            self.ptkp_status.trim().to_uppercase()
        };
        if !PTKP_STATUSES.contains(&ptkp_status.as_str()) {
            return Err("Status PTKP tidak dikenal.".into());
        }
        let (rate_per_hour, daily_rate) = match self.salary_type.as_str() {
            SALARY_TYPE_HOURLY => {
                if self.rate_per_hour < 0 {
                    return Err("Tarif per jam tidak boleh negatif.".into());
                }
                (self.rate_per_hour, 0)
            }
            SALARY_TYPE_FLAT_DAILY => {
                if !(DAILY_RATE_MIN..=DAILY_RATE_MAX).contains(&self.daily_rate) {
                    return Err(format!(
                        "Tarif harian harus antara Rp {DAILY_RATE_MIN} dan Rp {DAILY_RATE_MAX}."
                    ));
                }
                (0, self.daily_rate)
            }
            _ => return Err("Tipe gaji harus HOURLY atau FLAT_DAILY.".into()),
        };
        Ok(SalaryConfig {
            id: self.id.trim().to_string(),
            id_karyawan: id_karyawan.to_string(),
            rate_per_hour,
            ptkp_status,
            effective_date: effective_date.to_string(),
            created_by: self.created_by.clone(),
            created_at: self.created_at.clone(),
            salary_type: self.salary_type.clone(),
            daily_rate,
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PayrollRun {
    pub id: String,
    pub idempotency_key: String,
    pub period_start: String,
    pub period_end: String,
    pub status: String,
    pub total_gross_payout: i64,
    pub total_net_payout: i64,
    pub total_employees: i64,
    pub created_by: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PayrollItem {
    pub id: String,
    pub payroll_run_id: String,
    pub id_karyawan: String,
    pub nama_karyawan: String,
    pub divisi: String,
    pub ptkp_status: String,
    pub total_regular_hours: f64,
    pub total_overtime_hours: f64,
    pub total_overtime_index: f64,
    /// Seluruh jam kerja yang jatuh pada tanggal hari libur aktif.
    ///
    /// Menurut PP 35/2021 tidak ada "jam kerja biasa" pada hari libur resmi:
    /// SETIAP jam yang dikerjakan hari itu dihitung sebagai lembur. Karena itu
    /// nilainya adalah jam_kerja + lembur pada tanggal tersebut, dan ia sengaja
    /// TIDAK ikut `total_regular_hours`/`total_overtime_hours`.
    pub total_holiday_hours: f64,
    /// Indeks hasil `total_holiday_hours` melewati jenjang HARI_LIBUR.
    pub total_holiday_overtime_index: f64,
    pub rate_per_hour: i64,
    pub basic_salary: i64,
    pub overtime_salary: i64,
    pub gross_salary: i64,
    pub total_allowances: i64,
    pub total_deductions: i64,
    pub bpjs_employee_total: i64,
    pub bpjs_company_total: i64,
    pub pph21_amount: i64,
    pub net_salary: i64,
    pub breakdown_snapshot: String,
    pub created_at: String,
    pub salary_type: String,
    pub daily_rate: i64,
    pub days_present: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PayrollAuditLog {
    pub id: String,
    pub payroll_run_id: String,
    pub action: String,
    pub old_status: Option<String>,
    pub new_status: String,
    pub performed_by: String,
    pub notes: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PayrollRecapRow {
    pub id_karyawan: String,
    pub nama_karyawan: String,
    pub divisi: String,
    pub rate_per_hour: i64,
    pub ptkp_status: String,
    pub total_hadir: i64,
    pub total_terlambat_menit: i64,
    /// Menit MENTAH dari `absensi_harian`, sebelum dibagi 60.
    ///
    /// Inilah sumber kebenaran jamnya, dan pembekuan payroll WAJIB berangkat
    /// dari sini — bukan dari `total_regular_hours` di bawah. Angka jam itu
    /// `f64` hasil pembagian, dan membacanya kembali menjadi `Decimal` tidak
    /// mengembalikan presisi yang sudah hilang: pratinjau menghitung
    /// `menit/60` secara eksak, sementara pembekuan yang berangkat dari `f64`
    /// menghasilkan angka yang berbeda satu rupiah pada setiap nilai yang
    /// jatuh tepat di titik tengah pembulatan (11 menit pada tarif 18.750/jam
    /// = 3.437,5 tepat). Admin lalu menyetujui satu angka dan membayarkan
    /// angka lain.
    pub total_regular_minutes: i64,
    pub total_overtime_minutes: i64,
    pub total_holiday_minutes: i64,
    pub total_regular_hours: f64,
    pub total_overtime_hours: f64,
    pub total_overtime_index: f64,
    /// Jam kerja pada tanggal hari libur (jam_kerja + lembur hari itu).
    pub total_holiday_hours: f64,
    /// Indeks jenjang HARI_LIBUR untuk jam di atas.
    pub total_holiday_overtime_index: f64,
    pub est_basic_salary: i64,
    pub est_overtime_salary: i64,
    pub est_gross_salary: i64,
    pub est_total_allowance: i64,
    pub est_total_deduction: i64,
    pub est_bpjs_employee: i64,
    pub est_pph21: i64,
    pub est_net_salary: i64,
    pub salary_type: String,
    pub daily_rate: i64,
    /// Tanggal unik berstatus Hadir. Berbeda dengan `total_hadir` (jumlah
    /// baris): sesi PENGGANTI di tanggal yang sama tidak menambah hari.
    pub days_present: i64,
}

#[cfg(test)]
mod tests {
    use super::SalaryConfig;

    fn draft(salary_type: &str, rate_per_hour: i64, daily_rate: i64) -> SalaryConfig {
        SalaryConfig {
            id: String::new(),
            id_karyawan: "K001".into(),
            rate_per_hour,
            ptkp_status: "tk/0".into(),
            effective_date: "2026-10-01".into(),
            created_by: String::new(),
            created_at: String::new(),
            salary_type: salary_type.into(),
            daily_rate,
        }
    }

    #[test]
    fn konfigurasi_gaji_dinormalisasi_sesuai_check_cloud() {
        let flat = draft("FLAT_DAILY", 25_000, 150_000).normalized().unwrap();
        assert_eq!((flat.rate_per_hour, flat.daily_rate), (0, 150_000));
        assert_eq!(flat.ptkp_status, "TK/0");
        let hourly = draft("HOURLY", 25_000, 150_000).normalized().unwrap();
        assert_eq!((hourly.rate_per_hour, hourly.daily_rate), (25_000, 0));

        assert!(draft("FLAT", 0, 150_000).normalized().is_err());
        assert!(draft("FLAT_DAILY", 0, 999).normalized().is_err());
        assert!(draft("FLAT_DAILY", 0, 10_000_001).normalized().is_err());
        assert!(draft("HOURLY", -1, 0).normalized().is_err());
        let mut bad_date = draft("HOURLY", 1, 0);
        bad_date.effective_date = "2026-2-30".into();
        assert!(bad_date.normalized().is_err());
        let mut bad_ptkp = draft("HOURLY", 1, 0);
        bad_ptkp.ptkp_status = "K/9".into();
        assert!(bad_ptkp.normalized().is_err());
    }
}
