use std::{path::Path, time::SystemTime};

use rusqlite::{params, Connection, OptionalExtension};

use super::models::{CommandError, OfflineCredential};

const DATABASE_NAME: &str = "desktop-security.db";

fn database(path: &Path) -> Result<Connection, CommandError> {
    let connection =
        Connection::open(path.join(DATABASE_NAME)).map_err(|_| CommandError::internal())?;
    connection
        .execute_batch(
            "PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;",
        )
        .map_err(|_| CommandError::internal())?;
    Ok(connection)
}

pub fn now_epoch_seconds() -> i64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or_default()
}

pub fn normalize_identifier(value: &str) -> String {
    value.trim().to_lowercase()
}

pub fn initialize(path: &Path) -> Result<(), String> {
    let connection = database(path).map_err(|error| error.message)?;
    connection
        .execute_batch(
            r#"
      CREATE TABLE IF NOT EXISTS desktop_schema_migration (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS desktop_credential_index (
        identity_key TEXT PRIMARY KEY,
        operator_id INTEGER NOT NULL,
        username TEXT NOT NULL,
        kode_operator TEXT NOT NULL,
        role_key TEXT NOT NULL,
        permission_revision INTEGER NOT NULL,
        provisioned_at INTEGER NOT NULL,
        offline_valid_until INTEGER NOT NULL,
        server_origin TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS desktop_credential_alias (
        alias TEXT NOT NULL,
        server_origin TEXT NOT NULL,
        identity_key TEXT NOT NULL,
        PRIMARY KEY (alias, server_origin),
        FOREIGN KEY (identity_key) REFERENCES desktop_credential_index(identity_key)
          ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS desktop_security_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        operator_id INTEGER,
        event_type TEXT NOT NULL,
        event_at INTEGER NOT NULL,
        detail TEXT
      );
      INSERT OR IGNORE INTO desktop_schema_migration (version, name, applied_at)
      VALUES (1, 'desktop-security-foundation', unixepoch());
      "#,
        )
        .map_err(|_| "Schema keamanan Desktop tidak dapat diinisialisasi.".to_owned())?;
    Ok(())
}

pub fn save_credential_index(
    path: &Path,
    credential: &OfflineCredential,
) -> Result<(), CommandError> {
    let mut connection = database(path)?;
    let transaction = connection
        .transaction()
        .map_err(|_| CommandError::internal())?;
    transaction
        .execute(
            r#"
      INSERT INTO desktop_credential_index (
        identity_key, operator_id, username, kode_operator, role_key,
        permission_revision, provisioned_at, offline_valid_until, server_origin
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(identity_key) DO UPDATE SET
        operator_id = excluded.operator_id,
        username = excluded.username,
        kode_operator = excluded.kode_operator,
        role_key = excluded.role_key,
        permission_revision = excluded.permission_revision,
        provisioned_at = excluded.provisioned_at,
        offline_valid_until = excluded.offline_valid_until,
        server_origin = excluded.server_origin;
      "#,
            params![
                credential.identity_key,
                credential.operator.id,
                credential.operator.username,
                credential.operator.kode_operator,
                credential.operator.role_key,
                credential.operator.permission_revision,
                credential.provisioned_at,
                credential.offline_valid_until,
                credential.server_origin,
            ],
        )
        .map_err(|_| CommandError::internal())?;

    transaction
        .execute(
            "DELETE FROM desktop_credential_alias WHERE identity_key = ?;",
            params![credential.identity_key],
        )
        .map_err(|_| CommandError::internal())?;

    for alias in [
        normalize_identifier(&credential.operator.username),
        normalize_identifier(&credential.operator.kode_operator),
    ] {
        transaction
            .execute(
                r#"
        INSERT INTO desktop_credential_alias (alias, server_origin, identity_key)
        VALUES (?, ?, ?)
        ON CONFLICT(alias, server_origin) DO UPDATE SET
          identity_key = excluded.identity_key;
        "#,
                params![alias, credential.server_origin, credential.identity_key],
            )
            .map_err(|_| CommandError::internal())?;
    }
    transaction.commit().map_err(|_| CommandError::internal())?;
    Ok(())
}

pub fn find_identity_key(
    path: &Path,
    server_origin: &str,
    identifier: &str,
) -> Result<Option<String>, CommandError> {
    database(path)?
        .query_row(
            r#"
      SELECT identity_key FROM desktop_credential_alias
      WHERE alias = ? AND server_origin = ? LIMIT 1;
      "#,
            params![normalize_identifier(identifier), server_origin],
            |row| row.get(0),
        )
        .optional()
        .map_err(|_| CommandError::internal())
}

pub fn audit(path: &Path, operator_id: Option<i64>, event_type: &str, detail: Option<&str>) {
    if let Ok(connection) = database(path) {
        let _ = connection.execute(
            r#"
      INSERT INTO desktop_security_audit (operator_id, event_type, event_at, detail)
      VALUES (?, ?, ?, ?);
      "#,
            params![operator_id, event_type, now_epoch_seconds(), detail],
        );
    }
}
