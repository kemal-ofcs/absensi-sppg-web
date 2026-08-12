# Checkpoint Database, Login, dan Sinkronisasi

Tanggal checkpoint: 12 Agustus 2026  
Commit acuan: `ba42710`  
Tahap berikutnya: scanner, aturan shift, aturan waktu scan, `LOG_SCAN`, dan `ABSENSI_HARIAN`.

## Kondisi yang sudah terverifikasi

- Login online Web dan Desktop berjalan.
- Logout dan session memakai jalur server yang sama.
- Login offline Desktop menggunakan snapshot kredensial terenkripsi Stronghold.
- Desktop development memakai API Next lokal `http://localhost:3000`; build release memakai `SPPG_API_BASE_URL` HTTPS.
- Perubahan lokal masuk ke outbox, dikirim ke server, lalu snapshot server diterapkan kembali ke SQLite Desktop.
- Konflik create lama untuk karyawan dan shift bawaan sudah direkonsiliasi tanpa menggandakan record.
- Penambahan karyawan melalui Desktop sudah terbukti muncul di Web.
- Kondisi terakhir yang diverifikasi: pending `0`, failed `0`, conflict `0`, event terkirim total `4`, revisi snapshot `6`.
- Jumlah snapshot saat checkpoint: karyawan `3`, ID Card `2`, shift `5`, pengaturan `6`, backup `3`, koreksi `3`, import `0`, absensi harian `2`, dan log scan `8`.

## Cakupan snapshot operasional

Snapshot menyalin `master_data`, `id_card`, `tbl_shift`, `setting_gex_system`, penugasan backup aktif/terbaru, koreksi terbaru, import offline terbaru, absensi harian terbaru, dan log scan terbaru. Riwayat bertanggal dibatasi 31 hari dan log scan maksimal 5.000 baris.

Operator, role, permission, session, receipt sinkronisasi, change log server, serta audit keamanan tidak disalin sebagai tabel operasional offline. Data tersebut tetap dikelola server atau melalui command online yang berizin.

## Aturan yang tidak boleh dirusak pada tahap scanner

- Jangan menghubungkan Tauri langsung ke Turso atau membawa `TURSO_AUTH_TOKEN` ke frontend/binary Desktop.
- Jangan mengganti API Desktop development kembali ke deployment production secara default.
- Jangan menghapus outbox, conflict history, cursor, atau database lokal untuk “memperbaiki” bug scanner.
- Jangan mematikan `freezePrototype`; kompatibilitas library harus diperbaiki tanpa menurunkan proteksi WebView.
- Jangan menyamakan primary key autoincrement lokal dan server untuk ID Card, koreksi, import, atau absensi; gunakan identitas bisnis uniknya.
- Jangan menimpa perubahan lokal berstatus pending/failed/conflict ketika snapshot diterapkan.
- Jangan menganggap angka “Event terkirim” sebagai bukti snapshot berhasil. Keberhasilan pull ditentukan oleh waktu sinkronisasi, revisi, serta jumlah record snapshot.
- Jangan mengubah schema atau arsitektur login/sinkronisasi tanpa reproduksi dan tes regresi yang menunjukkan perubahan itu memang diperlukan.

## Cara memverifikasi regresi

1. Login online Desktop.
2. Jalankan **Sinkronkan sekarang**.
3. Pastikan pending, gagal, dan konflik bernilai `0`.
4. Pastikan waktu **Terakhir berhasil** berubah dan revisi tidak kembali ke `0`.
5. Bandingkan jumlah Karyawan dan Shift antara Web dan bagian **Snapshot operasional lokal**.
6. Tambah satu karyawan Desktop, tunggu push, lalu pastikan muncul di Web.
7. Perubahan scanner berikutnya wajib diuji pada Web dan Desktop tanpa menghapus data checkpoint.

## Masalah yang sengaja diteruskan ke tahap berikutnya

- Aturan scan Web dan Desktop belum sepenuhnya disejajarkan dengan referensi `code-sheet`.
- Aturan tanggal kerja untuk shift malam, jendela masuk/pulang, toleransi, multi-scan, dan shift fleksibel perlu diaudit.
- Kamera Desktop sebelumnya gagal karena build ES5 ZXing tidak kompatibel dengan `freezePrototype`.
- Key riwayat Absensi Harian sebelumnya memakai `id_absensi` yang tidak selalu tersedia dari snapshot.
