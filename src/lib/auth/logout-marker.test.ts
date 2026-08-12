import { describe, expect, test } from "bun:test";
import {
  clearForcedLogoutMarker,
  hasForcedLogoutMarker,
  setForcedLogoutMarker,
} from "@/lib/auth/logout-marker";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
}

describe("forced logout marker", () => {
  test("mencegah pemulihan sesi sampai login baru berhasil", () => {
    const storage = memoryStorage();
    expect(hasForcedLogoutMarker(storage)).toBe(false);
    setForcedLogoutMarker(storage);
    expect(hasForcedLogoutMarker(storage)).toBe(true);
    clearForcedLogoutMarker(storage);
    expect(hasForcedLogoutMarker(storage)).toBe(false);
  });
});
