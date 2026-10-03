import { describe, expect, test } from "bun:test";
import type { IdCardPrintLayoutConfig } from "@/types/id-card";
import {
  buildPrintPages,
  DEFAULT_PRINT_LAYOUT_PRESETS,
  getCardsPerPage,
  getCenteredMarginsMm,
  getCropMarkLinesMm,
  getGridOriginMm,
} from "./print-layout-store";

/** A4 tegak, 2 × 5, margin 10 di semua sisi: tata letak dari laporan bug. */
const A4: IdCardPrintLayoutConfig = {
  presetId: "uji",
  presetName: "Uji",
  paperSize: "a4",
  paperWidthMm: 210,
  paperHeightMm: 297,
  gridCols: 2,
  gridRows: 5,
  marginTopMm: 10,
  marginBottomMm: 10,
  marginLeftMm: 10,
  marginRightMm: 10,
  gapColMm: 5,
  gapRowMm: 2,
  showCropMarks: false,
  cropMarkLengthMm: 3.5,
  cropMarkOffsetMm: 1.5,
  bleedMm: 0,
  showCardBorder: false,
  duplexMode: "duplex",
  flipAxis: "long_edge",
  duplexPositionMode: "auto_mirror",
  printerOffsetXMm: 0,
  printerOffsetYMm: 0,
};
const W = 85.6;
const H = 54;

/** Posisi fisik di lembar, dilihat dari sisi depan, untuk kartu di sisi belakang. */
function fisikDariBelakang(
  layout: IdCardPrintLayoutConfig,
  x: number,
  y: number,
) {
  return layout.flipAxis === "long_edge"
    ? { x: layout.paperWidthMm - x - W, y }
    : { x, y: layout.paperHeightMm - y - H };
}

describe("pembagian halaman cetak", () => {
  test("bolak-balik: 23 kartu menjadi 3 lembar, urut depan lalu belakang", () => {
    const halaman = buildPrintPages(A4, 23, "landscape");
    expect(halaman.map((h) => h.length)).toEqual([10, 10, 10, 10, 3, 3]);
    expect(halaman.map((h) => h[0]?.side)).toEqual([
      "front",
      "back",
      "front",
      "back",
      "front",
      "back",
    ]);
    const tercetak = halaman
      .filter((h) => h[0]?.side === "front")
      .flatMap((h) => h.map((k) => k.cardIndex));
    expect(tercetak).toEqual(Array.from({ length: 23 }, (_, i) => i));
  });

  test("depan saja dan belakang saja: satu halaman per lembar, tidak ada kartu yang dibuang", () => {
    for (const duplexMode of ["front_only", "back_only"] as const) {
      const halaman = buildPrintPages({ ...A4, duplexMode }, 12, "landscape");
      expect(halaman.map((h) => h.length)).toEqual([10, 2]);
    }
  });

  test("berdampingan: 5 kartu per halaman A4, kartu ke-6 pindah halaman", () => {
    const layout = { ...A4, duplexMode: "side_by_side" as const };
    expect(getCardsPerPage(layout)).toBe(5);
    const halaman = buildPrintPages(layout, 7, "landscape");
    expect(halaman.map((h) => h.length)).toEqual([10, 4]);
    // Depan dan belakang kartu yang sama bersebelahan di baris yang sama.
    const [depan, belakang] = halaman[1] ?? [];
    expect(depan).toEqual({ cardIndex: 5, side: "front", xMm: 10, yMm: 10 });
    expect(belakang).toEqual({
      cardIndex: 5,
      side: "back",
      xMm: 100.6,
      yMm: 10,
    });
    // Tidak ada kartu yang melewati tepi bawah kertas.
    for (const kartu of halaman.flat()) {
      expect(kartu.yMm + H).toBeLessThanOrEqual(layout.paperHeightMm);
    }
  });

  test("preset bawaan berdampingan tetap satu kartu per lembar", () => {
    const preset = DEFAULT_PRINT_LAYOUT_PRESETS.find(
      (p) => p.presetId === "side_by_side_fold",
    );
    expect(preset && getCardsPerPage(preset)).toBe(1);
  });

  test("matriks manual: indeks kartu bergeser per halaman", () => {
    const layout: IdCardPrintLayoutConfig = {
      ...A4,
      duplexMode: "front_only",
      duplexPositionMode: "manual_matrix",
      frontPageSlots: [
        { slotIndex: 3, cardIndex: 0, side: "front" },
        { slotIndex: 0, cardIndex: 1, side: "front" },
        { slotIndex: 5, cardIndex: -1, side: "front" },
      ],
    };
    const halaman = buildPrintPages(layout, 3, "landscape");
    expect(halaman.map((h) => h.map((k) => k.cardIndex))).toEqual([
      [0, 1],
      [2],
    ]);
  });
});

