# Hybrid Starter App (Next.js 16 + Tauri v2 + Offline SQLite + Turso Sync)

Fondasi aplikasi hybrid yang dapat langsung disalin untuk membangun produk baru (seperti **POS / Kasir**, **Inventori**, **Manajemen Toko**, **Klinik**, dsb.) dengan dukungan **Offline-First SQLite Lokal** dan **Cloud Sync Turso/libSQL**.

> 💡 **Mau langsung buat aplikasi baru?** Baca panduan 1 menit di **[QUICK_START.md](./QUICK_START.md)**.

## Fitur Utama

- **Frontend**: Next.js 16 (App Router) + React 19 + Tailwind CSS v4 + Radix UI / Shadcn.
- **Desktop & Mobile**: Tauri v2 dengan SQLite lokal terkompilasi (`hybrid-starter.db`).
- **Cloud Database**: Turso / libSQL dengan koneksi server aman.
- **Sinkronisasi Otomatis**: Sync registry ketat (Zod allowlist, delta cursor `(updated_at, id)`, HLC conflict audit, dan rollback protection).
- **Autentikasi & RBAC**: Login offline desktop + Web NextAuth/Argon2, role management (`super_admin`, `admin`, `manager`, `staff`, `cashier`, `viewer`).
- **Contoh Modul POS Siap Pakai**: Modul `products` lengkap dengan Drizzle schema, CRUD service, dan UI interaktif di dashboard.


## Development login

- username: `admin`
- email: `admin@starter.local`
- password: `admin123`

Set `STARTER_ADMIN_PASSWORD` and replace the bootstrap account before using
this starter in production.

### Cara mengatur login development

Web dan desktop memakai database yang berbeda, jadi pilih salah satu cara di
bawah sesuai runtime yang ingin dijalankan.

#### Pilihan A: desktop lokal tanpa Turso

Untuk mencoba aplikasi desktop dan login offline, Turso belum perlu
dikonfigurasi:

```powershell
cd E:\Freelance\Project\backup-app
bun install
bun desktop
```

Login pertama menggunakan akun bootstrap di atas. Tauri akan membuat database
SQLite lokal `hybrid-starter.db` di application-data directory Windows secara
otomatis. Setelah berhasil login, konfigurasi Turso dapat dimasukkan melalui
panel **Secure cloud sync** jika sinkronisasi ingin diuji.

Perintah desktop yang valid adalah salah satu dari berikut:

```powershell
bun desktop
# atau
bun tauri dev
```

Jangan menggunakan `bun tauri:dev`, karena script dengan nama tersebut tidak
ada di `package.json`.

> Catatan: `STARTER_ADMIN_PASSWORD` adalah konfigurasi seed server/web. Login
> bootstrap SQLite desktop pada starter ini tetap menggunakan `admin123` saat
> database lokal pertama kali dibuat. Sebelum menjadikan starter sebagai
> produk produksi, sediakan flow ganti password/account setup dan jangan
> mendistribusikan credential default.

#### Pilihan B: web development tanpa Turso

Untuk mencoba `bun dev` tanpa akun Turso, buat file `.env.local` di root
project dengan konfigurasi development berikut:

```dotenv
AUTH_DATABASE_URL="file:./starter-web-dev.db"
AUTH_SECRET="ganti-dengan-random-secret-minimal-32-karakter"
AUTH_TRUST_HOST=true
AUTH_URL="http://localhost:3000"
NEXTAUTH_URL="http://localhost:3000"

NEXT_PUBLIC_APP_NAME="Hybrid Starter"
NEXT_PUBLIC_APP_VERSION="0.1.0"

STARTER_ADMIN_PASSWORD="ganti-password-development-ini"
```

Jangan isi `AUTH_DATABASE_URL` dengan nilai contoh
`libsql://your-project.turso.io`, karena itu hanya placeholder dan akan membuat
login gagal tersambung. Setelah `.env.local` disimpan, jalankan:

```powershell
bun dev
```

Buka `http://localhost:3000`, kemudian login dengan username `admin` atau email
`admin@starter.local` dan password yang dipasang pada
`STARTER_ADMIN_PASSWORD`.

