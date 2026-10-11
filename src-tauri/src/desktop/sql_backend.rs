//! Seam transport SQL: satu skema, dua jalan menuju database.
//!
//! Seluruh SQL cloud di `turso.rs` — 98 `Statement` — melewati satu titik saja,
//! `execute_pipeline`. Modul ini memisahkan "apa SQL-nya" dari "ke mana SQL
//! dikirim", sehingga mode lokal tidak perlu menulis ulang satu baris SQL pun.
//! Tabel lokal dan tabel cloud lahir dari fungsi yang sama persis, jadi drift
//! skema di antara keduanya bukan sekadar dicegah — ia mustahil.
//!
//! Yang paling menentukan di sini adalah **bentuk nilai hasil query**. Jalur
//! Hrana mengirim integer sebagai string JSON lalu mem-parse-nya menjadi angka,
//! dan blob sebagai base64. Bila jalur lokal menghasilkan bentuk yang berbeda,
//! setiap `as_i64()` di hilir berubah perilaku tanpa satu pun pesan kesalahan.
//! Karena itu dekoder Hrana diekstrak ke sini (`decode_hrana_cell`) dan diuji
//! berdampingan dengan dekoder lokal terhadap nilai yang sama.

use std::path::{Path, PathBuf};

use base64::prelude::*;
use rusqlite::{types::ValueRef, Connection};
use serde_json::{json, Value};

use super::models::CommandError;
use super::turso::{QueryResult, Statement};

/// PRAGMA yang sama dengan `storage::database`, supaya berkas hub lokal
/// berperilaku identik dengan database perangkat: WAL agar pembacaan tidak
/// memblokir penulisan, dan `busy_timeout` agar dua proses tidak saling
/// menolak dengan SQLITE_BUSY.
const LOCAL_PRAGMAS: &str = "PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000; PRAGMA temp_store = MEMORY; PRAGMA cache_size = -64000;";

/// Terjemahkan satu sel jawaban Hrana menjadi nilai JSON.
///
/// Dulu logika ini tertanam di dalam `execute_pipeline`, sehingga tidak ada
/// cara menguji apakah jalur lokal menghasilkan bentuk yang sama. Perhatikan
/// `"integer"`: libsql mengirimkannya sebagai **string** agar tidak kehilangan
/// presisi di JSON, dan hasil akhirnya harus berupa angka.
pub fn decode_hrana_cell(cell: &Value) -> Value {
    match cell.get("type").and_then(Value::as_str).unwrap_or("") {
        "null" => Value::Null,
        "integer" => {
            let raw = cell.get("value");
            if let Some(text) = raw.and_then(Value::as_str) {
                text.parse::<i64>()
                    .map(|number| json!(number))
                    .unwrap_or_else(|_| json!(text))
            } else if let Some(number) = raw.and_then(Value::as_i64) {
                json!(number)
            } else {
                Value::Null
            }
        }
        "float" => cell.get("value").cloned().unwrap_or(Value::Null),
        "text" => cell.get("value").cloned().unwrap_or(Value::Null),
        "blob" => cell.get("base64").cloned().unwrap_or(Value::Null),
        _ => cell.clone(),
    }
}

/// Terjemahkan satu nilai SQLite lokal menjadi nilai JSON.
///
/// Wajib menghasilkan bentuk yang identik dengan [`decode_hrana_cell`] — itulah
/// yang diuji di modul test di bawah.
fn decode_local_cell(value: ValueRef<'_>) -> Value {
    match value {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(number) => json!(number),
        ValueRef::Real(number) => json!(number),
        ValueRef::Text(bytes) => Value::String(String::from_utf8_lossy(bytes).into_owned()),
        ValueRef::Blob(bytes) => Value::String(BASE64_STANDARD.encode(bytes)),
    }
}

/// Pasang argumen `Statement` ke pernyataan SQLite.
///
/// Aturannya mencerminkan `Statement::to_libsql_v2_stmt` satu per satu: boolean
/// menjadi integer 0/1, dan nilai bertingkat (array/objek) menjadi teks. Kalau
/// keduanya berbeda, satu argumen yang sama akan tersimpan sebagai tipe berbeda
/// di lokal dan di cloud.
fn bind_arguments(
    statement: &mut rusqlite::Statement<'_>,
    args: &[Value],
) -> Result<(), CommandError> {
    for (index, arg) in args.iter().enumerate() {
        let position = index + 1;
        let result = match arg {
            Value::Null => statement.raw_bind_parameter(position, rusqlite::types::Null),
            Value::Bool(flag) => {
                statement.raw_bind_parameter(position, if *flag { 1_i64 } else { 0_i64 })
            }
            Value::Number(number) => {
                if let Some(integer) = number.as_i64() {
                    statement.raw_bind_parameter(position, integer)
                } else if let Some(float) = number.as_f64() {
                    statement.raw_bind_parameter(position, float)
                } else {
                    statement.raw_bind_parameter(position, rusqlite::types::Null)
                }
            }
            Value::String(text) => statement.raw_bind_parameter(position, text.as_str()),
            other => statement.raw_bind_parameter(position, other.to_string()),
        };
        result.map_err(|error| {
            CommandError::new(
                "LOCAL_SQL_ERROR",
                format!("Argumen ke-{position} tidak dapat dipasang: {error}"),
            )
        })?;
    }
    Ok(())
}

