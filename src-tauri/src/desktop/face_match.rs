//! Verifikasi wajah 1:1 di atas scan QR: kartu menyatakan "saya Budi", wajah
//! di kamera memastikan orangnya memang Budi.
//!
//! Kembar dengan `src/lib/validations/face-match.ts` (Web) dan diuji dengan
//! vektor yang sama di `face_match::tests` ↔ `face-match.test.ts`. Vektor wajah
//! dihitung di perangkat; yang diputuskan di sini hanya perbandingannya,
//! terhadap vektor terdaftar yang dibaca dari database, tidak pernah dari
//! payload scan.
//!
//! `personil_wajah` ikut `SNAPSHOT_TABLES` supaya terminal offline tetap bisa
//! memeriksa. Vektornya int8 (±1,4 KB base64 per orang), bukan foto.

use std::collections::HashMap;

use base64::prelude::*;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Deserialize;
use serde_json::{json, Value};

use super::{config::DesktopState, models::CommandError, storage, sync};

pub const FACE_MODEL_ID: &str = "human-faceres-v1";
pub const FACE_VECTOR_DIM: usize = 1024;

pub const SCAN_FACE_VERIFY_ENABLED_KEY: &str = "scan_face_verify_enabled";
pub const SCAN_FACE_MODE_KEY: &str = "scan_face_mode";
pub const SCAN_FACE_THRESHOLD_KEY: &str = "scan_face_threshold";

pub const FACE_THRESHOLD_DEFAULT: f64 = 0.55;
pub const FACE_THRESHOLD_MIN: f64 = 0.3;
pub const FACE_THRESHOLD_MAX: f64 = 0.95;

pub const FACE_TEMPLATE_SOURCES: [&str; 2] = ["kamera", "foto_profil"];
const MAX_SAMPLES: i64 = 20;

#[derive(Debug, Clone, PartialEq)]
pub struct FaceVector {
    pub model: String,
    pub vektor: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct FaceVerdict {
    pub vonis: &'static str,
    pub skor: Option<f64>,
}

pub fn decode_face_vector(encoded: &str) -> Option<Vec<i8>> {
    let bytes = BASE64_STANDARD.decode(encoded.trim()).ok()?;
    if bytes.len() != FACE_VECTOR_DIM {
        return None;
    }
    Some(bytes.into_iter().map(|byte| byte as i8).collect())
}

/// Kemiripan kosinus, dibulatkan 4 desimal dengan `floor(x + 0.5)` — sama
/// persis dengan `faceSimilarity` di TS (`f64::round` membulatkan setengah
/// negatif berbeda dari `Math.round`).
pub fn face_similarity(a: &[i8], b: &[i8]) -> f64 {
    let (mut dot, mut norm_a, mut norm_b) = (0i64, 0i64, 0i64);
    for (x, y) in a.iter().zip(b) {
        let (x, y) = (i64::from(*x), i64::from(*y));
        dot += x * y;
        norm_a += x * x;
        norm_b += y * y;
    }
    if norm_a == 0 || norm_b == 0 {
        return 0.0;
    }
    let cos = dot as f64 / ((norm_a * norm_b) as f64).sqrt();
    (cos * 10000.0 + 0.5).floor() / 10000.0
}

pub fn face_verdict(
    probe: Option<&FaceVector>,
    reference: Option<&FaceVector>,
    threshold: f64,
) -> FaceVerdict {
    let probe_vector = probe
        .filter(|item| item.model == FACE_MODEL_ID)
        .and_then(|item| decode_face_vector(&item.vektor));
    let Some(probe_vector) = probe_vector else {
        return FaceVerdict {
            vonis: "Tidak Diperiksa",
            skor: None,
        };
    };
    let reference_vector = reference
        .filter(|item| item.model == FACE_MODEL_ID)
        .and_then(|item| decode_face_vector(&item.vektor));
    let Some(reference_vector) = reference_vector else {
        return FaceVerdict {
            vonis: "Belum Terdaftar",
            skor: None,
        };
    };
    let skor = face_similarity(&probe_vector, &reference_vector);
    FaceVerdict {
        vonis: if skor >= threshold {
            "Cocok"
        } else {
            "Tidak Cocok"
        },
        skor: Some(skor),
    }
}

/// Hanya "Tidak Cocok" pada mode `tolak` yang menolak. Wajah yang belum
/// terdaftar atau tidak terbaca tetap lolos: kamera murah atau model yang gagal
/// dimuat tidak boleh menahan siswa di gerbang.
pub fn face_scan_rejected(mode: &str, vonis: &str) -> bool {
    mode == "tolak" && vonis == "Tidak Cocok"
}

pub fn normalize_face_threshold(raw: &str) -> Option<f64> {
    let value: f64 = raw.trim().parse().ok()?;
    (value.is_finite() && (FACE_THRESHOLD_MIN..=FACE_THRESHOLD_MAX).contains(&value))
        .then_some(value)
}

pub fn normalize_face_mode(raw: &str) -> Option<&'static str> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "pantau" => Some("pantau"),
        "tolak" => Some("tolak"),
        _ => None,
    }
}

