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
}
