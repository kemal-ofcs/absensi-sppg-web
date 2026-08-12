mod auth;
mod desktop_config;
mod runtime;

use crate::auth::service::{
    authenticate_with_biometric, get_sync_config, get_sync_device_id, set_password,
    set_sync_config, verify_local_desktop_login, verify_password,
};
use crate::runtime::service::{
    ensure_runtime_bootstrap_ready, get_runtime_bootstrap_config, probe_runtime_bootstrap_health,
    setup_desktop_runtime, shutdown_desktop_runtime, DesktopRuntimeManagerState,
};
use tauri_plugin_log::{RotationStrategy, Target, TargetKind};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(
            tauri_plugin_log::Builder::default()
                .level(log::LevelFilter::Info)
                .rotation_strategy(RotationStrategy::KeepSome(10))
                .clear_targets()
                .targets([
                    Target::new(TargetKind::LogDir {
                        file_name: Some("rust".into()),
                    }),
                    Target::new(TargetKind::LogDir {
                        file_name: Some("webview".into()),
                    })
                    .filter(|metadata| {
                        metadata
                            .target()
                            .starts_with(tauri_plugin_log::WEBVIEW_TARGET)
                    }),
                ])
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_sql::Builder::new().build())
        .manage(DesktopRuntimeManagerState::default())
        .invoke_handler(tauri::generate_handler![
            authenticate_with_biometric,
            set_password,
            verify_password,
            verify_local_desktop_login,
            get_sync_config,
            get_sync_device_id,
            set_sync_config,
            get_runtime_bootstrap_config,
            probe_runtime_bootstrap_health,
            ensure_runtime_bootstrap_ready
        ])
        .setup(|app| {
            log::info!("[DesktopRuntime] Starting Tauri setup.");
            setup_desktop_runtime(&app.handle())
                .map_err(|error| -> Box<dyn std::error::Error> { error.into() })?;
            log::info!("[DesktopRuntime] Tauri setup completed.");

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        if matches!(
            event,
            tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit
        ) {
            let _ = shutdown_desktop_runtime(&app_handle);
        }
    });
}