/// Setting tersinkron yang belum ada atau rusak jatuh ke bawaan teraman:
/// mode `pantau` (tidak pernah menolak) dan ambang bawaan.
pub fn face_settings(settings: &HashMap<String, String>) -> (&'static str, f64) {
    let mode = settings
        .get(SCAN_FACE_MODE_KEY)
        .and_then(|value| normalize_face_mode(value))
        .unwrap_or("pantau");
    let threshold = settings
        .get(SCAN_FACE_THRESHOLD_KEY)
        .and_then(|value| normalize_face_threshold(value))
        .unwrap_or(FACE_THRESHOLD_DEFAULT);
    (mode, threshold)
}

/// Vektor wajah yang dikirim terminal bersama scan. Bentuk yang salah dibaca
/// sebagai "tidak ada" — vonisnya `Tidak Diperiksa`, bukan scan ditolak.
pub fn read_probe(input: &Value) -> Option<FaceVector> {
    let text = |key: &str| {
        input
            .get(key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
    };
    Some(FaceVector {
        model: text("wajahModel")?,
        vektor: text("wajahVektor")?,
    })
}

pub fn reference_for(
    connection: &Connection,
    id_unik: &str,
) -> Result<Option<FaceVector>, CommandError> {
    connection
        .query_row(
            "SELECT model, vektor FROM personil_wajah WHERE id_unik = ?;",
            params![id_unik],
            |row| {
                Ok(FaceVector {
                    model: row.get(0)?,
                    vektor: row.get(1)?,
                })
            },
        )
        .optional()
        .map_err(|_| CommandError::internal())
}

fn invalid(message: impl Into<String>) -> CommandError {
    CommandError::new("VALIDATION_ERROR", message)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FaceTemplateDraft {
    pub id_unik: String,
    pub model: String,
    pub vektor: String,
    pub jumlah_sampel: i64,
    pub sumber: String,
}

/// Aturan simpan, kembar dengan `validateFaceTemplate` di
/// `server/operational/face-template.ts`.
pub fn validate_template(draft: &FaceTemplateDraft) -> Result<(), String> {
    if draft.id_unik.trim().is_empty() {
        return Err("Karyawan wajib dipilih.".into());
    }
    if draft.model != FACE_MODEL_ID {
        return Err("Model wajah tidak dikenal. Muat ulang aplikasi.".into());
    }
    if decode_face_vector(&draft.vektor).is_none() {
        return Err("Data wajah tidak valid.".into());
    }
    if !(1..=MAX_SAMPLES).contains(&draft.jumlah_sampel) {
        return Err("Jumlah sampel wajah tidak valid.".into());
    }
    if !FACE_TEMPLATE_SOURCES.contains(&draft.sumber.as_str()) {
        return Err("Sumber pendaftaran wajah tidak dikenal.".into());
    }
    Ok(())
}

fn template_json(connection: &Connection, id_unik: &str) -> Result<Option<Value>, CommandError> {
    connection
        .query_row(
            "SELECT id_unik, model, vektor, jumlah_sampel, sumber, dibuat_oleh, updated_at
             FROM personil_wajah WHERE id_unik = ?;",
            params![id_unik],
            |row| {
                Ok(json!({
                    "id_unik": row.get::<_, String>(0)?,
                    "model": row.get::<_, String>(1)?,
                    "vektor": row.get::<_, String>(2)?,
                    "jumlah_sampel": row.get::<_, i64>(3)?,
                    "sumber": row.get::<_, String>(4)?,
                    "dibuat_oleh": row.get::<_, Option<String>>(5)?,
                    "updated_at": row.get::<_, String>(6)?,
                }))
            },
        )
        .optional()
        .map_err(|_| CommandError::internal())
}

/// Seluruh karyawan aktif beserta status pendaftaran wajahnya, TANPA vektor.
///
/// Karyawan ikut di sini (bukan dibaca lewat daftar karyawan) supaya halaman
/// ini cukup menuntut `face_template.view`, bukan juga `employees.view`.
/// Wajah milik karyawan nonaktif tetap tampil supaya masih bisa dihapus.
/// Query-nya kembar dengan `listFaceTemplates` di `face-template.ts`.
pub const LIST_TEMPLATES_SQL: &str =
    "SELECT m.id_unik, COALESCE(m.nama, '') AS nama, COALESCE(m.jabatan_status, '') AS jabatan,
                    COALESCE(m.divisi, '') AS divisi, w.model, w.jumlah_sampel, w.sumber,
                    w.dibuat_oleh, w.updated_at
             FROM master_data m
             LEFT JOIN personil_wajah w ON w.id_unik = m.id_unik
             WHERE COALESCE(m.status_aktif, 'Aktif') <> 'Nonaktif' OR w.id_unik IS NOT NULL
             ORDER BY m.nama COLLATE NOCASE
             -- batas: satu baris per karyawan, dibatasi jumlah karyawan perusahaan
             ;";

pub fn list_templates(state: &DesktopState) -> Result<Value, CommandError> {
    let connection = storage::database(&state.data_dir)?;
    let mut statement = connection
        .prepare(LIST_TEMPLATES_SQL)
        .map_err(|_| CommandError::internal())?;
    let rows = statement
        .query_map([], |row| {
            Ok(json!({
                "id_unik": row.get::<_, String>(0)?,
                "nama": row.get::<_, String>(1)?,
                "jabatan": row.get::<_, String>(2)?,
                "divisi": row.get::<_, String>(3)?,
                "model": row.get::<_, Option<String>>(4)?,
                "jumlah_sampel": row.get::<_, Option<i64>>(5)?,
                "sumber": row.get::<_, Option<String>>(6)?,
                "dibuat_oleh": row.get::<_, Option<String>>(7)?,
                "updated_at": row.get::<_, Option<String>>(8)?,
            }))
        })
        .map_err(|_| CommandError::internal())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| CommandError::internal())?;
    Ok(Value::Array(rows))
}

pub fn save_template(
    state: &DesktopState,
    dibuat_oleh: &str,
    draft: Value,
) -> Result<Value, CommandError> {
    let draft: FaceTemplateDraft =
        serde_json::from_value(draft).map_err(|_| invalid("Data wajah tidak valid."))?;
    validate_template(&draft).map_err(invalid)?;
    let id_unik = draft.id_unik.trim();
    let client_id = sync::ensure_client_id(state)?;
    let mut connection = storage::database(&state.data_dir)?;
    let transaction = connection
        .transaction()
        .map_err(|_| CommandError::internal())?;
    let ada: bool = transaction
        .query_row(
            "SELECT 1 FROM master_data WHERE id_unik = ?;",
            params![id_unik],
            |_| Ok(true),
        )
        .optional()
        .map_err(|_| CommandError::internal())?
        .unwrap_or(false);
    if !ada {
        return Err(invalid("Karyawan tidak ditemukan."));
    }
    transaction
        .execute(
            "INSERT INTO personil_wajah (id_unik, model, vektor, jumlah_sampel, sumber, dibuat_oleh, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
             ON CONFLICT(id_unik) DO UPDATE SET
               model = excluded.model, vektor = excluded.vektor,
               jumlah_sampel = excluded.jumlah_sampel, sumber = excluded.sumber,
               dibuat_oleh = excluded.dibuat_oleh, updated_at = excluded.updated_at;",
            params![
                id_unik,
                draft.model,
                draft.vektor.trim(),
                draft.jumlah_sampel,
                draft.sumber,
                dibuat_oleh
            ],
        )
        .map_err(|_| CommandError::internal())?;
    let payload = template_json(&transaction, id_unik)?.ok_or_else(CommandError::internal)?;
    sync::enqueue(
        &transaction,
        &client_id,
        "face-template",
        "save",
        id_unik,
        &payload,
        None,
    )?;
    transaction.commit().map_err(|_| CommandError::internal())?;
    Ok(json!({ "sukses": true }))
}

pub fn delete_template(state: &DesktopState, id_unik: &str) -> Result<Value, CommandError> {
    let id_unik = id_unik.trim();
    if id_unik.is_empty() {
        return Err(invalid("Karyawan wajib dipilih."));
    }
    let client_id = sync::ensure_client_id(state)?;
    let mut connection = storage::database(&state.data_dir)?;
    let transaction = connection
        .transaction()
        .map_err(|_| CommandError::internal())?;
    transaction
        .execute(
            "DELETE FROM personil_wajah WHERE id_unik = ?;",
            params![id_unik],
        )
        .map_err(|_| CommandError::internal())?;
    // Event dikirim walau baris lokal tidak ada: wajah yang didaftarkan
    // perangkat lain dan belum tertarik ke sini tetap harus terhapus di cloud.
    sync::enqueue(
        &transaction,
        &client_id,
        "face-template",
        "delete",
        id_unik,
        &json!({ "id_unik": id_unik }),
        None,
    )?;
    transaction.commit().map_err(|_| CommandError::internal())?;
    Ok(json!({ "sukses": true }))
}

/// Nilai upsert cloud dari event `face-template/save`. `None` untuk baris yang
/// tidak sah, supaya CHECK cloud tidak menolaknya dan mengunci outbox.
pub fn cloud_template_values(row: &Value, entity_key: &str) -> Option<Vec<Value>> {
    let text = |key: &str| {
        row.get(key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
    };
    let draft = FaceTemplateDraft {
        id_unik: text("id_unik").unwrap_or_else(|| entity_key.trim().to_owned()),
        model: text("model")?,
        vektor: text("vektor")?,
        jumlah_sampel: row.get("jumlah_sampel").and_then(Value::as_i64)?,
        sumber: text("sumber")?,
    };
    validate_template(&draft).ok()?;
    Some(vec![
        json!(draft.id_unik),
        json!(draft.model),
        json!(draft.vektor),
        json!(draft.jumlah_sampel),
        json!(draft.sumber),
        json!(text("dibuat_oleh")),
        json!(text("updated_at")),
    ])
}

pub const CLOUD_UPSERT_TEMPLATE_SQL: &str = "INSERT INTO personil_wajah (
        id_unik, model, vektor, jumlah_sampel, sumber, dibuat_oleh, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')))
    ON CONFLICT(id_unik) DO UPDATE SET
        model = excluded.model,
        vektor = excluded.vektor,
        jumlah_sampel = excluded.jumlah_sampel,
        sumber = excluded.sumber,
        dibuat_oleh = excluded.dibuat_oleh,
        updated_at = excluded.updated_at;";

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// Vektor kembar `a` (pemilik) dan `b` (orang lain) untuk tes lintas modul.
    pub(crate) fn twin_owner() -> String {
        q(&a())
    }
    pub(crate) fn twin_stranger() -> String {
        q(&b())
    }

    // Vektor kembar dengan `face-match.test.ts`. Ubah satu, ubah keduanya.
    fn a() -> Vec<f64> {
        (0..1024).map(|i| ((i * 37) % 251) as f64 - 125.0).collect()
    }
    fn b() -> Vec<f64> {
        (0..1024).map(|i| ((i * 53) % 241) as f64 - 120.0).collect()
    }
    fn c() -> Vec<f64> {
        a().iter()
            .enumerate()
            .map(|(i, v)| v + (((i % 7) as f64) - 3.0) * 5.0)
            .collect()
    }

    /// Kuantisasi hanya ada di klien (TS); cerminan ini hanya untuk membangun
    /// vektor uji yang sama persis.
    fn q(values: &[f64]) -> String {
        let max_abs = values.iter().fold(0.0f64, |acc, v| acc.max(v.abs()));
        let bytes: Vec<u8> = values
            .iter()
            .map(|v| ((v / max_abs) * 127.0).round().clamp(-127.0, 127.0) as i8 as u8)
            .collect();
        BASE64_STANDARD.encode(bytes)
    }

    fn vector(values: &[f64]) -> FaceVector {
        FaceVector {
            model: FACE_MODEL_ID.into(),
            vektor: q(values),
        }
    }

    #[test]
    fn kuantisasi_dan_decode() {
        let encoded = q(&a());
        assert_eq!(encoded.len(), 1368);
        assert_eq!(&encoded[..24], "gafM8hc9Y4mv1PofRWuRt9wC");
        assert_eq!(
            decode_face_vector(&encoded).unwrap()[..6],
            [-127, -89, -52, -14, 23, 61]
        );
        assert_eq!(
            decode_face_vector(&q(&c())).unwrap()[..6],
            [-127, -89, -51, -13, 25, 64]
        );
        assert!(decode_face_vector("AAAA").is_none());
        assert!(decode_face_vector("bukan base64!").is_none());
    }

    #[test]
    fn kemiripan() {
        let (da, db, dc) = (
            decode_face_vector(&q(&a())).unwrap(),
            decode_face_vector(&q(&b())).unwrap(),
            decode_face_vector(&q(&c())).unwrap(),
        );
        assert_eq!(face_similarity(&da, &da), 1.0);
        assert_eq!(face_similarity(&da, &dc), 0.9906);
        assert_eq!(face_similarity(&da, &db), 0.0118);
    }

    #[test]
    fn vonis() {
        let reference = vector(&a());
        assert_eq!(
            face_verdict(Some(&vector(&c())), Some(&reference), 0.55),
            FaceVerdict {
                vonis: "Cocok",
                skor: Some(0.9906)
            }
        );
        assert_eq!(
            face_verdict(Some(&vector(&b())), Some(&reference), 0.55),
            FaceVerdict {
                vonis: "Tidak Cocok",
                skor: Some(0.0118)
            }
        );
        assert_eq!(
            face_verdict(Some(&vector(&c())), None, 0.55),
            FaceVerdict {
                vonis: "Belum Terdaftar",
                skor: None
            }
        );
        let model_lain = FaceVector {
            model: "model-lain".into(),
            vektor: q(&a()),
        };
        assert_eq!(
            face_verdict(Some(&vector(&c())), Some(&model_lain), 0.55).vonis,
            "Belum Terdaftar"
        );
        assert_eq!(
            face_verdict(None, Some(&reference), 0.55).vonis,
            "Tidak Diperiksa"
        );
        let probe_lain = FaceVector {
            model: "model-lain".into(),
            vektor: q(&c()),
        };
        assert_eq!(
            face_verdict(Some(&probe_lain), Some(&reference), 0.55).vonis,
            "Tidak Diperiksa"
        );
    }

    #[test]
    fn hanya_tidak_cocok_pada_mode_tolak_yang_menolak() {
        assert!(face_scan_rejected("tolak", "Tidak Cocok"));
        assert!(!face_scan_rejected("pantau", "Tidak Cocok"));
        assert!(!face_scan_rejected("tolak", "Belum Terdaftar"));
        assert!(!face_scan_rejected("tolak", "Tidak Diperiksa"));
    }

    #[test]
    fn normalisasi_setting() {
        assert_eq!(normalize_face_threshold("0.6"), Some(0.6));
        assert_eq!(normalize_face_threshold("0.3"), Some(0.3));
        assert_eq!(normalize_face_threshold("0.29"), None);
        assert_eq!(normalize_face_threshold("0.96"), None);
        assert_eq!(normalize_face_threshold(""), None);
        assert_eq!(normalize_face_threshold("abc"), None);
        assert_eq!(normalize_face_mode(" Tolak "), Some("tolak"));
        assert_eq!(normalize_face_mode("pantau"), Some("pantau"));
        assert_eq!(normalize_face_mode("blokir"), None);
        let mut settings = HashMap::new();
        assert_eq!(face_settings(&settings), ("pantau", FACE_THRESHOLD_DEFAULT));
        settings.insert(SCAN_FACE_MODE_KEY.to_owned(), "tolak".to_owned());
        settings.insert(SCAN_FACE_THRESHOLD_KEY.to_owned(), "0.7".to_owned());
        assert_eq!(face_settings(&settings), ("tolak", 0.7));
    }

    #[test]
    fn template_tidak_sah_tidak_sampai_cloud() {
        let sah = json!({
            "id_unik": "P-1", "model": FACE_MODEL_ID, "vektor": q(&a()),
            "jumlah_sampel": 3, "sumber": "kamera"
        });
        assert!(cloud_template_values(&sah, "P-1").is_some());
        let mut sumber_asing = sah.clone();
        sumber_asing["sumber"] = json!("upload");
        assert!(cloud_template_values(&sumber_asing, "P-1").is_none());
        let mut vektor_rusak = sah.clone();
        vektor_rusak["vektor"] = json!("AAAA");
        assert!(cloud_template_values(&vektor_rusak, "P-1").is_none());
    }
}
