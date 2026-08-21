use std::path::PathBuf;

use reqwest::Client;
use tauri::{AppHandle, Manager};
use url::Url;

use super::{
    models::{CommandError, DesktopSession},
    secrets, storage,
    turso::{normalize_turso_url, TursoClient, TursoConfig},
};

const BUILD_OFFLINE_MAX_AGE_HOURS: Option<&str> = option_env!("SPPG_OFFLINE_AUTH_MAX_AGE_HOURS");
#[cfg(debug_assertions)]
const BUILD_TURSO_DATABASE_URL: Option<&str> = option_env!("TURSO_DATABASE_URL");
#[cfg(not(debug_assertions))]
const BUILD_TURSO_DATABASE_URL: Option<&str> = None;
#[cfg(debug_assertions)]
const BUILD_TURSO_AUTH_TOKEN: Option<&str> = option_env!("TURSO_AUTH_TOKEN");
#[cfg(not(debug_assertions))]
const BUILD_TURSO_AUTH_TOKEN: Option<&str> = None;
const DESKTOP_HTTP_TIMEOUT_SECONDS: u64 = 60;
const DEFAULT_FALLBACK_URL: &str = "https://absensi-sppg-seven.vercel.app";

pub struct DesktopState {
    pub server_origin: std::sync::RwLock<String>,
    pub offline_max_age_hours: u64,
    pub data_dir: PathBuf,
    pub http: Client,
    pub turso_config: std::sync::RwLock<Option<TursoConfig>>,
    pub session: std::sync::Mutex<Option<DesktopSession>>,
    pub vault_lock: std::sync::Mutex<()>,
}

fn parse_offline_hours_value(configured: Option<&str>, debug_build: bool) -> Result<u64, String> {
    let raw = configured.unwrap_or(if debug_build { "24" } else { "" });
    let hours = raw
        .parse::<u64>()
        .map_err(|_| "SPPG_OFFLINE_AUTH_MAX_AGE_HOURS harus berupa angka.")?;
    if !(1..=720).contains(&hours) {
        return Err("Masa login offline harus berada pada rentang 1-720 jam.".into());
    }
    Ok(hours)
}

fn parse_offline_hours() -> Result<u64, String> {
    parse_offline_hours_value(BUILD_OFFLINE_MAX_AGE_HOURS, cfg!(debug_assertions))
}

fn parse_server_url(raw_url: &str) -> Result<Url, CommandError> {
    let mut parsed = Url::parse(raw_url.trim())
        .map_err(|_| CommandError::new("SERVER_URL_INVALID", "Format URL Server tidak valid."))?;
    if !matches!(parsed.scheme(), "http" | "https")
        || parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
        || !matches!(parsed.path(), "" | "/")
    {
        return Err(CommandError::new(
            "SERVER_URL_INVALID",
            "URL Server harus berupa origin HTTP(S) tanpa kredensial, path, query, atau fragment.",
        ));
    }
    if parsed.scheme() != "https"
        && !(cfg!(debug_assertions)
            && matches!(
                parsed.host_str(),
                Some("localhost" | "127.0.0.1" | "::1" | "10.0.2.2")
            ))
    {
        return Err(CommandError::new(
            "SERVER_URL_INVALID",
            "URL Server wajib memakai HTTPS; HTTP hanya diizinkan untuk localhost saat debug.",
        ));
    }
    parsed.set_path("");
    Ok(parsed)
}

impl DesktopState {
    pub fn initialize(app: &AppHandle) -> Result<Self, String> {
        let offline_max_age_hours = parse_offline_hours()?;
        let data_dir = app
            .path()
            .app_local_data_dir()
            .map_err(|_| "Folder data lokal aplikasi tidak tersedia.")?;
        std::fs::create_dir_all(&data_dir)
            .map_err(|_| "Folder data lokal aplikasi tidak dapat dibuat.")?;
        storage::initialize(&data_dir)?;

        let http = Client::builder()
            .connect_timeout(std::time::Duration::from_secs(15))
            .timeout(std::time::Duration::from_secs(DESKTOP_HTTP_TIMEOUT_SECONDS))
            .user_agent("Absensi-SPPG-Desktop/0.1")
            .build()
            .map_err(|_| "HTTP client Desktop tidak dapat dibuat.")?;

        let temp_state = Self {
            server_origin: std::sync::RwLock::new(DEFAULT_FALLBACK_URL.into()),
            offline_max_age_hours,
            data_dir: data_dir.clone(),
            http: http.clone(),
            turso_config: std::sync::RwLock::new(None),
            session: std::sync::Mutex::new(None),
            vault_lock: std::sync::Mutex::new(()),
        };

        // 1. Cek vault terenkripsi
        let vault_config =
            secrets::load_turso_config(&temp_state).map_err(|error| error.message)?;

        // 2. Cek database setting lokal
        let db_turso_url = storage::get_system_setting(&data_dir, "turso_database_url")
            .map_err(|error| error.message)?;
        let db_turso_token = storage::get_system_setting(&data_dir, "turso_auth_token")
            .map_err(|error| error.message)?;

        let resolved_config = vault_config.clone().or_else(|| {
            if let (Some(u), Some(t)) = (db_turso_url.as_ref(), db_turso_token.as_ref()) {
                if !u.trim().is_empty() {
                    return Some(TursoConfig {
                        database_url: u.trim().to_owned(),
                        auth_token: t.trim().to_owned(),
                    });
                }
            }
            if let (Some(u), Some(t)) = (BUILD_TURSO_DATABASE_URL, BUILD_TURSO_AUTH_TOKEN) {
                if !u.trim().is_empty() {
                    return Some(TursoConfig {
                        database_url: u.trim().to_owned(),
                        auth_token: t.trim().to_owned(),
                    });
                }
            }
            None
        });

        // Migrasi fallback plaintext lama ke vault tanpa memutus konfigurasi instalasi aktif.
        if vault_config.is_none() {
            if let Some(config) = resolved_config.as_ref() {
                secrets::save_turso_config(&temp_state, config).map_err(|error| error.message)?;
            }
        }
        if db_turso_token
            .as_deref()
            .is_some_and(|token| !token.is_empty())
        {
            storage::set_system_setting(&data_dir, "turso_auth_token", "")
                .map_err(|error| error.message)?;
        }

        let server_origin = if let Some(ref cfg) = resolved_config {
            normalize_turso_url(&cfg.database_url)
                .map(|u| u.origin().ascii_serialization())
                .map_err(|error| error.message)?
        } else {
            let saved_url = storage::get_system_setting(&data_dir, "server_api_base_url")
                .map_err(|error| error.message)?
                .unwrap_or_else(|| DEFAULT_FALLBACK_URL.into());
            parse_server_url(&saved_url)
                .map(|url| url.origin().ascii_serialization())
                .map_err(|error| error.message)?
        };

        Ok(Self {
            server_origin: std::sync::RwLock::new(server_origin),
            offline_max_age_hours,
            data_dir,
            http,
            turso_config: std::sync::RwLock::new(resolved_config),
            session: std::sync::Mutex::new(None),
            vault_lock: std::sync::Mutex::new(()),
        })
    }