/// Transport ke berkas SQLite lokal.
///
/// Menyimpan lokasi berkas, bukan koneksi terbuka: koneksi dibuka per panggilan
/// persis seperti `storage::database`. Selain menghindari `Connection` yang
/// tidak `Sync` melintasi titik `.await`, ini juga membuat mode lokal memakai
/// pola siklus hidup yang sudah terbukti di modul penyimpanan perangkat.
#[derive(Clone, Debug)]
pub struct LocalTransport {
    path: PathBuf,
}

impl LocalTransport {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into() }
    }

    /// Lokasi berkas hub. Dipakai layar status koneksi pada Fase 02.
    #[allow(dead_code)]
    pub fn path(&self) -> &Path {
        &self.path
    }

    fn open(&self) -> Result<Connection, CommandError> {
        let connection = Connection::open(&self.path).map_err(|error| {
            CommandError::new(
                "LOCAL_DB_UNAVAILABLE",
                format!("Berkas database lokal tidak dapat dibuka: {error}"),
            )
        })?;
        connection.execute_batch(LOCAL_PRAGMAS).map_err(|error| {
            CommandError::new(
                "LOCAL_DB_UNAVAILABLE",
                format!("Database lokal tidak dapat disiapkan: {error}"),
            )
        })?;
        Ok(connection)
    }

    /// Jalankan sederet pernyataan berurutan, tanpa transaksi.
    ///
    /// Sama seperti pipeline Hrana: kegagalan satu pernyataan menghentikan
    /// sisanya dan mengembalikan error, tetapi pernyataan yang sudah berhasil
    /// TIDAK dibatalkan. Yang butuh sifat semua-atau-tidak memakai
    /// [`LocalTransport::execute_atomic`].
    pub fn execute_pipeline(
        &self,
        statements: Vec<Statement>,
    ) -> Result<Vec<QueryResult>, CommandError> {
        let connection = self.open()?;
        let mut results = Vec::with_capacity(statements.len());
        for statement in &statements {
            results.push(run_statement(&connection, statement)?);
        }
        Ok(results)
    }

    /// Jalankan sederet pernyataan sebagai satu transaksi.
    ///
    /// `BEGIN IMMEDIATE` dipilih agar kunci tulis diambil di awal, sama dengan
    /// langkah pertama batch atomik jalur Hrana. Kegagalan mana pun memicu
    /// ROLLBACK sehingga tidak ada data separuh jadi yang tertinggal.
    pub fn execute_atomic(&self, statements: Vec<Statement>) -> Result<(), CommandError> {
        if statements.is_empty() {
            return Ok(());
        }

        let connection = self.open()?;
        connection.execute_batch("BEGIN IMMEDIATE;").map_err(|error| {
            CommandError::new(
                "LOCAL_SQL_ERROR",
                format!("Transaksi database lokal tidak dapat dimulai: {error}"),
            )
        })?;

        for statement in &statements {
            if let Err(error) = run_statement(&connection, statement) {
                let _ = connection.execute_batch("ROLLBACK;");
                return Err(error);
            }
        }

        connection.execute_batch("COMMIT;").map_err(|error| {
            let _ = connection.execute_batch("ROLLBACK;");
            CommandError::new(
                "LOCAL_TRANSACTION_ROLLED_BACK",
                format!("Transaksi database lokal dibatalkan agar tidak meninggalkan data parsial: {error}"),
            )
        })?;

        Ok(())
    }
}

