# Proposal Superadmin dan Role-Based Access Control

Tanggal: 9 Agustus 2026 (Asia/Jakarta)

Status: desain role dinamis dan Fase A/B disetujui. Kode Fase A selesai; migration serta bootstrap lokal telah berhasil membuat `SPD001`. Desain teknis rinci Fase B dicatat dalam `SECURITY_PHASE_B_PROPOSAL.md` dan menunggu konfirmasi boundary sebelum kode arsitektur diubah.

## Status implementasi Fase A

- Migration runner additive dan idempotent tersedia; tabel operator lama tidak dihapus.
- Katalog permission, role dinamis, matriks permission, revision, dan audit perubahan tersedia.
- Halaman `/operators` menyediakan CRUD operator serta Role & Akses khusus Superadmin.
- OP001 tetap dimigrasikan sebagai Admin. Penghapusan ditolak bila akun memiliki histori; akun dapat dinonaktifkan agar audit tetap utuh.
- Superadmin aktif terakhir dan akun yang sedang digunakan tidak dapat dihapus.
- Password baru memakai PBKDF2-SHA256 600.000 iterasi; password legacy di-upgrade setelah login online yang berhasil.
- Guard navigasi, halaman, export, pengelolaan Karyawan, dan pengelolaan Shift membaca permission dinamis.
- Halaman `/forbidden` menampilkan penolakan akses tanpa mengubah data.
- Lint, TypeScript, 12 test, dan Next.js production build/static export lulus.
- Bootstrap lokal `SPD001` telah berhasil dan menghasilkan row ID internal `2`; kode bisnis Superadmin tetap `SPD001`.
- Enforcement masih berada pada UI/service client-compatible. Boundary tepercaya Web/Tauri tetap pekerjaan Fase B.

## Jawaban pemilik aplikasi

- Kode Superadmin pertama: `SPD001`.
- Perubahan permission wajib dilakukan saat online.
- Fase A (model, migrasi, service, UI, dan test) disetujui.
- Fase B (boundary autentikasi dan enforcement production) disetujui.
- Superadmin boleh membuat role tambahan dinamis seperti Supervisor atau HR.
- Bootstrap database lokal telah membuat `SPD001` menggunakan kredensial environment pemilik. Tidak ada kredensial bawaan yang ditambahkan ke source code.

Bootstrap Fase A menggunakan perintah lokal `bun run bootstrap:superadmin`. Nama, username, dan password dibaca dari environment `SPPG_SUPERADMIN_NAME`, `SPPG_SUPERADMIN_USERNAME`, dan `SPPG_SUPERADMIN_PASSWORD`. Password minimal 12 karakter, memiliki huruf besar, huruf kecil, dan angka; nilai password tidak dicetak atau ditulis ke source code. Bootstrap otomatis ditolak setelah Superadmin aktif tersedia.

## Keputusan produk yang sudah disetujui

- Hak akses diwariskan dari role, bukan diatur per akun.
- Contoh: OP1 dengan role `Admin` menerima seluruh permission milik Admin; OP2 dengan role `Scanner` menerima seluruh permission milik Scanner.
- Hanya `Superadmin` yang dapat mengubah permission suatu role.
- Role awal: `Superadmin`, `Admin`, `Operator`, dan `Scanner`.
- Permission Superadmin selalu penuh dan tidak dapat dikurangi melalui UI.

## Kondisi kode saat ini

- `master_operator.role` dibatasi database hanya ke `Admin`, `Operator`, dan `Scanner`.
- Aturan akses masih berupa daftar hard-coded pada `src/lib/auth/access.ts`.
- Session berada di browser storage dan masih dapat dimodifikasi dari client.
- Service dipanggil langsung dari client dan belum memiliki boundary otorisasi yang tepercaya.
- Belum ada sistem migration/version database.

Implikasinya: menyembunyikan menu saja bukan keamanan. Pengguna tetap dapat mencoba memanggil service secara langsung. Production RBAC harus memeriksa permission pada UI dan pada boundary data yang tepercaya.

## Model data yang diusulkan

### Penyempurnaan yang direkomendasikan: role berbasis database

Menindaklanjuti permintaan halaman Master Operator tanpa hard-code akun, model yang lebih fleksibel adalah menambahkan tabel `app_role`. `master_operator` menyimpan referensi `role_id`, bukan daftar role yang ditanam berulang pada setiap user.

