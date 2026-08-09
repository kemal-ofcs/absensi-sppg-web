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

# Packaging Tauri; otomatis menjalankan build:desktop
bun run tauri:build
```

Perintah `bun run build` diarahkan ke target Web. Konfigurasi Tauri selalu menggunakan target Desktop agar Route Handler Web tidak disalin ke aplikasi Desktop.

## Environment Web/Vercel

Salin nama variable dari `.env.example`. Credential database wajib server-only:

- `TURSO_DATABASE_URL`
- `TURSO_AUTH_TOKEN`

Jangan memakai prefix `NEXT_PUBLIC_` untuk URL atau token Turso. Token yang pernah dipakai sebagai public environment harus dirotasi sebelum deployment production.

Pada Web, login dan RBAC memakai Route Handler same-origin dengan cookie session `HttpOnly`. Endpoint operator dan role tidak menerima identitas actor dari browser; actor selalu dimuat dari session server. Desktop masih memakai adapter lokal lama sampai boundary Tauri pada Fase B3 selesai.

## Quality gate

```bash
bun run lint
bunx tsc --noEmit
bun test
bun run build:web
bun run build:desktop
```
