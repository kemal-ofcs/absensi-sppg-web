use std::path::PathBuf;

use reqwest::Client;
use tauri::{AppHandle, Manager};
use url::Url;

use super::{
    models::{CommandError, DesktopSession},
    storage,
};

const BUILD_API_BASE_URL: Option<&str> = option_env!("SPPG_API_BASE_URL");
const BUILD_DEV_API_BASE_URL: Option<&str> = option_env!("SPPG_DEV_API_BASE_URL");
const BUILD_OFFLINE_MAX_AGE_HOURS: Option<&str> = option_env!("SPPG_OFFLINE_AUTH_MAX_AGE_HOURS");
const DESKTOP_HTTP_TIMEOUT_SECONDS: u64 = 60;
const DEFAULT_FALLBACK_URL: &str = "https://absensi-sppg-seven.vercel.app";

pub struct DesktopState {
    pub api_base_url: std::sync::RwLock<Url>,
    pub server_origin: std::sync::RwLock<String>,
    pub offline_max_age_hours: u64,
    pub data_dir: PathBuf,
    pub http: Client,
    pub session: std::sync::Mutex<Option<DesktopSession>>,
    pub vault_lock: std::sync::Mutex<()>,
}

fn parse_api_base_url_value(configured: Option<&str>, debug_build: bool) -> Result<Url, String> {
    let configured = configured
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(DEFAULT_FALLBACK_URL);
    if configured.is_empty() {
        return Err("SPPG_API_BASE_URL belum dikonfigurasi untuk build Desktop.".into());
    }

    let mut url = Url::parse(configured).map_err(|_| "SPPG_API_BASE_URL tidak valid.")?;
    if url.username() != ""
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || !matches!(url.path(), "" | "/")
    {
        return Err(
            "SPPG_API_BASE_URL harus berupa origin tanpa kredensial, path, query, atau fragment."
                .into(),
        );
    }
    let local_debug = debug_build
        && url.scheme() == "http"
        && (
            matches!(
                url.host_str(),
                Some("localhost" | "127.0.0.1" | "::1" | "10.0.2.2")
            ) || url.host().map_or(false, |h| matches!(h, url::Host::Ipv4(_)))
        );
    if url.scheme() != "https" && !local_debug {
        return Err("SPPG_API_BASE_URL wajib memakai HTTPS pada build release.".into());
    }
    url.set_path("");
    Ok(url)
}

fn parse_api_base_url() -> Result<Url, String> {
    let debug_build = cfg!(debug_assertions);
    let configured = if debug_build {
        BUILD_DEV_API_BASE_URL
    } else {
        BUILD_API_BASE_URL
    };
    parse_api_base_url_value(configured, debug_build)
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

        let saved_url = storage::get_system_setting(&data_dir, "server_api_base_url").ok().flatten();
        let api_base_url = if let Some(saved) = saved_url {
            Url::parse(&saved).unwrap_or_else(|_| parse_api_base_url().unwrap_or_else(|_| Url::parse(DEFAULT_FALLBACK_URL).unwrap()))
        } else {
            parse_api_base_url()?
        };
        let server_origin = api_base_url.origin().ascii_serialization();

        let http = Client::builder()
            .connect_timeout(std::time::Duration::from_secs(15))
            .timeout(std::time::Duration::from_secs(DESKTOP_HTTP_TIMEOUT_SECONDS))
            .user_agent("Absensi-SPPG-Desktop/0.1")
            .build()
            .map_err(|_| "HTTP client Desktop tidak dapat dibuat.")?;

        Ok(Self {
            api_base_url: std::sync::RwLock::new(api_base_url),
            server_origin: std::sync::RwLock::new(server_origin),
            offline_max_age_hours,
            data_dir,
            http,
            session: std::sync::Mutex::new(None),
            vault_lock: std::sync::Mutex::new(()),
        })
    }

    pub fn api_base_url(&self) -> Url {
        self.api_base_url.read().unwrap().clone()
    }

    pub fn server_origin(&self) -> String {
        self.server_origin.read().unwrap().clone()
    }

    pub fn set_server_url(&self, raw_url: &str) -> Result<String, CommandError> {
        let trimmed = raw_url.trim();
        if trimmed.is_empty() {
            return Err(CommandError::new(
                "SERVER_URL_INVALID",
                "URL Server tidak boleh kosong.",
            ));
        }

        let mut parsed = Url::parse(trimmed).map_err(|_| {
            CommandError::new(
                "SERVER_URL_INVALID",
                "Format URL Server tidak valid (contoh: https://absensi-sppg-seven.vercel.app atau http://127.0.0.1:3000).",
            )
        })?;

        if !matches!(parsed.scheme(), "http" | "https") {
            return Err(CommandError::new(
                "SERVER_URL_INVALID",
                "URL Server harus menggunakan protokol http atau https.",
            ));
        }

        parsed.set_path("");
        parsed.set_query(None);
        parsed.set_fragment(None);

        let origin = parsed.origin().ascii_serialization();

        storage::set_system_setting(&self.data_dir, "server_api_base_url", parsed.as_str())?;

        *self.api_base_url.write().unwrap() = parsed;
        *self.server_origin.write().unwrap() = origin.clone();

        Ok(origin)
    }
}

#[cfg(test)]
mod tests {
    use super::{parse_api_base_url_value, parse_offline_hours_value};

    #[test]
    fn release_endpoint_must_be_https_origin() {
        assert!(parse_api_base_url_value(Some("https://buyer.example"), false).is_ok());
        assert!(parse_api_base_url_value(Some("http://buyer.example"), false).is_err());
        assert!(parse_api_base_url_value(Some("https://buyer.example/api"), false).is_err());
        assert!(parse_api_base_url_value(Some("https://user@buyer.example"), false).is_err());
    }

    #[test]
    fn localhost_http_is_debug_only() {
        assert!(parse_api_base_url_value(None, true).is_ok());
        assert!(parse_api_base_url_value(Some("http://127.0.0.1:3000"), true).is_ok());
        assert!(parse_api_base_url_value(Some("http://127.0.0.1:3000"), false).is_err());
    }

    #[test]
    fn offline_window_is_bounded_and_required_in_release() {
        assert_eq!(parse_offline_hours_value(Some("24"), false), Ok(24));
        assert!(parse_offline_hours_value(None, false).is_err());
        assert!(parse_offline_hours_value(Some("0"), false).is_err());
        assert!(parse_offline_hours_value(Some("721"), false).is_err());
    }
}
