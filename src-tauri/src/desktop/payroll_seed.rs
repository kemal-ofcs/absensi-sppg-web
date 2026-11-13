//! Tabel tarif default payroll — SATU sumber untuk SQLite lokal dan Turso cloud.
//!
//! Sebelumnya seed ditulis dua kali dengan tangan: `storage.rs` memakai id
//! bertanda hubung (`tax-p17-1`, `bpjs-jkk`) sedangkan `turso.rs` memakai
//! garis bawah (`tax_p17_1`, `bpjs_jkk_co`) dengan tarif dan tanggal berlaku
//! yang berbeda pula. Akibatnya baris seed lokal ikut terdorong ke cloud:
//! bracket PASAL_17 menjadi dobel, dan push BPJS selalu gagal karena
//! `component_code` UNIQUE sudah dipakai baris cloud dengan id berbeda.
//!
//! Menambah atau mengubah tarif default WAJIB dilakukan di berkas ini dan di
//! `validations/tarif-bawaan.json` (TER, Pasal 17, BPJS) saja.

use std::sync::OnceLock;

use rusqlite::{params, Connection};
use serde::Deserialize;
use serde_json::{json, Value};

/// Seed default `overtime_tier_rules`. Idempoten: `INSERT OR IGNORE`.
pub const OVERTIME_TIER_RULES_SEED_SQL: &str = r#"INSERT OR IGNORE INTO overtime_tier_rules (
    id, rule_type, tier_order, hour_start, hour_end, multiplier, is_active
) VALUES
    ('ot-work-1', 'HARI_KERJA', 1, 0.0, 1.0, 1.5, 1),
    ('ot-work-2', 'HARI_KERJA', 2, 1.0, NULL, 2.0, 1),
    ('ot-holiday-1', 'HARI_LIBUR', 1, 0.0, 8.0, 2.0, 1),
    ('ot-holiday-2', 'HARI_LIBUR', 2, 8.0, 9.0, 3.0, 1),
    ('ot-holiday-3', 'HARI_LIBUR', 3, 9.0, NULL, 4.0, 1);"#;

