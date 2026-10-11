# Proposal Fase B — Boundary Keamanan Web dan Desktop

Tanggal: 9 Agustus 2026 (Asia/Jakarta)

Status: checkpoint arsitektur disetujui dengan Vercel sebagai target Web. B1, B2, dan implementasi kode B3 selesai; smoke test Desktop online/offline pada perangkat pengguna menjadi checkpoint operasional berikutnya.

## Status implementasi B1

- `build:web` menghasilkan Next.js server build untuk Vercel dan mempertahankan Route Handler autentikasi dinamis.
- `build:desktop` menghasilkan static export `out`; konfigurasi Tauri telah diarahkan ke script ini dan tidak menyalin endpoint auth ke artifact Desktop.
- Koneksi Web server memakai `TURSO_DATABASE_URL` dan `TURSO_AUTH_TOKEN` tanpa prefix publik.
- Scan artifact menemukan credential lama pernah masuk bundle, kemudian environment lokal serta kode diperbaiki. Scan ulang Web client dan Desktop menunjukkan nol JWT-like secret dan nol URL Turso production.
- Migration additive versi 2 menambahkan `app_session` untuk opaque session token yang disimpan dalam bentuk SHA-256 hash, expiry, revocation, actor, dan revision permission.
- Route `POST /api/auth/login`, `POST /api/auth/session`, dan `DELETE /api/auth/session` tersedia untuk vertical slice Web B2.
- Cookie session disiapkan sebagai `HttpOnly`, `Secure` pada production, `SameSite=Lax`, expiry delapan jam, dan response `no-store`.
- UI belum dialihkan ke endpoint baru. Session `localStorage` lama masih dipertahankan sementara agar alur aplikasi tidak diputus sebelum B2 selesai.
- Initializer Web menolak pembuatan akun default legacy `OP001/admin123`; akun production hanya dibuat melalui bootstrap/CRUD yang disetujui.
- Tidak ada `useEffect` baru yang ditambahkan.
- Biome, TypeScript, 18 test, build Web, build Desktop, `git diff --check`, dan pemeriksaan secret artifact lulus.

Tindakan eksternal sebelum deploy production: hapus variable Vercel bernama `NEXT_PUBLIC_TURSO_DATABASE_URL` dan `NEXT_PUBLIC_TURSO_AUTH_TOKEN` bila masih ada, tambahkan pasangan server-only tanpa prefix, lalu rotasi token Turso yang lama.

## Tujuan

- Web selalu online dan mengakses Turso hanya melalui backend tepercaya.
- Desktop Tauri dapat login serta bekerja dari database SQLite lokal saat offline, lalu menyinkronkan perubahan ketika online.
- Session dan permission tidak dapat dinaikkan dengan mengubah `localStorage` atau memanggil service client secara langsung.
- Route, halaman, komponen, tabel domain, dan kontrak fitur lama dipertahankan selama migrasi bertahap.
- Perubahan role/permission tetap wajib online dan seluruhnya diaudit.

## Masalah yang harus diselesaikan

1. `next.config.ts` selalu memakai `output: "export"`. Build ini cocok untuk aset Desktop Tauri, tetapi tidak dapat menjadi backend Web dinamis untuk cookie session dan Route Handler yang membaca request.
2. `src/lib/db.ts` masih memungkinkan browser membuat koneksi database dengan environment publik. Token database production tidak boleh masuk bundle Web maupun WebView Desktop.
3. Session Web saat ini berada di browser storage. Nilainya dapat dimodifikasi oleh pengguna dan bukan boundary autentikasi yang tepercaya.
4. Permission Fase A sudah benar untuk perilaku UI, tetapi enforcement service masih berjalan di lingkungan client-compatible.
5. Tauri belum memiliki command domain, database SQLite lokal yang dikelola Rust, secure secret storage, atau capability minimum. CSP juga masih `null`.

## Arsitektur yang direkomendasikan

Satu source UI dipertahankan, tetapi menghasilkan dua target runtime:

```text
Web browser
  -> Next.js server / Route Handlers
  -> authentication + authorization + DAL
  -> Turso online

Desktop WebView
  -> Tauri custom commands
  -> authentication + authorization di Rust
  -> SQLite lokal + outbox sinkronisasi
  -> ketika online: API Web yang sama
  -> Turso online
```

