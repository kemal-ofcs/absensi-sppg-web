import { describe, expect, test } from "bun:test";
import { periksaWaktuImport } from "./waktu-import";

// Vektor yang sama dengan `waktu_import_vektor_kembar` di administration.rs.
const HARI_INI = "2026-10-23";
const JAM_SEKARANG = "06:30";

describe("periksaWaktuImport", () => {
  const kasus: [string, string, string | null][] = [
    ["2026-10-20", "22:00", null],
    [
      "2026-10-24",
      "07:00",
      "Tanggal 2026-10-24 belum terjadi; absensi berjam hanya boleh untuk hari ini atau sebelumnya.",
    ],
    [
      HARI_INI,
      "22:00",
      "Jam masuk 22:00 pada 2026-10-23 belum terjadi. Untuk shift malam, isi tanggal hari shift dimulai.",
    ],
    [HARI_INI, "06:30:00", null],
    [HARI_INI, "", null],
  ];
  for (const [tanggal, masuk, harapan] of kasus) {
    test(`${tanggal} ${masuk || "(tanpa jam masuk)"}`, () => {
      expect(periksaWaktuImport(tanggal, masuk, HARI_INI, JAM_SEKARANG)).toBe(
        harapan,
      );
    });
  }
});
