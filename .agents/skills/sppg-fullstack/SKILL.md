---
name: sppg-fullstack
description: >-
  Expert fullstack guide for SPPG Attendance application covering Next.js 16,
  Tauri v2 Desktop & Android APK development, Turso/LibSQL cloud database,
  local SQLite synchronization, and zero-error quality verification.
---

# SPPG Attendance Fullstack Development Skill

This skill provides mandatory engineering rules and step-by-step procedures for building and maintaining the SPPG Attendance system across Web, Desktop (Tauri v2), and Mobile (Android APK target).

---

## 1. Tri-Platform Database Schema Synchronization (Zero-Drift Policy)

Whenever a table, column, enum, or index is added, renamed, or modified:
**You MUST update ALL schema definitions simultaneously across all runtimes:**

1. **Cloud / Web Database (Turso / LibSQL)**:
   - File: `src/lib/db-schema.ts`
   - Ensure table creation statements, seed defaults, and constraints match exact specifications.
2. **Desktop & Mobile Local Database (SQLite via Rusqlite)**:
   - File: `src-tauri/src/desktop/storage.rs`
   - Update `INITIAL_SCHEMA` and add migration scripts inside `run_migrations()`.
3. **Cloud Sync Contract & Zod Validation Schemas**:
   - Files: `src/lib/server/operational/sync-schema.ts`, `src/lib/server/operational/sync-pull.ts`, `src/lib/server/operational/sync-push.ts`, `src/lib/services/offline-import.ts`.
   - Desktop/Mobile: `src-tauri/src/desktop/sync.rs`.
   - **CRITICAL**: Because sync Zod schemas use `.strict()`, EVERY payload key sent from Rust/SQLite (e.g. `izinkan_multi_sesi` on shifts, `waktu_dibatalkan` & `operator_pembatalan` on backups) MUST exist in the schema to avoid `POST /api/sync/push 400` validation errors.
4. **TypeScript Domain Types & Interfaces**:
   - Files: `src/lib/attendance/time-policy.ts`, `src/lib/gateways/*.ts`, `src/lib/types/`.

> **CRITICAL**: Never rename or add a column on one runtime without immediately updating Desktop Rust SQLite, Web LibSQL, and Sync Outbox serialization. Column name drift causes silent data loss during sync.

---

## 2. Codebase Exploration, Anti-Duplication, & Architecture Preservation

**DILARANG berasumsi. WAJIB memeriksa struktur kode, nama tabel, kolom skema, tipe data, serta helper/fungsi yang sudah ada terlebih dahulu.**

Sebelum menulis atau mengubah kode apapun:
1. **Search & Inspect First**: Selalu cari dan teliti struktur kode asli terlebih dahulu (`grep_search` & `view_file`):
   - Waktu & Shift: `src/lib/attendance/time-policy.ts` (Web) & `src-tauri/src/desktop/time_policy.rs` (Rust).
   - Operasional & Koreksi: `src/lib/services/correction.ts`, `src/lib/services/backup.ts`, `src/lib/services/offline-import.ts`.
   - Sinkronisasi: `src/lib/server/operational/sync-schema.ts` & `src-tauri/src/desktop/sync.rs`.
   - Permission & RBAC: `src/lib/auth/access.ts` (Web) & `src-tauri/src/desktop/auth.rs` (Rust).
   - Export & Formatting: `src/lib/client/excel-export.ts`, `src/lib/client/employee-workbook.ts`.
   - Skema & Validasi: `src/lib/db-schema.ts`, `src-tauri/src/desktop/storage.rs`, `src/lib/validations/stabilization.ts`.
2. **Reuse Existing Functions (Single Source of Truth)**: Selalu gunakan helper dan fungsi yang sudah ada, jangan membuat fungsi duplikat atau menuliskan nama fungsi yang tidak diekspor.
3. **Pelestarian Arsitektur Lama (Zero-Regress & Wajib Konfirmasi)**:
   - DIWAJIBKAN untuk mempertahankan struktur dan arsitektur lama yang sudah berjalan stabil.
   - DILARANG menghapus atau merombak arsitektur tanpa konfirmasi dan persetujuan eksplisit dari User. Jika terdapat kebutuhan perubahan struktural, jelaskan alasannya dan minta konfirmasi User terlebih dahulu.

---

## 3. Ironclad Backend Logic, Data Security & Sync Integrity

Backend logic and database synchronization must adhere to strict defensive programming standards:

1. **Atomic Transaction Isolation**:
   - All multi-table mutations (e.g. employee creation + ID card generation + sync outbox queue) must execute inside a single atomic database transaction (`connection.transaction()` in Rust / `db.batch()` in Web).
   - If any step fails, roll back completely to prevent orphan records.

2. **Sync Outbox & Conflict Resolution**:
   - Every local write operation on Desktop/Mobile must enqueue a record into `desktop_sync_outbox` with unique event ID (`sync::new_event_id`), client ID, domain, operation, and timestamp.
   - Sync conflict priority: `Koreksi Admin` > `Import Offline / Manual` > `Scanner Terminal` > `Generate Sistem`.

