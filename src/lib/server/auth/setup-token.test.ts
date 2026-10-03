import { describe, expect, mock, test } from "bun:test";

mock.module("server-only", () => ({}));

const { matchesSetupToken, resolveSetupToken } = await import(
  "@/lib/server/auth/setup-token"
);

const TOKEN = "k7Qm2vXw9Lr4Tz8Bn1Hc6Yd3Fs5Gj0Pa";

describe("token pemasangan", () => {
  test("kosong berarti provisioning lewat browser dimatikan", () => {
    expect(resolveSetupToken({})).toEqual({ state: "disabled" });
    expect(resolveSetupToken({ KOS_SETUP_TOKEN: "   " })).toEqual({
      state: "disabled",
    });
  });

  test("token pendek tidak pernah membuka provisioning", () => {
    expect(resolveSetupToken({ KOS_SETUP_TOKEN: "rahasia123" })).toEqual({
      state: "weak",
    });
    expect(resolveSetupToken({ KOS_SETUP_TOKEN: TOKEN.slice(0, 31) })).toEqual({
      state: "weak",
    });
  });

  test("token 32 karakter ke atas diterima, spasi tepi dibuang", () => {
    expect(resolveSetupToken({ KOS_SETUP_TOKEN: ` ${TOKEN}\n` })).toEqual({
      state: "ready",
      token: TOKEN,
    });
  });

  test("pencocokan menolak token lain, termasuk yang panjangnya berbeda", () => {
    expect(matchesSetupToken(TOKEN, TOKEN)).toBe(true);
    expect(matchesSetupToken(TOKEN, ` ${TOKEN} `)).toBe(true);
    expect(matchesSetupToken(TOKEN, `${TOKEN}x`)).toBe(false);
    expect(matchesSetupToken(TOKEN, TOKEN.slice(1))).toBe(false);
    expect(matchesSetupToken(TOKEN, "")).toBe(false);
  });
});
