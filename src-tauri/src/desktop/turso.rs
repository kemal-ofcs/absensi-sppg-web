use std::collections::{HashMap, HashSet};
use std::net::IpAddr;
use std::sync::Mutex;

use argon2::PasswordVerifier;
use base64::prelude::*;
use pbkdf2::pbkdf2_hmac;
use reqwest::{header::HeaderMap, Client, StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use url::Url;
use zeroize::Zeroizing;

use super::{
    models::{CommandError, OperatorUser},
    sync,
};

pub fn normalize_turso_url(raw: &str) -> Result<Url, CommandError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(CommandError::new(
            "TURSO_URL_INVALID",
            "URL database Turso tidak boleh kosong.",
        ));
    }

    let https_url_str = if let Some(stripped) = trimmed.strip_prefix("libsql://") {
        format!("https://{stripped}")
    } else {
        trimmed.to_owned()
    };

    let mut parsed = Url::parse(&https_url_str).map_err(|_| {
        CommandError::new(
            "TURSO_URL_INVALID",
            "Format URL database Turso tidak valid (contoh: libsql://db-name.turso.io atau https://db-name.turso.io).",
        )
    })?;

    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(CommandError::new(
            "TURSO_URL_INVALID",
            "URL database Turso harus menggunakan protokol libsql://, https://, atau http://.",
        ));
    }
    if parsed.host_str().is_none() || !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(CommandError::new(
            "TURSO_URL_INVALID",
            "URL database Turso harus memiliki host dan tidak boleh memuat kredensial.",
        ));
    }
    if parsed.scheme() == "http" {
        let host = parsed.host_str().unwrap_or_default();
        let is_local = host.eq_ignore_ascii_case("localhost")
            || host == "10.0.2.2"
            || host.parse::<IpAddr>().is_ok_and(|ip| match ip {
                IpAddr::V4(address) => address.is_loopback() || address.is_private(),
                IpAddr::V6(address) => address.is_loopback() || address.is_unique_local(),
            });
        if !cfg!(debug_assertions) || !is_local {
            return Err(CommandError::new(
                "TURSO_URL_INSECURE",
                "HTTP hanya diizinkan untuk localhost atau IP lokal pada build debug.",
            ));
        }
    }

    parsed.set_path("");
    parsed.set_query(None);
    parsed.set_fragment(None);
    Ok(parsed)
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TursoConfig {
    pub database_url: String,
    pub auth_token: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TursoConnectionStatus {
    pub connected: bool,
    pub url: String,
    pub latency_ms: Option<u64>,
    pub error_message: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BootstrapStatus {
    pub configured: bool,
    pub required: bool,
    pub server_origin: String,
}

/// Tabel inti yang wajib ada agar database dianggap benar-benar database Absensi SPPG.
const DATABASE_CHECK_CORE_TABLES: [&str; 6] = [
    "app_role",
    "master_operator",
    "master_data",
    "tbl_shift",
    "absensi_harian",
    "log_scan",
];

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseCheckResult {
    pub reachable: bool,
    pub server_origin: String,
    pub latency_ms: Option<u64>,
    pub empty_database: bool,
    pub schema_ready: bool,
    pub missing_tables: Vec<String>,
    pub table_count: i64,
    pub bootstrap_claimed: bool,
    pub superadmin_exists: bool,
    pub superadmin_count: i64,
    pub superadmin_username: Option<String>,
    pub operator_count: i64,
    pub karyawan_count: i64,
    pub attendance_count: i64,
    pub company_name: Option<String>,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
}

impl DatabaseCheckResult {
    pub fn unreachable(server_origin: String, error: &CommandError) -> Self {
        Self {
            reachable: false,
            server_origin,
            latency_ms: None,
            empty_database: false,
            schema_ready: false,
            missing_tables: Vec::new(),
            table_count: 0,
            bootstrap_claimed: false,
            superadmin_exists: false,
            superadmin_count: 0,
            superadmin_username: None,
            operator_count: 0,
            karyawan_count: 0,
            attendance_count: 0,
            company_name: None,
            error_code: Some(error.code.to_owned()),
            error_message: Some(error.message.clone()),
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
pub struct BootstrapSuperadminDraft {
    pub kode_operator: String,
    pub nama_operator: String,
    pub username: String,
    pub password: String,
}

#[derive(Clone, Debug)]
pub struct Statement {
    pub sql: String,
    pub args: Vec<Value>,
}

impl Statement {
    pub fn new(sql: impl Into<String>, args: Vec<Value>) -> Self {
        Self {
            sql: sql.into(),
            args,
        }
    }

    fn to_libsql_v2_stmt(&self) -> Value {
        let args_val: Vec<Value> = self
            .args
            .iter()
            .map(|arg| match arg {
                Value::Null => json!({ "type": "null" }),
                Value::Bool(b) => json!({ "type": "integer", "value": if *b { 1 } else { 0 } }),
                Value::Number(n) => {
                    if let Some(i) = n.as_i64() {
                        json!({ "type": "integer", "value": i.to_string() })
                    } else if let Some(f) = n.as_f64() {
                        json!({ "type": "float", "value": f })
                    } else {
                        json!({ "type": "null" })
                    }
                }
                Value::String(s) => json!({ "type": "text", "value": s }),
                _ => json!({ "type": "text", "value": arg.to_string() }),
            })
            .collect();

        json!({
            "sql": self.sql,
            "args": args_val
        })
    }
}

#[derive(Default)]
struct StatementCollector {
    statements: Mutex<Vec<Statement>>,
}

impl StatementCollector {
    async fn query_one(
        &self,
        sql: impl Into<String>,
        args: Vec<Value>,
    ) -> Result<QueryResult, CommandError> {
        self.statements
            .lock()
            .map_err(|_| CommandError::internal())?
            .push(Statement::new(sql, args));
        Ok(QueryResult::default())
    }

    fn finish(self) -> Result<Vec<Statement>, CommandError> {
        self.statements
            .into_inner()
            .map_err(|_| CommandError::internal())
    }
}

fn atomic_batch_steps(statements: &[Statement]) -> (Vec<Value>, usize) {
    let mut steps = Vec::with_capacity(statements.len() + 3);
    steps.push(json!({
        "stmt": Statement::new("BEGIN IMMEDIATE;", vec![]).to_libsql_v2_stmt()
    }));
    let mut previous_step = 0_usize;
    for statement in statements {
        steps.push(json!({
            "condition": { "type": "ok", "step": previous_step },
            "stmt": statement.to_libsql_v2_stmt()
        }));
        previous_step += 1;
    }
    let commit_step = steps.len();
    steps.push(json!({
        "condition": { "type": "ok", "step": previous_step },
        "stmt": Statement::new("COMMIT;", vec![]).to_libsql_v2_stmt()
    }));
    steps.push(json!({
        "condition": {
            "type": "not",
            "cond": { "type": "ok", "step": commit_step }
        },
        "stmt": Statement::new("ROLLBACK;", vec![]).to_libsql_v2_stmt()
    }));
    (steps, commit_step)
}

#[derive(Clone, Debug, Default, serde::Serialize)]
pub struct QueryResult {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<Value>>,
    #[allow(dead_code)]
    pub rows_affected: u64,
    pub last_insert_rowid: Option<i64>,
}

impl QueryResult {
    pub fn to_objects(&self) -> Vec<HashMap<String, Value>> {
        self.rows
            .iter()
            .map(|row| {
                let mut map = HashMap::new();
                for (col_idx, col_name) in self.columns.iter().enumerate() {
                    let val = row.get(col_idx).cloned().unwrap_or(Value::Null);
                    map.insert(col_name.clone(), val);
                }
                map
            })
            .collect()
    }
}

/// Cache proses-wide berisi URL database yang skemanya sudah diverifikasi mutakhir.
///
/// `DesktopState::get_turso_client` membuat `TursoClient` baru setiap kali dipanggil,
/// jadi cache tidak boleh menempel di instance — kalau tidak, `ensure_schema_current`
/// menambah satu round-trip ke Turso di setiap push dan setiap pull.
static SCHEMA_VERIFIED: std::sync::OnceLock<Mutex<HashSet<String>>> = std::sync::OnceLock::new();

fn schema_verified_cache() -> &'static Mutex<HashSet<String>> {
    SCHEMA_VERIFIED.get_or_init(|| Mutex::new(HashSet::new()))
}

/// Satu tabel operasional cloud yang ikut ditarik ke SQLite lokal.
///
/// Daftar ini adalah sumber tunggal untuk dua hal sekaligus: query pembacaan
/// snapshot dan daftar tabel yang dipasangi trigger `sync_pulse`. Menambah
/// tabel snapshot baru cukup di sini — jangan bikin daftar kedua.
struct SnapshotSource {
    payload_key: &'static str,
    table: &'static str,
    sql: &'static str,
}

const SNAPSHOT_SOURCES: &[SnapshotSource] = &[
    SnapshotSource {
        payload_key: "employees",
        table: "master_data",
        sql: "SELECT * FROM master_data;",
    },
    SnapshotSource {
        payload_key: "idCards",
        table: "id_card",
        sql: "SELECT * FROM id_card;",
    },
    SnapshotSource {
        payload_key: "shifts",
        table: "tbl_shift",
        sql: "SELECT * FROM tbl_shift ORDER BY id_shift;",
    },
    SnapshotSource {
        payload_key: "holidays",
        table: "tbl_hari_libur",
        sql: "SELECT * FROM tbl_hari_libur ORDER BY tanggal;",
    },
    SnapshotSource {
        payload_key: "settings",
        table: "setting_gex_system",
        sql: "SELECT key, value FROM setting_gex_system;",
    },
    SnapshotSource {
        payload_key: "companyProfiles",
        table: "company_profile",
        sql: "SELECT * FROM company_profile;",
    },
    SnapshotSource {
        payload_key: "idCardTemplates",
        table: "id_card_template",
        sql: "SELECT * FROM id_card_template;",
    },
    SnapshotSource {
        payload_key: "backups",
        table: "backup_karyawan",
        sql: "SELECT * FROM backup_karyawan;",
    },
    SnapshotSource {
        payload_key: "corrections",
        table: "koreksi_admin",
        sql: "SELECT * FROM koreksi_admin;",
    },
    SnapshotSource {
        payload_key: "imports",
        table: "import_offline",
        sql: "SELECT * FROM import_offline;",
    },
    SnapshotSource {
        payload_key: "attendance",
        table: "absensi_harian",
        sql: "SELECT * FROM absensi_harian;",
    },
    SnapshotSource {
        payload_key: "scanLogs",
        table: "log_scan",
        sql: "SELECT * FROM log_scan ORDER BY timestamp_scan;",
    },
    SnapshotSource {
        payload_key: "salaryConfigs",
        table: "salary_configs",
        sql: "SELECT * FROM salary_configs ORDER BY id_karyawan, effective_date DESC;",
    },
    SnapshotSource {
        payload_key: "overtimeTierRules",
        table: "overtime_tier_rules",
        sql: "SELECT * FROM overtime_tier_rules ORDER BY rule_type, tier_order;",
    },
    SnapshotSource {
        payload_key: "payrollComponents",
        table: "payroll_components",
        sql: "SELECT * FROM payroll_components ORDER BY category, name;",
    },
    SnapshotSource {
        payload_key: "taxRules",
        table: "tax_rules",
        sql: "SELECT * FROM tax_rules ORDER BY category, bracket_min;",
    },
    SnapshotSource {
        payload_key: "bpjsRules",
        table: "bpjs_rules",
        sql: "SELECT * FROM bpjs_rules ORDER BY component_code;",
    },
    SnapshotSource {
        payload_key: "payrollRuns",
        table: "payroll_runs",
        sql: "SELECT * FROM payroll_runs ORDER BY period_start DESC, created_at DESC;",
    },
    SnapshotSource {
        payload_key: "payrollItems",
        table: "payroll_items",
        sql: "SELECT * FROM payroll_items ORDER BY created_at;",
    },
    SnapshotSource {
        payload_key: "payrollAuditLogs",
        table: "payroll_audit_logs",
        sql: "SELECT * FROM payroll_audit_logs ORDER BY created_at;",
    },
];

pub struct TursoClient {
    base_url: Url,
    auth_token: Zeroizing<String>,
    http: Client,
}

impl TursoClient {
    pub fn new(base_url: Url, auth_token: String, http: Client) -> Self {
        Self {
            base_url,
            auth_token: Zeroizing::new(auth_token),
            http,
        }
    }

    pub fn from_config(config: &TursoConfig, http: Client) -> Result<Self, CommandError> {
        let base_url = normalize_turso_url(&config.database_url)?;
        if config.auth_token.trim().is_empty() && base_url.scheme() == "https" {
            return Err(CommandError::new(
                "TURSO_TOKEN_REQUIRED",
                "Auth Token database Turso wajib diisi untuk koneksi HTTPS.",
            ));
        }
        Ok(Self::new(base_url, config.auth_token.clone(), http))
    }

    pub fn base_url(&self) -> &Url {
        &self.base_url
    }

    #[allow(dead_code)]
    pub fn auth_token(&self) -> &str {
        &self.auth_token
    }

    pub async fn execute_pipeline(
        &self,
        statements: Vec<Statement>,
    ) -> Result<Vec<QueryResult>, CommandError> {
        let mut endpoint = self.base_url.clone();
        endpoint.set_path("/v2/pipeline");

        let requests: Vec<Value> = statements
            .iter()
            .map(|stmt| {
                json!({
                    "type": "execute",
                    "stmt": stmt.to_libsql_v2_stmt()
                })
            })
            .chain(std::iter::once(json!({ "type": "close" })))
            .collect();

        let payload = json!({ "requests": requests });

        let mut headers = HeaderMap::new();
        if !self.auth_token.is_empty() {
            let auth_header_val = format!("Bearer {}", self.auth_token.as_str());
            headers.insert(
                reqwest::header::AUTHORIZATION,
                reqwest::header::HeaderValue::from_str(&auth_header_val)
                    .map_err(|_| CommandError::internal())?,
            );
        }

        let response = self
            .http
            .post(endpoint)
            .headers(headers)
            .json(&payload)
            .send()
            .await
            .map_err(|e| {
                CommandError::new(
                    "TURSO_NETWORK_ERROR",
                    format!("Gagal menghubungi database Turso: {e}"),
                )
            })?;

        let status = response.status();
        if !status.is_success() {
            let error_body = response.text().await.unwrap_or_default();
            if status == StatusCode::UNAUTHORIZED || status == StatusCode::FORBIDDEN {
                return Err(CommandError::new(
                    "TURSO_AUTH_FAILED",
                    "Auth Token database Turso tidak valid atau kedaluwarsa.",
                ));
            }
            return Err(CommandError::new(
                "TURSO_QUERY_FAILED",
                format!(
                    "Database Turso mengembalikan error ({status}): {}",
                    error_body.chars().take(500).collect::<String>()
                ),
            ));
        }

        let text = response.text().await.map_err(|e| {
            CommandError::new(
                "TURSO_RESPONSE_INVALID",
                format!("Gagal membaca data respon Turso: {e}"),
            )
        })?;

        let body: Value = serde_json::from_str(&text).map_err(|e| {
            let snippet = text.chars().take(250).collect::<String>();
            CommandError::new(
                "TURSO_RESPONSE_INVALID",
                format!("Format JSON respon Turso tidak valid: {e}. Data mentah: {snippet}"),
            )
        })?;

        let results_arr = body
            .get("results")
            .and_then(Value::as_array)
            .ok_or_else(|| {
                CommandError::new("TURSO_RESPONSE_INVALID", "Format hasil pipeline kosong.")
            })?;

        let mut query_results = Vec::new();
        for (i, res) in results_arr.iter().enumerate() {
            if i >= statements.len() {
                break; // Abaikan close request
            }
            let res_type = res.get("type").and_then(Value::as_str).unwrap_or("");
            if res_type != "ok" {
                let err_msg = res
                    .get("error")
                    .and_then(|e| e.get("message"))
                    .and_then(Value::as_str)
                    .unwrap_or("Query SQL gagal dieksekusi di Turso.");
                return Err(CommandError::new("TURSO_SQL_ERROR", err_msg));
            }

            let exec_res = res
                .get("response")
                .and_then(|r| r.get("result"))
                .cloned()
                .unwrap_or(Value::Null);

            let columns: Vec<String> = exec_res
                .get("cols")
                .and_then(Value::as_array)
                .map(|cols| {
                    cols.iter()
                        .filter_map(|c| c.get("name").and_then(Value::as_str).map(|s| s.to_owned()))
                        .collect()
                })
                .unwrap_or_default();

            let rows_arr = exec_res.get("rows").and_then(Value::as_array);
            let mut parsed_rows = Vec::new();

            if let Some(rows) = rows_arr {
                for row_val in rows {
                    if let Some(cells) = row_val.as_array() {
                        let parsed_cells: Vec<Value> = cells
                            .iter()
                            .map(|cell| {
                                let ctype = cell.get("type").and_then(Value::as_str).unwrap_or("");
                                match ctype {
                                    "null" => Value::Null,
                                    "integer" => {
                                        let v = cell.get("value");
                                        if let Some(s) = v.and_then(Value::as_str) {
                                            s.parse::<i64>()
                                                .map(|num| json!(num))
                                                .unwrap_or_else(|_| json!(s))
                                        } else if let Some(n) = v.and_then(Value::as_i64) {
                                            json!(n)
                                        } else {
                                            Value::Null
                                        }
                                    }
                                    "float" => cell.get("value").cloned().unwrap_or(Value::Null),
                                    "text" => cell.get("value").cloned().unwrap_or(Value::Null),
                                    "blob" => cell.get("base64").cloned().unwrap_or(Value::Null),
                                    _ => cell.clone(),
                                }
                            })
                            .collect();
                        parsed_rows.push(parsed_cells);
                    }
                }
            }

            let rows_affected = exec_res
                .get("affected_row_count")
                .and_then(Value::as_u64)
                .unwrap_or(0);
            let last_insert_rowid = exec_res.get("last_insert_rowid").and_then(|v| {
                if let Some(s) = v.as_str() {
                    s.parse::<i64>().ok()
                } else {
                    v.as_i64()
                }
            });

            query_results.push(QueryResult {
                columns,
                rows: parsed_rows,
                rows_affected,
                last_insert_rowid,
            });
        }

        Ok(query_results)
    }

    pub async fn execute_atomic(&self, statements: Vec<Statement>) -> Result<(), CommandError> {
        if statements.is_empty() {
            return Ok(());
        }
        let mut endpoint = self.base_url.clone();
        endpoint.set_path("/v2/pipeline");

        let (steps, commit_step) = atomic_batch_steps(&statements);

        let payload = json!({
            "requests": [
                { "type": "batch", "batch": { "steps": steps } },
                { "type": "close" }
            ]
        });
        let mut headers = HeaderMap::new();
        if !self.auth_token.is_empty() {
            let auth_header_val = format!("Bearer {}", self.auth_token.as_str());
            headers.insert(
                reqwest::header::AUTHORIZATION,
                reqwest::header::HeaderValue::from_str(&auth_header_val)
                    .map_err(|_| CommandError::internal())?,
            );
        }
        let response = self
            .http
            .post(endpoint)
            .headers(headers)
            .json(&payload)
            .send()
            .await
            .map_err(|error| {
                CommandError::new(
                    "TURSO_NETWORK_ERROR",
                    format!("Gagal menghubungi database Turso: {error}"),
                )
            })?;
        let status = response.status();
        let text = response.text().await.map_err(|error| {
            CommandError::new(
                "TURSO_RESPONSE_INVALID",
                format!("Gagal membaca data respon Turso: {error}"),
            )
        })?;
        if !status.is_success() {
            if status == StatusCode::UNAUTHORIZED || status == StatusCode::FORBIDDEN {
                return Err(CommandError::new(
                    "TURSO_AUTH_FAILED",
                    "Auth Token database Turso tidak valid atau kedaluwarsa.",
                ));
            }
            return Err(CommandError::new(
                "TURSO_QUERY_FAILED",
                format!(
                    "Database Turso mengembalikan error ({status}): {}",
                    text.chars().take(500).collect::<String>()
                ),
            ));
        }
        let body: Value = serde_json::from_str(&text).map_err(|error| {
            CommandError::new(
                "TURSO_RESPONSE_INVALID",
                format!(
                    "Format JSON respon Turso tidak valid: {error}. Data mentah: {}",
                    text.chars().take(250).collect::<String>()
                ),
            )
        })?;
        let batch_result = body
            .get("results")
            .and_then(Value::as_array)
            .and_then(|results| results.first())
            .filter(|result| result.get("type").and_then(Value::as_str) == Some("ok"))
            .and_then(|result| result.get("response"))
            .filter(|response| response.get("type").and_then(Value::as_str) == Some("batch"))
            .and_then(|response| response.get("result"))
            .ok_or_else(|| {
                CommandError::new(
                    "TURSO_RESPONSE_INVALID",
                    "Format hasil transaksi batch Turso tidak valid.",
                )
            })?;
        let step_errors = batch_result
            .get("step_errors")
            .and_then(Value::as_array)
            .ok_or_else(|| {
                CommandError::new(
                    "TURSO_RESPONSE_INVALID",
                    "Daftar hasil transaksi batch Turso tidak tersedia.",
                )
            })?;
        if let Some(error) = step_errors
            .iter()
            .take(commit_step + 1)
            .find(|error| !error.is_null())
        {
            let message = error
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("Transaksi database Turso gagal dan telah dibatalkan.");
            return Err(CommandError::new("TURSO_SQL_ERROR", message));
        }
        let commit_succeeded = batch_result
            .get("step_results")
            .and_then(Value::as_array)
            .and_then(|results| results.get(commit_step))
            .is_some_and(|result| !result.is_null());
        if !commit_succeeded {
            return Err(CommandError::new(
                "TURSO_TRANSACTION_ROLLED_BACK",
                "Transaksi database Turso dibatalkan agar tidak meninggalkan data parsial.",
            ));
        }
        Ok(())
    }

    pub async fn query_one(
        &self,
        sql: impl Into<String>,
        args: Vec<Value>,
    ) -> Result<QueryResult, CommandError> {
        let stmt = Statement::new(sql, args);
        let mut results = self.execute_pipeline(vec![stmt]).await?;
        results
            .pop()
            .ok_or_else(|| CommandError::new("TURSO_QUERY_EMPTY", "Hasil query kosong."))
    }

    pub async fn ping(&self) -> Result<u64, CommandError> {
        let start = std::time::Instant::now();
        self.query_one("SELECT 1 AS ping_val;", vec![]).await?;
        let elapsed = start.elapsed().as_millis() as u64;
        Ok(elapsed)
    }

    async fn ensure_column(
        &self,
        table: &str,
        column: &str,
        alter_sql: &str,
    ) -> Result<(), CommandError> {
        let result = self
            .query_one(format!("PRAGMA table_info({table});"), vec![])
            .await?;
        let exists = result.to_objects().iter().any(|row| {
            row.get("name")
                .and_then(Value::as_str)
                .is_some_and(|name| name == column)
        });
        if !exists {
            self.query_one(alter_sql, vec![]).await?;
        }
        Ok(())
    }

    pub async fn ensure_schema(&self) -> Result<(), CommandError> {
        let schema_stmts = vec![
            Statement::new(
                r#"CREATE TABLE IF NOT EXISTS schema_migration (
                    version INTEGER PRIMARY KEY,
                    name TEXT NOT NULL,
                    applied_at TEXT NOT NULL
                );"#,
                vec![],
            ),
            Statement::new(
                r#"CREATE TABLE IF NOT EXISTS app_role (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    role_key TEXT UNIQUE NOT NULL,
                    nama_role TEXT UNIQUE NOT NULL,
                    deskripsi TEXT,
                    is_system INTEGER NOT NULL DEFAULT 0,
                    is_superadmin INTEGER NOT NULL DEFAULT 0,
                    status TEXT NOT NULL DEFAULT 'Aktif',
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    created_by TEXT
                );"#,
                vec![],
            ),
            Statement::new(
                r#"CREATE TABLE IF NOT EXISTS app_permission (
                    permission_key TEXT PRIMARY KEY,
                    nama TEXT NOT NULL,
                    grup TEXT NOT NULL,
                    deskripsi TEXT,
                    is_active INTEGER NOT NULL DEFAULT 1,
                    sort_order INTEGER NOT NULL DEFAULT 0
                );"#,
                vec![],
            ),
            Statement::new(
                r#"CREATE TABLE IF NOT EXISTS role_permission (
                    role_id INTEGER NOT NULL,
                    permission_key TEXT NOT NULL,
                    is_allowed INTEGER NOT NULL DEFAULT 0,
                    updated_at TEXT NOT NULL,
                    updated_by TEXT,
                    PRIMARY KEY (role_id, permission_key),
                    FOREIGN KEY (role_id) REFERENCES app_role(id) ON DELETE CASCADE,
                    FOREIGN KEY (permission_key) REFERENCES app_permission(permission_key) ON DELETE CASCADE
                );"#,
                vec![],
            ),
            Statement::new(
                r#"CREATE TABLE IF NOT EXISTS master_operator (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    kode_operator TEXT UNIQUE NOT NULL,
                    nama_operator TEXT NOT NULL,
                    username TEXT UNIQUE NOT NULL,
                    password_hash TEXT NOT NULL,
                    role TEXT NOT NULL DEFAULT 'Operator',
                    role_id INTEGER REFERENCES app_role(id),
                    status TEXT DEFAULT 'Aktif',
                    created_at TEXT,
                    updated_at TEXT
                );"#,
                vec![],
            ),
            Statement::new(
                r#"CREATE TABLE IF NOT EXISTS master_data (
                    id_unik TEXT PRIMARY KEY,
                    kode_karyawan TEXT UNIQUE,
                    nama TEXT NOT NULL,
                    divisi TEXT NOT NULL,
                    jabatan_status TEXT,
                    no_hp TEXT,
                    lp TEXT,
                    id_shift INTEGER NOT NULL,
                    status_aktif TEXT DEFAULT 'Aktif',
                    tanggal_daftar TEXT,
                    catatan TEXT,
                    token_absensi TEXT UNIQUE,
                    qr_code TEXT,
                    status_qr TEXT DEFAULT 'Belum',
                    jenis_personil TEXT,
                    tanggal_mulai_aktif TEXT,
                    tanggal_selesai_aktif TEXT,
                    status_backup TEXT DEFAULT 'NORMAL'
                );"#,
                vec![],
            ),
            Statement::new(
                r#"CREATE TABLE IF NOT EXISTS id_card (
                    id_card_id INTEGER PRIMARY KEY AUTOINCREMENT,
                    id_unik TEXT UNIQUE NOT NULL,
                    nama TEXT NOT NULL,
                    divisi TEXT NOT NULL,
                    idcard_status TEXT DEFAULT 'Belum',
                    idcard_pdf_url TEXT,
                    idcard_last_generate TEXT,
                    idcard_catatan TEXT,
                    tanggal_generate TEXT,
                    link_qr_png TEXT,
                    FOREIGN KEY (id_unik) REFERENCES master_data(id_unik) ON DELETE CASCADE
                );"#,
                vec![],
            ),
            Statement::new(
                r#"CREATE TABLE IF NOT EXISTS tbl_shift (
                    id_shift INTEGER PRIMARY KEY AUTOINCREMENT,
                    kode_shift INTEGER UNIQUE NOT NULL,
                    nama_shift TEXT NOT NULL,
                    jam_masuk TEXT NOT NULL,
                    jam_pulang TEXT NOT NULL,
                    awal_absen_menit INTEGER DEFAULT 120,
                    batas_masuk_menit INTEGER DEFAULT 60,
                    toleransi_masuk_menit INTEGER DEFAULT 0,
                    jam_kerja_normal_menit INTEGER NOT NULL,
                    istirahat_menit INTEGER DEFAULT 60,
                    batas_pulang_menit INTEGER DEFAULT 240,
                    offset_istirahat_mulai INTEGER DEFAULT 240,
                    offset_generate_alfa INTEGER DEFAULT 180,
                    buffer_shift_malam_menit INTEGER DEFAULT 120,
                    izinkan_multi_sesi INTEGER DEFAULT 0
                );"#,
                vec![],
            ),
            Statement::new(
                r#"CREATE TABLE IF NOT EXISTS setting_gex_system (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                );"#,
                vec![],
            ),
            Statement::new(
                r#"CREATE TABLE IF NOT EXISTS log_scan (
                    id_log INTEGER PRIMARY KEY AUTOINCREMENT,
                    timestamp_scan TEXT NOT NULL,
                    tanggal_kerja TEXT NOT NULL,
                    jam_scan TEXT NOT NULL,
                    id_karyawan TEXT NOT NULL,
                    nama TEXT NOT NULL,
                    divisi TEXT NOT NULL,
                    jenis_scan TEXT NOT NULL,
                    status_proses TEXT NOT NULL,
                    sumber_data TEXT NOT NULL,
                    catatan_sistem TEXT,
                    keterangan TEXT,
                    menit_terlambat INTEGER DEFAULT 0,
                    menit_datang_awal INTEGER DEFAULT 0,
                    id_referensi TEXT,
                    kode_operator TEXT
                );"#,
                vec![],
            ),
            Statement::new(
                r#"CREATE TABLE IF NOT EXISTS absensi_harian (
                    id_absensi INTEGER PRIMARY KEY AUTOINCREMENT,
                    tanggal TEXT NOT NULL,
                    id_karyawan TEXT NOT NULL,
                    nama TEXT NOT NULL,
                    kelas_divisi TEXT NOT NULL,
                    jam_masuk TEXT,
                    jam_pulang TEXT,
                    status_kehadiran TEXT NOT NULL,
                    status_absen TEXT NOT NULL,
                    keterangan TEXT,
                    sumber TEXT NOT NULL,
                    update_terakhir TEXT NOT NULL,
                    menit_terlambat INTEGER DEFAULT 0,
                    menit_datang_awal INTEGER DEFAULT 0,
                    jam_kerja INTEGER DEFAULT 0,
                    lembur INTEGER DEFAULT 0,
                    jam_kerja_kurang INTEGER DEFAULT 0,
                    id_shift INTEGER NOT NULL,
                    bulan TEXT NOT NULL,
                    tahun INTEGER NOT NULL,
                    id_sesi TEXT UNIQUE NOT NULL,
                    mode_tugas TEXT DEFAULT 'NORMAL',
                    id_backup TEXT,
                    id_karyawan_asal TEXT,
                    tanggal_tugas TEXT
                );"#,
                vec![],
            ),
            Statement::new(
                r#"CREATE TABLE IF NOT EXISTS backup_karyawan (
                    id_backup TEXT PRIMARY KEY,
                    tanggal_tugas TEXT NOT NULL,
                    id_karyawan_asal TEXT NOT NULL,
                    nama_karyawan_asal TEXT NOT NULL,
                    divisi_asal TEXT NOT NULL,
                    id_shift_asal INTEGER NOT NULL,
                    id_karyawan_pengganti TEXT NOT NULL,
                    nama_karyawan_pengganti TEXT NOT NULL,
                    divisi_pengganti TEXT NOT NULL,
                    id_shift_normal_pengganti INTEGER NOT NULL,
                    id_shift_backup INTEGER NOT NULL,
                    alasan_backup TEXT,
                    status_tugas TEXT DEFAULT 'Aktif',
                    kode_operator TEXT NOT NULL,
                    waktu_input TEXT NOT NULL,
                    catatan TEXT,
                    waktu_dibatalkan TEXT,
                    operator_pembatalan TEXT
                );"#,
                vec![],
            ),
            Statement::new(
                r#"CREATE TABLE IF NOT EXISTS koreksi_admin (
                    id_koreksi INTEGER PRIMARY KEY AUTOINCREMENT,
                    id_referensi TEXT UNIQUE NOT NULL,
                    tanggal TEXT NOT NULL,
                    id_karyawan TEXT NOT NULL,
                    nama TEXT NOT NULL,
                    divisi TEXT NOT NULL,
                    jenis_koreksi TEXT NOT NULL,
                    jam_koreksi TEXT,
                    keterangan_admin TEXT,
                    status_proses TEXT DEFAULT 'Sudah Diproses',
                    timestamp TEXT NOT NULL,
                    kode_operator TEXT NOT NULL
                );"#,
                vec![],
            ),
            Statement::new(
                r#"CREATE TABLE IF NOT EXISTS audit_absensi (
                    id_audit INTEGER PRIMARY KEY AUTOINCREMENT,
                    waktu TEXT NOT NULL,
                    jenis TEXT NOT NULL,
                    tanggal TEXT NOT NULL,
                    id_karyawan TEXT NOT NULL,
                    nama TEXT NOT NULL,
                    baris_referensi TEXT,
                    detail TEXT NOT NULL,
                    status TEXT NOT NULL
                );"#,
                vec![],
            ),
            Statement::new(
                r#"CREATE TABLE IF NOT EXISTS tbl_hari_libur (
                    id_libur INTEGER PRIMARY KEY AUTOINCREMENT,
                    tanggal TEXT UNIQUE NOT NULL,
                    nama_libur TEXT NOT NULL,
                    jenis_libur TEXT DEFAULT 'Libur Nasional',
                    keterangan TEXT,
                    status_aktif INTEGER DEFAULT 1
                );"#,
                vec![],
            ),
            Statement::new(
                r#"CREATE TABLE IF NOT EXISTS company_profile (
                    id TEXT PRIMARY KEY DEFAULT 'default_company',
                    company_name TEXT NOT NULL DEFAULT 'SPPG',
                    branch_name TEXT,
                    logo_url TEXT,
                    signature_url TEXT,
                    address TEXT,
                    phone TEXT,
                    email TEXT,
                    website TEXT,
                    leader_name TEXT,
                    leader_title TEXT,
                    leader_nip TEXT,
                    card_terms TEXT,
                    timezone TEXT DEFAULT 'Asia/Jakarta',
                    updated_at TEXT NOT NULL
                );"#,
                vec![],
            ),
            Statement::new(
                r#"CREATE TABLE IF NOT EXISTS id_card_template (
                    id TEXT PRIMARY KEY DEFAULT 'default_template',
                    name TEXT NOT NULL DEFAULT 'Template Default SPPG',
                    orientation TEXT NOT NULL DEFAULT 'landscape',
                    front_bg_url TEXT,
                    back_bg_url TEXT,
                    elements_json TEXT NOT NULL,
                    is_active INTEGER NOT NULL DEFAULT 1,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );"#,
                vec![],
            ),
            Statement::new(
                r#"CREATE TABLE IF NOT EXISTS import_offline (
                    id_import INTEGER PRIMARY KEY AUTOINCREMENT,
                    event_key TEXT UNIQUE NOT NULL,
                    timestamp_input TEXT NOT NULL DEFAULT '',
                    tanggal TEXT NOT NULL DEFAULT '',
                    id_unik TEXT NOT NULL DEFAULT '',
                    nama TEXT,
                    divisi TEXT,
                    jam_masuk TEXT,
                    jam_pulang TEXT,
                    status_kehadiran TEXT,
                    status_absen TEXT,
                    keterangan TEXT,
                    status_proses TEXT NOT NULL DEFAULT 'Belum Diproses',
                    diproses_pada TEXT,
                    pesan_error TEXT,
                    kode_operator TEXT
                );"#,
                vec![],
            ),
            Statement::new(
                r#"CREATE TABLE IF NOT EXISTS sync_changelog (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    client_id TEXT NOT NULL,
                    event_id TEXT NOT NULL UNIQUE,
                    domain TEXT NOT NULL,
                    operation TEXT NOT NULL,
                    entity_key TEXT NOT NULL,
                    payload_json TEXT NOT NULL,
                    created_at INTEGER NOT NULL
                );"#,
                vec![],
            ),
            Statement::new(
                r#"CREATE TABLE IF NOT EXISTS sync_operation_receipt (
                    event_id TEXT PRIMARY KEY,
                    client_id TEXT NOT NULL,
                    domain TEXT NOT NULL,
                    operation TEXT NOT NULL,
                    entity_key TEXT NOT NULL,
                    payload_hash TEXT,
                    server_revision INTEGER NOT NULL,
                    status TEXT NOT NULL,
                    result_json TEXT,
                    base_revision INTEGER,
                    actor_operator_id INTEGER,
                    receipt_json TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    processed_at TEXT
                );"#,
                vec![],
            ),
            Statement::new(
                r#"CREATE TABLE IF NOT EXISTS app_session (
                    session_id TEXT PRIMARY KEY,
                    operator_id INTEGER NOT NULL,
                    created_at TEXT NOT NULL,
                    expires_at TEXT NOT NULL,
                    last_activity_at TEXT NOT NULL,
                    ip_address TEXT,
                    user_agent TEXT,
                    FOREIGN KEY (operator_id) REFERENCES master_operator(id) ON DELETE CASCADE
                );"#,
                vec![],
            ),
            Statement::new(
                r#"CREATE TABLE IF NOT EXISTS auth_login_rate_limit (
                    identifier_hash TEXT PRIMARY KEY,
                    failed_attempts INTEGER NOT NULL DEFAULT 0,
                    lockout_until TEXT,
                    last_attempt_at TEXT NOT NULL
                );"#,
                vec![],
            ),
            Statement::new(
                r#"CREATE TABLE IF NOT EXISTS app_bootstrap_state (
                    bootstrap_key TEXT PRIMARY KEY,
                    claimed_at TEXT NOT NULL
                );"#,
                vec![],
            ),
            // Indeks
            Statement::new("CREATE INDEX IF NOT EXISTS idx_log_scan_id_tanggal ON log_scan(id_karyawan, tanggal_kerja);", vec![]),
            Statement::new("CREATE INDEX IF NOT EXISTS idx_absensi_tanggal_id ON absensi_harian(tanggal, id_karyawan);", vec![]),
            Statement::new("CREATE INDEX IF NOT EXISTS idx_absensi_id_sesi ON absensi_harian(id_sesi);", vec![]),
            Statement::new("CREATE INDEX IF NOT EXISTS idx_log_scan_tanggal ON log_scan(tanggal_kerja);", vec![]),
            Statement::new("CREATE INDEX IF NOT EXISTS idx_absensi_tanggal ON absensi_harian(tanggal);", vec![]),
            Statement::new("CREATE INDEX IF NOT EXISTS idx_operator_username ON master_operator(username);", vec![]),
            // Seed Roles
            Statement::new(
                r#"INSERT OR IGNORE INTO app_role (id, role_key, nama_role, deskripsi, is_system, is_superadmin, status, created_at, updated_at) VALUES
                (1, 'superadmin', 'Superadmin', 'Pemilik akses penuh dan pengelola role aplikasi.', 1, 1, 'Aktif', datetime('now'), datetime('now')),
                (2, 'admin', 'Admin', 'Administrator operasional sesuai matriks permission.', 1, 0, 'Aktif', datetime('now'), datetime('now')),
                (3, 'operator', 'Operator', 'Operator harian sesuai matriks permission.', 1, 0, 'Aktif', datetime('now'), datetime('now')),
                (4, 'scanner', 'Scanner', 'Petugas terminal QR sesuai matriks permission.', 1, 0, 'Aktif', datetime('now'), datetime('now'));"#,
                vec![],
            ),
            // Seed Permissions Catalog
            Statement::new(
                r#"INSERT OR IGNORE INTO app_permission (permission_key, nama, grup, deskripsi, is_active, sort_order) VALUES
                ('home.view', 'Akses Beranda & Navigasi Utama', 'Navigasi', 'Melihat ringkasan operasional dan menu sistem.', 1, 10),
                ('scanner.use', 'Gunakan Scanner Terminal', 'Scanner', 'Mengoperasikan terminal scanner QR presensi.', 1, 20),
                ('dashboard.view', 'Akses Dashboard Operasional', 'Dashboard', 'Melihat statistik absensi dan grafik kehadiran.', 1, 30),
                ('dashboard.export', 'Ekspor Data Dashboard', 'Dashboard', 'Mengunduh laporan rekap absensi CSV/Excel.', 1, 40),
                ('employees.view', 'Lihat Master Karyawan', 'Karyawan', 'Melihat daftar dan profil karyawan.', 1, 50),
                ('employees.manage', 'Kelola Master Karyawan', 'Karyawan', 'Menambah, mengedit, dan menonaktifkan data karyawan.', 1, 60),
                ('shifts.view', 'Lihat Master Shift', 'Shift', 'Melihat konfigurasi shift kerja.', 1, 70),
                ('shifts.manage', 'Kelola Master Shift', 'Shift', 'Menambah dan mengubah konfigurasi jam kerja shift.', 1, 80),
                ('holidays.view', 'Lihat Hari Libur', 'Hari Libur', 'Melihat kalender hari libur dan cuti bersama.', 1, 90),
                ('holidays.manage', 'Kelola Hari Libur', 'Hari Libur', 'Menambah dan mengubah tanggal libur operasional.', 1, 100),
                ('corrections.view', 'Lihat Koreksi Admin', 'Koreksi', 'Melihat riwayat koreksi presensi manual.', 1, 110),
                ('corrections.manage', 'Kelola Koreksi Admin', 'Koreksi', 'Melakukan koreksi jam dan status presensi manual.', 1, 120),
                ('backups.view', 'Lihat Penugasan Backup', 'Backup', 'Melihat jadwal tugas pengganti personil.', 1, 130),
                ('backups.manage', 'Kelola Penugasan Backup', 'Backup', 'Menugaskan atau membatalkan backup personil.', 1, 140),
                ('alfa.trigger', 'Trigger Generate Alfa', 'Alfa', 'Menjalankan proses penandaan otomatis status Alfa.', 1, 150),
                ('attendance_audit.view', 'Lihat Audit Absensi', 'Audit', 'Melihat log audit perubahan absensi.', 1, 160),
                ('operational.edit', 'Edit Log Operasional', 'Operasional', 'Mengedit riwayat absensi dan log scan harian.', 1, 170),
                ('operational.delete', 'Hapus Log Operasional', 'Operasional', 'Menghapus riwayat absensi atau log scan yang keliru.', 1, 180),
                ('history.edit', 'Edit Riwayat Presensi', 'Riwayat', 'Mengubah data presensi lampau.', 1, 190),
                ('history.delete', 'Hapus Riwayat Presensi', 'Riwayat', 'Menghapus data presensi lampau.', 1, 200),
                ('operators.view', 'Lihat Daftar Operator', 'Operator', 'Melihat data operator dan akun pengguna.', 1, 210),
                ('operators.manage', 'Kelola Operator', 'Operator', 'Menambah dan mengubah data operator aplikasi.', 1, 220),
                ('roles.manage', 'Kelola Hak Akses & Role', 'Role', 'Mengatur permission matriks untuk setiap role.', 1, 230),
                ('settings.manage', 'Kelola Pengaturan Sistem', 'Pengaturan', 'Mengubah radius geofence, multi-scan, dan sistem.', 1, 240),
                ('branding.manage', 'Kelola Profil & Template ID Card', 'Branding', 'Mengubah logo instansi dan desain kartu.', 1, 250),
                ('sync.view', 'Lihat Status Sinkronisasi', 'Sinkronisasi', 'Melihat indikator dan status antrean sync cloud.', 1, 260),
                ('sync.retry', 'Kirim Ulang & Atasi Konflik', 'Sinkronisasi', 'Memicu sinkronisasi manual dan resolusi konflik.', 1, 270),
                ('diagnostics.view', 'Lihat Diagnostik Sistem', 'Diagnostik', 'Melihat informasi runtime dan kesehatan database.', 1, 280),
                ('payroll.view', 'Akses Modul Penggajian', 'Penggajian', 'Melihat estimasi dan rekap penggajian karyawan.', 1, 290),
                ('payroll.run.create', 'Buat & Jalankan Batch Payroll', 'Penggajian', 'Membuat dan menjalankan batch payroll resmi.', 1, 300),
                ('payroll.run.review', 'Review Batch Payroll', 'Penggajian', 'Meninjau batch payroll sebelum disetujui.', 1, 301),
                ('payroll.run.approve', 'Setujui Batch Payroll', 'Penggajian', 'Menyetujui batch payroll yang telah direview.', 1, 302),
                ('payroll.run.disburse', 'Tandai Dibayar & Kunci Slip', 'Penggajian', 'Menandai batch payroll sebagai dibayar dan mengunci slip.', 1, 303),
                ('payroll.config.manage', 'Kelola Aturan Penggajian', 'Penggajian', 'Mengatur rate gaji, lembur, PPh 21, dan BPJS.', 1, 310),
                ('payroll.export', 'Ekspor Laporan & Slip Gaji', 'Penggajian', 'Mengunduh rekap penggajian dan slip gaji.', 1, 320);"#,
                vec![],
            ),
            // Seed Default Role Permissions untuk Role Superadmin (Role 1)
            Statement::new(
                r#"INSERT OR IGNORE INTO role_permission (role_id, permission_key, is_allowed, updated_at, updated_by)
                SELECT 1, permission_key, 1, datetime('now'), 'system' FROM app_permission;"#,
                vec![],
            ),
            // Seed Default Role Permissions untuk Role Admin (Role 2)
            Statement::new(
                r#"INSERT OR IGNORE INTO role_permission (role_id, permission_key, is_allowed, updated_at, updated_by)
                SELECT 2, permission_key, 1, datetime('now'), 'system' FROM app_permission
                WHERE permission_key NOT IN ('roles.manage', 'operators.manage');"#,
                vec![],
            ),
            // Seed Settings
            Statement::new(
                r#"INSERT OR IGNORE INTO setting_gex_system (key, value) VALUES
                ('geofence_enabled', 'false'),
                ('lat_kantor', '0'),
                ('lng_kantor', '0'),
                ('radius_meter', '100'),
                ('anti_double_scan_seconds', '60'),
                ('batas_multi_scan_menit', '5'),
                ('auto_alfa_aktif', 'true'),
                ('rbac_revision', '1');"#,
                vec![],
            ),
            // Seed Company Profile
            Statement::new(
                r#"INSERT OR IGNORE INTO company_profile (id, company_name, branch_name, address, timezone, updated_at) VALUES
                ('default_company', 'SPPG', 'Kantor Pusat', 'Jl. Jenderal Sudirman No. 1', 'Asia/Jakarta', datetime('now'));"#,
                vec![],
            ),
            // Seed ID Card Template
            Statement::new(
                r#"INSERT OR IGNORE INTO id_card_template (id, name, orientation, elements_json, is_active, created_at, updated_at) VALUES
                ('default_template', 'Template Default SPPG', 'landscape', ?, 1, datetime('now'), datetime('now'));"#,
                vec![json!(serde_json::to_string(&crate::desktop::operational::default_id_card_elements()).unwrap_or_else(|_| "[]".to_string()))],
            ),
            // Payroll DDL
            Statement::new(
                r#"CREATE TABLE IF NOT EXISTS salary_configs (
                    id TEXT PRIMARY KEY,
                    id_karyawan TEXT NOT NULL,
                    rate_per_hour REAL NOT NULL,
                    ptkp_status TEXT NOT NULL DEFAULT 'TK/0',
                    effective_date TEXT NOT NULL,
                    created_by TEXT NOT NULL,
                    created_at TEXT NOT NULL DEFAULT (datetime('now')),
                    UNIQUE(id_karyawan, effective_date),
                    FOREIGN KEY (id_karyawan) REFERENCES master_data(id_unik) ON DELETE CASCADE
                );"#,
                vec![],
            ),
            Statement::new(
                r#"CREATE TABLE IF NOT EXISTS overtime_tier_rules (
                    id TEXT PRIMARY KEY,
                    rule_type TEXT NOT NULL,
                    tier_order INTEGER NOT NULL,
                    hour_start REAL NOT NULL,
                    hour_end REAL,
                    multiplier REAL NOT NULL,
                    is_active INTEGER NOT NULL DEFAULT 1,
                    UNIQUE(rule_type, tier_order)
                );"#,
                vec![],
            ),
            Statement::new(
                r#"CREATE TABLE IF NOT EXISTS payroll_components (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    category TEXT NOT NULL,
                    calc_type TEXT NOT NULL,
                    default_value REAL NOT NULL DEFAULT 0,
                    applies_to TEXT NOT NULL DEFAULT 'ALL',
                    is_active INTEGER NOT NULL DEFAULT 1,
                    created_at TEXT NOT NULL DEFAULT (datetime('now'))
                );"#,
                vec![],
            ),
            Statement::new(
                r#"CREATE TABLE IF NOT EXISTS tax_rules (
                    id TEXT PRIMARY KEY,
                    category TEXT NOT NULL,
                    bracket_min REAL NOT NULL,
                    bracket_max REAL,
                    rate_percentage REAL NOT NULL,
                    effective_date TEXT NOT NULL,
                    created_at TEXT NOT NULL DEFAULT (datetime('now'))
                );"#,
                vec![],
            ),
            Statement::new(
                r#"CREATE TABLE IF NOT EXISTS bpjs_rules (
                    id TEXT PRIMARY KEY,
                    component_code TEXT UNIQUE NOT NULL,
                    component_name TEXT NOT NULL,
                    rate_percentage REAL NOT NULL,
                    wage_cap REAL,
                    effective_date TEXT NOT NULL,
                    created_at TEXT NOT NULL DEFAULT (datetime('now'))
                );"#,
                vec![],
            ),
            Statement::new(
                r#"CREATE TABLE IF NOT EXISTS payroll_runs (
                    id TEXT PRIMARY KEY,
                    idempotency_key TEXT NOT NULL UNIQUE,
                    period_start TEXT NOT NULL,
                    period_end TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'DRAFT',
                    total_gross_payout INTEGER NOT NULL DEFAULT 0,
                    total_net_payout INTEGER NOT NULL DEFAULT 0,
                    total_employees INTEGER NOT NULL DEFAULT 0,
                    created_by TEXT NOT NULL,
                    created_at TEXT NOT NULL DEFAULT (datetime('now')),
                    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
                );"#,
                vec![],
            ),
            Statement::new(
                r#"CREATE TABLE IF NOT EXISTS payroll_items (
                    id TEXT PRIMARY KEY,
                    payroll_run_id TEXT NOT NULL REFERENCES payroll_runs(id) ON DELETE CASCADE,
                    id_karyawan TEXT NOT NULL,
                    nama_karyawan TEXT NOT NULL,
                    divisi TEXT NOT NULL,
                    ptkp_status TEXT NOT NULL DEFAULT 'TK/0',
                    total_regular_hours REAL NOT NULL,
                    total_overtime_hours REAL NOT NULL,
                    total_overtime_index REAL NOT NULL,
                    rate_per_hour INTEGER NOT NULL,
                    basic_salary INTEGER NOT NULL,
                    overtime_salary INTEGER NOT NULL,
                    gross_salary INTEGER NOT NULL,
                    total_allowances INTEGER NOT NULL DEFAULT 0,
                    total_deductions INTEGER NOT NULL DEFAULT 0,
                    bpjs_employee_total INTEGER NOT NULL DEFAULT 0,
                    bpjs_company_total INTEGER NOT NULL DEFAULT 0,
                    pph21_amount INTEGER NOT NULL DEFAULT 0,
                    net_salary INTEGER NOT NULL,
                    breakdown_snapshot TEXT NOT NULL,
                    created_at TEXT NOT NULL DEFAULT (datetime('now')),
                    UNIQUE (payroll_run_id, id_karyawan)
                );"#,
                vec![],
            ),
            Statement::new(
                r#"CREATE TABLE IF NOT EXISTS payroll_audit_logs (
                    id TEXT PRIMARY KEY,
                    payroll_run_id TEXT NOT NULL REFERENCES payroll_runs(id) ON DELETE CASCADE,
                    action TEXT NOT NULL,
                    old_status TEXT,
                    new_status TEXT NOT NULL,
                    performed_by TEXT NOT NULL,
                    notes TEXT,
                    created_at TEXT NOT NULL DEFAULT (datetime('now'))
                );"#,
                vec![],
            ),
            Statement::new("CREATE INDEX IF NOT EXISTS idx_salary_configs_karyawan ON salary_configs(id_karyawan, effective_date DESC);", vec![]),
            Statement::new("CREATE INDEX IF NOT EXISTS idx_overtime_rules_type ON overtime_tier_rules(rule_type, tier_order ASC);", vec![]),
            Statement::new("CREATE INDEX IF NOT EXISTS idx_payroll_runs_periode ON payroll_runs(period_start, period_end, status);", vec![]),
            Statement::new("CREATE INDEX IF NOT EXISTS idx_payroll_items_run ON payroll_items(payroll_run_id);", vec![]),
            Statement::new("CREATE INDEX IF NOT EXISTS idx_payroll_items_karyawan ON payroll_items(id_karyawan);", vec![]),
            // Seed Default Overtime Rules
            Statement::new(
                r#"INSERT OR IGNORE INTO overtime_tier_rules (id, rule_type, tier_order, hour_start, hour_end, multiplier, is_active) VALUES
                ('ot-work-1', 'HARI_KERJA', 1, 0.0, 1.0, 1.5, 1),
                ('ot-work-2', 'HARI_KERJA', 2, 1.0, NULL, 2.0, 1),
                ('ot-holiday-1', 'HARI_LIBUR', 1, 0.0, 8.0, 2.0, 1),
                ('ot-holiday-2', 'HARI_LIBUR', 2, 8.0, 9.0, 3.0, 1),
                ('ot-holiday-3', 'HARI_LIBUR', 3, 9.0, NULL, 4.0, 1);"#,
                vec![],
            ),
            // Seed Default Tax Rules (Pasal 17 & TER Baseline)
            Statement::new(
                r#"INSERT OR IGNORE INTO tax_rules (id, category, bracket_min, bracket_max, rate_percentage, effective_date, created_at) VALUES
                ('tax_p17_1', 'PASAL_17', 0, 60000000, 5.0, '2026-01-01', datetime('now')),
                ('tax_p17_2', 'PASAL_17', 60000000, 250000000, 15.0, '2026-01-01', datetime('now')),
                ('tax_p17_3', 'PASAL_17', 250000000, 500000000, 25.0, '2026-01-01', datetime('now')),
                ('tax_p17_4', 'PASAL_17', 500000000, 5000000000, 30.0, '2026-01-01', datetime('now')),
                ('tax_p17_5', 'PASAL_17', 5000000000, NULL, 35.0, '2026-01-01', datetime('now')),
                ('tax_ter_a_1', 'TER_A', 0, 5400000, 0.0, '2026-01-01', datetime('now')),
                ('tax_ter_a_2', 'TER_A', 5400000, 5650000, 0.25, '2026-01-01', datetime('now')),
                ('tax_ter_a_3', 'TER_A', 5650000, 5950000, 0.5, '2026-01-01', datetime('now')),
                ('tax_ter_a_4', 'TER_A', 5950000, 6300000, 0.75, '2026-01-01', datetime('now')),
                ('tax_ter_a_5', 'TER_A', 6300000, 6750000, 1.0, '2026-01-01', datetime('now')),
                ('tax_ter_a_6', 'TER_A', 6750000, 7500000, 1.25, '2026-01-01', datetime('now')),
                ('tax_ter_a_7', 'TER_A', 7500000, 8550000, 1.5, '2026-01-01', datetime('now')),
                ('tax_ter_a_8', 'TER_A', 8550000, 9650000, 1.75, '2026-01-01', datetime('now')),
                ('tax_ter_a_9', 'TER_A', 9650000, 10050000, 2.0, '2026-01-01', datetime('now')),
                ('tax_ter_a_10', 'TER_A', 10050000, 10350000, 2.25, '2026-01-01', datetime('now')),
                ('tax_ter_a_11', 'TER_A', 10350000, 10700000, 2.5, '2026-01-01', datetime('now')),
                ('tax_ter_a_12', 'TER_A', 10700000, 11050000, 3.0, '2026-01-01', datetime('now')),
                ('tax_ter_a_13', 'TER_A', 11050000, 11600000, 3.5, '2026-01-01', datetime('now')),
                ('tax_ter_a_14', 'TER_A', 11600000, 12500000, 4.0, '2026-01-01', datetime('now')),
                ('tax_ter_a_15', 'TER_A', 12500000, 13750000, 5.0, '2026-01-01', datetime('now')),
                ('tax_ter_a_16', 'TER_A', 13750000, 15100000, 6.0, '2026-01-01', datetime('now')),
                ('tax_ter_a_17', 'TER_A', 15100000, 16950000, 7.0, '2026-01-01', datetime('now')),
                ('tax_ter_a_18', 'TER_A', 16950000, 19750000, 8.0, '2026-01-01', datetime('now')),
                ('tax_ter_a_19', 'TER_A', 19750000, 24150000, 9.0, '2026-01-01', datetime('now')),
                ('tax_ter_a_20', 'TER_A', 24150000, 26450000, 10.0, '2026-01-01', datetime('now')),
                ('tax_ter_a_21', 'TER_A', 26450000, 28000000, 11.0, '2026-01-01', datetime('now')),
                ('tax_ter_a_22', 'TER_A', 28000000, 30050000, 12.0, '2026-01-01', datetime('now')),
                ('tax_ter_a_23', 'TER_A', 30050000, 32400000, 13.0, '2026-01-01', datetime('now')),
                ('tax_ter_a_24', 'TER_A', 32400000, 35400000, 14.0, '2026-01-01', datetime('now')),
                ('tax_ter_a_25', 'TER_A', 35400000, 39100000, 15.0, '2026-01-01', datetime('now')),
                ('tax_ter_a_26', 'TER_A', 39100000, 43850000, 16.0, '2026-01-01', datetime('now')),
                ('tax_ter_a_27', 'TER_A', 43850000, 47800000, 17.0, '2026-01-01', datetime('now')),
                ('tax_ter_a_28', 'TER_A', 47800000, 51400000, 18.0, '2026-01-01', datetime('now')),
                ('tax_ter_a_29', 'TER_A', 51400000, 56300000, 19.0, '2026-01-01', datetime('now')),
                ('tax_ter_a_30', 'TER_A', 56300000, 62200000, 20.0, '2026-01-01', datetime('now')),
                ('tax_ter_a_31', 'TER_A', 62200000, 68600000, 21.0, '2026-01-01', datetime('now')),
                ('tax_ter_a_32', 'TER_A', 68600000, 77500000, 22.0, '2026-01-01', datetime('now')),
                ('tax_ter_a_33', 'TER_A', 77500000, 89000000, 23.0, '2026-01-01', datetime('now')),
                ('tax_ter_a_34', 'TER_A', 89000000, 103000000, 24.0, '2026-01-01', datetime('now')),
                ('tax_ter_a_35', 'TER_A', 103000000, 125000000, 25.0, '2026-01-01', datetime('now')),
                ('tax_ter_a_36', 'TER_A', 125000000, 157000000, 26.0, '2026-01-01', datetime('now')),
                ('tax_ter_a_37', 'TER_A', 157000000, 206000000, 27.0, '2026-01-01', datetime('now')),
                ('tax_ter_a_38', 'TER_A', 206000000, 337000000, 28.0, '2026-01-01', datetime('now')),
                ('tax_ter_a_39', 'TER_A', 337000000, 454000000, 29.0, '2026-01-01', datetime('now')),
                ('tax_ter_a_40', 'TER_A', 454000000, 550000000, 30.0, '2026-01-01', datetime('now')),
                ('tax_ter_a_41', 'TER_A', 550000000, 695000000, 31.0, '2026-01-01', datetime('now')),
                ('tax_ter_a_42', 'TER_A', 695000000, 910000000, 32.0, '2026-01-01', datetime('now')),
                ('tax_ter_a_43', 'TER_A', 910000000, 1400000000, 33.0, '2026-01-01', datetime('now')),
                ('tax_ter_a_44', 'TER_A', 1400000000, NULL, 34.0, '2026-01-01', datetime('now')),
                ('tax_ter_b_1', 'TER_B', 0, 6200000, 0.0, '2026-01-01', datetime('now')),
                ('tax_ter_b_2', 'TER_B', 6200000, 6500000, 0.25, '2026-01-01', datetime('now')),
                ('tax_ter_b_3', 'TER_B', 6500000, 6850000, 0.5, '2026-01-01', datetime('now')),
                ('tax_ter_b_4', 'TER_B', 6850000, 7300000, 0.75, '2026-01-01', datetime('now')),
                ('tax_ter_b_5', 'TER_B', 7300000, 9200000, 1.0, '2026-01-01', datetime('now')),
                ('tax_ter_b_6', 'TER_B', 9200000, 10750000, 1.5, '2026-01-01', datetime('now')),
                ('tax_ter_b_7', 'TER_B', 10750000, 12500000, 2.0, '2026-01-01', datetime('now')),
                ('tax_ter_b_8', 'TER_B', 12500000, 13750000, 3.0, '2026-01-01', datetime('now')),
                ('tax_ter_b_9', 'TER_B', 13750000, 15100000, 4.0, '2026-01-01', datetime('now')),
                ('tax_ter_b_10', 'TER_B', 15100000, 16950000, 5.0, '2026-01-01', datetime('now')),
                ('tax_ter_b_11', 'TER_B', 16950000, 19750000, 6.0, '2026-01-01', datetime('now')),
                ('tax_ter_b_12', 'TER_B', 19750000, 24150000, 7.0, '2026-01-01', datetime('now')),
                ('tax_ter_b_13', 'TER_B', 24150000, 26450000, 8.0, '2026-01-01', datetime('now')),
                ('tax_ter_b_14', 'TER_B', 26450000, 28000000, 9.0, '2026-01-01', datetime('now')),
                ('tax_ter_b_15', 'TER_B', 28000000, 30050000, 10.0, '2026-01-01', datetime('now')),
                ('tax_ter_b_16', 'TER_B', 30050000, 32400000, 11.0, '2026-01-01', datetime('now')),
                ('tax_ter_b_17', 'TER_B', 32400000, 35400000, 12.0, '2026-01-01', datetime('now')),
                ('tax_ter_b_18', 'TER_B', 35400000, 39100000, 13.0, '2026-01-01', datetime('now')),
                ('tax_ter_b_19', 'TER_B', 39100000, 43850000, 14.0, '2026-01-01', datetime('now')),
                ('tax_ter_b_20', 'TER_B', 43850000, 47800000, 15.0, '2026-01-01', datetime('now')),
                ('tax_ter_b_21', 'TER_B', 47800000, 51400000, 16.0, '2026-01-01', datetime('now')),
                ('tax_ter_b_22', 'TER_B', 51400000, 56300000, 17.0, '2026-01-01', datetime('now')),
                ('tax_ter_b_23', 'TER_B', 56300000, 62200000, 18.0, '2026-01-01', datetime('now')),
                ('tax_ter_b_24', 'TER_B', 62200000, 68600000, 19.0, '2026-01-01', datetime('now')),
                ('tax_ter_b_25', 'TER_B', 68600000, 77500000, 20.0, '2026-01-01', datetime('now')),
                ('tax_ter_b_26', 'TER_B', 77500000, 89000000, 21.0, '2026-01-01', datetime('now')),
                ('tax_ter_b_27', 'TER_B', 89000000, 103000000, 22.0, '2026-01-01', datetime('now')),
                ('tax_ter_b_28', 'TER_B', 103000000, 125000000, 23.0, '2026-01-01', datetime('now')),
                ('tax_ter_b_29', 'TER_B', 125000000, 157000000, 24.0, '2026-01-01', datetime('now')),
                ('tax_ter_b_30', 'TER_B', 157000000, 206000000, 25.0, '2026-01-01', datetime('now')),
                ('tax_ter_b_31', 'TER_B', 206000000, 337000000, 26.0, '2026-01-01', datetime('now')),
                ('tax_ter_b_32', 'TER_B', 337000000, 454000000, 27.0, '2026-01-01', datetime('now')),
                ('tax_ter_b_33', 'TER_B', 454000000, 550000000, 28.0, '2026-01-01', datetime('now')),
                ('tax_ter_b_34', 'TER_B', 550000000, 695000000, 29.0, '2026-01-01', datetime('now')),
                ('tax_ter_b_35', 'TER_B', 695000000, 910000000, 30.0, '2026-01-01', datetime('now')),
                ('tax_ter_b_36', 'TER_B', 910000000, 1400000000, 31.0, '2026-01-01', datetime('now')),
                ('tax_ter_b_37', 'TER_B', 1400000000, NULL, 32.0, '2026-01-01', datetime('now')),
                ('tax_ter_c_1', 'TER_C', 0, 6600000, 0.0, '2026-01-01', datetime('now')),
                ('tax_ter_c_2', 'TER_C', 6600000, 6950000, 0.25, '2026-01-01', datetime('now')),
                ('tax_ter_c_3', 'TER_C', 6950000, 7350000, 0.5, '2026-01-01', datetime('now')),
                ('tax_ter_c_4', 'TER_C', 7350000, 7800000, 0.75, '2026-01-01', datetime('now')),
                ('tax_ter_c_5', 'TER_C', 7800000, 8850000, 1.0, '2026-01-01', datetime('now')),
                ('tax_ter_c_6', 'TER_C', 8850000, 9800000, 1.25, '2026-01-01', datetime('now')),
                ('tax_ter_c_7', 'TER_C', 9800000, 10950000, 1.5, '2026-01-01', datetime('now')),
                ('tax_ter_c_8', 'TER_C', 10950000, 11200000, 1.75, '2026-01-01', datetime('now')),
                ('tax_ter_c_9', 'TER_C', 11200000, 12050000, 2.0, '2026-01-01', datetime('now')),
                ('tax_ter_c_10', 'TER_C', 12050000, 12950000, 3.0, '2026-01-01', datetime('now')),
                ('tax_ter_c_11', 'TER_C', 12950000, 14150000, 4.0, '2026-01-01', datetime('now')),
                ('tax_ter_c_12', 'TER_C', 14150000, 15550000, 5.0, '2026-01-01', datetime('now')),
                ('tax_ter_c_13', 'TER_C', 15550000, 17050000, 6.0, '2026-01-01', datetime('now')),
                ('tax_ter_c_14', 'TER_C', 17050000, 19500000, 7.0, '2026-01-01', datetime('now')),
                ('tax_ter_c_15', 'TER_C', 19500000, 22700000, 8.0, '2026-01-01', datetime('now')),
                ('tax_ter_c_16', 'TER_C', 22700000, 24700000, 9.0, '2026-01-01', datetime('now')),
                ('tax_ter_c_17', 'TER_C', 24700000, 27500000, 10.0, '2026-01-01', datetime('now')),
                ('tax_ter_c_18', 'TER_C', 27500000, 30000000, 11.0, '2026-01-01', datetime('now')),
                ('tax_ter_c_19', 'TER_C', 30000000, 34100000, 12.0, '2026-01-01', datetime('now')),
                ('tax_ter_c_20', 'TER_C', 34100000, 37600000, 13.0, '2026-01-01', datetime('now')),
                ('tax_ter_c_21', 'TER_C', 37600000, 42700000, 14.0, '2026-01-01', datetime('now')),
                ('tax_ter_c_22', 'TER_C', 42700000, 47400000, 15.0, '2026-01-01', datetime('now')),
                ('tax_ter_c_23', 'TER_C', 47400000, 52100000, 16.0, '2026-01-01', datetime('now')),
                ('tax_ter_c_24', 'TER_C', 52100000, 56300000, 17.0, '2026-01-01', datetime('now')),
                ('tax_ter_c_25', 'TER_C', 56300000, 62200000, 18.0, '2026-01-01', datetime('now')),
                ('tax_ter_c_26', 'TER_C', 62200000, 68600000, 19.0, '2026-01-01', datetime('now')),
                ('tax_ter_c_27', 'TER_C', 68600000, 77500000, 20.0, '2026-01-01', datetime('now')),
                ('tax_ter_c_28', 'TER_C', 77500000, 89000000, 21.0, '2026-01-01', datetime('now')),
                ('tax_ter_c_29', 'TER_C', 89000000, 103000000, 22.0, '2026-01-01', datetime('now')),
                ('tax_ter_c_30', 'TER_C', 103000000, 125000000, 23.0, '2026-01-01', datetime('now')),
                ('tax_ter_c_31', 'TER_C', 125000000, 157000000, 24.0, '2026-01-01', datetime('now')),
                ('tax_ter_c_32', 'TER_C', 157000000, 206000000, 25.0, '2026-01-01', datetime('now')),
                ('tax_ter_c_33', 'TER_C', 206000000, 337000000, 26.0, '2026-01-01', datetime('now')),
                ('tax_ter_c_34', 'TER_C', 337000000, 454000000, 27.0, '2026-01-01', datetime('now')),
                ('tax_ter_c_35', 'TER_C', 454000000, 550000000, 28.0, '2026-01-01', datetime('now')),
                ('tax_ter_c_36', 'TER_C', 550000000, 695000000, 29.0, '2026-01-01', datetime('now')),
                ('tax_ter_c_37', 'TER_C', 695000000, 910000000, 30.0, '2026-01-01', datetime('now')),
                ('tax_ter_c_38', 'TER_C', 910000000, 1400000000, 31.0, '2026-01-01', datetime('now')),
                ('tax_ter_c_39', 'TER_C', 1400000000, NULL, 32.0, '2026-01-01', datetime('now'));"#,
                vec![],
            ),
            // Seed Default BPJS Rules
            Statement::new(
                r#"INSERT OR IGNORE INTO bpjs_rules (id, component_code, component_name, rate_percentage, wage_cap, effective_date, created_at) VALUES
                ('bpjs_jht_emp', 'JHT_EMP', 'JHT Tenaga Kerja (Pekerja)', 2.0, NULL, '2026-01-01', datetime('now')),
                ('bpjs_jht_co', 'JHT_CO', 'JHT Tenaga Kerja (Perusahaan)', 3.7, NULL, '2026-01-01', datetime('now')),
                ('bpjs_jp_emp', 'JP_EMP', 'Jaminan Pensiun (Pekerja)', 1.0, 10042300, '2026-01-01', datetime('now')),
                ('bpjs_jp_co', 'JP_CO', 'Jaminan Pensiun (Perusahaan)', 2.0, 10042300, '2026-01-01', datetime('now')),
                ('bpjs_jkk_co', 'JKK_CO', 'JKK Risiko Sedang (Perusahaan)', 0.54, NULL, '2026-01-01', datetime('now')),
                ('bpjs_jkm_co', 'JKM_CO', 'Jaminan Kematian (Perusahaan)', 0.3, NULL, '2026-01-01', datetime('now')),
                ('bpjs_kes_emp', 'BPJS_KES_EMP', 'BPJS Kesehatan (Pekerja)', 1.0, 12000000, '2026-01-01', datetime('now')),
                ('bpjs_kes_co', 'BPJS_KES_CO', 'BPJS Kesehatan (Perusahaan)', 4.0, 12000000, '2026-01-01', datetime('now'));"#,
                vec![],
            ),
            // Seed Schema Migration
            Statement::new(
                r#"INSERT OR IGNORE INTO schema_migration (version, name, applied_at) VALUES
                (10, 'payroll-engine-v1', datetime('now'));"#,
                vec![],
            ),
        ];

        self.execute_pipeline(schema_stmts).await?;

        // Pertahankan nilai dari alias seed lama tanpa terus memakai nama yang drift.
        self.query_one(
            r#"INSERT INTO setting_gex_system (key, value)
               SELECT 'lat_kantor', value FROM setting_gex_system WHERE key = 'office_lat'
               ON CONFLICT(key) DO UPDATE SET value = excluded.value
               WHERE setting_gex_system.value = '0';"#,
            vec![],
        )
        .await?;
        self.query_one(
            r#"INSERT INTO setting_gex_system (key, value)
               SELECT 'lng_kantor', value FROM setting_gex_system WHERE key = 'office_lng'
               ON CONFLICT(key) DO UPDATE SET value = excluded.value
               WHERE setting_gex_system.value = '0';"#,
            vec![],
        )
        .await?;
        self.query_one(
            r#"INSERT INTO setting_gex_system (key, value)
               SELECT 'radius_meter', value FROM setting_gex_system WHERE key = 'office_radius_meters'
               ON CONFLICT(key) DO UPDATE SET value = excluded.value
               WHERE setting_gex_system.value = '100';"#,
            vec![],
        )
        .await?;
        self.query_one(
            r#"INSERT INTO setting_gex_system (key, value)
               SELECT 'anti_double_scan_seconds', value FROM setting_gex_system WHERE key = 'cooldown_scan_seconds'
               ON CONFLICT(key) DO UPDATE SET value = excluded.value
               WHERE setting_gex_system.value = '60';"#,
            vec![],
        )
        .await?;
        self.query_one(
            r#"INSERT INTO setting_gex_system (key, value)
               SELECT 'batas_multi_scan_menit', value FROM setting_gex_system WHERE key = 'multi_scan_window_minutes'
               ON CONFLICT(key) DO UPDATE SET value = excluded.value
               WHERE setting_gex_system.value = '5';"#,
            vec![],
        )
        .await?;
        self.query_one(
            r#"INSERT INTO setting_gex_system (key, value)
               SELECT 'auto_alfa_aktif', value FROM setting_gex_system WHERE key = 'auto_alfa_enabled'
               ON CONFLICT(key) DO UPDATE SET value = excluded.value
               WHERE setting_gex_system.value = 'true';"#,
            vec![],
        )
        .await?;

        // Idempotent column migrations for legacy databases in Turso Cloud.
        for (table, column, sql) in [
            ("master_operator", "role_id", "ALTER TABLE master_operator ADD COLUMN role_id INTEGER REFERENCES app_role(id);"),
            ("master_operator", "role", "ALTER TABLE master_operator ADD COLUMN role TEXT NOT NULL DEFAULT 'Operator';"),
            ("master_operator", "status", "ALTER TABLE master_operator ADD COLUMN status TEXT DEFAULT 'Aktif';"),
            ("master_operator", "created_at", "ALTER TABLE master_operator ADD COLUMN created_at TEXT;"),
            ("master_operator", "updated_at", "ALTER TABLE master_operator ADD COLUMN updated_at TEXT;"),
            ("tbl_shift", "izinkan_multi_sesi", "ALTER TABLE tbl_shift ADD COLUMN izinkan_multi_sesi INTEGER NOT NULL DEFAULT 0;"),
            ("import_offline", "timestamp_input", "ALTER TABLE import_offline ADD COLUMN timestamp_input TEXT;"),
            ("import_offline", "id_unik", "ALTER TABLE import_offline ADD COLUMN id_unik TEXT;"),
            ("import_offline", "status_absen", "ALTER TABLE import_offline ADD COLUMN status_absen TEXT;"),
            ("import_offline", "status_proses", "ALTER TABLE import_offline ADD COLUMN status_proses TEXT DEFAULT 'Belum Diproses';"),
            ("import_offline", "diproses_pada", "ALTER TABLE import_offline ADD COLUMN diproses_pada TEXT;"),
            ("import_offline", "pesan_error", "ALTER TABLE import_offline ADD COLUMN pesan_error TEXT;"),
            ("sync_operation_receipt", "payload_hash", "ALTER TABLE sync_operation_receipt ADD COLUMN payload_hash TEXT;"),
            ("sync_operation_receipt", "result_json", "ALTER TABLE sync_operation_receipt ADD COLUMN result_json TEXT;"),
            ("sync_operation_receipt", "base_revision", "ALTER TABLE sync_operation_receipt ADD COLUMN base_revision INTEGER;"),
            ("sync_operation_receipt", "actor_operator_id", "ALTER TABLE sync_operation_receipt ADD COLUMN actor_operator_id INTEGER;"),
            ("sync_operation_receipt", "receipt_json", "ALTER TABLE sync_operation_receipt ADD COLUMN receipt_json TEXT NOT NULL DEFAULT '{}';"),
            ("sync_operation_receipt", "processed_at", "ALTER TABLE sync_operation_receipt ADD COLUMN processed_at TEXT;"),
        ] {
            self.ensure_column(table, column, sql).await?;
        }

        // If template in Turso Cloud has empty '[]', upgrade it with default elements
        let default_elements_str =
            serde_json::to_string(&crate::desktop::operational::default_id_card_elements())
                .unwrap_or_else(|_| "[]".to_string());
        self.query_one(
            "UPDATE id_card_template SET elements_json = ? WHERE id = 'default_template' AND (elements_json IS NULL OR TRIM(elements_json) = '' OR TRIM(elements_json) = '[]') AND NOT EXISTS (SELECT 1 FROM sync_changelog WHERE domain IN ('id-card-template', 'id_card_template') AND entity_key = 'default_template');",
            vec![json!(default_elements_str)],
        ).await?;

        self.query_one(
            "INSERT OR IGNORE INTO schema_migration (version, name, applied_at) VALUES (-2001, 'two-tier-schema-stabilization-v1', datetime('now'));",
            vec![],
        )
        .await?;
        self.query_one(
            "INSERT OR IGNORE INTO schema_migration (version, name, applied_at) VALUES (-2002, 'two-tier-security-atomic-sync-v2', datetime('now'));",
            vec![],
        )
        .await?;
        self.query_one(
            "INSERT OR IGNORE INTO schema_migration (version, name, applied_at) VALUES (-2003, 'payroll-engine-v1', datetime('now'));",
            vec![],
        )
        .await?;

        // Selaraskan ulang counter AUTOINCREMENT yang terlanjur melar. Sebelum perbaikan,
        // setiap "INSERT ... ON CONFLICT DO UPDATE" tetap menghabiskan satu nomor urut
        // meskipun tidak ada baris baru, sehingga id melompat (mis. 7 -> 69 -> 111).
        // Dijalankan sekali saja karena ensure_schema hanya dipanggil ketika penanda
        // migrasi -2004 belum ada.
        for (table, primary_key) in [
            ("tbl_shift", "id_shift"),
            ("id_card", "id_card_id"),
            ("absensi_harian", "id_absensi"),
            ("koreksi_admin", "id_koreksi"),
            ("tbl_hari_libur", "id_libur"),
            ("import_offline", "id_import"),
            ("log_scan", "id_log"),
            ("audit_absensi", "id_audit"),
            ("master_operator", "id"),
        ] {
            let realign = format!(
                "UPDATE sqlite_sequence SET seq = (SELECT COALESCE(MAX({primary_key}), 0) FROM {table}) WHERE name = '{table}' AND seq > (SELECT COALESCE(MAX({primary_key}), 0) FROM {table});"
            );
            let _ = self.query_one(realign, vec![]).await;
        }

        self.query_one(
            "INSERT OR IGNORE INTO schema_migration (version, name, applied_at) VALUES (-2004, 'autoincrement-sequence-realign-v1', datetime('now'));",
            vec![],
        )
        .await?;

        self.ensure_sync_pulse().await?;
        self.query_one(
            "INSERT OR IGNORE INTO schema_migration (version, name, applied_at) VALUES (-2005, 'sync-pulse-change-detection-v1', datetime('now'));",
            vec![],
        )
        .await?;

        Ok(())
    }

    /// Memasang penghitung perubahan per tabel (`sync_pulse`) beserta trigger-nya.
    ///
    /// Ini yang membuat pull inkremental aman: penghitung dinaikkan oleh trigger
    /// SQLite, jadi ikut naik untuk SEMUA jalur tulis — push Desktop/Mobile,
    /// route handler Web yang menulis langsung ke Turso, maupun perubahan manual.
    /// Client cukup membandingkan angka ini untuk tahu tabel mana yang basi.
    async fn ensure_sync_pulse(&self) -> Result<(), CommandError> {
        let mut statements = vec![
            Statement::new(
                r#"CREATE TABLE IF NOT EXISTS sync_pulse (
                    table_name TEXT PRIMARY KEY,
                    revision INTEGER NOT NULL DEFAULT 0,
                    updated_at TEXT NOT NULL
                );"#,
                vec![],
            ),
        ];
        for source in SNAPSHOT_SOURCES {
            let table = source.table;
            // Diseed pada revisi 1 supaya client yang sudah sinkron penuh punya
            // angka pembanding, bukan 0 yang ambigu dengan "cursor lokal kosong".
            statements.push(Statement::new(
                format!(
                    "INSERT OR IGNORE INTO sync_pulse (table_name, revision, updated_at) VALUES ('{table}', 1, datetime('now'));"
                ),
                vec![],
            ));
            for (suffix, event) in [("ins", "INSERT"), ("upd", "UPDATE"), ("del", "DELETE")] {
                statements.push(Statement::new(
                    format!(
                        r#"CREATE TRIGGER IF NOT EXISTS trg_sync_pulse_{table}_{suffix}
                        AFTER {event} ON {table}
                        BEGIN
                          INSERT INTO sync_pulse (table_name, revision, updated_at)
                          VALUES ('{table}', 1, datetime('now'))
                          ON CONFLICT(table_name) DO UPDATE SET
                            revision = revision + 1,
                            updated_at = datetime('now');
                        END;"#
                    ),
                    vec![],
                ));
            }
        }
        // Dikirim per rombongan supaya pemasangan ~80 statement DDL ini tidak
        // menjadi 80 round-trip berurutan saat login pertama setelah pembaruan.
        // Tabel bisa saja belum ada di database lama, jadi kegagalan satu
        // rombongan diulang satu per satu dan tetap tidak menggagalkan
        // `ensure_schema` secara keseluruhan.
        for chunk in statements.chunks(24) {
            if self.execute_pipeline(chunk.to_vec()).await.is_ok() {
                continue;
            }
            for statement in chunk {
                let _ = self
                    .query_one(statement.sql.clone(), statement.args.clone())
                    .await;
            }
        }
        Ok(())
    }

    async fn ensure_schema_current(&self) -> Result<(), CommandError> {
        let cache_key = self.base_url.as_str().to_owned();
        if schema_verified_cache()
            .lock()
            .map(|verified| verified.contains(&cache_key))
            .unwrap_or(false)
        {
            return Ok(());
        }
        let current = self
            .query_one(
                "SELECT COUNT(*) AS total FROM schema_migration WHERE version = -2005;",
                vec![],
            )
            .await
            .ok()
            .and_then(|result| result.to_objects().into_iter().next())
            .and_then(|row| row.get("total").cloned())
            .and_then(|value| value.as_i64())
            .unwrap_or(0)
            > 0;
        if !current {
            self.ensure_schema().await?;
        }
        if let Ok(mut verified) = schema_verified_cache().lock() {
            verified.insert(cache_key);
        }
        Ok(())
    }

    /// Pemeriksaan database provisioning bersifat READ-ONLY: tidak membuat schema,
    /// tidak menulis apa pun. Salah input URL tidak boleh mencemari database lain.
    pub async fn inspect_database(&self) -> Result<DatabaseCheckResult, CommandError> {
        let started = std::time::Instant::now();
        let tables_result = self
            .query_one(
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%';",
                vec![],
            )
            .await?;
        let latency_ms = started.elapsed().as_millis() as u64;
        let tables: Vec<String> = tables_result
            .to_objects()
            .into_iter()
            .filter_map(|row| {
                row.get("name")
                    .and_then(Value::as_str)
                    .map(|name| name.to_owned())
            })
            .collect();
        let has_table = |name: &str| tables.iter().any(|table| table == name);
        let missing_tables: Vec<String> = DATABASE_CHECK_CORE_TABLES
            .iter()
            .filter(|table| !has_table(table))
            .map(|table| (*table).to_owned())
            .collect();

        let mut check = DatabaseCheckResult {
            reachable: true,
            server_origin: self.base_url.origin().ascii_serialization(),
            latency_ms: Some(latency_ms),
            empty_database: tables.is_empty(),
            schema_ready: missing_tables.is_empty(),
            missing_tables,
            table_count: tables.len() as i64,
            bootstrap_claimed: false,
            superadmin_exists: false,
            superadmin_count: 0,
            superadmin_username: None,
            operator_count: 0,
            karyawan_count: 0,
            attendance_count: 0,
            company_name: None,
            error_code: None,
            error_message: None,
        };

        if has_table("app_bootstrap_state") {
            check.bootstrap_claimed = self
                .count_scalar(
                    "SELECT COUNT(*) AS total FROM app_bootstrap_state WHERE bootstrap_key = 'superadmin';",
                )
                .await?
                > 0;
        }
        if has_table("master_operator") && has_table("app_role") {
            let superadmins = self
                .query_one(
                    r#"SELECT m.username AS username
                       FROM master_operator m
                       JOIN app_role r ON r.id = m.role_id
                       WHERE m.status = 'Aktif' AND r.is_superadmin = 1
                       ORDER BY m.id ASC;"#,
                    vec![],
                )
                .await?
                .to_objects();
            check.superadmin_count = superadmins.len() as i64;
            check.superadmin_exists = check.superadmin_count > 0;
            check.superadmin_username = superadmins
                .first()
                .and_then(|row| row.get("username"))
                .and_then(Value::as_str)
                .map(|username| username.to_owned());
            check.operator_count = self
                .count_scalar("SELECT COUNT(*) AS total FROM master_operator WHERE status = 'Aktif';")
                .await?;
        }
        if has_table("master_data") {
            check.karyawan_count = self
                .count_scalar("SELECT COUNT(*) AS total FROM master_data;")
                .await?;
        }
        if has_table("absensi_harian") {
            check.attendance_count = self
                .count_scalar("SELECT COUNT(*) AS total FROM absensi_harian;")
                .await?;
        }
        if has_table("company_profile") {
            check.company_name = self
                .query_one("SELECT company_name FROM company_profile LIMIT 1;", vec![])
                .await?
                .to_objects()
                .first()
                .and_then(|row| row.get("company_name"))
                .and_then(Value::as_str)
                .map(|name| name.trim().to_owned())
                .filter(|name| !name.is_empty());
        }
        Ok(check)
    }

    async fn count_scalar(&self, sql: &str) -> Result<i64, CommandError> {
        Ok(self
            .query_one(sql, vec![])
            .await?
            .to_objects()
            .into_iter()
            .next()
            .and_then(|row| row.get("total").cloned())
            .and_then(|value| {
                value
                    .as_i64()
                    .or_else(|| value.as_str().and_then(|text| text.parse().ok()))
            })
            .unwrap_or(0))
    }

    pub async fn bootstrap_status(&self) -> Result<BootstrapStatus, CommandError> {
        self.ensure_schema_current().await?;
        let result = self
            .query_one(
                r#"SELECT COUNT(*) AS total
                   FROM master_operator m
                   JOIN app_role r ON r.id = m.role_id
                   WHERE m.status = 'Aktif' AND r.is_superadmin = 1;"#,
                vec![],
            )
            .await?;
        let active_superadmins = result
            .to_objects()
            .into_iter()
            .next()
            .and_then(|row| row.get("total").cloned())
            .and_then(|value| {
                value
                    .as_i64()
                    .or_else(|| value.as_str().and_then(|text| text.parse().ok()))
            })
            .unwrap_or(0);
        Ok(BootstrapStatus {
            configured: true,
            required: active_superadmins == 0,
            server_origin: self.base_url.origin().ascii_serialization(),
        })
    }

    pub async fn bootstrap_superadmin(
        &self,
        draft: BootstrapSuperadminDraft,
    ) -> Result<(), CommandError> {
        validate_bootstrap_draft(&draft)?;
        if !self.bootstrap_status().await?.required {
            return Err(CommandError::new(
                "TURSO_BOOTSTRAP_CLOSED",
                "Bootstrap ditutup karena Superadmin aktif sudah tersedia.",
            ));
        }
        let superadmin_role_id = self
            .query_one(
                "SELECT id FROM app_role WHERE role_key = 'superadmin' AND is_superadmin = 1 AND status = 'Aktif' LIMIT 1;",
                vec![],
            )
            .await?
            .to_objects()
            .into_iter()
            .next()
            .and_then(|row| row.get("id").cloned())
            .and_then(|value| {
                value
                    .as_i64()
                    .or_else(|| value.as_str().and_then(|text| text.parse().ok()))
            })
            .filter(|role_id| *role_id > 0)
            .ok_or_else(|| {
                CommandError::new(
                    "TURSO_SCHEMA_INVALID",
                    "Role Superadmin aktif tidak tersedia pada schema database cloud.",
                )
            })?;
        let password = Zeroizing::new(draft.password);
        let password_hash = hash_password_pbkdf2(&password);
        let statements = vec![
            Statement::new(
                "INSERT INTO app_bootstrap_state (bootstrap_key, claimed_at) VALUES ('superadmin', datetime('now'));",
                vec![],
            ),
            Statement::new(
                r#"INSERT INTO master_operator (
                    kode_operator, nama_operator, username, password_hash,
                    role, role_id, status, created_at, updated_at
                ) VALUES (?, ?, ?, ?, 'Admin', ?, 'Aktif', datetime('now'), datetime('now'));"#,
                vec![
                    json!(draft.kode_operator.trim().to_ascii_uppercase()),
                    json!(draft.nama_operator.trim()),
                    json!(draft.username.trim()),
                    json!(password_hash),
                    json!(superadmin_role_id),
                ],
            ),
        ];
        self.execute_atomic(statements).await.map_err(|error| {
            if error.message.contains("UNIQUE") || error.message.contains("bootstrap") {
                CommandError::new(
                    "TURSO_BOOTSTRAP_CLOSED",
                    "Bootstrap ditutup karena sudah pernah diklaim pada database ini.",
                )
            } else {
                error
            }
        })?;
        if self.bootstrap_status().await?.required {
            return Err(CommandError::new(
                "TURSO_BOOTSTRAP_FAILED",
                "Superadmin awal belum berhasil dibuat.",
            ));
        }
        Ok(())
    }

    pub async fn authenticate_operator(
        &self,
        identifier: &str,
        password: &str,
    ) -> Result<OperatorUser, CommandError> {
        self.ensure_schema_current().await?;
        let id_clean = identifier.trim();
        let sql = r#"
            SELECT
                m.id, m.kode_operator, m.nama_operator, m.username, m.password_hash,
                m.role_id, r.role_key, r.nama_role, r.is_superadmin
            FROM master_operator m
            JOIN app_role r ON r.id = m.role_id
            WHERE (m.username = ? COLLATE NOCASE OR m.kode_operator = ? COLLATE NOCASE)
              AND m.status = 'Aktif' AND r.status = 'Aktif'
            LIMIT 1;
        "#;

        let result = self
            .query_one(sql, vec![json!(id_clean), json!(id_clean)])
            .await?;

        let objects = result.to_objects();
        let row = objects.first().ok_or_else(|| {
            CommandError::new(
                "LOGIN_REJECTED",
                "Username atau password tidak sesuai atau akun nonaktif.",
            )
        })?;

        let stored_hash = row
            .get("password_hash")
            .and_then(Value::as_str)
            .unwrap_or("");

        if !verify_password(password, stored_hash) {
            return Err(CommandError::new(
                "LOGIN_REJECTED",
                "Username atau password tidak sesuai.",
            ));
        }

        let op_id = row.get("id").and_then(Value::as_i64).unwrap_or(0);
        if !stored_hash.starts_with("pbkdf2-sha256$") && !stored_hash.starts_with("$argon2") {
            let upgraded_hash = hash_password_pbkdf2(password);
            self.query_one(
                "UPDATE master_operator SET password_hash = ?, updated_at = datetime('now') WHERE id = ? AND password_hash = ?;",
                vec![json!(upgraded_hash), json!(op_id), json!(stored_hash)],
            )
            .await?;
        }
        let kode_operator = row
            .get("kode_operator")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned();
        let nama_operator = row
            .get("nama_operator")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned();
        let username = row
            .get("username")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned();
        let role_id = row.get("role_id").and_then(Value::as_i64).unwrap_or(0);
        let role_key = row
            .get("role_key")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned();
        let nama_role = row
            .get("nama_role")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned();
        let is_superadmin = row
            .get("is_superadmin")
            .and_then(|v| v.as_i64().map(|n| n == 1).or_else(|| v.as_bool()))
            .unwrap_or(false);

        // Permission selalu dibaca dari katalog aktif agar backend dan UI tidak drift.
        let permission_sql = if is_superadmin {
            "SELECT permission_key FROM app_permission WHERE is_active = 1 ORDER BY sort_order, permission_key;"
        } else {
            "SELECT p.permission_key FROM app_permission p JOIN role_permission rp ON rp.permission_key = p.permission_key WHERE p.is_active = 1 AND rp.role_id = ? AND rp.is_allowed = 1 ORDER BY p.sort_order, p.permission_key;"
        };
        let permission_args = if is_superadmin {
            vec![]
        } else {
            vec![json!(role_id)]
        };
        let permissions = self
            .query_one(permission_sql, permission_args)
            .await?
            .to_objects()
            .into_iter()
            .filter_map(|permission| {
                permission
                    .get("permission_key")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            })
            .collect();

        // Ambil rbac_revision
        let rev_query = self
            .query_one(
                "SELECT value FROM setting_gex_system WHERE key = 'rbac_revision' LIMIT 1;",
                vec![],
            )
            .await;
        let permission_revision = rev_query
            .ok()
            .and_then(|res| res.to_objects().into_iter().next())
            .and_then(|row| {
                row.get("value")
                    .and_then(Value::as_str)
                    .and_then(|s| s.parse::<i64>().ok())
                    .or_else(|| row.get("value").and_then(Value::as_i64))
            })
            .unwrap_or(1);

        Ok(OperatorUser {
            id: op_id,
            kode_operator,
            nama_operator,
            username,
            role: nama_role,
            role_id,
            role_key,
            is_superadmin,
            permissions,
            permission_revision,
            login_at: Some(chrono_like_now_iso()),
        })
    }

    /// Membaca penghitung perubahan per tabel dari `sync_pulse`.
    ///
    /// `Ok(None)` berarti database cloud belum memiliki tabel/trigger pulse
    /// (database lama). Pemanggil wajib memperlakukannya sebagai "semua tabel
    /// berpotensi berubah" dan menarik snapshot penuh.
    pub async fn fetch_sync_pulse(&self) -> Result<Option<HashMap<String, i64>>, CommandError> {
        let Ok(result) = self
            .query_one("SELECT table_name, revision FROM sync_pulse;", vec![])
            .await
        else {
            return Ok(None);
        };
        let mut pulse = HashMap::with_capacity(SNAPSHOT_SOURCES.len());
        for row in result.to_objects() {
            let Some(table) = row.get("table_name").and_then(Value::as_str) else {
                continue;
            };
            let revision = row
                .get("revision")
                .and_then(|value| {
                    value
                        .as_i64()
                        .or_else(|| value.as_str().and_then(|text| text.parse().ok()))
                })
                .unwrap_or(0);
            pulse.insert(table.to_owned(), revision);
        }
        if pulse.is_empty() {
            return Ok(None);
        }
        Ok(Some(pulse))
    }

    /// Menarik snapshot cloud. Bila `wanted` diisi, hanya tabel di dalamnya yang
    /// dibaca — kunci payload tabel lain sengaja tidak dimunculkan sama sekali
    /// agar `sync::apply_table` memperlakukannya sebagai "tidak dikirim" dan
    /// melewatkannya (termasuk melewatkan penghapusan baris lokal).
    pub async fn pull_snapshot_tables(
        &self,
        last_revision: i64,
        wanted: Option<&HashSet<String>>,
    ) -> Result<Value, CommandError> {
        self.ensure_schema_current().await?;
        let sources: Vec<&SnapshotSource> = SNAPSHOT_SOURCES
            .iter()
            .filter(|source| match wanted {
                None => true,
                Some(set) => set.contains(source.table),
            })
            .collect();

        let mut snapshot = json!({});
        let mut max_rev = last_revision;

        if !sources.is_empty() {
            let mut statements: Vec<Statement> = sources
                .iter()
                .map(|source| Statement::new(source.sql, vec![]))
                .collect();
            statements.push(Statement::new(
                "SELECT COALESCE(MAX(id), 0) AS max_rev FROM sync_changelog;",
                vec![],
            ));

            let results = self.execute_pipeline(statements).await?;
            let rev_result = results.last().ok_or_else(CommandError::internal)?;
            let queried_rev = rev_result
                .to_objects()
                .into_iter()
                .next()
                .and_then(|row| {
                    row.get("max_rev").and_then(|value| {
                        value
                            .as_i64()
                            .or_else(|| value.as_str().and_then(|text| text.parse().ok()))
                    })
                })
                .unwrap_or(0);
            max_rev = queried_rev.max(last_revision);

            for (idx, source) in sources.iter().enumerate() {
                let res = results.get(idx).ok_or_else(CommandError::internal)?;
                let rows_json: Vec<Value> =
                    res.to_objects().into_iter().map(|map| json!(map)).collect();
                snapshot[source.payload_key] = json!(rows_json);
            }
        }

        snapshot["revision"] = json!(max_rev);
        Ok(json!({ "snapshot": snapshot }))
    }

    pub async fn push_events(&self, events: &[Value]) -> Result<Vec<Value>, CommandError> {
        self.ensure_schema_current().await?;
        if events.is_empty() || events.len() > 50 {
            return Err(CommandError::new(
                "TURSO_SYNC_BATCH_INVALID",
                "Batch sinkronisasi harus berisi 1 sampai 50 event.",
            ));
        }
        let mut push_results = Vec::new();

        // Pastikan tabel sync_changelog ada
        let ensure_changelog_sql = r#"
            CREATE TABLE IF NOT EXISTS sync_changelog (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                client_id TEXT NOT NULL,
                event_id TEXT NOT NULL UNIQUE,
                domain TEXT NOT NULL,
                operation TEXT NOT NULL,
                entity_key TEXT NOT NULL,
                payload_json TEXT NOT NULL,
                created_at INTEGER NOT NULL
            );
        "#;

        // Satu round-trip untuk seluruh batch: jaminan tabel changelog + pemetaan
        // changelog dan receipt untuk semua event sekaligus. Sebelumnya setiap
        // event menembak dua query terpisah secara berurutan, jadi satu batch 50
        // event berarti 100+ request HTTP bolak-balik ke Turso.
        let batch_event_ids: Vec<String> = events
            .iter()
            .filter_map(|event| {
                event
                    .get("event_id")
                    .or_else(|| event.get("eventId"))
                    .and_then(Value::as_str)
            })
            .filter(|event_id| !event_id.is_empty())
            .map(str::to_owned)
            .collect();

        let mut previous_events: HashMap<String, HashMap<String, Value>> = HashMap::new();
        let mut applied_receipts: HashSet<String> = HashSet::new();
        if batch_event_ids.is_empty() {
            self.query_one(ensure_changelog_sql, vec![]).await?;
        } else {
            let placeholders = vec!["?"; batch_event_ids.len()].join(", ");
            let args: Vec<Value> = batch_event_ids.iter().map(|id| json!(id)).collect();
            let prefetch = self
                .execute_pipeline(vec![
                    Statement::new(ensure_changelog_sql, vec![]),
                    Statement::new(
                        format!(
                            "SELECT id, event_id, client_id, domain, operation, entity_key, payload_json FROM sync_changelog WHERE event_id IN ({placeholders});"
                        ),
                        args.clone(),
                    ),
                    Statement::new(
                        format!(
                            "SELECT event_id FROM sync_operation_receipt WHERE status = 'applied' AND event_id IN ({placeholders});"
                        ),
                        args,
                    ),
                ])
                .await?;
            if let Some(result) = prefetch.get(1) {
                for row in result.to_objects() {
                    let Some(event_id) = row
                        .get("event_id")
                        .and_then(Value::as_str)
                        .map(str::to_owned)
                    else {
                        continue;
                    };
                    previous_events.insert(event_id, row);
                }
            }
            if let Some(result) = prefetch.get(2) {
                for row in result.to_objects() {
                    if let Some(event_id) = row.get("event_id").and_then(Value::as_str) {
                        applied_receipts.insert(event_id.to_owned());
                    }
                }
            }
        }

        for event in events {
            let event_id = event
                .get("event_id")
                .or_else(|| event.get("eventId"))
                .and_then(Value::as_str)
                .unwrap_or("");
            let client_id = event
                .get("client_id")
                .or_else(|| event.get("clientId"))
                .and_then(Value::as_str)
                .unwrap_or("desktop-client");
            let raw_domain = event.get("domain").and_then(Value::as_str).unwrap_or("");
            let raw_operation = event.get("operation").and_then(Value::as_str).unwrap_or("");
            let entity_key = event
                .get("entity_key")
                .or_else(|| event.get("entityKey"))
                .and_then(Value::as_str)
                .unwrap_or("");
            let base_revision = event
                .get("base_revision")
                .or_else(|| event.get("baseRevision"))
                .and_then(Value::as_i64);
            let payload_json = event
                .get("payload_json")
                .or_else(|| event.get("payloadJson"))
                .or_else(|| event.get("payload"))
                .map(|value| match value {
                    Value::String(text) => text.clone(),
                    other => other.to_string(),
                })
                .unwrap_or_else(|| "{}".to_owned());

            let valid_event_id = event_id.len() == 68
                && event_id.starts_with("evt-")
                && event_id[4..].bytes().all(|byte| byte.is_ascii_hexdigit());
            let valid_client_id = client_id.len() == 72
                && client_id.starts_with("desktop-")
                && client_id[8..].bytes().all(|byte| byte.is_ascii_hexdigit());
            if !valid_event_id
                || !valid_client_id
                || raw_domain.is_empty()
                || raw_operation.is_empty()
                || entity_key.is_empty()
                || entity_key.len() > 160
                || base_revision.is_some_and(|revision| revision < 0)
                || payload_json.len() > 25_165_824
            {
                return Err(CommandError::new(
                    "TURSO_SYNC_EVENT_INVALID",
                    "Event sinkronisasi tidak valid atau melampaui batas payload.",
                ));
            }
            let parsed_payload = serde_json::from_str::<Value>(&payload_json).map_err(|_| {
                CommandError::new(
                    "TURSO_SYNC_EVENT_INVALID",
                    "Payload event sinkronisasi bukan JSON yang valid.",
                )
            })?;
            if !parsed_payload.is_object() {
                return Err(CommandError::new(
                    "TURSO_SYNC_EVENT_INVALID",
                    "Payload event sinkronisasi harus berupa objek JSON.",
                ));
            }
            let Some((domain, operation)) = canonical_sync_route(raw_domain, raw_operation) else {
                let message = format!(
                    "Domain atau operasi sinkronisasi tidak dikenali: {raw_domain}/{raw_operation}."
                );
                push_results.push(json!({
                    "eventId": event_id,
                    "status": "conflict",
                    "reason": message.clone(),
                    "message": message,
                    "serverRevision": 0
                }));
                continue;
            };

            // Receipt adalah sumber idempotensi event sukses. Changelog tanpa receipt
            // hanya mungkin berasal dari versi lama yang belum atomik.
            let previous_event = previous_events.get(event_id);
            if let Some(previous) = previous_event {
                let previous_route = previous
                    .get("domain")
                    .and_then(Value::as_str)
                    .zip(previous.get("operation").and_then(Value::as_str))
                    .and_then(|(domain, operation)| canonical_sync_route(domain, operation));
                let same_event = previous.get("client_id").and_then(Value::as_str)
                    == Some(client_id)
                    && previous_route == Some((domain, operation))
                    && previous.get("entity_key").and_then(Value::as_str) == Some(entity_key)
                    && previous.get("payload_json").and_then(Value::as_str)
                        == Some(payload_json.as_str());
                if !same_event {
                    return Err(CommandError::new(
                        "TURSO_SYNC_EVENT_COLLISION",
                        "Event ID pernah dipakai dengan isi yang berbeda.",
                    ));
                }
                let previous_revision = previous
                    .get("id")
                    .and_then(|value| {
                        value
                            .as_i64()
                            .or_else(|| value.as_str().and_then(|text| text.parse().ok()))
                    })
                    .filter(|revision| *revision > 0)
                    .ok_or_else(|| {
                        CommandError::new(
                            "TURSO_SYNC_REVISION_INVALID",
                            "Revision event sinkronisasi tidak dapat ditentukan.",
                        )
                    })?;
                if applied_receipts.contains(event_id) {
                    push_results.push(json!({
                        "eventId": event_id,
                        "status": "applied",
                        "message": "Event sudah pernah diterapkan.",
                        "serverRevision": previous_revision
                    }));
                    continue;
                }
                self.query_one(
                    "DELETE FROM sync_changelog WHERE event_id = ?;",
                    vec![json!(event_id)],
                )
                .await?;
            }

            let now_epoch = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs() as i64)
                .unwrap_or_default();

            let collector = StatementCollector::default();
            if let Err(error) =
                apply_event_to_turso(&collector, domain, operation, entity_key, &parsed_payload)
                    .await
            {
                push_results.push(json!({
                    "eventId": event_id,
                    "status": "conflict",
                    "reason": error.message.clone(),
                    "message": error.message,
                    "serverRevision": 0
                }));
                continue;
            }
            let mutations = collector.finish()?;
            if mutations.is_empty() {
                let message = format!(
                    "Payload event tidak menghasilkan mutasi: {domain}/{operation} ({entity_key})."
                );
                push_results.push(json!({
                    "eventId": event_id,
                    "status": "conflict",
                    "reason": message.clone(),
                    "message": message,
                    "serverRevision": 0
                }));
                continue;
            }
            let mut transaction_statements = vec![Statement::new(
                r#"INSERT INTO sync_changelog (
                    client_id, event_id, domain, operation, entity_key, payload_json, created_at
                ) VALUES (
                    CASE WHEN ? IS NULL OR COALESCE((
                        SELECT MAX(id) FROM sync_changelog
                        WHERE domain = ? AND entity_key = ?
                    ), 0) <= ? THEN ? ELSE NULL END,
                    ?, ?, ?, ?, ?, ?
                )
                ON CONFLICT(event_id) DO UPDATE SET
                    client_id = CASE WHEN
                        sync_changelog.client_id = excluded.client_id
                        AND sync_changelog.domain = excluded.domain
                        AND sync_changelog.operation = excluded.operation
                        AND sync_changelog.entity_key = excluded.entity_key
                        AND sync_changelog.payload_json = excluded.payload_json
                    THEN sync_changelog.client_id ELSE NULL END;"#,
                vec![
                    json!(base_revision),
                    json!(domain),
                    json!(entity_key),
                    json!(base_revision),
                    json!(client_id),
                    json!(event_id),
                    json!(domain),
                    json!(operation),
                    json!(entity_key),
                    json!(payload_json),
                    json!(now_epoch),
                ],
            )];
            transaction_statements.extend(mutations);
            let receipt = json!({ "eventId": event_id, "status": "applied" });
            let payload_hash = hex::encode(Sha256::digest(payload_json.as_bytes()));
            transaction_statements.push(Statement::new(
                r#"INSERT OR REPLACE INTO sync_operation_receipt (
                    event_id, client_id, domain, operation, entity_key, payload_hash,
                    server_revision, status, result_json, base_revision, actor_operator_id,
                    receipt_json, created_at, processed_at
                ) VALUES (?, ?, ?, ?, ?,
                    ?, (SELECT id FROM sync_changelog WHERE event_id = ?),
                    'applied', ?, ?, 0, ?, ?, datetime('now'));"#,
                vec![
                    json!(event_id),
                    json!(client_id),
                    json!(domain),
                    json!(operation),
                    json!(entity_key),
                    json!(payload_hash),
                    json!(event_id),
                    json!(receipt.to_string()),
                    json!(base_revision),
                    json!(receipt.to_string()),
                    json!(now_epoch),
                ],
            ));

            if let Err(error) = self.execute_atomic(transaction_statements).await {
                let current_revision = if let Some(base_revision) = base_revision {
                    self.query_one(
                        "SELECT COALESCE(MAX(id), 0) AS revision FROM sync_changelog WHERE domain = ? AND entity_key = ?;",
                        vec![json!(domain), json!(entity_key)],
                    )
                    .await
                    .ok()
                    .and_then(|result| result.to_objects().into_iter().next())
                    .and_then(|row| row.get("revision").cloned())
                    .and_then(|value| {
                        value
                            .as_i64()
                            .or_else(|| value.as_str().and_then(|text| text.parse().ok()))
                    })
                    .filter(|revision| *revision > base_revision)
                } else {
                    None
                };
                let message = current_revision
                    .map(|_| "Data server berubah setelah snapshot lokal dibuat.".to_owned())
                    .unwrap_or(error.message);
                push_results.push(json!({
                    "eventId": event_id,
                    "status": "conflict",
                    "reason": message.clone(),
                    "message": message,
                    "serverRevision": current_revision.unwrap_or(0)
                }));
                continue;
            }
            let server_revision = self
                .query_one(
                    "SELECT id FROM sync_changelog WHERE event_id = ? LIMIT 1;",
                    vec![json!(event_id)],
                )
                .await?
                .to_objects()
                .into_iter()
                .next()
                .and_then(|row| row.get("id").cloned())
                .and_then(|value| {
                    value
                        .as_i64()
                        .or_else(|| value.as_str().and_then(|text| text.parse().ok()))
                })
                .filter(|revision| *revision > 0)
                .ok_or_else(|| {
                    CommandError::new(
                        "TURSO_SYNC_REVISION_INVALID",
                        "Revision event sinkronisasi tidak dapat ditentukan.",
                    )
                })?;
            push_results.push(json!({
                "eventId": event_id,
                "status": "applied",
                "message": "Event berhasil diterapkan secara atomik ke database Turso.",
                "serverRevision": server_revision
            }));
        }

        Ok(push_results)
    }

    pub async fn get_master_operators(&self) -> Result<Value, CommandError> {
        self.ensure_schema_current().await?;
        let sql = r#"
            SELECT
                m.id, m.kode_operator, m.nama_operator, m.username,
                COALESCE(m.role_id, 2) AS role_id,
                COALESCE(m.status, 'Aktif') AS status,
                COALESCE(r.nama_role, 'Admin') AS nama_role,
                COALESCE(r.role_key, 'admin') AS role_key,
                COALESCE(r.is_superadmin, 0) AS is_superadmin,
                COALESCE(m.created_at, '') AS created_at,
                COALESCE(m.updated_at, '') AS updated_at
            FROM master_operator m
            LEFT JOIN app_role r ON r.id = m.role_id
            ORDER BY m.id ASC;
        "#;
        let res = self.query_one(sql, vec![]).await?;
        let rows: Vec<Value> = res.to_objects().into_iter().map(|m| json!(m)).collect();
        Ok(json!({ "operators": rows }))
    }

    pub async fn create_operator(&self, draft: &Value) -> Result<Value, CommandError> {
        let kode_operator = draft
            .get("kode_operator")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim();
        let nama_operator = draft
            .get("nama_operator")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim();
        let username = draft
            .get("username")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim();
        let password = draft
            .get("password")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim();
        let role_id = draft.get("role_id").and_then(Value::as_i64).unwrap_or(2);
        let status = draft
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or("Aktif");

        if kode_operator.is_empty()
            || nama_operator.is_empty()
            || username.is_empty()
            || password.is_empty()
        {
            return Err(CommandError::new(
                "VALIDATION_ERROR",
                "Data operator tidak lengkap.",
            ));
        }

        let password_hash = hash_password_pbkdf2(password);
        let now_epoch = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or_default();

        let sql = r#"
            INSERT INTO master_operator (kode_operator, nama_operator, username, password_hash, role_id, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?);
        "#;

        let res = self
            .query_one(
                sql,
                vec![
                    json!(kode_operator),
                    json!(nama_operator),
                    json!(username),
                    json!(password_hash),
                    json!(role_id),
                    json!(status),
                    json!(now_epoch),
                    json!(now_epoch),
                ],
            )
            .await?;

        let new_id = res.last_insert_rowid.unwrap_or(0);
        Ok(json!({
            "sukses": true,
            "operator": {
                "id": new_id,
                "kode_operator": kode_operator,
                "nama_operator": nama_operator,
                "username": username,
                "role_id": role_id,
                "status": status
            }
        }))
    }

    pub async fn update_operator(&self, id: i64, draft: &Value) -> Result<Value, CommandError> {
        let target = self
            .query_one(
                "SELECT r.is_superadmin FROM master_operator m JOIN app_role r ON r.id = m.role_id WHERE m.id = ? LIMIT 1;",
                vec![json!(id)],
            )
            .await?
            .to_objects()
            .into_iter()
            .next()
            .ok_or_else(|| CommandError::new("VALIDATION_ERROR", "Operator tidak ditemukan."))?;
        if target.get("is_superadmin").and_then(Value::as_i64) == Some(1) {
            if draft.get("status").and_then(Value::as_str) == Some("Nonaktif") {
                return Err(CommandError::new(
                    "FORBIDDEN",
                    "Superadmin aktif terakhir tidak dapat dinonaktifkan.",
                ));
            }
            if let Some(next_role_id) = draft.get("role_id").and_then(Value::as_i64) {
                let next_is_superadmin = self
                    .query_one(
                        "SELECT is_superadmin FROM app_role WHERE id = ? AND status = 'Aktif' LIMIT 1;",
                        vec![json!(next_role_id)],
                    )
                    .await?
                    .to_objects()
                    .into_iter()
                    .next()
                    .and_then(|row| row.get("is_superadmin").and_then(Value::as_i64))
                    == Some(1);
                if !next_is_superadmin {
                    return Err(CommandError::new(
                        "FORBIDDEN",
                        "Superadmin aktif terakhir tidak dapat diturunkan rolenya.",
                    ));
                }
            }
        }
        let mut updates = Vec::new();
        let mut args = Vec::new();

        if let Some(nama) = draft.get("nama_operator").and_then(Value::as_str) {
            updates.push("nama_operator = ?");
            args.push(json!(nama.trim()));
        }
        if let Some(role_id) = draft.get("role_id").and_then(Value::as_i64) {
            updates.push("role_id = ?");
            args.push(json!(role_id));
        }
        if let Some(status) = draft.get("status").and_then(Value::as_str) {
            updates.push("status = ?");
            args.push(json!(status));
        }
        if let Some(password) = draft.get("password").and_then(Value::as_str) {
            if !password.trim().is_empty() {
                updates.push("password_hash = ?");
                args.push(json!(hash_password_pbkdf2(password.trim())));
            }
        }

        if updates.is_empty() {
            return Ok(json!({ "sukses": true }));
        }

        let now_epoch = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or_default();
        updates.push("updated_at = ?");
        args.push(json!(now_epoch));

        args.push(json!(id));
        let sql = format!(
            "UPDATE master_operator SET {} WHERE id = ?;",
            updates.join(", ")
        );

        self.query_one(&sql, args).await?;
        Ok(json!({ "sukses": true }))
    }

    pub async fn delete_operator(&self, id: i64) -> Result<Value, CommandError> {
        let check_sql = "SELECT is_superadmin FROM app_role r JOIN master_operator m ON m.role_id = r.id WHERE m.id = ?;";
        let check = self.query_one(check_sql, vec![json!(id)]).await?;
        if let Some(row) = check.to_objects().first() {
            if row
                .get("is_superadmin")
                .and_then(|v| v.as_i64())
                .unwrap_or(0)
                == 1
            {
                return Err(CommandError::new(
                    "FORBIDDEN",
                    "Akun Superadmin utama tidak dapat dihapus.",
                ));
            }
        }

        self.query_one("DELETE FROM master_operator WHERE id = ?;", vec![json!(id)])
            .await?;
        Ok(json!({ "sukses": true }))
    }

    pub async fn get_roles(&self) -> Result<Value, CommandError> {
        self.ensure_schema_current().await?;
        let roles_sql = "SELECT id, role_key, nama_role, deskripsi, is_superadmin, status FROM app_role ORDER BY id ASC;";
        let perms_sql = "SELECT role_id, permission_key, is_allowed FROM role_permission;";

        let mut results = self
            .execute_pipeline(vec![
                Statement::new(roles_sql, vec![]),
                Statement::new(perms_sql, vec![]),
            ])
            .await?;

        let perms_res = results.pop().unwrap_or_default();
        let roles_res = results.pop().unwrap_or_default();

        let mut role_perms: HashMap<i64, Vec<String>> = HashMap::new();
        for p in perms_res.to_objects() {
            let r_id = p.get("role_id").and_then(Value::as_i64).unwrap_or(0);
            let is_allowed = p.get("is_allowed").and_then(Value::as_i64).unwrap_or(0) == 1;
            let key = p
                .get("permission_key")
                .and_then(Value::as_str)
                .unwrap_or("");
            if is_allowed && !key.is_empty() {
                role_perms.entry(r_id).or_default().push(key.to_owned());
            }
        }

        let mut roles = Vec::new();
        for r in roles_res.to_objects() {
            let r_id = r.get("id").and_then(Value::as_i64).unwrap_or(0);
            let mut role_obj = json!(r);
            let perms = role_perms.get(&r_id).cloned().unwrap_or_default();
            role_obj["permissions"] = json!(perms);
            roles.push(role_obj);
        }

        Ok(json!({ "roles": roles }))
    }

    pub async fn create_role(&self, draft: &Value) -> Result<Value, CommandError> {
        let role_key = draft
            .get("role_key")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim();
        let nama_role = draft
            .get("nama_role")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim();
        let deskripsi = draft.get("deskripsi").and_then(Value::as_str).unwrap_or("");

        if role_key.is_empty() || nama_role.is_empty() {
            return Err(CommandError::new(
                "VALIDATION_ERROR",
                "Data role tidak lengkap.",
            ));
        }
        if role_key.len() > 64
            || !role_key
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
            || role_key.starts_with('-')
            || role_key.ends_with('-')
        {
            return Err(CommandError::new(
                "VALIDATION_ERROR",
                "Role key wajib memakai huruf kecil, angka, dan tanda minus.",
            ));
        }

        let mut statements = vec![Statement::new(
            "INSERT INTO app_role (role_key, nama_role, deskripsi, is_superadmin, status, created_at, updated_at) VALUES (?, ?, ?, 0, 'Aktif', datetime('now'), datetime('now'));",
            vec![json!(role_key), json!(nama_role), json!(deskripsi)],
        )];
        if let Some(perms) = draft.get("permissions").and_then(Value::as_array) {
            statements.extend(perms
                .iter()
                .filter_map(|p| p.as_str())
                .map(|p_key| {
                    Statement::new(
                        "INSERT OR REPLACE INTO role_permission (role_id, permission_key, is_allowed, updated_at, updated_by) VALUES ((SELECT id FROM app_role WHERE role_key = ?), ?, 1, datetime('now'), 'system');",
                        vec![json!(role_key), json!(p_key)],
                    )
                }));
        }
        statements.push(Statement::new(
            "INSERT INTO setting_gex_system (key, value) VALUES ('rbac_revision', strftime('%s','now')) ON CONFLICT(key) DO UPDATE SET value = strftime('%s','now');",
            vec![],
        ));
        self.execute_atomic(statements).await?;
        let role_id = self
            .query_one(
                "SELECT id FROM app_role WHERE role_key = ? LIMIT 1;",
                vec![json!(role_key)],
            )
            .await?
            .to_objects()
            .into_iter()
            .next()
            .and_then(|row| row.get("id").and_then(Value::as_i64))
            .ok_or_else(|| {
                CommandError::new(
                    "TURSO_ROLE_CREATE_FAILED",
                    "Role baru tidak ditemukan setelah transaksi.",
                )
            })?;
        Ok(json!({ "sukses": true, "role_id": role_id }))
    }

    pub async fn update_role(&self, role_id: i64, draft: &Value) -> Result<Value, CommandError> {
        let target = self
            .query_one(
                "SELECT is_superadmin FROM app_role WHERE id = ? LIMIT 1;",
                vec![json!(role_id)],
            )
            .await?
            .to_objects()
            .into_iter()
            .next()
            .ok_or_else(|| CommandError::new("VALIDATION_ERROR", "Role tidak ditemukan."))?;
        if target.get("is_superadmin").and_then(Value::as_i64) == Some(1) {
            return Err(CommandError::new(
                "FORBIDDEN",
                "Role Superadmin tidak dapat diubah atau dinonaktifkan.",
            ));
        }
        let mut updates = Vec::new();
        let mut args = Vec::new();

        if let Some(nama) = draft.get("nama_role").and_then(Value::as_str) {
            updates.push("nama_role = ?");
            args.push(json!(nama.trim()));
        }
        if let Some(deskripsi) = draft.get("deskripsi").and_then(Value::as_str) {
            updates.push("deskripsi = ?");
            args.push(json!(deskripsi));
        }

        if !updates.is_empty() {
            updates.push("updated_at = datetime('now')");
            args.push(json!(role_id));
            let sql = format!("UPDATE app_role SET {} WHERE id = ?;", updates.join(", "));
            self.query_one(&sql, args).await?;
        }

        Ok(json!({ "sukses": true }))
    }

    pub async fn set_role_permissions(
        &self,
        role_id: i64,
        permissions: &[String],
    ) -> Result<Value, CommandError> {
        let target = self
            .query_one(
                "SELECT is_superadmin FROM app_role WHERE id = ? LIMIT 1;",
                vec![json!(role_id)],
            )
            .await?
            .to_objects()
            .into_iter()
            .next()
            .ok_or_else(|| CommandError::new("VALIDATION_ERROR", "Role tidak ditemukan."))?;
        if target.get("is_superadmin").and_then(Value::as_i64) == Some(1) {
            return Err(CommandError::new(
                "FORBIDDEN",
                "Permission Superadmin selalu mengikuti katalog aktif dan tidak dapat dikurangi.",
            ));
        }
        let available: HashSet<String> = self
            .query_one(
                "SELECT permission_key FROM app_permission WHERE is_active = 1;",
                vec![],
            )
            .await?
            .to_objects()
            .into_iter()
            .filter_map(|row| {
                row.get("permission_key")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            })
            .collect();
        if permissions
            .iter()
            .any(|permission| !available.contains(permission))
        {
            return Err(CommandError::new(
                "VALIDATION_ERROR",
                "Daftar permission memuat key yang tidak aktif atau tidak dikenal.",
            ));
        }
        let mut stmts = vec![Statement::new(
            "DELETE FROM role_permission WHERE role_id = ?;",
            vec![json!(role_id)],
        )];

        for p_key in permissions {
            stmts.push(Statement::new(
                "INSERT INTO role_permission (role_id, permission_key, is_allowed, updated_at, updated_by) VALUES (?, ?, 1, datetime('now'), 'system');",
                vec![json!(role_id), json!(p_key)],
            ));
        }

        // Bump rbac revision
        stmts.push(Statement::new(
            "INSERT INTO setting_gex_system (key, value) VALUES ('rbac_revision', strftime('%s','now')) ON CONFLICT(key) DO UPDATE SET value = strftime('%s','now');",
            vec![],
        ));

        self.execute_atomic(stmts).await?;
        Ok(json!({ "sukses": true }))
    }

    pub async fn delete_role(&self, role_id: i64) -> Result<Value, CommandError> {
        let check = self
            .query_one(
                "SELECT r.is_superadmin, r.is_system, COUNT(m.id) AS operator_count FROM app_role r LEFT JOIN master_operator m ON m.role_id = r.id WHERE r.id = ? GROUP BY r.id;",
                vec![json!(role_id)],
            )
            .await?;
        if let Some(row) = check.to_objects().first() {
            let protected = row.get("is_superadmin").and_then(Value::as_i64) == Some(1)
                || row.get("is_system").and_then(Value::as_i64) == Some(1)
                || row
                    .get("operator_count")
                    .and_then(Value::as_i64)
                    .unwrap_or(0)
                    > 0;
            if protected {
                return Err(CommandError::new(
                    "FORBIDDEN",
                    "Role sistem atau role yang masih dipakai operator tidak dapat dihapus.",
                ));
            }
        }

        self.execute_atomic(vec![
            Statement::new(
                "DELETE FROM role_permission WHERE role_id = ?;",
                vec![json!(role_id)],
            ),
            Statement::new("DELETE FROM app_role WHERE id = ?;", vec![json!(role_id)]),
            Statement::new(
                "INSERT INTO setting_gex_system (key, value) VALUES ('rbac_revision', strftime('%s','now')) ON CONFLICT(key) DO UPDATE SET value = strftime('%s','now');",
                vec![],
            ),
        ])
        .await?;

        Ok(json!({ "sukses": true }))
    }
}