    pub fn server_origin(&self) -> String {
        self.server_origin
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    pub fn api_base_url(&self) -> Result<Url, CommandError> {
        Url::parse(&self.server_origin()).map_err(|_| {
            CommandError::new(
                "DESKTOP_SERVER_URL_INVALID",
                "URL server aktif tidak valid. Periksa konfigurasi koneksi aplikasi.",
            )
        })
    }

    pub fn get_turso_client(&self) -> Result<TursoClient, CommandError> {
        let config_guard = self
            .turso_config
            .read()
            .map_err(|_| CommandError::internal())?;
        if let Some(config) = config_guard.as_ref() {
            TursoClient::from_config(config, self.http.clone())
        } else {
            Err(CommandError::new(
                "TURSO_NOT_CONFIGURED",
                "Database Cloud Turso belum dikonfigurasi. Silakan tambahkan URL dan Auth Token di Pengaturan.",
            ))
        }
    }

    pub fn turso_config(&self) -> Option<TursoConfig> {
        self.turso_config
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    pub fn set_turso_config(
        &self,
        raw_url: &str,
        auth_token: &str,
    ) -> Result<String, CommandError> {
        let normalized = normalize_turso_url(raw_url)?;
        let origin = normalized.origin().ascii_serialization();

        let resolved_token = if auth_token.trim().is_empty() {
            self.turso_config()
                .filter(|config| {
                    normalize_turso_url(&config.database_url).is_ok_and(|url| url == normalized)
                })
                .map(|config| config.auth_token)
                .ok_or_else(|| {
                    CommandError::new(
                        "TURSO_TOKEN_REQUIRED",
                        "Auth Token wajib diisi saat URL database Turso berubah.",
                    )
                })?
        } else {
            auth_token.trim().to_owned()
        };

        let config = TursoConfig {
            database_url: raw_url.trim().to_owned(),
            auth_token: resolved_token,
        };

        // Simpan ke vault terenkripsi
        secrets::save_turso_config(self, &config)?;

        // URL non-rahasia boleh disimpan lokal; token hanya boleh berada di vault.
        storage::set_system_setting(&self.data_dir, "turso_database_url", &config.database_url)?;
        storage::set_system_setting(&self.data_dir, "turso_auth_token", "")?;

        *self
            .turso_config
            .write()
            .map_err(|_| CommandError::internal())? = Some(config);
        *self
            .server_origin
            .write()
            .map_err(|_| CommandError::internal())? = origin.clone();

        Ok(origin)
    }

    pub fn set_server_url(&self, raw_url: &str) -> Result<String, CommandError> {
        let parsed = parse_server_url(raw_url)?;
        let origin = parsed.origin().ascii_serialization();
        storage::set_system_setting(&self.data_dir, "server_api_base_url", parsed.as_str())?;
        *self
            .server_origin
            .write()
            .map_err(|_| CommandError::internal())? = origin.clone();
        Ok(origin)
    }
}

#[cfg(test)]
mod tests {
    use super::{normalize_turso_url, parse_offline_hours_value, parse_server_url};

    #[test]
    fn turso_endpoint_normalization() {
        assert!(normalize_turso_url("libsql://customer.turso.io").is_ok());
        assert!(normalize_turso_url("https://customer.turso.io").is_ok());
        assert!(normalize_turso_url("http://localhost:8080").is_ok());
        assert!(normalize_turso_url("").is_err());
    }

    #[test]
    fn legacy_server_endpoint_must_be_safe_origin() {
        assert!(parse_server_url("https://buyer.example").is_ok());
        assert!(parse_server_url("https://buyer.example/api").is_err());
        assert!(parse_server_url("https://user@buyer.example").is_err());
    }

    #[test]
    fn offline_window_is_bounded_and_required_in_release() {
        assert_eq!(parse_offline_hours_value(Some("24"), false), Ok(24));
        assert!(parse_offline_hours_value(None, false).is_err());
        assert!(parse_offline_hours_value(Some("0"), false).is_err());
        assert!(parse_offline_hours_value(Some("721"), false).is_err());
    }
}
