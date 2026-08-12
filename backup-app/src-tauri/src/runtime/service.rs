use crate::desktop_config::resolve_provisioned_runtime_env;
use std::{
    fs,
    fs::OpenOptions,
    net::TcpListener,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::Mutex,
    thread::sleep,
    time::Duration,
};

use rand::{distributions::Alphanumeric, Rng};
use tauri::{AppHandle, Manager, Runtime, State, Url};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

const DEFAULT_LOOPBACK_HOST: &str = "127.0.0.1";
const DEFAULT_PREFERRED_PORT: u16 = 3310;
const BOOTSTRAP_WINDOW_LABEL: &str = "main";
const STARTUP_MAX_ATTEMPTS: usize = 40;
const STARTUP_SLEEP_MS: u64 = 500;
const DESKTOP_LOOPBACK_QUERY_TOKEN: &str = "hybrid_starter_desktop_token";
const DESKTOP_LOOPBACK_ENV_TOKEN: &str = "HYBRID_STARTER_DESKTOP_LOOPBACK_TOKEN";
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Clone, serde::Deserialize, serde::Serialize)]
pub struct DesktopRuntimeBootstrapConfig {
    pub strategy: String,
    pub loopback_host: String,
    pub preferred_port: u16,
    pub health_path: String,
    pub warmup_path: String,
    pub expected_runtime: String,
    pub release_ready: bool,
}

#[derive(Clone, serde::Deserialize, serde::Serialize)]
pub struct DesktopRuntimeBootstrapHealth {
    pub ok: bool,
    pub status_code: Option<u16>,
    pub url: String,
    pub message: String,
}

#[derive(Clone, serde::Deserialize, serde::Serialize)]
pub struct DesktopRuntimeBootstrapEnsureResult {
    pub ok: bool,
    pub phase: String,
    pub action: String,
    pub message: String,
    pub config: DesktopRuntimeBootstrapConfig,
    pub health: DesktopRuntimeBootstrapHealth,
}

#[derive(Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct EmbeddedRuntimeBundleConfig {
    host: String,
    port: u16,
    node_binary: String,
    server_entrypoint: String,
    app_dir: String,
    bundle_archive: String,
    bundle_version: String,
    env: std::collections::HashMap<String, String>,
}

#[derive(Default)]
pub struct DesktopRuntimeManagerState {
    inner: Mutex<DesktopRuntimeManager>,
}

#[derive(Default)]
struct DesktopRuntimeManager {
    child: Option<Child>,
    active_port: Option<u16>,
    desktop_session_token: Option<String>,
    last_error: Option<String>,
}

fn preferred_port() -> u16 {
    DEFAULT_PREFERRED_PORT
}

fn should_manage_embedded_runtime() -> bool {
    !cfg!(debug_assertions)
        || std::env::var("HYBRID_STARTER_DESKTOP_BOOTSTRAP_DEV")
            .map(|value| value == "1" || value.eq_ignore_ascii_case("true"))
            .unwrap_or(false)
}

fn build_base_url(config: &DesktopRuntimeBootstrapConfig) -> String {
    format!("http://{}:{}", config.loopback_host, config.preferred_port)
}

fn build_window_entry_url(
    config: &DesktopRuntimeBootstrapConfig,
    state: &DesktopRuntimeManagerState,
) -> String {
    let base_url = build_base_url(config);
    let desktop_session_token = state
        .inner
        .lock()
        .ok()
        .and_then(|manager| manager.desktop_session_token.clone());

    match desktop_session_token {
        Some(token) if !token.trim().is_empty() => {
            format!("{base_url}/?{DESKTOP_LOOPBACK_QUERY_TOKEN}={token}")
        }
        _ => base_url,
    }
}

fn build_health_url(config: &DesktopRuntimeBootstrapConfig) -> String {
    format!("{}{}", build_base_url(config), config.health_path)
}

