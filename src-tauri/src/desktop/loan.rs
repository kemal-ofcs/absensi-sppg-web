//! Kasbon karyawan (Fase K2): pengajuan, pencairan, cicilan potong gaji,
//! pelunasan tunai, dan penundaan.
//!
//! Tiga tabel tersinkron: `keu_pinjaman`, `keu_pinjaman_mutasi` (append-only),
//! dan `keu_pinjaman_tunda`. Sisa pinjaman TIDAK pernah disimpan: pokok
//! dikurangi angsuran gaji dan pelunasan tunai, dihitung setiap kali dibaca.
//! Setiap uang yang berpindah punya jurnal (`accounting::tulis_jurnal_tx`)
//! yang ditulis di transaksi lokal yang sama.
//!
//! Aturan murni di berkas ini dicerminkan `src/lib/validations/loan.ts` dan
//! diuji dengan vektor yang sama. Pesan galatnya pun wajib identik.

use std::collections::HashMap;

use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::Deserialize;
use serde_json::{json, Value};

use super::{
    accounting::{self, BarisTulis, HeaderTulis},
    config::DesktopState,
    models::CommandError,
    storage, sync,
};

/// WAJIB sama dengan CHECK `keu_pinjaman.status` di ketiga DDL.
pub const STATUS_PINJAMAN: [&str; 4] = ["Diajukan", "Disetujui", "Ditolak", "Dibatalkan"];
/// WAJIB sama dengan CHECK `keu_pinjaman_mutasi.jenis` di ketiga DDL.
pub const JENIS_MUTASI_PINJAMAN: [&str; 4] = [
    "Pencairan",
    "Angsuran Gaji",
    "Pelunasan Tunai",
    "Pembatalan",
];

pub const MAKS_POKOK: i64 = 1_000_000_000;
pub const MAKS_KETERANGAN_PINJAMAN: usize = 100;

pub const AKUN_PIUTANG_KARYAWAN: &str = "akun-piutang-karyawan";
pub const AKUN_BEBAN_GAJI: &str = "akun-beban-gaji";
pub const AKUN_BEBAN_BPJS: &str = "akun-beban-bpjs";
pub const AKUN_UTANG_PPH21: &str = "akun-utang-pph21";
pub const AKUN_UTANG_BPJS: &str = "akun-utang-bpjs";
pub const AKUN_POTONGAN_GAJI: &str = "akun-potongan-gaji";
pub const AKUN_KAS: &str = "akun-kas";

// ── Aturan murni ────────────────────────────────────────────────────────────

fn panjang(value: &str) -> usize {
    value.chars().count()
}

/// Cermin `isValidPeriode`: `YYYY-MM`.
pub fn is_valid_periode(value: &str) -> bool {
    let bytes = value.as_bytes();
    let angka = |range: std::ops::Range<usize>| {
        bytes[range.clone()]
            .iter()
            .all(u8::is_ascii_digit)
            .then(|| value[range].parse::<u32>().ok())
            .flatten()
    };
    if bytes.len() != 7 || bytes[4] != b'-' || !value.is_ascii() {
        return false;
    }
    matches!((angka(0..4), angka(5..7)), (Some(tahun), Some(bulan)) if tahun >= 1900 && (1..=12).contains(&bulan))
}

pub fn id_tunda(id_pinjaman: &str, periode: &str) -> String {
    format!("tunda-{id_pinjaman}-{periode}")
}
pub fn id_angsuran_gaji(id_item: &str, id_pinjaman: &str) -> String {
    format!("ang-{id_item}-{id_pinjaman}")
}
pub fn id_pencairan(id_pinjaman: &str) -> String {
    format!("cair-{id_pinjaman}")
}
pub fn id_pembatalan_pinjaman(id_pinjaman: &str) -> String {
    format!("batal-{id_pinjaman}")
}
pub fn id_jurnal_pencairan(id_pinjaman: &str) -> String {
    format!("jrn-cair-{id_pinjaman}")
}
pub fn id_jurnal_payroll(id_run: &str) -> String {
    format!("pay-{id_run}")
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PinjamanDraft {
    #[serde(default)]
    pub id_pinjaman: Option<String>,
    #[serde(default)]
    pub id_karyawan: String,
    #[serde(default)]
    pub pokok: Value,
    #[serde(default)]
    pub cicilan: Value,
    #[serde(default)]
    pub mulai_potong: String,
    #[serde(default)]
    pub keterangan: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PinjamanValid {
    pub id_karyawan: String,
    pub pokok: i64,
    pub cicilan: i64,
    pub mulai_potong: String,
    pub keterangan: Option<String>,
}

/// Rupiah bulat > 0. Pecahan, nol, negatif, atau bukan angka = tidak sah.
fn rupiah_positif(value: &Value) -> Option<i64> {
    value.as_i64().filter(|nilai| *nilai > 0)
}

/// Cermin `validatePinjaman`.
pub fn validate_pinjaman(draft: &PinjamanDraft) -> Result<PinjamanValid, String> {
    let id_karyawan = draft.id_karyawan.trim();
    if id_karyawan.is_empty() {
        return Err("Karyawan wajib dipilih.".into());
    }
    let Some(pokok) = rupiah_positif(&draft.pokok) else {
        return Err("Pokok pinjaman harus rupiah bulat lebih dari nol.".into());
    };
    if pokok > MAKS_POKOK {
        return Err(format!(
            "Pokok pinjaman maksimal {}.",
            accounting::format_rupiah(MAKS_POKOK)
        ));
    }
    let Some(cicilan) = rupiah_positif(&draft.cicilan) else {
        return Err("Cicilan harus rupiah bulat lebih dari nol.".into());
    };
    if cicilan > pokok {
        return Err("Cicilan tidak boleh melebihi pokok pinjaman.".into());
    }
    if !is_valid_periode(&draft.mulai_potong) {
        return Err("Bulan mulai potong tidak valid.".into());
    }
    let keterangan = draft
        .keterangan
        .as_deref()
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_owned);
    if keterangan
        .as_deref()
        .is_some_and(|text| panjang(text) > MAKS_KETERANGAN_PINJAMAN)
    {
        return Err("Keterangan maksimal 100 karakter.".into());
    }
    Ok(PinjamanValid {
        id_karyawan: id_karyawan.to_owned(),
        pokok,
        cicilan,
        mulai_potong: draft.mulai_potong.clone(),
        keterangan,
    })
}

/// Cermin `aturanKeputusan`: status baru, atau alasan penolakan.
pub fn aturan_keputusan(
    status: &str,
    aksi: &str,
    ada_angsuran: bool,
) -> Result<&'static str, String> {
    match aksi {
        "setujui" | "tolak" => {
            if status != "Diajukan" {
                return Err("Hanya pengajuan yang bisa disetujui atau ditolak.".into());
            }
            Ok(if aksi == "setujui" {
                "Disetujui"
            } else {
                "Ditolak"
            })
        }
        "batalkan" => {
            if status != "Disetujui" {
                return Err("Hanya pinjaman yang sudah disetujui yang bisa dibatalkan.".into());
            }
            if ada_angsuran {
                return Err("Pinjaman yang sudah diangsur tidak bisa dibatalkan.".into());
            }
            Ok("Dibatalkan")
        }
        _ => Err("Aksi tidak dikenal.".into()),
    }
}

