//! Notifikasi grup Telegram internal (schema v33).
//!
//! Kembar `validations/telegram.ts` + `services/telegram.ts`; aturan murninya
//! diuji dengan vektor yang sama di kedua bahasa. Bot hanya MENGIRIM: tidak ada
//! perintah atau tombol dari Telegram yang bisa mengubah data, karena itu akan
//! melewati login, 2FA, dan RBAC.
//!
//! Kejadian tidak dikaitkan ke setiap jalur simpan. Pengirim membaca datanya
//! langsung dari database yang dikonfigurasi (`SQL_*`) dan mencatatnya ke
//! `notifikasi_telegram` dengan id deterministik, jadi beberapa perangkat yang
//! berjalan bersamaan tidak pernah menggandakan pesan. Kedua tabelnya khusus
//! cloud: token bot tidak pernah tersalin ke perangkat.

use std::collections::HashMap;
use std::time::Duration;

use serde_json::{json, Value};

use super::{
    accounting::format_rupiah,
    inventory::format_jumlah,
    models::CommandError,
    turso::{Statement, TursoClient},
    tutup_buku::tanggal_tampil,
};

pub const BIDANG: [&str; 3] = ["inventaris", "keuangan", "pimpinan"];
pub const KEJADIAN: [&str; 7] = [
    "pengajuan_baru",
    "pengajuan_putus",
    "stok_menipis",
    "kasbon_baru",
    "tutup_buku",
    "gaji_status",
    "buka_buku_pimpinan",
];

/// Grup tujuan setiap kejadian. Cermin `BIDANG_KEJADIAN`.
pub fn bidang_kejadian(kejadian: &str) -> Option<&'static str> {
    match kejadian {
        "pengajuan_baru" | "kasbon_baru" | "tutup_buku" => Some("keuangan"),
        "pengajuan_putus" | "stok_menipis" => Some("inventaris"),
        "gaji_status" | "buka_buku_pimpinan" => Some("pimpinan"),
        _ => None,
    }
}

fn label_bidang(bidang: &str) -> &'static str {
    match bidang {
        "keuangan" => "Keuangan",
        "pimpinan" => "Pimpinan",
        _ => "Inventaris",
    }
}

const KUNCI_TOKEN: &str = "bot_token";
const KUNCI_AKTIF: &str = "aktif";
const KUNCI_AKTIF_SEJAK: &str = "aktif_sejak";
const JAM_RINGKASAN_STOK: i64 = 7;
const MAKS_BARIS_STOK: usize = 30;
const TELEGRAM_BATCH: i64 = 20;
const TELEGRAM_TIMEOUT: Duration = Duration::from_secs(15);
const TELEGRAM_THROTTLE: Duration = Duration::from_millis(1000);

// SQL di bawah DISALIN HARFIAH dari `validations/telegram.ts`.
const UPSERT_SETTING_SQL: &str = "INSERT INTO app_telegram_setting (kunci, nilai, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(kunci) DO UPDATE SET nilai = excluded.nilai, updated_at = excluded.updated_at;";
const INSERT_ANTREAN_SQL: &str = "INSERT OR IGNORE INTO notifikasi_telegram (id_notifikasi, kejadian, isi_pesan) VALUES (?, ?, ?);";

const SQL_PENGAJUAN_BARU: &str = "SELECT p.id_pengajuan, p.nomor, p.keperluan, p.cara_bayar,
       COALESCE(o.nama_operator, p.diajukan_oleh) AS pengaju,
       (SELECT COUNT(*) FROM inventory_pengajuan_baris b WHERE b.id_pengajuan = p.id_pengajuan) AS jumlah_baris,
       (SELECT COALESCE(SUM(CASE WHEN b.desimal = 1 THEN (b.jumlah * b.harga_satuan + 50) / 100 ELSE b.jumlah * b.harga_satuan END), 0) FROM inventory_pengajuan_baris b WHERE b.id_pengajuan = p.id_pengajuan) AS total
FROM inventory_pengajuan p
LEFT JOIN master_operator o ON o.username = p.diajukan_oleh
WHERE p.created_at >= ? AND p.created_at >= datetime('now', '-7 days')
  AND p.disetujui_pada IS NULL AND p.ditolak_pada IS NULL AND p.dibatalkan_pada IS NULL
  AND NOT EXISTS (SELECT 1 FROM notifikasi_telegram n WHERE n.id_notifikasi = 'pgj-baru:' || p.id_pengajuan)
ORDER BY p.created_at
LIMIT 50;";

const SQL_PENGAJUAN_PUTUS: &str = "SELECT p.id_pengajuan, p.nomor, p.keperluan,
       CASE WHEN p.disetujui_pada IS NOT NULL THEN 1 ELSE 0 END AS disetujui,
       COALESCE(o.nama_operator, p.disetujui_oleh, p.ditolak_oleh) AS pemutus,
       CASE WHEN p.disetujui_pada IS NOT NULL THEN p.catatan_persetujuan ELSE p.alasan_tolak END AS catatan,
       (SELECT COALESCE(SUM(CASE WHEN b.desimal = 1 THEN (b.jumlah * b.harga_satuan + 50) / 100 ELSE b.jumlah * b.harga_satuan END), 0) FROM inventory_pengajuan_baris b WHERE b.id_pengajuan = p.id_pengajuan) AS total
FROM inventory_pengajuan p
LEFT JOIN master_operator o ON o.username = COALESCE(p.disetujui_oleh, p.ditolak_oleh)
WHERE COALESCE(p.disetujui_pada, p.ditolak_pada) >= datetime(?, '+7 hours')
  AND COALESCE(p.disetujui_pada, p.ditolak_pada) >= datetime('now', '+7 hours', '-7 days')
  AND NOT EXISTS (SELECT 1 FROM notifikasi_telegram n WHERE n.id_notifikasi = 'pgj-putus:' || p.id_pengajuan)
ORDER BY COALESCE(p.disetujui_pada, p.ditolak_pada)
LIMIT 50;";

const SQL_STOK_MENIPIS: &str = "SELECT kode_barang, nama_barang, satuan, desimal, stok_minimum, stok_baik FROM (
  SELECT b.kode_barang, b.nama_barang, b.satuan, b.desimal, b.stok_minimum,
         COALESCE((SELECT SUM(s.saldo) FROM inventory_saldo s WHERE s.id_barang = b.id_barang AND s.kondisi = 'Baik'), 0) AS stok_baik
  FROM inventory_barang b
  WHERE b.status_aktif = 1 AND b.dihapus_pada IS NULL AND b.stok_minimum > 0
) WHERE stok_baik < stok_minimum
ORDER BY nama_barang COLLATE NOCASE
-- batas: satu baris per barang aktif yang stoknya di bawah minimum
;";

const SQL_KASBON_BARU: &str = "SELECT k.id_pinjaman, k.pokok, k.cicilan, k.mulai_potong
FROM keu_pinjaman k
WHERE k.created_at >= ? AND k.created_at >= datetime('now', '-7 days')
  AND k.status = 'Diajukan'
  AND NOT EXISTS (SELECT 1 FROM notifikasi_telegram n WHERE n.id_notifikasi = 'kasbon:' || k.id_pinjaman)
ORDER BY k.created_at
LIMIT 50;";

