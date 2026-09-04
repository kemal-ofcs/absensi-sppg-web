import { describe, expect, test } from "bun:test";
import {
  evaluateHolidayScan,
  foldWhitelistText,
  type HolidayWhitelistEntry,
  matchesHolidayWhitelist,
  normalizeHolidayDate,
  normalizeScopeType,
  normalizeScopeValue,
} from "@/lib/validations/holiday-whitelist";

/**
 * Vektor di bawah dieja ULANG PERSIS pada modul test `scanner.rs`
 * (`holiday_whitelist_vectors`).
 *
 * Aturannya dinilai dua kali — server Web menilai dengan modul ini, terminal
 * Desktop/Mobile menilai dengan cerminan Rust-nya — jadi perbedaan sekecil apa
 * pun muncul sebagai "karyawan yang sama boleh scan di Web tapi ditolak di
 * terminal". Sama seperti paritas `ip-allowlist` dan `totp`, satu-satunya
 * penjaga adalah vektor kembar ini.
 */

function entry(over: Partial<HolidayWhitelistEntry>): HolidayWhitelistEntry {
  return {
    id: "hlw-test",
    scope_type: "DIVISI",
    scope_value: "Keamanan",
    tanggal_libur: null,
    keterangan: null,
    status_aktif: 1,
    ...over,
  };
}

describe("normalizeScopeType", () => {
  test("menerima dua cakupan yang sah, apa pun kapitalisasinya", () => {
    expect(normalizeScopeType("SHIFT")).toBe("SHIFT");
    expect(normalizeScopeType("shift")).toBe("SHIFT");
    expect(normalizeScopeType("  Divisi ")).toBe("DIVISI");
  });

  test("menolak cakupan lain", () => {
    expect(normalizeScopeType("")).toBeNull();
    expect(normalizeScopeType("KARYAWAN")).toBeNull();
    expect(normalizeScopeType("jabatan")).toBeNull();
  });
});

describe("normalizeScopeValue", () => {
  test("SHIFT dinormalkan ke desimal tanpa nol di depan", () => {
    expect(normalizeScopeValue("SHIFT", "4")).toBe("4");
    expect(normalizeScopeValue("SHIFT", " 04 ")).toBe("4");
    expect(normalizeScopeValue("SHIFT", "0012")).toBe("12");
  });

  test("SHIFT menolak nilai bukan angka positif", () => {
    expect(normalizeScopeValue("SHIFT", "")).toBeNull();
    expect(normalizeScopeValue("SHIFT", "0")).toBeNull();
    expect(normalizeScopeValue("SHIFT", "-1")).toBeNull();
    expect(normalizeScopeValue("SHIFT", "Satpam")).toBeNull();
    expect(normalizeScopeValue("SHIFT", "1.5")).toBeNull();
  });

  test("DIVISI merapikan spasi tapi mempertahankan huruf aslinya", () => {
    expect(normalizeScopeValue("DIVISI", "  Keamanan  ")).toBe("Keamanan");
    expect(normalizeScopeValue("DIVISI", "Unit   Maintenance")).toBe(
      "Unit Maintenance",
    );
    expect(normalizeScopeValue("DIVISI", "   ")).toBeNull();
  });
});

describe("normalizeHolidayDate", () => {
  test("menerima YYYY-MM-DD dan memotong bagian waktu", () => {
    expect(normalizeHolidayDate("2026-08-17")).toBe("2026-08-17");
    expect(normalizeHolidayDate(" 2026-08-17T08:00:00 ")).toBe("2026-08-17");
  });

  test("menolak bentuk lain", () => {
    expect(normalizeHolidayDate(null)).toBeNull();
    expect(normalizeHolidayDate("")).toBeNull();
    expect(normalizeHolidayDate("17-08-2026")).toBeNull();
    expect(normalizeHolidayDate("2026-13-01")).toBeNull();
    expect(normalizeHolidayDate("2026-00-10")).toBeNull();
    expect(normalizeHolidayDate("2026-08-32")).toBeNull();
  });
});

describe("foldWhitelistText", () => {
  test("membandingkan tanpa peduli spasi dan kapitalisasi", () => {
    expect(foldWhitelistText("  Unit   Keamanan ")).toBe("unit keamanan");
    expect(foldWhitelistText("UNIT KEAMANAN")).toBe("unit keamanan");
  });
});