fn navigate_main_window_to_runtime<R: Runtime>(
    app_handle: &AppHandle<R>,
    config: &DesktopRuntimeBootstrapConfig,
    state: &DesktopRuntimeManagerState,
) -> Result<(), String> {
    let runtime_url = build_window_entry_url(config, state);
    let parsed = Url::parse(&runtime_url)
        .map_err(|error| format!("URL runtime desktop tidak valid: {error}"))?;
    let Some(window) = app_handle.get_webview_window(BOOTSTRAP_WINDOW_LABEL) else {
        return Err("Window utama Tauri tidak ditemukan.".to_string());
    };

    window
        .navigate(parsed)
        .map_err(|error| format!("Gagal mengarahkan window ke loopback runtime: {error}"))?;
    window
        .show()
        .map_err(|error| format!("Gagal menampilkan window utama: {error}"))?;

    Ok(())
}

fn generate_desktop_session_token() -> String {
    rand::thread_rng()
        .sample_iter(&Alphanumeric)
        .take(48)
        .map(char::from)
        .collect()
}

fn sanitize_node_options(input: Option<&str>, storage_file: &Path) -> String {
    let mut sanitized_tokens: Vec<String> = Vec::new();
    let mut has_localstorage_option = false;

    for token in input
        .unwrap_or_default()
        .split_whitespace()
        .map(str::trim)
        .filter(|token| !token.is_empty())
    {
        if token == "--localstorage-file" {
            has_localstorage_option = true;
            continue;
        }

        if let Some(raw_value) = token.strip_prefix("--localstorage-file=") {
            has_localstorage_option = true;
            if !raw_value.trim().is_empty() {
                sanitized_tokens.push(token.to_string());
            }
            continue;
        }

        sanitized_tokens.push(token.to_string());
    }

    let storage_token = format!("--localstorage-file={}", storage_file.display());
    if !has_localstorage_option
        || !sanitized_tokens
            .iter()
            .any(|token| token.starts_with("--localstorage-file="))
    {
        sanitized_tokens.push(storage_token);
    }

    sanitized_tokens.join(" ")
}

fn desktop_runtime_resource_dir<R: Runtime>(app_handle: &AppHandle<R>) -> Result<PathBuf, String> {
    let resource_dir = app_handle
        .path()
        .resource_dir()
        .map_err(|error| format!("Gagal membaca resource dir Tauri: {error}"))?;

    Ok(resource_dir.join("desktop-runtime"))
}

fn runtime_bundle_config_path<R: Runtime>(app_handle: &AppHandle<R>) -> Result<PathBuf, String> {
    Ok(desktop_runtime_resource_dir(app_handle)?.join("runtime-config.json"))
}

fn runtime_log_dir<R: Runtime>(app_handle: &AppHandle<R>) -> Result<PathBuf, String> {
    let dir = app_handle
        .path()
        .app_log_dir()
        .map_err(|error| format!("Gagal membaca app_log_dir desktop runtime: {error}"))?;

    if !dir.exists() {
        fs::create_dir_all(&dir).map_err(|error| {
            format!(
                "Gagal membuat app_log_dir desktop runtime di {}: {error}",
                dir.display()
            )
        })?;
    }

    Ok(dir)
}

fn runtime_bundle_archive_path<R: Runtime>(
    app_handle: &AppHandle<R>,
    bundle_config: &EmbeddedRuntimeBundleConfig,
) -> Result<PathBuf, String> {
    Ok(desktop_runtime_resource_dir(app_handle)?.join(&bundle_config.bundle_archive))
}

fn load_embedded_runtime_bundle_config<R: Runtime>(
    app_handle: &AppHandle<R>,
) -> Result<EmbeddedRuntimeBundleConfig, String> {
    let config_path = runtime_bundle_config_path(app_handle)?;
    let config_text = fs::read_to_string(&config_path).map_err(|error| {
        format!(
            "Gagal membaca desktop runtime config di {}: {error}",
            config_path.display()
        )
    })?;

    serde_json::from_str(&config_text).map_err(|error| {
        format!(
            "Desktop runtime config tidak valid di {}: {error}",
            config_path.display()
        )
    })
}

