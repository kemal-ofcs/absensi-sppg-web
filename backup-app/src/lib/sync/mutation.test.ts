import { describe, expect, it } from "vitest";
import {
  pendingSoftDeleteMetadata,
  pendingSyncMetadata,
} from "@/lib/sync/mutation";

describe("local-first mutation metadata", () => {
  it("increments version and queues a local write", () => {
    const metadata = pendingSyncMetadata({
      current: { version: 4, hlc: null },
      nodeId: "device-a",
      now: 1767225600000,
    });
    expect(metadata.version).toBe(5);
    expect(metadata.syncStatus).toBe("pending");
    expect(metadata.updatedAt).toEqual(new Date("2026-01-01T00:00:00.000Z"));
  });

  it("uses a tombstone instead of hard delete", () => {
    const metadata = pendingSoftDeleteMetadata({
      current: { version: 1 },
      nodeId: "device-a",
      now: 1767225600000,
    });
    expect(metadata.deletedAt).toEqual(metadata.updatedAt);
    expect(metadata.version).toBe(2);
  });
});