describe("matchesHolidayWhitelist", () => {
  const context = {
    tanggal: "2026-08-17",
    divisi: "Keamanan",
    kodeShift: 4 as number | null,
  };

  test("cakupan DIVISI cocok tanpa peduli kapitalisasi", () => {
    expect(
      matchesHolidayWhitelist(entry({ scope_value: "keamanan" }), context),
    ).toBe(true);
    expect(
      matchesHolidayWhitelist(entry({ scope_value: "  KEAMANAN  " }), context),
    ).toBe(true);
    expect(
      matchesHolidayWhitelist(entry({ scope_value: "Produksi" }), context),
    ).toBe(false);
  });

  test("cakupan SHIFT cocok pada kode_shift, bukan id_shift", () => {
    expect(
      matchesHolidayWhitelist(
        entry({ scope_type: "SHIFT", scope_value: "4" }),
        context,
      ),
    ).toBe(true);
    expect(
      matchesHolidayWhitelist(
        entry({ scope_type: "SHIFT", scope_value: "04" }),
        context,
      ),
    ).toBe(true);
    expect(
      matchesHolidayWhitelist(
        entry({ scope_type: "SHIFT", scope_value: "5" }),
        context,
      ),
    ).toBe(false);
  });

  test("shift yang tidak dikenal tidak pernah cocok pada cakupan SHIFT", () => {
    expect(
      matchesHolidayWhitelist(
        entry({ scope_type: "SHIFT", scope_value: "4" }),
        { ...context, kodeShift: null },
      ),
    ).toBe(false);
  });

  test("entri nonaktif tidak pernah mengizinkan", () => {
    expect(matchesHolidayWhitelist(entry({ status_aktif: 0 }), context)).toBe(
      false,
    );
  });

  test("tanggal_libur kosong berlaku untuk semua hari libur", () => {
    expect(
      matchesHolidayWhitelist(entry({ tanggal_libur: null }), context),
    ).toBe(true);
    expect(matchesHolidayWhitelist(entry({ tanggal_libur: "" }), context)).toBe(
      true,
    );
    expect(
      matchesHolidayWhitelist(entry({ tanggal_libur: "   " }), context),
    ).toBe(true);
  });

  test("tanggal_libur terisi hanya berlaku pada tanggal itu", () => {
    expect(
      matchesHolidayWhitelist(entry({ tanggal_libur: "2026-08-17" }), context),
    ).toBe(true);
    expect(
      matchesHolidayWhitelist(entry({ tanggal_libur: "2026-12-25" }), context),
    ).toBe(false);
  });

  test("cakupan dan nilai yang tidak sah diabaikan, bukan mengizinkan", () => {
    expect(
      matchesHolidayWhitelist(entry({ scope_type: "JABATAN" }), context),
    ).toBe(false);
    expect(matchesHolidayWhitelist(entry({ scope_value: "  " }), context)).toBe(
      false,
    );
  });
});

describe("evaluateHolidayScan", () => {
  const context = {
    tanggal: "2026-08-17",
    divisi: "Maintenance",
    kodeShift: 2 as number | null,
  };

  test("daftar kosong menolak — bawaan aplikasi tetap 'libur = tidak ada scan'", () => {
    const decision = evaluateHolidayScan([], context);
    expect(decision.allowed).toBe(false);
    expect(decision.matched).toBeNull();
  });

  test("satu entri yang cocok sudah cukup, dan alasannya siap tampil", () => {
    const decision = evaluateHolidayScan(
      [
        entry({ id: "a", scope_value: "Produksi" }),
        entry({ id: "b", scope_value: "maintenance" }),
      ],
      context,
    );
    expect(decision.allowed).toBe(true);
    expect(decision.matched?.id).toBe("b");
    expect(decision.reason).toBe("Divisi maintenance");
  });

  test("cakupan SHIFT juga memberi alasan yang siap tampil", () => {
    const decision = evaluateHolidayScan(
      [entry({ id: "s", scope_type: "SHIFT", scope_value: "02" })],
      context,
    );
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toBe("Shift kode 2");
  });

  test("tidak ada yang cocok tetap menolak", () => {
    const decision = evaluateHolidayScan(
      [
        entry({ scope_value: "Produksi" }),
        entry({ scope_type: "SHIFT", scope_value: "9" }),
      ],
      context,
    );
    expect(decision.allowed).toBe(false);
  });
});
