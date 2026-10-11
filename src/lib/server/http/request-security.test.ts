import { expect, mock, test } from "bun:test";

mock.module("server-only", () => ({}));

const { getClientAddress } = await import("./request-security");

function permintaan(headers: Record<string, string>) {
  return new Request("https://sppg.example/api/x", { headers });
}

test("entri kiri X-Forwarded-For isian klien tidak dipercaya", () => {
  // Klien menulis "1.1.1.1"; nginx menambahkan alamat aslinya di kanan.
  expect(
    getClientAddress(permintaan({ "x-forwarded-for": "1.1.1.1, 203.0.113.9" })),
  ).toBe("203.0.113.9");
});

test("satu alamat (Vercel) dan tanpa header tetap berfungsi", () => {
  expect(
    getClientAddress(permintaan({ "x-forwarded-for": "203.0.113.9" })),
  ).toBe("203.0.113.9");
  expect(getClientAddress(permintaan({ "x-real-ip": "198.51.100.4" }))).toBe(
    "198.51.100.4",
  );
  expect(getClientAddress(permintaan({}))).toBe("unknown");
});
