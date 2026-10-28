//! Akuntansi berpasangan (Fase K1).
//!
//! Tiga tabel tersinkron: `keu_akun`, `keu_jurnal`, `keu_jurnal_baris`. Saldo
//! tidak pernah disimpan; setiap laporan menjumlahkan baris jurnal, karena
//! kolom saldo yang ikut sync ditimpa siapa terakhir menang saat dua perangkat
//! offline mencatat transaksi. Jurnal append-only: koreksi adalah jurnal
//! pembalik berid `batal-<id>`, sehingga pembatalan ganda dari dua perangkat
//! menghasilkan PK yang sama dan cloud mengabaikan yang kedua.
//!
//! Aturan murni di berkas ini dicerminkan `src/lib/validations/accounting.ts`
//! dan diuji dengan vektor yang sama. Pesan galatnya pun wajib identik.

use std::collections::HashSet;
use std::sync::OnceLock;

use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::Deserialize;
use serde_json::{json, Value};

use super::{config::DesktopState, license, models::CommandError, storage, sync};

/// WAJIB sama dengan CHECK `keu_akun.kelompok` di ketiga DDL.
pub const KELOMPOK_AKUN: [&str; 5] = ["Aset", "Kewajiban", "Ekuitas", "Pendapatan", "Beban"];
pub const SALDO_NORMAL: [&str; 2] = ["Debit", "Kredit"];
/// WAJIB sama dengan CHECK `keu_jurnal.sumber` di ketiga DDL.
pub const SUMBER_JURNAL: [&str; 5] = ["Manual", "Kasbon", "Payroll", "Inventaris", "Pembatalan"];

pub const MAKS_NOMINAL: i64 = 1_000_000_000_000;
pub const MAKS_BARIS_JURNAL: usize = 100;
pub const MAKS_KETERANGAN: usize = 200;
pub const MAKS_ALASAN_BATAL: usize = 150;
pub const MAKS_KODE_AKUN: usize = 20;
pub const MAKS_NAMA_AKUN: usize = 80;
/// Cermin `MAKS_BARIS_BUKU_BESAR` (`validations/accounting.ts`).
pub const MAKS_BARIS_BUKU_BESAR: usize = 1000;

#[derive(Debug, Clone, Deserialize)]
pub struct AkunBawaan {
    pub id_akun: String,
    pub kode: String,
    pub nama: String,
    pub kelompok: String,
    pub saldo_normal: String,
    pub sistem: bool,
}

/// Bagan akun bawaan dari berkas JSON yang SAMA dengan yang diimpor
/// `validations/accounting.ts`. Seed payroll pernah ditulis dua kali dengan
/// tangan dan langsung menyimpang; berkas tunggal ini menutup jalan itu.
pub fn akun_bawaan() -> &'static [AkunBawaan] {
    static AKUN: OnceLock<Vec<AkunBawaan>> = OnceLock::new();
    AKUN.get_or_init(|| {
        serde_json::from_str(include_str!(
            "../../../src/lib/validations/akun-bawaan.json"
        ))
        .expect("akun-bawaan.json tidak valid")
    })
}

/// Akun yang dipakai jurnal otomatis K2/K3: boleh diganti nama, tidak lebih.
pub fn is_akun_sistem(id_akun: &str) -> bool {
    akun_bawaan()
        .iter()
        .any(|akun| akun.sistem && akun.id_akun == id_akun)
}

/// Cermin `SEED_AKUN_SQL`. Idempoten: akun yang sudah diganti nama tidak ditimpa.
pub const SEED_AKUN_SQL: &str = "INSERT OR IGNORE INTO keu_akun (id_akun, kode, nama, kelompok, saldo_normal, is_aktif) VALUES (?, ?, ?, ?, ?, 1);";

/// Menanam bagan akun bawaan ke SQLite lokal. Barisnya TIDAK masuk outbox:
/// cloud menanam seed yang sama, jadi mendorongnya hanya akan menimpa nama
/// akun yang sudah diganti perusahaan dengan nama bawaan.
pub fn seed_akun_bawaan(connection: &Connection) -> rusqlite::Result<()> {
    let mut statement = connection.prepare(SEED_AKUN_SQL)?;
    for akun in akun_bawaan() {
        statement.execute(params![
            akun.id_akun,
            akun.kode,
            akun.nama,
            akun.kelompok,
            akun.saldo_normal
        ])?;
    }
    Ok(())
}

// ── Aturan murni ────────────────────────────────────────────────────────────

fn panjang(value: &str) -> usize {
    value.chars().count()
}

/// Cermin `formatRupiah`. Tanpa locale: hasilnya harus sama byte per byte dengan TS.
pub fn format_rupiah(nilai: i64) -> String {
    let digit = nilai.unsigned_abs().to_string();
    let mut kelompok: Vec<&str> = Vec::new();
    let mut akhir = digit.len();
    while akhir > 0 {
        let awal = akhir.saturating_sub(3);
        kelompok.insert(0, &digit[awal..akhir]);
        akhir = awal;
    }
    let tanda = if nilai < 0 { "-" } else { "" };
    format!("{tanda}Rp{}", kelompok.join("."))
}

/// Cermin `saldoNormalBawaan`: Aset dan Beban bertambah di debit. Di Rust
/// hanya dipakai tes untuk memeriksa berkas seed; UI memakai versi TS.
#[cfg(test)]
pub fn saldo_normal_bawaan(kelompok: &str) -> &'static str {
    if kelompok == "Aset" || kelompok == "Beban" {
        "Debit"
    } else {
        "Kredit"
    }
}

/// Cermin `formatNomorJurnal`.
pub fn format_nomor_jurnal(tahun: &str, seri: &str, nomor_urut: i64) -> String {
    format!("JU/{tahun}/{seri}/{nomor_urut:04}")
}

/// Cermin `idPembalik`.
pub fn id_pembalik(id: &str) -> String {
    format!("batal-{id}")
}

/// Cermin `saldoAkun`: saldo bertanda menurut saldo normalnya.
pub fn saldo_akun(saldo_normal: &str, debit: i64, kredit: i64) -> i64 {
    if saldo_normal == "Debit" {
        debit - kredit
    } else {
        kredit - debit
    }
}

/// Cermin `saldoBerjalan`.
pub fn saldo_berjalan(saldo_normal: &str, saldo_awal: i64, baris: &[(i64, i64)]) -> Vec<i64> {
    let mut saldo = saldo_awal;
    baris
        .iter()
        .map(|(debit, kredit)| {
            saldo += saldo_akun(saldo_normal, *debit, *kredit);
            saldo
        })
        .collect()
}

/// Cermin `kolomNeracaSaldo`: `(debit, kredit)`.
pub fn kolom_neraca_saldo(total_debit: i64, total_kredit: i64) -> (i64, i64) {
    let bersih = total_debit - total_kredit;
    if bersih >= 0 {
        (bersih, 0)
    } else {
        (0, -bersih)
    }
}

