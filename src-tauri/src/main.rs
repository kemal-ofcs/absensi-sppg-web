// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // generate_context!() membungkus ../out; diekspansi di bin agar ubah UI tidak mengompilasi ulang crate lib.
    absensi_sppg_desktop_lib::run_with_context(tauri::generate_context!());
}
