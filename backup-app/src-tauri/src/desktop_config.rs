use rand::{distributions::Alphanumeric, Rng};
use std::{fs, path::PathBuf};
use tauri::{Manager, Runtime};

const SYNC_KEYRING_SERVICE: &str = "hybrid-starter.sync";
const RUNTIME_KEYRING_SERVICE: &str = "hybrid-starter.runtime";
const SYNC_URL_KEY: &str = "sync_url";
const SYNC_AUTH_TOKEN_KEY: &str = "sync_auth_token";
const AUTH_SECRET_KEY: &str = "desktop_auth_secret";
const DEVICE_ID_KEY: &str = "desktop_device_id";

#[derive(Clone, serde::Deserialize, serde::Serialize)]
pub struct StoredSyncConfig {
    pub url: String,
    pub auth_token: String,
}

#[derive(Clone, serde::Deserialize, serde::Serialize)]
struct SyncConfigFilePayload {
    url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    auth_token: Option<String>,
}

#[derive(Clone, serde::Deserialize)]
struct LegacyRuntimeSecretFilePayload {
    auth_secret: String,
}

pub struct ProvisionedRuntimeEnv {
    pub auth_database_url: String,
    pub auth_database_auth_token: String,
    pub sync_database_url: String,
    pub sync_database_auth_token: String,
    pub auth_secret: String,
    pub device_id: String,
}

fn app_config_dir<R: Runtime>(app_handle: &tauri::AppHandle<R>) -> Result<PathBuf, String> {
    let base_dir = app_handle
        .path()
        .app_config_dir()
        .map_err(|error| format!("Gagal menentukan app_config_dir: {error}"))?;

    if !base_dir.exists() {
        fs::create_dir_all(&base_dir)
            .map_err(|error| format!("Gagal membuat folder konfigurasi app: {error}"))?;
    }

    Ok(base_dir)
}

fn sync_config_file_path<R: Runtime>(app_handle: &tauri::AppHandle<R>) -> Result<PathBuf, String> {
    Ok(app_config_dir(app_handle)?.join("sync-config.json"))
}

fn legacy_runtime_secret_file_path<R: Runtime>(
    app_handle: &tauri::AppHandle<R>,
) -> Result<PathBuf, String> {
    Ok(app_config_dir(app_handle)?.join("runtime-secrets.json"))
}

fn read_legacy_runtime_secret<R: Runtime>(app_handle: &tauri::AppHandle<R>) -> Option<String> {
    let file_path = legacy_runtime_secret_file_path(app_handle).ok()?;
    let raw = fs::read_to_string(&file_path).ok()?;
    let parsed = serde_json::from_str::<LegacyRuntimeSecretFilePayload>(&raw).ok()?;
    let secret = parsed.auth_secret.trim().to_string();
    if secret.is_empty() {
        return None;
    }
    Some(secret)
}

fn read_sync_config_file<R: Runtime>(
    app_handle: &tauri::AppHandle<R>,
) -> Option<SyncConfigFilePayload> {
    let file_path = sync_config_file_path(app_handle).ok()?;
    let raw = fs::read_to_string(file_path).ok()?;
    let parsed = serde_json::from_str::<SyncConfigFilePayload>(&raw).ok()?;

    if parsed.url.trim().is_empty() {
        return None;
    }
    Some(parsed)
}

fn write_sync_config_file<R: Runtime>(
    app_handle: &tauri::AppHandle<R>,
    url: &str,
) -> Result<(), String> {
    let file_path = sync_config_file_path(app_handle)?;
    let encoded = serde_json::to_string_pretty(&SyncConfigFilePayload {
        url: url.trim().to_string(),
        auth_token: None,
    })
    .map_err(|error| format!("Gagal serialisasi sync config: {error}"))?;

    fs::write(file_path, encoded)
        .map_err(|error| format!("Gagal menulis sync config file fallback: {error}"))?;

    Ok(())
}

fn generate_auth_secret() -> String {
    rand::thread_rng()
        .sample_iter(&Alphanumeric)
        .take(64)
        .map(char::from)
        .collect()
}

pub fn normalize_sync_url_for_client(raw_url: String) -> String {
    if raw_url.starts_with("libsql://") {
        raw_url.replacen("libsql://", "https://", 1)
    } else {
        raw_url
    }
}

