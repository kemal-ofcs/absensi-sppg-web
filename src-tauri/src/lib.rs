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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