/// Seri nomor jurnal bawaan perangkat: huruf platform + 4 hex pertama kode
/// perangkat (`W-AB12-...` → `WAB12`). Hanya Rust: Web memakai seri `WEB`.
pub fn seri_perangkat(device_code: &str) -> String {
    device_code
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .take(5)
        .collect::<String>()
        .to_ascii_uppercase()
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AkunDraft {
    #[serde(default)]
    pub id_akun: Option<String>,
    #[serde(default)]
    pub kode: String,
    #[serde(default)]
    pub nama: String,
    #[serde(default)]
    pub kelompok: String,
    #[serde(default)]
    pub saldo_normal: String,
    #[serde(default = "bawaan_aktif")]
    pub is_aktif: bool,
}

fn bawaan_aktif() -> bool {
    true
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AkunValid {
    pub kode: String,
    pub nama: String,
    pub kelompok: String,
    pub saldo_normal: String,
    pub is_aktif: bool,
}

/// Cermin `validateAkun`.
pub fn validate_akun(draft: &AkunDraft) -> Result<AkunValid, String> {
    let kode = draft.kode.trim();
    if kode.is_empty() {
        return Err("Kode akun wajib diisi.".into());
    }
    if panjang(kode) > MAKS_KODE_AKUN {
        return Err("Kode akun maksimal 20 karakter.".into());
    }
    let nama = draft.nama.trim();
    if nama.is_empty() {
        return Err("Nama akun wajib diisi.".into());
    }
    if panjang(nama) > MAKS_NAMA_AKUN {
        return Err("Nama akun maksimal 80 karakter.".into());
    }
    if !KELOMPOK_AKUN.contains(&draft.kelompok.as_str()) {
        return Err("Kelompok akun tidak dikenal.".into());
    }
    if !SALDO_NORMAL.contains(&draft.saldo_normal.as_str()) {
        return Err("Saldo normal harus Debit atau Kredit.".into());
    }
    Ok(AkunValid {
        kode: kode.to_owned(),
        nama: nama.to_owned(),
        kelompok: draft.kelompok.clone(),
        saldo_normal: draft.saldo_normal.clone(),
        is_aktif: draft.is_aktif,
    })
}

pub struct AkunLama {
    pub kelompok: String,
    pub saldo_normal: String,
    pub sistem: bool,
    pub punya_jurnal: bool,
}

/// Cermin `aturanUbahAkun`. Akun tidak pernah dihapus, hanya dinonaktifkan.
pub fn aturan_ubah_akun(lama: &AkunLama, baru: &AkunValid) -> Result<(), String> {
    let struktur_berubah = lama.kelompok != baru.kelompok || lama.saldo_normal != baru.saldo_normal;
    if lama.sistem {
        if struktur_berubah {
            return Err("Kelompok dan saldo normal akun sistem tidak bisa diubah.".into());
        }
        if !baru.is_aktif {
            return Err("Akun sistem tidak bisa dinonaktifkan.".into());
        }
    }
    if lama.punya_jurnal && struktur_berubah {
        return Err(
            "Kelompok dan saldo normal tidak bisa diubah setelah akun dipakai jurnal.".into(),
        );
    }
    Ok(())
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BarisDraft {
    #[serde(default)]
    pub id_akun: String,
    #[serde(default)]
    pub debit: Value,
    #[serde(default)]
    pub kredit: Value,
    #[serde(default)]
    pub keterangan: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct JurnalDraft {
    #[serde(default)]
    pub tanggal: String,
    #[serde(default)]
    pub keterangan: String,
    #[serde(default)]
    pub baris: Vec<BarisDraft>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BarisValid {
    pub id_akun: String,
    pub debit: i64,
    pub kredit: i64,
    pub keterangan: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JurnalValid {
    pub tanggal: String,
    pub keterangan: String,
    pub baris: Vec<BarisValid>,
    pub total: i64,
}

/// Nominal kosong = 0. Pecahan, negatif, atau bukan angka = tidak sah.
fn nominal(value: &Value) -> Option<i64> {
    match value {
        Value::Null => Some(0),
        Value::Number(number) => number.as_i64().filter(|nilai| *nilai >= 0),
        _ => None,
    }
}

fn bersih(value: &Option<String>) -> Option<String> {
    value
        .as_deref()
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_owned)
}

/// Cermin `validateJurnal`. Keberadaan dan status aktif akun diperiksa
/// pemanggil, karena butuh database.
pub fn validate_jurnal(draft: &JurnalDraft) -> Result<JurnalValid, String> {
    if !super::inventory::is_valid_date(&draft.tanggal) {
        return Err("Tanggal jurnal tidak valid.".into());
    }
    let keterangan = draft.keterangan.trim();
    if keterangan.is_empty() {
        return Err("Keterangan jurnal wajib diisi.".into());
    }
    if panjang(keterangan) > MAKS_KETERANGAN {
        return Err("Keterangan jurnal maksimal 200 karakter.".into());
    }
    if draft.baris.len() < 2 {
        return Err("Jurnal minimal dua baris.".into());
    }
    if draft.baris.len() > MAKS_BARIS_JURNAL {
        return Err("Jurnal maksimal 100 baris.".into());
    }

    let mut baris = Vec::with_capacity(draft.baris.len());
    let mut total_debit = 0i64;
    let mut total_kredit = 0i64;
    for (indeks, item) in draft.baris.iter().enumerate() {
        let n = indeks + 1;
        let id_akun = item.id_akun.trim();
        if id_akun.is_empty() {
            return Err(format!("Baris {n}: akun wajib dipilih."));
        }
        let (Some(debit), Some(kredit)) = (nominal(&item.debit), nominal(&item.kredit)) else {
            return Err(format!(
                "Baris {n}: nominal harus rupiah bulat dan tidak negatif."
            ));
        };
        if (debit > 0) == (kredit > 0) {
            return Err(format!(
                "Baris {n}: isi debit atau kredit, salah satu saja."
            ));
        }
        if debit > MAKS_NOMINAL || kredit > MAKS_NOMINAL {
            return Err(format!(
                "Baris {n}: nominal maksimal {}.",
                format_rupiah(MAKS_NOMINAL)
            ));
        }
        let keterangan_baris = bersih(&item.keterangan);
        if keterangan_baris
            .as_deref()
            .is_some_and(|text| panjang(text) > MAKS_KETERANGAN)
        {
            return Err(format!("Baris {n}: keterangan maksimal 200 karakter."));
        }
        total_debit += debit;
        total_kredit += kredit;
        baris.push(BarisValid {
            id_akun: id_akun.to_owned(),
            debit,
            kredit,
            keterangan: keterangan_baris,
        });
    }
    if total_debit != total_kredit {
        return Err(format!(
            "Total debit {} tidak sama dengan total kredit {}.",
            format_rupiah(total_debit),
            format_rupiah(total_kredit)
        ));
    }
    Ok(JurnalValid {
        tanggal: draft.tanggal.clone(),
        keterangan: keterangan.to_owned(),
        baris,
        total: total_debit,
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BarisTulis {
    pub id_baris: String,
    pub id_akun: String,
    pub debit: i64,
    pub kredit: i64,
    pub keterangan: Option<String>,
    pub urutan: i64,
}

pub struct JurnalAsal {
    pub id_jurnal: String,
    pub nomor: String,
    pub sumber: String,
    pub baris: Vec<BarisTulis>,
}

#[derive(Debug, PartialEq, Eq)]
pub struct Pembalik {
    pub id_jurnal: String,
    pub keterangan: String,
    pub baris: Vec<BarisTulis>,
}

/// Cermin `susunPembalik`. Apakah jurnal ini SUDAH dibatalkan diperiksa pemanggil.
pub fn susun_pembalik(asal: &JurnalAsal, alasan: &str) -> Result<Pembalik, String> {
    if asal.sumber == "Pembatalan" {
        return Err("Jurnal pembalik tidak bisa dibatalkan lagi.".into());
    }
    if asal.sumber != "Manual" {
        return Err(format!(
            "Jurnal dari modul {} dibatalkan dari modulnya.",
            asal.sumber
        ));
    }
    let alasan = alasan.trim();
    if alasan.is_empty() {
        return Err("Alasan pembatalan wajib diisi.".into());
    }
    if panjang(alasan) > MAKS_ALASAN_BATAL {
        return Err("Alasan pembatalan maksimal 150 karakter.".into());
    }
    Ok(Pembalik {
        id_jurnal: id_pembalik(&asal.id_jurnal),
        keterangan: format!("Pembatalan {}: {alasan}", asal.nomor),
        baris: asal
            .baris
            .iter()
            .map(|item| BarisTulis {
                id_baris: id_pembalik(&item.id_baris),
                id_akun: item.id_akun.clone(),
                debit: item.kredit,
                kredit: item.debit,
                keterangan: item.keterangan.clone(),
                urutan: item.urutan,
            })
            .collect(),
    })
}

// ── Penulisan lokal ─────────────────────────────────────────────────────────

fn invalid(message: impl Into<String>) -> CommandError {
    CommandError::new("VALIDATION_ERROR", message)
}

fn new_id(prefix: &str) -> String {
    let mut bytes = [0u8; 16];
    rand_core::RngCore::fill_bytes(&mut rand_core::OsRng, &mut bytes);
    format!("{prefix}{}", hex::encode(bytes))
}

fn db_error(_: rusqlite::Error) -> CommandError {
    CommandError::internal()
}

fn akun_json(connection: &Connection, id_akun: &str) -> Result<Option<Value>, CommandError> {
    connection
        .query_row(
            "SELECT id_akun, kode, nama, kelompok, saldo_normal, is_aktif, created_at, updated_at
             FROM keu_akun WHERE id_akun = ?;",
            params![id_akun],
            |row| {
                Ok(json!({
                    "id_akun": row.get::<_, String>(0)?,
                    "kode": row.get::<_, String>(1)?,
                    "nama": row.get::<_, String>(2)?,
                    "kelompok": row.get::<_, String>(3)?,
                    "saldo_normal": row.get::<_, String>(4)?,
                    "is_aktif": row.get::<_, i64>(5)?,
                    "created_at": row.get::<_, String>(6)?,
                    "updated_at": row.get::<_, String>(7)?,
                }))
            },
        )
        .optional()
        .map_err(db_error)
}

pub fn list_accounts(state: &DesktopState) -> Result<Value, CommandError> {
    let connection = storage::database(&state.data_dir)?;
    let mut statement = connection
        .prepare(
            "SELECT a.id_akun, a.kode, a.nama, a.kelompok, a.saldo_normal, a.is_aktif,
                    EXISTS(SELECT 1 FROM keu_jurnal_baris b WHERE b.id_akun = a.id_akun) AS punya_jurnal
             FROM keu_akun a
             ORDER BY a.kode, a.id_akun
             LIMIT 1000;",
        )
        .map_err(db_error)?;
    let items = statement
        .query_map([], |row| {
            let id: String = row.get(0)?;
            Ok(json!({
                "sistem": is_akun_sistem(&id),
                "id_akun": id,
                "kode": row.get::<_, String>(1)?,
                "nama": row.get::<_, String>(2)?,
                "kelompok": row.get::<_, String>(3)?,
                "saldo_normal": row.get::<_, String>(4)?,
                "is_aktif": row.get::<_, i64>(5)? == 1,
                "punya_jurnal": row.get::<_, i64>(6)? == 1,
            }))
        })
        .map_err(db_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error)?;
    Ok(json!({ "items": items }))
}

pub fn save_account(state: &DesktopState, draft: Value) -> Result<Value, CommandError> {
    let draft: AkunDraft =
        serde_json::from_value(draft).map_err(|_| invalid("Data akun tidak valid."))?;
    let valid = validate_akun(&draft).map_err(invalid)?;
    let client_id = sync::ensure_client_id(state)?;

    let mut connection = storage::database(&state.data_dir)?;
    let transaction = connection.transaction().map_err(db_error)?;

    let id_akun = match bersih(&draft.id_akun) {
        Some(id) => {
            let lama: (String, String) = transaction
                .query_row(
                    "SELECT kelompok, saldo_normal FROM keu_akun WHERE id_akun = ?;",
                    params![id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()
                .map_err(db_error)?
                .ok_or_else(|| invalid("Akun tidak ditemukan."))?;
            let punya_jurnal: bool = transaction
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM keu_jurnal_baris WHERE id_akun = ?);",
                    params![id],
                    |row| row.get(0),
                )
                .map_err(db_error)?;
            aturan_ubah_akun(
                &AkunLama {
                    kelompok: lama.0,
                    saldo_normal: lama.1,
                    sistem: is_akun_sistem(&id),
                    punya_jurnal,
                },
                &valid,
            )
            .map_err(invalid)?;
            id
        }
        None => new_id("akun-"),
    };

    let kode_dipakai: bool = transaction
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM keu_akun WHERE LOWER(kode) = LOWER(?) AND id_akun <> ?);",
            params![valid.kode, id_akun],
            |row| row.get(0),
        )
        .map_err(db_error)?;
    if kode_dipakai {
        return Err(invalid("Kode akun sudah dipakai akun lain."));
    }

    transaction
        .execute(
            "INSERT INTO keu_akun (
                id_akun, kode, nama, kelompok, saldo_normal, is_aktif, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
             ON CONFLICT(id_akun) DO UPDATE SET
                kode = excluded.kode,
                nama = excluded.nama,
                kelompok = excluded.kelompok,
                saldo_normal = excluded.saldo_normal,
                is_aktif = excluded.is_aktif,
                updated_at = excluded.updated_at;",
            params![
                id_akun,
                valid.kode,
                valid.nama,
                valid.kelompok,
                valid.saldo_normal,
                valid.is_aktif as i64
            ],
        )
        .map_err(db_error)?;

    let payload = akun_json(&transaction, &id_akun)?.ok_or_else(CommandError::internal)?;
    sync::enqueue(
        &transaction,
        &client_id,
        "accounting-account",
        "save",
        &id_akun,
        &payload,
        None,
    )?;
    transaction.commit().map_err(db_error)?;
    Ok(json!({ "sukses": true, "id_akun": id_akun }))
}

pub struct HeaderTulis {
    pub id_jurnal: String,
    pub tanggal: String,
    pub keterangan: String,
    pub sumber: &'static str,
    pub id_sumber: Option<String>,
    pub id_jurnal_batal: Option<String>,
    pub dibuat_oleh: String,
}

/// Menulis satu jurnal utuh ke SQLite lokal dan mendaftarkan SATU event
/// outbox yang membawa header beserta seluruh barisnya. Cloud menerapkan
/// satu event dalam satu batch atomik, jadi cloud tidak pernah memegang
/// separuh jurnal. Dipakai jurnal manual, pembalik, dan jurnal otomatis
/// modul lain (K2/K3) di dalam transaksi sumbernya.
pub fn tulis_jurnal_tx(
    transaction: &Transaction<'_>,
    state: &DesktopState,
    client_id: &str,
    header: HeaderTulis,
    baris: &[BarisTulis],
) -> Result<String, CommandError> {
    // Idempoten untuk id deterministik (`pay-<run>`, `jrn-cair-<pinjaman>`):
    // jurnal yang sama mungkin sudah tertarik dari perangkat lain yang lebih
    // dulu mencatatnya. Menulis ulang akan gagal di PK dan mendaftarkan event
    // kedua untuk jurnal yang sudah ada.
    if let Some(nomor) = transaction
        .query_row(
            "SELECT nomor FROM keu_jurnal WHERE id_jurnal = ?;",
            params![header.id_jurnal],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(db_error)?
    {
        return Ok(nomor);
    }
    // Perangkat yang sudah tahu periodenya ditutup tidak mencatat ke sana.
    super::tutup_buku::assert_periode_terbuka(transaction, &header.tanggal)?;
    let seri = seri_perangkat(&license::current_device_code(state)?);
    let tahun: String = header.tanggal.chars().take(4).collect();
    let nomor_urut: i64 = transaction
        .query_row(
            "SELECT COALESCE(MAX(nomor_urut), 0) + 1 FROM keu_jurnal
             WHERE seri = ? AND substr(tanggal, 1, 4) = ?
             -- batas: agregat, selalu satu baris
             ;",
            params![seri, tahun],
            |row| row.get(0),
        )
        .map_err(db_error)?;
    let nomor = format_nomor_jurnal(&tahun, &seri, nomor_urut);

    transaction
        .execute(
            "INSERT INTO keu_jurnal (
                id_jurnal, tanggal, seri, nomor_urut, nomor, keterangan, sumber,
                id_sumber, id_jurnal_batal, dibuat_oleh, created_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'));",
            params![
                header.id_jurnal,
                header.tanggal,
                seri,
                nomor_urut,
                nomor,
                header.keterangan,
                header.sumber,
                header.id_sumber,
                header.id_jurnal_batal,
                header.dibuat_oleh
            ],
        )
        .map_err(db_error)?;
    for item in baris {
        transaction
            .execute(
                "INSERT INTO keu_jurnal_baris (
                    id_baris, id_jurnal, id_akun, debit, kredit, keterangan, urutan
                 ) VALUES (?, ?, ?, ?, ?, ?, ?);",
                params![
                    item.id_baris,
                    header.id_jurnal,
                    item.id_akun,
                    item.debit,
                    item.kredit,
                    item.keterangan,
                    item.urutan
                ],
            )
            .map_err(db_error)?;
    }

    let payload = jurnal_payload(transaction, &header.id_jurnal)?;
    sync::enqueue(
        transaction,
        client_id,
        "accounting-journal",
        "post",
        &header.id_jurnal,
        &payload,
        None,
    )?;
    Ok(nomor)
}

fn jurnal_payload(connection: &Connection, id_jurnal: &str) -> Result<Value, CommandError> {
    let jurnal = connection
        .query_row(
            "SELECT id_jurnal, tanggal, seri, nomor_urut, nomor, keterangan, sumber,
                    id_sumber, id_jurnal_batal, dibuat_oleh, created_at
             FROM keu_jurnal WHERE id_jurnal = ?;",
            params![id_jurnal],
            |row| {
                Ok(json!({
                    "id_jurnal": row.get::<_, String>(0)?,
                    "tanggal": row.get::<_, String>(1)?,
                    "seri": row.get::<_, String>(2)?,
                    "nomor_urut": row.get::<_, i64>(3)?,
                    "nomor": row.get::<_, String>(4)?,
                    "keterangan": row.get::<_, String>(5)?,
                    "sumber": row.get::<_, String>(6)?,
                    "id_sumber": row.get::<_, Option<String>>(7)?,
                    "id_jurnal_batal": row.get::<_, Option<String>>(8)?,
                    "dibuat_oleh": row.get::<_, String>(9)?,
                    "created_at": row.get::<_, String>(10)?,
                }))
            },
        )
        .map_err(db_error)?;
    let mut statement = connection
        .prepare(
            "SELECT id_baris, id_akun, debit, kredit, keterangan, urutan
             FROM keu_jurnal_baris WHERE id_jurnal = ?
             ORDER BY urutan, id_baris
             LIMIT 100;",
        )
        .map_err(db_error)?;
    let baris = statement
        .query_map(params![id_jurnal], |row| {
            Ok(json!({
                "id_baris": row.get::<_, String>(0)?,
                "id_akun": row.get::<_, String>(1)?,
                "debit": row.get::<_, i64>(2)?,
                "kredit": row.get::<_, i64>(3)?,
                "keterangan": row.get::<_, Option<String>>(4)?,
                "urutan": row.get::<_, i64>(5)?,
            }))
        })
        .map_err(db_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error)?;
    Ok(json!({ "jurnal": jurnal, "baris": baris }))
}

/// Setiap akun yang dipakai harus ada dan aktif. Pesan menyebut baris
/// pertama yang memakainya, sama dengan `assertAkunAktif` di Web.
fn assert_akun_aktif(connection: &Connection, baris: &[BarisValid]) -> Result<(), CommandError> {
    let mut diperiksa = HashSet::new();
    for (indeks, item) in baris.iter().enumerate() {
        if !diperiksa.insert(item.id_akun.as_str()) {
            continue;
        }
        let aktif: Option<i64> = connection
            .query_row(
                "SELECT is_aktif FROM keu_akun WHERE id_akun = ?;",
                params![item.id_akun],
                |row| row.get(0),
            )
            .optional()
            .map_err(db_error)?;
        if aktif != Some(1) {
            return Err(invalid(format!(
                "Baris {}: akun tidak ditemukan atau nonaktif.",
                indeks + 1
            )));
        }
    }
    Ok(())
}

pub fn post_journal(
    state: &DesktopState,
    dibuat_oleh: &str,
    draft: Value,
) -> Result<Value, CommandError> {
    let draft: JurnalDraft =
        serde_json::from_value(draft).map_err(|_| invalid("Data jurnal tidak valid."))?;
    let valid = validate_jurnal(&draft).map_err(invalid)?;
    let client_id = sync::ensure_client_id(state)?;

    let mut connection = storage::database(&state.data_dir)?;
    let transaction = connection.transaction().map_err(db_error)?;
    assert_akun_aktif(&transaction, &valid.baris)?;

    let id_jurnal = new_id("jrn-");
    let baris: Vec<BarisTulis> = valid
        .baris
        .iter()
        .enumerate()
        .map(|(indeks, item)| BarisTulis {
            id_baris: new_id("jb-"),
            id_akun: item.id_akun.clone(),
            debit: item.debit,
            kredit: item.kredit,
            keterangan: item.keterangan.clone(),
            urutan: indeks as i64 + 1,
        })
        .collect();
    let nomor = tulis_jurnal_tx(
        &transaction,
        state,
        &client_id,
        HeaderTulis {
            id_jurnal: id_jurnal.clone(),
            tanggal: valid.tanggal,
            keterangan: valid.keterangan,
            sumber: "Manual",
            id_sumber: None,
            id_jurnal_batal: None,
            dibuat_oleh: dibuat_oleh.to_owned(),
        },
        &baris,
    )?;
    transaction.commit().map_err(db_error)?;
    Ok(json!({ "sukses": true, "id_jurnal": id_jurnal, "nomor": nomor }))
}

fn load_baris(connection: &Connection, id_jurnal: &str) -> Result<Vec<BarisTulis>, CommandError> {
    let mut statement = connection
        .prepare(
            "SELECT id_baris, id_akun, debit, kredit, keterangan, urutan
             FROM keu_jurnal_baris WHERE id_jurnal = ?
             ORDER BY urutan, id_baris
             LIMIT 100;",
        )
        .map_err(db_error)?;
    let rows = statement
        .query_map(params![id_jurnal], |row| {
            Ok(BarisTulis {
                id_baris: row.get(0)?,
                id_akun: row.get(1)?,
                debit: row.get(2)?,
                kredit: row.get(3)?,
                keterangan: row.get(4)?,
                urutan: row.get(5)?,
            })
        })
        .map_err(db_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error)?;
    Ok(rows)
}

/// Jurnal pembalik untuk jurnal MODUL (kasbon dan payroll), tanpa
/// pemeriksaan `sumber` milik `susun_pembalik`: modul sumbernya yang sudah
/// memutuskan pembatalan itu sah. Bertanggal hari pembatalan (WIB). Bila
/// pembaliknya sudah ada, tidak menulis apa pun.
pub fn balik_jurnal_tx(
    transaction: &Transaction<'_>,
    state: &DesktopState,
    client_id: &str,
    id_jurnal: &str,
    keterangan: String,
    dibuat_oleh: &str,
) -> Result<(), CommandError> {
    let ada: bool = transaction
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM keu_jurnal WHERE id_jurnal = ?);",
            params![id_jurnal],
            |row| row.get(0),
        )
        .map_err(db_error)?;
    if !ada {
        return Ok(());
    }
    let baris: Vec<BarisTulis> = load_baris(transaction, id_jurnal)?
        .into_iter()
        .map(|item| BarisTulis {
            id_baris: id_pembalik(&item.id_baris),
            debit: item.kredit,
            kredit: item.debit,
            ..item
        })
        .collect();
    let hari_ini: String = transaction
        .query_row("SELECT date('now', '+7 hours');", [], |row| row.get(0))
        .map_err(db_error)?;
    tulis_jurnal_tx(
        transaction,
        state,
        client_id,
        HeaderTulis {
            id_jurnal: id_pembalik(id_jurnal),
            tanggal: hari_ini,
            keterangan,
            sumber: "Pembatalan",
            id_sumber: None,
            id_jurnal_batal: Some(id_jurnal.to_owned()),
            dibuat_oleh: dibuat_oleh.to_owned(),
        },
        &baris,
    )?;
    Ok(())
}

/// Akun pembayaran (Kas, Bank, atau akun kas lain buatan perusahaan) wajib akun
/// Aset yang aktif. Cermin `assertAkunBayar` di `services/accounting.ts`.
pub fn assert_akun_bayar(connection: &Connection, id_akun: &str) -> Result<(), CommandError> {
    let sah: bool = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM keu_akun WHERE id_akun = ? AND kelompok = 'Aset' AND is_aktif = 1);",
            params![id_akun],
            |row| row.get(0),
        )
        .map_err(db_error)?;
    if !sah {
        return Err(invalid("Akun pembayaran harus akun aset yang aktif."));
    }
    Ok(())
}

pub fn reverse_journal(
    state: &DesktopState,
    dibuat_oleh: &str,
    id_jurnal: &str,
    alasan: &str,
) -> Result<Value, CommandError> {
    let client_id = sync::ensure_client_id(state)?;
    let mut connection = storage::database(&state.data_dir)?;
    let transaction = connection.transaction().map_err(db_error)?;

    let (nomor, sumber): (String, String) = transaction
        .query_row(
            "SELECT nomor, sumber FROM keu_jurnal WHERE id_jurnal = ?;",
            params![id_jurnal],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(db_error)?
        .ok_or_else(|| invalid("Jurnal tidak ditemukan."))?;
    let sudah: bool = transaction
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM keu_jurnal WHERE id_jurnal = ?);",
            params![id_pembalik(id_jurnal)],
            |row| row.get(0),
        )
        .map_err(db_error)?;
    if sudah {
        return Err(invalid("Jurnal ini sudah dibatalkan."));
    }

    let asal = JurnalAsal {
        id_jurnal: id_jurnal.to_owned(),
        nomor,
        sumber,
        baris: load_baris(&transaction, id_jurnal)?,
    };
    let pembalik = susun_pembalik(&asal, alasan).map_err(invalid)?;
    // Pembalik bertanggal hari pembatalan (WIB), bukan tanggal jurnal asal:
    // laporan periode yang sudah lewat tidak ikut berubah karenanya.
    let hari_ini: String = transaction
        .query_row("SELECT date('now', '+7 hours');", [], |row| row.get(0))
        .map_err(db_error)?;
    let nomor_baru = tulis_jurnal_tx(
        &transaction,
        state,
        &client_id,
        HeaderTulis {
            id_jurnal: pembalik.id_jurnal.clone(),
            tanggal: hari_ini,
            keterangan: pembalik.keterangan,
            sumber: "Pembatalan",
            id_sumber: None,
            id_jurnal_batal: Some(id_jurnal.to_owned()),
            dibuat_oleh: dibuat_oleh.to_owned(),
        },
        &pembalik.baris,
    )?;
    transaction.commit().map_err(db_error)?;
    Ok(json!({ "sukses": true, "id_jurnal": pembalik.id_jurnal, "nomor": nomor_baru }))
}

// ── Pembacaan ───────────────────────────────────────────────────────────────

fn rentang(dari: &str, sampai: &str) -> Result<(), CommandError> {
    let valid = super::inventory::is_valid_date(dari) && super::inventory::is_valid_date(sampai);
    if !valid || dari > sampai {
        return Err(invalid("Rentang tanggal tidak valid."));
    }
    Ok(())
}

pub fn list_journals(
    state: &DesktopState,
    dari: &str,
    sampai: &str,
    sumber: Option<&str>,
) -> Result<Value, CommandError> {
    rentang(dari, sampai)?;
    let sumber = sumber.map(str::trim).filter(|value| !value.is_empty());
    if sumber.is_some_and(|value| !SUMBER_JURNAL.contains(&value)) {
        return Err(invalid("Sumber jurnal tidak dikenal."));
    }
    let sql = journal_list_query(sumber.is_some());
    let mut args = vec![dari, sampai];
    args.extend(sumber);

    let connection = storage::database(&state.data_dir)?;
    let mut statement = connection.prepare(&sql).map_err(db_error)?;
    let items = statement
        .query_map(rusqlite::params_from_iter(args.iter()), |row| {
            Ok(json!({
                "id_jurnal": row.get::<_, String>(0)?,
                "tanggal": row.get::<_, String>(1)?,
                "nomor": row.get::<_, String>(2)?,
                "keterangan": row.get::<_, String>(3)?,
                "sumber": row.get::<_, String>(4)?,
                "id_jurnal_batal": row.get::<_, Option<String>>(5)?,
                "dibuat_oleh": row.get::<_, String>(6)?,
                "created_at": row.get::<_, String>(7)?,
                "total": row.get::<_, i64>(8)?,
                "dibatalkan": row.get::<_, i64>(9)? == 1,
                "nomor_ganda": row.get::<_, i64>(10)? == 1,
            }))
        })
        .map_err(db_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error)?;
    Ok(json!({ "items": items }))
}

/// SQL daftar jurnal. Cermin `listJournals` di `services/accounting.ts`.
fn journal_list_query(dengan_sumber: bool) -> String {
    let mut sql = String::from(
        "SELECT j.id_jurnal, j.tanggal, j.nomor, j.keterangan, j.sumber, j.id_jurnal_batal,
                j.dibuat_oleh, j.created_at,
                COALESCE((SELECT SUM(b.debit) FROM keu_jurnal_baris b WHERE b.id_jurnal = j.id_jurnal), 0) AS total,
                EXISTS(SELECT 1 FROM keu_jurnal x WHERE x.id_jurnal = 'batal-' || j.id_jurnal) AS dibatalkan,
                (SELECT COUNT(*) FROM keu_jurnal y WHERE y.nomor = j.nomor) > 1 AS nomor_ganda
         FROM keu_jurnal j
         WHERE j.tanggal >= ? AND j.tanggal <= ?",
    );
    if dengan_sumber {
        sql.push_str(" AND j.sumber = ?");
    }
    // `LIMIT 300` = `BATAS_DAFTAR_JURNAL` di `validations/accounting.ts`.
    sql.push_str(" ORDER BY j.tanggal DESC, j.created_at DESC, j.id_jurnal DESC LIMIT 300;");
    sql
}

pub fn get_journal(state: &DesktopState, id_jurnal: &str) -> Result<Value, CommandError> {
    let connection = storage::database(&state.data_dir)?;
    let jurnal = connection
        .query_row(
            "SELECT j.id_jurnal, j.tanggal, j.nomor, j.keterangan, j.sumber, j.id_sumber,
                    j.id_jurnal_batal, j.dibuat_oleh, j.created_at,
                    (SELECT x.nomor FROM keu_jurnal x WHERE x.id_jurnal = 'batal-' || j.id_jurnal) AS nomor_pembalik
             FROM keu_jurnal j WHERE j.id_jurnal = ?;",
            params![id_jurnal],
            |row| {
                Ok(json!({
                    "id_jurnal": row.get::<_, String>(0)?,
                    "tanggal": row.get::<_, String>(1)?,
                    "nomor": row.get::<_, String>(2)?,
                    "keterangan": row.get::<_, String>(3)?,
                    "sumber": row.get::<_, String>(4)?,
                    "id_sumber": row.get::<_, Option<String>>(5)?,
                    "id_jurnal_batal": row.get::<_, Option<String>>(6)?,
                    "dibuat_oleh": row.get::<_, String>(7)?,
                    "created_at": row.get::<_, String>(8)?,
                    "nomor_pembalik": row.get::<_, Option<String>>(9)?,
                }))
            },
        )
        .optional()
        .map_err(db_error)?
        .ok_or_else(|| CommandError::new("NOT_FOUND", "Jurnal tidak ditemukan."))?;
    let mut statement = connection
        .prepare(
            "SELECT b.id_baris, b.id_akun, COALESCE(a.kode, '') AS kode_akun,
                    COALESCE(a.nama, b.id_akun) AS nama_akun, b.debit, b.kredit, b.keterangan, b.urutan
             FROM keu_jurnal_baris b
             LEFT JOIN keu_akun a ON a.id_akun = b.id_akun
             WHERE b.id_jurnal = ?
             ORDER BY b.urutan, b.id_baris
             LIMIT 100;",
        )
        .map_err(db_error)?;
    let baris = statement
        .query_map(params![id_jurnal], |row| {
            Ok(json!({
                "id_baris": row.get::<_, String>(0)?,
                "id_akun": row.get::<_, String>(1)?,
                "kode_akun": row.get::<_, String>(2)?,
                "nama_akun": row.get::<_, String>(3)?,
                "debit": row.get::<_, i64>(4)?,
                "kredit": row.get::<_, i64>(5)?,
                "keterangan": row.get::<_, Option<String>>(6)?,
                "urutan": row.get::<_, i64>(7)?,
            }))
        })
        .map_err(db_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error)?;
    Ok(json!({ "jurnal": jurnal, "baris": baris }))
}

/// Buku besar satu akun. Saldo awal dan total periode dihitung dengan
/// agregat terpisah, sehingga saldo akhir tetap benar meski daftar barisnya
/// terpotong di `MAKS_BARIS_BUKU_BESAR`.
pub fn ledger(
    state: &DesktopState,
    id_akun: &str,
    dari: &str,
    sampai: &str,
) -> Result<Value, CommandError> {
    rentang(dari, sampai)?;
    let connection = storage::database(&state.data_dir)?;
    let akun = akun_json(&connection, id_akun)?
        .ok_or_else(|| CommandError::new("NOT_FOUND", "Akun tidak ditemukan."))?;
    let saldo_normal = akun["saldo_normal"].as_str().unwrap_or("Debit").to_owned();

    let (awal_debit, awal_kredit): (i64, i64) = connection
        .query_row(
            "SELECT COALESCE(SUM(b.debit), 0), COALESCE(SUM(b.kredit), 0)
             FROM keu_jurnal_baris b
             JOIN keu_jurnal j ON j.id_jurnal = b.id_jurnal
             WHERE b.id_akun = ? AND j.tanggal < ?
             -- batas: agregat, selalu satu baris
             ;",
            params![id_akun, dari],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(db_error)?;
    let (total_debit, total_kredit, jumlah): (i64, i64, i64) = connection
        .query_row(
            "SELECT COALESCE(SUM(b.debit), 0), COALESCE(SUM(b.kredit), 0), COUNT(*)
             FROM keu_jurnal_baris b
             JOIN keu_jurnal j ON j.id_jurnal = b.id_jurnal
             WHERE b.id_akun = ? AND j.tanggal >= ? AND j.tanggal <= ?
             -- batas: agregat, selalu satu baris
             ;",
            params![id_akun, dari, sampai],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .map_err(db_error)?;

    let mut statement = connection
        .prepare(
            "SELECT j.id_jurnal, j.tanggal, j.nomor, j.keterangan, j.sumber,
                    b.keterangan, b.debit, b.kredit
             FROM keu_jurnal_baris b
             JOIN keu_jurnal j ON j.id_jurnal = b.id_jurnal
             WHERE b.id_akun = ? AND j.tanggal >= ? AND j.tanggal <= ?
             ORDER BY j.tanggal, j.created_at, j.id_jurnal, b.urutan
             LIMIT 1000;",
        )
        .map_err(db_error)?;
    let rows = statement
        .query_map(params![id_akun, dari, sampai], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, Option<String>>(5)?,
                row.get::<_, i64>(6)?,
                row.get::<_, i64>(7)?,
            ))
        })
        .map_err(db_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error)?;

    let saldo_awal = saldo_akun(&saldo_normal, awal_debit, awal_kredit);
    let mutasi: Vec<(i64, i64)> = rows.iter().map(|row| (row.6, row.7)).collect();
    let saldo = saldo_berjalan(&saldo_normal, saldo_awal, &mutasi);
    let baris: Vec<Value> = rows
        .into_iter()
        .zip(saldo)
        .map(|(row, saldo)| {
            json!({
                "id_jurnal": row.0,
                "tanggal": row.1,
                "nomor": row.2,
                "keterangan": row.5.unwrap_or(row.3),
                "sumber": row.4,
                "debit": row.6,
                "kredit": row.7,
                "saldo": saldo,
            })
        })
        .collect();

    Ok(json!({
        "akun": akun,
        "saldo_awal": saldo_awal,
        "total_debit": total_debit,
        "total_kredit": total_kredit,
        "saldo_akhir": saldo_awal + saldo_akun(&saldo_normal, total_debit, total_kredit),
        "terpotong": jumlah as usize > MAKS_BARIS_BUKU_BESAR,
        "baris": baris,
    }))
}

