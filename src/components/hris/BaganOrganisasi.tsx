"use client";

// Tab Struktur (fase 10, §25.5): Bagan, Fokus, dan Menurut unit, ketiganya
// dari `susunBagan`. Datanya sama dengan daftar karyawan (`employees.view`),
// jadi berjalan offline di Desktop/Mobile. Garis penghubung dari border
// pseudo-element; warna `slate-500` terbaca di kedua tema tanpa CSS baru.

import { type ReactNode, useEffect, useMemo, useState } from "react";
import { PilihCari } from "@/components/ui/PilihCari";
import type { Organisasi } from "@/lib/gateways/hris";
import { LABEL_TANDA_HRIS } from "@/lib/validations/hris";
import {
  type Bagan,
  bukaRantai,
  KEDALAMAN_MAKS_BAGAN,
  kelompokUnit,
  kotakBagan,
  rantaiBagan,
  type SimpulBagan,
  susunBagan,
  TANPA_CABANG,
  terbukaBawaan,
} from "@/lib/validations/hris-bagan";

type Tampilan = "bagan" | "fokus" | "unit";

/** Bagan bawaan mulai lebar `lg`, di bawahnya Fokus (Q-133). */
const LEBAR_BAGAN = "(min-width: 1024px)";
/** Lebih dari ini bawahan langsung ditumpuk ke bawah, bukan ke samping. */
const ANAK_KOLOM = 8;

const TOMBOL = "min-h-10 rounded-xl px-4 text-sm font-bold transition-colors";
const TOMBOL_KECIL =
  "min-h-9 rounded-lg border border-slate-700 px-3 text-xs font-semibold text-slate-300 hover:bg-slate-800";
const KARTU = "rounded-2xl border border-slate-800 bg-slate-900 p-4";
const GARIS = "before:border-slate-500 after:border-slate-500";
const ANAK_BARIS = `relative px-2 pt-5 before:absolute before:top-0 before:right-1/2 before:h-5 before:w-1/2 before:border-t after:absolute after:top-0 after:left-1/2 after:h-5 after:w-1/2 after:border-t after:border-l first:before:border-0 last:after:border-0 last:before:border-r only:pt-0 only:before:hidden only:after:hidden ${GARIS}`;

interface Konteks {
  bagan: Bagan;
  buka: ReadonlySet<string>;
  tampil: ReadonlySet<string>;
  pilih: string | null;
  onPilih: (id: string) => void;
  onLipat: (id: string) => void;
  onLihat: (id: string) => void;
}

