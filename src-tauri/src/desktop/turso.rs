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
    // Seam transport: dekoder sel Hrana dan jalur SQLite lokal. SQL-nya sama,
    // yang berbeda hanya ke mana ia dikirim.
    sql_backend::{decode_hrana_cell, LocalTransport},
    // Normalisasi cakupan whitelist hari libur hidup di `scanner` bersama
    // penilaiannya, supaya jalur cloud dan jalur scan tidak pernah bisa drift.
    scanner, sync,
};

/// Provider database cloud yang dipakai perangkat.
///
/// `Turso` adalah layanan terkelola (`libsql://<db>.turso.io`): selalu TLS dan
/// selalu memerlukan Auth Token. `SelfHosted` adalah server libSQL milik
/// pengguna sendiri (`sqld` / `libsql-server`) yang berjalan di komputer kantor,
/// NAS, mesin LAN, atau VPS. Server seperti itu lazim dijalankan tanpa token dan
/// tanpa sertifikat TLS, sehingga aturan validasinya memang berbeda.
///
/// Provider disimpan eksplisit, BUKAN ditebak dari bentuk URL. Kalau ditebak,
/// satu salah ketik pada URL Turso (`http://` alih-alih `https://`) otomatis
/// melonggarkan aturan transport tanpa pengguna pernah memilihnya.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DatabaseProvider {
    #[default]
    Turso,
    #[serde(
        alias = "selfHosted",
        alias = "self-hosted",
        alias = "custom",
        alias = "local",
        alias = "libsql"
    )]
    SelfHosted,
    /// Berkas SQLite di perangkat ini, tanpa server sama sekali.
    ///
    /// Alias `"local"` SENGAJA TIDAK dipakai di sini: nilai itu sudah lebih
    /// dulu berarti `SelfHosted` pada instalasi yang ada, dan memakainya ulang
    /// akan mengubah arti data yang sudah tersimpan di perangkat pelanggan.
    #[serde(alias = "localFile", alias = "local-file", alias = "file")]
    LocalFile,
}

impl DatabaseProvider {
    pub fn is_self_hosted(self) -> bool {
        matches!(self, Self::SelfHosted)
    }

    /// Apakah seluruh SQL dijalankan ke berkas lokal, tanpa jaringan.
    pub fn is_local_file(self) -> bool {
        matches!(self, Self::LocalFile)
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Turso => "turso",
            Self::SelfHosted => "self_hosted",
            Self::LocalFile => "local_file",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::Turso => "Turso Cloud",
            Self::SelfHosted => "Server Database Sendiri",
            Self::LocalFile => "Database Lokal (Tanpa Server)",
        }
    }
}

/// Alamat yang trafiknya tidak pernah meninggalkan perangkat atau LAN pengguna.
///
/// Dipakai untuk memutuskan apakah HTTP polos boleh dipakai. Daftar ini sengaja
/// konservatif: hanya loopback, rentang privat RFC1918/RFC4193, link-local,
/// nama domain LAN, dan dua alias host yang memang menunjuk mesin developer
/// (`10.0.2.2` untuk emulator Android, `host.docker.internal` untuk container).
pub fn is_private_network_host(host: &str) -> bool {
    if host.eq_ignore_ascii_case("localhost") || host.eq_ignore_ascii_case("host.docker.internal") {
        return true;
    }
    // Alamat khusus emulator Android yang menunjuk balik ke mesin developer.
    if host == "10.0.2.2" {
        return true;
    }
    let lowered = host.to_ascii_lowercase();
    if lowered.ends_with(".local") || lowered.ends_with(".lan") || lowered.ends_with(".internal") {
        return true;
    }
    host.parse::<IpAddr>().is_ok_and(|ip| match ip {
        IpAddr::V4(address) => {
            address.is_loopback() || address.is_private() || address.is_link_local()
        }
        IpAddr::V6(address) => address.is_loopback() || address.is_unique_local(),
    })
}

/// Validasi dan normalisasi URL endpoint database untuk provider tertentu.
///
/// Mengembalikan origin bersih tanpa path/query/fragment karena seluruh
/// pemanggil menambahkan `/v2/pipeline` sendiri. Kredensial di dalam URL
/// (`https://user:pass@host`) ditolak: token wajib lewat vault, bukan lewat URL
/// yang ikut tersimpan di tabel setting dan ikut tampil di UI.
/// Origin sintetis untuk mode Database Lokal.
///
/// Mode lokal tidak punya alamat jaringan, tetapi `server_origin` tetap
/// dibutuhkan: vault perangkat mengikat snapshot kredensial pada kombinasi
/// origin + username + device_id. Nilainya harus stabil (kalau berubah, seluruh
/// akses offline yang sudah tersimpan menjadi tidak sah) dan tidak boleh pernah
/// bisa di-resolve — `.invalid` dicadangkan RFC 2606 justru untuk itu, sehingga
/// tidak ada kemungkinan permintaan nyasar ke host milik orang lain.
pub const LOCAL_FILE_ORIGIN: &str = "https://local-file.sppg.invalid";