/// Neraca saldo per tanggal. Hanya baris yang headernya sudah ada yang
/// dihitung (JOIN), karena snapshot per tabel bisa membawa baris lebih dulu.
pub fn trial_balance(state: &DesktopState, sampai: &str) -> Result<Value, CommandError> {
    if !super::inventory::is_valid_date(sampai) {
        return Err(invalid("Tanggal tidak valid."));
    }
    let connection = storage::database(&state.data_dir)?;
    let mut statement = connection
        .prepare(
            "SELECT a.id_akun, a.kode, a.nama, a.kelompok, a.saldo_normal, a.is_aktif,
                    COALESCE(t.debit, 0), COALESCE(t.kredit, 0)
             FROM keu_akun a
             LEFT JOIN (
                 SELECT b.id_akun, SUM(b.debit) AS debit, SUM(b.kredit) AS kredit
                 FROM keu_jurnal_baris b
                 JOIN keu_jurnal j ON j.id_jurnal = b.id_jurnal
                 WHERE j.tanggal <= ?
                 GROUP BY b.id_akun
             ) t ON t.id_akun = a.id_akun
             ORDER BY a.kode, a.id_akun
             LIMIT 1000;",
        )
        .map_err(db_error)?;
    let mut total_debit = 0i64;
    let mut total_kredit = 0i64;
    let items = statement
        .query_map(params![sampai], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, i64>(5)?,
                row.get::<_, i64>(6)?,
                row.get::<_, i64>(7)?,
            ))
        })
        .map_err(db_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error)?
        .into_iter()
        // Akun nonaktif tanpa mutasi tidak punya apa pun untuk dilaporkan.
        .filter(|row| row.5 == 1 || row.6 != 0 || row.7 != 0)
        .map(|row| {
            let (debit, kredit) = kolom_neraca_saldo(row.6, row.7);
            total_debit += debit;
            total_kredit += kredit;
            json!({
                "id_akun": row.0,
                "kode": row.1,
                "nama": row.2,
                "kelompok": row.3,
                "saldo_normal": row.4,
                "debit": debit,
                "kredit": kredit,
            })
        })
        .collect::<Vec<_>>();
    Ok(json!({
        "items": items,
        "total_debit": total_debit,
        "total_kredit": total_kredit,
    }))
}

