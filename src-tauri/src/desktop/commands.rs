use base64::prelude::*;
use reqwest::Method;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager, State};
use zeroize::Zeroizing;

use super::{
    portability,
    administration,
    config::DesktopState,
    models::{
        CommandError, DesktopLoginResult, DesktopRuntimeStatus, DesktopSession, DesktopSyncStatus,
        OperatorUser, SessionMode,
    },
    operational,
    remote::{self, RemoteLoginError},
    scanner, secrets, storage, sync, turso,
};

struct OnlineAccess {
    token: Zeroizing<String>,
}

/// Sesi login yang sah, tanpa menuntut izin tertentu.
///
/// Dipakai tindakan yang hanya menyentuh akun milik pemanggil sendiri —
/// mendaftarkan atau mematikan verifikasi dua langkahnya sendiri. Memaksakan
/// sebuah izin di sini akan salah: setiap operator berhak mengamankan akunnya,
/// termasuk role paling terbatas sekalipun.
fn require_session(state: &DesktopState) -> Result<OperatorUser, CommandError> {
    let session = state.session.lock().map_err(|_| CommandError::internal())?;
    let session = session.as_ref().ok_or_else(|| {
        CommandError::new(
            "DESKTOP_SESSION_MISSING",
            "Session Desktop tidak tersedia. Silakan login kembali.",
        )
    })?;
    Ok(session.operator.clone())
}

// `pub(crate)`, bukan privat: build Mobile punya perintah yang tidak ada
// padanannya di Desktop (`share.rs`), dan perintah itu wajib melewati gerbang
// izin yang SAMA. Menyalin logikanya ke sana akan membuat dua gerbang yang
// cepat atau lambat berbeda.
pub(crate) fn require_permission(
    state: &DesktopState,
    permission: &str,
) -> Result<OperatorUser, CommandError> {
    let session = state.session.lock().map_err(|_| CommandError::internal())?;
    let session = session.as_ref().ok_or_else(|| {
        CommandError::new(
            "DESKTOP_SESSION_MISSING",
            "Session Desktop tidak tersedia. Silakan login kembali.",
        )
    })?;
    if !session.operator.is_superadmin
        && !session
            .operator
            .permissions
            .iter()
            .any(|key| key == permission)
    {
        return Err(CommandError::new(
            "DESKTOP_ACCESS_DENIED",
            "Akses ditolak untuk tindakan ini.",
        ));
    }
    Ok(session.operator.clone())
}

fn require_online_access(
    state: &DesktopState,
    permission: &str,
) -> Result<OnlineAccess, CommandError> {
    let session = state.session.lock().map_err(|_| CommandError::internal())?;
    let session = session.as_ref().ok_or_else(|| {
        CommandError::new(
            "DESKTOP_SESSION_MISSING",
            "Session Desktop tidak tersedia. Silakan login kembali.",
        )
    })?;
    if !session.operator.is_superadmin
        || !session
            .operator
            .permissions
            .iter()
            .any(|key| key == permission)
    {
        return Err(CommandError::new(
            "DESKTOP_ACCESS_DENIED",
            "Akses ditolak untuk tindakan ini.",
        ));
    }
    let token = session.token.as_ref().ok_or_else(|| {
        CommandError::new(
            "DESKTOP_ONLINE_REQUIRED",
            "Master Operator dan perubahan role wajib dilakukan saat online.",
        )
    })?;
    Ok(OnlineAccess {
        token: Zeroizing::new(token.to_string()),
    })
}

/// Token sesi bila ada, atau string kosong.
///
/// Kosong BUKAN alasan untuk membatalkan sinkronisasi: jalur Turso 2-tier tidak
/// memakai token sama sekali. Hanya jalur HTTP legacy yang membutuhkannya.
fn session_token(state: &DesktopState) -> String {
    state
        .session
        .lock()
        .ok()
        .and_then(|guard| {
            guard
                .as_ref()
                .and_then(|session| session.token.as_ref().map(|token| token.to_string()))
        })
        .unwrap_or_default()
}

fn clear_expired_session(state: &DesktopState, error: &CommandError) {
    if error.code == "DESKTOP_SESSION_EXPIRED" {
        if let Ok(mut session) = state.session.lock() {
            *session = None;
        }
    }
}

fn ensure_login_not_locked(state: &DesktopState, identifier: &str) -> Result<(), CommandError> {
    if let Some(seconds) = storage::login_lock_remaining(&state.data_dir, identifier)? {
        return Err(CommandError::new(
            "LOGIN_RATE_LIMITED",
            format!(
                "Terlalu banyak percobaan login. Coba kembali dalam {} menit {} detik.",
                seconds / 60,
                seconds % 60
            ),
        ));
    }
    Ok(())
}

fn reject_login(state: &DesktopState, identifier: &str) -> Result<(), CommandError> {
    if let Some(seconds) = storage::record_failed_login(&state.data_dir, identifier)? {
        return Err(CommandError::new(
            "LOGIN_RATE_LIMITED",
            format!(
                "Terlalu banyak percobaan login. Coba kembali dalam {} menit {} detik.",
                seconds / 60,
                seconds % 60
            ),
        ));
    }
    Ok(())
}

async fn secured_api(
    state: &DesktopState,
    permission: &str,
    method: Method,
    path: &str,
    body: Option<Value>,
) -> Result<Value, CommandError> {
    let access = require_online_access(state, permission)?;
    let result = remote::authorized_json(state, method, path, body, &access.token).await;
    if let Err(error) = &result {
        clear_expired_session(state, error);
    }
    result
}

#[tauri::command]
pub fn desktop_get_session(
    state: State<'_, DesktopState>,
) -> Result<Option<OperatorUser>, CommandError> {
    let session = state.session.lock().map_err(|_| CommandError::internal())?;
    Ok(session.as_ref().map(|session| session.operator.clone()))
}

#[tauri::command]
pub fn desktop_get_runtime_status(
    state: State<'_, DesktopState>,
) -> Result<DesktopRuntimeStatus, CommandError> {
    let session = state.session.lock().map_err(|_| CommandError::internal())?;
    Ok(DesktopRuntimeStatus {
        configured: true,
        server_origin: state.server_origin(),
        offline_max_age_hours: state.offline_max_age_hours,
        has_active_session: session.is_some(),
        mode: session.as_ref().map(|session| session.mode),
    })
}

#[tauri::command]
pub async fn desktop_get_bootstrap_status(
    state: State<'_, DesktopState>,
) -> Result<turso::BootstrapStatus, CommandError> {
    // Perintah ini menentukan apakah layar provisioning muncul, jadi ia tidak
    // boleh gagal keras. Sebelumnya, database cloud yang mati/terhapus membuat
    // perintah ini mengembalikan Err, frontend menelannya menjadi `null`, dan
    // perangkat terkunci selamanya di layar login tanpa jalan kembali ke
    // provisioning. Sekarang kegagalan koneksi dilaporkan sebagai status.
    match state.get_turso_client() {
        Ok(client) => {
            let origin = state.server_origin();
            match client.bootstrap_status().await {
                Ok(status) => Ok(status),
                Err(error) => Ok(turso::BootstrapStatus::unreachable(origin, &error)),
            }
        }
        Err(error) if error.code == "TURSO_NOT_CONFIGURED" => Ok(turso::BootstrapStatus {
            configured: false,
            required: true,
            server_origin: String::new(),
            reachable: false,
            message: Some(error.message),
        }),
        Err(error) => Err(error),
    }
}

#[tauri::command]
pub async fn desktop_bootstrap_superadmin(
    state: State<'_, DesktopState>,
    draft: turso::BootstrapSuperadminDraft,
    database_url: Option<String>,
    auth_token: Option<String>,
    provider: Option<turso::DatabaseProvider>,
    allow_insecure_transport: Option<bool>,
) -> Result<Value, CommandError> {
    if state
        .session
        .lock()
        .map_err(|_| CommandError::internal())?
        .is_some()
    {
        return Err(CommandError::new(
            "TURSO_BOOTSTRAP_CLOSED",
            "Bootstrap hanya tersedia sebelum sesi pengguna aktif.",
        ));
    }

    // Kredensial dari form SELALU menang atas kredensial yang sudah tersimpan.
    // Dulu cabang "sudah terkonfigurasi" langsung memakai klien vault dan
    // membuang `database_url`/`auth_token` yang baru saja diketik, sehingga
    // pengguna yang mengarahkan aplikasi ke database Turso baru justru
    // memprovisioning database lama — yang bahkan mungkin sudah dihapus.
    // `resolve_bootstrap_turso_config` memakai vault hanya bila form dikosongkan.
    let config = resolve_bootstrap_turso_config(
        &state,
        database_url,
        auth_token,
        provider,
        allow_insecure_transport,
    )?;
    let client = turso::TursoClient::from_config(&config, state.http.clone())?;
    let status = client.bootstrap_status().await?;
    // Kode pemulihan hanya bisa dibaca SEKALI — database memegang hash-nya saja.
    // Karena itu ia ikut dalam balasan ini, dan layar bootstrap wajib
    // menampilkannya sampai pengguna menyatakan sudah menyimpannya.
    let recovery_codes = if status.required {
        client.bootstrap_superadmin(draft).await?
    } else {
        Vec::new()
    };
    state.set_database_config(&config)?;
    let _ = sync::pull_snapshot(&state, "").await;
    storage::audit(&state.data_dir, None, "bootstrap-superadmin-success", None);
    Ok(json!({ "sukses": true, "recoveryCodes": recovery_codes }))
}

fn ensure_bootstrap_window_open(state: &DesktopState) -> Result<(), CommandError> {
    if state
        .session
        .lock()
        .map_err(|_| CommandError::internal())?
        .is_some()
    {
        return Err(CommandError::new(
            "TURSO_BOOTSTRAP_CLOSED",
            "Pemeriksaan database provisioning hanya tersedia sebelum sesi pengguna aktif.",
        ));
    }
    Ok(())
}

