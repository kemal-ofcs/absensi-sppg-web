---
name: sppg-fullstack
description: >-
  Expert fullstack guide for SPPG Attendance application covering Next.js 16,
  Tauri v2 Desktop & Android APK development, Turso/LibSQL cloud database,
  local SQLite synchronization, and zero-error quality verification.
---

# SPPG Attendance Fullstack Development Skill & Knowledge Base

This skill provides mandatory engineering rules, architectural patterns, defensive programming guidelines, and troubleshooting solutions for building and maintaining the SPPG Attendance system across Web, Desktop (Tauri v2), and Mobile (Android APK target).

---

## 1. Tri-Platform Database Schema Synchronization (Zero-Drift Policy)

Whenever a table, column, enum, or index is added, renamed, or modified:
**You MUST update ALL schema definitions simultaneously across all runtimes:**

1. **Cloud / Web Database (Turso / LibSQL)**:
   - Schema: `src/lib/db-schema.ts`
   - Dynamic Migrations: `src/lib/db-migrations.ts` (increment migration step, e.g. migration 7).
   - Migration Tests: `src/lib/rbac/rbac-migration.test.ts` (update expected migration versions array `[1, 2, ..., N]`).
2. **Desktop & Mobile Local Database (SQLite via Rusqlite)**:
   - File: `src-tauri/src/desktop/storage.rs`
   - Update `INITIAL_SCHEMA` table definitions and add migration step in `run_migrations()`.
3. **Cloud Sync Contract & Zod Validation Schemas**:
   - Files: `src/lib/server/operational/sync-schema.ts`, `sync-pull.ts`, `sync-push.ts`, `snapshot.ts`.
   - Snapshot Batch Tests: `src/lib/server/operational/snapshot.test.ts` (ensure mock batch statement count matches total tables).
   - Desktop/Mobile Rust: `src-tauri/src/desktop/sync.rs` (add domain to `TABLES` array).
   - **CRITICAL (Zod .strict())**: Every payload key sent from Rust/SQLite (e.g. `izinkan_multi_sesi`, `waktu_dibatalkan`, `status_aktif`) MUST be declared in the schema to avoid `POST /api/sync/push 400` validation failures.
4. **TypeScript Domain Types & Gateways**:
   - Files: `src/lib/attendance/time-policy.ts`, `src/lib/gateways/*.ts`, `src/lib/types/`.

> **CRITICAL**: Never rename or add a column on one runtime without immediately updating Desktop Rust SQLite, Web LibSQL, and Sync Outbox serialization. Column name drift causes silent data loss during sync.

---

## 2. Codebase Exploration, Anti-Duplication, & Architecture Preservation

**DILARANG berasumsi. WAJIB memeriksa struktur kode, nama tabel, kolom skema, tipe data, serta helper/fungsi yang sudah ada terlebih dahulu.**

1. **Search & Inspect First (`grep_search` & `view_file`)**:
   - Shift & Time: `src/lib/attendance/time-policy.ts` (Web) & `src-tauri/src/desktop/time_policy.rs` (Rust).
   - Operational Workflows: `src/lib/services/correction.ts`, `backup.ts`, `offline-import.ts`, `holiday.ts`, `alfa-audit.ts`.
   - Sync Protocol: `src/lib/server/operational/sync-schema.ts` & `src-tauri/src/desktop/sync.rs`.
   - RBAC & Permissions: `src/lib/rbac/catalog.ts`, `src/lib/auth/access.ts` (Web) & `src-tauri/src/desktop/auth.rs` (Rust).
   - Gateway Layer: `src/lib/gateways/*.ts`.
   - Export & Formatting: `src/lib/client/excel-export.ts`, `src/lib/client/employee-workbook.ts`.
2. **Reuse Existing Functions (Single Source of Truth)**: Always use existing helpers. Never create duplicate helper functions.
3. **Pelestarian Arsitektur Lama (Zero-Regress & Wajib Konfirmasi)**:
   - DIWAJIBKAN untuk mempertahankan struktur dan arsitektur lama yang sudah berjalan stabil.
   - DILARANG merombak arsitektur tanpa konfirmasi dan persetujuan User.

---

## 3. Ironclad Backend Logic, Data Security & Sync Integrity

1. **Atomic Transaction Isolation**:
   - Multi-table mutations must execute inside a single atomic transaction (`connection.transaction()` in Rust / `db.batch()` in Web).
   - If any step fails, roll back completely to prevent orphan records.
2. **Sync Outbox & Conflict Resolution**:
   - Every local mutation on Desktop/Mobile must enqueue a record into `desktop_sync_outbox` with unique event ID (`sync::new_event_id`).
   - Sync priority hierarchy: `Koreksi Admin` > `Import Offline / Manual` > `Scanner Terminal` > `Generate Sistem`.
3. **Overnight Shift Math & Cross-Day Session Merging ($H+1 \rightarrow H-1$)**:
   - **Shift 3 (Overnight)**: When cross-midnight occurs (`jam_pulang < jam_masuk`), scan out belongs to $H+1$, and duration is $(out\_min + 1440) - in\_min$.
   - **Cross-Day Checkout Fallback**: If an admin correction or offline checkout is submitted on day $H$ and no check-in is found on day $H$, system MUST search for an open session on yesterday ($H-1$).
   - **Late & Overtime Preservation**: Checkout corrections must never wipe or reset `menit_terlambat` from the existing check-in to 0. Excess work is stored as `lembur`.
   - **Timeline Normalization**: Night shift arrivals after midnight (e.g. 00:00 for shift 23:00) are normalized (`if arrival < shift_start - 720 { arrival += 1440 }`) for accurate late calculations.