### Target Web

- `build:web` memakai Next.js server build, bukan static export.
- Credential Turso hanya dibaca dari environment server tanpa prefix `NEXT_PUBLIC_`.
- Login menghasilkan opaque session token acak. Hanya hash token yang disimpan di database; browser menerima cookie `HttpOnly`, `Secure`, dan `SameSite`.
- Setiap Route Handler sensitif memuat actor dari session lalu memeriksa permission di Data Access Layer sebelum query atau mutasi.
- Perubahan role/permission memajukan revision dan mencabut atau menyegarkan session terkait.
- Request mutasi memiliki validasi input, pemeriksaan origin/CSRF yang sesuai, audit, serta rate limit untuk login.

### Target Desktop

- `build:desktop` mempertahankan static export ke folder `out` yang saat ini dipakai Tauri.
- WebView tidak menerima token Turso dan tidak diberi akses SQL generik.
- Command Rust dibuat per use case, misalnya login lokal, membaca session aman, membaca snapshot permission, dan mutasi domain. Setiap command memverifikasi session/permission sebelum menyentuh SQLite.
- Secret perangkat/session disimpan melalui Tauri Stronghold; UI hanya menerima DTO aman dan status session.
- Database lokal menyimpan data kerja, snapshot permission terakhir yang tervalidasi, revision, dan outbox sinkronisasi.
- Saat offline, perubahan security seperti role/operator/permission ditolak. Mutasi operasional yang disetujui disimpan lokal dahulu dan mempunyai idempotency key.
- Capability Tauri dibatasi ke window dan command yang benar-benar diperlukan, kemudian CSP production diaktifkan.

### Mengapa bukan akses SQL langsung dari frontend

Plugin SQL Tauri resmi cocok untuk akses database lokal, tetapi mengekspos operasi SQL ke frontend akan memperlebar boundary yang perlu dipercaya. Untuk RBAC production, proposal ini memilih custom Rust commands per use case sehingga permission diperiksa sebelum query berjalan. Keputusan ini tidak mengganti schema domain; hanya memindahkan eksekusinya ke boundary yang tepercaya.

## Kompatibilitas dengan kode lama

Lapisan UI tidak akan dirombak sekaligus. Service yang sekarang dipakai halaman akan mendapat adapter runtime dengan bentuk respons yang sama:

- Web adapter memanggil same-origin API.
- Desktop adapter memanggil Tauri command.
- Test adapter dapat memakai database/test fixture yang terisolasi.

Migrasi dilakukan per domain. Selama sebuah domain belum dipindahkan, perilaku lamanya dipertahankan untuk development dan diberi penanda jelas bahwa domain tersebut belum memenuhi gate production. Tidak ada tabel atau service lama yang dihapus pada Fase B.

## Tahap implementasi

### B1 — Dual build dan fondasi Web

- Tambahkan script `build:web` dan `build:desktop` dengan konfigurasi Next bersyarat yang eksplisit.
- Ubah perintah build Tauri agar hanya memakai `build:desktop`.
- Pisahkan koneksi Turso server-only dari modul client.
- Tambahkan tabel session, migration, cookie session, DAL actor, dan Route Handler autentikasi.
- Pertahankan verifikasi password PBKDF2 Fase A dan mekanisme upgrade password legacy yang sudah tersedia.
- Tambahkan test bahwa bundle/client tidak dapat mengimpor credential atau koneksi server.

### B2 — Web RBAC sebagai vertical slice

- Migrasikan login, session, role/permission, dan Master Operator lebih dahulu.
- Semua endpoint Master Operator wajib memeriksa `operators.view`, `operators.manage`, atau kemampuan internal `roles.manage` di server.
- Tambahkan test direct call untuk guest, role tanpa permission, operator nonaktif, session kedaluwarsa, dan Superadmin terakhir.
- UI lama memakai adapter tanpa perubahan alur pengguna.

### B3 — Boundary Desktop

- Tambahkan custom Rust commands, SQLite lokal, Stronghold, capability minimum, dan CSP awal.
- Migrasikan login lokal serta snapshot RBAC terlebih dahulu.
- Password, token online, dan secret perangkat tidak disimpan di `localStorage`.
- Tambahkan test command untuk session palsu, permission ditolak, snapshot belum tersedia, dan perubahan security saat offline.