// ── Laporan keuangan perusahaan (Fase K4a) ─────────────────────────────────────

/// Satu akun beserta jumlah debit dan kredit dalam rentang laporan.
#[derive(Debug, Clone)]
pub struct AkunSaldo {
    pub id_akun: String,
    pub kode: String,
    pub nama: String,
    pub kelompok: String,
    pub saldo_normal: String,
    pub debit: i64,
    pub kredit: i64,
}

fn baris_laporan(akun: &AkunSaldo) -> Value {
    json!({
        "id_akun": akun.id_akun,
        "kode": akun.kode,
        "nama": akun.nama,
        "saldo": saldo_akun(&akun.saldo_normal, akun.debit, akun.kredit),
    })
}

fn kelompok_laporan(akun: &[AkunSaldo], kelompok: &str) -> (Vec<Value>, i64) {
    let mut total = 0;
    let baris = akun
        .iter()
        .filter(|a| a.kelompok == kelompok)
        .filter(|a| saldo_akun(&a.saldo_normal, a.debit, a.kredit) != 0)
        .map(|a| {
            total += saldo_akun(&a.saldo_normal, a.debit, a.kredit);
            baris_laporan(a)
        })
        .collect();
    (baris, total)
}

/// Cermin `susunPosisiKeuangan`. Tutup buku belum ada, jadi selisih
/// pendapatan dan beban sepanjang masa tampil sebagai "Laba (rugi) bersih
/// berjalan" di ekuitas. Akun bersaldo nol tidak ditampilkan.
pub fn susun_posisi_keuangan(akun: &[AkunSaldo]) -> Value {
    let (aset, total_aset) = kelompok_laporan(akun, "Aset");
    let (kewajiban, total_kewajiban) = kelompok_laporan(akun, "Kewajiban");
    let (ekuitas, total_ekuitas_akun) = kelompok_laporan(akun, "Ekuitas");
    let (_, pendapatan) = kelompok_laporan(akun, "Pendapatan");
    let (_, beban) = kelompok_laporan(akun, "Beban");
    let laba_bersih = pendapatan - beban;
    let total_ekuitas = total_ekuitas_akun + laba_bersih;
    json!({
        "aset": aset,
        "kewajiban": kewajiban,
        "ekuitas": ekuitas,
        "laba_berjalan": laba_bersih,
        "total_aset": total_aset,
        "total_kewajiban": total_kewajiban,
        "total_ekuitas": total_ekuitas,
        "selisih": total_aset - (total_kewajiban + total_ekuitas),
    })
}