pub fn read_sync_config<R: Runtime>(app_handle: &tauri::AppHandle<R>) -> Option<StoredSyncConfig> {
    let keyring_url = keyring::Entry::new(SYNC_KEYRING_SERVICE, SYNC_URL_KEY).ok();
    let keyring_token = keyring::Entry::new(SYNC_KEYRING_SERVICE, SYNC_AUTH_TOKEN_KEY).ok();

    let keyring_url_value = keyring_url
        .as_ref()
        .and_then(|entry| entry.get_password().ok());
    let keyring_token_value = keyring_token
        .as_ref()
        .and_then(|entry| entry.get_password().ok());

    if let (Some(url), Some(auth_token)) =
        (keyring_url_value.as_ref(), keyring_token_value.as_ref())
    {
        if !url.trim().is_empty() && !auth_token.trim().is_empty() {
            let legacy_plaintext_exists = read_sync_config_file(app_handle)
                .and_then(|payload| payload.auth_token)
                .is_some_and(|token| !token.trim().is_empty());
            if legacy_plaintext_exists
                && write_sync_config_file(app_handle, url).is_err()
                && !sync_config_file_path(app_handle)
                    .ok()
                    .is_some_and(|path| fs::remove_file(path).is_ok())
            {
                log::error!("[DesktopConfig] Legacy plaintext sync token tidak dapat dibersihkan.");
                return None;
            }
            return Some(StoredSyncConfig {
                url: url.clone(),
                auth_token: auth_token.clone(),
            });
        }
    }

    if let Some(file_payload) = read_sync_config_file(app_handle) {
        if let Some(legacy_token) = file_payload
            .auth_token
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            let migrated = keyring_url
                .as_ref()
                .is_some_and(|entry| entry.set_password(file_payload.url.trim()).is_ok())
                && keyring_token
                    .as_ref()
                    .is_some_and(|entry| entry.set_password(legacy_token).is_ok());
            if migrated {
                if let Err(error) = write_sync_config_file(app_handle, &file_payload.url) {
                    let removed = sync_config_file_path(app_handle)
                        .ok()
                        .is_some_and(|path| fs::remove_file(path).is_ok());
                    if !removed {
                        log::error!(
                            "[DesktopConfig] Legacy plaintext token tidak dapat dibersihkan: {error}"
                        );
                        return None;
                    }
                }
                return Some(StoredSyncConfig {
                    url: file_payload.url,
                    auth_token: legacy_token.to_string(),
                });
            }
            log::error!(
                "[DesktopConfig] Legacy plaintext sync token tidak digunakan karena migrasi keyring gagal."
            );
        } else if let Some(auth_token) = keyring_token_value.as_ref() {
            if !auth_token.trim().is_empty() {
                return Some(StoredSyncConfig {
                    url: file_payload.url,
                    auth_token: auth_token.clone(),
                });
            }
        }
    }

    let env_url = std::env::var("SYNC_DATABASE_URL")
        .or_else(|_| std::env::var("TURSO_DATABASE_URL"))
        .ok()?;
    let env_auth_token = std::env::var("SYNC_DATABASE_AUTH_TOKEN")
        .or_else(|_| std::env::var("TURSO_AUTH_TOKEN"))
        .ok()?;

    if env_url.trim().is_empty() || env_auth_token.trim().is_empty() {
        return None;
    }

    Some(StoredSyncConfig {
        url: env_url,
        auth_token: env_auth_token,
    })
}

pub fn save_sync_config<R: Runtime>(
    app_handle: &tauri::AppHandle<R>,
    payload: &StoredSyncConfig,
) -> Result<(), String> {
    let keyring_url = keyring::Entry::new(SYNC_KEYRING_SERVICE, SYNC_URL_KEY)
        .map_err(|error| format!("Gagal inisialisasi keyring sync_url: {error}"))?;
    let keyring_token = keyring::Entry::new(SYNC_KEYRING_SERVICE, SYNC_AUTH_TOKEN_KEY)
        .map_err(|error| format!("Gagal inisialisasi keyring sync_auth_token: {error}"))?;

    keyring_url
        .set_password(payload.url.trim())
        .map_err(|error| format!("Gagal menyimpan sync URL ke OS keyring: {error}"))?;
    keyring_token
        .set_password(payload.auth_token.trim())
        .map_err(|error| format!("Gagal menyimpan Turso token ke OS keyring: {error}"))?;

    write_sync_config_file(app_handle, payload.url.trim())
        .map_err(|error| format!("Gagal menyimpan metadata sync URL: {error}"))?;

    Ok(())
}

