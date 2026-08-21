use std::{
    fs,
    path::{Path, PathBuf},
};

use aes_gcm::{
    aead::{Aead, KeyInit, Payload},
    Aes256Gcm, Nonce,
};
use argon2::Argon2;
use sha2::{Digest, Sha256};
use tauri_plugin_stronghold::{kdf::KeyDerivation, stronghold::Stronghold};
use zeroize::{Zeroize, Zeroizing};

use super::{
    config::DesktopState,
    models::{CommandError, OfflineCredential, OperatorUser},
    storage,
    turso::TursoConfig,
};

const CLIENT_ID: &[u8] = b"sppg-desktop-auth-v1";
const CREDENTIAL_KEY: &[u8] = b"offline-credential";
const TURSO_VAULT_FILE: &str = "turso_config.vault";
const TURSO_SALT_FILE: &str = "turso_config.salt";
const LEGACY_TURSO_SECRET_PASSPHRASE: &str = "sppg-vault-master-turso-v1";
const TURSO_VAULT_MAGIC_V2: &[u8] = b"SPPGTV2";

fn device_id(state: &DesktopState) -> Result<String, CommandError> {
    storage::get_or_create_device_id(&state.data_dir)
}

fn legacy_identity_key(server_origin: &str, operator_id: i64) -> String {
    let mut hash = Sha256::new();
    hash.update(server_origin.as_bytes());
    hash.update(b":");
    hash.update(operator_id.to_string().as_bytes());
    hex::encode(hash.finalize())
}

fn identity_key(server_origin: &str, operator_id: i64, device_id: &str) -> String {
    let mut hash = Sha256::new();
    hash.update(b"sppg-offline-identity-v2:");
    hash.update(server_origin.as_bytes());
    hash.update(b":");
    hash.update(operator_id.to_string().as_bytes());
    hash.update(b":");
    hash.update(device_id.as_bytes());
    hex::encode(hash.finalize())
}

fn derive_turso_key(passphrase: &[u8], salt: &[u8]) -> Result<[u8; 32], CommandError> {
    let mut key = [0_u8; 32];
    Argon2::default()
        .hash_password_into(passphrase, salt, &mut key)
        .map_err(|_| CommandError::internal())?;
    Ok(key)
}