/// Eksekusi satu pernyataan dan bentuk hasilnya seperti jawaban Hrana.
fn run_statement(
    connection: &Connection,
    statement: &Statement,
) -> Result<QueryResult, CommandError> {
    let mut prepared = connection.prepare(&statement.sql).map_err(|error| {
        CommandError::new("LOCAL_SQL_ERROR", format!("{error}"))
    })?;

    bind_arguments(&mut prepared, &statement.args)?;

    let columns: Vec<String> = prepared
        .column_names()
        .into_iter()
        .map(str::to_owned)
        .collect();
    let column_count = columns.len();

    let mut rows = Vec::new();
    let mut cursor = prepared.raw_query();
    loop {
        let row = cursor
            .next()
            .map_err(|error| CommandError::new("LOCAL_SQL_ERROR", format!("{error}")))?;
        let Some(row) = row else { break };

        let mut cells = Vec::with_capacity(column_count);
        for index in 0..column_count {
            let value = row
                .get_ref(index)
                .map_err(|error| CommandError::new("LOCAL_SQL_ERROR", format!("{error}")))?;
            cells.push(decode_local_cell(value));
        }
        rows.push(cells);
    }
    drop(cursor);
    drop(prepared);

    let rows_affected = connection.changes();
    // Jalur Hrana mengembalikan null untuk pernyataan yang tidak menyisipkan
    // baris. `last_insert_rowid()` SQLite bernilai 0 sebelum INSERT pertama
    // pada koneksi ini, sehingga 0 dipetakan ke None agar pemanggil di hilir
    // melihat bentuk yang sama.
    let last_rowid = connection.last_insert_rowid();
    let last_insert_rowid = if last_rowid == 0 { None } else { Some(last_rowid) };

    Ok(QueryResult {
        columns,
        rows,
        rows_affected,
        last_insert_rowid,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn transport() -> (tempfile::TempDir, LocalTransport) {
        let dir = tempdir().expect("direktori sementara");
        let transport = LocalTransport::new(dir.path().join("hub.db"));
        (dir, transport)
    }

    /// Paritas bentuk nilai: satu nilai logis, dua dekoder, hasil harus sama.
    ///
    /// Inilah pengujian terpenting di modul ini. Bila salah satu tipe bergeser,
    /// setiap `as_i64()`/`as_str()` di hilir berubah diam-diam.
    #[test]
    fn dekoder_lokal_dan_hrana_menghasilkan_bentuk_sama() {
        // integer: Hrana mengirimnya sebagai string, hasilnya wajib angka.
        assert_eq!(
            decode_hrana_cell(&json!({ "type": "integer", "value": "42" })),
            decode_local_cell(ValueRef::Integer(42)),
        );
        assert_eq!(
            decode_hrana_cell(&json!({ "type": "integer", "value": "-9007199254740993" })),
            decode_local_cell(ValueRef::Integer(-9_007_199_254_740_993)),
        );
        assert_eq!(
            decode_hrana_cell(&json!({ "type": "float", "value": 1.5 })),
            decode_local_cell(ValueRef::Real(1.5)),
        );
        assert_eq!(
            decode_hrana_cell(&json!({ "type": "text", "value": "Koreksi Admin" })),
            decode_local_cell(ValueRef::Text("Koreksi Admin".as_bytes())),
        );
        assert_eq!(
            decode_hrana_cell(&json!({ "type": "null" })),
            decode_local_cell(ValueRef::Null),
        );
        // blob: Hrana menyerahkan base64, jalur lokal wajib meng-encode sendiri.
        assert_eq!(
            decode_hrana_cell(&json!({ "type": "blob", "base64": BASE64_STANDARD.encode([1_u8, 2, 3]) })),
            decode_local_cell(ValueRef::Blob(&[1, 2, 3])),
        );
    }

    #[test]
    fn integer_besar_tidak_kehilangan_presisi() {
        let (_dir, transport) = transport();
        transport
            .execute_pipeline(vec![Statement::new(
                "CREATE TABLE t (nilai INTEGER);",
                vec![],
            )])
            .expect("DDL");

        let besar = 9_007_199_254_740_993_i64;
        transport
            .execute_pipeline(vec![Statement::new(
                "INSERT INTO t (nilai) VALUES (?);",
                vec![json!(besar)],
            )])
            .expect("insert");

        let hasil = transport
            .execute_pipeline(vec![Statement::new("SELECT nilai FROM t;", vec![])])
            .expect("select");
        assert_eq!(hasil[0].rows[0][0].as_i64(), Some(besar));
    }

    #[test]
    fn kolom_dan_baris_terbaca_sesuai_urutan() {
        let (_dir, transport) = transport();
        transport
            .execute_pipeline(vec![
                Statement::new("CREATE TABLE t (a TEXT, b INTEGER, c REAL);", vec![]),
                Statement::new(
                    "INSERT INTO t (a, b, c) VALUES (?, ?, ?);",
                    vec![json!("x"), json!(7), json!(2.5)],
                ),
            ])
            .expect("siapkan");

        let hasil = transport
            .execute_pipeline(vec![Statement::new("SELECT a, b, c FROM t;", vec![])])
            .expect("select");

        assert_eq!(hasil[0].columns, vec!["a", "b", "c"]);
        assert_eq!(hasil[0].rows[0][0], json!("x"));
        assert_eq!(hasil[0].rows[0][1], json!(7));
        assert_eq!(hasil[0].rows[0][2], json!(2.5));
    }

    #[test]
    fn rows_affected_dan_last_insert_rowid_terisi() {
        let (_dir, transport) = transport();
        transport
            .execute_pipeline(vec![Statement::new(
                "CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, nama TEXT);",
                vec![],
            )])
            .expect("DDL");

        let insert = transport
            .execute_pipeline(vec![Statement::new(
                "INSERT INTO t (nama) VALUES (?);",
                vec![json!("Budi")],
            )])
            .expect("insert");
        assert_eq!(insert[0].rows_affected, 1);
        assert_eq!(insert[0].last_insert_rowid, Some(1));

        let hapus = transport
            .execute_pipeline(vec![Statement::new("DELETE FROM t;", vec![])])
            .expect("delete");
        assert_eq!(hapus[0].rows_affected, 1);
    }

    /// Argumen boolean harus tersimpan sebagai integer, sama seperti jalur
    /// Hrana yang memetakan `Value::Bool` ke `{"type":"integer"}`.
    #[test]
    fn boolean_tersimpan_sebagai_integer() {
        let (_dir, transport) = transport();
        transport
            .execute_pipeline(vec![
                Statement::new("CREATE TABLE t (aktif INTEGER);", vec![]),
                Statement::new("INSERT INTO t (aktif) VALUES (?);", vec![json!(true)]),
            ])
            .expect("siapkan");

        let hasil = transport
            .execute_pipeline(vec![Statement::new(
                "SELECT aktif, typeof(aktif) AS tipe FROM t;",
                vec![],
            )])
            .expect("select");
        assert_eq!(hasil[0].rows[0][0], json!(1));
        assert_eq!(hasil[0].rows[0][1], json!("integer"));
    }

    #[test]
    fn transaksi_gagal_tidak_meninggalkan_data_parsial() {
        let (_dir, transport) = transport();
        transport
            .execute_pipeline(vec![Statement::new(
                "CREATE TABLE t (id INTEGER PRIMARY KEY, nama TEXT NOT NULL);",
                vec![],
            )])
            .expect("DDL");

        let hasil = transport.execute_atomic(vec![
            Statement::new("INSERT INTO t (id, nama) VALUES (1, 'satu');", vec![]),
            // Melanggar NOT NULL: seluruh transaksi harus dibatalkan.
            Statement::new("INSERT INTO t (id, nama) VALUES (2, NULL);", vec![]),
        ]);
        assert!(hasil.is_err());

        let jumlah = transport
            .execute_pipeline(vec![Statement::new(
                "SELECT COUNT(*) AS jumlah FROM t;",
                vec![],
            )])
            .expect("hitung");
        assert_eq!(jumlah[0].rows[0][0], json!(0));
    }

    #[test]
    fn transaksi_berhasil_menyimpan_seluruh_baris() {
        let (_dir, transport) = transport();
        transport
            .execute_pipeline(vec![Statement::new(
                "CREATE TABLE t (id INTEGER PRIMARY KEY);",
                vec![],
            )])
            .expect("DDL");

        transport
            .execute_atomic(vec![
                Statement::new("INSERT INTO t (id) VALUES (1);", vec![]),
                Statement::new("INSERT INTO t (id) VALUES (2);", vec![]),
            ])
            .expect("atomic");

        let jumlah = transport
            .execute_pipeline(vec![Statement::new(
                "SELECT COUNT(*) AS jumlah FROM t;",
                vec![],
            )])
            .expect("hitung");
        assert_eq!(jumlah[0].rows[0][0], json!(2));
    }

    /// Pipeline TIDAK bersifat transaksional — sifat yang sama dengan jalur
    /// Hrana, dan yang membedakannya dari `execute_atomic`.
    #[test]
    fn pipeline_gagal_tidak_membatalkan_yang_sudah_berhasil() {
        let (_dir, transport) = transport();
        transport
            .execute_pipeline(vec![Statement::new(
                "CREATE TABLE t (id INTEGER PRIMARY KEY);",
                vec![],
            )])
            .expect("DDL");

        let hasil = transport.execute_pipeline(vec![
            Statement::new("INSERT INTO t (id) VALUES (1);", vec![]),
            Statement::new("INSERT INTO t (id) VALUES (1);", vec![]),
        ]);
        assert!(hasil.is_err());

        let jumlah = transport
            .execute_pipeline(vec![Statement::new(
                "SELECT COUNT(*) AS jumlah FROM t;",
                vec![],
            )])
            .expect("hitung");
        assert_eq!(jumlah[0].rows[0][0], json!(1));
    }
}