4. **Per-Shift Auto Multi-Session**:
   - Every shift in `tbl_shift` has `izinkan_multi_sesi` (0 = Nonaktif, 1 = Aktif).
   - Only shifts with `izinkan_multi_sesi = 1` permit consecutive shifts on scan after completion. Regular shifts safely reject subsequent scans after check-out (`ALREADY_CHECKED_OUT`).
5. **Holiday Management & Scanner Guard**:
   - Active holidays in `tbl_hari_libur` disable regular attendance scanning.
   - Scans on active holidays are rejected with informative message (*"Scan ditolak: Hari ini Hari Libur..."*) and logged to `log_scan` with status `Ditolak` without creating daily attendance records.
6. **Generate Alfa Harian & Background Automation**:
   - Cutoff formula: `jam_pulang - offset_generate_alfa` (e.g. Shift 1 07:00–15:00 with offset 180 min $\rightarrow$ cutoff 12:00; Shift 3 23:00–07:00 H+1 $\rightarrow$ cutoff 04:00 subuh).
   - Skip criteria: Active holiday on work date, flexible shifts (Shift 4), employees with existing NORMAL sessions, employees with admin priority corrections (Sakit/Izin/Dispen/Alfa), or non-active employees.
   - Automation runner: Mounted in `AppShell` with periodic background checks (e.g. 10s initial delay + 5-minute interval) calling `triggerGenerateAlfa()` silently.

---

## 4. UI/UX Engineering & CSS Sticky Table Precision

1. **Sticky Table Header & Sticky Column Layering (Z-Index Hierarchy)**:
   - When building tables with horizontal and vertical scroll (`max-h-[...] overflow-x-auto`):
     - `<thead>`: `sticky top-0 z-20 bg-slate-950`
     - Regular `<th>`: `sticky top-0 bg-slate-950`
     - Top-Right Pinned `<th>` (Aksi): `sticky top-0 right-0 z-30 bg-slate-950 border-l border-slate-800/80 shadow-md`
     - Body Pinned `<td>` (Aksi): `sticky right-0 z-10 bg-slate-900/95 border-l border-slate-800/80`
   - **Why**: If the header corner `<th>` lacks `top-0` or has `z-10` equal to body `<td>`, vertical scrolling causes body action cells to float over the table header!
2. **Action Column Alignment & Spacing**:
   - Action columns with multiple buttons (e.g. Detail, QR, Edit, Delete) must use:
     - Header: `text-center min-w-[200px]` (or `min-w-[220px]`).
     - Cells: `text-center min-w-[220px]`.
     - Container: `<div className="flex items-center justify-center gap-1.5">`.
3. **Race Condition Protection**:
   - All forms and buttons must use `isSubmittingRef = useRef(false)` to synchronously block rapid duplicate clicks.
4. **Modal Rendering & Accessibility**:
   - Prefer conditional mounting: `{modalData ? <Modal titleId="modal-title" ...> : null}`.
   - Ensure `titleId` matches the modal header heading ID for screen readers.

---

## 5. Troubleshooting & Problem-Solving Guide

### A. Rust / Tauri Desktop Gotchas
1. **Snapshot Apply Panic (`missing key in snapshot`)**:
   - In `src-tauri/src/desktop/sync.rs`, always extract snapshot table rows with fallback:
     ```rust
     let empty_vec = Vec::new();
     let (rows, present) = match snapshot.get(definition.payload_key).and_then(Value::as_array) {
         Some(arr) => (arr, true),
         None => (&empty_vec, false),
     };
     ```
   - Only execute `delete_missing` if `definition.delete_missing && present`.
2. **String Borrow Type Incompatibility in `if/else`**:
   - `text(draft, "field")` returns `&str`. Do not return `String` in the `else` branch (use `"Default"` instead of `"Default".to_owned()`).
3. **Local Timezone in Rust Queries**:
   - When executing time math in SQLite, query Jakarta offset:
     ```sql
     SELECT strftime('%Y-%m-%d', 'now', '+7 hours'), strftime('%H:%M:%S', 'now', '+7 hours');
     ```
4. **Test Helpers in Rust Scanner**:
   - Helper functions like `submit_at` or `submit_internal` must be declared `pub(crate)` so tests in `administration.rs` or `sync.rs` can pass custom simulated timestamps.
5. **Employee Token in Tests**:
   - `operational::create_employee` generates `TOK-{id}-{timestamp}`. Always extract `res["token_absensi"].as_str()` when building scan payloads in unit tests (`format!("{id}|{token}")`).

### B. Next.js & Bun Test Gotchas
1. **`server-only` in Unit Tests**:
   - In Bun unit tests for server services (`src/lib/services/*.test.ts`), mock `server-only` before dynamic import:
     ```ts
     import { mock } from "bun:test";
     mock.module("server-only", () => ({}));
     const { serviceFn } = await import("./service");
     ```
2. **Snapshot Batch Query Mocking**:
   - When adding a new synchronized table, increase the mock statements count in `snapshot.test.ts` to match the exact number of queries executed by the snapshot batch.
3. **Spreadsheet Client Safety**:
   - Never import `exceljs` into `"use client"` components. Use `src/lib/client/employee-workbook.ts` or client CSV/Excel helpers in `src/lib/client/excel-export.ts`.

---

## 6. Quality Gate Zero-Error Checklist

Before completing any task, execute:
```bash
bun run format && bun run check
```
Verify with 0 errors and 0 warnings:
1. **Biome Linter & Formatter**: Clean syntax, no double empty lines, accessible click handlers.
2. **TypeScript Strict Typecheck**: Complete parameter type safety.
3. **Bun Test Suite**: All unit and integration tests passing.
4. **Rust Cargo Tests**: `cargo test --manifest-path src-tauri/Cargo.toml` passing (100% passed).