fn device_turso_passphrase(device_id: &str) -> Zeroizing<Vec<u8>> {
    let mut hash = Sha256::new();
    hash.update(b"sppg-vault-master-turso-v2:");
    hash.update(device_id.as_bytes());
    Zeroizing::new(hash.finalize().to_vec())
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
    let server_origin = state.server_origin();
    let device_id = device_id(state)?;
    let identity_key = identity_key(&server_origin, operator.id, &device_id);
    let now = storage::now_epoch_seconds();
    let max_age_seconds = state
        .offline_max_age_hours
        .checked_mul(60 * 60)
        .and_then(|value| i64::try_from(value).ok())
        .ok_or_else(CommandError::internal)?;
    let credential = OfflineCredential {
        version: 2,
        identity_key: identity_key.clone(),
        server_origin,
        device_id: Some(device_id),
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
    let server_origin = state.server_origin();
    let stored_identity_key =
        storage::find_identity_key(&state.data_dir, &server_origin, identifier)?.ok_or_else(
            || {
                CommandError::new(
        "OFFLINE_NOT_PROVISIONED",
        "Perangkat ini wajib login online minimal satu kali sebelum dapat digunakan offline.",
      )
            },
        )?;
    let (snapshot_path, salt_path) = credential_paths(state, &stored_identity_key)?;
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
    let serialized = Zeroizing::new(
        client
            .store()
            .get(CREDENTIAL_KEY)
            .map_err(|_| CommandError::internal())?
            .ok_or_else(CommandError::internal)?,
    );
    let credential: OfflineCredential =
        serde_json::from_slice(&serialized).map_err(|_| CommandError::internal())?;
    drop(client);
    drop(stronghold);

    let normalized_identifier = storage::normalize_identifier(identifier);
    let identifier_matches = [
        storage::normalize_identifier(&credential.operator.username),
        storage::normalize_identifier(&credential.operator.kode_operator),
    ]
    .contains(&normalized_identifier);
    let current_device_id = device_id(state)?;
    let expected_v2_identity =
        identity_key(&server_origin, credential.operator.id, &current_device_id);
    let legacy_identity = legacy_identity_key(&server_origin, credential.operator.id);
    let valid_v1 = credential.version == 1
        && credential.device_id.is_none()
        && credential.identity_key == legacy_identity
        && stored_identity_key == legacy_identity;
    let valid_v2 = credential.version == 2
        && credential.device_id.as_deref() == Some(current_device_id.as_str())
        && credential.identity_key == expected_v2_identity
        && stored_identity_key == expected_v2_identity;
    if credential.server_origin != server_origin || !identifier_matches || (!valid_v1 && !valid_v2)
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
    if valid_v1 {
        let migrated = OfflineCredential {
            version: 2,
            identity_key: expected_v2_identity.clone(),
            server_origin,
            device_id: Some(current_device_id),
            operator: credential.operator,
            provisioned_at: credential.provisioned_at,
            offline_valid_until: credential.offline_valid_until,
        };
        let (migrated_snapshot, migrated_salt) = credential_paths(state, &expected_v2_identity)?;
        write_snapshot(&migrated_snapshot, &migrated_salt, password, &migrated)?;
        storage::save_credential_index(&state.data_dir, &migrated)?;
        let _ = fs::remove_file(snapshot_path);
        let _ = fs::remove_file(salt_path);
        return Ok(migrated);
    }
    Ok(credential)
}

pub fn save_turso_config(state: &DesktopState, config: &TursoConfig) -> Result<(), CommandError> {
    let directory = state.data_dir.join("credentials");
    fs::create_dir_all(&directory).map_err(|_| CommandError::internal())?;
    let vault_path = directory.join(TURSO_VAULT_FILE);
    let salt_path = directory.join(TURSO_SALT_FILE);

    let _guard = state
        .vault_lock
        .lock()
        .map_err(|_| CommandError::internal())?;

    let salt = if salt_path.is_file() {
        let bytes = fs::read(&salt_path).map_err(|_| CommandError::internal())?;
        if bytes.len() < 16 {
            let mut new_salt = [0u8; 32];
            rand_core::RngCore::fill_bytes(&mut rand_core::OsRng, &mut new_salt);
            fs::write(&salt_path, &new_salt).map_err(|_| CommandError::internal())?;
            new_salt.to_vec()
        } else {
            bytes
        }
    } else {
        let mut new_salt = [0u8; 32];
        rand_core::RngCore::fill_bytes(&mut rand_core::OsRng, &mut new_salt);
        fs::write(&salt_path, &new_salt).map_err(|_| CommandError::internal())?;
        new_salt.to_vec()
    };

    let current_device_id = device_id(state)?;
    let passphrase = device_turso_passphrase(&current_device_id);
    let mut key = derive_turso_key(&passphrase, &salt)?;

    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|_| CommandError::internal())?;
    key.zeroize();

    let mut nonce_bytes = [0u8; 12];
    rand_core::RngCore::fill_bytes(&mut rand_core::OsRng, &mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);

    let serialized =
        Zeroizing::new(serde_json::to_vec(config).map_err(|_| CommandError::internal())?);
    let ciphertext = cipher
        .encrypt(
            nonce,
            Payload {
                msg: serialized.as_ref(),
                aad: current_device_id.as_bytes(),
            },
        )
        .map_err(|_| CommandError::internal())?;

    let mut file_payload = Vec::with_capacity(TURSO_VAULT_MAGIC_V2.len() + 12 + ciphertext.len());
    file_payload.extend_from_slice(TURSO_VAULT_MAGIC_V2);
    file_payload.extend_from_slice(&nonce_bytes);
    file_payload.extend_from_slice(&ciphertext);

    fs::write(&vault_path, file_payload).map_err(|_| CommandError::internal())?;
    Ok(())
}

pub fn load_turso_config(state: &DesktopState) -> Result<Option<TursoConfig>, CommandError> {
    let directory = state.data_dir.join("credentials");
    let vault_path = directory.join(TURSO_VAULT_FILE);
    let salt_path = directory.join(TURSO_SALT_FILE);

    if !vault_path.is_file() || !salt_path.is_file() {
        return Ok(None);
    }

    let _guard = state
        .vault_lock
        .lock()
        .map_err(|_| CommandError::internal())?;

    let salt = fs::read(&salt_path).map_err(|_| CommandError::internal())?;
    if salt.len() < 16 {
        return Err(CommandError::new(
            "TURSO_VAULT_INVALID",
            "Vault konfigurasi Turso rusak atau tidak lengkap.",
        ));
    }
    let payload = fs::read(&vault_path).map_err(|_| CommandError::internal())?;
    if payload.len() < 12 + 16 {
        return Err(CommandError::new(
            "TURSO_VAULT_INVALID",
            "Vault konfigurasi Turso rusak atau tidak lengkap.",
        ));
    }

    let current_device_id = device_id(state)?;
    let is_v2 = payload.starts_with(TURSO_VAULT_MAGIC_V2);
    let encrypted_payload = if is_v2 {
        &payload[TURSO_VAULT_MAGIC_V2.len()..]
    } else {
        payload.as_slice()
    };
    if encrypted_payload.len() < 12 + 16 {
        return Err(CommandError::new(
            "TURSO_VAULT_INVALID",
            "Vault konfigurasi Turso rusak atau tidak lengkap.",
        ));
    }
    let (nonce_bytes, ciphertext) = encrypted_payload.split_at(12);
    let nonce = Nonce::from_slice(nonce_bytes);

    let passphrase = if is_v2 {
        device_turso_passphrase(&current_device_id)
    } else {
        Zeroizing::new(LEGACY_TURSO_SECRET_PASSPHRASE.as_bytes().to_vec())
    };
    let mut key = derive_turso_key(&passphrase, &salt)?;
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|_| CommandError::internal())?;
    key.zeroize();
    let decrypted = Zeroizing::new(if is_v2 {
        cipher
            .decrypt(
                nonce,
                Payload {
                    msg: ciphertext,
                    aad: current_device_id.as_bytes(),
                },
            )
            .map_err(|_| {
                CommandError::new(
                    "TURSO_VAULT_DEVICE_MISMATCH",
                    "Vault database cloud tidak cocok dengan instalasi perangkat ini.",
                )
            })?
    } else {
        cipher
            .decrypt(nonce, ciphertext)
            .map_err(|_| CommandError::internal())?
    });

    let config: TursoConfig =
        serde_json::from_slice(&decrypted).map_err(|_| CommandError::internal())?;
    drop(_guard);
    if !is_v2 {
        save_turso_config(state, &config)?;
    }
    Ok(Some(config))
}