fn resolve_bootstrap_config<R: Runtime>(
    app_handle: &AppHandle<R>,
    state: &DesktopRuntimeManagerState,
) -> DesktopRuntimeBootstrapConfig {
    let resource_config = load_embedded_runtime_bundle_config(app_handle).ok();
    let loopback_host = resource_config
        .as_ref()
        .map(|config| config.host.clone())
        .filter(|host| !host.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_LOOPBACK_HOST.to_string());

    let default_port = resource_config
        .as_ref()
        .map(|config| config.port)
        .unwrap_or_else(preferred_port);

    let active_port = state
        .inner
        .lock()
        .ok()
        .and_then(|manager| manager.active_port)
        .unwrap_or(default_port);

    let embedded_release_ready = resource_config.is_some();

    DesktopRuntimeBootstrapConfig {
        strategy: "embedded-local-web-server".to_string(),
        loopback_host: loopback_host.clone(),
        preferred_port: active_port,
        health_path: "/api/runtime/health".to_string(),
        warmup_path: "/api/runtime/warmup".to_string(),
        expected_runtime: if embedded_release_ready {
            "desktop-production-server".to_string()
        } else {
            "next-app-server".to_string()
        },
        release_ready: embedded_release_ready,
    }
}

fn select_loopback_port(host: &str, preferred: u16) -> Result<u16, String> {
    if let Ok(listener) = TcpListener::bind((host, preferred)) {
        drop(listener);
        return Ok(preferred);
    }

    let listener = TcpListener::bind((host, 0))
        .map_err(|error| format!("Gagal mencari port loopback kosong: {error}"))?;
    let selected = listener
        .local_addr()
        .map_err(|error| format!("Gagal membaca port loopback terpilih: {error}"))?
        .port();
    drop(listener);
    Ok(selected)
}

fn set_bootstrap_window_state<R: Runtime>(
    app_handle: &AppHandle<R>,
    state: &str,
    title: &str,
    detail: &str,
) {
    if let Some(window) = app_handle.get_webview_window(BOOTSTRAP_WINDOW_LABEL) {
        let payload = serde_json::json!({
            "state": state,
            "title": title,
            "detail": detail,
        });

        let script = format!(
            "window.__HYBRID_STARTER_BOOTSTRAP__ && window.__HYBRID_STARTER_BOOTSTRAP__.setState({payload});",
            payload = payload
        );

        let _ = window.eval(script.as_str());
    }
}

fn resolve_runtime_paths<R: Runtime>(
    app_handle: &AppHandle<R>,
    bundle_config: &EmbeddedRuntimeBundleConfig,
) -> Result<(PathBuf, PathBuf, PathBuf), String> {
    let runtime_root = ensure_extracted_runtime_bundle(app_handle, bundle_config)?;
    let node_path = runtime_root.join(&bundle_config.node_binary);
    let app_dir = runtime_root.join(&bundle_config.app_dir);
    let server_path = runtime_root.join(&bundle_config.server_entrypoint);

    if !node_path.is_file() {
        return Err(format!(
            "Executable embedded runtime tidak ditemukan di {}.",
            node_path.display()
        ));
    }

    if !app_dir.is_dir() {
        return Err(format!(
            "Direktori app embedded runtime tidak ditemukan di {}.",
            app_dir.display()
        ));
    }

    if !server_path.is_file() {
        return Err(format!(
            "Entrypoint embedded runtime tidak ditemukan di {}.",
            server_path.display()
        ));
    }

    Ok((node_path, app_dir, server_path))
}

fn resolve_runtime_localstorage_file(app_dir: &Path) -> Result<PathBuf, String> {
    let next_dir = app_dir.join(".next");
    fs::create_dir_all(&next_dir).map_err(|error| {
        format!(
            "Gagal menyiapkan direktori .next embedded runtime di {}: {error}",
            next_dir.display()
        )
    })?;

    Ok(next_dir.join("node-localstorage"))
}

fn open_runtime_log_file(path: &Path) -> Result<fs::File, String> {
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|error| {
            format!(
                "Gagal membuka file log runtime di {}: {error}",
                path.display()
            )
        })
}

fn extracted_runtime_root<R: Runtime>(
    app_handle: &AppHandle<R>,
    bundle_config: &EmbeddedRuntimeBundleConfig,
) -> Result<PathBuf, String> {
    let app_local_data_dir = app_handle
        .path()
        .app_local_data_dir()
        .map_err(|error| format!("Gagal membaca app local data dir: {error}"))?;

    Ok(app_local_data_dir
        .join("embedded-runtime")
        .join(&bundle_config.bundle_version))
}

