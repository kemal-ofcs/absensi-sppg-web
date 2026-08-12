import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createClient } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  resetSyncEngineForTests,
  runServerSync,
} from "@/lib/sync/server-engine";

let testDirectory = "";

describe("server sync engine", () => {
  beforeEach(async () => {
    testDirectory = await mkdtemp(path.join(tmpdir(), "hybrid-sync-"));
    process.env.HYBRID_STARTER_DESKTOP_RUNTIME = "embedded-local-web-server";
    process.env.AUTH_DATABASE_URL = `file:${path.join(testDirectory, "local.db").replaceAll("\\", "/")}`;
    process.env.SYNC_DATABASE_URL = `file:${path.join(testDirectory, "cloud.db").replaceAll("\\", "/")}`;
    process.env.SYNC_DATABASE_AUTH_TOKEN =
      "test-database-token-at-least-32-characters";
    process.env.HYBRID_STARTER_DEVICE_ID = "test-device";
    await resetSyncEngineForTests();
  });

  afterEach(async () => {
    await resetSyncEngineForTests();
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      try {
        await rm(testDirectory, { recursive: true, force: true });
        break;
      } catch (error) {
        if (attempt === 5) {
          const code =
            typeof error === "object" && error && "code" in error
              ? String(error.code)
              : "";
          if (code === "EBUSY") {
            // libSQL's Windows worker releases this temp handle on worker exit.
            break;
          }
          throw error;
        }
        await delay(100 * attempt);
      }
    }
  });

  it("pushes pending local rows and pulls a newer cloud version", async () => {
    const localUrl = process.env.AUTH_DATABASE_URL;
    const cloudUrl = process.env.SYNC_DATABASE_URL;
    if (!localUrl || !cloudUrl) throw new Error("Test databases are missing");
    const local = createClient({ url: localUrl });
    const cloud = createClient({ url: cloudUrl });

    await runServerSync("push");
    await local.execute(`
      INSERT INTO roles (
        id, name, description, version, hlc, created_at, updated_at,
        deleted_at, sync_status
      ) VALUES (
        'role-manager', 'manager', 'Local manager', 1,
        '1767225600000-000000-test-device', 1767225600, 1767225600,
        NULL, 'pending'
      )
    `);

    const push = await runServerSync("push");
    expect(push.uploaded).toBe(1);
    expect(
      (
        await cloud.execute(
          "SELECT description FROM roles WHERE id = 'role-manager'",
        )
      ).rows[0]?.description,
    ).toBe("Local manager");
    expect(
      (
        await local.execute(
          "SELECT sync_status FROM roles WHERE id = 'role-manager'",
        )
      ).rows[0]?.sync_status,
    ).toBe("synced");

    await cloud.execute(`
      UPDATE roles SET
        description = 'Cloud manager',
        version = 2,
        hlc = '1767225601000-000000-cloud-device',
        updated_at = 1767225601
      WHERE id = 'role-manager'
    `);

    const pull = await runServerSync("pull");
    expect(pull.downloaded).toBe(1);
    expect(
      (
        await local.execute(
          "SELECT description, version FROM roles WHERE id = 'role-manager'",
        )
      ).rows[0],
    ).toMatchObject({ description: "Cloud manager", version: 2 });

    await local.close();
    await cloud.close();
  });
});
