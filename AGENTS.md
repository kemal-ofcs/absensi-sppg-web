<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# SPPG Absensi App - Core Engineering Rules

1. **Quality Gate**: Every task must pass `bun run check` (Biome linter, TypeScript strict typecheck, Bun tests, and Rust cargo tests) with 0 errors and 0 warnings. Format issues can be auto-resolved with `bun run format`.
2. **Anti-Asumsi & Single Source of Truth**:
   - DILARANG berasumsi. WAJIB memeriksa struktur kode, nama tabel, kolom skema, dan helper/fungsi yang sudah ada (`grep_search` / `view_file`) sebelum menulis kode baru.
   - Tidak boleh membuat fungsi duplikat atau memanggil nama fungsi/kolom yang tidak sesuai kontrak asli.
3. **Pelestarian Arsitektur Lama & Wajib Konfirmasi Perubahan**:
   - DIWAJIBKAN untuk mempertahankan dan TIDAK mengubah/menghapus struktur maupun arsitektur lama yang sudah berjalan stabil.
   - Jika memang terdapat kebutuhan perubahan arsitektur atau breaking change, WAJIB meminta konfirmasi dan persetujuan User terlebih dahulu sebelum dieksekusi.
4. **Tri-Platform Schema Synchronization (Zero-Drift)**:
   - When creating or modifying tables/columns, you MUST update all schemas simultaneously: Web Turso (`src/lib/db-schema.ts`), Desktop & Mobile SQLite (`src-tauri/src/desktop/storage.rs`), and Sync Contracts (`src/lib/server/operational/sync-push.ts`, `src-tauri/src/desktop/sync.rs`).
5. **Ironclad Backend & Sync Security**:
   - All multi-table mutations must execute inside a single atomic transaction (`connection.transaction()` / `db.batch()`).
   - Every local mutation on Desktop/Mobile must enqueue an outbox event in `desktop_sync_outbox`.
   - Attendance priority hierarchy: `Koreksi Admin` > `Import Offline / Manual` > `Scanner Terminal` > `Generate Sistem`.
   - Always protect forms against race conditions using `isSubmittingRef = useRef(false)`.
   - **Form & Modal Focus Safety**: In dialogs (`Modal`), callback props (`onClose`, `onSubmit`, `onChange`) MUST be stabilized via `useRef` (`onCloseRef.current = onClose`) so inline handler re-renders do NOT re-trigger effects. Never call `.focus()` inside effects that depend on callback props or without `!dialogRef.current?.contains(document.activeElement)` guard (prevents 1-keystroke focus-stealing bug).
6. **Unified Stack & Android APK Readiness**:
   - **Frontend**: Next.js 16 + React 19 + Tailwind CSS v4. Use `ExcelJS` for spreadsheet import/export.
   - **Desktop & Mobile**: Tauri v2 + Rust + SQLite. All logic must use the Gateway abstraction (`isDesktopRuntime()`) and responsive layouts.
   - **Shift 3 (Overnight Shift)**: When cross-midnight occurs (`jam_pulang < jam_masuk`), scan out belongs to $H+1$ (`nextDate`), and duration is $(out\_min + 1440) - in\_min$.
7. **Next.js Static Export Compatibility (`output: "export"`)**:
   - Desktop and Mobile Tauri builds rely on `output: "export"`. Route handlers in `src/app/api/` must NEVER export a `GET` handler (which breaks static exports). Always use `POST /api/<domain>/query/route.ts` or `POST`/`PUT`/`PATCH`/`DELETE` for all API endpoints.
8. **Immersive 3D & Motion UI (Offline-First)**:
   - **Approved stack only**: `three` + `@react-three/fiber` (v9+) + `@react-three/drei`, `@splinetool/react-spline`, `motion` (Framer Motion), `@rive-app/react-canvas`, `detect-gpu`, `zustand`, Draco / `@gltf-transform/*` (devDependency only), plus vendored Aceternity UI & Magic UI components. Anything else (GSAP, Lottie, Babylon, react-spring) needs explicit USER approval.
   - **Zero CDN**: every `.glb`/`.riv`/`.wasm`/decoder/benchmark asset must be bundled under `public/3d/` and referenced by relative path. Rive, `detect-gpu`, Draco, and Spline all default to a CDN — override each one (`setWasmUrl`, `benchmarksURL`, decoder path, local `.splinecode`). Loosening CSP (`connect-src 'self'`, `script-src 'wasm-unsafe-eval'`) is a prerequisite that requires USER confirmation first.
   - **Client-only**: 3D components live in `src/components/visual/`, are `"use client"`, and are loaded via `dynamic(..., { ssr: false })` with a non-3D fallback. Never import `three`/R3F/Spline/Rive from a server component or from `src/lib/**` (those dirs are synced to mobile and must stay platform-neutral).
   - **Hardware gate**: run `detect-gpu` once, map it to tier `high|medium|low|off` (fallback `low` when detection fails), keep a real WebGL guard, allow only one live WebGL context, and dispose geometry/material/texture + `gl.dispose()` + `forceContextLoss()` on unmount.
   - **Device-local preference**: store the visual tier in `localStorage` (`sppg.visual.tier`) only — NEVER in `setting_gex_system` or any synced table, and never add columns/outbox domains/sync routes for visual state. Honor `prefers-reduced-motion`, use existing `--app-*` theme tokens (test dark AND light), and define animations via `@theme` in `globals.css` (Tailwind v4 — do not create `tailwind.config.ts`).
   - Shared visual code is canonical here: register `components/visual` and `lib/stores` in `mobile/scripts/sync-frontend-lib.ts` and install the same pinned versions in both workspaces. Full contract: `.agents/skills/absensi-sppg-rules/references/07-immersive-3d-ui-ux.md`.