fn resolve_or_create_auth_secret<R: Runtime>(
    app_handle: &tauri::AppHandle<R>,
) -> Result<String, String> {
    let keyring_entry = keyring::Entry::new(RUNTIME_KEYRING_SERVICE, AUTH_SECRET_KEY)
        .map_err(|error| format!("Gagal inisialisasi keyring auth secret: {error}"))?;

    if let Ok(secret) = keyring_entry.get_password() {
        if !secret.trim().is_empty() {
            if let Ok(legacy_path) = legacy_runtime_secret_file_path(app_handle) {
                if legacy_path.is_file() {
                    fs::remove_file(legacy_path).map_err(|error| {
                        format!("Gagal menghapus legacy runtime secret file: {error}")
                    })?;
                }
            }
            return Ok(secret);
        }
    }

    if let Some(legacy_secret) = read_legacy_runtime_secret(app_handle) {
        keyring_entry
            .set_password(&legacy_secret)
            .map_err(|error| format!("Gagal migrasi auth secret ke OS keyring: {error}"))?;
        if let Ok(legacy_path) = legacy_runtime_secret_file_path(app_handle) {
            fs::remove_file(legacy_path)
                .map_err(|error| format!("Gagal menghapus legacy runtime secret file: {error}"))?;
        }
        return Ok(legacy_secret);
    }

    if let Ok(env_secret) =
        std::env::var("AUTH_SECRET").or_else(|_| std::env::var("NEXTAUTH_SECRET"))
    {
        if !env_secret.trim().is_empty() {
            let trimmed = env_secret.trim().to_string();
            keyring_entry
                .set_password(trimmed.as_str())
                .map_err(|error| format!("Gagal simpan auth secret ke OS keyring: {error}"))?;
            return Ok(trimmed);
        }
    }

    let generated_secret = generate_auth_secret();
    keyring_entry
        .set_password(generated_secret.as_str())
        .map_err(|error| format!("Gagal simpan auth secret baru ke OS keyring: {error}"))?;

    Ok(generated_secret)
}

pub fn resolve_or_create_device_id() -> Result<String, String> {
    let keyring_entry = keyring::Entry::new(RUNTIME_KEYRING_SERVICE, DEVICE_ID_KEY)
        .map_err(|error| format!("Gagal inisialisasi device ID keyring: {error}"))?;
    if let Ok(device_id) = keyring_entry.get_password() {
        if !device_id.trim().is_empty() {
            return Ok(device_id);
        }
    }

    let device_id: String = rand::thread_rng()
        .sample_iter(&Alphanumeric)
        .take(32)
        .map(char::from)
        .collect();
    keyring_entry
        .set_password(&device_id)
        .map_err(|error| format!("Gagal simpan device ID ke OS keyring: {error}"))?;
    Ok(device_id)
}

fn desktop_database_url<R: Runtime>(app_handle: &tauri::AppHandle<R>) -> Result<String, String> {
    let app_data_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|error| format!("Gagal menentukan app_data_dir: {error}"))?;
    if !app_data_dir.exists() {
        fs::create_dir_all(&app_data_dir)
            .map_err(|error| format!("Gagal membuat app_data_dir: {error}"))?;
    }
    let path = app_data_dir
        .join("hybrid-starter.db")
        .to_string_lossy()
        .replace('\\', "/");
    Ok(format!("file:{path}"))
}

pub fn resolve_provisioned_runtime_env<R: Runtime>(
    app_handle: &tauri::AppHandle<R>,
) -> Result<ProvisionedRuntimeEnv, String> {
    let sync_config = read_sync_config(app_handle);

    let auth_secret = resolve_or_create_auth_secret(app_handle)?;
    let device_id = resolve_or_create_device_id()?;

    Ok(ProvisionedRuntimeEnv {
        auth_database_url: desktop_database_url(app_handle)?,
        auth_database_auth_token: String::new(),
        sync_database_url: sync_config
            .as_ref()
            .map(|config| config.url.clone())
            .unwrap_or_default(),
        sync_database_auth_token: sync_config
            .as_ref()
            .map(|config| config.auth_token.clone())
            .unwrap_or_default(),
        auth_secret,
        device_id,
    })
}