### B4 — Domain operasional dan sinkronisasi

- Migrasikan Karyawan, Shift, Absensi/Scanner, Koreksi, dan domain lain satu per satu melalui adapter yang sama.
- Tambahkan outbox idempotent, retry dengan backoff, status pending/synced/failed/conflict, serta pull revision.
- Aturan konflik per domain harus dikonfirmasi sebelum data yang berubah di dua sisi digabung atau ditimpa.

### B5 — Hardening dan cleanup release

- Hapus akses database client lama hanya setelah seluruh domain lulus migration gate.
- Hapus `NEXT_PUBLIC_TURSO_AUTH_TOKEN`, session browser lama, akun/helper diagnostik, dan data dummy pada Fase C/release cleanup yang terpisah.
- Aktifkan CSP final, lakukan migration rehearsal, uji Web/Desktop online-offline, lalu build release.

## Perubahan yang memerlukan konfirmasi dokumen ini

1. Web berubah dari static-only menjadi Next.js server deployment; Desktop tetap static export.
2. `package.json`, `next.config.ts`, dan konfigurasi build Tauri memperoleh target build terpisah.
3. Koneksi database Web dipindahkan ke server-only API/DAL.
4. Autentikasi Desktop dan akses SQLite dipindahkan ke custom Rust commands.
5. Dependency Rust untuk SQLite lokal dan Stronghold ditambahkan; capability serta CSP Tauri diperketat.
6. Session lama di browser storage dihentikan bertahap setelah adapter baru terbukti bekerja.

Tidak ada persetujuan yang diminta untuk menghapus route, halaman, service contract, tabel domain, atau data lama. Penghapusan tersebut tidak termasuk dalam proposal ini.

## Gate dan rollback

Setiap subfase harus lulus Biome, TypeScript, unit/integration test, `build:web`, `build:desktop`, serta test Tauri yang relevan. Migration database harus additive dan idempotent. Adapter lama tidak dilepas sebelum vertical slice baru lulus test dan rollback diuji.

Rollback B1/B2 adalah mengembalikan UI ke adapter lama pada development tanpa menghapus migration baru. Rollback B3/B4 menghentikan command/sync baru dan mempertahankan database lokal agar antrean tidak hilang; data antrean tidak boleh dihapus otomatis.

## Acceptance criteria Fase B

- Tidak ada token Turso production dalam bundle Web/Desktop.
- Mengubah `localStorage` tidak menghasilkan session atau permission sah.
- Direct API/command call tanpa permission ditolak sebelum query/mutasi.
- Web memakai cookie session yang aman dan Desktop memakai secret storage OS/Stronghold.
- Desktop dapat membaca snapshot permission valid saat offline, tetapi tidak dapat mengubah security saat offline.
- Penonaktifan operator atau perubahan role berlaku setelah refresh/revision dan tercatat dalam audit.
- UI Login, Home, Dashboard, Scanner, Settings, dan Master Operator tetap memiliki alur yang sama selama migrasi.
- Kedua target build dan test security lulus.

## Checkpoint arsitektur B1

Pemilik telah menyetujui rancangan berikut:

- Web: Next.js server deployment di Vercel + same-origin API + Turso server-only.
- Desktop: static export Tauri + custom Rust commands + SQLite lokal + Stronghold.
- UI/service contract lama dipertahankan melalui adapter runtime.
- Plugin SQL generik tidak diekspos ke frontend.

## Checkpoint implementasi B2