9. **Light/Dark Theme Harmony & Symmetric Tone Inversion**:
   - **Base JSX is Dark Mode**: Always use dark base classes (`bg-slate-900`, `bg-slate-950`, `text-white`, `text-slate-400`, `border-white/10`). NEVER put inline light base classes (`bg-white dark:...`).
   - **Light Mode via `globals.css` / Variables**: In `web-desktop`, override centrally via `globals.css` with full container opacity whitelisting (`.bg-slate-900\/95`, etc.). In `mobile`, invert variables in `:root[data-theme="light"]`.
   - **Symmetric Tone Inversion**: Light accent text in dark mode (`text-amber-100`, `text-rose-100`, `text-sky-100`) MUST be inverted to deep high-contrast tones in light mode (e.g. Amber: `#78350f` / `#92400e`, Rose: `#9f1239` / `#be123c`).
   - **Semantic Classes for Critical Elements**: Critical components (recovery code pills, bootstrap panels, modals) MUST carry dedicated semantic classes (`.bootstrap-recovery-code`, `.recovery-code-pill`, etc.) with explicit light mode styles.


10. **Mode Database Lokal (offline-first tanpa server)**:
   - Provider ada **TIGA**, bukan dua: `turso`, `self_hosted`, dan `local_file`. Nilainya disimpan eksplisit di `TursoConfig.provider` dan TIDAK PERNAH ditebak dari bentuk URL. `normalize_database_url` di `turso.rs` adalah satu-satunya gerbangnya.
   - Pada `local_file` yang ditukar hanya **transport**-nya (`LocalTransport` di `sql_backend.rs`), bukan SQL-nya. `ensure_schema()` yang sama membangun database cloud maupun berkas lokal, sehingga drift antara keduanya mustahil secara struktural.
   - Perangkat memegang **DUA berkas terpisah**: `desktop-security.db` (operasional + outbox) dan `sppg-hub.db` (berperan sebagai cloud). Mutasi lokal hanya menyentuh yang pertama; hub baru terisi lewat `push_outbox`.
   - `export_database` dan promosi ke cloud sama-sama membaca **hub**. Outbox yang tidak terkuras berarti cadangan dan migrasi kehilangan data tanpa satu pun pesan error — karena itu mesin sinkronisasi TETAP WAJIB berjalan di mode lokal.
   - Formulir provisioning mode ini sengaja tidak punya kolom alamat, jadi provider WAJIB ditentukan SEBELUM alamat kosong ditolak.
11. **Android Scoped Storage & Perintah Khusus Mobile**:
   - DILARANG menulis langsung ke `/storage/emulated/0/Download`. Sejak Android 10 penulisan itu ditolak dan gagal secara DIAM: berkas tetap dibuat di folder privat, pemanggil melapor sukses, pengguna tidak pernah menemukannya.
   - Berkas untuk pengguna diserahkan lewat dialog Storage Access Framework (`tauri-plugin-android-fs`, di-`cfg` khusus Android). WAJIB `android_fs_async()`, bukan `android_fs()` — dialognya menunggu manusia dan memblokir thread runtime akan membekukan antarmuka termasuk dialog itu sendiri. Pengguna yang menutup dialog adalah PEMBATALAN, bukan kegagalan.
   - Perintah yang hanya ada di biner Mobile hidup di modul di luar daftar salin `sync-rust-modules.ts` dan namanya WAJIB berawalan `mobile_`; di gateway bersama dipanggil dari dalam blok `if (isMobileRuntime()) { … }` (guard POSITIF). Keduanya adalah bentuk yang dikenali `audit:contract`.
12. **Pemulihan Password: TIGA jalur, jangan asumsikan email**:
   - Jalurnya `email`, `in_app` (persetujuan peninjau), dan kode pemulihan cetak. Pemilihnya `password_reset_route` / `resolvePasswordResetRoute`; nilai eksplisit di `setting_gex_system` menang lebih dulu, baru `app_mail_config.is_active` sebagai bawaan — urutan ini tidak boleh dibalik.
   - Pada jalur `in_app`, `verify` TIDAK membuat token; token lahir di layar peninjau saat `approve`. Versi yang selalu mengirim email membuat "Lupa Password" mati total di setiap pemasangan tanpa konfigurasi email.
   - `password_reset.approve` masuk `SENSITIVE_MUTATION_PERMISSIONS` bersama `password_reset.delete`.
   - `generateRecoveryCodes`/`normalizeRecoveryCode` (TS) dan padanan Rust-nya wajib tetap identik, termasuk membuang setiap karakter non-alfanumerik.
