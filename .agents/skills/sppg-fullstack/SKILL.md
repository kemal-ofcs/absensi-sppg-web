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
3. **Cloud Sync Contract & Outbox Serialization**:
   - Files: `src/lib/server/operational/sync-pull.ts`, `src/lib/server/operational/sync-push.ts`, `src/lib/services/offline-import.ts`.
   - Desktop/Mobile: `src-tauri/src/desktop/sync.rs`.
   - Ensure payload JSON keys map 1-to-1 with table column names.
4. **TypeScript Domain Types & Interfaces**:
   - Files: `src/lib/attendance/time-policy.ts`, `src/lib/gateways/*.ts`, `src/lib/types/`.

> **CRITICAL**: Never rename a column on Web without immediately updating Desktop Rust SQLite and Sync Outbox serialization. Column name drift causes silent data loss during sync.

---

## 2. Codebase Exploration & Anti-Duplication Rule (Single Source of Truth)

**Never assume or create duplicate functions, utilities, or constants.**

Before implementing any logic:
1. **Search First**: Use `grep_search` to check if a helper or logic already exists:
   - Time & Shift calculation: `src/lib/attendance/time-policy.ts` (Web) & `src-tauri/src/desktop/time_policy.rs` (Rust).
   - Permission & RBAC: `src/lib/auth/access.ts` (Web) & `src-tauri/src/desktop/auth.rs` (Rust).
   - Export & Formatting: `src/lib/client/excel-export.ts`, `src/lib/client/employee-workbook.ts`.
   - Validation: `src/lib/validations/stabilization.ts`.
2. **Reuse Existing Functions**: Always import and call established helpers.
3. **No Dual Implementations**: If logic is needed across multiple components, elevate it to a shared module in `src/lib/` or `src-tauri/src/desktop/` instead of writing duplicate inline implementations.

---

## 3. Ironclad Backend Logic, Data Security & Sync Integrity

Backend logic and database synchronization must adhere to strict defensive programming standards:

1. **Atomic Transaction Isolation**:
   - All multi-table mutations (e.g. employee creation + ID card generation + sync outbox queue) must execute inside a single atomic database transaction (`connection.transaction()` in Rust / `db.batch()` in Web).
   - If any step fails, roll back completely to prevent orphan records.
2. **Sync Outbox & Conflict Resolution**:
   - Every local write operation on Desktop/Mobile must enqueue a record into `desktop_sync_outbox` with unique event ID (`sync::new_event_id`), client ID, domain, operation, and timestamp.
   - Sync conflict priority: `Koreksi Admin` > `Import Offline / Manual` > `Scanner Terminal` > `Generate Sistem`.
3. **Defensive Validation & Shift Domain Math**:
   - **Overnight Shift (Shift 3)**: When cross-midnight occurs (`jam_pulang < jam_masuk`), the scan out date belongs to the following day ($H+1$), and duration is calculated as $(out\_min + 1440) - in\_min$.
   - **Negative Duration Guard**: Never produce negative work minutes (`Math.max(0, ...)` / `max(0, ...)`).
   - **Role-Based Permission Enforcement**: Verify operator active status and granular permission before executing any privileged action.
4. **Deduplication & Replay Attack Prevention**:
   - Before inserting a manual entry or admin correction into `log_scan`, always delete prior provisional logs for the same `(tanggal_kerja, id_karyawan, jenis_scan)` to prevent duplicate entries.
5. **Concurrency & Double-Click Protection**:
   - UI forms must use an immediate synchronous `isSubmittingRef = useRef(false)` lock to block rapid duplicate submissions.

---

## 4. End-to-End Feature Implementation Workflow

1. **Schema Sync**: Update `src/lib/db-schema.ts` and `src-tauri/src/desktop/storage.rs`.
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
   - Do not attach `onClick` to non-interactive elements (`<tr>`, `<td>`, `<div>`) without keyboard accessibility (`useKeyWithClickEvents`).
   - Avoid double blank lines (`\n\n\n`) and blank lines at opening braces.
   - Limit lines to 80 characters max with parenthesis wrapping.
2. **Spreadsheet Client Safety**:
   - Never import `exceljs` into `"use client"` files. Use the native Central Directory parser in `src/lib/client/employee-workbook.ts`.
3. **Execute Quality Gate Command**:
   ```bash
   bun run check
   ```
   Ensure Biome linting, TypeScript typechecking, Bun unit tests, and Rust Cargo tests all pass with 0 errors and 0 warnings.
