"use client";

import { useMemo, useState } from "react";
import { saringPersonil, tambahTerpilih } from "./aturanPilihPersonil";

// Satu komponen untuk Web/Desktop dan Mobile (`filesToCopy`). Kelasnya sama
// dengan isian halaman Operasional di kedua build.
const INPUT =
  "min-h-11 w-full rounded-xl border border-white/10 bg-slate-950 px-3 text-sm text-white outline-none focus:border-sky-400";
const CHIP =
  "min-h-9 rounded-xl border px-3 text-xs font-semibold transition disabled:opacity-50";
const TAMPIL_MAKS = 30;

interface PilihPersonilProps {
  id: string;
  label: string;
  personil: Record<string, unknown>[];
  terpilih: string[];
  onChange: (ids: string[]) => void;
  /** Diisi = boleh memilih banyak karyawan sampai jumlah ini. Kosong = satu orang. */
  batas?: number;
  disabled?: boolean;
}

export function PilihPersonil({
  id,
  label,
  personil,
  terpilih,
  onChange,
  batas,
  disabled = false,
}: PilihPersonilProps) {
  const banyak = batas !== undefined;
  const [kata, setKata] = useState("");
  const [catatan, setCatatan] = useState<string | null>(null);

  const peta = useMemo(
    () => new Map(personil.map((row) => [String(row.id_unik ?? ""), row])),
    [personil],
  );

  const hasil = saringPersonil(personil, kata);
  const idManual = kata.trim();

  const tambah = (ids: string[]) => {
    if (!banyak) {
      onChange(ids.slice(0, 1));
      setKata("");
      return;
    }
    const { hasil: baru, terpotong } = tambahTerpilih(terpilih, ids, batas);
    onChange(baru);
    setCatatan(
      terpotong > 0
        ? `${terpotong} karyawan tidak masuk karena batas ${batas} orang per simpan.`
        : null,
    );
  };

  const alihkan = (idPersonil: string) => {
    if (terpilih.includes(idPersonil)) {
      onChange(terpilih.filter((item) => item !== idPersonil));
    } else {
      tambah([idPersonil]);
    }
  };

  const namaDari = (idPersonil: string) =>
    String(peta.get(idPersonil)?.nama ?? idPersonil);

  const keterangan = (row: Record<string, unknown>) =>
    [String(row.id_unik ?? ""), String(row.divisi ?? "")]
      .filter(Boolean)
      .join(" · ");

  // Mode satu orang yang sudah terpilih: tampilkan orangnya, bukan kotak cari.
  if (!banyak && terpilih[0]) {
    const row = peta.get(terpilih[0]);
    return (
      <div className="space-y-1">
        <span className="text-slate-400 block mb-1 text-xs font-semibold">
          {label}
        </span>
        <div className="flex items-center justify-between gap-3 rounded-xl border border-white/10 bg-slate-950 px-3 py-2">
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-white">
              {namaDari(terpilih[0])}
            </p>
            <p className="truncate text-xs text-slate-400">
              {row
                ? keterangan(row)
                : `ID ${terpilih[0]} (tidak ada di daftar aktif)`}
            </p>
          </div>
          <button
            type="button"
            disabled={disabled}
            onClick={() => onChange([])}
            className={`${CHIP} shrink-0 border-white/10 text-sky-300 hover:bg-slate-800`}
          >
            Ganti
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <label
        htmlFor={`${id}-cari`}
        className="text-slate-400 block text-xs font-semibold"
      >
        {label}
      </label>
      <input
        id={`${id}-cari`}
        type="search"
        className={INPUT}
        placeholder="Ketik nama, ID, kode, atau divisi"
        value={kata}
        disabled={disabled}
        onChange={(event) => setKata(event.target.value)}
      />

      {!idManual ? (
        <p className="text-xs text-slate-400">
          Ketik untuk mencari karyawan aktif.
        </p>
      ) : hasil.length === 0 ? (
        <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
          <span>Tidak ada karyawan aktif yang cocok.</span>
          <button
            type="button"
            disabled={disabled}
            onClick={() => tambah([idManual])}
            className={`${CHIP} border-white/10 text-sky-300 hover:bg-slate-800`}
          >
            Pakai ID &quot;{idManual}&quot;
          </button>
        </div>
      ) : (
        <>
          {banyak ? (
            <button
              type="button"
              disabled={disabled}
              onClick={() =>
                tambah(hasil.map((row) => String(row.id_unik ?? "")))
              }
              className={`${CHIP} border-white/10 text-sky-300 hover:bg-slate-800`}
            >
              Pilih semua hasil ({hasil.length})
            </button>
          ) : null}
          <ul
            aria-label={`Hasil pencarian ${label}`}
            className="max-h-64 divide-y divide-slate-800 overflow-y-auto rounded-xl border border-white/10 bg-slate-950"
          >
            {hasil.slice(0, TAMPIL_MAKS).map((row) => {
              const idPersonil = String(row.id_unik ?? "");
              return (
                <li key={idPersonil}>
                  {banyak ? (
                    <label className="flex min-h-11 cursor-pointer items-center gap-3 px-3 py-2 hover:bg-slate-800/60">
                      <input
                        type="checkbox"
                        className="size-4 shrink-0 accent-sky-400"
                        checked={terpilih.includes(idPersonil)}
                        disabled={disabled}
                        onChange={() => alihkan(idPersonil)}
                      />
                      <span className="min-w-0">
                        <span className="block truncate text-sm text-white">
                          {String(row.nama ?? idPersonil)}
                        </span>
                        <span className="block truncate text-xs text-slate-400">
                          {keterangan(row)}
                        </span>
                      </span>
                    </label>
                  ) : (
                    <button
                      type="button"
                      disabled={disabled}
                      onClick={() => tambah([idPersonil])}
                      className="block min-h-11 w-full px-3 py-2 text-left hover:bg-slate-800/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500"
                    >
                      <span className="block truncate text-sm text-white">
                        {String(row.nama ?? idPersonil)}
                      </span>
                      <span className="block truncate text-xs text-slate-400">
                        {keterangan(row)}
                      </span>
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
          {hasil.length > TAMPIL_MAKS ? (
            <p className="text-xs text-slate-400">
              {hasil.length - TAMPIL_MAKS} lainnya tidak ditampilkan. Persempit
              pencarian untuk melihatnya.
            </p>
          ) : null}
        </>
      )}

      {catatan ? <p className="text-xs text-amber-300">{catatan}</p> : null}

      {banyak && terpilih.length > 0 ? (
        <div className="space-y-1.5 rounded-xl border border-sky-400/30 bg-slate-950 p-2.5">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-semibold text-sky-300">
              {terpilih.length} dipilih (maks. {batas})
            </span>
            <button
              type="button"
              disabled={disabled}
              onClick={() => {
                onChange([]);
                setCatatan(null);
              }}
              className="text-xs font-semibold text-rose-300 hover:text-rose-200 disabled:opacity-50"
            >
              Kosongkan
            </button>
          </div>
          <ul className="flex max-h-40 flex-wrap gap-1.5 overflow-y-auto">
            {terpilih.map((idPersonil) => (
              <li
                key={idPersonil}
                className="flex items-center gap-1 rounded-lg border border-white/10 bg-slate-900 py-0.5 pl-2 pr-0.5 text-xs text-white"
              >
                <span className="max-w-48 truncate">
                  {namaDari(idPersonil)}
                </span>
                <button
                  type="button"
                  aria-label={`Hapus ${namaDari(idPersonil)} dari pilihan`}
                  disabled={disabled}
                  onClick={() => alihkan(idPersonil)}
                  className="grid size-7 place-items-center rounded-md text-slate-400 hover:bg-slate-800 hover:text-white"
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
