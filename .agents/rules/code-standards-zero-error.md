# Zero-Error & Zero-Warning Code Standards

## 1. Quality Gate Command
Every task and code change must strictly pass:
```bash
bun run check
```
This comprehensive check executes:
1. `bun run lint` (`biome check .` — Biome linter and formatter)
2. `bun run typecheck` (`tsc --noEmit` — Strict TypeScript validation)
3. `bun run test` (`bun scripts/run-tests.ts` — Frontend & Gateway test suite)
4. `bun run test:rust` (`cargo test --manifest-path src-tauri/Cargo.toml` — Tauri Rust tests)

**Result Requirement**: 0 errors, 0 warnings.

---

## 2. Biome Linter & Formatter Precision Rules
To prevent formatting and accessibility failures:

1. **`useConst` Rule**:
   - Always declare variables with `const` unless they are explicitly reassigned.
   - Arrays and objects that are only mutated via `.push()`, `.set()`, etc., MUST use `const`.
2. **`useKeyWithClickEvents` Accessibility Rule**:
   - Never add `onClick` to non-interactive elements (e.g. `<tr>`, `<td>`, `<div>`, `<span>`).
   - Always use semantic `<button>` elements for user interactions or provide corresponding `onKeyDown` handlers.
3. **No Double Blank Lines**:
   - Never leave multiple consecutive empty lines (`\n\n\n`). Use at most 1 empty line between function declarations or major logical blocks.
   - Never leave empty lines immediately after an opening brace `{` or tag body `<td\n\n>`.
4. **Line Width Standard (Max 80 Chars)**:
   - Wrap long logical expressions (`&&`, `||`, binary operations, and ternaries) with clean parentheses across multiple lines.
5. **No Unused Imports / Dead Code**:
   - Remove all unused variables, unused imports, and unreferenced constants before saving.

---

## 3. TypeScript Strictness & Client/Server Boundaries
1. **No `any` Policy**:
   - Use explicit domain interfaces or `Record<string, unknown>`.
   - Narrow `unknown` types safely using `typeof`, optional chaining `?.`, or type guards.
2. **Client vs Server Isolation**:
   - Files with `import "server-only";` (in `src/lib/services/`, `src/lib/server/`) must NEVER be imported into `"use client"` components.
   - Client components must communicate with backend services solely via the Gateway abstraction (`src/lib/gateways/`).

---

## 4. Excel & Spreadsheet Processing Standard
1. **Client-Side Safe Parsing**:
   - Do NOT import heavyweight Node-hybrid libraries (`exceljs`) into `"use client"` Webpack bundles to avoid `TypeError: Cannot assign to read only property 'toString'` in browser strict mode.
   - In browser/client components, use the native Central Directory (EOCD) parser with `DecompressionStream("deflate-raw")` (`src/lib/client/employee-workbook.ts`) and zero-dependency builder (`src/lib/client/excel-export.ts`).
2. **Data Validation**:
   - Validate column headers, reject duplicates, and enforce max batch limits (500 records) before submission.

---

## 5. Rust & Tauri v2 Standards
1. **Explicit Error Handling**:
   - All commands must return `Result<Value, CommandError>`.
   - Never use `.unwrap()` on database or I/O calls in command handlers; map errors to `CommandError::internal()` or explicit validation errors.
2. **Registration Consistency**:
   - Every command declared in `src-tauri/src/desktop/commands.rs` must be registered in:
     - `src-tauri/src/lib.rs` (`tauri::generate_handler![...]`)
     - `src-tauri/build.rs` (`DESKTOP_COMMANDS`)
     - `src-tauri/capabilities/default.json` (`"allow-desktop-..."`)
3. **Zero Compiler Warnings**:
   - Code must compile with 0 warnings under `cargo check` and `cargo test`.