export function BaganOrganisasi({
  karyawan,
  org,
  onLihatRincian,
}: {
  karyawan: ReadonlyArray<Record<string, unknown>>;
  org: Organisasi | null;
  onLihatRincian: (idKaryawan: string) => void;
}) {
  const bagan = useMemo(
    () =>
      susunBagan(
        karyawan,
        org?.atasan_siklus ?? [],
        new Map((org?.cabang ?? []).map((c) => [c.id_cabang, c.nama])),
      ),
    [karyawan, org],
  );
  const [tampilan, setTampilan] = useState<Tampilan>(() =>
    typeof window !== "undefined" && window.matchMedia(LEBAR_BAGAN).matches
      ? "bagan"
      : "fokus",
  );
  const [pilihan, setPilihan] = useState<string | null>(null);
  const [terbuka, setTerbuka] = useState<Set<string> | null>(null);
  const bawaan = useMemo(() => terbukaBawaan(bagan), [bagan]);
  const buka = terbuka ?? bawaan.terbuka;
  const kotak = useMemo(() => kotakBagan(bagan, buka), [bagan, buka]);
  const unit = useMemo(() => kelompokUnit(bagan), [bagan]);
  const urutNama = useMemo(
    () =>
      [...bagan.simpul.values()].sort((a, b) =>
        a.nama.localeCompare(b.nama, "id", { sensitivity: "base" }),
      ),
    [bagan],
  );
  // Pilihan bisa hilang setelah muat ulang (karyawan dinonaktifkan).
  const pilih = pilihan && bagan.simpul.has(pilihan) ? pilihan : null;

  useEffect(() => {
    if (tampilan !== "bagan" || !pilih) return;
    document
      .getElementById(`hris-bagan-${pilih}`)
      ?.scrollIntoView({ block: "nearest", inline: "center" });
  }, [tampilan, pilih]);

  const pilihOrang = (id: string) => {
    setPilihan(id);
    const digambar = bagan.akar.includes(rantaiBagan(bagan, id)[0] ?? "");
    if (tampilan === "bagan" && digambar) {
      setTerbuka(bukaRantai(buka, bagan, id));
    } else if (tampilan !== "fokus") {
      setTampilan("fokus");
    }
  };

  const konteks: Konteks = {
    bagan,
    buka,
    tampil: kotak.tampil,
    pilih,
    onPilih: setPilihan,
    onLipat: (id) => {
      const baru = new Set(buka);
      if (baru.has(id)) baru.delete(id);
      else baru.add(id);
      setTerbuka(baru);
    },
    onLihat: onLihatRincian,
  };

  if (bagan.simpul.size === 0) {
    return (
      <p className={`${KARTU} text-sm text-slate-400`}>
        Belum ada karyawan aktif.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div
          className="flex shrink-0 gap-2 overflow-x-auto"
          role="tablist"
          aria-label="Tampilan struktur"
        >
          {(
            [
              ["bagan", "Bagan"],
              ["fokus", "Fokus"],
              ["unit", "Menurut unit"],
            ] as Array<[Tampilan, string]>
          ).map(([id, label]) => (
            <button
              key={id}
              id={`hris-bagan-tampilan-${id}`}
              type="button"
              role="tab"
              aria-selected={tampilan === id}
              onClick={() => setTampilan(id)}
              className={`${TOMBOL} shrink-0 ${tampilan === id ? "bg-sky-500 text-white" : "bg-slate-900 text-slate-300"}`}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="min-w-0 flex-1">
          <PilihCari
            id="hris-bagan-cari"
            aria-label="Cari karyawan di struktur"
            value={pilih ?? ""}
            onChange={(e) => {
              if (e.target.value) pilihOrang(e.target.value);
            }}
          >
            <option value="">Cari karyawan</option>
            {urutNama.map((s) => (
              <option key={s.id} value={s.id}>
                {s.nama} • {s.jabatan || "-"} • {s.divisi || "-"}
              </option>
            ))}
          </PilihCari>
        </div>
      </div>

      {tampilan === "bagan" ? (
        <BaganPohon
          konteks={konteks}
          dipersempit={kotak.dipersempit || (!terbuka && bawaan.dipersempit)}
        />
      ) : null}
      {tampilan === "fokus" ? <Fokus konteks={konteks} /> : null}
      {tampilan === "unit" ? (
        <div className={`${KARTU} space-y-2`}>
          {unit.map((cabang) => (
            <details
              key={cabang.nama}
              className="rounded-xl border border-slate-800 bg-slate-950 p-3"
            >
              <summary className="cursor-pointer font-semibold text-white">
                {cabang.nama}{" "}
                <span className="text-sm font-normal text-slate-400">
                  ({cabang.jumlah})
                </span>
              </summary>
              <div className="mt-2 space-y-2">
                {cabang.divisi.map((divisi) => (
                  <details
                    key={divisi.nama}
                    className="rounded-lg border border-slate-800 p-2"
                  >
                    <summary className="cursor-pointer text-sm font-semibold text-slate-300">
                      {divisi.nama}{" "}
                      <span className="font-normal text-slate-400">
                        ({divisi.jumlah})
                      </span>
                    </summary>
                    <DaftarNama
                      id={divisi.id}
                      bagan={bagan}
                      onPilih={pilihOrang}
                    />
                  </details>
                ))}
              </div>
            </details>
          ))}
        </div>
      ) : (
        <TanpaAtasan bagan={bagan} onPilih={pilihOrang} />
      )}
    </div>
  );
}

function BaganPohon({
  konteks,
  dipersempit,
}: {
  konteks: Konteks;
  dipersempit: boolean;
}) {
  const akar = konteks.bagan.akar.filter((id) => konteks.tampil.has(id));
  return (
    <div className={`${KARTU} space-y-3`}>
      {dipersempit ? (
        <p className="text-sm text-amber-200">
          Bagan dipersempit, pakai Fokus atau cari.
        </p>
      ) : null}
      {akar.length === 0 ? (
        <p className="text-sm text-slate-400">
          Belum ada atasan yang diisi. Karyawan tanpa atasan ada di kelompok di
          bawah.
        </p>
      ) : (
        <div className="overflow-x-auto pb-2">
          <div className="mx-auto flex w-max items-start gap-8">
            {akar.map((id) => (
              <Pohon key={id} id={id} konteks={konteks} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function Pohon({ id, konteks }: { id: string; konteks: Konteks }) {
  const s = konteks.bagan.simpul.get(id);
  if (!s) return null;
  const terbuka = konteks.buka.has(id);
  const anak = terbuka ? s.anak.filter((a) => konteks.tampil.has(a)) : [];
  const terpotong = terbuka ? s.langsung - anak.length : 0;
  const bisaBuka = s.langsung > 0 && s.kedalaman < KEDALAMAN_MAKS_BAGAN;
  const kolom = s.langsung > ANAK_KOLOM;
  const kotak = (
    <Kotak
      s={s}
      dipilih={konteks.pilih === id}
      onPilih={() => konteks.onPilih(id)}
      className={kolom ? "w-full" : "w-44"}
      idElemen={`hris-bagan-${id}`}
    >
      {bisaBuka ? (
        <button
          type="button"
          aria-expanded={terbuka}
          onClick={() => konteks.onLipat(id)}
          className="mt-2 w-full rounded-lg border border-slate-700 px-2 py-1 text-xs font-semibold text-sky-200 hover:bg-slate-800"
        >
          {terbuka ? "Lipat" : `+${s.langsung} bawahan`}
        </button>
      ) : null}
      {terpotong > 0 ? (
        <span className="mt-1 block text-xs text-amber-200">
          {terpotong} tidak digambar
        </span>
      ) : null}
      {konteks.pilih === id ? (
        <TombolRincian onKlik={() => konteks.onLihat(id)} />
      ) : null}
    </Kotak>
  );
  if (anak.length === 0)
    return <div className="flex justify-center">{kotak}</div>;
  if (kolom) {
    return (
      <div className="inline-flex flex-col items-stretch">
        {kotak}
        <ul className="ml-4 space-y-2 border-l border-slate-500 pt-2 pl-4">
          {anak.map((a) => (
            <li
              key={a}
              className="relative before:absolute before:top-6 before:-left-4 before:w-4 before:border-t before:border-slate-500"
            >
              <Pohon id={a} konteks={konteks} />
            </li>
          ))}
        </ul>
      </div>
    );
  }
  return (
    <div className="flex flex-col items-center">
      {kotak}
      <ul
        className={`relative flex justify-center pt-5 before:absolute before:top-0 before:left-1/2 before:h-5 before:border-l ${GARIS}`}
      >
        {anak.map((a) => (
          <li key={a} className={ANAK_BARIS}>
            <Pohon id={a} konteks={konteks} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function Fokus({ konteks }: { konteks: Konteks }) {
  const { bagan, pilih } = konteks;
  const kini = pilih ? bagan.simpul.get(pilih) : undefined;
  const atas = pilih ? rantaiBagan(bagan, pilih).slice(0, -1) : [];
  const bawah = kini ? kini.anak : bagan.akar;
  return (
    <div className={`${KARTU} space-y-4`}>
      {kini ? (
        <>
          <div className="space-y-2">
            <button
              type="button"
              onClick={() => konteks.onPilih("")}
              className={TOMBOL_KECIL}
            >
              Ke puncak bagan
            </button>
            {atas.length > 0 ? (
              <ol className="space-y-1 border-l border-slate-500 pl-3">
                {atas.map((id) => {
                  const s = bagan.simpul.get(id);
                  return s ? (
                    <li key={id}>
                      <button
                        type="button"
                        onClick={() => konteks.onPilih(id)}
                        className="block w-full min-w-0 rounded-lg px-2 py-1 text-left hover:bg-slate-800"
                      >
                        <span className="block truncate text-sm font-semibold text-white">
                          {s.nama}
                        </span>
                        <span className="block truncate text-xs text-slate-400">
                          {s.jabatan || "-"}
                        </span>
                      </button>
                    </li>
                  ) : null;
                })}
              </ol>
            ) : null}
          </div>
          <Kotak s={kini} dipilih onPilih={() => undefined} className="w-full">
            <TombolRincian onKlik={() => konteks.onLihat(kini.id)} />
          </Kotak>
        </>
      ) : null}
      <div className="space-y-2">
        <h3 className="text-sm font-bold text-slate-300">
          {kini
            ? `Bawahan langsung (${kini.langsung})`
            : `Puncak bagan (${bagan.akar.length})`}
        </h3>
        {bawah.length === 0 ? (
          <p className="text-sm text-slate-400">
            {kini
              ? "Tidak ada bawahan langsung."
              : "Belum ada atasan yang diisi."}
          </p>
        ) : (
          <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {bawah.map((id) => {
              const s = bagan.simpul.get(id);
              return s ? (
                <li key={id} className="min-w-0">
                  <Kotak
                    s={s}
                    dipilih={false}
                    onPilih={() => konteks.onPilih(id)}
                    className="w-full"
                  />
                </li>
              ) : null;
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

function Kotak({
  s,
  dipilih,
  onPilih,
  className,
  idElemen,
  children,
}: {
  s: SimpulBagan;
  dipilih: boolean;
  onPilih: () => void;
  className: string;
  idElemen?: string;
  children?: ReactNode;
}) {
  return (
    <div
      id={idElemen}
      className={`min-w-0 rounded-xl border p-2 text-left ${className} ${dipilih ? "border-sky-500 bg-sky-500/20" : "border-slate-700 bg-slate-950"}`}
    >
      <button
        type="button"
        onClick={onPilih}
        aria-pressed={dipilih}
        className="block w-full min-w-0 text-left"
      >
        <span className="block truncate font-semibold text-white">
          {s.nama}
        </span>
        <span className="block truncate text-xs text-slate-400">
          {s.jabatan || "-"}
        </span>
        <span className="block truncate text-xs text-slate-400">
          {s.divisi || "-"} • {s.cabang ?? TANPA_CABANG}
        </span>
        {s.total > 0 ? (
          <span className="block truncate text-xs text-slate-300">
            {s.langsung} langsung • {s.total} total
          </span>
        ) : null}
        {s.tanda.map((t) => (
          <span key={t} className="block truncate text-xs text-amber-200">
            {LABEL_TANDA_HRIS[t] ?? t}
          </span>
        ))}
      </button>
      {children}
    </div>
  );
}

function TombolRincian({ onKlik }: { onKlik: () => void }) {
  return (
    <button
      type="button"
      onClick={onKlik}
      className="mt-2 min-h-9 w-full rounded-lg bg-sky-500 px-3 text-xs font-bold text-white"
    >
      Lihat rincian
    </button>
  );
}

function TanpaAtasan({
  bagan,
  onPilih,
}: {
  bagan: Bagan;
  onPilih: (id: string) => void;
}) {
  if (bagan.tanpaAtasan.length === 0) return null;
  const jumlah = bagan.tanpaAtasan.reduce((n, k) => n + k.jumlah, 0);
  return (
    <section className={`${KARTU} space-y-2`}>
      <h3 className="text-sm font-bold text-white">
        Belum punya atasan ({jumlah})
      </h3>
      <p className="text-xs text-slate-400">
        Karyawan aktif tanpa atasan dan tanpa bawahan. Atasannya diisi dari data
        karyawan.
      </p>
      {bagan.tanpaAtasan.map((kelompok) => (
        <details
          key={kelompok.nama}
          className="rounded-xl border border-slate-800 bg-slate-950 p-3"
        >
          <summary className="cursor-pointer text-sm font-semibold text-slate-300">
            {kelompok.nama}{" "}
            <span className="font-normal text-slate-400">
              ({kelompok.jumlah})
            </span>
          </summary>
          <DaftarNama id={kelompok.id} bagan={bagan} onPilih={onPilih} />
          {kelompok.jumlah > kelompok.id.length ? (
            <p className="mt-2 text-xs text-slate-400">
              dan {kelompok.jumlah - kelompok.id.length} lainnya
            </p>
          ) : null}
        </details>
      ))}
    </section>
  );
}

function DaftarNama({
  id,
  bagan,
  onPilih,
}: {
  id: readonly string[];
  bagan: Bagan;
  onPilih: (id: string) => void;
}) {
  return (
    <ul className="mt-2 grid grid-cols-1 gap-1 sm:grid-cols-2">
      {id.map((idKaryawan) => {
        const s = bagan.simpul.get(idKaryawan);
        return s ? (
          <li key={idKaryawan} className="min-w-0">
            <button
              type="button"
              onClick={() => onPilih(idKaryawan)}
              className="block w-full min-w-0 rounded-lg px-2 py-1 text-left hover:bg-slate-800"
            >
              <span className="block truncate text-sm text-white">
                {s.nama}
              </span>
              <span className="block truncate text-xs text-slate-400">
                {s.jabatan || "-"}
              </span>
            </button>
          </li>
        ) : null;
      })}
    </ul>
  );
}
