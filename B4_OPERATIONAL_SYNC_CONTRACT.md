# Kontrak Migrasi B4 — Operasional dan Sinkronisasi

Tanggal: 10 Agustus 2026 (Asia/Jakarta)

Status: disetujui untuk implementasi berkelanjutan. Pemeriksaan kecil dilakukan per vertical slice; acceptance test lengkap dilakukan setelah seluruh B4 selesai.

## Sumber kebenaran

Urutan sumber kebenaran selama B4:

1. Keputusan produk eksplisit pemilik aplikasi.
2. Perilaku bisnis pada folder `code-sheet`.
3. Kontrak fungsi dan DTO service TypeScript yang sudah dipakai UI.
4. Metadata sinkronisasi baru yang tidak boleh mengubah arti data bisnis lama.

Route, halaman, service, tabel domain, dan data lama tidak dihapus pada B4. Refactor struktur legacy dilakukan setelah checkpoint B4 dan membutuhkan konfirmasi terpisah bila mengganti kontrak atau tanggung jawab modul.

## Prioritas sumber data

Prioritas yang dipertahankan dari Apps Script:

1. Koreksi Admin.
2. Import Offline.
3. Scanner.
4. Generate Sistem/Alfa.

Data dengan prioritas lebih rendah tidak boleh menimpa hasil dengan prioritas lebih tinggi.

## Kontrak Scanner dan Absensi

Urutan proses dipertahankan:

1. Parse QR dengan format `ID_Unik|Token_Absensi`.
2. Validasi karyawan, token, dan status aktif.
3. Tentukan tanggal kerja serta shift efektif.
4. Validasi GPS dan geofencing.
5. Periksa penugasan karyawan asal/pengganti.
6. Periksa cooldown scan.
7. Baca riwayat Masuk/Pulang, termasuk shift malam.
8. Terapkan aturan jam scan dari konfigurasi shift.
9. Terapkan prioritas Koreksi Admin.
10. Catat hasil percobaan ke `log_scan`.
11. Hanya status `Berhasil` atau `Perlu Verifikasi` yang dapat membuat atau mengubah `absensi_harian`.

Koreksi produk yang telah disetujui terhadap implementasi Apps Script lama:

- Scan dalam masa cooldown tetap dicatat ke `log_scan` sebagai `Scan Ditolak`/`Ditolak` dengan alasan duplikat.
- Scan duplikat tidak membuat atau mengubah `absensi_harian`.
- Log duplikat yang ditolak tidak menjadi dasar baru perhitungan cooldown.
- Pengiriman ulang event sinkronisasi dengan `event_id` yang sama mengembalikan hasil lama dan tidak membuat baris kedua.

## Kontrak runtime

- Web selalu online dan memakai same-origin Route Handler serta Turso server-only.
- Desktop memakai custom command Rust; WebView tidak memperoleh SQL generik atau token Turso.
- Mutasi operasional Desktop disimpan lokal terlebih dahulu, kemudian dimasukkan ke outbox.
- Master Operator, role, dan permission tetap wajib online dan tidak masuk outbox operasional.
- Mutasi gagal tidak dihapus otomatis.
- Konflik tidak ditimpa otomatis dan disimpan untuk peninjauan.
- Generate Alfa berjalan pada server online agar beberapa perangkat tidak membuat Alfa ganda.
- Desktop yang memulai session secara offline harus login online kembali sebelum outbox dapat dikirim karena token server tidak disimpan permanen.

## Metadata sinkronisasi additive

Tabel domain legacy tidak diberi kolom sync. Metadata disimpan pada tabel pendamping:

- Server `sync_operation_receipt`: bukti idempotency dan hasil pemrosesan event.
- Server `sync_change_log`: revision monoton untuk pull perubahan.
- Desktop `desktop_sync_outbox`: antrean `pending`, `synced`, `failed`, atau `conflict`.
- Desktop `desktop_sync_cursor`: revision terakhir per domain.
- Desktop `desktop_sync_conflict`: payload lokal/server dan alasan konflik.

Status `failed` dapat dicoba ulang dengan exponential backoff. Status `conflict` memerlukan keputusan pengguna dan tidak dicoba ulang otomatis. Record `synced`, `failed`, dan `conflict` tidak dihapus otomatis pada B4.

## Urutan vertical slice

1. Fondasi schema sync dan kontrak DTO.
2. Snapshot Setting, Shift, Karyawan, token QR, serta Backup.
3. CRUD Karyawan dan Shift melalui adapter Web/Desktop.
4. Scanner, `log_scan`, dan `absensi_harian` local-first.
5. Koreksi Admin, Backup Karyawan, dan Import Offline.
6. Alfa, audit, Dashboard/rekap, token, serta ID Card.
7. Status sinkronisasi, retry manual, dan conflict visibility.
8. Acceptance test Web/Desktop online-offline dan checkpoint B4.

## Gate stabilisasi setelah B4

Stabilisasi struktur legacy hanya dimulai setelah acceptance test B4 lulus. Fase tersebut boleh mengurangi duplikasi atau memecah modul besar, tetapi tidak boleh mengubah hasil bisnis tanpa persetujuan dan fixture regresi yang membuktikan paritas.