pub fn clear_turso_config(state: &DesktopState) -> Result<(), CommandError> {
    let directory = state.data_dir.join("credentials");
    let vault_path = directory.join(TURSO_VAULT_FILE);
    let salt_path = directory.join(TURSO_SALT_FILE);
    if vault_path.exists() {
        fs::remove_file(vault_path).map_err(|_| CommandError::internal())?;
    }
    if salt_path.exists() {
        fs::remove_file(salt_path).map_err(|_| CommandError::internal())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::sync::{Mutex, RwLock};

    use reqwest::Client;
    use rusqlite::{params, Connection};
    use tempfile::TempDir;

    use super::{
        credential_paths, device_id, identity_key, legacy_identity_key, load_offline, provision,
        write_snapshot,
    };
    use crate::desktop::{
        config::DesktopState,
        models::{OfflineCredential, OperatorUser},
        storage,
    };

    fn test_state(directory: &TempDir, origin: &str, hours: u64) -> DesktopState {
        storage::initialize(directory.path()).expect("test schema");
        DesktopState {
            server_origin: RwLock::new(origin.to_owned()),
            offline_max_age_hours: hours,
            data_dir: directory.path().to_owned(),
            http: Client::new(),
            turso_config: RwLock::new(None),
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
        let device = "device-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        assert_ne!(
            identity_key("https://buyer-a.example", 1, device),
            identity_key("https://buyer-b.example", 1, device)
        );
    }

    #[test]
    fn identity_is_bound_to_device() {
        assert_ne!(
            identity_key("https://buyer-a.example", 1, "device-a"),
            identity_key("https://buyer-a.example", 1, "device-b")
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
                params!["attacker", state.server_origin(), credential.identity_key],
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
        let identity_key = identity_key(
            &state.server_origin(),
            7,
            &device_id(&state).expect("device identity"),
        );
        let now = storage::now_epoch_seconds();
        let credential = OfflineCredential {
            version: 2,
            identity_key: identity_key.clone(),
            server_origin: state.server_origin(),
            device_id: Some(device_id(&state).expect("device identity")),
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

    #[test]
    fn legacy_snapshot_is_migrated_to_device_bound_version() {
        let directory = TempDir::new().expect("temporary directory");
        let state = test_state(&directory, "https://buyer-a.example", 24);
        let legacy_key = legacy_identity_key(&state.server_origin(), 7);
        let now = storage::now_epoch_seconds();
        let credential = OfflineCredential {
            version: 1,
            identity_key: legacy_key.clone(),
            server_origin: state.server_origin(),
            device_id: None,
            operator: test_operator(),
            provisioned_at: now,
            offline_valid_until: now.saturating_add(3_600),
        };
        let (snapshot_path, salt_path) =
            credential_paths(&state, &legacy_key).expect("credential paths");
        write_snapshot(&snapshot_path, &salt_path, "valid-password", &credential)
            .expect("write legacy snapshot");
        storage::save_credential_index(&state.data_dir, &credential).expect("save legacy index");

        let migrated =
            load_offline(&state, "SPD007", "valid-password").expect("migrate legacy snapshot");
        assert_eq!(migrated.version, 2);
        assert_eq!(
            migrated.device_id,
            Some(device_id(&state).expect("device identity"))
        );
        assert!(!snapshot_path.exists());
    }
}
