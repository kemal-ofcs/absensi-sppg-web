"use client";

// Daftar + rincian HRIS (fase 10, §25.4). Mulai `lg` dua kolom; di bawahnya
// daftar disembunyikan selama ada yang dipilih, supaya rincian tidak jatuh di
// bawah daftar yang harus digulir lebih dulu.

import { type ReactNode, useEffect, useRef } from "react";

const LEBAR_DUA_KOLOM = "(min-width: 1024px)";

export function DaftarRincian({
  daftar,
  adaPilihan,
  onKembali,
  children,
}: {
  daftar: ReactNode;
  /** Ada rincian atau form yang sedang dibuka. */
  adaPilihan: boolean;
  onKembali: () => void;
  children: ReactNode;
}) {
  const akar = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!adaPilihan || window.matchMedia(LEBAR_DUA_KOLOM).matches) return;
    akar.current?.scrollIntoView({ block: "start" });
  }, [adaPilihan]);

  return (
    <div
      ref={akar}
      className="grid gap-4 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]"
    >
      <div className={adaPilihan ? "hidden min-w-0 lg:block" : "min-w-0"}>
        {daftar}
      </div>
      <div className="min-w-0 space-y-4">
        {adaPilihan ? (
          <button
            type="button"
            onClick={onKembali}
            className="min-h-10 rounded-xl border border-slate-700 px-4 text-sm font-bold text-slate-300 hover:bg-slate-800 lg:hidden"
          >
            Kembali ke daftar
          </button>
        ) : null}
        {children}
      </div>
    </div>
  );
}
