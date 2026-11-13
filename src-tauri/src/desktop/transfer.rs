//! HRIS fase 12 (skema v44): berkas transfer gaji ke bank.
//!
//! `app_bank`, `app_bank_rekening`, dan `app_bank_format` KHUSUS CLOUD
//! (§27.2): tidak pernah ada di SQLite perangkat, tanpa outbox, dan tidak ikut
//! ke terminal scanner. Nominal berkas = `payroll_items.net_salary` apa adanya,
//! dijumlahkan sebagai bilangan bulat (aturan 13). Baris yang tidak bisa
//! ditransfer ditandai, tidak ditolak. Berkasnya sendiri dirender di TS, sama
//! untuk ketiga versi (§27.6).
//!
//! Aturan murninya cermin `src/lib/validations/transfer.ts` dan diuji dengan
//! vektor yang sama (`transfer.vektor.json`).

use std::collections::HashSet;
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use super::hr_keluar::{angka_baris, hari_ini_cloud, teks_baris, Baris};
use super::hris::{
    kunci_nama, nama_bentrok, nomor_identitas, objek, siap, tak_terhubung, MAKS_NAMA, MAKS_TEKS, PANJANG_REKENING,
};
use super::inventory::{invalid, is_valid_date, new_hex_id, payload_text};
use super::models::CommandError;
use super::turso::TursoClient;

/// Mengunduh berkas membuka nomor rekening semua karyawan: wajib KEDUANYA
/// (Q-157 (a)). Yang menandai dibayar adalah yang mentransfer.
pub const IZIN_UNDUH: [&str; 2] = ["payroll.run.disburse", "hr.finance.view"];
/// Rekening debet dan urutan kolom menentukan ke mana uang pergi (Q-173 (a)):
/// khusus Superadmin lewat `SUPERADMIN_ONLY_PERMISSIONS`.
pub const IZIN_PENGATURAN: &str = "payroll.config.manage";
/// Jenis isian `desktop_transfer_settings_save`.
pub const JENIS_PENGATURAN: [&str; 3] = ["bank", "rekening", "format"];

/// Satu bank bawaan. `kode` = kode bank BI 3 digit.
#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct BankBawaan {
    pub id_bank: String,
    pub nama: String,
    pub kode: Option<String>,
    pub alias: Vec<String>,
}

/// Bank bawaan dari berkas JSON yang SAMA dengan yang diimpor
/// `validations/transfer.ts`. Kode BI diverifikasi 13 Nov 2026; semuanya bisa
/// disunting di Pengaturan.
pub fn bank_bawaan() -> &'static [BankBawaan] {
    static BANK: OnceLock<Vec<BankBawaan>> = OnceLock::new();
    BANK.get_or_init(|| {
        serde_json::from_str(include_str!("../../../src/lib/validations/bank-bawaan.json"))
            .expect("bank-bawaan.json tidak valid")
    })
}

/// Cermin `SEED_BANK_SQL`. Bank yang sudah disunting tidak ditimpa.
pub const SEED_BANK_SQL: &str = "INSERT OR IGNORE INTO app_bank (id_bank, nama, kode, alias, is_bawaan) VALUES (?1, ?2, ?3, ?4, 1);";

pub fn seed_bank_args(bank: &BankBawaan) -> Vec<Value> {
    vec![
        json!(bank.id_bank),
        json!(bank.nama),
        json!(bank.kode),
        json!(serde_json::to_string(&bank.alias).expect("alias bank")),
    ]
}

// ── Konstanta ──────────────────────────────────────────────────────────────

pub const MAKS_ALIAS: usize = 20;
pub const MAKS_KOLOM_FORMAT: usize = 30;
pub const MAKS_JUDUL_KOLOM: usize = 60;
pub const MAKS_TEKS_KOLOM: usize = 100;
pub const MAKS_PANJANG_BERITA: i64 = 200;
/// WAJIB sama dengan CHECK `app_bank_format.jenis`.
pub const JENIS_BERKAS: [&str; 3] = ["csv", "txt", "xlsx"];
/// WAJIB sama dengan CHECK `app_bank_format.pemisah` (`char(9)` = tab).
pub const PEMISAH: [&str; 4] = [",", ";", "\t", "|"];
/// WAJIB sama dengan CHECK `app_bank_format.cakupan`.
pub const CAKUPAN: [&str; 3] = ["semua", "sesama", "antarbank"];
/// Isian yang boleh dipakai kolom format (§27.3).
pub const ISIAN_TRANSFER: [&str; 13] = ["nama_karyawan", "kode_karyawan", "nama_bank", "kode_bank", "no_rekening", "nama_rekening", "nominal", "berita", "rekening_debet", "nama_debet", "tanggal_efektif", "nomor_urut", "teks_tetap"];

// ── SQL kembar (harfiah di `validations/transfer.ts`) ──────────────────────

pub const BANK_SQL: &str = "SELECT id_bank, nama, kode, alias, is_aktif, is_bawaan, diubah_oleh, created_at, updated_at FROM app_bank ORDER BY is_aktif DESC, nama, id_bank;";
pub const REKENING_SQL: &str = "SELECT r.*, b.nama AS nama_bank, b.kode AS kode_bank, b.is_aktif AS bank_aktif FROM app_bank_rekening r LEFT JOIN app_bank b ON b.id_bank = r.id_bank ORDER BY r.is_aktif DESC, b.nama, r.no_rekening, r.id_rekening;";
pub const FORMAT_SQL: &str = "SELECT f.*, b.nama AS nama_bank FROM app_bank_format f LEFT JOIN app_bank b ON b.id_bank = f.id_bank ORDER BY f.is_aktif DESC, f.nama, f.id_format;";
pub const SIMPAN_BANK_SQL: &str = "INSERT INTO app_bank (id_bank, nama, kode, alias, is_aktif, diubah_oleh) VALUES (?1, ?2, ?3, ?4, ?5, ?6) ON CONFLICT(id_bank) DO UPDATE SET nama = excluded.nama, kode = excluded.kode, alias = excluded.alias, is_aktif = excluded.is_aktif, diubah_oleh = excluded.diubah_oleh, updated_at = datetime('now');";
pub const SIMPAN_REKENING_SQL: &str = "INSERT INTO app_bank_rekening (id_rekening, id_bank, no_rekening, nama_rekening, keterangan, is_aktif, diubah_oleh) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) ON CONFLICT(id_rekening) DO UPDATE SET id_bank = excluded.id_bank, no_rekening = excluded.no_rekening, nama_rekening = excluded.nama_rekening, keterangan = excluded.keterangan, is_aktif = excluded.is_aktif, diubah_oleh = excluded.diubah_oleh, updated_at = datetime('now');";
pub const SIMPAN_FORMAT_SQL: &str = "INSERT INTO app_bank_format (id_format, nama, id_bank, jenis, pemisah, pakai_judul, kutip, desimal, cakupan, kolom, maks_berita, is_aktif, diubah_oleh) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13) ON CONFLICT(id_format) DO UPDATE SET nama = excluded.nama, id_bank = excluded.id_bank, jenis = excluded.jenis, pemisah = excluded.pemisah, pakai_judul = excluded.pakai_judul, kutip = excluded.kutip, desimal = excluded.desimal, cakupan = excluded.cakupan, kolom = excluded.kolom, maks_berita = excluded.maks_berita, is_aktif = excluded.is_aktif, diubah_oleh = excluded.diubah_oleh, updated_at = datetime('now');";
pub const RUN_TRANSFER_SQL: &str = "SELECT id, period_start, period_end, status, total_net_payout, total_employees FROM payroll_runs WHERE id = ?1;";
/// Rekening dibaca saat mengunduh, tidak dibekukan di run (§27.9).
pub const BARIS_TRANSFER_SQL: &str = "SELECT i.id AS id_item, i.id_karyawan, i.nama_karyawan, m.kode_karyawan, i.net_salary, m.id_keluar, p.bank, p.no_rekening, p.nama_rekening FROM payroll_items i LEFT JOIN master_data m ON m.id_unik = i.id_karyawan LEFT JOIN hr_profil p ON p.id_karyawan = i.id_karyawan WHERE i.payroll_run_id = ?1 ORDER BY i.nama_karyawan, i.id;";
/// Jejak unduhan langsung di cloud (Q-156); status run tidak berubah.
pub const CATAT_UNDUH_SQL: &str = "INSERT INTO payroll_audit_logs (id, payroll_run_id, action, old_status, new_status, performed_by, notes) VALUES (?1, ?2, 'TRANSFER_EXPORT', ?3, ?3, ?4, ?5);";
pub const RIWAYAT_UNDUH_SQL: &str = "SELECT id, performed_by, notes, created_at FROM payroll_audit_logs WHERE payroll_run_id = ?1 AND action = 'TRANSFER_EXPORT' ORDER BY created_at DESC, id DESC;";

