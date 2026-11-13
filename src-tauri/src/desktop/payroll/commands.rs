use std::collections::HashMap;

use rusqlite::{params, Connection, OptionalExtension};
use rust_decimal::prelude::*;
use rust_decimal::Decimal;
use serde_json::{json, Value};
use tauri::State;

use super::engine::{KonteksPajak, PayInput, PayRules, PayrollCalculator};
use super::pajak::{self, ItemPembanding};
use super::models::{
    BpjsRule, OvertimeTierRule, PayrollAuditLog, PayrollComponent, PayrollItem, PayrollRecapRow,
    PayrollRun, PayrollStatus, SalaryConfig, TaxRule, SALARY_TYPE_FLAT_DAILY,
};
use crate::desktop::config::DesktopState;
use crate::desktop::loan;
use crate::desktop::models::CommandError;
use crate::desktop::storage;
use crate::desktop::sync;
// Gerbang izin yang SAMA dengan seluruh command lain: salinan sendiri di sini
// akan meloloskan payroll dari mode baca-saja lisensi.
use crate::desktop::commands::require_permission;

fn iso_now_tx(tx: &rusqlite::Transaction<'_>) -> String {
    tx.query_row("SELECT strftime('%Y-%m-%dT%H:%M:%SZ', 'now');", [], |r| {
        r.get(0)
    })
    .unwrap_or_else(|_| format!("epoch-{}", storage::now_epoch_seconds()))
}

/// Id baris payroll dibuat KLIEN: `<awalan>-<detik epoch>-<48 bit acak>`.
///
/// Dulu hanya `<awalan>-<detik epoch>`, dan itu bertabrakan di tiga tempat:
/// (1) fungsi simpan MASSAL (`save_*_rules`) memberi id yang SAMA ke setiap
/// baris baru dalam satu loop, sehingga baris berikutnya menimpa yang pertama
/// lewat `ON CONFLICT(id)`; (2) dua perangkat yang menyimpan pada detik yang
/// sama menghasilkan id sama, dan cloud menolak push kedua dengan pelanggaran
/// PK — outbox-nya macet permanen; (3) dua transisi status batch dalam satu
/// detik menabrakkan id `payroll_audit_logs`. Detiknya dipertahankan supaya id
/// tetap terbaca dan terurut kira-kira menurut waktu.
/// Id baris BPJS yang sudah memakai `component_code` ini, atau id baru.
///
/// `bpjs_rules` unik per kode dan INSERT-nya menimpa lewat kode itu dengan id
/// LAMA; tanpa ini outbox mengantrekan id yang tidak dimiliki baris mana pun.
fn bpjs_rule_id(
    tx: &rusqlite::Transaction<'_>,
    requested_id: &str,
    component_code: &str,
) -> Result<String, CommandError> {
    if !requested_id.trim().is_empty() {
        return Ok(requested_id.to_string());
    }
    let existing = tx
        .query_row(
            "SELECT id FROM bpjs_rules WHERE component_code = ?1;",
            params![component_code],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|_| CommandError::internal())?;
    Ok(existing.unwrap_or_else(|| {
        new_payroll_id(&format!("bpjs-{}", component_code.to_lowercase()))
    }))
}

fn new_payroll_id(prefix: &str) -> String {
    let mut bytes = [0u8; 6];
    rand_core::RngCore::fill_bytes(&mut rand_core::OsRng, &mut bytes);
    format!(
        "{prefix}-{}-{}",
        storage::now_epoch_seconds(),
        hex::encode(bytes)
    )
}

#[tauri::command]
pub async fn desktop_get_salary_configs(
    state: State<'_, DesktopState>,
    search: Option<String>,
) -> Result<Vec<SalaryConfig>, CommandError> {
    require_permission(&state, "payroll.view")?;
    let conn = storage::database(&state.data_dir)?;

    let search_pattern = search
        .as_deref()
        .map(|s| format!("%{}%", s.trim()))
        .unwrap_or_else(|| "%".to_string());

    let mut stmt = conn
        .prepare(
            r#"
            SELECT sc.id, sc.id_karyawan, sc.rate_per_hour, sc.ptkp_status,
                   sc.effective_date, sc.created_by, sc.created_at,
                   sc.salary_type, sc.daily_rate
            FROM salary_configs sc
            LEFT JOIN master_data md ON md.id_unik = sc.id_karyawan
            WHERE (?1 = '%' OR COALESCE(md.nama, '') LIKE ?1 OR COALESCE(md.kode_karyawan, '') LIKE ?1 OR sc.id_karyawan LIKE ?1)
            ORDER BY sc.effective_date DESC;
            "#,
        )
        .map_err(|_| CommandError::internal())?;

    let rows = stmt
        .query_map(params![search_pattern], |row| {
            Ok(SalaryConfig {
                id: row.get(0)?,
                id_karyawan: row.get(1)?,
                rate_per_hour: row.get(2)?,
                ptkp_status: row.get(3)?,
                effective_date: row.get(4)?,
                created_by: row.get(5)?,
                created_at: row.get(6)?,
                salary_type: row.get(7)?,
                daily_rate: row.get(8)?,
            })
        })
        .map_err(|_| CommandError::internal())?;

    let mut list = Vec::new();
    for item in rows {
        if let Ok(config) = item {
            list.push(config);
        }
    }
    Ok(list)
}

#[tauri::command]
pub async fn desktop_save_salary_config(
    state: State<'_, DesktopState>,
    draft: SalaryConfig,
) -> Result<bool, CommandError> {
    let operator = require_permission(&state, "payroll.config.manage")?;
    let draft = draft
        .normalized()
        .map_err(|message| CommandError::new("VALIDATION_ERROR", message))?;
    let mut conn = storage::database(&state.data_dir)?;

    let tx = conn.transaction().map_err(|_| CommandError::internal())?;
    let client_id = sync::ensure_client_id(&state)?;
    upsert_salary_config(&tx, &client_id, &draft, &operator.username)?;
    tx.commit().map_err(|_| CommandError::internal())?;
    Ok(true)
}