const SQL_TUTUP_BUKU: &str = "SELECT t.id_tutup, t.sampai_tanggal, t.status, COALESCE(o.nama_operator, t.dibuat_oleh) AS oleh
FROM keu_tutup_buku t
LEFT JOIN master_operator o ON o.username = t.dibuat_oleh
WHERE t.created_at >= ? AND t.created_at >= datetime('now', '-7 days')
  AND t.status IN ('Aktif', 'Menunggu')
  AND NOT EXISTS (SELECT 1 FROM notifikasi_telegram n WHERE n.id_notifikasi = 'tutup:' || t.id_tutup)
ORDER BY t.created_at
LIMIT 50;";

const SQL_BUKA_BUKU: &str = "SELECT t.id_tutup, t.sampai_tanggal, COALESCE(o.nama_operator, t.dibuka_oleh) AS oleh, t.alasan_buka
FROM keu_tutup_buku t
LEFT JOIN master_operator o ON o.username = t.dibuka_oleh
WHERE t.status = 'Dibuka'
  AND t.dibuka_pada >= datetime(?, '+7 hours') AND t.dibuka_pada >= datetime('now', '+7 hours', '-7 days')
  AND NOT EXISTS (SELECT 1 FROM notifikasi_telegram n WHERE n.id_notifikasi = ? || t.id_tutup)
ORDER BY t.dibuka_pada
LIMIT 50;";

const SQL_GAJI_STATUS: &str = "SELECT a.id, a.new_status, a.notes, r.period_start, r.period_end,
       r.total_employees, r.total_net_payout,
       COALESCE(o.nama_operator, a.performed_by) AS oleh
FROM payroll_audit_logs a
JOIN payroll_runs r ON r.id = a.payroll_run_id
LEFT JOIN master_operator o ON o.username = a.performed_by
WHERE a.action = 'TRANSITION_STATUS'
  AND a.new_status IN ('REVIEWED', 'APPROVED', 'PAID', 'REJECTED')
  AND datetime(a.created_at) >= datetime(?) AND datetime(a.created_at) >= datetime('now', '-7 days')
  AND NOT EXISTS (SELECT 1 FROM notifikasi_telegram n WHERE n.id_notifikasi = 'gaji:' || a.id)
ORDER BY datetime(a.created_at), a.id
LIMIT 50;";

/// Awalan id pesan "buku dibuka kembali": satu pembukaan menjadi dua pesan,
/// ke Keuangan dan ke Pimpinan. Cermin `AWALAN_BUKA*`.
const AWALAN_BUKA: &str = "buka:";
const AWALAN_BUKA_PIMPINAN: &str = "buka-pimpinan:";

const SQL_JAM_WIB: &str = "SELECT date('now', '+7 hours') AS tanggal, date('now', '+7 hours', '-1 day') AS kemarin, CAST(strftime('%H', 'now', '+7 hours') AS INTEGER) AS jam;";

// ── Aturan murni ────────────────────────────────────────────────────────────

