import { describe, expect, test } from "bun:test";
import {
  buildOtpAuthUri,
  decodeBase32,
  encodeBase32,
  generateHotp,
  generateRecoveryCodes,
  generateTotp,
  generateTotpSecret,
  normalizeRecoveryCode,
  TOTP_STEP_SECONDS,
  totpCounter,
  verifyTotp,
} from "@/lib/security/totp";

/**
 * Vektor uji resmi RFC 4226 (HOTP) dan RFC 6238 (TOTP).
 *
 * Ini satu-satunya bukti yang berarti bahwa kode kita akan cocok dengan Google
 * Authenticator: aplikasi itu tidak bisa dijalankan di CI, tetapi ia mengikuti
 * RFC yang sama. Kalau vektor ini lolos, kode yang muncul di ponsel akan cocok.
 */
const RFC4226_SECRET = encodeBase32(
  new TextEncoder().encode("12345678901234567890"),
);

describe("base32", () => {
  test("encode-decode pulang pergi tanpa kehilangan byte", () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    expect(Array.from(decodeBase32(encodeBase32(bytes)))).toEqual(
      Array.from(bytes),
    );
  });

  test("rahasia RFC 4226 menghasilkan base32 yang dikenal luas", () => {
    expect(RFC4226_SECRET).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
  });

  test("memaafkan spasi, tanda hubung, huruf kecil, dan padding", () => {
    // Orang menyalin rahasia dari layar dengan tangan; bentuk-bentuk ini wajar.
    const rapi = decodeBase32("GEZDGNBVGY3TQOJQ");
    expect(Array.from(decodeBase32("gezd gnbv gy3t qojq"))).toEqual(
      Array.from(rapi),
    );
    expect(Array.from(decodeBase32("GEZD-GNBV-GY3T-QOJQ"))).toEqual(
      Array.from(rapi),
    );
    expect(Array.from(decodeBase32("GEZDGNBVGY3TQOJQ===="))).toEqual(
      Array.from(rapi),
    );
  });

  test("menolak karakter di luar alfabet base32", () => {
    expect(() => decodeBase32("GEZD0189")).toThrow("tidak valid");
  });
});

describe("HOTP terhadap vektor RFC 4226", () => {
  test("delapan pencacah pertama menghasilkan kode resmi", async () => {
    const expected = [
      "755224",
      "287082",
      "359152",
      "969429",
      "338314",
      "254676",
      "287922",
      "162583",
    ];
    for (const [counter, code] of expected.entries()) {
      expect(await generateHotp(RFC4226_SECRET, counter)).toBe(code);
    }
  });
});

describe("TOTP terhadap vektor RFC 6238", () => {
  test("stempel waktu resmi menghasilkan kode SHA-1 yang benar", async () => {
    // RFC 6238 Appendix B, baris SHA-1. Kode delapan digit di RFC dipotong
    // menjadi enam digit terakhir karena autentikator memakai enam digit.
    const vectors: [number, string][] = [
      [59, "94287082"],
      [1_111_111_109, "07081804"],
      [1_111_111_111, "14050471"],
      [1_234_567_890, "89005924"],
      [2_000_000_000, "69279037"],
    ];
    for (const [seconds, eightDigits] of vectors) {
      expect(await generateTotp(RFC4226_SECRET, seconds)).toBe(
        eightDigits.slice(-6),
      );
    }
  });

  test("pencacah berganti setiap 30 detik", () => {
    expect(totpCounter(0)).toBe(0);
    expect(totpCounter(TOTP_STEP_SECONDS - 1)).toBe(0);
    expect(totpCounter(TOTP_STEP_SECONDS)).toBe(1);
  });
});

