"use client";

import { useState } from "react";
import { PilihCari } from "@/components/ui/PilihCari";
import {
  type KolomMassal,
  kalimatKonfirmasiMassal,
  validasiNilaiMassal,
} from "./aturanUbahMassal";

// Satu komponen untuk Web/Desktop dan Mobile (`filesToCopy`). Penyimpanannya
// diserahkan ke halaman, karena tiap halaman punya gateway dan banner sendiri.
const INPUT =
  "min-h-11 w-full rounded-xl border border-white/10 bg-slate-950 px-3 text-sm text-white outline-none focus:border-sky-400 disabled:opacity-50";
const TOMBOL =
  "min-h-11 rounded-xl px-4 text-sm font-bold transition disabled:opacity-50";

export type TerapkanMassal = (
  kolom: KolomMassal,
  nilai: string,
  onProgres: (selesai: number) => void,
) => Promise<void>;

interface UbahMassalProps {
  /** Id unik untuk label; dua bilah di satu halaman wajib berbeda. */
  id: string;
  terpilih: string[];
  namaDari: (id: string) => string;
  /** Kata benda jamak di kalimat, misalnya "karyawan". */
  satuan: string;
  kolom: KolomMassal[];
  onTerapkan: TerapkanMassal;
  onKosongkan: () => void;
  sibuk?: boolean;
}

export function UbahMassal({
  id,
  terpilih,
  namaDari,
  satuan,
  kolom,
  onTerapkan,
  onKosongkan,
  sibuk = false,
}: UbahMassalProps) {
  const [keyKolom, setKeyKolom] = useState(kolom[0]?.key ?? "");
  const [nilai, setNilai] = useState("");
  const [menunggu, setMenunggu] = useState(false);
  const [progres, setProgres] = useState<number | null>(null);
  const [galat, setGalat] = useState<string | null>(null);

  const aktif = kolom.find((item) => item.key === keyKolom) ?? kolom[0];
  if (terpilih.length === 0 || !aktif) return null;

  const jumlah = terpilih.length;
  const berjalan = progres !== null;

  const minta = () => {
    const pesan = validasiNilaiMassal(aktif, nilai);
    setGalat(pesan);
    if (!pesan) setMenunggu(true);
  };

  const terapkan = async () => {
    setMenunggu(false);
    setProgres(0);
    try {
      await onTerapkan(aktif, nilai.trim(), setProgres);
      setNilai("");
    } finally {
      setProgres(null);
    }
  };

  return (
    <section
      aria-label={`Ubah massal ${satuan}`}
      className="space-y-3 rounded-2xl border border-sky-400/30 bg-slate-900 p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-semibold text-sky-300">
          {jumlah} {satuan} dipilih
        </p>
        <button
          type="button"
          disabled={berjalan || sibuk}
          onClick={() => {
            setMenunggu(false);
            setGalat(null);
            onKosongkan();
          }}
          className="text-xs font-semibold text-slate-400 hover:text-white disabled:opacity-50"
        >
          Batalkan pilihan
        </button>
      </div>

      <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
        <div>
          <label
            htmlFor={`${id}-kolom`}
            className="mb-1 block text-xs font-semibold text-slate-400"
          >
            Kolom yang diubah
          </label>
          <select
            id={`${id}-kolom`}
            className={INPUT}
            value={aktif.key}
            disabled={berjalan || sibuk}
            onChange={(event) => {
              setKeyKolom(event.target.value);
              setNilai("");
              setMenunggu(false);
              setGalat(null);
            }}
          >
            {kolom.map((item) => (
              <option key={item.key} value={item.key}>
                {item.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label
            htmlFor={`${id}-nilai`}
            className="mb-1 block text-xs font-semibold text-slate-400"
          >
            Nilai baru
          </label>
          {aktif.opsi ? (
            <PilihCari
              id={`${id}-nilai`}
              className={INPUT}
              value={nilai}
              disabled={berjalan || sibuk}
              onChange={(event) => {
                setNilai(event.target.value);
                setMenunggu(false);
              }}
            >
              <option value="">Pilih {aktif.label.toLowerCase()}...</option>
              {aktif.opsi.map((opsi) => (
                <option key={opsi.value} value={opsi.value}>
                  {opsi.label}
                </option>
              ))}
            </PilihCari>
          ) : (
            <input
              id={`${id}-nilai`}
              type={
                aktif.jenis === "tanggal"
                  ? "date"
                  : aktif.jenis === "angka"
                    ? "number"
                    : "text"
              }
              className={INPUT}
              value={nilai}
              disabled={berjalan || sibuk}
              onChange={(event) => {
                setNilai(event.target.value);
                setMenunggu(false);
              }}
            />
          )}
        </div>
        <button
          type="button"
          disabled={berjalan || sibuk || menunggu}
          onClick={minta}
          className={`${TOMBOL} bg-sky-400 text-slate-950 hover:bg-sky-300`}
        >
          Terapkan ke {jumlah} {satuan}
        </button>
      </div>

      {galat ? (
        <p role="alert" className="text-xs text-rose-300">
          {galat}
        </p>
      ) : null}

      {menunggu ? (
        <div className="space-y-2 rounded-xl border border-amber-400/40 bg-slate-950 p-3">
          <p className="text-sm text-slate-200">
            {kalimatKonfirmasiMassal(
              aktif,
              nilai,
              terpilih.map(namaDari),
              satuan,
            )}
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void terapkan()}
              className={`${TOMBOL} bg-amber-400 text-slate-950 hover:bg-amber-300`}
            >
              Ya, terapkan
            </button>
            <button
              type="button"
              onClick={() => setMenunggu(false)}
              className={`${TOMBOL} border border-white/10 text-slate-300 hover:bg-slate-800`}
            >
              Batal
            </button>
          </div>
        </div>
      ) : null}

      {berjalan ? (
        <output className="block text-xs text-sky-300">
          Menyimpan {progres}/{jumlah}...
        </output>
      ) : null}
    </section>
  );
}
