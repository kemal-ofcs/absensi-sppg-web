"use client";

import type {
  FlipAxis,
  IdCardPrintLayoutConfig,
  PrintSlotAssignment,
} from "@/types/id-card";

// ===========================================================================
// Storage Keys
// ===========================================================================

const LS_PRESETS_KEY = "sppg.idcard.print_layout.presets";
const LS_ACTIVE_KEY = "sppg.idcard.print_layout.active_id";

// ===========================================================================
// Helper: Hitung Mirror Back Page
// ===========================================================================

/**
 * Menghitung slot assignment halaman belakang secara otomatis berdasarkan flip axis.
 *
 * Flip long_edge (balik kiri-kanan): mirror kolom → col' = (gridCols - 1) - col
 * Flip short_edge (balik atas-bawah): mirror baris → row' = (gridRows - 1) - row
 *
 * Contoh grid 3×2, flip long_edge:
 *   Depan:    [K1F][K2F][K3F] / [K4F][K5F][K6F]
 *   Belakang: [K3B][K2B][K1B] / [K6B][K5B][K4B]
 */
export function computeMirroredBackLayout(
  frontSlots: PrintSlotAssignment[],
  gridCols: number,
  gridRows: number,
  flipAxis: FlipAxis,
): PrintSlotAssignment[] {
  return frontSlots.map((slot) => {
    const row = Math.floor(slot.slotIndex / gridCols);
    const col = slot.slotIndex % gridCols;

    let mirroredRow = row;
    let mirroredCol = col;

    if (flipAxis === "long_edge") {
      // Balik kiri-kanan → mirror kolom
      mirroredCol = gridCols - 1 - col;
    } else {
      // Balik atas-bawah → mirror baris
      mirroredRow = gridRows - 1 - row;
    }

    const mirroredSlotIndex = mirroredRow * gridCols + mirroredCol;

    return {
      slotIndex: mirroredSlotIndex,
      cardIndex: slot.cardIndex,
      side: "back" as const,
    };
  });
}

/**
 * Menghasilkan slot assignment default (row-major order, semua kartu terurut).
 * cardIndex mengikuti urutan slot: slot 0 = karyawan ke-0, slot 1 = karyawan ke-1, dst.
 */
export function buildDefaultFrontSlots(
  gridCols: number,
  gridRows: number,
): PrintSlotAssignment[] {
  const total = gridCols * gridRows;
  return Array.from({ length: total }, (_, i) => ({
    slotIndex: i,
    cardIndex: i,
    side: "front" as const,
  }));
}

// ===========================================================================
// Dimensi Kertas Standar
// ===========================================================================

/** Mengembalikan dimensi kertas dalam milimeter berdasarkan jenis kertas. */
export function getPaperDimensionsMm(
  size: IdCardPrintLayoutConfig["paperSize"],
  customW?: number,
  customH?: number,
): { widthMm: number; heightMm: number } {
  switch (size) {
    case "cr80":
      return { widthMm: 85.6, heightMm: 54 };
    case "a4":
      return { widthMm: 210, heightMm: 297 };
    case "f4":
      return { widthMm: 215, heightMm: 330 };
    case "letter":
      return { widthMm: 215.9, heightMm: 279.4 };
    case "a3":
      return { widthMm: 297, heightMm: 420 };
    case "custom":
      return {
        widthMm: customW ?? 210,
        heightMm: customH ?? 297,
      };
  }
}

// ===========================================================================
// 5 Preset Bawaan
// ===========================================================================

