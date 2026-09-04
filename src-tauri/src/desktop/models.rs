use serde::{Deserialize, Serialize};
use serde_json::Value;
use zeroize::Zeroizing;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OperatorUser {
    pub id: i64,
    #[serde(rename = "kode_operator")]
    pub kode_operator: String,
    #[serde(rename = "nama_operator")]
    pub nama_operator: String,
    pub username: String,
    pub role: String,
    pub role_id: i64,
    pub role_key: String,
    pub is_superadmin: bool,
    pub permissions: Vec<String>,
    pub permission_revision: i64,
    /// Role ini mewajibkan foto bukti pada setiap scan absensi.
    ///
    /// `serde(default)` bukan hiasan: struct ini ikut tersimpan di vault
    /// kredensial offline. Snapshot yang dibuat versi lama tidak memiliki field
    /// ini, dan tanpa default seluruh vault akan gagal dibaca — pengguna
    /// lapangan terkunci di luar aplikasinya sendiri setelah update.
    #[serde(default)]
    pub require_scan_photo: bool,
    /// Role ini hanya boleh melakukan scan dari alamat IP yang terdaftar.
    #[serde(default)]
    pub require_scan_ip_allowlist: bool,
    pub login_at: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OfflineCredential {
    pub version: u8,
    pub identity_key: String,
    pub server_origin: String,
    #[serde(default)]
    pub device_id: Option<String>,
    pub operator: OperatorUser,
    pub provisioned_at: i64,
    pub offline_valid_until: i64,
}

#[derive(Debug)]
pub struct DesktopSession {
    pub operator: OperatorUser,
    pub token: Option<Zeroizing<String>>,
    pub mode: SessionMode,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SessionMode {
    Online,
    Offline,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopLoginResult {
    pub sukses: bool,
    pub pesan: String,
    pub operator: OperatorUser,
    pub mode: SessionMode,
    pub offline_ready: bool,
    pub offline_valid_until: Option<i64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopRuntimeStatus {
    pub configured: bool,
    pub server_origin: String,
    pub offline_max_age_hours: u64,
    pub has_active_session: bool,
    pub mode: Option<SessionMode>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopSyncStatus {
    pub client_id: String,
    pub pending: i64,
    pub synced: i64,
    pub failed: i64,
    pub conflict: i64,
    pub last_revision: i64,
    pub last_sync_at: Option<i64>,
    pub table_counts: Value,
    /// Pesan kegagalan push pada siklus terakhir, bila ada. Push yang gagal
    /// TIDAK lagi membatalkan pull — antrean outbox tetap aman dengan backoff,
    /// sementara data cloud terbaru tetap masuk. Field ini yang memberi tahu UI
    /// bahwa siklus "berhasil sebagian".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub push_error: Option<String>,
    /// Jumlah baris lokal yang benar-benar berubah pada siklus pull terakhir.
    /// Nol berarti data lokal sudah identik dengan cloud, sehingga UI tidak
    /// perlu memuat ulang apa pun.
    pub changed_rows: i64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandError {
    pub code: &'static str,
    pub message: String,
}

impl CommandError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    pub fn internal() -> Self {
        Self::new(
            "DESKTOP_INTERNAL_ERROR",
            "Data lokal Desktop tidak dapat diproses.",
        )
    }
}

#[derive(Debug, Deserialize)]
pub struct LoginApiResponse {
    pub sukses: bool,
    pub pesan: Option<String>,
    pub operator: Option<OperatorUser>,
}

pub struct RemoteLogin {
    pub operator: OperatorUser,
    pub token: Zeroizing<String>,
    pub message: String,
}
