"use client";

import {
  Children,
  Fragment,
  isValidElement,
  type ReactNode,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

/**
 * Pengganti `<select>` untuk daftar yang bisa panjang: satu baris berisi kotak
 * cari dan tombol daftar, dengan daftar yang dibatasi tingginya dan bisa
 * digulir. Props dan anak `<option>`-nya sama dengan `<select>`, jadi pemanggil
 * cukup mengganti nama tag. Dipakai Web/Desktop dan Mobile (`filesToCopy`).
 *
 * Daftarnya dirender lewat portal: panel Modal memakai `overflow-hidden` dan
 * `backdrop-filter`, yang memotong anak ber-`position: fixed`.
 */

const BATAS_TAMPIL = 200;
const TINGGI_MAKS = 280;
const TINGGI_MIN_BAWAH = 200;
const LEBAR_MIN = 240;

const KELAS_WADAH =
  /^(?:[\w-]+:)*(?:m[tblrxy]?-|w-|min-w-|max-w-|flex-|grow|shrink|col-span-)/;

export interface OpsiPilihan {
  value: string;
  label: string;
  disabled: boolean;
}

type PropsOption = {
  children?: ReactNode;
  value?: string | number;
  disabled?: boolean;
};

function teksAnak(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(teksAnak).join("");
  if (isValidElement<PropsOption>(node)) return teksAnak(node.props.children);
  return "";
}

/** Membaca anak `<option>`, termasuk yang ada di array dan Fragment. */
export function opsiDariAnak(children: ReactNode): OpsiPilihan[] {
  const hasil: OpsiPilihan[] = [];
  Children.forEach(children, (anak) => {
    if (!isValidElement<PropsOption>(anak)) return;
    if (anak.type === Fragment) {
      hasil.push(...opsiDariAnak(anak.props.children));
    } else if (anak.type === "option") {
      const label = teksAnak(anak.props.children).replace(/\s+/g, " ").trim();
      hasil.push({
        value: String(anak.props.value ?? label),
        label,
        disabled: Boolean(anak.props.disabled),
      });
    }
  });
  return hasil;
}

/** Setiap kata yang diketik harus ada di label, urutannya bebas. */
export function saringOpsi(opsi: OpsiPilihan[], kata: string): OpsiPilihan[] {
  const bagian = kata.toLowerCase().split(/\s+/).filter(Boolean);
  if (bagian.length === 0) return opsi;
  return opsi.filter((item) => {
    const label = item.label.toLowerCase();
    return bagian.every((potongan) => label.includes(potongan));
  });
}

/** Kelas tata letak milik wadah satu baris; sisanya milik kotak isian. */
export function pisahKelas(className: string): {
  wadah: string;
  isian: string;
} {
  const kelas = className.split(/\s+/).filter(Boolean);
  const wadah = kelas.filter((item) => KELAS_WADAH.test(item));
  const isian = kelas.filter((item) => !KELAS_WADAH.test(item));
  if (!wadah.some((item) => /(?:^|:)w-/.test(item))) wadah.unshift("w-full");
  return { wadah: wadah.join(" "), isian: isian.join(" ") };
}

function pointerKasar(): boolean {
  return window.matchMedia("(pointer: coarse)").matches;
}

export interface PilihCariProps {
  id?: string;
  value?: string | number | null;
  onChange?: (event: { target: { value: string } }) => void;
  children?: ReactNode;
  className?: string;
  required?: boolean;
  disabled?: boolean;
  title?: string;
  "aria-label"?: string;
  "aria-describedby"?: string;
}

type Posisi = {
  left: number;
  width: number;
  top?: number;
  bottom?: number;
  maxHeight: number;
};

export function PilihCari({
  id,
  value,
  onChange,
  children,
  className = "",
  required,
  disabled,
  title,
  "aria-label": ariaLabel,
  "aria-describedby": ariaDescribedby,
}: PilihCariProps) {
  const opsi = opsiDariAnak(children);
  const nilai = String(value ?? "");
  const terpilih = opsi.find((item) => item.value === nilai) ?? null;
  const [buka, setBuka] = useState(false);
  const [kata, setKata] = useState("");
  const [sorot, setSorot] = useState(0);
  const [posisi, setPosisi] = useState<Posisi | null>(null);
  const wadahRef = useRef<HTMLDivElement>(null);
  const daftarRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const idDaftar = useId();

  const tersaring = buka ? saringOpsi(opsi, kata) : [];
  const tampil = tersaring.slice(0, BATAS_TAMPIL);
  const { wadah, isian } = pisahKelas(className);

  const bukaDaftar = () => {
    if (disabled) return;
    const indeks = opsi.findIndex((item) => item.value === nilai);
    setKata("");
    setSorot(indeks >= 0 && indeks < BATAS_TAMPIL ? indeks : 0);
    setBuka(true);
  };

  const pilih = (item: OpsiPilihan) => {
    if (item.disabled) return;
    setBuka(false);
    setKata("");
    if (item.value !== nilai) onChange?.({ target: { value: item.value } });
  };

  const geserSorot = (arah: 1 | -1) => {
    let indeks = sorot;
    for (let i = 0; i < tampil.length; i += 1) {
      indeks = (indeks + arah + tampil.length) % tampil.length;
      if (!tampil[indeks]?.disabled) {
        setSorot(indeks);
        return;
      }
    }
  };

  useLayoutEffect(() => {
    if (!buka) {
      setPosisi(null);
      return;
    }
    const hitung = () => {
      const kotak = wadahRef.current?.getBoundingClientRect();
      if (!kotak) return;
      const tinggiLayar = window.visualViewport?.height ?? window.innerHeight;
      const lebarLayar = document.documentElement.clientWidth;
      const ruangBawah = tinggiLayar - kotak.bottom - 12;
      const ruangAtas = kotak.top - 12;
      const keAtas = ruangBawah < TINGGI_MIN_BAWAH && ruangAtas > ruangBawah;
      const width = Math.min(Math.max(kotak.width, LEBAR_MIN), lebarLayar - 16);
      setPosisi({
        left: Math.max(8, Math.min(kotak.left, lebarLayar - width - 8)),
        width,
        top: keAtas ? undefined : kotak.bottom + 4,
        bottom: keAtas ? window.innerHeight - kotak.top + 4 : undefined,
        maxHeight: Math.min(TINGGI_MAKS, keAtas ? ruangAtas : ruangBawah),
      });
    };
    hitung();
    const saatGulir = (event: Event) => {
      if (!daftarRef.current?.contains(event.target as Node)) hitung();
    };
    window.addEventListener("scroll", saatGulir, true);
    window.addEventListener("resize", hitung);
    window.visualViewport?.addEventListener("resize", hitung);
    return () => {
      window.removeEventListener("scroll", saatGulir, true);
      window.removeEventListener("resize", hitung);
      window.visualViewport?.removeEventListener("resize", hitung);
    };
  }, [buka]);

  useEffect(() => {
    if (!buka) return;
    const saatTekan = (event: PointerEvent) => {
      const sasaran = event.target as Node;
      if (
        !wadahRef.current?.contains(sasaran) &&
        !daftarRef.current?.contains(sasaran)
      ) {
        setBuka(false);
      }
    };
    // Fase capture dan stopImmediatePropagation: Escape hanya menutup daftar,
    // tidak ikut menutup Modal yang mendengarkan di window.
    const saatEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopImmediatePropagation();
        setBuka(false);
      }
    };
    document.addEventListener("pointerdown", saatTekan);
    window.addEventListener("keydown", saatEscape, true);
    return () => {
      document.removeEventListener("pointerdown", saatTekan);
      window.removeEventListener("keydown", saatEscape, true);
    };
  }, [buka]);

  useEffect(() => {
    if (!buka || !posisi) return;
    document
      .getElementById(`${idDaftar}-${sorot}`)
      ?.scrollIntoView({ block: "nearest" });
  }, [buka, posisi, sorot, idDaftar]);

  const teks =
    buka || !terpilih || terpilih.value === ""
      ? buka
        ? kata
        : ""
      : terpilih.label;

  return (
    <div ref={wadahRef} className={`flex gap-1 ${wadah}`}>
      <input
        ref={inputRef}
        id={id}
        type="text"
        role="combobox"
        aria-label={ariaLabel}
        aria-describedby={ariaDescribedby}
        aria-autocomplete="list"
        aria-expanded={buka}
        aria-controls={idDaftar}
        aria-activedescendant={
          buka && tampil[sorot] ? `${idDaftar}-${sorot}` : undefined
        }
        title={title}
        autoComplete="off"
        required={required}
        disabled={disabled}
        value={teks}
        placeholder={terpilih?.label ?? opsi[0]?.label ?? ""}
        onFocus={(event) => event.target.select()}
        onClick={() => {
          if (!buka) bukaDaftar();
        }}
        onChange={(event) => {
          setKata(event.target.value);
          setSorot(0);
          setBuka(true);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            if (!buka) bukaDaftar();
            else geserSorot(event.key === "ArrowDown" ? 1 : -1);
          } else if (event.key === "Enter") {
            // Enter di kotak ini tidak pernah mengirim formulir.
            event.preventDefault();
            if (!buka) bukaDaftar();
            else if (tampil[sorot]) pilih(tampil[sorot]);
          } else if (event.key === "Tab") {
            setBuka(false);
          } else if (
            !buka &&
            (event.key === "Backspace" ||
              (event.key.length === 1 && !event.ctrlKey && !event.metaKey))
          ) {
            bukaDaftar();
          }
        }}
        className={`min-w-0 flex-1 ${isian}`}
      />
      <button
        type="button"
        tabIndex={-1}
        disabled={disabled}
        aria-label={buka ? "Tutup daftar pilihan" : "Tampilkan daftar pilihan"}
        onClick={() => {
          if (buka) {
            setBuka(false);
            return;
          }
          bukaDaftar();
          // Di HP tombol ini untuk memilih tanpa memunculkan papan ketik.
          if (!pointerKasar()) inputRef.current?.focus();
        }}
        className="grid w-11 shrink-0 place-items-center rounded-lg border border-slate-700 bg-slate-900 text-slate-300 transition-colors hover:bg-slate-800 disabled:opacity-60"
      >
        <svg
          viewBox="0 0 20 20"
          aria-hidden="true"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={`size-4 transition-transform ${buka ? "rotate-180" : ""}`}
        >
          <path d="m5 8 5 5 5-5" />
        </svg>
      </button>
      {buka && posisi
        ? createPortal(
            <div
              ref={daftarRef}
              data-no-pull-refresh
              style={{ position: "fixed", ...posisi }}
              className="z-[200] flex flex-col overflow-hidden rounded-lg border border-slate-700 bg-slate-900 shadow-2xl shadow-black/40"
            >
              <div
                id={idDaftar}
                role="listbox"
                onMouseDown={(event) => event.preventDefault()}
                className="min-h-0 flex-1 touch-pan-y overflow-y-auto overscroll-contain"
              >
                {tampil.map((item, indeks) => (
                  <button
                    key={`${item.value}-${indeks}`}
                    id={`${idDaftar}-${indeks}`}
                    type="button"
                    role="option"
                    tabIndex={-1}
                    aria-selected={item.value === nilai}
                    disabled={item.disabled}
                    onClick={() => {
                      pilih(item);
                      if (pointerKasar()) inputRef.current?.blur();
                    }}
                    className={`block min-h-10 w-full px-3 py-2 text-left text-sm wrap-break-word hover:bg-slate-800 disabled:opacity-50 ${
                      indeks === sorot ? "bg-slate-800" : ""
                    } ${
                      item.value === nilai
                        ? "font-semibold text-sky-300"
                        : "text-slate-100"
                    }`}
                  >
                    {item.label}
                  </button>
                ))}
                {tampil.length === 0 ? (
                  <p className="px-3 py-3 text-sm text-slate-400">
                    Tidak ada pilihan yang cocok.
                  </p>
                ) : null}
              </div>
              {tersaring.length > BATAS_TAMPIL ? (
                <p className="shrink-0 border-t border-slate-800 px-3 py-2 text-xs text-slate-400">
                  {tersaring.length - BATAS_TAMPIL} pilihan lain tidak
                  ditampilkan. Ketik untuk mempersempit.
                </p>
              ) : null}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