/// Cermin `validatePelunasan`. `sisa` adalah sisa efektif.
pub fn validate_pelunasan(jumlah: i64, sisa: i64) -> Result<i64, String> {
    if jumlah <= 0 {
        return Err("Jumlah pelunasan harus rupiah bulat lebih dari nol.".into());
    }
    if jumlah > sisa {
        return Err(format!(
            "Jumlah pelunasan melebihi sisa pinjaman {}.",
            accounting::format_rupiah(sisa.max(0))
        ));
    }
    Ok(jumlah)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PinjamanAktif {
    pub id_pinjaman: String,
    pub cicilan: i64,
    pub sisa_efektif: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PotonganKasbon {
    pub id_pinjaman: String,
    pub jumlah: i64,
    pub sebagian: bool,
}

/// Cermin `potongKasbon`. Kasbon dipotong TERAKHIR, dari gaji bersih yang
/// tersisa, pinjaman tertua lebih dulu; gaji bersih tidak pernah minus.
pub fn potong_kasbon(net_tersedia: i64, pinjaman: &[PinjamanAktif]) -> (i64, Vec<PotonganKasbon>) {
    let mut sisa_net = net_tersedia.max(0);
    let mut rincian = Vec::new();
    for item in pinjaman {
        let target = item.cicilan.min(item.sisa_efektif);
        if target <= 0 {
            continue;
        }
        let jumlah = target.min(sisa_net);
        if jumlah <= 0 {
            continue;
        }
        sisa_net -= jumlah;
        rincian.push(PotonganKasbon {
            id_pinjaman: item.id_pinjaman.clone(),
            jumlah,
            sebagian: jumlah < target,
        });
    }
    (rincian.iter().map(|item| item.jumlah).sum(), rincian)
}

/// Cermin `komponenKasbon`: entri `breakdown_snapshot.components`.
pub fn komponen_kasbon(rincian: &[PotonganKasbon]) -> Vec<Value> {
    rincian
        .iter()
        .map(|item| {
            json!({
                "id": format!("kasbon-{}", item.id_pinjaman),
                "name": if item.sebagian { "Cicilan Kasbon (dipotong sebagian)" } else { "Cicilan Kasbon" },
                "category": "DEDUCTION",
                "calc_type": "KASBON",
                "rate": 0,
                "nominal": item.jumlah,
            })
        })
        .collect()
}

/// Daftar `breakdown_snapshot.kasbon`: yang dibaca saat proses gaji dibayar.
pub fn rincian_kasbon_json(rincian: &[PotonganKasbon]) -> Vec<Value> {
    rincian
        .iter()
        .map(|item| {
            json!({
                "id_pinjaman": item.id_pinjaman,
                "jumlah": item.jumlah,
                "sebagian": item.sebagian,
            })
        })
        .collect()
}

#[derive(Debug, Clone, Copy, Default)]
pub struct ItemPayroll {
    pub gross: i64,
    pub net: i64,
    pub pph21: i64,
    pub bpjs_karyawan: i64,
    pub bpjs_perusahaan: i64,
    pub kasbon: i64,
}

/// Cermin `susunJurnalPayroll`: `(id_akun, debit, kredit)`, baris nol dibuang.
pub fn susun_jurnal_payroll(items: &[ItemPayroll], id_akun_bayar: &str) -> Vec<(String, i64, i64)> {
    let jumlah = |pilih: fn(&ItemPayroll) -> i64| items.iter().map(pilih).sum::<i64>();
    let gross = jumlah(|item| item.gross);
    let net = jumlah(|item| item.net);
    let pph21 = jumlah(|item| item.pph21);
    let bpjs_karyawan = jumlah(|item| item.bpjs_karyawan);
    let bpjs_perusahaan = jumlah(|item| item.bpjs_perusahaan);
    let kasbon = jumlah(|item| item.kasbon);
    let potongan_lain = gross - net - pph21 - bpjs_karyawan - kasbon;

    [
        (AKUN_BEBAN_GAJI, gross, 0),
        (AKUN_BEBAN_BPJS, bpjs_perusahaan, 0),
        (id_akun_bayar, 0, net),
        (AKUN_UTANG_PPH21, 0, pph21),
        (AKUN_UTANG_BPJS, 0, bpjs_karyawan + bpjs_perusahaan),
        (AKUN_PIUTANG_KARYAWAN, 0, kasbon),
        (
            AKUN_POTONGAN_GAJI,
            (-potongan_lain).max(0),
            potongan_lain.max(0),
        ),
    ]
    .into_iter()
    .filter(|(_, debit, kredit)| *debit > 0 || *kredit > 0)
    .map(|(akun, debit, kredit)| (akun.to_owned(), debit, kredit))
    .collect()
}

// ── Penulisan dan pembacaan lokal ───────────────────────────────────────────

fn invalid(message: impl Into<String>) -> CommandError {
    CommandError::new("VALIDATION_ERROR", message)
}

fn db_error(_: rusqlite::Error) -> CommandError {
    CommandError::internal()
}

fn new_id(prefix: &str) -> String {
    let mut bytes = [0u8; 16];
    rand_core::RngCore::fill_bytes(&mut rand_core::OsRng, &mut bytes);
    format!("{prefix}{}", hex::encode(bytes))
}

fn hari_ini(connection: &Connection) -> Result<String, CommandError> {
    connection
        .query_row("SELECT date('now', '+7 hours');", [], |row| row.get(0))
        .map_err(db_error)
}

/// Potongan kasbon di proses gaji yang BELUM dibayar dan belum ditolak,
/// dibaca dari `breakdown_snapshot.kasbon`. Tanpa ini dua draf yang berjalan
/// bersamaan sama-sama memotong cicilan dari sisa yang sama.
const PENDING_SQL: &str = "COALESCE((
        SELECT SUM(CAST(json_extract(k.value, '$.jumlah') AS INTEGER))
        FROM payroll_items i
        JOIN payroll_runs r ON r.id = i.payroll_run_id,
             json_each(i.breakdown_snapshot, '$.kasbon') k
        WHERE r.status NOT IN ('PAID', 'REJECTED')
          AND json_extract(k.value, '$.id_pinjaman') = p.id_pinjaman
    ), 0)";

/// Potongan kasbon yang sudah masuk proses gaji (selain yang ditolak) di
/// bulan yang sama, menurut bulan `period_start`. Cicilan adalah jatah per
/// BULAN, bukan per proses gaji: gaji harian/mingguan bisa punya beberapa
/// proses gaji sebulan. Cermin `TERPOTONG_BULAN_SQL` di `services/loan.ts`.
const TERPOTONG_BULAN_SQL: &str = "COALESCE((
        SELECT SUM(CAST(json_extract(k.value, '$.jumlah') AS INTEGER))
        FROM payroll_items i
        JOIN payroll_runs r ON r.id = i.payroll_run_id,
             json_each(i.breakdown_snapshot, '$.kasbon') k
        WHERE r.status <> 'REJECTED'
          AND substr(r.period_start, 1, 7) = ?1
          AND json_extract(k.value, '$.id_pinjaman') = p.id_pinjaman
    ), 0)";

const BAYAR_SQL: &str = "COALESCE((
        SELECT SUM(m.jumlah) FROM keu_pinjaman_mutasi m
        WHERE m.id_pinjaman = p.id_pinjaman
          AND m.jenis IN ('Angsuran Gaji', 'Pelunasan Tunai')
    ), 0)";

fn pinjaman_json(connection: &Connection, id: &str) -> Result<Option<Value>, CommandError> {
    connection
        .query_row(
            "SELECT id_pinjaman, id_karyawan, nama_karyawan, pokok, cicilan, mulai_potong,
                    keterangan, status, tanggal_pengajuan, diajukan_oleh, diputuskan_oleh,
                    tanggal_cair, id_akun_kas, created_at, updated_at
             FROM keu_pinjaman WHERE id_pinjaman = ?;",
            params![id],
            |row| {
                Ok(json!({
                    "id_pinjaman": row.get::<_, String>(0)?,
                    "id_karyawan": row.get::<_, String>(1)?,
                    "nama_karyawan": row.get::<_, String>(2)?,
                    "pokok": row.get::<_, i64>(3)?,
                    "cicilan": row.get::<_, i64>(4)?,
                    "mulai_potong": row.get::<_, String>(5)?,
                    "keterangan": row.get::<_, Option<String>>(6)?,
                    "status": row.get::<_, String>(7)?,
                    "tanggal_pengajuan": row.get::<_, String>(8)?,
                    "diajukan_oleh": row.get::<_, String>(9)?,
                    "diputuskan_oleh": row.get::<_, Option<String>>(10)?,
                    "tanggal_cair": row.get::<_, Option<String>>(11)?,
                    "id_akun_kas": row.get::<_, Option<String>>(12)?,
                    "created_at": row.get::<_, String>(13)?,
                    "updated_at": row.get::<_, String>(14)?,
                }))
            },
        )
        .optional()
        .map_err(db_error)
}

