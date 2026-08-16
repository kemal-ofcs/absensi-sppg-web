use std::{collections::HashMap, env, path::PathBuf};

const DESKTOP_COMMANDS: &[&str] = &[
    "desktop_get_session",
    "desktop_get_runtime_status",
    "desktop_login",
    "desktop_logout",
    "desktop_get_master_operators",
    "desktop_create_operator",
    "desktop_update_operator",
    "desktop_delete_operator",
    "desktop_get_roles",
    "desktop_create_role",
    "desktop_update_role",
    "desktop_set_role_permissions",
    "desktop_delete_role",
    "desktop_get_employees",
    "desktop_create_employee",
    "desktop_import_employees",
    "desktop_update_employee",

    "desktop_set_employee_status",
    "desktop_generate_employee_tokens",
    "desktop_get_shifts",
    "desktop_create_shift",
    "desktop_update_shift",
    "desktop_delete_shift",
    "desktop_submit_qr_scan",
    "desktop_get_corrections",
    "desktop_create_correction",
    "desktop_get_backups",
    "desktop_create_backup",
    "desktop_cancel_backup",
    "desktop_import_offline",
    "desktop_get_dashboard_data",
    "desktop_get_id_cards",
    "desktop_update_id_card",
    "desktop_get_geofence_settings",
    "desktop_update_geofence_settings",
    "desktop_get_sync_status",
    "desktop_sync_now",
    "desktop_get_sync_conflicts",
    "desktop_retry_failed_sync",
];

fn local_build_values() -> HashMap<String, String> {
    let path = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("manifest dir"))
        .join("..")
        .join(".env");
    dotenvy::from_path_iter(path)
        .map(|entries| entries.filter_map(Result::ok).collect())
        .unwrap_or_default()
}

fn expose_build_value(name: &str, local: &HashMap<String, String>) -> Option<String> {
    let value = env::var(name)
        .ok()
        .or_else(|| local.get(name).cloned())
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty());
    if let Some(value) = &value {
        println!("cargo:rustc-env={name}={value}");
    }
    println!("cargo:rerun-if-env-changed={name}");
    value
}

fn main() {
    println!("cargo:rerun-if-changed=../.env");
    let local = local_build_values();
    let api_base_url = expose_build_value("SPPG_API_BASE_URL", &local);
    expose_build_value("SPPG_DEV_API_BASE_URL", &local);
    let offline_hours = expose_build_value("SPPG_OFFLINE_AUTH_MAX_AGE_HOURS", &local);

    if env::var("PROFILE").as_deref() == Ok("release") {
        assert!(
            api_base_url.is_some(),
            "SPPG_API_BASE_URL wajib tersedia untuk build release Desktop."
        );
        assert!(
            offline_hours.is_some(),
            "SPPG_OFFLINE_AUTH_MAX_AGE_HOURS wajib tersedia untuk build release Desktop."
        );
    }

    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(DESKTOP_COMMANDS)),
    )
    .expect("gagal membangun manifest Tauri");
}
