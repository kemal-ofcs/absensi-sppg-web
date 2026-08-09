use std::{
    fs,
    path::{Path, PathBuf},
};

use sha2::{Digest, Sha256};
use tauri_plugin_stronghold::{kdf::KeyDerivation, stronghold::Stronghold};

use super::{
    config::DesktopState,
    models::{CommandError, OfflineCredential, OperatorUser},
    storage,
};

const CLIENT_ID: &[u8] = b"sppg-desktop-auth-v1";
const CREDENTIAL_KEY: &[u8] = b"offline-credential";

fn identity_key(server_origin: &str, operator_id: i64) -> String {
    let mut hash = Sha256::new();
    hash.update(server_origin.as_bytes());
    hash.update(b":");
    hash.update(operator_id.to_string().as_bytes());
    hex::encode(hash.finalize())
}

fn credential_paths(
    state: &DesktopState,
    identity_key: &str,
) -> Result<(PathBuf, PathBuf), CommandError> {
    let directory = state.data_dir.join("credentials");
    fs::create_dir_all(&directory).map_err(|_| CommandError::internal())?;
    Ok((
        directory.join(format!("{identity_key}.stronghold")),
        directory.join(format!("{identity_key}.salt")),
    ))
}

fn derive_key(password: &str, salt_path: &Path) -> Result<Vec<u8>, CommandError> {
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        KeyDerivation::argon2(password, salt_path)
    }))
    .map_err(|_| CommandError::internal())
}

fn write_snapshot(
    snapshot_path: &Path,
    salt_path: &Path,
    password: &str,
    credential: &OfflineCredential,
) -> Result<(), CommandError> {
    let temporary = snapshot_path.with_extension("stronghold.new");
    let backup = snapshot_path.with_extension("stronghold.bak");
    let _ = fs::remove_file(&temporary);
    let _ = fs::remove_file(&backup);

    let key = derive_key(password, salt_path)?;
    let stronghold = Stronghold::new(&temporary, key).map_err(|_| CommandError::internal())?;
    let client = stronghold
        .create_client(CLIENT_ID)
        .map_err(|_| CommandError::internal())?;
    let serialized = serde_json::to_vec(credential).map_err(|_| CommandError::internal())?;
    client
        .store()
        .insert(CREDENTIAL_KEY.to_vec(), serialized, None)
        .map_err(|_| CommandError::internal())?;
    stronghold
        .write_client(CLIENT_ID)
        .map_err(|_| CommandError::internal())?;
    stronghold.save().map_err(|_| CommandError::internal())?;
    drop(stronghold);

    if snapshot_path.exists() {
        fs::rename(snapshot_path, &backup).map_err(|_| CommandError::internal())?;
    }
    if fs::rename(&temporary, snapshot_path).is_err() {
        if backup.exists() {
            let _ = fs::rename(&backup, snapshot_path);
        }
        return Err(CommandError::internal());
    }
    let _ = fs::remove_file(backup);
    Ok(())
}

pub fn provision(
    state: &DesktopState,
    operator: OperatorUser,
    password: &str,
) -> Result<OfflineCredential, CommandError> {
    let identity_key = identity_key(&state.server_origin, operator.id);
    let now = storage::now_epoch_seconds();
    let max_age_seconds = state
        .offline_max_age_hours
        .checked_mul(60 * 60)
        .and_then(|value| i64::try_from(value).ok())
        .ok_or_else(CommandError::internal)?;
    let credential = OfflineCredential {
        version: 1,
        identity_key: identity_key.clone(),
        server_origin: state.server_origin.clone(),
        operator,
        provisioned_at: now,
        offline_valid_until: now.saturating_add(max_age_seconds),
    };
    let (snapshot_path, salt_path) = credential_paths(state, &identity_key)?;
    let _guard = state
        .vault_lock
        .lock()
        .map_err(|_| CommandError::internal())?;
    write_snapshot(&snapshot_path, &salt_path, password, &credential)?;
    storage::save_credential_index(&state.data_dir, &credential)?;
    Ok(credential)
}