pub fn list_loans(state: &DesktopState) -> Result<Value, CommandError> {
    let connection = storage::database(&state.data_dir)?;
    let sql = format!(
        "SELECT p.id_pinjaman, p.id_karyawan, p.nama_karyawan, p.pokok, p.cicilan,
                p.mulai_potong, p.keterangan, p.status, p.tanggal_pengajuan, p.tanggal_cair,
                {BAYAR_SQL} AS bayar,
                {PENDING_SQL} AS pending,
                (SELECT group_concat(t.periode, ',') FROM keu_pinjaman_tunda t
                  WHERE t.id_pinjaman = p.id_pinjaman) AS tunda
         FROM keu_pinjaman p
         ORDER BY CASE p.status WHEN 'Diajukan' THEN 0 WHEN 'Disetujui' THEN 1 ELSE 2 END,
                  p.created_at DESC, p.id_pinjaman
         LIMIT 1000;"
    );
    let mut statement = connection.prepare(&sql).map_err(db_error)?;
    let items = statement
        .query_map([], |row| {
            let pokok: i64 = row.get(3)?;
            let status: String = row.get(7)?;
            let bayar: i64 = row.get(10)?;
            let pending: i64 = row.get(11)?;
            let tunda: Option<String> = row.get(12)?;
            let sisa = pokok - bayar;
            Ok(json!({
                "id_pinjaman": row.get::<_, String>(0)?,
                "id_karyawan": row.get::<_, String>(1)?,
                "nama_karyawan": row.get::<_, String>(2)?,
                "pokok": pokok,
                "cicilan": row.get::<_, i64>(4)?,
                "mulai_potong": row.get::<_, String>(5)?,
                "keterangan": row.get::<_, Option<String>>(6)?,
                "lebih_potong": status == "Disetujui" && sisa < 0,
                "status": status,
                "tanggal_pengajuan": row.get::<_, String>(8)?,
                "tanggal_cair": row.get::<_, Option<String>>(9)?,
                "terbayar": bayar,
                "sisa": sisa,
                "potongan_tertunda": pending,
                "tunda": tunda
                    .map(|text| text.split(',').map(str::to_owned).collect::<Vec<_>>())
                    .unwrap_or_default(),
            }))
        })
        .map_err(db_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error)?;
    Ok(json!({ "items": items }))
}

pub fn loan_detail(state: &DesktopState, id_pinjaman: &str) -> Result<Value, CommandError> {
    let connection = storage::database(&state.data_dir)?;
    let pinjaman = pinjaman_json(&connection, id_pinjaman)?
        .ok_or_else(|| CommandError::new("NOT_FOUND", "Pinjaman tidak ditemukan."))?;
    let mut statement = connection
        .prepare(
            "SELECT id_mutasi, jenis, jumlah, tanggal, id_ref, id_jurnal, dicatat_oleh, created_at
             FROM keu_pinjaman_mutasi WHERE id_pinjaman = ?
             ORDER BY tanggal, created_at, id_mutasi
             LIMIT 500;",
        )
        .map_err(db_error)?;
    let mutasi = statement
        .query_map(params![id_pinjaman], |row| {
            Ok(json!({
                "id_mutasi": row.get::<_, String>(0)?,
                "jenis": row.get::<_, String>(1)?,
                "jumlah": row.get::<_, i64>(2)?,
                "tanggal": row.get::<_, String>(3)?,
                "id_ref": row.get::<_, Option<String>>(4)?,
                "id_jurnal": row.get::<_, Option<String>>(5)?,
                "dicatat_oleh": row.get::<_, String>(6)?,
                "created_at": row.get::<_, String>(7)?,
            }))
        })
        .map_err(db_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error)?;
    let mut statement = connection
        .prepare(
            "SELECT id_tunda, periode, alasan, dibuat_oleh FROM keu_pinjaman_tunda
             WHERE id_pinjaman = ? ORDER BY periode LIMIT 200;",
        )
        .map_err(db_error)?;
    let tunda = statement
        .query_map(params![id_pinjaman], |row| {
            Ok(json!({
                "id_tunda": row.get::<_, String>(0)?,
                "periode": row.get::<_, String>(1)?,
                "alasan": row.get::<_, Option<String>>(2)?,
                "dibuat_oleh": row.get::<_, String>(3)?,
            }))
        })
        .map_err(db_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error)?;
    Ok(json!({ "pinjaman": pinjaman, "mutasi": mutasi, "tunda": tunda }))
}

/// Personil aktif untuk dipilih sebagai peminjam. Dibaca dengan izin kasbon,
/// bukan `employees.view`: bendahara perlu memilih orang tanpa melihat
/// seluruh data kepegawaian.
pub fn loan_people(state: &DesktopState) -> Result<Value, CommandError> {
    let connection = storage::database(&state.data_dir)?;
    let mut statement = connection
        .prepare(
            "SELECT id_unik, nama, divisi FROM master_data
             WHERE COALESCE(status_aktif, 'Aktif') = 'Aktif'
             ORDER BY nama, id_unik
             LIMIT 3000;",
        )
        .map_err(db_error)?;
    let items = statement
        .query_map([], |row| {
            Ok(json!({
                "id_karyawan": row.get::<_, String>(0)?,
                "nama": row.get::<_, String>(1)?,
                "divisi": row.get::<_, String>(2)?,
            }))
        })
        .map_err(db_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error)?;
    Ok(json!({ "items": items }))
}

fn enqueue_pinjaman(
    transaction: &Transaction<'_>,
    client_id: &str,
    id_pinjaman: &str,
) -> Result<(), CommandError> {
    let payload = pinjaman_json(transaction, id_pinjaman)?.ok_or_else(CommandError::internal)?;
    sync::enqueue(
        transaction,
        client_id,
        "loan",
        "save",
        id_pinjaman,
        &payload,
        None,
    )?;
    Ok(())
}

pub fn save_loan(
    state: &DesktopState,
    operator: &str,
    draft: Value,
) -> Result<Value, CommandError> {
    let draft: PinjamanDraft =
        serde_json::from_value(draft).map_err(|_| invalid("Data pinjaman tidak valid."))?;
    let valid = validate_pinjaman(&draft).map_err(invalid)?;
    let client_id = sync::ensure_client_id(state)?;
    let mut connection = storage::database(&state.data_dir)?;
    let transaction = connection.transaction().map_err(db_error)?;

    let nama: String = transaction
        .query_row(
            "SELECT nama FROM master_data WHERE id_unik = ?;",
            params![valid.id_karyawan],
            |row| row.get(0),
        )
        .optional()
        .map_err(db_error)?
        .ok_or_else(|| invalid("Karyawan tidak ditemukan."))?;

    let id_pinjaman = match draft
        .id_pinjaman
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty())
    {
        Some(id) => {
            let status: String = transaction
                .query_row(
                    "SELECT status FROM keu_pinjaman WHERE id_pinjaman = ?;",
                    params![id],
                    |row| row.get(0),
                )
                .optional()
                .map_err(db_error)?
                .ok_or_else(|| invalid("Pinjaman tidak ditemukan."))?;
            if status != "Diajukan" {
                return Err(invalid("Hanya pengajuan yang bisa diubah."));
            }
            id.to_owned()
        }
        None => new_id("pjm-"),
    };
    let tanggal = hari_ini(&transaction)?;

    transaction
        .execute(
            "INSERT INTO keu_pinjaman (
                id_pinjaman, id_karyawan, nama_karyawan, pokok, cicilan, mulai_potong,
                keterangan, status, tanggal_pengajuan, diajukan_oleh, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, 'Diajukan', ?, ?, datetime('now'), datetime('now'))
             ON CONFLICT(id_pinjaman) DO UPDATE SET
                id_karyawan = excluded.id_karyawan,
                nama_karyawan = excluded.nama_karyawan,
                pokok = excluded.pokok,
                cicilan = excluded.cicilan,
                mulai_potong = excluded.mulai_potong,
                keterangan = excluded.keterangan,
                updated_at = excluded.updated_at;",
            params![
                id_pinjaman,
                valid.id_karyawan,
                nama,
                valid.pokok,
                valid.cicilan,
                valid.mulai_potong,
                valid.keterangan,
                tanggal,
                operator
            ],
        )
        .map_err(db_error)?;
    enqueue_pinjaman(&transaction, &client_id, &id_pinjaman)?;
    transaction.commit().map_err(db_error)?;
    Ok(json!({ "sukses": true, "id_pinjaman": id_pinjaman }))
}