- Login dan pembacaan session Web telah dialihkan dari browser storage ke same-origin API dengan cookie opaque `HttpOnly`; Desktop tetap memakai jalur legacy melalui adapter runtime sampai B3.
- Master Operator dan pengelolaan role pada Web memakai Route Handler server. Actor selalu dibaca dari cookie session; `actorId` dari UI tidak dipercaya oleh Web.
- Endpoint operator memeriksa `operators.view`/`operators.manage`, endpoint role memeriksa `roles.manage`, dan seluruhnya dibatasi untuk Superadmin sesuai keputusan produk.
- Mutation dilindungi pemeriksaan same-origin yang kompatibel dengan reverse proxy Vercel. Payload JSON, ukuran payload, identifier, status, dan draft domain divalidasi di boundary server.
- Migration additive versi 3 menambahkan rate limit login persisten per IP dan kombinasi IP/identifier. Lima kegagalan dalam 15 menit memblokir percobaan berikutnya selama 15 menit.
- Perubahan operator sensitif serta perubahan role/permission mencabut session terkait. Aturan Superadmin aktif terakhir dan histori audit tetap dipertahankan.
- Fallback kredensial `OP001/admin123` telah dihapus dari initializer dan service. Record lama milik pengguna tidak dihapus atau diubah.
- Pengujian mencakup guest/direct call, role tanpa permission, origin asing, session kedaluwarsa, operator nonaktif, Superadmin terakhir, revocation akibat perubahan permission, rate limit, serta cookie production.
- Integrasi server production lokal lulus: guest `401`, origin asing `403`, Login/session/Superadmin API `200`, create operator `201`, dan Admin tanpa izin `403`.
- Tidak ada `useEffect` baru pada B2. Biome, TypeScript, 24 test, build Web, dan static export Desktop lulus. Artifact Desktop hanya memuat route statis `/api/test-db`; tidak memuat endpoint auth/operator/role, JWT-like secret, credential environment aktual, atau kredensial pengujian B2. Verifikasi visual melalui browser internal belum dapat dilakukan karena bootstrap konektor gagal; pengujian boundary dilakukan lewat HTTP terhadap hasil production build.

## Checkpoint implementasi B3

- Setiap pembeli memakai deployment Vercel dan database Turso terpisah. Binary Desktop diikat ke origin Vercel pelanggan melalui `SPPG_API_BASE_URL` saat build; domain tidak dapat diganti dari WebView atau halaman Settings.
- Release Desktop menolak build tanpa origin HTTPS pelanggan dan `SPPG_OFFLINE_AUTH_MAX_AGE_HOURS`. Rentang kebijakan offline dibatasi 1-720 jam dan harus ditentukan sebelum build pelanggan.
- Login Desktop online dilakukan oleh custom Rust command ke API pelanggan. Token session hanya berada di memori Rust dan tidak dikirim ke `localStorage` atau JavaScript.
- Login online pertama membuat snapshot identitas/RBAC terenkripsi per operator menggunakan Stronghold dan kunci turunan password Argon2. SQLite lokal hanya menyimpan indeks non-secret serta audit keamanan.
- Saat server benar-benar tidak tersedia, Desktop dapat membuka snapshot dengan username/kode operator dan password yang benar. Snapshot yang kedaluwarsa, berasal dari pelanggan lain, password salah, atau alias lokal yang dimodifikasi ditolak.
- Penolakan login server seperti password salah dan rate limit tidak pernah dialihkan ke fallback offline.
- Master Operator dan pengelolaan role selalu memerlukan session online. Rust memeriksa status Superadmin serta permission sebelum request; server mengulang pemeriksaan dari session tepercaya.
- WebView hanya memperoleh custom commands yang di-allowlist. SQL, HTTP, dan Stronghold generik tidak diekspos. CSP production diaktifkan dan koneksi jaringan WebView dibatasi ke IPC Tauri.
- Adapter legacy dipindahkan ke modul rollback tetapi belum dihapus. Session legacy di `localStorage` dibersihkan saat Desktop baru mulai; tidak ada route, tabel domain, atau service lama yang dihapus.
- Tidak ada `useEffect` baru. Biome, TypeScript, 24/24 test frontend/server, 11/11 test Rust, Clippy ketat, build Web, static export Desktop, dan packaging MSI/NSIS lulus. Warning linker PDB berasal dari binary native `libsodium`; bukan warning kode aplikasi dan tidak menggagalkan build.

B4 tetap diperlukan untuk data operasional Karyawan, Shift, Scanner/Absensi, Koreksi, outbox, retry, dan sinkronisasi local-first. B3 hanya menutup autentikasi serta RBAC Desktop dan tidak mengklaim sinkronisasi domain operasional sudah selesai.

Koreksi pasca-checkpoint: logout Web/Desktop mengganti history aktif ke `/login` setelah session dicabut. Integrasi lokal membuktikan session berubah dari `200` menjadi `401` setelah logout, dan test regresi memastikan redirect memakai `location.replace`.
