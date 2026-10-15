//! Tutup buku / kunci periode (Tahap 1).
//!
//! Satu tanggal batas yang maju: "terkunci sampai X" = tanggal terbesar di
//! antara baris `keu_tutup_buku` berstatus `Aktif`. Setiap tutup buku
//! menyimpan dua waktu, `waktu_perangkat` (jam perangkat, bisa salah) dan
//! `diterima_cloud` (jam database cloud, diisi handler cloud), beserta potret
//! saldo setiap akun pada tanggal batas. Membuka kembali hanya untuk batas
//! terakhir, dengan alasan, dan barisnya tidak pernah dihapus.
//!
//! Penolakan pencatatan ada di `tulis_jurnal_tx`, satu-satunya penulis jurnal
//! lokal, sehingga jurnal manual, tagihan, kuitansi, kasbon, dan payroll ikut
//! tertolak tanpa pemeriksaan di tiap modul. Yang ditolak hanya PERANGKAT yang
//! sudah tahu periodenya ditutup; cloud tidak pernah menolak jurnal karena
//! tanggal (antrean sinkron akan macet padahal uangnya sudah diterima).
//!
//! Aturan murni dieja kembar di `src/lib/validations/tutup-buku.ts` dengan
//! vektor yang sama.

use rusqlite::{params, Connection};
use serde_json::{json, Value};

use super::{
    accounting, config::DesktopState, inventory, license, models::CommandError, storage, sync,
};

/// WAJIB sama dengan CHECK `keu_tutup_buku.status` di ketiga DDL. `Digantikan`
/// dan `Menunggu` dipakai keputusan bentrokan (Tahap 2).
#[cfg(test)]
pub const STATUS_TUTUP: [&str; 4] = ["Aktif", "Dibuka", "Digantikan", "Menunggu"];
pub const MAKS_ALASAN_BUKA: usize = 150;
pub const MAKS_CATATAN_KEPUTUSAN: usize = 150;
/// Keputusan atas tutup buku yang `Menunggu`: dipakai (yang lain digantikan)
/// atau ditolak (digantikan). Cermin `KEPUTUSAN_TUTUP`.
pub const KEPUTUSAN_TUTUP: [&str; 2] = ["pakai", "tolak"];

fn invalid(message: impl Into<String>) -> CommandError {
    CommandError::new("VALIDATION_ERROR", message)
}

fn db_error(_: rusqlite::Error) -> CommandError {
    CommandError::internal()
}

/// `2026-09-30` → `30/09/2026`.
pub fn tanggal_tampil(tanggal: &str) -> String {
    let bagian: Vec<&str> = tanggal.split('-').collect();
    match bagian.as_slice() {
        [tahun, bulan, hari] => format!("{hari}/{bulan}/{tahun}"),
        _ => tanggal.to_owned(),
    }
}

/// Cermin `cekPeriodeTerbuka`.
pub fn cek_periode_terbuka(tanggal: &str, batas: Option<&str>) -> Result<(), String> {
    match batas {
        Some(batas) if tanggal <= batas => Err(format!(
            "Tanggal {} masuk periode yang sudah ditutup (sampai {}). Catat dengan tanggal sesudahnya, atau minta pemegang izin tutup buku membuka periode itu.",
            tanggal_tampil(tanggal),
            tanggal_tampil(batas)
        )),
        _ => Ok(()),
    }
}

/// Cermin `validateTutup`: tanggal sah, sebelum hari ini (WIB), dan sesudah
/// batas yang berlaku.
pub fn validate_tutup(sampai: &str, batas: Option<&str>, hari_ini: &str) -> Result<String, String> {
    let sampai = sampai.trim();
    if !inventory::is_valid_date(sampai) {
        return Err("Tanggal tutup buku tidak valid.".to_owned());
    }
    if sampai >= hari_ini {
        return Err("Tanggal tutup buku harus sebelum hari ini.".to_owned());
    }
    if let Some(batas) = batas {
        if sampai <= batas {
            return Err(format!(
                "Buku sudah ditutup sampai {}. Pilih tanggal sesudahnya.",
                tanggal_tampil(batas)
            ));
        }
    }
    Ok(sampai.to_owned())
}

/// Cermin `validateAlasanBuka`.
pub fn validate_alasan_buka(alasan: &str) -> Result<String, String> {
    let alasan = alasan.trim();
    if alasan.is_empty() {
        return Err("Alasan membuka kembali wajib diisi.".to_owned());
    }
    if alasan.chars().count() > MAKS_ALASAN_BUKA {
        return Err(format!("Alasan paling banyak {MAKS_ALASAN_BUKA} karakter."));
    }
    Ok(alasan.to_owned())
}

/// Cermin `saldoTutupJson`: potret saldo dalam bentuk kanonik (urut `id_akun`,
/// akun bersaldo nol dibuang) supaya potret dari Rust dan TS bisa dibandingkan
/// apa adanya saat memeriksa bentrokan.
pub fn saldo_tutup_json(akun: &[(String, i64, i64)]) -> String {
    let mut urut: Vec<&(String, i64, i64)> =
        akun.iter().filter(|(_, debit, kredit)| *debit != 0 || *kredit != 0).collect();
    urut.sort_by(|a, b| a.0.cmp(&b.0));
    let isi: Vec<String> = urut
        .iter()
        .map(|(id, debit, kredit)| {
            format!(
                "{{\"id_akun\":{},\"debit\":{debit},\"kredit\":{kredit}}}",
                serde_json::to_string(id).unwrap_or_else(|_| "\"\"".to_owned())
            )
        })
        .collect();
    format!("[{}]", isi.join(","))
}

/// Cermin `validateCatatanKeputusan`: catatan boleh kosong, paling banyak 150.
pub fn validate_catatan_keputusan(catatan: &str) -> Result<Option<String>, String> {
    let catatan = catatan.trim();
    if catatan.chars().count() > MAKS_CATATAN_KEPUTUSAN {
        return Err(format!("Catatan paling banyak {MAKS_CATATAN_KEPUTUSAN} karakter."));
    }
    Ok((!catatan.is_empty()).then(|| catatan.to_owned()))
}