fn extract_attendance_row_params(row: &Value, id_sesi: &str) -> Vec<Value> {
    let tanggal = row.get("tanggal").and_then(Value::as_str).unwrap_or("");
    let tahun = row
        .get("tahun")
        .and_then(|v| {
            v.as_i64()
                .or_else(|| v.as_str().and_then(|s| s.parse::<i64>().ok()))
        })
        .unwrap_or_else(|| {
            tanggal
                .split('-')
                .next()
                .and_then(|s| s.parse::<i64>().ok())
                .unwrap_or(2026)
        });
    let bulan = row
        .get("bulan")
        .and_then(Value::as_str)
        .map(|s| s.to_string())
        .unwrap_or_else(|| {
            let month_num = tanggal
                .split('-')
                .nth(1)
                .and_then(|s| s.parse::<usize>().ok())
                .unwrap_or(1);
            const MONTHS: [&str; 12] = [
                "Januari",
                "Februari",
                "Maret",
                "April",
                "Mei",
                "Juni",
                "Juli",
                "Agustus",
                "September",
                "Oktober",
                "November",
                "Desember",
            ];
            (*MONTHS
                .get(month_num.saturating_sub(1))
                .unwrap_or(&"Januari"))
            .to_string()
        });
    let status_absen = row
        .get("status_absen")
        .and_then(Value::as_str)
        .unwrap_or_else(|| {
            if row
                .get("jam_pulang")
                .and_then(Value::as_str)
                .map(|s| !s.is_empty())
                .unwrap_or(false)
            {
                "Pulang"
            } else {
                "Hadir"
            }
        });
    let sumber = row
        .get("sumber")
        .and_then(Value::as_str)
        .unwrap_or("Scanner");
    let update_terakhir = row
        .get("update_terakhir")
        .and_then(Value::as_str)
        .unwrap_or_else(|| {
            if !tanggal.is_empty() {
                tanggal
            } else {
                "2026-01-01 00:00:00"
            }
        });

    vec![
        // Nilai pertama mengisi kolom id_absensi lewat subquery pada klausa VALUES, sehingga
        // upsert yang berakhir sebagai UPDATE tidak menghabiskan counter AUTOINCREMENT.
        json!(id_sesi),
        json!(tanggal),
        json!(row.get("id_karyawan").and_then(Value::as_str).unwrap_or("")),
        json!(row.get("nama").and_then(Value::as_str).unwrap_or("")),
        json!(row
            .get("kelas_divisi")
            .and_then(Value::as_str)
            .unwrap_or("")),
        json!(row.get("jam_masuk").and_then(Value::as_str)),
        json!(row.get("jam_pulang").and_then(Value::as_str)),
        json!(row
            .get("status_kehadiran")
            .and_then(Value::as_str)
            .unwrap_or("Hadir")),
        json!(status_absen),
        json!(row.get("keterangan").and_then(Value::as_str)),
        json!(sumber),
        json!(update_terakhir),
        json!(row
            .get("menit_terlambat")
            .and_then(Value::as_i64)
            .unwrap_or(0)),
        json!(row
            .get("menit_datang_awal")
            .and_then(Value::as_i64)
            .unwrap_or(0)),
        json!(row
            .get("jam_kerja")
            .and_then(|v| v
                .as_i64()
                .or_else(|| v.as_str().and_then(|s| s.parse::<i64>().ok())))
            .unwrap_or(0)),
        json!(row
            .get("lembur")
            .and_then(|v| v
                .as_i64()
                .or_else(|| v.as_str().and_then(|s| s.parse::<i64>().ok())))
            .unwrap_or(0)),
        json!(row
            .get("jam_kerja_kurang")
            .and_then(|v| v
                .as_i64()
                .or_else(|| v.as_str().and_then(|s| s.parse::<i64>().ok())))
            .unwrap_or(0)),
        json!(row.get("id_shift").and_then(Value::as_i64).unwrap_or(1)),
        json!(bulan),
        json!(tahun),
        json!(id_sesi),
        json!(row
            .get("mode_tugas")
            .and_then(Value::as_str)
            .unwrap_or("NORMAL")),
        json!(row.get("id_backup").and_then(Value::as_str)),
        json!(row.get("id_karyawan_asal").and_then(Value::as_str)),
        json!(row.get("tanggal_tugas").and_then(Value::as_str)),
    ]
}