Password seed hanya digunakan ketika akun bootstrap belum ada. Mengubah
`STARTER_ADMIN_PASSWORD` setelah `starter-web-dev.db` terbentuk tidak otomatis
mengubah password akun yang sudah tersimpan. Untuk database development yang
belum berisi data penting, database tersebut dapat dibuat ulang; untuk data
yang harus dipertahankan, ubah password melalui flow manajemen akun yang aman.

#### Pilihan C: web development dengan Turso

Jika Turso sudah tersedia, gunakan URL dan database-scoped token asli di
`.env.local`:

```dotenv
AUTH_DATABASE_URL="libsql://nama-database.turso.io"
AUTH_DATABASE_AUTH_TOKEN="token-auth-database"
SYNC_DATABASE_URL="libsql://nama-database.turso.io"
SYNC_DATABASE_AUTH_TOKEN="token-sync-database"

AUTH_SECRET="ganti-dengan-random-secret-minimal-32-karakter"
AUTH_TRUST_HOST=true
AUTH_URL="http://localhost:3000"
NEXTAUTH_URL="http://localhost:3000"
STARTER_ADMIN_PASSWORD="ganti-password-bootstrap-ini"
```

Jangan menambahkan awalan `NEXT_PUBLIC_` pada URL/token database. File
`.env.local` juga tidak boleh disalin ke backup publik atau dimasukkan ke Git.

## Start

Pasang dependency terlebih dahulu:

```powershell
bun install
```

Untuk desktop lokal, jalankan:

```powershell
bun desktop
```

Untuk web, buat `.env.local` menggunakan konfigurasi pada bagian
**Development login**, lalu jalankan `bun dev`. Jangan langsung menyalin
placeholder `.env.example` tanpa mengganti URL dan token databasenya.

## Instalasi dan menjalankan aplikasi desktop (Windows)

Bagian ini adalah catatan untuk memakai kembali backup source code yang bersih.

### 1. Persiapan komputer development

Pastikan komputer sudah mempunyai:

- Bun 1.3 atau lebih baru;
- Node.js 22 atau lebih baru;
- Rust stable dan Cargo;
- Microsoft Visual Studio Build Tools dengan workload **Desktop development
  with C++**;
- Microsoft Edge WebView2 Runtime.

Kemudian buka PowerShell di folder project dan pasang dependency:

```powershell
cd E:\Freelance\Project\backup-app
bun install
Copy-Item .env.example .env
```

File `.env` yang berisi credential asli tidak ikut disimpan di backup. Isi ulang
konfigurasi yang dibutuhkan dan jangan memasukkan token atau password ke Git.

### 2. Menjalankan desktop untuk development

```powershell
bun desktop
```

Perintah tersebut menjalankan Next.js dan Tauri dalam mode development. Ini
**bukan** proses instalasi aplikasi. Kompilasi pertama dapat memerlukan waktu
lama dan membuat `src-tauri/target` berukuran beberapa GB karena berisi cache
kompilasi Rust.

Alternatif yang sama:

```powershell
bun tauri dev
```

Hentikan development server dengan `Ctrl+C`.

### 3. Membuat installer Windows MSI

Jalankan validasi sebelum membuat installer:

```powershell
bunx biome check .
bunx tsc --noEmit
bun run test --run
bun run build
bun run build:desktop
```

Kemudian buat installer:

```powershell
bun tauri build
```

Installer akan dibuat di:

```text
src-tauri\target\release\bundle\msi\
```

Konfigurasi saat ini hanya menargetkan MSI. Kelulusan build MSI tidak berarti
installer NSIS juga sudah diuji.

### 4. Memasang aplikasi seperti pengguna biasa

1. Buka folder `src-tauri\target\release\bundle\msi`.
2. Klik dua kali file `.msi` yang dihasilkan.
3. Ikuti Windows Installer sampai selesai.
4. Jalankan aplikasi melalui Start Menu.
5. Login dengan akun bootstrap, segera ganti password default, lalu atur
   **Secure cloud sync** dari dashboard jika Turso akan digunakan.

Pengguna akhir hanya memerlukan file MSI. Mereka tidak memerlukan source code,
Bun, Node.js, Rust, `node_modules`, atau folder `src-tauri/target`.