- Halaman **Master Operator**: CRUD akun, status, dan pilihan role; hanya Superadmin.
- Halaman **Role & Akses**: CRUD role non-sistem dan matriks permission; hanya Superadmin.
- Role `Superadmin` merupakan role sistem yang tidak dapat dihapus, dinonaktifkan, atau dikurangi permission-nya.
- Akun operator dan penetapan role selalu berasal dari database.
- Permission key tetap merupakan kontrak kode karena aplikasi memerlukannya untuk menghubungkan fitur dengan pemeriksaan akses; nilai allowed/denied berasal dari database.

Cakupan role dinamis telah disetujui. Superadmin dapat membuat, mengubah, dan menonaktifkan role non-sistem. Role hanya dapat dihapus bila tidak dipakai operator dan tidak memiliki histori yang wajib dipertahankan; pilihan default aplikasi adalah menonaktifkan role agar audit tetap utuh.

### 1. Perubahan `master_operator`

Pilihan awal role adalah:

- `Superadmin`
- `Admin`
- `Operator`
- `Scanner`

Jika desain role berbasis database disetujui, kolom `role` lama diganti secara aman menjadi `role_id` yang mengarah ke `app_role`. Karena SQLite/libSQL tidak dapat mengubah `CHECK` lama secara langsung, migrasi harus membuat tabel pengganti, menyalin seluruh data, memverifikasi jumlah/checksum dasar, lalu mengganti tabel dalam transaction. Tidak ada akun lama yang dihapus.

### 2. Tabel `app_permission`

Katalog fitur yang stabil dan tidak bergantung pada label UI:

| Kolom | Fungsi |
| --- | --- |
| `permission_key` | Primary key, misalnya `scanner.use` |
| `nama` | Label yang dibaca pengguna |
| `grup` | Kelompok menu seperti Utama atau Manajemen |
| `deskripsi` | Penjelasan dampak permission |
| `is_active` | Mengaktifkan permission tanpa menghapus histori |
| `sort_order` | Urutan pada halaman Settings |

### 3. Tabel `role_permission`

Matriks permission untuk role yang dapat diatur:

| Kolom | Fungsi |
| --- | --- |
| `role` | `Admin`, `Operator`, atau `Scanner` |
| `permission_key` | Referensi ke `app_permission` |
| `is_allowed` | `0` atau `1` |
| `updated_at` | Waktu perubahan UTC |
| `updated_by` | Kode operator Superadmin |

Primary key gabungan: `(role, permission_key)`. `Superadmin` tidak memiliki baris yang dapat diedit; sistem selalu menganggap seluruh permission aktif untuk Superadmin.

### 4. Tabel `role_permission_audit`

Setiap perubahan menyimpan role, permission, nilai sebelum/sesudah, operator Superadmin, waktu, dan ID perubahan. Audit bersifat append-only dari aplikasi.

### 5. Versi konfigurasi

Tambahkan revision integer untuk matriks permission. Desktop menyimpan snapshot read-only beserta revision terakhir agar menu dan operasi yang sebelumnya diizinkan tetap dapat diketahui saat offline.

## Katalog permission awal

| Permission | Cakupan |
| --- | --- |
| `home.view` | Membuka Home |
| `scanner.use` | Membuka dan menggunakan QR Scanner |
| `dashboard.view` | Melihat Dashboard |
| `dashboard.export` | Mengunduh/export laporan |
| `employees.view` | Melihat data karyawan |
| `employees.manage` | Menambah dan mengubah karyawan |
| `shifts.view` | Melihat Shift |
| `shifts.manage` | Menambah dan mengubah Shift |
| `corrections.view` | Melihat Koreksi Admin |
| `corrections.manage` | Membuat koreksi absensi |
| `backups.view` | Melihat penugasan backup |
| `backups.manage` | Mengubah penugasan backup |
| `attendance_audit.view` | Melihat audit absensi |
| `operators.view` | Melihat Master Operator |
| `operators.manage` | Menambah, mengubah role, dan menonaktifkan operator |
| `branding.manage` | Mengganti logo dan profil aplikasi |
| `sync.view` | Melihat status sinkronisasi |
| `sync.retry` | Menjalankan ulang sinkronisasi gagal |
| `diagnostics.view` | Membuka diagnostik development |

`roles.manage` menjadi kemampuan internal khusus Superadmin dan tidak muncul sebagai checkbox yang dapat didelegasikan.

## Aturan keselamatan

