//! Hari kerja mingguan dan hari libur massal.
//!
//! Libur mingguan adalah ATURAN, bukan baris `tbl_hari_libur`: karyawan
//! mengikuti `tbl_shift.hari_kerja`. Libur nasional tetap data per tanggal.
//!
//! Cermin `src/lib/validations/hari-kerja.ts`; keduanya diuji dengan vektor
//! yang sama, termasuk pesan galatnya.

use serde_json::Value;

use super::time_policy;

/// Bawaan kolom `tbl_shift.hari_kerja`: tujuh hari, perilaku sebelum v50.
pub const HARI_KERJA_SEMUA: &str = "1,2,3,4,5,6,7";

pub const JENIS_LIBUR: [&str; 3] = ["Libur Nasional", "Cuti Bersama", "Libur Khusus"];

/// Batas satu kali simpan; rentang dan impor setahun jauh di bawahnya.
pub const MAKS_LIBUR_MASSAL: usize = 120;

/// Cermin `validateHariKerja`: hasilnya teks kanonik terurut (`"1,2,3,4,5"`),
/// satu-satunya bentuk yang boleh tersimpan karena payroll membacanya lewat
/// `instr()`.
pub fn validate_hari_kerja(nilai: &Value) -> Result<String, String> {
    let daftar = match nilai.as_array() {
        Some(daftar) if !daftar.is_empty() => daftar,
        _ => return Err("Pilih minimal satu hari kerja.".into()),
    };
    let mut hari = Vec::with_capacity(daftar.len());
    for item in daftar {
        // `as_f64` menerima `1` maupun `1.0`, sama dengan `Number.isInteger`.
        match item.as_f64() {
            Some(h) if h.fract() == 0.0 && (1.0..=7.0).contains(&h) => hari.push(h as i64),
            _ => return Err("Hari kerja harus angka 1 (Senin) sampai 7 (Minggu).".into()),
        }
    }
    hari.sort_unstable();
    if hari.windows(2).any(|w| w[0] == w[1]) {
        return Err("Hari kerja tidak boleh ganda.".into());
    }
    Ok(hari
        .iter()
        .map(i64::to_string)
        .collect::<Vec<_>>()
        .join(","))
}

/// Cermin `parseHariKerja`: kosong atau rusak berarti tujuh hari, supaya
/// shift lama tidak tiba-tiba punya hari libur.
pub fn parse_hari_kerja(tersimpan: Option<&str>) -> Vec<i64> {
    let bagian: Vec<&str> = tersimpan.unwrap_or("").split(',').map(str::trim).collect();
    let angka: Vec<Value> = if bagian
        .iter()
        .all(|s| s.len() == 1 && ('1'..='7').contains(&s.chars().next().unwrap_or('0')))
    {
        bagian
            .iter()
            .filter_map(|s| s.parse::<i64>().ok())
            .map(Value::from)
            .collect()
    } else {
        Vec::new()
    };
    match validate_hari_kerja(&Value::Array(angka)) {
        Ok(teks) => teks.split(',').filter_map(|s| s.parse().ok()).collect(),
        Err(_) => (1..=7).collect(),
    }
}

/// Cermin `tanggalValid`: `YYYY-MM-DD` yang benar-benar ada di kalender.
pub fn tanggal_valid(tanggal: &str) -> bool {
    tanggal.len() == 10
        && tanggal.chars().enumerate().all(|(i, c)| {
            if i == 4 || i == 7 {
                c == '-'
            } else {
                c.is_ascii_digit()
            }
        })
        && time_policy::add_days(tanggal, 0).as_deref() == Ok(tanggal)
}

/// Cermin `hariIso`: 1 = Senin s.d. 7 = Minggu. 2024-01-01 adalah Senin.
pub fn hari_iso(tanggal: &str) -> Option<i64> {
    if !tanggal_valid(tanggal) {
        return None;
    }
    let selisih = time_policy::days_between("2024-01-01", tanggal).ok()?;
    Some(selisih.rem_euclid(7) + 1)
}