/// Cermin `susunAktivitas`: Laporan Laba Rugi satu rentang.
pub fn susun_aktivitas(akun: &[AkunSaldo]) -> Value {
    let (pendapatan, total_pendapatan) = kelompok_laporan(akun, "Pendapatan");
    let (beban, total_beban) = kelompok_laporan(akun, "Beban");
    json!({
        "pendapatan": pendapatan,
        "beban": beban,
        "total_pendapatan": total_pendapatan,
        "total_beban": total_beban,
        "laba_bersih": total_pendapatan - total_beban,
    })
}

/// Cermin `labelSumberKas`.
pub fn label_sumber_kas(sumber: &str) -> &'static str {
    match sumber {
        "Payroll" => "Pembayaran gaji",
        "Kasbon" => "Kasbon karyawan",
        "Inventaris" => "Pembelian barang dan servis",
        "Manual" => "Jurnal umum",
        _ => "Pembatalan",
    }
}

/// Cermin `susunArusKas`: arus kas metode langsung per sumber jurnal.
/// `mutasi` = `(sumber efektif, debit, kredit)` pada akun kas terpilih.
pub fn susun_arus_kas(saldo_awal: i64, mutasi: &[(String, i64, i64)]) -> Value {
    let mut kelompok = Vec::new();
    let (mut masuk_total, mut keluar_total) = (0i64, 0i64);
    for sumber in SUMBER_JURNAL {
        let (masuk, keluar) = mutasi
            .iter()
            .filter(|(s, _, _)| s == sumber)
            .fold((0, 0), |(m, k), (_, d, c)| (m + d, k + c));
        if masuk == 0 && keluar == 0 {
            continue;
        }
        masuk_total += masuk;
        keluar_total += keluar;
        kelompok.push(json!({
            "sumber": sumber,
            "label": label_sumber_kas(sumber),
            "masuk": masuk,
            "keluar": keluar,
            "bersih": masuk - keluar,
        }));
    }
    json!({
        "saldo_awal": saldo_awal,
        "kelompok": kelompok,
        "total_masuk": masuk_total,
        "total_keluar": keluar_total,
        "saldo_akhir": saldo_awal + masuk_total - keluar_total,
    })
}

pub const MAKS_AKUN_KAS: usize = 20;

/// Saldo debit dan kredit setiap akun dalam rentang `[dari, sampai]`.
fn saldo_per_akun(
    connection: &Connection,
    dari: &str,
    sampai: &str,
) -> Result<Vec<AkunSaldo>, CommandError> {
    let mut statement = connection
        .prepare(
            "SELECT a.id_akun, a.kode, a.nama, a.kelompok, a.saldo_normal,
                    COALESCE(t.debit, 0), COALESCE(t.kredit, 0)
             FROM keu_akun a
             LEFT JOIN (
                 SELECT b.id_akun, SUM(b.debit) AS debit, SUM(b.kredit) AS kredit
                 FROM keu_jurnal_baris b
                 JOIN keu_jurnal j ON j.id_jurnal = b.id_jurnal
                 WHERE j.tanggal >= ?1 AND j.tanggal <= ?2
                 GROUP BY b.id_akun
             ) t ON t.id_akun = a.id_akun
             ORDER BY a.kode, a.id_akun
             LIMIT 1000;",
        )
        .map_err(db_error)?;
    let rows = statement
        .query_map(params![dari, sampai], |row| {
            Ok(AkunSaldo {
                id_akun: row.get(0)?,
                kode: row.get(1)?,
                nama: row.get(2)?,
                kelompok: row.get(3)?,
                saldo_normal: row.get(4)?,
                debit: row.get(5)?,
                kredit: row.get(6)?,
            })
        })
        .map_err(db_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error)?;
    Ok(rows)
}

/// Neraca per tanggal.
pub fn report_position(state: &DesktopState, sampai: &str) -> Result<Value, CommandError> {
    if !super::inventory::is_valid_date(sampai) {
        return Err(invalid("Tanggal tidak valid."));
    }
    let connection = storage::database(&state.data_dir)?;
    let mut hasil = susun_posisi_keuangan(&saldo_per_akun(&connection, "0001-01-01", sampai)?);
    hasil["sampai"] = json!(sampai);
    Ok(hasil)
}

/// Laporan Laba Rugi untuk satu rentang.
pub fn report_activity(
    state: &DesktopState,
    dari: &str,
    sampai: &str,
) -> Result<Value, CommandError> {
    rentang(dari, sampai)?;
    let connection = storage::database(&state.data_dir)?;
    let mut hasil = susun_aktivitas(&saldo_per_akun(&connection, dari, sampai)?);
    hasil["dari"] = json!(dari);
    hasil["sampai"] = json!(sampai);
    Ok(hasil)
}