/// Resolusi kredensial untuk pemeriksaan provisioning: pakai input form bila diisi,
/// selain itu jatuh ke konfigurasi vault yang sudah tersimpan. Token yang sudah ada
/// di vault tidak pernah dikirim balik ke frontend, jadi field kosong = pakai token lama.
fn resolve_bootstrap_turso_config(
    state: &DesktopState,
    database_url: Option<String>,
    auth_token: Option<String>,
    provider: Option<turso::DatabaseProvider>,
    allow_insecure_transport: Option<bool>,
) -> Result<turso::TursoConfig, CommandError> {
    let url = database_url.unwrap_or_default().trim().to_owned();
    let token = auth_token.unwrap_or_default().trim().to_owned();
    let stored = state.turso_config();

    // Provider yang tidak dikirim frontend mewarisi pilihan yang sudah tersimpan;
    // instalasi lama yang belum punya konfigurasi apa pun tetap jatuh ke Turso.
    //
    // WAJIB ditentukan SEBELUM alamat kosong ditolak di bawah: Mode Database
    // Lokal memang tidak punya alamat, dan formulirnya sengaja tidak menampilkan
    // kolom itu. Versi sebelumnya memeriksa alamat lebih dulu, sehingga
    // provisioning perangkat baru dalam mode lokal selalu berhenti dengan
    // "Alamat database wajib diisi" — menuntut sesuatu yang tidak pernah bisa
    // diisi pengguna.
    let requested_provider = provider
        .or_else(|| stored.as_ref().map(|config| config.provider))
        .unwrap_or_default();

    if requested_provider.is_local_file() {
        // Lokasi berkas hub ditentukan di sini persis seperti pada
        // `set_database_config`, supaya kedua pintu masuk konfigurasi memakai
        // lokasi bawaan yang sama. Alamat yang dikirim eksplisit tetap
        // dihormati, agar hub bisa ditaruh di drive lain.
        let path = if url.is_empty() {
            state.local_hub_path().to_string_lossy().into_owned()
        } else {
            url
        };
        return Ok(turso::TursoConfig::new(
            path,
            String::new(),
            turso::DatabaseProvider::LocalFile,
            false,
        ));
    }

    if url.is_empty() {
        return stored.ok_or_else(|| {
            CommandError::new(
                "TURSO_NOT_CONFIGURED",
                "Alamat database wajib diisi untuk memeriksa database.",
            )
        });
    }

    let provider = requested_provider;
    let allow_insecure_transport = allow_insecure_transport
        .or_else(|| {
            stored
                .as_ref()
                .map(|config| config.allow_insecure_transport)
        })
        .unwrap_or(false);

    // Token kosong berarti "pakai token vault", tapi hanya bila URL-nya memang
    // database yang sama. Perbandingan wajib ternormalisasi: versi lama menyamakan
    // string mentah, sehingga mengetik `https://x` untuk vault yang menyimpan
    // `libsql://x` membuang token yang sebenarnya masih berlaku dan memunculkan
    // "Auth Token wajib diisi" pada database yang sudah terhubung.
    let token = if token.is_empty() {
        stored
            .as_ref()
            .filter(|config| config.matches_url(&url))
            .map(|config| config.auth_token.clone())
            .unwrap_or_default()
    } else {
        token
    };

    let config = turso::TursoConfig::new(url, token, provider, allow_insecure_transport);
    // Server libSQL sendiri di LAN boleh tanpa autentikasi; hanya endpoint yang
    // benar-benar terekspos internet yang wajib bertoken.
    if config.auth_token.trim().is_empty() && config.requires_auth_token() {
        return Err(CommandError::new(
            "TURSO_TOKEN_REQUIRED",
            "Auth Token wajib diisi untuk memeriksa database ini.",
        ));
    }
    Ok(config)
}

#[tauri::command]
pub async fn desktop_check_bootstrap_database(
    state: State<'_, DesktopState>,
    database_url: Option<String>,
    auth_token: Option<String>,
    provider: Option<turso::DatabaseProvider>,
    allow_insecure_transport: Option<bool>,
) -> Result<turso::DatabaseCheckResult, CommandError> {
    ensure_bootstrap_window_open(&state)?;
    let config = resolve_bootstrap_turso_config(
        &state,
        database_url,
        auth_token,
        provider,
        allow_insecure_transport,
    )?;
    let origin = config
        .normalized_url()
        .map(|url| url.origin().ascii_serialization())
        .unwrap_or_default();
    let client = match turso::TursoClient::from_config(&config, state.http.clone()) {
        Ok(client) => client,
        Err(error) => return Ok(turso::DatabaseCheckResult::unreachable(origin, &error)),
    };
    match client.inspect_database().await {
        Ok(check) => Ok(check),
        Err(error) => Ok(turso::DatabaseCheckResult::unreachable(origin, &error)),
    }
}

/// Menyimpan kredensial database yang sudah punya Superadmin aktif tanpa membuat akun baru.
#[tauri::command]
pub async fn desktop_link_bootstrap_database(
    state: State<'_, DesktopState>,
    database_url: Option<String>,
    auth_token: Option<String>,
    provider: Option<turso::DatabaseProvider>,
    allow_insecure_transport: Option<bool>,
) -> Result<turso::DatabaseCheckResult, CommandError> {
    ensure_bootstrap_window_open(&state)?;
    let config = resolve_bootstrap_turso_config(
        &state,
        database_url,
        auth_token,
        provider,
        allow_insecure_transport,
    )?;
    let client = turso::TursoClient::from_config(&config, state.http.clone())?;
    let check = client.inspect_database().await?;
    if !check.superadmin_exists {
        return Err(CommandError::new(
            "TURSO_SUPERADMIN_MISSING",
            "Database ini belum memiliki Superadmin aktif. Lanjutkan provisioning untuk membuat akun pertama.",
        ));
    }
    state.set_database_config(&config)?;
    let _ = sync::pull_snapshot(&state, "").await;
    storage::audit(&state.data_dir, None, "bootstrap-database-linked", None);
    Ok(check)
}

/// Bolehkah akun ini masuk lewat jalur offline?
///
/// Jalur offline hanya memeriksa username + password terhadap snapshot vault.
/// Untuk akun ber-2FA itu berarti faktor kedua hilang seluruhnya, sehingga
/// perangkat yang punya cache offline justru menjadi cara termudah melewatinya.
///
/// Rahasia TOTP SENGAJA tidak ikut disimpan di vault supaya bisa diverifikasi
/// offline: vault dibuka dengan password akun itu sendiri, jadi penyerang yang
/// berhasil membukanya sudah melewati faktor pertama — menyimpan rahasianya di
/// sana membuat faktor kedua tidak menambah perlindungan apa pun. Yang benar
/// adalah menolak, lalu meminta satu kali koneksi.
///
/// Catatan: pada Mode Database Lokal batasan ini tidak pernah terasa, karena
/// `authenticate_operator` berjalan penuh terhadap berkas lokal — termasuk
/// verifikasi TOTP-nya.
fn assert_offline_login_allowed(operator: &OperatorUser) -> Result<(), CommandError> {
    if operator.totp_enabled {
        return Err(CommandError::new(
            "TOTP_REQUIRED_ONLINE",
            "Akun ini memakai verifikasi dua langkah, sehingga kodenya tidak dapat diperiksa saat perangkat sedang offline. Sambungkan perangkat ke database sekali untuk masuk.",
        ));
    }
    Ok(())
}

