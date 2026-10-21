// Kelas dan helper yang dipakai bersama `InventarisWorkspace` dan
// `PanelPemantauan`. Ikut disalin ke Mobile lewat `filesToCopy`.

import { formatJumlah, jumlahDariKetikan } from "@/lib/validations/inventory";

export const INPUT =
  "w-full min-h-11 text-sm rounded-lg px-3 py-2 bg-slate-900 border border-slate-700 text-slate-100 focus:outline-none focus:ring-2 focus:ring-sky-500";
export const LABEL = "block text-xs font-medium text-slate-300 mb-1";
export const TOMBOL_UTAMA =
  "min-h-11 px-4 py-2 text-sm font-semibold rounded-lg bg-sky-600 hover:bg-sky-500 text-white transition-colors disabled:opacity-60 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-300";
export const TOMBOL_KEDUA =
  "min-h-11 px-3 py-2 text-sm font-medium rounded-lg border border-slate-700 text-slate-200 hover:bg-slate-800 transition-colors disabled:opacity-60 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500";
export const TOMBOL_BAHAYA =
  "min-h-11 px-4 py-2 text-sm font-semibold rounded-lg bg-rose-600 hover:bg-rose-500 text-white disabled:opacity-60 focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-300";

/** Hanya untuk nilai awal isian tanggal; backend tetap memvalidasi dengan jam database. */
export function hariIniWib(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta" }).format(
    new Date(),
  );
}

/**
 * Jumlah stok untuk dibaca: 10000 -> "10.000"; barang desimal (tersimpan
 * ×100) 25450 -> "254,50". Hasilnya bisa diketik ulang ke isian jumlah.
 */
export function angka(nilai: number, desimal = false): string {
  return formatJumlah(nilai, desimal);
}

/**
 * Atribut isian jumlah. Selalu teks berformat Indonesia ("1.000", "2,5")
 * dibaca `bacaJumlah`, karena `type="number"` memperlakukan koma dan titik
 * mengikuti bahasa peramban, tidak mengikuti aturan aplikasi.
 */
export function isianJumlah(desimal: boolean) {
  return {
    type: "text",
    inputMode: desimal ? "decimal" : "numeric",
    autoComplete: "off",
  } as const;
}

/** Ketikan jumlah menjadi jumlah tersimpan, atau galat yang siap ditampilkan. */
export function bacaJumlah(
  teks: string,
  desimal: boolean,
  nama = "Jumlah",
): number {
  const nilai = jumlahDariKetikan(teks, desimal);
  if (nilai === null) {
    throw new Error(
      desimal
        ? `${nama} harus angka dengan paling banyak 2 angka di belakang koma, misalnya 2,5.`
        : `${nama} harus bilangan bulat, misalnya 10 atau 1.000.`,
    );
  }
  return nilai;
}

export function pesanGalat(error: unknown, cadangan: string): string {
  return error instanceof Error && error.message ? error.message : cadangan;
}