export const DEFAULT_PRINT_LAYOUT_PRESETS: IdCardPrintLayoutConfig[] = [
  {
    presetId: "cr80_direct",
    presetName: "CR80 Direct — Printer Kartu PVC",
    isBuiltIn: true,
    paperSize: "cr80",
    paperWidthMm: 85.6,
    paperHeightMm: 54,
    gridCols: 1,
    gridRows: 1,
    marginTopMm: 0,
    marginBottomMm: 0,
    marginLeftMm: 0,
    marginRightMm: 0,
    gapColMm: 0,
    gapRowMm: 0,
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
  },
  {
    presetId: "a4_portrait_2x5",
    presetName: "A4 Portrait Grid 2×5 + Crop Marks",
    isBuiltIn: true,
    paperSize: "a4",
    paperWidthMm: 210,
    paperHeightMm: 297,
    gridCols: 2,
    gridRows: 5,
    marginTopMm: 8,
    marginBottomMm: 8,
    marginLeftMm: 8,
    marginRightMm: 8,
    gapColMm: 5,
    gapRowMm: 4,
    showCropMarks: true,
    cropMarkLengthMm: 3.5,
    cropMarkOffsetMm: 1.5,
    bleedMm: 1,
    showCardBorder: false,
    duplexMode: "duplex",
    flipAxis: "long_edge",
    duplexPositionMode: "auto_mirror",
    printerOffsetXMm: 0,
    printerOffsetYMm: 0,
  },
  {
    presetId: "a4_landscape_3x2",
    presetName: "A4 Landscape Grid 3×2 + Crop Marks",
    isBuiltIn: true,
    paperSize: "a4",
    paperWidthMm: 297,
    paperHeightMm: 210,
    gridCols: 3,
    gridRows: 2,
    marginTopMm: 8,
    marginBottomMm: 8,
    marginLeftMm: 8,
    marginRightMm: 8,
    gapColMm: 6,
    gapRowMm: 6,
    showCropMarks: true,
    cropMarkLengthMm: 3.5,
    cropMarkOffsetMm: 1.5,
    bleedMm: 1,
    showCardBorder: false,
    duplexMode: "duplex",
    flipAxis: "long_edge",
    duplexPositionMode: "auto_mirror",
    printerOffsetXMm: 0,
    printerOffsetYMm: 0,
  },
  {
    presetId: "f4_portrait_2x5",
    presetName: "F4 Folio Portrait Grid 2×5 + Crop Marks",
    isBuiltIn: true,
    paperSize: "f4",
    paperWidthMm: 215,
    paperHeightMm: 330,
    gridCols: 2,
    gridRows: 5,
    marginTopMm: 10,
    marginBottomMm: 10,
    marginLeftMm: 10,
    marginRightMm: 10,
    gapColMm: 5,
    gapRowMm: 5,
    showCropMarks: true,
    cropMarkLengthMm: 3.5,
    cropMarkOffsetMm: 1.5,
    bleedMm: 1,
    showCardBorder: false,
    duplexMode: "duplex",
    flipAxis: "long_edge",
    duplexPositionMode: "auto_mirror",
    printerOffsetXMm: 0,
    printerOffsetYMm: 0,
  },
  {
    presetId: "side_by_side_fold",
    presetName: "Berdampingan Lipat — Depan & Belakang 1 Halaman",
    isBuiltIn: true,
    // Lebar = 2 × 85.6 mm + gap 5 mm = 176.2 mm (landscape, 1 baris)
    paperSize: "custom",
    paperWidthMm: 176.2,
    paperHeightMm: 54,
    gridCols: 2,
    gridRows: 1,
    marginTopMm: 0,
    marginBottomMm: 0,
    marginLeftMm: 0,
    marginRightMm: 0,
    gapColMm: 5,
    gapRowMm: 0,
    showCropMarks: false,
    cropMarkLengthMm: 3.5,
    cropMarkOffsetMm: 1.5,
    bleedMm: 0,
    showCardBorder: true,
    duplexMode: "side_by_side",
    flipAxis: "long_edge",
    duplexPositionMode: "auto_mirror",
    printerOffsetXMm: 0,
    printerOffsetYMm: 0,
  },
];

// ===========================================================================
// Fungsi CRUD Preset (localStorage)
// ===========================================================================

