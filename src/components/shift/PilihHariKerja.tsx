"use client";

import { NAMA_HARI } from "@/lib/validations/hari-kerja";

/**
 * Tujuh kotak centang hari kerja shift. Dipakai halaman Shift Web/Desktop dan
 * Mobile (disalin lewat `filesToCopy`).
 */
export function PilihHariKerja({
  value,
  onChange,
}: {
  value: readonly number[];
  onChange: (hari: number[]) => void;
}) {
  const ubah = (hari: number, dipilih: boolean) =>
    onChange(
      dipilih
        ? [...value, hari].sort((a, b) => a - b)
        : value.filter((h) => h !== hari),
    );

  return (
    <fieldset className="rounded-2xl border border-slate-800 bg-slate-950/80 p-3.5">
      <legend className="px-1 text-sm font-semibold text-slate-200">
        Hari kerja
      </legend>
      <p className="mt-0.5 text-[11px] leading-relaxed text-slate-400">
        Di hari yang tidak dicentang, pemegang shift ini tidak diberi Alfa, dan
        jam kerjanya masuk Jam Kerja Hari Libur di rekap gaji.
      </p>
      <div className="mt-2.5 flex flex-wrap gap-2">
        {NAMA_HARI.map((nama, indeks) => {
          const hari = indeks + 1;
          const dipilih = value.includes(hari);
          return (
            <label
              key={nama}
              className={`flex min-h-11 cursor-pointer items-center gap-2 rounded-xl border px-3 text-sm transition focus-within:ring-2 focus-within:ring-amber-400 ${
                dipilih
                  ? "border-amber-500/60 bg-amber-500/10 font-semibold text-amber-100"
                  : "border-slate-800 text-slate-300 hover:border-slate-600"
              }`}
            >
              <input
                type="checkbox"
                checked={dipilih}
                onChange={(e) => ubah(hari, e.target.checked)}
                className="size-4 accent-amber-500"
              />
              {nama}
            </label>
          );
        })}
      </div>
      {value.length === 0 ? (
        <p role="alert" className="mt-2 text-[11px] text-rose-300">
          Pilih minimal satu hari kerja.
        </p>
      ) : null}
    </fieldset>
  );
}
