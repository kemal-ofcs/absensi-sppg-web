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
   - When creating or modifying tables/columns, you MUST update all schemas simultaneously: Web Turso (`src/lib/db-schema.ts`), Desktop & Mobile SQLite (`src-tauri/src/desktop/storage.rs`), and Sync Contracts (`src/lib/server/operational/sync-pull.ts`, `sync-push.ts`, `src-tauri/src/desktop/sync.rs`).
5. **Ironclad Backend & Sync Security**:
   - All multi-table mutations must execute inside a single atomic transaction (`connection.transaction()` / `db.batch()`).
   - Every local mutation on Desktop/Mobile must enqueue an outbox event in `desktop_sync_outbox`.
   - Attendance priority hierarchy: `Koreksi Admin` > `Import Offline / Manual` > `Scanner Terminal` > `Generate Sistem`.
   - Always protect forms against race conditions using `isSubmittingRef = useRef(false)`.
6. **Unified Stack & Android APK Readiness**:
   - **Frontend**: Next.js 16 + React 19 + Tailwind CSS v4. Use `ExcelJS` for spreadsheet import/export.
   - **Desktop & Mobile**: Tauri v2 + Rust + SQLite. All logic must use the Gateway abstraction (`isDesktopRuntime()`) and responsive layouts.
   - **Shift 3 (Overnight Shift)**: When cross-midnight occurs (`jam_pulang < jam_masuk`), scan out belongs to $H+1$ (`nextDate`), and duration is $(out\_min + 1440) - in\_min$.