// ── Aturan murni ───────────────────────────────────────────────────────────

fn panjang(teks: &str) -> usize {
    teks.chars().count()
}

fn rapikan(teks: &str) -> String {
    teks.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Cermin `adaKendali`: karakter di bawah spasi (tab, baris baru).
fn ada_kendali(teks: &str) -> bool {
    teks.chars().any(|c| c < ' ')
}

/// Cermin `objekKetat`: objek dengan kunci dari `kolom` saja (aturan 37).
fn objek_ketat<'a>(draft: &'a Value, kolom: &[&str]) -> Result<&'a Map<String, Value>, String> {
    let objek = draft.as_object().ok_or("Isian tidak valid.")?;
    if let Some(kunci) = objek.keys().find(|k| !kolom.contains(&k.as_str())) {
        return Err(format!("Isian '{kunci}' tidak dikenal."));
    }
    Ok(objek)
}

/// Cermin `teksWajib`: spasi dirapikan, wajib, maksimal `maks`.
fn teks_wajib(draft: &Value, kunci: &str, label: &str, maks: usize) -> Result<String, String> {
    let teks = payload_text(draft, kunci)
        .map(|t| rapikan(&t))
        .ok_or_else(|| format!("{label} wajib diisi."))?;
    if panjang(&teks) > maks {
        return Err(format!("{label} maksimal {maks} karakter."));
    }
    Ok(teks)
}

/// Cermin `bendera`: true/false atau 0/1; absen atau null = `bawaan`.
fn bendera(draft: &Value, kunci: &str, label: &str, bawaan: i64) -> Result<i64, String> {
    match draft.get(kunci) {
        None | Some(Value::Null) => Ok(bawaan),
        Some(Value::Bool(b)) => Ok(i64::from(*b)),
        Some(v) => v.as_i64().filter(|n| *n == 0 || *n == 1).ok_or_else(|| format!("{label} tidak valid.")),
    }
}

/// Cermin `bacaAlias`: larik JSON teks; rusak = kosong.
pub fn baca_alias(teks: Option<&str>) -> Vec<String> {
    match serde_json::from_str::<Value>(teks.unwrap_or("[]")) {
        Ok(Value::Array(daftar)) => daftar.into_iter().filter_map(|v| v.as_str().map(str::to_owned)).collect(),
        _ => Vec::new(),
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct BankSah {
    pub nama: String,
    pub kode: Option<String>,
    pub alias: Vec<String>,
    pub is_aktif: i64,
}

/// Cermin `validasiBank`. `nama_lama` = nama tersimpan saat menyunting: bila
/// nama berubah, nama lama ditambahkan ke alias (Q-176) supaya profil
/// karyawan lama tetap cocok.
pub fn validasi_bank(draft: &Value, nama_lama: Option<&str>) -> Result<BankSah, String> {
    objek_ketat(draft, &["nama", "kode", "alias", "is_aktif"])?;
    let nama = teks_wajib(draft, "nama", "Nama bank", MAKS_NAMA)?;
    let kode = match draft.get("kode") {
        None | Some(Value::Null) => None,
        Some(Value::String(t)) => {
            let t = t.trim();
            if !t.is_empty() && !(t.chars().count() == 3 && t.chars().all(|c| c.is_ascii_digit())) {
                return Err("Kode bank harus 3 digit angka.".into());
            }
            Some(t.to_owned()).filter(|t| !t.is_empty())
        }
        Some(_) => return Err("Kode bank tidak valid.".into()),
    };
    let mentah: Vec<&str> = match draft.get("alias") {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(daftar)) => daftar.iter().map(Value::as_str).collect::<Option<_>>().ok_or("Alias tidak valid.")?,
        Some(_) => return Err("Alias tidak valid.".into()),
    };
    let mut alias = Vec::new();
    let mut dipakai = HashSet::from([kunci_nama(&nama)]);
    let mut tambah = |teks: &str| {
        let a = rapikan(teks);
        if !a.is_empty() && dipakai.insert(kunci_nama(&a)) {
            alias.push(a);
        }
    };
    for a in mentah {
        if panjang(&rapikan(a)) > MAKS_NAMA {
            return Err(format!("Alias maksimal {MAKS_NAMA} karakter."));
        }
        tambah(a);
    }
    if let Some(lama) = nama_lama {
        tambah(lama);
    }
    if alias.len() > MAKS_ALIAS {
        return Err(format!("Alias maksimal {MAKS_ALIAS} nama."));
    }
    let is_aktif = bendera(draft, "is_aktif", "Status aktif", 1)?;
    Ok(BankSah { nama, kode, alias, is_aktif })
}

/// Baris `app_bank` seperti dibaca `BANK_SQL`.
#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct BankBaris {
    pub id_bank: String,
    pub nama: String,
    #[serde(default)]
    pub kode: Option<String>,
    #[serde(default)]
    pub alias: Option<String>,
    pub is_aktif: i64,
}

/// Cermin `bankBentrok`: nama atau alias `sah` sudah dipakai nama atau alias
/// bank lain (nama unik ditegakkan aplikasi, §27.2). Hasil = nama bank lain itu.
pub fn bank_bentrok(id: Option<&str>, sah: &BankSah, bank: &[BankBaris]) -> Option<String> {
    let kunci: HashSet<String> = std::iter::once(&sah.nama).chain(&sah.alias).map(|n| kunci_nama(n)).collect();
    bank.iter()
        .filter(|b| Some(b.id_bank.as_str()) != id)
        .find(|b| {
            std::iter::once(b.nama.clone())
                .chain(baca_alias(b.alias.as_deref()))
                .any(|n| kunci.contains(&kunci_nama(&n)))
        })
        .map(|b| b.nama.clone())
}

/// Cermin `cocokBank`: teks `hr_profil.bank` → bank, lewat nama lalu alias
/// sesudah huruf besar kecil dan spasi dirapikan. Bank nonaktif tetap cocok;
/// pemanggil menandainya `bank_tidak_dikenal`.
pub fn cocok_bank<'a>(teks: Option<&str>, bank: &'a [BankBaris]) -> Option<&'a BankBaris> {
    let kunci = kunci_nama(teks.unwrap_or(""));
    if kunci.is_empty() {
        return None;
    }
    bank.iter().find(|b| kunci_nama(&b.nama) == kunci).or_else(|| {
        bank.iter()
            .find(|b| baca_alias(b.alias.as_deref()).iter().any(|a| kunci_nama(a) == kunci))
    })
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct RekeningSah {
    pub id_bank: String,
    pub no_rekening: String,
    pub nama_rekening: String,
    pub keterangan: Option<String>,
    pub is_aktif: i64,
}

/// Cermin `validasiRekening`: rekening debet perusahaan.
pub fn validasi_rekening(draft: &Value) -> Result<RekeningSah, String> {
    objek_ketat(draft, &["id_bank", "no_rekening", "nama_rekening", "keterangan", "is_aktif"])?;
    let id_bank = payload_text(draft, "id_bank").ok_or("Bank wajib dipilih.")?;
    let no = match draft.get("no_rekening") {
        None | Some(Value::Null) => None,
        Some(Value::String(t)) => Some(t.as_str()),
        Some(_) => return Err("Nomor rekening tidak valid.".into()),
    };
    let no_rekening = nomor_identitas(no, "Nomor rekening", &PANJANG_REKENING)?.ok_or("Nomor rekening wajib diisi.")?;
    let nama_rekening = teks_wajib(draft, "nama_rekening", "Nama pemilik rekening", MAKS_NAMA)?;
    let keterangan = payload_text(draft, "keterangan");
    if keterangan.as_deref().is_some_and(|k| panjang(k) > MAKS_TEKS) {
        return Err(format!("Keterangan maksimal {MAKS_TEKS} karakter."));
    }
    let is_aktif = bendera(draft, "is_aktif", "Status aktif", 1)?;
    Ok(RekeningSah { id_bank, no_rekening, nama_rekening, keterangan, is_aktif })
}