#[allow(clippy::too_many_arguments)]
fn catat_mutasi_tx(
    transaction: &Transaction<'_>,
    client_id: &str,
    id_mutasi: &str,
    id_pinjaman: &str,
    jenis: &str,
    jumlah: i64,
    tanggal: &str,
    id_ref: Option<&str>,
    id_jurnal: Option<&str>,
    dicatat_oleh: &str,
) -> Result<(), CommandError> {
    // `OR IGNORE`: id deterministik (cair-, batal-, ang-) yang sudah tertarik
    // dari perangkat lain tidak dicatat dan tidak diantre dua kali.
    let ditulis = transaction
        .execute(
            "INSERT OR IGNORE INTO keu_pinjaman_mutasi (
                id_mutasi, id_pinjaman, jenis, jumlah, tanggal, id_ref, id_jurnal,
                dicatat_oleh, created_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'));",
            params![
                id_mutasi,
                id_pinjaman,
                jenis,
                jumlah,
                tanggal,
                id_ref,
                id_jurnal,
                dicatat_oleh
            ],
        )
        .map_err(db_error)?;
    if ditulis == 0 {
        return Ok(());
    }
    let payload = transaction
        .query_row(
            "SELECT id_mutasi, id_pinjaman, jenis, jumlah, tanggal, id_ref, id_jurnal,
                    dicatat_oleh, created_at
             FROM keu_pinjaman_mutasi WHERE id_mutasi = ?;",
            params![id_mutasi],
            |row| {
                Ok(json!({
                    "id_mutasi": row.get::<_, String>(0)?,
                    "id_pinjaman": row.get::<_, String>(1)?,
                    "jenis": row.get::<_, String>(2)?,
                    "jumlah": row.get::<_, i64>(3)?,
                    "tanggal": row.get::<_, String>(4)?,
                    "id_ref": row.get::<_, Option<String>>(5)?,
                    "id_jurnal": row.get::<_, Option<String>>(6)?,
                    "dicatat_oleh": row.get::<_, String>(7)?,
                    "created_at": row.get::<_, String>(8)?,
                }))
            },
        )
        .map_err(db_error)?;
    sync::enqueue(
        transaction,
        client_id,
        "loan-mutation",
        "create",
        id_mutasi,
        &payload,
        None,
    )?;
    Ok(())
}

fn baris_dua(debit_akun: &str, kredit_akun: &str, jumlah: i64, prefix: &str) -> Vec<BarisTulis> {
    vec![
        BarisTulis {
            id_baris: format!("{prefix}-1"),
            id_akun: debit_akun.to_owned(),
            debit: jumlah,
            kredit: 0,
            keterangan: None,
            urutan: 1,
        },
        BarisTulis {
            id_baris: format!("{prefix}-2"),
            id_akun: kredit_akun.to_owned(),
            debit: 0,
            kredit: jumlah,
            keterangan: None,
            urutan: 2,
        },
    ]
}

/// Sisa efektif satu pinjaman: pokok − angsuran − pelunasan − potongan di
/// proses gaji yang belum dibayar.
fn sisa_efektif(connection: &Connection, id_pinjaman: &str) -> Result<i64, CommandError> {
    connection
        .query_row(
            &format!(
                "SELECT p.pokok - {BAYAR_SQL} - {PENDING_SQL}
                 FROM keu_pinjaman p WHERE p.id_pinjaman = ?;"
            ),
            params![id_pinjaman],
            |row| row.get(0),
        )
        .map_err(db_error)
}

pub fn decide_loan(
    state: &DesktopState,
    operator: &str,
    id_pinjaman: &str,
    aksi: &str,
    id_akun_kas: Option<&str>,
) -> Result<Value, CommandError> {
    let client_id = sync::ensure_client_id(state)?;
    let mut connection = storage::database(&state.data_dir)?;
    let transaction = connection.transaction().map_err(db_error)?;

    let (status, pokok, nama): (String, i64, String) = transaction
        .query_row(
            "SELECT status, pokok, nama_karyawan FROM keu_pinjaman WHERE id_pinjaman = ?;",
            params![id_pinjaman],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()
        .map_err(db_error)?
        .ok_or_else(|| invalid("Pinjaman tidak ditemukan."))?;
    let ada_angsuran: bool = transaction
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM keu_pinjaman_mutasi
                           WHERE id_pinjaman = ? AND jenis IN ('Angsuran Gaji', 'Pelunasan Tunai'));",
            params![id_pinjaman],
            |row| row.get(0),
        )
        .map_err(db_error)?;
    let status_baru = aturan_keputusan(&status, aksi, ada_angsuran).map_err(invalid)?;
    let tanggal = hari_ini(&transaction)?;

    match aksi {
        "setujui" => {
            let akun = id_akun_kas.unwrap_or(AKUN_KAS);
            accounting::assert_akun_bayar(&transaction, akun)?;
            transaction
                .execute(
                    "UPDATE keu_pinjaman SET status = ?, diputuskan_oleh = ?, tanggal_cair = ?,
                            id_akun_kas = ?, updated_at = datetime('now')
                     WHERE id_pinjaman = ?;",
                    params![status_baru, operator, tanggal, akun, id_pinjaman],
                )
                .map_err(db_error)?;
            let id_jurnal = id_jurnal_pencairan(id_pinjaman);
            accounting::tulis_jurnal_tx(
                &transaction,
                state,
                &client_id,
                HeaderTulis {
                    id_jurnal: id_jurnal.clone(),
                    tanggal: tanggal.clone(),
                    keterangan: format!("Pencairan kasbon {nama}"),
                    sumber: "Kasbon",
                    id_sumber: Some(id_pinjaman.to_owned()),
                    id_jurnal_batal: None,
                    dibuat_oleh: operator.to_owned(),
                },
                &baris_dua(AKUN_PIUTANG_KARYAWAN, akun, pokok, &id_jurnal),
            )?;
            catat_mutasi_tx(
                &transaction,
                &client_id,
                &id_pencairan(id_pinjaman),
                id_pinjaman,
                "Pencairan",
                pokok,
                &tanggal,
                None,
                Some(&id_jurnal),
                operator,
            )?;
        }
        "tolak" => {
            transaction
                .execute(
                    "UPDATE keu_pinjaman SET status = ?, diputuskan_oleh = ?, updated_at = datetime('now')
                     WHERE id_pinjaman = ?;",
                    params![status_baru, operator, id_pinjaman],
                )
                .map_err(db_error)?;
        }
        _ => {
            transaction
                .execute(
                    "UPDATE keu_pinjaman SET status = ?, updated_at = datetime('now')
                     WHERE id_pinjaman = ?;",
                    params![status_baru, id_pinjaman],
                )
                .map_err(db_error)?;
            let id_jurnal = id_jurnal_pencairan(id_pinjaman);
            accounting::balik_jurnal_tx(
                &transaction,
                state,
                &client_id,
                &id_jurnal,
                format!("Pembatalan kasbon {nama}"),
                operator,
            )?;
            catat_mutasi_tx(
                &transaction,
                &client_id,
                &id_pembatalan_pinjaman(id_pinjaman),
                id_pinjaman,
                "Pembatalan",
                pokok,
                &tanggal,
                None,
                Some(&accounting::id_pembalik(&id_jurnal)),
                operator,
            )?;
        }
    }
    enqueue_pinjaman(&transaction, &client_id, id_pinjaman)?;
    transaction.commit().map_err(db_error)?;
    Ok(json!({ "sukses": true, "status": status_baru }))
}