/// Laporan Arus Kas metode langsung untuk akun kas yang dipilih.
pub fn report_cashflow(
    state: &DesktopState,
    dari: &str,
    sampai: &str,
    akun_kas: &[String],
) -> Result<Value, CommandError> {
    rentang(dari, sampai)?;
    let mut akun: Vec<String> = Vec::new();
    for id in akun_kas {
        let id = id.trim();
        if !id.is_empty() && !akun.iter().any(|a| a == id) {
            akun.push(id.to_owned());
        }
    }
    if akun.is_empty() {
        return Err(invalid("Pilih minimal satu akun kas."));
    }
    if akun.len() > MAKS_AKUN_KAS {
        return Err(invalid("Akun kas paling banyak 20."));
    }
    let connection = storage::database(&state.data_dir)?;
    let mut nama_akun = Vec::new();
    for id in &akun {
        let baris: Option<(String, String, String)> = connection
            .query_row(
                "SELECT kode, nama, kelompok FROM keu_akun WHERE id_akun = ?;",
                params![id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()
            .map_err(db_error)?;
        match baris {
            Some((kode, nama, kelompok)) if kelompok == "Aset" => {
                nama_akun.push(json!({ "id_akun": id, "kode": kode, "nama": nama }));
            }
            _ => return Err(invalid("Akun kas harus akun aset.")),
        }
    }
    let tanda: Vec<String> = (0..akun.len()).map(|i| format!("?{}", i + 3)).collect();
    let daftar = tanda.join(", ");
    let mut args: Vec<&dyn rusqlite::ToSql> = vec![&dari, &sampai];
    for id in &akun {
        args.push(id);
    }
    let saldo_awal: i64 = connection
        .query_row(
            &format!(
                "SELECT COALESCE(SUM(b.debit - b.kredit), 0)
                 FROM keu_jurnal_baris b
                 JOIN keu_jurnal j ON j.id_jurnal = b.id_jurnal
                 WHERE j.tanggal < ?1 AND b.id_akun IN ({daftar})
                 -- batas: agregat, selalu satu baris
                 ;"
            ),
            args.as_slice(),
            |row| row.get(0),
        )
        .map_err(db_error)?;
    let mut statement = connection
        .prepare(&format!(
            "SELECT COALESCE(asal.sumber, j.sumber), SUM(b.debit), SUM(b.kredit)
             FROM keu_jurnal_baris b
             JOIN keu_jurnal j ON j.id_jurnal = b.id_jurnal
             LEFT JOIN keu_jurnal asal ON asal.id_jurnal = j.id_jurnal_batal
             WHERE j.tanggal >= ?1 AND j.tanggal <= ?2 AND b.id_akun IN ({daftar})
             GROUP BY 1
             -- batas: agregat per sumber jurnal
             ;"
        ))
        .map_err(db_error)?;
    let mutasi = statement
        .query_map(args.as_slice(), |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?, row.get::<_, i64>(2)?))
        })
        .map_err(db_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error)?;
    let mut hasil = susun_arus_kas(saldo_awal, &mutasi);
    hasil["dari"] = json!(dari);
    hasil["sampai"] = json!(sampai);
    hasil["akun_kas"] = json!(nama_akun);
    Ok(hasil)
}

// ── Penerapan event di cloud ────────────────────────────────────────────────

fn payload_text(row: &Value, key: &str) -> Option<String> {
    row.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_owned)
}

pub const CLOUD_UPSERT_ACCOUNT_SQL: &str = "INSERT INTO keu_akun (
        id_akun, kode, nama, kelompok, saldo_normal, is_aktif, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')), COALESCE(?, datetime('now')))
    ON CONFLICT(id_akun) DO UPDATE SET
        kode = excluded.kode,
        nama = excluded.nama,
        kelompok = excluded.kelompok,
        saldo_normal = excluded.saldo_normal,
        is_aktif = excluded.is_aktif,
        updated_at = excluded.updated_at;";

/// Nilai `keu_akun` dari payload event `accounting-account/save`.
pub fn cloud_account_values(row: &Value, entity_key: &str) -> Option<Vec<Value>> {
    let id = payload_text(row, "id_akun").unwrap_or_else(|| entity_key.trim().to_owned());
    let kode = payload_text(row, "kode")?;
    let nama = payload_text(row, "nama")?;
    let kelompok =
        payload_text(row, "kelompok").filter(|value| KELOMPOK_AKUN.contains(&value.as_str()))?;
    let saldo_normal =
        payload_text(row, "saldo_normal").filter(|value| SALDO_NORMAL.contains(&value.as_str()))?;
    if id.is_empty() {
        return None;
    }
    let is_aktif = match row.get("is_aktif").and_then(Value::as_i64) {
        Some(0) => 0,
        _ => 1,
    };
    Some(vec![
        json!(id),
        json!(kode),
        json!(nama),
        json!(kelompok),
        json!(saldo_normal),
        json!(is_aktif),
        json!(payload_text(row, "created_at")),
        json!(payload_text(row, "updated_at")),
    ])
}

pub const CLOUD_INSERT_JOURNAL_SQL: &str = "INSERT INTO keu_jurnal (
        id_jurnal, tanggal, seri, nomor_urut, nomor, keterangan, sumber,
        id_sumber, id_jurnal_batal, dibuat_oleh, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')))
    ON CONFLICT(id_jurnal) DO NOTHING;";

pub const CLOUD_INSERT_JOURNAL_ROW_SQL: &str = "INSERT INTO keu_jurnal_baris (
        id_baris, id_jurnal, id_akun, debit, kredit, keterangan, urutan
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id_baris) DO NOTHING;";

/// Statement header + seluruh baris dari payload `accounting-journal/post`.
///
/// Semua-atau-tidak-sama-sekali: satu baris cacat atau jurnal yang tidak
/// seimbang membuat SELURUH event dilewati, karena separuh jurnal di cloud
/// membuat neraca saldo setiap perangkat timpang. `ON CONFLICT DO NOTHING`
/// membuat event yang terkirim ulang dan pembatalan ganda tidak berbekas.
pub fn cloud_journal_statements(
    payload: &Value,
    entity_key: &str,
) -> Option<Vec<(&'static str, Vec<Value>)>> {
    let jurnal = payload.get("jurnal")?;
    let id = payload_text(jurnal, "id_jurnal").unwrap_or_else(|| entity_key.trim().to_owned());
    let tanggal =
        payload_text(jurnal, "tanggal").filter(|value| super::inventory::is_valid_date(value))?;
    let seri = payload_text(jurnal, "seri")?;
    let nomor_urut = jurnal
        .get("nomor_urut")
        .and_then(Value::as_i64)
        .filter(|value| *value > 0)?;
    let nomor = payload_text(jurnal, "nomor")?;
    let keterangan = payload_text(jurnal, "keterangan")?;
    let sumber =
        payload_text(jurnal, "sumber").filter(|value| SUMBER_JURNAL.contains(&value.as_str()))?;
    let dibuat_oleh = payload_text(jurnal, "dibuat_oleh")?;
    if id.is_empty() {
        return None;
    }

    let baris = payload.get("baris")?.as_array()?;
    if baris.len() < 2 || baris.len() > MAKS_BARIS_JURNAL {
        return None;
    }
    let mut statements = vec![(
        CLOUD_INSERT_JOURNAL_SQL,
        vec![
            json!(id),
            json!(tanggal),
            json!(seri),
            json!(nomor_urut),
            json!(nomor),
            json!(keterangan),
            json!(sumber),
            json!(payload_text(jurnal, "id_sumber")),
            json!(payload_text(jurnal, "id_jurnal_batal")),
            json!(dibuat_oleh),
            json!(payload_text(jurnal, "created_at")),
        ],
    )];
    let (mut total_debit, mut total_kredit) = (0i64, 0i64);
    for item in baris {
        let id_baris = payload_text(item, "id_baris")?;
        let id_akun = payload_text(item, "id_akun")?;
        let debit = item.get("debit").and_then(Value::as_i64)?;
        let kredit = item.get("kredit").and_then(Value::as_i64)?;
        if debit < 0 || kredit < 0 || (debit > 0) == (kredit > 0) {
            return None;
        }
        total_debit += debit;
        total_kredit += kredit;
        statements.push((
            CLOUD_INSERT_JOURNAL_ROW_SQL,
            vec![
                json!(id_baris),
                json!(id),
                json!(id_akun),
                json!(debit),
                json!(kredit),
                json!(payload_text(item, "keterangan")),
                json!(item.get("urutan").and_then(Value::as_i64).unwrap_or(0)),
            ],
        ));
    }
    if total_debit != total_kredit {
        return None;
    }
    Some(statements)
}

#[cfg(test)]
mod tests {
    use super::*;

    // Vektor kembar `src/lib/validations/accounting.test.ts`.

    fn draft_jurnal(value: Value) -> JurnalDraft {
        serde_json::from_value(value).expect("draft jurnal")
    }

    fn galat_jurnal(value: Value) -> Option<String> {
        validate_jurnal(&draft_jurnal(value)).err()
    }

    fn dua_baris() -> Value {
        json!([
            { "id_akun": "akun-beban-utilitas", "debit": 1_500_000 },
            { "id_akun": "akun-kas", "kredit": 1_500_000 }
        ])
    }

    #[test]
    fn format_rupiah_dan_nomor() {
        assert_eq!(format_rupiah(0), "Rp0");
        assert_eq!(format_rupiah(999), "Rp999");
        assert_eq!(format_rupiah(1500), "Rp1.500");
        assert_eq!(format_rupiah(1_000_000_000_000), "Rp1.000.000.000.000");
        assert_eq!(format_rupiah(-2500), "-Rp2.500");
        assert_eq!(
            format_nomor_jurnal("2026", "WA3F9", 7),
            "JU/2026/WA3F9/0007"
        );
        assert_eq!(
            format_nomor_jurnal("2026", "WEB", 12345),
            "JU/2026/WEB/12345"
        );
    }

    #[test]
    fn seri_perangkat_dari_kode_perangkat() {
        assert_eq!(seri_perangkat("W-AB12-CD34-EF56-7890"), "WAB12");
        assert_eq!(seri_perangkat("a-0f9e-0000-0000-0000"), "A0F9E");
    }

    #[test]
    fn saldo() {
        assert_eq!(saldo_normal_bawaan("Aset"), "Debit");
        assert_eq!(saldo_normal_bawaan("Beban"), "Debit");
        assert_eq!(saldo_normal_bawaan("Kewajiban"), "Kredit");
        assert_eq!(saldo_normal_bawaan("Ekuitas"), "Kredit");
        assert_eq!(saldo_normal_bawaan("Pendapatan"), "Kredit");
        assert_eq!(saldo_akun("Debit", 500, 200), 300);
        assert_eq!(saldo_akun("Kredit", 500, 200), -300);
        assert_eq!(
            saldo_berjalan("Debit", 1000, &[(100, 0), (0, 300), (50, 0)]),
            vec![1100, 800, 850]
        );
        assert_eq!(
            saldo_berjalan("Kredit", 0, &[(0, 500), (200, 0)]),
            vec![500, 300]
        );
        assert_eq!(kolom_neraca_saldo(700, 200), (500, 0));
        assert_eq!(kolom_neraca_saldo(200, 700), (0, 500));
        assert_eq!(kolom_neraca_saldo(300, 300), (0, 0));
    }

