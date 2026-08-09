use reqwest::Method;
use serde_json::{json, Value};
use tauri::State;
use zeroize::Zeroizing;

use super::{
    config::DesktopState,
    models::{
        CommandError, DesktopLoginResult, DesktopRuntimeStatus, DesktopSession, OperatorUser,
        SessionMode,
    },
    remote::{self, RemoteLoginError},
    secrets, storage,
};

struct OnlineAccess {
    token: Zeroizing<String>,
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
            let (offline_ready, offline_valid_until, message) = match provisioned {
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
