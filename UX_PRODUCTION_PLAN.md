# Rencana UX/UI Production — Absensi SPPG

Tanggal audit awal: 9 Agustus 2026 (Asia/Jakarta)

## Kesepakatan kerja

- Struktur route, service, database, dan arsitektur yang ada dipertahankan.
- Penggantian arsitektur, pemindahan tanggung jawab data, penambahan dependency besar, atau penghapusan fitur hanya dilakukan setelah persetujuan pemilik aplikasi.
- Pengerjaan dilakukan per tahap kecil. Setiap tahap harus lolos pemeriksaan sebelum tahap berikutnya dimulai.
- UI harus responsif mulai lebar 320 px, nyaman pada jendela desktop Tauri 800 x 600, dan tetap baik pada layar desktop lebar.
- Mode offline/online harus dijelaskan lewat status data yang nyata: tersimpan lokal, menunggu sinkronisasi, berhasil tersinkron, konflik, atau gagal. Indikator jaringan saja tidak cukup.
- `useEffect` bukan pilihan default. Setiap pemakaian harus diaudit. Logika event ditempatkan pada event handler, nilai turunan dihitung saat render, dan subscription browser memakai API framework/React yang tepat. Effect hanya dipertahankan bila benar-benar menyinkronkan sistem eksternal dan mempunyai cleanup yang benar.
- Tidak ada perubahan kode aplikasi pada tahap perencanaan ini.

## Fakta hasil audit awal

- Stack: Next.js 16.3.0, React 19.2.8, Tailwind CSS 4.3.3, Biome 2.4.2, Tauri 2.11.3, dan libSQL/Turso.
- Route yang tersedia: `/login`, `/`, `/scanner`, `/dashboard`, dan `/api/test-db`.
- Seluruh route berhasil dibuat sebagai static export; `bun run build` lulus.
- `bun run lint` belum lulus: 16 error dan 3 warning.
- Halaman utama masih mencampur navigasi production dengan tombol pengujian internal Tahap 1–6.
- Halaman yang tersedia masih berupa Client Components besar: home sekitar 13 KB, login 8 KB, dashboard 17 KB, dan scanner 18 KB.
- Ada 11 pemakaian `useEffect` pada halaman/context/hooks. Beberapa adalah kandidat kuat untuk diganti, sedangkan scanner, jam, fokus input, dan browser API harus dievaluasi berdasarkan kebutuhan sinkronisasi eksternal.
- Status online saat ini melakukan ping eksternal dan polling setiap 6 detik. Ini perlu diganti atau dipersempit setelah strategi offline disetujui.
- Next.js 16.3 menyediakan `useOffline`, tetapi masih experimental. API ini tidak akan diaktifkan sebelum diuji terhadap static export, Tauri, dan kebutuhan aplikasi.
- Mode offline web/desktop belum tervalidasi end-to-end. Jalur database lokal hanya dipilih saat `window` tidak tersedia, sedangkan WebView Tauri berjalan dengan `window`.
- Ada blocker keamanan production: fallback admin tertanam, password dibandingkan/disimpan sebagai plaintext di browser, token Turso dapat masuk bundle publik, session berada di `localStorage`, dan CSP Tauri bernilai `null`.
- Konfigurasi paket desktop masih memakai identifier/metadata pengembangan dan ukuran awal jendela 800 x 600.
- Worktree sudah memiliki banyak perubahan lokal yang belum di-commit. Semuanya dianggap sebagai pekerjaan pemilik dan harus dipertahankan.

## Keputusan produk yang disetujui

Dicatat pada 9 Agustus 2026:

- Web dan Desktop Tauri memiliki prioritas yang setara.
- Web selalu menggunakan database online. Desktop harus dapat bekerja online maupun offline.
- Saat Desktop offline, perubahan disimpan lokal sebagai antrean. Saat jaringan kembali, antrean dikirim ke database online.
- Urutan pengalaman utama adalah Login → Home → Dashboard. Scanner tetap menjadi menu operasional utama, bukan halaman awal setelah login.
- Menu tambahan boleh dibuat selama didukung domain/service yang sudah ada.
- Tombol pengujian Tahap 1–6 dan akun demo dipindahkan dari UI utama ke area diagnostik terpisah, kemudian dapat dikeluarkan dari build production.
- Belum ada logo final. Halaman Settings harus menyediakan fitur upload/ganti logo.
- Arah visual: modern, stylish, bersih, dengan putih sebagai dasar, biru muda sebagai warna utama, dan gold sebagai aksen terbatas.
- Sinkronisasi menggunakan pola local-first untuk Desktop: simpan lokal dahulu, tandai statusnya, lalu sinkronkan ketika online.

### Batas yang belum diputuskan

- Hak akses rinci untuk role Admin, Operator, dan Scanner.
- Aturan penyelesaian konflik jika data lokal dan online berubah bersamaan.
- Lokasi penyimpanan logo. Menyimpan file sebagai data di setting yang ada lebih sederhana tetapi kurang ideal; object storage dengan cache lokal lebih scalable tetapi menambah boundary arsitektur dan memerlukan persetujuan.

## Roadmap bertahap

### Tahap 0 — Baseline dan keputusan produk

Tujuan: menyepakati target sebelum mengubah UI.

- Petakan pengguna utama, role, perangkat, kondisi jaringan, dan alur kerja harian.
- Tentukan halaman yang benar-benar dibutuhkan untuk rilis pertama.
- Tentukan identitas visual: nama produk final, logo, warna merek, dan gaya bahasa.
- Putuskan nasib tombol tes dan akun demo: disembunyikan pada production, dipindahkan ke mode diagnostik, atau dipertahankan untuk role tertentu.
- Putuskan definisi offline untuk Web dan Desktop, sumber data utama, aturan retry, resolusi konflik, dan kapan sinkronisasi dijalankan.
- Setujui perubahan keamanan/data yang berpotensi menyentuh arsitektur.

Keluaran: scope rilis, peta alur, daftar halaman prioritas, matriks role, dan keputusan offline yang disetujui.

### Tahap 1 — Stabilkan fondasi tanpa mengubah arsitektur

Tujuan: baseline teknis bersih sebelum visual dipoles.

- Bersihkan error/warning Biome yang aman dan mekanis.
- Audit seluruh `useEffect` satu per satu dan dokumentasikan: hapus, ganti, atau pertahankan beserta alasan.
- Hilangkan key render acak, `alert()` production, polling agresif, dan state turunan yang tidak perlu.
- Tambahkan state loading, empty, error, disabled, retry, dan offline yang konsisten.
- Pastikan tidak ada perubahan service/database di tahap ini kecuali disetujui.

Gerbang selesai: lint, TypeScript, dan build lulus; tidak ada regresi alur login, scanner, dashboard, dan export.

### Tahap 2 — Design system dan app shell

Tujuan: UI konsisten, cepat, aksesibel, dan mudah dikembangkan.

- Bentuk token warna, spacing, radius, elevation, typography, focus ring, motion, dan breakpoint di CSS yang ada.
- Bangun komponen presentasional kecil: button, input, field, badge, card, banner, skeleton, empty state, dialog/toast, table shell, dan page header.
- Pertahankan Tailwind 4 dan struktur App Router; tidak menambahkan UI framework tanpa persetujuan.
- Perbaiki navigasi untuk 320 px–desktop: skip link, target sentuh minimal, keyboard navigation, focus visible, reduced motion, serta kontras WCAG.
- Buat status koneksi/sinkronisasi global yang membedakan jaringan dengan keadaan data.

Gerbang selesai: komponen memiliki semua state penting, keyboard usable, dan layout tidak overflow pada matriks viewport.

### Tahap 3 — Halaman prioritas (satu halaman per iterasi)

Urutan yang disetujui:

1. Login — kredibilitas produk, validasi form, error yang jelas, dan mode offline yang jujur.
2. Home — pusat kerja sesuai role, ringkasan hari ini, status sinkronisasi, dan shortcut tindakan utama.
3. Dashboard — hierarchy informasi, filter, tabel responsif, empty/error/loading, export, dan ringkasan yang mudah dipindai.
4. Scanner — fokus scan, feedback sukses/gagal, histori, audio, GPS, antrean offline, dan recovery sinkronisasi.
5. Menu operasional dan Settings — dibuat bertahap berdasarkan peta menu production di bawah.

