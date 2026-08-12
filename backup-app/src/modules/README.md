# Application modules

Create product-specific modules here. Each module should own its validation,
service rules, web adapter, desktop adapter, sync registration, and tests.

## Synced entity checklist

1. Add the table to `src/core/db/schema.ts` and its migration.
2. Include `id`, `version`, `hlc`, `createdAt`, `updatedAt`, `deletedAt`, and
   `syncStatus`.
3. Add an allowlisted snake_case column list and strict Zod schema to
   `src/lib/sync/registry.ts`.
4. In the desktop service, write the business change and pending sync metadata
   in one SQLite transaction.
5. Use `pendingSoftDeleteMetadata` instead of hard delete.
6. Test invalid cloud payloads, retry behavior, and two-device conflicts.

Example metadata preparation:

```ts
const deviceId = await getSyncDeviceId();
const sync = pendingSyncMetadata({
  current: existing,
  nodeId: deviceId,
});

await db.update(products).set({ ...input, ...sync }).where(eq(products.id, id));
```

The `deviceId` is not a secret. Keep it stable per installation so HLC ties are
deterministic.