### 5. Folder yang tidak perlu masuk backup source

Folder berikut dapat dibuat ulang dan sebaiknya tidak disalin:

```text
node_modules/
.next/
.desktop-runtime-staging/
src-tauri/target/
src-tauri/gen/schemas/
src-tauri/desktop-runtime/runtime-bundle.tar
src-tauri/desktop-runtime/runtime-config.json
```

Jika hanya ingin membersihkan hasil kompilasi development Rust tanpa menghapus
build release/MSI, jalankan:

```powershell
cd src-tauri
cargo clean --profile dev
cd ..
```

Menjalankan `bun desktop` atau `bun tauri build` akan membuat kembali artefak
yang diperlukan.

## Create a product

1. Change `src/config/product.ts`, Tauri identity, icons, environment names,
   and the keyring service names in `src-tauri/src/desktop_config.rs`.
2. Add domain code under `src/modules/<module>`.
3. Extend `src/core/db/schema.ts` and `src/core/db/migrations.ts`.
4. Register synced tables and Zod schemas in `src/lib/sync/registry.ts`.
5. Implement both web server and desktop local adapters.
6. Validate web, desktop development, and the MSI artifact independently.

Cloud credentials must remain server/native-only. Never add a
`NEXT_PUBLIC_*` database token.

## Secure desktop sync

Kontrak implementasi dan checklist saat menambah tabel dirangkum di
[`SYNC_CHECKPOINT.md`](./SYNC_CHECKPOINT.md).

The desktop write path is always:

1. write to local SQLite;
2. increment `version` and HLC;
3. set `syncStatus` to `pending` in the same transaction;
4. continue working offline;
5. let the embedded local server push and pull when online.

Use `pendingSyncMetadata` and `pendingSoftDeleteMetadata` from
`src/lib/sync/mutation.ts` when implementing a local domain service.

The webview never receives a Turso token. Packaged desktop saves the token in
the operating-system keyring and passes it only to the embedded server process.
Sync endpoints additionally require all of the following:

- loopback host;
- same-origin request;
- Tauri user agent;
- dedicated request header;
- random HttpOnly desktop session cookie.

To configure packaged desktop:

1. create a Turso database and a database-scoped token;
2. open **Secure cloud sync** on the desktop dashboard;
3. enter `libsql://...` and the token;
4. save and restart the app;
5. use **Sync now** and inspect pending/failed counts.

The token cannot be read back from JavaScript. Only its final four-character
hint is exposed. Legacy plaintext config is migrated to the keyring and the
plaintext secret is removed.

This built-in direct-Turso mode assumes the desktop device and its operating
system account are trusted by the organization. Keyring storage protects
secrets at rest; it cannot protect a token from a fully compromised device or
local administrator. For public SaaS, untrusted customer devices, or strict
multi-tenant isolation, replace direct-Turso transport with a hosted sync
gateway. Only the gateway should hold the Turso token, and it must validate the
user, device, tenant, permission, payload schema, and idempotency key before
writing cloud data.

Every multi-tenant domain table must include a `tenant_id`/organization
boundary and validate it server-side. A client-supplied tenant ID is never
sufficient authorization by itself.

### Conflict and delete policy

- winner order: `version`, then HLC, then `updated_at`, then deterministic ID;
- pending local rows that lose are recorded in `sync_conflicts` before being
  replaced;
- audit payloads redact `password_hash`;
- pull uses exact composite per-table cursors (`updated_at`, then `id`);
- a failed pull row stops that table before the cursor advances, so a malformed
  or temporarily conflicting cloud row cannot be skipped silently;
- any failed push/pull row marks the run as failed instead of reporting a
  misleading successful sync;
- the desktop panel reports pending/failed queues per registered table;
- important business rows use tombstones (`deleted_at`), not hard delete;
- rows with `sync_status = error` are retried on the next push.

For POS payments, stock movements, ledgers, and other high-value transactions,
prefer append-only events plus idempotency keys. Do not model financial history
as an ordinary last-write-wins row.

The bundled SQLite driver is not SQLCipher. Local data is protected by the OS
user boundary and should be combined with BitLocker/FileVault or an explicit
SQLCipher integration when encrypted-at-rest storage is required.