pub fn pay_off_loan(
    state: &DesktopState,
    operator: &str,
    id_pinjaman: &str,
    jumlah: i64,
    id_akun_kas: Option<&str>,
) -> Result<Value, CommandError> {
    let client_id = sync::ensure_client_id(state)?;
    let mut connection = storage::database(&state.data_dir)?;
    let transaction = connection.transaction().map_err(db_error)?;

    let (status, nama): (String, String) = transaction
        .query_row(
            "SELECT status, nama_karyawan FROM keu_pinjaman WHERE id_pinjaman = ?;",
            params![id_pinjaman],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(db_error)?
        .ok_or_else(|| invalid("Pinjaman tidak ditemukan."))?;
    if status != "Disetujui" {
        return Err(invalid(
            "Hanya pinjaman yang sudah disetujui yang bisa dilunasi.",
        ));
    }
    validate_pelunasan(jumlah, sisa_efektif(&transaction, id_pinjaman)?).map_err(invalid)?;
    let akun = id_akun_kas.unwrap_or(AKUN_KAS);
    accounting::assert_akun_bayar(&transaction, akun)?;

    let tanggal = hari_ini(&transaction)?;
    let id_mutasi = new_id("lns-");
    let id_jurnal = format!("jrn-{id_mutasi}");
    accounting::tulis_jurnal_tx(
        &transaction,
        state,
        &client_id,
        HeaderTulis {
            id_jurnal: id_jurnal.clone(),
            tanggal: tanggal.clone(),
            keterangan: format!("Pelunasan kasbon {nama}"),
            sumber: "Kasbon",
            id_sumber: Some(id_pinjaman.to_owned()),
            id_jurnal_batal: None,
            dibuat_oleh: operator.to_owned(),
        },
        &baris_dua(akun, AKUN_PIUTANG_KARYAWAN, jumlah, &id_jurnal),
    )?;
    catat_mutasi_tx(
        &transaction,
        &client_id,
        &id_mutasi,
        id_pinjaman,
        "Pelunasan Tunai",
        jumlah,
        &tanggal,
        None,
        Some(&id_jurnal),
        operator,
    )?;
    transaction.commit().map_err(db_error)?;
    Ok(json!({ "sukses": true, "id_mutasi": id_mutasi }))
}

pub fn defer_loan(
    state: &DesktopState,
    operator: &str,
    id_pinjaman: &str,
    periode: &str,
    alasan: Option<&str>,
) -> Result<Value, CommandError> {
    if !is_valid_periode(periode) {
        return Err(invalid("Bulan penundaan tidak valid."));
    }
    let alasan = alasan.map(str::trim).filter(|text| !text.is_empty());
    if alasan.is_some_and(|text| panjang(text) > MAKS_KETERANGAN_PINJAMAN) {
        return Err(invalid("Alasan penundaan maksimal 100 karakter."));
    }
    let client_id = sync::ensure_client_id(state)?;
    let mut connection = storage::database(&state.data_dir)?;
    let transaction = connection.transaction().map_err(db_error)?;
    let status: Option<String> = transaction
        .query_row(
            "SELECT status FROM keu_pinjaman WHERE id_pinjaman = ?;",
            params![id_pinjaman],
            |row| row.get(0),
        )
        .optional()
        .map_err(db_error)?;
    if status.as_deref() != Some("Disetujui") {
        return Err(invalid(
            "Hanya pinjaman yang sudah disetujui yang bisa ditunda.",
        ));
    }
    let id = id_tunda(id_pinjaman, periode);
    let ditulis = transaction
        .execute(
            "INSERT OR IGNORE INTO keu_pinjaman_tunda (id_tunda, id_pinjaman, periode, alasan, dibuat_oleh, created_at)
             VALUES (?, ?, ?, ?, ?, datetime('now'));",
            params![id, id_pinjaman, periode, alasan, operator],
        )
        .map_err(db_error)?;
    if ditulis > 0 {
        let payload = json!({
            "id_tunda": id,
            "id_pinjaman": id_pinjaman,
            "periode": periode,
            "alasan": alasan,
            "dibuat_oleh": operator,
        });
        sync::enqueue(
            &transaction,
            &client_id,
            "loan-deferral",
            "save",
            &id,
            &payload,
            None,
        )?;
    }
    transaction.commit().map_err(db_error)?;
    Ok(json!({ "sukses": true, "id_tunda": id }))
}

pub fn undefer_loan(state: &DesktopState, id_tunda: &str) -> Result<Value, CommandError> {
    let client_id = sync::ensure_client_id(state)?;
    let mut connection = storage::database(&state.data_dir)?;
    let transaction = connection.transaction().map_err(db_error)?;
    let dihapus = transaction
        .execute(
            "DELETE FROM keu_pinjaman_tunda WHERE id_tunda = ?;",
            params![id_tunda],
        )
        .map_err(db_error)?;
    if dihapus > 0 {
        sync::enqueue(
            &transaction,
            &client_id,
            "loan-deferral",
            "delete",
            id_tunda,
            &json!({ "id_tunda": id_tunda }),
            None,
        )?;
    }
    transaction.commit().map_err(db_error)?;
    Ok(json!({ "sukses": true }))
}

// ── Integrasi payroll ───────────────────────────────────────────────────────

/// Pinjaman yang dipotong pada proses gaji bulan `bulan` (`YYYY-MM`), per
/// karyawan, pinjaman tertua lebih dulu. `cicilan` yang dikembalikan adalah
/// SISA jatah bulan itu: proses gaji kedua di bulan yang sama hanya memotong
/// kekurangan dari proses sebelumnya. Cermin `pinjamanAktif` di
/// `services/loan.ts`.
pub fn pinjaman_aktif(
    connection: &Connection,
    bulan: &str,
) -> Result<HashMap<String, Vec<PinjamanAktif>>, CommandError> {
    let sql = format!(
        "SELECT p.id_karyawan, p.id_pinjaman, p.cicilan - {TERPOTONG_BULAN_SQL} AS cicilan_sisa,
                p.pokok - {BAYAR_SQL} - {PENDING_SQL} AS sisa_efektif
         FROM keu_pinjaman p
         WHERE p.status = 'Disetujui' AND p.mulai_potong <= ?1
           AND NOT EXISTS (SELECT 1 FROM keu_pinjaman_tunda t
                           WHERE t.id_pinjaman = p.id_pinjaman AND t.periode = ?1)
         ORDER BY p.id_karyawan, p.tanggal_cair, p.created_at, p.id_pinjaman
         LIMIT 5000;"
    );
    let mut statement = connection.prepare(&sql).map_err(db_error)?;
    let rows = statement
        .query_map(params![bulan], |row| {
            Ok((
                row.get::<_, String>(0)?,
                PinjamanAktif {
                    id_pinjaman: row.get(1)?,
                    cicilan: row.get(2)?,
                    sisa_efektif: row.get(3)?,
                },
            ))
        })
        .map_err(db_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error)?;
    let mut hasil: HashMap<String, Vec<PinjamanAktif>> = HashMap::new();
    // Pinjaman yang sudah lunas, atau jatah bulan ini sudah terpenuhi, tidak
    // ikut sama sekali.
    for (id_karyawan, pinjaman) in rows
        .into_iter()
        .filter(|(_, p)| p.sisa_efektif > 0 && p.cicilan > 0)
    {
        hasil.entry(id_karyawan).or_default().push(pinjaman);
    }
    Ok(hasil)
}

/// Dipanggil di transaksi yang SAMA dengan transisi proses gaji ke PAID:
/// mencatat angsuran setiap kasbon yang terpotong dan satu jurnal payroll.
/// Id deterministik membuat dua perangkat yang sama-sama menandai PAID tidak
/// mencatat apa pun dua kali.
pub fn catat_pembayaran_payroll_tx(
    transaction: &Transaction<'_>,
    state: &DesktopState,
    client_id: &str,
    run_id: &str,
    id_akun_bayar: &str,
    operator: &str,
) -> Result<(), CommandError> {
    let (period_start, period_end): (String, String) = transaction
        .query_row(
            "SELECT period_start, period_end FROM payroll_runs WHERE id = ?;",
            params![run_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(db_error)?;
    let mut statement = transaction
        .prepare(
            "SELECT id, gross_salary, net_salary, pph21_amount, bpjs_employee_total,
                    bpjs_company_total, breakdown_snapshot
             FROM payroll_items WHERE payroll_run_id = ?
             ORDER BY id
             LIMIT 5000;",
        )
        .map_err(db_error)?;
    let rows = statement
        .query_map(params![run_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, i64>(4)?,
                row.get::<_, i64>(5)?,
                row.get::<_, String>(6)?,
            ))
        })
        .map_err(db_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error)?;
    drop(statement);

    let tanggal = hari_ini(transaction)?;
    let id_jurnal = id_jurnal_payroll(run_id);
    let mut items = Vec::with_capacity(rows.len());
    for (id_item, gross, net, pph21, bpjs_k, bpjs_p, breakdown) in rows {
        let kasbon: Vec<(String, i64)> = serde_json::from_str::<Value>(&breakdown)
            .ok()
            .and_then(|value| value.get("kasbon").and_then(Value::as_array).cloned())
            .unwrap_or_default()
            .iter()
            .filter_map(|entry| {
                Some((
                    entry.get("id_pinjaman")?.as_str()?.to_owned(),
                    entry.get("jumlah")?.as_i64().filter(|jumlah| *jumlah > 0)?,
                ))
            })
            .collect();
        for (id_pinjaman, jumlah) in &kasbon {
            catat_mutasi_tx(
                transaction,
                client_id,
                &id_angsuran_gaji(&id_item, id_pinjaman),
                id_pinjaman,
                "Angsuran Gaji",
                *jumlah,
                &tanggal,
                Some(&id_item),
                Some(&id_jurnal),
                operator,
            )?;
        }
        items.push(ItemPayroll {
            gross,
            net,
            pph21,
            bpjs_karyawan: bpjs_k,
            bpjs_perusahaan: bpjs_p,
            kasbon: kasbon.iter().map(|(_, jumlah)| jumlah).sum(),
        });
    }

    let baris: Vec<BarisTulis> = susun_jurnal_payroll(&items, id_akun_bayar)
        .into_iter()
        .enumerate()
        .map(|(indeks, (id_akun, debit, kredit))| BarisTulis {
            id_baris: format!("{id_jurnal}-{}", indeks + 1),
            id_akun,
            debit,
            kredit,
            keterangan: None,
            urutan: indeks as i64 + 1,
        })
        .collect();
    if baris.len() >= 2 {
        accounting::tulis_jurnal_tx(
            transaction,
            state,
            client_id,
            HeaderTulis {
                id_jurnal,
                tanggal,
                keterangan: format!("Pembayaran gaji periode {period_start} s.d. {period_end}"),
                sumber: "Payroll",
                id_sumber: Some(run_id.to_owned()),
                id_jurnal_batal: None,
                dibuat_oleh: operator.to_owned(),
            },
            &baris,
        )?;
    }
    Ok(())
}

// ── Penerapan event di cloud ────────────────────────────────────────────────

fn payload_text(row: &Value, key: &str) -> Option<String> {
    row.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_owned)
}

