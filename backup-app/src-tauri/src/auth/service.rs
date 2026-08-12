use crate::desktop_config::{
    normalize_sync_url_for_client, read_sync_config, resolve_or_create_device_id, save_sync_config,
    StoredSyncConfig,
};
use argon2::{
    password_hash::{rand_core::OsRng, PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
    Argon2, Params,
};
use rusqlite::{params_from_iter, Connection, OpenFlags, OptionalExtension};
use std::path::PathBuf;
use tauri::{Manager, Runtime};

const ARGON2_M_COST: u32 = 65_536;
const ARGON2_T_COST: u32 = 3;
const ARGON2_P_COST: u32 = 4;

#[derive(Clone, serde::Deserialize, serde::Serialize)]
pub struct BiometricAuthRequest {
    pub user_id: String,
    pub reason: String,
}

#[derive(Clone, serde::Deserialize, serde::Serialize)]
pub struct BiometricAuthResponse {
    pub success: bool,
    pub error: Option<String>,
}

#[derive(Clone, serde::Deserialize, serde::Serialize)]
pub struct SetPasswordRequest {
    pub user_id: String,
    pub password: String,
    pub is_first_time: bool,
}

#[derive(Clone, serde::Deserialize, serde::Serialize)]
pub struct SetPasswordResponse {
    pub success: bool,
    pub hash: Option<String>,
    pub error: Option<String>,
}

#[derive(Clone, serde::Deserialize, serde::Serialize)]
pub struct VerifyPasswordRequest {
    pub password: String,
    pub stored_hash: String,
}

#[derive(Clone, serde::Deserialize, serde::Serialize)]
pub struct VerifyPasswordResponse {
    pub success: bool,
    pub error: Option<String>,
}

#[derive(Clone, serde::Deserialize, serde::Serialize)]
pub struct VerifyLocalDesktopLoginRequest {
    pub identifier: String,
    pub password: String,
}

#[derive(Clone, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeDesktopAuthUserRow {
    pub id: Option<String>,
    pub full_name: Option<String>,
    pub email: Option<String>,
    pub username: Option<String>,
    pub role: Option<String>,
    pub version: Option<i64>,
    #[serde(skip_serializing, skip_deserializing)]
    pub password_hash: Option<String>,
    pub is_active: Option<i64>,
    pub last_login_at: Option<i64>,
    pub provider: Option<String>,
    pub provider_id: Option<String>,
    pub created_at: Option<i64>,
    pub updated_at: Option<i64>,
    pub deleted_at: Option<i64>,
    pub hlc: Option<String>,
    pub sync_status: Option<String>,
}

#[derive(Clone, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifyLocalDesktopLoginResponse {
    pub success: bool,
    pub user: Option<NativeDesktopAuthUserRow>,
    pub error: Option<String>,
    pub db_path: Option<String>,
}

#[derive(Clone, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncConfigResponse {
    pub configured: bool,
    pub url: String,
    pub token_hint: Option<String>,
}

#[derive(Clone, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetSyncConfigRequest {
    pub url: String,
    pub auth_token: String,
    pub user_id: String,
    pub current_password: String,
}

fn desktop_auth_db_path<R: Runtime>(app_handle: &tauri::AppHandle<R>) -> Result<PathBuf, String> {
    let base_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|error| format!("Unable to resolve app data directory: {error}"))?;
    Ok(base_dir.join("hybrid-starter.db"))
}

fn authorize_sync_config_change<R: Runtime>(
    app_handle: &tauri::AppHandle<R>,
    user_id: &str,
    current_password: &str,
) -> Result<(), String> {
    let db_path = desktop_auth_db_path(app_handle)?;
    let connection = Connection::open_with_flags(
        &db_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|error| format!("Unable to open local auth database: {error}"))?;
    let row = connection
        .query_row(
            r#"SELECT role, password_hash
               FROM users
               WHERE id = ?1 AND is_active = 1 AND deleted_at IS NULL
               LIMIT 1"#,
            [user_id.trim()],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)),
        )
        .optional()
        .map_err(|error| format!("Unable to validate sync administrator: {error}"))?;

    let Some((role, password_hash)) = row else {
        return Err("Akun administrator lokal tidak ditemukan".to_string());
    };
    if role != "super_admin" && role != "admin" {
        return Err("Hanya admin yang dapat mengubah konfigurasi sync".to_string());
    }
    let Some(password_hash) = password_hash else {
        return Err("Password administrator lokal belum tersedia".to_string());
    };
    if !verify_local_password(current_password, &password_hash) {
        return Err("Password administrator lokal tidak valid".to_string());
    }
    Ok(())
}

