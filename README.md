# Absensi SPPG

Aplikasi absensi Web dan Desktop Tauri dengan RBAC dinamis serta target sinkronisasi local-first.

## Development

```bash
bun dev
```

Buka `http://localhost:3000`.

## Target build

```bash
# Next.js server build untuk Web/Vercel
bun run build:web

# Static export ke out/ untuk Desktop Tauri
bun run build:desktop

# Packaging Tauri; wajib diberi konfigurasi pelanggan dan otomatis menjalankan build:desktop
bun run tauri:build
```

Perintah `bun run build` diarahkan ke target Web. Konfigurasi Tauri selalu menggunakan target Desktop agar Route Handler Web tidak disalin ke aplikasi Desktop.

## Environment Web/Vercel

Salin nama variable dari `.env.example`. Credential database wajib server-only:

- `TURSO_DATABASE_URL`
- `TURSO_AUTH_TOKEN`

Jangan memakai prefix `NEXT_PUBLIC_` untuk URL atau token Turso. Token yang pernah dipakai sebagai public environment harus dirotasi sebelum deployment production.

Pada Web, login dan RBAC memakai Route Handler same-origin dengan cookie session `HttpOnly`. Endpoint operator dan role tidak menerima identitas actor dari browser; actor selalu dimuat dari session server.

## Environment Desktop per pelanggan

Setiap pembeli wajib mempunyai deployment Vercel dan database Turso sendiri. Sebelum packaging release Desktop, set dua nilai publik berikut pada environment build:

- `SPPG_API_BASE_URL`: origin HTTPS Vercel pelanggan tanpa path.
- `SPPG_OFFLINE_AUTH_MAX_AGE_HOURS`: masa berlaku snapshot login offline, 1-720 jam, sesuai kebijakan yang telah disetujui.

Saat `bun run tauri:dev`, Desktop memakai `http://localhost:3000` agar login dan sinkronisasi selalu menuju server Next lokal yang sedang dijalankan. `SPPG_DEV_API_BASE_URL` dapat diisi bila alamat development memang perlu diganti; nilai release tetap berasal dari `SPPG_API_BASE_URL`.

Nilai tersebut bukan credential database. `TURSO_AUTH_TOKEN` tetap hanya berada pada environment server Vercel dan tidak boleh diberikan ke build Desktop. Installer satu pelanggan tidak boleh didistribusikan ke pelanggan lain karena origin API sudah diikat saat build.

Panduan provisioning lengkap tersedia di `CUSTOMER_DEPLOYMENT_GUIDE.md`.

## Quality gate

```bash
bun run lint
bunx tsc --noEmit
bun test
bun run build:web
bun run build:desktop
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml --lib
```