pub const CLOUD_UPSERT_LOAN_SQL: &str = "INSERT INTO keu_pinjaman (
        id_pinjaman, id_karyawan, nama_karyawan, pokok, cicilan, mulai_potong, keterangan,
        status, tanggal_pengajuan, diajukan_oleh, diputuskan_oleh, tanggal_cair, id_akun_kas,
        created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')), COALESCE(?, datetime('now')))
    ON CONFLICT(id_pinjaman) DO UPDATE SET
        id_karyawan = excluded.id_karyawan,
        nama_karyawan = excluded.nama_karyawan,
        pokok = excluded.pokok,
        cicilan = excluded.cicilan,
        mulai_potong = excluded.mulai_potong,
        keterangan = excluded.keterangan,
        status = excluded.status,
        diputuskan_oleh = excluded.diputuskan_oleh,
        tanggal_cair = excluded.tanggal_cair,
        id_akun_kas = excluded.id_akun_kas,
        updated_at = excluded.updated_at;";

/// Nilai `keu_pinjaman` dari payload `loan/save`. Bentuk cacat dilewati,
/// tidak pernah ditolak: menolak mengunci outbox (prinsip 5.3).
pub fn cloud_loan_values(row: &Value, entity_key: &str) -> Option<Vec<Value>> {
    let id = payload_text(row, "id_pinjaman").unwrap_or_else(|| entity_key.trim().to_owned());
    let status =
        payload_text(row, "status").filter(|value| STATUS_PINJAMAN.contains(&value.as_str()))?;
    let pokok = row
        .get("pokok")
        .and_then(Value::as_i64)
        .filter(|v| *v > 0)?;
    let cicilan = row
        .get("cicilan")
        .and_then(Value::as_i64)
        .filter(|v| *v > 0)?;
    if id.is_empty() {
        return None;
    }
    Some(vec![
        json!(id),
        json!(payload_text(row, "id_karyawan")?),
        json!(payload_text(row, "nama_karyawan")?),
        json!(pokok),
        json!(cicilan),
        json!(payload_text(row, "mulai_potong")?),
        json!(payload_text(row, "keterangan")),
        json!(status),
        json!(payload_text(row, "tanggal_pengajuan")?),
        json!(payload_text(row, "diajukan_oleh")?),
        json!(payload_text(row, "diputuskan_oleh")),
        json!(payload_text(row, "tanggal_cair")),
        json!(payload_text(row, "id_akun_kas")),
        json!(payload_text(row, "created_at")),
        json!(payload_text(row, "updated_at")),
    ])
}

pub const CLOUD_INSERT_LOAN_MUTATION_SQL: &str = "INSERT INTO keu_pinjaman_mutasi (
        id_mutasi, id_pinjaman, jenis, jumlah, tanggal, id_ref, id_jurnal, dicatat_oleh, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')))
    ON CONFLICT(id_mutasi) DO NOTHING;";

pub fn cloud_loan_mutation_values(row: &Value, entity_key: &str) -> Option<Vec<Value>> {
    let id = payload_text(row, "id_mutasi").unwrap_or_else(|| entity_key.trim().to_owned());
    let jenis = payload_text(row, "jenis")
        .filter(|value| JENIS_MUTASI_PINJAMAN.contains(&value.as_str()))?;
    let jumlah = row
        .get("jumlah")
        .and_then(Value::as_i64)
        .filter(|v| *v > 0)?;
    if id.is_empty() {
        return None;
    }
    Some(vec![
        json!(id),
        json!(payload_text(row, "id_pinjaman")?),
        json!(jenis),
        json!(jumlah),
        json!(payload_text(row, "tanggal")?),
        json!(payload_text(row, "id_ref")),
        json!(payload_text(row, "id_jurnal")),
        json!(payload_text(row, "dicatat_oleh")?),
        json!(payload_text(row, "created_at")),
    ])
}

pub const CLOUD_INSERT_DEFERRAL_SQL: &str = "INSERT INTO keu_pinjaman_tunda (
        id_tunda, id_pinjaman, periode, alasan, dibuat_oleh, created_at
    ) VALUES (?, ?, ?, ?, ?, COALESCE(?, datetime('now')))
    ON CONFLICT(id_tunda) DO NOTHING;";

pub fn cloud_deferral_values(row: &Value, entity_key: &str) -> Option<Vec<Value>> {
    let id = payload_text(row, "id_tunda").unwrap_or_else(|| entity_key.trim().to_owned());
    let periode = payload_text(row, "periode").filter(|value| is_valid_periode(value))?;
    if id.is_empty() {
        return None;
    }
    Some(vec![
        json!(id),
        json!(payload_text(row, "id_pinjaman")?),
        json!(periode),
        json!(payload_text(row, "alasan")),
        json!(payload_text(row, "dibuat_oleh")?),
        json!(payload_text(row, "created_at")),
    ])
}

#[cfg(test)]
mod tests {
    use super::*;

    // Vektor kembar `src/lib/validations/loan.test.ts`.

    #[test]
    fn periode_dan_id() {
        assert!(is_valid_periode("2026-10"));
        assert!(!is_valid_periode("2026-13"));
        assert!(!is_valid_periode("2026-1"));
        assert!(!is_valid_periode("1899-01"));
        assert_eq!(id_tunda("pjm-1", "2026-11"), "tunda-pjm-1-2026-11");
        assert_eq!(id_angsuran_gaji("PR-1-K01", "pjm-1"), "ang-PR-1-K01-pjm-1");
    }

    fn draft(ubah: Value) -> PinjamanDraft {
        let mut dasar = json!({
            "id_karyawan": " K-01 ",
            "pokok": 3_000_000,
            "cicilan": 500_000,
            "mulai_potong": "2026-11",
            "keterangan": " Biaya berobat anak "
        });
        for (key, value) in ubah.as_object().expect("objek") {
            dasar[key] = value.clone();
        }
        serde_json::from_value(dasar).expect("draft")
    }

