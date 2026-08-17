use reqwest::Method;
use serde_json::{json, Value};
use tauri::State;
use zeroize::Zeroizing;

use super::{
    administration,
    config::DesktopState,
    models::{
        CommandError, DesktopLoginResult, DesktopRuntimeStatus, DesktopSession, DesktopSyncStatus,
        OperatorUser, SessionMode,
    },
    operational,
    remote::{self, RemoteLoginError},
    scanner, secrets, storage, sync,
};

struct OnlineAccess {
    token: Zeroizing<String>,
}

fn require_permission(
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
    if !session
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

fn clear_expired_session(state: &DesktopState, error: &CommandError) {
    if error.code == "DESKTOP_SESSION_EXPIRED" {
        if let Ok(mut session) = state.session.lock() {
            *session = None;
        }
    }
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
        server_origin: state.server_origin.clone(),
        offline_max_age_hours: state.offline_max_age_hours,
        has_active_session: session.is_some(),
        mode: session.as_ref().map(|session| session.mode),
    })
}

#[tauri::command]
pub async fn desktop_login(
    state: State<'_, DesktopState>,
    identifier: String,
    password: String,
) -> Result<DesktopLoginResult, CommandError> {
    let identifier = identifier.trim().to_owned();
    if identifier.len() < 3 || identifier.len() > 64 || password.len() > 256 {
        return Err(CommandError::new(
            "LOGIN_REJECTED",
            "Username atau password tidak sesuai.",
        ));
    }
    let password = Zeroizing::new(password);

    match remote::login(&state, &identifier, &password).await {
        Ok(login) => {
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
            Ok(DesktopLoginResult {
                sukses: true,
                pesan: message,
                operator: login.operator,
                mode: SessionMode::Online,
                offline_ready,
                offline_valid_until,
            })
        }
        Err(RemoteLoginError::Rejected(error)) => {
            storage::audit(
                &state.data_dir,
                None,
                "login-online-rejected",
                Some(error.code),
            );
            Err(error)
        }
        Err(RemoteLoginError::Unavailable) => {
            let credential = secrets::load_offline(&state, &identifier, &password)?;
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
                pesan: "Server tidak terjangkau. Login memakai snapshot offline tervalidasi."
                    .into(),
                operator: credential.operator,
                mode: SessionMode::Offline,
                offline_ready: true,
                offline_valid_until: Some(credential.offline_valid_until),
            })
        }
    }
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
            remote::logout(&state, &token).await;
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn desktop_get_master_operators(
    state: State<'_, DesktopState>,
) -> Result<Value, CommandError> {
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
    let payload = secured_api(
        &state,
        "roles.manage",
        Method::POST,
        "/api/roles/query",
        None,
    )
    .await?;
    Ok(payload.get("roles").cloned().unwrap_or_else(|| json!([])))
}

#[tauri::command]
pub async fn desktop_create_role(
    state: State<'_, DesktopState>,
    draft: Value,
    permission_keys: Vec<String>,
) -> Result<Value, CommandError> {
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
    scanner::submit(&state, &input, &operator.kode_operator)
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
    require_permission(&state, "dashboard.view")?;
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
    let result = secured_api(
        &state,
        "branding.manage",
        Method::PUT,
        "/api/settings/geofence",
        Some(settings),
    )
    .await?;
    let data = result.get("data").cloned().ok_or_else(|| {
        CommandError::new(
            "DESKTOP_REMOTE_INVALID_RESPONSE",
            "Respons pengaturan geofencing tidak valid.",
        )
    })?;
    operational::save_geofence_settings(&state, &data)?;
    Ok(data)
}

#[tauri::command]
pub fn desktop_get_scanner_settings(
    state: State<'_, DesktopState>,
) -> Result<Value, CommandError> {
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
    let result = secured_api(
        &state,
        "branding.manage",
        Method::PUT,
        "/api/settings/scanner",
        Some(settings),
    )
    .await?;
    let data = result.get("data").cloned().ok_or_else(|| {
        CommandError::new(
            "DESKTOP_REMOTE_INVALID_RESPONSE",
            "Respons pengaturan keamanan scanner tidak valid.",
        )
    })?;
    operational::save_scanner_settings(&state, &data)?;
    Ok(data)
}

#[tauri::command]
pub fn desktop_get_sync_status(
    state: State<'_, DesktopState>,
) -> Result<DesktopSyncStatus, CommandError> {
    let session = state.session.lock().map_err(|_| CommandError::internal())?;
    let operator = session.as_ref().ok_or_else(|| {
        CommandError::new(
            "DESKTOP_SESSION_MISSING",
            "Session Desktop tidak tersedia. Silakan login kembali.",
        )
    })?;
    if !operator
        .operator
        .permissions
        .iter()
        .any(|permission| permission == "sync.view")
    {
        return Err(CommandError::new(
            "DESKTOP_ACCESS_DENIED",
            "Akses status sinkronisasi ditolak.",
        ));
    }
    drop(session);
    sync::status(&state)
}

#[tauri::command]
pub async fn desktop_sync_now(
    state: State<'_, DesktopState>,
) -> Result<DesktopSyncStatus, CommandError> {
    let token = {
        let session = state.session.lock().map_err(|_| CommandError::internal())?;
        let session = session.as_ref().ok_or_else(|| {
            CommandError::new(
                "DESKTOP_SESSION_MISSING",
                "Session Desktop tidak tersedia. Silakan login kembali.",
            )
        })?;
        if !session
            .operator
            .permissions
            .iter()
            .any(|permission| permission == "sync.view")
        {
            return Err(CommandError::new(
                "DESKTOP_ACCESS_DENIED",
                "Akses sinkronisasi ditolak.",
            ));
        }
        session
            .token
            .as_ref()
            .map(|value| value.to_string())
            .ok_or_else(|| {
                CommandError::new(
                    "DESKTOP_ONLINE_REQUIRED",
                    "Login online diperlukan sebelum data operasional dapat disinkronkan.",
                )
            })?
    };
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
pub fn desktop_resolve_sync_conflicts(
    state: State<'_, DesktopState>,
    event_id: Option<String>,
) -> Result<DesktopSyncStatus, CommandError> {
    require_permission(&state, "sync.retry")?;
    sync::resolve_conflicts(&state, event_id.as_deref())?;
    desktop_get_sync_status(state)
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

#[tauri::command]
pub fn desktop_save_file(
    filename: String,
    base64_data: String,
) -> Result<Value, CommandError> {
    operational::save_desktop_file(&filename, &base64_data)
}


