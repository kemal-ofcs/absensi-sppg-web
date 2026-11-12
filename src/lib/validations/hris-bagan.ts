// Bagan struktur organisasi (fase 10, §25.5). Hanya layar yang membacanya,
// jadi tanpa kembaran Rust (pola label box inventaris). Masukannya baris
// `getDaftarKaryawan` dan `ambilOrganisasi` yang sudah dimuat tab HRIS.

import { dalamSiklusAtasan } from "@/lib/validations/hris";

export const MAKS_KOTAK_BAGAN = 400;
export const KEDALAMAN_MAKS_BAGAN = 12;
export const TINGKAT_TERBUKA_BAGAN = 2;
export const MAKS_NAMA_KELOMPOK = 200;
export const TANPA_DIVISI = "Tanpa divisi";
export const TANPA_CABANG = "Tanpa cabang";

/** Labelnya di `LABEL_TANDA_HRIS`. */
export type TandaBagan = "atasan_siklus" | "atasan_nonaktif";

export interface SimpulBagan {
  id: string;
  nama: string;
  jabatan: string;
  divisi: string;
  cabang: string | null;
  /** Atasan yang dipakai bagan; null = akar atau "Belum punya atasan". */
  induk: string | null;
  anak: string[];
  langsung: number;
  total: number;
  kedalaman: number;
  tanda: TandaBagan[];
}

export interface KelompokNama {
  nama: string;
  jumlah: number;
  /** Urut nama; di "Belum punya atasan" paling banyak `MAKS_NAMA_KELOMPOK`. */
  id: string[];
}

export interface Bagan {
  /** Semua karyawan aktif, termasuk yang di kelompok "Belum punya atasan". */
  simpul: Map<string, SimpulBagan>;
  akar: string[];
  tanpaAtasan: KelompokNama[];
}

type Baris = Readonly<Record<string, unknown>>;

const teks = (v: unknown) => (typeof v === "string" ? v.trim() : "");

const banding = (a: string, b: string) =>
  a.localeCompare(b, "id", { sensitivity: "base" });

const urutNama =
  (simpul: ReadonlyMap<string, { nama: string }>) => (a: string, b: string) =>
    banding(simpul.get(a)?.nama ?? "", simpul.get(b)?.nama ?? "") ||
    (a < b ? -1 : a > b ? 1 : 0);

const urutKelompok = (kosong: string) => (a: string, b: string) =>
  a === kosong ? 1 : b === kosong ? -1 : banding(a, b);

/**
 * `siklus` = `Organisasi.atasan_siklus`. Lingkaran di antara karyawan aktif
 * juga dihitung ulang di sini, supaya bagan tidak berputar walaupun daftar
 * siklus belum termuat.
 */
export function susunBagan(
  karyawan: readonly Baris[],
  siklus: readonly string[],
  namaCabang: ReadonlyMap<string, string>,
): Bagan {
  const aktif = karyawan.filter((k) => k.status_aktif === "Aktif");
  const ada = new Set(aktif.map((k) => teks(k.id_unik)));
  const atasan = new Map(
    aktif.map((k) => {
      const id = teks(k.id_atasan);
      return [teks(k.id_unik), id && id !== teks(k.id_unik) ? id : null];
    }),
  );
  const petaAktif = new Map(
    [...atasan].map(([id, a]) => [id, a && ada.has(a) ? a : null] as const),
  );
  const melingkar = new Set([
    ...siklus.filter((id) => ada.has(id)),
    ...dalamSiklusAtasan(petaAktif),
  ]);

  const simpul = new Map<string, SimpulBagan>();
  for (const k of aktif) {
    const id = teks(k.id_unik);
    const a = atasan.get(id) ?? null;
    const tanda: TandaBagan[] = melingkar.has(id)
      ? ["atasan_siklus"]
      : a && !ada.has(a)
        ? ["atasan_nonaktif"]
        : [];
    simpul.set(id, {
      id,
      nama: teks(k.nama),
      jabatan: teks(k.jabatan_status),
      divisi: teks(k.divisi),
      cabang: namaCabang.get(teks(k.id_cabang)) ?? null,
      induk: tanda.length === 0 && a ? a : null,
      anak: [],
      langsung: 0,
      total: 0,
      kedalaman: 0,
      tanda,
    });
  }
  for (const s of simpul.values()) {
    if (s.induk) simpul.get(s.induk)?.anak.push(s.id);
  }
  const urut = urutNama(simpul);
  for (const s of simpul.values()) {
    s.anak.sort(urut);
    s.langsung = s.anak.length;
  }

  const puncak = [...simpul.values()].filter((s) => s.induk === null);
  const akar = puncak
    .filter((s) => s.anak.length > 0 || s.tanda.length > 0)
    .map((s) => s.id)
    .sort(urut);

  // Graf `induk` tanpa lingkaran: setiap lingkaran di antara karyawan aktif
  // sudah menjadi akar bertanda, jadi rekursi ini selalu berhenti.
  const totalDari = (id: string, dalam: number): number => {
    const s = simpul.get(id);
    if (!s) return 0;
    s.kedalaman = dalam;
    s.total = s.anak.reduce((n, a) => n + 1 + totalDari(a, dalam + 1), 0);
    return s.total;
  };
  for (const id of akar) totalDari(id, 0);

  const perDivisi = new Map<string, string[]>();
  for (const s of puncak) {
    if (s.anak.length > 0 || s.tanda.length > 0) continue;
    const kunci = s.divisi || TANPA_DIVISI;
    perDivisi.set(kunci, [...(perDivisi.get(kunci) ?? []), s.id]);
  }
  const tanpaAtasan = [...perDivisi.keys()]
    .sort(urutKelompok(TANPA_DIVISI))
    .map((nama) => {
      const id = (perDivisi.get(nama) ?? []).sort(urut);
      return { nama, jumlah: id.length, id: id.slice(0, MAKS_NAMA_KELOMPOK) };
    });

  return { simpul, akar, tanpaAtasan };
}