/// Satu baris `salary_configs` + event outbox-nya, di transaksi pemanggil.
///
/// `draft` WAJIB sudah melewati `SalaryConfig::normalized`.
fn upsert_salary_config(
    tx: &rusqlite::Transaction<'_>,
    client_id: &str,
    draft: &SalaryConfig,
    created_by: &str,
) -> Result<(), CommandError> {
    // Rate unik per (karyawan, tanggal berlaku) dan INSERT di bawah menimpa
    // baris lama lewat kunci alami itu — dengan id LAMA. Tanpa pencarian ini,
    // outbox mengantrekan id baru yang tidak dimiliki baris mana pun.
    let config_id = if draft.id.is_empty() {
        tx.query_row(
            "SELECT id FROM salary_configs WHERE id_karyawan = ?1 AND effective_date = ?2;",
            params![draft.id_karyawan, draft.effective_date],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|_| CommandError::internal())?
        .unwrap_or_else(|| new_payroll_id("sc"))
    } else {
        draft.id.clone()
    };
    let now = iso_now_tx(tx);

    tx.execute(
        r#"
        INSERT INTO salary_configs (
            id, id_karyawan, rate_per_hour, ptkp_status, effective_date, created_by, created_at,
            salary_type, daily_rate
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
        ON CONFLICT(id_karyawan, effective_date) DO UPDATE SET
            rate_per_hour = excluded.rate_per_hour,
            ptkp_status = excluded.ptkp_status,
            created_by = excluded.created_by,
            salary_type = excluded.salary_type,
            daily_rate = excluded.daily_rate;
        "#,
        params![
            config_id,
            draft.id_karyawan,
            draft.rate_per_hour,
            draft.ptkp_status,
            draft.effective_date,
            created_by,
            now,
            draft.salary_type,
            draft.daily_rate
        ],
    )
    .map_err(|_| CommandError::new("SAVE_FAILED", "Gagal menyimpan konfigurasi gaji karyawan."))?;

    sync::enqueue(
        tx,
        client_id,
        "payroll",
        "salary-config",
        &config_id,
        &json!({
            "id": config_id,
            "id_karyawan": draft.id_karyawan.clone(),
            "rate_per_hour": draft.rate_per_hour,
            "ptkp_status": draft.ptkp_status.clone(),
            "effective_date": draft.effective_date.clone(),
            "created_by": created_by,
            "created_at": now,
            "salary_type": draft.salary_type.clone(),
            "daily_rate": draft.daily_rate,
        }),
        None,
    )?;
    Ok(())
}

/// Menerapkan tarif harian tetap ke seluruh karyawan aktif, atau satu divisi.
///
/// Satu transaksi untuk seluruh baris dan event outbox-nya, lewat rute kanonik
/// `salary-config` yang sama dengan simpan tunggal. Status PTKP setiap
/// karyawan dipertahankan dari konfigurasi terakhirnya. Mengembalikan jumlah
/// karyawan yang diperbarui.
#[tauri::command]
pub async fn desktop_bulk_apply_flat_daily(
    state: State<'_, DesktopState>,
    divisi: Option<String>,
    daily_rate: i64,
    effective_date: String,
) -> Result<i64, CommandError> {
    let operator = require_permission(&state, "payroll.config.manage")?;
    let divisi = divisi
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let mut conn = storage::database(&state.data_dir)?;
    let tx = conn.transaction().map_err(|_| CommandError::internal())?;

    let targets: Vec<(String, String)> = {
        let mut stmt = tx
            .prepare(
                r#"
                SELECT md.id_unik,
                       COALESCE((
                           SELECT sc.ptkp_status FROM salary_configs sc
                           WHERE sc.id_karyawan = md.id_unik
                           ORDER BY sc.effective_date DESC LIMIT 1
                       ), 'TK/0')
                FROM master_data md
                WHERE md.status_aktif = 'Aktif' AND (?1 IS NULL OR md.divisi = ?1)
                ORDER BY md.id_unik;
                "#,
            )
            .map_err(|_| CommandError::internal())?;
        let rows = stmt
            .query_map(params![divisi], |row| Ok((row.get(0)?, row.get(1)?)))
            .map_err(|_| CommandError::internal())?;
        rows.collect::<Result<_, _>>()
            .map_err(|_| CommandError::internal())?
    };
    if targets.is_empty() {
        return Err(CommandError::new(
            "VALIDATION_ERROR",
            "Tidak ada karyawan aktif pada cakupan yang dipilih.",
        ));
    }

    let client_id = sync::ensure_client_id(&state)?;
    for (id_karyawan, ptkp_status) in &targets {
        let draft = SalaryConfig {
            id: String::new(),
            id_karyawan: id_karyawan.clone(),
            rate_per_hour: 0,
            ptkp_status: ptkp_status.clone(),
            effective_date: effective_date.clone(),
            created_by: String::new(),
            created_at: String::new(),
            salary_type: SALARY_TYPE_FLAT_DAILY.to_string(),
            daily_rate,
        }
        .normalized()
        .map_err(|message| CommandError::new("VALIDATION_ERROR", message))?;
        upsert_salary_config(&tx, &client_id, &draft, &operator.username)?;
    }

    tx.commit().map_err(|_| CommandError::internal())?;
    Ok(targets.len() as i64)
}

#[tauri::command]
pub async fn desktop_delete_salary_config(
    state: State<'_, DesktopState>,
    id: String,
) -> Result<bool, CommandError> {
    require_permission(&state, "payroll.config.manage")?;
    let mut conn = storage::database(&state.data_dir)?;
    let tx = conn.transaction().map_err(|_| CommandError::internal())?;

    tx.execute("DELETE FROM salary_configs WHERE id = ?1;", params![id])
        .map_err(|_| CommandError::new("DELETE_FAILED", "Gagal menghapus konfigurasi gaji karyawan."))?;

    let client_id = sync::ensure_client_id(&state)?;
    sync::enqueue(
        &tx,
        &client_id,
        "payroll",
        "delete",
        &format!("salary_configs:{id}"),
        &json!({ "table": "salary_configs", "id": id }),
        None,
    )?;

    tx.commit().map_err(|_| CommandError::internal())?;
    Ok(true)
}

#[tauri::command]
pub async fn desktop_get_overtime_rules(
    state: State<'_, DesktopState>,
) -> Result<Vec<OvertimeTierRule>, CommandError> {
    require_permission(&state, "payroll.view")?;
    let conn = storage::database(&state.data_dir)?;

    let mut stmt = conn
        .prepare(
            r#"
            SELECT id, rule_type, tier_order, hour_start, hour_end, multiplier, is_active
            FROM overtime_tier_rules
            ORDER BY rule_type, tier_order ASC;
            "#,
        )
        .map_err(|_| CommandError::internal())?;

    let rows = stmt
        .query_map([], |row| {
            Ok(OvertimeTierRule {
                id: row.get(0)?,
                rule_type: row.get(1)?,
                tier_order: row.get(2)?,
                hour_start: row.get(3)?,
                hour_end: row.get(4)?,
                multiplier: row.get(5)?,
                is_active: row.get(6)?,
            })
        })
        .map_err(|_| CommandError::internal())?;

    let mut list = Vec::new();
    for item in rows {
        if let Ok(rule) = item {
            list.push(rule);
        }
    }
    Ok(list)
}

#[tauri::command]
pub async fn desktop_save_overtime_rule(
    state: State<'_, DesktopState>,
    draft: OvertimeTierRule,
) -> Result<bool, CommandError> {
    require_permission(&state, "payroll.config.manage")?;
    let mut conn = storage::database(&state.data_dir)?;
    let tx = conn.transaction().map_err(|_| CommandError::internal())?;

    let rule_id = if draft.id.trim().is_empty() {
        new_payroll_id(&format!("ot-{}", draft.rule_type.to_lowercase()))
    } else {
        draft.id.clone()
    };

    tx.execute(
        r#"
        INSERT INTO overtime_tier_rules (
            id, rule_type, tier_order, hour_start, hour_end, multiplier, is_active
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
        ON CONFLICT(id) DO UPDATE SET
            rule_type = excluded.rule_type,
            tier_order = excluded.tier_order,
            hour_start = excluded.hour_start,
            hour_end = excluded.hour_end,
            multiplier = excluded.multiplier,
            is_active = excluded.is_active;
        "#,
        params![
            rule_id,
            draft.rule_type,
            draft.tier_order,
            draft.hour_start,
            draft.hour_end,
            draft.multiplier,
            draft.is_active
        ],
    )
    .map_err(|_| CommandError::new("SAVE_FAILED", "Gagal menyimpan jenjang lembur."))?;

    let client_id = sync::ensure_client_id(&state)?;
    sync::enqueue(
        &tx,
        &client_id,
        "payroll",
        "overtime-rule",
        &rule_id,
        &json!({
            "id": rule_id,
            "rule_type": draft.rule_type.clone(),
            "tier_order": draft.tier_order,
            "hour_start": draft.hour_start,
            "hour_end": draft.hour_end,
            "multiplier": draft.multiplier,
            "is_active": draft.is_active,
        }),
        None,
    )?;

    tx.commit().map_err(|_| CommandError::internal())?;
    Ok(true)
}

#[tauri::command]
pub async fn desktop_delete_overtime_rule(
    state: State<'_, DesktopState>,
    id: String,
) -> Result<bool, CommandError> {
    require_permission(&state, "payroll.config.manage")?;
    let mut conn = storage::database(&state.data_dir)?;
    let tx = conn.transaction().map_err(|_| CommandError::internal())?;

    tx.execute("DELETE FROM overtime_tier_rules WHERE id = ?1;", params![id])
        .map_err(|_| CommandError::new("DELETE_FAILED", "Gagal menghapus jenjang lembur."))?;

    let client_id = sync::ensure_client_id(&state)?;
    sync::enqueue(
        &tx,
        &client_id,
        "payroll",
        "delete",
        &format!("overtime_tier_rules:{id}"),
        &json!({ "table": "overtime_tier_rules", "id": id }),
        None,
    )?;

    tx.commit().map_err(|_| CommandError::internal())?;
    Ok(true)
}

#[tauri::command]
pub async fn desktop_save_overtime_rules(
    state: State<'_, DesktopState>,
    rules: Vec<OvertimeTierRule>,
) -> Result<bool, CommandError> {
    require_permission(&state, "payroll.config.manage")?;
    let mut conn = storage::database(&state.data_dir)?;
    let tx = conn.transaction().map_err(|_| CommandError::internal())?;
    let client_id = sync::ensure_client_id(&state)?;

    for rule in rules {
        let rule_id = if rule.id.trim().is_empty() {
            new_payroll_id(&format!("ot-{}", rule.rule_type.to_lowercase()))
        } else {
            rule.id.clone()
        };

        tx.execute(
            r#"
            INSERT INTO overtime_tier_rules (
                id, rule_type, tier_order, hour_start, hour_end, multiplier, is_active
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
            ON CONFLICT(id) DO UPDATE SET
                rule_type = excluded.rule_type,
                tier_order = excluded.tier_order,
                hour_start = excluded.hour_start,
                hour_end = excluded.hour_end,
                multiplier = excluded.multiplier,
                is_active = excluded.is_active;
            "#,
            params![
                rule_id,
                rule.rule_type,
                rule.tier_order,
                rule.hour_start,
                rule.hour_end,
                rule.multiplier,
                rule.is_active
            ],
        )
        .map_err(|_| CommandError::new("SAVE_FAILED", "Gagal memperbarui jenjang lembur."))?;

        sync::enqueue(
            &tx,
            &client_id,
            "payroll",
            "overtime-rule",
            &rule_id,
            &json!({
                "id": rule_id,
                "rule_type": rule.rule_type.clone(),
                "tier_order": rule.tier_order,
                "hour_start": rule.hour_start,
                "hour_end": rule.hour_end,
                "multiplier": rule.multiplier,
                "is_active": rule.is_active,
            }),
            None,
        )?;
    }

    tx.commit().map_err(|_| CommandError::internal())?;
    Ok(true)
}

#[tauri::command]
pub async fn desktop_get_payroll_components(
    state: State<'_, DesktopState>,
) -> Result<Vec<PayrollComponent>, CommandError> {
    require_permission(&state, "payroll.view")?;
    let conn = storage::database(&state.data_dir)?;

    let mut stmt = conn
        .prepare(
            r#"
            SELECT id, name, category, calc_type, default_value, applies_to, is_active, dasar_bpjs
            FROM payroll_components
            ORDER BY category, name ASC;
            "#,
        )
        .map_err(|_| CommandError::internal())?;

    let rows = stmt
        .query_map([], |row| {
            Ok(PayrollComponent {
                id: row.get(0)?,
                name: row.get(1)?,
                category: row.get(2)?,
                calc_type: row.get(3)?,
                default_value: row.get(4)?,
                applies_to: row.get(5)?,
                is_active: row.get(6)?,
                dasar_bpjs: row.get(7)?,
            })
        })
        .map_err(|_| CommandError::internal())?;

    let mut list = Vec::new();
    for item in rows {
        if let Ok(comp) = item {
            list.push(comp);
        }
    }
    Ok(list)
}

#[tauri::command]
pub async fn desktop_save_payroll_component(
    state: State<'_, DesktopState>,
    draft: PayrollComponent,
) -> Result<bool, CommandError> {
    require_permission(&state, "payroll.config.manage")?;
    let mut conn = storage::database(&state.data_dir)?;
    let tx = conn.transaction().map_err(|_| CommandError::internal())?;

    let comp_id = if draft.id.trim().is_empty() {
        new_payroll_id("comp")
    } else {
        draft.id.clone()
    };
    // Cermin CHECK `dasar_bpjs IN (0, 1)` (aturan 43); potongan tidak pernah
    // menjadi dasar BPJS.
    if !matches!(draft.dasar_bpjs, 0 | 1) {
        return Err(CommandError::new("VALIDATION_ERROR", "Penanda dasar BPJS harus 0 atau 1."));
    }
    let dasar_bpjs = if draft.category == "ALLOWANCE" { draft.dasar_bpjs } else { 0 };

    tx.execute(
        r#"
        INSERT INTO payroll_components (
            id, name, category, calc_type, default_value, applies_to, is_active, dasar_bpjs
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
        ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            category = excluded.category,
            calc_type = excluded.calc_type,
            default_value = excluded.default_value,
            applies_to = excluded.applies_to,
            is_active = excluded.is_active,
            dasar_bpjs = excluded.dasar_bpjs;
        "#,
        params![
            comp_id,
            draft.name,
            draft.category,
            draft.calc_type,
            draft.default_value,
            draft.applies_to,
            draft.is_active,
            dasar_bpjs
        ],
    )
    .map_err(|_| CommandError::new("SAVE_FAILED", "Gagal menyimpan komponen payroll."))?;

    let client_id = sync::ensure_client_id(&state)?;
    sync::enqueue(
        &tx,
        &client_id,
        "payroll",
        "payroll-component",
        &comp_id,
        &json!({
            "id": comp_id,
            "name": draft.name.clone(),
            "category": draft.category.clone(),
            "calc_type": draft.calc_type.clone(),
            "default_value": draft.default_value,
            "applies_to": draft.applies_to.clone(),
            "is_active": draft.is_active,
            "dasar_bpjs": dasar_bpjs,
        }),
        None,
    )?;

    tx.commit().map_err(|_| CommandError::internal())?;
    Ok(true)
}

#[tauri::command]
pub async fn desktop_delete_payroll_component(
    state: State<'_, DesktopState>,
    id: String,
) -> Result<bool, CommandError> {
    require_permission(&state, "payroll.config.manage")?;
    let mut conn = storage::database(&state.data_dir)?;
    let tx = conn.transaction().map_err(|_| CommandError::internal())?;

    tx.execute("DELETE FROM payroll_components WHERE id = ?1;", params![id])
        .map_err(|_| CommandError::new("DELETE_FAILED", "Gagal menghapus komponen."))?;

    let client_id = sync::ensure_client_id(&state)?;
    sync::enqueue(
        &tx,
        &client_id,
        "payroll",
        "delete",
        &format!("payroll_components:{id}"),
        &json!({ "table": "payroll_components", "id": id }),
        None,
    )?;

    tx.commit().map_err(|_| CommandError::internal())?;
    Ok(true)
}

#[tauri::command]
pub async fn desktop_get_tax_rules(
    state: State<'_, DesktopState>,
) -> Result<Vec<TaxRule>, CommandError> {
    require_permission(&state, "payroll.view")?;
    let conn = storage::database(&state.data_dir)?;

    let mut stmt = conn
        .prepare(
            r#"
            SELECT id, category, bracket_min, bracket_max, rate_percentage, effective_date
            FROM tax_rules
            ORDER BY category, bracket_min ASC;
            "#,
        )
        .map_err(|_| CommandError::internal())?;

    let rows = stmt
        .query_map([], |row| {
            Ok(TaxRule {
                id: row.get(0)?,
                category: row.get(1)?,
                bracket_min: row.get(2)?,
                bracket_max: row.get(3)?,
                rate_percentage: row.get(4)?,
                effective_date: row.get(5)?,
            })
        })
        .map_err(|_| CommandError::internal())?;

    let mut list = Vec::new();
    for item in rows {
        if let Ok(rule) = item {
            list.push(rule);
        }
    }
    Ok(list)
}

#[tauri::command]
pub async fn desktop_save_tax_rule(
    state: State<'_, DesktopState>,
    draft: TaxRule,
) -> Result<bool, CommandError> {
    require_permission(&state, "payroll.config.manage")?;
    pajak::periksa_tarif(draft.rate_percentage).map_err(|pesan| CommandError::new("VALIDATION_ERROR", pesan))?;
    let mut conn = storage::database(&state.data_dir)?;
    let tx = conn.transaction().map_err(|_| CommandError::internal())?;

    let rule_id = if draft.id.trim().is_empty() {
        new_payroll_id(&format!("tax-{}", draft.category.to_lowercase()))
    } else {
        draft.id.clone()
    };
    let eff_date = if draft.effective_date.trim().is_empty() {
        iso_now_tx(&tx)[..10].to_string()
    } else {
        draft.effective_date
    };

    tx.execute(
        r#"
        INSERT INTO tax_rules (
            id, category, bracket_min, bracket_max, rate_percentage, effective_date
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
        ON CONFLICT(id) DO UPDATE SET
            category = excluded.category,
            bracket_min = excluded.bracket_min,
            bracket_max = excluded.bracket_max,
            rate_percentage = excluded.rate_percentage,
            effective_date = excluded.effective_date;
        "#,
        params![
            rule_id,
            draft.category,
            draft.bracket_min,
            draft.bracket_max,
            draft.rate_percentage,
            eff_date
        ],
    )
    .map_err(|_| CommandError::new("SAVE_FAILED", "Gagal menyimpan aturan pajak."))?;

    let client_id = sync::ensure_client_id(&state)?;
    sync::enqueue(
        &tx,
        &client_id,
        "payroll",
        "tax-rule",
        &rule_id,
        &json!({
            "id": rule_id,
            "category": draft.category.clone(),
            "bracket_min": draft.bracket_min,
            "bracket_max": draft.bracket_max,
            "rate_percentage": draft.rate_percentage,
            "effective_date": eff_date.clone(),
        }),
        None,
    )?;

    tx.commit().map_err(|_| CommandError::internal())?;
    Ok(true)
}

#[tauri::command]
pub async fn desktop_delete_tax_rule(
    state: State<'_, DesktopState>,
    id: String,
) -> Result<bool, CommandError> {
    require_permission(&state, "payroll.config.manage")?;
    let mut conn = storage::database(&state.data_dir)?;
    let tx = conn.transaction().map_err(|_| CommandError::internal())?;

    tx.execute("DELETE FROM tax_rules WHERE id = ?1;", params![id])
        .map_err(|_| CommandError::new("DELETE_FAILED", "Gagal menghapus aturan pajak."))?;

    let client_id = sync::ensure_client_id(&state)?;
    sync::enqueue(
        &tx,
        &client_id,
        "payroll",
        "delete",
        &format!("tax_rules:{id}"),
        &json!({ "table": "tax_rules", "id": id }),
        None,
    )?;

    tx.commit().map_err(|_| CommandError::internal())?;
    Ok(true)
}

#[tauri::command]
pub async fn desktop_save_tax_rules(
    state: State<'_, DesktopState>,
    rules: Vec<TaxRule>,
) -> Result<bool, CommandError> {
    require_permission(&state, "payroll.config.manage")?;
    for rule in &rules {
        pajak::periksa_tarif(rule.rate_percentage).map_err(|pesan| CommandError::new("VALIDATION_ERROR", pesan))?;
    }
    let mut conn = storage::database(&state.data_dir)?;
    let tx = conn.transaction().map_err(|_| CommandError::internal())?;
    let client_id = sync::ensure_client_id(&state)?;

    for rule in rules {
        let rule_id = if rule.id.trim().is_empty() {
            new_payroll_id(&format!("tax-{}", rule.category.to_lowercase()))
        } else {
            rule.id.clone()
        };
        let eff_date = if rule.effective_date.trim().is_empty() {
            iso_now_tx(&tx)[..10].to_string()
        } else {
            rule.effective_date.clone()
        };

        tx.execute(
            r#"
            INSERT INTO tax_rules (
                id, category, bracket_min, bracket_max, rate_percentage, effective_date
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
            ON CONFLICT(id) DO UPDATE SET
                category = excluded.category,
                bracket_min = excluded.bracket_min,
                bracket_max = excluded.bracket_max,
                rate_percentage = excluded.rate_percentage,
                effective_date = excluded.effective_date;
            "#,
            params![
                rule_id,
                rule.category,
                rule.bracket_min,
                rule.bracket_max,
                rule.rate_percentage,
                eff_date
            ],
        )
        .map_err(|_| CommandError::new("SAVE_FAILED", "Gagal memperbarui aturan pajak."))?;

        sync::enqueue(
            &tx,
            &client_id,
            "payroll",
            "tax-rule",
            &rule_id,
            &json!({
                "id": rule_id,
                "category": rule.category.clone(),
                "bracket_min": rule.bracket_min,
                "bracket_max": rule.bracket_max,
                "rate_percentage": rule.rate_percentage,
                "effective_date": eff_date.clone(),
            }),
            None,
        )?;
    }

    tx.commit().map_err(|_| CommandError::internal())?;
    Ok(true)
}

#[tauri::command]
pub async fn desktop_save_bpjs_rule(
    state: State<'_, DesktopState>,
    draft: BpjsRule,
) -> Result<bool, CommandError> {
    require_permission(&state, "payroll.config.manage")?;
    pajak::periksa_tarif(draft.rate_percentage).map_err(|pesan| CommandError::new("VALIDATION_ERROR", pesan))?;
    let mut conn = storage::database(&state.data_dir)?;
    let tx = conn.transaction().map_err(|_| CommandError::internal())?;

    let rule_id = bpjs_rule_id(&tx, &draft.id, &draft.component_code)?;
    let eff_date = if draft.effective_date.trim().is_empty() {
        iso_now_tx(&tx)[..10].to_string()
    } else {
        draft.effective_date
    };

    tx.execute(
        r#"
        INSERT INTO bpjs_rules (
            id, component_code, component_name, rate_percentage, wage_cap, effective_date
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
        ON CONFLICT(component_code) DO UPDATE SET
            component_name = excluded.component_name,
            rate_percentage = excluded.rate_percentage,
            wage_cap = excluded.wage_cap,
            effective_date = excluded.effective_date;
        "#,
        params![
            rule_id,
            draft.component_code,
            draft.component_name,
            draft.rate_percentage,
            draft.wage_cap,
            eff_date
        ],
    )
    .map_err(|_| CommandError::new("SAVE_FAILED", "Gagal menyimpan aturan BPJS."))?;

    let client_id = sync::ensure_client_id(&state)?;
    sync::enqueue(
        &tx,
        &client_id,
        "payroll",
        "bpjs-rule",
        &rule_id,
        &json!({
            "id": rule_id,
            "component_code": draft.component_code.clone(),
            "component_name": draft.component_name.clone(),
            "rate_percentage": draft.rate_percentage,
            "wage_cap": draft.wage_cap,
            "effective_date": eff_date.clone(),
        }),
        None,
    )?;

    tx.commit().map_err(|_| CommandError::internal())?;
    Ok(true)
}

#[tauri::command]
pub async fn desktop_delete_bpjs_rule(
    state: State<'_, DesktopState>,
    id: String,
) -> Result<bool, CommandError> {
    require_permission(&state, "payroll.config.manage")?;
    let mut conn = storage::database(&state.data_dir)?;
    let tx = conn.transaction().map_err(|_| CommandError::internal())?;

    tx.execute("DELETE FROM bpjs_rules WHERE id = ?1 OR component_code = ?1;", params![id])
        .map_err(|_| CommandError::new("DELETE_FAILED", "Gagal menghapus aturan BPJS."))?;

    let client_id = sync::ensure_client_id(&state)?;
    sync::enqueue(
        &tx,
        &client_id,
        "payroll",
        "delete",
        &format!("bpjs_rules:{id}"),
        &json!({ "table": "bpjs_rules", "id": id }),
        None,
    )?;

    tx.commit().map_err(|_| CommandError::internal())?;
    Ok(true)
}

#[tauri::command]
pub async fn desktop_get_bpjs_rules(
    state: State<'_, DesktopState>,
) -> Result<Vec<BpjsRule>, CommandError> {
    require_permission(&state, "payroll.view")?;
    let conn = storage::database(&state.data_dir)?;

    let mut stmt = conn
        .prepare(
            r#"
            SELECT id, component_code, component_name, rate_percentage, wage_cap, effective_date
            FROM bpjs_rules
            ORDER BY component_code ASC;
            "#,
        )
        .map_err(|_| CommandError::internal())?;

    let rows = stmt
        .query_map([], |row| {
            Ok(BpjsRule {
                id: row.get(0)?,
                component_code: row.get(1)?,
                component_name: row.get(2)?,
                rate_percentage: row.get(3)?,
                wage_cap: row.get(4)?,
                effective_date: row.get(5)?,
            })
        })
        .map_err(|_| CommandError::internal())?;

    let mut list = Vec::new();
    for item in rows {
        if let Ok(rule) = item {
            list.push(rule);
        }
    }
    Ok(list)
}

#[tauri::command]
pub async fn desktop_save_bpjs_rules(
    state: State<'_, DesktopState>,
    rules: Vec<BpjsRule>,
) -> Result<bool, CommandError> {
    require_permission(&state, "payroll.config.manage")?;
    for rule in &rules {
        pajak::periksa_tarif(rule.rate_percentage).map_err(|pesan| CommandError::new("VALIDATION_ERROR", pesan))?;
    }
    let mut conn = storage::database(&state.data_dir)?;
    let tx = conn.transaction().map_err(|_| CommandError::internal())?;
    let client_id = sync::ensure_client_id(&state)?;

    for rule in rules {
        let rule_id = bpjs_rule_id(&tx, &rule.id, &rule.component_code)?;
        let eff_date = if rule.effective_date.trim().is_empty() {
            iso_now_tx(&tx)[..10].to_string()
        } else {
            rule.effective_date.clone()
        };

        tx.execute(
            r#"
            INSERT INTO bpjs_rules (
                id, component_code, component_name, rate_percentage, wage_cap, effective_date
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
            ON CONFLICT(component_code) DO UPDATE SET
                component_name = excluded.component_name,
                rate_percentage = excluded.rate_percentage,
                wage_cap = excluded.wage_cap,
                effective_date = excluded.effective_date;
            "#,
            params![
                rule_id,
                rule.component_code,
                rule.component_name,
                rule.rate_percentage,
                rule.wage_cap,
                eff_date
            ],
        )
        .map_err(|_| CommandError::new("SAVE_FAILED", "Gagal memperbarui aturan BPJS."))?;

        sync::enqueue(
            &tx,
            &client_id,
            "payroll",
            "bpjs-rule",
            &rule_id,
            &json!({
                "id": rule_id,
                "component_code": rule.component_code.clone(),
                "component_name": rule.component_name.clone(),
                "rate_percentage": rule.rate_percentage,
                "wage_cap": rule.wage_cap,
                "effective_date": eff_date.clone(),
            }),
            None,
        )?;
    }

    tx.commit().map_err(|_| CommandError::internal())?;
    Ok(true)
}

#[tauri::command]
pub async fn desktop_get_payroll_recap(
    state: State<'_, DesktopState>,
    period_start: String,
    period_end: String,
) -> Result<Vec<PayrollRecapRow>, CommandError> {
    require_permission(&state, "payroll.view")?;
    let conn = storage::database(&state.data_dir)?;

    let overtime_tiers = load_overtime_tiers(&conn, "HARI_KERJA")?;
    // Jenjang lembur hari libur dikonfigurasi terpisah oleh user di menu
    // "Aturan Jenjang Lembur" (rule_type = 'HARI_LIBUR'). Sebelum ini kedua
    // jenjang itu tersimpan dan bisa disunting, tetapi tidak pernah dibaca
    // siapa pun — seluruh lembur selalu dihitung dengan tarif HARI_KERJA.
    let holiday_tiers = load_overtime_tiers(&conn, "HARI_LIBUR")?;
    let components = load_payroll_components(&conn)?;
    let tax_rules = load_tax_rules(&conn, &period_end)?;
    let bpjs_rules = load_bpjs_rules(&conn, &period_end)?;
    // Kasbon: jatah cicilan per BULAN, dinilai terhadap bulan tanggal mulai
    // periode (sama dengan penundaan dan bulan mulai potong).
    let kasbon_aktif =
        loan::pinjaman_aktif(&conn, &period_start.chars().take(7).collect::<String>())?;
    // Pengajuan cuti/izin/sakit `Dibayar` (HRIS v37, A-4): hari hadir FLAT_DAILY
    // dan menit reguler HOURLY. Cermin `cutiDibayar` di `computePayrollRecap`.
    let cuti_dibayar = crate::desktop::hr_pengajuan::cuti_dibayar(&conn, &period_start, &period_end)?;
    // Mode SPL (HRIS v38, Q-56, Q-57). Cermin `lemburSpl` di `computePayrollRecap`.
    let (lembur_mode, lembur_potong) = crate::desktop::hr_pengajuan::lembur_spl(&conn, &period_start, &period_end)?;
    // Reimbursement mode `gaji` (HRIS v39). Cermin `reimburseGaji` di `computePayrollRecap`.
    let reimburse = crate::desktop::hr_pengajuan::reimburse_gaji(&conn, &period_end)?;
    // Run lain di tahun pajak yang sama sampai masa ini (fase 13, §29.3).
    let pembanding = muat_pembanding(&conn, &period_start)?;
    let masa = pajak::masa(&period_start);

    let mut stmt = conn
        .prepare(&format!(
            r#"
            SELECT 
                md.id_unik,
                md.nama,
                md.divisi,
                COALESCE(sc.rate_per_hour, 0) AS rate_per_hour,
                COALESCE(sc.ptkp_status, 'TK/0') AS ptkp_status,
                COUNT(CASE WHEN ah.status_kehadiran IN ('Hadir', 'PRESENT') THEN 1 END) AS total_hadir,
                COALESCE(SUM(ah.menit_terlambat), 0) AS total_terlambat_menit,
                COALESCE(SUM(CASE WHEN (hl.tanggal IS NOT NULL OR COALESCE(instr(COALESCE(NULLIF(TRIM(sh.hari_kerja), ''), '1,2,3,4,5,6,7'), replace(strftime('%w', ah.tanggal), '0', '7')), 1) = 0) THEN 0 ELSE ah.jam_kerja END), 0) AS total_jam_kerja_menit,
                COALESCE(SUM(CASE WHEN (hl.tanggal IS NOT NULL OR COALESCE(instr(COALESCE(NULLIF(TRIM(sh.hari_kerja), ''), '1,2,3,4,5,6,7'), replace(strftime('%w', ah.tanggal), '0', '7')), 1) = 0) THEN 0 ELSE ah.lembur END), 0) AS total_lembur_menit,
                COALESCE(SUM(CASE WHEN (hl.tanggal IS NOT NULL OR COALESCE(instr(COALESCE(NULLIF(TRIM(sh.hari_kerja), ''), '1,2,3,4,5,6,7'), replace(strftime('%w', ah.tanggal), '0', '7')), 1) = 0)
                    THEN COALESCE(ah.jam_kerja, 0) + COALESCE(ah.lembur, 0) ELSE 0 END), 0) AS total_libur_menit,
                COALESCE(sc.salary_type, 'HOURLY') AS salary_type,
                COALESCE(sc.daily_rate, 0) AS daily_rate,
                -- Hari UNIK: sesi PENGGANTI di tanggal yang sama tidak menambah hari,
                -- dan hari berlaporan perjalanan driver ikut dihitung hadir (v34).
                {hari_hadir} AS days_present,
                -- Jam kerja (tanpa lembur) yang jatuh pada hari libur; dipakai
                -- `apply_holiday_fallback` bila jenjang HARI_LIBUR tidak aktif.
                COALESCE(SUM(CASE WHEN (hl.tanggal IS NOT NULL OR COALESCE(instr(COALESCE(NULLIF(TRIM(sh.hari_kerja), ''), '1,2,3,4,5,6,7'), replace(strftime('%w', ah.tanggal), '0', '7')), 1) = 0)
                    THEN COALESCE(ah.jam_kerja, 0) ELSE 0 END), 0) AS total_libur_jam_kerja_menit,
                -- Status, tanggal keluar, dan PTKP awal tahun untuk masa pajak (v45).
                {kolom_pajak}
            FROM master_data md
            LEFT JOIN salary_configs sc ON sc.id_karyawan = md.id_unik
                AND sc.effective_date = (
                    SELECT MAX(effective_date) FROM salary_configs
                    WHERE id_karyawan = md.id_unik AND effective_date <= ?2
                )
            LEFT JOIN absensi_harian ah ON ah.id_karyawan = md.id_unik
                AND ah.tanggal >= ?1 AND ah.tanggal <= ?2
            -- Penanda hari libur diambil dari tanggal kerja barisnya, BUKAN dari
            -- kolom pada absensi_harian. `tbl_hari_libur.tanggal` UNIQUE sehingga
            -- join ini tidak pernah menggandakan baris, dan absensi lama otomatis
            -- ikut terhitung benar begitu admin melengkapi daftar hari liburnya.
            LEFT JOIN tbl_hari_libur hl ON hl.tanggal = ah.tanggal AND hl.status_aktif = 1
            -- Libur mingguan: tanggal di luar hari kerja shift barisnya ikut
            -- dihitung jam hari libur (PP 35/2021 menyamakan istirahat mingguan
            -- dengan hari libur resmi untuk lembur). replace() mengubah 0
            -- (Minggu) dari strftime('%w') menjadi 7; hari_kerja kosong = 7 hari.
            LEFT JOIN tbl_shift sh ON sh.id_shift = ah.id_shift
            -- Karyawan aktif, dan yang keluar di dalam periode ini supaya gaji
            -- terakhirnya tetap terhitung (PRD HRIS §20.6).
            WHERE {karyawan}
            GROUP BY md.id_unik
            ORDER BY md.nama ASC;
            "#,
            karyawan = crate::desktop::hr_keluar::karyawan_rekap("?1"),
            hari_hadir = super::super::driver::HARI_HADIR_SQL,
            kolom_pajak = pajak::KOLOM_PAJAK_SQL
        ))
        .map_err(|_| CommandError::internal())?;

    struct TempAgg {
        id_unik: String,
        nama: String,
        divisi: String,
        rate_per_hour: i64,
        ptkp_status: String,
        total_hadir: i64,
        total_terlambat: i64,
        jam_kerja_menit: i64,
        lembur_menit: i64,
        libur_menit: i64,
        salary_type: String,
        daily_rate: i64,
        days_present: i64,
        libur_jam_kerja_menit: i64,
        jenis_personil: Option<String>,
        keluar_pada: Option<String>,
        ptkp_awal_tahun: String,
    }

    let rows = stmt
        .query_map(params![period_start, period_end], |row| {
            Ok(TempAgg {
                id_unik: row.get(0)?,
                nama: row.get(1)?,
                divisi: row.get(2)?,
                rate_per_hour: row.get(3)?,
                ptkp_status: row.get(4)?,
                total_hadir: row.get(5)?,
                total_terlambat: row.get(6)?,
                jam_kerja_menit: row.get(7)?,
                lembur_menit: row.get(8)?,
                libur_menit: row.get(9)?,
                salary_type: row.get(10)?,
                daily_rate: row.get(11)?,
                days_present: row.get(12)?,
                libur_jam_kerja_menit: row.get(13)?,
                jenis_personil: row.get(14)?,
                keluar_pada: row.get(15)?,
                ptkp_awal_tahun: row.get(16)?,
            })
        })
        .map_err(|_| CommandError::internal())?;

    let rules = PayRules {
        overtime_tiers: &overtime_tiers,
        holiday_tiers: &holiday_tiers,
        components: &components,
        tax_rules: &tax_rules,
        bpjs_rules: &bpjs_rules,
    };
    let mut result = Vec::new();

    for item in rows {
        if let Ok(agg) = item {
            // Tanpa jenjang HARI_LIBUR aktif, jam hari libur dibayar seperti
            // hari biasa; menit yang sudah disesuaikan ini juga yang dibekukan.
            let (cuti_hari, cuti_menit) =
                cuti_dibayar.get(&agg.id_unik).copied().unwrap_or((0, 0));
            let days_present = agg.days_present + cuti_hari;
            // Mode `spl`: lembur tanpa SPL atau melebihi SPL tidak dibayar,
            // sebelum fallback hari libur.
            let potong = lembur_potong.get(&agg.id_unik).copied().unwrap_or_default();
            let (jam_kerja_menit, lembur_menit, libur_menit) =
                PayrollCalculator::apply_holiday_fallback(
                    agg.jam_kerja_menit + cuti_menit,
                    agg.lembur_menit - potong.lembur,
                    agg.libur_menit - potong.libur_total,
                    agg.libur_jam_kerja_menit - potong.libur_jam_kerja,
                    !holiday_tiers.is_empty(),
                );
            let reg_hours = Decimal::from(jam_kerja_menit) / Decimal::from(60);
            let ot_hours = Decimal::from(lembur_menit) / Decimal::from(60);
            let holiday_hours = Decimal::from(libur_menit) / Decimal::from(60);
            let ringkas = pajak::ringkas_pembanding(
                pembanding.get(&agg.id_unik).map(Vec::as_slice).unwrap_or(&[]),
                &masa,
                pajak::status_pph(agg.jenis_personil.as_deref(), &agg.salary_type),
            );
            let pay = PayrollCalculator::calculate_employee_pay(
                &PayInput {
                    id_karyawan: &agg.id_unik,
                    salary_type: &agg.salary_type,
                    rate_per_hour: agg.rate_per_hour,
                    daily_rate: agg.daily_rate,
                    days_present,
                    regular_minutes: jam_kerja_menit,
                    overtime_minutes: lembur_menit,
                    holiday_minutes: libur_menit,
                    pajak: KonteksPajak {
                        period_start: &period_start,
                        period_end: &period_end,
                        jenis_personil: agg.jenis_personil.as_deref(),
                        ptkp_awal_tahun: &agg.ptkp_awal_tahun,
                        keluar_pada: agg.keluar_pada.as_deref(),
                        pembanding: &ringkas,
                    },
                },
                &rules,
            );
            let ot_index = pay.overtime_index;
            let holiday_index = pay.holiday_index;
            let basic_salary = pay.basic;
            let overtime_salary = pay.overtime;
            let allowance = pay.allowance;
            let deduction = pay.deduction;
            let gross = pay.gross;
            let bpjs_emp = pay.bpjs_employee;
            let pph21 = pay.pph21;
            // Kasbon dipotong TERAKHIR dari gaji bersih yang tersisa, aturan
            // yang sama persis dengan pembekuan di bawah dan `potongKasbon` Web.
            let (kasbon, _) = loan::potong_kasbon(
                pay.net.to_i64().unwrap_or(0),
                kasbon_aktif
                    .get(&agg.id_unik)
                    .map(Vec::as_slice)
                    .unwrap_or(&[]),
            );
            // Reimbursement SESUDAH kasbon, jadi tidak bisa termakan kasbon.
            let est_reimburse: i64 = reimburse
                .get(&agg.id_unik)
                .map(|klaim| klaim.iter().map(|(_, nominal)| nominal).sum())
                .unwrap_or(0);
            let net = pay.net - Decimal::from(kasbon) + Decimal::from(est_reimburse);
            let deduction = deduction + Decimal::from(kasbon);

            result.push(PayrollRecapRow {
                id_karyawan: agg.id_unik,
                nama_karyawan: agg.nama,
                divisi: agg.divisi,
                rate_per_hour: agg.rate_per_hour,
                ptkp_status: agg.ptkp_status,
                total_hadir: agg.total_hadir,
                total_terlambat_menit: agg.total_terlambat,
                total_regular_hours: reg_hours.to_f64().unwrap_or(0.0),
                total_overtime_hours: ot_hours.to_f64().unwrap_or(0.0),
                total_overtime_index: ot_index.to_f64().unwrap_or(0.0),
                total_holiday_hours: holiday_hours.to_f64().unwrap_or(0.0),
                total_holiday_overtime_index: holiday_index.to_f64().unwrap_or(0.0),
                // Menit mentah ikut dibawa supaya pembekuan bisa menurunkan
                // jamnya dengan cara yang sama persis seperti di sini, alih-alih
                // membaca ulang `f64` di bawah yang presisinya sudah hilang.
                total_regular_minutes: jam_kerja_menit,
                total_overtime_minutes: lembur_menit,
                total_holiday_minutes: libur_menit,
                est_basic_salary: basic_salary.to_i64().unwrap_or(0),
                est_overtime_salary: overtime_salary.to_i64().unwrap_or(0),
                est_gross_salary: gross.to_i64().unwrap_or(0),
                est_total_allowance: allowance.to_i64().unwrap_or(0),
                est_total_deduction: deduction.to_i64().unwrap_or(0),
                est_bpjs_employee: bpjs_emp.to_i64().unwrap_or(0),
                est_pph21: pph21.to_i64().unwrap_or(0),
                est_net_salary: net.to_i64().unwrap_or(0),
                est_kasbon: kasbon,
                salary_type: agg.salary_type,
                daily_rate: agg.daily_rate,
                days_present,
                cuti_dibayar_hari: cuti_hari,
                cuti_dibayar_menit: cuti_menit,
                lembur_mode: lembur_mode.clone(),
                lembur_tanpa_spl_menit: potong.tanpa_spl,
                lembur_dipotong_menit: potong.lembur + potong.libur_total,
                est_reimburse,
                jenis_personil: agg.jenis_personil,
                keluar_pada: agg.keluar_pada,
                ptkp_awal_tahun: agg.ptkp_awal_tahun,
                pajak: serde_json::to_value(&pay.pajak).unwrap_or_default(),
            });
        }
    }

    Ok(result)
}

#[tauri::command]
pub async fn desktop_create_payroll_run(
    state: State<'_, DesktopState>,
    idempotency_key: String,
    period_start: String,
    period_end: String,
) -> Result<PayrollRun, CommandError> {
    let operator = require_permission(&state, "payroll.run.create")?;
    let mut conn = storage::database(&state.data_dir)?;

    // Idempotency check: jika key sudah ada, kembalikan data existing
    if let Some(existing) = conn
        .query_row(
            r#"
            SELECT id, idempotency_key, period_start, period_end, status,
                   total_gross_payout, total_net_payout, total_employees,
                   created_by, created_at, updated_at
            FROM payroll_runs
            WHERE idempotency_key = ?1;
            "#,
            params![idempotency_key],
            |row| {
                Ok(PayrollRun {
                    id: row.get(0)?,
                    idempotency_key: row.get(1)?,
                    period_start: row.get(2)?,
                    period_end: row.get(3)?,
                    status: row.get(4)?,
                    total_gross_payout: row.get(5)?,
                    total_net_payout: row.get(6)?,
                    total_employees: row.get(7)?,
                    created_by: row.get(8)?,
                    created_at: row.get(9)?,
                    updated_at: row.get(10)?,
                })
            },
        )
        .optional()
        .map_err(|_| CommandError::internal())?
    {
        return Ok(existing);
    }

    // Kalkulasi data payroll
    let recap = desktop_get_payroll_recap(state.clone(), period_start.clone(), period_end.clone()).await?;

    let overtime_tiers = load_overtime_tiers(&conn, "HARI_KERJA")?;
    let holiday_tiers = load_overtime_tiers(&conn, "HARI_LIBUR")?;
    let components = load_payroll_components(&conn)?;
    let tax_rules = load_tax_rules(&conn, &period_end)?;
    let bpjs_rules = load_bpjs_rules(&conn, &period_end)?;
    let kasbon_aktif =
        loan::pinjaman_aktif(&conn, &period_start.chars().take(7).collect::<String>())?;
    let reimburse = crate::desktop::hr_pengajuan::reimburse_gaji(&conn, &period_end)?;
    let pembanding = muat_pembanding(&conn, &period_start)?;
    let masa = pajak::masa(&period_start);

    let tx = conn.transaction().map_err(|_| CommandError::internal())?;

    let run_id = new_payroll_id(&format!("PR-{}", period_start.replace('-', "")));
    let now = iso_now_tx(&tx);

    let mut total_gross_sum = 0i64;
    let mut total_net_sum = 0i64;
    let total_emp_count = recap.len() as i64;
    let mut calculated_items = Vec::new();
    let rules = PayRules {
        overtime_tiers: &overtime_tiers,
        holiday_tiers: &holiday_tiers,
        components: &components,
        tax_rules: &tax_rules,
        bpjs_rules: &bpjs_rules,
    };

    for row in &recap {
        let item_id = format!("{}-{}", run_id, row.id_karyawan);
        // Dihitung dari MENIT MENTAH lewat fungsi yang sama dengan
        // `desktop_get_payroll_recap`, bukan dari jam `f64` yang presisinya
        // sudah hilang — angka yang DISETUJUI admin harus sama dengan angka
        // yang DIBEKUKAN, sampai titik tengah pembulatannya.
        let ringkas = pajak::ringkas_pembanding(
            pembanding.get(&row.id_karyawan).map(Vec::as_slice).unwrap_or(&[]),
            &masa,
            pajak::status_pph(row.jenis_personil.as_deref(), &row.salary_type),
        );
        let pay = PayrollCalculator::calculate_employee_pay(
            &PayInput {
                id_karyawan: &row.id_karyawan,
                salary_type: &row.salary_type,
                rate_per_hour: row.rate_per_hour,
                daily_rate: row.daily_rate,
                days_present: row.days_present,
                regular_minutes: row.total_regular_minutes,
                overtime_minutes: row.total_overtime_minutes,
                holiday_minutes: row.total_holiday_minutes,
                pajak: KonteksPajak {
                    period_start: &period_start,
                    period_end: &period_end,
                    jenis_personil: row.jenis_personil.as_deref(),
                    ptkp_awal_tahun: &row.ptkp_awal_tahun,
                    keluar_pada: row.keluar_pada.as_deref(),
                    pembanding: &ringkas,
                },
            },
            &rules,
        );
        let ot_index = pay.overtime_index;
        let holiday_index = pay.holiday_index;
        let basic_salary = pay.basic;
        let overtime_salary = pay.overtime;
        let allowance = pay.allowance;
        let deduction = pay.deduction;
        let gross = pay.gross;
        let bpjs_emp = pay.bpjs_employee;
        let bpjs_co = pay.bpjs_company;
        let pph21 = pay.pph21;
        // Kasbon TERAKHIR, sama dengan pratinjau. `breakdown.kasbon` dibaca saat
        // proses gaji ditandai PAID untuk mencatat angsuran; entri komponennya
        // membuat slip langsung menampilkannya.
        let (kasbon, rincian_kasbon) = loan::potong_kasbon(
            pay.net.to_i64().unwrap_or(0),
            kasbon_aktif
                .get(&row.id_karyawan)
                .map(Vec::as_slice)
                .unwrap_or(&[]),
        );
        // Reimbursement mode `gaji` sesudah kasbon, sama dengan pratinjau.
        let klaim_reimburse = reimburse.get(&row.id_karyawan).cloned().unwrap_or_default();
        let total_reimburse: i64 = klaim_reimburse.iter().map(|(_, nominal)| nominal).sum();
        let net = pay.net - Decimal::from(kasbon) + Decimal::from(total_reimburse);
        let deduction = deduction + Decimal::from(kasbon);
        let mut components_snapshot = pay.components;
        components_snapshot.extend(loan::komponen_kasbon(&rincian_kasbon));

        let snapshot = json!({
            "salary_type": row.salary_type,
            "daily_rate": row.daily_rate,
            "days_present": row.days_present,
            "cuti_dibayar": { "hari": row.cuti_dibayar_hari, "menit": row.cuti_dibayar_menit },
            "lembur_spl": {
                "mode": row.lembur_mode,
                "dipotong_menit": row.lembur_dipotong_menit,
                "tanpa_spl_menit": row.lembur_tanpa_spl_menit,
            },
            "rate_per_hour": row.rate_per_hour,
            "regular_hours": row.total_regular_hours,
            "overtime_hours": row.total_overtime_hours,
            "overtime_index": ot_index.to_f64().unwrap_or(0.0),
            "holiday_hours": row.total_holiday_hours,
            "holiday_overtime_index": holiday_index.to_f64().unwrap_or(0.0),
            "basic_salary": basic_salary.to_i64().unwrap_or(0),
            "overtime_salary": overtime_salary.to_i64().unwrap_or(0),
            "components": components_snapshot,
            "bpjs": pay.bpjs,
            "bpjs_masa": pay.bpjs_masa,
            "tax": pay.tax,
            "pajak": pay.pajak,
            "kasbon": loan::rincian_kasbon_json(&rincian_kasbon),
            "reimburse": crate::desktop::hr_pengajuan::rincian_reimburse_json(&klaim_reimburse),
            "calculated_at": now.clone()
        });

        let basic_i64 = basic_salary.to_i64().unwrap_or(0);
        let ot_i64 = overtime_salary.to_i64().unwrap_or(0);
        let gross_i64 = gross.to_i64().unwrap_or(0);
        let allow_i64 = allowance.to_i64().unwrap_or(0);
        let deduct_i64 = deduction.to_i64().unwrap_or(0);
        let bpjs_emp_i64 = bpjs_emp.to_i64().unwrap_or(0);
        let bpjs_co_i64 = bpjs_co.to_i64().unwrap_or(0);
        let pph21_i64 = pph21.to_i64().unwrap_or(0);
        let net_i64 = net.to_i64().unwrap_or(0);

        total_gross_sum += gross_i64;
        total_net_sum += net_i64;

        calculated_items.push((
            item_id,
            row.id_karyawan.clone(),
            row.nama_karyawan.clone(),
            row.divisi.clone(),
            row.ptkp_status.clone(),
            row.total_regular_hours,
            row.total_overtime_hours,
            ot_index.to_f64().unwrap_or(0.0),
            row.total_holiday_hours,
            holiday_index.to_f64().unwrap_or(0.0),
            row.rate_per_hour,
            basic_i64,
            ot_i64,
            gross_i64,
            allow_i64,
            deduct_i64,
            bpjs_emp_i64,
            bpjs_co_i64,
            pph21_i64,
            net_i64,
            snapshot.to_string(),
            row.salary_type.clone(),
            row.daily_rate,
            row.days_present,
        ));
    }

    let items_json: Vec<Value> = calculated_items
        .iter()
        .map(|it| {
            json!({
                "id": it.0.clone(),
                "payroll_run_id": run_id.clone(),
                "id_karyawan": it.1.clone(),
                "nama_karyawan": it.2.clone(),
                "divisi": it.3.clone(),
                "ptkp_status": it.4.clone(),
                "total_regular_hours": it.5,
                "total_overtime_hours": it.6,
                "total_overtime_index": it.7,
                "total_holiday_hours": it.8,
                "total_holiday_overtime_index": it.9,
                "rate_per_hour": it.10,
                "basic_salary": it.11,
                "overtime_salary": it.12,
                "gross_salary": it.13,
                "total_allowances": it.14,
                "total_deductions": it.15,
                "bpjs_employee_total": it.16,
                "bpjs_company_total": it.17,
                "pph21_amount": it.18,
                "net_salary": it.19,
                "breakdown_snapshot": it.20.clone(),
                "created_at": now.clone(),
                "salary_type": it.21.clone(),
                "daily_rate": it.22,
                "days_present": it.23,
            })
        })
        .collect();

    // 1. Insert parent payroll_runs terlebih dahulu agar lolos foreign key constraint
    tx.execute(
        r#"
        INSERT INTO payroll_runs (
            id, idempotency_key, period_start, period_end, status,
            total_gross_payout, total_net_payout, total_employees,
            created_by, created_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, 'DRAFT', ?5, ?6, ?7, ?8, ?9, ?10);
        "#,
        params![
            run_id,
            idempotency_key,
            period_start,
            period_end,
            total_gross_sum,
            total_net_sum,
            total_emp_count,
            operator.username,
            now,
            now
        ],
    )
    .map_err(|_| CommandError::new("RUN_FAILED", "Gagal membuat batch payroll baru."))?;

    // 2. Insert child payroll_items dengan relasi foreign key ke payroll_runs(id)
    for it in calculated_items {
        tx.execute(
            r#"
            INSERT INTO payroll_items (
                id, payroll_run_id, id_karyawan, nama_karyawan, divisi, ptkp_status,
                total_regular_hours, total_overtime_hours, total_overtime_index,
                total_holiday_hours, total_holiday_overtime_index,
                rate_per_hour, basic_salary, overtime_salary, gross_salary,
                total_allowances, total_deductions, bpjs_employee_total, bpjs_company_total,
                pph21_amount, net_salary, breakdown_snapshot, created_at,
                salary_type, daily_rate, days_present
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26);
            "#,
            params![
                it.0,
                run_id,
                it.1,
                it.2,
                it.3,
                it.4,
                it.5,
                it.6,
                it.7,
                it.8,
                it.9,
                it.10,
                it.11,
                it.12,
                it.13,
                it.14,
                it.15,
                it.16,
                it.17,
                it.18,
                it.19,
                it.20,
                now,
                it.21,
                it.22,
                it.23
            ],
        )
        .map_err(|_| CommandError::new("RUN_FAILED", "Gagal menyimpan rincian slip gaji karyawan."))?;
    }

    let audit_id = new_payroll_id("audit");
    tx.execute(
        r#"
        INSERT INTO payroll_audit_logs (
            id, payroll_run_id, action, old_status, new_status, performed_by, notes, created_at
        ) VALUES (?1, ?2, 'CREATE_RUN', NULL, 'DRAFT', ?3, 'Batch payroll dibuat.', ?4);
        "#,
        params![audit_id, run_id, operator.username, now],
    )
    .map_err(|_| CommandError::internal())?;

    let client_id = sync::ensure_client_id(&state)?;
    sync::enqueue(
        &tx,
        &client_id,
        "payroll",
        "create-run",
        &run_id,
        &json!({
            "run": {
                "id": run_id.clone(),
                "idempotency_key": idempotency_key.clone(),
                "period_start": period_start.clone(),
                "period_end": period_end.clone(),
                "status": "DRAFT",
                "total_gross_payout": total_gross_sum,
                "total_net_payout": total_net_sum,
                "total_employees": total_emp_count,
                "created_by": operator.username.clone(),
                "created_at": now.clone(),
                "updated_at": now.clone(),
            },
            "items": items_json,
            "audit": {
                "id": audit_id,
                "payroll_run_id": run_id.clone(),
                "action": "CREATE_RUN",
                "old_status": Value::Null,
                "new_status": "DRAFT",
                "performed_by": operator.username.clone(),
                "notes": "Batch payroll dibuat.",
                "created_at": now.clone(),
            },
        }),
        None,
    )?;

    tx.commit().map_err(|_| CommandError::internal())?;

    Ok(PayrollRun {
        id: run_id,
        idempotency_key,
        period_start,
        period_end,
        status: "DRAFT".to_string(),
        total_gross_payout: total_gross_sum,
        total_net_payout: total_net_sum,
        total_employees: total_emp_count,
        created_by: operator.username,
        created_at: now.clone(),
        updated_at: now,
    })
}

#[tauri::command]
pub async fn desktop_list_payroll_runs(
    state: State<'_, DesktopState>,
    status: Option<String>,
) -> Result<Vec<PayrollRun>, CommandError> {
    require_permission(&state, "payroll.view")?;
    let conn = storage::database(&state.data_dir)?;

    let status_filter = status.unwrap_or_default();
    let query = if status_filter.is_empty() {
        "SELECT id, idempotency_key, period_start, period_end, status,
                total_gross_payout, total_net_payout, total_employees,
                created_by, created_at, updated_at
         FROM payroll_runs ORDER BY period_start DESC, created_at DESC;"
    } else {
        "SELECT id, idempotency_key, period_start, period_end, status,
                total_gross_payout, total_net_payout, total_employees,
                created_by, created_at, updated_at
         FROM payroll_runs WHERE status = ?1 ORDER BY period_start DESC, created_at DESC;"
    };

    let mut stmt = conn.prepare(query).map_err(|_| CommandError::internal())?;

    let map_fn = |row: &rusqlite::Row| {
        Ok(PayrollRun {
            id: row.get(0)?,
            idempotency_key: row.get(1)?,
            period_start: row.get(2)?,
            period_end: row.get(3)?,
            status: row.get(4)?,
            total_gross_payout: row.get(5)?,
            total_net_payout: row.get(6)?,
            total_employees: row.get(7)?,
            created_by: row.get(8)?,
            created_at: row.get(9)?,
            updated_at: row.get(10)?,
        })
    };

    let rows: Vec<PayrollRun> = if status_filter.is_empty() {
        stmt.query_map([], map_fn)
            .map_err(|_| CommandError::internal())?
            .filter_map(|r| r.ok())
            .collect()
    } else {
        stmt.query_map(params![status_filter], map_fn)
            .map_err(|_| CommandError::internal())?
            .filter_map(|r| r.ok())
            .collect()
    };

    Ok(rows)
}

#[tauri::command]
pub async fn desktop_get_payroll_run_detail(
    state: State<'_, DesktopState>,
    run_id: String,
) -> Result<serde_json::Value, CommandError> {
    require_permission(&state, "payroll.view")?;
    let conn = storage::database(&state.data_dir)?;

    let run: PayrollRun = conn
        .query_row(
            r#"
            SELECT id, idempotency_key, period_start, period_end, status,
                   total_gross_payout, total_net_payout, total_employees,
                   created_by, created_at, updated_at
            FROM payroll_runs
            WHERE id = ?1;
            "#,
            params![run_id],
            |row| {
                Ok(PayrollRun {
                    id: row.get(0)?,
                    idempotency_key: row.get(1)?,
                    period_start: row.get(2)?,
                    period_end: row.get(3)?,
                    status: row.get(4)?,
                    total_gross_payout: row.get(5)?,
                    total_net_payout: row.get(6)?,
                    total_employees: row.get(7)?,
                    created_by: row.get(8)?,
                    created_at: row.get(9)?,
                    updated_at: row.get(10)?,
                })
            },
        )
        .map_err(|_| CommandError::new("NOT_FOUND", "Batch payroll tidak ditemukan."))?;

    let mut items_stmt = conn
        .prepare(
            r#"
            SELECT id, payroll_run_id, id_karyawan, nama_karyawan, divisi, ptkp_status,
                   total_regular_hours, total_overtime_hours, total_overtime_index,
                   COALESCE(total_holiday_hours, 0), COALESCE(total_holiday_overtime_index, 0),
                   rate_per_hour, basic_salary, overtime_salary, gross_salary,
                   total_allowances, total_deductions, bpjs_employee_total, bpjs_company_total,
                   pph21_amount, net_salary, breakdown_snapshot, created_at,
                   COALESCE(salary_type, 'HOURLY'), COALESCE(daily_rate, 0), COALESCE(days_present, 0)
            FROM payroll_items
            WHERE payroll_run_id = ?1
            ORDER BY nama_karyawan ASC;
            "#,
        )
        .map_err(|_| CommandError::internal())?;

    let items: Vec<PayrollItem> = items_stmt
        .query_map(params![run_id], |row| {
            Ok(PayrollItem {
                id: row.get(0)?,
                payroll_run_id: row.get(1)?,
                id_karyawan: row.get(2)?,
                nama_karyawan: row.get(3)?,
                divisi: row.get(4)?,
                ptkp_status: row.get(5)?,
                total_regular_hours: row.get(6)?,
                total_overtime_hours: row.get(7)?,
                total_overtime_index: row.get(8)?,
                total_holiday_hours: row.get(9)?,
                total_holiday_overtime_index: row.get(10)?,
                rate_per_hour: row.get(11)?,
                basic_salary: row.get(12)?,
                overtime_salary: row.get(13)?,
                gross_salary: row.get(14)?,
                total_allowances: row.get(15)?,
                total_deductions: row.get(16)?,
                bpjs_employee_total: row.get(17)?,
                bpjs_company_total: row.get(18)?,
                pph21_amount: row.get(19)?,
                net_salary: row.get(20)?,
                breakdown_snapshot: row.get(21)?,
                created_at: row.get(22)?,
                salary_type: row.get(23)?,
                daily_rate: row.get(24)?,
                days_present: row.get(25)?,
            })
        })
        .map_err(|_| CommandError::internal())?
        .filter_map(|r| r.ok())
        .collect();

    let mut logs_stmt = conn
        .prepare(
            r#"
            SELECT id, payroll_run_id, action, old_status, new_status, performed_by, notes, created_at
            FROM payroll_audit_logs
            WHERE payroll_run_id = ?1
            ORDER BY created_at ASC;
            "#,
        )
        .map_err(|_| CommandError::internal())?;

    let audit_logs: Vec<PayrollAuditLog> = logs_stmt
        .query_map(params![run_id], |row| {
            Ok(PayrollAuditLog {
                id: row.get(0)?,
                payroll_run_id: row.get(1)?,
                action: row.get(2)?,
                old_status: row.get(3)?,
                new_status: row.get(4)?,
                performed_by: row.get(5)?,
                notes: row.get(6)?,
                created_at: row.get(7)?,
            })
        })
        .map_err(|_| CommandError::internal())?
        .filter_map(|r| r.ok())
        .collect();

    Ok(json!({
        "run": run,
        "items": items,
        "audit_logs": audit_logs
    }))
}

#[tauri::command]
pub async fn desktop_transition_payroll_status(
    state: State<'_, DesktopState>,
    run_id: String,
    target_status: String,
    notes: Option<String>,
    id_akun_bayar: Option<String>,
) -> Result<PayrollRun, CommandError> {
    let target = PayrollStatus::from_str(&target_status)
        .ok_or_else(|| CommandError::new("INVALID_STATUS", "Status target tidak valid."))?;

    // Layer 2 Guard: verifikasi permission per status transition
    let required_permission = match target {
        PayrollStatus::Submitted => "payroll.run.create",
        PayrollStatus::Reviewed => "payroll.run.review",
        PayrollStatus::Approved => "payroll.run.approve",
        PayrollStatus::Paid => "payroll.run.disburse",
        PayrollStatus::Rejected => "payroll.run.review",
        PayrollStatus::Draft => "payroll.run.create",
    };

    let operator = require_permission(&state, required_permission)?;
    let mut conn = storage::database(&state.data_dir)?;

    let (current_status_str, idempotency_key, period_start, period_end, gross, net, emp_count, created_by, created_at): (
        String, String, String, String, i64, i64, i64, String, String
    ) = conn
        .query_row(
            r#"
            SELECT status, idempotency_key, period_start, period_end,
                   total_gross_payout, total_net_payout, total_employees,
                   created_by, created_at
            FROM payroll_runs
            WHERE id = ?1;
            "#,
            params![run_id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                    row.get(7)?,
                    row.get(8)?,
                ))
            },
        )
        .map_err(|_| CommandError::new("NOT_FOUND", "Batch payroll tidak ditemukan."))?;

    let current = PayrollStatus::from_str(&current_status_str)
        .ok_or_else(|| CommandError::new("STATE_ERROR", "Status saat ini tidak valid."))?;

    // State Machine Exhaustive Match: cegah jumping status ilegal
    if !current.can_transition_to(&target) {
        return Err(CommandError::new(
            "ILLEGAL_TRANSITION",
            format!(
                "Tidak dapat mengubah status dari {} ke {}.",
                current.as_str(),
                target.as_str()
            ),
        ));
    }

    // Akun pembayaran diperiksa SEBELUM status berubah: proses gaji yang
    // tercatat PAID tanpa jurnal tidak bisa diulang, karena PAID status akhir.
    let akun_bayar = id_akun_bayar.as_deref().unwrap_or(loan::AKUN_KAS);
    if target == PayrollStatus::Paid {
        crate::desktop::accounting::assert_akun_bayar(&conn, akun_bayar)?;
    }

    let tx = conn.transaction().map_err(|_| CommandError::internal())?;
    let now = iso_now_tx(&tx);

    tx.execute(
        "UPDATE payroll_runs SET status = ?1, updated_at = ?2 WHERE id = ?3;",
        params![target.as_str(), now, run_id],
    )
    .map_err(|_| CommandError::new("UPDATE_FAILED", "Gagal memperbarui status payroll."))?;

    let audit_id = new_payroll_id("audit");
    let notes_text = notes.unwrap_or_default();
    tx.execute(
        r#"
        INSERT INTO payroll_audit_logs (
            id, payroll_run_id, action, old_status, new_status, performed_by, notes, created_at
        ) VALUES (?1, ?2, 'TRANSITION_STATUS', ?3, ?4, ?5, ?6, ?7);
        "#,
        params![
            audit_id,
            run_id,
            current.as_str(),
            target.as_str(),
            operator.username,
            notes_text,
            now
        ],
    )
    .map_err(|_| CommandError::internal())?;

    let client_id = sync::ensure_client_id(&state)?;
    sync::enqueue(
        &tx,
        &client_id,
        "payroll",
        "transition-status",
        &run_id,
        &json!({
            "id": run_id.clone(),
            "status": target.as_str(),
            "updated_at": now.clone(),
            "audit": {
                "id": audit_id,
                "payroll_run_id": run_id.clone(),
                "action": "TRANSITION_STATUS",
                "old_status": current.as_str(),
                "new_status": target.as_str(),
                "performed_by": operator.username.clone(),
                "notes": notes_text,
                "created_at": now.clone(),
            },
        }),
        None,
    )?;

    if target == PayrollStatus::Paid {
        // Angsuran kasbon dan jurnal payroll di transaksi yang SAMA dengan
        // perubahan status: proses gaji tidak pernah tercatat dibayar tanpa
        // pembukuannya, dan sebaliknya.
        loan::catat_pembayaran_payroll_tx(
            &tx,
            &state,
            &client_id,
            &run_id,
            akun_bayar,
            &operator.username,
        )?;
    }

    tx.commit().map_err(|_| CommandError::internal())?;

    Ok(PayrollRun {
        id: run_id,
        idempotency_key,
        period_start,
        period_end,
        status: target.as_str().to_string(),
        total_gross_payout: gross,
        total_net_payout: net,
        total_employees: emp_count,
        created_by,
        created_at,
        updated_at: now,
    })
}

// Helper loaders
fn load_overtime_tiers(conn: &Connection, rule_type: &str) -> Result<Vec<OvertimeTierRule>, CommandError> {
    let mut stmt = conn
        .prepare(
            r#"
            SELECT id, rule_type, tier_order, hour_start, hour_end, multiplier, is_active
            FROM overtime_tier_rules
            WHERE rule_type = ?1 AND is_active = 1
            ORDER BY tier_order ASC;
            "#,
        )
        .map_err(|_| CommandError::internal())?;

    let rows = stmt
        .query_map(params![rule_type], |row| {
            Ok(OvertimeTierRule {
                id: row.get(0)?,
                rule_type: row.get(1)?,
                tier_order: row.get(2)?,
                hour_start: row.get(3)?,
                hour_end: row.get(4)?,
                multiplier: row.get(5)?,
                is_active: row.get(6)?,
            })
        })
        .map_err(|_| CommandError::internal())?;

    Ok(rows.filter_map(|r| r.ok()).collect())
}

/// Item run pembanding per karyawan (`pajak::RUN_TAHUN_SQL`). Dibaca dari
/// SQLite lokal: run perangkat lain yang belum tersinkron tidak terlihat,
/// jadi gateway menjalankan `syncNow()` sebelum membuat run.
fn muat_pembanding(
    conn: &Connection,
    period_start: &str,
) -> Result<HashMap<String, Vec<ItemPembanding>>, CommandError> {
    let mut stmt = conn
        .prepare(pajak::RUN_TAHUN_SQL)
        .map_err(|_| CommandError::internal())?;
    let rows = stmt
        .query_map(params![period_start], |row| {
            Ok((
                row.get::<_, String>(0)?,
                ItemPembanding {
                    masa: row.get(1)?,
                    gross_salary: row.get(2)?,
                    pph21_amount: row.get(3)?,
                    salary_type: row.get(4)?,
                    breakdown_snapshot: row.get(5)?,
                },
            ))
        })
        .map_err(|_| CommandError::internal())?;
    let mut hasil: HashMap<String, Vec<ItemPembanding>> = HashMap::new();
    for row in rows {
        let (id_karyawan, item) = row.map_err(|_| CommandError::internal())?;
        hasil.entry(id_karyawan).or_default().push(item);
    }
    Ok(hasil)
}

fn load_payroll_components(conn: &Connection) -> Result<Vec<PayrollComponent>, CommandError> {
    let mut stmt = conn
        .prepare(
            r#"
            SELECT id, name, category, calc_type, default_value, applies_to, is_active, dasar_bpjs
            FROM payroll_components
            WHERE is_active = 1
            ORDER BY category, name ASC;
            "#,
        )
        .map_err(|_| CommandError::internal())?;

    let rows = stmt
        .query_map([], |row| {
            Ok(PayrollComponent {
                id: row.get(0)?,
                name: row.get(1)?,
                category: row.get(2)?,
                calc_type: row.get(3)?,
                default_value: row.get(4)?,
                applies_to: row.get(5)?,
                is_active: row.get(6)?,
                dasar_bpjs: row.get(7)?,
            })
        })
        .map_err(|_| CommandError::internal())?;

    Ok(rows.filter_map(|r| r.ok()).collect())
}

/// Tarif yang BERLAKU pada akhir periode, bukan seluruh isi tabelnya.
///
/// `effective_date` sudah ada di skema sejak awal dan didokumentasikan sebagai
/// kunci generasi tarif, tetapi tidak pernah dipakai menyaring: tabelnya dibaca
/// utuh, lalu pencarian tarif (kini `pajak::tarif_ter`) memakai `.find()` — bracket PERTAMA yang
/// cocok. Begitu admin menambahkan tabel TER tahun depan, periode berjalan
/// memakai bracket yang urutannya tidak ditentukan siapa pun, karena dua baris
/// dengan `bracket_min` sama diurutkan sembarang oleh SQLite.
///
/// Polanya disalin dari `salary_configs` di query rekap — generasi terbaru yang
/// sudah berlaku, per kategori. `COALESCE` ke generasi terawal menjaga periode
/// yang lebih tua daripada seluruh tarif tetap punya tarif, alih-alih diam-diam
/// menghasilkan potongan nol. Cerminan TS-nya: `loadTaxRules` di
/// `payroll-recap.ts`.
fn load_tax_rules(conn: &Connection, period_end: &str) -> Result<Vec<TaxRule>, CommandError> {
    let mut stmt = conn
        .prepare(
            r#"
            SELECT id, category, bracket_min, bracket_max, rate_percentage, effective_date
            FROM tax_rules
            WHERE effective_date = COALESCE(
                (SELECT MAX(t2.effective_date) FROM tax_rules t2
                  WHERE t2.category = tax_rules.category AND t2.effective_date <= ?1),
                (SELECT MIN(t3.effective_date) FROM tax_rules t3
                  WHERE t3.category = tax_rules.category)
            )
            ORDER BY category, bracket_min ASC;
            "#,
        )
        .map_err(|_| CommandError::internal())?;

    let rows = stmt
        .query_map([period_end], |row| {
            Ok(TaxRule {
                id: row.get(0)?,
                category: row.get(1)?,
                bracket_min: row.get(2)?,
                bracket_max: row.get(3)?,
                rate_percentage: row.get(4)?,
                effective_date: row.get(5)?,
            })
        })
        .map_err(|_| CommandError::internal())?;

    Ok(rows.filter_map(|r| r.ok()).collect())
}

/// Iuran BPJS yang BERLAKU pada akhir periode — alasan dan polanya sama dengan
/// `load_tax_rules`. Cerminan TS-nya: `loadBpjsRules` di `payroll-recap.ts`.
fn load_bpjs_rules(conn: &Connection, period_end: &str) -> Result<Vec<BpjsRule>, CommandError> {
    let mut stmt = conn
        .prepare(
            r#"
            SELECT id, component_code, component_name, rate_percentage, wage_cap, effective_date
            FROM bpjs_rules
            WHERE effective_date = COALESCE(
                (SELECT MAX(b2.effective_date) FROM bpjs_rules b2
                  WHERE b2.component_code = bpjs_rules.component_code AND b2.effective_date <= ?1),
                (SELECT MIN(b3.effective_date) FROM bpjs_rules b3
                  WHERE b3.component_code = bpjs_rules.component_code)
            )
            ORDER BY component_code ASC;
            "#,
        )
        .map_err(|_| CommandError::internal())?;

    let rows = stmt
        .query_map([period_end], |row| {
            Ok(BpjsRule {
                id: row.get(0)?,
                component_code: row.get(1)?,
                component_name: row.get(2)?,
                rate_percentage: row.get(3)?,
                wage_cap: row.get(4)?,
                effective_date: row.get(5)?,
            })
        })
        .map_err(|_| CommandError::internal())?;

    Ok(rows.filter_map(|r| r.ok()).collect())
}

#[cfg(test)]
mod tests {
    use super::new_payroll_id;
    use std::collections::HashSet;

    #[test]
    fn id_payroll_tidak_bertabrakan_dalam_satu_detik() {
        // Fungsi simpan massal memanggilnya berkali-kali dalam loop yang sama —
        // persis keadaan yang dulu memberi setiap baris id identik.
        let ids: HashSet<String> = (0..500).map(|_| new_payroll_id("ot-hari_kerja")).collect();
        assert_eq!(ids.len(), 500);
    }

    #[test]
    fn id_payroll_mempertahankan_awalan_yang_terbaca() {
        let id = new_payroll_id("PR-20260901");
        assert!(id.starts_with("PR-20260901-"));
        let suffix = id.rsplit('-').next().unwrap_or_default();
        assert_eq!(suffix.len(), 12);
        assert!(suffix.chars().all(|c| c.is_ascii_hexdigit()));
    }
}

/// Fase 13 (§29.9 langkah 3): `RUN_TAHUN_SQL` dan `KOLOM_PAJAK_SQL` pada
/// skema SQLite lokal, lalu rumus masa lewat `calculate_employee_pay`.
#[cfg(test)]
mod tests_pajak {
    use super::super::engine::{EmployeePay, KonteksPajak, PayInput, PayRules, PayrollCalculator};
    use super::super::models::{BpjsRule, TaxRule};
    use super::super::pajak::{self, Pembanding};
    use super::muat_pembanding;
    use crate::desktop::storage;
    use rusqlite::{params, Connection};
    use rust_decimal::Decimal;
    use serde_json::json;

    fn db() -> (tempfile::TempDir, Connection) {
        let dir = tempfile::tempdir().expect("direktori sementara");
        storage::initialize(dir.path()).expect("skema lokal");
        let conn = storage::database(dir.path()).expect("database lokal");
        (dir, conn)
    }

    fn run(conn: &Connection, id: &str, mulai: &str, akhir: &str, status: &str) {
        conn.execute(
            "INSERT INTO payroll_runs (id, idempotency_key, period_start, period_end, status, created_by, created_at, updated_at)
             VALUES (?1, ?1, ?2, ?3, ?4, 'uji', '2026-01-01', '2026-01-01');",
            params![id, mulai, akhir, status],
        )
        .expect("run");
    }

    fn item(conn: &Connection, run: &str, karyawan: &str, gross: i64, pph: i64, snapshot: serde_json::Value) {
        conn.execute(
            "INSERT INTO payroll_items (id, payroll_run_id, id_karyawan, nama_karyawan, divisi,
                 total_regular_hours, total_overtime_hours, total_overtime_index, rate_per_hour,
                 basic_salary, overtime_salary, gross_salary, pph21_amount, net_salary, breakdown_snapshot, created_at)
             VALUES (?1 || '-' || ?2, ?1, ?2, 'Uji', 'Umum', 0, 0, 0, 0, ?3, 0, ?3, ?4, ?3, ?5, '2026-01-01');",
            params![run, karyawan, gross, pph, snapshot.to_string()],
        )
        .expect("item");
    }

    /// Item hasil rumus baru (kunci `pajak` dan `bpjs_masa`).
    fn snapshot_baru(bruto: i64, bpjs: serde_json::Value) -> serde_json::Value {
        json!({"pajak": {"bruto_pajak": bruto, "status": "tetap"}, "bpjs_masa": {"dasar_run": bruto}, "bpjs": bpjs})
    }

    fn lapis() -> Vec<TaxRule> {
        crate::desktop::payroll_seed::tarif_bawaan()
            .pajak
            .iter()
            .map(|t| TaxRule {
                id: t.id.clone(),
                category: t.category.clone(),
                bracket_min: t.bracket_min,
                bracket_max: t.bracket_max,
                rate_percentage: t.rate_percentage,
                effective_date: t.effective_date.clone(),
            })
            .collect()
    }

    /// Gaji per jam sebesar `gross` (tarif × 160 jam) untuk satu run.
    fn bayar(
        gross: i64,
        periode: (&str, &str),
        ptkp: &str,
        keluar_pada: Option<&str>,
        pembanding: &Pembanding,
        bpjs: &[BpjsRule],
    ) -> EmployeePay {
        let tax = lapis();
        let rules = PayRules {
            overtime_tiers: &[],
            holiday_tiers: &[],
            components: &[],
            tax_rules: &tax,
            bpjs_rules: bpjs,
        };
        PayrollCalculator::calculate_employee_pay(
            &PayInput {
                id_karyawan: "K1",
                salary_type: "HOURLY",
                rate_per_hour: gross / 160,
                daily_rate: 0,
                days_present: 20,
                regular_minutes: 9_600,
                overtime_minutes: 0,
                holiday_minutes: 0,
                pajak: KonteksPajak {
                    period_start: periode.0,
                    period_end: periode.1,
                    jenis_personil: Some("Pegawai"),
                    ptkp_awal_tahun: ptkp,
                    keluar_pada,
                    pembanding,
                },
            },
            &rules,
        )
    }

    fn jp_emp() -> Vec<BpjsRule> {
        vec![BpjsRule {
            id: "bpjs_jp_emp".into(),
            component_code: "JP_EMP".into(),
            component_name: "JP".into(),
            rate_percentage: 1.0,
            wage_cap: Some(11_086_300),
            effective_date: "2026-03-01".into(),
        }]
    }

    /// Dua run sebulan (V10/V11 dengan 8.000.000): run kedua menambal PPh dan
    /// JP masa; run `REJECTED`, tahun lalu, dan masa sesudahnya tidak dihitung.
    #[test]
    fn pajak_dua_run_sebulan_dan_rejected_diabaikan() {
        let (_dir, conn) = db();
        let jp = json!([{"code": "JP_EMP", "nominal": 80_000}]);
        run(&conn, "R1", "2026-01-01", "2026-01-15", "DRAFT");
        item(&conn, "R1", "K1", 8_000_000, 120_000, snapshot_baru(8_000_000, jp.clone()));
        run(&conn, "RX", "2026-01-01", "2026-01-15", "REJECTED");
        item(&conn, "RX", "K1", 8_000_000, 999_999, snapshot_baru(8_000_000, jp.clone()));
        run(&conn, "R0", "2025-12-01", "2025-12-31", "PAID");
        item(&conn, "R0", "K1", 8_000_000, 120_000, snapshot_baru(8_000_000, jp.clone()));
        run(&conn, "RF", "2026-02-01", "2026-02-28", "DRAFT");
        item(&conn, "RF", "K1", 8_000_000, 120_000, snapshot_baru(8_000_000, jp));

        let semua = muat_pembanding(&conn, "2026-01-16").expect("pembanding");
        let items = semua.get("K1").expect("item K1");
        assert_eq!(items.len(), 1, "REJECTED, tahun lalu, atau Februari ikut terbaca");
        let pembanding = pajak::ringkas_pembanding(items, "2026-01", pajak::STATUS_TETAP);
        assert_eq!((pembanding.bruto_masa, pembanding.pph_masa, pembanding.run_masa), (8_000_000, 120_000, 1));

        let pay = bayar(8_000_000, ("2026-01-16", "2026-01-31"), "TK/0", None, &pembanding, &jp_emp());
        // JP masa 1% × 11.086.300 = 110.863, dikurangi 80.000.
        assert_eq!(pay.bpjs_employee, Decimal::from(30_863));
        // TER A masa 16.000.000 = 7% → 1.120.000, dikurangi 120.000.
        assert_eq!(pay.pph21, Decimal::from(1_000_000));
        assert_eq!((pay.pajak.bruto_masa, pay.pajak.tarif), (Some(16_000_000), Some(700)));
        assert_eq!(pay.net, Decimal::from(8_000_000 - 30_863 - 1_000_000));
        assert!(pay.pajak.tanda.is_empty(), "{:?}", pay.pajak.tanda);
    }

    /// Masa Desember: Pasal 17 setahun dikurangi PPh Januari–November; run
    /// Januari dibuat rumus lama (tanpa `pajak`) tetap terhitung dan ditandai.
    #[test]
    fn pajak_masa_desember_menghitung_ulang_setahun_termasuk_run_lama() {
        let (_dir, conn) = db();
        let jht = json!([{"code": "JHT_EMP", "nominal": 100_000}]);
        for bulan in 1..=11 {
            let id = format!("R{bulan:02}");
            run(&conn, &id, &format!("2026-{bulan:02}-01"), &format!("2026-{bulan:02}-28"), "PAID");
            let snapshot = if bulan == 1 {
                json!({"bpjs": jht.clone()})
            } else {
                snapshot_baru(10_000_000, jht.clone())
            };
            item(&conn, &id, "K1", 10_000_000, 200_000, snapshot);
        }
        let semua = muat_pembanding(&conn, "2026-12-01").expect("pembanding");
        let pembanding = pajak::ringkas_pembanding(&semua["K1"], "2026-12", pajak::STATUS_TETAP);
        assert_eq!((pembanding.bruto_tahun, pembanding.masa_berbruto_lain), (110_000_000, 11));

        let pay = bayar(10_000_000, ("2026-12-01", "2026-12-31"), "K/0", None, &pembanding, &[]);
        let p = &pay.pajak;
        assert_eq!(p.metode, pajak::METODE_PASAL_17_TERAKHIR);
        // 120.000.000 − 6.000.000 − 1.100.000 − 58.500.000 = 54.400.000.
        assert_eq!((p.biaya_jabatan, p.iuran_pensiun, p.pkp), (Some(6_000_000), Some(1_100_000), Some(54_400_000)));
        assert_eq!((p.pph_setahun, p.pph), (Some(2_720_000), 520_000));
        assert_eq!(p.tanda, vec!["rumus_lama"]);
    }

    /// `KOLOM_PAJAK_SQL`: PTKP awal tahun (Q-180) dan tanggal keluar hanya
    /// bila `id_keluar` terisi; bulan keluar menjadi masa terakhir.
    #[test]
    fn pajak_kolom_konteks_dan_karyawan_keluar() {
        let (_dir, conn) = db();
        conn.execute_batch(
            "INSERT INTO master_data (id_unik, nama, divisi, id_shift, jenis_personil, id_keluar, tanggal_selesai_aktif)
               VALUES ('K3', 'Keluar', 'Umum', 1, 'Kontrak', 'klr-1', '2026-08-20'),
                      ('K4', 'Baru', 'Umum', 1, NULL, NULL, NULL),
                      ('K5', 'Selesai', 'Umum', 1, 'Harian', NULL, '2026-08-20');
             INSERT INTO salary_configs (id, id_karyawan, rate_per_hour, ptkp_status, effective_date, created_by, created_at) VALUES
               ('s1', 'K3', 1, 'K/1', '2025-06-01', 'uji', '2025-06-01'),
               ('s2', 'K3', 1, 'K/2', '2026-05-01', 'uji', '2026-05-01'),
               ('s3', 'K4', 1, 'TK/1', '2026-03-01', 'uji', '2026-03-01'),
               ('s4', 'K4', 1, 'K/0', '2026-07-01', 'uji', '2026-07-01');",
        )
        .expect("data karyawan");
        let baca = |id: &str| -> (Option<String>, Option<String>, String) {
            conn.query_row(
                &format!("SELECT {} FROM master_data md WHERE md.id_unik = ?3;", pajak::KOLOM_PAJAK_SQL),
                params!["2026-08-01", "2026-08-31", id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .expect("kolom pajak")
        };
        assert_eq!(baca("K3"), (Some("Kontrak".into()), Some("2026-08-20".into()), "K/1".into()));
        assert_eq!(baca("K4"), (None, None, "TK/1".into()));
        assert_eq!(baca("K5"), (Some("Harian".into()), None, "TK/0".into()));

        let (_, keluar, ptkp) = baca("K3");
        let pembanding = Pembanding::default();
        let agustus = bayar(17_500_000, ("2026-08-01", "2026-08-31"), &ptkp, keluar.as_deref(), &pembanding, &[]);
        assert_eq!(agustus.pajak.metode, pajak::METODE_PASAL_17_TERAKHIR);
        assert_eq!(agustus.pajak.ptkp, Some(63_000_000));
        let juli = bayar(17_500_000, ("2026-07-01", "2026-07-31"), &ptkp, keluar.as_deref(), &pembanding, &[]);
        assert_eq!(juli.pajak.metode, pajak::METODE_TER_BULANAN);
    }
}
