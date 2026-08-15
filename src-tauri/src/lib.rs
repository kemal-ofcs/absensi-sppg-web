mod desktop;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            app.manage(desktop::DesktopState::initialize(app.handle())?);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            desktop::commands::desktop_get_session,
            desktop::commands::desktop_get_runtime_status,
            desktop::commands::desktop_login,
            desktop::commands::desktop_logout,
            desktop::commands::desktop_get_master_operators,
            desktop::commands::desktop_create_operator,
            desktop::commands::desktop_update_operator,
            desktop::commands::desktop_delete_operator,
            desktop::commands::desktop_get_roles,
            desktop::commands::desktop_create_role,
            desktop::commands::desktop_update_role,
            desktop::commands::desktop_set_role_permissions,
            desktop::commands::desktop_delete_role,
            desktop::commands::desktop_get_employees,
            desktop::commands::desktop_create_employee,
            desktop::commands::desktop_update_employee,
            desktop::commands::desktop_set_employee_status,
            desktop::commands::desktop_generate_employee_tokens,
            desktop::commands::desktop_get_shifts,
            desktop::commands::desktop_create_shift,
            desktop::commands::desktop_update_shift,
            desktop::commands::desktop_delete_shift,
            desktop::commands::desktop_submit_qr_scan,
            desktop::commands::desktop_get_corrections,
            desktop::commands::desktop_create_correction,
            desktop::commands::desktop_get_backups,
            desktop::commands::desktop_create_backup,
            desktop::commands::desktop_cancel_backup,
            desktop::commands::desktop_import_offline,
            desktop::commands::desktop_get_dashboard_data,
            desktop::commands::desktop_get_id_cards,
            desktop::commands::desktop_update_id_card,
            desktop::commands::desktop_get_geofence_settings,
            desktop::commands::desktop_update_geofence_settings,
            desktop::commands::desktop_get_sync_status,
            desktop::commands::desktop_sync_now,
            desktop::commands::desktop_get_sync_conflicts,
            desktop::commands::desktop_retry_failed_sync,
            desktop::commands::desktop_save_file,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