describe("verifyTotp", () => {
  const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
  const now = 1_700_000_000;

  test("menerima kode langkah waktu berjalan", async () => {
    const code = await generateTotp(secret, now);
    expect(await verifyTotp(secret, code, now, 1)).toBe(true);
  });

  test("menerima kode satu langkah sebelum dan sesudah", async () => {
    // Toleransi ini yang membuat kode tetap diterima walau pengguna menekan
    // kirim tepat saat kodenya berganti.
    const sebelum = await generateTotp(secret, now - TOTP_STEP_SECONDS);
    const sesudah = await generateTotp(secret, now + TOTP_STEP_SECONDS);
    expect(await verifyTotp(secret, sebelum, now, 1)).toBe(true);
    expect(await verifyTotp(secret, sesudah, now, 1)).toBe(true);
  });

  test("menolak kode di luar jendela toleransi", async () => {
    const jauh = await generateTotp(secret, now + TOTP_STEP_SECONDS * 5);
    expect(await verifyTotp(secret, jauh, now, 1)).toBe(false);
  });

  test("jendela lebar menerima jam perangkat yang meleset", async () => {
    // Jalur offline memakai jam perangkat, yang pada ponsel murah bisa meleset
    // lebih dari satu menit.
    const meleset = await generateTotp(secret, now + TOTP_STEP_SECONDS * 3);
    expect(await verifyTotp(secret, meleset, now, 1)).toBe(false);
    expect(await verifyTotp(secret, meleset, now, 4)).toBe(true);
  });

  test("menolak kode yang panjangnya bukan enam digit", async () => {
    expect(await verifyTotp(secret, "12345", now, 1)).toBe(false);
    expect(await verifyTotp(secret, "1234567", now, 1)).toBe(false);
    expect(await verifyTotp(secret, "", now, 1)).toBe(false);
  });

  test("memaafkan spasi yang ikut tersalin dari autentikator", async () => {
    const code = await generateTotp(secret, now);
    expect(
      await verifyTotp(secret, `${code.slice(0, 3)} ${code.slice(3)}`, now, 1),
    ).toBe(true);
  });
});

describe("generateTotpSecret", () => {
  test("menghasilkan rahasia 32 karakter yang berbeda tiap panggilan", () => {
    const first = generateTotpSecret();
    const second = generateTotpSecret();
    expect(first).toHaveLength(32);
    expect(first).not.toBe(second);
    expect(decodeBase32(first)).toHaveLength(20);
  });
});

describe("buildOtpAuthUri", () => {
  test("menyusun URI yang bisa dipindai autentikator", () => {
    const uri = buildOtpAuthUri({
      secret: "GEZDGNBVGY3TQOJQ",
      accountLabel: "operator01",
      issuer: "Absensi SPPG",
    });
    expect(uri.startsWith("otpauth://totp/")).toBe(true);
    expect(uri).toContain("secret=GEZDGNBVGY3TQOJQ");
    expect(uri).toContain("algorithm=SHA1");
    expect(uri).toContain("digits=6");
    expect(uri).toContain("period=30");
    // Label memuat issuer supaya beberapa akun SPPG di satu ponsel tidak
    // tampil bertumpuk tanpa keterangan.
    expect(decodeURIComponent(uri)).toContain("Absensi SPPG:operator01");
  });
});

describe("kode cadangan", () => {
  test("menerbitkan kode unik dengan format yang mudah disalin tangan", () => {
    const codes = generateRecoveryCodes(8);
    expect(codes).toHaveLength(8);
    expect(new Set(codes).size).toBe(8);
    for (const code of codes) {
      expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
      // Karakter yang mudah tertukar saat disalin tangan tidak dipakai.
      expect(code).not.toMatch(/[OI01]/);
    }
  });

  test("normalisasi menyamakan bentuk yang diketik ulang", () => {
    expect(normalizeRecoveryCode("abcd-efgh")).toBe("ABCDEFGH");
    expect(normalizeRecoveryCode(" ABCD EFGH ")).toBe("ABCDEFGH");
    // Cerminan `is_ascii_alphanumeric` di Rust: pemisah apa pun dibuang, bukan
    // hanya spasi dan tanda hubung. Kode yang sama wajib menghasilkan hash yang
    // sama di kedua sisi.
    expect(normalizeRecoveryCode("ABCD_EFGH")).toBe("ABCDEFGH");
    expect(normalizeRecoveryCode("ABCD.EFGH")).toBe("ABCDEFGH");
  });
});
