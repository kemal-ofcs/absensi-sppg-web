export type CardOrientation = "portrait" | "landscape";
export type CardSide = "front" | "back";
export type ElementType =
  | "text"
  | "qr_code"
  | "photo"
  | "company_logo"
  | "static_text";

export interface IdCardElement {
  id: string;
  type: ElementType;
  side: CardSide;
  sourceKey:
    | "employee.name"
    | "employee.nik"
    | "employee.gender"
    | "employee.position"
    | "employee.department"
    | "employee.qr_token"
    | "employee.avatar"
    | "company.name"
    | "company.logo"
    | "company.terms"
    | "company.signature"
    | "static_text";
  staticValue?: string;
  label: string;
  x: number; // Persentase dari kiri (0 - 100%)
  y: number; // Persentase dari atas (0 - 100%)
  width?: number; // Persentase lebar (0 - 100%)
  height?: number; // Persentase tinggi (0 - 100%)
  fontSize: number; // Ukuran font dalam pt/px
  fontWeight?: "normal" | "600" | "bold";
  color: string; // Hex color
  textAlign?: "left" | "center" | "right";
  isUppercase?: boolean;
  visible?: boolean; // Default true, jika false maka elemen tidak dirender di kartu
}

export interface IdCardTemplateConfig {
  id: string;
  name: string;
  orientation: CardOrientation;
  frontBgUrl?: string; // Base64 atau URL asset
  backBgUrl?: string;
  elements: IdCardElement[];
  isActive: boolean;
  createdAt?: string;
  updatedAt?: string;
}

// ===========================================================================
// TIPE DATA UNTUK FITUR SETTING LAYOUT & KERTAS (Print Layout Precision)
// ===========================================================================

/** Ukuran kertas standar yang didukung. "custom" = pengguna isi dimensi manual. */
export type PrintPaperSize =
  | "cr80" // 85.6 × 54 mm — kartu PVC standar
  | "a4" // 210 × 297 mm
  | "f4" // 215 × 330 mm — Folio, umum di percetakan Indonesia
  | "letter" // 215.9 × 279.4 mm
  | "a3" // 297 × 420 mm
  | "custom"; // dimensi diisi manual

/** Mode cetak: sisi mana yang dicetak dan bagaimana halaman disusun. */
export type PrintDuplexMode =
  | "front_only" // satu halaman, sisi depan saja
  | "back_only" // satu halaman, sisi belakang saja
  | "duplex" // dua halaman: depan = hal.1, belakang = hal.2 (mirror-aware)
  | "side_by_side"; // depan + belakang di halaman yang sama berdampingan (untuk laminasi lipat)

/** Sumbu balik kertas saat printer mengerjakan pencetakan duplex. */
export type FlipAxis =
  | "long_edge" // balik pada sisi panjang (flip kiri-kanan) — paling umum
  | "short_edge"; // balik pada sisi pendek (flip atas-bawah)

/** Cara menentukan posisi kartu di halaman belakang saat duplex. */
export type DuplexPositionMode =
  | "auto_mirror" // sistem otomatis menghitung mirror berdasarkan FlipAxis
  | "manual_matrix"; // pengguna menentukan sendiri tiap slot di Position Matrix Editor

/**
 * Satu assignment slot pada lembar kertas.
 * Mendefinisikan: di slot mana, kartu karyawan ke-N, sisi apa, ditempatkan.
 */
export interface PrintSlotAssignment {
  slotIndex: number; // urutan slot di grid, row-major (0 = kiri-atas, dst.)
  cardIndex: number; // indeks karyawan dalam daftar cetak (0-based). -1 = slot kosong
  side: "front" | "back";
}

/**
 * Konfigurasi layout cetak lengkap untuk satu preset.
 * Disimpan per-workstation di localStorage (kunci: sppg.idcard.print_layout).
 * Tidak disinkronkan ke cloud — kalibrasi printer bersifat per-perangkat fisik.
 */
export interface IdCardPrintLayoutConfig {
  // --- Identifikasi Preset ---
  presetId: string; // ID unik, misal "a4-portrait-2x5" atau timestamp
  presetName: string; // Nama tampilan, misal "A4 Portrait Grid 2×5 + Crop Marks"
  isBuiltIn?: boolean; // true = preset bawaan sistem, tidak bisa dihapus

  // --- Ukuran Kertas ---
  paperSize: PrintPaperSize;
  paperWidthMm: number; // selalu terisi (dihitung dari paperSize atau diisi manual)
  paperHeightMm: number;

  // --- Grid Kartu ---
  gridCols: number; // jumlah kolom (1–4)
  gridRows: number; // jumlah baris (1–6)

  // --- Margin Tepi Kertas (mm) ---
  marginTopMm: number;
  marginBottomMm: number;
  marginLeftMm: number;
  marginRightMm: number;

  // --- Jarak Antar Kartu (mm) ---
  gapColMm: number; // jarak horizontal antar kartu
  gapRowMm: number; // jarak vertikal antar kartu

  // --- Tanda Potong & Finishing ---
  showCropMarks: boolean;
  cropMarkLengthMm: number; // panjang garis potong, default 3.5 mm
  cropMarkOffsetMm: number; // jarak garis dari tepi kartu, default 1.5 mm
  bleedMm: number; // bleeding background di luar batas kartu (0–3 mm)
  showCardBorder: boolean; // garis tipis pembatas kartu

  // --- Duplex / Sisi Cetak ---
  duplexMode: PrintDuplexMode;
  flipAxis: FlipAxis; // sumbu balik printer saat duplex
  duplexPositionMode: DuplexPositionMode;

  // Hanya terisi jika duplexPositionMode === "manual_matrix"
  frontPageSlots?: PrintSlotAssignment[]; // assignment slot halaman depan
  backPageSlots?: PrintSlotAssignment[]; // assignment slot halaman belakang

  // --- Kalibrasi Offset Fisik Printer (mm) ---
  printerOffsetXMm: number; // offset horizontal (-5 s.d. +5)
  printerOffsetYMm: number; // offset vertikal (-5 s.d. +5)
}
