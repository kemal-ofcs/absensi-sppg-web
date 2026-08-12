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
    pub login_at: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OfflineCredential {
    pub version: u8,
    pub identity_key: String,
    pub server_origin: String,
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