/** Rantai atasan dari akar sampai `id` (termasuk `id`). Kosong bila tidak ada. */
export function rantaiBagan(bagan: Bagan, id: string): string[] {
  const hasil: string[] = [];
  let kini: string | null = bagan.simpul.has(id) ? id : null;
  while (kini && hasil.length <= bagan.simpul.size) {
    hasil.unshift(kini);
    kini = bagan.simpul.get(kini)?.induk ?? null;
  }
  return hasil;
}

/**
 * Kotak yang digambar Bagan: akar, lalu anak setiap simpul yang terbuka,
 * tingkat demi tingkat sampai `maks`. Tingkat atas selalu utuh lebih dulu.
 */
export function kotakBagan(
  bagan: Bagan,
  terbuka: ReadonlySet<string>,
  maks = MAKS_KOTAK_BAGAN,
): { tampil: Set<string>; dipersempit: boolean } {
  const tampil = new Set<string>();
  let tingkat = bagan.akar;
  let dalam = 0;
  while (tingkat.length > 0) {
    const berikut: string[] = [];
    for (const id of tingkat) {
      if (tampil.size >= maks) return { tampil, dipersempit: true };
      tampil.add(id);
      if (terbuka.has(id) && dalam < KEDALAMAN_MAKS_BAGAN) {
        berikut.push(...(bagan.simpul.get(id)?.anak ?? []));
      }
    }
    tingkat = berikut;
    dalam++;
  }
  return { tampil, dipersempit: false };
}

/**
 * Simpul yang terbuka saat Bagan pertama tampil: `TINGKAT_TERBUKA_BAGAN`
 * tingkat pertama, dikurangi sampai kotaknya muat `maks`.
 */
export function terbukaBawaan(
  bagan: Bagan,
  maks = MAKS_KOTAK_BAGAN,
): { terbuka: Set<string>; dipersempit: boolean } {
  for (let tingkat = TINGKAT_TERBUKA_BAGAN; tingkat > 1; tingkat--) {
    const terbuka = new Set<string>();
    let lapis = bagan.akar;
    for (let i = 0; i < tingkat - 1; i++) {
      for (const id of lapis) terbuka.add(id);
      lapis = lapis.flatMap((id) => bagan.simpul.get(id)?.anak ?? []);
    }
    if (!kotakBagan(bagan, terbuka, maks).dipersempit) {
      return { terbuka, dipersempit: tingkat < TINGKAT_TERBUKA_BAGAN };
    }
  }
  return {
    terbuka: new Set(),
    dipersempit: bagan.akar.some((id) => bagan.simpul.get(id)?.langsung),
  };
}

/** Membuka rantai atasan sampai `id` terlihat di Bagan. */
export function bukaRantai(
  terbuka: ReadonlySet<string>,
  bagan: Bagan,
  id: string,
): Set<string> {
  const hasil = new Set(terbuka);
  for (const atasan of rantaiBagan(bagan, id).slice(0, -1)) hasil.add(atasan);
  return hasil;
}

export interface UnitCabang {
  nama: string;
  jumlah: number;
  divisi: KelompokNama[];
}

/** Menurut unit: Cabang → Divisi → karyawan, "Tanpa ..." di akhir. */
export function kelompokUnit(bagan: Bagan): UnitCabang[] {
  const peta = new Map<string, Map<string, string[]>>();
  for (const s of bagan.simpul.values()) {
    const cabang = s.cabang ?? TANPA_CABANG;
    const divisi = s.divisi || TANPA_DIVISI;
    const isi = peta.get(cabang) ?? new Map<string, string[]>();
    isi.set(divisi, [...(isi.get(divisi) ?? []), s.id]);
    peta.set(cabang, isi);
  }
  const urut = urutNama(bagan.simpul);
  return [...peta.keys()].sort(urutKelompok(TANPA_CABANG)).map((nama) => {
    const isi = peta.get(nama) ?? new Map<string, string[]>();
    const divisi = [...isi.keys()].sort(urutKelompok(TANPA_DIVISI)).map((d) => {
      const id = (isi.get(d) ?? []).sort(urut);
      return { nama: d, jumlah: id.length, id };
    });
    return {
      nama,
      jumlah: divisi.reduce((n, d) => n + d.jumlah, 0),
      divisi,
    };
  });
}