fn ensure_extracted_runtime_bundle<R: Runtime>(
    app_handle: &AppHandle<R>,
    bundle_config: &EmbeddedRuntimeBundleConfig,
) -> Result<PathBuf, String> {
    let runtime_root = extracted_runtime_root(app_handle, bundle_config)?;
    let marker_path = runtime_root.join(".extract-complete");
    if marker_path.is_file() {
        return Ok(runtime_root);
    }

    let archive_path = runtime_bundle_archive_path(app_handle, bundle_config)?;
    if !archive_path.is_file() {
        return Err(format!(
            "Archive embedded runtime tidak ditemukan di {}.",
            archive_path.display()
        ));
    }

    if runtime_root.exists() {
        fs::remove_dir_all(&runtime_root).map_err(|error| {
            format!(
                "Gagal membersihkan cache embedded runtime di {}: {error}",
                runtime_root.display()
            )
        })?;
    }

    fs::create_dir_all(&runtime_root).map_err(|error| {
        format!(
            "Gagal membuat cache embedded runtime di {}: {error}",
            runtime_root.display()
        )
    })?;

    let archive_file = fs::File::open(&archive_path).map_err(|error| {
        format!(
            "Gagal membuka archive embedded runtime di {}: {error}",
            archive_path.display()
        )
    })?;

    let mut archive = tar::Archive::new(archive_file);
    archive.unpack(&runtime_root).map_err(|error| {
        format!(
            "Gagal mengekstrak embedded runtime ke {}: {error}",
            runtime_root.display()
        )
    })?;

    fs::write(&marker_path, &bundle_config.bundle_version).map_err(|error| {
        format!(
            "Gagal menulis marker extract embedded runtime di {}: {error}",
            marker_path.display()
        )
    })?;

    Ok(runtime_root)
}

fn kill_child_process(child: &mut Child) -> Result<(), String> {
    child
        .kill()
        .map_err(|error| format!("Gagal menghentikan embedded runtime: {error}"))?;
    let _ = child.wait();
    Ok(())
}

