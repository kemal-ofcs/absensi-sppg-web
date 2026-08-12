# Hybrid Starter operational rules

This repository is a reusable hybrid application foundation:

- Web: Next.js server routes use Turso/libSQL.
- Desktop: Tauri uses local SQLite first and remains usable offline.
- Sync: desktop pushes and pulls validated domain deltas when online.

The only permitted cloud-sync transport for packaged desktop is the embedded
server route under `/api/sync/*`. Do not recreate a Turso client inside the
Tauri webview and do not expose `get_sync_config` token contents.

## Runtime boundaries

- Client components must never import server database clients.
- Web browser code must never receive Turso credentials.
- Desktop core flows must never require web API routes or a web session.
- New synced entities require `id`, `version`, `updatedAt`, `deletedAt`,
  `syncStatus`, and preferably `hlc`.
- Business entities use soft delete unless an explicit invariant requires
  otherwise.
- Local writes must increment `version`, advance HLC, update `updatedAt`, and
  mark `syncStatus = pending` atomically.
- Cloud payloads must be registered in `src/lib/sync/registry.ts` with an
  explicit column allowlist and strict Zod schema.
- Financial or ledger-like modules use append-only events and idempotency keys,
  not plain LWW updates.
- Direct-Turso desktop sync is only for trusted-device deployments. Public or
  untrusted multi-tenant deployments require a hosted validation gateway; do
  not ship a database write token to those devices.

## Adding a module

Put product-specific code under `src/modules/<module>` and provide:

1. schema and migration changes;
2. Zod input validation;
3. domain/service rules;
4. a web server adapter;
5. a desktop local adapter;
6. sync table registration and conflict policy;
7. unit tests and a runtime-boundary smoke test.

## Validation

Run in order:

```bash
bunx biome check .
bunx tsc --noEmit
bun run test
bun run build
bun run build:desktop
bun tauri build
```

Windows desktop signoff is installer-channel specific. Passing MSI does not
automatically sign off NSIS.