    #[test]
    fn bagan_akun_bawaan() {
        let akun = akun_bawaan();
        assert_eq!(akun.len(), 24);
        assert!(is_akun_sistem("akun-kas"));
        assert!(!is_akun_sistem("akun-peralatan"));
        assert_eq!(akun.iter().filter(|a| a.sistem).count(), 8);
        for item in akun {
            assert_eq!(item.saldo_normal, saldo_normal_bawaan(&item.kelompok));
            assert!(KELOMPOK_AKUN.contains(&item.kelompok.as_str()));
        }
        let ids: HashSet<&str> = akun.iter().map(|a| a.id_akun.as_str()).collect();
        let kode: HashSet<&str> = akun.iter().map(|a| a.kode.as_str()).collect();
        assert_eq!(ids.len(), akun.len());
        assert_eq!(kode.len(), akun.len());
    }

    fn draft_akun(ubah: Value) -> AkunDraft {
        let mut dasar = json!({
            "kode": " 5-1700 ",
            "nama": " Beban Transport ",
            "kelompok": "Beban",
            "saldo_normal": "Debit"
        });
        for (key, value) in ubah.as_object().expect("objek") {
            dasar[key] = value.clone();
        }
        serde_json::from_value(dasar).expect("draft akun")
    }

    #[test]
    fn validasi_akun() {
        assert_eq!(
            validate_akun(&draft_akun(json!({}))),
            Ok(AkunValid {
                kode: "5-1700".into(),
                nama: "Beban Transport".into(),
                kelompok: "Beban".into(),
                saldo_normal: "Debit".into(),
                is_aktif: true,
            })
        );
        let galat = |ubah: Value| validate_akun(&draft_akun(ubah)).err();
        assert_eq!(
            galat(json!({ "kode": "  " })).as_deref(),
            Some("Kode akun wajib diisi.")
        );
        assert_eq!(
            galat(json!({ "kode": "1".repeat(21) })).as_deref(),
            Some("Kode akun maksimal 20 karakter.")
        );
        assert_eq!(
            galat(json!({ "nama": "" })).as_deref(),
            Some("Nama akun wajib diisi.")
        );
        assert_eq!(
            galat(json!({ "nama": "n".repeat(81) })).as_deref(),
            Some("Nama akun maksimal 80 karakter.")
        );
        assert_eq!(
            galat(json!({ "kelompok": "Aset Neto" })).as_deref(),
            Some("Kelompok akun tidak dikenal.")
        );
        assert_eq!(
            galat(json!({ "saldo_normal": "debit" })).as_deref(),
            Some("Saldo normal harus Debit atau Kredit.")
        );
    }

    #[test]
    fn aturan_ubah() {
        let baru = |kelompok: &str, saldo_normal: &str, is_aktif: bool| AkunValid {
            kode: "1-1100".into(),
            nama: "Kas Kecil".into(),
            kelompok: kelompok.into(),
            saldo_normal: saldo_normal.into(),
            is_aktif,
        };
        let lama = |sistem: bool, punya_jurnal: bool| AkunLama {
            kelompok: "Aset".into(),
            saldo_normal: "Debit".into(),
            sistem,
            punya_jurnal,
        };
        assert_eq!(
            aturan_ubah_akun(&lama(true, false), &baru("Aset", "Debit", true)),
            Ok(())
        );
        assert_eq!(
            aturan_ubah_akun(&lama(true, false), &baru("Beban", "Debit", true)),
            Err("Kelompok dan saldo normal akun sistem tidak bisa diubah.".into())
        );
        assert_eq!(
            aturan_ubah_akun(&lama(true, false), &baru("Aset", "Debit", false)),
            Err("Akun sistem tidak bisa dinonaktifkan.".into())
        );
        assert_eq!(
            aturan_ubah_akun(&lama(false, true), &baru("Aset", "Kredit", true)),
            Err("Kelompok dan saldo normal tidak bisa diubah setelah akun dipakai jurnal.".into())
        );
        assert_eq!(
            aturan_ubah_akun(&lama(false, true), &baru("Aset", "Debit", false)),
            Ok(())
        );
        assert_eq!(
            aturan_ubah_akun(&lama(false, false), &baru("Beban", "Debit", true)),
            Ok(())
        );
    }

    #[test]
    fn jurnal_seimbang_diterima() {
        let hasil = validate_jurnal(&draft_jurnal(json!({
            "tanggal": "2026-10-12",
            "keterangan": " Bayar listrik ",
            "baris": [
                { "id_akun": "akun-beban-utilitas", "debit": 1_500_000, "keterangan": "  " },
                { "id_akun": "akun-kas", "kredit": 1_500_000 }
            ]
        })));
        assert_eq!(
            hasil,
            Ok(JurnalValid {
                tanggal: "2026-10-12".into(),
                keterangan: "Bayar listrik".into(),
                baris: vec![
                    BarisValid {
                        id_akun: "akun-beban-utilitas".into(),
                        debit: 1_500_000,
                        kredit: 0,
                        keterangan: None,
                    },
                    BarisValid {
                        id_akun: "akun-kas".into(),
                        debit: 0,
                        kredit: 1_500_000,
                        keterangan: None,
                    },
                ],
                total: 1_500_000,
            })
        );
    }

    #[test]
    fn jurnal_ditolak() {
        let dengan = |tanggal: &str, keterangan: &str, baris: Value| {
            galat_jurnal(json!({ "tanggal": tanggal, "keterangan": keterangan, "baris": baris }))
        };
        let ket = "Bayar listrik";
        let tgl = "2026-10-12";
        assert_eq!(
            dengan("2026-02-30", ket, dua_baris()).as_deref(),
            Some("Tanggal jurnal tidak valid.")
        );
        assert_eq!(
            dengan(tgl, "  ", dua_baris()).as_deref(),
            Some("Keterangan jurnal wajib diisi.")
        );
        assert_eq!(
            dengan(tgl, &"k".repeat(201), dua_baris()).as_deref(),
            Some("Keterangan jurnal maksimal 200 karakter.")
        );
        assert_eq!(
            dengan(tgl, ket, json!([dua_baris()[0]])).as_deref(),
            Some("Jurnal minimal dua baris.")
        );
        let banyak: Vec<Value> = (0..101).map(|_| dua_baris()[0].clone()).collect();
        assert_eq!(
            dengan(tgl, ket, json!(banyak)).as_deref(),
            Some("Jurnal maksimal 100 baris.")
        );
        assert_eq!(
            dengan(
                tgl,
                ket,
                json!([dua_baris()[0], { "id_akun": " ", "kredit": 1 }])
            )
            .as_deref(),
            Some("Baris 2: akun wajib dipilih.")
        );
        assert_eq!(
            dengan(
                tgl,
                ket,
                json!([{ "id_akun": "a", "debit": 10.5 }, dua_baris()[1]])
            )
            .as_deref(),
            Some("Baris 1: nominal harus rupiah bulat dan tidak negatif.")
        );
        assert_eq!(
            dengan(
                tgl,
                ket,
                json!([{ "id_akun": "a", "debit": -5 }, dua_baris()[1]])
            )
            .as_deref(),
            Some("Baris 1: nominal harus rupiah bulat dan tidak negatif.")
        );
        assert_eq!(
            dengan(
                tgl,
                ket,
                json!([{ "id_akun": "a", "debit": 5, "kredit": 5 }, dua_baris()[1]])
            )
            .as_deref(),
            Some("Baris 1: isi debit atau kredit, salah satu saja.")
        );
        assert_eq!(
            dengan(tgl, ket, json!([{ "id_akun": "a" }, dua_baris()[1]])).as_deref(),
            Some("Baris 1: isi debit atau kredit, salah satu saja.")
        );
        assert_eq!(
            dengan(
                tgl,
                ket,
                json!([
                    { "id_akun": "a", "debit": 1_000_000_000_001i64 },
                    { "id_akun": "b", "kredit": 1_000_000_000_001i64 }
                ])
            )
            .as_deref(),
            Some("Baris 1: nominal maksimal Rp1.000.000.000.000.")
        );
        assert_eq!(
            dengan(
                tgl,
                ket,
                json!([
                    { "id_akun": "a", "debit": 1000, "keterangan": "k".repeat(201) },
                    { "id_akun": "b", "kredit": 1000 }
                ])
            )
            .as_deref(),
            Some("Baris 1: keterangan maksimal 200 karakter.")
        );
        assert_eq!(
            dengan(
                tgl,
                ket,
                json!([{ "id_akun": "a", "debit": 1000 }, { "id_akun": "b", "kredit": 900 }])
            )
            .as_deref(),
            Some("Total debit Rp1.000 tidak sama dengan total kredit Rp900.")
        );
    }

    fn asal(sumber: &str) -> JurnalAsal {
        JurnalAsal {
            id_jurnal: "jrn-1".into(),
            nomor: "JU/2026/WEB/0001".into(),
            sumber: sumber.into(),
            baris: vec![
                BarisTulis {
                    id_baris: "jb-1".into(),
                    id_akun: "akun-beban-atk".into(),
                    debit: 250_000,
                    kredit: 0,
                    keterangan: Some("Kertas".into()),
                    urutan: 1,
                },
                BarisTulis {
                    id_baris: "jb-2".into(),
                    id_akun: "akun-kas".into(),
                    debit: 0,
                    kredit: 250_000,
                    keterangan: None,
                    urutan: 2,
                },
            ],
        }
    }

    #[test]
    fn pembalik() {
        assert_eq!(
            susun_pembalik(&asal("Manual"), " Salah akun "),
            Ok(Pembalik {
                id_jurnal: "batal-jrn-1".into(),
                keterangan: "Pembatalan JU/2026/WEB/0001: Salah akun".into(),
                baris: vec![
                    BarisTulis {
                        id_baris: "batal-jb-1".into(),
                        id_akun: "akun-beban-atk".into(),
                        debit: 0,
                        kredit: 250_000,
                        keterangan: Some("Kertas".into()),
                        urutan: 1,
                    },
                    BarisTulis {
                        id_baris: "batal-jb-2".into(),
                        id_akun: "akun-kas".into(),
                        debit: 250_000,
                        kredit: 0,
                        keterangan: None,
                        urutan: 2,
                    },
                ],
            })
        );
        let galat = |sumber: &str, alasan: &str| susun_pembalik(&asal(sumber), alasan).err();
        assert_eq!(
            galat("Pembatalan", "x").as_deref(),
            Some("Jurnal pembalik tidak bisa dibatalkan lagi.")
        );
        assert_eq!(
            galat("Payroll", "x").as_deref(),
            Some("Jurnal dari modul Payroll dibatalkan dari modulnya.")
        );
        assert_eq!(
            galat("Manual", "  ").as_deref(),
            Some("Alasan pembatalan wajib diisi.")
        );
        assert_eq!(
            galat("Manual", &"a".repeat(151)).as_deref(),
            Some("Alasan pembatalan maksimal 150 karakter.")
        );
    }