describe("cermin sisi belakang", () => {
  test("titik awal belakang dihitung dari tepi kertas yang berlawanan", () => {
    // Lebar grid 2 × 85,6 + 5 = 176,2; sisa kanan 210 − 10 − 176,2 = 23,8.
    expect(getGridOriginMm(A4, "front", "landscape")).toEqual({ x: 10, y: 10 });
    expect(getGridOriginMm(A4, "back", "landscape")).toEqual({
      x: 23.8,
      y: 10,
    });
  });

  for (const flipAxis of ["long_edge", "short_edge"] as const) {
    test(`setiap kartu belakang jatuh tepat di balik kartu depannya (${flipAxis})`, () => {
      const layout = { ...A4, flipAxis };
      const [depan, belakang] = buildPrintPages(layout, 7, "landscape");
      expect(belakang?.length).toBe(7);
      for (const kartu of depan ?? []) {
        const pasangan = belakang?.find((b) => b.cardIndex === kartu.cardIndex);
        expect(pasangan).toBeDefined();
        const fisik = fisikDariBelakang(
          layout,
          pasangan?.xMm ?? 0,
          pasangan?.yMm ?? 0,
        );
        expect(fisik.x).toBeCloseTo(kartu.xMm, 3);
        expect(fisik.y).toBeCloseTo(kartu.yMm, 3);
      }
    });
  }
});

describe("tengahkan kartu di kertas", () => {
  test("margin kiri-kanan dan atas-bawah membagi rata sisa kertas", () => {
    // Grid 176,2 × 278 di A4 210 × 297.
    const margin = getCenteredMarginsMm(A4, "landscape");
    expect(margin).toEqual({
      marginTopMm: 9.5,
      marginBottomMm: 9.5,
      marginLeftMm: 16.9,
      marginRightMm: 16.9,
    });
    // Setelah ditengahkan, depan dan belakang mulai di titik yang sama.
    const tengah = { ...A4, ...margin };
    expect(getGridOriginMm(tengah, "back", "landscape")).toEqual(
      getGridOriginMm(tengah, "front", "landscape"),
    );
  });

  test("grid yang lebih besar dari kertas mendapat margin 0", () => {
    const margin = getCenteredMarginsMm({ ...A4, gridCols: 3 }, "landscape");
    expect(margin.marginLeftMm).toBe(0);
  });
});

describe("kalibrasi sisi belakang", () => {
  // Diterawang dari depan: baris atas pas, baris bawah belakangnya 2 mm
  // terlalu ke kanan dan 1,5 mm terlalu ke bawah (kertas tebal).
  const terukur = {
    backDriftTopXMm: 0,
    backDriftTopYMm: 0,
    backDriftBottomXMm: 2,
    backDriftBottomYMm: 1.5,
  };

  for (const flipAxis of ["long_edge", "short_edge"] as const) {
    test(`gambar belakang digeser berlawanan dengan selisih terukur (${flipAxis})`, () => {
      const layout = { ...A4, flipAxis, ...terukur };
      const [depan, belakang] = buildPrintPages(layout, 10, "landscape");
      for (const kartu of depan ?? []) {
        const pasangan = belakang?.find((b) => b.cardIndex === kartu.cardIndex);
        const fisik = fisikDariBelakang(
          layout,
          pasangan?.xMm ?? 0,
          pasangan?.yMm ?? 0,
        );
        // Baris 0..4 pada jarak 56 mm; koreksinya naik rata dari atas ke bawah.
        const t = (kartu.yMm - 10) / (4 * 56);
        expect(fisik.x).toBeCloseTo(kartu.xMm - 2 * t, 3);
        expect(fisik.y).toBeCloseTo(kartu.yMm - 1.5 * t, 3);
      }
    });
  }

  test("sisi depan dan mode berdampingan tidak ikut bergeser", () => {
    const layout = { ...A4, ...terukur };
    expect(buildPrintPages(layout, 10, "landscape")[0]).toEqual(
      buildPrintPages(A4, 10, "landscape")[0],
    );
    const berdampingan = { duplexMode: "side_by_side" as const };
    expect(
      buildPrintPages({ ...layout, ...berdampingan }, 5, "landscape"),
    ).toEqual(buildPrintPages({ ...A4, ...berdampingan }, 5, "landscape"));
  });
});

describe("bleed dan tanda potong", () => {
  test("bleed tidak mengubah posisi maupun jarak kartu", () => {
    const tanpa = buildPrintPages(A4, 10, "landscape");
    const dengan = buildPrintPages({ ...A4, bleedMm: 2 }, 10, "landscape");
    expect(dengan).toEqual(tanpa);
    const baris = tanpa[0]?.filter((k) => k.xMm === 10).map((k) => k.yMm);
    expect(baris).toEqual([10, 66, 122, 178, 234]);
  });

  test("tanda potong segaris dengan garis potong kartu", () => {
    expect(getCropMarkLinesMm(A4, 10, 10, "landscape")).toEqual([]);
    const garis = getCropMarkLinesMm(
      { ...A4, showCropMarks: true },
      10,
      10,
      "landscape",
    );
    expect(garis.length).toBe(8);
    // Garis mendatar berada di tepi atas (10) atau tepi bawah (64) kartu,
    // garis tegak di tepi kiri (10) atau kanan (95,6): memotong mengikutinya
    // menghasilkan kartu 85,6 × 54.
    const mendatar = garis.filter(([, , w]) => w > 1).map(([, y]) => y);
    const tegak = garis.filter(([, , , h]) => h > 1).map(([x]) => x);
    expect([...new Set(mendatar)]).toEqual([10, 64]);
    expect([...new Set(tegak)]).toEqual([10, 95.6]);
    // Tidak ada garis yang masuk ke dalam kartu.
    for (const [x, y, w, h] of garis) {
      const diLuar = x + w <= 10 || x >= 95.6 || y + h <= 10 || y >= 64;
      expect(diLuar).toBe(true);
    }
  });
});