#[tauri::command]
pub async fn desktop_login(
    state: State<'_, DesktopState>,
    identifier: String,
    password: String,
    totp_code: Option<String>,
) -> Result<DesktopLoginResult, CommandError> {
    let identifier = identifier.trim().to_owned();
    if identifier.len() < 3 || identifier.len() > 64 || password.len() > 256 {
        return Err(CommandError::new(
            "LOGIN_REJECTED",
            "Username atau password tidak sesuai.",
        ));
    }
    ensure_login_not_locked(&state, &identifier)?;
    let password = Zeroizing::new(password);

    // Alasan kegagalan koneksi cloud, disimpan supaya pesan error terakhir bisa
    // menyebut penyebab sebenarnya. Dulu alasan ini dibuang, sehingga perangkat
    // yang kredensialnya menunjuk database Turso terhapus hanya melaporkan
    // "wajib login online minimal satu kali" — pesan yang membuat pengguna
    // mengira internetnya mati padahal internetnya aktif.
    let mut cloud_failure: Option<String> = None;

    // 1. Coba login online via Turso jika Turso Client tersedia
    if let Ok(turso) = state.get_turso_client() {
        // Mode Database Lokal tidak punya jaringan yang bisa gagal. Kegagalan di
        // sana berarti berkasnya bermasalah, dan menyamarkannya sebagai "cloud
        // tidak terjangkau" akan meneruskan login ke fallback offline — jalur
        // yang hanya memeriksa username + password.
        let backend_is_local = turso.is_local();
        match turso
            .authenticate_operator(&identifier, &password, totp_code.as_deref())
            .await
        {
            Ok(operator) => {
                storage::clear_login_failures(&state.data_dir, &identifier)?;
                let provisioned = secrets::provision(&state, operator.clone(), &password);
                let (offline_ready, offline_valid_until, mut message): (
                    bool,
                    Option<i64>,
                    String,
                ) = match provisioned {
                    Ok(credential) => (
                        true,
                        Some(credential.offline_valid_until),
                        "Login online database cloud berhasil. Akses offline perangkat berhasil diperbarui.".into(),
                    ),
                    Err(_) => (
                        false,
                        None,
                        "Login online berhasil, tetapi penyimpanan offline belum dapat diperbarui.".into(),
                    ),
                };

                if operator
                    .permissions
                    .iter()
                    .any(|permission| permission == "sync.view")
                {
                    match sync::synchronize(&state, "").await {
                        Ok(_) => {
                            message.push_str(" Data operasional lokal berhasil disinkronkan.");
                        }
                        Err(err) => {
                            eprintln!("[desktop_login] Sinkronisasi data cloud gagal: {:?}", err);
                        }
                    }
                }

                storage::audit(
                    &state.data_dir,
                    Some(operator.id),
                    "login-online-turso-success",
                    None,
                );

                *state.session.lock().map_err(|_| CommandError::internal())? =
                    Some(DesktopSession {
                        operator: operator.clone(),
                        token: Some(Zeroizing::new("turso-direct-session".into())),
                        mode: SessionMode::Online,
                    });

                return Ok(DesktopLoginResult {
                    sukses: true,
                    pesan: message,
                    operator,
                    mode: SessionMode::Online,
                    offline_ready,
                    offline_valid_until,
                });
            }
            Err(err) if err.code == "LOGIN_REJECTED" => {
                storage::audit(
                    &state.data_dir,
                    None,
                    "login-online-rejected",
                    Some(&err.code),
                );
                reject_login(&state, &identifier)?;
                return Err(err);
            }
            // Kegagalan 2FA BUKAN "cloud tidak terjangkau". Tanpa lengan ini
            // ketiga kode di bawah jatuh ke lengan Err umum, yang meneruskan
            // login ke fallback offline — dan fallback itu hanya memeriksa
            // username + password, sehingga verifikasi dua langkah terlewati
            // seluruhnya pada perangkat yang punya cache offline.
            Err(err)
                if matches!(
                    err.code,
                    "TOTP_REQUIRED" | "TOTP_INVALID" | "TOTP_ENROLLMENT_REQUIRED"
                ) =>
            {
                storage::audit(&state.data_dir, None, "login-online-totp", Some(&err.code));
                // Hanya kode yang SALAH yang dihitung sebagai percobaan gagal.
                // "Belum mengirim kode" adalah langkah normal alur login, dan
                // menghitungnya akan mengunci akun yang justru patuh memakai 2FA.
                if err.code == "TOTP_INVALID" {
                    reject_login(&state, &identifier)?;
                }
                return Err(err);
            }
            Err(err) => {
                storage::audit(
                    &state.data_dir,
                    None,
                    "login-online-turso-unavailable",
                    Some(&err.code),
                );
                // Tidak ada "offline" yang masuk akal pada berkas lokal:
                // laporkan kerusakannya apa adanya, jangan diam-diam turun ke
                // jalur yang lebih lemah.
                if backend_is_local {
                    return Err(err);
                }
                // Koneksi network Turso gagal, lanjut ke fallback di bawah
                cloud_failure = Some(err.message);
            }
        }
    }

    // 2. Login remote HTTP legacy — HANYA untuk instalasi yang memang memakai
    //    server aplikasi, bukan database langsung.
    //
    //    Saat database dikonfigurasi, `server_origin` menunjuk host database itu
    //    sendiri. Menjalankan fallback ini di sana berarti mem-POST username dan
    //    password plaintext ke `<host-database>/api/auth/login` — endpoint yang
    //    tidak pernah ada di sana. Pada Turso permintaan itu hanya 404, tetapi
    //    pada server libSQL milik pengguna, body request bisa ikut tercatat di
    //    log reverse proxy di depannya. Kredensial tidak boleh dikirim ke tempat
    //    yang bukan endpoint autentikasi.
    let legacy_http_login_available = state.turso_config().is_none();
    match if legacy_http_login_available {
        remote::login(&state, &identifier, &password).await
    } else {
        Err(RemoteLoginError::Unavailable)
    } {
        Ok(login) => {
            storage::clear_login_failures(&state.data_dir, &identifier)?;
            let provisioned = secrets::provision(&state, login.operator.clone(), &password);
            let (offline_ready, offline_valid_until, mut message) = match provisioned {
                Ok(credential) => (
                    true,
                    Some(credential.offline_valid_until),
                    format!(
                        "{} Akses offline perangkat berhasil diperbarui.",
                        login.message
                    ),
                ),
                Err(_) => (
                    false,
                    None,
                    format!(
                        "{} Penyimpanan offline belum dapat diperbarui.",
                        login.message
                    ),
                ),
            };
            if login
                .operator
                .permissions
                .iter()
                .any(|permission| permission == "sync.view")
                && sync::synchronize(&state, &login.token).await.is_ok()
            {
                message.push_str(" Data operasional lokal berhasil diperbarui.");
            }
            storage::audit(
                &state.data_dir,
                Some(login.operator.id),
                "login-online-success",
                None,
            );
            *state.session.lock().map_err(|_| CommandError::internal())? = Some(DesktopSession {
                operator: login.operator.clone(),
                token: Some(login.token),
                mode: SessionMode::Online,
            });
            return Ok(DesktopLoginResult {
                sukses: true,
                pesan: message,
                operator: login.operator,
                mode: SessionMode::Online,
                offline_ready,
                offline_valid_until,
            });
        }
        Err(RemoteLoginError::Rejected(error)) => {
            storage::audit(
                &state.data_dir,
                None,
                "login-online-rejected",
                Some(&error.code),
            );
            reject_login(&state, &identifier)?;
            return Err(error);
        }
        Err(RemoteLoginError::Unavailable) => {
            // Fallback offline
        }
    }

    // 3. Fallback offline credential snapshot
    let credential = match secrets::load_offline(&state, &identifier, &password) {
        Ok(credential) => credential,
        Err(error) => {
            if matches!(
                error.code,
                "OFFLINE_CREDENTIAL_INVALID" | "OFFLINE_SNAPSHOT_INVALID"
            ) {
                reject_login(&state, &identifier)?;
            }
            // Perangkat belum punya snapshot offline DAN database cloud memang
            // tidak menjawab: yang salah adalah konfigurasi database, bukan
            // koneksi internet pengguna. Sebutkan penyebab aslinya.
            if error.code == "OFFLINE_NOT_PROVISIONED" {
                if let Some(reason) = cloud_failure {
                    return Err(CommandError::new(
                        "TURSO_UNREACHABLE",
                        format!(
                            "Database cloud ({}) tidak dapat dihubungi, sehingga login pertama pada perangkat ini belum bisa dilakukan. Penyebab: {} Periksa kembali URL dan Auth Token database pada layar konfigurasi database.",
                            state.server_origin(),
                            reason,
                        ),
                    ));
                }
            }
            return Err(error);
        }
    };
    // Gerbang 2FA untuk jalur offline. Sampai di sini password sudah terbukti
    // benar terhadap vault — sama seperti pada jalur online, gerbang 2FA berdiri
    // SETELAH password, supaya layar login tidak bisa dipakai memetakan akun
    // mana yang memakai verifikasi dua langkah.
    if let Err(error) = assert_offline_login_allowed(&credential.operator) {
        storage::audit(
            &state.data_dir,
            Some(credential.operator.id),
            "login-offline-blocked-totp",
            Some(&error.code),
        );
        return Err(error);
    }

    storage::clear_login_failures(&state.data_dir, &identifier)?;
    storage::audit(
        &state.data_dir,
        Some(credential.operator.id),
        "login-offline-success",
        None,
    );
    *state.session.lock().map_err(|_| CommandError::internal())? = Some(DesktopSession {
        operator: credential.operator.clone(),
        token: None,
        mode: SessionMode::Offline,
    });
    Ok(DesktopLoginResult {
        sukses: true,
        pesan: "Database cloud tidak terjangkau. Login memakai snapshot offline tervalidasi."
            .into(),
        operator: credential.operator,
        mode: SessionMode::Offline,
        offline_ready: true,
        offline_valid_until: Some(credential.offline_valid_until),
    })
}

#[tauri::command]
pub async fn desktop_logout(state: State<'_, DesktopState>) -> Result<(), CommandError> {
    let previous = state
        .session
        .lock()
        .map_err(|_| CommandError::internal())?
        .take();
    if let Some(session) = previous {
        storage::audit(&state.data_dir, Some(session.operator.id), "logout", None);
        if let Some(token) = session.token {
            if token.as_str() != "turso-direct-session" {
                remote::logout(&state, &token).await;
            }
        }
    }
    Ok(())
}

/// Riwayat "Lupa Password".
///
/// Berbeda dengan command `desktop_password_reset_*` yang sengaja terbuka tanpa
/// sesi, membaca dan menghapus riwayat butuh izin: setiap baris menyimpan foto
/// wajah pemohon.
/// Setujui permintaan pemulihan password, lalu serahkan kodenya sekali.
///
/// Berbeda dari lima langkah `desktop_password_reset_*` lain yang sengaja
/// terbuka tanpa sesi, langkah ini menuntut izin: yang terjadi di sini adalah
/// menyerahkan kendali sebuah akun kepada orang yang berdiri di depan layar,
/// setelah peninjau melihat foto wajahnya.
#[tauri::command]
pub async fn desktop_password_reset_approve(
    state: State<'_, DesktopState>,
    request_id: String,
) -> Result<Value, CommandError> {
    let actor = require_permission(&state, "password_reset.approve")?;
    let hasil = state
        .get_turso_client()?
        .password_reset_approve(actor.id, request_id.trim())
        .await?;
    storage::audit(
        &state.data_dir,
        Some(actor.id),
        "password-reset-approved",
        Some(request_id.trim()),
    );
    Ok(hasil)
}

/// Jalur penyerahan token pemulihan yang berlaku pada instalasi ini.
///
/// Dibaca layar "Lupa Password" supaya pesannya benar sejak awal: menjanjikan
/// email pada pemasangan yang tidak punya jaringan hanya membuat pengguna
/// menunggu sesuatu yang tidak akan pernah datang.
/// Masuk kembali memakai kode pemulihan, lalu setel password baru.
///
/// Sengaja TANPA sesi, sama seperti lima langkah `desktop_password_reset_*`
/// lainnya: yang memakainya justru orang yang sedang terkunci di luar. Yang
/// menjaganya adalah kode sekali pakai itu sendiri — disimpan sebagai hash,
/// dihapus begitu dipakai.
#[tauri::command]
pub async fn desktop_password_recovery_with_code(
    state: State<'_, DesktopState>,
    identifier: String,
    code: String,
    new_password: String,
) -> Result<Value, CommandError> {
    ensure_login_not_locked(&state, identifier.trim())?;
    let hasil = state
        .get_turso_client()?
        .password_recovery_with_code(&identifier, &code, &new_password)
        .await;
    match hasil {
        Ok(value) => {
            storage::clear_login_failures(&state.data_dir, identifier.trim())?;
            storage::audit(&state.data_dir, None, "password-recovery-code-used", None);
            Ok(value)
        }
        Err(error) => {
            // Kode yang salah dihitung sebagai percobaan gagal: tanpa itu,
            // daftar kode 8 karakter bisa ditebak dengan mencoba terus-menerus.
            if error.code == "RECOVERY_REJECTED" {
                reject_login(&state, identifier.trim())?;
            }
            Err(error)
        }
    }
}

#[tauri::command]
pub async fn desktop_password_reset_route(
    state: State<'_, DesktopState>,
) -> Result<Value, CommandError> {
    let route = state.get_turso_client()?.password_reset_route().await?;
    Ok(json!({ "route": route }))
}

#[tauri::command]
pub async fn desktop_list_password_reset_history(
    state: State<'_, DesktopState>,
    status: Option<String>,
    search: Option<String>,
    limit: Option<i64>,
) -> Result<Value, CommandError> {
    require_permission(&state, "password_reset.view")?;
    state
        .get_turso_client()?
        .list_password_reset_history(
            status.as_deref().unwrap_or("SEMUA"),
            search.as_deref().unwrap_or(""),
            limit.unwrap_or(100),
        )
        .await
}

#[tauri::command]
pub async fn desktop_get_password_reset_photo(
    state: State<'_, DesktopState>,
    request_id: String,
) -> Result<Value, CommandError> {
    require_permission(&state, "password_reset.view")?;
    state
        .get_turso_client()?
        .get_password_reset_photo(&request_id)
        .await
}

#[tauri::command]
pub async fn desktop_delete_password_reset_history(
    state: State<'_, DesktopState>,
    request_id: String,
) -> Result<Value, CommandError> {
    require_permission(&state, "password_reset.delete")?;
    state
        .get_turso_client()?
        .delete_password_reset_history(&request_id)
        .await
}

