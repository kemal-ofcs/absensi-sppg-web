use std::{collections::HashMap, env, path::PathBuf};

const DESKTOP_COMMANDS: &[&str] = &[
    "desktop_get_session",
    "desktop_get_runtime_status",
    "desktop_get_bootstrap_status",
    "desktop_bootstrap_superadmin",
    "desktop_check_bootstrap_database",
    "desktop_link_bootstrap_database",
    "desktop_login",
    "desktop_logout",
    "desktop_list_password_reset_history",
    "desktop_get_password_reset_photo",
    "desktop_delete_password_reset_history",
    "desktop_purge_password_reset_history",
    "desktop_list_attendance_photos",
    "desktop_get_attendance_photo",
    "desktop_delete_attendance_photo",
    "desktop_purge_attendance_photos",
    "desktop_get_scan_security",
    "desktop_update_scan_security",
    "desktop_password_reset_lookup",
    "desktop_password_reset_confirm",
    "desktop_password_reset_swap_challenge",
    "desktop_password_reset_verify",
    "desktop_password_reset_inspect",
    "desktop_password_reset_complete",
    "desktop_send_test_mail",
    "desktop_get_mail_config",
    "desktop_save_mail_config",
    "desktop_get_two_factor_status",
    "desktop_begin_two_factor_setup",
    "desktop_confirm_two_factor_setup",
    "desktop_disable_two_factor",
    "desktop_admin_disable_two_factor",
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
    "desktop_delete_correction",
    "desktop_update_attendance",
    "desktop_delete_attendance",
    "desktop_delete_log_scan",
    "desktop_delete_import_offline",
    "desktop_get_backups",
    "desktop_create_backup",
    "desktop_cancel_backup",
    "desktop_get_imports",
    "desktop_import_offline",
    "desktop_get_dashboard_data",
    "desktop_get_id_cards",
    "desktop_update_id_card",
    "desktop_get_geofence_settings",
    "desktop_update_geofence_settings",
    "desktop_get_scanner_settings",
    "desktop_update_scanner_settings",
    "desktop_get_app_display_name",
    "desktop_update_app_display_name",
    "desktop_get_sync_status",
    "desktop_sync_now",
    "desktop_get_sync_conflicts",
    "desktop_retry_failed_sync",
    "desktop_resolve_sync_conflicts",
    "desktop_resolve_sync_conflicts_local",
    "desktop_clear_failed_sync",
    "desktop_save_file",
    "desktop_get_holidays",
    "desktop_get_holiday_whitelist",
    "desktop_create_holiday_whitelist",
    "desktop_update_holiday_whitelist",
    "desktop_delete_holiday_whitelist",
    "desktop_create_holiday",
    "desktop_update_holiday",
    "desktop_delete_holiday",
    "desktop_get_alfa_settings",
    "desktop_save_alfa_settings",
    "desktop_trigger_generate_alfa",
    "desktop_get_attendance_audit",
    "desktop_get_server_url",
    "desktop_set_server_url",
    "desktop_get_company_profile",
    "desktop_update_company_profile",
    "desktop_get_id_card_template",
    "desktop_save_id_card_template",
    "desktop_force_resync_settings",
    "desktop_debug_template_sync",
    "desktop_get_turso_url",
    "desktop_get_database_config",
    "desktop_save_turso_config",
    "desktop_test_turso_connection",
    "desktop_clear_turso_config",
    "desktop_get_salary_configs",
    "desktop_save_salary_config",
    "desktop_delete_salary_config",
    "desktop_get_overtime_rules",
    "desktop_save_overtime_rule",
    "desktop_delete_overtime_rule",
    "desktop_save_overtime_rules",
    "desktop_get_payroll_components",
    "desktop_save_payroll_component",
    "desktop_delete_payroll_component",
    "desktop_get_tax_rules",
    "desktop_save_tax_rule",
    "desktop_delete_tax_rule",
    "desktop_save_tax_rules",
    "desktop_get_bpjs_rules",
    "desktop_save_bpjs_rule",
    "desktop_delete_bpjs_rule",
    "desktop_save_bpjs_rules",
    "desktop_get_payroll_recap",
    "desktop_create_payroll_run",
    "desktop_list_payroll_runs",
    "desktop_get_payroll_run_detail",
    "desktop_transition_payroll_status",
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
    expose_build_value("TURSO_DATABASE_URL", &local);
    expose_build_value("TURSO_AUTH_TOKEN", &local);
    expose_build_value("SPPG_API_BASE_URL", &local);
    expose_build_value("SPPG_DEV_API_BASE_URL", &local);
    expose_build_value("SPPG_OFFLINE_AUTH_MAX_AGE_HOURS", &local);

    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(DESKTOP_COMMANDS)),
    )
    .expect("gagal membangun manifest Tauri");
}