fn normalize_identifier(value: &str) -> String {
    value.trim().to_lowercase()
}

fn email_candidates(identifier: &str) -> Vec<String> {
    let normalized = normalize_identifier(identifier);
    if normalized.is_empty() {
        return Vec::new();
    }
    if normalized.contains('@') {
        return vec![normalized];
    }
    vec![normalized.clone(), format!("{normalized}@starter.local")]
}

fn verify_local_password(password: &str, stored_hash: &str) -> bool {
    let normalized_hash = stored_hash.trim();
    if normalized_hash.starts_with("$argon2") {
        return PasswordHash::new(normalized_hash)
            .ok()
            .is_some_and(|parsed| {
                Argon2::default()
                    .verify_password(password.as_bytes(), &parsed)
                    .is_ok()
            });
    }
    !normalized_hash.is_empty() && normalized_hash == password
}

fn load_user<R: Runtime>(
    app_handle: &tauri::AppHandle<R>,
    identifier: &str,
) -> Result<(Option<NativeDesktopAuthUserRow>, PathBuf), String> {
    let db_path = desktop_auth_db_path(app_handle)?;
    let candidates = email_candidates(identifier);
    if candidates.is_empty() {
        return Ok((None, db_path));
    }

    let connection = Connection::open_with_flags(
        &db_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|error| format!("Unable to open desktop auth database: {error}"))?;
    let placeholders = candidates
        .iter()
        .map(|_| "?")
        .collect::<Vec<_>>()
        .join(", ");
    let query = format!(
        "SELECT id, full_name, email, username, role, version, password_hash,
                is_active, last_login_at, provider, provider_id, created_at,
                updated_at, deleted_at, hlc, sync_status
         FROM users
         WHERE is_active = 1 AND deleted_at IS NULL
           AND (lower(email) IN ({placeholders}) OR lower(COALESCE(username, '')) = ?)
         LIMIT 1"
    );
    let mut args = candidates;
    args.push(normalize_identifier(identifier));
    let user = connection
        .query_row(&query, params_from_iter(args.iter()), |row| {
            Ok(NativeDesktopAuthUserRow {
                id: row.get(0)?,
                full_name: row.get(1)?,
                email: row.get(2)?,
                username: row.get(3)?,
                role: row.get(4)?,
                version: row.get(5)?,
                password_hash: row.get(6)?,
                is_active: row.get(7)?,
                last_login_at: row.get(8)?,
                provider: row.get(9)?,
                provider_id: row.get(10)?,
                created_at: row.get(11)?,
                updated_at: row.get(12)?,
                deleted_at: row.get(13)?,
                hlc: row.get(14)?,
                sync_status: row.get(15)?,
            })
        })
        .optional()
        .map_err(|error| format!("Unable to query desktop auth user: {error}"))?;
    Ok((user, db_path))
}

fn record_login<R: Runtime>(app_handle: &tauri::AppHandle<R>, user_id: &str) -> Result<(), String> {
    let db_path = desktop_auth_db_path(app_handle)?;
    let now = chrono::Utc::now().timestamp();
    let connection = Connection::open_with_flags(
        &db_path,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|error| format!("Unable to update desktop auth database: {error}"))?;
    connection
        .execute(
            "UPDATE users SET last_login_at = ?1, updated_at = ?1, sync_status = 'pending' WHERE id = ?2",
            (now, user_id),
        )
        .map_err(|error| format!("Unable to persist desktop login: {error}"))?;
    Ok(())
}

#[tauri::command]
pub async fn authenticate_with_biometric<R: Runtime>(
    _app_handle: tauri::AppHandle<R>,
    _request: BiometricAuthRequest,
) -> Result<BiometricAuthResponse, String> {
    Ok(BiometricAuthResponse {
        success: false,
        error: Some("Biometric adapter is not configured".to_string()),
    })
}

