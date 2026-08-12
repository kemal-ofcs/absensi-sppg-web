import { describe, expect, it } from "vitest";
import {
  parseSyncRecord,
  redactSyncRecord,
  SYNC_TABLES,
} from "@/lib/sync/registry";

const usersTable = SYNC_TABLES.find((table) => table.name === "users");
if (!usersTable) throw new Error("Users sync table is not registered");

describe("sync registry validation", () => {
  it("rejects unknown columns and invalid roles from cloud", () => {
    expect(() =>
      parseSyncRecord(usersTable, {
        id: "user-1",
        full_name: "User",
        email: "user@example.com",
        username: null,
        role: "untrusted_role",
        password_hash: null,
        is_active: 1,
        last_login_at: null,
        provider: null,
        provider_id: null,
        version: 1,
        hlc: null,
        created_at: 1,
        updated_at: 1,
        deleted_at: null,
        injected_column: "blocked",
      }),
    ).toThrow();
  });

  it("redacts password hashes from conflict audit payloads", () => {
    expect(
      redactSyncRecord(usersTable, {
        id: "user-1",
        password_hash: "$argon2id$secret",
      }),
    ).toEqual({ id: "user-1", password_hash: "[REDACTED]" });
  });
});