fn saldo_bersih(json_saldo: &str) -> std::collections::BTreeMap<String, i64> {
    serde_json::from_str::<Vec<Value>>(json_saldo)
        .unwrap_or_default()
        .iter()
        .filter_map(|item| {
            let id = item["id_akun"].as_str()?.to_owned();
            Some((id, item["debit"].as_i64().unwrap_or(0) - item["kredit"].as_i64().unwrap_or(0)))
        })
        .collect()
}

/// Cermin `bandingSaldo`: akun yang saldo bersihnya (debit - kredit) berbeda
/// antara dua potret, urut `id_akun`. Potret yang tidak terbaca = kosong.
pub fn banding_saldo(sebelum: &str, sesudah: &str) -> Vec<(String, i64, i64)> {
    let a = saldo_bersih(sebelum);
    let b = saldo_bersih(sesudah);
    let mut kunci: Vec<&String> = a.keys().chain(b.keys()).collect();
    kunci.sort();
    kunci.dedup();
    kunci
        .into_iter()
        .filter_map(|id| {
            let x = a.get(id).copied().unwrap_or(0);
            let y = b.get(id).copied().unwrap_or(0);
            (x != y).then(|| (id.clone(), x, y))
        })
        .collect()
}

/// Tanggal batas yang berlaku di database ini, atau `None`.
pub fn batas_tutup(connection: &Connection) -> Result<Option<String>, CommandError> {
    connection
        .query_row(
            "SELECT MAX(sampai_tanggal) FROM keu_tutup_buku WHERE status = 'Aktif'
             -- batas: agregat, selalu satu baris
             ;",
            [],
            |row| row.get(0),
        )
        .map_err(db_error)
}

/// Gerbang untuk setiap penulis jurnal lokal.
pub fn assert_periode_terbuka(connection: &Connection, tanggal: &str) -> Result<(), CommandError> {
    cek_periode_terbuka(tanggal, batas_tutup(connection)?.as_deref()).map_err(invalid)
}

fn hari_ini(connection: &Connection) -> Result<String, CommandError> {
    connection
        .query_row("SELECT date('now', '+7 hours');", [], |row| row.get(0))
        .map_err(db_error)
}

const KOLOM_TUTUP: &str = "id_tutup, sampai_tanggal, dibuat_oleh, kode_perangkat, waktu_perangkat,
    diterima_cloud, saldo_json, status, alasan_buka, dibuka_oleh, dibuka_pada, created_at, updated_at,
    diputuskan_oleh, diputuskan_pada, catatan_keputusan";

fn baris_json(row: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    Ok(json!({
        "id_tutup": row.get::<_, String>(0)?,
        "sampai_tanggal": row.get::<_, String>(1)?,
        "dibuat_oleh": row.get::<_, String>(2)?,
        "kode_perangkat": row.get::<_, String>(3)?,
        "waktu_perangkat": row.get::<_, String>(4)?,
        "diterima_cloud": row.get::<_, Option<String>>(5)?,
        "saldo_json": row.get::<_, String>(6)?,
        "status": row.get::<_, String>(7)?,
        "alasan_buka": row.get::<_, Option<String>>(8)?,
        "dibuka_oleh": row.get::<_, Option<String>>(9)?,
        "dibuka_pada": row.get::<_, Option<String>>(10)?,
        "created_at": row.get::<_, String>(11)?,
        "updated_at": row.get::<_, String>(12)?,
        "diputuskan_oleh": row.get::<_, Option<String>>(13)?,
        "diputuskan_pada": row.get::<_, Option<String>>(14)?,
        "catatan_keputusan": row.get::<_, Option<String>>(15)?,
    }))
}