function isBrowser(): boolean {
  return typeof window !== "undefined" && typeof localStorage !== "undefined";
}

/** Memuat semua preset dari localStorage, digabung dengan preset bawaan. */
export function loadPrintLayoutPresets(): IdCardPrintLayoutConfig[] {
  if (!isBrowser()) return [...DEFAULT_PRINT_LAYOUT_PRESETS];

  try {
    const raw = localStorage.getItem(LS_PRESETS_KEY);
    const userPresets: IdCardPrintLayoutConfig[] = raw
      ? (JSON.parse(raw) as IdCardPrintLayoutConfig[])
      : [];

    const userPresetMap = new Map(userPresets.map((p) => [p.presetId, p]));
    // Preset bawaan: gunakan versi modifikasi user jika ada, fallback ke bawaan asli
    const result = DEFAULT_PRINT_LAYOUT_PRESETS.map(
      (builtin) => userPresetMap.get(builtin.presetId) ?? builtin,
    );
    // Tambahkan preset kustom buatan pengguna
    for (const p of userPresets) {
      if (
        !DEFAULT_PRINT_LAYOUT_PRESETS.some((b) => b.presetId === p.presetId)
      ) {
        result.push(p);
      }
    }
    return result;
  } catch {
    return [...DEFAULT_PRINT_LAYOUT_PRESETS];
  }
}

/** Menyimpan seluruh preset ke localStorage. */
export function savePrintLayoutPresets(
  presets: IdCardPrintLayoutConfig[],
): void {
  if (!isBrowser()) return;
  try {
    localStorage.setItem(LS_PRESETS_KEY, JSON.stringify(presets));
  } catch {
    // localStorage error — abaikan
  }
}

/** Mendapatkan preset yang sedang aktif. Fallback ke preset pertama jika tidak ada. */
export function getActivePrintLayout(): IdCardPrintLayoutConfig {
  if (!isBrowser()) return DEFAULT_PRINT_LAYOUT_PRESETS[0];

  const activeId = localStorage.getItem(LS_ACTIVE_KEY) ?? "";
  const all = loadPrintLayoutPresets();
  return all.find((p) => p.presetId === activeId) ?? all[0];
}

/** Menyimpan ID preset yang sedang aktif ke localStorage. */
export function setActivePrintLayoutId(presetId: string): void {
  if (!isBrowser()) return;
  localStorage.setItem(LS_ACTIVE_KEY, presetId);
}

/** Menyimpan atau memperbarui satu preset. */
export function upsertPrintLayoutPreset(preset: IdCardPrintLayoutConfig): void {
  if (!isBrowser()) return;

  const all = loadPrintLayoutPresets();
  const existingIdx = all.findIndex((p) => p.presetId === preset.presetId);
  let updated: IdCardPrintLayoutConfig[];
  if (existingIdx >= 0) {
    updated = all.map((p) => (p.presetId === preset.presetId ? preset : p));
  } else {
    updated = [...all, preset];
  }
  savePrintLayoutPresets(updated);
}

/** Menghapus preset berdasarkan ID. Preset built-in tidak bisa dihapus. */
export function deletePrintLayoutPreset(presetId: string): void {
  if (!isBrowser()) return;
  const all = loadPrintLayoutPresets();
  const target = all.find((p) => p.presetId === presetId);
  if (!target || target.isBuiltIn) return;

  const updated = all.filter((p) => p.presetId !== presetId);
  savePrintLayoutPresets(updated);

  // Jika preset yang dihapus adalah yang aktif, reset ke preset pertama
  const activeId = localStorage.getItem(LS_ACTIVE_KEY);
  if (activeId === presetId) {
    const fallback = updated[0];
    if (fallback) setActivePrintLayoutId(fallback.presetId);
  }
}

/** Menghasilkan ID preset unik baru berdasarkan timestamp. */
export function generatePresetId(): string {
  return `custom_${Date.now()}`;
}