    #[test]
    fn validasi_pinjaman() {
        assert_eq!(
            validate_pinjaman(&draft(json!({}))),
            Ok(PinjamanValid {
                id_karyawan: "K-01".into(),
                pokok: 3_000_000,
                cicilan: 500_000,
                mulai_potong: "2026-11".into(),
                keterangan: Some("Biaya berobat anak".into()),
            })
        );
        let galat = |ubah: Value| validate_pinjaman(&draft(ubah)).err();
        assert_eq!(
            galat(json!({ "id_karyawan": " " })).as_deref(),
            Some("Karyawan wajib dipilih.")
        );
        assert_eq!(
            galat(json!({ "pokok": 0 })).as_deref(),
            Some("Pokok pinjaman harus rupiah bulat lebih dari nol.")
        );
        assert_eq!(
            galat(json!({ "pokok": 1500.5 })).as_deref(),
            Some("Pokok pinjaman harus rupiah bulat lebih dari nol.")
        );
        assert_eq!(
            galat(json!({ "pokok": 1_000_000_001i64 })).as_deref(),
            Some("Pokok pinjaman maksimal Rp1.000.000.000.")
        );
        assert_eq!(
            galat(json!({ "cicilan": -1 })).as_deref(),
            Some("Cicilan harus rupiah bulat lebih dari nol.")
        );
        assert_eq!(
            galat(json!({ "cicilan": 3_000_001 })).as_deref(),
            Some("Cicilan tidak boleh melebihi pokok pinjaman.")
        );
        assert_eq!(
            galat(json!({ "mulai_potong": "2026-13" })).as_deref(),
            Some("Bulan mulai potong tidak valid.")
        );
        assert_eq!(
            galat(json!({ "keterangan": "k".repeat(101) })).as_deref(),
            Some("Keterangan maksimal 100 karakter.")
        );
    }

    #[test]
    fn keputusan() {
        assert_eq!(
            aturan_keputusan("Diajukan", "setujui", false),
            Ok("Disetujui")
        );
        assert_eq!(aturan_keputusan("Diajukan", "tolak", false), Ok("Ditolak"));
        assert_eq!(
            aturan_keputusan("Disetujui", "setujui", false),
            Err("Hanya pengajuan yang bisa disetujui atau ditolak.".into())
        );
        assert_eq!(
            aturan_keputusan("Disetujui", "batalkan", false),
            Ok("Dibatalkan")
        );
        assert_eq!(
            aturan_keputusan("Disetujui", "batalkan", true),
            Err("Pinjaman yang sudah diangsur tidak bisa dibatalkan.".into())
        );
        assert_eq!(
            aturan_keputusan("Diajukan", "batalkan", false),
            Err("Hanya pinjaman yang sudah disetujui yang bisa dibatalkan.".into())
        );
        assert_eq!(
            aturan_keputusan("Diajukan", "hapus", false),
            Err("Aksi tidak dikenal.".into())
        );
    }

    #[test]
    fn pelunasan() {
        assert_eq!(
            validate_pelunasan(0, 100),
            Err("Jumlah pelunasan harus rupiah bulat lebih dari nol.".into())
        );
        assert_eq!(
            validate_pelunasan(150, 100),
            Err("Jumlah pelunasan melebihi sisa pinjaman Rp100.".into())
        );
        assert_eq!(
            validate_pelunasan(10, -5),
            Err("Jumlah pelunasan melebihi sisa pinjaman Rp0.".into())
        );
        assert_eq!(validate_pelunasan(100, 100), Ok(100));
    }

    fn aktif() -> Vec<PinjamanAktif> {
        vec![
            PinjamanAktif {
                id_pinjaman: "a".into(),
                cicilan: 300_000,
                sisa_efektif: 1_000_000,
            },
            PinjamanAktif {
                id_pinjaman: "b".into(),
                cicilan: 500_000,
                sisa_efektif: 200_000,
            },
            PinjamanAktif {
                id_pinjaman: "c".into(),
                cicilan: 100_000,
                sisa_efektif: 0,
            },
        ]
    }

    #[test]
    fn potongan_kasbon() {
        let potong = |id: &str, jumlah: i64, sebagian: bool| PotonganKasbon {
            id_pinjaman: id.into(),
            jumlah,
            sebagian,
        };
        assert_eq!(
            potong_kasbon(1_000_000, &aktif()),
            (
                500_000,
                vec![potong("a", 300_000, false), potong("b", 200_000, false)]
            )
        );
        assert_eq!(
            potong_kasbon(400_000, &aktif()),
            (
                400_000,
                vec![potong("a", 300_000, false), potong("b", 100_000, true)]
            )
        );
        assert_eq!(potong_kasbon(0, &aktif()), (0, vec![]));
        assert_eq!(potong_kasbon(-50, &aktif()), (0, vec![]));
        assert_eq!(
            komponen_kasbon(&[potong("b", 100_000, true)]),
            vec![json!({
                "id": "kasbon-b",
                "name": "Cicilan Kasbon (dipotong sebagian)",
                "category": "DEDUCTION",
                "calc_type": "KASBON",
                "rate": 0,
                "nominal": 100_000,
            })]
        );
    }