pub fn load_offline(
    state: &DesktopState,
    identifier: &str,
    password: &str,
) -> Result<OfflineCredential, CommandError> {
    let identity_key =
        storage::find_identity_key(&state.data_dir, &state.server_origin, identifier)?.ok_or_else(
            || {
                CommandError::new(
        "OFFLINE_NOT_PROVISIONED",
        "Perangkat ini wajib login online minimal satu kali sebelum dapat digunakan offline.",
      )
            },
        )?;
    let (snapshot_path, salt_path) = credential_paths(state, &identity_key)?;
    if !snapshot_path.is_file() || !salt_path.is_file() {
        return Err(CommandError::new(
            "OFFLINE_NOT_PROVISIONED",
            "Data login offline perangkat belum tersedia atau tidak lengkap.",
        ));
    }

    let _guard = state
        .vault_lock
        .lock()
        .map_err(|_| CommandError::internal())?;
    let key = derive_key(password, &salt_path).map_err(|_| {
        CommandError::new(
            "OFFLINE_CREDENTIAL_INVALID",
            "Username/kode operator atau password offline tidak sesuai.",
        )
    })?;
    let stronghold = Stronghold::new(&snapshot_path, key).map_err(|_| {
        CommandError::new(
            "OFFLINE_CREDENTIAL_INVALID",
            "Username/kode operator atau password offline tidak sesuai.",
        )
    })?;
    let client = stronghold
        .load_client(CLIENT_ID)
        .map_err(|_| CommandError::internal())?;
    let serialized = client
        .store()
        .get(CREDENTIAL_KEY)
        .map_err(|_| CommandError::internal())?
        .ok_or_else(CommandError::internal)?;
    let credential: OfflineCredential =
        serde_json::from_slice(&serialized).map_err(|_| CommandError::internal())?;

    let normalized_identifier = storage::normalize_identifier(identifier);
    let identifier_matches = [
        storage::normalize_identifier(&credential.operator.username),
        storage::normalize_identifier(&credential.operator.kode_operator),
    ]
    .contains(&normalized_identifier);
    if credential.version != 1
        || credential.identity_key != identity_key
        || credential.server_origin != state.server_origin
        || !identifier_matches
    {
        return Err(CommandError::new(
            "OFFLINE_SNAPSHOT_INVALID",
            "Snapshot keamanan offline tidak cocok dengan deployment pelanggan ini.",
        ));
    }
    if storage::now_epoch_seconds() > credential.offline_valid_until {
        return Err(CommandError::new(
            "OFFLINE_SNAPSHOT_EXPIRED",
            "Masa login offline berakhir. Sambungkan internet dan login kembali.",
        ));
    }
    Ok(credential)
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use reqwest::Client;
    use rusqlite::{params, Connection};
    use tempfile::TempDir;
    use url::Url;

    use super::{credential_paths, identity_key, load_offline, provision, write_snapshot};
    use crate::desktop::{
        config::DesktopState,
        models::{OfflineCredential, OperatorUser},
        storage,
    };

    fn test_state(directory: &TempDir, origin: &str, hours: u64) -> DesktopState {
        storage::initialize(directory.path()).expect("test schema");
        DesktopState {
            api_base_url: Url::parse(origin).expect("test origin"),
            server_origin: origin.to_owned(),
            offline_max_age_hours: hours,
            data_dir: directory.path().to_owned(),
            http: Client::new(),
            session: Mutex::new(None),
            vault_lock: Mutex::new(()),
        }
    }

    fn test_operator() -> OperatorUser {
        OperatorUser {
            id: 7,
            kode_operator: "SPD007".into(),
            nama_operator: "Operator Test".into(),
            username: "operator.test".into(),
            role: "Scanner".into(),
            role_id: 3,
            role_key: "scanner".into(),
            is_superadmin: false,
            permissions: vec!["scanner.use".into()],
            permission_revision: 4,
            login_at: None,
        }
    }

    #[test]
    fn identity_is_bound_to_customer_origin() {
        assert_ne!(
            identity_key("https://buyer-a.example", 1),
            identity_key("https://buyer-b.example", 1)
        );
    }

    #[test]
    fn encrypted_snapshot_supports_username_and_operator_code() {
        let directory = TempDir::new().expect("temporary directory");
        let state = test_state(&directory, "https://buyer-a.example", 24);
        provision(&state, test_operator(), "correct horse battery staple")
            .expect("provision snapshot");

        let by_username = load_offline(&state, " OPERATOR.TEST ", "correct horse battery staple")
            .expect("login with username");
        let by_code = load_offline(&state, "spd007", "correct horse battery staple")
            .expect("login with code");
        assert_eq!(by_username.operator.id, 7);
        assert_eq!(by_code.operator.permission_revision, 4);
    }

    #[test]
    fn wrong_password_and_other_customer_are_rejected() {
        let directory = TempDir::new().expect("temporary directory");
        let buyer_a = test_state(&directory, "https://buyer-a.example", 24);
        provision(&buyer_a, test_operator(), "valid-password").expect("provision snapshot");
        assert_eq!(
            load_offline(&buyer_a, "SPD007", "wrong-password")
                .expect_err("wrong password must fail")
                .code,
            "OFFLINE_CREDENTIAL_INVALID"
        );

        let buyer_b = test_state(&directory, "https://buyer-b.example", 24);
        assert_eq!(
            load_offline(&buyer_b, "SPD007", "valid-password")
                .expect_err("other customer must fail")
                .code,
            "OFFLINE_NOT_PROVISIONED"
        );
    }

    #[test]
    fn tampered_alias_cannot_impersonate_an_operator() {
        let directory = TempDir::new().expect("temporary directory");
        let state = test_state(&directory, "https://buyer-a.example", 24);
        let credential =
            provision(&state, test_operator(), "valid-password").expect("provision snapshot");
        let connection = Connection::open(directory.path().join("desktop-security.db"))
            .expect("open test index");
        connection
            .execute(
                r#"
                INSERT INTO desktop_credential_alias (alias, server_origin, identity_key)
                VALUES (?, ?, ?);
                "#,
                params!["attacker", state.server_origin, credential.identity_key],
            )
            .expect("tamper local alias");

        assert_eq!(
            load_offline(&state, "attacker", "valid-password")
                .expect_err("tampered alias must fail")
                .code,
            "OFFLINE_SNAPSHOT_INVALID"
        );
    }

    #[test]
    fn expired_snapshot_requires_online_login() {
        let directory = TempDir::new().expect("temporary directory");
        let state = test_state(&directory, "https://buyer-a.example", 24);
        let identity_key = identity_key(&state.server_origin, 7);
        let now = storage::now_epoch_seconds();
        let credential = OfflineCredential {
            version: 1,
            identity_key: identity_key.clone(),
            server_origin: state.server_origin.clone(),
            operator: test_operator(),
            provisioned_at: now.saturating_sub(7_200),
            offline_valid_until: now.saturating_sub(3_600),
        };
        let (snapshot_path, salt_path) =
            credential_paths(&state, &identity_key).expect("credential paths");
        write_snapshot(&snapshot_path, &salt_path, "valid-password", &credential)
            .expect("write expired snapshot");
        storage::save_credential_index(&state.data_dir, &credential).expect("save test index");

        assert_eq!(
            load_offline(&state, "SPD007", "valid-password")
                .expect_err("expired snapshot must fail")
                .code,
            "OFFLINE_SNAPSHOT_EXPIRED"
        );
    }

    #[test]
    fn corrupted_salt_is_rejected_without_trusting_the_snapshot() {
        let directory = TempDir::new().expect("temporary directory");
        let state = test_state(&directory, "https://buyer-a.example", 24);
        let credential =
            provision(&state, test_operator(), "valid-password").expect("provision snapshot");
        let (_, salt_path) =
            credential_paths(&state, &credential.identity_key).expect("credential paths");
        std::fs::write(salt_path, [1_u8, 2, 3]).expect("corrupt test salt");

        assert_eq!(
            load_offline(&state, "SPD007", "valid-password")
                .expect_err("corrupted salt must fail")
                .code,
            "OFFLINE_CREDENTIAL_INVALID"
        );
    }
}
