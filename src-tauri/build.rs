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