/// Cermin `wajibMasuk`: libur mingguan dinilai lebih dulu; pada tanggal libur
/// aktif hanya yang masuk whitelist yang dijadwalkan. Tanggal tidak sah
/// dianggap hari kerja, perilaku sebelum aturan ini ada.
pub fn wajib_masuk(tanggal: &str, hari_masuk: &[i64], libur: bool, masuk_saat_libur: bool) -> bool {
    if let Some(hari) = hari_iso(tanggal) {
        if !hari_masuk.contains(&hari) {
            return false;
        }
    }
    !libur || masuk_saat_libur
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LiburMassal {
    pub tanggal: String,
    pub nama_libur: String,
    pub jenis_libur: String,
    pub keterangan: Option<String>,
}

/// Cermin `validateLiburMassal`. Tanggal ganda dalam satu kiriman ditolak,
/// bukan digabung, karena namanya bisa berbeda.
pub fn validate_libur_massal(nilai: &Value) -> Result<Vec<LiburMassal>, String> {
    let daftar = match nilai.as_array() {
        Some(daftar) if !daftar.is_empty() => daftar,
        _ => return Err("Pilih minimal satu tanggal libur.".into()),
    };
    if daftar.len() > MAKS_LIBUR_MASSAL {
        return Err(format!(
            "Paling banyak {MAKS_LIBUR_MASSAL} tanggal sekali simpan."
        ));
    }
    let mut hasil = Vec::with_capacity(daftar.len());
    let mut terlihat = std::collections::HashSet::new();
    for item in daftar {
        let Some(baris) = item.as_object() else {
            return Err("Data hari libur tidak valid.".into());
        };
        let teks = |kunci: &str| {
            baris
                .get(kunci)
                .and_then(Value::as_str)
                .map(str::trim)
                .unwrap_or("")
                .to_owned()
        };
        let tanggal = teks("tanggal");
        if !tanggal_valid(&tanggal) {
            return Err(format!("Tanggal \"{tanggal}\" tidak valid."));
        }
        if !terlihat.insert(tanggal.clone()) {
            return Err(format!("Tanggal {tanggal} tercantum dua kali."));
        }
        let nama = teks("nama_libur");
        if nama.is_empty() || nama.chars().count() > 120 {
            return Err(format!(
                "Nama libur {tanggal} wajib diisi, maksimal 120 karakter."
            ));
        }
        let jenis = teks("jenis_libur");
        if !JENIS_LIBUR.contains(&jenis.as_str()) {
            return Err(format!("Jenis libur {tanggal} tidak dikenal."));
        }
        let keterangan = Some(teks("keterangan")).filter(|s| !s.is_empty());
        hasil.push(LiburMassal {
            tanggal,
            nama_libur: nama,
            jenis_libur: jenis,
            keterangan,
        });
    }
    Ok(hasil)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // Vektor kembar `hari-kerja.test.ts`. Mengubah satu sisi berarti mengubah
    // keduanya.

    #[test]
    fn validasi_hari_kerja() {
        assert_eq!(validate_hari_kerja(&json!([5, 1, 3])), Ok("1,3,5".into()));
        assert_eq!(
            validate_hari_kerja(&json!([1, 2, 3, 4, 5, 6, 7])),
            Ok(HARI_KERJA_SEMUA.into())
        );
        assert_eq!(
            validate_hari_kerja(&json!([])),
            Err("Pilih minimal satu hari kerja.".into())
        );
        assert_eq!(
            validate_hari_kerja(&json!("1,2")),
            Err("Pilih minimal satu hari kerja.".into())
        );
        assert_eq!(
            validate_hari_kerja(&json!([0, 1])),
            Err("Hari kerja harus angka 1 (Senin) sampai 7 (Minggu).".into())
        );
        assert_eq!(
            validate_hari_kerja(&json!([1.5])),
            Err("Hari kerja harus angka 1 (Senin) sampai 7 (Minggu).".into())
        );
        assert_eq!(
            validate_hari_kerja(&json!(["1"])),
            Err("Hari kerja harus angka 1 (Senin) sampai 7 (Minggu).".into())
        );
        assert_eq!(
            validate_hari_kerja(&json!([2, 2])),
            Err("Hari kerja tidak boleh ganda.".into())
        );
    }

    #[test]
    fn parse_hari_kerja_jatuh_ke_tujuh_hari() {
        assert_eq!(parse_hari_kerja(Some("1,2,3,4,5")), vec![1, 2, 3, 4, 5]);
        assert_eq!(parse_hari_kerja(Some(" 6 , 1 ")), vec![1, 6]);
        assert_eq!(parse_hari_kerja(None), vec![1, 2, 3, 4, 5, 6, 7]);
        assert_eq!(parse_hari_kerja(Some("")), vec![1, 2, 3, 4, 5, 6, 7]);
        assert_eq!(parse_hari_kerja(Some("1,8")), vec![1, 2, 3, 4, 5, 6, 7]);
        assert_eq!(parse_hari_kerja(Some("1,1")), vec![1, 2, 3, 4, 5, 6, 7]);
    }

    #[test]
    fn hari_iso_dan_tanggal() {
        assert_eq!(hari_iso("2026-10-15"), Some(4));
        assert_eq!(hari_iso("2026-10-18"), Some(7));
        assert_eq!(hari_iso("2026-10-19"), Some(1));
        assert_eq!(hari_iso("2024-02-29"), Some(4));
        assert_eq!(hari_iso("1999-12-31"), Some(5));
        assert_eq!(hari_iso("2026-02-29"), None);
        assert_eq!(hari_iso("2026-1-05"), None);
        assert_eq!(hari_iso(""), None);
        assert!(tanggal_valid("2028-02-29"));
        assert!(!tanggal_valid("2026-13-01"));
    }

    #[test]
    fn wajib_masuk_vektor() {
        let senin_jumat = [1, 2, 3, 4, 5];
        // Sabtu 2026-10-17 di luar hari kerja: tidak wajib masuk.
        assert!(!wajib_masuk("2026-10-17", &senin_jumat, false, false));
        // Hari kerja biasa.
        assert!(wajib_masuk("2026-10-16", &senin_jumat, false, false));
        // Libur aktif tanpa whitelist.
        assert!(!wajib_masuk("2026-10-16", &senin_jumat, true, false));
        // Libur aktif, masuk whitelist.
        assert!(wajib_masuk("2026-10-16", &senin_jumat, true, true));
        // Whitelist tidak mengalahkan libur mingguan.
        assert!(!wajib_masuk("2026-10-18", &senin_jumat, true, true));
        // Tanggal tidak sah: dianggap hari kerja.
        assert!(wajib_masuk("bukan", &senin_jumat, false, false));
    }

    #[test]
    fn validasi_libur_massal() {
        let ok = validate_libur_massal(&json!([
            { "tanggal": "2026-12-24", "nama_libur": " Cuti Natal ", "jenis_libur": "Cuti Bersama" },
            { "tanggal": "2026-12-25", "nama_libur": "Natal", "jenis_libur": "Libur Nasional", "keterangan": " SKB " }
        ]))
        .expect("valid");
        assert_eq!(ok[0].nama_libur, "Cuti Natal");
        assert_eq!(ok[0].keterangan, None);
        assert_eq!(ok[1].keterangan.as_deref(), Some("SKB"));

        let galat = |nilai: Value| validate_libur_massal(&nilai).unwrap_err();
        assert_eq!(galat(json!([])), "Pilih minimal satu tanggal libur.");
        assert_eq!(galat(json!(["x"])), "Data hari libur tidak valid.");
        assert_eq!(
            galat(
                json!([{ "tanggal": "2026-02-30", "nama_libur": "A", "jenis_libur": "Libur Khusus" }])
            ),
            "Tanggal \"2026-02-30\" tidak valid."
        );
        assert_eq!(
            galat(json!([
                { "tanggal": "2026-01-01", "nama_libur": "A", "jenis_libur": "Libur Khusus" },
                { "tanggal": "2026-01-01", "nama_libur": "B", "jenis_libur": "Libur Khusus" }
            ])),
            "Tanggal 2026-01-01 tercantum dua kali."
        );
        assert_eq!(
            galat(
                json!([{ "tanggal": "2026-01-01", "nama_libur": "  ", "jenis_libur": "Libur Khusus" }])
            ),
            "Nama libur 2026-01-01 wajib diisi, maksimal 120 karakter."
        );
        assert_eq!(
            galat(
                json!([{ "tanggal": "2026-01-01", "nama_libur": "A", "jenis_libur": "Libur Sekolah" }])
            ),
            "Jenis libur 2026-01-01 tidak dikenal."
        );
        let banyak: Vec<Value> = (0..121)
            .map(|i| {
                json!({
                    "tanggal": time_policy::add_days("2026-01-01", i).unwrap(),
                    "nama_libur": "A",
                    "jenis_libur": "Libur Khusus"
                })
            })
            .collect();
        assert_eq!(
            galat(Value::Array(banyak)),
            "Paling banyak 120 tanggal sekali simpan."
        );
    }
}