Setiap iterasi: review wireframe berbasis konten nyata, implementasi tanpa mengubah kontrak service, uji responsive/keyboard/offline, lalu persetujuan sebelum lanjut.

### Peta menu production

Peta ini dibuat dari service dan tabel yang memang sudah ada. Hak akses akhirnya menunggu matriks role.

- Utama
  - Home
  - Scanner
  - Dashboard
- Manajemen
  - Data Karyawan
  - ID Card
  - Koreksi Admin
  - Penugasan Backup
  - Audit Absensi
- Settings
  - Profil Aplikasi & Logo
  - Shift & Aturan Absensi
  - Operator & Role
  - Sinkronisasi & Data
  - Diagnostik Sistem

Area diagnostik tidak tampil sebagai navigasi utama. Pada development, area ini hanya dapat diakses Admin. Pada build production, strategi finalnya adalah dikeluarkan dari bundle atau dilindungi feature flag; pilihan final ditentukan sebelum release candidate.

### Tahap 4 — Offline/online yang dapat dipercaya

Tujuan: pengguna selalu tahu apakah pekerjaannya aman.

- Validasi jalur penyimpanan lokal Desktop dan Web secara terpisah.
- Rancang antrian mutasi dengan status pending/synced/failed/conflict dan operasi idempotent.
- Tampilkan waktu sinkron terakhir, jumlah antrean, aksi retry, dan konflik yang perlu keputusan pengguna.
- Evaluasi tiga opsi tanpa memilih diam-diam: subscription browser dengan React, `useOffline` experimental Next.js, atau service worker/PWA untuk full offline web.
- Uji matikan jaringan saat login, scan, membuka route, export, dan saat sinkronisasi berlangsung.

Gerbang persetujuan: perubahan source-of-truth, skema sync, service worker, API/backend, atau boundary Tauri harus disetujui dahulu.

### Tahap 5 — Performa dan reliability

- Ukur lebih dahulu, lalu optimalkan client boundary, ukuran bundle, render ulang, query, tabel panjang, prefetch, font, dan asset.
- Pecah komponen halaman besar tanpa memindahkan tanggung jawab service/database.
- Gunakan pagination/virtualization hanya jika volume data nyata membutuhkannya.
- Pastikan scanner tetap responsif pada perangkat rendah dan koneksi buruk.
- Target awal: tidak ada layout shift yang mengganggu, interaksi utama terasa instan, dan tidak ada polling kontinu yang tidak perlu.

### Tahap 6 — Security dan packaging production

Tahap ini wajib sebelum aplikasi boleh disebut production-ready.

- Hilangkan kredensial default/plaintext dan rahasia dari bundle klien.
- Tentukan penyimpanan session/kredensial offline yang aman untuk Web dan Tauri.
- Aktifkan CSP Tauri yang sesuai dan review capability minimum.
- Finalkan identifier, metadata, icon, title, window behavior, error logging, dan update strategy.
- Audit akses berbasis role dan redaksi data sensitif dari log/error UI.

Semua perubahan yang memindahkan autentikasi atau akses database ke boundary baru memerlukan persetujuan eksplisit.

### Tahap 7 — Release candidate

- Uji alur end-to-end untuk setiap role dan mode jaringan.
- Uji viewport 320, 360, 768, 800 x 600, 1024, 1280, dan 1440 px.
- Uji keyboard, screen reader basics, kontras, reduced motion, zoom 200%, tabel panjang, data kosong, dan error database.
- Jalankan Biome, TypeScript, Next production build/static export, serta Tauri build.
- Buat checklist rollback, backup data, migration, dan acceptance sign-off.

## Aturan persetujuan perubahan

Konfirmasi wajib sebelum:

- menghapus/mengganti route, service, schema, atau kontrak data;
- memindahkan autentikasi/database ke backend, API, Rust/Tauri command, atau worker;
- mengaktifkan fitur Next.js experimental;
- menambahkan library UI/state/data-fetching/testing yang besar;
- menambah service worker/PWA atau mengubah strategi static export;
- menghapus/memindahkan test console, akun demo, atau fungsi operasional yang sudah ada.

Perubahan yang dapat dilakukan setelah satu tahap disetujui: styling, markup semantik, komponen presentasional, responsive behavior, accessibility, copy UI, dan perbaikan lint mekanis selama kontrak/fungsi lama tetap sama.

## Pertanyaan yang harus dijawab sebelum Tahap 1/3

1. Rilis pertama diprioritaskan untuk Desktop Tauri, Web, atau keduanya setara?
jawban: keduanya setara
2. Siapa pengguna dan role yang benar-benar memakai aplikasi, serta halaman wajib masing-masing?
jawban: Admin, Operator, Scanner. 
3. Apakah sudah ada logo, warna merek, atau referensi desain?
jawban: kalo untuk logo belum ada, nahh nanti di halmaan setting tolong tambahkan fitur upload atau mengganti logo. warna merek nya sih aku lebih suka yang berwarna putih, biru muda, ada gold juga. referensi desain aku ingin yang modern, stylish dan keren.
4. Tombol tes Tahap 1–6 dan akun demo akan dipindahkan ke mode diagnostik atau dihilangkan dari build production?
jawaban: tolong pindahkan saja, karena nanti kalo siap production langsung di clean.
5. Saat offline, apakah scan harus tetap tersimpan lalu tersinkron otomatis? Siapa yang memutuskan jika terjadi konflik?
jawaban: nahh iya benar, simpan lokal dulu baru nanti di sinkron kan
6. Berapa perkiraan jumlah karyawan dan baris laporan per hari/bulan?
jawaban: aku belum tau soalnya ini untuk aplikasi freelance aku, kemungkinan pasti banyak, karyawan bisa sampai ribuan juga kalo dipakai di perusahaan besar

## Definition of Done global

- Tidak ada struktur/arsitektur yang berubah tanpa catatan persetujuan.
- Build Web dan Desktop lulus; lint dan TypeScript bersih.
- Semua halaman yang disetujui memiliki loading, empty, error, offline, dan success state.
- Tidak ada kredensial plaintext/default atau rahasia cloud di bundle klien.
- Alur utama dapat digunakan dengan keyboard, pada 320 px dan 800 x 600, serta tetap jelas saat koneksi terputus.
- Status penyimpanan dan sinkronisasi data dapat dipahami tanpa menebak.

## Catatan progres implementasi

### Tahap 1 — selesai untuk baseline Web (9 Agustus 2026)

- Jumlah `useEffect` turun dari 11 menjadi 2.
- Effect yang dihapus: hydration, pembacaan session, redirect auth, clock, autofocus, pemeriksaan database otomatis, dan polling status jaringan.
- Dua Effect yang dipertahankan: pemuatan data dashboard serta permintaan lokasi GPS. Keduanya menyinkronkan sistem eksternal dan mempunyai cleanup untuk mencegah update setelah komponen dilepas.
- Hydration, session browser, status jaringan, dan clock menggunakan subscription `useSyncExternalStore`.
- Ping ke `1.1.1.1` dan polling setiap 6 detik telah dihapus. Status jaringan sekarang mengikuti event browser tanpa request eksternal terus-menerus.
- Auth redirect menggunakan mekanisme render Next.js, bukan Effect.
- `alert()` diagnostik diganti dengan feedback inline yang aksesibel.
- Key render acak pada scanner dan dashboard diganti dengan key stabil.
- Pemuatan dashboard diparalelkan dan mempunyai error state serta perlindungan stale update.
- Biome: lulus, 39 file diperiksa tanpa error/warning.
- Next.js production build dan TypeScript: lulus; seluruh route tetap static-exported.
- `git diff --check`: lulus.

- Identifier Tauri telah diperbarui secara permanen dari `com.tauri.dev` menjadi `id.sppg.absensi` untuk persiapan build production.