fn spawn_embedded_runtime<R: Runtime>(
    app_handle: &AppHandle<R>,
    state: &DesktopRuntimeManagerState,
    config: &DesktopRuntimeBootstrapConfig,
) -> Result<String, String> {
    let bundle_config = load_embedded_runtime_bundle_config(app_handle)?;
    let provisioned_env = resolve_provisioned_runtime_env(app_handle)?;
    let (node_path, app_dir, server_path) = resolve_runtime_paths(app_handle, &bundle_config)?;
    let localstorage_file = resolve_runtime_localstorage_file(&app_dir)?;
    let log_dir = runtime_log_dir(app_handle)?;
    let stdout_log_path = log_dir.join("embedded-runtime.stdout.log");
    let stderr_log_path = log_dir.join("embedded-runtime.stderr.log");
    let selected_port = select_loopback_port(&config.loopback_host, bundle_config.port)?;
    let desktop_session_token = generate_desktop_session_token();

    let mut command = Command::new(&node_path);
    command.arg(&server_path);
    command.current_dir(&app_dir);
    command.stdin(Stdio::null());
    command.stdout(Stdio::from(open_runtime_log_file(&stdout_log_path)?));
    command.stderr(Stdio::from(open_runtime_log_file(&stderr_log_path)?));
    #[cfg(target_os = "windows")]
    command.creation_flags(CREATE_NO_WINDOW);

    for (key, value) in &bundle_config.env {
        command.env(key, value);
    }
    let sanitized_node_options = sanitize_node_options(
        std::env::var("NODE_OPTIONS").ok().as_deref(),
        &localstorage_file,
    );
    command.env("NODE_OPTIONS", sanitized_node_options);
    command.env("AUTH_DATABASE_URL", &provisioned_env.auth_database_url);
    command.env(
        "AUTH_DATABASE_AUTH_TOKEN",
        &provisioned_env.auth_database_auth_token,
    );
    command.env("SYNC_DATABASE_URL", &provisioned_env.sync_database_url);
    command.env(
        "SYNC_DATABASE_AUTH_TOKEN",
        &provisioned_env.sync_database_auth_token,
    );
    command.env("AUTH_SECRET", &provisioned_env.auth_secret);
    command.env("NEXTAUTH_SECRET", &provisioned_env.auth_secret);
    command.env("HYBRID_STARTER_DEVICE_ID", &provisioned_env.device_id);

    command.env("HOSTNAME", &config.loopback_host);
    command.env("PORT", selected_port.to_string());
    command.env(
        "AUTH_URL",
        format!("http://{}:{}", config.loopback_host, selected_port),
    );
    command.env(
        "NEXTAUTH_URL",
        format!("http://{}:{}", config.loopback_host, selected_port),
    );
    command.env(DESKTOP_LOOPBACK_ENV_TOKEN, &desktop_session_token);

    log::info!(
        "[DesktopRuntime] Spawning embedded runtime: node={} server={} cwd={} stdout_log={} stderr_log={} port={}",
        node_path.display(),
        server_path.display(),
        app_dir.display(),
        stdout_log_path.display(),
        stderr_log_path.display(),
        selected_port
    );

    let child = command.spawn().map_err(|error| {
        format!(
            "Gagal menjalankan embedded runtime di {}: {error}",
            server_path.display()
        )
    })?;

    let mut manager = state
        .inner
        .lock()
        .map_err(|_| "Mutex desktop runtime manager rusak.".to_string())?;
    if let Some(existing_child) = manager.child.as_mut() {
        let _ = kill_child_process(existing_child);
    }
    manager.child = Some(child);
    manager.active_port = Some(selected_port);
    manager.desktop_session_token = Some(desktop_session_token);
    manager.last_error = None;

    Ok(format!(
        "spawned:{}",
        format!("http://{}:{}", config.loopback_host, selected_port)
    ))
}

fn stop_embedded_runtime_internal(state: &DesktopRuntimeManagerState) -> Result<(), String> {
    let mut manager = state
        .inner
        .lock()
        .map_err(|_| "Mutex desktop runtime manager rusak.".to_string())?;

    if let Some(mut child) = manager.child.take() {
        kill_child_process(&mut child)?;
    }

    manager.active_port = None;
    manager.desktop_session_token = None;
    manager.last_error = None;
    Ok(())
}

fn mark_runtime_error(state: &DesktopRuntimeManagerState, message: String) {
    if let Ok(mut manager) = state.inner.lock() {
        manager.last_error = Some(message);
        manager.active_port = None;
        manager.desktop_session_token = None;
        manager.child = None;
    }
}

fn check_child_exited(state: &DesktopRuntimeManagerState) -> Result<Option<String>, String> {
    let mut manager = state
        .inner
        .lock()
        .map_err(|_| "Mutex desktop runtime manager rusak.".to_string())?;

    let Some(child) = manager.child.as_mut() else {
        return Ok(None);
    };

    let maybe_status = child
        .try_wait()
        .map_err(|error| format!("Gagal mengecek status embedded runtime: {error}"))?;

    if let Some(status) = maybe_status {
        manager.child = None;
        manager.active_port = None;
        manager.desktop_session_token = None;
        let message = format!("Embedded runtime berhenti lebih awal dengan status {status}.");
        log::error!("[DesktopRuntime] {message}");
        manager.last_error = Some(message.clone());
        return Ok(Some(message));
    }

    Ok(None)
}

