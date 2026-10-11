import { describe, expect, test } from "bun:test";
import {
  isTransientDatabaseError,
  withTransientDatabaseRetry,
} from "./database-retry";

describe("transient database retry", () => {
  test("mengenali connect timeout yang tersimpan sebagai cause", () => {
    const cause = Object.assign(new Error("Connect Timeout Error"), {
      code: "UND_ERR_CONNECT_TIMEOUT",
    });
    expect(
      isTransientDatabaseError(new TypeError("fetch failed", { cause })),
    ).toBe(true);
  });

  test("mencoba ulang satu kali lalu mengembalikan hasil", async () => {
    let attempts = 0;
    const result = await withTransientDatabaseRetry(
      async () => {
        attempts++;
        if (attempts === 1) throw new TypeError("fetch failed");
        return "berhasil";
      },
      { delayMs: 0 },
    );

    expect(result).toBe("berhasil");
    expect(attempts).toBe(2);
  });

  test("tidak mencoba ulang error bisnis", async () => {
    let attempts = 0;
    await expect(
      withTransientDatabaseRetry(
        async () => {
          attempts++;
          throw new Error("Data karyawan sudah digunakan.");
        },
        { delayMs: 0 },
      ),
    ).rejects.toThrow("Data karyawan sudah digunakan.");
    expect(attempts).toBe(1);
  });
});