#[tauri::command]
pub async fn set_password(request: SetPasswordRequest) -> Result<SetPasswordResponse, String> {
    if request.password.len() < 8 {
        return Err("Password must contain at least 8 characters".to_string());
    }
    let params = Params::new(ARGON2_M_COST, ARGON2_T_COST, ARGON2_P_COST, None)
        .map_err(|error| format!("Invalid Argon2 configuration: {error}"))?;
    let argon2 = Argon2::new(argon2::Algorithm::Argon2id, argon2::Version::V0x13, params);
    let salt = SaltString::generate(&mut OsRng);
    let hash = argon2
        .hash_password(request.password.as_bytes(), &salt)
        .map_err(|error| format!("Unable to hash password: {error}"))?;
    Ok(SetPasswordResponse {
        success: true,
        hash: Some(hash.to_string()),
        error: None,
    })
}

#[tauri::command]
pub async fn verify_password(
    request: VerifyPasswordRequest,
) -> Result<VerifyPasswordResponse, String> {
    Ok(VerifyPasswordResponse {
        success: verify_local_password(&request.password, &request.stored_hash),
        error: None,
    })
}

#[tauri::command]
pub async fn verify_local_desktop_login<R: Runtime>(
    app_handle: tauri::AppHandle<R>,
    request: VerifyLocalDesktopLoginRequest,
) -> Result<VerifyLocalDesktopLoginResponse, String> {
    let identifier = normalize_identifier(&request.identifier);
    if identifier.is_empty() || request.password.is_empty() {
        return Ok(VerifyLocalDesktopLoginResponse {
            success: false,
            user: None,
            error: Some("INVALID_CREDENTIALS".to_string()),
            db_path: None,
        });
    }
    let (user, db_path) = load_user(&app_handle, &identifier)?;
    let Some(user) = user else {
        return Ok(VerifyLocalDesktopLoginResponse {
            success: false,
            user: None,
            error: Some("USER_NOT_FOUND".to_string()),
            db_path: Some(db_path.display().to_string()),
        });
    };
    let Some(hash) = user.password_hash.clone() else {
        return Ok(VerifyLocalDesktopLoginResponse {
            success: false,
            user: None,
            error: Some("PASSWORD_HASH_MISSING".to_string()),
            db_path: Some(db_path.display().to_string()),
        });
    };
    if !verify_local_password(&request.password, &hash) {
        return Ok(VerifyLocalDesktopLoginResponse {
            success: false,
            user: None,
            error: Some("INVALID_CREDENTIALS".to_string()),
            db_path: Some(db_path.display().to_string()),
        });
    }
    if let Some(user_id) = user.id.as_deref() {
        if let Err(error) = record_login(&app_handle, user_id) {
            log::warn!("[AUTH] Unable to persist login metadata: {error}");
        }
    }
    Ok(VerifyLocalDesktopLoginResponse {
        success: true,
        user: Some(user),
        error: None,
        db_path: Some(db_path.display().to_string()),
    })
}

#[tauri::command]
pub async fn get_sync_config<R: Runtime>(
    app_handle: tauri::AppHandle<R>,
) -> Result<SyncConfigResponse, String> {
    let Some(config) = read_sync_config(&app_handle) else {
        return Ok(SyncConfigResponse {
            configured: false,
            url: String::new(),
            token_hint: None,
        });
    };
    let suffix: String = config
        .auth_token
        .chars()
        .rev()
        .take(4)
        .collect::<String>()
        .chars()
        .rev()
        .collect();
    Ok(SyncConfigResponse {
        configured: true,
        url: normalize_sync_url_for_client(config.url),
        token_hint: Some(format!("••••{suffix}")),
    })
}

#[tauri::command]
pub async fn get_sync_device_id() -> Result<String, String> {
    resolve_or_create_device_id()
}

#[tauri::command]
pub async fn set_sync_config<R: Runtime>(
    app_handle: tauri::AppHandle<R>,
    request: SetSyncConfigRequest,
) -> Result<(), String> {
    authorize_sync_config_change(&app_handle, &request.user_id, &request.current_password)?;
    let url = request.url.trim();
    let auth_token = request.auth_token.trim();
    if !url.starts_with("libsql://") && !url.starts_with("https://") {
        return Err("Sync URL harus memakai libsql:// atau https://".to_string());
    }
    if auth_token.len() < 32 || auth_token.len() > 4096 {
        return Err("Turso database token tidak valid".to_string());
    }
    save_sync_config(
        &app_handle,
        &StoredSyncConfig {
            url: url.to_string(),
            auth_token: auth_token.to_string(),
        },
    )
}