#[tauri::command]
pub async fn desktop_purge_password_reset_history(
    state: State<'_, DesktopState>,
    older_than_days: i64,
) -> Result<Value, CommandError> {
    require_permission(&state, "password_reset.delete")?;
    state
        .get_turso_client()?
        .purge_password_reset_history(older_than_days)
        .await
}

/// Perintah alur "Lupa Password".

///
/// Sengaja TIDAK memakai `require_permission`: pemohon justru sedang terkunci
/// di luar akunnya sendiri, jadi tidak ada sesi yang bisa diperiksa. Penjaganya
/// adalah verifikasi wajah, urutan tantangan acak yang hanya diketahui
/// database, umur token yang pendek, dan penyerahan link lewat email pemilik
/// akun — bukan sesi.
#[tauri::command]
pub async fn desktop_password_reset_lookup(
    state: State<'_, DesktopState>,
    identifier: String,
) -> Result<Value, CommandError> {
    state.get_turso_client()?.password_reset_lookup(&identifier).await
}

#[tauri::command]
pub async fn desktop_password_reset_confirm(
    state: State<'_, DesktopState>,
    identifier: String,
    confirmation: String,
) -> Result<Value, CommandError> {
    state
        .get_turso_client()?
        .password_reset_confirm(&identifier, &confirmation)
        .await
}

#[tauri::command]
pub async fn desktop_password_reset_swap_challenge(
    state: State<'_, DesktopState>,
    request_id: String,
    challenge_token: String,
    step_index: i64,
) -> Result<Value, CommandError> {
    state
        .get_turso_client()?
        .password_reset_swap_challenge(&request_id, &challenge_token, step_index)
        .await
}

#[tauri::command]
pub async fn desktop_password_reset_verify(
    state: State<'_, DesktopState>,
    request_id: String,
    challenge_token: String,
    verdict: Value,
    photo_base64: String,
    photo_mime: String,
) -> Result<Value, CommandError> {
    state
        .get_turso_client()?
        .password_reset_verify(
            &request_id,
            &challenge_token,
            &verdict,
            &photo_base64,
            &photo_mime,
        )
        .await
}

#[tauri::command]
pub async fn desktop_password_reset_inspect(
    state: State<'_, DesktopState>,
    token: String,
) -> Result<Value, CommandError> {
    state.get_turso_client()?.password_reset_inspect(&token).await
}

#[tauri::command]
pub async fn desktop_password_reset_complete(
    state: State<'_, DesktopState>,
    token: String,
    password: String,
) -> Result<Value, CommandError> {
    let password = Zeroizing::new(password);
    state
        .get_turso_client()?
        .password_reset_complete(&token, &password)
        .await
}

#[tauri::command]
pub async fn desktop_send_test_mail(
    state: State<'_, DesktopState>,
) -> Result<Value, CommandError> {
    let actor = require_permission(&state, "settings.manage")?;
    state.get_turso_client()?.send_test_mail(actor.id).await
}

#[tauri::command]
pub async fn desktop_get_mail_config(
    state: State<'_, DesktopState>,
) -> Result<Value, CommandError> {
    require_permission(&state, "settings.manage")?;
    state.get_turso_client()?.get_mail_config().await
}

#[tauri::command]
pub async fn desktop_save_mail_config(
    state: State<'_, DesktopState>,
    draft: Value,
) -> Result<Value, CommandError> {
    let actor = require_permission(&state, "settings.manage")?;
    state
        .get_turso_client()?
        .save_mail_config(&draft, &actor.kode_operator)
        .await
}

/// Pengelolaan verifikasi dua langkah.
///
/// `status`, `begin`, `confirm`, dan `disable` selalu bekerja pada akun
/// PEMANGGIL — id operatornya diambil dari sesi, tidak pernah dari argumen.
/// Tanpa aturan itu, siapa pun yang punya sesi bisa mematikan 2FA milik orang
/// lain hanya dengan menebak id.
#[tauri::command]
pub async fn desktop_get_two_factor_status(
    state: State<'_, DesktopState>,
) -> Result<Value, CommandError> {
    let actor = require_session(&state)?;
    state
        .get_turso_client()?
        .get_two_factor_status(actor.id)
        .await
}

/// Terbitkan ulang kode pemulihan password untuk akun yang sedang login.
///
/// SENGAJA hanya untuk akun sendiri, diambil dari sesi — bukan dari id yang
/// dikirim pemanggil. Mencetak kode bagi akun orang lain berarti membuat kunci
/// cadangan ke akun itu, dan itu jalur pengambilalihan yang senyap: pemiliknya
/// tidak akan pernah tahu kuncinya pernah dibuat.
///
/// Akun Superadmin baru yang dibuat lewat Master Operator belum punya kode apa
/// pun sampai pemiliknya menerbitkannya sendiri dari sini.
#[tauri::command]
pub async fn desktop_issue_recovery_codes(
    state: State<'_, DesktopState>,
) -> Result<Value, CommandError> {
    let actor = require_session(&state)?;
    let codes = state
        .get_turso_client()?
        .issue_password_recovery_codes(actor.id)
        .await?;
    storage::audit(
        &state.data_dir,
        Some(actor.id),
        "password-recovery-codes-reissued",
        None,
    );
    Ok(json!({ "codes": codes }))
}

#[tauri::command]
pub async fn desktop_begin_two_factor_setup(
    state: State<'_, DesktopState>,
) -> Result<Value, CommandError> {
    let actor = require_session(&state)?;
    state
        .get_turso_client()?
        .begin_two_factor_setup(actor.id)
        .await
}

#[tauri::command]
pub async fn desktop_confirm_two_factor_setup(
    state: State<'_, DesktopState>,
    code: String,
) -> Result<Value, CommandError> {
    let actor = require_session(&state)?;
    state
        .get_turso_client()?
        .confirm_two_factor_setup(actor.id, &code)
        .await
}

#[tauri::command]
pub async fn desktop_disable_two_factor(
    state: State<'_, DesktopState>,
    code: String,
) -> Result<Value, CommandError> {
    let actor = require_session(&state)?;
    state
        .get_turso_client()?
        .disable_two_factor(actor.id, true, &code)
        .await
}

/// Mematikan 2FA operator lain — untuk operator yang kehilangan ponselnya.
/// Dijaga izin `two_factor.reset` yang masuk daftar mutasi sensitif.
#[tauri::command]
pub async fn desktop_admin_disable_two_factor(
    state: State<'_, DesktopState>,
    operator_id: i64,
) -> Result<Value, CommandError> {
    require_permission(&state, "two_factor.reset")?;
    state
        .get_turso_client()?
        .disable_two_factor(operator_id, false, "")
        .await
}

#[tauri::command]
pub async fn desktop_get_master_operators(
    state: State<'_, DesktopState>,
) -> Result<Value, CommandError> {
    require_permission(&state, "operators.view")?;
    if let Ok(turso) = state.get_turso_client() {
        return turso.get_master_operators().await;
    }
    let payload = secured_api(
        &state,
        "operators.view",
        Method::POST,
        "/api/operators/query",
        None,
    )
    .await?;
    Ok(payload
        .get("operators")
        .cloned()
        .unwrap_or_else(|| json!([])))
}

#[tauri::command]
pub async fn desktop_create_operator(
    state: State<'_, DesktopState>,
    draft: Value,
) -> Result<Value, CommandError> {
    require_permission(&state, "operators.manage")?;
    if let Ok(turso) = state.get_turso_client() {
        return turso.create_operator(&draft).await;
    }
    secured_api(
        &state,
        "operators.manage",
        Method::POST,
        "/api/operators",
        Some(json!({ "draft": draft })),
    )
    .await
}

#[tauri::command]
pub async fn desktop_update_operator(
    state: State<'_, DesktopState>,
    operator_id: i64,
    draft: Value,
) -> Result<Value, CommandError> {
    require_permission(&state, "operators.manage")?;
    if let Ok(turso) = state.get_turso_client() {
        return turso.update_operator(operator_id, &draft).await;
    }
    secured_api(
        &state,
        "operators.manage",
        Method::PATCH,
        "/api/operators",
        Some(json!({ "operatorId": operator_id, "draft": draft })),
    )
    .await
}

#[tauri::command]
pub async fn desktop_delete_operator(
    state: State<'_, DesktopState>,
    operator_id: i64,
) -> Result<Value, CommandError> {
    let actor = require_permission(&state, "operators.manage")?;
    if let Ok(turso) = state.get_turso_client() {
        return turso.delete_operator(actor.id, operator_id).await;
    }
    secured_api(
        &state,
        "operators.manage",
        Method::DELETE,
        "/api/operators",
        Some(json!({ "operatorId": operator_id })),
    )
    .await
}

#[tauri::command]
pub async fn desktop_get_roles(state: State<'_, DesktopState>) -> Result<Value, CommandError> {
    require_permission(&state, "roles.view")?;
    if let Ok(turso) = state.get_turso_client() {
        return turso.get_roles().await;
    }
    let payload = secured_api(&state, "roles.view", Method::POST, "/api/roles/query", None).await?;
    Ok(payload.get("roles").cloned().unwrap_or_else(|| json!([])))
}

#[tauri::command]
pub async fn desktop_create_role(
    state: State<'_, DesktopState>,
    draft: Value,
    permission_keys: Vec<String>,
) -> Result<Value, CommandError> {
    require_permission(&state, "roles.manage")?;
    if let Ok(turso) = state.get_turso_client() {
        let mut full_draft = draft.clone();
        full_draft["permissions"] = json!(permission_keys);
        return turso.create_role(&full_draft).await;
    }
    secured_api(
        &state,
        "roles.manage",
        Method::POST,
        "/api/roles",
        Some(json!({ "draft": draft, "permissionKeys": permission_keys })),
    )
    .await
}

#[tauri::command]
pub async fn desktop_update_role(
    state: State<'_, DesktopState>,
    role_id: i64,
    draft: Value,
) -> Result<Value, CommandError> {
    require_permission(&state, "roles.manage")?;
    if let Ok(turso) = state.get_turso_client() {
        return turso.update_role(role_id, &draft).await;
    }
    secured_api(
        &state,
        "roles.manage",
        Method::PATCH,
        "/api/roles",
        Some(json!({ "roleId": role_id, "draft": draft })),
    )
    .await
}

