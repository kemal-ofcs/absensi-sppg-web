import { describe, expect, test } from "bun:test";
import {
  assertOperatorContact,
  isValidOperatorEmail,
  isValidOperatorPhone,
  maskEmail,
  maskPhone,
  normalizeOperatorEmail,
  normalizeOperatorPhone,
} from "@/lib/operators/contact";

describe("normalizeOperatorPhone", () => {
  test("semua bentuk nomor Indonesia menjadi satu bentuk kanonik", () => {
    // Empat tulisan berbeda untuk nomor yang sama. Tanpa normalisasi, satu
    // operator bisa tersimpan dalam empat bentuk dan pencarian gagal.
    for (const input of [
      "081234567890",
      "+62 812-3456-7890",
      "6281234567890",
      "(0812) 3456 7890",
    ]) {
      expect(normalizeOperatorPhone(input)).toBe("+6281234567890");
    }
  });

  test("nomor internasional dipertahankan bila memakai awalan +", () => {
    expect(normalizeOperatorPhone("+15551234567")).toBe("+15551234567");
  });

  test("masukan tanpa awalan yang dikenali ditolak", () => {
    expect(normalizeOperatorPhone("12345")).toBe("");
    expect(normalizeOperatorPhone("bukan nomor")).toBe("");
    expect(normalizeOperatorPhone("")).toBe("");
  });
});

describe("normalizeOperatorEmail", () => {
  test("email disimpan lowercase agar cocok dengan index LOWER(email)", () => {
    expect(normalizeOperatorEmail("  Operator@SPPG.ID ")).toBe(
      "operator@sppg.id",
    );
  });
});

describe("isValidOperatorEmail", () => {
  test("menerima email wajar", () => {
    expect(isValidOperatorEmail("operator.satu@sppg.id")).toBe(true);
    expect(isValidOperatorEmail("a@b.co")).toBe(true);
  });

  test("menolak bentuk yang tidak lengkap", () => {
    for (const invalid of [
      "",
      "operator",
      "operator@",
      "@sppg.id",
      "operator@sppg",
      "operator @sppg.id",
      "a@b@c.id",
    ]) {
      expect(isValidOperatorEmail(invalid)).toBe(false);
    }
  });
});

describe("isValidOperatorPhone", () => {
  test("menerima panjang nomor yang wajar", () => {
    expect(isValidOperatorPhone("081234567890")).toBe(true);
  });

  test("menolak nomor terlalu pendek atau kosong", () => {
    expect(isValidOperatorPhone("0812")).toBe(false);
    expect(isValidOperatorPhone("")).toBe(false);
  });
});

describe("assertOperatorContact", () => {
  test("lolos untuk kontak lengkap", () => {
    expect(() =>
      assertOperatorContact("operator@sppg.id", "081234567890"),
    ).not.toThrow();
  });

  test("pesan menyebut bidang yang kosong", () => {
    expect(() => assertOperatorContact("", "081234567890")).toThrow(
      "Email operator wajib diisi.",
    );
    expect(() => assertOperatorContact("operator@sppg.id", "")).toThrow(
      "Nomor HP operator wajib diisi.",
    );
    expect(() => assertOperatorContact("bukan-email", "081234567890")).toThrow(
      "Format email operator tidak valid.",
    );
  });
});

describe("penyamaran kontak", () => {
  test("maskEmail menyembunyikan bagian lokal dan domain", () => {
    const masked = maskEmail("operator01@sppg.id");
    expect(masked).not.toContain("operator01");
    expect(masked.startsWith("o")).toBe(true);
    expect(masked).toContain("@");
    expect(masked.endsWith(".id")).toBe(true);
  });

  test("maskEmail aman untuk masukan kosong atau rusak", () => {
    expect(maskEmail("")).toBe("");
    expect(maskEmail("@sppg.id")).toBe("");
  });

  test("maskPhone menyisakan awalan negara dan empat digit terakhir", () => {
    const masked = maskPhone("081234567890");
    expect(masked.startsWith("+62")).toBe(true);
    expect(masked.endsWith("7890")).toBe(true);
    expect(masked).toContain("*");
    expect(masked).not.toContain("123456");
  });

  test("maskPhone mengembalikan string kosong untuk nomor tidak valid", () => {
    expect(maskPhone("bukan nomor")).toBe("");
  });
});