    // ── I/O terhadap skema asli `storage::initialize` ──

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

    fn outbox(state: &DesktopState, domain: &str) -> Vec<Value> {
        let connection = storage::database(&state.data_dir).expect("db");
        let mut statement = connection
            .prepare(
                "SELECT payload_json FROM desktop_sync_outbox WHERE domain = ? ORDER BY rowid;",
            )
            .expect("outbox");
        statement
            .query_map(params![domain], |row| row.get::<_, String>(0))
            .expect("rows")
            .map(|raw| serde_json::from_str(&raw.expect("raw")).expect("json"))
            .collect()
    }

    #[test]
    fn seed_akun_ditanam_tanpa_outbox() {
        let (_dir, state) = state_uji();
        let akun = list_accounts(&state).expect("daftar akun");
        assert_eq!(akun["items"].as_array().expect("items").len(), 24);
        assert!(outbox(&state, "accounting-account").is_empty());
    }

    #[test]
    fn posting_pembalik_dan_laporan() {
        let (_dir, state) = state_uji();
        let jurnal = |tanggal: &str, debit_akun: &str, kredit_akun: &str, nominal: i64| {
            post_journal(
                &state,
                "bendahara",
                json!({
                    "tanggal": tanggal,
                    "keterangan": "Uji",
                    "baris": [
                        { "id_akun": debit_akun, "debit": nominal },
                        { "id_akun": kredit_akun, "kredit": nominal }
                    ]
                }),
            )
            .expect("posting")
        };
        let pertama = jurnal("2026-09-30", "akun-kas", "akun-modal", 10_000_000);
        let kedua = jurnal("2026-10-05", "akun-beban-atk", "akun-kas", 250_000);
        assert!(pertama["nomor"].as_str().expect("nomor").ends_with("/0001"));
        assert!(kedua["nomor"].as_str().expect("nomor").ends_with("/0002"));

        // Satu event per jurnal, membawa header dan seluruh barisnya, dan
        // payload itu diterima apa adanya oleh penerap cloud.
        let events = outbox(&state, "accounting-journal");
        assert_eq!(events.len(), 2);
        assert_eq!(events[0]["baris"].as_array().expect("baris").len(), 2);
        let statements = cloud_journal_statements(&events[0], "").expect("payload sah di cloud");
        assert_eq!(statements.len(), 3);

        let id_kedua = kedua["id_jurnal"].as_str().expect("id");
        let batal = reverse_journal(&state, "kepala", id_kedua, "Salah catat").expect("batal");
        assert_eq!(batal["id_jurnal"], json!(format!("batal-{id_kedua}")));
        let ulang = reverse_journal(&state, "kepala", id_kedua, "Lagi").expect_err("batal ganda");
        assert_eq!(ulang.message, "Jurnal ini sudah dibatalkan.");
        let pembalik = reverse_journal(&state, "kepala", &format!("batal-{id_kedua}"), "x")
            .expect_err("pembalik dibatalkan");
        assert_eq!(
            pembalik.message,
            "Jurnal pembalik tidak bisa dibatalkan lagi."
        );

        let neraca = trial_balance(&state, "2099-12-31").expect("neraca saldo");
        assert_eq!(neraca["total_debit"], neraca["total_kredit"]);
        let kas = neraca["items"]
            .as_array()
            .expect("items")
            .iter()
            .find(|item| item["id_akun"] == "akun-kas")
            .expect("kas");
        // Kas: +10.000.000 − 250.000 + 250.000 (pembalik) = 10.000.000.
        assert_eq!(kas["debit"], json!(10_000_000));

        let buku = ledger(&state, "akun-kas", "2026-10-01", "2099-12-31").expect("buku besar");
        assert_eq!(buku["saldo_awal"], json!(10_000_000));
        assert_eq!(buku["saldo_akhir"], json!(10_000_000));
        assert_eq!(buku["baris"].as_array().expect("baris").len(), 2);

        let daftar =
            list_journals(&state, "2026-01-01", "2099-12-31", Some("Manual")).expect("daftar");
        let manual = daftar["items"].as_array().expect("items");
        assert_eq!(manual.len(), 2);
        assert!(manual.iter().any(|item| item["dibatalkan"] == json!(true)));

        // Laporan keuangan dari jurnal yang sama (K4a).
        let posisi = report_position(&state, "2099-12-31").expect("posisi keuangan");
        assert_eq!(posisi["total_aset"], json!(10_000_000));
        assert_eq!(posisi["total_ekuitas"], json!(10_000_000));
        assert_eq!(posisi["laba_berjalan"], json!(0));
        assert_eq!(posisi["selisih"], json!(0));
        let aktivitas = report_activity(&state, "2026-10-05", "2026-10-05").expect("aktivitas");
        assert_eq!(aktivitas["total_beban"], json!(250_000));
        assert_eq!(aktivitas["laba_bersih"], json!(-250_000));
        let arus = report_cashflow(&state, "2026-10-01", "2099-12-31", &["akun-kas".into()])
            .expect("arus kas");
        assert_eq!(arus["saldo_awal"], json!(10_000_000));
        // Pembalik ikut kelompok sumber jurnal yang dibatalkannya.
        assert_eq!(arus["kelompok"].as_array().expect("kelompok").len(), 1);
        assert_eq!(arus["kelompok"][0]["label"], json!("Jurnal umum"));
        assert_eq!(arus["kelompok"][0]["masuk"], json!(250_000));
        assert_eq!(arus["kelompok"][0]["keluar"], json!(250_000));
        assert_eq!(arus["saldo_akhir"], json!(10_000_000));
        assert_eq!(
            report_cashflow(&state, "2026-10-01", "2026-10-31", &["akun-beban-atk".into()])
                .expect_err("bukan aset")
                .message,
            "Akun kas harus akun aset."
        );
        assert_eq!(
            report_cashflow(&state, "2026-10-01", "2026-10-31", &[" ".into()])
                .expect_err("kosong")
                .message,
            "Pilih minimal satu akun kas."
        );
    }

    #[test]
    fn akun_nonaktif_dan_kode_ganda_ditolak() {
        let (_dir, state) = state_uji();
        let galat = save_account(
            &state,
            json!({ "kode": "1-1100", "nama": "Kas Kedua", "kelompok": "Aset", "saldo_normal": "Debit" }),
        )
        .expect_err("kode ganda");
        assert_eq!(galat.message, "Kode akun sudah dipakai akun lain.");

        let baru = save_account(
            &state,
            json!({ "kode": "5-1700", "nama": "Beban Transport", "kelompok": "Beban", "saldo_normal": "Debit", "is_aktif": false }),
        )
        .expect("akun baru");
        assert_eq!(outbox(&state, "accounting-account").len(), 1);
        let id = baru["id_akun"].as_str().expect("id");
        let galat = post_journal(
            &state,
            "bendahara",
            json!({
                "tanggal": "2026-10-12",
                "keterangan": "Ongkos",
                "baris": [
                    { "id_akun": "akun-kas", "kredit": 50_000 },
                    { "id_akun": id, "debit": 50_000 }
                ]
            }),
        )
        .expect_err("akun nonaktif");
        assert_eq!(
            galat.message,
            "Baris 2: akun tidak ditemukan atau nonaktif."
        );
    }

    #[test]
    fn cloud_menolak_jurnal_timpang_seluruhnya() {
        let payload = json!({
            "jurnal": {
                "id_jurnal": "jrn-x", "tanggal": "2026-10-12", "seri": "WEB", "nomor_urut": 1,
                "nomor": "JU/2026/WEB/0001", "keterangan": "x", "sumber": "Manual", "dibuat_oleh": "a"
            },
            "baris": [
                { "id_baris": "b1", "id_akun": "akun-kas", "debit": 100, "kredit": 0 },
                { "id_baris": "b2", "id_akun": "akun-bank", "debit": 0, "kredit": 90 }
            ]
        });
        assert!(cloud_journal_statements(&payload, "jrn-x").is_none());
    }

    #[test]
    fn laporan_isak35_kembar() {
        let a = |id: &str, kelompok: &str, normal: &str, debit: i64, kredit: i64| AkunSaldo {
            id_akun: id.into(),
            kode: id.into(),
            nama: id.into(),
            kelompok: kelompok.into(),
            saldo_normal: normal.into(),
            debit,
            kredit,
        };
        let akun = vec![
            a("kas", "Aset", "Debit", 900_000, 300_000),
            a("piutang", "Aset", "Debit", 500_000, 200_000),
            a("bangunan", "Aset", "Debit", 0, 0),
            a("titipan", "Kewajiban", "Kredit", 0, 50_000),
            a("ekuitas", "Ekuitas", "Kredit", 0, 400_000),
            a("spp", "Pendapatan", "Kredit", 0, 700_000),
            a("gaji", "Beban", "Debit", 300_000, 0),
        ];
        let posisi = susun_posisi_keuangan(&akun);
        assert_eq!(posisi["total_aset"], json!(900_000));
        assert_eq!(posisi["aset"].as_array().expect("aset").len(), 2);
        assert_eq!(posisi["total_kewajiban"], json!(50_000));
        assert_eq!(posisi["laba_berjalan"], json!(400_000));
        assert_eq!(posisi["total_ekuitas"], json!(800_000));
        assert_eq!(posisi["selisih"], json!(50_000));

        let aktivitas = susun_aktivitas(&akun);
        assert_eq!(aktivitas["total_pendapatan"], json!(700_000));
        assert_eq!(aktivitas["total_beban"], json!(300_000));
        assert_eq!(aktivitas["laba_bersih"], json!(400_000));
        assert_eq!(aktivitas["beban"][0]["saldo"], json!(300_000));

        let arus = susun_arus_kas(
            100_000,
            &[
                ("Payroll".into(), 0, 250_000),
                ("Manual".into(), 600_000, 50_000),
                ("Kasbon".into(), 0, 0),
            ],
        );
        assert_eq!(arus["kelompok"].as_array().expect("kelompok").len(), 2);
        // Urutan mengikuti `SUMBER_JURNAL`.
        assert_eq!(arus["kelompok"][0]["label"], json!("Jurnal umum"));
        assert_eq!(arus["kelompok"][0]["bersih"], json!(550_000));
        assert_eq!(arus["kelompok"][1]["label"], json!("Pembayaran gaji"));
        assert_eq!(arus["total_masuk"], json!(600_000));
        assert_eq!(arus["total_keluar"], json!(300_000));
        assert_eq!(arus["saldo_akhir"], json!(400_000));
    }
}