/// Baris `app_bank_rekening` yang dibandingkan `rekening_bentrok`.
#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct RekeningBaris {
    pub id_rekening: String,
    pub id_bank: String,
    pub no_rekening: String,
}

/// Cermin `rekeningBentrok`: bank + nomor yang sama sudah tercatat.
pub fn rekening_bentrok(id: Option<&str>, sah: &RekeningSah, rekening: &[RekeningBaris]) -> bool {
    rekening.iter().any(|r| {
        Some(r.id_rekening.as_str()) != id && r.id_bank == sah.id_bank && r.no_rekening == sah.no_rekening
    })
}

/// Satu kolom format. Urutan field = urutan kunci `kolomTeks`.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct KolomFormat {
    pub isian: String,
    pub judul: String,
    pub teks: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct FormatSah {
    pub nama: String,
    pub id_bank: Option<String>,
    pub jenis: String,
    pub pemisah: Option<String>,
    pub pakai_judul: i64,
    pub kutip: i64,
    pub desimal: i64,
    pub cakupan: String,
    pub kolom: Vec<KolomFormat>,
    pub maks_berita: Option<i64>,
    pub is_aktif: i64,
}

/// Teks opsional kolom: absen/null = kosong, bukan teks = galat.
fn teks_kolom(kolom: &Value, kunci: &str, pesan: String) -> Result<String, String> {
    match kolom.get(kunci) {
        None | Some(Value::Null) => Ok(String::new()),
        Some(Value::String(t)) => Ok(t.trim().to_owned()),
        Some(_) => Err(pesan),
    }
}

/// Cermin `validasiKolom`: larik kolom format, juga untuk membaca ulang `kolom`.
pub fn validasi_kolom(mentah: Option<&Value>) -> Result<Vec<KolomFormat>, String> {
    let daftar = mentah
        .and_then(Value::as_array)
        .filter(|d| !d.is_empty() && d.len() <= MAKS_KOLOM_FORMAT)
        .ok_or_else(|| format!("Format wajib punya 1–{MAKS_KOLOM_FORMAT} kolom."))?;
    let mut kolom = Vec::with_capacity(daftar.len());
    for (i, item) in daftar.iter().enumerate() {
        let ke = format!("Kolom ke-{}", i + 1);
        objek_ketat(item, &["isian", "judul", "teks"]).map_err(|e| format!("{ke}: {e}"))?;
        let isian = item
            .get("isian")
            .and_then(Value::as_str)
            .filter(|s| ISIAN_TRANSFER.contains(s))
            .ok_or_else(|| format!("{ke}: isian tidak dikenal."))?;
        let judul = teks_kolom(item, "judul", format!("{ke}: judul tidak valid."))?;
        if judul.is_empty() {
            return Err(format!("{ke}: judul wajib diisi."));
        }
        if panjang(&judul) > MAKS_JUDUL_KOLOM {
            return Err(format!("{ke}: judul maksimal {MAKS_JUDUL_KOLOM} karakter."));
        }
        if ada_kendali(&judul) {
            return Err(format!("{ke}: judul tidak boleh berisi tab atau baris baru."));
        }
        let teks = teks_kolom(item, "teks", format!("{ke}: teks tidak valid."))?;
        if isian != "teks_tetap" {
            if !teks.is_empty() {
                return Err(format!("{ke}: teks hanya untuk isian teks tetap."));
            }
            kolom.push(KolomFormat { isian: isian.to_owned(), judul, teks: None });
            continue;
        }
        if panjang(&teks) > MAKS_TEKS_KOLOM {
            return Err(format!("{ke}: teks maksimal {MAKS_TEKS_KOLOM} karakter."));
        }
        if ada_kendali(&teks) {
            return Err(format!("{ke}: teks tidak boleh berisi tab atau baris baru."));
        }
        kolom.push(KolomFormat { isian: isian.to_owned(), judul, teks: Some(teks) });
    }
    Ok(kolom)
}

/// Cermin `validasiFormat`: format kustom dari Pengaturan (§27.3).
pub fn validasi_format(draft: &Value) -> Result<FormatSah, String> {
    objek_ketat(
        draft,
        &["nama", "id_bank", "jenis", "pemisah", "pakai_judul", "kutip", "desimal", "cakupan", "kolom", "maks_berita", "is_aktif"],
    )?;
    let nama = teks_wajib(draft, "nama", "Nama format", MAKS_NAMA)?;
    let id_bank = payload_text(draft, "id_bank");
    let jenis = draft
        .get("jenis")
        .and_then(Value::as_str)
        .filter(|j| JENIS_BERKAS.contains(j))
        .ok_or("Jenis berkas tidak dikenal.")?
        .to_owned();
    // Pemisah tidak dipangkas: tab adalah spasi.
    let pemisah = match draft.get("pemisah") {
        None | Some(Value::Null) => None,
        Some(v) => Some(v),
    };
    let pemisah = if jenis == "xlsx" {
        if pemisah.is_some_and(|v| v.as_str() != Some("")) {
            return Err("Berkas Excel tidak memakai pemisah.".into());
        }
        None
    } else {
        Some(
            pemisah
                .and_then(Value::as_str)
                .filter(|p| PEMISAH.contains(p))
                .ok_or("Pemisah tidak dikenal.")?
                .to_owned(),
        )
    };
    let pakai_judul = bendera(draft, "pakai_judul", "Baris judul", 1)?;
    let kutip = bendera(draft, "kutip", "Kutip", 0)?;
    let desimal = bendera(draft, "desimal", "Desimal", 0)?;
    let cakupan = match draft.get("cakupan") {
        None | Some(Value::Null) => "semua",
        Some(v) => v.as_str().filter(|c| CAKUPAN.contains(c)).ok_or("Cakupan tidak dikenal.")?,
    }
    .to_owned();
    let kolom = validasi_kolom(draft.get("kolom"))?;
    let maks_berita = match draft.get("maks_berita") {
        None | Some(Value::Null) => None,
        Some(v) => Some(
            v.as_i64()
                .filter(|n| (1..=MAKS_PANJANG_BERITA).contains(n))
                .ok_or_else(|| format!("Panjang berita harus bilangan bulat 1–{MAKS_PANJANG_BERITA}."))?,
        ),
    };
    let is_aktif = bendera(draft, "is_aktif", "Status aktif", 1)?;
    Ok(FormatSah { nama, id_bank, jenis, pemisah, pakai_judul, kutip, desimal, cakupan, kolom, maks_berita, is_aktif })
}

/// Cermin `kolomTeks`: bentuk tersimpan `app_bank_format.kolom`.
pub fn kolom_teks(kolom: &[KolomFormat]) -> String {
    serde_json::to_string(kolom).expect("kolom format")
}

// ── Susun baris transfer ───────────────────────────────────────────────────

