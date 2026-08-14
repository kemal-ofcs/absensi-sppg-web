import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createClient } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getServerSyncStatus,
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
    expect(push.tables.find((table) => table.table === "roles")).toMatchObject({
      uploaded: 1,
      failed: 0,
    });
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

  it("does not advance a pull cursor past a row that failed validation", async () => {
    const localUrl = process.env.AUTH_DATABASE_URL;
    const cloudUrl = process.env.SYNC_DATABASE_URL;
    if (!localUrl || !cloudUrl) throw new Error("Test databases are missing");
    const local = createClient({ url: localUrl });
    const cloud = createClient({ url: cloudUrl });

    await runServerSync("push");
    await cloud.execute(`
      INSERT INTO roles (
        id, name, description, version, hlc, created_at, updated_at,
        deleted_at, sync_status
      ) VALUES
        ('a-valid', 'staff', 'Valid before failure', 1,
         '1767225600000-000001-cloud', 1767225600, 1767225600, NULL, 'synced'),
        ('b-invalid', 'not_a_role', 'Invalid role', 1,
         '1767225600000-000002-cloud', 1767225600, 1767225600, NULL, 'synced'),
        ('c-valid', 'admin', 'Valid after failure', 1,
         '1767225600000-000003-cloud', 1767225600, 1767225600, NULL, 'synced')
    `);

    const expectedError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    try {
      await expect(runServerSync("pull")).rejects.toMatchObject({
        code: "SYNC_PULL_ROW_FAILED",
      });
      expect(expectedError).toHaveBeenCalledWith(
        "[SYNC_PULL:roles]",
        expect.any(Error),
      );
    } finally {
      expectedError.mockRestore();
    }

    expect(
      (await local.execute("SELECT id FROM roles WHERE id = 'a-valid'")).rows,
    ).toHaveLength(1);
    expect(
      (await local.execute("SELECT id FROM roles WHERE id = 'c-valid'")).rows,
    ).toHaveLength(0);
    expect(
      (
        await local.execute(
          "SELECT last_updated_at, last_id FROM sync_cursors WHERE table_name = 'roles'",
        )
      ).rows[0],
    ).toMatchObject({ last_updated_at: 1767225600, last_id: "a-valid" });

    await cloud.execute(
      "UPDATE roles SET name = 'super_admin' WHERE id = 'b-invalid'",
    );
    const retry = await runServerSync("pull");
    expect(retry.downloaded).toBe(2);
    expect(
      (
        await local.execute(
          "SELECT COUNT(*) AS total FROM roles WHERE id IN ('a-valid', 'b-invalid', 'c-valid')",
        )
      ).rows[0]?.total,
    ).toBe(3);

    await local.close();
    await cloud.close();
  });

  it("marks a partial push failure as an error and keeps the row retryable", async () => {
    const localUrl = process.env.AUTH_DATABASE_URL;
    if (!localUrl) throw new Error("Test database is missing");
    const local = createClient({ url: localUrl });

    await runServerSync("push");
    await local.execute(`
      INSERT INTO roles (
        id, name, description, version, hlc, created_at, updated_at,
        deleted_at, sync_status
      ) VALUES (
        'role-invalid', 'not_a_role', 'Invalid local role', 1,
        '1767225600000-000001-test-device', 1767225600, 1767225600,
        NULL, 'pending'
      )
    `);

    const expectedError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    try {
      await expect(runServerSync("push")).rejects.toMatchObject({
        code: "SYNC_PARTIAL_FAILURE",
      });
      expect(expectedError).toHaveBeenCalledWith(
        "[SYNC_PUSH:roles]",
        expect.any(Error),
      );
    } finally {
      expectedError.mockRestore();
    }

    expect(
      (
        await local.execute(
          "SELECT sync_status FROM roles WHERE id = 'role-invalid'",
        )
      ).rows[0]?.sync_status,
    ).toBe("error");
    const status = await getServerSyncStatus();
    expect(status.failed).toBe(1);
    expect(status.lastRun).toMatchObject({ status: "error", failed: 1 });
    expect(
      status.tables.find((table) => table.table === "roles"),
    ).toMatchObject({ pending: 0, failed: 1 });

    await local.close();
  });
});