#[derive(Debug, Clone, Deserialize)]
pub struct TarifPajak {
    pub id: String,
    pub category: String,
    pub bracket_min: i64,
    pub bracket_max: Option<i64>,
    pub rate_percentage: f64,
    pub effective_date: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct TarifBpjs {
    pub id: String,
    pub component_code: String,
    pub component_name: String,
    pub rate_percentage: f64,
    pub wage_cap: Option<i64>,
    pub effective_date: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct PajakLama {
    pub id: String,
    pub bracket_min: i64,
    pub bracket_max: Option<i64>,
    pub rate_percentage: f64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct KoreksiV45 {
    pub pajak_lama: Vec<PajakLama>,
    pub jp_wage_cap_lama: i64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct TarifBawaan {
    pub pajak: Vec<TarifPajak>,
    pub bpjs: Vec<TarifBpjs>,
    /// Dibaca Web dan tes; Rust memakai `LEGACY_RATE_IDS` yang dijaga tes sama.
    #[cfg_attr(not(test), allow(dead_code))]
    pub id_lama: Vec<String>,
    pub koreksi_v45: KoreksiV45,
}

/// TER A/B/C, Pasal 17, dan BPJS bawaan dari berkas JSON yang SAMA dengan
/// yang diimpor `validations/tarif-bawaan.ts` (seed Web).
pub fn tarif_bawaan() -> &'static TarifBawaan {
    static TARIF: OnceLock<TarifBawaan> = OnceLock::new();
    TARIF.get_or_init(|| {
        serde_json::from_str(include_str!("../../../src/lib/validations/tarif-bawaan.json"))
            .expect("tarif-bawaan.json tidak valid")
    })
}

/// Cermin `TAX_RULES_SEED_SQL`. Idempoten: tarif yang disunting admin tidak ditimpa.
pub const TAX_RULES_SEED_SQL: &str = "INSERT OR IGNORE INTO tax_rules (id, category, bracket_min, bracket_max, rate_percentage, effective_date) VALUES (?1, ?2, ?3, ?4, ?5, ?6);";

/// Cermin `BPJS_RULES_SEED_SQL`. Kode yang sudah dipakai baris lain dilewati (UNIQUE).
pub const BPJS_RULES_SEED_SQL: &str = "INSERT OR IGNORE INTO bpjs_rules (id, component_code, component_name, rate_percentage, wage_cap, effective_date) VALUES (?1, ?2, ?3, ?4, ?5, ?6);";

/// Cermin `KOREKSI_PAJAK_SQL` (v45): lapis TER B/C seed lama diganti hanya
/// bila ketiga nilainya masih persis seed lama (Q-186 (a)).
pub const KOREKSI_PAJAK_SQL: &str = "UPDATE tax_rules SET bracket_min = ?1, bracket_max = ?2, rate_percentage = ?3 WHERE id = ?4 AND bracket_min = ?5 AND bracket_max IS ?6 AND rate_percentage = ?7;";

/// Cermin `KOREKSI_JP_SQL` (v45): batas upah JP hanya untuk baris yang masih
/// bernilai seed lama.
pub const KOREKSI_JP_SQL: &str = "UPDATE bpjs_rules SET wage_cap = ?1, effective_date = ?2 WHERE component_code = ?3 AND wage_cap = ?4;";

pub fn seed_pajak_args(tarif: &TarifPajak) -> Vec<Value> {
    vec![
        json!(tarif.id),
        json!(tarif.category),
        json!(tarif.bracket_min),
        json!(tarif.bracket_max),
        json!(tarif.rate_percentage),
        json!(tarif.effective_date),
    ]
}

pub fn seed_bpjs_args(tarif: &TarifBpjs) -> Vec<Value> {
    vec![
        json!(tarif.id),
        json!(tarif.component_code),
        json!(tarif.component_name),
        json!(tarif.rate_percentage),
        json!(tarif.wage_cap),
        json!(tarif.effective_date),
    ]
}

/// Argumen `KOREKSI_PAJAK_SQL` per lapis; nilai baru dari seed.
pub fn koreksi_pajak_args() -> Vec<Vec<Value>> {
    let tarif = tarif_bawaan();
    tarif
        .koreksi_v45
        .pajak_lama
        .iter()
        .map(|lama| {
            let baru = tarif
                .pajak
                .iter()
                .find(|baris| baris.id == lama.id)
                .expect("koreksi tanpa seed baru");
            vec![
                json!(baru.bracket_min),
                json!(baru.bracket_max),
                json!(baru.rate_percentage),
                json!(lama.id),
                json!(lama.bracket_min),
                json!(lama.bracket_max),
                json!(lama.rate_percentage),
            ]
        })
        .collect()
}

/// Argumen `KOREKSI_JP_SQL` untuk `JP_EMP` dan `JP_CO`.
pub fn koreksi_jp_args() -> Vec<Vec<Value>> {
    let tarif = tarif_bawaan();
    tarif
        .bpjs
        .iter()
        .filter(|baris| baris.component_code.starts_with("JP_"))
        .map(|baris| {
            vec![
                json!(baris.wage_cap),
                json!(baris.effective_date),
                json!(baris.component_code),
                json!(tarif.koreksi_v45.jp_wage_cap_lama),
            ]
        })
        .collect()
}

/// Menanam TER, Pasal 17, dan BPJS bawaan ke SQLite lokal. Tanpa outbox:
/// cloud menanam seed yang sama (lihat `DEFAULT_RATE_IDS`).
pub fn seed_tarif_lokal(connection: &Connection) -> rusqlite::Result<()> {
    let tarif = tarif_bawaan();
    let mut pajak = connection.prepare(TAX_RULES_SEED_SQL)?;
    for baris in &tarif.pajak {
        pajak.execute(params![
            baris.id,
            baris.category,
            baris.bracket_min,
            baris.bracket_max,
            baris.rate_percentage,
            baris.effective_date
        ])?;
    }
    let mut bpjs = connection.prepare(BPJS_RULES_SEED_SQL)?;
    for baris in &tarif.bpjs {
        bpjs.execute(params![
            baris.id,
            baris.component_code,
            baris.component_name,
            baris.rate_percentage,
            baris.wage_cap,
            baris.effective_date
        ])?;
    }
    Ok(())
}

/// Id baris default bawaan aplikasi, per tabel tarif.
///
/// Baris ini disediakan oleh seed di kedua sisi, jadi TIDAK boleh ikut
/// didorong ulang lewat backfill outbox — kalau ikut, instalasi baru akan
/// menimpa tarif yang sudah disesuaikan admin dengan nilai default.
pub const DEFAULT_RATE_IDS: &[&str] = &[
    "ot-work-1",
    "ot-work-2",
    "ot-holiday-1",
    "ot-holiday-2",
    "ot-holiday-3",
    "tax_p17_1",
    "tax_p17_2",
    "tax_p17_3",
    "tax_p17_4",
    "tax_p17_5",
    "tax_ter_a_1",
    "tax_ter_a_2",
    "tax_ter_a_3",
    "tax_ter_a_4",
    "tax_ter_a_5",
    "tax_ter_a_6",
    "tax_ter_a_7",
    "tax_ter_a_8",
    "tax_ter_a_9",
    "tax_ter_a_10",
    "tax_ter_a_11",
    "tax_ter_a_12",
    "tax_ter_a_13",
    "tax_ter_a_14",
    "tax_ter_a_15",
    "tax_ter_a_16",
    "tax_ter_a_17",
    "tax_ter_a_18",
    "tax_ter_a_19",
    "tax_ter_a_20",
    "tax_ter_a_21",
    "tax_ter_a_22",
    "tax_ter_a_23",
    "tax_ter_a_24",
    "tax_ter_a_25",
    "tax_ter_a_26",
    "tax_ter_a_27",
    "tax_ter_a_28",
    "tax_ter_a_29",
    "tax_ter_a_30",
    "tax_ter_a_31",
    "tax_ter_a_32",
    "tax_ter_a_33",
    "tax_ter_a_34",
    "tax_ter_a_35",
    "tax_ter_a_36",
    "tax_ter_a_37",
    "tax_ter_a_38",
    "tax_ter_a_39",
    "tax_ter_a_40",
    "tax_ter_a_41",
    "tax_ter_a_42",
    "tax_ter_a_43",
    "tax_ter_a_44",
    "tax_ter_b_1",
    "tax_ter_b_2",
    "tax_ter_b_3",
    "tax_ter_b_4",
    "tax_ter_b_5",
    "tax_ter_b_6",
    "tax_ter_b_7",
    "tax_ter_b_8",
    "tax_ter_b_9",
    "tax_ter_b_10",
    "tax_ter_b_11",
    "tax_ter_b_12",
    "tax_ter_b_13",
    "tax_ter_b_14",
    "tax_ter_b_15",
    "tax_ter_b_16",
    "tax_ter_b_17",
    "tax_ter_b_18",
    "tax_ter_b_19",
    "tax_ter_b_20",
    "tax_ter_b_21",
    "tax_ter_b_22",
    "tax_ter_b_23",
    "tax_ter_b_24",
    "tax_ter_b_25",
    "tax_ter_b_26",
    "tax_ter_b_27",
    "tax_ter_b_28",
    "tax_ter_b_29",
    "tax_ter_b_30",
    "tax_ter_b_31",
    "tax_ter_b_32",
    "tax_ter_b_33",
    "tax_ter_b_34",
    "tax_ter_b_35",
    "tax_ter_b_36",
    "tax_ter_b_37",
    "tax_ter_b_38",
    "tax_ter_b_39",
    "tax_ter_b_40",
    "tax_ter_c_1",
    "tax_ter_c_2",
    "tax_ter_c_3",
    "tax_ter_c_4",
    "tax_ter_c_5",
    "tax_ter_c_6",
    "tax_ter_c_7",
    "tax_ter_c_8",
    "tax_ter_c_9",
    "tax_ter_c_10",
    "tax_ter_c_11",
    "tax_ter_c_12",
    "tax_ter_c_13",
    "tax_ter_c_14",
    "tax_ter_c_15",
    "tax_ter_c_16",
    "tax_ter_c_17",
    "tax_ter_c_18",
    "tax_ter_c_19",
    "tax_ter_c_20",
    "tax_ter_c_21",
    "tax_ter_c_22",
    "tax_ter_c_23",
    "tax_ter_c_24",
    "tax_ter_c_25",
    "tax_ter_c_26",
    "tax_ter_c_27",
    "tax_ter_c_28",
    "tax_ter_c_29",
    "tax_ter_c_30",
    "tax_ter_c_31",
    "tax_ter_c_32",
    "tax_ter_c_33",
    "tax_ter_c_34",
    "tax_ter_c_35",
    "tax_ter_c_36",
    "tax_ter_c_37",
    "tax_ter_c_38",
    "tax_ter_c_39",
    "tax_ter_c_40",
    "tax_ter_c_41",
    "bpjs_jht_emp",
    "bpjs_jht_co",
    "bpjs_jp_emp",
    "bpjs_jp_co",
    "bpjs_jkk_co",
    "bpjs_jkm_co",
    "bpjs_kes_emp",
    "bpjs_kes_co",
];

/// Id seed keliru dari versi lama `storage.rs`, dibersihkan sekali di lokal
/// maupun cloud. Daftarnya sengaja eksplisit supaya pembersihan tidak pernah
/// menyentuh baris tarif yang dibuat admin.
pub const LEGACY_RATE_IDS: &[&str] = &[
    "tax-p17-1",
    "tax-p17-2",
    "tax-p17-3",
    "tax-p17-4",
    "tax-p17-5",
    "bpjs-jht-emp",
    "bpjs-jht-co",
    "bpjs-jp-emp",
    "bpjs-jp-co",
    "bpjs-jkk",
    "bpjs-jkm",
    "bpjs-kes-emp",
    "bpjs-kes-co",
];

#[cfg(test)]
mod tests {
    use super::*;

    /// Daftar id di berkas ini wajib sama dengan JSON yang dibaca Web.
    #[test]
    fn daftar_id_sama_dengan_tarif_bawaan_json() {
        let tarif = tarif_bawaan();
        let mut json_ids: Vec<&str> = tarif.pajak.iter().map(|t| t.id.as_str()).collect();
        json_ids.extend(tarif.bpjs.iter().map(|t| t.id.as_str()));
        let bawaan: Vec<&str> = DEFAULT_RATE_IDS
            .iter()
            .copied()
            .filter(|id| !id.starts_with("ot-"))
            .collect();
        assert_eq!(bawaan, json_ids);
        assert_eq!(
            LEGACY_RATE_IDS.to_vec(),
            tarif.id_lama.iter().map(String::as_str).collect::<Vec<_>>()
        );
    }

    /// PP 58/2023: TER A 44 lapis, B 40, C 41; lapis bersambung, tarif naik,
    /// dan hanya lapis terakhir tanpa batas atas.
    #[test]
    fn lapis_ter_lengkap_dan_bersambung() {
        let tarif = tarif_bawaan();
        for (kategori, jumlah, tertinggi) in [
            ("TER_A", 44, 1_400_000_000),
            ("TER_B", 40, 1_405_000_000),
            ("TER_C", 41, 1_419_000_000),
            ("PASAL_17", 5, 5_000_000_000),
        ] {
            let lapis: Vec<&TarifPajak> = tarif.pajak.iter().filter(|t| t.category == kategori).collect();
            assert_eq!(lapis.len(), jumlah, "{kategori}");
            assert_eq!(lapis[0].bracket_min, 0);
            for pasangan in lapis.windows(2) {
                assert_eq!(Some(pasangan[1].bracket_min), pasangan[0].bracket_max, "{}", pasangan[1].id);
                assert!(pasangan[1].rate_percentage > pasangan[0].rate_percentage, "{}", pasangan[1].id);
            }
            let akhir = lapis.last().expect("lapis");
            assert_eq!((akhir.bracket_min, akhir.bracket_max), (tertinggi, None));
        }
        assert_eq!(koreksi_pajak_args().len(), 55);
        assert_eq!(koreksi_jp_args().len(), 2);
    }
}