#[derive(Clone, Debug, Deserialize)]
pub struct ItemTransfer {
    pub id_karyawan: String,
    pub nama_karyawan: String,
    #[serde(default)]
    pub kode_karyawan: Option<String>,
    pub net_salary: i64,
    #[serde(default)]
    pub id_keluar: Option<String>,
    #[serde(default)]
    pub bank: Option<String>,
    #[serde(default)]
    pub no_rekening: Option<String>,
    #[serde(default)]
    pub nama_rekening: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct RunTransfer {
    pub period_start: String,
    pub period_end: String,
}

#[derive(Clone, Debug, Deserialize)]
pub struct DebetTransfer {
    pub id_bank: String,
    pub no_rekening: String,
    pub nama_rekening: String,
}

#[derive(Clone, Debug, Deserialize)]
pub struct IsianKolom {
    pub isian: String,
}

/// Bagian format yang menentukan isi baris; `None` = Excel umum.
#[derive(Clone, Debug, Deserialize)]
pub struct FormatSusun {
    pub cakupan: String,
    pub kolom: Vec<IsianKolom>,
    #[serde(default)]
    pub maks_berita: Option<i64>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct MasukanTransfer {
    pub run: RunTransfer,
    pub item: Vec<ItemTransfer>,
    pub bank: Vec<BankBaris>,
    pub debet: DebetTransfer,
    pub format: Option<FormatSusun>,
    pub tanggal_efektif: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct BarisTransfer {
    pub nomor_urut: Option<i64>,
    pub id_karyawan: String,
    pub nama_karyawan: String,
    pub kode_karyawan: Option<String>,
    pub nama_bank: Option<String>,
    pub kode_bank: Option<String>,
    pub no_rekening: Option<String>,
    pub nama_rekening: Option<String>,
    pub nominal: i64,
    pub jenis: Option<&'static str>,
    pub tanda: Vec<&'static str>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct Jumlah {
    pub jumlah: i64,
    pub total: i64,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct JumlahBank {
    pub nama_bank: String,
    pub jumlah: i64,
    pub total: i64,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct PerJenis {
    pub sesama: Jumlah,
    pub antarbank: Jumlah,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct RingkasanTransfer {
    pub jumlah_baris: i64,
    pub total: i64,
    pub total_run: i64,
    pub selisih: i64,
    pub jumlah_manual: i64,
    pub total_manual: i64,
    pub jumlah_luar_cakupan: i64,
    pub total_luar_cakupan: i64,
    pub per_bank: Vec<JumlahBank>,
    pub per_jenis: PerJenis,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct SusunanTransfer {
    pub berita: String,
    pub rekening_debet: String,
    pub nama_debet: String,
    pub tanggal_efektif: String,
    pub baris: Vec<BarisTransfer>,
    pub manual: Vec<BarisTransfer>,
    pub luar_cakupan: Vec<BarisTransfer>,
    pub ringkasan: RingkasanTransfer,
}

/// Cermin `beritaTransfer`: dipangkas per karakter ke `maks`.
pub fn berita_transfer(run: &RunTransfer, maks: Option<i64>) -> String {
    let teks = format!("Gaji {} s.d. {}", run.period_start, run.period_end);
    match maks {
        Some(n) => teks.chars().take(usize::try_from(n).unwrap_or(0)).collect(),
        None => teks,
    }
}

fn teks_ada(nilai: &Option<String>) -> Option<String> {
    nilai.as_deref().map(str::trim).filter(|t| !t.is_empty()).map(str::to_owned)
}

fn jumlahkan<'a>(daftar: impl IntoIterator<Item = &'a BarisTransfer>) -> Jumlah {
    daftar.into_iter().fold(Jumlah::default(), |j, r| Jumlah { jumlah: j.jumlah + 1, total: j.total + r.nominal })
}

/// Cermin `susunTransfer` (§27.3). Urutan pemeriksaan: tanda manual yang
/// tidak bergantung format, lalu cakupan, lalu `tanpa_kode_bank`. Baris di
/// luar cakupan bukan "manual": berkas lain (sesama/antarbank) memuatnya.
pub fn susun_transfer(masukan: &MasukanTransfer) -> SusunanTransfer {
    let format = masukan.format.as_ref();
    let pakai_kode = format.is_some_and(|f| f.kolom.iter().any(|k| k.isian == "kode_bank"));
    let cakupan = format.map_or("semua", |f| f.cakupan.as_str());
    let (mut baris, mut manual, mut luar) = (Vec::new(), Vec::new(), Vec::new());
    for it in &masukan.item {
        let no_rekening = teks_ada(&it.no_rekening);
        let nama_rekening = teks_ada(&it.nama_rekening);
        let teks_bank = teks_ada(&it.bank);
        let b = cocok_bank(teks_bank.as_deref(), &masukan.bank);
        let dikenal = b.filter(|b| b.is_aktif == 1);
        let jenis = dikenal.map(|b| if b.id_bank == masukan.debet.id_bank { "sesama" } else { "antarbank" });
        let mut tanda = Vec::new();
        if teks_bank.is_none() || no_rekening.is_none() {
            tanda.push("tanpa_rekening");
        } else if dikenal.is_none() {
            tanda.push("bank_tidak_dikenal");
        }
        if it.net_salary <= 0 {
            tanda.push("nominal_nol");
        }
        let keluar_cakupan = tanda.is_empty() && cakupan != "semua" && jenis != Some(cakupan);
        if tanda.is_empty() && !keluar_cakupan && pakai_kode && b.and_then(|b| b.kode.as_deref()).map_or(true, str::is_empty) {
            tanda.push("tanpa_kode_bank");
        }
        let masuk = tanda.is_empty() && !keluar_cakupan;
        if nama_rekening.as_deref().is_some_and(|n| kunci_nama(n) != kunci_nama(&it.nama_karyawan)) {
            tanda.push("nama_berbeda");
        }
        if teks_ada(&it.id_keluar).is_some() {
            tanda.push("karyawan_keluar");
        }
        let r = BarisTransfer {
            nomor_urut: masuk.then(|| baris.len() as i64 + 1),
            id_karyawan: it.id_karyawan.clone(),
            nama_karyawan: it.nama_karyawan.clone(),
            kode_karyawan: it.kode_karyawan.clone(),
            nama_bank: b.map(|b| b.nama.clone()).or(teks_bank),
            kode_bank: b.and_then(|b| b.kode.clone()),
            no_rekening,
            nama_rekening,
            nominal: it.net_salary,
            jenis,
            tanda,
        };
        if masuk {
            baris.push(r);
        } else if keluar_cakupan {
            luar.push(r);
        } else {
            manual.push(r);
        }
    }
    let mut per_bank: Vec<JumlahBank> = Vec::new();
    for r in &baris {
        let nama = r.nama_bank.clone().unwrap_or_default();
        match per_bank.iter_mut().find(|k| k.nama_bank == nama) {
            Some(k) => {
                k.jumlah += 1;
                k.total += r.nominal;
            }
            None => per_bank.push(JumlahBank { nama_bank: nama, jumlah: 1, total: r.nominal }),
        }
    }
    let isi = jumlahkan(&baris);
    let total_run: i64 = masukan.item.iter().map(|it| it.net_salary).sum();
    let m = jumlahkan(&manual);
    let l = jumlahkan(&luar);
    let per_jenis = PerJenis {
        sesama: jumlahkan(baris.iter().filter(|r| r.jenis == Some("sesama"))),
        antarbank: jumlahkan(baris.iter().filter(|r| r.jenis == Some("antarbank"))),
    };
    SusunanTransfer {
        berita: berita_transfer(&masukan.run, format.and_then(|f| f.maks_berita)),
        rekening_debet: masukan.debet.no_rekening.clone(),
        nama_debet: masukan.debet.nama_rekening.clone(),
        tanggal_efektif: masukan.tanggal_efektif.clone(),
        ringkasan: RingkasanTransfer {
            jumlah_baris: isi.jumlah,
            total: isi.total,
            total_run,
            selisih: total_run - isi.total,
            jumlah_manual: m.jumlah,
            total_manual: m.total,
            jumlah_luar_cakupan: l.jumlah,
            total_luar_cakupan: l.total,
            per_bank,
            per_jenis,
        },
        baris,
        manual,
        luar_cakupan: luar,
    }
}

// ── Bacaan dan tulisan cloud ───────────────────────────────────────────────

pub const PESAN_STATUS_RUN: &str = "Berkas transfer hanya untuk proses gaji yang sudah disetujui (APPROVED) atau dibayar (PAID).";
pub const PESAN_DEBET_NONAKTIF: &str = "Rekening debet tidak ditemukan atau sudah nonaktif.";
pub const PESAN_FORMAT_NONAKTIF: &str = "Format berkas tidak ditemukan atau sudah nonaktif.";
pub const PESAN_REKENING_GANDA: &str = "Rekening ini sudah tercatat.";
pub const PESAN_FORMAT_GANDA: &str = "Nama format sudah dipakai.";
/// Status run yang boleh diunduh berkasnya (Q-154 (a)).
pub const STATUS_RUN_TRANSFER: [&str; 2] = ["APPROVED", "PAID"];

/// Cermin `pesanBankGanda`.
pub fn pesan_bank_ganda(nama: &str) -> String {
    format!("Nama atau alias sudah dipakai bank {nama}.")
}

fn tak_ditemukan(apa: &str) -> CommandError {
    invalid(format!("{apa} tidak ditemukan."))
}

fn dari_baris<T: serde::de::DeserializeOwned>(baris: &[Baris]) -> Result<Vec<T>, CommandError> {
    serde_json::from_value(json!(baris)).map_err(|_| CommandError::internal())
}

fn aktif(baris: &Baris, kunci: &str) -> bool {
    angka_baris(baris, kunci) == 1
}

/// Baris bank untuk layar: `alias` sebagai larik.
fn bank_tampil(mut baris: Baris) -> Baris {
    let alias = baca_alias(baris.get("alias").and_then(Value::as_str));
    baris.insert("alias".into(), json!(alias));
    baris
}

/// Baris format untuk layar dan perender: `kolom` sebagai larik. Kolom yang
/// tidak lagi sah menjadi null, dan format itu tidak bisa dipakai mengunduh.
fn format_tampil(mut baris: Baris) -> Baris {
    let kolom = baris
        .get("kolom")
        .and_then(Value::as_str)
        .and_then(|t| serde_json::from_str::<Value>(t).ok())
        .and_then(|v| validasi_kolom(Some(&v)).ok());
    baris.insert("kolom".into(), json!(kolom));
    baris
}

/// Pengaturan transfer menurut izin pemanggil: `atur` = semua bank, rekening,
/// dan format; `unduh` = yang aktif saja (layar berkas transfer); selain itu
/// hanya bank aktif (isian profil keuangan, cukup sesi).
pub async fn pengaturan(turso: &TursoClient, atur: bool, unduh: bool) -> Result<Value, CommandError> {
    siap(turso).await?;
    let bank: Vec<Baris> = objek(turso, BANK_SQL, vec![])
        .await?
        .into_iter()
        .filter(|b| atur || aktif(b, "is_aktif"))
        .map(bank_tampil)
        .collect();
    let (rekening, format) = if atur || unduh {
        let rekening: Vec<Baris> = objek(turso, REKENING_SQL, vec![])
            .await?
            .into_iter()
            .filter(|r| atur || (aktif(r, "is_aktif") && aktif(r, "bank_aktif")))
            .collect();
        let format: Vec<Baris> = objek(turso, FORMAT_SQL, vec![])
            .await?
            .into_iter()
            .filter(|f| atur || aktif(f, "is_aktif"))
            .map(format_tampil)
            .collect();
        (rekening, format)
    } else {
        (Vec::new(), Vec::new())
    };
    Ok(json!({ "bank": bank, "rekening": rekening, "format": format, "atur": atur, "unduh": unduh }))
}

/// Bank harus ada; aktif kecuali tidak berubah dari yang tersimpan (pola
/// divisi pagu, §26.3).
async fn periksa_bank(turso: &TursoClient, id_bank: &str, tetap: bool) -> Result<(), CommandError> {
    let baris = objek(turso, "SELECT is_aktif FROM app_bank WHERE id_bank = ?1;", vec![json!(id_bank)])
        .await?
        .into_iter()
        .next()
        .ok_or_else(|| tak_ditemukan("Bank"))?;
    if !tetap && !aktif(&baris, "is_aktif") {
        return Err(invalid("Bank sudah nonaktif."));
    }
    Ok(())
}

/// Baris tersimpan berid `id` dari `daftar`; galat bila `id` diisi tetapi
/// tidak ditemukan.
fn baris_lama<'a>(daftar: &'a [Baris], kunci: &str, id: Option<&str>, apa: &str) -> Result<Option<&'a Baris>, CommandError> {
    let Some(id) = id else { return Ok(None) };
    daftar
        .iter()
        .find(|b| teks_baris(b, kunci).as_deref() == Some(id))
        .map(Some)
        .ok_or_else(|| tak_ditemukan(apa))
}

async fn tulis(turso: &TursoClient, sql: &str, args: Vec<Value>) -> Result<(), CommandError> {
    turso.query_one(sql, args).await.map_err(tak_terhubung)?;
    Ok(())
}

/// Simpan (termasuk nonaktifkan) satu bank, rekening debet, atau format.
/// Keunikan nama ditegakkan di sini, bukan di skema (§27.2). Ganti nama bank
/// menambah nama lamanya ke alias (Q-176) lewat `validasi_bank`.
pub async fn simpan_pengaturan(
    turso: &TursoClient,
    oleh: &str,
    jenis: &str,
    id: Option<&str>,
    draft: &Value,
) -> Result<Value, CommandError> {
    if !JENIS_PENGATURAN.contains(&jenis) {
        return Err(invalid("Jenis pengaturan tidak dikenal."));
    }
    siap(turso).await?;
    let id_baru = match jenis {
        "bank" => {
            let semua = objek(turso, BANK_SQL, vec![]).await?;
            let lama = baris_lama(&semua, "id_bank", id, "Bank")?;
            let sah = validasi_bank(draft, lama.and_then(|l| teks_baris(l, "nama")).as_deref()).map_err(invalid)?;
            if let Some(nama) = bank_bentrok(id, &sah, &dari_baris::<BankBaris>(&semua)?) {
                return Err(invalid(pesan_bank_ganda(&nama)));
            }
            let id = id.map_or_else(|| new_hex_id("bnk-"), str::to_owned);
            let alias = serde_json::to_string(&sah.alias).map_err(|_| CommandError::internal())?;
            let args = vec![json!(id), json!(sah.nama), json!(sah.kode), json!(alias), json!(sah.is_aktif), json!(oleh)];
            tulis(turso, SIMPAN_BANK_SQL, args).await?;
            id
        }
        "rekening" => {
            let semua = objek(turso, REKENING_SQL, vec![]).await?;
            let lama = baris_lama(&semua, "id_rekening", id, "Rekening")?;
            let sah = validasi_rekening(draft).map_err(invalid)?;
            let tetap = lama.and_then(|l| teks_baris(l, "id_bank")).as_deref() == Some(sah.id_bank.as_str());
            periksa_bank(turso, &sah.id_bank, tetap).await?;
            if rekening_bentrok(id, &sah, &dari_baris::<RekeningBaris>(&semua)?) {
                return Err(invalid(PESAN_REKENING_GANDA));
            }
            let id = id.map_or_else(|| new_hex_id("rek-"), str::to_owned);
            let args = vec![
                json!(id),
                json!(sah.id_bank),
                json!(sah.no_rekening),
                json!(sah.nama_rekening),
                json!(sah.keterangan),
                json!(sah.is_aktif),
                json!(oleh),
            ];
            tulis(turso, SIMPAN_REKENING_SQL, args).await?;
            id
        }
        _ => {
            let semua = objek(turso, FORMAT_SQL, vec![]).await?;
            let lama = baris_lama(&semua, "id_format", id, "Format")?;
            let sah = validasi_format(draft).map_err(invalid)?;
            if let Some(id_bank) = &sah.id_bank {
                let tetap = lama.and_then(|l| teks_baris(l, "id_bank")).as_deref() == Some(id_bank.as_str());
                periksa_bank(turso, id_bank, tetap).await?;
            }
            let nama: Vec<(String, String)> = semua
                .iter()
                .map(|f| (teks_baris(f, "id_format").unwrap_or_default(), teks_baris(f, "nama").unwrap_or_default()))
                .collect();
            if nama_bentrok(id, &sah.nama, &nama) {
                return Err(invalid(PESAN_FORMAT_GANDA));
            }
            let id = id.map_or_else(|| new_hex_id("fmt-"), str::to_owned);
            let args = vec![
                json!(id),
                json!(sah.nama),
                json!(sah.id_bank),
                json!(sah.jenis),
                json!(sah.pemisah),
                json!(sah.pakai_judul),
                json!(sah.kutip),
                json!(sah.desimal),
                json!(sah.cakupan),
                json!(kolom_teks(&sah.kolom)),
                json!(sah.maks_berita),
                json!(sah.is_aktif),
                json!(oleh),
            ];
            tulis(turso, SIMPAN_FORMAT_SQL, args).await?;
            id
        }
    };
    Ok(json!({ "sukses": true, "id": id_baru }))
}

/// Pilihan unduhan yang sudah divalidasi.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct PilihanTransfer {
    pub run_id: String,
    pub id_rekening: String,
    pub id_format: Option<String>,
    pub tanggal_efektif: Option<String>,
    pub catat: bool,
}

/// Cermin `validasiPilihanTransfer`. Format kosong = Excel umum.
pub fn validasi_pilihan_transfer(draft: &Value) -> Result<PilihanTransfer, String> {
    objek_ketat(draft, &["run_id", "id_rekening", "id_format", "tanggal_efektif", "catat"])?;
    let run_id = payload_text(draft, "run_id").ok_or("Proses gaji wajib dipilih.")?;
    let id_rekening = payload_text(draft, "id_rekening").ok_or("Rekening debet wajib dipilih.")?;
    let tanggal_efektif = payload_text(draft, "tanggal_efektif");
    if tanggal_efektif.as_deref().is_some_and(|t| !is_valid_date(t)) {
        return Err("Tanggal efektif tidak valid.".into());
    }
    let catat = match draft.get("catat") {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(_) => return Err("Catat unduhan tidak valid.".into()),
    };
    Ok(PilihanTransfer { run_id, id_rekening, id_format: payload_text(draft, "id_format"), tanggal_efektif, catat })
}

/// Baris berkas transfer satu run `APPROVED`/`PAID` (§27.3), rekening karyawan
/// dibaca SAAT INI dari `hr_profil`. `catat` = unduhan dicatat
/// `TRANSFER_EXPORT` langsung di cloud (Q-156); status run tidak berubah.
/// `riwayat` = unduhan SEBELUM permintaan ini, untuk peringatan unggahan
/// ganda (§27.4).
pub async fn berkas_transfer(turso: &TursoClient, oleh: &str, draft: &Value) -> Result<Value, CommandError> {
    let pilihan = validasi_pilihan_transfer(draft).map_err(invalid)?;
    siap(turso).await?;
    let run = objek(turso, RUN_TRANSFER_SQL, vec![json!(pilihan.run_id)])
        .await?
        .into_iter()
        .next()
        .ok_or_else(|| tak_ditemukan("Proses gaji"))?;
    let status = teks_baris(&run, "status").unwrap_or_default();
    if !STATUS_RUN_TRANSFER.contains(&status.as_str()) {
        return Err(invalid(PESAN_STATUS_RUN));
    }
    let debet = objek(turso, REKENING_SQL, vec![])
        .await?
        .into_iter()
        .find(|r| teks_baris(r, "id_rekening").as_deref() == Some(pilihan.id_rekening.as_str()))
        .filter(|r| aktif(r, "is_aktif") && aktif(r, "bank_aktif"))
        .ok_or_else(|| invalid(PESAN_DEBET_NONAKTIF))?;
    let format = match &pilihan.id_format {
        Some(id) => Some(
            objek(turso, FORMAT_SQL, vec![])
                .await?
                .into_iter()
                .find(|f| teks_baris(f, "id_format").as_deref() == Some(id.as_str()))
                .filter(|f| aktif(f, "is_aktif"))
                .map(format_tampil)
                .filter(|f| f.get("kolom").is_some_and(|k| !k.is_null()))
                .ok_or_else(|| invalid(PESAN_FORMAT_NONAKTIF))?,
        ),
        None => None,
    };
    let tanggal_efektif = match pilihan.tanggal_efektif {
        Some(t) => t,
        None => hari_ini_cloud(turso).await?,
    };
    let rusak = |_| CommandError::internal();
    let masukan = MasukanTransfer {
        run: serde_json::from_value(json!(run)).map_err(rusak)?,
        item: dari_baris(&objek(turso, BARIS_TRANSFER_SQL, vec![json!(pilihan.run_id)]).await?)?,
        bank: dari_baris(&objek(turso, BANK_SQL, vec![]).await?)?,
        debet: serde_json::from_value(json!(debet)).map_err(rusak)?,
        format: format.as_ref().map(|f| serde_json::from_value(json!(f))).transpose().map_err(rusak)?,
        tanggal_efektif,
    };
    let susunan = susun_transfer(&masukan);
    let riwayat = objek(turso, RIWAYAT_UNDUH_SQL, vec![json!(pilihan.run_id)]).await?;
    if pilihan.catat {
        // Kunci urut abjad: teksnya sama dengan `services/transfer.ts`, dengan
        // atau tanpa fitur `preserve_order` serde_json.
        let catatan = json!({
            "format": format.as_ref().and_then(|f| teks_baris(f, "nama")),
            "id_format": pilihan.id_format,
            "id_rekening": pilihan.id_rekening,
            "jumlah_baris": susunan.ringkasan.jumlah_baris,
            "rekening_debet": susunan.rekening_debet,
            "tanggal_efektif": susunan.tanggal_efektif,
            "total": susunan.ringkasan.total,
        });
        let args = vec![json!(new_hex_id("trf-")), json!(pilihan.run_id), json!(status), json!(oleh), json!(catatan.to_string())];
        tulis(turso, CATAT_UNDUH_SQL, args).await?;
    }
    Ok(json!({
        "run": run,
        "debet": debet,
        "format": format,
        "susunan": susunan,
        "riwayat": riwayat,
        "dicatat": pilihan.catat,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vektor() -> Value {
        serde_json::from_str(include_str!("../../../src/lib/validations/transfer.vektor.json")).expect("vektor")
    }

    fn hasil<T: Serialize>(r: Result<T, String>) -> Value {
        match r {
            Ok(nilai) => json!({ "ok": true, "nilai": nilai }),
            Err(pesan) => json!({ "ok": false, "pesan": pesan }),
        }
    }

    fn bank(v: &Value) -> Vec<BankBaris> {
        serde_json::from_value(v.clone()).expect("bank vektor")
    }

    #[test]
    fn transfer_bank_bawaan() {
        let bank = bank_bawaan();
        let kode: HashSet<_> = bank.iter().filter_map(|b| b.kode.as_deref()).collect();
        assert!(["014", "008", "451"].iter().all(|k| kode.contains(k)), "BCA, Mandiri, BSI wajib ada (Q-150)");
        assert_eq!(kode.len(), bank.len(), "kode bawaan unik");
        for b in bank {
            assert_eq!(b.id_bank, format!("bnk-{}", b.kode.as_deref().unwrap_or_default()));
            assert!(validasi_bank(&json!({ "nama": b.nama, "kode": b.kode, "alias": b.alias }), None).is_ok());
        }
        let baris: Vec<BankBaris> = bank
            .iter()
            .map(|b| BankBaris {
                id_bank: b.id_bank.clone(),
                nama: b.nama.clone(),
                kode: b.kode.clone(),
                alias: Some(serde_json::to_string(&b.alias).unwrap()),
                is_aktif: 1,
            })
            .collect();
        for b in bank {
            let sah = validasi_bank(&json!({ "nama": b.nama, "alias": b.alias }), None).unwrap();
            assert_eq!(bank_bentrok(Some(&b.id_bank), &sah, &baris), None, "nama/alias bawaan {} bentrok", b.nama);
        }
    }

    #[test]
    fn transfer_validasi_vektor_bersama() {
        let v = vektor();
        for k in v["bank"].as_array().unwrap() {
            assert_eq!(hasil(validasi_bank(&k["masukan"], k["nama_lama"].as_str())), k["harapan"], "bank {}", k["masukan"]);
        }
        for k in v["rekening"].as_array().unwrap() {
            assert_eq!(hasil(validasi_rekening(&k["masukan"])), k["harapan"], "rekening {}", k["masukan"]);
        }
        for k in v["format"].as_array().unwrap() {
            assert_eq!(hasil(validasi_format(&k["masukan"])), k["harapan"], "format {}", k["masukan"]);
        }
        for k in v["pilihan"].as_array().unwrap() {
            assert_eq!(hasil(validasi_pilihan_transfer(&k["masukan"])), k["harapan"], "pilihan {}", k["masukan"]);
        }
        for k in v["kolom_teks"].as_array().unwrap() {
            let kolom = validasi_kolom(Some(&k["kolom"])).expect("kolom vektor");
            assert_eq!(kolom_teks(&kolom), k["harapan"].as_str().unwrap());
        }
    }

    #[test]
    fn transfer_cocok_dan_bentrok_vektor_bersama() {
        let v = vektor();
        let daftar = bank(&v["cocok"]["bank"]);
        for k in v["cocok"]["kasus"].as_array().unwrap() {
            let id = cocok_bank(k["teks"].as_str(), &daftar).map(|b| b.id_bank.clone());
            assert_eq!(json!(id), k["harapan"], "cocok {}", k["teks"]);
        }
        for k in v["cocok"]["bentrok"].as_array().unwrap() {
            let sah = validasi_bank(&k["masukan"], None).expect("bank sah");
            assert_eq!(json!(bank_bentrok(k["id"].as_str(), &sah, &daftar)), k["harapan"], "bentrok {}", k["masukan"]);
        }
        let rekening: Vec<RekeningBaris> = serde_json::from_value(v["rekening_bentrok"]["rekening"].clone()).unwrap();
        for k in v["rekening_bentrok"]["kasus"].as_array().unwrap() {
            let sah = validasi_rekening(&k["masukan"]).expect("rekening sah");
            assert_eq!(json!(rekening_bentrok(k["id"].as_str(), &sah, &rekening)), k["harapan"]);
        }
        assert_eq!(baca_alias(Some("bukan json")), Vec::<String>::new());
        assert_eq!(baca_alias(Some(r#"["A", 1, "B"]"#)), vec!["A", "B"]);
        assert_eq!(baca_alias(None), Vec::<String>::new());
    }

    #[test]
    fn transfer_susun_vektor_bersama() {
        let v = vektor();
        let s = &v["susun"];
        for k in s["kasus"].as_array().unwrap() {
            let mut masukan = s.clone();
            masukan["format"] = k["format"].clone();
            let masukan: MasukanTransfer = serde_json::from_value(masukan).expect("masukan vektor");
            let susunan = susun_transfer(&masukan);
            assert_eq!(serde_json::to_value(&susunan).unwrap(), k["harapan"], "susun {}", k["nama"]);
            let total: i64 = susunan.baris.iter().map(|r| r.nominal).sum();
            assert_eq!(total, susunan.ringkasan.total);
            assert_eq!(
                susunan.ringkasan.total + susunan.ringkasan.total_manual + susunan.ringkasan.total_luar_cakupan,
                susunan.ringkasan.total_run,
                "setiap rupiah run ada di salah satu daftar"
            );
        }
    }

    /// Langkah 4 §27.8: Pengaturan simpan/nonaktifkan, ganti nama bank
    /// menambah alias, baris transfer dari run APPROVED/PAID, dan jejak
    /// `TRANSFER_EXPORT` langsung di cloud.
    #[test]
    fn transfer_cloud_pengaturan_dan_baris() {
        let runtime = tokio::runtime::Builder::new_current_thread().build().expect("runtime uji");
        runtime.block_on(async {
            let dir = tempfile::tempdir().expect("direktori sementara");
            let hub = dir.path().join("sppg-hub.db");
            let turso = TursoClient::local_file(
                url::Url::parse(super::super::turso::LOCAL_FILE_ORIGIN).expect("origin lokal"),
                &hub,
                reqwest::Client::new(),
            );
            turso.ensure_schema().await.expect("provisioning lokal");
            let conn = rusqlite::Connection::open(&hub).expect("buka hub");
            conn.execute_batch(
                "INSERT INTO master_data (id_unik, kode_karyawan, nama, divisi, jabatan_status, id_shift) VALUES
                   ('K1', 'EMP-1', 'Ana', 'Gudang', 'Staff', 1), ('K2', 'EMP-2', 'Budi', 'Gudang', 'Staff', 1),
                   ('K3', 'EMP-3', 'Citra', 'Gudang', 'Staff', 1), ('K4', 'EMP-4', 'Dedi', 'Gudang', 'Staff', 1);
                 UPDATE master_data SET id_keluar = 'klr-1' WHERE id_unik = 'K4';
                 INSERT INTO hr_profil (id_karyawan, bank, no_rekening, nama_rekening) VALUES
                   ('K1', 'Bank BCA', '1111111111', 'Ana'), ('K2', 'bca', '2222222222', 'Budi'),
                   ('K4', 'Bank Mandiri', '4444444444', 'Siti');
                 INSERT INTO payroll_runs (id, idempotency_key, period_start, period_end, status, created_by) VALUES
                   ('run-ok', 'k-ok', '2026-10-01', '2026-10-31', 'APPROVED', 'hrd'),
                   ('run-draf', 'k-draf', '2026-10-01', '2026-10-31', 'DRAFT', 'hrd');",
            )
            .expect("data awal");
            for (i, (id, nama, net)) in [("K1", "Ana", 5_000_000_i64), ("K2", "Budi", 4_000_000), ("K3", "Citra", 3_000_000), ("K4", "Dedi", 2_000_000)]
                .iter()
                .enumerate()
            {
                conn.execute(
                    "INSERT INTO payroll_items (id, payroll_run_id, id_karyawan, nama_karyawan, divisi, total_regular_hours, total_overtime_hours, total_overtime_index, rate_per_hour, basic_salary, overtime_salary, gross_salary, net_salary, breakdown_snapshot)
                     VALUES (?1, 'run-ok', ?2, ?3, 'Gudang', 0, 0, 0, 0, ?4, 0, ?4, ?4, '{}');",
                    rusqlite::params![format!("pi-{i}"), id, nama, net],
                )
                .expect("item gaji");
            }
            let angka = |sql: &str| -> i64 { conn.query_row(sql, [], |r| r.get(0)).unwrap() };
            let teks = |sql: &str| -> String { conn.query_row(sql, [], |r| r.get(0)).unwrap() };
            let galat = |hasil: Result<Value, CommandError>| hasil.expect_err("harus ditolak").message;
            let simpan = |jenis: &'static str, id: Option<String>, draft: Value| {
                let turso = &turso;
                async move { simpan_pengaturan(turso, "super", jenis, id.as_deref(), &draft).await }
            };

            // Bacaan cukup sesi: hanya bank aktif, tanpa rekening dan format.
            let awal = pengaturan(&turso, false, false).await.unwrap();
            assert_eq!(awal["bank"].as_array().unwrap().len(), bank_bawaan().len());
            assert_eq!((awal["rekening"].as_array().unwrap().len(), awal["format"].as_array().unwrap().len()), (0, 0));
            assert!(awal["bank"][0]["alias"].is_array(), "alias dikirim sebagai larik");

            // Ganti nama bank: nama lama masuk alias (Q-176), jadi profil "bca" tetap cocok.
            simpan("bank", Some("bnk-014".into()), json!({ "nama": "PT BCA", "kode": "014", "alias": ["Bank BCA", "Bank Central Asia"] }))
                .await
                .unwrap();
            let alias: Vec<String> = serde_json::from_str(&teks("SELECT alias FROM app_bank WHERE id_bank = 'bnk-014';")).unwrap();
            assert_eq!(alias, ["Bank BCA", "Bank Central Asia", "BCA"]);
            assert_eq!(teks("SELECT diubah_oleh FROM app_bank WHERE id_bank = 'bnk-014';"), "super");
            assert_eq!(galat(simpan("bank", None, json!({ "nama": "Baru", "alias": ["bca"] })).await), pesan_bank_ganda("PT BCA"));
            assert_eq!(galat(simpan("bank", Some("bnk-x".into()), json!({ "nama": "X" })).await), "Bank tidak ditemukan.");
            assert_eq!(galat(simpan("kartu", None, json!({})).await), "Jenis pengaturan tidak dikenal.");
            let kecil = simpan("bank", None, json!({ "nama": "Bank Kecil" })).await.unwrap()["id"].as_str().unwrap().to_owned();
            assert!(kecil.starts_with("bnk-"));
            assert_eq!(angka("SELECT COUNT(*) FROM app_bank WHERE is_bawaan = 0;"), 1);

            // Rekening debet: nomor dirapikan, ganda ditolak, bank nonaktif ditolak.
            let rek = simpan("rekening", None, json!({ "id_bank": "bnk-014", "no_rekening": "880 011 2233", "nama_rekening": "PT Contoh" }))
                .await
                .unwrap()["id"]
                .as_str()
                .unwrap()
                .to_owned();
            assert_eq!(teks("SELECT no_rekening FROM app_bank_rekening;"), "8800112233");
            assert_eq!(
                galat(simpan("rekening", None, json!({ "id_bank": "bnk-014", "no_rekening": "8800112233", "nama_rekening": "PT Contoh" })).await),
                PESAN_REKENING_GANDA
            );
            let rekening_kecil = json!({ "id_bank": kecil, "no_rekening": "12345", "nama_rekening": "PT Contoh" });
            let rek_kecil = simpan("rekening", None, rekening_kecil.clone()).await.unwrap()["id"].as_str().unwrap().to_owned();
            simpan("bank", None, json!({ "nama": "Bank Mati" })).await.unwrap();
            conn.execute("UPDATE app_bank SET is_aktif = 0 WHERE nama IN ('Bank Mati', 'Bank Kecil');", []).unwrap();
            let mati = teks("SELECT id_bank FROM app_bank WHERE nama = 'Bank Mati';");
            assert_eq!(
                galat(simpan("rekening", None, json!({ "id_bank": mati, "no_rekening": "99999", "nama_rekening": "PT" })).await),
                "Bank sudah nonaktif."
            );

            // Format: nama unik, validasi kembar, bank sasaran wajib ada.
            let kolom = json!([
                { "isian": "kode_bank", "judul": "Kode" },
                { "isian": "no_rekening", "judul": "Rek" },
                { "isian": "nominal", "judul": "Nominal" }
            ]);
            let format = json!({ "nama": "BCA sesama", "id_bank": "bnk-014", "jenis": "csv", "pemisah": ",", "cakupan": "sesama", "kolom": kolom });
            let fmt = simpan("format", None, format.clone()).await.unwrap()["id"].as_str().unwrap().to_owned();
            assert_eq!(galat(simpan("format", None, format.clone()).await), PESAN_FORMAT_GANDA);
            simpan("format", Some(fmt.clone()), format.clone()).await.expect("ubah format sendiri");
            assert_eq!(galat(simpan("format", None, json!({ "nama": "X", "jenis": "pdf", "kolom": kolom })).await), "Jenis berkas tidak dikenal.");
            assert_eq!(
                galat(simpan("format", None, json!({ "nama": "Y", "id_bank": "bnk-x", "jenis": "xlsx", "kolom": kolom })).await),
                "Bank tidak ditemukan."
            );
            let tersimpan: Vec<KolomFormat> = serde_json::from_str(&teks("SELECT kolom FROM app_bank_format;")).unwrap();
            assert_eq!(tersimpan.len(), 3);

            // Cakupan bacaan: atur = semua, unduh = yang aktif saja.
            let atur = pengaturan(&turso, true, false).await.unwrap();
            assert_eq!(atur["bank"].as_array().unwrap().len(), bank_bawaan().len() + 2);
            assert_eq!(atur["rekening"].as_array().unwrap().len(), 2);
            assert!(atur["format"][0]["kolom"].is_array());
            let unduh = pengaturan(&turso, false, true).await.unwrap();
            assert_eq!(unduh["rekening"].as_array().unwrap().len(), 1, "rekening berbank nonaktif disembunyikan");
            assert_eq!(unduh["format"].as_array().unwrap().len(), 1);

            // Berkas: status run, rekening debet, format.
            let berkas = |run: &str, rekening: &str, format: Value, catat: bool| {
                let turso = &turso;
                let draft = json!({ "run_id": run, "id_rekening": rekening, "id_format": format, "catat": catat });
                async move { berkas_transfer(turso, "super", &draft).await }
            };
            assert_eq!(galat(berkas("run-draf", &rek, Value::Null, false).await), PESAN_STATUS_RUN);
            assert_eq!(galat(berkas("run-x", &rek, Value::Null, false).await), "Proses gaji tidak ditemukan.");
            assert_eq!(galat(berkas("run-ok", &rek_kecil, Value::Null, false).await), PESAN_DEBET_NONAKTIF);
            assert_eq!(galat(berkas("run-ok", &rek, json!("fmt-x"), false).await), PESAN_FORMAT_NONAKTIF);
            assert_eq!(
                galat(berkas_transfer(&turso, "super", &json!({ "run_id": "run-ok", "id_rekening": rek, "lain": 1 })).await),
                "Isian 'lain' tidak dikenal."
            );

            let hasil = berkas("run-ok", &rek, json!(fmt), false).await.unwrap();
            let s = &hasil["susunan"];
            let nama = |daftar: &str| -> Vec<String> {
                s[daftar].as_array().unwrap().iter().map(|r| r["nama_karyawan"].as_str().unwrap().to_owned()).collect()
            };
            assert_eq!(nama("baris"), ["Ana", "Budi"], "profil 'bca' cocok lewat alias nama lama");
            assert_eq!(nama("manual"), ["Citra"]);
            assert_eq!(nama("luar_cakupan"), ["Dedi"]);
            assert_eq!(s["luar_cakupan"][0]["tanda"], json!(["nama_berbeda", "karyawan_keluar"]));
            assert_eq!((s["ringkasan"]["total"].as_i64(), s["ringkasan"]["total_run"].as_i64()), (Some(9_000_000), Some(14_000_000)));
            assert_eq!(s["rekening_debet"], "8800112233");
            assert!(is_valid_date(s["tanggal_efektif"].as_str().unwrap()), "bawaan = tanggal WIB jam database");
            assert_eq!(hasil["format"]["nama"], "BCA sesama");
            assert_eq!(angka("SELECT COUNT(*) FROM payroll_audit_logs;"), 0, "pratinjau tidak dicatat");

            // Unduhan dicatat; run tidak berubah; riwayat = unduhan sebelumnya.
            let pertama = berkas("run-ok", &rek, json!(fmt), true).await.unwrap();
            assert_eq!(pertama["riwayat"].as_array().unwrap().len(), 0);
            let (aksi, lama, baru, oleh, catatan): (String, String, String, String, String) = conn
                .query_row("SELECT action, old_status, new_status, performed_by, notes FROM payroll_audit_logs;", [], |r| {
                    Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
                })
                .unwrap();
            assert_eq!((aksi.as_str(), lama.as_str(), baru.as_str(), oleh.as_str()), ("TRANSFER_EXPORT", "APPROVED", "APPROVED", "super"));
            assert_eq!(
                catatan,
                format!(
                    r#"{{"format":"BCA sesama","id_format":"{fmt}","id_rekening":"{rek}","jumlah_baris":2,"rekening_debet":"8800112233","tanggal_efektif":"{}","total":9000000}}"#,
                    pertama["susunan"]["tanggal_efektif"].as_str().unwrap()
                ),
                "teks catatan sama dengan services/transfer.ts"
            );
            let catatan: Value = serde_json::from_str(&catatan).unwrap();
            assert_eq!((catatan["jumlah_baris"].as_i64(), catatan["total"].as_i64()), (Some(2), Some(9_000_000)));
            assert_eq!(catatan["format"], "BCA sesama");
            assert_eq!(teks("SELECT status FROM payroll_runs WHERE id = 'run-ok';"), "APPROVED");
            conn.execute("UPDATE payroll_runs SET status = 'PAID' WHERE id = 'run-ok';", []).unwrap();
            let kedua = berkas("run-ok", &rek, Value::Null, true).await.expect("PAID boleh diunduh ulang (Q-154)");
            assert_eq!(kedua["riwayat"].as_array().unwrap().len(), 1);
            assert_eq!(kedua["susunan"]["baris"].as_array().unwrap().len(), 3, "Excel umum memuat sesama dan antarbank");

            // Kolom rusak di database: format tidak bisa dipakai.
            conn.execute("UPDATE app_bank_format SET kolom = 'rusak';", []).unwrap();
            assert!(pengaturan(&turso, true, false).await.unwrap()["format"][0]["kolom"].is_null());
            assert_eq!(galat(berkas("run-ok", &rek, json!(fmt), false).await), PESAN_FORMAT_NONAKTIF);
        });
    }
}