async fn insert_payroll_audit_log(
    turso: &StatementCollector,
    row: &Value,
) -> Result<(), CommandError> {
    let id = row.get("id").and_then(Value::as_str).unwrap_or("");
    let payroll_run_id = row
        .get("payroll_run_id")
        .and_then(Value::as_str)
        .unwrap_or("");
    if id.is_empty() || payroll_run_id.is_empty() {
        return Ok(());
    }
    turso
        .query_one(
            r#"
            INSERT INTO payroll_audit_logs (
                id, payroll_run_id, action, old_status, new_status, performed_by, notes, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO NOTHING;
            "#,
            vec![
                json!(id),
                json!(payroll_run_id),
                json!(row.get("action").and_then(Value::as_str).unwrap_or("")),
                json!(row.get("old_status").and_then(Value::as_str)),
                json!(row.get("new_status").and_then(Value::as_str).unwrap_or("")),
                json!(row.get("performed_by").and_then(Value::as_str).unwrap_or("")),
                json!(row.get("notes").and_then(Value::as_str)),
                json!(row.get("created_at").and_then(Value::as_str).unwrap_or("")),
            ],
        )
        .await?;
    Ok(())
}

async fn insert_log_if_missing(
    turso: &StatementCollector,
    row: &Value,
) -> Result<(), CommandError> {
    let timestamp_scan = row
        .get("timestamp_scan")
        .and_then(Value::as_str)
        .unwrap_or("");
    let id_karyawan = row.get("id_karyawan").and_then(Value::as_str).unwrap_or("");
    let jenis_scan = row.get("jenis_scan").and_then(Value::as_str).unwrap_or("");
    if timestamp_scan.is_empty() || id_karyawan.is_empty() || jenis_scan.is_empty() {
        return Err(CommandError::new(
            "TURSO_SYNC_PAYLOAD_INVALID",
            "Log scan wajib memiliki timestamp_scan, id_karyawan, dan jenis_scan.",
        ));
    }
    let id_referensi = row.get("id_referensi").and_then(Value::as_str);
    turso
        .query_one(
            r#"INSERT INTO log_scan (
                timestamp_scan, tanggal_kerja, jam_scan, id_karyawan, nama, divisi,
                jenis_scan, status_proses, sumber_data, catatan_sistem, keterangan,
                menit_terlambat, menit_datang_awal, id_referensi, kode_operator
            )
            SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
            WHERE NOT EXISTS (
                SELECT 1 FROM log_scan
                WHERE timestamp_scan = ? AND id_karyawan = ? AND jenis_scan = ?
                  AND COALESCE(id_referensi, '') = COALESCE(?, '')
            );"#,
            vec![
                json!(timestamp_scan),
                json!(row
                    .get("tanggal_kerja")
                    .and_then(Value::as_str)
                    .unwrap_or("")),
                json!(row.get("jam_scan").and_then(Value::as_str).unwrap_or("")),
                json!(id_karyawan),
                json!(row.get("nama").and_then(Value::as_str).unwrap_or("")),
                json!(row.get("divisi").and_then(Value::as_str).unwrap_or("")),
                json!(jenis_scan),
                json!(row
                    .get("status_proses")
                    .and_then(Value::as_str)
                    .unwrap_or("")),
                json!(row.get("sumber_data").and_then(Value::as_str).unwrap_or("")),
                json!(row.get("catatan_sistem").and_then(Value::as_str)),
                json!(row.get("keterangan").and_then(Value::as_str)),
                json!(row
                    .get("menit_terlambat")
                    .and_then(Value::as_i64)
                    .unwrap_or(0)),
                json!(row
                    .get("menit_datang_awal")
                    .and_then(Value::as_i64)
                    .unwrap_or(0)),
                json!(id_referensi),
                json!(row.get("kode_operator").and_then(Value::as_str)),
                json!(timestamp_scan),
                json!(id_karyawan),
                json!(jenis_scan),
                json!(id_referensi),
            ],
        )
        .await?;
    Ok(())
}

