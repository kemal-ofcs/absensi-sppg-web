# SPPG App - Tech Stack & Architecture Rules

## 1. Unified Stack Overview
- **Frontend Framework**: Next.js 16 (App Router) + React 19 + TypeScript (Strict).
- **Styling**: Tailwind CSS v4 + Vanilla CSS utilities for high-performance glassmorphism and modern UI.
- **Desktop Runtime**: Tauri v2 (Rust 2021 edition) + SQLite (via `rusqlite`).
- **Web / Cloud Backend**: Next.js Server Actions & API Routes + Turso (LibSQL via `@libsql/client`).
- **Mobile Target (Android APK)**: Tauri v2 Android target & responsive PWA architecture with offline SQLite synchronization.

---

## 2. Tri-Platform Database Schema Synchronization (Zero-Drift Policy)
Whenever a table, column, enum, or index is added, renamed, or modified:
1. **Web / Turso (`src/lib/db-schema.ts`)**: Update SQL schemas, table definitions, and initial migrations.
2. **Desktop & Mobile SQLite (`src-tauri/src/desktop/storage.rs`)**: Update `INITIAL_SCHEMA` and migration scripts in `run_migrations()`.
3. **Sync Serialization Contracts (`src/lib/server/operational/sync-pull.ts`, `sync-push.ts`, `src-tauri/src/desktop/sync.rs`)**: Ensure all JSON field names match table column names 100% identically across platforms.
4. **TypeScript Domain Models**: Keep domain interfaces in `src/lib/` synchronized.

---

## 3. Codebase Exploration & Anti-Duplication Rule (Single Source of Truth)
**Never assume or create duplicate functions, utilities, or constants.**
1. **Search Before Coding**: Use `grep_search` to verify if existing helpers exist in `src/lib/attendance/time-policy.ts`, `src-tauri/src/desktop/time_policy.rs`, `src/lib/auth/`, etc.
2. **Reuse Existing Functions**: Always import and reuse established single sources of truth.
3. **Centralize Shared Logic**: If logic is needed across multiple pages or handlers, place it in a common shared module rather than duplicating.

---

## 4. Ironclad Backend Logic & Sync Security
1. **Atomic Transaction Isolation**: All multi-statement write operations must execute in a single database transaction (`connection.transaction()` in Rust / `db.batch()` in Web). Roll back on any failure.
2. **Sync Outbox & Conflict Resolution**: Every local modification must insert an event into `desktop_sync_outbox`. Follow deterministic conflict resolution: `Koreksi Admin` > `Import Offline / Manual` > `Scanner Terminal` > `Generate Sistem`.
3. **Defensive Validation**:
   - Verify all date/time strings (`YYYY-MM-DD`, `HH:mm:ss`).
   - Calculate overnight shift cross-midnight math as $H+1$ and duration as $(out\_min + 1440) - in\_min$.
   - Guard against negative durations (`Math.max(0, ...)`).
4. **Deduplication**: Proactively delete stale provisional logs before inserting manual entries or admin corrections.
5. **Double-Click Lock**: Protect all forms with `isSubmittingRef = useRef(false)`.

---

## 5. Gateway Pattern & Runtime Abstraction
Always abstract database & native device interactions through the gateway layer in `src/lib/gateways/`:
1. Check runtime via `isDesktopRuntime()`.
2. Desktop/Mobile: invoke Tauri IPC command (`invokeDesktop("desktop_command_name", payload)`).
3. Web: request REST API / Server Action (`requestWebApi("/api/...", method, body)`).
4. After state mutations, always invoke `kickDesktopSync()` to push mutations to cloud outbox.

---

## 6. Tauri v2 Desktop & Mobile Rust Backend Rules
When adding or updating Rust backend functionality:
1. **Atomic Batch Transactions**: Implement dedicated bulk handlers (`import_employees`, `import_offline`) executing inside a single `connection.transaction()`.
2. **Permission & Command Registration**:
   - Declare command in `src-tauri/src/desktop/commands.rs`.
   - Register in `src-tauri/src/lib.rs` inside `tauri::generate_handler![...]`.
   - Add command name to `DESKTOP_COMMANDS` in `src-tauri/build.rs`.
   - Add permission string to `src-tauri/capabilities/default.json`.
3. **Rust Compilation & Warnings**: All Rust code must compile with 0 warnings (`cargo test --manifest-path src-tauri/Cargo.toml`).

---

## 7. Android APK & Mobile Readiness
1. **Responsive Viewport**: All tables must support horizontal scrolling with sticky headers (`overflow-x-auto`, `min-w-[...]`).
2. **Camera & QR Scanner**: Use standard ZXing / media devices with fallback permissions for mobile webviews.
3. **Offline-First Storage**: Ensure all critical features function seamlessly offline on local SQLite before syncing.
