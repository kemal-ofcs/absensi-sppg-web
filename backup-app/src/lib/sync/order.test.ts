import { describe, expect, it } from "vitest";
import { compareSyncOrder, nextHlc } from "@/lib/sync/order";

describe("sync ordering", () => {
  it("orders by version, HLC, updated time, then id", () => {
    const base = {
      id: "a",
      version: 2,
      hlc: "1767225600000-000001-device-a",
      updated_at: 1767225600,
    };
    expect(compareSyncOrder({ ...base, version: 3 }, base)).toBe(1);
    expect(
      compareSyncOrder({ ...base, hlc: "1767225600000-000002-device-b" }, base),
    ).toBe(1);
    expect(compareSyncOrder({ ...base, id: "b" }, base)).toBe(1);
  });

  it("increments the logical counter when wall time does not advance", () => {
    expect(
      nextHlc({
        last: "1767225600000-000004-device-a",
        nodeId: "DEVICE B!",
        now: 1767225599000,
      }),
    ).toBe("1767225600000-000005-deviceb");
  });
});