#[tauri::command]
pub async fn desktop_set_role_permissions(
    state: State<'_, DesktopState>,
    role_id: i64,
    permission_keys: Vec<String>,
) -> Result<Value, CommandError> {
    require_permission(&state, "roles.manage")?;
    if let Ok(turso) = state.get_turso_client() {
        return turso.set_role_permissions(role_id, &permission_keys).await;
    }
    secured_api(
        &state,
        "roles.manage",
        Method::PUT,
        "/api/roles",
        Some(json!({ "roleId": role_id, "permissionKeys": permission_keys })),
    )
    .await
}

#[tauri::command]
pub async fn desktop_delete_role(
    state: State<'_, DesktopState>,
    role_id: i64,
) -> Result<Value, CommandError> {
    require_permission(&state, "roles.manage")?;
    if let Ok(turso) = state.get_turso_client() {
        return turso.delete_role(role_id).await;
    }
    secured_api(
        &state,
        "roles.manage",
        Method::DELETE,
        "/api/roles",
        Some(json!({ "roleId": role_id })),
    )
    .await
}

#[tauri::command]
pub fn desktop_get_employees(
    state: State<'_, DesktopState>,
    filter: Value,
) -> Result<Value, CommandError> {
    require_permission(&state, "employees.view")?;
    operational::list_employees(&state, &filter)
}

#[tauri::command]
pub fn desktop_create_employee(
    state: State<'_, DesktopState>,
    draft: Value,
) -> Result<Value, CommandError> {
    require_permission(&state, "employees.manage")?;
    operational::create_employee(&state, &draft)
}

#[tauri::command]
pub fn desktop_import_employees(
    state: State<'_, DesktopState>,
    drafts: Vec<Value>,
) -> Result<Value, CommandError> {
    require_permission(&state, "employees.manage")?;
    operational::import_employees(&state, &drafts)
}

#[tauri::command]
pub fn desktop_update_employee(
    state: State<'_, DesktopState>,
    id_unik: String,
    draft: Value,
) -> Result<Value, CommandError> {
    require_permission(&state, "employees.manage")?;
    operational::update_employee(&state, &id_unik, &draft)
}

#[tauri::command]
pub fn desktop_set_employee_status(
    state: State<'_, DesktopState>,
    id_unik: String,
    status: String,
) -> Result<Value, CommandError> {
    require_permission(&state, "employees.manage")?;
    operational::set_employee_status(&state, &id_unik, &status)
}

#[tauri::command]
pub fn desktop_generate_employee_tokens(
    state: State<'_, DesktopState>,
) -> Result<Value, CommandError> {
    require_permission(&state, "employees.manage")?;
    operational::generate_employee_tokens(&state)
}

#[tauri::command]
pub fn desktop_get_shifts(state: State<'_, DesktopState>) -> Result<Value, CommandError> {
    require_permission(&state, "shifts.view")?;
    operational::list_shifts(&state)
}

#[tauri::command]
pub fn desktop_create_shift(
    state: State<'_, DesktopState>,
    draft: Value,
) -> Result<Value, CommandError> {
    require_permission(&state, "shifts.manage")?;
    operational::create_shift(&state, &draft)
}

#[tauri::command]
pub fn desktop_update_shift(
    state: State<'_, DesktopState>,
    shift_id: i64,
    draft: Value,
) -> Result<Value, CommandError> {
    require_permission(&state, "shifts.manage")?;
    operational::update_shift(&state, shift_id, &draft)
}

#[tauri::command]
pub fn desktop_delete_shift(
    state: State<'_, DesktopState>,
    shift_id: i64,
) -> Result<Value, CommandError> {
    require_permission(&state, "shifts.manage")?;
    operational::delete_shift(&state, shift_id)
}

#[tauri::command]
pub fn desktop_submit_qr_scan(
    state: State<'_, DesktopState>,
    input: Value,
) -> Result<Value, CommandError> {
    let operator = require_permission(&state, "scanner.use")?;
    // Kebijakan diambil dari sesi, bukan dari payload: terminal yang dikuasai
    // penyerang tidak boleh bisa mematikan kewajiban fotonya sendiri hanya
    // dengan tidak mengirimkan sakelarnya.
    let policy = scanner::ScanSecurityPolicy {
        require_photo: operator.require_scan_photo,
        require_ip_allowlist: operator.require_scan_ip_allowlist,
    };
    scanner::submit(&state, &input, &operator.kode_operator, policy)
}

/// Foto bukti absensi.
///
/// Dibaca langsung dari cloud, bukan dari SQLite lokal: foto sengaja TIDAK ikut
/// snapshot sync, jadi perangkat ini hanya menyimpan foto hasil scannya sendiri.
/// Meninjau bukti hanya berguna kalau yang terlihat adalah foto dari SEMUA
/// terminal.
#[tauri::command]
pub async fn desktop_list_attendance_photos(
    state: State<'_, DesktopState>,
    tanggal_mulai: Option<String>,
    tanggal_selesai: Option<String>,
    search: Option<String>,
    limit: Option<i64>,
) -> Result<Value, CommandError> {
    require_permission(&state, "attendance_photo.view")?;
    state
        .get_turso_client()?
        .list_attendance_photos(
            tanggal_mulai.as_deref().unwrap_or(""),
            tanggal_selesai.as_deref().unwrap_or(""),
            search.as_deref().unwrap_or(""),
            limit.unwrap_or(100),
        )
        .await
}

#[tauri::command]
pub async fn desktop_get_attendance_photo(
    state: State<'_, DesktopState>,
    photo_id: String,
) -> Result<Value, CommandError> {
    require_permission(&state, "attendance_photo.view")?;
    state
        .get_turso_client()?
        .get_attendance_photo(&photo_id)
        .await
}

#[tauri::command]
pub async fn desktop_delete_attendance_photo(
    state: State<'_, DesktopState>,
    photo_id: String,
) -> Result<Value, CommandError> {
    require_permission(&state, "attendance_photo.delete")?;
    let result = state
        .get_turso_client()?
        .delete_attendance_photo(&photo_id)
        .await?;
    // Salinan lokal ikut dihapus supaya perangkat yang mengambil fotonya tidak
    // tetap menyimpan bukti yang sudah dinyatakan dihapus.
    let connection = storage::database(&state.data_dir)?;
    let _ = connection.execute(
        "DELETE FROM absensi_foto WHERE id_foto = ?;",
        rusqlite::params![photo_id],
    );
    Ok(result)
}

#[tauri::command]
pub async fn desktop_purge_attendance_photos(
    state: State<'_, DesktopState>,
    older_than_days: i64,
) -> Result<Value, CommandError> {
    require_permission(&state, "attendance_photo.delete")?;
    let result = state
        .get_turso_client()?
        .purge_attendance_photos(older_than_days)
        .await?;
    let connection = storage::database(&state.data_dir)?;
    let _ = connection.execute(
        "DELETE FROM absensi_foto WHERE tanggal_kerja < date('now', ?);",
        rusqlite::params![format!("-{} day", older_than_days.max(0))],
    );
    Ok(result)
}

/// Pengaturan keamanan absensi: sakelar induk fitur + daftar IP.
///
/// Membacanya hanya butuh sesi yang sah, bukan Superadmin: halaman scanner
/// perlu tahu apakah fitur fotonya hidup supaya bisa menahan scan pada saat
/// yang tepat. Daftar alamat IP-nya sendiri hanya dikembalikan untuk
/// Superadmin — itu bagian yang layak dirahasiakan dari operator biasa.
#[tauri::command]
pub fn desktop_get_scan_security(state: State<'_, DesktopState>) -> Result<Value, CommandError> {
    let operator = require_session(&state)?;
    operational::get_scan_security(
        &state,
        operator.is_superadmin,
        operator.require_scan_photo,
        operator.require_scan_ip_allowlist,
    )
}

/// Mengubahnya sama ketatnya dengan pengaturan geofencing di sebelahnya: salah
/// satu dari keduanya bisa mengunci seluruh terminal di luar, jadi Superadmin.
#[tauri::command]
pub async fn desktop_update_scan_security(
    state: State<'_, DesktopState>,
    payload: Value,
) -> Result<Value, CommandError> {
    let operator = require_permission(&state, "settings.manage")?;
    if !operator.is_superadmin {
        return Err(CommandError::new(
            "DESKTOP_ACCESS_DENIED",
            "Pengaturan keamanan absensi hanya dapat diubah Superadmin.",
        ));
    }
    let data = payload.get("data").cloned().unwrap_or(payload);
    let result = operational::save_scan_security(&state, &data)?;
    let _ = sync::push_outbox(&state, &session_token(&state)).await;
    Ok(result)
}



#[tauri::command]
pub fn desktop_get_corrections(
    state: State<'_, DesktopState>,
    filter: Value,
) -> Result<Value, CommandError> {
    require_permission(&state, "corrections.view")?;
    administration::list_corrections(&state, &filter)
}

#[tauri::command]
pub fn desktop_create_correction(
    state: State<'_, DesktopState>,
    draft: Value,
) -> Result<Value, CommandError> {
    let operator = require_permission(&state, "corrections.manage")?;
    administration::create_correction(&state, &draft, &operator.kode_operator)
}

#[tauri::command]
pub fn desktop_get_backups(
    state: State<'_, DesktopState>,
    filter: Value,
) -> Result<Value, CommandError> {
    require_permission(&state, "backups.view")?;
    administration::list_backups(&state, &filter)
}

#[tauri::command]
pub fn desktop_create_backup(
    state: State<'_, DesktopState>,
    draft: Value,
) -> Result<Value, CommandError> {
    let operator = require_permission(&state, "backups.manage")?;
    administration::create_backup(&state, &draft, &operator.kode_operator)
}

#[tauri::command]
pub fn desktop_cancel_backup(
    state: State<'_, DesktopState>,
    id_backup: String,
) -> Result<Value, CommandError> {
    let operator = require_permission(&state, "backups.manage")?;
    administration::cancel_backup(&state, &id_backup, &operator.kode_operator)
}

#[tauri::command]
pub fn desktop_delete_correction(
    state: State<'_, DesktopState>,
    id_referensi: String,
) -> Result<Value, CommandError> {
    let operator = require_permission(&state, "operational.delete")?;
    administration::delete_correction(&state, &id_referensi, &operator.kode_operator)
}

#[tauri::command]
pub fn desktop_update_attendance(
    state: State<'_, DesktopState>,
    id_sesi: String,
    patch: Value,
) -> Result<Value, CommandError> {
    let operator = require_permission(&state, "history.edit")?;
    administration::update_attendance(&state, &id_sesi, &patch, &operator.kode_operator)
}

#[tauri::command]
pub fn desktop_delete_attendance(
    state: State<'_, DesktopState>,
    id_sesi: String,
) -> Result<Value, CommandError> {
    let operator = require_permission(&state, "history.delete")?;
    administration::delete_attendance(&state, &id_sesi, &operator.kode_operator)
}