fn canonical_sync_route(domain: &str, operation: &str) -> Option<(&'static str, &'static str)> {
    let route = match (domain.trim(), operation.trim()) {
        ("employee", "create") => ("employee", "create"),
        ("employee", "update") => ("employee", "update"),
        ("employee", "status") => ("employee", "status"),
        ("employee", "token") => ("employee", "token"),
        ("id_card" | "idcard" | "id-card", "create" | "generate" | "update") => {
            ("id-card", "update")
        }
        ("shift", "create") => ("shift", "create"),
        ("shift", "update") => ("shift", "update"),
        ("shift", "delete") => ("shift", "delete"),
        ("holiday", "create") => ("holiday", "create"),
        ("holiday", "update") => ("holiday", "update"),
        ("holiday", "delete") => ("holiday", "delete"),
        ("attendance", "scan") => ("attendance", "scan"),
        ("attendance", "create") => ("attendance", "create"),
        ("attendance", "update") => ("attendance", "update"),
        ("attendance", "delete") => ("attendance", "delete"),
        ("scan-log" | "scan_log" | "log-scan" | "log_scan" | "scan", "create" | "submit") => {
            ("attendance", "scan")
        }
        ("scan-log" | "scan_log" | "log-scan" | "log_scan" | "scan", "delete") => {
            ("log-scan", "delete")
        }
        ("backup" | "backup_karyawan", "create" | "update") => ("backup", "create"),
        ("backup" | "backup_karyawan", "cancel") => ("backup", "cancel"),
        ("correction" | "koreksi_admin", "create" | "update") => ("correction", "create"),
        ("correction" | "koreksi_admin", "delete") => ("correction", "delete"),
        (
            "import_offline" | "import-offline" | "offline_import" | "offline-import",
            "create" | "submit" | "row" | "update" | "upsert",
        ) => ("offline-import", "row"),
        ("import_offline" | "import-offline" | "offline_import" | "offline-import", "delete") => {
            ("offline-import", "delete")
        }
        (
            "company_profile" | "company-profile" | "companyProfile",
            "create" | "update" | "upsert",
        ) => ("company-profile", "update"),
        (
            "id_card_template" | "id-card-template" | "idCardTemplate",
            "create" | "save" | "update" | "upsert",
        ) => ("id-card-template", "save"),
        (
            "setting" | "settings" | "setting_gex_system" | "setting-gex-system",
            "create" | "upsert",
        ) => ("setting", "upsert"),
        ("setting" | "settings" | "setting_gex_system" | "setting-gex-system", "update") => {
            ("setting", "update")
        }
        ("payroll", "salary-config") => ("payroll", "salary-config"),
        ("payroll", "overtime-rule") => ("payroll", "overtime-rule"),
        ("payroll", "payroll-component") => ("payroll", "payroll-component"),
        ("payroll", "tax-rule") => ("payroll", "tax-rule"),
        ("payroll", "bpjs-rule") => ("payroll", "bpjs-rule"),
        ("payroll", "delete") => ("payroll", "delete"),
        ("payroll", "create-run") => ("payroll", "create-run"),
        ("payroll", "transition-status") => ("payroll", "transition-status"),
        _ => return None,
    };
    sync::is_canonical_sync_route(route.0, route.1).then_some(route)
}