3. **Overnight Shift Math & Cross-Day Session Merging ($H+1 \rightarrow H-1$)**:
   - **Overnight Shift (Shift 3)**: When cross-midnight occurs (`jam_pulang < jam_masuk`), scan out date belongs to the next day ($H+1$), and duration is calculated as $(out\_min + 1440) - in\_min$.
   - **Cross-Day Checkout Fallback**: When an admin correction (`Lupa Absen Pulang` / `Kendala Sistem - Jam Pulang`) or offline checkout row is submitted on day $H$ and no check-in is found on day $H$, system MUST search for an unclosed session on yesterday ($H-1$). If found, the checkout is merged into day $H-1$ without creating a duplicate row on day $H$.
   - **Late & Overtime Preservation**: Koreksi jam pulang tidak boleh menimpa atau mereset `menit_terlambat` dari jam masuk yang sudah ada menjadi 0. Jam kerja berlebih otomatis dicatat sebagai `lembur`.
   - **Timeline Normalization**: Kedatangan shift malam setelah tengah malam (misal 00:00 untuk shift 23:00) dinormalisasi (`if arrival < shift_start - 720 { arrival += 1440 }`) agar dihitung sebagai keterlambatan yang akurat.

4. **Per-Shift Auto Multi-Session & Consecutive Shifts**:
   - Every shift configuration in `tbl_shift` has an `izinkan_multi_sesi` toggle (0 = Nonaktif, 1 = Aktif).
   - Only shifts with `izinkan_multi_sesi = 1` (e.g. Satpam 24-jam) permit automatic transition to the next shift on scan after completion.
   - Shifts with `izinkan_multi_sesi = 0` (Office, Production) safely reject subsequent scans after check-out (`ALREADY_CHECKED_OUT`) to protect against accidental double-taps.

5. **Operational Workflows (Koreksi Admin, Backup, Import Manual)**:
   - Always normalize dates (`DD/MM/YYYY` -> `YYYY-MM-DD`) across all input channels.
   - An employee with an active backup assignment in `backup_karyawan` is blocked from regular check-in/import, while the replacement employee assumes the backup shift (`mode_tugas = 'PENGGANTI'`, `id_backup = 'BCK-...'`).
   - If a replacement employee works both their own regular shift and a backup shift on the same day, they produce 2 distinct attendance records with isolated `log_scan` references (`id_referensi`).

6. **Log Scan Deduplication Precision**:
   - Before inserting an admin correction or manual entry into `log_scan`, always delete prior provisional logs matching:
     `WHERE tanggal_kerja = ? AND id_karyawan = ? AND jenis_scan = ? AND sumber_data = '...' AND COALESCE(id_referensi, '') = ?;`
   - **NEVER** use `OR sumber_data = '...'` as that accidentally deletes the opposite scan kind ("Masuk" or "Pulang").

7. **Concurrency & Anti Double-Scan Protection**:
   - All forms and scanner inputs must use synchronous `isSubmittingRef = useRef(false)` locks to immediately reject rapid duplicate dispatches.
   - Clear input state before calling async scan submission and add debounce protection on camera and keyboard events.

---

## 4. End-to-End Feature Implementation Workflow

1. **Schema Sync**: Update `src/lib/db-schema.ts`, `src-tauri/src/desktop/storage.rs`, and `src/lib/server/operational/sync-schema.ts`.
2. **Desktop Tauri Backend (Rust)**:
   - Business logic: `src-tauri/src/desktop/<domain>.rs`.
   - Command wrapper: `src-tauri/src/desktop/commands.rs`.
   - Handler registration: `src-tauri/src/lib.rs`.
   - Build permissions: `src-tauri/build.rs` and `src-tauri/capabilities/default.json`.
3. **Web Backend (Next.js)**:
   - Service logic: `src/lib/services/<domain>.ts`.
   - Route handler: `src/app/api/<domain>/route.ts`.
4. **Gateway Integration**:
   - In `src/lib/gateways/<domain>.ts`, branch between `isDesktopRuntime()` and `requestWebApi()`.
   - Call `kickDesktopSync()` after every mutating action.
5. **Frontend UI**:
   - Build in `src/app/<page>/page.tsx` using `AppShell` and `FeedbackBanner`.
   - Implement `isSubmittingRef` lock and clear loading states.

---

## 5. Quality Gate Zero-Error Checklist

Before completing any task:
1. **Biome Linter & Formatter**:
   - Use `const` for non-reassigned variables (`useConst`).
   - Do not attach `onClick` to non-interactive elements without keyboard accessibility (`useKeyWithClickEvents`).
   - Avoid double blank lines (`\n\n\n`) and blank lines at opening braces.
   - Run `bun run format` (`biome format --write`) to auto-format any styling issues.
2. **Spreadsheet Client Safety**:
   - Never import `exceljs` into `"use client"` files. Use the native Central Directory parser in `src/lib/client/employee-workbook.ts`.
3. **Execute Quality Gate Command**:
   ```bash
   bun run check
   ```
   Ensure Biome linting, TypeScript typechecking, Bun unit tests (`*.test.ts` & `*.test.tsx`), and Rust Cargo tests all pass with 0 errors and 0 warnings.
