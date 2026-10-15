// Kelas dan helper yang dipakai bersama `InventarisWorkspace` dan
// `PanelPemantauan`. Ikut disalin ke Mobile lewat `filesToCopy`.

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

export function pesanGalat(error: unknown, cadangan: string): string {
  return error instanceof Error && error.message ? error.message : cadangan;
}