#[tauri::command]
pub fn desktop_delete_log_scan(
    state: State<'_, DesktopState>,
    id_log: i64,
) -> Result<Value, CommandError> {
    let operator = require_permission(&state, "history.delete")?;
    administration::delete_log_scan(&state, id_log, &operator.kode_operator)
}

#[tauri::command]
pub fn desktop_delete_import_offline(
    state: State<'_, DesktopState>,
    event_key: String,
) -> Result<Value, CommandError> {
    let operator = require_permission(&state, "operational.delete")?;
    administration::delete_import_offline(&state, &event_key, &operator.kode_operator)
}

#[tauri::command]
pub fn desktop_get_imports(
    state: State<'_, DesktopState>,
    filter: Value,
) -> Result<Value, CommandError> {
    require_permission(&state, "corrections.view")?;
    administration::list_imports(&state, &filter)
}

#[tauri::command]
pub fn desktop_import_offline(
    state: State<'_, DesktopState>,
    rows: Vec<Value>,
) -> Result<Value, CommandError> {
    let operator = require_permission(&state, "corrections.manage")?;
    administration::import_offline(&state, &rows, &operator.kode_operator)
}

#[tauri::command]
pub fn desktop_get_dashboard_data(
    state: State<'_, DesktopState>,
    kind: String,
    filter: Value,
) -> Result<Value, CommandError> {
    if kind == "scan-history" {
        require_permission(&state, "home.view")?;
    } else {
        require_permission(&state, "dashboard.view")?;
    }
    administration::dashboard_data(&state, &kind, &filter)
}

#[tauri::command]
pub fn desktop_get_id_cards(
    state: State<'_, DesktopState>,
    filter: Value,
) -> Result<Value, CommandError> {
    require_permission(&state, "employees.manage")?;
    operational::list_id_cards(&state, &filter)
}

#[tauri::command]
pub fn desktop_update_id_card(
    state: State<'_, DesktopState>,
    draft: Value,
) -> Result<Value, CommandError> {
    require_permission(&state, "employees.manage")?;
    operational::update_id_card(&state, &draft)
}

#[tauri::command]
pub fn desktop_get_geofence_settings(
    state: State<'_, DesktopState>,
) -> Result<Value, CommandError> {
    let operator = require_permission(&state, "branding.manage")?;
    if !operator.is_superadmin {
        return Err(CommandError::new(
            "DESKTOP_ACCESS_DENIED",
            "Pengaturan geofencing hanya dapat diakses Superadmin.",
        ));
    }
    operational::get_geofence_settings(&state)
}

#[tauri::command]
pub async fn desktop_update_geofence_settings(
    state: State<'_, DesktopState>,
    settings: Value,
) -> Result<Value, CommandError> {
    let operator = require_permission(&state, "branding.manage")?;
    if !operator.is_superadmin {
        return Err(CommandError::new(
            "DESKTOP_ACCESS_DENIED",
            "Pengaturan geofencing hanya dapat diakses Superadmin.",
        ));
    }
    let data = settings.get("data").cloned().unwrap_or(settings);
    operational::save_geofence_settings(&state, &data)?;
    let _ = sync::push_outbox(&state, &session_token(&state)).await;
    Ok(data)
}

#[tauri::command]
pub fn desktop_get_scanner_settings(state: State<'_, DesktopState>) -> Result<Value, CommandError> {
    let operator = require_permission(&state, "branding.manage")?;
    if !operator.is_superadmin {
        return Err(CommandError::new(
            "DESKTOP_ACCESS_DENIED",
            "Pengaturan keamanan scanner hanya dapat diakses Superadmin.",
        ));
    }
    operational::get_scanner_settings(&state)
}

#[tauri::command]
pub async fn desktop_update_scanner_settings(
    state: State<'_, DesktopState>,
    settings: Value,
) -> Result<Value, CommandError> {
    let operator = require_permission(&state, "branding.manage")?;
    if !operator.is_superadmin {
        return Err(CommandError::new(
            "DESKTOP_ACCESS_DENIED",
            "Pengaturan keamanan scanner hanya dapat diakses Superadmin.",
        ));
    }
    let data = settings.get("data").cloned().unwrap_or(settings);
    operational::save_scanner_settings(&state, &data)?;
    let _ = sync::push_outbox(&state, &session_token(&state)).await;
    Ok(data)
}

#[tauri::command]
pub fn desktop_get_app_display_name(state: State<'_, DesktopState>) -> Result<String, CommandError> {
    operational::get_app_display_name(&state)
}

/// Menyamakan judul jendela dengan nama aplikasi yang diatur customer.
///
/// Judul pada `tauri.conf.json` hanya nilai awal yang dipanggang saat build,
/// jadi tanpa ini nama baru tidak akan pernah terlihat di bilah judul tanpa
/// build ulang. Kegagalannya sengaja diabaikan: nama merek yang tidak terbaca
/// tidak boleh menggagalkan startup, dan pada Mobile memang tidak ada jendela
/// berjudul yang bisa diubah.
pub fn apply_window_title(app: &AppHandle, state: &DesktopState) {
    let Ok(name) = operational::get_app_display_name(state) else {
        return;
    };
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_title(&name);
    }
}

#[tauri::command]
pub async fn desktop_update_app_display_name(
    app: AppHandle,
    state: State<'_, DesktopState>,
    name: String,
) -> Result<String, CommandError> {
    require_permission(&state, "settings.manage")?;
    let saved = operational::save_app_display_name(&state, &name)?;
    apply_window_title(&app, &state);
    let _ = sync::push_outbox(&state, &session_token(&state)).await;
    Ok(saved)
}

#[tauri::command]
pub fn desktop_get_sync_status(
    state: State<'_, DesktopState>,
) -> Result<DesktopSyncStatus, CommandError> {
    require_permission(&state, "sync.view")?;
    sync::status(&state)
}

#[tauri::command]
pub async fn desktop_sync_now(
    state: State<'_, DesktopState>,
) -> Result<DesktopSyncStatus, CommandError> {
    // Pesan dibuat spesifik: role tanpa `sync.view` membuat auto-sync berhenti
    // total, dan gejalanya di lapangan hanya "data tidak masuk" tanpa petunjuk.
    require_permission(&state, "sync.view").map_err(|error| {
        if error.code == "DESKTOP_ACCESS_DENIED" {
            CommandError::new(
                "DESKTOP_ACCESS_DENIED",
                "Role akun ini tidak memiliki permission 'sync.view', sehingga sinkronisasi otomatis tidak dapat berjalan. Tambahkan permission tersebut pada role di menu Master Operator.",
            )
        } else {
            error
        }
    })?;
    // Token hanya relevan untuk jalur HTTP legacy. Pada arsitektur 2-tier,
    // `sync::synchronize` bicara langsung ke Turso dan tidak memerlukan token
    // sama sekali. Dulu perintah ini menolak sesi tanpa token, sehingga siapa
    // pun yang pernah login lewat snapshot offline (token = None) tidak pernah
    // lagi auto-sync sampai logout — persis gejala "push & pull mati".
    let token = session_token(&state);
    if token.is_empty() && state.turso_config().is_none() {
        return Err(CommandError::new(
            "DESKTOP_ONLINE_REQUIRED",
            "Database cloud belum dikonfigurasi dan sesi ini tidak punya token online. Sinkronisasi tidak dapat dijalankan.",
        ));
    }
    let result = sync::synchronize(&state, &token).await;
    if let Err(error) = &result {
        clear_expired_session(&state, error);
    }
    result
}

#[tauri::command]
pub fn desktop_get_sync_conflicts(state: State<'_, DesktopState>) -> Result<Value, CommandError> {
    require_permission(&state, "sync.view")?;
    sync::conflicts(&state)
}

#[tauri::command]
pub async fn desktop_retry_failed_sync(
    state: State<'_, DesktopState>,
    event_id: Option<String>,
) -> Result<DesktopSyncStatus, CommandError> {
    require_permission(&state, "sync.retry")?;
    sync::retry_failed(&state, event_id.as_deref())?;
    desktop_sync_now(state).await
}

#[tauri::command]
pub async fn desktop_resolve_sync_conflicts(
    state: State<'_, DesktopState>,
    event_id: Option<String>,
) -> Result<DesktopSyncStatus, CommandError> {
    require_permission(&state, "sync.retry")?;
    sync::resolve_conflicts(&state, event_id.as_deref())?;
    desktop_sync_now(state).await
}

#[tauri::command]
pub async fn desktop_resolve_sync_conflicts_local(
    state: State<'_, DesktopState>,
    event_id: Option<String>,
) -> Result<DesktopSyncStatus, CommandError> {
    require_permission(&state, "sync.retry")?;
    sync::resolve_conflicts_local(&state, event_id.as_deref())?;
    desktop_sync_now(state).await
}

#[tauri::command]
pub fn desktop_clear_failed_sync(
    state: State<'_, DesktopState>,
    event_id: Option<String>,
) -> Result<DesktopSyncStatus, CommandError> {
    require_permission(&state, "sync.retry")?;
    sync::clear_failed(&state, event_id.as_deref())?;
    desktop_get_sync_status(state)
}

/// Keluarkan seluruh isi database lokal ke satu berkas cadangan.
///
/// Frasa sandi kosong menghasilkan berkas SQLite polos. Itu sah — berguna untuk
/// diagnosa karena bisa dibuka di DB Browser — tetapi berkasnya memuat hash
/// password, rahasia TOTP, dan foto absensi, sehingga UI WAJIB memperingatkan
/// pengguna sebelum memilihnya.
#[tauri::command]
pub fn desktop_export_database(
    state: State<'_, DesktopState>,
    passphrase: Option<String>,
) -> Result<portability::ExportReport, CommandError> {
    let operator = require_permission(&state, "database_backup.export")?;
    let report = portability::export_database(&state, passphrase.as_deref())?;
    storage::audit(
        &state.data_dir,
        Some(operator.id),
        if report.encrypted {
            "database-export-encrypted"
        } else {
            "database-export-plaintext"
        },
        Some(&report.file_name),
    );
    Ok(report)
}

/// Ganti isi database lokal dengan isi berkas cadangan.
///
/// Ini MENIMPA seluruh data perangkat, bukan menggabungkannya — karena itu
/// izinnya masuk `SENSITIVE_MUTATION_PERMISSIONS`. Berkas lama tetap disimpan
/// berdampingan oleh `portability::import_database`, sehingga salah pilih
/// berkas masih bisa dibatalkan secara manual.
#[tauri::command]
pub fn desktop_import_database(
    state: State<'_, DesktopState>,
    source_path: String,
    passphrase: Option<String>,
) -> Result<portability::ImportReport, CommandError> {
    let operator = require_permission(&state, "database_backup.restore")?;
    let report = portability::import_database(
        &state,
        std::path::Path::new(source_path.trim()),
        passphrase.as_deref(),
    )?;
    storage::audit(
        &state.data_dir,
        Some(operator.id),
        "database-restore",
        Some(&format!("schema v{}", report.schema_version)),
    );
    Ok(report)
}

