import { describe, expect, test } from "bun:test";
import { canAccessArea } from "@/lib/auth/access";
import { parseQrToken } from "@/lib/services/attendance";
import {
  createEmployeeIdentifiers,
  firstValidationMessage,
  isValidTime,
  validateEmployeeDraft,
  validateShiftDraft,
} from "./stabilization";

describe("temporary access guard", () => {
  test("membatasi area sensitif untuk role non-Admin", () => {
    const admin = {
      isSuperadmin: false,
      permissions: ["branding.manage", "employees.view"] as const,
    };
    const scanner = {
      isSuperadmin: false,
      permissions: ["scanner.use"] as const,
    };
    expect(canAccessArea(admin, "settings")).toBe(true);
    expect(canAccessArea(scanner, "settings")).toBe(false);
    expect(canAccessArea(scanner, "karyawan")).toBe(false);
    expect(canAccessArea(scanner, "scanner")).toBe(true);
    expect(
      canAccessArea({ isSuperadmin: true, permissions: [] }, "operators"),
    ).toBe(true);
  });
});

describe("employee stabilization", () => {
  test("membuat identitas stabil dari UUID", () => {
    expect(
      createEmployeeIdentifiers("123e4567-e89b-12d3-a456-426614174000"),
    ).toEqual({
      idUnik: "EMP_123E4567E89B",
      kodeKaryawan: "K14174000",
    });
  });

  test("menolak draft karyawan yang belum lengkap", () => {
    const errors = validateEmployeeDraft({
      id_unik: "",
      kode_karyawan: "",
      nama: "A",
      divisi: "",
      id_shift: 0,
    });

    expect(Object.keys(errors)).toHaveLength(5);
    expect(firstValidationMessage(errors)).toBe("ID unik wajib diisi.");
  });
});

describe("shift stabilization", () => {
  test("memvalidasi jam 24 jam", () => {
    expect(isValidTime("07:30")).toBe(true);
    expect(isValidTime("24:00")).toBe(false);
    expect(isValidTime("7:30")).toBe(false);
  });

  test("menolak nilai shift yang tidak aman", () => {
    const errors = validateShiftDraft({
      kode_shift: 0,
      nama_shift: "",
      jam_masuk: "25:00",
      jam_pulang: "25:00",
      toleransi_masuk_menit: -1,
      jam_kerja_normal_menit: 0,
      istirahat_menit: 1500,
    });

    expect(Object.keys(errors)).toHaveLength(7);
  });
});

describe("QR payload", () => {
  test("hanya menerima payload ID dan token QR", () => {
    expect(parseQrToken("EMP_ABC123|TOKEN-QR-01")).toEqual({
      valid: true,
      pesan: "QR Valid.",
      idUnik: "EMP_ABC123",
      token: "TOKEN-QR-01",
    });
    expect(parseQrToken("EMP_ABC123").valid).toBe(false);
    expect(parseQrToken("").valid).toBe(false);
  });
});
