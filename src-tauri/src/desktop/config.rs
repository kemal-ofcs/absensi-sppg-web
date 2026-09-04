use std::path::PathBuf;

use reqwest::Client;
use tauri::{AppHandle, Manager};
use url::Url;

use super::{
    models::{CommandError, DesktopSession},
    secrets, storage, sync,
    turso::{DatabaseProvider, TursoClient, TursoConfig},
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

/// Baca provider database dari tabel setting lokal.
///
/// Nilai yang tidak dikenal (atau belum pernah ditulis, seperti pada instalasi
/// yang dibuat sebelum mode server sendiri ada) selalu jatuh ke Turso terkelola
/// — aturan validasi yang paling ketat, sehingga default-nya aman.
fn parse_provider_setting(raw: Option<&str>) -> DatabaseProvider {
    match raw.map(str::trim) {
        // `"local"` SENGAJA tetap berarti server sendiri. Nilai itu sudah
        // tersimpan di perangkat yang memakai `sqld` sejak sebelum mode lokal
        // ada, dan memakainya ulang akan mengubah arti data mereka diam-diam.
        Some("self_hosted") | Some("self-hosted") | Some("selfHosted") | Some("custom")
        | Some("local") | Some("libsql") => DatabaseProvider::SelfHosted,
        Some("local_file") | Some("local-file") | Some("localFile") | Some("file") => {
            DatabaseProvider::LocalFile
        }
        _ => DatabaseProvider::Turso,
    }
}

/// Baca flag boolean dari tabel setting lokal (disimpan sebagai "1"/"0").
fn parse_bool_setting(raw: Option<&str>) -> bool {
    matches!(
        raw.map(str::trim),
        Some("1") | Some("true") | Some("TRUE") | Some("yes")
    )
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

        // 1. Cek vault terenkripsi (jika database baru dibuat ulang dan vault lama mismatch, reset vault usang secara aman)
        let vault_config = match secrets::load_turso_config(&temp_state) {
            Ok(config) => config,
            Err(err)
                if err.code == "TURSO_VAULT_DEVICE_MISMATCH"
                    || err.code == "TURSO_VAULT_INVALID" =>
            {
                let credentials_dir = data_dir.join("credentials");
                let _ = std::fs::remove_file(credentials_dir.join("turso_config.vault"));
                let _ = std::fs::remove_file(credentials_dir.join("turso_config.salt"));
                None
            }
            Err(err) => return Err(err.message),
        };

        // 2. Cek database setting lokal
        let db_turso_url = storage::get_system_setting(&data_dir, "turso_database_url")
            .map_err(|error| error.message)?;
        let db_turso_token = storage::get_system_setting(&data_dir, "turso_auth_token")
            .map_err(|error| error.message)?;
        // Provider dan izin transport ikut dicermin ke tabel setting lokal
        // (keduanya bukan rahasia) supaya jalur pemulihan ini tahu bahwa URL LAN
        // ber-HTTP memang disengaja, bukan URL Turso yang salah ketik.
        let db_provider = storage::get_system_setting(&data_dir, "turso_database_provider")
            .map_err(|error| error.message)?;
        let db_allow_insecure =
            storage::get_system_setting(&data_dir, "turso_allow_insecure_transport")
                .map_err(|error| error.message)?;

        let resolved_config = vault_config.clone().or_else(|| {
            // Token boleh kosong. Server libSQL sendiri kerap berjalan tanpa
            // autentikasi, dan token Turso memang dikosongkan dari tabel setting
            // begitu dipindahkan ke vault. Versi lama menuntut `Some(_)` untuk
            // token, sehingga perangkat yang tidak pernah punya baris
            // `turso_auth_token` gagal memulihkan URL-nya sama sekali.
            if let Some(u) = db_turso_url.as_ref() {
                if !u.trim().is_empty() {
                    return Some(TursoConfig::new(
                        u.trim().to_owned(),
                        db_turso_token
                            .as_deref()
                            .unwrap_or_default()
                            .trim()
                            .to_owned(),
                        parse_provider_setting(db_provider.as_deref()),
                        parse_bool_setting(db_allow_insecure.as_deref()),
                    ));
                }
            }
            if let (Some(u), Some(t)) = (BUILD_TURSO_DATABASE_URL, BUILD_TURSO_AUTH_TOKEN) {
                if !u.trim().is_empty() {
                    return Some(TursoConfig::turso(u.trim().to_owned(), t.trim().to_owned()));
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
            cfg.normalized_url()
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
                "Database belum dikonfigurasi. Pilih Turso Cloud atau Server Database Sendiri, lalu isi alamatnya di Pengaturan.",
            ))
        }
    }

    pub fn turso_config(&self) -> Option<TursoConfig> {
        self.turso_config
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    /// Lokasi bawaan berkas hub untuk mode Database Lokal.
    ///
    /// Berdampingan dengan database perangkat, bukan menggantikannya:
    /// `desktop-security.db` tetap memegang vault, outbox, dan cermin
    /// operasional, sementara berkas ini memegang skema cloud apa adanya.
    /// Menggabungkan keduanya berarti mendamaikan DDL `storage.rs` dengan DDL
    /// `turso.rs` — justru kelas drift yang ingin dihindari mode lokal.
    pub fn local_hub_path(&self) -> PathBuf {
        self.data_dir.join("sppg-hub.db")
    }

    /// Simpan konfigurasi database aktif — provider, URL, dan token — sekaligus.
    ///
    /// Ini satu-satunya pintu penulisan konfigurasi database. Provider ikut
    /// disimpan karena aturan validasi transport bergantung padanya; menebaknya
    /// ulang dari bentuk URL akan salah untuk server sendiri yang sudah ber-HTTPS.
    pub fn set_database_config(&self, requested: &TursoConfig) -> Result<String, CommandError> {
        // Mode lokal: formulir tidak menampilkan kolom alamat sama sekali, jadi
        // lokasi berkas diisi di sini. Nilai yang dikirim eksplisit tetap
        // dihormati supaya pengguna bisa menaruh hub di drive lain.
        let requested = &if requested.provider.is_local_file()
            && requested.database_url.trim().is_empty()
        {
            TursoConfig::new(
                self.local_hub_path().to_string_lossy().into_owned(),
                String::new(),
                requested.provider,
                false,
            )
        } else {
            requested.clone()
        };

        let normalized = requested.normalized_url()?;
        let origin = normalized.origin().ascii_serialization();
        let previous = self.turso_config();

        // Token kosong berarti "pertahankan token yang sudah ada di vault":
        // frontend memang tidak pernah menerima token plaintext untuk dikirim
        // balik. Itu hanya sah bila URL-nya masih menunjuk database yang sama.
        let resolved_token = if requested.auth_token.trim().is_empty() {
            previous
                .as_ref()
                .filter(|config| config.normalized_url().is_ok_and(|url| url == normalized))
                .map(|config| config.auth_token.clone())
                .unwrap_or_default()
        } else {
            requested.auth_token.trim().to_owned()
        };

        let config = TursoConfig::new(
            requested.database_url.trim().to_owned(),
            resolved_token,
            requested.provider,
            requested.allow_insecure_transport,
        );

        // Turso terkelola — dan server sendiri yang terekspos internet — wajib
        // punya token. Server libSQL di LAN boleh tanpa autentikasi sama sekali,
        // jadi token kosong di sana adalah nilai akhir yang sah, bukan error.
        if config.auth_token.trim().is_empty() && config.requires_auth_token() {
            return Err(CommandError::new(
                "TURSO_TOKEN_REQUIRED",
                "Auth Token wajib diisi saat URL database berubah.",
            ));
        }

        // Perbandingan wajib memakai URL ternormalisasi: `libsql://x` dan
        // `https://x` menunjuk database yang sama, dan menyimpan ulang URL yang
        // sama dalam ejaan berbeda tidak boleh dianggap pindah database.
        // Mode lokal selalu menghasilkan origin sintetis yang sama, sehingga
        // perbandingan URL tidak akan pernah melihat perpindahan berkas. Yang
        // menentukan di sana adalah lokasi berkasnya — dan pindah berkas berarti
        // pindah database, persis seperti pindah URL.
        let url_changed = if config.provider.is_local_file() {
            !previous.as_ref().is_some_and(|previous_config| {
                previous_config.provider.is_local_file()
                    && previous_config.database_url.trim() == config.database_url.trim()
            })
        } else {
            !previous
                .as_ref()
                .and_then(|config| config.normalized_url().ok())
                .is_some_and(|previous_url| previous_url == normalized)
        };

        // Simpan ke vault terenkripsi
        secrets::save_turso_config(self, &config)?;

        // Nilai non-rahasia boleh disimpan lokal; token hanya boleh berada di vault.
        storage::set_system_setting(&self.data_dir, "turso_database_url", &config.database_url)?;
        storage::set_system_setting(&self.data_dir, "turso_auth_token", "")?;
        storage::set_system_setting(
            &self.data_dir,
            "turso_database_provider",
            config.provider.as_str(),
        )?;
        storage::set_system_setting(
            &self.data_dir,
            "turso_allow_insecure_transport",
            if config.allow_insecure_transport {
                "1"
            } else {
                "0"
            },
        )?;

        if url_changed {
            // Pindah database bukan sekadar ganti kredensial. Seluruh SQLite lokal
            // adalah cache milik database lama: karyawan, absensi, log scan, payroll,
            // pengaturan, sampai outbox yang belum terkirim. Kalau tidak dibuang,
            // data database lama tetap tampil di aplikasi dan outbox lamanya justru
            // terdorong masuk ke database baru. Snapshot pull tidak bisa
            // membereskannya karena `delete_missing` memang dimatikan untuk hampir
            // semua tabel demi melindungi data lokal yang belum dilacak server.
            storage::reset_cloud_linked_data(&self.data_dir, sync::DEVICE_LOCAL_SETTING_KEYS)?;
        }

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
    use super::super::turso::normalize_database_url;
    use super::{
        parse_bool_setting, parse_offline_hours_value, parse_provider_setting, parse_server_url,
        DatabaseProvider,
    };

    #[test]
    fn turso_endpoint_normalization() {
        let turso = |raw: &str| normalize_database_url(raw, DatabaseProvider::Turso, false);
        assert!(turso("libsql://customer.turso.io").is_ok());
        assert!(turso("https://customer.turso.io").is_ok());
        assert!(turso("http://localhost:8080").is_ok());
        assert!(turso("").is_err());
    }

    #[test]
    fn provider_setting_defaults_to_turso_for_unknown_values() {
        assert_eq!(
            parse_provider_setting(Some("self_hosted")),
            DatabaseProvider::SelfHosted
        );
        assert_eq!(
            parse_provider_setting(Some("self-hosted")),
            DatabaseProvider::SelfHosted
        );
        // Instalasi lama tidak pernah menulis baris ini; default-nya harus
        // aturan yang paling ketat, bukan yang paling longgar.
        assert_eq!(parse_provider_setting(None), DatabaseProvider::Turso);
        assert_eq!(parse_provider_setting(Some("")), DatabaseProvider::Turso);
        assert_eq!(
            parse_provider_setting(Some("local_file")),
            DatabaseProvider::LocalFile
        );
        assert_eq!(
            parse_provider_setting(Some("local-file")),
            DatabaseProvider::LocalFile
        );
        // Nilai lama `"local"` WAJIB tetap berarti server sendiri: perangkat
        // yang memakai sqld sudah menyimpannya sejak sebelum mode lokal ada.
        assert_eq!(
            parse_provider_setting(Some("local")),
            DatabaseProvider::SelfHosted
        );
        assert_eq!(
            parse_provider_setting(Some("postgres")),
            DatabaseProvider::Turso
        );
    }

    #[test]
    fn bool_setting_only_accepts_explicit_truth() {
        assert!(parse_bool_setting(Some("1")));
        assert!(parse_bool_setting(Some("true")));
        assert!(!parse_bool_setting(Some("0")));
        assert!(!parse_bool_setting(None));
        assert!(!parse_bool_setting(Some("")));
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