async fn apply_event_to_turso(
    turso: &StatementCollector,
    domain: &str,
    operation: &str,
    entity_key: &str,
    payload: &Value,
) -> Result<(), CommandError> {
    if !payload.is_object() {
        return Err(CommandError::new(
            "TURSO_SYNC_PAYLOAD_INVALID",
            "Payload event sinkronisasi harus berupa objek JSON.",
        ));
    }

    match (domain, operation) {
        ("employee", "create" | "update") => {
            let row = payload.get("employee").unwrap_or(payload);
            let id_unik = row
                .get("id_unik")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .unwrap_or(entity_key);
            let kode_karyawan = row
                .get("kode_karyawan")
                .and_then(Value::as_str)
                .unwrap_or("");
            let nama = row.get("nama").and_then(Value::as_str).unwrap_or("");
            let divisi = row.get("divisi").and_then(Value::as_str).unwrap_or("");
            if id_unik.is_empty()
                || kode_karyawan.is_empty()
                || nama.chars().count() < 2
                || divisi.is_empty()
            {
                return Err(CommandError::new(
                    "TURSO_SYNC_PAYLOAD_INVALID",
                    "Data karyawan pada event sinkronisasi belum lengkap.",
                ));
            }
            if operation == "update" {
                turso
                    .query_one(
                        r#"INSERT INTO master_data (
                            id_unik, kode_karyawan, nama, divisi, jabatan_status, no_hp,
                            lp, id_shift, status_aktif, catatan, status_backup
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'NORMAL')
                        ON CONFLICT(id_unik) DO UPDATE SET
                            kode_karyawan = excluded.kode_karyawan,
                            nama = excluded.nama,
                            divisi = excluded.divisi,
                            jabatan_status = excluded.jabatan_status,
                            no_hp = excluded.no_hp,
                            lp = excluded.lp,
                            id_shift = excluded.id_shift,
                            status_aktif = excluded.status_aktif,
                            catatan = excluded.catatan,
                            jenis_personil = ?,
                            tanggal_mulai_aktif = ?,
                            tanggal_selesai_aktif = ?;"#,
                        vec![
                            json!(id_unik),
                            json!(kode_karyawan),
                            json!(nama),
                            json!(divisi),
                            json!(row.get("jabatan_status").and_then(Value::as_str)),
                            json!(row.get("no_hp").and_then(Value::as_str)),
                            json!(row.get("lp").and_then(Value::as_str)),
                            json!(row.get("id_shift").and_then(Value::as_i64).unwrap_or(1)),
                            json!(row
                                .get("status_aktif")
                                .and_then(Value::as_str)
                                .unwrap_or("Aktif")),
                            json!(row.get("catatan").and_then(Value::as_str)),
                            json!(row.get("jenis_personil").and_then(Value::as_str).unwrap_or("Pegawai")),
                            json!(row.get("tanggal_mulai_aktif").and_then(Value::as_str)),
                            json!(row.get("tanggal_selesai_aktif").and_then(Value::as_str)),
                        ],
                    )
                    .await?;
                turso
                    .query_one(
                        "INSERT INTO id_card (id_unik, nama, divisi, idcard_status, tanggal_generate) SELECT ?, ?, ?, 'Belum', date('now') WHERE NOT EXISTS (SELECT 1 FROM id_card WHERE id_unik = ?);",
                        vec![json!(id_unik), json!(nama), json!(divisi), json!(id_unik)],
                    )
                    .await?;
                for (sql, args) in [
                    (
                        "UPDATE id_card SET nama = ?, divisi = ? WHERE id_unik = ?;",
                        vec![json!(nama), json!(divisi), json!(id_unik)],
                    ),
                    (
                        "UPDATE absensi_harian SET nama = ?, kelas_divisi = ? WHERE id_karyawan = ?;",
                        vec![json!(nama), json!(divisi), json!(id_unik)],
                    ),
                    (
                        "UPDATE log_scan SET nama = ?, divisi = ? WHERE id_karyawan = ?;",
                        vec![json!(nama), json!(divisi), json!(id_unik)],
                    ),
                    (
                        "UPDATE backup_karyawan SET nama_karyawan_pengganti = ?, divisi_pengganti = ? WHERE id_karyawan_pengganti = ?;",
                        vec![json!(nama), json!(divisi), json!(id_unik)],
                    ),
                    (
                        "UPDATE backup_karyawan SET nama_karyawan_asal = ?, divisi_asal = ? WHERE id_karyawan_asal = ?;",
                        vec![json!(nama), json!(divisi), json!(id_unik)],
                    ),
                    (
                        "UPDATE koreksi_admin SET nama = ?, divisi = ? WHERE id_karyawan = ?;",
                        vec![json!(nama), json!(divisi), json!(id_unik)],
                    ),
                ] {
                    turso.query_one(sql, args).await?;
                }
                return Ok(());
            }
            let token_opt = row.get("token_absensi").and_then(Value::as_str);
            let status_qr = row
                .get("status_qr")
                .and_then(Value::as_str)
                .unwrap_or_else(|| {
                    if token_opt.map(|t| !t.is_empty()).unwrap_or(false) {
                        "Generated"
                    } else {
                        "Belum"
                    }
                });
            if !id_unik.is_empty() {
                let sql = r#"
                    INSERT INTO master_data (
                        id_unik, kode_karyawan, nama, divisi, jabatan_status, no_hp, lp,
                        id_shift, status_aktif, tanggal_daftar, catatan, token_absensi,
                        qr_code, status_qr, jenis_personil, tanggal_mulai_aktif,
                        tanggal_selesai_aktif, status_backup
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(id_unik) DO UPDATE SET
                        kode_karyawan = excluded.kode_karyawan,
                        nama = excluded.nama,
                        divisi = excluded.divisi,
                        jabatan_status = excluded.jabatan_status,
                        no_hp = excluded.no_hp,
                        lp = excluded.lp,
                        id_shift = excluded.id_shift,
                        status_aktif = excluded.status_aktif,
                        tanggal_daftar = excluded.tanggal_daftar,
                        catatan = excluded.catatan,
                        token_absensi = excluded.token_absensi,
                        qr_code = excluded.qr_code,
                        status_qr = excluded.status_qr,
                        jenis_personil = excluded.jenis_personil,
                        tanggal_mulai_aktif = excluded.tanggal_mulai_aktif,
                        tanggal_selesai_aktif = excluded.tanggal_selesai_aktif,
                        status_backup = excluded.status_backup;
                "#;
                turso
                    .query_one(
                        sql,
                        vec![
                            json!(id_unik),
                            json!(kode_karyawan),
                            json!(nama),
                            json!(divisi),
                            json!(row.get("jabatan_status").and_then(Value::as_str)),
                            json!(row.get("no_hp").and_then(Value::as_str)),
                            json!(row.get("lp").and_then(Value::as_str)),
                            json!(row.get("id_shift").and_then(Value::as_i64).unwrap_or(1)),
                            json!(row
                                .get("status_aktif")
                                .and_then(Value::as_str)
                                .unwrap_or("Aktif")),
                            json!(row.get("tanggal_daftar").and_then(Value::as_str)),
                            json!(row.get("catatan").and_then(Value::as_str)),
                            json!(row.get("token_absensi").and_then(Value::as_str)),
                            json!(row.get("qr_code").and_then(Value::as_str)),
                            json!(status_qr),
                            json!(row.get("jenis_personil").and_then(Value::as_str)),
                            json!(row.get("tanggal_mulai_aktif").and_then(Value::as_str)),
                            json!(row.get("tanggal_selesai_aktif").and_then(Value::as_str)),
                            json!(row
                                .get("status_backup")
                                .and_then(Value::as_str)
                                .unwrap_or("NORMAL")),
                        ],
                    )
                    .await?;
                turso
                    .query_one(
                        "INSERT INTO id_card (id_unik, nama, divisi, idcard_status, tanggal_generate) SELECT ?, ?, ?, 'Belum', date('now') WHERE NOT EXISTS (SELECT 1 FROM id_card WHERE id_unik = ?);",
                        vec![json!(id_unik), json!(nama), json!(divisi), json!(id_unik)],
                    )
                    .await?;
            }
        }
        ("employee", "status") => {
            let id_unik = payload
                .get("id_unik")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .unwrap_or(entity_key);
            let status = payload
                .get("status_aktif")
                .and_then(Value::as_str)
                .unwrap_or("Aktif");
            if !matches!(status, "Aktif" | "Nonaktif") {
                return Err(CommandError::new(
                    "TURSO_SYNC_PAYLOAD_INVALID",
                    "Status karyawan pada event sinkronisasi tidak valid.",
                ));
            }
            if !id_unik.is_empty() {
                turso
                    .query_one(
                        "UPDATE master_data SET status_aktif = ? WHERE id_unik = ?;",
                        vec![json!(status), json!(id_unik)],
                    )
                    .await?;
            }
        }
        ("employee", "token") => {
            let id_unik = payload
                .get("id_unik")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .unwrap_or(entity_key);
            let token = payload
                .get("token_absensi")
                .and_then(Value::as_str)
                .unwrap_or("");
            let qr = payload.get("qr_code").and_then(Value::as_str).unwrap_or("");
            if !id_unik.is_empty() {
                turso.query_one(
                    "UPDATE master_data SET token_absensi = ?, qr_code = ?, status_qr = 'Generated' WHERE id_unik = ?;",
                    vec![json!(token), json!(qr), json!(id_unik)],
                ).await?;
            }
        }
        ("employee", "delete") => {
            let id_unik = payload.get("id_unik").and_then(Value::as_str).unwrap_or("");
            if !id_unik.is_empty() {
                turso
                    .query_one(
                        "DELETE FROM master_data WHERE id_unik = ?;",
                        vec![json!(id_unik)],
                    )
                    .await?;
            }
        }
        ("id_card" | "idcard" | "id-card", "create" | "update" | "generate") => {
            let row = payload.get("id_card").unwrap_or(payload);
            let id_unik = row
                .get("id_unik")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .unwrap_or(entity_key);
            if !id_unik.is_empty() {
                let sql = r#"
                    INSERT INTO id_card (
                        id_card_id, id_unik, nama, divisi, idcard_status, idcard_pdf_url,
                        idcard_last_generate, idcard_catatan, tanggal_generate, link_qr_png
                    ) VALUES ((SELECT id_card_id FROM id_card WHERE id_unik = ?), ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(id_card_id) DO UPDATE SET
                        nama = COALESCE(NULLIF(excluded.nama, ''), id_card.nama),
                        divisi = COALESCE(NULLIF(excluded.divisi, ''), id_card.divisi),
                        idcard_status = excluded.idcard_status,
                        idcard_pdf_url = excluded.idcard_pdf_url,
                        idcard_last_generate = excluded.idcard_last_generate,
                        idcard_catatan = excluded.idcard_catatan,
                        tanggal_generate = excluded.tanggal_generate,
                        link_qr_png = excluded.link_qr_png;
                "#;
                turso
                    .query_one(
                        sql,
                        vec![
                            json!(id_unik),
                            json!(id_unik),
                            json!(row.get("nama").and_then(Value::as_str).unwrap_or("")),
                            json!(row.get("divisi").and_then(Value::as_str).unwrap_or("")),
                            json!(row
                                .get("idcard_status")
                                .and_then(Value::as_str)
                                .unwrap_or("Belum Dicetak")),
                            json!(row.get("idcard_pdf_url").and_then(Value::as_str)),
                            json!(row.get("idcard_last_generate").and_then(Value::as_str)),
                            json!(row.get("idcard_catatan").and_then(Value::as_str)),
                            json!(row.get("tanggal_generate").and_then(Value::as_str)),
                            json!(row.get("link_qr_png").and_then(Value::as_str)),
                        ],
                    )
                    .await?;
            }
        }
        ("id_card" | "idcard" | "id-card", "delete") => {
            let id_unik = payload.get("id_unik").and_then(Value::as_str).unwrap_or("");
            if !id_unik.is_empty() {
                turso
                    .query_one(
                        "DELETE FROM id_card WHERE id_unik = ?;",
                        vec![json!(id_unik)],
                    )
                    .await?;
            }
        }
        ("shift", "create" | "update") => {
            let row = payload.get("shift").unwrap_or(payload);
            let kode_shift = row
                .get("kode_shift")
                .and_then(|v| {
                    v.as_i64()
                        .or_else(|| v.as_str().and_then(|s| s.parse::<i64>().ok()))
                })
                .or_else(|| {
                    entity_key
                        .strip_prefix("kode:")
                        .unwrap_or(entity_key)
                        .parse::<i64>()
                        .ok()
                })
                .or_else(|| row.get("id_shift").and_then(Value::as_i64))
                .unwrap_or(0);
            if kode_shift <= 0 {
                return Err(CommandError::new(
                    "TURSO_SYNC_PAYLOAD_INVALID",
                    "Kode shift tidak valid pada event sinkronisasi.",
                ));
            }
            let sql = r#"
                INSERT INTO tbl_shift (
                    id_shift, kode_shift, nama_shift, jam_masuk, jam_pulang, awal_absen_menit,
                    batas_masuk_menit, toleransi_masuk_menit, jam_kerja_normal_menit,
                    istirahat_menit, batas_pulang_menit, offset_istirahat_mulai,
                    offset_generate_alfa, buffer_shift_malam_menit, izinkan_multi_sesi
                ) VALUES ((SELECT id_shift FROM tbl_shift WHERE kode_shift = ?), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id_shift) DO UPDATE SET
                    nama_shift = excluded.nama_shift,
                    jam_masuk = excluded.jam_masuk,
                    jam_pulang = excluded.jam_pulang,
                    awal_absen_menit = excluded.awal_absen_menit,
                    batas_masuk_menit = excluded.batas_masuk_menit,
                    toleransi_masuk_menit = excluded.toleransi_masuk_menit,
                    jam_kerja_normal_menit = excluded.jam_kerja_normal_menit,
                    istirahat_menit = excluded.istirahat_menit,
                    batas_pulang_menit = excluded.batas_pulang_menit,
                    offset_istirahat_mulai = excluded.offset_istirahat_mulai,
                    offset_generate_alfa = excluded.offset_generate_alfa,
                    buffer_shift_malam_menit = excluded.buffer_shift_malam_menit,
                    izinkan_multi_sesi = excluded.izinkan_multi_sesi;
            "#;
            turso
                .query_one(
                    sql,
                    vec![
                        json!(kode_shift),
                        json!(kode_shift),
                        json!(row.get("nama_shift").and_then(Value::as_str).unwrap_or("")),
                        json!(row.get("jam_masuk").and_then(Value::as_str).unwrap_or("")),
                        json!(row.get("jam_pulang").and_then(Value::as_str).unwrap_or("")),
                        json!(row
                            .get("awal_absen_menit")
                            .and_then(Value::as_i64)
                            .unwrap_or(120)),
                        json!(row
                            .get("batas_masuk_menit")
                            .and_then(Value::as_i64)
                            .unwrap_or(60)),
                        json!(row
                            .get("toleransi_masuk_menit")
                            .and_then(Value::as_i64)
                            .unwrap_or(0)),
                        json!(row
                            .get("jam_kerja_normal_menit")
                            .and_then(Value::as_i64)
                            .unwrap_or(480)),
                        json!(row
                            .get("istirahat_menit")
                            .and_then(Value::as_i64)
                            .unwrap_or(60)),
                        json!(row
                            .get("batas_pulang_menit")
                            .and_then(Value::as_i64)
                            .unwrap_or(240)),
                        json!(row
                            .get("offset_istirahat_mulai")
                            .and_then(Value::as_i64)
                            .unwrap_or(240)),
                        json!(row
                            .get("offset_generate_alfa")
                            .and_then(Value::as_i64)
                            .unwrap_or(180)),
                        json!(row
                            .get("buffer_shift_malam_menit")
                            .and_then(Value::as_i64)
                            .unwrap_or(120)),
                        json!(row
                            .get("izinkan_multi_sesi")
                            .map(|v| if v.as_bool().unwrap_or(false) || v.as_i64().unwrap_or(0) == 1 { 1 } else { 0 })
                            .unwrap_or(0)),
                    ],
                )
                .await?;
        }
        ("shift", "delete") => {
            let shift_id = payload
                .get("id_shift")
                .and_then(Value::as_i64)
                .or_else(|| entity_key.parse::<i64>().ok());
            let shift_code = payload.get("kode_shift").and_then(Value::as_i64);
            if let Some(id) = shift_id {
                turso
                    .query_one("DELETE FROM tbl_shift WHERE id_shift = ?;", vec![json!(id)])
                    .await?;
            } else if let Some(code) = shift_code {
                turso
                    .query_one(
                        "DELETE FROM tbl_shift WHERE kode_shift = ?;",
                        vec![json!(code)],
                    )
                    .await?;
            }
        }
        ("holiday", "create" | "update") => {
            let row = payload.get("holiday").unwrap_or(payload);
            let tanggal = row.get("tanggal").and_then(Value::as_str).unwrap_or("");
            if !tanggal.is_empty() {
                let sql = r#"
                    INSERT INTO tbl_hari_libur (id_libur, tanggal, nama_libur, jenis_libur, keterangan, status_aktif)
                    VALUES ((SELECT id_libur FROM tbl_hari_libur WHERE tanggal = ?), ?, ?, ?, ?, ?)
                    ON CONFLICT(id_libur) DO UPDATE SET
                        nama_libur = excluded.nama_libur,
                        jenis_libur = excluded.jenis_libur,
                        keterangan = excluded.keterangan,
                        status_aktif = excluded.status_aktif;
                "#;
                turso
                    .query_one(
                        sql,
                        vec![
                            json!(tanggal),
                            json!(tanggal),
                            json!(row.get("nama_libur").and_then(Value::as_str).unwrap_or("")),
                            json!(row.get("jenis_libur").and_then(Value::as_str).unwrap_or("")),
                            json!(row.get("keterangan").and_then(Value::as_str)),
                            json!(row.get("status_aktif").and_then(Value::as_i64).unwrap_or(1)),
                        ],
                    )
                    .await?;
            }
        }
        ("holiday", "delete") => {
            let tanggal = payload
                .get("tanggal")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .unwrap_or(entity_key);
            if !tanggal.is_empty() {
                turso
                    .query_one(
                        "DELETE FROM tbl_hari_libur WHERE tanggal = ?;",
                        vec![json!(tanggal)],
                    )
                    .await?;
            }
        }
        ("attendance", "scan") => {
            // 1. Terapkan log_scan jika ada
            if let Some(log) = payload.get("log") {
                insert_log_if_missing(turso, log).await?;
            }

            // 2. Terapkan absensi_harian jika ada
            if let Some(att) = payload.get("attendance") {
                if !att.is_null() {
                    let id_sesi = att.get("id_sesi").and_then(Value::as_str).unwrap_or("");
                    if !id_sesi.is_empty() {
                        let att_sql = r#"
                            INSERT INTO absensi_harian (
                                id_absensi, tanggal, id_karyawan, nama, kelas_divisi, jam_masuk, jam_pulang,
                                status_kehadiran, status_absen, keterangan, sumber, update_terakhir,
                                menit_terlambat, menit_datang_awal, jam_kerja, lembur,
                                jam_kerja_kurang, id_shift, bulan, tahun, id_sesi, mode_tugas,
                                id_backup, id_karyawan_asal, tanggal_tugas
                            ) VALUES ((SELECT id_absensi FROM absensi_harian WHERE id_sesi = ?), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                            ON CONFLICT(id_absensi) DO UPDATE SET
                                tanggal = excluded.tanggal,
                                id_karyawan = excluded.id_karyawan,
                                nama = excluded.nama,
                                kelas_divisi = excluded.kelas_divisi,
                                jam_masuk = excluded.jam_masuk,
                                jam_pulang = excluded.jam_pulang,
                                status_kehadiran = excluded.status_kehadiran,
                                status_absen = excluded.status_absen,
                                keterangan = excluded.keterangan,
                                sumber = excluded.sumber,
                                update_terakhir = excluded.update_terakhir,
                                menit_terlambat = excluded.menit_terlambat,
                                menit_datang_awal = excluded.menit_datang_awal,
                                jam_kerja = excluded.jam_kerja,
                                lembur = excluded.lembur,
                                jam_kerja_kurang = excluded.jam_kerja_kurang,
                                id_shift = excluded.id_shift,
                                bulan = excluded.bulan,
                                tahun = excluded.tahun,
                                mode_tugas = excluded.mode_tugas,
                                id_backup = excluded.id_backup,
                                id_karyawan_asal = excluded.id_karyawan_asal,
                                tanggal_tugas = excluded.tanggal_tugas;
                        "#;
                        let params = extract_attendance_row_params(att, id_sesi);
                        turso.query_one(att_sql, params).await?;
                    }
                }
            }
        }
        ("attendance", "create" | "update") => {
            let row = payload.get("attendance").unwrap_or(payload);
            let id_sesi = row
                .get("id_sesi")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .unwrap_or(entity_key);
            if !id_sesi.is_empty() {
                let sql = r#"
                    INSERT INTO absensi_harian (
                        id_absensi, tanggal, id_karyawan, nama, kelas_divisi, jam_masuk, jam_pulang,
                        status_kehadiran, status_absen, keterangan, sumber, update_terakhir,
                        menit_terlambat, menit_datang_awal, jam_kerja, lembur,
                        jam_kerja_kurang, id_shift, bulan, tahun, id_sesi, mode_tugas,
                        id_backup, id_karyawan_asal, tanggal_tugas
                    ) VALUES ((SELECT id_absensi FROM absensi_harian WHERE id_sesi = ?), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(id_absensi) DO UPDATE SET
                        tanggal = COALESCE(NULLIF(excluded.tanggal, ''), absensi_harian.tanggal),
                        id_karyawan = COALESCE(NULLIF(excluded.id_karyawan, ''), absensi_harian.id_karyawan),
                        nama = COALESCE(NULLIF(excluded.nama, ''), absensi_harian.nama),
                        kelas_divisi = COALESCE(NULLIF(excluded.kelas_divisi, ''), absensi_harian.kelas_divisi),
                        jam_masuk = excluded.jam_masuk,
                        jam_pulang = excluded.jam_pulang,
                        status_kehadiran = excluded.status_kehadiran,
                        status_absen = excluded.status_absen,
                        keterangan = excluded.keterangan,
                        sumber = excluded.sumber,
                        update_terakhir = excluded.update_terakhir,
                        menit_terlambat = excluded.menit_terlambat,
                        menit_datang_awal = excluded.menit_datang_awal,
                        jam_kerja = excluded.jam_kerja,
                        lembur = excluded.lembur,
                        jam_kerja_kurang = excluded.jam_kerja_kurang,
                        id_shift = COALESCE(NULLIF(excluded.id_shift, 0), absensi_harian.id_shift),
                        bulan = COALESCE(NULLIF(excluded.bulan, ''), absensi_harian.bulan),
                        tahun = COALESCE(NULLIF(excluded.tahun, ''), absensi_harian.tahun),
                        mode_tugas = COALESCE(NULLIF(excluded.mode_tugas, ''), absensi_harian.mode_tugas),
                        id_backup = excluded.id_backup,
                        id_karyawan_asal = excluded.id_karyawan_asal,
                        tanggal_tugas = excluded.tanggal_tugas;
                "#;
                let params = extract_attendance_row_params(row, id_sesi);
                turso.query_one(sql, params).await?;
            }
        }
        ("attendance", "delete") => {
            let id_sesi = payload
                .get("id_sesi")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .unwrap_or(entity_key);
            if !id_sesi.is_empty() {
                turso
                    .query_one(
                        "DELETE FROM absensi_harian WHERE id_sesi = ?;",
                        vec![json!(id_sesi)],
                    )
                    .await?;
            }
        }
        ("scan-log" | "scan_log" | "log-scan" | "log_scan" | "scan", "create" | "submit") => {
            let row = payload.get("log").unwrap_or(payload);
            insert_log_if_missing(turso, row).await?;
        }
        ("scan-log" | "scan_log" | "log-scan" | "log_scan" | "scan", "delete") => {
            let id_log = payload
                .get("id_log")
                .and_then(Value::as_i64)
                .or_else(|| entity_key.parse::<i64>().ok());
            if let Some(id) = id_log {
                turso
                    .query_one("DELETE FROM log_scan WHERE id_log = ?;", vec![json!(id)])
                    .await?;
            }
        }
        ("backup" | "backup_karyawan", "create" | "update") => {
            let row = payload.get("backup").unwrap_or(payload);
            let id_backup = row.get("id_backup").and_then(Value::as_str).unwrap_or("");
            if !id_backup.is_empty() {
                let sql = r#"
                    INSERT INTO backup_karyawan (
                        id_backup, tanggal_tugas, id_karyawan_asal, nama_karyawan_asal,
                        divisi_asal, id_shift_asal, id_karyawan_pengganti, nama_karyawan_pengganti,
                        divisi_pengganti, id_shift_normal_pengganti, id_shift_backup,
                        alasan_backup, status_tugas, kode_operator, waktu_input,
                        catatan, waktu_dibatalkan, operator_pembatalan
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(id_backup) DO UPDATE SET
                        tanggal_tugas = excluded.tanggal_tugas,
                        status_tugas = excluded.status_tugas,
                        catatan = excluded.catatan,
                        waktu_dibatalkan = excluded.waktu_dibatalkan,
                        operator_pembatalan = excluded.operator_pembatalan;
                "#;
                turso
                    .query_one(
                        sql,
                        vec![
                            json!(id_backup),
                            json!(row
                                .get("tanggal_tugas")
                                .and_then(Value::as_str)
                                .unwrap_or("")),
                            json!(row
                                .get("id_karyawan_asal")
                                .and_then(Value::as_str)
                                .unwrap_or("")),
                            json!(row
                                .get("nama_karyawan_asal")
                                .and_then(Value::as_str)
                                .unwrap_or("")),
                            json!(row.get("divisi_asal").and_then(Value::as_str).unwrap_or("")),
                            json!(row
                                .get("id_shift_asal")
                                .and_then(Value::as_i64)
                                .unwrap_or(1)),
                            json!(row
                                .get("id_karyawan_pengganti")
                                .and_then(Value::as_str)
                                .unwrap_or("")),
                            json!(row
                                .get("nama_karyawan_pengganti")
                                .and_then(Value::as_str)
                                .unwrap_or("")),
                            json!(row
                                .get("divisi_pengganti")
                                .and_then(Value::as_str)
                                .unwrap_or("")),
                            json!(row
                                .get("id_shift_normal_pengganti")
                                .and_then(Value::as_i64)
                                .unwrap_or(1)),
                            json!(row
                                .get("id_shift_backup")
                                .and_then(Value::as_i64)
                                .unwrap_or(1)),
                            json!(row.get("alasan_backup").and_then(Value::as_str)),
                            json!(row
                                .get("status_tugas")
                                .and_then(Value::as_str)
                                .unwrap_or("Aktif")),
                            json!(row
                                .get("kode_operator")
                                .and_then(Value::as_str)
                                .unwrap_or("")),
                            json!(row.get("waktu_input").and_then(Value::as_str).unwrap_or("")),
                            json!(row.get("catatan").and_then(Value::as_str)),
                            json!(row.get("waktu_dibatalkan").and_then(Value::as_str)),
                            json!(row.get("operator_pembatalan").and_then(Value::as_str)),
                        ],
                    )
                    .await?;
            }
        }
        ("backup" | "backup_karyawan", "cancel") => {
            let id_backup = payload
                .get("id_backup")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .unwrap_or(entity_key);
            let waktu_dibatalkan = payload
                .get("waktu_dibatalkan")
                .and_then(Value::as_str)
                .unwrap_or("");
            let operator_pembatalan = payload
                .get("operator_pembatalan")
                .and_then(Value::as_str)
                .unwrap_or("");
            if !id_backup.is_empty() {
                turso.query_one(
                    "UPDATE backup_karyawan SET status_tugas = 'Dibatalkan', waktu_dibatalkan = ?, operator_pembatalan = ? WHERE id_backup = ?;",
                    vec![json!(waktu_dibatalkan), json!(operator_pembatalan), json!(id_backup)],
                ).await?;
            }
        }
        ("backup" | "backup_karyawan", "delete") => {
            let id_backup = payload
                .get("id_backup")
                .and_then(Value::as_str)
                .unwrap_or("");
            if !id_backup.is_empty() {
                turso
                    .query_one(
                        "DELETE FROM backup_karyawan WHERE id_backup = ?;",
                        vec![json!(id_backup)],
                    )
                    .await?;
            }
        }
        ("correction" | "koreksi_admin", "create" | "update") => {
            let row = payload.get("correction").unwrap_or(payload);
            let id_referensi = row
                .get("id_referensi")
                .and_then(Value::as_str)
                .unwrap_or("");
            if !id_referensi.is_empty() {
                let sql = r#"
                    INSERT INTO koreksi_admin (
                        id_koreksi, id_referensi, tanggal, id_karyawan, nama, divisi, jenis_koreksi,
                        jam_koreksi, keterangan_admin, status_proses, timestamp, kode_operator
                    ) VALUES ((SELECT id_koreksi FROM koreksi_admin WHERE id_referensi = ?), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(id_koreksi) DO UPDATE SET
                        tanggal = excluded.tanggal,
                        jenis_koreksi = excluded.jenis_koreksi,
                        jam_koreksi = excluded.jam_koreksi,
                        keterangan_admin = excluded.keterangan_admin,
                        status_proses = excluded.status_proses,
                        timestamp = excluded.timestamp,
                        kode_operator = excluded.kode_operator;
                "#;
                turso
                    .query_one(
                        sql,
                        vec![
                            json!(id_referensi),
                            json!(id_referensi),
                            json!(row.get("tanggal").and_then(Value::as_str).unwrap_or("")),
                            json!(row.get("id_karyawan").and_then(Value::as_str).unwrap_or("")),
                            json!(row.get("nama").and_then(Value::as_str).unwrap_or("")),
                            json!(row.get("divisi").and_then(Value::as_str).unwrap_or("")),
                            json!(row
                                .get("jenis_koreksi")
                                .and_then(Value::as_str)
                                .unwrap_or("")),
                            json!(row.get("jam_koreksi").and_then(Value::as_str)),
                            json!(row.get("keterangan_admin").and_then(Value::as_str)),
                            json!(row
                                .get("status_proses")
                                .and_then(Value::as_str)
                                .unwrap_or("Sudah Diproses")),
                            json!(row.get("timestamp").and_then(Value::as_str).unwrap_or("")),
                            json!(row
                                .get("kode_operator")
                                .and_then(Value::as_str)
                                .unwrap_or("")),
                        ],
                    )
                    .await?;
            }

            // Terapkan absensi_harian jika disertakan dalam event koreksi
            if let Some(att) = payload.get("attendance") {
                if !att.is_null() {
                    let id_sesi = att.get("id_sesi").and_then(Value::as_str).unwrap_or("");
                    if !id_sesi.is_empty() {
                        let att_sql = r#"
                            INSERT INTO absensi_harian (
                                id_absensi, tanggal, id_karyawan, nama, kelas_divisi, jam_masuk, jam_pulang,
                                status_kehadiran, status_absen, keterangan, sumber, update_terakhir,
                                menit_terlambat, menit_datang_awal, jam_kerja, lembur,
                                jam_kerja_kurang, id_shift, bulan, tahun, id_sesi, mode_tugas,
                                id_backup, id_karyawan_asal, tanggal_tugas
                            ) VALUES ((SELECT id_absensi FROM absensi_harian WHERE id_sesi = ?), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                            ON CONFLICT(id_absensi) DO UPDATE SET
                                tanggal = excluded.tanggal,
                                id_karyawan = excluded.id_karyawan,
                                nama = excluded.nama,
                                kelas_divisi = excluded.kelas_divisi,
                                jam_masuk = excluded.jam_masuk,
                                jam_pulang = excluded.jam_pulang,
                                status_kehadiran = excluded.status_kehadiran,
                                status_absen = excluded.status_absen,
                                keterangan = excluded.keterangan,
                                sumber = excluded.sumber,
                                update_terakhir = excluded.update_terakhir,
                                menit_terlambat = excluded.menit_terlambat,
                                menit_datang_awal = excluded.menit_datang_awal,
                                jam_kerja = excluded.jam_kerja,
                                lembur = excluded.lembur,
                                jam_kerja_kurang = excluded.jam_kerja_kurang,
                                id_shift = excluded.id_shift,
                                bulan = excluded.bulan,
                                tahun = excluded.tahun,
                                mode_tugas = excluded.mode_tugas,
                                id_backup = excluded.id_backup,
                                id_karyawan_asal = excluded.id_karyawan_asal,
                                tanggal_tugas = excluded.tanggal_tugas;
                        "#;
                        let params = extract_attendance_row_params(att, id_sesi);
                        turso.query_one(att_sql, params).await?;
                    }
                }
            }

            // Terapkan log_scan jika disertakan dalam koreksi
            if let Some(log) = payload.get("log") {
                if !log.is_null() {
                    insert_log_if_missing(turso, log).await?;
                }
            }
        }
        ("correction" | "koreksi_admin", "delete") => {
            let id_referensi = payload
                .get("id_referensi")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .unwrap_or(entity_key);
            if !id_referensi.is_empty() {
                turso
                    .query_one(
                        "DELETE FROM koreksi_admin WHERE id_referensi = ?;",
                        vec![json!(id_referensi)],
                    )
                    .await?;
                turso
                    .query_one(
                        "DELETE FROM log_scan WHERE id_referensi = ?;",
                        vec![json!(id_referensi)],
                    )
                    .await?;
            }
        }
        (
            "import_offline" | "import-offline" | "offline_import" | "offline-import",
            "create" | "submit" | "row" | "update" | "upsert",
        ) => {
            let row = payload.get("import").unwrap_or(payload);
            let event_key = row.get("event_key").and_then(Value::as_str).unwrap_or("");
            if !event_key.is_empty() {
                let id_unik = row
                    .get("id_unik")
                    .or_else(|| row.get("id_karyawan"))
                    .and_then(Value::as_str)
                    .unwrap_or("");
                let sql = r#"
                    INSERT INTO import_offline (
                        id_import, event_key, timestamp_input, tanggal, id_unik, nama, divisi,
                        jam_masuk, jam_pulang, status_kehadiran, status_absen,
                        keterangan, status_proses, diproses_pada, pesan_error, kode_operator
                    ) VALUES ((SELECT id_import FROM import_offline WHERE event_key = ?), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Sudah Diproses', datetime('now'), '', ?)
                    ON CONFLICT(id_import) DO UPDATE SET
                        timestamp_input = COALESCE(NULLIF(excluded.timestamp_input, ''), import_offline.timestamp_input),
                        tanggal = excluded.tanggal,
                        id_unik = excluded.id_unik,
                        nama = excluded.nama,
                        divisi = excluded.divisi,
                        jam_masuk = excluded.jam_masuk,
                        jam_pulang = excluded.jam_pulang,
                        status_kehadiran = excluded.status_kehadiran,
                        status_absen = excluded.status_absen,
                        keterangan = excluded.keterangan,
                        status_proses = excluded.status_proses,
                        diproses_pada = excluded.diproses_pada,
                        pesan_error = excluded.pesan_error,
                        kode_operator = excluded.kode_operator;
                "#;
                turso
                    .query_one(
                        sql,
                        vec![
                            json!(event_key),
                            json!(event_key),
                            json!(row
                                .get("timestamp_input")
                                .and_then(Value::as_str)
                                .unwrap_or("")),
                            json!(row.get("tanggal").and_then(Value::as_str).unwrap_or("")),
                            json!(id_unik),
                            json!(row.get("nama").and_then(Value::as_str)),
                            json!(row.get("divisi").and_then(Value::as_str)),
                            json!(row.get("jam_masuk").and_then(Value::as_str)),
                            json!(row.get("jam_pulang").and_then(Value::as_str)),
                            json!(row.get("status_kehadiran").and_then(Value::as_str)),
                            json!(row.get("status_absen").and_then(Value::as_str)),
                            json!(row.get("keterangan").and_then(Value::as_str)),
                            json!(row.get("kode_operator").and_then(Value::as_str)),
                        ],
                    )
                    .await?;
            }

            // Terapkan absensi_harian jika disertakan dalam event import offline
            if let Some(att) = payload.get("attendance") {
                if !att.is_null() {
                    let id_sesi = att.get("id_sesi").and_then(Value::as_str).unwrap_or("");
                    if !id_sesi.is_empty() {
                        let att_sql = r#"
                            INSERT INTO absensi_harian (
                                id_absensi, tanggal, id_karyawan, nama, kelas_divisi, jam_masuk, jam_pulang,
                                status_kehadiran, status_absen, keterangan, sumber, update_terakhir,
                                menit_terlambat, menit_datang_awal, jam_kerja, lembur,
                                jam_kerja_kurang, id_shift, bulan, tahun, id_sesi, mode_tugas,
                                id_backup, id_karyawan_asal, tanggal_tugas
                            ) VALUES ((SELECT id_absensi FROM absensi_harian WHERE id_sesi = ?), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                            ON CONFLICT(id_absensi) DO UPDATE SET
                                tanggal = excluded.tanggal,
                                id_karyawan = excluded.id_karyawan,
                                nama = excluded.nama,
                                kelas_divisi = excluded.kelas_divisi,
                                jam_masuk = excluded.jam_masuk,
                                jam_pulang = excluded.jam_pulang,
                                status_kehadiran = excluded.status_kehadiran,
                                status_absen = excluded.status_absen,
                                keterangan = excluded.keterangan,
                                sumber = excluded.sumber,
                                update_terakhir = excluded.update_terakhir,
                                menit_terlambat = excluded.menit_terlambat,
                                menit_datang_awal = excluded.menit_datang_awal,
                                jam_kerja = excluded.jam_kerja,
                                lembur = excluded.lembur,
                                jam_kerja_kurang = excluded.jam_kerja_kurang,
                                id_shift = excluded.id_shift,
                                bulan = excluded.bulan,
                                tahun = excluded.tahun,
                                mode_tugas = excluded.mode_tugas,
                                id_backup = excluded.id_backup,
                                id_karyawan_asal = excluded.id_karyawan_asal,
                                tanggal_tugas = excluded.tanggal_tugas;
                        "#;
                        let params = extract_attendance_row_params(att, id_sesi);
                        turso.query_one(att_sql, params).await?;
                    }
                }
            }

            // Terapkan logs jika disertakan dalam event import offline
            if let Some(logs) = payload.get("logs").and_then(Value::as_array) {
                for log in logs {
                    insert_log_if_missing(turso, log).await?;
                }
            }
        }
        ("import_offline" | "import-offline" | "offline_import" | "offline-import", "delete") => {
            let event_key = payload
                .get("event_key")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .unwrap_or(entity_key);
            if !event_key.is_empty() {
                turso
                    .query_one(
                        "DELETE FROM import_offline WHERE event_key = ?;",
                        vec![json!(event_key)],
                    )
                    .await?;
                turso
                    .query_one(
                        "DELETE FROM log_scan WHERE id_referensi = ?;",
                        vec![json!(event_key)],
                    )
                    .await?;
            }
        }
        (
            "company_profile" | "company-profile" | "companyProfile",
            "create" | "update" | "upsert",
        ) => {
            let row = payload.get("company_profile").unwrap_or(payload);
            let id = row
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or("default_company");
            let sql = r#"
                INSERT INTO company_profile (
                    id, company_name, branch_name, logo_url, signature_url, address,
                    phone, email, website, leader_name, leader_title, leader_nip,
                    card_terms, timezone, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
                ON CONFLICT(id) DO UPDATE SET
                    company_name = excluded.company_name,
                    branch_name = excluded.branch_name,
                    logo_url = excluded.logo_url,
                    signature_url = excluded.signature_url,
                    address = excluded.address,
                    phone = excluded.phone,
                    email = excluded.email,
                    website = excluded.website,
                    leader_name = excluded.leader_name,
                    leader_title = excluded.leader_title,
                    leader_nip = excluded.leader_nip,
                    card_terms = excluded.card_terms,
                    timezone = excluded.timezone,
                    updated_at = datetime('now');
            "#;
            turso
                .query_one(
                    sql,
                    vec![
                        json!(id),
                        json!(row
                            .get("company_name")
                            .and_then(Value::as_str)
                            .unwrap_or("SPPG")),
                        json!(row.get("branch_name").and_then(Value::as_str)),
                        json!(row.get("logo_url").and_then(Value::as_str)),
                        json!(row.get("signature_url").and_then(Value::as_str)),
                        json!(row.get("address").and_then(Value::as_str)),
                        json!(row.get("phone").and_then(Value::as_str)),
                        json!(row.get("email").and_then(Value::as_str)),
                        json!(row.get("website").and_then(Value::as_str)),
                        json!(row.get("leader_name").and_then(Value::as_str)),
                        json!(row.get("leader_title").and_then(Value::as_str)),
                        json!(row.get("leader_nip").and_then(Value::as_str)),
                        json!(row.get("card_terms").and_then(Value::as_str)),
                        json!(row
                            .get("timezone")
                            .and_then(Value::as_str)
                            .unwrap_or("Asia/Jakarta")),
                    ],
                )
                .await?;
        }
        (
            "id_card_template" | "id-card-template" | "idCardTemplate",
            "create" | "save" | "update" | "upsert",
        ) => {
            let row = payload.get("id_card_template").unwrap_or(payload);
            let id = row
                .get("id")
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty())
                .unwrap_or(entity_key);
            let id = if id.is_empty() { "default_template" } else { id };
            let elements_raw = row.get("elements_json").or_else(|| row.get("elements"));
            let mut current = match elements_raw {
                Some(Value::String(text)) => {
                    if let Ok(parsed) = serde_json::from_str::<Value>(text) {
                        parsed
                    } else {
                        Value::String(text.clone())
                    }
                }
                Some(val) => val.clone(),
                None => json!([]),
            };
            while let Value::String(ref s) = current {
                if let Ok(parsed) = serde_json::from_str::<Value>(s) {
                    current = parsed;
                } else {
                    break;
                }
            }
            let elements_json = if current.is_array() || current.is_object() {
                serde_json::to_string(&current).unwrap_or_else(|_| "[]".to_owned())
            } else if let Value::String(s) = current {
                if s.trim().is_empty() {
                    "[]".to_owned()
                } else {
                    s
                }
            } else {
                "[]".to_owned()
            };
            let front_bg = row
                .get("front_bg_url")
                .or_else(|| row.get("frontBgUrl"))
                .and_then(Value::as_str)
                .filter(|s| !s.trim().is_empty());
            let back_bg = row
                .get("back_bg_url")
                .or_else(|| row.get("backBgUrl"))
                .and_then(Value::as_str)
                .filter(|s| !s.trim().is_empty());
            let is_active = row
                .get("is_active")
                .or_else(|| row.get("isActive"))
                .map(|v| {
                    if v.as_bool().unwrap_or(false)
                        || v.as_i64().unwrap_or(0) == 1
                        || v.as_str().map(|s| s == "1" || s.eq_ignore_ascii_case("true")).unwrap_or(false)
                    {
                        1
                    } else {
                        0
                    }
                })
                .unwrap_or(1);
            let sql = r#"
                INSERT INTO id_card_template (
                    id, name, orientation, front_bg_url, back_bg_url, elements_json,
                    is_active, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
                ON CONFLICT(id) DO UPDATE SET
                    name = excluded.name,
                    orientation = excluded.orientation,
                    front_bg_url = excluded.front_bg_url,
                    back_bg_url = excluded.back_bg_url,
                    elements_json = excluded.elements_json,
                    is_active = excluded.is_active,
                    updated_at = datetime('now');
            "#;
            turso
                .query_one(
                    sql,
                    vec![
                        json!(id),
                        json!(row
                            .get("name")
                            .and_then(Value::as_str)
                            .unwrap_or("Template Default SPPG")),
                        json!(row
                            .get("orientation")
                            .and_then(Value::as_str)
                            .unwrap_or("landscape")),
                        json!(front_bg),
                        json!(back_bg),
                        json!(elements_json),
                        json!(is_active),
                    ],
                )
                .await?;
        }
        (
            "setting" | "settings" | "setting_gex_system" | "setting-gex-system",
            "create" | "update" | "upsert",
        ) => {
            let row = payload.get("setting").unwrap_or(payload);
            let key = row.get("key").and_then(Value::as_str).unwrap_or("");
            let value = row
                .get("value")
                .map(|value| match value {
                    Value::String(text) => text.clone(),
                    other => other.to_string(),
                })
                .unwrap_or_default();
            if !key.is_empty() {
                let sql = "INSERT INTO setting_gex_system (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value;";
                turso.query_one(sql, vec![json!(key), json!(value)]).await?;
            }
        }
        ("payroll", "salary-config") => {
            let row = payload.get("salaryConfig").unwrap_or(payload);
            let id = row.get("id").and_then(Value::as_str).unwrap_or("");
            if !id.is_empty() {
                let sql = r#"
                    INSERT INTO salary_configs (
                        id, id_karyawan, rate_per_hour, ptkp_status, effective_date, created_by, created_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(id_karyawan, effective_date) DO UPDATE SET
                        rate_per_hour = excluded.rate_per_hour,
                        ptkp_status = excluded.ptkp_status,
                        created_by = excluded.created_by;
                "#;
                turso
                    .query_one(
                        sql,
                        vec![
                            json!(id),
                            json!(row.get("id_karyawan").and_then(Value::as_str).unwrap_or("")),
                            json!(row.get("rate_per_hour").and_then(Value::as_i64).unwrap_or(0)),
                            json!(row
                                .get("ptkp_status")
                                .and_then(Value::as_str)
                                .unwrap_or("TK/0")),
                            json!(row
                                .get("effective_date")
                                .and_then(Value::as_str)
                                .unwrap_or("")),
                            json!(row.get("created_by").and_then(Value::as_str).unwrap_or("")),
                            json!(row.get("created_at").and_then(Value::as_str).unwrap_or("")),
                        ],
                    )
                    .await?;
            }
        }
        ("payroll", "overtime-rule") => {
            let row = payload.get("overtimeRule").unwrap_or(payload);
            let id = row.get("id").and_then(Value::as_str).unwrap_or("");
            if !id.is_empty() {
                let sql = r#"
                    INSERT INTO overtime_tier_rules (
                        id, rule_type, tier_order, hour_start, hour_end, multiplier, is_active
                    ) VALUES (?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(rule_type, tier_order) DO UPDATE SET
                        hour_start = excluded.hour_start,
                        hour_end = excluded.hour_end,
                        multiplier = excluded.multiplier,
                        is_active = excluded.is_active;
                "#;
                turso
                    .query_one(
                        sql,
                        vec![
                            json!(id),
                            json!(row.get("rule_type").and_then(Value::as_str).unwrap_or("")),
                            json!(row.get("tier_order").and_then(Value::as_i64).unwrap_or(0)),
                            json!(row.get("hour_start").and_then(Value::as_f64).unwrap_or(0.0)),
                            json!(row.get("hour_end").and_then(Value::as_f64)),
                            json!(row.get("multiplier").and_then(Value::as_f64).unwrap_or(1.0)),
                            json!(row.get("is_active").and_then(Value::as_i64).unwrap_or(1)),
                        ],
                    )
                    .await?;
            }
        }
        ("payroll", "payroll-component") => {
            let row = payload.get("component").unwrap_or(payload);
            let id = row.get("id").and_then(Value::as_str).unwrap_or("");
            if !id.is_empty() {
                let sql = r#"
                    INSERT INTO payroll_components (
                        id, name, category, calc_type, default_value, applies_to, is_active
                    ) VALUES (?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(id) DO UPDATE SET
                        name = excluded.name,
                        category = excluded.category,
                        calc_type = excluded.calc_type,
                        default_value = excluded.default_value,
                        applies_to = excluded.applies_to,
                        is_active = excluded.is_active;
                "#;
                turso
                    .query_one(
                        sql,
                        vec![
                            json!(id),
                            json!(row.get("name").and_then(Value::as_str).unwrap_or("")),
                            json!(row.get("category").and_then(Value::as_str).unwrap_or("")),
                            json!(row.get("calc_type").and_then(Value::as_str).unwrap_or("")),
                            json!(row
                                .get("default_value")
                                .and_then(Value::as_f64)
                                .unwrap_or(0.0)),
                            json!(row
                                .get("applies_to")
                                .and_then(Value::as_str)
                                .unwrap_or("ALL")),
                            json!(row.get("is_active").and_then(Value::as_i64).unwrap_or(1)),
                        ],
                    )
                    .await?;
            }
        }
        ("payroll", "tax-rule") => {
            let row = payload.get("taxRule").unwrap_or(payload);
            let id = row.get("id").and_then(Value::as_str).unwrap_or("");
            if !id.is_empty() {
                let sql = r#"
                    INSERT INTO tax_rules (
                        id, category, bracket_min, bracket_max, rate_percentage, effective_date
                    ) VALUES (?, ?, ?, ?, ?, ?)
                    ON CONFLICT(id) DO UPDATE SET
                        category = excluded.category,
                        bracket_min = excluded.bracket_min,
                        bracket_max = excluded.bracket_max,
                        rate_percentage = excluded.rate_percentage,
                        effective_date = excluded.effective_date;
                "#;
                turso
                    .query_one(
                        sql,
                        vec![
                            json!(id),
                            json!(row.get("category").and_then(Value::as_str).unwrap_or("")),
                            json!(row.get("bracket_min").and_then(Value::as_i64).unwrap_or(0)),
                            json!(row.get("bracket_max").and_then(Value::as_i64)),
                            json!(row
                                .get("rate_percentage")
                                .and_then(Value::as_f64)
                                .unwrap_or(0.0)),
                            json!(row
                                .get("effective_date")
                                .and_then(Value::as_str)
                                .unwrap_or("")),
                        ],
                    )
                    .await?;
            }
        }
        ("payroll", "bpjs-rule") => {
            let row = payload.get("bpjsRule").unwrap_or(payload);
            let id = row.get("id").and_then(Value::as_str).unwrap_or("");
            if !id.is_empty() {
                let sql = r#"
                    INSERT INTO bpjs_rules (
                        id, component_code, component_name, rate_percentage, wage_cap, effective_date
                    ) VALUES (?, ?, ?, ?, ?, ?)
                    ON CONFLICT(component_code) DO UPDATE SET
                        component_name = excluded.component_name,
                        rate_percentage = excluded.rate_percentage,
                        wage_cap = excluded.wage_cap,
                        effective_date = excluded.effective_date;
                "#;
                turso
                    .query_one(
                        sql,
                        vec![
                            json!(id),
                            json!(row
                                .get("component_code")
                                .and_then(Value::as_str)
                                .unwrap_or("")),
                            json!(row
                                .get("component_name")
                                .and_then(Value::as_str)
                                .unwrap_or("")),
                            json!(row
                                .get("rate_percentage")
                                .and_then(Value::as_f64)
                                .unwrap_or(0.0)),
                            json!(row.get("wage_cap").and_then(Value::as_i64)),
                            json!(row
                                .get("effective_date")
                                .and_then(Value::as_str)
                                .unwrap_or("")),
                        ],
                    )
                    .await?;
            }
        }
        ("payroll", "delete") => {
            const DELETABLE_TABLES: &[&str] = &[
                "salary_configs",
                "overtime_tier_rules",
                "payroll_components",
                "tax_rules",
                "bpjs_rules",
            ];
            let table = payload.get("table").and_then(Value::as_str).unwrap_or("");
            let id = payload.get("id").and_then(Value::as_str).unwrap_or("");
            if !id.is_empty() && DELETABLE_TABLES.contains(&table) {
                let sql = format!("DELETE FROM {table} WHERE id = ?;");
                turso.query_one(&sql, vec![json!(id)]).await?;
            }
        }
        ("payroll", "create-run") => {
            let run = payload.get("run").unwrap_or(payload);
            let run_id = run.get("id").and_then(Value::as_str).unwrap_or("");
            if run_id.is_empty() {
                return Ok(());
            }
            let run_sql = r#"
                INSERT INTO payroll_runs (
                    id, idempotency_key, period_start, period_end, status,
                    total_gross_payout, total_net_payout, total_employees,
                    created_by, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO NOTHING;
            "#;
            turso
                .query_one(
                    run_sql,
                    vec![
                        json!(run_id),
                        json!(run
                            .get("idempotency_key")
                            .and_then(Value::as_str)
                            .unwrap_or("")),
                        json!(run.get("period_start").and_then(Value::as_str).unwrap_or("")),
                        json!(run.get("period_end").and_then(Value::as_str).unwrap_or("")),
                        json!(run.get("status").and_then(Value::as_str).unwrap_or("DRAFT")),
                        json!(run
                            .get("total_gross_payout")
                            .and_then(Value::as_i64)
                            .unwrap_or(0)),
                        json!(run
                            .get("total_net_payout")
                            .and_then(Value::as_i64)
                            .unwrap_or(0)),
                        json!(run
                            .get("total_employees")
                            .and_then(Value::as_i64)
                            .unwrap_or(0)),
                        json!(run.get("created_by").and_then(Value::as_str).unwrap_or("")),
                        json!(run.get("created_at").and_then(Value::as_str).unwrap_or("")),
                        json!(run.get("updated_at").and_then(Value::as_str).unwrap_or("")),
                    ],
                )
                .await?;

            if let Some(items) = payload.get("items").and_then(Value::as_array) {
                let item_sql = r#"
                    INSERT INTO payroll_items (
                        id, payroll_run_id, id_karyawan, nama_karyawan, divisi, ptkp_status,
                        total_regular_hours, total_overtime_hours, total_overtime_index,
                        rate_per_hour, basic_salary, overtime_salary, gross_salary,
                        total_allowances, total_deductions, bpjs_employee_total, bpjs_company_total,
                        pph21_amount, net_salary, breakdown_snapshot, created_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(id) DO NOTHING;
                "#;
                for item in items {
                    let item_id = item.get("id").and_then(Value::as_str).unwrap_or("");
                    if item_id.is_empty() {
                        continue;
                    }
                    turso
                        .query_one(
                            item_sql,
                            vec![
                                json!(item_id),
                                json!(run_id),
                                json!(item.get("id_karyawan").and_then(Value::as_str).unwrap_or("")),
                                json!(item
                                    .get("nama_karyawan")
                                    .and_then(Value::as_str)
                                    .unwrap_or("")),
                                json!(item.get("divisi").and_then(Value::as_str).unwrap_or("")),
                                json!(item
                                    .get("ptkp_status")
                                    .and_then(Value::as_str)
                                    .unwrap_or("TK/0")),
                                json!(item
                                    .get("total_regular_hours")
                                    .and_then(Value::as_f64)
                                    .unwrap_or(0.0)),
                                json!(item
                                    .get("total_overtime_hours")
                                    .and_then(Value::as_f64)
                                    .unwrap_or(0.0)),
                                json!(item
                                    .get("total_overtime_index")
                                    .and_then(Value::as_f64)
                                    .unwrap_or(0.0)),
                                json!(item.get("rate_per_hour").and_then(Value::as_i64).unwrap_or(0)),
                                json!(item.get("basic_salary").and_then(Value::as_i64).unwrap_or(0)),
                                json!(item
                                    .get("overtime_salary")
                                    .and_then(Value::as_i64)
                                    .unwrap_or(0)),
                                json!(item.get("gross_salary").and_then(Value::as_i64).unwrap_or(0)),
                                json!(item
                                    .get("total_allowances")
                                    .and_then(Value::as_i64)
                                    .unwrap_or(0)),
                                json!(item
                                    .get("total_deductions")
                                    .and_then(Value::as_i64)
                                    .unwrap_or(0)),
                                json!(item
                                    .get("bpjs_employee_total")
                                    .and_then(Value::as_i64)
                                    .unwrap_or(0)),
                                json!(item
                                    .get("bpjs_company_total")
                                    .and_then(Value::as_i64)
                                    .unwrap_or(0)),
                                json!(item.get("pph21_amount").and_then(Value::as_i64).unwrap_or(0)),
                                json!(item.get("net_salary").and_then(Value::as_i64).unwrap_or(0)),
                                json!(item
                                    .get("breakdown_snapshot")
                                    .and_then(Value::as_str)
                                    .unwrap_or("{}")),
                                json!(item.get("created_at").and_then(Value::as_str).unwrap_or("")),
                            ],
                        )
                        .await?;
                }
            }

            if let Some(audit) = payload.get("audit") {
                insert_payroll_audit_log(turso, audit).await?;
            }
        }
        ("payroll", "transition-status") => {
            let run_id = payload.get("id").and_then(Value::as_str).unwrap_or("");
            let status = payload.get("status").and_then(Value::as_str).unwrap_or("");
            let updated_at = payload.get("updated_at").and_then(Value::as_str).unwrap_or("");
            if !run_id.is_empty() && !status.is_empty() {
                turso
                    .query_one(
                        "UPDATE payroll_runs SET status = ?, updated_at = ? WHERE id = ?;",
                        vec![json!(status), json!(updated_at), json!(run_id)],
                    )
                    .await?;
            }
            if let Some(audit) = payload.get("audit") {
                insert_payroll_audit_log(turso, audit).await?;
            }
        }
        _ => {
            return Err(CommandError::new(
                "TURSO_SYNC_OPERATION_UNSUPPORTED",
                format!("Domain atau operasi sinkronisasi tidak dikenali: {domain}/{operation}."),
            ));
        }
    }

    Ok(())
}

fn validate_bootstrap_draft(draft: &BootstrapSuperadminDraft) -> Result<(), CommandError> {
    let code = draft.kode_operator.trim().to_ascii_uppercase();
    let name = draft.nama_operator.trim();
    let username = draft.username.trim();
    let password = draft.password.as_str();
    if code != "SPD001" {
        return Err(CommandError::new(
            "TURSO_BOOTSTRAP_INVALID",
            "Kode bootstrap Superadmin wajib SPD001.",
        ));
    }
    if !(3..=120).contains(&name.chars().count()) {
        return Err(CommandError::new(
            "TURSO_BOOTSTRAP_INVALID",
            "Nama Superadmin harus terdiri dari 3-120 karakter.",
        ));
    }
    if !(3..=64).contains(&username.len())
        || !username
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
    {
        return Err(CommandError::new(
            "TURSO_BOOTSTRAP_INVALID",
            "Username harus terdiri dari 3-64 karakter huruf, angka, titik, garis bawah, atau tanda minus.",
        ));
    }
    let has_upper = password.chars().any(char::is_uppercase);
    let has_lower = password.chars().any(char::is_lowercase);
    let has_digit = password.chars().any(|character| character.is_ascii_digit());
    let has_symbol = password
        .chars()
        .any(|character| !character.is_alphanumeric() && !character.is_whitespace());
    if !(12..=128).contains(&password.chars().count())
        || !has_upper
        || !has_lower
        || !has_digit
        || !has_symbol
        || password.to_lowercase().contains(&username.to_lowercase())
    {
        return Err(CommandError::new(
            "TURSO_BOOTSTRAP_PASSWORD_WEAK",
            "Password minimal 12 karakter dan wajib memuat huruf besar, huruf kecil, angka, simbol, serta tidak memuat username.",
        ));
    }
    Ok(())
}

pub fn verify_password(password: &str, stored_hash: &str) -> bool {
    if stored_hash.is_empty() {
        return false;
    }

    let parts: Vec<&str> = stored_hash.split('$').collect();
    if parts.len() == 4 && parts[0] == "pbkdf2-sha256" {
        let Ok(iterations) = parts[1].parse::<u32>() else {
            return false;
        };
        let Ok(salt) = BASE64_STANDARD.decode(parts[2]) else {
            return false;
        };
        let Ok(expected_hash) = BASE64_STANDARD.decode(parts[3]) else {
            return false;
        };

        if iterations < 1_000 {
            return false;
        }

        let mut derived = vec![0u8; expected_hash.len()];
        pbkdf2_hmac::<Sha256>(password.as_bytes(), &salt, iterations, &mut derived);

        let mut diff = 0u8;
        for (a, b) in derived.iter().zip(expected_hash.iter()) {
            diff |= a ^ b;
        }
        return diff == 0 && derived.len() == expected_hash.len();
    }

    // Cek Argon2 jika format $argon2id$...
    if stored_hash.starts_with("$argon2") {
        if let Ok(parsed) = argon2::PasswordHash::new(stored_hash) {
            return argon2::Argon2::default()
                .verify_password(password.as_bytes(), &parsed)
                .is_ok();
        }
    }

    // Fallback legacy plaintext
    stored_hash == password
}

pub fn hash_password_pbkdf2_with_iterations(password: &str, iterations: u32) -> String {
    use rand_core::{OsRng, RngCore};
    let mut salt = [0u8; 16];
    OsRng.fill_bytes(&mut salt);
    let mut derived = [0u8; 32];
    pbkdf2_hmac::<Sha256>(password.as_bytes(), &salt, iterations, &mut derived);
    format!(
        "pbkdf2-sha256${}${}${}",
        iterations,
        BASE64_STANDARD.encode(salt),
        BASE64_STANDARD.encode(derived)
    )
}

pub fn hash_password_pbkdf2(password: &str) -> String {
    hash_password_pbkdf2_with_iterations(password, 600_000)
}

fn chrono_like_now_iso() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or_default();
    format!("{now}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_normalize_turso_url() {
        assert_eq!(
            normalize_turso_url("libsql://my-db.turso.io")
                .unwrap()
                .as_str(),
            "https://my-db.turso.io/"
        );
        assert_eq!(
            normalize_turso_url("https://my-db.turso.io/path?query=1")
                .unwrap()
                .as_str(),
            "https://my-db.turso.io/"
        );
        assert!(normalize_turso_url("ftp://my-db.turso.io").is_err());
        assert!(normalize_turso_url("").is_err());
    }

    #[test]
    fn test_pbkdf2_hash_and_verify() {
        let password = "MySecretPassword123!";
        let hash = hash_password_pbkdf2_with_iterations(password, 1_000);
        assert!(hash.starts_with("pbkdf2-sha256$1000$"));
        assert!(verify_password(password, &hash));
        assert!(!verify_password("WrongPassword", &hash));
    }

    #[test]
    fn test_legacy_plaintext_verify() {
        assert!(verify_password("plaintext123", "plaintext123"));
        assert!(!verify_password("plaintext123", "different"));
    }

    #[test]
    fn bootstrap_requires_a_strong_non_default_password() {
        let strong = BootstrapSuperadminDraft {
            kode_operator: "SPD001".into(),
            nama_operator: "Pemilik SPPG".into(),
            username: "pemilik.sppg".into(),
            password: "Aman-Sekali-2026!".into(),
        };
        assert!(validate_bootstrap_draft(&strong).is_ok());
        let weak = BootstrapSuperadminDraft {
            password: "admin123".into(),
            ..strong
        };
        assert_eq!(
            validate_bootstrap_draft(&weak)
                .expect_err("weak password")
                .code,
            "TURSO_BOOTSTRAP_PASSWORD_WEAK"
        );
    }

    #[test]
    fn atomic_batch_has_guarded_commit_and_rollback() {
        let statements = vec![
            Statement::new("INSERT INTO a VALUES (?);", vec![json!(1)]),
            Statement::new("INSERT INTO b VALUES (?);", vec![json!(2)]),
        ];
        let (steps, commit_step) = atomic_batch_steps(&statements);
        assert_eq!(steps.len(), 5);
        assert_eq!(commit_step, 3);
        assert_eq!(steps[2]["condition"], json!({ "type": "ok", "step": 1 }));
        assert_eq!(
            steps[4]["condition"],
            json!({ "type": "not", "cond": { "type": "ok", "step": 3 } })
        );
    }

    #[test]
    fn sync_routes_are_canonicalized_and_unsupported_mutations_are_closed() {
        assert_eq!(
            canonical_sync_route("company_profile", "upsert"),
            Some(("company-profile", "update"))
        );
        assert_eq!(
            canonical_sync_route("scan_log", "submit"),
            Some(("attendance", "scan"))
        );
        assert_eq!(
            canonical_sync_route("offline_import", "upsert"),
            Some(("offline-import", "row"))
        );
        assert_eq!(canonical_sync_route("employee", "delete"), None);
        assert_eq!(canonical_sync_route("unknown_domain", "update"), None);
    }

    #[test]
    fn extract_attendance_row_params_resolves_integer_and_string_tahun() {
        let att_int = json!({
            "tanggal": "2026-08-22",
            "id_karyawan": "EMP001",
            "nama": "Budi",
            "tahun": 2026,
            "bulan": "Agustus"
        });
        let params_int = extract_attendance_row_params(&att_int, "SESI001");
        assert_eq!(params_int[18], json!("Agustus"));
        assert_eq!(params_int[19], json!(2026));

        let att_str = json!({
            "tanggal": "2026-08-22",
            "id_karyawan": "EMP001",
            "nama": "Budi",
            "tahun": "2026"
        });
        let params_str = extract_attendance_row_params(&att_str, "SESI001");
        assert_eq!(params_str[18], json!("Agustus"));
        assert_eq!(params_str[19], json!(2026));

        let att_empty = json!({
            "tanggal": "2026-08-22",
            "id_karyawan": "EMP001",
            "nama": "Budi"
        });
        let params_empty = extract_attendance_row_params(&att_empty, "SESI001");
        assert_eq!(params_empty[18], json!("Agustus"));
        assert_eq!(params_empty[19], json!(2026));
    }
}
