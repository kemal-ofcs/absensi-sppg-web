import { describe, expect, test } from "bun:test";
import { assertOnlineSecurityMutation } from "./security-mutation";

describe("security mutation runtime guard", () => {
  test("tidak menganggap Bun CLI sebagai browser offline", () => {
    expect(() => assertOnlineSecurityMutation("Harus online.")).not.toThrow();
  });

  test("menolak mutasi ketika browser benar-benar offline", () => {
    expect(() =>
      assertOnlineSecurityMutation("Harus online.", {
        isBrowser: true,
        isOnline: false,
      }),
    ).toThrow("Harus online.");
  });

  test("mengizinkan mutasi ketika browser online", () => {
    expect(() =>
      assertOnlineSecurityMutation("Harus online.", {
        isBrowser: true,
        isOnline: true,
      }),
    ).not.toThrow();
  });
});