async fn probe_runtime_bootstrap_health_for_config(
    config: &DesktopRuntimeBootstrapConfig,
) -> Result<DesktopRuntimeBootstrapHealth, String> {
    let url = build_health_url(config);

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .map_err(|error| format!("Gagal membuat HTTP client bootstrap: {error}"))?;

    let response = match client.get(&url).send().await {
        Ok(response) => response,
        Err(error) => {
            return Ok(DesktopRuntimeBootstrapHealth {
                ok: false,
                status_code: None,
                url,
                message: format!("Loopback runtime belum reachable: {error}"),
            });
        }
    };

    let status_code = response.status().as_u16();
    if !response.status().is_success() {
        return Ok(DesktopRuntimeBootstrapHealth {
            ok: false,
            status_code: Some(status_code),
            url,
            message: format!("Loopback runtime merespons status {status_code}."),
        });
    }

    let payload = response.text().await.unwrap_or_default();
    let looks_healthy = payload.contains("\"ok\":true")
        && payload.contains(config.expected_runtime.as_str())
        && (payload.contains("\"db\":\"ready\"")
            || payload.contains("\"db\":\"deferred-local-runtime\""));

    Ok(DesktopRuntimeBootstrapHealth {
        ok: looks_healthy,
        status_code: Some(status_code),
        url,
        message: if looks_healthy {
            "Loopback runtime sehat.".to_string()
        } else {
            "Loopback runtime merespons, tetapi payload health belum sesuai.".to_string()
        },
    })
}

async fn ensure_runtime_bootstrap_ready_internal<R: Runtime>(
    app_handle: &AppHandle<R>,
    state: &DesktopRuntimeManagerState,
    allow_spawn: bool,
) -> Result<DesktopRuntimeBootstrapEnsureResult, String> {
    let mut config = resolve_bootstrap_config(app_handle, state);
    let health = probe_runtime_bootstrap_health_for_config(&config).await?;

    if health.ok {
        return Ok(DesktopRuntimeBootstrapEnsureResult {
            ok: true,
            phase: "ready".to_string(),
            action: "none".to_string(),
            message: "Desktop embedded runtime sudah reachable.".to_string(),
            config,
            health,
        });
    }

    if !allow_spawn {
        return Ok(DesktopRuntimeBootstrapEnsureResult {
            ok: false,
            phase: "not-started".to_string(),
            action: "probe-only".to_string(),
            message: "Loopback runtime belum siap dan startup manager sedang berjalan pada mode probe-only.".to_string(),
            config,
            health,
        });
    }

    if !should_manage_embedded_runtime() {
        return Ok(DesktopRuntimeBootstrapEnsureResult {
            ok: false,
            phase: "development-bypass".to_string(),
            action: "spawn-skipped".to_string(),
            message: "Embedded runtime production is managed in packaged builds or when HYBRID_STARTER_DESKTOP_BOOTSTRAP_DEV=true.".to_string(),
            config,
            health,
        });
    }

    set_bootstrap_window_state(
        app_handle,
        "loading",
        "Menjalankan embedded app server...",
        "Startup manager native sedang menyiapkan runtime desktop production.",
    );

    let spawn_action = spawn_embedded_runtime(app_handle, state, &config)?;
    config = resolve_bootstrap_config(app_handle, state);

    for attempt in 1..=STARTUP_MAX_ATTEMPTS {
        let detail = format!(
            "Memeriksa health loopback {} (percobaan {attempt}/{STARTUP_MAX_ATTEMPTS}).",
            build_health_url(&config)
        );
        set_bootstrap_window_state(app_handle, "loading", "Menunggu runtime siap...", &detail);

        if let Some(message) = check_child_exited(state)? {
            set_bootstrap_window_state(
                app_handle,
                "error",
                "Runtime berhenti terlalu cepat.",
                &message,
            );
            return Ok(DesktopRuntimeBootstrapEnsureResult {
                ok: false,
                phase: "spawn-failed".to_string(),
                action: spawn_action,
                message,
                config: config.clone(),
                health: DesktopRuntimeBootstrapHealth {
                    ok: false,
                    status_code: None,
                    url: build_health_url(&config),
                    message: "Embedded runtime mati sebelum health check sehat.".to_string(),
                },
            });
        }

        let current_health = probe_runtime_bootstrap_health_for_config(&config).await?;
        if current_health.ok {
            return Ok(DesktopRuntimeBootstrapEnsureResult {
                ok: true,
                phase: "ready".to_string(),
                action: spawn_action,
                message: "Embedded runtime berhasil dijalankan dan lolos health check loopback."
                    .to_string(),
                config,
                health: current_health,
            });
        }

        sleep(Duration::from_millis(STARTUP_SLEEP_MS));
    }

    let timeout_message = "Embedded runtime tidak sehat sebelum timeout startup.".to_string();
    let _ = stop_embedded_runtime_internal(state);
    mark_runtime_error(state, timeout_message.clone());
    set_bootstrap_window_state(
        app_handle,
        "error",
        "Runtime timeout saat startup.",
        &timeout_message,
    );

    Ok(DesktopRuntimeBootstrapEnsureResult {
        ok: false,
        phase: "startup-timeout".to_string(),
        action: spawn_action,
        message: timeout_message,
        config: config.clone(),
        health: DesktopRuntimeBootstrapHealth {
            ok: false,
            status_code: None,
            url: build_health_url(&config),
            message: "Embedded runtime belum sehat sampai batas waktu startup habis.".to_string(),
        },
    })
}