/// Pulihkan dari berkas yang dipilih lewat `<input type="file">`.
///
/// Android tidak pernah menyerahkan path sebenarnya kepada halaman web, jadi
/// tanpa jalur ini pemulihan mustahil dilakukan di Mobile. Validasinya sama
/// persis dengan jalur berbasis path — datangnya berkas dari pemilih berkas
/// bukan alasan untuk melonggarkan pemeriksaan apa pun.
#[tauri::command]
pub fn desktop_import_database_bytes(
    state: State<'_, DesktopState>,
    file_name: String,
    base64_data: String,
    passphrase: Option<String>,
) -> Result<portability::ImportReport, CommandError> {
    let operator = require_permission(&state, "database_backup.restore")?;
    let payload = BASE64_STANDARD
        .decode(base64_data.trim())
        .map_err(|_| CommandError::new("BACKUP_CORRUPT", "Isi berkas cadangan tidak dapat dibaca."))?;
    let report = portability::import_database_bytes(
        &state,
        &payload,
        file_name.trim(),
        passphrase.as_deref(),
    )?;
    storage::audit(
        &state.data_dir,
        Some(operator.id),
        "database-restore-upload",
        Some(&format!("schema v{}", report.schema_version)),
    );
    Ok(report)
}

/// Lokasi folder data aplikasi, untuk ditampilkan di layar Cadangan.
///
/// Pada Desktop pengguna bisa membukanya sendiri di file explorer dan menyalin
/// berkasnya secara manual — asalkan aplikasi ditutup lebih dulu. Pada Android
/// folder ini privat dan tidak terjangkau, sehingga UI mengarahkan penggunanya
/// ke tombol Bagikan.
#[tauri::command]
pub fn desktop_get_data_folder(state: State<'_, DesktopState>) -> Result<Value, CommandError> {
    require_permission(&state, "database_backup.export")?;
    Ok(json!({
        "dataDir": state.data_dir.to_string_lossy(),
        "hubPath": state.local_hub_path().to_string_lossy(),
    }))
}

#[tauri::command]
pub fn desktop_save_file(filename: String, base64_data: String) -> Result<Value, CommandError> {
    operational::save_desktop_file(&filename, &base64_data)
}

#[tauri::command]
pub fn desktop_get_holidays(state: State<'_, DesktopState>) -> Result<Value, CommandError> {
    require_permission(&state, "holidays.view")?;
    operational::list_holidays(&state)
}

#[tauri::command]
pub fn desktop_create_holiday(
    state: State<'_, DesktopState>,
    draft: Value,
) -> Result<Value, CommandError> {
    require_permission(&state, "holidays.manage")?;
    operational::create_holiday(&state, &draft)
}

#[tauri::command]
pub fn desktop_update_holiday(
    state: State<'_, DesktopState>,
    holiday_id: i64,
    draft: Value,
) -> Result<Value, CommandError> {
    require_permission(&state, "holidays.manage")?;
    operational::update_holiday(&state, holiday_id, &draft)
}

#[tauri::command]
pub fn desktop_delete_holiday(
    state: State<'_, DesktopState>,
    holiday_id: i64,
) -> Result<Value, CommandError> {
    require_permission(&state, "holidays.manage")?;
    operational::delete_holiday(&state, holiday_id)
}

/// Whitelist Shift/Divisi hari libur.
///
/// Membacanya memakai izin `holidays.view` dan mengubahnya `holidays.manage`,
/// sama persis dengan hari liburnya sendiri: daftar ini adalah bagian dari
/// kebijakan hari libur, bukan kewenangan terpisah.
#[tauri::command]
pub fn desktop_get_holiday_whitelist(
    state: State<'_, DesktopState>,
) -> Result<Value, CommandError> {
    require_permission(&state, "holidays.view")?;
    operational::list_holiday_whitelist(&state)
}

#[tauri::command]
pub fn desktop_create_holiday_whitelist(
    state: State<'_, DesktopState>,
    draft: Value,
) -> Result<Value, CommandError> {
    require_permission(&state, "holidays.manage")?;
    operational::create_holiday_whitelist(&state, &draft)
}

#[tauri::command]
pub fn desktop_update_holiday_whitelist(
    state: State<'_, DesktopState>,
    whitelist_id: String,
    draft: Value,
) -> Result<Value, CommandError> {
    require_permission(&state, "holidays.manage")?;
    operational::update_holiday_whitelist(&state, &whitelist_id, &draft)
}

#[tauri::command]
pub fn desktop_delete_holiday_whitelist(
    state: State<'_, DesktopState>,
    whitelist_id: String,
) -> Result<Value, CommandError> {
    require_permission(&state, "holidays.manage")?;
    operational::delete_holiday_whitelist(&state, &whitelist_id)
}

#[tauri::command]
pub fn desktop_get_alfa_settings(state: State<'_, DesktopState>) -> Result<Value, CommandError> {
    operational::get_alfa_settings(&state)
}

#[tauri::command]
pub async fn desktop_save_alfa_settings(
    state: State<'_, DesktopState>,
    enabled: bool,
) -> Result<Value, CommandError> {
    require_permission(&state, "settings.manage")?;
    let res = operational::save_alfa_settings(&state, enabled)?;
    let _ = sync::push_outbox(&state, &session_token(&state)).await;
    Ok(res)
}

#[tauri::command]
pub fn desktop_trigger_generate_alfa(
    state: State<'_, DesktopState>,
    simulated_time: Option<String>,
) -> Result<Value, CommandError> {
    require_permission(&state, "alfa.trigger")?;
    operational::generate_alfa_harian(&state, simulated_time)
}

#[tauri::command]
pub fn desktop_get_attendance_audit(
    state: State<'_, DesktopState>,
    tanggal: Option<String>,
) -> Result<Value, CommandError> {
    require_permission(&state, "attendance_audit.view")?;
    operational::get_attendance_audit(&state, tanggal)
}

#[tauri::command]
pub fn desktop_get_server_url(state: State<'_, DesktopState>) -> Result<String, CommandError> {
    Ok(state.server_origin())
}

#[tauri::command]
pub fn desktop_set_server_url(
    state: State<'_, DesktopState>,
    url: String,
) -> Result<String, CommandError> {
    state.set_server_url(&url)
}

#[tauri::command]
pub fn desktop_get_company_profile(state: State<'_, DesktopState>) -> Result<Value, CommandError> {
    require_permission(&state, "settings.manage")?;
    operational::get_company_profile(&state)
}

#[tauri::command]
pub fn desktop_update_company_profile(
    state: State<'_, DesktopState>,
    profile: Value,
) -> Result<Value, CommandError> {
    require_permission(&state, "settings.manage")?;
    operational::update_company_profile(&state, &profile)
}

#[tauri::command]
pub fn desktop_get_id_card_template(
    state: State<'_, DesktopState>,
    id: Option<String>,
) -> Result<Value, CommandError> {
    operational::get_id_card_template(&state, id.as_deref().unwrap_or("default_template"))
}

#[tauri::command]
pub fn desktop_save_id_card_template(
    state: State<'_, DesktopState>,
    template: Value,
) -> Result<Value, CommandError> {
    require_permission(&state, "employees.manage")?;
    operational::save_id_card_template(&state, &template)
}

#[tauri::command]
pub async fn desktop_force_resync_settings(
    state: State<'_, DesktopState>,
) -> Result<Value, CommandError> {
    require_permission(&state, "sync.view")?;
    let token = session_token(&state);
    if token.is_empty() && state.turso_config().is_none() {
        return Err(CommandError::new(
            "DESKTOP_ONLINE_REQUIRED",
            "Database cloud belum dikonfigurasi dan sesi ini tidak punya token online. Sinkronisasi tidak dapat dijalankan.",
        ));
    }

    // Enqueue ulang pengaturan dari data lokal
    let enqueue_result = operational::force_enqueue_settings(&state)?;

    // Langsung sinkronisasi ke server
    let sync_result = sync::synchronize(&state, &token).await;
    if let Err(error) = &sync_result {
        clear_expired_session(&state, error);
    }
    let status = sync_result?;

    Ok(json!({
        "enqueue": enqueue_result,
        "status": status,
    }))
}

#[tauri::command]
pub async fn desktop_debug_template_sync(
    state: State<'_, DesktopState>,
) -> Result<Value, CommandError> {
    let local_tpl = operational::get_id_card_template(&state, "default_template")?;
    let cloud_tpl: Option<Value> = if let Ok(turso) = state.get_turso_client() {
        turso.query_one(
            "SELECT id, name, orientation, front_bg_url, back_bg_url, elements_json, is_active, updated_at FROM id_card_template WHERE id = 'default_template';",
            vec![],
        ).await.ok().and_then(|res| res.to_objects().into_iter().next().map(|map| json!(map)))
    } else {
        None
    };
    Ok(json!({
        "local": local_tpl,
        "cloud": cloud_tpl,
    }))
}

#[tauri::command]
pub fn desktop_get_turso_url(
    state: State<'_, DesktopState>,
) -> Result<Option<String>, CommandError> {
    let operator = require_permission(&state, "settings.view")?;
    if !operator.is_superadmin {
        return Err(CommandError::new(
            "DESKTOP_ACCESS_DENIED",
            "Informasi konfigurasi database cloud hanya dapat diakses Superadmin.",
        ));
    }
    Ok(state.turso_config().map(|c| c.database_url))
}

/// Ringkasan konfigurasi database aktif untuk halaman Pengaturan.
///
/// `desktop_get_turso_url` hanya mengembalikan URL, sehingga UI tidak punya cara
/// mengetahui provider mana yang aktif dan selalu menampilkan ulang formulir
/// dalam mode Turso — termasuk pada perangkat yang justru terhubung ke server
/// LAN. Auth Token tetap tidak pernah ikut keluar dari vault.
#[tauri::command]
pub fn desktop_get_database_config(
    state: State<'_, DesktopState>,
) -> Result<turso::DatabaseConfigView, CommandError> {
    let operator = require_permission(&state, "settings.view")?;
    if !operator.is_superadmin {
        return Err(CommandError::new(
            "DESKTOP_ACCESS_DENIED",
            "Informasi konfigurasi database hanya dapat diakses Superadmin.",
        ));
    }
    Ok(state
        .turso_config()
        .as_ref()
        .map(turso::DatabaseConfigView::from_config)
        .unwrap_or_else(turso::DatabaseConfigView::empty))
}