pub fn normalize_database_url(
    raw: &str,
    provider: DatabaseProvider,
    allow_insecure_transport: bool,
) -> Result<Url, CommandError> {
    // Mode lokal tidak pernah menyentuh jaringan, sehingga seluruh aturan
    // transport di bawah tidak berlaku — dan `raw` di sini adalah lokasi
    // berkas, bukan URL. Dikembalikan lebih dulu supaya lokasi berkas tidak
    // pernah salah diuji sebagai alamat host.
    if provider.is_local_file() {
        return Url::parse(LOCAL_FILE_ORIGIN).map_err(|_| CommandError::internal());
    }

    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(CommandError::new(
            "TURSO_URL_INVALID",
            "URL database tidak boleh kosong.",
        ));
    }

    // `libsql://` dan `ws(s)://` hanyalah ejaan lain dari endpoint HTTP yang
    // sama. Server libSQL self-hosted kerap dicetak dengan salah satu bentuk itu
    // di dokumentasinya, jadi keduanya diterima dan dipetakan ke http(s).
    let https_url_str = if let Some(stripped) = trimmed.strip_prefix("libsql://") {
        format!("https://{stripped}")
    } else if let Some(stripped) = trimmed.strip_prefix("wss://") {
        format!("https://{stripped}")
    } else if let Some(stripped) = trimmed.strip_prefix("ws://") {
        format!("http://{stripped}")
    } else {
        trimmed.to_owned()
    };

    let mut parsed = Url::parse(&https_url_str).map_err(|_| {
        CommandError::new(
            "TURSO_URL_INVALID",
            match provider {
                DatabaseProvider::Turso => "Format URL database Turso tidak valid (contoh: libsql://db-name.turso.io atau https://db-name.turso.io).",
                DatabaseProvider::SelfHosted => "Format URL server database tidak valid (contoh: http://192.168.1.10:8080 atau https://db.kantor-anda.com).",
                // Tidak terjangkau: mode lokal sudah kembali di awal fungsi.
                DatabaseProvider::LocalFile => "Mode Database Lokal tidak memakai URL.",
            },
        )
    })?;

    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(CommandError::new(
            "TURSO_URL_INVALID",
            "URL database harus memakai protokol libsql://, https://, atau http://.",
        ));
    }
    if parsed.host_str().is_none() || !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(CommandError::new(
            "TURSO_URL_INVALID",
            "URL database harus memiliki host dan tidak boleh memuat kredensial.",
        ));
    }

    if parsed.scheme() == "http" {
        let host = parsed.host_str().unwrap_or_default();
        let is_private = is_private_network_host(host);
        let allowed = match provider {
            // Turso terkelola tidak pernah melayani HTTP polos di internet;
            // satu-satunya HTTP yang masuk akal adalah `turso dev` lokal saat
            // pengembangan.
            DatabaseProvider::Turso => is_private && cfg!(debug_assertions),
            // Server sendiri di jaringan privat: paket tidak pernah keluar dari
            // LAN, jadi HTTP polos diizinkan pada build rilis sekalipun. Di luar
            // jaringan privat, pengguna harus menyatakan risikonya secara sadar.
            DatabaseProvider::SelfHosted => is_private || allow_insecure_transport,
            DatabaseProvider::LocalFile => true,
        };
        if !allowed {
            let message = match provider {
                DatabaseProvider::Turso => {
                    "URL database Turso wajib memakai HTTPS. Kalau ini server database Anda sendiri, pilih mode \"Server Database Sendiri\" terlebih dahulu."
                }
                DatabaseProvider::SelfHosted => {
                    "Alamat server ini berada di luar jaringan privat, sehingga HTTP polos akan mengirim Auth Token dan data absensi tanpa enkripsi. Pasang HTTPS di server (misalnya lewat Caddy/Nginx), pakai alamat LAN/VPN, atau centang \"Izinkan koneksi tanpa enkripsi\" bila Anda menerima risikonya."
                }
                DatabaseProvider::LocalFile => "Mode Database Lokal tidak memakai URL.",
            };
            return Err(CommandError::new("TURSO_URL_INSECURE", message));
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
    /// Default `Turso` supaya vault lama — yang hanya menyimpan `database_url`
    /// dan `auth_token` — tetap terbaca apa adanya setelah aplikasi diperbarui.
    #[serde(default)]
    pub provider: DatabaseProvider,
    /// Hanya bermakna untuk [`DatabaseProvider::SelfHosted`]: izin eksplisit
    /// memakai HTTP polos ke host di luar jaringan privat.
    #[serde(default)]
    pub allow_insecure_transport: bool,
}

impl TursoConfig {
    pub fn new(
        database_url: String,
        auth_token: String,
        provider: DatabaseProvider,
        allow_insecure_transport: bool,
    ) -> Self {
        Self {
            database_url,
            auth_token,
            provider,
            // Flag ini tidak punya arti di luar mode server sendiri; memaksanya
            // `false` mencegah nilai basi ikut aktif kalau pengguna berpindah
            // balik ke Turso lalu kembali lagi ke server sendiri.
            allow_insecure_transport: provider.is_self_hosted() && allow_insecure_transport,
        }
    }

    /// Konfigurasi Turso terkelola (bentuk lama dua-field).
    pub fn turso(database_url: String, auth_token: String) -> Self {
        Self::new(database_url, auth_token, DatabaseProvider::Turso, false)
    }

    /// Origin endpoint yang sudah tervalidasi menurut provider konfigurasi ini.
    pub fn normalized_url(&self) -> Result<Url, CommandError> {
        normalize_database_url(
            &self.database_url,
            self.provider,
            self.allow_insecure_transport,
        )
    }

    /// Apakah `raw` menunjuk database yang sama dengan konfigurasi ini.
    ///
    /// Perbandingan wajib ternormalisasi: `libsql://x`, `https://x`, dan
    /// `https://x/` menunjuk database yang sama. Perbandingan string mentah
    /// pernah membuat token yang tersimpan di vault dianggap milik database lain
    /// hanya karena pengguna mengetik ejaan URL yang berbeda.
    pub fn matches_url(&self, raw: &str) -> bool {
        match (
            self.normalized_url(),
            normalize_database_url(raw, self.provider, self.allow_insecure_transport),
        ) {
            (Ok(current), Ok(candidate)) => current == candidate,
            _ => self.database_url.trim() == raw.trim(),
        }
    }

    /// Lokasi berkas hub untuk mode Database Lokal.
    ///
    /// `database_url` menyimpan lokasi berkas apa adanya pada mode ini — bukan
    /// URL — supaya yang tersimpan di tabel setting dan yang tampil di layar
    /// adalah sesuatu yang bisa dibuka pengguna di file explorer.
    pub fn local_file_path(&self) -> Result<std::path::PathBuf, CommandError> {
        let trimmed = self.database_url.trim();
        if trimmed.is_empty() {
            return Err(CommandError::new(
                "LOCAL_DB_PATH_MISSING",
                "Lokasi berkas database lokal belum ditentukan.",
            ));
        }
        Ok(std::path::PathBuf::from(trimmed))
    }

    /// Auth Token wajib ada sebelum koneksi boleh dicoba.
    ///
    /// Turso terkelola selalu wajib. Server sendiri boleh tanpa token — `sqld`
    /// default berjalan tanpa autentikasi — kecuali endpoint-nya HTTPS publik,
    /// yang berarti server itu terekspos ke internet dan token adalah satu-
    /// satunya penghalang yang tersisa.
    pub fn requires_auth_token(&self) -> bool {
        match self.provider {
            DatabaseProvider::Turso => true,
            // Tidak ada jaringan, tidak ada pihak yang perlu diyakinkan.
            DatabaseProvider::LocalFile => false,
            DatabaseProvider::SelfHosted => self.normalized_url().ok().is_some_and(|url| {
                url.scheme() == "https"
                    && !is_private_network_host(url.host_str().unwrap_or_default())
            }),
        }
    }
}

/// Ringkasan konfigurasi database yang aman ditampilkan di UI.
///
/// Auth Token TIDAK PERNAH ikut. Frontend hanya perlu tahu bahwa token sudah
/// tersimpan supaya bisa menampilkan "Tersimpan di Vault" dan membiarkan field
/// isian kosong berarti "pertahankan token lama".
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseConfigView {
    pub configured: bool,
    pub database_url: String,
    pub provider: String,
    /// Nama provider yang siap ditampilkan, supaya UI tidak perlu menyimpan
    /// salinan tabel terjemahannya sendiri dan ikut basi saat provider bertambah.
    pub provider_label: String,
    pub allow_insecure_transport: bool,
    pub auth_token_saved: bool,
}

impl DatabaseConfigView {
    pub fn empty() -> Self {
        Self {
            configured: false,
            database_url: String::new(),
            provider: DatabaseProvider::Turso.as_str().to_owned(),
            provider_label: DatabaseProvider::Turso.label().to_owned(),
            allow_insecure_transport: false,
            auth_token_saved: false,
        }
    }

    pub fn from_config(config: &TursoConfig) -> Self {
        Self {
            configured: true,
            database_url: config.database_url.clone(),
            provider: config.provider.as_str().to_owned(),
            provider_label: config.provider.label().to_owned(),
            allow_insecure_transport: config.allow_insecure_transport,
            auth_token_saved: !config.auth_token.trim().is_empty(),
        }
    }
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
    /// Apakah database cloud yang tersimpan benar-benar berhasil dihubungi.
    ///
    /// `configured = true` hanya berarti perangkat menyimpan kredensial; tidak
    /// berarti kredensial itu masih menunjuk database yang hidup. Kalau database
    /// lama sudah dihapus di Turso, `configured` tetap true sementara `reachable`
    /// menjadi false — dan layar login harus memakai perbedaan itu untuk
    /// menawarkan konfigurasi ulang, bukan menyembunyikannya sebagai kegagalan.
    pub reachable: bool,
    /// Alasan `reachable = false`, apa adanya dari klien Turso.
    pub message: Option<String>,
}

impl BootstrapStatus {
    /// Kredensial tersimpan tetapi database cloud-nya tidak menjawab.
    pub fn unreachable(server_origin: String, error: &CommandError) -> Self {
        Self {
            configured: true,
            required: false,
            server_origin,
            reachable: false,
            message: Some(error.message.clone()),
        }
    }
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
    /// Kontak Superadmin. Wajib sejak schema versi 11: tanpa email, akun
    /// pertama aplikasi tidak punya jalur pemulihan password sama sekali.
    #[serde(default)]
    pub email: String,
    #[serde(default)]
    pub no_hp: String,
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

/// Apakah pesan error menandakan skema cloud tertinggal dari kode ini.
///
/// `ensure_schema_current` hanya melihat satu baris sentinel `schema_migration`,
/// jadi database cloud yang sudah punya sentinel lama dianggap mutakhir dan
/// seluruh `ensure_column` dilewati. Kalau seseorang lupa menaikkan sentinel
/// setelah menambah kolom, setiap push berubah jadi "konflik" permanen yang
/// tidak bisa diselesaikan operator dari UI. Deteksi ini membuat push
/// menyembuhkan dirinya sekali, alih-alih menyalahkan datanya.
fn is_recoverable_schema_error(message: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    lower.contains("has no column named")
        || lower.contains("no such column")
        || lower.contains("no such table")
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
    /// Berkas SQLite lokal, bila perangkat ini berjalan tanpa server sama
    /// sekali. `None` berarti seluruh SQL dikirim lewat HTTP seperti biasa.
    local: Option<LocalTransport>,
}

impl TursoClient {
    pub fn new(base_url: Url, auth_token: String, http: Client) -> Self {
        Self {
            base_url,
            auth_token: Zeroizing::new(auth_token),
            http,
            local: None,
        }
    }

    /// Klien yang berbicara ke berkas SQLite lokal, tanpa jaringan sama sekali.
    ///
    /// SQL yang dijalankannya sama persis dengan jalur cloud — yang berbeda
    /// hanya tujuannya. Itulah yang membuat tabel lokal dan tabel cloud tidak
    /// bisa berbeda bentuk: keduanya lahir dari `ensure_schema` yang sama.
    ///
    /// `base_url` tetap diminta karena dipakai sebagai identitas asal
    /// (`server_origin`) yang mengikat snapshot kredensial di vault perangkat.
    pub fn local_file(
        base_url: Url,
        path: impl Into<std::path::PathBuf>,
        http: Client,
    ) -> Self {
        Self {
            base_url,
            auth_token: Zeroizing::new(String::new()),
            http,
            local: Some(LocalTransport::new(path)),
        }
    }

    /// Apakah klien ini berjalan sepenuhnya lokal.
    #[allow(dead_code)]
    pub fn is_local(&self) -> bool {
        self.local.is_some()
    }

    pub fn from_config(config: &TursoConfig, http: Client) -> Result<Self, CommandError> {
        // Validasi URL memakai provider yang benar-benar dipilih pengguna.
        // Memakai aturan Turso untuk server sendiri akan menolak alamat LAN
        // ber-HTTP yang justru menjadi tujuan mode itu.
        let base_url = config.normalized_url()?;

        // Mode lokal: SQL yang sama, tujuan yang berbeda. Tidak ada token yang
        // perlu diperiksa karena tidak ada yang dikirim ke mana pun.
        if config.provider.is_local_file() {
            return Ok(Self::local_file(base_url, config.local_file_path()?, http));
        }

        if config.auth_token.trim().is_empty() && config.requires_auth_token() {
            return Err(CommandError::new(
                "TURSO_TOKEN_REQUIRED",
                match config.provider {
                    DatabaseProvider::Turso => {
                        "Auth Token database Turso wajib diisi untuk koneksi HTTPS."
                    }
                    DatabaseProvider::SelfHosted => {
                        "Server database ini dapat dijangkau dari internet, jadi Auth Token wajib diisi."
                    }
                    // Tidak terjangkau: mode lokal sudah kembali di atas.
                    DatabaseProvider::LocalFile => "Mode Database Lokal tidak memakai Auth Token.",
                },
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

    /// Titik tunggal yang memilih transport.
    ///
    /// Seluruh `Statement` di berkas ini melewati sini, sehingga menukar
    /// tujuan tidak menuntut satu baris SQL pun ditulis ulang.
    pub async fn execute_pipeline(
        &self,
        statements: Vec<Statement>,
    ) -> Result<Vec<QueryResult>, CommandError> {
        match &self.local {
            Some(local) => local.execute_pipeline(statements),
            None => self.execute_pipeline_remote(statements).await,
        }
    }

    pub async fn execute_atomic(&self, statements: Vec<Statement>) -> Result<(), CommandError> {
        match &self.local {
            Some(local) => local.execute_atomic(statements),
            None => self.execute_atomic_remote(statements).await,
        }
    }

    async fn execute_pipeline_remote(
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
                        let parsed_cells: Vec<Value> =
                            cells.iter().map(decode_hrana_cell).collect();
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

    async fn execute_atomic_remote(&self, statements: Vec<Statement>) -> Result<(), CommandError> {
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
                    is_system INTEGER NOT NULL DEFAULT 0 CHECK(is_system IN (0, 1)),
                    is_superadmin INTEGER NOT NULL DEFAULT 0 CHECK(is_superadmin IN (0, 1)),
                    status TEXT NOT NULL DEFAULT 'Aktif' CHECK(status IN ('Aktif', 'Nonaktif')),
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
                    is_active INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0, 1)),
                    sort_order INTEGER NOT NULL DEFAULT 0
                );"#,
                vec![],
            ),
            Statement::new(
                r#"CREATE TABLE IF NOT EXISTS role_permission (
                    role_id INTEGER NOT NULL,
                    permission_key TEXT NOT NULL,
                    is_allowed INTEGER NOT NULL DEFAULT 0 CHECK(is_allowed IN (0, 1)),
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
                    role TEXT NOT NULL DEFAULT 'Operator' CHECK(role IN ('Admin', 'Operator', 'Scanner')),
                    role_id INTEGER REFERENCES app_role(id),
                    email TEXT,
                    no_hp TEXT,
                    totp_secret TEXT,
                    totp_enabled INTEGER NOT NULL DEFAULT 0,
                    totp_confirmed_at TEXT,
                    totp_recovery_codes TEXT,
                    password_recovery_codes TEXT,
                    password_recovery_created_at TEXT,
                    status TEXT DEFAULT 'Aktif',
                    created_at TEXT,
                    updated_at TEXT
                );"#,
                vec![],
            ),
            // Tabel milik Web (definisi asli di db-migrations.ts). Rust ikut
            // membuatnya supaya database yang lahir dari Desktop/Mobile tetap
            // bisa dipakai aplikasi Web, dan sebaliknya. Cloud-only: tidak
            // pernah masuk SNAPSHOT_TABLES karena berisi bukti foto dan hash
            // token reset yang tidak boleh direplikasi ke setiap perangkat.
            Statement::new(
                r#"CREATE TABLE IF NOT EXISTS password_reset_request (
                    id TEXT PRIMARY KEY,
                    operator_id INTEGER NOT NULL,
                    identifier_used TEXT NOT NULL,
                    contact_channel TEXT NOT NULL DEFAULT 'email',
                    contact_target TEXT NOT NULL,
                    challenge_hash TEXT NOT NULL,
                    challenge_sequence TEXT NOT NULL,
                    token_hash TEXT,
                    status TEXT NOT NULL DEFAULT 'Menunggu Verifikasi'
                        CHECK(status IN (
                            'Menunggu Verifikasi', 'Terkirim', 'Terpakai', 'Kedaluwarsa', 'Dibatalkan'
                        )),
                    liveness_score REAL,
                    liveness_report TEXT,
                    photo_mime TEXT,
                    photo_base64 TEXT,
                    delivery_status TEXT,
                    delivery_error TEXT,
                    requested_at TEXT NOT NULL,
                    verified_at TEXT,
                    sent_at TEXT,
                    used_at TEXT,
                    expires_at TEXT NOT NULL,
                    request_ip_hash TEXT,
                    user_agent_hash TEXT,
                    FOREIGN KEY (operator_id) REFERENCES master_operator(id) ON DELETE CASCADE
                );"#,
                vec![],
            ),
            Statement::new(
                r#"CREATE TABLE IF NOT EXISTS app_mail_config (
                    id TEXT PRIMARY KEY,
                    provider TEXT NOT NULL DEFAULT 'resend'
                        CHECK(provider IN ('resend', 'brevo')),
                    api_key TEXT,
                    sender_email TEXT,
                    sender_name TEXT,
                    reset_base_url TEXT,
                    is_active INTEGER NOT NULL DEFAULT 0 CHECK(is_active IN (0, 1)),
                    updated_at TEXT NOT NULL,
                    updated_by TEXT
                );"#,
                vec![],
            ),
            Statement::new(
                "INSERT OR IGNORE INTO app_mail_config (id, provider, is_active, updated_at, updated_by) VALUES ('default', 'resend', 0, datetime('now'), 'rust-bootstrap');",
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
                    izinkan_multi_sesi INTEGER DEFAULT 0,
                    shift_lanjutan_id INTEGER DEFAULT 0
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
                    sumber_data TEXT NOT NULL
                        CHECK (sumber_data IN ('Scanner', 'Koreksi Admin', 'Import Offline', 'Import Manual', 'Generate Sistem')),
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
                    sumber TEXT NOT NULL
                        CHECK (sumber IN ('Scanner', 'Koreksi Admin', 'Import Offline', 'Import Manual', 'Generate Sistem')),
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
                // Foto bukti absensi. SENGAJA di luar SNAPSHOT_TABLES: satu foto
                // ~40 KB, dan menariknya lewat snapshot akan membuat tiap siklus
                // pull berukuran puluhan megabyte di setiap perangkat. Foto ikut
                // event 'attendance/scan' saat push, lalu dibaca satu per satu
                // dari cloud oleh halaman peninjauan.
                r#"CREATE TABLE IF NOT EXISTS absensi_foto (
                    id_foto TEXT PRIMARY KEY,
                    id_sesi TEXT,
                    tanggal_kerja TEXT NOT NULL,
                    id_karyawan TEXT NOT NULL,
                    nama TEXT NOT NULL,
                    divisi TEXT,
                    jenis_scan TEXT NOT NULL,
                    timestamp_scan TEXT NOT NULL,
                    sumber_data TEXT NOT NULL DEFAULT 'Scanner',
                    kode_operator TEXT,
                    ip_perangkat TEXT,
                    client_id TEXT,
                    foto_mime TEXT NOT NULL DEFAULT 'image/jpeg',
                    foto_base64 TEXT NOT NULL,
                    created_at TEXT NOT NULL
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
            // Whitelist Shift/Divisi yang tetap boleh scan saat hari libur.
            // Definisinya WAJIB identik dengan `db-migrations.ts`: keduanya
            // membangun database cloud yang sama, dan CREATE TABLE IF NOT EXISTS
            // tidak pernah memperbaiki tabel yang terlanjur dibuat sisi lain.
            //
            // Cakupan memakai `kode_shift` dan NAMA divisi, bukan `id_shift`:
            // id itu AUTOINCREMENT yang berbeda tiap perangkat. Tidak ada UNIQUE
            // pada (scope_type, scope_value) — dua perangkat offline boleh
            // mendaftarkan cakupan sama tanpa membuat push sync gagal permanen.
            Statement::new(
                r#"CREATE TABLE IF NOT EXISTS hari_libur_whitelist (
                    id TEXT PRIMARY KEY,
                    scope_type TEXT NOT NULL CHECK (scope_type IN ('SHIFT', 'DIVISI')),
                    scope_value TEXT NOT NULL,
                    tanggal_libur TEXT,
                    keterangan TEXT,
                    status_aktif INTEGER NOT NULL DEFAULT 1 CHECK (status_aktif IN (0, 1)),
                    created_at TEXT NOT NULL DEFAULT (datetime('now')),
                    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
                );"#,
                vec![],
            ),
            Statement::new("CREATE INDEX IF NOT EXISTS idx_hari_libur_whitelist_scope ON hari_libur_whitelist(scope_type, scope_value, status_aktif);", vec![]),
            Statement::new("CREATE INDEX IF NOT EXISTS idx_hari_libur_whitelist_tanggal ON hari_libur_whitelist(tanggal_libur, status_aktif);", vec![]),
            Statement::new(
                r#"CREATE TABLE IF NOT EXISTS company_profile (
                    id TEXT PRIMARY KEY DEFAULT 'default_company',
                    company_name TEXT NOT NULL DEFAULT 'YOUR COMPANY',
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
                    name TEXT NOT NULL DEFAULT 'Default ID Card Template',
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
                    timestamp_input TEXT NOT NULL,
                    tanggal TEXT NOT NULL,
                    id_unik TEXT NOT NULL,
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
                // Definisi WAJIB sama dengan `db-migrations.ts`: tabel ini ditulis
                // jalur Rust MAUPUN jalur Web. Versi lama menaruh `server_revision`
                // sebagai NOT NULL (padahal Web menulis NULL untuk event yang
                // rejected/conflict) dan `receipt_json` NOT NULL tanpa DEFAULT
                // (padahal INSERT Web tidak menyertakan kolom itu) — dua-duanya
                // membuat push dari Web gagal di database hasil provisioning
                // Desktop/Mobile.
                r#"CREATE TABLE IF NOT EXISTS sync_operation_receipt (
                    event_id TEXT PRIMARY KEY,
                    client_id TEXT NOT NULL,
                    domain TEXT NOT NULL,
                    operation TEXT NOT NULL,
                    entity_key TEXT NOT NULL,
                    payload_hash TEXT NOT NULL,
                    status TEXT NOT NULL CHECK(status IN ('applied', 'rejected', 'conflict')),
                    result_json TEXT NOT NULL,
                    base_revision INTEGER,
                    server_revision INTEGER,
                    actor_operator_id INTEGER NOT NULL,
                    receipt_json TEXT NOT NULL DEFAULT '{}',
                    created_at TEXT NOT NULL,
                    processed_at TEXT NOT NULL
                );"#,
                vec![],
            ),
            Statement::new(
                // `app_session` dan `auth_login_rate_limit` DIMILIKI aplikasi Web
                // (`src/lib/auth/session-store.ts` dan `login-rate-limit.ts`);
                // Rust tidak pernah membacanya. Definisi di bawah WAJIB sama
                // persis dengan `db-migrations.ts`. Versi lama Rust memakai
                // kolom karangan sendiri (`last_activity_at`, `identifier_hash`),
                // sehingga database yang di-provisioning dari Desktop/Mobile
                // membuat login Web gagal total.
                r#"CREATE TABLE IF NOT EXISTS app_session (
                    session_id TEXT PRIMARY KEY,
                    token_hash TEXT UNIQUE NOT NULL,
                    operator_id INTEGER NOT NULL,
                    permission_revision INTEGER NOT NULL,
                    created_at TEXT NOT NULL,
                    expires_at TEXT NOT NULL,
                    last_seen_at TEXT NOT NULL,
                    revoked_at TEXT,
                    revoked_reason TEXT,
                    user_agent_hash TEXT,
                    FOREIGN KEY (operator_id) REFERENCES master_operator(id) ON DELETE CASCADE
                );"#,
                vec![],
            ),
            Statement::new(
                r#"CREATE TABLE IF NOT EXISTS auth_login_rate_limit (
                    rate_key TEXT PRIMARY KEY,
                    attempt_count INTEGER NOT NULL,
                    window_started_at TEXT NOT NULL,
                    blocked_until TEXT,
                    updated_at TEXT NOT NULL
                );"#,
                vec![],
            ),
            Statement::new(
                // Jejak audit RBAC, dipakai `src/lib/rbac/role-admin.ts`. Dulu
                // hanya dibuat jalur Web, jadi database hasil provisioning
                // Desktop/Mobile membuat manajemen role di Web gagal.
                r#"CREATE TABLE IF NOT EXISTS role_permission_audit (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    role_id INTEGER NOT NULL,
                    permission_key TEXT NOT NULL,
                    before_allowed INTEGER NOT NULL,
                    after_allowed INTEGER NOT NULL,
                    changed_at TEXT NOT NULL,
                    changed_by TEXT NOT NULL,
                    revision INTEGER NOT NULL
                );"#,
                vec![],
            ),
            Statement::new(
                // Changelog jalur Web (`src/lib/server/operational/*`). Berbeda
                // dari `sync_changelog` milik pipeline Desktop/Mobile, dan ikut
                // dihitung `isDatabaseSchemaReady` di sisi Web.
                r#"CREATE TABLE IF NOT EXISTS sync_change_log (
                    revision INTEGER PRIMARY KEY AUTOINCREMENT,
                    domain TEXT NOT NULL,
                    entity_key TEXT NOT NULL,
                    operation TEXT NOT NULL,
                    payload_json TEXT NOT NULL,
                    changed_at TEXT NOT NULL,
                    actor_operator_id INTEGER NOT NULL
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
            Statement::new("CREATE INDEX IF NOT EXISTS idx_password_reset_operator ON password_reset_request(operator_id, status, requested_at DESC);", vec![]),
            Statement::new("CREATE INDEX IF NOT EXISTS idx_password_reset_token ON password_reset_request(token_hash);", vec![]),
            Statement::new("CREATE INDEX IF NOT EXISTS idx_password_reset_challenge ON password_reset_request(challenge_hash);", vec![]),
            Statement::new("CREATE INDEX IF NOT EXISTS idx_absensi_foto_tanggal ON absensi_foto(tanggal_kerja, timestamp_scan DESC);", vec![]),
            Statement::new("CREATE INDEX IF NOT EXISTS idx_absensi_foto_karyawan ON absensi_foto(id_karyawan, tanggal_kerja);", vec![]),
            Statement::new("CREATE INDEX IF NOT EXISTS idx_absensi_foto_sesi ON absensi_foto(id_sesi);", vec![]),
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
                ('password_reset.view', 'Lihat Riwayat Reset Password', 'Sistem', 'Melihat riwayat pengajuan pemulihan password beserta bukti fotonya.', 1, 201),
                ('password_reset.delete', 'Hapus Riwayat Reset Password', 'Sistem', 'Menghapus jejak pengajuan pemulihan password.', 1, 202),
                ('two_factor.reset', 'Reset 2FA Operator Lain', 'Sistem', 'Mematikan verifikasi dua langkah milik operator lain.', 1, 203),
                ('attendance_photo.view', 'Lihat Foto Bukti Absensi', 'Sistem', 'Melihat foto bukti yang diambil saat scan absensi.', 1, 204),
                ('attendance_photo.delete', 'Hapus Foto Bukti Absensi', 'Sistem', 'Menghapus foto bukti absensi dari database cloud.', 1, 205),
                ('password_reset.approve', 'Setujui Pemulihan Password', 'Sistem', 'Meninjau foto pemohon lalu menyerahkan kode pemulihan password.', 1, 208),
                ('database_backup.export', 'Ekspor Cadangan Database', 'Sistem', 'Mengeluarkan seluruh isi database ke satu berkas cadangan.', 1, 206),
                ('database_backup.restore', 'Pulihkan Database dari Cadangan', 'Sistem', 'Menimpa seluruh data perangkat dengan isi berkas cadangan.', 1, 207),
                ('operators.view', 'Lihat Daftar Operator', 'Operator', 'Melihat data operator dan akun pengguna.', 1, 210),
                ('operators.manage', 'Kelola Operator', 'Operator', 'Menambah dan mengubah data operator aplikasi.', 1, 220),
                ('roles.manage', 'Kelola Hak Akses & Role', 'Role', 'Mengatur permission matriks untuk setiap role.', 1, 230),
                ('settings.manage', 'Kelola Pengaturan Sistem & Auto Alfa', 'Pengaturan', 'Mengubah radius geofence, multi-scan, sistem, dan status Auto Generate Alfa.', 1, 240),
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
                ('default_company', 'YOUR COMPANY', 'Operations Center', 'Your Company Address', 'Asia/Jakarta', datetime('now'));"#,
                vec![],
            ),
            // Seed ID Card Template
            Statement::new(
                r#"INSERT OR IGNORE INTO id_card_template (id, name, orientation, elements_json, is_active, created_at, updated_at) VALUES
                ('default_template', 'Default ID Card Template', 'landscape', ?, 1, datetime('now'), datetime('now'));"#,
                vec![json!(serde_json::to_string(&crate::desktop::operational::default_id_card_elements()).unwrap_or_else(|_| "[]".to_string()))],
            ),
            // Payroll DDL
            Statement::new(
                r#"CREATE TABLE IF NOT EXISTS salary_configs (
                    id TEXT PRIMARY KEY,
                    id_karyawan TEXT NOT NULL,
                    rate_per_hour REAL NOT NULL CHECK (rate_per_hour >= 0),
                    ptkp_status TEXT NOT NULL DEFAULT 'TK/0'
                        CHECK (ptkp_status IN ('TK/0','TK/1','TK/2','TK/3','K/0','K/1','K/2','K/3')),
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
                    rule_type TEXT NOT NULL CHECK (rule_type IN ('HARI_KERJA', 'HARI_LIBUR')),
                    tier_order INTEGER NOT NULL,
                    hour_start REAL NOT NULL CHECK (hour_start >= 0),
                    hour_end REAL,
                    multiplier REAL NOT NULL CHECK (multiplier >= 1.0),
                    is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
                    UNIQUE(rule_type, tier_order)
                );"#,
                vec![],
            ),
            Statement::new(
                r#"CREATE TABLE IF NOT EXISTS payroll_components (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    category TEXT NOT NULL CHECK (category IN ('ALLOWANCE', 'DEDUCTION')),
                    calc_type TEXT NOT NULL CHECK (calc_type IN ('FIXED', 'PERCENTAGE')),
                    default_value REAL NOT NULL DEFAULT 0 CHECK (default_value >= 0),
                    applies_to TEXT NOT NULL DEFAULT 'ALL',
                    is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
                    created_at TEXT NOT NULL DEFAULT (datetime('now'))
                );"#,
                vec![],
            ),
            Statement::new(
                r#"CREATE TABLE IF NOT EXISTS tax_rules (
                    id TEXT PRIMARY KEY,
                    category TEXT NOT NULL CHECK (category IN ('TER_A','TER_B','TER_C','PASAL_17')),
                    bracket_min REAL NOT NULL,
                    bracket_max REAL,
                    rate_percentage REAL NOT NULL CHECK (rate_percentage >= 0),
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
                    rate_percentage REAL NOT NULL CHECK (rate_percentage >= 0),
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
                    status TEXT NOT NULL DEFAULT 'DRAFT'
                        CHECK (status IN ('DRAFT','SUBMITTED','REVIEWED','APPROVED','PAID','REJECTED')),
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
                    total_holiday_hours REAL NOT NULL DEFAULT 0,
                    total_holiday_overtime_index REAL NOT NULL DEFAULT 0,
                    rate_per_hour INTEGER NOT NULL,
                    basic_salary INTEGER NOT NULL CHECK (basic_salary >= 0),
                    overtime_salary INTEGER NOT NULL CHECK (overtime_salary >= 0),
                    gross_salary INTEGER NOT NULL CHECK (gross_salary >= 0),
                    total_allowances INTEGER NOT NULL DEFAULT 0,
                    total_deductions INTEGER NOT NULL DEFAULT 0,
                    bpjs_employee_total INTEGER NOT NULL DEFAULT 0,
                    bpjs_company_total INTEGER NOT NULL DEFAULT 0,
                    pph21_amount INTEGER NOT NULL DEFAULT 0,
                    net_salary INTEGER NOT NULL CHECK (net_salary >= 0),
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
            Statement::new(crate::desktop::payroll_seed::OVERTIME_TIER_RULES_SEED_SQL, vec![]),
            // Seed Default Tax Rules (Pasal 17 & TER Baseline)
            Statement::new(crate::desktop::payroll_seed::TAX_RULES_SEED_SQL, vec![]),
            // Seed Default BPJS Rules
            Statement::new(crate::desktop::payroll_seed::BPJS_RULES_SEED_SQL, vec![]),
            // Seed Schema Migration
            Statement::new(
                r#"INSERT OR IGNORE INTO schema_migration (version, name, applied_at) VALUES
                (10, 'payroll-engine-v1', datetime('now')),
                (11, 'operator-contact-and-password-reset', datetime('now')),
                (12, 'two-factor-totp', datetime('now')),
                (14, 'holiday-whitelist-and-holiday-overtime', datetime('now')),
                (15, 'superadmin-password-recovery-codes', datetime('now'));"#,
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
            // Kontak operator. NULL-able supaya baris operator lama tidak rusak;
            // kewajiban mengisinya ditegakkan di lapisan validasi aplikasi.
            ("master_operator", "email", "ALTER TABLE master_operator ADD COLUMN email TEXT;"),
            ("master_operator", "no_hp", "ALTER TABLE master_operator ADD COLUMN no_hp TEXT;"),
            // Verifikasi dua langkah (schema versi 12).
            ("master_operator", "totp_secret", "ALTER TABLE master_operator ADD COLUMN totp_secret TEXT;"),
            ("master_operator", "totp_enabled", "ALTER TABLE master_operator ADD COLUMN totp_enabled INTEGER NOT NULL DEFAULT 0;"),
            ("master_operator", "totp_confirmed_at", "ALTER TABLE master_operator ADD COLUMN totp_confirmed_at TEXT;"),
            ("master_operator", "totp_recovery_codes", "ALTER TABLE master_operator ADD COLUMN totp_recovery_codes TEXT;"),
            // Kode pemulihan password (schema versi 15). Satu-satunya jalan
            // masuk kembali bagi Superadmin yang lupa passwordnya pada
            // pemasangan tanpa jaringan — di sana tidak ada email yang bisa
            // dikirim, dan tidak ada Superadmin lain yang bisa menyetujui.
            ("master_operator", "password_recovery_codes", "ALTER TABLE master_operator ADD COLUMN password_recovery_codes TEXT;"),
            ("master_operator", "password_recovery_created_at", "ALTER TABLE master_operator ADD COLUMN password_recovery_created_at TEXT;"),
            ("app_role", "require_totp", "ALTER TABLE app_role ADD COLUMN require_totp INTEGER NOT NULL DEFAULT 0;"),
            // Keamanan absensi per role (schema versi 13): foto bukti wajib dan
            // pembatasan alamat IP. Keduanya nonaktif secara bawaan supaya
            // database lama tetap bisa dipakai scan tanpa perubahan apa pun.
            ("app_role", "require_scan_photo", "ALTER TABLE app_role ADD COLUMN require_scan_photo INTEGER NOT NULL DEFAULT 0;"),
            ("app_role", "require_scan_ip_allowlist", "ALTER TABLE app_role ADD COLUMN require_scan_ip_allowlist INTEGER NOT NULL DEFAULT 0;"),
            ("tbl_shift", "izinkan_multi_sesi", "ALTER TABLE tbl_shift ADD COLUMN izinkan_multi_sesi INTEGER NOT NULL DEFAULT 0;"),
            ("tbl_shift", "shift_lanjutan_id", "ALTER TABLE tbl_shift ADD COLUMN shift_lanjutan_id INTEGER NOT NULL DEFAULT 0;"),
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
            // Kolom berikut hanya dibuat jalur provisioning Rust, sehingga
            // database yang lahir dari jalur Web tidak memilikinya. Ditambahkan
            // di sini supaya klien mana pun bisa menyembuhkannya. Nullable:
            // SQLite menolak `ADD COLUMN` dengan default non-konstan seperti
            // `datetime('now')` — hanya `CREATE TABLE` yang mengizinkannya.
            ("tax_rules", "created_at", "ALTER TABLE tax_rules ADD COLUMN created_at TEXT;"),
            ("bpjs_rules", "created_at", "ALTER TABLE bpjs_rules ADD COLUMN created_at TEXT;"),
            ("payroll_components", "created_at", "ALTER TABLE payroll_components ADD COLUMN created_at TEXT;"),
            // Pemisahan jam kerja hari libur (schema versi 14). Database cloud
            // yang sudah ada sudah memiliki payroll_items, sehingga CREATE TABLE
            // IF NOT EXISTS di pipeline tidak akan menambahkan kolomnya.
            ("payroll_items", "total_holiday_hours", "ALTER TABLE payroll_items ADD COLUMN total_holiday_hours REAL NOT NULL DEFAULT 0;"),
            ("payroll_items", "total_holiday_overtime_index", "ALTER TABLE payroll_items ADD COLUMN total_holiday_overtime_index REAL NOT NULL DEFAULT 0;"),
        ] {
            self.ensure_column(table, column, sql).await?;
        }

        // Indeks ini WAJIB dibuat setelah loop di atas, bukan di dalam pipeline
        // DDL. Pada database cloud yang sudah ada, `master_operator` lahir tanpa
        // kolom `email`, sehingga CREATE INDEX di pipeline gagal dengan
        // "no such column: email" — dan karena satu statement gagal membatalkan
        // seluruh pipeline, `ensure_column` yang justru menambahkan kolom itu
        // tidak pernah sempat berjalan. Database lama akan terkunci selamanya.
        self.query_one(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_master_operator_email ON master_operator(LOWER(email)) WHERE email IS NOT NULL AND TRIM(email) <> '';",
            vec![],
        )
        .await?;

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
        self.purge_legacy_rate_rows().await?;
        self.repair_web_owned_tables().await?;
        self.query_one(
            "INSERT OR IGNORE INTO schema_migration (version, name, applied_at) VALUES (-2007, 'tbl-shift-continuation-column-v1', datetime('now'));",
            vec![],
        )
        .await?;
        self.query_one(
            "INSERT OR IGNORE INTO schema_migration (version, name, applied_at) VALUES (-2008, 'operator-contact-and-password-reset-v1', datetime('now'));",
            vec![],
        )
        .await?;
        self.query_one(
            "INSERT OR IGNORE INTO schema_migration (version, name, applied_at) VALUES (-2009, 'two-factor-totp-v1', datetime('now'));",
            vec![],
        )
        .await?;
        self.query_one(
            "INSERT OR IGNORE INTO schema_migration (version, name, applied_at) VALUES (-2010, 'holiday-whitelist-and-holiday-overtime-v1', datetime('now'));",
            vec![],
        )
        .await?;
        self.query_one(
            "INSERT OR IGNORE INTO schema_migration (version, name, applied_at) VALUES (-2011, 'superadmin-password-recovery-codes-v1', datetime('now'));",
            vec![],
        )
        .await?;

        Ok(())
    }

    /// Membangun ulang tabel milik Web yang terlanjur dibuat dengan skema karangan Rust.
    ///
    /// `CREATE TABLE IF NOT EXISTS` tidak memperbaiki tabel yang sudah ada, jadi
    /// database yang pernah di-provisioning dari Desktop/Mobile akan selamanya
    /// memakai kolom yang salah dan membuat login Web gagal. Kedua tabel ini
    /// hanya menyimpan data sementara — sesi login dan penghitung rate limit —
    /// sehingga membangunnya ulang aman: pengguna Web cukup login lagi.
    async fn repair_web_owned_tables(&self) -> Result<(), CommandError> {
        for (table, required_column, create_sql) in [
            (
                "app_session",
                "token_hash",
                r#"CREATE TABLE app_session (
                    session_id TEXT PRIMARY KEY,
                    token_hash TEXT UNIQUE NOT NULL,
                    operator_id INTEGER NOT NULL,
                    permission_revision INTEGER NOT NULL,
                    created_at TEXT NOT NULL,
                    expires_at TEXT NOT NULL,
                    last_seen_at TEXT NOT NULL,
                    revoked_at TEXT,
                    revoked_reason TEXT,
                    user_agent_hash TEXT,
                    FOREIGN KEY (operator_id) REFERENCES master_operator(id) ON DELETE CASCADE
                );"#,
            ),
            (
                "auth_login_rate_limit",
                "rate_key",
                r#"CREATE TABLE auth_login_rate_limit (
                    rate_key TEXT PRIMARY KEY,
                    attempt_count INTEGER NOT NULL,
                    window_started_at TEXT NOT NULL,
                    blocked_until TEXT,
                    updated_at TEXT NOT NULL
                );"#,
            ),
        ] {
            let Ok(info) = self
                .query_one(format!("PRAGMA table_info({table});"), vec![])
                .await
            else {
                continue;
            };
            let rows = info.to_objects();
            // Tabel belum ada: `ensure_schema` di atas sudah membuatnya benar.
            if rows.is_empty() {
                continue;
            }
            let correct = rows.iter().any(|row| {
                row.get("name")
                    .and_then(Value::as_str)
                    .is_some_and(|name| name == required_column)
            });
            if correct {
                continue;
            }
            let _ = self
                .query_one(format!("DROP TABLE IF EXISTS {table};"), vec![])
                .await;
            self.query_one(create_sql, vec![]).await?;
        }
        Ok(())
    }

    /// Menghapus baris tarif hasil seed lokal versi lama yang sempat terdorong ke cloud.
    ///
    /// Seed lokal dulu memakai id bertanda hubung (`tax-p17-1`, `bpjs-jkk`) sedangkan
    /// cloud memakai garis bawah, sehingga backfill outbox menambahkan bracket
    /// PASAL_17 kedua di cloud dan seluruh perangkat menarik tarif dobel itu.
    /// Daftar id sengaja eksplisit supaya tarif buatan admin tidak pernah tersentuh.
    async fn purge_legacy_rate_rows(&self) -> Result<(), CommandError> {
        let placeholders = vec!["?"; crate::desktop::payroll_seed::LEGACY_RATE_IDS.len()].join(", ");
        let args: Vec<Value> = crate::desktop::payroll_seed::LEGACY_RATE_IDS
            .iter()
            .map(|id| json!(id))
            .collect();
        for table in ["tax_rules", "bpjs_rules", "overtime_tier_rules"] {
            let _ = self
                .query_one(
                    format!("DELETE FROM {table} WHERE id IN ({placeholders});"),
                    args.clone(),
                )
                .await;
        }
        // Changelog dan receipt event lama ikut dibuang supaya perangkat yang
        // masih mengantre event tersebut tidak menghidupkannya kembali.
        let _ = self
            .query_one(
                format!("DELETE FROM sync_changelog WHERE domain = 'payroll' AND entity_key IN ({placeholders});"),
                args,
            )
            .await;

        // Konfigurasi koneksi milik satu perangkat pernah ikut terdorong ke cloud
        // lewat "Kirim ulang pengaturan lokal", lalu tertarik oleh perangkat lain.
        let setting_placeholders =
            vec!["?"; crate::desktop::sync::DEVICE_LOCAL_SETTING_KEYS.len()].join(", ");
        let setting_args: Vec<Value> = crate::desktop::sync::DEVICE_LOCAL_SETTING_KEYS
            .iter()
            .map(|key| json!(key))
            .collect();
        let _ = self
            .query_one(
                format!("DELETE FROM setting_gex_system WHERE key IN ({setting_placeholders});"),
                setting_args.clone(),
            )
            .await;
        let _ = self
            .query_one(
                format!("DELETE FROM sync_changelog WHERE domain = 'setting' AND entity_key IN ({setting_placeholders});"),
                setting_args,
            )
            .await;
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

    /// Menjalankan ulang `ensure_schema` tanpa mempedulikan sentinel maupun
    /// cache proses. Dipakai saat push gagal karena kolom/tabel belum ada.
    async fn heal_schema(&self) -> Result<(), CommandError> {
        if let Ok(mut verified) = schema_verified_cache().lock() {
            verified.remove(self.base_url.as_str());
        }
        self.ensure_schema().await?;
        if let Ok(mut verified) = schema_verified_cache().lock() {
            verified.insert(self.base_url.as_str().to_owned());
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
                // Sentinel WAJIB dinaikkan setiap kali ensure_schema menambah
                // tabel atau kolom. Tanpa itu database cloud yang sudah ada
                // dianggap mutakhir dan seluruh ensure_column dilewati, sehingga
                // push gagal dengan "has no column named ...".
                // Sentinel WAJIB dinaikkan setiap kali ensure_schema menambah
                // tabel atau kolom — nilainya di sini dan pada INSERT di atas
                // harus selalu sama.
                "SELECT COUNT(*) AS total FROM schema_migration WHERE version = -2011;",
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
            reachable: true,
            message: None,
        })
    }

    /// Buat Superadmin pertama, lalu terbitkan kode pemulihannya.
    ///
    /// Kode dikembalikan di sini karena inilah satu-satunya saat ia bisa
    /// dibaca: database hanya memegang hash-nya. Akun pertama juga satu-satunya
    /// akun yang tidak punya siapa pun di atasnya untuk menyetujui pemulihan,
    /// sehingga tanpa kode ini sebuah pemasangan tanpa jaringan bisa terkunci
    /// selamanya hanya karena satu password terlupa.
    pub async fn bootstrap_superadmin(
        &self,
        draft: BootstrapSuperadminDraft,
    ) -> Result<Vec<String>, CommandError> {
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
                    kode_operator, nama_operator, username, email, no_hp, password_hash,
                    role, role_id, status, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, 'Admin', ?, 'Aktif', datetime('now'), datetime('now'));"#,
                vec![
                    json!(draft.kode_operator.trim().to_ascii_uppercase()),
                    json!(draft.nama_operator.trim()),
                    json!(draft.username.trim()),
                    json!(normalize_operator_email(&draft.email)),
                    json!(normalize_operator_phone(&draft.no_hp)),
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

        let operator_id = self
            .query_one(
                "SELECT id FROM master_operator WHERE username = ? COLLATE NOCASE LIMIT 1;",
                vec![json!(draft.username.trim())],
            )
            .await?
            .to_objects()
            .into_iter()
            .next()
            .and_then(|row| row.get("id").and_then(Value::as_i64))
            .ok_or_else(|| {
                CommandError::new(
                    "TURSO_BOOTSTRAP_FAILED",
                    "Superadmin awal tidak dapat dibaca kembali.",
                )
            })?;

        self.issue_password_recovery_codes(operator_id).await
    }

    /// Waktu dari jam DATABASE, bukan jam perangkat.
    ///
    /// Kode TOTP yang sah harus diterima sama di Web maupun Desktop. Kalau
    /// masing-masing memakai jamnya sendiri, satu kode bisa lolos di satu
    /// platform dan ditolak di platform lain — dan jam ponsel murah memang
    /// sering meleset. Prinsip yang sama dipakai `time_policy.rs`.
    async fn database_unix_seconds(&self) -> Result<i64, CommandError> {
        self.query_one(
            "SELECT CAST(strftime('%s','now') AS INTEGER) AS now;",
            vec![],
        )
        .await?
        .to_objects()
        .into_iter()
        .next()
        .and_then(|row| row.get("now").and_then(Value::as_i64))
        .ok_or_else(|| CommandError::new("TURSO_QUERY_FAILED", "Jam database tidak dapat dibaca."))
    }

    /// Status 2FA satu operator.
    pub async fn get_two_factor_status(&self, operator_id: i64) -> Result<Value, CommandError> {
        self.ensure_schema_current().await?;
        let row = self.read_operator_totp(operator_id).await?;
        Ok(json!({
            "status": {
                "enabled": row.enabled,
                "confirmedAt": row.confirmed_at,
                "recoveryRemaining": row.recovery_codes.len(),
                "requiredByRole": row.require_totp,
            }
        }))
    }

    async fn read_operator_totp(&self, operator_id: i64) -> Result<OperatorTotp, CommandError> {
        let row = self
            .query_one(
                r#"SELECT COALESCE(m.totp_secret, '') AS totp_secret,
                          COALESCE(m.totp_enabled, 0) AS totp_enabled,
                          COALESCE(m.totp_confirmed_at, '') AS totp_confirmed_at,
                          COALESCE(m.totp_recovery_codes, '[]') AS totp_recovery_codes,
                          m.username,
                          COALESCE(r.require_totp, 0) AS require_totp
                   FROM master_operator m
                   LEFT JOIN app_role r ON r.id = m.role_id
                   WHERE m.id = ? LIMIT 1;"#,
                vec![json!(operator_id)],
            )
            .await?
            .to_objects()
            .into_iter()
            .next()
            .ok_or_else(|| CommandError::new("VALIDATION_ERROR", "Operator tidak ditemukan."))?;
        let text = |key: &str| {
            row.get(key)
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string()
        };
        let recovery_codes: Vec<String> =
            serde_json::from_str(&text("totp_recovery_codes")).unwrap_or_default();
        Ok(OperatorTotp {
            secret: text("totp_secret"),
            enabled: row.get("totp_enabled").and_then(Value::as_i64) == Some(1),
            confirmed_at: text("totp_confirmed_at"),
            recovery_codes,
            username: text("username"),
            require_totp: row.get("require_totp").and_then(Value::as_i64) == Some(1),
        })
    }

    /// Menerbitkan rahasia baru dalam keadaan BELUM aktif.
    pub async fn begin_two_factor_setup(&self, operator_id: i64) -> Result<Value, CommandError> {
        self.ensure_schema_current().await?;
        let row = self.read_operator_totp(operator_id).await?;
        if row.enabled {
            return Err(CommandError::new(
                "VALIDATION_ERROR",
                "Verifikasi dua langkah sudah aktif. Nonaktifkan dulu sebelum mendaftarkan perangkat baru.",
            ));
        }
        let secret = generate_totp_secret();
        self.query_one(
            "UPDATE master_operator SET totp_secret = ?, totp_enabled = 0, totp_confirmed_at = NULL, totp_recovery_codes = NULL WHERE id = ?;",
            vec![json!(secret), json!(operator_id)],
        )
        .await?;
        let label = format!("Absensi SPPG:{}", row.username);
        Ok(json!({
            "setup": {
                "secret": secret,
                "otpauthUri": format!(
                    "otpauth://totp/{}?secret={}&issuer=Absensi%20SPPG&algorithm=SHA1&digits=6&period=30",
                    urlencoding_minimal(&label),
                    secret
                ),
            }
        }))
    }

    /// Mengaktifkan 2FA setelah kode pertama terbukti cocok.
    pub async fn confirm_two_factor_setup(
        &self,
        operator_id: i64,
        code: &str,
    ) -> Result<Value, CommandError> {
        self.ensure_schema_current().await?;
        let row = self.read_operator_totp(operator_id).await?;
        if row.enabled {
            return Err(CommandError::new(
                "VALIDATION_ERROR",
                "Verifikasi dua langkah sudah aktif.",
            ));
        }
        if row.secret.is_empty() {
            return Err(CommandError::new(
                "VALIDATION_ERROR",
                "Pendaftaran belum dimulai. Buka kembali layar pengaturan 2FA.",
            ));
        }
        let now = self.database_unix_seconds().await?;
        if !verify_totp(&row.secret, code, now, TOTP_WINDOW_ONLINE) {
            return Err(CommandError::new(
                "VALIDATION_ERROR",
                "Kode tidak cocok. Pastikan jam ponsel Anda otomatis dan kodenya belum berganti.",
            ));
        }
        let recovery_codes = generate_recovery_codes(8);
        let hashed: Vec<String> = recovery_codes
            .iter()
            .map(|code| sha256_hex(&normalize_recovery_code(code)))
            .collect();
        self.query_one(
            "UPDATE master_operator SET totp_enabled = 1, totp_confirmed_at = datetime('now'), totp_recovery_codes = ? WHERE id = ?;",
            vec![
                json!(serde_json::to_string(&hashed).unwrap_or_else(|_| "[]".to_string())),
                json!(operator_id),
            ],
        )
        .await?;
        Ok(json!({ "recoveryCodes": recovery_codes }))
    }

    /// Mematikan 2FA. `require_proof` benar ketika operator mematikan miliknya
    /// sendiri; Admin yang menolong operator kehilangan ponsel memakai `false`.
    pub async fn disable_two_factor(
        &self,
        operator_id: i64,
        require_proof: bool,
        code: &str,
    ) -> Result<Value, CommandError> {
        self.ensure_schema_current().await?;
        let row = self.read_operator_totp(operator_id).await?;
        if !row.enabled {
            return Err(CommandError::new(
                "VALIDATION_ERROR",
                "Verifikasi dua langkah memang belum aktif.",
            ));
        }
        if require_proof && !self.consume_totp_or_recovery(operator_id, &row, code).await? {
            return Err(CommandError::new(
                "FORBIDDEN",
                "Kode verifikasi tidak cocok.",
            ));
        }
        self.query_one(
            "UPDATE master_operator SET totp_secret = NULL, totp_enabled = 0, totp_confirmed_at = NULL, totp_recovery_codes = NULL WHERE id = ?;",
            vec![json!(operator_id)],
        )
        .await?;
        Ok(json!({ "sukses": true }))
    }

    /// Memeriksa kode TOTP atau kode cadangan; kode cadangan yang cocok
    /// langsung dihapus pada percobaan yang berhasil itu juga.
    async fn consume_totp_or_recovery(
        &self,
        operator_id: i64,
        row: &OperatorTotp,
        code: &str,
    ) -> Result<bool, CommandError> {
        let now = self.database_unix_seconds().await?;
        if verify_totp(&row.secret, code, now, TOTP_WINDOW_ONLINE) {
            return Ok(true);
        }
        let normalized = normalize_recovery_code(code);
        if normalized.len() < 6 {
            return Ok(false);
        }
        let hashed = sha256_hex(&normalized);
        if !row.recovery_codes.iter().any(|item| *item == hashed) {
            return Ok(false);
        }
        let remaining: Vec<&String> = row
            .recovery_codes
            .iter()
            .filter(|item| **item != hashed)
            .collect();
        self.query_one(
            "UPDATE master_operator SET totp_recovery_codes = ? WHERE id = ?;",
            vec![
                json!(serde_json::to_string(&remaining).unwrap_or_else(|_| "[]".to_string())),
                json!(operator_id),
            ],
        )
        .await?;
        Ok(true)
    }

    pub async fn authenticate_operator(
        &self,
        identifier: &str,
        password: &str,
        totp_code: Option<&str>,
    ) -> Result<OperatorUser, CommandError> {
        self.ensure_schema_current().await?;
        let id_clean = identifier.trim();
        let sql = r#"
            SELECT
                m.id, m.kode_operator, m.nama_operator, m.username, m.password_hash,
                m.role_id, r.role_key, r.nama_role, r.is_superadmin,
                COALESCE(m.totp_enabled, 0) AS totp_enabled,
                COALESCE(r.require_scan_photo, 0) AS require_scan_photo,
                COALESCE(r.require_scan_ip_allowlist, 0) AS require_scan_ip_allowlist
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
        // Gerbang 2FA dijalankan SETELAH password terbukti benar. Urutan itu
        // penting: memberi tahu bahwa sebuah akun memakai 2FA sebelum
        // passwordnya benar akan mengubah layar login menjadi alat pemetaan
        // akun mana yang bernilai diserang.
        let totp = self.read_operator_totp(op_id).await?;
        if totp.enabled {
            let code = totp_code.unwrap_or("").trim();
            if code.is_empty() {
                return Err(CommandError::new(
                    "TOTP_REQUIRED",
                    "Masukkan kode 6 digit dari aplikasi autentikator Anda.",
                ));
            }
            if !self.consume_totp_or_recovery(op_id, &totp, code).await? {
                return Err(CommandError::new(
                    "TOTP_INVALID",
                    "Kode verifikasi tidak cocok. Periksa kode terbaru di aplikasi autentikator.",
                ));
            }
        } else if totp.require_totp {
            return Err(CommandError::new(
                "TOTP_ENROLLMENT_REQUIRED",
                "Role akun ini mewajibkan verifikasi dua langkah, tetapi akun Anda belum mendaftarkannya. Hubungi Admin untuk membuka pendaftaran 2FA.",
            ));
        }

        self.hydrate_operator(row, op_id).await
    }

    /// Susun `OperatorUser` lengkap dari satu baris `master_operator` + `app_role`.
    ///
    /// Dipakai bersama oleh login dan pemuatan ulang sesi. Menyalin blok ini ke
    /// dua tempat akan membuat keduanya drift: permission hasil login dan
    /// permission hasil revalidasi harus dihitung dengan aturan yang persis sama.
    async fn hydrate_operator(
        &self,
        row: &HashMap<String, Value>,
        operator_id: i64,
    ) -> Result<OperatorUser, CommandError> {
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

        // Kebijakan keamanan absensi per role. Ikut ke dalam snapshot vault
        // offline supaya perangkat yang login tanpa jaringan tetap menegakkan
        // aturan yang sama — tanpa ini, mode offline menjadi jalan pintas untuk
        // melewati kewajiban foto dan pembatasan IP.
        let role_flag = |key: &str| {
            row.get(key)
                .and_then(|value| value.as_i64().map(|n| n == 1).or_else(|| value.as_bool()))
                .unwrap_or(false)
        };

        Ok(OperatorUser {
            id: operator_id,
            kode_operator,
            nama_operator,
            username,
            role: nama_role,
            role_id,
            role_key,
            is_superadmin,
            permissions,
            permission_revision,
            require_scan_photo: role_flag("require_scan_photo"),
            require_scan_ip_allowlist: role_flag("require_scan_ip_allowlist"),
            // Penanda akun, bukan penanda role — dibaca dengan closure yang sama
            // karena keduanya sama-sama kolom integer 0/1 pada baris ini.
            totp_enabled: role_flag("totp_enabled"),
            login_at: Some(chrono_like_now_iso()),
        })
    }

    /// Muat ulang status dan permission operator yang sedang memegang sesi.
    ///
    /// `Ok(None)` berarti operator sudah dihapus, dinonaktifkan, atau role-nya
    /// dimatikan di cloud — sesi perangkat WAJIB dicabut. Kegagalan jaringan
    /// tetap dikembalikan sebagai `Err` supaya sesi tidak pernah dicabut hanya
    /// karena koneksi sedang terganggu; itu akan membuat perangkat lapangan
    /// terlempar keluar setiap kali sinyal turun.
    pub async fn reload_operator(
        &self,
        operator_id: i64,
    ) -> Result<Option<OperatorUser>, CommandError> {
        let sql = r#"
            SELECT
                m.id, m.kode_operator, m.nama_operator, m.username,
                m.role_id, r.role_key, r.nama_role, r.is_superadmin,
                COALESCE(m.totp_enabled, 0) AS totp_enabled,
                COALESCE(r.require_scan_photo, 0) AS require_scan_photo,
                COALESCE(r.require_scan_ip_allowlist, 0) AS require_scan_ip_allowlist
            FROM master_operator m
            JOIN app_role r ON r.id = m.role_id
            WHERE m.id = ? AND m.status = 'Aktif' AND r.status = 'Aktif'
            LIMIT 1;
        "#;
        let result = self.query_one(sql, vec![json!(operator_id)]).await?;
        let objects = result.to_objects();
        let Some(row) = objects.first() else {
            return Ok(None);
        };
        self.hydrate_operator(row, operator_id).await.map(Some)
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

        // Kondisi absensi cloud untuk seluruh batch, satu query. Dipakai menegakkan
        // hierarki prioritas dan konkurensi optimistis sebelum baris ditimpa.
        let mut attendance_guard: HashMap<String, AttendanceGuardRow> = HashMap::new();
        let guarded_sessions: Vec<String> = events
            .iter()
            .filter_map(|event| {
                let domain = event.get("domain").and_then(Value::as_str)?;
                let operation = event.get("operation").and_then(Value::as_str)?;
                let (domain, operation) = canonical_sync_route(domain, operation)?;
                let payload = event
                    .get("payload")
                    .or_else(|| event.get("payload_json"))
                    .or_else(|| event.get("payloadJson"))?;
                attendance_session_of(domain, operation, payload)
            })
            .collect::<HashSet<_>>()
            .into_iter()
            .collect();
        if !guarded_sessions.is_empty() {
            let placeholders = vec!["?"; guarded_sessions.len()].join(", ");
            let result = self
                .query_one(
                    format!(
                        "SELECT id_sesi, sumber, update_terakhir, COALESCE(jam_masuk, '') AS jam_masuk, COALESCE(jam_pulang, '') AS jam_pulang, COALESCE(status_kehadiran, '') AS status_kehadiran FROM absensi_harian WHERE id_sesi IN ({placeholders});"
                    ),
                    guarded_sessions.iter().map(|id| json!(id)).collect(),
                )
                .await?;
            for row in result.to_objects() {
                let Some(id_sesi) = row.get("id_sesi").and_then(Value::as_str) else {
                    continue;
                };
                attendance_guard.insert(
                    id_sesi.to_owned(),
                    AttendanceGuardRow {
                        sumber: row
                            .get("sumber")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_owned(),
                        update_terakhir: row
                            .get("update_terakhir")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_owned(),
                        jam_masuk: row
                            .get("jam_masuk")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_owned(),
                        jam_pulang: row
                            .get("jam_pulang")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_owned(),
                        status_kehadiran: row
                            .get("status_kehadiran")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_owned(),
                    },
                );
            }
        }

        // Revisi server yang dihasilkan event-event SEBELUMNYA di batch ini,
        // per (domain kanonik, entity_key).
        //
        // `base_revision` sebuah event dibekukan saat event DIBUAT, bukan saat
        // dikirim. Dua event yang menyentuh entitas sama dan lahir sebelum
        // siklus push berikutnya — mis. hapus scan Masuk (attendance/update)
        // lalu hapus scan Pulang (attendance/delete) pada sesi absensi yang
        // sama — membuat event kedua tiba membawa revisi yang sudah usang
        // begitu event pertama diterapkan. Cloud lalu menolaknya sebagai
        // konflik yang TIDAK pernah bisa selesai: perangkat asal sudah
        // menghapus barisnya secara lokal, sementara cloud dan setiap
        // perangkat lain menyimpannya selamanya. Basis yang benar untuk event
        // kedua adalah hasil event pertama, bukan angka beku saat enqueue.
        let mut batch_revisions: HashMap<(String, String), i64> = HashMap::new();

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

            // Basis optimistic-concurrency diperbarui bila entitas yang sama
            // sudah dimajukan oleh event sebelumnya di batch ini.
            let base_revision = batch_revisions
                .get(&(domain.to_owned(), entity_key.to_owned()))
                .copied()
                .or(base_revision);

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
                    batch_revisions.insert(
                        (domain.to_owned(), entity_key.to_owned()),
                        previous_revision,
                    );
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

            // Guard absensi dijalankan SEBELUM mutasi disusun, meniru urutan yang
            // sudah dipakai jalur Web di `sync-push.ts`.
            if let Err(error) = assert_attendance_precondition(
                domain,
                operation,
                &parsed_payload,
                attendance_session_of(domain, operation, &parsed_payload)
                    .and_then(|id_sesi| attendance_guard.get(&id_sesi)),
            ) {
                push_results.push(json!({
                    "eventId": event_id,
                    "status": "conflict",
                    "reason": error.message.clone(),
                    "message": error.message,
                    "serverRevision": 0
                }));
                continue;
            }

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
                    'applied', ?, ?, 0, ?, datetime('now'), datetime('now'));"#,
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
                ],
            ));

            // Statement disalin dulu supaya batch yang sama bisa diulang setelah
            // skema disembuhkan; `execute_atomic` mengonsumsi vektornya.
            let retry_statements = transaction_statements.clone();
            let mut atomic_result = self.execute_atomic(transaction_statements).await;
            if let Err(error) = &atomic_result {
                if is_recoverable_schema_error(&error.message) {
                    match self.heal_schema().await {
                        Ok(()) => {
                            atomic_result = self.execute_atomic(retry_statements).await;
                        }
                        Err(heal_error) => {
                            atomic_result = Err(heal_error);
                        }
                    }
                }
            }
            if let Err(error) = atomic_result {
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
            batch_revisions.insert((domain.to_owned(), entity_key.to_owned()), server_revision);
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
                COALESCE(m.email, '') AS email,
                COALESCE(m.no_hp, '') AS no_hp,
                COALESCE(m.totp_enabled, 0) AS totp_enabled,
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
        let email = normalize_operator_email(
            draft.get("email").and_then(Value::as_str).unwrap_or(""),
        );
        let no_hp = normalize_operator_phone(
            draft.get("no_hp").and_then(Value::as_str).unwrap_or(""),
        );

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
        validate_operator_contact(&email, &no_hp)?;

        let role_row = self
            .query_one(
                "SELECT is_superadmin, status FROM app_role WHERE id = ? LIMIT 1;",
                vec![json!(role_id)],
            )
            .await?
            .to_objects()
            .into_iter()
            .next();

        match role_row {
            Some(row) => {
                if row.get("status").and_then(Value::as_str) != Some("Aktif") {
                    return Err(CommandError::new(
                        "VALIDATION_ERROR",
                        "Role tujuan sedang nonaktif.",
                    ));
                }
                if row.get("is_superadmin").and_then(Value::as_i64) == Some(1) {
                    return Err(CommandError::new(
                        "FORBIDDEN",
                        "Role Superadmin tidak dapat ditambahkan secara manual.",
                    ));
                }
            }
            None => {
                return Err(CommandError::new(
                    "VALIDATION_ERROR",
                    "Role tujuan tidak ditemukan.",
                ));
            }
        }

        let password_hash = hash_password_pbkdf2(password);

        // Kolom warisan `role` WAJIB diisi: pada database yang di-provisioning
        // dari Web ia `NOT NULL` dengan CHECK ('Admin','Operator','Scanner') dan
        // tanpa DEFAULT, sehingga INSERT tanpa `role` selalu ditolak. Nilainya
        // diturunkan dari `app_role` agar tetap konsisten dengan RBAC.
        let sql = r#"
            INSERT INTO master_operator (
                kode_operator, nama_operator, username, email, no_hp, password_hash,
                role, role_id, status, created_at, updated_at
            )
            VALUES (
                ?, ?, ?, ?, ?, ?,
                COALESCE((
                    SELECT CASE
                        WHEN r.is_superadmin = 1 THEN 'Admin'
                        WHEN LOWER(r.role_key) = 'admin' THEN 'Admin'
                        WHEN LOWER(r.role_key) = 'scanner' THEN 'Scanner'
                        ELSE 'Operator'
                    END FROM app_role r WHERE r.id = ?
                ), 'Operator'),
                ?, ?, datetime('now'), datetime('now')
            );
        "#;

        let res = self
            .query_one(
                sql,
                vec![
                    json!(kode_operator),
                    json!(nama_operator),
                    json!(username),
                    json!(email),
                    json!(no_hp),
                    json!(password_hash),
                    json!(role_id),
                    json!(role_id),
                    json!(status),
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
                "email": email,
                "no_hp": no_hp,
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
        } else if let Some(next_role_id) = draft.get("role_id").and_then(Value::as_i64) {
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
            if next_is_superadmin {
                return Err(CommandError::new(
                    "FORBIDDEN",
                    "Operator tidak dapat dinaikkan menjadi Superadmin.",
                ));
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
        // Kontak hanya divalidasi ketika formulir benar-benar mengirimkannya,
        // supaya pemanggil yang hanya mengubah status/role tidak dipaksa
        // mengirim ulang seluruh data akun.
        let next_email = draft
            .get("email")
            .and_then(Value::as_str)
            .map(normalize_operator_email);
        let next_phone = draft
            .get("no_hp")
            .and_then(Value::as_str)
            .map(normalize_operator_phone);
        if next_email.is_some() || next_phone.is_some() {
            let stored = self
                .query_one(
                    "SELECT COALESCE(email, '') AS email, COALESCE(no_hp, '') AS no_hp FROM master_operator WHERE id = ? LIMIT 1;",
                    vec![json!(id)],
                )
                .await?
                .to_objects()
                .into_iter()
                .next()
                .unwrap_or_default();
            let email = next_email.clone().unwrap_or_else(|| {
                stored
                    .get("email")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string()
            });
            let phone = next_phone.clone().unwrap_or_else(|| {
                stored
                    .get("no_hp")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string()
            });
            validate_operator_contact(&email, &phone)?;
            if let Some(email) = next_email {
                updates.push("email = ?");
                args.push(json!(email));
            }
            if let Some(phone) = next_phone {
                updates.push("no_hp = ?");
                args.push(json!(phone));
            }
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
}

/// Fakta yang menentukan boleh-tidaknya sebuah operator dihapus.
///
/// Dikumpulkan lewat query, lalu diputuskan oleh `assert_operator_deletable`
/// yang murni. Pemisahan ini bukan gaya-gayaan: aturannya harus sama persis
/// dengan `removeOperator` di `src/lib/operators/operator-admin.ts`, dan
/// satu-satunya cara membuktikannya tanpa database hidup adalah menguji
/// keputusannya sebagai fungsi biasa.
#[derive(Clone, Copy, Debug, Default)]
pub struct OperatorDeleteFacts {
    pub actor_id: i64,
    pub target_id: i64,
    pub target_exists: bool,
    pub target_is_superadmin: bool,
    pub target_is_active: bool,
    pub active_superadmin_count: i64,
    /// Jumlah baris log scan, koreksi admin, penugasan backup, dan audit role
    /// yang menunjuk kode operator ini.
    pub transaction_references: i64,
    /// Jumlah pengajuan "Lupa Password" milik operator ini.
    pub reset_history: i64,
}

/// Urutan pemeriksaan sengaja mengikuti jalur Web supaya pesan yang muncul
/// untuk satu keadaan selalu sama di Web, Desktop, dan Mobile.
pub fn assert_operator_deletable(facts: &OperatorDeleteFacts) -> Result<(), CommandError> {
    if facts.actor_id != 0 && facts.actor_id == facts.target_id {
        return Err(CommandError::new(
            "FORBIDDEN",
            "Akun yang sedang digunakan tidak dapat dihapus.",
        ));
    }
    if !facts.target_exists {
        return Err(CommandError::new(
            "VALIDATION_ERROR",
            "Operator tidak ditemukan.",
        ));
    }
    // Yang dilarang adalah menghabiskan Superadmin aktif TERAKHIR, bukan
    // menghapus Superadmin mana pun. Superadmin kedua yang terlanjur dibuat
    // tetap harus bisa dirapikan.
    if facts.target_is_superadmin && facts.target_is_active && facts.active_superadmin_count <= 1 {
        return Err(CommandError::new(
            "FORBIDDEN",
            "Superadmin aktif terakhir tidak dapat dihapus.",
        ));
    }
    if facts.transaction_references > 0 {
        return Err(CommandError::new(
            "FORBIDDEN",
            "Operator memiliki histori transaksi. Nonaktifkan akun agar audit tetap utuh.",
        ));
    }
    // `password_reset_request` ber-CASCADE ke `master_operator`, jadi DELETE di
    // sini ikut memusnahkan riwayat pengajuan reset beserta foto wajah
    // pemohonnya — bukti audit yang justru paling perlu bertahan.
    if facts.reset_history > 0 {
        return Err(CommandError::new(
            "FORBIDDEN",
            "Operator memiliki riwayat pengajuan reset password beserta foto verifikasinya. Hapus riwayat itu lebih dulu di halaman Riwayat Reset Password, atau nonaktifkan akun agar bukti audit tetap utuh.",
        ));
    }
    Ok(())
}

impl TursoClient {
    /// Mengumpulkan fakta penghapusan operator dari database.
    async fn operator_delete_facts(
        &self,
        actor_id: i64,
        id: i64,
    ) -> Result<OperatorDeleteFacts, CommandError> {
        let mut facts = OperatorDeleteFacts {
            actor_id,
            target_id: id,
            ..Default::default()
        };

        let target = self
            .query_one(
                r#"SELECT m.kode_operator, COALESCE(m.status, 'Aktif') AS status,
                          COALESCE(r.is_superadmin, 0) AS is_superadmin
                   FROM master_operator m
                   JOIN app_role r ON r.id = m.role_id
                   WHERE m.id = ? LIMIT 1;"#,
                vec![json!(id)],
            )
            .await?
            .to_objects()
            .into_iter()
            .next();
        let Some(target) = target else {
            return Ok(facts);
        };
        facts.target_exists = true;
        facts.target_is_superadmin =
            target.get("is_superadmin").and_then(Value::as_i64) == Some(1);
        facts.target_is_active = target.get("status").and_then(Value::as_str) == Some("Aktif");
        let kode = target
            .get("kode_operator")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();

        let count_of = |result: QueryResult| {
            result
                .to_objects()
                .into_iter()
                .next()
                .and_then(|row| row.get("total").and_then(Value::as_i64))
                .unwrap_or(0)
        };

        facts.active_superadmin_count = count_of(
            self.query_one(
                r#"SELECT COUNT(*) AS total
                   FROM master_operator m JOIN app_role r ON r.id = m.role_id
                   WHERE m.status = 'Aktif' AND r.is_superadmin = 1;"#,
                vec![],
            )
            .await?,
        );

        facts.transaction_references = count_of(
            self.query_one(
                r#"SELECT
                     (SELECT COUNT(*) FROM log_scan WHERE kode_operator = ?)
                   + (SELECT COUNT(*) FROM koreksi_admin WHERE kode_operator = ?)
                   + (SELECT COUNT(*) FROM backup_karyawan WHERE kode_operator = ? OR operator_pembatalan = ?)
                   + (SELECT COUNT(*) FROM role_permission_audit WHERE changed_by = ?) AS total;"#,
                vec![
                    json!(kode),
                    json!(kode),
                    json!(kode),
                    json!(kode),
                    json!(kode),
                ],
            )
            .await?,
        );

        facts.reset_history = count_of(
            self.query_one(
                "SELECT COUNT(*) AS total FROM password_reset_request WHERE operator_id = ?;",
                vec![json!(id)],
            )
            .await?,
        );

        Ok(facts)
    }

    pub async fn delete_operator(&self, actor_id: i64, id: i64) -> Result<Value, CommandError> {
        self.ensure_schema_current().await?;
        let facts = self.operator_delete_facts(actor_id, id).await?;
        assert_operator_deletable(&facts)?;

        self.query_one("DELETE FROM master_operator WHERE id = ?;", vec![json!(id)])
            .await?;
        Ok(json!({ "sukses": true }))
    }

    pub async fn get_roles(&self) -> Result<Value, CommandError> {
        self.ensure_schema_current().await?;
        let roles_sql = "SELECT id, role_key, nama_role, deskripsi, is_superadmin, status, COALESCE(require_totp, 0) AS require_totp, COALESCE(require_scan_photo, 0) AS require_scan_photo, COALESCE(require_scan_ip_allowlist, 0) AS require_scan_ip_allowlist FROM app_role ORDER BY id ASC;";
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
        let is_superadmin = target.get("is_superadmin").and_then(Value::as_i64) == Some(1);
        if is_superadmin
            && (draft.get("nama_role").is_some()
                || draft.get("deskripsi").is_some()
                || draft.get("status").is_some())
        {
            return Err(CommandError::new(
                "FORBIDDEN",
                "Nama, deskripsi, dan status role Superadmin tidak dapat diubah.",
            ));
        }
        let mut updates = Vec::new();
        let mut args = Vec::new();

        // Sakelar wajib-2FA per role. Dikirim eksplisit oleh formulir, jadi
        // ketiadaannya berarti "jangan ubah", bukan "matikan".
        if let Some(require_totp) = draft.get("require_totp").and_then(Value::as_bool) {
            updates.push("require_totp = ?");
            args.push(json!(if require_totp { 1 } else { 0 }));
        }
        // Sakelar keamanan absensi per role, dengan aturan "absen = jangan ubah"
        // yang sama seperti require_totp di atas.
        if let Some(require_photo) = draft.get("require_scan_photo").and_then(Value::as_bool) {
            updates.push("require_scan_photo = ?");
            args.push(json!(if require_photo { 1 } else { 0 }));
        }
        if let Some(require_ip) = draft
            .get("require_scan_ip_allowlist")
            .and_then(Value::as_bool)
        {
            updates.push("require_scan_ip_allowlist = ?");
            args.push(json!(if require_ip { 1 } else { 0 }));
        }
        if !is_superadmin {
            if let Some(nama) = draft.get("nama_role").and_then(Value::as_str) {
                updates.push("nama_role = ?");
                args.push(json!(nama.trim()));
            }
            if let Some(deskripsi) = draft.get("deskripsi").and_then(Value::as_str) {
                updates.push("deskripsi = ?");
                args.push(json!(deskripsi));
            }
        }

        if !updates.is_empty() {
            updates.push("updated_at = datetime('now')");
            args.push(json!(role_id));
            let sql = format!("UPDATE app_role SET {} WHERE id = ?;", updates.join(", "));
            self.query_one(&sql, args).await?;
            // Sesi yang sedang berjalan hanya dimuat ulang ketika angka ini
            // berubah. Tanpa kenaikan di sini, sakelar keamanan absensi yang
            // baru diatur baru berlaku setelah operatornya logout.
            self.query_one(
                r#"INSERT INTO setting_gex_system (key, value) VALUES ('rbac_revision', '2')
                   ON CONFLICT(key) DO UPDATE SET
                     value = CAST(CAST(setting_gex_system.value AS INTEGER) + 1 AS TEXT);"#,
                vec![],
            )
            .await?;
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
        ("holiday-whitelist" | "holiday_whitelist", "create") => ("holiday-whitelist", "create"),
        ("holiday-whitelist" | "holiday_whitelist", "update") => ("holiday-whitelist", "update"),
        ("holiday-whitelist" | "holiday_whitelist", "delete") => ("holiday-whitelist", "delete"),
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

/// Kondisi baris absensi cloud saat batch push dimulai.
struct AttendanceGuardRow {
    sumber: String,
    update_terakhir: String,
    jam_masuk: String,
    jam_pulang: String,
    status_kehadiran: String,
}

/// `id_sesi` absensi yang disentuh sebuah event, bila event-nya memang menulis absensi.
fn attendance_session_of(domain: &str, operation: &str, payload: &Value) -> Option<String> {
    let touches_attendance = matches!(
        (domain, operation),
        ("attendance", "scan") | ("correction", "create") | ("offline-import", "row")
    );
    if !touches_attendance {
        return None;
    }
    payload
        .get("attendance")
        .and_then(|attendance| attendance.get("id_sesi"))
        .and_then(Value::as_str)
        .filter(|id_sesi| !id_sesi.is_empty())
        .map(str::to_owned)
}

/// Menegakkan hierarki prioritas absensi dan pemeriksaan konkurensi optimistis.
///
/// Jalur HTTP Web sudah melakukan ini di `sync-push.ts`, tetapi jalur Turso
/// 2-tier — yang justru dipakai Desktop dan Mobile — dulu menimpa `absensi_harian`
/// tanpa syarat. Akibatnya scan terminal yang datang belakangan bisa menghapus
/// Koreksi Admin, dan dua perangkat yang menyunting sesi yang sama saling
/// menimpa diam-diam. `attendanceBaseUpdatedAt` sudah dikirim client dan
/// divalidasi `sync-schema.ts`, hanya tidak pernah dibaca di sini.
fn assert_attendance_precondition(
    domain: &str,
    operation: &str,
    payload: &Value,
    current: Option<&AttendanceGuardRow>,
) -> Result<(), CommandError> {
    if attendance_session_of(domain, operation, payload).is_none() {
        return Ok(());
    }
    if let Some(row) = current {
        if row.sumber == "Koreksi Admin" && domain != "correction" {
            // Perlindungan berlaku pada KOLOM yang benar-benar diisi admin,
            // bukan seluruh baris. Scan pulang yang hanya mengisi jam_pulang
            // kosong tidak menimpa keputusan admin apa pun; dulu ia ikut
            // ditolak sehingga karyawan yang jam masuknya dikoreksi tidak
            // pernah bisa menyelesaikan absensinya lewat scanner.
            let attendance = payload.get("attendance");
            let masuk_baru = attendance
                .and_then(|value| value.get("jam_masuk"))
                .and_then(Value::as_str)
                .unwrap_or_default();
            let pulang_baru = attendance
                .and_then(|value| value.get("jam_pulang"))
                .and_then(Value::as_str)
                .unwrap_or_default();
            let menimpa = |tersimpan: &str, baru: &str| !tersimpan.is_empty() && tersimpan != baru;
            // Koreksi Sakit/Izin/Dispen/Alfa sengaja MENGOSONGKAN kedua jam.
            // Aturan "boleh mengisi kolom kosong" saja akan membuat scan
            // menghidupkan kembali baris itu menjadi Hadir dan menghapus
            // keputusan ketidakhadiran dari admin.
            let keputusan_ketidakhadiran = row.status_kehadiran != "Hadir";
            if keputusan_ketidakhadiran
                || menimpa(&row.jam_masuk, masuk_baru)
                || menimpa(&row.jam_pulang, pulang_baru)
            {
                return Err(CommandError::new(
                    "TURSO_SYNC_ATTENDANCE_PROTECTED",
                    "Data absensi sudah dikoreksi admin dan tidak boleh ditimpa sumber lain.",
                ));
            }
        }
    }
    // Operator sudah menyatakan "Gunakan Versi Lokal" untuk konflik ini.
    // Tanpa jalan keluar ini konfliknya abadi: payload tetap membawa
    // `attendanceBaseUpdatedAt` lama, jadi setiap percobaan ulang ditolak lagi
    // dengan pesan yang sama dan operator tidak punya cara menyelesaikannya.
    if payload
        .get("forceLocalOverride")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return Ok(());
    }

    let base = payload
        .get("attendanceBaseUpdatedAt")
        .and_then(Value::as_str)
        .unwrap_or("");
    let stale = match current {
        Some(row) => base.is_empty() || row.update_terakhir != base,
        None => !base.is_empty(),
    };
    if stale {
        return Err(CommandError::new(
            "TURSO_SYNC_ATTENDANCE_STALE",
            "Data absensi server berubah setelah event lokal dibuat.",
        ));
    }
    Ok(())
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
                    offset_generate_alfa, buffer_shift_malam_menit, izinkan_multi_sesi,
                    shift_lanjutan_id
                ) VALUES ((SELECT id_shift FROM tbl_shift WHERE kode_shift = ?), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
                    izinkan_multi_sesi = excluded.izinkan_multi_sesi,
                    shift_lanjutan_id = excluded.shift_lanjutan_id;
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
                        json!(row
                            .get("shift_lanjutan_id")
                            .and_then(Value::as_i64)
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
        ("holiday-whitelist", "create" | "update") => {
            let row = payload.get("whitelist").unwrap_or(payload);
            let id = row
                .get("id")
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
                .unwrap_or(entity_key);
            let scope_type = row
                .get("scope_type")
                .and_then(Value::as_str)
                .and_then(scanner::normalize_whitelist_scope_type);
            let scope_value = scope_type.and_then(|scope| {
                row.get("scope_value")
                    .and_then(Value::as_str)
                    .and_then(|raw| scanner::normalize_whitelist_scope_value(scope, raw))
            });

            // Baris yang cakupannya tidak sah DIABAIKAN, bukan ditulis apa
            // adanya: whitelist yang berisi entri sampah tidak pernah cocok
            // dengan siapa pun, jadi menyimpannya hanya menyisakan baris mati
            // yang membingungkan admin.
            if let (Some(scope), Some(value)) = (scope_type, scope_value) {
                if !id.trim().is_empty() {
                    let tanggal_libur = scanner::normalize_holiday_date(
                        row.get("tanggal_libur").and_then(Value::as_str),
                    );
                    let status_aktif = match row.get("status_aktif").and_then(Value::as_i64) {
                        Some(0) => 0,
                        _ => 1,
                    };
                    turso
                        .query_one(
                            r#"INSERT INTO hari_libur_whitelist (
                                id, scope_type, scope_value, tanggal_libur, keterangan,
                                status_aktif, created_at, updated_at
                            ) VALUES (?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')), COALESCE(?, datetime('now')))
                            ON CONFLICT(id) DO UPDATE SET
                                scope_type = excluded.scope_type,
                                scope_value = excluded.scope_value,
                                tanggal_libur = excluded.tanggal_libur,
                                keterangan = excluded.keterangan,
                                status_aktif = excluded.status_aktif,
                                updated_at = excluded.updated_at;"#,
                            vec![
                                json!(id),
                                json!(scope),
                                json!(value),
                                json!(tanggal_libur),
                                json!(row.get("keterangan").and_then(Value::as_str)),
                                json!(status_aktif),
                                json!(row.get("created_at").and_then(Value::as_str)),
                                json!(row.get("updated_at").and_then(Value::as_str)),
                            ],
                        )
                        .await?;
                }
            }
        }
        ("holiday-whitelist", "delete") => {
            let id = payload
                .get("id")
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
                .unwrap_or(entity_key);
            if !id.trim().is_empty() {
                turso
                    .query_one(
                        "DELETE FROM hari_libur_whitelist WHERE id = ?;",
                        vec![json!(id)],
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

            // 2. Foto bukti absensi, bila terminal mengirimkannya. Idempoten:
            // event yang sama di-push ulang tidak menggandakan barisnya.
            if let Some(photo) = payload.get("photo").filter(|value| !value.is_null()) {
                let id_foto = photo.get("id_foto").and_then(Value::as_str).unwrap_or("");
                let foto_base64 = photo
                    .get("foto_base64")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                if !id_foto.is_empty() && !foto_base64.is_empty() {
                    let text = |key: &str| {
                        json!(photo.get(key).and_then(Value::as_str).unwrap_or(""))
                    };
                    turso
                        .query_one(
                            r#"INSERT INTO absensi_foto (
                                id_foto, id_sesi, tanggal_kerja, id_karyawan, nama, divisi,
                                jenis_scan, timestamp_scan, sumber_data, kode_operator,
                                ip_perangkat, client_id, foto_mime, foto_base64, created_at
                            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                            ON CONFLICT(id_foto) DO NOTHING;"#,
                            vec![
                                json!(id_foto),
                                text("id_sesi"),
                                text("tanggal_kerja"),
                                text("id_karyawan"),
                                text("nama"),
                                text("divisi"),
                                text("jenis_scan"),
                                text("timestamp_scan"),
                                json!(photo
                                    .get("sumber_data")
                                    .and_then(Value::as_str)
                                    .unwrap_or("Scanner")),
                                text("kode_operator"),
                                text("ip_perangkat"),
                                text("client_id"),
                                json!(photo
                                    .get("foto_mime")
                                    .and_then(Value::as_str)
                                    .unwrap_or("image/jpeg")),
                                json!(foto_base64),
                                text("created_at"),
                            ],
                        )
                        .await?;
                }
            }

            // 3. Terapkan absensi_harian jika ada
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


/// Umur satu permintaan sebelum verifikasi wajah selesai (menit).
/// Penggantian tantangan yang boleh diminta satu permintaan reset.
/// WAJIB sama dengan MAX_CHALLENGE_SWAPS di
/// src/lib/server/auth/password-reset.ts.
/// Kegagalan pengiriman email: pesan aman untuk pemohon, dan penjelasan apa
/// adanya dari penyedia untuk pemegang izin.
struct MailFailure {
    message: String,
    detail: String,
}

const RESET_MAX_CHALLENGE_SWAPS: i64 = 2;
const RESET_CHALLENGE_TTL_MINUTES: i64 = 15;
/// Umur token reset setelah email terkirim (menit).
const RESET_TOKEN_TTL_MINUTES: i64 = 30;
/// Ambang skor liveness. WAJIB sama dengan LIVENESS_MIN_SCORE di
/// src/lib/security/face-liveness.ts.
const RESET_LIVENESS_MIN_SCORE: f64 = 0.7;
/// Batas ukuran foto bukti dalam base64.
const RESET_PHOTO_MAX_LEN: usize = 900_000;

/// Token acak 32 byte, base64url tanpa padding. Yang disimpan hanya hash
/// SHA-256-nya, sama seperti `hashSessionToken` di sisi TypeScript.
fn random_reset_token() -> String {
    use rand_core::{OsRng, RngCore};
    let mut bytes = [0u8; 32];
    OsRng.fill_bytes(&mut bytes);
    BASE64_URL_SAFE_NO_PAD.encode(bytes)
}

fn random_request_id() -> String {
    use rand_core::{OsRng, RngCore};
    let mut bytes = [0u8; 16];
    OsRng.fill_bytes(&mut bytes);
    hex::encode(bytes)
}

fn sha256_hex(value: &str) -> String {
    hex::encode(Sha256::digest(value.as_bytes()))
}

/// Memilih urutan tantangan liveness secara acak di sisi server.
///
/// Urutan ini disimpan di database dan tidak pernah bisa ditebak klien, jadi
/// rekaman verifikasi lama tidak bisa dipakai ulang untuk permintaan baru.
fn pick_reset_challenges() -> Vec<String> {
    use rand_core::{OsRng, RngCore};
    let mut pool = vec![
        "KEDIP".to_string(),
        "TENGOK_KIRI".to_string(),
        "TENGOK_KANAN".to_string(),
        "DEKATKAN_WAJAH".to_string(),
        "JAUHKAN_WAJAH".to_string(),
    ];
    let mut picked = Vec::with_capacity(3);
    for _ in 0..3 {
        if pool.is_empty() {
            break;
        }
        let index = (OsRng.next_u32() as usize) % pool.len();
        picked.push(pool.remove(index));
    }
    picked
}

/// Membaca `liveness_report` menjadi alasan + daftar tantangan.
///
/// Kolom itu ditulis dua penulis berbeda — TypeScript menyimpan vonis lengkap,
/// Rust menyimpan vonis yang dikirim aplikasi — jadi pembacanya harus
/// memaafkan bentuk yang tidak dikenal. Riwayat tetap berguna walau satu baris
/// lamanya tidak bisa diurai.
fn parse_liveness_report(raw: &str) -> (String, Vec<String>) {
    let Ok(parsed) = serde_json::from_str::<Value>(raw) else {
        return (String::new(), Vec::new());
    };
    let reason = parsed
        .get("reason")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let challenges = parsed
        .get("challenges")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    item.as_str()
                        .map(str::to_string)
                        .or_else(|| {
                            item.get("challenge")
                                .and_then(Value::as_str)
                                .map(str::to_string)
                        })
                })
                .collect()
        })
        .unwrap_or_default();
    (reason, challenges)
}

fn reset_error(message: impl Into<String>) -> CommandError {
    CommandError::new("PASSWORD_RESET_REJECTED", message)
}

/// Kekuatan password baru. Cerminan `validatePasswordStrength` di
/// `src/lib/auth/password.ts` supaya aturan yang sama berlaku di kedua jalur.
fn validate_new_password(password: &str) -> Result<(), CommandError> {
    if password.chars().count() < 12 {
        return Err(reset_error("Password minimal 12 karakter."));
    }
    if !password.chars().any(char::is_lowercase) || !password.chars().any(char::is_uppercase) {
        return Err(reset_error(
            "Password harus memiliki huruf kecil dan huruf besar.",
        ));
    }
    if !password.chars().any(|item| item.is_ascii_digit()) {
        return Err(reset_error("Password harus memiliki angka."));
    }
    Ok(())
}

impl TursoClient {
    /// Mencari akun yang boleh dipulihkan dari username, kode operator, atau email.
    async fn find_reset_operator(
        &self,
        identifier: &str,
    ) -> Result<Option<HashMap<String, Value>>, CommandError> {
        let clean = identifier.trim();
        if clean.len() < 3 || clean.len() > 120 {
            return Ok(None);
        }
        let email = normalize_operator_email(clean);
        let sql = r#"
            SELECT m.id, m.nama_operator, m.kode_operator, m.username,
                   COALESCE(m.email, '') AS email, COALESCE(m.no_hp, '') AS no_hp
            FROM master_operator m
            JOIN app_role r ON r.id = m.role_id
            WHERE (
                m.username = ? COLLATE NOCASE
                OR m.kode_operator = ? COLLATE NOCASE
                OR LOWER(COALESCE(m.email, '')) = ?
            )
            AND m.status = 'Aktif' AND r.status = 'Aktif'
            LIMIT 1;
        "#;
        Ok(self
            .query_one(sql, vec![json!(clean), json!(clean), json!(email)])
            .await?
            .to_objects()
            .into_iter()
            .next())
    }

    fn require_recoverable(
        operator: Option<HashMap<String, Value>>,
    ) -> Result<HashMap<String, Value>, CommandError> {
        let row = operator.ok_or_else(|| {
            reset_error("Akun dengan username atau email tersebut tidak ditemukan.")
        })?;
        let email = row
            .get("email")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string();
        if email.is_empty() {
            return Err(reset_error(
                "Akun ini belum memiliki email terdaftar sehingga link reset tidak dapat dikirim. Hubungi Admin untuk melengkapi data akun.",
            ));
        }
        Ok(row)
    }

    /// Riwayat pengajuan "Lupa Password" untuk peninjauan manusia.
    ///
    /// `photo_base64` sengaja TIDAK ikut di-select: satu foto sekitar 40 KB dan
    /// seratus baris akan mengirim puluhan megabyte lewat IPC setiap kali
    /// halaman dibuka. Foto diambil per baris lewat `get_password_reset_photo`
    /// hanya ketika benar-benar dibuka.
    pub async fn list_password_reset_history(
        &self,
        status: &str,
        search: &str,
        limit: i64,
    ) -> Result<Value, CommandError> {
        self.ensure_schema_current().await?;
        let mut conditions: Vec<String> = Vec::new();
        let mut args: Vec<Value> = Vec::new();

        if !status.is_empty() && status != "SEMUA" {
            conditions.push("p.status = ?".to_string());
            args.push(json!(status));
        }
        let search = search.trim();
        if !search.is_empty() {
            conditions.push(
                "(m.nama_operator LIKE ? COLLATE NOCASE OR m.username LIKE ? COLLATE NOCASE \
                 OR m.kode_operator LIKE ? COLLATE NOCASE OR p.identifier_used LIKE ? COLLATE NOCASE)"
                    .to_string(),
            );
            let like = format!("%{}%", search.chars().take(60).collect::<String>());
            for _ in 0..4 {
                args.push(json!(like));
            }
        }
        let limit = limit.clamp(1, 500);
        args.push(json!(limit));

        let where_clause = if conditions.is_empty() {
            String::new()
        } else {
            format!("WHERE {}", conditions.join(" AND "))
        };
        let sql = format!(
            r#"SELECT
                p.id, p.operator_id, p.identifier_used, p.contact_target, p.status,
                p.liveness_score, p.liveness_report, p.delivery_status, p.delivery_error,
                p.requested_at, p.verified_at, p.sent_at, p.used_at, p.expires_at,
                CASE WHEN p.photo_base64 IS NOT NULL AND TRIM(p.photo_base64) <> '' THEN 1 ELSE 0 END AS has_photo,
                m.nama_operator, m.username, m.kode_operator
               FROM password_reset_request p
               JOIN master_operator m ON m.id = p.operator_id
               {where_clause}
               ORDER BY p.requested_at DESC
               LIMIT ?;"#
        );

        let rows = self.query_one(sql, args).await?.to_objects();
        let entries: Vec<Value> = rows
            .into_iter()
            .map(|row| {
                let text = |key: &str| {
                    row.get(key)
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string()
                };
                let (reason, challenges) = parse_liveness_report(&text("liveness_report"));
                json!({
                    "id": text("id"),
                    "operatorId": row.get("operator_id").and_then(Value::as_i64).unwrap_or(0),
                    "operatorName": text("nama_operator"),
                    "username": text("username"),
                    "kodeOperator": text("kode_operator"),
                    "identifierUsed": text("identifier_used"),
                    "maskedEmail": mask_operator_email(&text("contact_target")),
                    "status": text("status"),
                    "livenessScore": row.get("liveness_score").and_then(Value::as_f64),
                    "livenessReason": reason,
                    "livenessChallenges": challenges,
                    "deliveryStatus": text("delivery_status"),
                    "deliveryError": text("delivery_error"),
                    "hasPhoto": row.get("has_photo").and_then(Value::as_i64).unwrap_or(0) == 1,
                    "requestedAt": text("requested_at"),
                    "verifiedAt": text("verified_at"),
                    "sentAt": text("sent_at"),
                    "usedAt": text("used_at"),
                    "expiresAt": text("expires_at"),
                })
            })
            .collect();
        Ok(json!({ "entries": entries }))
    }

    /// Daftar foto bukti absensi — TANPA isi fotonya.
    ///
    /// `foto_base64` sengaja tidak ikut: satu foto sekitar 40 KB, sehingga 200
    /// baris akan menjadi balasan 8 MB yang harus melewati jaringan seluler.
    /// Fotonya diambil satu per satu lewat `get_attendance_photo`.
    pub async fn list_attendance_photos(
        &self,
        start_date: &str,
        end_date: &str,
        search: &str,
        limit: i64,
    ) -> Result<Value, CommandError> {
        self.ensure_schema_current().await?;
        let mut conditions: Vec<String> = Vec::new();
        let mut args: Vec<Value> = Vec::new();

        let start = start_date.trim();
        if !start.is_empty() {
            conditions.push("tanggal_kerja >= ?".to_string());
            args.push(json!(start));
        }
        let end = end_date.trim();
        if !end.is_empty() {
            conditions.push("tanggal_kerja <= ?".to_string());
            args.push(json!(end));
        }
        let search = search.trim();
        if !search.is_empty() {
            conditions.push(
                "(nama LIKE ? COLLATE NOCASE OR id_karyawan LIKE ? COLLATE NOCASE \
                 OR divisi LIKE ? COLLATE NOCASE OR kode_operator LIKE ? COLLATE NOCASE)"
                    .to_string(),
            );
            let like = format!("%{}%", search.chars().take(60).collect::<String>());
            for _ in 0..4 {
                args.push(json!(like));
            }
        }
        let limit = limit.clamp(1, 500);
        args.push(json!(limit));

        let where_clause = if conditions.is_empty() {
            String::new()
        } else {
            format!("WHERE {}", conditions.join(" AND "))
        };
        let sql = format!(
            r#"SELECT
                id_foto, COALESCE(id_sesi, '') AS id_sesi, tanggal_kerja, id_karyawan,
                nama, COALESCE(divisi, '') AS divisi, jenis_scan, timestamp_scan,
                COALESCE(sumber_data, '') AS sumber_data,
                COALESCE(kode_operator, '') AS kode_operator,
                COALESCE(ip_perangkat, '') AS ip_perangkat,
                COALESCE(client_id, '') AS client_id,
                COALESCE(foto_mime, 'image/jpeg') AS foto_mime,
                LENGTH(COALESCE(foto_base64, '')) AS ukuran_base64,
                created_at
               FROM absensi_foto
               {where_clause}
               ORDER BY timestamp_scan DESC
               LIMIT ?;"#
        );

        let rows = self.query_one(sql, args).await?.to_objects();
        let entries: Vec<Value> = rows
            .into_iter()
            .map(|row| {
                let text = |key: &str| {
                    row.get(key)
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string()
                };
                json!({
                    "idFoto": text("id_foto"),
                    "idSesi": text("id_sesi"),
                    "tanggalKerja": text("tanggal_kerja"),
                    "idKaryawan": text("id_karyawan"),
                    "nama": text("nama"),
                    "divisi": text("divisi"),
                    "jenisScan": text("jenis_scan"),
                    "timestampScan": text("timestamp_scan"),
                    "sumberData": text("sumber_data"),
                    "kodeOperator": text("kode_operator"),
                    "ipPerangkat": text("ip_perangkat"),
                    "clientId": text("client_id"),
                    "fotoMime": text("foto_mime"),
                    "ukuranBase64": row
                        .get("ukuran_base64")
                        .and_then(Value::as_i64)
                        .unwrap_or(0),
                    "createdAt": text("created_at"),
                })
            })
            .collect();
        Ok(json!({ "entries": entries }))
    }

    pub async fn get_attendance_photo(&self, photo_id: &str) -> Result<Value, CommandError> {
        self.ensure_schema_current().await?;
        let id = photo_id.trim();
        if id.is_empty() || id.len() > 200 {
            return Err(CommandError::new(
                "VALIDATION_ERROR",
                "ID foto absensi tidak valid.",
            ));
        }
        let row = self
            .query_one(
                "SELECT COALESCE(foto_mime, 'image/jpeg') AS foto_mime, COALESCE(foto_base64, '') AS foto_base64 FROM absensi_foto WHERE id_foto = ? LIMIT 1;",
                vec![json!(id)],
            )
            .await?
            .to_objects()
            .into_iter()
            .next()
            .ok_or_else(|| CommandError::new("NOT_FOUND", "Foto absensi tidak ditemukan."))?;
        let base64 = row
            .get("foto_base64")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string();
        if base64.is_empty() {
            return Err(CommandError::new(
                "NOT_FOUND",
                "Baris ini tidak menyimpan foto.",
            ));
        }
        let mime = row
            .get("foto_mime")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        Ok(json!({
            "photo": {
                "mime": if mime.is_empty() { "image/jpeg".to_string() } else { mime },
                "base64": base64,
            }
        }))
    }

    pub async fn delete_attendance_photo(&self, photo_id: &str) -> Result<Value, CommandError> {
        self.ensure_schema_current().await?;
        let id = photo_id.trim();
        if id.is_empty() || id.len() > 200 {
            return Err(CommandError::new(
                "VALIDATION_ERROR",
                "ID foto absensi tidak valid.",
            ));
        }
        let result = self
            .query_one(
                "DELETE FROM absensi_foto WHERE id_foto = ?;",
                vec![json!(id)],
            )
            .await?;
        if result.rows_affected == 0 {
            return Err(CommandError::new(
                "NOT_FOUND",
                "Foto tidak ditemukan atau sudah dihapus.",
            ));
        }
        Ok(json!({ "sukses": true, "deleted": 1 }))
    }

    /// Membersihkan foto bukti yang lebih tua dari `days` hari.
    ///
    /// Hanya fotonya yang hilang; baris `log_scan` dan `absensi_harian` tetap
    /// utuh, jadi rekap kehadiran tidak pernah ikut terhapus oleh retensi ini.
    pub async fn purge_attendance_photos(&self, days: i64) -> Result<Value, CommandError> {
        self.ensure_schema_current().await?;
        if !(1..=3650).contains(&days) {
            return Err(CommandError::new(
                "VALIDATION_ERROR",
                "Rentang hari pembersihan tidak valid.",
            ));
        }
        let result = self
            .query_one(
                "DELETE FROM absensi_foto WHERE tanggal_kerja <= date('now', ?);",
                vec![json!(format!("-{days} days"))],
            )
            .await?;
        Ok(json!({ "sukses": true, "deleted": result.rows_affected }))
    }

    pub async fn get_password_reset_photo(&self, request_id: &str) -> Result<Value, CommandError> {
        self.ensure_schema_current().await?;
        let id = request_id.trim();
        if id.is_empty() || id.len() > 64 {
            return Err(CommandError::new(
                "VALIDATION_ERROR",
                "ID permintaan tidak valid.",
            ));
        }
        let row = self
            .query_one(
                "SELECT COALESCE(photo_mime, '') AS photo_mime, COALESCE(photo_base64, '') AS photo_base64 FROM password_reset_request WHERE id = ? LIMIT 1;",
                vec![json!(id)],
            )
            .await?
            .to_objects()
            .into_iter()
            .next()
            .ok_or_else(|| CommandError::new("NOT_FOUND", "Permintaan tidak ditemukan."))?;
        let base64 = row
            .get("photo_base64")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string();
        if base64.is_empty() {
            return Err(CommandError::new(
                "NOT_FOUND",
                "Permintaan ini tidak menyimpan foto verifikasi.",
            ));
        }
        let mime = row
            .get("photo_mime")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        Ok(json!({
            "photo": {
                "mime": if mime.is_empty() { "image/jpeg".to_string() } else { mime },
                "base64": base64,
            }
        }))
    }

    pub async fn delete_password_reset_history(
        &self,
        request_id: &str,
    ) -> Result<Value, CommandError> {
        self.ensure_schema_current().await?;
        let id = request_id.trim();
        if id.is_empty() || id.len() > 64 {
            return Err(CommandError::new(
                "VALIDATION_ERROR",
                "ID permintaan tidak valid.",
            ));
        }
        let result = self
            .query_one(
                "DELETE FROM password_reset_request WHERE id = ?;",
                vec![json!(id)],
            )
            .await?;
        if result.rows_affected == 0 {
            return Err(CommandError::new(
                "NOT_FOUND",
                "Riwayat tidak ditemukan atau sudah dihapus.",
            ));
        }
        Ok(json!({ "sukses": true, "deleted": 1 }))
    }

    /// Membersihkan riwayat yang sudah selesai dan lebih tua dari `days` hari.
    ///
    /// Baris `Terkirim` dan `Menunggu Verifikasi` sengaja dilewati: membersihkan
    /// arsip tidak boleh memutus pemulihan yang sedang berjalan.
    pub async fn purge_password_reset_history(&self, days: i64) -> Result<Value, CommandError> {
        self.ensure_schema_current().await?;
        if !(1..=3650).contains(&days) {
            return Err(CommandError::new(
                "VALIDATION_ERROR",
                "Rentang hari pembersihan tidak valid.",
            ));
        }
        let result = self
            .query_one(
                "DELETE FROM password_reset_request WHERE status IN ('Terpakai', 'Kedaluwarsa', 'Dibatalkan') AND requested_at <= datetime('now', ?);",
                vec![json!(format!("-{days} days"))],
            )
            .await?;
        Ok(json!({ "sukses": true, "deleted": result.rows_affected }))
    }

    /// Langkah 1: identitas tersamar untuk dikonfirmasi pemohon.

    pub async fn password_reset_lookup(&self, identifier: &str) -> Result<Value, CommandError> {
        self.ensure_schema_current().await?;
        let row = Self::require_recoverable(self.find_reset_operator(identifier).await?)?;
        let text = |key: &str| {
            row.get(key)
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string()
        };
        Ok(json!({
            "account": {
                "name": text("nama_operator"),
                "kode_operator": text("kode_operator"),
                "username": text("username"),
                "masked_email": mask_operator_email(&text("email")),
                "masked_phone": mask_operator_phone(&text("no_hp")),
            }
        }))
    }

    /// Langkah 2: identitas diketik ulang, lalu tantangan liveness diterbitkan.
    pub async fn password_reset_confirm(
        &self,
        identifier: &str,
        confirmation: &str,
    ) -> Result<Value, CommandError> {
        self.ensure_schema_current().await?;
        let row = Self::require_recoverable(self.find_reset_operator(identifier).await?)?;
        let operator_id = row.get("id").and_then(Value::as_i64).unwrap_or(0);
        let confirmed = self.find_reset_operator(confirmation).await?;
        let matches = confirmed
            .as_ref()
            .and_then(|item| item.get("id"))
            .and_then(Value::as_i64)
            == Some(operator_id);
        if !matches {
            return Err(reset_error(
                "Konfirmasi username atau email tidak cocok dengan akun yang dipilih.",
            ));
        }
        let email = row
            .get("email")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();

        // Satu akun hanya boleh punya satu permintaan hidup, supaya token lama
        // tidak ikut berlaku setelah permintaan baru dibuat.
        self.query_one(
            "UPDATE password_reset_request SET status = 'Dibatalkan' WHERE operator_id = ? AND status IN ('Menunggu Verifikasi', 'Terkirim');",
            vec![json!(operator_id)],
        )
        .await?;

        let challenges = pick_reset_challenges();
        let challenge_token = random_reset_token();
        let request_id = random_request_id();
        let sql = format!(
            r#"INSERT INTO password_reset_request (
                id, operator_id, identifier_used, contact_channel, contact_target,
                challenge_hash, challenge_sequence, status, requested_at, expires_at
            ) VALUES (?, ?, ?, 'email', ?, ?, ?, 'Menunggu Verifikasi', datetime('now'), datetime('now', '+{RESET_CHALLENGE_TTL_MINUTES} minutes'));"#
        );
        self.query_one(
            sql,
            vec![
                json!(request_id),
                json!(operator_id),
                json!(identifier.trim().chars().take(120).collect::<String>()),
                json!(email),
                json!(sha256_hex(&challenge_token)),
                json!(serde_json::to_string(&challenges).unwrap_or_else(|_| "[]".to_string())),
            ],
        )
        .await?;

        let expires_at = self
            .query_one(
                "SELECT expires_at FROM password_reset_request WHERE id = ? LIMIT 1;",
                vec![json!(request_id)],
            )
            .await?
            .to_objects()
            .into_iter()
            .next()
            .and_then(|item| item.get("expires_at").and_then(Value::as_str).map(str::to_string))
            .unwrap_or_default();

        Ok(json!({
            "challenge": {
                "request_id": request_id,
                "challenge_token": challenge_token,
                "challenges": challenges,
                "masked_email": mask_operator_email(&email),
                "expires_at": expires_at,
            }
        }))
    }

    /// Mengganti satu tantangan yang tidak pernah terbaca kamera pemohon.
    ///
    /// Deteksi kedipan bergantung pada beberapa piksel pita mata; pada kamera
    /// kelas bawah, ruang redup, atau wajah berkacamata, tantangan itu bisa
    /// memang tidak pernah terbaca — dan tanpa jalan keluar, pemiliknya
    /// terkunci selamanya dari akunnya sendiri. Penggantinya tetap dipilih
    /// server, tetap acak, dan jumlahnya dibatasi supaya ini bukan cara memilih
    /// tantangan termudah.
    pub async fn password_reset_swap_challenge(
        &self,
        request_id: &str,
        challenge_token: &str,
        step_index: i64,
    ) -> Result<Value, CommandError> {
        self.ensure_schema_current().await?;
        let row = self
            .query_one(
                r#"SELECT p.id, p.challenge_sequence, p.status, p.liveness_report,
                          CASE WHEN p.expires_at <= datetime('now') THEN 1 ELSE 0 END AS is_expired
                   FROM password_reset_request p
                   WHERE p.id = ? AND p.challenge_hash = ? LIMIT 1;"#,
                vec![json!(request_id), json!(sha256_hex(challenge_token))],
            )
            .await?
            .to_objects()
            .into_iter()
            .next()
            .ok_or_else(|| reset_error("Sesi verifikasi tidak ditemukan."))?;

        if row.get("status").and_then(Value::as_str) != Some("Menunggu Verifikasi") {
            return Err(reset_error(
                "Sesi verifikasi ini sudah tidak berlaku. Ulangi dari awal.",
            ));
        }
        if row.get("is_expired").and_then(Value::as_i64) == Some(1) {
            return Err(reset_error(
                "Waktu verifikasi habis. Ulangi permintaan dari awal.",
            ));
        }

        let mut challenges: Vec<String> = serde_json::from_str(
            row.get("challenge_sequence")
                .and_then(Value::as_str)
                .unwrap_or("[]"),
        )
        .unwrap_or_default();
        if step_index < 0 || step_index as usize >= challenges.len() {
            return Err(reset_error("Langkah tantangan tidak dikenal."));
        }

        let report: Value = serde_json::from_str(
            row.get("liveness_report")
                .and_then(Value::as_str)
                .unwrap_or("{}"),
        )
        .unwrap_or_else(|_| json!({}));
        let attempts = report.get("attempts").and_then(Value::as_i64).unwrap_or(0);
        let swaps = report.get("swaps").and_then(Value::as_i64).unwrap_or(0);
        if swaps >= RESET_MAX_CHALLENGE_SWAPS {
            return Err(reset_error(format!(
                "Penggantian tantangan sudah mencapai batas ({RESET_MAX_CHALLENGE_SWAPS}). Ulangi permintaan dari awal di tempat yang lebih terang."
            )));
        }

        let alternatives: Vec<String> = [
            "KEDIP",
            "TENGOK_KIRI",
            "TENGOK_KANAN",
            "DEKATKAN_WAJAH",
            "JAUHKAN_WAJAH",
        ]
        .into_iter()
        .filter(|item| !challenges.iter().any(|used| used == item))
        .map(str::to_string)
        .collect();
        if alternatives.is_empty() {
            return Err(reset_error("Tidak ada tantangan pengganti yang tersisa."));
        }
        let pick = {
            use rand_core::{OsRng, RngCore};
            (OsRng.next_u32() as usize) % alternatives.len()
        };
        challenges[step_index as usize] = alternatives[pick].clone();

        self.query_one(
            "UPDATE password_reset_request SET challenge_sequence = ?, liveness_report = ? WHERE id = ? AND status = 'Menunggu Verifikasi';",
            vec![
                json!(serde_json::to_string(&challenges).unwrap_or_else(|_| "[]".to_string())),
                json!(json!({ "attempts": attempts, "swaps": swaps + 1 }).to_string()),
                json!(request_id),
            ],
        )
        .await?;

        Ok(json!({ "challenges": challenges }))
    }

    /// Langkah 3: menerima vonis liveness, lalu mengirim link reset.

    ///
    /// Yang diperiksa di sini bukan piksel — analisisnya berjalan di aplikasi
    /// memakai modul TypeScript yang sama dengan Web — melainkan hal yang hanya
    /// diketahui database: urutan tantangan acak yang diterbitkan pada langkah
    /// sebelumnya, umur permintaan, dan status barisnya. Rekaman lama atau
    /// vonis untuk urutan tantangan yang berbeda ditolak di sini.
    /// Jalur penyerahan token pemulihan yang berlaku pada instalasi ini.
    ///
    /// Mode Database Lokal tidak punya jaringan sama sekali, sehingga
    /// pengiriman email SELALU gagal di sana — dan kegagalan itu membatalkan
    /// permintaannya, membuat fitur "Lupa Password" mati total. Karena itu
    /// jalurnya tidak boleh mengasumsikan jaringan, dengan alasan yang sama
    /// yang membuat verifikasi dua langkah memakai TOTP alih-alih penyedia
    /// identitas pihak ketiga.
    ///
    /// Bawaannya DITENTUKAN OTOMATIS, bukan dipaksakan: instalasi yang sudah
    /// mengaktifkan email tetap memakai email setelah pembaruan, sisanya —
    /// termasuk seluruh pemasangan mode lokal — memakai persetujuan di
    /// aplikasi. Nilai eksplisit di `setting_gex_system` mengalahkan keduanya.
    /// Jumlah kode pemulihan yang diterbitkan sekali jalan.
    ///
    /// Cukup banyak untuk bertahan bertahun-tahun bagi akun yang jarang lupa,
    /// tetapi masih muat dicetak pada selembar kertas dan disimpan di brankas.
    const RECOVERY_CODE_COUNT: usize = 8;

    /// Terbitkan ulang kode pemulihan password untuk sebuah akun.
    ///
    /// Yang tersimpan hanya hash SHA-256-nya, sama seperti kode cadangan 2FA.
    /// Bentuk aslinya dikembalikan SEKALI dan tidak pernah bisa dibaca lagi —
    /// karena itu pemanggil wajib menampilkannya sampai pengguna menyatakan
    /// sudah menyimpannya.
    ///
    /// Menerbitkan ulang MENGGANTI seluruh kode lama: daftar yang sebagiannya
    /// sudah tercetak di kertas lama tidak boleh tetap berlaku bersamaan dengan
    /// yang baru.
    pub async fn issue_password_recovery_codes(
        &self,
        operator_id: i64,
    ) -> Result<Vec<String>, CommandError> {
        let codes = generate_recovery_codes(Self::RECOVERY_CODE_COUNT);
        let hashes: Vec<String> = codes
            .iter()
            .map(|code| sha256_hex(&normalize_recovery_code(code)))
            .collect();

        self.query_one(
            "UPDATE master_operator SET password_recovery_codes = ?, password_recovery_created_at = datetime('now') WHERE id = ?;",
            vec![
                json!(serde_json::to_string(&hashes).unwrap_or_else(|_| "[]".to_string())),
                json!(operator_id),
            ],
        )
        .await?;

        Ok(codes)
    }

    /// Masuk kembali memakai kode pemulihan, lalu setel password baru.
    ///
    /// Inilah satu-satunya jalan pulih bagi Superadmin pada pemasangan tanpa
    /// jaringan: tidak ada email yang bisa dikirim, dan tidak ada Superadmin
    /// lain yang bisa menyetujui permintaannya.
    ///
    /// Kode yang dipakai LANGSUNG DIHAPUS, bahkan bila langkah berikutnya
    /// gagal — kode sekali pakai yang masih hidup setelah dipakai bukan lagi
    /// kode sekali pakai. Verifikasinya memakai perbandingan hash, sehingga
    /// database tidak pernah memegang bentuk aslinya.
    pub async fn password_recovery_with_code(
        &self,
        identifier: &str,
        code: &str,
        new_password: &str,
    ) -> Result<Value, CommandError> {
        let identifier = identifier.trim();
        if identifier.is_empty() {
            return Err(CommandError::new(
                "RECOVERY_REJECTED",
                "Username atau kode operator wajib diisi.",
            ));
        }
        if new_password.chars().count() < 8 {
            return Err(CommandError::new(
                "RECOVERY_PASSWORD_WEAK",
                "Password baru minimal 8 karakter.",
            ));
        }

        let normalized = normalize_recovery_code(code);
        if normalized.is_empty() {
            return Err(CommandError::new(
                "RECOVERY_REJECTED",
                "Kode pemulihan wajib diisi.",
            ));
        }

        let row = self
            .query_one(
                r#"SELECT m.id, COALESCE(m.password_recovery_codes, '[]') AS kode,
                          COALESCE(m.nama_operator, '') AS nama_operator
                   FROM master_operator m
                   JOIN app_role r ON r.id = m.role_id
                   WHERE (m.username = ? COLLATE NOCASE OR m.kode_operator = ? COLLATE NOCASE)
                     AND m.status = 'Aktif' AND r.status = 'Aktif'
                   LIMIT 1;"#,
                vec![json!(identifier), json!(identifier)],
            )
            .await?
            .to_objects()
            .into_iter()
            .next();

        // Akun yang tidak ada dan kode yang salah dijawab SAMA. Membedakannya
        // akan mengubah layar ini menjadi alat memetakan akun mana yang ada.
        let ditolak = || {
            CommandError::new(
                "RECOVERY_REJECTED",
                "Kode pemulihan tidak sesuai, atau sudah pernah dipakai.",
            )
        };

        let Some(row) = row else {
            return Err(ditolak());
        };
        let operator_id = row.get("id").and_then(Value::as_i64).unwrap_or(0);
        let stored: Vec<String> = row
            .get("kode")
            .and_then(Value::as_str)
            .and_then(|raw| serde_json::from_str(raw).ok())
            .unwrap_or_default();

        let hashed = sha256_hex(&normalized);
        if !stored.iter().any(|item| *item == hashed) {
            return Err(ditolak());
        }

        let remaining: Vec<&String> = stored.iter().filter(|item| **item != hashed).collect();
        self.query_one(
            "UPDATE master_operator SET password_recovery_codes = ? WHERE id = ?;",
            vec![
                json!(serde_json::to_string(&remaining).unwrap_or_else(|_| "[]".to_string())),
                json!(operator_id),
            ],
        )
        .await?;

        let password_hash = hash_password_pbkdf2(new_password);
        self.query_one(
            "UPDATE master_operator SET password_hash = ?, updated_at = datetime('now') WHERE id = ?;",
            vec![json!(password_hash), json!(operator_id)],
        )
        .await?;

        // Sesi lama dicabut: siapa pun yang masih memegang sesi dengan password
        // lama tidak boleh tetap masuk setelah pemiliknya memulihkan akunnya.
        self.query_one(
            "UPDATE app_session SET revoked_at = datetime('now'), revoked_reason = 'password-recovery' WHERE operator_id = ? AND revoked_at IS NULL;",
            vec![json!(operator_id)],
        )
        .await
        .ok();

        Ok(json!({
            "sukses": true,
            "namaOperator": row.get("nama_operator").and_then(Value::as_str).unwrap_or(""),
            "sisaKode": remaining.len(),
        }))
    }

    pub async fn password_reset_route(&self) -> Result<String, CommandError> {
        let explicit = self
            .query_one(
                "SELECT value FROM setting_gex_system WHERE key = 'password_reset_route' LIMIT 1;",
                vec![],
            )
            .await
            .ok()
            .and_then(|result| result.to_objects().into_iter().next())
            .and_then(|row| {
                row.get("value")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(str::to_owned)
            });

        if let Some(value) = explicit {
            return Ok(if value == "email" {
                "email".to_owned()
            } else {
                "in_app".to_owned()
            });
        }

        let mail_active = self
            .query_one(
                "SELECT COALESCE(is_active, 0) AS is_active FROM app_mail_config WHERE id = 'default' LIMIT 1;",
                vec![],
            )
            .await
            .ok()
            .and_then(|result| result.to_objects().into_iter().next())
            .and_then(|row| {
                row.get("is_active")
                    .and_then(|value| value.as_i64().or_else(|| value.as_bool().map(i64::from)))
            })
            .unwrap_or(0);

        Ok(if mail_active == 1 {
            "email".to_owned()
        } else {
            "in_app".to_owned()
        })
    }

    /// Setujui permintaan pemulihan dan serahkan tokennya SEKALI.
    ///
    /// Token baru dibuat di sini, bukan saat verifikasi wajah. Itu disengaja:
    /// kalau ia dibuat lebih dulu, bentuk aslinya harus disimpan di suatu tempat
    /// sampai disetujui — dan database hanya boleh memegang hash-nya.
    ///
    /// Peninjau manusia yang melihat foto wajah pemohon adalah faktor kedua di
    /// jalur ini, dan sebenarnya lebih kuat daripada email: email hanya
    /// membuktikan penguasaan kotak masuk, bukan siapa yang meminta.
    pub async fn password_reset_approve(
        &self,
        actor_id: i64,
        request_id: &str,
    ) -> Result<Value, CommandError> {
        let existing = self
            .query_one(
                r#"SELECT p.id, p.status, p.delivery_status, p.identifier_used,
                          COALESCE(m.nama_operator, '') AS nama_operator,
                          CASE WHEN p.expires_at <= datetime('now') THEN 1 ELSE 0 END AS kedaluwarsa
                   FROM password_reset_request p
                   LEFT JOIN master_operator m ON m.id = p.operator_id
                   WHERE p.id = ? LIMIT 1;"#,
                vec![json!(request_id)],
            )
            .await?
            .to_objects()
            .into_iter()
            .next()
            .ok_or_else(|| {
                CommandError::new(
                    "RESET_REQUEST_NOT_FOUND",
                    "Permintaan pemulihan tidak ditemukan.",
                )
            })?;

        if existing.get("status").and_then(Value::as_str) != Some("Menunggu Verifikasi") {
            return Err(CommandError::new(
                "RESET_REQUEST_NOT_PENDING",
                "Permintaan ini sudah diproses sebelumnya.",
            ));
        }
        if existing.get("delivery_status").and_then(Value::as_str) != Some("Menunggu Persetujuan") {
            return Err(CommandError::new(
                "RESET_REQUEST_NOT_PENDING",
                "Permintaan ini tidak menunggu persetujuan.",
            ));
        }
        if existing
            .get("kedaluwarsa")
            .and_then(Value::as_i64)
            .unwrap_or(0)
            == 1
        {
            self.query_one(
                "UPDATE password_reset_request SET status = 'Kedaluwarsa' WHERE id = ?;",
                vec![json!(request_id)],
            )
            .await?;
            return Err(CommandError::new(
                "RESET_REQUEST_EXPIRED",
                "Permintaan ini sudah kedaluwarsa. Minta pemohon mengulang dari awal.",
            ));
        }

        let reset_token = random_reset_token();
        let update_sql = format!(
            r#"UPDATE password_reset_request
               SET token_hash = ?, status = 'Terkirim', delivery_status = 'Disetujui',
                   delivery_error = NULL, sent_at = datetime('now'),
                   expires_at = datetime('now', '+{RESET_TOKEN_TTL_MINUTES} minutes')
               WHERE id = ? AND status = 'Menunggu Verifikasi';"#
        );
        let applied = self
            .query_one(
                update_sql,
                vec![json!(sha256_hex(&reset_token)), json!(request_id)],
            )
            .await?;
        if applied.rows_affected == 0 {
            return Err(CommandError::new(
                "RESET_REQUEST_NOT_PENDING",
                "Permintaan ini sudah diproses oleh orang lain.",
            ));
        }

        self.query_one(
            "INSERT INTO role_permission_audit (actor_operator_id, action, detail, created_at) VALUES (?, 'password-reset-approve', ?, datetime('now'));",
            vec![json!(actor_id), json!(request_id)],
        )
        .await
        .ok();

        Ok(json!({
            "sukses": true,
            "token": reset_token,
            "berlakuMenit": RESET_TOKEN_TTL_MINUTES,
            "namaOperator": existing.get("nama_operator").and_then(Value::as_str).unwrap_or(""),
            "identifier": existing.get("identifier_used").and_then(Value::as_str).unwrap_or(""),
        }))
    }

    pub async fn password_reset_verify(
        &self,
        request_id: &str,
        challenge_token: &str,
        verdict: &Value,
        photo_base64: &str,
        photo_mime: &str,
    ) -> Result<Value, CommandError> {
        self.ensure_schema_current().await?;
        let photo = photo_base64.trim();
        if photo.is_empty() || photo.len() > RESET_PHOTO_MAX_LEN {
            return Err(reset_error(
                "Foto verifikasi tidak valid atau terlalu besar.",
            ));
        }

        let row = self
            .query_one(
                r#"SELECT p.id, p.operator_id, p.contact_target, p.challenge_sequence, p.status,
                          m.nama_operator,
                          CASE WHEN p.expires_at <= datetime('now') THEN 1 ELSE 0 END AS is_expired
                   FROM password_reset_request p
                   JOIN master_operator m ON m.id = p.operator_id
                   WHERE p.id = ? AND p.challenge_hash = ? LIMIT 1;"#,
                vec![json!(request_id), json!(sha256_hex(challenge_token))],
            )
            .await?
            .to_objects()
            .into_iter()
            .next()
            .ok_or_else(|| reset_error("Sesi verifikasi tidak ditemukan."))?;

        if row.get("status").and_then(Value::as_str) != Some("Menunggu Verifikasi") {
            return Err(reset_error(
                "Sesi verifikasi ini sudah tidak berlaku. Ulangi dari awal.",
            ));
        }
        if row.get("is_expired").and_then(Value::as_i64) == Some(1) {
            self.query_one(
                "UPDATE password_reset_request SET status = 'Kedaluwarsa' WHERE id = ?;",
                vec![json!(request_id)],
            )
            .await?;
            return Err(reset_error(
                "Waktu verifikasi habis. Ulangi permintaan dari awal.",
            ));
        }

        let expected: Vec<String> = serde_json::from_str(
            row.get("challenge_sequence")
                .and_then(Value::as_str)
                .unwrap_or("[]"),
        )
        .unwrap_or_default();
        let reported: Vec<String> = verdict
            .get("challenges")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| item.as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default();
        if expected.is_empty() || expected != reported {
            return Err(reset_error(
                "Urutan tantangan tidak sesuai. Ulangi verifikasi.",
            ));
        }

        let score = verdict.get("score").and_then(Value::as_f64).unwrap_or(0.0);
        let passed = verdict.get("passed").and_then(Value::as_bool) == Some(true);
        if !passed || score < RESET_LIVENESS_MIN_SCORE {
            let reason = verdict
                .get("reason")
                .and_then(Value::as_str)
                .unwrap_or("Verifikasi wajah gagal.");
            self.query_one(
                "UPDATE password_reset_request SET liveness_score = ?, liveness_report = ?, photo_mime = ?, photo_base64 = ?, status = 'Dibatalkan' WHERE id = ?;",
                vec![
                    json!(score),
                    json!(verdict.to_string()),
                    json!(photo_mime.chars().take(40).collect::<String>()),
                    json!(photo),
                    json!(request_id),
                ],
            )
            .await?;
            return Err(reset_error(reason));
        }

        // Jalur persetujuan di aplikasi: tidak ada token yang dibuat di sini,
        // dan tidak ada yang dikirim ke mana pun. Permintaannya tetap
        // "Menunggu Verifikasi" sampai seorang Superadmin melihat foto wajahnya
        // dan menyetujui — barulah token dibuat, sekali, di layar peninjau.
        if self.password_reset_route().await? != "email" {
            let update_sql = format!(
                r#"UPDATE password_reset_request
                   SET liveness_score = ?, liveness_report = ?, photo_mime = ?, photo_base64 = ?,
                       contact_channel = 'in_app', delivery_status = 'Menunggu Persetujuan',
                       delivery_error = NULL, verified_at = datetime('now'),
                       expires_at = datetime('now', '+{RESET_TOKEN_TTL_MINUTES} minutes')
                   WHERE id = ? AND status = 'Menunggu Verifikasi';"#
            );
            self.query_one(
                update_sql,
                vec![
                    json!(score),
                    json!(verdict.to_string()),
                    json!(photo_mime.chars().take(40).collect::<String>()),
                    json!(photo),
                    json!(request_id),
                ],
            )
            .await?;

            return Ok(json!({
                "delivery": {
                    "delivered": false,
                    "mode": "in_app",
                    "message": format!(
                        "Permintaan Anda sudah tercatat dan menunggu persetujuan Superadmin. Hubungi Superadmin untuk meninjau, lalu minta kode pemulihan yang berlaku {RESET_TOKEN_TTL_MINUTES} menit."
                    ),
                    "score": score,
                }
            }));
        }

        let reset_token = random_reset_token();
        let update_sql = format!(
            r#"UPDATE password_reset_request
               SET token_hash = ?, status = 'Terkirim', liveness_score = ?, liveness_report = ?,
                   photo_mime = ?, photo_base64 = ?, verified_at = datetime('now'),
                   expires_at = datetime('now', '+{RESET_TOKEN_TTL_MINUTES} minutes')
               WHERE id = ? AND status = 'Menunggu Verifikasi';"#
        );
        self.query_one(
            update_sql,
            vec![
                json!(sha256_hex(&reset_token)),
                json!(score),
                json!(verdict.to_string()),
                json!(photo_mime.chars().take(40).collect::<String>()),
                json!(photo),
                json!(request_id),
            ],
        )
        .await?;

        let contact = row
            .get("contact_target")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let operator_name = row
            .get("nama_operator")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let delivery = self
            .send_reset_email(&contact, &operator_name, &reset_token)
            .await;

        match delivery {
            Ok(()) => {
                self.query_one(
                    "UPDATE password_reset_request SET delivery_status = 'Terkirim', delivery_error = NULL, sent_at = datetime('now') WHERE id = ?;",
                    vec![json!(request_id)],
                )
                .await?;
                Ok(json!({
                    "delivery": {
                        "delivered": true,
                        "masked_email": mask_operator_email(&contact),
                        "message": format!(
                            "Link reset password sudah dikirim ke {}. Berlaku {} menit.",
                            mask_operator_email(&contact),
                            RESET_TOKEN_TTL_MINUTES
                        ),
                        "score": score,
                    }
                }))
            }
            Err(failure) => {
                // Permintaan dibatalkan ketika email gagal terkirim: token yang
                // tidak pernah sampai ke pemiliknya tidak boleh tetap hidup.
                // Yang disimpan adalah penjelasan penyedia, bukan pesan generik —
                // itulah satu-satunya petunjuk yang bisa dibaca Admin nanti di
                // halaman Riwayat Reset Password.
                self.query_one(
                    "UPDATE password_reset_request SET delivery_status = 'Gagal', delivery_error = ?, status = 'Dibatalkan' WHERE id = ?;",
                    vec![
                        json!(if failure.detail.is_empty() {
                            failure.message.clone()
                        } else {
                            failure.detail.clone()
                        }),
                        json!(request_id),
                    ],
                )
                .await?;
                Err(reset_error(failure.message))
            }
        }
    }

    /// Langkah 4: memvalidasi token sebelum form password baru ditampilkan.
    pub async fn password_reset_inspect(&self, token: &str) -> Result<Value, CommandError> {
        self.ensure_schema_current().await?;
        let row = self.load_reset_token(token).await?;
        let text = |key: &str| {
            row.get(key)
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string()
        };
        Ok(json!({
            "token": {
                "operator_name": text("nama_operator"),
                "username": text("username"),
                "masked_email": mask_operator_email(&text("contact_target")),
                "expires_at": text("expires_at"),
            }
        }))
    }

    async fn load_reset_token(&self, token: &str) -> Result<HashMap<String, Value>, CommandError> {
        let clean = token.trim();
        if clean.len() < 16 || clean.len() > 256 {
            return Err(reset_error("Token reset tidak valid."));
        }
        let row = self
            .query_one(
                r#"SELECT p.id, p.operator_id, p.contact_target, p.status, p.expires_at,
                          m.nama_operator, m.username,
                          CASE WHEN p.expires_at <= datetime('now') THEN 1 ELSE 0 END AS is_expired
                   FROM password_reset_request p
                   JOIN master_operator m ON m.id = p.operator_id
                   WHERE p.token_hash = ? LIMIT 1;"#,
                vec![json!(sha256_hex(clean))],
            )
            .await?
            .to_objects()
            .into_iter()
            .next()
            .ok_or_else(|| reset_error("Token reset tidak dikenal atau sudah dipakai."))?;

        match row.get("status").and_then(Value::as_str) {
            Some("Terpakai") => {
                return Err(reset_error("Token reset ini sudah pernah dipakai."));
            }
            Some("Terkirim") => {}
            _ => return Err(reset_error("Token reset sudah tidak berlaku.")),
        }
        if row.get("is_expired").and_then(Value::as_i64) == Some(1) {
            let id = row.get("id").cloned().unwrap_or(Value::Null);
            self.query_one(
                "UPDATE password_reset_request SET status = 'Kedaluwarsa' WHERE id = ?;",
                vec![id],
            )
            .await?;
            return Err(reset_error(
                "Token reset sudah kedaluwarsa. Ulangi permintaan dari awal.",
            ));
        }
        Ok(row)
    }

    /// Langkah 5: password lama benar-benar digantikan yang baru.
    pub async fn password_reset_complete(
        &self,
        token: &str,
        password: &str,
    ) -> Result<Value, CommandError> {
        self.ensure_schema_current().await?;
        let row = self.load_reset_token(token).await?;
        validate_new_password(password)?;
        let request_id = row.get("id").cloned().unwrap_or(Value::Null);
        let operator_id = row.get("operator_id").and_then(Value::as_i64).unwrap_or(0);

        // Token dikonsumsi lebih dulu: dua permintaan paralel dengan token yang
        // sama tidak boleh sama-sama sempat menulis password.
        let consumed = self
            .query_one(
                "UPDATE password_reset_request SET status = 'Terpakai', used_at = datetime('now') WHERE id = ? AND status = 'Terkirim';",
                vec![request_id.clone()],
            )
            .await?;
        if consumed.rows_affected == 0 {
            return Err(reset_error("Token reset ini sudah pernah dipakai."));
        }

        let password_hash = hash_password_pbkdf2(password);
        self.query_one(
            "UPDATE master_operator SET password_hash = ?, updated_at = datetime('now') WHERE id = ?;",
            vec![json!(password_hash), json!(operator_id)],
        )
        .await?;
        // Sesi Web yang masih hidup ikut dicabut; kalau tidak, penyerang yang
        // terlanjur masuk tetap memegang sesi walau passwordnya sudah diganti.
        self.query_one(
            "UPDATE app_session SET revoked_at = datetime('now'), revoked_reason = 'password-reset' WHERE operator_id = ? AND revoked_at IS NULL;",
            vec![json!(operator_id)],
        )
        .await?;

        Ok(json!({
            "sukses": true,
            "username": row.get("username").cloned().unwrap_or(Value::Null),
        }))
    }

    /// Konfigurasi email tanpa kunci API — aman dikirim ke lapisan UI.
    pub async fn get_mail_config(&self) -> Result<Value, CommandError> {
        self.ensure_schema_current().await?;
        let row = self
            .query_one(
                "SELECT provider, COALESCE(api_key, '') AS api_key, COALESCE(sender_email, '') AS sender_email, COALESCE(sender_name, '') AS sender_name, COALESCE(reset_base_url, '') AS reset_base_url, is_active, updated_at, COALESCE(updated_by, '') AS updated_by FROM app_mail_config WHERE id = 'default' LIMIT 1;",
                vec![],
            )
            .await?
            .to_objects()
            .into_iter()
            .next()
            .unwrap_or_default();
        let text = |key: &str| {
            row.get(key)
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string()
        };
        Ok(json!({
            "config": {
                "provider": if text("provider").is_empty() { "resend".to_string() } else { text("provider") },
                "hasApiKey": !text("api_key").trim().is_empty(),
                "senderEmail": text("sender_email"),
                "senderName": text("sender_name"),
                "resetBaseUrl": text("reset_base_url"),
                "isActive": row.get("is_active").and_then(Value::as_i64).unwrap_or(0) == 1,
                "updatedAt": text("updated_at"),
                "updatedBy": text("updated_by"),
            }
        }))
    }

    pub async fn save_mail_config(
        &self,
        draft: &Value,
        actor: &str,
    ) -> Result<Value, CommandError> {
        self.ensure_schema_current().await?;
        let field = |key: &str| {
            draft
                .get(key)
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .to_string()
        };
        let provider = match field("provider").as_str() {
            "brevo" => "brevo".to_string(),
            _ => "resend".to_string(),
        };
        let is_active = draft.get("is_active").and_then(Value::as_bool) == Some(true);
        let sender_email = field("sender_email").to_lowercase();
        let sender_name = field("sender_name");
        let api_key = field("api_key");

        let stored = self
            .query_one(
                "SELECT COALESCE(api_key, '') AS api_key FROM app_mail_config WHERE id = 'default' LIMIT 1;",
                vec![],
            )
            .await?
            .to_objects()
            .into_iter()
            .next()
            .and_then(|row| row.get("api_key").and_then(Value::as_str).map(str::to_string))
            .unwrap_or_default();

        if is_active {
            if api_key.is_empty() && stored.trim().is_empty() {
                return Err(CommandError::new(
                    "VALIDATION_ERROR",
                    "Kunci API penyedia email wajib diisi.",
                ));
            }
            if !is_valid_operator_email(&sender_email) {
                return Err(CommandError::new(
                    "VALIDATION_ERROR",
                    "Email pengirim wajib diisi dengan format yang valid.",
                ));
            }
            if sender_name.chars().count() < 2 {
                return Err(CommandError::new(
                    "VALIDATION_ERROR",
                    "Nama pengirim minimal 2 karakter.",
                ));
            }
        }

        // Kunci hanya ditimpa ketika formulir mengirim kunci baru: UI tidak
        // pernah menerima kunci tersimpan sehingga selalu mengirim string kosong.
        let next_key = if api_key.is_empty() { stored } else { api_key };
        let base_url = field("reset_base_url")
            .trim_end_matches('/')
            .to_string();

        self.query_one(
            r#"INSERT INTO app_mail_config (
                    id, provider, api_key, sender_email, sender_name,
                    reset_base_url, is_active, updated_at, updated_by
               ) VALUES ('default', ?, ?, ?, ?, ?, ?, datetime('now'), ?)
               ON CONFLICT(id) DO UPDATE SET
                    provider = excluded.provider,
                    api_key = excluded.api_key,
                    sender_email = excluded.sender_email,
                    sender_name = excluded.sender_name,
                    reset_base_url = excluded.reset_base_url,
                    is_active = excluded.is_active,
                    updated_at = excluded.updated_at,
                    updated_by = excluded.updated_by;"#,
            vec![
                json!(provider),
                json!(next_key),
                json!(sender_email),
                json!(sender_name),
                json!(base_url),
                json!(if is_active { 1 } else { 0 }),
                json!(actor),
            ],
        )
        .await?;
        self.get_mail_config().await
    }

    /// Mengirim email percobaan ke alamat Admin yang sedang login.
    ///
    /// Balasannya memuat penjelasan apa adanya dari penyedia — aman karena
    /// command pemanggilnya menuntut izin `settings.manage`. Tanpa ini, satu-
    /// satunya cara menguji konfigurasi adalah menjalankan seluruh alur
    /// "Lupa Password" sampai verifikasi wajah.
    pub async fn send_test_mail(&self, operator_id: i64) -> Result<Value, CommandError> {
        self.ensure_schema_current().await?;
        let row = self
            .query_one(
                "SELECT COALESCE(email, '') AS email, nama_operator FROM master_operator WHERE id = ? LIMIT 1;",
                vec![json!(operator_id)],
            )
            .await?
            .to_objects()
            .into_iter()
            .next()
            .unwrap_or_default();
        let to = row
            .get("email")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string();
        if to.is_empty() {
            return Ok(json!({
                "test": {
                    "delivered": false,
                    "message": "Akun Anda belum punya email terdaftar. Lengkapi email akun Anda di Master Operator lebih dulu.",
                    "detail": "",
                    "to": "",
                }
            }));
        }
        let name = row
            .get("nama_operator")
            .and_then(Value::as_str)
            .unwrap_or("Admin")
            .to_string();
        let body = format!(
            "Halo {name},\n\nEmail ini dikirim dari menu Pengaturan > Email Sistem untuk menguji konfigurasi pengirim.\nBila email ini sampai, fitur Lupa Password sudah siap dipakai.\n\nAbsensi SPPG"
        );
        match self
            .deliver_mail(&to, "Uji Kirim Email Sistem Absensi SPPG", &body)
            .await
        {
            Ok(()) => Ok(json!({
                "test": {
                    "delivered": true,
                    "message": format!("Email uji terkirim ke {to}."),
                    "detail": "",
                    "to": to,
                }
            })),
            Err(error) => Ok(json!({
                "test": {
                    "delivered": false,
                    "message": error.message,
                    "detail": error.detail,
                    "to": to,
                }
            })),
        }
    }

    /// Mengirim email lewat HTTP API penyedia.
    async fn deliver_mail(
        &self,
        to: &str,
        subject: &str,
        body_text: &str,
    ) -> Result<(), MailFailure> {
        let row = self
            .query_one(
                "SELECT provider, COALESCE(api_key, '') AS api_key, COALESCE(sender_email, '') AS sender_email, COALESCE(sender_name, '') AS sender_name, is_active FROM app_mail_config WHERE id = 'default' LIMIT 1;",
                vec![],
            )
            .await
            .map_err(|error| MailFailure {
                message: "Konfigurasi email tidak dapat dibaca dari database.".to_string(),
                detail: error.message,
            })?
            .to_objects()
            .into_iter()
            .next()
            .unwrap_or_default();
        let text = |key: &str| {
            row.get(key)
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string()
        };
        let api_key = text("api_key");
        let sender_email = text("sender_email");
        if row.get("is_active").and_then(Value::as_i64) != Some(1)
            || api_key.trim().is_empty()
            || sender_email.is_empty()
        {
            return Err(MailFailure {
                message: "Pengiriman email belum dikonfigurasi. Minta Admin mengisi Pengaturan > Email Sistem.".to_string(),
                detail: "Konfigurasi email nonaktif, kunci API kosong, atau email pengirim belum diisi.".to_string(),
            });
        }
        let sender_name = if text("sender_name").is_empty() {
            "Absensi SPPG".to_string()
        } else {
            text("sender_name")
        };
        let provider = text("provider");

        let request = if provider == "brevo" {
            self.http
                .post("https://api.brevo.com/v3/smtp/email")
                .header("api-key", api_key.trim())
                .json(&json!({
                    "sender": { "name": sender_name, "email": sender_email },
                    "to": [{ "email": to }],
                    "subject": subject,
                    "textContent": body_text,
                }))
        } else {
            self.http
                .post("https://api.resend.com/emails")
                .bearer_auth(api_key.trim())
                .json(&json!({
                    "from": format!("{sender_name} <{sender_email}>"),
                    "to": [to],
                    "subject": subject,
                    "text": body_text,
                }))
        };

        let response = request.send().await.map_err(|error| MailFailure {
            message: "Email gagal dikirim karena jaringan tidak tersedia. Coba lagi setelah perangkat terhubung internet.".to_string(),
            // Penyebab teknisnya disimpan terpisah: "tidak ada internet" yang
            // muncul padahal internet menyala hampir selalu berarti DNS, TLS,
            // atau proxy — bukan kabel terputus.
            detail: format!("Permintaan ke {provider} gagal: {error}"),
        })?;
        let status = response.status();
        if !status.is_success() {
            let body = response.text().await.unwrap_or_default();
            return Err(MailFailure {
                message: format!("Penyedia email menolak pengiriman (HTTP {}).", status.as_u16()),
                detail: format!(
                    "HTTP {} dari {provider}: {}",
                    status.as_u16(),
                    body.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(400).collect::<String>()
                ),
            });
        }
        Ok(())
    }

    /// Mengirim email lewat HTTP API penyedia.
    ///
    /// Bukan SMTP: WebView Tauri di Android maupun runtime Vercel tidak
    /// menjamin soket keluar port 587, sementara HTTPS keluar sudah pasti
    /// tersedia — jalur yang sama yang dipakai klien Turso ini.
    async fn send_reset_email(
        &self,
        to: &str,
        operator_name: &str,
        reset_token: &str,
    ) -> Result<(), MailFailure> {
        let base_url = self
            .query_one(
                "SELECT COALESCE(reset_base_url, '') AS reset_base_url FROM app_mail_config WHERE id = 'default' LIMIT 1;",
                vec![],
            )
            .await
            .ok()
            .and_then(|result| result.to_objects().into_iter().next())
            .and_then(|row| row.get("reset_base_url").and_then(Value::as_str).map(str::to_string))
            .unwrap_or_default();
        let action = if base_url.is_empty() {
            format!(
                "Masukkan kode berikut pada halaman \"Lupa Password\" di aplikasi:
{reset_token}"
            )
        } else {
            format!(
                "Buka tautan berikut untuk membuat password baru:
{base_url}/lupa-password/reset?token={reset_token}"
            )
        };
        let body_text = format!(
            "Halo {operator_name},

\
             Kami menerima permintaan pemulihan password untuk akun Absensi SPPG Anda.
\
             Permintaan ini sudah melewati verifikasi wajah pada perangkat pemohon.

\
             {action}

\
             Tautan/kode ini berlaku {RESET_TOKEN_TTL_MINUTES} menit dan hanya dapat dipakai satu kali.
\
             Jika Anda tidak merasa mengajukan permintaan ini, abaikan email ini dan segera
\
             laporkan ke Admin — foto pemohon sudah tersimpan sebagai bukti.

\
             Absensi SPPG"
        );
        self.deliver_mail(to, "Pemulihan Password Absensi SPPG", &body_text)
            .await
    }
}

/// Normalisasi email operator: disimpan lowercase karena index unik
/// `idx_master_operator_email` memakai `LOWER(email)`.
///
/// Cerminan Rust dari `src/lib/operators/contact.ts`. Kedua sisi menulis ke
/// kolom yang sama, jadi aturan yang berbeda akan membuat satu operator
/// tersimpan dalam dua bentuk dan pencarian "Lupa Password" gagal menemukannya.
pub fn normalize_operator_email(value: &str) -> String {
    value.trim().to_lowercase()
}

/// Normalisasi nomor HP Indonesia ke bentuk kanonik `+62…`.
pub fn normalize_operator_phone(value: &str) -> String {
    let cleaned: String = value
        .chars()
        .filter(|character| character.is_ascii_digit() || *character == '+')
        .collect();
    if cleaned.is_empty() {
        return String::new();
    }
    let had_plus = cleaned.starts_with('+');
    let bare: String = cleaned.chars().filter(char::is_ascii_digit).collect();
    if bare.is_empty() {
        return String::new();
    }
    if let Some(rest) = bare.strip_prefix("62") {
        return format!("+62{rest}");
    }
    if let Some(rest) = bare.strip_prefix('0') {
        return format!("+62{rest}");
    }
    if bare.starts_with('8') {
        return format!("+62{bare}");
    }
    if had_plus {
        return format!("+{bare}");
    }
    String::new()
}

pub fn is_valid_operator_email(value: &str) -> bool {
    let email = normalize_operator_email(value);
    if email.is_empty() || email.len() > 120 || email.chars().any(char::is_whitespace) {
        return false;
    }
    let mut parts = email.split('@');
    let (Some(local), Some(domain), None) = (parts.next(), parts.next(), parts.next()) else {
        return false;
    };
    !local.is_empty()
        && domain.contains('.')
        && !domain.starts_with('.')
        && !domain.ends_with('.')
        && !domain.contains("..")
}

pub fn is_valid_operator_phone(value: &str) -> bool {
    let phone = normalize_operator_phone(value);
    let digits = phone.trim_start_matches('+');
    phone.starts_with('+') && (9..=15).contains(&digits.len())
}

/// Email dan nomor HP wajib pada setiap akun operator: email adalah satu-satunya
/// jalur pengiriman link "Lupa Password".
pub fn validate_operator_contact(email: &str, phone: &str) -> Result<(), CommandError> {
    if !is_valid_operator_email(email) {
        return Err(CommandError::new(
            "VALIDATION_ERROR",
            "Email operator wajib diisi dengan format yang valid.",
        ));
    }
    if !is_valid_operator_phone(phone) {
        return Err(CommandError::new(
            "VALIDATION_ERROR",
            "Nomor HP operator wajib diisi. Gunakan format 08xxxxxxxxxx atau +62xxxxxxxxxx.",
        ));
    }
    Ok(())
}

/// Menyamarkan email untuk layar "Lupa Password" yang terbuka tanpa login.
pub fn mask_operator_email(value: &str) -> String {
    let email = normalize_operator_email(value);
    let Some(at) = email.rfind('@') else {
        return String::new();
    };
    if at == 0 {
        return String::new();
    }
    let local = &email[..at];
    let domain = &email[at + 1..];
    let head: String = local.chars().take(1).collect();
    let tail: String = if local.chars().count() > 2 {
        local.chars().rev().take(1).collect()
    } else {
        String::new()
    };
    let hidden = local
        .chars()
        .count()
        .saturating_sub(head.chars().count() + tail.chars().count())
        .max(2);
    let masked_domain = match domain.find('.') {
        Some(dot) if dot > 1 => format!(
            "{}{}{}",
            &domain[..1],
            "*".repeat(dot - 1),
            &domain[dot..]
        ),
        _ => domain.to_string(),
    };
    format!("{head}{}{tail}@{masked_domain}", "*".repeat(hidden))
}

/// Menyamarkan nomor HP: hanya awalan negara dan empat digit terakhir.
pub fn mask_operator_phone(value: &str) -> String {
    let phone = normalize_operator_phone(value);
    if phone.is_empty() {
        return String::new();
    }
    let digits = &phone[1..];
    if digits.len() <= 4 {
        return format!("+{}", "*".repeat(digits.len()));
    }
    format!(
        "+{}{}{}",
        &digits[..2],
        "*".repeat(digits.len() - 6),
        &digits[digits.len() - 4..]
    )
}

/// Langkah waktu TOTP (RFC 6238). WAJIB sama dengan TOTP_STEP_SECONDS di
/// src/lib/security/totp.ts.
/// Data 2FA satu operator, dibaca sekali lalu dipakai beberapa pemeriksaan.
struct OperatorTotp {
    secret: String,
    enabled: bool,
    confirmed_at: String,
    recovery_codes: Vec<String>,
    username: String,
    require_totp: bool,
}

/// Meng-escape label otpauth seperlunya. Label hanya berisi nama aplikasi dan
/// username operator, jadi cukup menangani karakter yang merusak URI.
fn urlencoding_minimal(value: &str) -> String {
    value
        .chars()
        .map(|character| match character {
            ' ' => "%20".to_string(),
            ':' => "%3A".to_string(),
            '/' => "%2F".to_string(),
            '?' => "%3F".to_string(),
            '#' => "%23".to_string(),
            '&' => "%26".to_string(),
            other => other.to_string(),
        })
        .collect()
}

const TOTP_STEP_SECONDS: i64 = 30;
const TOTP_DIGITS: u32 = 6;
/// Toleransi langkah waktu saat verifikasi. Sempit ketika waktunya diambil dari
/// jam server database; lebar ketika terpaksa memakai jam perangkat.
pub const TOTP_WINDOW_ONLINE: i64 = 1;

const BASE32_ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/// Membaca base32 dengan memaafkan bentuk yang biasa diketik manusia: spasi,
/// tanda hubung, huruf kecil, dan padding `=`.
pub fn decode_base32(value: &str) -> Option<Vec<u8>> {
    let mut bits: u32 = 0;
    let mut accumulator: u32 = 0;
    let mut output = Vec::new();
    for character in value.chars() {
        if character == ' ' || character == '-' || character == '=' {
            continue;
        }
        let upper = character.to_ascii_uppercase() as u8;
        let index = BASE32_ALPHABET.iter().position(|item| *item == upper)?;
        accumulator = (accumulator << 5) | index as u32;
        bits += 5;
        if bits >= 8 {
            output.push(((accumulator >> (bits - 8)) & 0xff) as u8);
            bits -= 8;
        }
    }
    Some(output)
}

pub fn encode_base32(bytes: &[u8]) -> String {
    let mut bits: u32 = 0;
    let mut value: u32 = 0;
    let mut output = String::new();
    for byte in bytes {
        value = (value << 8) | u32::from(*byte);
        bits += 8;
        while bits >= 5 {
            output.push(BASE32_ALPHABET[((value >> (bits - 5)) & 31) as usize] as char);
            bits -= 5;
        }
    }
    if bits > 0 {
        output.push(BASE32_ALPHABET[((value << (5 - bits)) & 31) as usize] as char);
    }
    output
}

/// HOTP (RFC 4226): HMAC-SHA1 dari pencacah, lalu pemotongan dinamis 6 digit.
pub fn generate_hotp(secret_base32: &str, counter: u64) -> Option<String> {
    use hmac::{Hmac, Mac};
    use sha1::Sha1;

    let key = decode_base32(secret_base32)?;
    if key.is_empty() {
        return None;
    }
    let mut mac = Hmac::<Sha1>::new_from_slice(&key).ok()?;
    mac.update(&counter.to_be_bytes());
    let digest = mac.finalize().into_bytes();
    let offset = (digest[digest.len() - 1] & 0x0f) as usize;
    let binary = (u32::from(digest[offset] & 0x7f) << 24)
        | (u32::from(digest[offset + 1]) << 16)
        | (u32::from(digest[offset + 2]) << 8)
        | u32::from(digest[offset + 3]);
    let modulo = 10u32.pow(TOTP_DIGITS);
    Some(format!(
        "{:0width$}",
        binary % modulo,
        width = TOTP_DIGITS as usize
    ))
}

/// Pasangan penghasil kode untuk `verify_totp`. Produksi hanya memverifikasi,
/// tetapi vektor uji RFC 6238 menuntut sisi penghasilnya juga dibuktikan benar.
#[allow(dead_code)]
pub fn generate_totp(secret_base32: &str, unix_seconds: i64) -> Option<String> {
    let counter = unix_seconds.div_euclid(TOTP_STEP_SECONDS);
    if counter < 0 {
        return None;
    }
    generate_hotp(secret_base32, counter as u64)
}

/// Memverifikasi kode terhadap jendela langkah waktu di sekitar `unix_seconds`.
///
/// Seluruh jendela selalu ditelusuri sampai habis, tanpa keluar lebih awal saat
/// menemukan kecocokan, supaya lama pemrosesan tidak membocorkan posisi
/// langkah waktu yang cocok.
pub fn verify_totp(secret_base32: &str, code: &str, unix_seconds: i64, window: i64) -> bool {
    let clean: String = code.chars().filter(char::is_ascii_digit).collect();
    if clean.len() != TOTP_DIGITS as usize {
        return false;
    }
    let center = unix_seconds.div_euclid(TOTP_STEP_SECONDS);
    let mut matched = false;
    for offset in -window..=window {
        let counter = center + offset;
        if counter < 0 {
            continue;
        }
        if let Some(expected) = generate_hotp(secret_base32, counter as u64) {
            // Perbandingan waktu-tetap: panjangnya selalu sama enam digit.
            let mut difference: u8 = 0;
            for (left, right) in expected.bytes().zip(clean.bytes()) {
                difference |= left ^ right;
            }
            if difference == 0 {
                matched = true;
            }
        }
    }
    matched
}

/// Rahasia TOTP acak 20 byte, dikembalikan dalam base32.
pub fn generate_totp_secret() -> String {
    use rand_core::{OsRng, RngCore};
    let mut bytes = [0u8; 20];
    OsRng.fill_bytes(&mut bytes);
    encode_base32(&bytes)
}

/// Kode cadangan sekali pakai untuk operator yang kehilangan ponselnya.
///
/// Alfabetnya membuang karakter yang mudah tertukar saat disalin tangan
/// (O, I, 0, 1), karena kode ini memang dimaksudkan untuk dicatat di kertas.
pub fn generate_recovery_codes(count: usize) -> Vec<String> {
    use rand_core::{OsRng, RngCore};
    const ALPHABET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    (0..count)
        .map(|_| {
            let mut bytes = [0u8; 8];
            OsRng.fill_bytes(&mut bytes);
            let raw: String = bytes
                .iter()
                .map(|byte| ALPHABET[(*byte as usize) % ALPHABET.len()] as char)
                .collect();
            format!("{}-{}", &raw[0..4], &raw[4..8])
        })
        .collect()
}

pub fn normalize_recovery_code(value: &str) -> String {
    value
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .collect::<String>()
        .to_ascii_uppercase()
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
    validate_operator_contact(&draft.email, &draft.no_hp)?;
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

    /// Nomor HP harus dinormalisasi sama persis dengan
    /// `src/lib/operators/contact.ts`. Bila kedua sisi berbeda, satu operator
    /// bisa tersimpan dalam dua bentuk dan pencarian "Lupa Password" gagal
    /// menemukan akunnya sendiri.
    /// Paritas penghapusan operator antara Rust dan `removeOperator` di
    /// `src/lib/operators/operator-admin.ts`.
    ///
    /// Sebelum ini jalur Desktop hanya menolak Superadmin dan tidak memeriksa
    /// histori transaksi sama sekali, sehingga operator yang di Web ditolak
    /// tetap bisa dihapus dari Desktop.
    /// Vektor uji resmi RFC 4226 dan RFC 6238, sama persis dengan yang diuji
    /// `src/lib/security/totp.test.ts`.
    ///
    /// Dua implementasi menguji vektor yang sama adalah cara paritas TOTP
    /// dijaga: kode yang diterima Web wajib diterima Desktop/Mobile juga,
    /// karena keduanya memverifikasi rahasia yang sama dari database yang sama.
    #[test]
    fn totp_matches_the_official_rfc_vectors() {
        let secret = encode_base32(b"12345678901234567890");
        assert_eq!(secret, "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");

        // RFC 4226 Appendix D: delapan pencacah pertama.
        let hotp = [
            "755224", "287082", "359152", "969429", "338314", "254676", "287922", "162583",
        ];
        for (counter, expected) in hotp.iter().enumerate() {
            assert_eq!(
                generate_hotp(&secret, counter as u64).as_deref(),
                Some(*expected),
                "HOTP pencacah {counter}"
            );
        }

        // RFC 6238 Appendix B, baris SHA-1. Delapan digit dipotong jadi enam.
        for (seconds, eight_digits) in [
            (59i64, "94287082"),
            (1_111_111_109, "07081804"),
            (1_111_111_111, "14050471"),
            (1_234_567_890, "89005924"),
            (2_000_000_000, "69279037"),
        ] {
            assert_eq!(
                generate_totp(&secret, seconds).as_deref(),
                Some(&eight_digits[2..]),
                "TOTP detik {seconds}"
            );
        }
    }

    #[test]
    fn base32_decoding_forgives_human_typing() {
        let rapi = decode_base32("GEZDGNBVGY3TQOJQ").expect("base32");
        assert_eq!(decode_base32("gezd gnbv gy3t qojq").as_deref(), Some(&rapi[..]));
        assert_eq!(decode_base32("GEZD-GNBV-GY3T-QOJQ").as_deref(), Some(&rapi[..]));
        assert_eq!(decode_base32("GEZDGNBVGY3TQOJQ====").as_deref(), Some(&rapi[..]));
        // Karakter di luar alfabet base32 ditolak, bukan diam-diam dilewati.
        assert!(decode_base32("GEZD0189").is_none());
    }

    #[test]
    fn totp_verification_window_behaves_like_typescript() {
        let secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
        let now = 1_700_000_000i64;
        let code = generate_totp(secret, now).expect("kode");

        assert!(verify_totp(secret, &code, now, TOTP_WINDOW_ONLINE));
        // Kode yang berganti tepat saat tombol ditekan tetap diterima.
        let sebelum = generate_totp(secret, now - 30).expect("kode");
        let sesudah = generate_totp(secret, now + 30).expect("kode");
        assert!(verify_totp(secret, &sebelum, now, TOTP_WINDOW_ONLINE));
        assert!(verify_totp(secret, &sesudah, now, TOTP_WINDOW_ONLINE));

        // Di luar toleransi sempit ditolak, tetapi jendela offline yang lebih
        // lebar menerimanya — itulah gunanya membedakan keduanya.
        let meleset = generate_totp(secret, now + 90).expect("kode");
        assert!(!verify_totp(secret, &meleset, now, TOTP_WINDOW_ONLINE));
        // Jendela lebar yang dipakai sisi TypeScript untuk jam perangkat.
        assert!(verify_totp(secret, &meleset, now, 4));

        // Panjang salah dan spasi yang ikut tersalin.
        assert!(!verify_totp(secret, "12345", now, TOTP_WINDOW_ONLINE));
        assert!(!verify_totp(secret, "", now, TOTP_WINDOW_ONLINE));
        let berspasi = format!("{} {}", &code[0..3], &code[3..]);
        assert!(verify_totp(secret, &berspasi, now, TOTP_WINDOW_ONLINE));
    }

    #[test]
    fn generated_secrets_and_recovery_codes_are_usable() {
        let first = generate_totp_secret();
        let second = generate_totp_secret();
        assert_eq!(first.len(), 32);
        assert_ne!(first, second);
        assert_eq!(decode_base32(&first).map(|bytes| bytes.len()), Some(20));

        let codes = generate_recovery_codes(8);
        assert_eq!(codes.len(), 8);
        for code in &codes {
            assert_eq!(code.len(), 9);
            assert_eq!(code.as_bytes()[4], b'-');
            // Karakter yang mudah tertukar saat disalin tangan tidak dipakai.
            assert!(!code.contains(['O', 'I', '0', '1']));
        }
        assert_eq!(normalize_recovery_code("abcd-efgh"), "ABCDEFGH");
    }

    #[test]
    fn operator_deletion_guards_match_the_web_path() {
        let bersih = OperatorDeleteFacts {
            actor_id: 1,
            target_id: 2,
            target_exists: true,
            target_is_superadmin: false,
            target_is_active: true,
            active_superadmin_count: 1,
            transaction_references: 0,
            reset_history: 0,
        };
        assert!(assert_operator_deletable(&bersih).is_ok());

        let diri_sendiri = OperatorDeleteFacts {
            target_id: 1,
            ..bersih
        };
        assert_eq!(
            assert_operator_deletable(&diri_sendiri)
                .expect_err("akun sendiri")
                .message,
            "Akun yang sedang digunakan tidak dapat dihapus."
        );

        let tidak_ada = OperatorDeleteFacts {
            target_exists: false,
            ..bersih
        };
        assert_eq!(
            assert_operator_deletable(&tidak_ada)
                .expect_err("tidak ada")
                .message,
            "Operator tidak ditemukan."
        );

        let superadmin_terakhir = OperatorDeleteFacts {
            target_is_superadmin: true,
            active_superadmin_count: 1,
            ..bersih
        };
        assert_eq!(
            assert_operator_deletable(&superadmin_terakhir)
                .expect_err("superadmin terakhir")
                .message,
            "Superadmin aktif terakhir tidak dapat dihapus."
        );

        // Superadmin kedua boleh dihapus — persis seperti jalur Web. Aturan
        // lama Rust menolak semua Superadmin tanpa kecuali.
        let superadmin_cadangan = OperatorDeleteFacts {
            target_is_superadmin: true,
            active_superadmin_count: 2,
            ..bersih
        };
        assert!(assert_operator_deletable(&superadmin_cadangan).is_ok());

        // Superadmin yang sudah nonaktif tidak menahan siapa pun.
        let superadmin_nonaktif = OperatorDeleteFacts {
            target_is_superadmin: true,
            target_is_active: false,
            active_superadmin_count: 1,
            ..bersih
        };
        assert!(assert_operator_deletable(&superadmin_nonaktif).is_ok());

        let punya_transaksi = OperatorDeleteFacts {
            transaction_references: 1,
            ..bersih
        };
        assert_eq!(
            assert_operator_deletable(&punya_transaksi)
                .expect_err("histori transaksi")
                .message,
            "Operator memiliki histori transaksi. Nonaktifkan akun agar audit tetap utuh."
        );

        let punya_riwayat_reset = OperatorDeleteFacts {
            reset_history: 1,
            ..bersih
        };
        assert!(
            assert_operator_deletable(&punya_riwayat_reset)
                .expect_err("riwayat reset")
                .message
                .contains("riwayat pengajuan reset password")
        );

        // Histori transaksi diperiksa lebih dulu daripada riwayat reset, sama
        // seperti urutan di jalur Web.
        let keduanya = OperatorDeleteFacts {
            transaction_references: 1,
            reset_history: 1,
            ..bersih
        };
        assert_eq!(
            assert_operator_deletable(&keduanya)
                .expect_err("keduanya")
                .message,
            "Operator memiliki histori transaksi. Nonaktifkan akun agar audit tetap utuh."
        );
    }

    #[test]
    fn test_normalize_operator_phone_matches_typescript() {
        for input in [
            "081234567890",
            "+62 812-3456-7890",
            "6281234567890",
            "(0812) 3456 7890",
        ] {
            assert_eq!(normalize_operator_phone(input), "+6281234567890");
        }
        assert_eq!(normalize_operator_phone("+15551234567"), "+15551234567");
        assert_eq!(normalize_operator_phone("12345"), "");
        assert_eq!(normalize_operator_phone("bukan nomor"), "");
        assert_eq!(normalize_operator_phone(""), "");
    }

    #[test]
    fn test_normalize_operator_email_is_lowercased() {
        assert_eq!(
            normalize_operator_email("  Operator@SPPG.ID "),
            "operator@sppg.id"
        );
    }

    #[test]
    fn test_operator_email_validation() {
        assert!(is_valid_operator_email("operator.satu@sppg.id"));
        assert!(is_valid_operator_email("a@b.co"));
        for invalid in [
            "",
            "operator",
            "operator@",
            "@sppg.id",
            "operator@sppg",
            "operator @sppg.id",
            "a@b@c.id",
        ] {
            assert!(!is_valid_operator_email(invalid), "harus ditolak: {invalid}");
        }
    }

    #[test]
    fn test_operator_phone_validation() {
        assert!(is_valid_operator_phone("081234567890"));
        assert!(!is_valid_operator_phone("0812"));
        assert!(!is_valid_operator_phone(""));
    }

    #[test]
    fn test_validate_operator_contact_rejects_incomplete_data() {
        assert!(validate_operator_contact("operator@sppg.id", "081234567890").is_ok());
        assert!(validate_operator_contact("", "081234567890").is_err());
        assert!(validate_operator_contact("operator@sppg.id", "").is_err());
        assert!(validate_operator_contact("bukan-email", "081234567890").is_err());
    }

    /// Layar "Lupa Password" terbuka tanpa login, jadi kontak lengkap tidak
    /// boleh ditampilkan di sana.
    #[test]
    fn test_contact_masking_hides_identity() {
        let masked = mask_operator_email("operator01@sppg.id");
        assert!(!masked.contains("operator01"));
        assert!(masked.starts_with('o'));
        assert!(masked.ends_with(".id"));
        assert_eq!(mask_operator_email(""), "");
        assert_eq!(mask_operator_email("@sppg.id"), "");

        let phone = mask_operator_phone("081234567890");
        assert!(phone.starts_with("+62"));
        assert!(phone.ends_with("7890"));
        assert!(phone.contains('*'));
        assert!(!phone.contains("123456"));
        assert_eq!(mask_operator_phone("bukan nomor"), "");
    }

    /// Tantangan liveness harus acak dan tidak berulang dalam satu sesi.
    #[test]
    fn test_pick_reset_challenges_returns_unique_triplet() {
        let picked = pick_reset_challenges();
        assert_eq!(picked.len(), 3);
        let unique: std::collections::HashSet<&String> = picked.iter().collect();
        assert_eq!(unique.len(), 3);
        for challenge in &picked {
            assert!([
                "KEDIP",
                "TENGOK_KIRI",
                "TENGOK_KANAN",
                "DEKATKAN_WAJAH",
                "JAUHKAN_WAJAH"
            ]
            .contains(&challenge.as_str()));
        }
    }

    /// Aturan kekuatan password baru harus sama dengan
    /// `validatePasswordStrength` di `src/lib/auth/password.ts`.
    #[test]
    fn test_validate_new_password_mirrors_typescript_rules() {
        assert!(validate_new_password("PasswordBaruKuat1").is_ok());
        assert!(validate_new_password("pendek").is_err());
        assert!(validate_new_password("semuahurufkecil1").is_err());
        assert!(validate_new_password("SEMUAHURUFBESAR1").is_err());
        assert!(validate_new_password("TanpaAngkaSamaSekali").is_err());
    }

    /// Token reset tidak pernah disimpan apa adanya — hanya hash SHA-256-nya,
    /// sama seperti `hashSessionToken` di sisi TypeScript.
    #[test]
    fn test_random_reset_token_is_unique_and_hashed() {
        let first = random_reset_token();
        let second = random_reset_token();
        assert_ne!(first, second);
        assert!(first.len() >= 40);
        assert_eq!(sha256_hex(&first).len(), 64);
        assert_ne!(sha256_hex(&first), sha256_hex(&second));
        assert_eq!(sha256_hex(&first), sha256_hex(&first));
    }

    #[test]
    fn test_normalize_turso_url() {
        let turso = |raw: &str| normalize_database_url(raw, DatabaseProvider::Turso, false);
        assert_eq!(
            turso("libsql://my-db.turso.io").unwrap().as_str(),
            "https://my-db.turso.io/"
        );
        assert_eq!(
            turso("https://my-db.turso.io/path?query=1").unwrap().as_str(),
            "https://my-db.turso.io/"
        );
        assert!(turso("ftp://my-db.turso.io").is_err());
        assert!(turso("").is_err());
    }

    #[test]
    fn self_hosted_allows_plain_http_on_private_networks() {
        // Justru inilah tujuan mode server sendiri: server libSQL di LAN kantor
        // atau di rumah yang berjalan tanpa TLS. Ini harus lolos pada build
        // rilis, bukan hanya pada build debug.
        for address in [
            "http://192.168.1.10:8080",
            "http://10.20.30.40:8080",
            "http://172.16.5.4:8080",
            "http://localhost:8080",
            "http://127.0.0.1:8080",
            "http://nas.local:8080",
            "ws://192.168.1.10:8080",
        ] {
            assert!(
                normalize_database_url(address, DatabaseProvider::SelfHosted, false).is_ok(),
                "alamat privat harus diterima: {address}"
            );
        }
    }

    #[test]
    fn self_hosted_rejects_plain_http_on_public_hosts_unless_opted_in() {
        // VPS berisi IP publik: HTTP polos di sana mengirim Auth Token dan data
        // absensi tanpa enkripsi, jadi harus ditolak sampai pengguna menyatakan
        // menerima risikonya secara eksplisit.
        let error = normalize_database_url("http://203.0.113.10:8080", DatabaseProvider::SelfHosted, false)
            .expect_err("host publik ber-HTTP harus ditolak tanpa opt-in");
        assert_eq!(error.code, "TURSO_URL_INSECURE");
        assert!(
            normalize_database_url("http://203.0.113.10:8080", DatabaseProvider::SelfHosted, true)
                .is_ok()
        );
        // Opt-in tidak boleh menular ke provider Turso terkelola.
        assert!(normalize_database_url("http://203.0.113.10:8080", DatabaseProvider::Turso, true).is_err());
    }

    #[test]
    fn self_hosted_keeps_custom_port_and_strips_path() {
        let url = normalize_database_url(
            "http://192.168.1.10:9000/some/path?x=1#frag",
            DatabaseProvider::SelfHosted,
            false,
        )
        .unwrap();
        assert_eq!(url.as_str(), "http://192.168.1.10:9000/");
    }

    #[test]
    fn database_url_never_carries_credentials() {
        for provider in [DatabaseProvider::Turso, DatabaseProvider::SelfHosted] {
            assert!(
                normalize_database_url("https://user:secret@db.example.com", provider, false)
                    .is_err()
            );
        }
    }

    #[test]
    fn auth_token_is_optional_only_where_it_is_safe() {
        // sqld di LAN lazim berjalan tanpa autentikasi sama sekali.
        let lan = TursoConfig::new(
            "http://192.168.1.10:8080".into(),
            String::new(),
            DatabaseProvider::SelfHosted,
            false,
        );
        assert!(!lan.requires_auth_token());
        assert!(TursoClient::from_config(&lan, Client::new()).is_ok());

        // Server sendiri yang sudah ber-HTTPS publik berarti terekspos internet:
        // token menjadi satu-satunya penghalang yang tersisa.
        let public = TursoConfig::new(
            "https://db.kantor-anda.com".into(),
            String::new(),
            DatabaseProvider::SelfHosted,
            false,
        );
        assert!(public.requires_auth_token());
        assert!(TursoClient::from_config(&public, Client::new()).is_err());

        // Turso terkelola selalu wajib token.
        let turso = TursoConfig::turso("libsql://my-db.turso.io".into(), String::new());
        assert!(turso.requires_auth_token());
        assert!(TursoClient::from_config(&turso, Client::new()).is_err());
    }

    /// Mode lokal tidak menyentuh jaringan, jadi seluruh aturan transport dan
    /// kewajiban token tidak berlaku. Yang justru wajib dijaga adalah origin
    /// sintetisnya tetap stabil — vault perangkat mengikat snapshot kredensial
    /// padanya, sehingga origin yang berubah membatalkan seluruh akses offline.
    /// Regresi: "Lupa Password" lewat email pada Mode Database Lokal.
    ///
    /// Alur ini dilaporkan gagal dengan "akun tidak ditemukan" padahal jalur
    /// kode pemulihan — yang mencari lewat username/kode operator — berhasil.
    /// Perbedaannya hanya bentuk identitas yang dicari, jadi tes ini mengunci
    /// ketiganya sekaligus terhadap berkas lokal yang sungguhan.
    #[test]
    fn lupa_password_menemukan_akun_lewat_email() {
        let dir = tempfile::tempdir().expect("direktori sementara");
        let hub = dir.path().join("hub.db");
        let runtime = tokio::runtime::Builder::new_current_thread()
            .build()
            .expect("runtime uji");

        runtime.block_on(async {
            let client = TursoClient::local_file(
                Url::parse(LOCAL_FILE_ORIGIN).expect("origin lokal"),
                &hub,
                Client::new(),
            );
            client.ensure_schema().await.expect("provisioning lokal");
            client
                .bootstrap_superadmin(BootstrapSuperadminDraft {
                    kode_operator: "SPD001".into(),
                    nama_operator: "Superadmin Uji".into(),
                    username: "superadmin.uji".into(),
                    email: "Superadmin.Uji@Contoh.ID".into(),
                    no_hp: "081234567890".into(),
                    password: "KataSandiUji#2026".into(),
                })
                .await
                .expect("bootstrap superadmin");

            // Username — jalur yang dilaporkan berhasil.
            client
                .password_reset_lookup("superadmin.uji")
                .await
                .expect("pencarian lewat username");

            // Email persis seperti yang diketik saat bootstrap.
            client
                .password_reset_lookup("Superadmin.Uji@Contoh.ID")
                .await
                .expect("pencarian lewat email apa adanya");

            // Email dalam huruf kecil — bentuk yang tersimpan di database.
            client
                .password_reset_lookup("superadmin.uji@contoh.id")
                .await
                .expect("pencarian lewat email huruf kecil");
        });
    }

    /// Jalan pulih terakhir bagi Superadmin, dibuktikan tanpa jaringan.
    ///
    /// Akun pertama adalah satu-satunya akun yang tidak punya siapa pun di
    /// atasnya untuk menyetujui pemulihan. Tanpa kode ini, sebuah pemasangan
    /// mode lokal bisa terkunci selamanya hanya karena satu password terlupa —
    /// tidak ada email yang bisa dikirim, dan tidak ada peninjau yang bisa
    /// dimintai tolong.
    #[test]
    fn kode_pemulihan_mengembalikan_akses_tanpa_jaringan() {
        let dir = tempfile::tempdir().expect("direktori sementara");
        let hub = dir.path().join("sppg-hub.db");
        let runtime = tokio::runtime::Builder::new_current_thread()
            .build()
            .expect("runtime uji");

        runtime.block_on(async {
            let client = TursoClient::local_file(
                Url::parse(LOCAL_FILE_ORIGIN).expect("origin lokal"),
                &hub,
                Client::new(),
            );
            client.ensure_schema().await.expect("provisioning lokal");

            let codes = client
                .bootstrap_superadmin(BootstrapSuperadminDraft {
                    kode_operator: "SPD001".into(),
                    nama_operator: "Superadmin Uji".into(),
                    username: "superadmin.uji".into(),
                    email: "superadmin.uji@contoh.id".into(),
                    no_hp: "081234567890".into(),
                    password: "KataSandiLama#2026".into(),
                })
                .await
                .expect("bootstrap superadmin");

            assert_eq!(codes.len(), 8, "kode pemulihan wajib terbit saat bootstrap");
            // Kode harus dapat dibaca manusia yang menyalinnya dari layar ke
            // kertas: tanpa karakter yang mudah tertukar seperti 0/O dan 1/I.
            for code in &codes {
                assert!(!code.contains('0') && !code.contains('O'));
                assert!(!code.contains('1') && !code.contains('I'));
            }

            let dipakai = codes.first().expect("kode pertama").clone();

            // Kode yang salah ditolak, dan TIDAK boleh membocorkan apakah
            // akunnya ada.
            let salah = client
                .password_recovery_with_code("superadmin.uji", "XXXX-XXXX", "KataSandiBaru#2026")
                .await
                .expect_err("kode salah harus ditolak");
            assert_eq!(salah.code, "RECOVERY_REJECTED");
            let tidak_ada = client
                .password_recovery_with_code("akun.tidak.ada", &dipakai, "KataSandiBaru#2026")
                .await
                .expect_err("akun tidak ada harus ditolak");
            assert_eq!(tidak_ada.code, salah.code);
            assert_eq!(tidak_ada.message, salah.message);

            // Password baru yang terlalu pendek ditolak SEBELUM kode dikonsumsi.
            let lemah = client
                .password_recovery_with_code("superadmin.uji", &dipakai, "pendek")
                .await
                .expect_err("password lemah harus ditolak");
            assert_eq!(lemah.code, "RECOVERY_PASSWORD_WEAK");

            let hasil = client
                .password_recovery_with_code("superadmin.uji", &dipakai, "KataSandiBaru#2026")
                .await
                .expect("pemulihan harus berhasil");
            assert_eq!(hasil.get("sisaKode").and_then(Value::as_i64), Some(7));

            // Password baru berlaku, password lama tidak.
            client
                .authenticate_operator("superadmin.uji", "KataSandiBaru#2026", None)
                .await
                .expect("login dengan password baru");
            assert!(client
                .authenticate_operator("superadmin.uji", "KataSandiLama#2026", None)
                .await
                .is_err());

            // Kode sekali pakai: percobaan kedua dengan kode yang sama ditolak.
            let ulang = client
                .password_recovery_with_code("superadmin.uji", &dipakai, "KataSandiLain#2026")
                .await
                .expect_err("kode bekas harus ditolak");
            assert_eq!(ulang.code, "RECOVERY_REJECTED");
        });
    }

    /// Janji utama mode lokal, dibuktikan ujung ke ujung: sebuah perangkat
    /// yang belum pernah tersambung ke mana pun bisa dipasang, membuat akun
    /// pertamanya, lalu dipakai masuk — tanpa satu paket jaringan pun.
    ///
    /// Ketiga langkahnya memakai fungsi produksi yang sama persis dengan jalur
    /// cloud (`ensure_schema`, `bootstrap_superadmin`, `authenticate_operator`);
    /// yang berbeda hanya transportnya. Kalau tes ini lulus, tidak ada lagi
    /// bagian dari alur pemasangan yang diam-diam menuntut server.
    #[test]
    fn bootstrap_lalu_login_berhasil_tanpa_jaringan() {
        let dir = tempfile::tempdir().expect("direktori sementara");
        let hub = dir.path().join("sppg-hub.db");
        let runtime = tokio::runtime::Builder::new_current_thread()
            .build()
            .expect("runtime uji");

        runtime.block_on(async {
            let client = TursoClient::local_file(
                Url::parse(LOCAL_FILE_ORIGIN).expect("origin lokal"),
                &hub,
                Client::new(),
            );
            client.ensure_schema().await.expect("provisioning lokal");

            // Database baru wajib meminta akun pertama dibuat.
            let sebelum = client.bootstrap_status().await.expect("status bootstrap");
            assert!(sebelum.required, "database baru harus menuntut bootstrap");

            client
                .bootstrap_superadmin(BootstrapSuperadminDraft {
                    kode_operator: "SPD001".into(),
                    nama_operator: "Superadmin Uji".into(),
                    username: "superadmin.uji".into(),
                    email: "superadmin.uji@contoh.id".into(),
                    no_hp: "081234567890".into(),
                    password: "KataSandiUji#2026".into(),
                })
                .await
                .expect("bootstrap superadmin");

            // Sesudah akun pertama ada, pintu bootstrap wajib tertutup —
            // membiarkannya terbuka berarti siapa pun bisa membuat Superadmin
            // kedua tanpa melewati satu pun pemeriksaan hak akses.
            let sesudah = client.bootstrap_status().await.expect("status bootstrap");
            assert!(!sesudah.required, "bootstrap harus tertutup setelah akun pertama dibuat");

            let operator = client
                .authenticate_operator("superadmin.uji", "KataSandiUji#2026", None)
                .await
                .expect("login lokal");
            assert!(operator.is_superadmin);
            assert_eq!(operator.username, "superadmin.uji");
            assert!(!operator.totp_enabled, "akun baru belum memakai 2FA");

            // Kode operator juga sah sebagai identitas login.
            let lewat_kode = client
                .authenticate_operator("SPD001", "KataSandiUji#2026", None)
                .await
                .expect("login memakai kode operator");
            assert_eq!(lewat_kode.id, operator.id);

            // Password yang salah tetap ditolak — jalur lokal bukan jalan pintas.
            let ditolak = client
                .authenticate_operator("superadmin.uji", "salah", None)
                .await
                .expect_err("password salah harus ditolak");
            assert_eq!(ditolak.code, "LOGIN_REJECTED");
        });
    }

    /// Provisioning mode lokal, dari ujung ke ujung.
    ///
    /// Inilah bukti janji utama arsitektur ini: SQL yang sama persis yang
    /// membangun database cloud juga membangun berkas lokal. Bukan salinan
    /// DDL, bukan skema kedua — `ensure_schema()` yang sama, hanya dengan
    /// transport yang ditukar. Kalau tes ini lulus, drift antara tabel lokal
    /// dan tabel cloud tidak mungkin terjadi karena keduanya lahir dari satu
    /// fungsi.
    #[test]
    fn provisioning_lokal_membangun_seluruh_tabel_cloud() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .build()
            .expect("runtime uji");
        runtime.block_on(async {
        let dir = tempfile::tempdir().expect("direktori sementara");
        let hub = dir.path().join("sppg-hub.db");

        let client = TursoClient::local_file(
            Url::parse(LOCAL_FILE_ORIGIN).expect("origin lokal"),
            &hub,
            Client::new(),
        );
        client.ensure_schema().await.expect("provisioning lokal");

        let connection = rusqlite::Connection::open(&hub).expect("buka hub");

        // Ke-35 tabel yang dituntut `isDatabaseSchemaReady` di `db-schema.ts`.
        // Daftar ini sengaja dieja ulang di sini: kalau salah satunya berhenti
        // dibuat, aplikasi Web akan menganggap database selamanya belum siap.
        for table in [
            "master_data", "id_card", "master_operator", "tbl_shift",
            "setting_gex_system", "log_scan", "absensi_harian",
            "backup_karyawan", "koreksi_admin", "audit_absensi", "app_role",
            "app_permission", "role_permission", "app_session",
            "auth_login_rate_limit", "sync_operation_receipt",
            "sync_change_log", "sync_changelog", "app_bootstrap_state",
            "import_offline", "tbl_hari_libur", "company_profile",
            "id_card_template", "salary_configs", "overtime_tier_rules",
            "payroll_components", "tax_rules", "bpjs_rules", "payroll_runs",
            "payroll_items", "payroll_audit_logs", "password_reset_request",
            "app_mail_config", "absensi_foto", "hari_libur_whitelist",
        ] {
            let ada: i64 = connection
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1;",
                    [table],
                    |row| row.get(0),
                )
                .unwrap_or(0);
            assert_eq!(ada, 1, "tabel '{table}' tidak dibuat oleh ensure_schema()");
        }

        // Penghitung perubahan per tabel: tanpa ini, setiap siklus tarik akan
        // menganggap seluruh tabel berpotensi berubah.
        let pulse: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'sync_pulse';",
                [],
                |row| row.get(0),
            )
            .unwrap_or(0);
        assert_eq!(pulse, 1, "sync_pulse tidak dibuat");

        let versi: i64 = connection
            .query_row(
                "SELECT COALESCE(MAX(version), 0) FROM schema_migration WHERE version > 0;",
                [],
                |row| row.get(0),
            )
            .expect("versi skema");
        assert_eq!(
            versi,
            crate::desktop::sync::CLIENT_SCHEMA_VERSION,
            "versi skema hasil provisioning lokal berbeda dari versi klien"
        );
        });
    }

    /// Katalog permission ikut tertanam, bukan hanya tabelnya.
    ///
    /// Database tanpa baris permission membuat setiap pemeriksaan hak akses
    /// gagal — Superadmin pun tidak bisa membuka apa pun.
    #[test]
    fn provisioning_lokal_menanam_role_dan_permission() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .build()
            .expect("runtime uji");
        runtime.block_on(async {
        let dir = tempfile::tempdir().expect("direktori sementara");
        let hub = dir.path().join("sppg-hub.db");

        let client = TursoClient::local_file(
            Url::parse(LOCAL_FILE_ORIGIN).expect("origin lokal"),
            &hub,
            Client::new(),
        );
        client.ensure_schema().await.expect("provisioning lokal");

        let connection = rusqlite::Connection::open(&hub).expect("buka hub");
        let permissions: i64 = connection
            .query_row("SELECT COUNT(*) FROM app_permission;", [], |row| row.get(0))
            .expect("hitung permission");
        assert!(
            permissions > 30,
            "katalog permission tidak tertanam (hanya {permissions} baris)"
        );

        let superadmin: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM app_role WHERE role_key = 'superadmin' AND is_superadmin = 1;",
                [],
                |row| row.get(0),
            )
            .expect("hitung role superadmin");
        assert_eq!(superadmin, 1, "role Superadmin tidak tertanam");
        });
    }

    #[test]
    fn mode_lokal_tidak_pernah_menuntut_token() {
        let local = TursoConfig::new(
            "C:/data/sppg-hub.db".into(),
            String::new(),
            DatabaseProvider::LocalFile,
            false,
        );
        assert!(!local.requires_auth_token());

        let client = TursoClient::from_config(&local, Client::new()).expect("klien lokal");
        assert!(client.is_local());
    }

    #[test]
    fn origin_mode_lokal_stabil_dan_tidak_bergantung_isi_path() {
        let a = normalize_database_url("C:/data/sppg-hub.db", DatabaseProvider::LocalFile, false)
            .expect("origin lokal");
        let b = normalize_database_url(
            "/home/pengguna/lain.db",
            DatabaseProvider::LocalFile,
            false,
        )
        .expect("origin lokal");

        assert_eq!(a, b);
        assert_eq!(a.as_str().trim_end_matches('/'), LOCAL_FILE_ORIGIN);
    }

    /// Lokasi berkas yang kosong adalah kesalahan yang harus terlihat, bukan
    /// berkas kosong yang diam-diam dibuat di direktori kerja.
    #[test]
    fn lokasi_berkas_lokal_wajib_terisi() {
        let kosong = TursoConfig::new(
            "   ".into(),
            String::new(),
            DatabaseProvider::LocalFile,
            false,
        );
        let error = kosong.local_file_path().expect_err("harus gagal");
        assert_eq!(error.code, "LOCAL_DB_PATH_MISSING");
        assert!(TursoClient::from_config(&kosong, Client::new()).is_err());
    }

    #[test]
    fn nama_setting_provider_lokal_bukan_local() {
        // `"local"` sudah lebih dulu berarti server sendiri pada instalasi yang
        // ada; memakainya ulang akan mengubah arti data pelanggan.
        assert_eq!(DatabaseProvider::LocalFile.as_str(), "local_file");
        assert_eq!(DatabaseProvider::SelfHosted.as_str(), "self_hosted");
        assert!(DatabaseProvider::LocalFile.is_local_file());
        assert!(!DatabaseProvider::LocalFile.is_self_hosted());
    }

    #[test]
    fn matches_url_compares_normalized_spellings() {
        let config = TursoConfig::turso("libsql://my-db.turso.io".into(), "token".into());
        assert!(config.matches_url("https://my-db.turso.io"));
        assert!(config.matches_url("https://my-db.turso.io/"));
        assert!(config.matches_url("  libsql://my-db.turso.io  "));
        assert!(!config.matches_url("https://other-db.turso.io"));
    }

    #[test]
    fn insecure_flag_is_dropped_outside_self_hosted_mode() {
        let config = TursoConfig::new(
            "libsql://my-db.turso.io".into(),
            "token".into(),
            DatabaseProvider::Turso,
            true,
        );
        assert!(!config.allow_insecure_transport);
    }

    #[test]
    fn legacy_vault_payload_defaults_to_turso_provider() {
        // Vault yang ditulis versi lama hanya memuat dua field. Kalau default-nya
        // tidak Turso, seluruh instalasi lama akan gagal memuat konfigurasi.
        let config: TursoConfig = serde_json::from_str(
            r#"{"database_url":"libsql://my-db.turso.io","auth_token":"token"}"#,
        )
        .unwrap();
        assert_eq!(config.provider, DatabaseProvider::Turso);
        assert!(!config.allow_insecure_transport);
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
            email: "pemilik@sppg.id".into(),
            no_hp: "081234567890".into(),
            password: "Aman-Sekali-2026!".into(),
        };
        assert!(validate_bootstrap_draft(&strong).is_ok());
        let weak = BootstrapSuperadminDraft {
            password: "admin123".into(),
            ..strong.clone()
        };
        assert_eq!(
            validate_bootstrap_draft(&weak)
                .expect_err("weak password")
                .code,
            "TURSO_BOOTSTRAP_PASSWORD_WEAK"
        );
        // Superadmin adalah satu-satunya akun yang tidak punya Admin lain untuk
        // memulihkannya, jadi kontaknya wajib sejak awal.
        let tanpa_kontak = BootstrapSuperadminDraft {
            email: String::new(),
            ..strong
        };
        assert_eq!(
            validate_bootstrap_draft(&tanpa_kontak)
                .expect_err("kontak wajib")
                .code,
            "VALIDATION_ERROR"
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

    #[test]
    fn error_skema_dikenali_untuk_penyembuhan() {
        // Bentuk pesan yang benar-benar dikembalikan libSQL saat kolom atau
        // tabel belum ada di cloud.
        assert!(is_recoverable_schema_error(
            "SQLite error: table tbl_shift has no column named shift_lanjutan_id"
        ));
        assert!(is_recoverable_schema_error("no such column: shift_lanjutan_id"));
        assert!(is_recoverable_schema_error("SQLite error: no such table: tbl_shift"));

        // Konflik data yang sebenarnya tidak boleh memicu migrasi ulang.
        assert!(!is_recoverable_schema_error(
            "Data server berubah setelah snapshot lokal dibuat."
        ));
        assert!(!is_recoverable_schema_error(
            "Data absensi sudah dikoreksi admin dan tidak boleh ditimpa sumber lain."
        ));
        assert!(!is_recoverable_schema_error("UNIQUE constraint failed: tbl_shift.kode_shift"));
    }

    #[test]
    fn scan_tidak_boleh_menimpa_koreksi_admin_di_jalur_turso() {
        // Scan mencoba MENGUBAH jam masuk yang sudah diisi admin.
        let payload = json!({
            "attendance": {
                "id_sesi": "SESI-1",
                "jam_masuk": "2026-08-10 08:15:00",
                "jam_pulang": ""
            },
            "attendanceBaseUpdatedAt": "2026-08-10 07:30:00"
        });
        let dikoreksi = AttendanceGuardRow {
            sumber: "Koreksi Admin".into(),
            update_terakhir: "2026-08-10 07:30:00".into(),
            jam_masuk: "2026-08-10 07:00:00".into(),
            jam_pulang: String::new(),
            status_kehadiran: "Hadir".into(),
        };

        // Scanner terminal berada di bawah Koreksi Admin pada hierarki prioritas.
        let ditolak =
            assert_attendance_precondition("attendance", "scan", &payload, Some(&dikoreksi));
        assert_eq!(
            ditolak.unwrap_err().code,
            "TURSO_SYNC_ATTENDANCE_PROTECTED"
        );

        // Import offline juga tidak boleh menimpa koreksi admin.
        assert!(
            assert_attendance_precondition("offline-import", "row", &payload, Some(&dikoreksi))
                .is_err()
        );

        // Koreksi admin berikutnya tetap boleh menulis.
        assert!(
            assert_attendance_precondition("correction", "create", &payload, Some(&dikoreksi))
                .is_ok()
        );
    }

    #[test]
    fn scan_pulang_boleh_melengkapi_baris_koreksi_admin() {
        // Admin mengoreksi jam masuk; jam pulang masih kosong. Scan pulang
        // hanya MENGISI kolom kosong itu, tidak menimpa keputusan admin.
        let dikoreksi = AttendanceGuardRow {
            sumber: "Koreksi Admin".into(),
            update_terakhir: "2026-08-10 07:30:00".into(),
            jam_masuk: "2026-08-10 07:00:00".into(),
            jam_pulang: String::new(),
            status_kehadiran: "Hadir".into(),
        };
        let payload = json!({
            "attendance": {
                "id_sesi": "SESI-1",
                "jam_masuk": "2026-08-10 07:00:00",
                "jam_pulang": "2026-08-10 15:10:00"
            },
            "attendanceBaseUpdatedAt": "2026-08-10 07:30:00"
        });

        assert!(
            assert_attendance_precondition("attendance", "scan", &payload, Some(&dikoreksi)).is_ok()
        );

        // Menghapus jam masuk yang diisi admin tetap terlarang.
        let menghapus = json!({
            "attendance": {
                "id_sesi": "SESI-1",
                "jam_masuk": "",
                "jam_pulang": "2026-08-10 15:10:00"
            },
            "attendanceBaseUpdatedAt": "2026-08-10 07:30:00"
        });
        assert_eq!(
            assert_attendance_precondition("attendance", "scan", &menghapus, Some(&dikoreksi))
                .unwrap_err()
                .code,
            "TURSO_SYNC_ATTENDANCE_PROTECTED"
        );

        // Koreksi Sakit/Izin/Dispen/Alfa mengosongkan kedua jam. Scan tidak
        // boleh menghidupkannya kembali menjadi Hadir walaupun secara teknis
        // hanya "mengisi kolom kosong".
        let sakit = AttendanceGuardRow {
            sumber: "Koreksi Admin".into(),
            update_terakhir: "2026-08-10 07:30:00".into(),
            jam_masuk: String::new(),
            jam_pulang: String::new(),
            status_kehadiran: "Sakit".into(),
        };
        assert_eq!(
            assert_attendance_precondition("attendance", "scan", &payload, Some(&sakit))
                .unwrap_err()
                .code,
            "TURSO_SYNC_ATTENDANCE_PROTECTED"
        );
    }

    #[test]
    fn force_local_override_menyelesaikan_konflik_basi() {
        // Basis optimistis di payload tidak cocok dengan server. Tanpa jalan
        // keluar, operator menekan "Gunakan Versi Lokal" berkali-kali dan
        // konfliknya muncul terus dengan pesan yang sama.
        let basi = AttendanceGuardRow {
            sumber: "Scanner".into(),
            update_terakhir: "2026-08-10 09:00:00".into(),
            jam_masuk: String::new(),
            jam_pulang: String::new(),
            status_kehadiran: "Hadir".into(),
        };
        let payload = json!({
            "attendance": { "id_sesi": "SESI-1" },
            "attendanceBaseUpdatedAt": "2026-08-10 07:30:00"
        });
        assert_eq!(
            assert_attendance_precondition("attendance", "scan", &payload, Some(&basi))
                .unwrap_err()
                .code,
            "TURSO_SYNC_ATTENDANCE_STALE"
        );

        let dipaksa = json!({
            "attendance": { "id_sesi": "SESI-1" },
            "attendanceBaseUpdatedAt": "2026-08-10 07:30:00",
            "forceLocalOverride": true
        });
        assert!(
            assert_attendance_precondition("attendance", "scan", &dipaksa, Some(&basi)).is_ok()
        );

        // Prioritas Koreksi Admin TETAP menang: "gunakan lokal" tidak boleh
        // menjadi pintu belakang untuk menimpa keputusan admin.
        let dikoreksi = AttendanceGuardRow {
            sumber: "Koreksi Admin".into(),
            update_terakhir: "2026-08-10 07:30:00".into(),
            jam_masuk: "2026-08-10 07:00:00".into(),
            jam_pulang: String::new(),
            status_kehadiran: "Hadir".into(),
        };
        let menimpa = json!({
            "attendance": {
                "id_sesi": "SESI-1",
                "jam_masuk": "2026-08-10 09:99:00",
                "jam_pulang": ""
            },
            "attendanceBaseUpdatedAt": "2026-08-10 07:30:00",
            "forceLocalOverride": true
        });
        assert_eq!(
            assert_attendance_precondition("attendance", "scan", &menimpa, Some(&dikoreksi))
                .unwrap_err()
                .code,
            "TURSO_SYNC_ATTENDANCE_PROTECTED"
        );
    }

    #[test]
    fn event_absensi_basi_ditolak_sebagai_konflik() {
        let payload = json!({
            "attendance": { "id_sesi": "SESI-1" },
            "attendanceBaseUpdatedAt": "2026-08-10 07:30:00"
        });
        let berubah = AttendanceGuardRow {
            sumber: "Scanner".into(),
            update_terakhir: "2026-08-10 09:00:00".into(),
            jam_masuk: String::new(),
            jam_pulang: String::new(),
            status_kehadiran: "Hadir".into(),
        };
        assert_eq!(
            assert_attendance_precondition("attendance", "scan", &payload, Some(&berubah))
                .unwrap_err()
                .code,
            "TURSO_SYNC_ATTENDANCE_STALE"
        );

        // Basis sama: boleh lanjut.
        let sama = AttendanceGuardRow {
            sumber: "Scanner".into(),
            update_terakhir: "2026-08-10 07:30:00".into(),
            jam_masuk: String::new(),
            jam_pulang: String::new(),
            status_kehadiran: "Hadir".into(),
        };
        assert!(
            assert_attendance_precondition("attendance", "scan", &payload, Some(&sama)).is_ok()
        );

        // Baris belum ada dan client tidak mengirim basis: sesi baru, boleh lanjut.
        let baru = json!({ "attendance": { "id_sesi": "SESI-2" } });
        assert!(assert_attendance_precondition("attendance", "scan", &baru, None).is_ok());

        // Client mengira ada basis padahal baris sudah hilang: konflik.
        assert!(assert_attendance_precondition("attendance", "scan", &payload, None).is_err());

        // Domain yang tidak menyentuh absensi tidak terpengaruh guard ini.
        assert!(
            assert_attendance_precondition("employee", "update", &payload, Some(&berubah)).is_ok()
        );
    }
}