- Minimal satu Superadmin aktif harus selalu tersedia.
- Superadmin tidak boleh menonaktifkan atau menurunkan role dirinya sendiri jika itu menghasilkan nol Superadmin aktif.
- Role Superadmin dan `roles.manage` tidak dapat diberikan oleh Admin.
- Perubahan permission harus online dan langsung tercatat; perubahan keamanan tidak dimasukkan ke antrean offline.
- Saat offline, aplikasi hanya memakai snapshot permission terakhir yang sudah berhasil disinkronkan.
- Bila belum pernah memiliki snapshot valid, login offline ditolak untuk operasi sensitif.
- Menonaktifkan permission tidak boleh menghapus data maupun histori lama.
- Route yang ditolak menampilkan halaman akses ditolak, bukan redirect diam-diam ke Home.

## Enforcement yang dibutuhkan

1. Navigasi dan kartu Home hanya menampilkan fitur yang diizinkan.
2. Setiap halaman memeriksa permission saat dibuka.
3. Tombol create/update/export memeriksa permission tindakan, bukan hanya permission halaman.
4. Service memerlukan actor/session dan permission yang sesuai.
5. Web memvalidasi permission pada API/backend tepercaya.
6. Desktop memvalidasi permission pada command/service Tauri tepercaya untuk operasi lokal.
7. Perubahan role atau permission membatalkan/menyegarkan session dan snapshot terkait.

Poin 5 dan 6 mengubah boundary autentikasi/data, sehingga implementasinya tetap memerlukan persetujuan arsitektur dan security plan terpisah.

## Migrasi yang diusulkan

1. Backup database dan catat jumlah operator per role.
2. Tambahkan tabel migration/version.
3. Buat `master_operator_new` dengan empat role.
4. Salin seluruh operator lama tanpa mengubah kode, username, status, atau password.
5. Promosikan tepat satu akun pilihan pemilik menjadi Superadmin.
6. Verifikasi jumlah data dan tidak ada duplicate key.
7. Ganti tabel lama di dalam transaction.
8. Buat katalog permission, matriks default, audit, dan revision.
9. Jalankan integrity check serta test login setiap role.
10. Rollback ke backup jika salah satu verifikasi gagal.

Migrasi tidak boleh otomatis memilih akun Superadmin. Kode operator awal harus ditentukan pemilik aplikasi.

## Tahapan implementasi setelah disetujui

### Fase A — Model dan UI

- Migration runner yang idempotent dan dapat diuji.
- Schema RBAC dan seed permission.
- Service pembacaan/pembaruan matriks.
- Halaman Settings > Role & Akses untuk Superadmin.
- Guard UI lama diganti pembacaan permission dinamis.
- Unit test dan integration test migrasi.

Fase ini membuat perilaku aplikasi benar, tetapi belum cukup sebagai boundary keamanan production selama client masih dapat mengakses database langsung.

### Fase B — Enforcement production

- Web: autentikasi dan otorisasi pada API/backend.
- Desktop: autentikasi/otorisasi lokal melalui Tauri command dan penyimpanan kredensial yang aman.
- Session tidak dapat dipalsukan melalui browser storage.
- Snapshot permission offline tervalidasi dan memiliki revision.
- Test penolakan direct call untuk setiap permission sensitif.

### Fase C — Release cleanup

- Hapus akun/kredensial default, helper simulasi, route test, dan data dummy.
- Jalankan migration rehearsal pada salinan database.
- Uji Admin, Operator, Scanner, dan Superadmin pada mode online/offline.

## Acceptance criteria

- Mengubah permission Admin langsung memengaruhi seluruh akun Admin setelah refresh session/sync.
- Perubahan tidak memengaruhi role lain.
- Admin tidak dapat membuka atau memanggil pengaturan role, termasuk melalui direct call.
- Scanner hanya dapat menggunakan fitur yang dicentang untuk role Scanner.
- Tidak mungkin menghapus Superadmin aktif terakhir.
- Seluruh perubahan permission memiliki audit actor, waktu, dan before/after.
- Snapshot offline tidak dapat dipakai untuk menaikkan hak akses.
- Lint, unit test, migration test, Web build, dan Desktop build lulus sebelum release.

## Persetujuan yang masih diperlukan

1. Kode operator mana yang akan menjadi Superadmin pertama.
2. Apakah perubahan permission wajib online seperti rekomendasi proposal ini.
3. Persetujuan untuk Fase A yang mengubah schema dan menambahkan migration runner.
4. Persetujuan terpisah untuk Fase B karena memindahkan boundary autentikasi dan akses data.