#[tauri::command]
pub async fn desktop_save_turso_config(
    state: State<'_, DesktopState>,
    database_url: String,
    auth_token: String,
    provider: Option<turso::DatabaseProvider>,
    allow_insecure_transport: Option<bool>,
) -> Result<String, CommandError> {
    let operator = require_permission(&state, "settings.manage")?;
    if !operator.is_superadmin {
        return Err(CommandError::new(
            "DESKTOP_ACCESS_DENIED",
            "Hanya Superadmin yang berhak mengubah konfigurasi database cloud.",
        ));
    }
    // Provider yang tidak dikirim mewarisi pilihan tersimpan supaya klien lama
    // yang hanya mengirim url+token tidak diam-diam menurunkan konfigurasi
    // server sendiri menjadi Turso — yang akan langsung menolak alamat LAN-nya.
    let stored = state.turso_config();
    let provider = provider
        .or_else(|| stored.as_ref().map(|config| config.provider))
        .unwrap_or_default();
    let allow_insecure_transport = allow_insecure_transport
        .or_else(|| {
            stored
                .as_ref()
                .map(|config| config.allow_insecure_transport)
        })
        .unwrap_or(false);
    let origin = state.set_database_config(&turso::TursoConfig::new(
        database_url,
        auth_token,
        provider,
        allow_insecure_transport,
    ))?;
    let _ = sync::pull_snapshot(&state, "").await;
    Ok(origin)
}

#[tauri::command]
pub async fn desktop_test_turso_connection(
    state: State<'_, DesktopState>,
    database_url: Option<String>,
    auth_token: Option<String>,
    provider: Option<turso::DatabaseProvider>,
    allow_insecure_transport: Option<bool>,
) -> Result<turso::TursoConnectionStatus, CommandError> {
    let operator = require_permission(&state, "settings.view")?;
    if !operator.is_superadmin {
        return Err(CommandError::new(
            "DESKTOP_ACCESS_DENIED",
            "Tes koneksi database cloud hanya dapat dilakukan oleh Superadmin.",
        ));
    }

    let stored = state.turso_config();
    let config = if let Some(u) = database_url.as_ref().filter(|u| !u.trim().is_empty()) {
        let provider = provider
            .or_else(|| stored.as_ref().map(|config| config.provider))
            .unwrap_or_default();
        let allow_insecure_transport = allow_insecure_transport
            .or_else(|| {
                stored
                    .as_ref()
                    .map(|config| config.allow_insecure_transport)
            })
            .unwrap_or(false);
        // Perbandingan URL wajib ternormalisasi. Versi lama menyamakan string
        // mentah, jadi menekan "Tes Koneksi" setelah mengetik ulang URL yang sama
        // dengan ejaan berbeda mengirim token kosong dan selalu gagal.
        let auth_token = if let Some(t) = auth_token.as_ref().filter(|t| !t.trim().is_empty()) {
            t.trim().to_owned()
        } else {
            stored
                .as_ref()
                .filter(|config| config.matches_url(u))
                .map(|config| config.auth_token.clone())
                .unwrap_or_default()
        };

        turso::TursoConfig::new(
            u.trim().to_owned(),
            auth_token,
            provider,
            allow_insecure_transport,
        )
    } else if let Some(cfg) = stored {
        cfg
    } else {
        return Err(CommandError::new(
            "TURSO_NOT_CONFIGURED",
            "Database Cloud Turso belum dikonfigurasi.",
        ));
    };

    let client = match turso::TursoClient::from_config(&config, state.http.clone()) {
        Ok(c) => c,
        Err(e) => {
            return Ok(turso::TursoConnectionStatus {
                connected: false,
                url: config.database_url,
                latency_ms: None,
                error_message: Some(e.message),
            });
        }
    };

    match client.ping().await {
        Ok(latency_ms) => Ok(turso::TursoConnectionStatus {
            connected: true,
            url: client.base_url().to_string(),
            latency_ms: Some(latency_ms),
            error_message: None,
        }),
        Err(e) => Ok(turso::TursoConnectionStatus {
            connected: false,
            url: client.base_url().to_string(),
            latency_ms: None,
            error_message: Some(e.message),
        }),
    }
}

#[tauri::command]
pub fn desktop_clear_turso_config(state: State<'_, DesktopState>) -> Result<(), CommandError> {
    let operator = require_permission(&state, "settings.manage")?;
    if !operator.is_superadmin {
        return Err(CommandError::new(
            "DESKTOP_ACCESS_DENIED",
            "Hanya Superadmin yang berhak mereset konfigurasi database cloud.",
        ));
    }
    secrets::clear_turso_config(&state)?;
    storage::set_system_setting(&state.data_dir, "turso_database_url", "")?;
    storage::set_system_setting(&state.data_dir, "turso_auth_token", "")?;
    storage::set_system_setting(&state.data_dir, "turso_database_provider", "")?;
    storage::set_system_setting(&state.data_dir, "turso_allow_insecure_transport", "")?;
    *state
        .turso_config
        .write()
        .map_err(|_| CommandError::internal())? = None;
    Ok(())
}

#[cfg(test)]
mod tests_offline_login {
    use super::*;

    /// Regresi: provisioning Mode Database Lokal pernah berhenti dengan
    /// "Alamat database wajib diisi" pada perangkat baru.
    ///
    /// Formulirnya memang tidak menampilkan kolom alamat — mode lokal tidak
    /// punya alamat — sehingga frontend mengirim string kosong. Versi
    /// sebelumnya memeriksa alamat SEBELUM melihat provider, jadi pengguna
    /// diminta mengisi sesuatu yang tidak pernah bisa diisi.
    #[test]
    fn mode_lokal_tidak_menuntut_alamat_saat_provisioning() {
        let directory = tempfile::tempdir().expect("direktori sementara");
        storage::initialize(directory.path()).expect("skema lokal");
        let state = DesktopState {
            server_origin: std::sync::RwLock::new("http://localhost:3000".to_string()),
            offline_max_age_hours: 24,
            data_dir: directory.path().to_path_buf(),
            http: reqwest::Client::new(),
            turso_config: std::sync::RwLock::new(None),
            session: std::sync::Mutex::new(None),
            vault_lock: std::sync::Mutex::new(()),
        };

        let config = resolve_bootstrap_turso_config(
            &state,
            Some(String::new()),
            Some(String::new()),
            Some(turso::DatabaseProvider::LocalFile),
            Some(false),
        )
        .expect("mode lokal harus diterima tanpa alamat");

        assert!(config.provider.is_local_file());
        assert!(!config.requires_auth_token());
        assert_eq!(
            config.local_file_path().expect("lokasi hub"),
            state.local_hub_path(),
            "lokasi hub bawaan harus sama dengan yang dipakai set_database_config"
        );
    }

    /// Provider selain lokal TETAP menuntut alamat: perangkat yang belum
    /// dikonfigurasi tidak punya database untuk diperiksa.
    #[test]
    fn provider_remote_tetap_menuntut_alamat() {
        let directory = tempfile::tempdir().expect("direktori sementara");
        storage::initialize(directory.path()).expect("skema lokal");
        let state = DesktopState {
            server_origin: std::sync::RwLock::new("http://localhost:3000".to_string()),
            offline_max_age_hours: 24,
            data_dir: directory.path().to_path_buf(),
            http: reqwest::Client::new(),
            turso_config: std::sync::RwLock::new(None),
            session: std::sync::Mutex::new(None),
            vault_lock: std::sync::Mutex::new(()),
        };

        let error = resolve_bootstrap_turso_config(
            &state,
            Some(String::new()),
            None,
            Some(turso::DatabaseProvider::Turso),
            None,
        )
        .expect_err("Turso tanpa alamat harus ditolak");
        assert_eq!(error.code, "TURSO_NOT_CONFIGURED");
    }

    fn operator(totp_enabled: bool) -> OperatorUser {
        OperatorUser {
            id: 7,
            kode_operator: "OP-007".into(),
            nama_operator: "Operator Uji".into(),
            username: "operator.uji".into(),
            role: "Operator".into(),
            role_id: 2,
            role_key: "operator".into(),
            is_superadmin: false,
            permissions: vec!["sync.view".into()],
            permission_revision: 1,
            require_scan_photo: false,
            require_scan_ip_allowlist: false,
            totp_enabled,
            login_at: None,
        }
    }

    /// Jalur offline hanya memeriksa username + password. Tanpa gerbang ini,
    /// perangkat yang punya cache offline menjadi cara termudah melewati 2FA.
    #[test]
    fn akun_ber_2fa_ditolak_pada_jalur_offline() {
        let error =
            assert_offline_login_allowed(&operator(true)).expect_err("harus ditolak");
        assert_eq!(error.code, "TOTP_REQUIRED_ONLINE");
    }

    #[test]
    fn akun_tanpa_2fa_tetap_boleh_masuk_offline() {
        assert!(assert_offline_login_allowed(&operator(false)).is_ok());
    }

    /// Kode penolakannya WAJIB berbeda dari ketiga kode 2FA jalur online.
    /// Ketiganya sudah punya penanganan khusus di frontend — memakai kode yang
    /// sama akan memunculkan layar "masukkan kode" yang tidak akan pernah bisa
    /// diselesaikan pengguna selama perangkatnya offline.
    /// Frontend menyalakan layar "masukkan kode" dengan MENCOCOKKAN TEKS pesan
    /// (`desktop-session-store.ts`), bukan kode error. Pesan penolakan offline
    /// karena itu tidak boleh memuat frasa pemicunya: kalau memuat, pengguna
    /// akan disodori kolom kode yang tidak akan pernah bisa diselesaikan selama
    /// perangkatnya offline.
    #[test]
    fn pesan_offline_tidak_memuat_frasa_pemicu_layar_kode() {
        let error =
            assert_offline_login_allowed(&operator(true)).expect_err("harus ditolak");
        for frasa in ["aplikasi autentikator", "kode 6 digit"] {
            assert!(
                !error.message.contains(frasa),
                "pesan offline tidak boleh memuat frasa pemicu: {frasa}"
            );
        }
    }

    #[test]
    fn kode_penolakan_offline_tidak_bentrok_dengan_kode_2fa_online() {
        let error =
            assert_offline_login_allowed(&operator(true)).expect_err("harus ditolak");
        for online_code in ["TOTP_REQUIRED", "TOTP_INVALID", "TOTP_ENROLLMENT_REQUIRED"] {
            assert_ne!(error.code, online_code);
        }
    }
}
