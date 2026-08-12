# Audit Awal Scanner dan Aturan Absensi

Dokumen ini melanjutkan `CHECKPOINT_DATABASE_LOGIN.md`. Referensi perilaku utama adalah `code-sheet/02_Scanner_API.gs.txt`, `04_Attendance_Core.txt`, `05_Attendance_Update.txt`, `13_Shift_Settings.gs.txt`, `14_Scan_Settings.gs.txt`, dan helper terkait di `15_Helper.txt`.

## Dua engine aktif yang harus tetap setara

- Web memproses scan melalui `src/lib/services/attendance.ts` dan database server.
- Desktop memproses scan melalui `src-tauri/src/desktop/scanner.rs`, menyimpan SQLite lebih dahulu, lalu mengirim event melalui outbox.
- Perubahan aturan belum dianggap selesai sebelum skenario yang sama memberi keputusan, tanggal kerja, status, dan perhitungan menit yang sama pada kedua engine.

## Urutan aturan acuan

1. Parse QR tepat dalam format `ID|Token`.
2. Cari karyawan, validasi status aktif, dan cocokkan token terbaru.
3. Validasi geofence jika diwajibkan; penolakan tetap masuk `LOG_SCAN`.
4. Terapkan penugasan backup: karyawan asal ditolak, pengganti memakai shift backup dan ID referensi penugasan.
5. Terapkan cooldown scanner dan catat penolakan tanpa mengubah `ABSENSI_HARIAN`.
6. Tentukan tanggal kerja berdasarkan shift efektif, termasuk shift malam yang melewati tengah malam.
7. Baca riwayat masuk/pulang berdasarkan tanggal kerja, karyawan, dan ID referensi penugasan.
8. Tolak scan setelah pulang sudah tercatat.
9. Shift reguler menerapkan jendela datang awal, batas masuk normal, toleransi terlambat, batas pulang, dan batas multi-scan.
10. Scan pulang dalam jendela pulang tanpa riwayat masuk dicatat sebagai `Perlu Verifikasi`.
11. Shift fleksibel menerima satu masuk dan satu pulang tanpa aturan keterlambatan reguler.
12. Durasi kerja memotong istirahat hanya setelah `offset_istirahat_mulai`; shift fleksibel tidak memakai potongan/target reguler.
13. Koreksi Admin memiliki prioritas dan tidak boleh ditimpa scanner.
14. Setiap keputusan dicatat di `LOG_SCAN`; hanya `Berhasil` dan `Perlu Verifikasi` yang boleh mengubah `ABSENSI_HARIAN`.

## Ketidaksesuaian yang ditemukan pada implementasi sekarang

- Web dan Desktop masih memakai tanggal kalender langsung; aturan tanggal kerja shift malam dari referensi belum diterapkan.
- Waktu Web bergantung pada timezone proses server. Deployment cloud dapat berjalan dalam UTC, sehingga keputusan jam scan berisiko berbeda tujuh jam dari Asia/Jakarta.
- Kedua engine belum menolak scan terlalu awal, masuk setelah jendela ditutup, atau pulang setelah batas berakhir.
- Scan kedua setelah cooldown langsung dianggap pulang meskipun masih terlalu dekat dengan scan masuk.
- Scan ketiga dapat kembali memperbarui jam pulang; kondisi “sudah pulang” belum ditolak dengan benar.
- Pulang tanpa data masuk belum dibuat sebagai `Perlu Verifikasi` sesuai jendela shift.
- Potongan istirahat selalu diterapkan pada checkout, walaupun durasi hadir belum mencapai `offset_istirahat_mulai`.
- Shift fleksibel belum mempunyai penanda/perilaku eksplisit pada schema aplikasi baru. Seed saat ini memakai shift kode `4` dengan durasi normal `0`, sedangkan referensi lama memakai kode `FLEX`; keputusan representasi harus dibuat konsisten tanpa mengubah primary key.
- Setting `BATAS_MULTI_SCAN_MENIT` belum tersedia di `setting_gex_system`; yang tersedia saat audit hanya cooldown, auto alfa, geofence, radius, dan revisi RBAC.
- Engine Web menjalankan beberapa query terpisah tanpa satu transaksi penuh, sehingga kegagalan di tengah proses berpotensi membuat `LOG_SCAN` dan `ABSENSI_HARIAN` tidak konsisten.

## Tahapan implementasi

### Tahap Scanner 1 — Runtime kamera dan identitas UI

- Gunakan build ES2015 ZXing agar kompatibel dengan `freezePrototype` Tauri.
- Pertahankan `freezePrototype: true`.
- Gunakan `id_sesi` sebagai key utama riwayat Absensi Harian, bukan mengandalkan `id_absensi` snapshot.

### Tahap Scanner 2 — Mesin aturan waktu murni

- Buat kebijakan waktu yang dapat diuji dengan input waktu eksplisit.
- Tutupi shift reguler, shift malam, fleksibel, terlalu awal, terlambat, multi-scan, pulang awal/normal, pulang terlambat, dan pulang tanpa masuk.
- Tetapkan timezone operasional Asia/Jakarta pada Web.

### Tahap Scanner 3 — Integrasi Web

- Terapkan kebijakan pada service Web dengan transaksi atomik.
- Pastikan setiap penolakan hanya menulis log dan tidak mengubah absensi harian.

### Tahap Scanner 4 — Integrasi Desktop

- Port kebijakan yang sama ke Rust/SQLite.
- Pertahankan local-first dan outbox yang sudah stabil.

### Tahap Scanner 5 — Regresi end-to-end

- Bandingkan hasil Web dan Desktop untuk matriks skenario yang sama.
- Verifikasi hasil sinkronisasi `LOG_SCAN` dan `ABSENSI_HARIAN`, termasuk retry event tanpa duplikasi.