/// Cermin `tokenBotValid`: `<id bot>:<rahasia>` dari BotFather.
pub fn token_bot_valid(token: &str) -> bool {
    let Some((id, rahasia)) = token.split_once(':') else {
        return false;
    };
    (5..=15).contains(&id.len())
        && id.bytes().all(|b| b.is_ascii_digit())
        && (30..=60).contains(&rahasia.len())
        && rahasia
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// Cermin `normalisasiChatId`. `Some("")` = grup belum diatur; `None` = bukan
/// id chat Telegram.
pub fn normalisasi_chat_id(raw: &str) -> Option<String> {
    let nilai = raw.trim();
    if nilai.is_empty() {
        return Some(String::new());
    }
    let digit = nilai.strip_prefix('-').unwrap_or(nilai);
    (!digit.is_empty() && digit.len() <= 20 && digit.bytes().all(|b| b.is_ascii_digit()))
        .then(|| nilai.to_owned())
}

/// Cermin `samarkanToken`: token bot ada di URL API, jadi pesan galat jaringan
/// bisa memuatnya.
pub fn samarkan_token(teks: &str, token: &str) -> String {
    if token.is_empty() {
        teks.to_owned()
    } else {
        teks.replace(token, "***")
    }
}

/// Cermin `potong`: dihitung per karakter, bukan byte.
pub fn potong(teks: &str, maks: usize) -> String {
    let teks = teks.trim();
    if teks.chars().count() <= maks {
        teks.to_owned()
    } else {
        format!("{}…", teks.chars().take(maks - 1).collect::<String>())
    }
}

/// Cermin `pesanPengajuanBaru`.
pub fn pesan_pengajuan_baru(
    nomor: &str,
    keperluan: &str,
    total: i64,
    jumlah_baris: i64,
    pengaju: &str,
    cara_bayar: &str,
) -> String {
    let mut baris = vec![
        format!("📦 Pengajuan pembelian baru: {nomor}"),
        format!("Keperluan: {}", potong(keperluan, 200)),
        format!("Total: {} ({jumlah_baris} barang)", format_rupiah(total)),
    ];
    if cara_bayar == "Cicilan" {
        baris.push("Cara bayar: Cicilan".to_owned());
    }
    baris.push(format!("Diajukan oleh: {pengaju}"));
    baris.push("Menunggu ACC di aplikasi.".to_owned());
    baris.join("\n")
}

/// Cermin `pesanPengajuanPutus`.
pub fn pesan_pengajuan_putus(
    nomor: &str,
    keperluan: &str,
    total: i64,
    disetujui: bool,
    pemutus: &str,
    catatan: &str,
) -> String {
    let mut baris = vec![
        if disetujui {
            format!("✅ Pengajuan {nomor} disetujui")
        } else {
            format!("❌ Pengajuan {nomor} ditolak")
        },
        format!("Keperluan: {}", potong(keperluan, 200)),
        format!("Total: {}", format_rupiah(total)),
        format!(
            "{} oleh: {pemutus}",
            if disetujui { "Disetujui" } else { "Ditolak" }
        ),
    ];
    if !catatan.trim().is_empty() {
        baris.push(format!(
            "{}: {}",
            if disetujui { "Catatan" } else { "Alasan" },
            potong(catatan, 300)
        ));
    }
    baris.join("\n")
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BarisStok {
    pub kode: String,
    pub nama: String,
    pub satuan: String,
    pub desimal: bool,
    pub stok: i64,
    pub minimum: i64,
}

/// Cermin `pesanStokMenipis`. Daftar kosong tidak menghasilkan pesan.
pub fn pesan_stok_menipis(daftar: &[BarisStok]) -> Option<String> {
    if daftar.is_empty() {
        return None;
    }
    let mut baris = vec![format!("⚠️ {} barang di bawah stok minimum", daftar.len())];
    for item in daftar.iter().take(MAKS_BARIS_STOK) {
        baris.push(format!(
            "• {} ({}): {} dari minimum {} {}",
            potong(&item.nama, 60),
            item.kode,
            format_jumlah(item.stok, item.desimal),
            format_jumlah(item.minimum, item.desimal),
            item.satuan
        ));
    }
    if daftar.len() > MAKS_BARIS_STOK {
        baris.push(format!(
            "dan {} barang lainnya.",
            daftar.len() - MAKS_BARIS_STOK
        ));
    }
    Some(baris.join("\n"))
}

const NAMA_BULAN: [&str; 12] = [
    "Januari", "Februari", "Maret", "April", "Mei", "Juni", "Juli", "Agustus", "September",
    "Oktober", "November", "Desember",
];

/// Cermin `labelBulan`: `2026-11` → `November 2026`; teks lain apa adanya.
pub fn label_bulan(periode: &str) -> String {
    let huruf: Vec<char> = periode.chars().collect();
    if huruf.len() == 7 && huruf[4] == '-' {
        let tahun: String = huruf[..4].iter().collect();
        let bulan: String = huruf[5..].iter().collect();
        if let (Ok(_), Ok(bulan)) = (tahun.parse::<u32>(), bulan.parse::<usize>()) {
            if (1..=12).contains(&bulan) {
                return format!("{} {tahun}", NAMA_BULAN[bulan - 1]);
            }
        }
    }
    periode.to_owned()
}

/// Cermin `TELEGRAM_BATAS_PERCOBAAN`.
const BATAS_PERCOBAAN: i64 = 3;

/// Status dan jumlah percobaan setelah gagal. Cermin `statusSetelahGagal`.
pub fn status_setelah_gagal(percobaan_sebelumnya: i64) -> (&'static str, i64) {
    let percobaan = percobaan_sebelumnya + 1;
    let status = if percobaan >= BATAS_PERCOBAAN {
        "Gagal"
    } else {
        "Menunggu"
    };
    (status, percobaan)
}

/// Cermin `pesanKasbonBaru`. Sengaja tanpa nama karyawan maupun pengaju.
pub fn pesan_kasbon_baru(pokok: i64, cicilan: i64, mulai_potong: &str) -> String {
    [
        "💰 Pengajuan kasbon baru".to_owned(),
        format!("Pokok: {}", format_rupiah(pokok)),
        format!(
            "Cicilan: {} per bulan, mulai potong gaji {}",
            format_rupiah(cicilan),
            label_bulan(mulai_potong)
        ),
        "Menunggu keputusan di aplikasi.".to_owned(),
    ]
    .join("\n")
}

/// Cermin `pesanTutupBuku`.
pub fn pesan_tutup_buku(sampai_tanggal: &str, oleh: &str, menunggu: bool) -> String {
    let mut baris = vec![
        format!("🔒 Buku ditutup sampai {}", tanggal_tampil(sampai_tanggal)),
        format!("Oleh: {oleh}"),
    ];
    if menunggu {
        baris.push("Bentrok dengan tutup buku lain, menunggu keputusan di aplikasi.".to_owned());
    }
    baris.join("\n")
}

/// Cermin `pesanBukaBuku`.
pub fn pesan_buka_buku(sampai_tanggal: &str, oleh: &str, alasan: &str) -> String {
    let mut baris = vec![
        format!(
            "🔓 Buku dibuka kembali (tutup sampai {})",
            tanggal_tampil(sampai_tanggal)
        ),
        format!("Oleh: {oleh}"),
    ];
    if !alasan.trim().is_empty() {
        baris.push(format!("Alasan: {}", potong(alasan, 300)));
    }
    baris.join("\n")
}

/// Cermin `permintaanKirim`. Teks polos, tanpa `parse_mode`: tanpa escape.
/// Cermin `MIN_PEGAWAI_NOMINAL_GAJI`: di bawahnya total bersih praktis sama
/// dengan gaji perorangan, jadi pesan hanya menyebut jumlah pegawai.
pub const MIN_PEGAWAI_NOMINAL_GAJI: i64 = 3;

/// Cermin `pesanGajiStatus`. Status di luar daftar tidak menghasilkan pesan.
/// Hanya jumlah pegawai dan total bersih (disembunyikan di bawah
/// `MIN_PEGAWAI_NOMINAL_GAJI`): tanpa nama, slip, potongan, kasbon.
pub fn pesan_gaji_status(
    status: &str,
    periode_awal: &str,
    periode_akhir: &str,
    pegawai: i64,
    total_bersih: i64,
    oleh: &str,
    catatan: &str,
) -> Option<String> {
    let frasa = match status {
        "REVIEWED" => "menunggu persetujuan",
        "APPROVED" => "disetujui",
        "PAID" => "sudah dibayar",
        "REJECTED" => "ditolak",
        _ => return None,
    };
    let mut baris = vec![
        format!(
            "💼 Proses gaji {}–{} {frasa}",
            tanggal_tampil(periode_awal),
            tanggal_tampil(periode_akhir)
        ),
        if pegawai < MIN_PEGAWAI_NOMINAL_GAJI {
            format!("{pegawai} pegawai")
        } else {
            format!(
                "{pegawai} pegawai · total bersih {}",
                format_rupiah(total_bersih)
            )
        },
        format!("Oleh: {oleh}"),
    ];
    if status == "REJECTED" && !catatan.trim().is_empty() {
        baris.push(format!("Alasan: {}", potong(catatan, 300)));
    }
    Some(baris.join("\n"))
}

pub fn permintaan_kirim(token: &str, chat_id: &str, teks: &str) -> (String, Value) {
    (
        format!("https://api.telegram.org/bot{token}/sendMessage"),
        json!({ "chat_id": chat_id, "text": teks, "disable_web_page_preview": true }),
    )
}

/// Cermin `galatTelegram`.
pub fn galat_telegram(status: u16, badan: &str) -> Option<String> {
    let data: Value = serde_json::from_str(badan).unwrap_or(Value::Null);
    if (200..300).contains(&status) && data.get("ok") == Some(&Value::Bool(true)) {
        return None;
    }
    let penjelasan = data
        .get("description")
        .and_then(Value::as_str)
        .filter(|teks| !teks.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| format!("HTTP {status}"));
    Some(format!("Telegram: {penjelasan}"))
}

/// Cermin `grupDariUpdates`.
pub fn grup_dari_updates(respons: &Value) -> Vec<(String, String)> {
    let mut daftar: Vec<(String, String)> = Vec::new();
    let Some(hasil) = respons.get("result").and_then(Value::as_array) else {
        return daftar;
    };
    for update in hasil {
        for jenis in ["message", "edited_message", "my_chat_member", "chat_member"] {
            let Some(isi) = update.get(jenis).filter(|isi| isi.is_object()) else {
                continue;
            };
            let Some(chat) = isi.get("chat") else {
                continue;
            };
            let tipe = chat.get("type").and_then(Value::as_str);
            if tipe != Some("group") && tipe != Some("supergroup") {
                continue;
            }
            let Some(id) = chat.get("id").and_then(Value::as_i64) else {
                continue;
            };
            let id = id.to_string();
            let status_baru = isi
                .get("new_chat_member")
                .and_then(|anggota| anggota.get("status"))
                .and_then(Value::as_str);
            let posisi = daftar.iter().position(|(ada, _)| *ada == id);
            if jenis == "my_chat_member" && matches!(status_baru, Some("left" | "kicked")) {
                if let Some(posisi) = posisi {
                    daftar.remove(posisi);
                }
                continue;
            }
            let judul = chat
                .get("title")
                .and_then(Value::as_str)
                .map(str::to_owned)
                .unwrap_or_else(|| id.clone());
            match posisi {
                Some(posisi) => daftar[posisi].1 = judul,
                None => daftar.push((id, judul)),
            }
        }
    }
    daftar
}

// ── I/O ─────────────────────────────────────────────────────────────────────

fn text(row: &HashMap<String, Value>, key: &str) -> String {
    match row.get(key) {
        Some(Value::String(value)) => value.trim().to_owned(),
        Some(Value::Null) | None => String::new(),
        Some(other) => other.to_string(),
    }
}

fn int(row: &HashMap<String, Value>, key: &str) -> i64 {
    match row.get(key) {
        Some(Value::Number(value)) => value
            .as_i64()
            .or_else(|| value.as_f64().map(|n| n as i64))
            .unwrap_or(0),
        Some(Value::String(value)) => value.trim().parse().unwrap_or(0),
        _ => 0,
    }
}

struct Pengaturan {
    nilai: HashMap<String, String>,
}

impl Pengaturan {
    fn get(&self, kunci: &str) -> &str {
        self.nilai.get(kunci).map(String::as_str).unwrap_or("")
    }
    fn aktif(&self) -> bool {
        self.get(KUNCI_AKTIF) == "1"
    }
    fn token(&self) -> &str {
        self.get(KUNCI_TOKEN)
    }
    fn grup(&self, bidang: &str) -> &str {
        self.get(&format!("grup:{bidang}"))
    }
    fn kirim(&self, kejadian: &str) -> bool {
        self.get(&format!("kirim:{kejadian}")) == "1"
    }
    /// Kejadian ini akan dikirim: sakelarnya menyala dan grupnya sudah diatur.
    fn siap(&self, kejadian: &str) -> bool {
        self.kirim(kejadian)
            && bidang_kejadian(kejadian).is_some_and(|bidang| !self.grup(bidang).is_empty())
    }
}

async fn baca_pengaturan(turso: &TursoClient) -> Result<Pengaturan, CommandError> {
    let rows = turso
        .query_one(
            "SELECT kunci, nilai FROM app_telegram_setting LIMIT 100;",
            vec![],
        )
        .await?
        .to_objects();
    Ok(Pengaturan {
        nilai: rows
            .iter()
            .map(|row| (text(row, "kunci"), text(row, "nilai")))
            .collect(),
    })
}

fn http_galat(error: reqwest::Error) -> String {
    format!("Telegram tidak dapat dihubungi: {}", error.without_url())
}

async fn kirim_pesan(
    http: &reqwest::Client,
    token: &str,
    chat_id: &str,
    teks: &str,
) -> Result<(), String> {
    let (url, body) = permintaan_kirim(token, chat_id, teks);
    let response = http
        .post(url)
        .json(&body)
        .timeout(TELEGRAM_TIMEOUT)
        .send()
        .await
        .map_err(http_galat)?;
    let status = response.status().as_u16();
    let badan = response.text().await.unwrap_or_default();
    match galat_telegram(status, &badan) {
        Some(galat) => Err(samarkan_token(&galat, token)),
        None => Ok(()),
    }
}

fn tidak_valid(pesan: &str) -> CommandError {
    CommandError::new("VALIDATION_ERROR", pesan)
}

/// Konfigurasi untuk kartu Pengaturan. Token TIDAK pernah dikembalikan: hanya
/// apakah ada dan empat karakter terakhirnya.
pub async fn get_config(turso: &TursoClient) -> Result<Value, CommandError> {
    turso.ensure_schema_current().await?;
    let pengaturan = baca_pengaturan(turso).await?;
    let token = pengaturan.token();
    let riwayat = turso
        .query_one(
            "SELECT id_notifikasi, kejadian, status, COALESCE(last_error, '') AS last_error, datetime(created_at, '+7 hours') AS dibuat, COALESCE(sent_at, '') AS sent_at FROM notifikasi_telegram ORDER BY created_at DESC, id_notifikasi DESC LIMIT 10;",
            vec![],
        )
        .await?
        .to_objects();
    let grup: serde_json::Map<String, Value> = BIDANG
        .iter()
        .map(|bidang| ((*bidang).to_owned(), json!(pengaturan.grup(bidang))))
        .collect();
    let kirim: serde_json::Map<String, Value> = KEJADIAN
        .iter()
        .map(|kejadian| ((*kejadian).to_owned(), json!(pengaturan.kirim(kejadian))))
        .collect();
    Ok(json!({
        "aktif": pengaturan.aktif(),
        "tokenTersimpan": !token.is_empty(),
        "tokenAkhir": token.chars().rev().take(4).collect::<Vec<_>>().into_iter().rev().collect::<String>(),
        "grup": grup,
        "kirim": kirim,
        "riwayat": riwayat.iter().map(|row| json!({
            "id": text(row, "id_notifikasi"),
            "kejadian": text(row, "kejadian"),
            "status": text(row, "status"),
            "galat": text(row, "last_error"),
            "dibuat": text(row, "dibuat"),
            "terkirim": text(row, "sent_at"),
        })).collect::<Vec<_>>(),
    }))
}

/// Draft tervalidasi: kunci sama persis dengan `TelegramConfigDraft`; kunci
/// asing atau yang hilang ditolak, bukan dianggap kosong.
struct Draft {
    aktif: bool,
    bot_token: String,
    grup: Vec<(&'static str, String)>,
    kirim: Vec<(&'static str, bool)>,
}

fn objek_persis<'a>(
    nilai: Option<&'a Value>,
    kunci: &[&str],
    nama: &str,
) -> Result<&'a serde_json::Map<String, Value>, CommandError> {
    let objek = nilai
        .and_then(Value::as_object)
        .ok_or_else(|| tidak_valid(&format!("Bagian '{nama}' wajib diisi.")))?;
    if objek.len() != kunci.len() || !kunci.iter().all(|k| objek.contains_key(*k)) {
        return Err(tidak_valid(&format!(
            "Bagian '{nama}' wajib berisi tepat: {}.",
            kunci.join(", ")
        )));
    }
    Ok(objek)
}

fn baca_draft(draft: &Value) -> Result<Draft, CommandError> {
    let akar = objek_persis(
        Some(draft),
        &["aktif", "botToken", "grup", "kirim"],
        "draft",
    )?;
    let aktif = akar["aktif"]
        .as_bool()
        .ok_or_else(|| tidak_valid("Nilai 'aktif' harus benar/salah."))?;
    let bot_token = akar["botToken"]
        .as_str()
        .ok_or_else(|| tidak_valid("Token bot harus berupa teks."))?
        .trim()
        .to_owned();
    if !bot_token.is_empty() && !token_bot_valid(&bot_token) {
        return Err(tidak_valid(
            "Token bot tidak valid. Salin utuh dari BotFather, contoh 123456789:AAH...",
        ));
    }
    let grup_objek = objek_persis(akar.get("grup"), &BIDANG, "grup")?;
    let mut grup = Vec::new();
    for bidang in BIDANG {
        let raw = grup_objek[bidang]
            .as_str()
            .ok_or_else(|| tidak_valid("Id grup harus berupa teks."))?;
        let id = normalisasi_chat_id(raw).ok_or_else(|| {
            tidak_valid(&format!(
                "Id grup {} tidak valid. Pakai tombol Cari grup.",
                label_bidang(bidang)
            ))
        })?;
        grup.push((bidang, id));
    }
    let kirim_objek = objek_persis(akar.get("kirim"), &KEJADIAN, "kirim")?;
    let mut kirim = Vec::new();
    for kejadian in KEJADIAN {
        let nyala = kirim_objek[kejadian]
            .as_bool()
            .ok_or_else(|| tidak_valid("Sakelar kejadian harus benar/salah."))?;
        kirim.push((kejadian, nyala));
    }
    Ok(Draft {
        aktif,
        bot_token,
        grup,
        kirim,
    })
}

pub async fn save_config(turso: &TursoClient, draft: &Value) -> Result<Value, CommandError> {
    let draft = baca_draft(draft)?;
    turso.ensure_schema_current().await?;
    let lama = baca_pengaturan(turso).await?;
    if draft.aktif && draft.bot_token.is_empty() && lama.token().is_empty() {
        return Err(tidak_valid(
            "Isi token bot lebih dulu sebelum mengaktifkan notifikasi Telegram.",
        ));
    }
    let setting = |kunci: &str, nilai: String| {
        Statement::new(UPSERT_SETTING_SQL, vec![json!(kunci), json!(nilai)])
    };
    let mut statements = vec![setting(
        KUNCI_AKTIF,
        if draft.aktif { "1" } else { "0" }.to_owned(),
    )];
    if !draft.bot_token.is_empty() {
        statements.push(setting(KUNCI_TOKEN, draft.bot_token.clone()));
    }
    // Kejadian sebelum Telegram dinyalakan tidak pernah dikirim.
    if draft.aktif && (!lama.aktif() || lama.get(KUNCI_AKTIF_SEJAK).is_empty()) {
        statements.push(Statement::new(
            "INSERT INTO app_telegram_setting (kunci, nilai, updated_at) VALUES (?, datetime('now'), datetime('now')) ON CONFLICT(kunci) DO UPDATE SET nilai = excluded.nilai, updated_at = excluded.updated_at;",
            vec![json!(KUNCI_AKTIF_SEJAK)],
        ));
    }
    for (bidang, id) in &draft.grup {
        statements.push(setting(&format!("grup:{bidang}"), id.clone()));
    }
    for (kejadian, nyala) in &draft.kirim {
        statements.push(setting(
            &format!("kirim:{kejadian}"),
            if *nyala { "1" } else { "0" }.to_owned(),
        ));
    }
    turso.execute_atomic(statements).await?;
    get_config(turso).await
}

async fn token_dipakai(turso: &TursoClient, dikirim: &str) -> Result<String, CommandError> {
    let dikirim = dikirim.trim();
    if !dikirim.is_empty() {
        if !token_bot_valid(dikirim) {
            return Err(tidak_valid("Token bot tidak valid."));
        }
        return Ok(dikirim.to_owned());
    }
    let pengaturan = baca_pengaturan(turso).await?;
    if pengaturan.token().is_empty() {
        return Err(tidak_valid("Isi token bot lebih dulu."));
    }
    Ok(pengaturan.token().to_owned())
}

/// Grup yang terlihat bot dalam 24 jam terakhir (`getUpdates`).
pub async fn find_groups(
    turso: &TursoClient,
    http: &reqwest::Client,
    bot_token: &str,
) -> Result<Value, CommandError> {
    turso.ensure_schema_current().await?;
    let token = token_dipakai(turso, bot_token).await?;
    let response = http
        .post(format!("https://api.telegram.org/bot{token}/getUpdates"))
        .json(&json!({}))
        .timeout(TELEGRAM_TIMEOUT)
        .send()
        .await
        .map_err(|error| CommandError::new("NETWORK_ERROR", http_galat(error)))?;
    let status = response.status().as_u16();
    let badan = response.text().await.unwrap_or_default();
    if let Some(galat) = galat_telegram(status, &badan) {
        return Err(CommandError::new(
            "TELEGRAM_ERROR",
            samarkan_token(&galat, &token),
        ));
    }
    let respons: Value = serde_json::from_str(&badan).unwrap_or(Value::Null);
    Ok(json!({
        "grup": grup_dari_updates(&respons)
            .into_iter()
            .map(|(id, judul)| json!({ "id": id, "judul": judul }))
            .collect::<Vec<_>>(),
    }))
}

/// Kirim pesan uji langsung, tanpa antrean, supaya hasilnya terlihat seketika.
pub async fn send_test(
    turso: &TursoClient,
    http: &reqwest::Client,
    draft: &Value,
) -> Result<Value, CommandError> {
    let akar = objek_persis(Some(draft), &["bidang", "chatId", "botToken"], "uji")?;
    let bidang = akar["bidang"].as_str().unwrap_or("");
    if !BIDANG.contains(&bidang) {
        return Err(tidak_valid("Bidang tidak dikenal."));
    }
    let chat_id = normalisasi_chat_id(akar["chatId"].as_str().unwrap_or(""))
        .filter(|id| !id.is_empty())
        .ok_or_else(|| tidak_valid("Id grup belum diisi atau tidak valid."))?;
    turso.ensure_schema_current().await?;
    let token = token_dipakai(turso, akar["botToken"].as_str().unwrap_or("")).await?;
    let teks = format!(
        "Pesan uji notifikasi Telegram. Grup ini akan menerima notifikasi bidang {}.",
        label_bidang(bidang)
    );
    kirim_pesan(http, &token, &chat_id, &teks)
        .await
        .map_err(|galat| CommandError::new("TELEGRAM_ERROR", galat))?;
    Ok(json!({ "terkirim": true }))
}

fn hasil(sukses: bool, angka: [i64; 4], pesan: impl Into<String>) -> Value {
    let [diproses, terkirim, gagal, dibatalkan] = angka;
    json!({
        "sukses": sukses,
        "diproses": diproses,
        "terkirim": terkirim,
        "gagal": gagal,
        "dibatalkan": dibatalkan,
        "pesan": pesan.into(),
    })
}

async fn antrekan(
    turso: &TursoClient,
    id: &str,
    kejadian: &str,
    isi: &str,
) -> Result<(), CommandError> {
    turso
        .query_one(
            INSERT_ANTREAN_SQL,
            vec![json!(id), json!(kejadian), json!(isi)],
        )
        .await?;
    Ok(())
}

/// Catat kejadian baru dari data ke antrean. Idempoten: id deterministik.
async fn catat_kejadian(turso: &TursoClient, pengaturan: &Pengaturan) -> Result<(), CommandError> {
    let sejak = pengaturan.get(KUNCI_AKTIF_SEJAK).to_owned();
    if sejak.is_empty() {
        return Ok(());
    }
    if pengaturan.siap("pengajuan_baru") {
        let rows = turso
            .query_one(SQL_PENGAJUAN_BARU, vec![json!(sejak)])
            .await?
            .to_objects();
        for row in rows {
            let isi = pesan_pengajuan_baru(
                &text(&row, "nomor"),
                &text(&row, "keperluan"),
                int(&row, "total"),
                int(&row, "jumlah_baris"),
                &text(&row, "pengaju"),
                &text(&row, "cara_bayar"),
            );
            let id = format!("pgj-baru:{}", text(&row, "id_pengajuan"));
            antrekan(turso, &id, "pengajuan_baru", &isi).await?;
        }
    }
    if pengaturan.siap("pengajuan_putus") {
        let rows = turso
            .query_one(SQL_PENGAJUAN_PUTUS, vec![json!(sejak)])
            .await?
            .to_objects();
        for row in rows {
            let isi = pesan_pengajuan_putus(
                &text(&row, "nomor"),
                &text(&row, "keperluan"),
                int(&row, "total"),
                int(&row, "disetujui") == 1,
                &text(&row, "pemutus"),
                &text(&row, "catatan"),
            );
            let id = format!("pgj-putus:{}", text(&row, "id_pengajuan"));
            antrekan(turso, &id, "pengajuan_putus", &isi).await?;
        }
    }
    if pengaturan.siap("kasbon_baru") {
        let rows = turso
            .query_one(SQL_KASBON_BARU, vec![json!(sejak)])
            .await?
            .to_objects();
        for row in rows {
            let isi = pesan_kasbon_baru(
                int(&row, "pokok"),
                int(&row, "cicilan"),
                &text(&row, "mulai_potong"),
            );
            let id = format!("kasbon:{}", text(&row, "id_pinjaman"));
            antrekan(turso, &id, "kasbon_baru", &isi).await?;
        }
    }
    if pengaturan.siap("tutup_buku") {
        let rows = turso
            .query_one(SQL_TUTUP_BUKU, vec![json!(sejak)])
            .await?
            .to_objects();
        for row in rows {
            let isi = pesan_tutup_buku(
                &text(&row, "sampai_tanggal"),
                &text(&row, "oleh"),
                text(&row, "status") == "Menunggu",
            );
            let id = format!("tutup:{}", text(&row, "id_tutup"));
            antrekan(turso, &id, "tutup_buku", &isi).await?;
        }
        catat_buka_buku(turso, &sejak, AWALAN_BUKA, "tutup_buku").await?;
    }
    if pengaturan.siap("buka_buku_pimpinan") {
        catat_buka_buku(turso, &sejak, AWALAN_BUKA_PIMPINAN, "buka_buku_pimpinan").await?;
    }
    if pengaturan.siap("gaji_status") {
        let rows = turso
            .query_one(SQL_GAJI_STATUS, vec![json!(sejak)])
            .await?
            .to_objects();
        for row in rows {
            let isi = pesan_gaji_status(
                &text(&row, "new_status"),
                &text(&row, "period_start"),
                &text(&row, "period_end"),
                int(&row, "total_employees"),
                int(&row, "total_net_payout"),
                &text(&row, "oleh"),
                &text(&row, "notes"),
            );
            if let Some(isi) = isi {
                let id = format!("gaji:{}", text(&row, "id"));
                antrekan(turso, &id, "gaji_status", &isi).await?;
            }
        }
    }
    catat_harian(turso, pengaturan).await
}

/// Cermin `catatBukaBuku`: awalan id menentukan grup tujuannya.
async fn catat_buka_buku(
    turso: &TursoClient,
    sejak: &str,
    awalan: &str,
    kejadian: &str,
) -> Result<(), CommandError> {
    let rows = turso
        .query_one(SQL_BUKA_BUKU, vec![json!(sejak), json!(awalan)])
        .await?
        .to_objects();
    for row in rows {
        let isi = pesan_buka_buku(
            &text(&row, "sampai_tanggal"),
            &text(&row, "oleh"),
            &text(&row, "alasan_buka"),
        );
        let id = format!("{awalan}{}", text(&row, "id_tutup"));
        antrekan(turso, &id, kejadian, &isi).await?;
    }
    Ok(())
}

async fn belum_tercatat(turso: &TursoClient, id: &str) -> Result<bool, CommandError> {
    Ok(turso
        .query_one(
            "SELECT 1 AS ada FROM notifikasi_telegram WHERE id_notifikasi = ? LIMIT 1;",
            vec![json!(id)],
        )
        .await?
        .to_objects()
        .is_empty())
}

/// Cermin `catatHarian`: ringkasan sekali per tanggal, mulai 07.00 WIB.
async fn catat_harian(turso: &TursoClient, pengaturan: &Pengaturan) -> Result<(), CommandError> {
    if !pengaturan.siap("stok_menipis") {
        return Ok(());
    }
    let jam = turso.query_one(SQL_JAM_WIB, vec![]).await?.to_objects();
    let Some(jam) = jam.first() else {
        return Ok(());
    };
    if int(jam, "jam") < JAM_RINGKASAN_STOK {
        return Ok(());
    }

    let id_stok = format!("stok:{}", text(jam, "tanggal"));
    if belum_tercatat(turso, &id_stok).await? {
        let daftar: Vec<BarisStok> = turso
            .query_one(SQL_STOK_MENIPIS, vec![])
            .await?
            .to_objects()
            .iter()
            .map(|row| BarisStok {
                kode: text(row, "kode_barang"),
                nama: text(row, "nama_barang"),
                satuan: text(row, "satuan"),
                desimal: int(row, "desimal") == 1,
                stok: int(row, "stok_baik"),
                minimum: int(row, "stok_minimum"),
            })
            .collect();
        if let Some(isi) = pesan_stok_menipis(&daftar) {
            antrekan(turso, &id_stok, "stok_menipis", &isi).await?;
        }
    }

    Ok(())
}

/// Satu siklus: catat kejadian baru, lalu kirim antrean `Menunggu`. Dipanggil
/// `AutoTelegramRunner` dari setiap sesi yang login; setiap baris diklaim
/// atomik (`klaim_oleh`/`klaim_sampai`) seperti antrean WA.
pub async fn drain(
    turso: &TursoClient,
    http: &reqwest::Client,
    sender_id: &str,
) -> Result<Value, CommandError> {
    turso.ensure_schema_current().await?;
    let pengaturan = baca_pengaturan(turso).await?;
    if !pengaturan.aktif() || pengaturan.token().is_empty() {
        return Ok(hasil(true, [0; 4], "Notifikasi Telegram belum aktif."));
    }
    let token = pengaturan.token().to_owned();

    turso
        .query_one(
            "DELETE FROM notifikasi_telegram WHERE status <> 'Menunggu' AND created_at < datetime('now', '-30 days');",
            vec![],
        )
        .await?;
    catat_kejadian(turso, &pengaturan).await?;

    let rows = turso
        .query_one(
            "SELECT id_notifikasi, kejadian, isi_pesan, attempt_count FROM notifikasi_telegram WHERE status = 'Menunggu' AND (klaim_sampai IS NULL OR klaim_sampai < datetime('now')) ORDER BY created_at ASC, id_notifikasi ASC LIMIT ?;",
            vec![json!(TELEGRAM_BATCH)],
        )
        .await?
        .to_objects();

    let (mut terkirim, mut gagal, mut dibatalkan) = (0, 0, 0);
    for row in &rows {
        let id = text(row, "id_notifikasi");
        let kejadian = text(row, "kejadian");
        let chat_id = bidang_kejadian(&kejadian)
            .filter(|_| pengaturan.kirim(&kejadian))
            .map(|bidang| pengaturan.grup(bidang).to_owned())
            .filter(|chat_id| !chat_id.is_empty());
        let Some(chat_id) = chat_id else {
            let changed = turso
                .query_one(
                    "UPDATE notifikasi_telegram SET status = 'Dibatalkan', last_error = ? WHERE id_notifikasi = ? AND status = 'Menunggu' AND (klaim_sampai IS NULL OR klaim_sampai < datetime('now'));",
                    vec![json!("Kejadian dimatikan atau grupnya belum diatur."), json!(id)],
                )
                .await?
                .rows_affected;
            dibatalkan += i64::from(changed > 0);
            continue;
        };

        let claimed = turso
            .query_one(
                "UPDATE notifikasi_telegram SET klaim_oleh = ?, klaim_sampai = datetime('now', '+5 minutes') WHERE id_notifikasi = ? AND status = 'Menunggu' AND (klaim_sampai IS NULL OR klaim_sampai < datetime('now'));",
                vec![json!(sender_id), json!(id)],
            )
            .await?
            .rows_affected;
        if claimed == 0 {
            continue;
        }

        match kirim_pesan(http, &token, &chat_id, &text(row, "isi_pesan")).await {
            Ok(()) => {
                turso
                    .query_one(
                        "UPDATE notifikasi_telegram SET status = 'Terkirim', sent_at = datetime('now', '+7 hours'), last_error = NULL, klaim_oleh = NULL, klaim_sampai = NULL WHERE id_notifikasi = ? AND klaim_oleh = ?;",
                        vec![json!(id), json!(sender_id)],
                    )
                    .await?;
                terkirim += 1;
            }
            Err(error) => {
                let (status, attempts) = status_setelah_gagal(int(row, "attempt_count"));
                turso
                    .query_one(
                        "UPDATE notifikasi_telegram SET status = ?, attempt_count = ?, last_error = ?, klaim_oleh = NULL, klaim_sampai = NULL WHERE id_notifikasi = ? AND klaim_oleh = ?;",
                        vec![
                            json!(status),
                            json!(attempts),
                            json!(potong(&error, 500)),
                            json!(id),
                            json!(sender_id),
                        ],
                    )
                    .await?;
                gagal += 1;
            }
        }
        tokio::time::sleep(TELEGRAM_THROTTLE).await;
    }

    Ok(hasil(
        true,
        [
            i64::try_from(rows.len()).unwrap_or(i64::MAX),
            terkirim,
            gagal,
            dibatalkan,
        ],
        format!("{terkirim} terkirim, {gagal} gagal, {dibatalkan} dibatalkan."),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    // Vektor yang sama diuji di `validations/telegram.test.ts`.
    #[test]
    fn token_dan_chat_id() {
        assert!(token_bot_valid(
            "123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw0"
        ));
        assert!(!token_bot_valid(
            "123456789AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw0"
        ));
        assert!(!token_bot_valid("12:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw0"));
        assert!(!token_bot_valid("123456789:pendek"));
        assert!(!token_bot_valid(
            "123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PAL Dsaw0"
        ));

        assert_eq!(normalisasi_chat_id("  "), Some(String::new()));
        assert_eq!(
            normalisasi_chat_id(" -1001234567890 "),
            Some("-1001234567890".to_owned())
        );
        assert_eq!(normalisasi_chat_id("12345"), Some("12345".to_owned()));
        assert_eq!(normalisasi_chat_id("-"), None);
        assert_eq!(normalisasi_chat_id("https://t.me/+abc"), None);
        assert_eq!(normalisasi_chat_id("@grupku"), None);
    }

    #[test]
    fn samarkan_dan_potong() {
        assert_eq!(
            samarkan_token("gagal ke /bot123:ABC/sendMessage dan 123:ABC", "123:ABC"),
            "gagal ke /bot***/sendMessage dan ***"
        );
        assert_eq!(samarkan_token("apa adanya", ""), "apa adanya");
        assert_eq!(potong("  pendek  ", 10), "pendek");
        assert_eq!(potong("ééééé", 5), "ééééé");
        assert_eq!(potong("ééééééé", 5), "éééé…");
    }

    #[test]
    fn isi_pesan_pengajuan() {
        assert_eq!(
            pesan_pengajuan_baru("PB-2026-0012", "Alat tulis", 2_450_000, 6, "Sarpras", "Tunai"),
            "📦 Pengajuan pembelian baru: PB-2026-0012\nKeperluan: Alat tulis\nTotal: Rp2.450.000 (6 barang)\nDiajukan oleh: Sarpras\nMenunggu ACC di aplikasi."
        );
        assert_eq!(
            pesan_pengajuan_baru("PB-1", "Laptop", 9_000_000, 1, "Budi", "Cicilan"),
            "📦 Pengajuan pembelian baru: PB-1\nKeperluan: Laptop\nTotal: Rp9.000.000 (1 barang)\nCara bayar: Cicilan\nDiajukan oleh: Budi\nMenunggu ACC di aplikasi."
        );
        assert_eq!(
            pesan_pengajuan_putus("PB-1", "Laptop", 9_000_000, true, "Bendahara", ""),
            "✅ Pengajuan PB-1 disetujui\nKeperluan: Laptop\nTotal: Rp9.000.000\nDisetujui oleh: Bendahara"
        );
        assert_eq!(
            pesan_pengajuan_putus("PB-1", "Laptop", 9_000_000, false, "Bendahara", "Anggaran habis"),
            "❌ Pengajuan PB-1 ditolak\nKeperluan: Laptop\nTotal: Rp9.000.000\nDitolak oleh: Bendahara\nAlasan: Anggaran habis"
        );
    }

    #[test]
    fn isi_pesan_stok() {
        assert_eq!(pesan_stok_menipis(&[]), None);
        let barang = |i: usize| BarisStok {
            kode: format!("BRG-{i}"),
            nama: "Kertas A4".to_owned(),
            satuan: "rim".to_owned(),
            desimal: false,
            stok: 3,
            minimum: 10,
        };
        assert_eq!(
            pesan_stok_menipis(&[
                barang(1),
                BarisStok {
                    kode: "BRG-2".to_owned(),
                    nama: "Cairan pel".to_owned(),
                    satuan: "liter".to_owned(),
                    desimal: true,
                    stok: 150,
                    minimum: 500,
                },
            ]),
            Some("⚠️ 2 barang di bawah stok minimum\n• Kertas A4 (BRG-1): 3 dari minimum 10 rim\n• Cairan pel (BRG-2): 1,50 dari minimum 5 liter".to_owned())
        );
        let banyak: Vec<BarisStok> = (1..=32).map(barang).collect();
        let pesan = pesan_stok_menipis(&banyak).unwrap();
        assert!(pesan.starts_with("⚠️ 32 barang di bawah stok minimum\n"));
        assert!(
            pesan.ends_with("• Kertas A4 (BRG-30): 3 dari minimum 10 rim\ndan 2 barang lainnya.")
        );
    }

    #[test]
    fn permintaan_dan_galat() {
        let (url, body) = permintaan_kirim("1:A", "-100", "Halo");
        assert_eq!(url, "https://api.telegram.org/bot1:A/sendMessage");
        assert_eq!(
            body,
            json!({ "chat_id": "-100", "text": "Halo", "disable_web_page_preview": true })
        );
        assert_eq!(galat_telegram(200, r#"{"ok":true,"result":{}}"#), None);
        assert_eq!(
            galat_telegram(
                400,
                r#"{"ok":false,"error_code":400,"description":"Bad Request: chat not found"}"#
            ),
            Some("Telegram: Bad Request: chat not found".to_owned())
        );
        assert_eq!(
            galat_telegram(502, "<html>"),
            Some("Telegram: HTTP 502".to_owned())
        );
        assert_eq!(
            galat_telegram(200, r#"{"ok":false}"#),
            Some("Telegram: HTTP 200".to_owned())
        );
    }

    #[test]
    fn grup_dari_get_updates() {
        let respons = json!({
            "ok": true,
            "result": [
                { "update_id": 1, "my_chat_member": {
                    "chat": { "id": -100111, "title": "Inventaris", "type": "supergroup" },
                    "new_chat_member": { "status": "member" } } },
                { "update_id": 2, "message": {
                    "chat": { "id": 555, "first_name": "Budi", "type": "private" }, "text": "/start" } },
                { "update_id": 3, "message": {
                    "chat": { "id": -222, "title": "Keuangan", "type": "group" }, "text": "/start" } },
                { "update_id": 4, "edited_message": {
                    "chat": { "id": -100111, "title": "Inventaris Kantor", "type": "supergroup" } } },
                { "update_id": 5, "my_chat_member": {
                    "chat": { "id": -333, "title": "Lama", "type": "group" },
                    "new_chat_member": { "status": "member" } } },
                { "update_id": 6, "my_chat_member": {
                    "chat": { "id": -333, "title": "Lama", "type": "group" },
                    "new_chat_member": { "status": "kicked" } } },
                { "update_id": 7, "message": { "chat": { "id": "-444", "type": "group" } } }
            ]
        });
        assert_eq!(
            grup_dari_updates(&respons),
            vec![
                ("-100111".to_owned(), "Inventaris Kantor".to_owned()),
                ("-222".to_owned(), "Keuangan".to_owned()),
            ]
        );
        assert!(grup_dari_updates(&json!({ "ok": false })).is_empty());
    }

    // Vektor yang sama diuji di `validations/telegram.test.ts`.
    #[test]
    fn isi_pesan_keuangan() {
        assert_eq!(label_bulan("2026-01"), "Januari 2026");
        assert_eq!(label_bulan("2026-13"), "2026-13");
        assert_eq!(label_bulan(""), "");
        assert_eq!(status_setelah_gagal(0), ("Menunggu", 1));
        assert_eq!(status_setelah_gagal(1), ("Menunggu", 2));
        assert_eq!(status_setelah_gagal(2), ("Gagal", 3));
        assert_eq!(
            pesan_kasbon_baru(2_000_000, 500_000, "2026-12"),
            "💰 Pengajuan kasbon baru\nPokok: Rp2.000.000\nCicilan: Rp500.000 per bulan, mulai potong gaji Desember 2026\nMenunggu keputusan di aplikasi."
        );
        assert_eq!(
            pesan_tutup_buku("2026-09-30", "Bendahara", false),
            "🔒 Buku ditutup sampai 30/09/2026\nOleh: Bendahara"
        );
        assert_eq!(
            pesan_tutup_buku("2026-09-30", "Bendahara", true),
            "🔒 Buku ditutup sampai 30/09/2026\nOleh: Bendahara\nBentrok dengan tutup buku lain, menunggu keputusan di aplikasi."
        );
        assert_eq!(
            pesan_buka_buku("2026-09-30", "Kepala TU", "Salah input jurnal"),
            "🔓 Buku dibuka kembali (tutup sampai 30/09/2026)\nOleh: Kepala TU\nAlasan: Salah input jurnal"
        );
        assert_eq!(
            pesan_buka_buku("2026-09-30", "Kepala TU", " "),
            "🔓 Buku dibuka kembali (tutup sampai 30/09/2026)\nOleh: Kepala TU"
        );
    }

    // Vektor yang sama diuji di `validations/telegram.test.ts`.
    #[test]
    fn isi_pesan_gaji() {
        assert_eq!(
            pesan_gaji_status("REVIEWED", "2026-10-01", "2026-10-31", 42, 187_400_000, "Bendahara", ""),
            Some("💼 Proses gaji 01/10/2026–31/10/2026 menunggu persetujuan\n42 pegawai · total bersih Rp187.400.000\nOleh: Bendahara".to_owned())
        );
        assert_eq!(
            pesan_gaji_status("PAID", "2026-09-26", "2026-10-25", 40, 150_000_000, "Bendahara", "transfer"),
            Some("💼 Proses gaji 26/09/2026–25/10/2026 sudah dibayar\n40 pegawai · total bersih Rp150.000.000\nOleh: Bendahara".to_owned())
        );
        assert_eq!(
            pesan_gaji_status("REJECTED", "2026-10-01", "2026-10-31", 42, 187_400_000, "Direktur", "Lembur belum diverifikasi"),
            Some("💼 Proses gaji 01/10/2026–31/10/2026 ditolak\n42 pegawai · total bersih Rp187.400.000\nOleh: Direktur\nAlasan: Lembur belum diverifikasi".to_owned())
        );
        assert_eq!(
            pesan_gaji_status("SUBMITTED", "2026-10-01", "2026-10-31", 42, 1, "x", ""),
            None
        );
        assert_eq!(
            pesan_gaji_status("APPROVED", "2026-10-01", "2026-10-31", 2, 9_000_000, "Direktur", ""),
            Some("💼 Proses gaji 01/10/2026–31/10/2026 disetujui\n2 pegawai\nOleh: Direktur".to_owned())
        );
        assert_eq!(
            pesan_gaji_status("APPROVED", "2026-10-01", "2026-10-31", 3, 9_000_000, "Direktur", ""),
            Some("💼 Proses gaji 01/10/2026–31/10/2026 disetujui\n3 pegawai · total bersih Rp9.000.000\nOleh: Direktur".to_owned())
        );
    }

    #[test]
    fn pemetaan_kejadian() {
        assert_eq!(bidang_kejadian("pengajuan_baru"), Some("keuangan"));
        assert_eq!(bidang_kejadian("pengajuan_putus"), Some("inventaris"));
        assert_eq!(bidang_kejadian("stok_menipis"), Some("inventaris"));
        assert_eq!(bidang_kejadian("kasbon_baru"), Some("keuangan"));
        assert_eq!(bidang_kejadian("tutup_buku"), Some("keuangan"));
        assert_eq!(bidang_kejadian("gaji_status"), Some("pimpinan"));
        assert_eq!(bidang_kejadian("buka_buku_pimpinan"), Some("pimpinan"));
        assert_eq!(bidang_kejadian("gaji"), None);
    }

    #[test]
    fn draft_wajib_lengkap() {
        let sah = json!({
            "aktif": true,
            "botToken": "",
            "grup": { "inventaris": "-100111", "keuangan": "", "pimpinan": "-100333" },
            "kirim": {
                "pengajuan_baru": true, "pengajuan_putus": false, "stok_menipis": true,
                "kasbon_baru": true, "tutup_buku": false,
                "gaji_status": true, "buka_buku_pimpinan": false,
            },
        });
        let draft = baca_draft(&sah).unwrap();
        assert!(draft.aktif);
        assert_eq!(
            draft.grup,
            vec![
                ("inventaris", "-100111".to_owned()),
                ("keuangan", String::new()),
                ("pimpinan", "-100333".to_owned())
            ]
        );
        assert_eq!(
            draft.kirim,
            vec![
                ("pengajuan_baru", true),
                ("pengajuan_putus", false),
                ("stok_menipis", true),
                ("kasbon_baru", true),
                ("tutup_buku", false),
                ("gaji_status", true),
                ("buka_buku_pimpinan", false)
            ]
        );

        let mut asing = sah.clone();
        asing["is_active"] = json!(true);
        assert!(baca_draft(&asing).is_err());
        let mut kurang = sah.clone();
        kurang["kirim"]
            .as_object_mut()
            .unwrap()
            .remove("stok_menipis");
        assert!(baca_draft(&kurang).is_err());
        let mut grup_salah = sah.clone();
        grup_salah["grup"]["keuangan"] = json!("t.me/abc");
        assert!(baca_draft(&grup_salah).is_err());
        let mut token_salah = sah;
        token_salah["botToken"] = json!("bukan-token");
        assert!(baca_draft(&token_salah).is_err());
    }
}