    #[test]
    fn jurnal_payroll() {
        let item = |gross, net, pph21, bpjs_karyawan, bpjs_perusahaan, kasbon| ItemPayroll {
            gross,
            net,
            pph21,
            bpjs_karyawan,
            bpjs_perusahaan,
            kasbon,
        };
        let baris = |akun: &str, debit: i64, kredit: i64| (akun.to_owned(), debit, kredit);
        assert_eq!(
            susun_jurnal_payroll(
                &[
                    item(5_000_000, 4_000_000, 150_000, 200_000, 300_000, 500_000),
                    item(3_000_000, 2_800_000, 0, 100_000, 150_000, 0),
                ],
                "akun-bank"
            ),
            vec![
                baris("akun-beban-gaji", 8_000_000, 0),
                baris("akun-beban-bpjs", 450_000, 0),
                baris("akun-bank", 0, 6_800_000),
                baris("akun-utang-pph21", 0, 150_000),
                baris("akun-utang-bpjs", 0, 750_000),
                baris("akun-piutang-karyawan", 0, 500_000),
                baris("akun-potongan-gaji", 0, 250_000),
            ]
        );
        assert_eq!(
            susun_jurnal_payroll(&[item(100, 0, 0, 150, 0, 0)], "akun-kas"),
            vec![
                baris("akun-beban-gaji", 100, 0),
                baris("akun-utang-bpjs", 0, 150),
                baris("akun-potongan-gaji", 50, 0),
            ]
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

    fn saldo(state: &DesktopState, akun: &str) -> i64 {
        let neraca = accounting::trial_balance(state, "2099-12-31").expect("neraca");
        assert_eq!(
            neraca["total_debit"], neraca["total_kredit"],
            "neraca timpang"
        );
        neraca["items"]
            .as_array()
            .expect("items")
            .iter()
            .find(|item| item["id_akun"] == akun)
            .map(|item| item["debit"].as_i64().unwrap_or(0) - item["kredit"].as_i64().unwrap_or(0))
            .unwrap_or(0)
    }

    #[test]
    fn siklus_kasbon_dan_pembayaran_gaji() {
        let (_dir, state) = state_uji();
        let connection = storage::database(&state.data_dir).expect("db");
        connection
            .execute_batch(
                "INSERT INTO master_data (id_unik, kode_karyawan, nama, divisi, id_shift, jenis_personil, status_aktif)
                 VALUES ('K-01', 'K-01', 'Budi', 'TU', 1, 'Pegawai', 'Aktif');",
            )
            .expect("seed personil");

        let baru = save_loan(
            &state,
            "bendahara",
            json!({ "id_karyawan": "K-01", "pokok": 1_000_000, "cicilan": 400_000, "mulai_potong": "2026-01" }),
        )
        .expect("ajukan");
        let id = baru["id_pinjaman"].as_str().expect("id").to_owned();
        decide_loan(&state, "kepala", &id, "setujui", Some("akun-bank")).expect("setujui");
        assert_eq!(saldo(&state, "akun-piutang-karyawan"), 1_000_000);
        assert_eq!(saldo(&state, "akun-bank"), -1_000_000);

        // Proses gaji DRAFT yang memotong 400.000 mengurangi sisa efektif,
        // sehingga pelunasan 700.000 ditolak walau sisa tercatat 1.000.000.
        connection
            .execute_batch(&format!(
                "INSERT INTO payroll_runs (id, idempotency_key, period_start, period_end, status,
                     total_gross_payout, total_net_payout, total_employees, created_by, created_at, updated_at)
                 VALUES ('PR-1', 'k1', '2026-02-01', '2026-02-28', 'DRAFT', 5000000, 4100000, 1, 'a', 'x', 'x');
                 INSERT INTO payroll_items (id, payroll_run_id, id_karyawan, nama_karyawan, divisi,
                     total_regular_hours, total_overtime_hours, total_overtime_index, rate_per_hour,
                     basic_salary, overtime_salary, gross_salary, total_allowances, total_deductions,
                     bpjs_employee_total, bpjs_company_total, pph21_amount, net_salary,
                     breakdown_snapshot, created_at)
                 VALUES ('PR-1-K-01', 'PR-1', 'K-01', 'Budi', 'TU', 160, 0, 0, 31250,
                     5000000, 0, 5000000, 0, 400000, 200000, 300000, 300000, 4100000,
                     '{{\"kasbon\":[{{\"id_pinjaman\":\"{id}\",\"jumlah\":400000}}]}}', 'x');"
            ))
            .expect("seed proses gaji");
        let galat = pay_off_loan(&state, "bendahara", &id, 700_000, None).expect_err("melebihi");
        assert_eq!(
            galat.message,
            "Jumlah pelunasan melebihi sisa pinjaman Rp600.000."
        );
        // Jatah Februari sudah habis oleh proses gaji Februari; Maret penuh lagi.
        assert!(pinjaman_aktif(&connection, "2026-02")
            .expect("aktif")
            .is_empty());
        let aktif = pinjaman_aktif(&connection, "2026-03").expect("aktif");
        assert_eq!(aktif["K-01"][0].sisa_efektif, 600_000);
        assert_eq!(aktif["K-01"][0].cicilan, 400_000);

        // Ditandai PAID: angsuran tercatat dan jurnal payroll seimbang.
        connection
            .execute(
                "UPDATE payroll_runs SET status = 'PAID' WHERE id = 'PR-1';",
                [],
            )
            .expect("paid");
        {
            let mut koneksi = storage::database(&state.data_dir).expect("db");
            let tx = koneksi.transaction().expect("tx");
            let client_id = sync::ensure_client_id(&state).expect("client");
            catat_pembayaran_payroll_tx(&tx, &state, &client_id, "PR-1", "akun-kas", "kepala")
                .expect("catat");
            // Pemanggilan kedua tidak mencatat apa pun lagi.
            catat_pembayaran_payroll_tx(&tx, &state, &client_id, "PR-1", "akun-kas", "kepala")
                .expect("catat ulang");
            tx.commit().expect("commit");
        }
        assert_eq!(saldo(&state, "akun-piutang-karyawan"), 600_000);
        assert_eq!(saldo(&state, "akun-beban-gaji"), 5_000_000);
        assert_eq!(saldo(&state, "akun-kas"), -4_100_000);
        let daftar = list_loans(&state).expect("daftar");
        assert_eq!(daftar["items"][0]["sisa"], json!(600_000));
        assert_eq!(daftar["items"][0]["potongan_tertunda"], json!(0));

        let galat =
            decide_loan(&state, "kepala", &id, "batalkan", None).expect_err("sudah diangsur");
        assert_eq!(
            galat.message,
            "Pinjaman yang sudah diangsur tidak bisa dibatalkan."
        );

        defer_loan(&state, "bendahara", &id, "2026-03", Some("Sakit")).expect("tunda");
        assert!(pinjaman_aktif(&connection, "2026-03")
            .expect("aktif")
            .is_empty());
        undefer_loan(&state, &id_tunda(&id, "2026-03")).expect("cabut");
        assert_eq!(
            pinjaman_aktif(&connection, "2026-03").expect("aktif").len(),
            1
        );

        pay_off_loan(&state, "bendahara", &id, 600_000, None).expect("lunas");
        assert_eq!(saldo(&state, "akun-piutang-karyawan"), 0);
        assert!(pinjaman_aktif(&connection, "2026-04")
            .expect("aktif")
            .is_empty());
    }

    /// Cicilan adalah jatah per bulan: proses gaji mingguan kedua hanya
    /// memotong kekurangan minggu pertama, dan proses yang ditolak
    /// mengembalikan jatahnya.
    #[test]
    fn jatah_cicilan_per_bulan_lintas_proses_gaji() {
        let (_dir, state) = state_uji();
        let connection = storage::database(&state.data_dir).expect("db");
        connection
            .execute_batch(
                "INSERT INTO master_data (id_unik, kode_karyawan, nama, divisi, id_shift, jenis_personil, status_aktif)
                 VALUES ('K-03', 'K-03', 'Dewi', 'Gudang', 1, 'Pegawai', 'Aktif');",
            )
            .expect("seed personil");
        let id = save_loan(
            &state,
            "bendahara",
            json!({ "id_karyawan": "K-03", "pokok": 2_000_000, "cicilan": 500_000, "mulai_potong": "2026-10" }),
        )
        .expect("ajukan")["id_pinjaman"]
            .as_str()
            .expect("id")
            .to_owned();
        decide_loan(&state, "kepala", &id, "setujui", None).expect("setujui");
        let cicilan = |bulan: &str| {
            pinjaman_aktif(&connection, bulan)
                .expect("aktif")
                .get("K-03")
                .map(|daftar| daftar[0].cicilan)
        };
        assert_eq!(cicilan("2026-10"), Some(500_000));

        // Minggu pertama gaji kurang: baru terpotong 300.000 ("sebagian").
        let proses = |id_run: &str, mulai: &str, status: &str, jumlah: i64| {
            connection
                .execute_batch(&format!(
                    "INSERT INTO payroll_runs (id, idempotency_key, period_start, period_end, status,
                         total_gross_payout, total_net_payout, total_employees, created_by, created_at, updated_at)
                     VALUES ('{id_run}', '{id_run}', '{mulai}', '{mulai}', '{status}', 0, 0, 1, 'a', 'x', 'x');
                     INSERT INTO payroll_items (id, payroll_run_id, id_karyawan, nama_karyawan, divisi,
                         total_regular_hours, total_overtime_hours, total_overtime_index, rate_per_hour,
                         basic_salary, overtime_salary, gross_salary, total_allowances, total_deductions,
                         bpjs_employee_total, bpjs_company_total, pph21_amount, net_salary,
                         breakdown_snapshot, created_at)
                     VALUES ('{id_run}-K-03', '{id_run}', 'K-03', 'Dewi', 'Gudang', 0, 0, 0, 0,
                         0, 0, 0, 0, {jumlah}, 0, 0, 0, 0,
                         '{{\"kasbon\":[{{\"id_pinjaman\":\"{id}\",\"jumlah\":{jumlah}}}]}}', 'x');"
                ))
                .expect("seed proses gaji");
        };
        proses("PR-W1", "2026-10-01", "DRAFT", 300_000);
        assert_eq!(cicilan("2026-10"), Some(200_000), "minggu kedua memotong kekurangannya");
        proses("PR-W2", "2026-10-08", "DRAFT", 200_000);
        assert_eq!(cicilan("2026-10"), None, "jatah Oktober sudah terpenuhi");
        // Periode 28 Okt - 3 Nov masuk Oktober (bulan tanggal mulai), jadi
        // tidak mengurangi jatah November.
        assert_eq!(cicilan("2026-11"), Some(500_000));

        // Proses yang ditolak mengembalikan jatahnya.
        connection
            .execute("UPDATE payroll_runs SET status = 'REJECTED' WHERE id = 'PR-W2';", [])
            .expect("tolak");
        assert_eq!(cicilan("2026-10"), Some(200_000));
    }

    #[test]
    fn pembatalan_membalik_pencairan() {
        let (_dir, state) = state_uji();
        let connection = storage::database(&state.data_dir).expect("db");
        connection
            .execute_batch(
                "INSERT INTO master_data (id_unik, kode_karyawan, nama, divisi, id_shift, jenis_personil, status_aktif)
                 VALUES ('K-02', 'K-02', 'Sari', 'TU', 1, 'Pegawai', 'Aktif');",
            )
            .expect("seed personil");
        let id = save_loan(
            &state,
            "bendahara",
            json!({ "id_karyawan": "K-02", "pokok": 500_000, "cicilan": 100_000, "mulai_potong": "2026-01" }),
        )
        .expect("ajukan")["id_pinjaman"]
            .as_str()
            .expect("id")
            .to_owned();
        let akun_salah = decide_loan(&state, "kepala", &id, "setujui", Some("akun-beban-gaji"))
            .expect_err("akun beban");
        assert_eq!(
            akun_salah.message,
            "Akun pembayaran harus akun aset yang aktif."
        );
        decide_loan(&state, "kepala", &id, "setujui", None).expect("setujui");
        decide_loan(&state, "kepala", &id, "batalkan", None).expect("batalkan");
        assert_eq!(saldo(&state, "akun-piutang-karyawan"), 0);
        assert_eq!(saldo(&state, "akun-kas"), 0);
    }
}
