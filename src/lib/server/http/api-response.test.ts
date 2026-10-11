import { expect, mock, test } from "bun:test";

mock.module("server-only", () => ({}));

test("kegagalan fetch database dilaporkan sebagai layanan sementara", async () => {
  const { toApiErrorResponse } = await import("./api-response");
  const response = toApiErrorResponse(new TypeError("fetch failed"));

  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({
    sukses: false,
    pesan:
      "Database server sedang tidak dapat dijangkau. Periksa koneksi internet lalu coba sinkronkan kembali.",
  });
});