/// Potret saldo kanonik saat ini sampai `sampai`, dari jurnal lokal.
fn saldo_sekarang(state: &DesktopState, sampai: &str) -> Result<String, CommandError> {
    let neraca = accounting::trial_balance(state, sampai)?;
    let akun: Vec<(String, i64, i64)> = neraca["items"]
        .as_array()
        .map(|items| {
            items
                .iter()
                .map(|item| {
                    (
                        item["id_akun"].as_str().unwrap_or("").to_owned(),
                        item["debit"].as_i64().unwrap_or(0),
                        item["kredit"].as_i64().unwrap_or(0),
                    )
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(saldo_tutup_json(&akun))
}

fn baca_tutup(connection: &Connection, id: &str) -> Result<Option<Value>, CommandError> {
    use rusqlite::OptionalExtension;
    connection
        .query_row(
            &format!("SELECT {KOLOM_TUTUP} FROM keu_tutup_buku WHERE id_tutup = ?;"),
            params![id],
            baris_json,
        )
        .optional()
        .map_err(db_error)
}

/// Batas yang berlaku dan riwayat tutup buku. Cermin `status` di TS.
pub fn status(state: &DesktopState) -> Result<Value, CommandError> {
    let connection = storage::database(&state.data_dir)?;
    let mut statement = connection
        .prepare(&format!(
            "SELECT {KOLOM_TUTUP} FROM keu_tutup_buku
             ORDER BY sampai_tanggal DESC, waktu_perangkat DESC, id_tutup
             LIMIT 200;"
        ))
        .map_err(db_error)?;
    let mut riwayat = statement
        .query_map([], baris_json)
        .map_err(db_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error)?;
    // Tutup buku berlaku yang saldonya berubah sejak ditutup: ada transaksi
    // yang masuk ke periode itu sesudahnya (biasanya dari perangkat offline).
    let mut cache: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    let mut perhatian = 0;
    for baris in &mut riwayat {
        let berlaku = baris["status"] == "Aktif";
        let perlu = if berlaku {
            let sampai = baris["sampai_tanggal"].as_str().unwrap_or("").to_owned();
            let sekarang = match cache.get(&sampai) {
                Some(nilai) => nilai.clone(),
                None => {
                    let nilai = saldo_sekarang(state, &sampai)?;
                    cache.insert(sampai, nilai.clone());
                    nilai
                }
            };
            baris["saldo_json"].as_str() != Some(sekarang.as_str())
        } else {
            false
        };
        if perlu || baris["status"] == "Menunggu" {
            perhatian += 1;
        }
        baris["perlu_ditinjau"] = json!(perlu);
    }
    Ok(json!({
        "batas": batas_tutup(&connection)?,
        "perlu_perhatian": perhatian,
        "riwayat": riwayat,
    }))
}

/// Tutup buku sampai `sampai`, dengan potret saldo saat itu.
pub fn close(state: &DesktopState, operator: &str, sampai: &str) -> Result<Value, CommandError> {
    let client_id = sync::ensure_client_id(state)?;
    let kode_perangkat = license::current_device_code(state)?;
    let mut connection = storage::database(&state.data_dir)?;
    let sampai = validate_tutup(
        sampai,
        batas_tutup(&connection)?.as_deref(),
        &hari_ini(&connection)?,
    )
    .map_err(invalid)?;
    let neraca = accounting::trial_balance(state, &sampai)?;
    let akun: Vec<(String, i64, i64)> = neraca["items"]
        .as_array()
        .map(|items| {
            items
                .iter()
                .map(|item| {
                    (
                        item["id_akun"].as_str().unwrap_or("").to_owned(),
                        item["debit"].as_i64().unwrap_or(0),
                        item["kredit"].as_i64().unwrap_or(0),
                    )
                })
                .collect()
        })
        .unwrap_or_default();
    let mut bytes = [0u8; 16];
    rand_core::RngCore::fill_bytes(&mut rand_core::OsRng, &mut bytes);
    let id = format!("tb-{}", hex::encode(bytes));

    let transaction = connection.transaction().map_err(db_error)?;
    transaction
        .execute(
            "INSERT INTO keu_tutup_buku (
                id_tutup, sampai_tanggal, dibuat_oleh, kode_perangkat, waktu_perangkat,
                diterima_cloud, saldo_json, status
             ) VALUES (?, ?, ?, ?, datetime('now', '+7 hours'), NULL, ?, 'Aktif');",
            params![id, sampai, operator, kode_perangkat, saldo_tutup_json(&akun)],
        )
        .map_err(db_error)?;
    let baris = transaction
        .query_row(
            &format!("SELECT {KOLOM_TUTUP} FROM keu_tutup_buku WHERE id_tutup = ?;"),
            params![id],
            baris_json,
        )
        .map_err(db_error)?;
    sync::enqueue(&transaction, &client_id, "accounting-close", "create", &id, &baris, None)?;
    transaction.commit().map_err(db_error)?;
    Ok(json!({ "sukses": true, "tutup": baris }))
}

/// Buka kembali batas terakhir. Semua baris `Aktif` bertanggal batas itu ikut
/// dibuka, termasuk tutup buku kembar dari perangkat lain.
pub fn reopen(state: &DesktopState, operator: &str, alasan: &str) -> Result<Value, CommandError> {
    let alasan = validate_alasan_buka(alasan).map_err(invalid)?;
    let client_id = sync::ensure_client_id(state)?;
    let mut connection = storage::database(&state.data_dir)?;
    let Some(batas) = batas_tutup(&connection)? else {
        return Err(invalid("Belum ada periode yang ditutup."));
    };
    let transaction = connection.transaction().map_err(db_error)?;
    let id: String = transaction
        .query_row(
            "SELECT id_tutup FROM keu_tutup_buku WHERE sampai_tanggal = ? AND status = 'Aktif'
             ORDER BY id_tutup LIMIT 1;",
            params![batas],
            |row| row.get(0),
        )
        .map_err(db_error)?;
    let dibuka_pada: String = transaction
        .query_row("SELECT datetime('now', '+7 hours');", [], |row| row.get(0))
        .map_err(db_error)?;
    transaction
        .execute(
            "UPDATE keu_tutup_buku
             SET status = 'Dibuka', alasan_buka = ?, dibuka_oleh = ?, dibuka_pada = ?,
                 updated_at = datetime('now')
             WHERE sampai_tanggal = ? AND status = 'Aktif';",
            params![alasan, operator, dibuka_pada, batas],
        )
        .map_err(db_error)?;
    sync::enqueue(
        &transaction,
        &client_id,
        "accounting-close",
        "reopen",
        &id,
        &json!({
            "id_tutup": id,
            "sampai_tanggal": batas,
            "alasan_buka": alasan,
            "dibuka_oleh": operator,
            "dibuka_pada": dibuka_pada,
        }),
        None,
    )?;
    transaction.commit().map_err(db_error)?;
    Ok(json!({ "sukses": true, "batas": batas_tutup(&connection)? }))
}

// ── Tahap 2: tinjauan dan keputusan ─────────────────────────────────────────

/// Bahan tinjauan satu tutup buku. `Menunggu`: dibandingkan dengan versi
/// berlaku bertanggal sama. `Aktif`: dibandingkan dengan saldo sekarang,
/// beserta jurnal bertanggal di periode itu yang dicatat sesudah ditutup
/// (menurut jam pencatatnya). Cermin `review` di TS.
pub fn review(state: &DesktopState, id_tutup: &str) -> Result<Value, CommandError> {
    let connection = storage::database(&state.data_dir)?;
    let tutup = baca_tutup(&connection, id_tutup)?
        .ok_or_else(|| invalid("Tutup buku tidak ditemukan."))?;
    let sampai = tutup["sampai_tanggal"].as_str().unwrap_or("").to_owned();
    let saldo = tutup["saldo_json"].as_str().unwrap_or("[]").to_owned();
    let mut pembanding = Value::Null;
    let mut jurnal: Vec<Value> = Vec::new();
    let selisih = match tutup["status"].as_str() {
        Some("Menunggu") => {
            let mut statement = connection
                .prepare(&format!(
                    "SELECT {KOLOM_TUTUP} FROM keu_tutup_buku
                     WHERE sampai_tanggal = ? AND status = 'Aktif' AND id_tutup <> ?
                     ORDER BY id_tutup LIMIT 1;"
                ))
                .map_err(db_error)?;
            pembanding = statement
                .query_map(params![sampai, id_tutup], baris_json)
                .map_err(db_error)?
                .next()
                .transpose()
                .map_err(db_error)?
                .unwrap_or(Value::Null);
            banding_saldo(pembanding["saldo_json"].as_str().unwrap_or("[]"), &saldo)
        }
        Some("Aktif") => {
            let hasil = banding_saldo(&saldo, &saldo_sekarang(state, &sampai)?);
            if !hasil.is_empty() {
                let mut statement = connection
                    .prepare(
                        "SELECT j.id_jurnal, j.tanggal, j.nomor, j.keterangan, j.sumber, j.dibuat_oleh,
                                j.created_at, COALESCE(SUM(b.debit), 0)
                         FROM keu_jurnal j
                         LEFT JOIN keu_jurnal_baris b ON b.id_jurnal = j.id_jurnal
                         WHERE j.tanggal <= ? AND j.created_at > ?
                         GROUP BY j.id_jurnal
                         ORDER BY j.created_at DESC, j.id_jurnal
                         LIMIT 200;",
                    )
                    .map_err(db_error)?;
                jurnal = statement
                    .query_map(params![sampai, tutup["created_at"].as_str().unwrap_or("")], |row| {
                        Ok(json!({
                            "id_jurnal": row.get::<_, String>(0)?,
                            "tanggal": row.get::<_, String>(1)?,
                            "nomor": row.get::<_, String>(2)?,
                            "keterangan": row.get::<_, String>(3)?,
                            "sumber": row.get::<_, String>(4)?,
                            "dibuat_oleh": row.get::<_, String>(5)?,
                            "created_at": row.get::<_, String>(6)?,
                            "total": row.get::<_, i64>(7)?,
                        }))
                    })
                    .map_err(db_error)?
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(db_error)?;
            }
            hasil
        }
        _ => Vec::new(),
    };
    let mut daftar = Vec::with_capacity(selisih.len());
    for (id_akun, sebelum, sesudah) in selisih {
        let (kode, nama): (String, String) = {
            use rusqlite::OptionalExtension;
            connection
                .query_row(
                    "SELECT kode, nama FROM keu_akun WHERE id_akun = ?;",
                    params![id_akun],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()
                .map_err(db_error)?
                .unwrap_or_else(|| (String::new(), id_akun.clone()))
        };
        daftar.push(json!({
            "id_akun": id_akun, "kode": kode, "nama": nama, "sebelum": sebelum, "sesudah": sesudah,
        }));
    }
    Ok(json!({ "tutup": tutup, "pembanding": pembanding, "selisih": daftar, "jurnal": jurnal }))
}

/// Dipakai lokal DAN di cloud (parameter posisional sama): versi lain
/// bertanggal sama yang masih berlaku atau menunggu menjadi `Digantikan`.
pub const PAKAI_SINGKIRKAN_SQL: &str = "UPDATE keu_tutup_buku
    SET status = 'Digantikan', diputuskan_oleh = ?, diputuskan_pada = ?, catatan_keputusan = ?,
        updated_at = datetime('now')
    WHERE sampai_tanggal = (SELECT sampai_tanggal FROM keu_tutup_buku WHERE id_tutup = ?)
      AND id_tutup <> ?
      AND status IN ('Aktif', 'Menunggu')
      AND EXISTS (SELECT 1 FROM keu_tutup_buku WHERE id_tutup = ? AND status IN ('Aktif', 'Menunggu'));";

pub const PAKAI_SQL: &str = "UPDATE keu_tutup_buku
    SET status = 'Aktif', diputuskan_oleh = ?, diputuskan_pada = ?, catatan_keputusan = ?,
        updated_at = datetime('now')
    WHERE id_tutup = ? AND status IN ('Aktif', 'Menunggu');";

pub const TOLAK_SQL: &str = "UPDATE keu_tutup_buku
    SET status = 'Digantikan', diputuskan_oleh = ?, diputuskan_pada = ?, catatan_keputusan = ?,
        updated_at = datetime('now')
    WHERE id_tutup = ? AND status IN ('Aktif', 'Menunggu');";

/// Pernyataan satu keputusan. Cermin `statementKeputusan`.
pub fn statement_keputusan(
    id_tutup: &str,
    keputusan: &str,
    oleh: &str,
    pada: &str,
    catatan: Option<&str>,
) -> Option<Vec<(&'static str, Vec<Value>)>> {
    let cap = vec![json!(oleh), json!(pada), json!(catatan)];
    let dengan = |tambahan: Vec<Value>| {
        let mut v = cap.clone();
        v.extend(tambahan);
        v
    };
    match keputusan {
        "pakai" => Some(vec![
            (PAKAI_SINGKIRKAN_SQL, dengan(vec![json!(id_tutup), json!(id_tutup), json!(id_tutup)])),
            (PAKAI_SQL, dengan(vec![json!(id_tutup)])),
        ]),
        "tolak" => Some(vec![(TOLAK_SQL, dengan(vec![json!(id_tutup)]))]),
        _ => None,
    }
}

fn jalankan_lokal(
    transaction: &rusqlite::Transaction<'_>,
    pernyataan: Vec<(&'static str, Vec<Value>)>,
) -> Result<(), CommandError> {
    for (sql, nilai) in pernyataan {
        let args: Vec<rusqlite::types::Value> = nilai
            .into_iter()
            .map(|v| match v {
                Value::String(s) => rusqlite::types::Value::Text(s),
                _ => rusqlite::types::Value::Null,
            })
            .collect();
        transaction
            .execute(sql, rusqlite::params_from_iter(args))
            .map_err(db_error)?;
    }
    Ok(())
}

fn waktu_sekarang(connection: &Connection) -> Result<String, CommandError> {
    connection
        .query_row("SELECT datetime('now', '+7 hours');", [], |row| row.get(0))
        .map_err(db_error)
}

/// Putuskan tutup buku yang `Menunggu`: dipakai atau ditolak.
pub fn decide(
    state: &DesktopState,
    operator: &str,
    id_tutup: &str,
    keputusan: &str,
    catatan: &str,
) -> Result<Value, CommandError> {
    if !KEPUTUSAN_TUTUP.contains(&keputusan) {
        return Err(invalid("Keputusan tidak dikenal."));
    }
    let catatan = validate_catatan_keputusan(catatan).map_err(invalid)?;
    let client_id = sync::ensure_client_id(state)?;
    let mut connection = storage::database(&state.data_dir)?;
    let tutup = baca_tutup(&connection, id_tutup)?
        .ok_or_else(|| invalid("Tutup buku tidak ditemukan."))?;
    if tutup["status"] != "Menunggu" {
        return Err(invalid("Hanya tutup buku yang menunggu keputusan yang bisa diputuskan."));
    }
    let pada = waktu_sekarang(&connection)?;
    let transaction = connection.transaction().map_err(db_error)?;
    let pernyataan = statement_keputusan(id_tutup, keputusan, operator, &pada, catatan.as_deref())
        .ok_or_else(|| invalid("Keputusan tidak dikenal."))?;
    jalankan_lokal(&transaction, pernyataan)?;
    sync::enqueue(
        &transaction,
        &client_id,
        "accounting-close",
        "decide",
        id_tutup,
        &json!({
            "id_tutup": id_tutup, "keputusan": keputusan, "diputuskan_oleh": operator,
            "diputuskan_pada": pada, "catatan_keputusan": catatan,
        }),
        None,
    )?;
    transaction.commit().map_err(db_error)?;
    Ok(json!({ "sukses": true, "batas": batas_tutup(&connection)? }))
}

/// Tutup ulang tutup buku berlaku yang saldonya berubah: versi lama
/// `Digantikan`, versi baru dengan saldo sekarang `Aktif`. Keputusan didorong
/// LEBIH DULU daripada versi baru, sehingga cloud tidak menganggap versi baru
/// bentrok dengan versi lama.
pub fn revise(
    state: &DesktopState,
    operator: &str,
    id_tutup: &str,
    catatan: &str,
) -> Result<Value, CommandError> {
    let catatan = validate_catatan_keputusan(catatan)
        .map_err(invalid)?
        .unwrap_or_else(|| "Ditutup ulang dengan saldo sekarang.".to_owned());
    let client_id = sync::ensure_client_id(state)?;
    let kode_perangkat = license::current_device_code(state)?;
    let mut connection = storage::database(&state.data_dir)?;
    let tutup = baca_tutup(&connection, id_tutup)?
        .ok_or_else(|| invalid("Tutup buku tidak ditemukan."))?;
    if tutup["status"] != "Aktif" {
        return Err(invalid("Hanya tutup buku yang berlaku yang bisa ditutup ulang."));
    }
    let sampai = tutup["sampai_tanggal"].as_str().unwrap_or("").to_owned();
    let sekarang = saldo_sekarang(state, &sampai)?;
    if tutup["saldo_json"].as_str() == Some(sekarang.as_str()) {
        return Err(invalid("Saldo periode ini tidak berubah sejak ditutup."));
    }
    let pada = waktu_sekarang(&connection)?;
    let mut bytes = [0u8; 16];
    rand_core::RngCore::fill_bytes(&mut rand_core::OsRng, &mut bytes);
    let id_baru = format!("tb-{}", hex::encode(bytes));

    let transaction = connection.transaction().map_err(db_error)?;
    let pernyataan = statement_keputusan(id_tutup, "tolak", operator, &pada, Some(&catatan))
        .ok_or_else(CommandError::internal)?;
    jalankan_lokal(&transaction, pernyataan)?;
    sync::enqueue(
        &transaction,
        &client_id,
        "accounting-close",
        "decide",
        id_tutup,
        &json!({
            "id_tutup": id_tutup, "keputusan": "tolak", "diputuskan_oleh": operator,
            "diputuskan_pada": pada, "catatan_keputusan": catatan,
        }),
        None,
    )?;
    transaction
        .execute(
            "INSERT INTO keu_tutup_buku (
                id_tutup, sampai_tanggal, dibuat_oleh, kode_perangkat, waktu_perangkat,
                diterima_cloud, saldo_json, status
             ) VALUES (?, ?, ?, ?, datetime('now', '+7 hours'), NULL, ?, 'Aktif');",
            params![id_baru, sampai, operator, kode_perangkat, sekarang],
        )
        .map_err(db_error)?;
    let baris = transaction
        .query_row(
            &format!("SELECT {KOLOM_TUTUP} FROM keu_tutup_buku WHERE id_tutup = ?;"),
            params![id_baru],
            baris_json,
        )
        .map_err(db_error)?;
    sync::enqueue(&transaction, &client_id, "accounting-close", "create", &id_baru, &baris, None)?;
    transaction.commit().map_err(db_error)?;
    Ok(json!({ "sukses": true, "tutup": baris }))
}

// ── Penerapan event di cloud ────────────────────────────────────────────────

fn teks(row: &Value, key: &str) -> Option<String> {
    row.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

/// `diterima_cloud` selalu diisi jam database cloud di sini, tidak pernah
/// dari payload: itulah satu-satunya waktu yang tidak bisa dipalsukan
/// perangkat.
///
/// Bentrokan (Tahap 2): bila cloud sudah memegang tutup buku BERLAKU lain
/// bertanggal sama dengan potret saldo yang BERBEDA, versi yang datang
/// disimpan `Menunggu` untuk diputuskan pemegang `accounting.close`. Potret
/// identik digabung otomatis (keduanya berlaku). Tidak ada yang ditolak, jadi
/// antrean sinkron tidak macet.
pub const CLOUD_INSERT_CLOSE_SQL: &str = "INSERT INTO keu_tutup_buku (
        id_tutup, sampai_tanggal, dibuat_oleh, kode_perangkat, waktu_perangkat,
        diterima_cloud, saldo_json, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, datetime('now', '+7 hours'), ?,
              CASE WHEN EXISTS (
                  SELECT 1 FROM keu_tutup_buku k
                  WHERE k.sampai_tanggal = ? AND k.status = 'Aktif'
                    AND k.id_tutup <> ? AND k.saldo_json <> ?
              ) THEN 'Menunggu' ELSE 'Aktif' END,
              COALESCE(?, datetime('now')), COALESCE(?, datetime('now')))
    ON CONFLICT(id_tutup) DO NOTHING;";

/// Nilai untuk `CLOUD_INSERT_CLOSE_SQL` dari event `accounting-close/create`;
/// payload cacat dilewati seluruhnya.
pub fn cloud_close_values(row: &Value, entity_key: &str) -> Option<Vec<Value>> {
    let id = teks(row, "id_tutup").unwrap_or_else(|| entity_key.trim().to_owned());
    let sampai = teks(row, "sampai_tanggal").filter(|value| inventory::is_valid_date(value))?;
    let dibuat_oleh = teks(row, "dibuat_oleh")?;
    let kode_perangkat = teks(row, "kode_perangkat")?;
    let waktu_perangkat = teks(row, "waktu_perangkat")?;
    let saldo_json = teks(row, "saldo_json")?;
    if id.is_empty() {
        return None;
    }
    Some(vec![
        json!(id),
        json!(sampai),
        json!(dibuat_oleh),
        json!(kode_perangkat),
        json!(waktu_perangkat),
        json!(saldo_json),
        json!(sampai),
        json!(id),
        json!(saldo_json),
        json!(teks(row, "created_at")),
        json!(teks(row, "updated_at")),
    ])
}

/// Pernyataan event `accounting-close/decide`; payload cacat dilewati.
pub fn cloud_decide_statements(row: &Value) -> Option<Vec<(&'static str, Vec<Value>)>> {
    let id = teks(row, "id_tutup")?;
    let keputusan = teks(row, "keputusan")?;
    let catatan = validate_catatan_keputusan(&teks(row, "catatan_keputusan").unwrap_or_default()).ok()?;
    statement_keputusan(
        &id,
        &keputusan,
        &teks(row, "diputuskan_oleh")?,
        &teks(row, "diputuskan_pada")?,
        catatan.as_deref(),
    )
}

pub const CLOUD_REOPEN_SQL: &str = "UPDATE keu_tutup_buku
    SET status = 'Dibuka', alasan_buka = ?, dibuka_oleh = ?, dibuka_pada = ?,
        updated_at = datetime('now')
    WHERE sampai_tanggal = ? AND status = 'Aktif';";

/// Nilai untuk `CLOUD_REOPEN_SQL` dari event `accounting-close/reopen`.
pub fn cloud_reopen_values(row: &Value) -> Option<Vec<Value>> {
    let sampai = teks(row, "sampai_tanggal").filter(|value| inventory::is_valid_date(value))?;
    let alasan = validate_alasan_buka(&teks(row, "alasan_buka")?).ok()?;
    Some(vec![
        json!(alasan),
        json!(teks(row, "dibuka_oleh")?),
        json!(teks(row, "dibuka_pada")?),
        json!(sampai),
    ])
}

#[cfg(test)]
mod tests {
    use super::*;

    // Vektor kembar `src/lib/validations/tutup-buku.test.ts`.
    #[test]
    fn aturan_murni_kembar() {
        assert_eq!(cek_periode_terbuka("2026-10-01", None), Ok(()));
        assert_eq!(cek_periode_terbuka("2026-10-01", Some("2026-09-30")), Ok(()));
        assert_eq!(
            cek_periode_terbuka("2026-09-30", Some("2026-09-30")),
            Err("Tanggal 30/09/2026 masuk periode yang sudah ditutup (sampai 30/09/2026). Catat dengan tanggal sesudahnya, atau minta pemegang izin tutup buku membuka periode itu.".to_owned())
        );
        assert_eq!(validate_tutup(" 2026-09-30 ", None, "2026-10-14"), Ok("2026-09-30".to_owned()));
        assert_eq!(
            validate_tutup("2026-09-31", None, "2026-10-14"),
            Err("Tanggal tutup buku tidak valid.".to_owned())
        );
        assert_eq!(
            validate_tutup("2026-10-14", None, "2026-10-14"),
            Err("Tanggal tutup buku harus sebelum hari ini.".to_owned())
        );
        assert_eq!(
            validate_tutup("2026-08-31", Some("2026-08-31"), "2026-10-14"),
            Err("Buku sudah ditutup sampai 31/08/2026. Pilih tanggal sesudahnya.".to_owned())
        );
        assert_eq!(validate_alasan_buka("  Salah input  "), Ok("Salah input".to_owned()));
        assert_eq!(
            validate_alasan_buka(" "),
            Err("Alasan membuka kembali wajib diisi.".to_owned())
        );
        assert_eq!(
            validate_alasan_buka(&"a".repeat(151)),
            Err("Alasan paling banyak 150 karakter.".to_owned())
        );
        assert_eq!(
            saldo_tutup_json(&[
                ("akun-pendapatan-usaha".into(), 0, 300_000),
                ("akun-kas".into(), 300_000, 0),
                ("akun-bank".into(), 0, 0),
            ]),
            r#"[{"id_akun":"akun-kas","debit":300000,"kredit":0},{"id_akun":"akun-pendapatan-usaha","debit":0,"kredit":300000}]"#
        );
        assert_eq!(saldo_tutup_json(&[]), "[]");
    }

    fn state_uji() -> (tempfile::TempDir, DesktopState) {
        let dir = tempfile::tempdir().expect("tempdir");
        storage::initialize(dir.path()).expect("skema lokal");
        let state = DesktopState {
            server_origin: std::sync::RwLock::new("http://localhost:3000".to_string()),
            offline_max_age_hours: 24,
            data_dir: dir.path().to_path_buf(),
            http: reqwest::Client::new(),
            turso_config: std::sync::RwLock::new(None),
            session: std::sync::Mutex::new(None),
            vault_lock: std::sync::Mutex::new(()),
        };
        (dir, state)
    }

    fn jurnal(tanggal: &str) -> Value {
        json!({
            "tanggal": tanggal,
            "keterangan": "Uji",
            "baris": [
                { "id_akun": "akun-kas", "debit": 100000, "kredit": 0 },
                { "id_akun": "akun-pendapatan-usaha", "debit": 0, "kredit": 100000 }
            ]
        })
    }

    #[test]
    fn tutup_tolak_lalu_buka_kembali() {
        let (_dir, state) = state_uji();
        accounting::post_journal(&state, "tu", jurnal("2020-01-15")).expect("jurnal sebelum tutup");

        let hasil = close(&state, "kepala", "2020-01-31").expect("tutup");
        let saldo = hasil["tutup"]["saldo_json"].as_str().expect("saldo").to_owned();
        assert!(saldo.contains(r#"{"id_akun":"akun-kas","debit":100000,"kredit":0}"#), "{saldo}");
        assert_eq!(hasil["tutup"]["diterima_cloud"], Value::Null);
        assert_eq!(status(&state).expect("status")["batas"], json!("2020-01-31"));

        let tolak = accounting::post_journal(&state, "tu", jurnal("2020-01-31")).expect_err("periode tertutup");
        assert!(tolak.message.starts_with("Tanggal 31/01/2020 masuk periode yang sudah ditutup"), "{}", tolak.message);
        accounting::post_journal(&state, "tu", jurnal("2020-02-01")).expect("sesudah batas");

        assert_eq!(
            close(&state, "kepala", "2020-01-31").expect_err("tutup ulang").message,
            "Buku sudah ditutup sampai 31/01/2020. Pilih tanggal sesudahnya."
        );
        assert_eq!(
            reopen(&state, "kepala", " ").expect_err("tanpa alasan").message,
            "Alasan membuka kembali wajib diisi."
        );
        let buka = reopen(&state, "kepala", "Kuitansi Januari tertinggal").expect("buka");
        assert_eq!(buka["batas"], Value::Null);
        accounting::post_journal(&state, "tu", jurnal("2020-01-20")).expect("periode dibuka");
        assert_eq!(
            reopen(&state, "kepala", "Lagi").expect_err("tidak ada yang ditutup").message,
            "Belum ada periode yang ditutup."
        );

        let riwayat = status(&state).expect("status")["riwayat"].clone();
        assert_eq!(riwayat[0]["status"], json!("Dibuka"));
        assert_eq!(riwayat[0]["alasan_buka"], json!("Kuitansi Januari tertinggal"));
        let connection = storage::database(&state.data_dir).expect("db");
        let events: Vec<String> = connection
            .prepare(
                "SELECT operation FROM desktop_sync_outbox WHERE domain = 'accounting-close' ORDER BY created_at, rowid;",
            )
            .expect("siapkan")
            .query_map([], |row| row.get(0))
            .expect("baca")
            .collect::<Result<_, _>>()
            .expect("baris");
        assert_eq!(events, vec!["create".to_owned(), "reopen".to_owned()]);
    }

    // Vektor kembar `src/lib/validations/tutup-buku.test.ts` (Tahap 2).
    #[test]
    fn aturan_keputusan_kembar() {
        assert_eq!(
            banding_saldo(
                r#"[{"id_akun":"akun-kas","debit":100,"kredit":0},{"id_akun":"akun-spp","debit":0,"kredit":100}]"#,
                r#"[{"id_akun":"akun-bank","debit":50,"kredit":0},{"id_akun":"akun-kas","debit":100,"kredit":0},{"id_akun":"akun-spp","debit":0,"kredit":150}]"#,
            ),
            vec![("akun-bank".to_owned(), 0, 50), ("akun-spp".to_owned(), -100, -150)]
        );
        assert_eq!(banding_saldo("rusak", "[]"), Vec::<(String, i64, i64)>::new());
        assert_eq!(validate_catatan_keputusan("  "), Ok(None));
        assert_eq!(validate_catatan_keputusan(" Cocok dengan kas "), Ok(Some("Cocok dengan kas".to_owned())));
        assert_eq!(
            validate_catatan_keputusan(&"a".repeat(151)),
            Err("Catatan paling banyak 150 karakter.".to_owned())
        );
    }

    #[test]
    fn status_tutup_diterima_check_lokal() {
        let (_dir, state) = state_uji();
        let connection = storage::database(&state.data_dir).expect("db");
        for (i, status) in STATUS_TUTUP.iter().enumerate() {
            connection
                .execute(
                    "INSERT INTO keu_tutup_buku (id_tutup, sampai_tanggal, dibuat_oleh, kode_perangkat, waktu_perangkat, saldo_json, status)
                     VALUES (?, '2020-01-31', 'a', 'D', 'x', '[]', ?);",
                    params![format!("tb-{i}"), status],
                )
                .expect("status diterima CHECK");
        }
    }

    /// Jurnal yang tiba lewat tarikan (tanpa gerbang lokal) ke periode yang
    /// sudah ditutup: tutup buku menjadi "perlu ditinjau", lalu ditutup ulang.
    #[test]
    fn transaksi_telat_ditinjau_lalu_ditutup_ulang() {
        let (_dir, state) = state_uji();
        accounting::post_journal(&state, "tu", jurnal("2020-01-15")).expect("jurnal awal");
        let lama = close(&state, "kepala", "2020-01-31").expect("tutup")["tutup"]["id_tutup"]
            .as_str()
            .expect("id")
            .to_owned();
        assert_eq!(status(&state).expect("status")["perlu_perhatian"], json!(0));

        let connection = storage::database(&state.data_dir).expect("db");
        connection
            .execute_batch(
                "INSERT INTO keu_jurnal (id_jurnal, tanggal, seri, nomor_urut, nomor, keterangan, sumber, dibuat_oleh, created_at)
                 VALUES ('jrn-telat', '2020-01-20', 'M1234', 1, 'JU/2020/M1234/0001', 'SPP dari HP offline', 'Manual', 'bendahara', datetime('now', '+1 minute'));
                 INSERT INTO keu_jurnal_baris (id_baris, id_jurnal, id_akun, debit, kredit, urutan) VALUES
                   ('jrn-telat-1', 'jrn-telat', 'akun-kas', 50000, 0, 1),
                   ('jrn-telat-2', 'jrn-telat', 'akun-pendapatan-usaha', 0, 50000, 2);",
            )
            .expect("jurnal telat");

        let st = status(&state).expect("status");
        assert_eq!(st["perlu_perhatian"], json!(1));
        assert_eq!(st["riwayat"][0]["perlu_ditinjau"], json!(true));
        let tinjau = review(&state, &lama).expect("tinjau");
        let kas = tinjau["selisih"]
            .as_array()
            .expect("selisih")
            .iter()
            .find(|baris| baris["id_akun"] == "akun-kas")
            .cloned()
            .expect("akun kas berubah");
        assert_eq!((kas["sebelum"].clone(), kas["sesudah"].clone()), (json!(100000), json!(150000)));
        assert_eq!(tinjau["jurnal"][0]["id_jurnal"], json!("jrn-telat"));
        assert_eq!(tinjau["jurnal"][0]["total"], json!(50000));

        let baru = revise(&state, "kepala", &lama, "").expect("tutup ulang");
        assert_eq!(baru["tutup"]["status"], json!("Aktif"));
        let st = status(&state).expect("status");
        assert_eq!(st["perlu_perhatian"], json!(0));
        assert_eq!(st["batas"], json!("2020-01-31"));
        let lama_baris = baca_tutup(&connection, &lama).expect("baca").expect("ada");
        assert_eq!(lama_baris["status"], json!("Digantikan"));
        assert_eq!(lama_baris["catatan_keputusan"], json!("Ditutup ulang dengan saldo sekarang."));
        assert_eq!(
            revise(&state, "kepala", baru["tutup"]["id_tutup"].as_str().expect("id"), "")
                .expect_err("tidak berubah")
                .message,
            "Saldo periode ini tidak berubah sejak ditutup."
        );
        // Keputusan harus sampai ke cloud SEBELUM versi baru.
        let urutan: Vec<String> = connection
            .prepare(
                "SELECT operation FROM desktop_sync_outbox WHERE domain = 'accounting-close' ORDER BY created_at, rowid;",
            )
            .expect("siapkan")
            .query_map([], |row| row.get(0))
            .expect("baca")
            .collect::<Result<_, _>>()
            .expect("baris");
        assert_eq!(urutan, vec!["create".to_owned(), "decide".to_owned(), "create".to_owned()]);
    }

    /// Versi yang `Menunggu` (ditarik dari cloud) diputuskan atasan.
    #[test]
    fn versi_menunggu_dipakai_atau_ditolak() {
        let (_dir, state) = state_uji();
        accounting::post_journal(&state, "tu", jurnal("2020-01-15")).expect("jurnal awal");
        let berlaku = close(&state, "kepala", "2020-01-31").expect("tutup")["tutup"]["id_tutup"]
            .as_str()
            .expect("id")
            .to_owned();
        let connection = storage::database(&state.data_dir).expect("db");
        connection
            .execute_batch(
                "INSERT INTO keu_tutup_buku (id_tutup, sampai_tanggal, dibuat_oleh, kode_perangkat, waktu_perangkat, diterima_cloud, saldo_json, status) VALUES
                   ('tb-hp', '2020-01-31', 'bendahara', 'A9F3', '2020-02-01 07:00:00', '2020-02-03 10:00:00', '[]', 'Menunggu'),
                   ('tb-hp2', '2020-01-31', 'tu', 'B111', '2020-02-01 08:00:00', '2020-02-03 11:00:00', '[]', 'Menunggu');",
            )
            .expect("versi menunggu");
        assert_eq!(status(&state).expect("status")["perlu_perhatian"], json!(2));

        let tinjau = review(&state, "tb-hp").expect("tinjau");
        assert_eq!(tinjau["pembanding"]["id_tutup"], json!(berlaku));
        assert_eq!(tinjau["selisih"].as_array().expect("selisih").len(), 2);

        assert_eq!(
            decide(&state, "kepala", "tb-hp", "abaikan", "").expect_err("keputusan asing").message,
            "Keputusan tidak dikenal."
        );
        assert_eq!(
            decide(&state, "kepala", &berlaku, "pakai", "").expect_err("bukan menunggu").message,
            "Hanya tutup buku yang menunggu keputusan yang bisa diputuskan."
        );
        decide(&state, "kepala", "tb-hp", "pakai", "Sesuai buku kas").expect("pakai");
        let status_dari = |id: &str| baca_tutup(&connection, id).expect("baca").expect("ada")["status"].clone();
        assert_eq!(status_dari("tb-hp"), json!("Aktif"));
        assert_eq!(status_dari(&berlaku), json!("Digantikan"));
        assert_eq!(status_dari("tb-hp2"), json!("Digantikan"));
        assert_eq!(
            baca_tutup(&connection, &berlaku).expect("baca").expect("ada")["diputuskan_oleh"],
            json!("kepala")
        );
        assert_eq!(status(&state).expect("status")["batas"], json!("2020-01-31"));
    }
}