pub fn setup_desktop_runtime<R: Runtime>(app_handle: &AppHandle<R>) -> Result<(), String> {
    if !should_manage_embedded_runtime() {
        if let Some(window) = app_handle.get_webview_window(BOOTSTRAP_WINDOW_LABEL) {
            let _ = window.show();
        }
        return Ok(());
    }

    let state = app_handle.state::<DesktopRuntimeManagerState>();
    let Some(window) = app_handle.get_webview_window(BOOTSTRAP_WINDOW_LABEL) else {
        return Err("Window utama Tauri tidak ditemukan.".to_string());
    };

    let _ = window.hide();
    set_bootstrap_window_state(
        app_handle,
        "loading",
        "Menyiapkan runtime desktop...",
        "Shell Tauri menunggu embedded server lokal sehat sebelum UI utama dibuka.",
    );

    let result = tauri::async_runtime::block_on(ensure_runtime_bootstrap_ready_internal(
        app_handle, &state, true,
    ))?;

    if !result.ok {
        log::error!(
            "[DesktopRuntime] Bootstrap failed. phase={} action={} message={}",
            result.phase,
            result.action,
            result.message
        );
        set_bootstrap_window_state(
            app_handle,
            "error",
            "Bootstrap desktop gagal.",
            &result.message,
        );
        let _ = window.show();
        return Err(result.message);
    }

    navigate_main_window_to_runtime(app_handle, &result.config, &state)?;

    Ok(())
}

pub fn shutdown_desktop_runtime<R: Runtime>(app_handle: &AppHandle<R>) -> Result<(), String> {
    let state = app_handle.state::<DesktopRuntimeManagerState>();
    stop_embedded_runtime_internal(&state)
}

#[tauri::command]
pub async fn get_runtime_bootstrap_config<R: Runtime>(
    app_handle: tauri::AppHandle<R>,
    state: State<'_, DesktopRuntimeManagerState>,
) -> Result<DesktopRuntimeBootstrapConfig, String> {
    Ok(resolve_bootstrap_config(&app_handle, &state))
}

#[tauri::command]
pub async fn probe_runtime_bootstrap_health<R: Runtime>(
    app_handle: tauri::AppHandle<R>,
    state: State<'_, DesktopRuntimeManagerState>,
) -> Result<DesktopRuntimeBootstrapHealth, String> {
    let config = resolve_bootstrap_config(&app_handle, &state);
    probe_runtime_bootstrap_health_for_config(&config).await
}

#[tauri::command]
pub async fn ensure_runtime_bootstrap_ready<R: Runtime>(
    app_handle: tauri::AppHandle<R>,
    state: State<'_, DesktopRuntimeManagerState>,
) -> Result<DesktopRuntimeBootstrapEnsureResult, String> {
    let result = ensure_runtime_bootstrap_ready_internal(&app_handle, &state, true).await?;

    if result.ok {
        set_bootstrap_window_state(
            &app_handle,
            "loading",
            "Runtime desktop sehat.",
            "Bootstrap native selesai. Window akan memakai loopback runtime lokal.",
        );
        navigate_main_window_to_runtime(&app_handle, &result.config, &state)?;
    } else if should_manage_embedded_runtime() {
        set_bootstrap_window_state(
            &app_handle,
            "error",
            "Runtime desktop belum siap.",
            &result.message,
        );
    }

    Ok(result)
}
