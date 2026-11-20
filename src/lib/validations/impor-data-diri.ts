// Impor data diri karyawan (Pribadi dan Keuangan di HRIS) dari Excel. Hanya
// mengurai dan memeriksa berkas di klien; penyimpanan tetap lewat gateway
// `simpanDataPribadi`/`simpanDataKeuangan` per baris, sehingga izin dan aturan
// isian kembar TS/Rust diperiksa server seperti pada formulir.

import {
  KOLOM_KEUANGAN,
  KOLOM_PRIBADI,
  validasiKeuangan,
  validasiPribadi,
} from "./hris";

/**
 * Nomor yang rusak bila menjadi sel Angka: digit ke-16 dst. dibulatkan dan nol
 * depan hilang. Dibulatkan diam-diam tetap lolos validasi panjang NIK, jadi
 * tipe selnya yang diperiksa, bukan isinya.
 */
const KOLOM_NOMOR: ReadonlySet<string> = new Set([
  "nik",
  "no_kk",
  "darurat_hp",
  "no_rekening",
  "npwp",
  "bpjs_kesehatan",
  "bpjs_ketenagakerjaan",
]);

export const MAKS_BARIS_DATA_DIRI = 500;

export type IsianImpor = Record<string, string>;

export interface PegawaiRujukan {
  id_unik: string;
  kode_karyawan: string;
  nama: string;
}

export interface BarisDataDiri {
  /** Nomor baris Excel (judul = 1). */
  baris: number;
  id_karyawan: string;
  nama: string;
  /** Hanya sel yang berisi; `null` = kelompok ini tidak disentuh. */
  pribadi: IsianImpor | null;
  keuangan: IsianImpor | null;
  galat: string | null;
}

export interface HasilUraiDataDiri {
  baris: BarisDataDiri[];
  /** Kolom yang diabaikan karena izin, untuk ditampilkan di pratinjau. */
  catatan: string[];
}

/** Notasi ilmiah = angka yang sudah dirusak Excel dan tak bisa dipulihkan. */
function teksIdentitas(nilai: string, kolom: string): string {
  if (/^[\d.]+e[+-]?\d+$/i.test(nilai)) {
    throw new Error(
      `${kolom} '${nilai}' sudah diubah Excel menjadi angka. Format kolomnya sebagai Teks, ketik ulang, lalu impor lagi.`,
    );
  }
  return nilai;
}

/** `YYYY-MM-DD` apa adanya, atau nomor seri tanggal Excel (sel bertipe Tanggal). */
function tanggalExcel(nilai: string, kolom: string): string {
  if (!nilai || /^\d{4}-\d{2}-\d{2}$/.test(nilai)) return nilai;
  if (/^\d{4,6}(\.\d+)?$/.test(nilai)) {
    const ms = Date.UTC(1899, 11, 30) + Math.floor(Number(nilai)) * 86_400_000;
    return new Date(ms).toISOString().slice(0, 10);
  }
  throw new Error(
    `${kolom} '${nilai}' harus berformat YYYY-MM-DD, misalnya 1990-07-15.`,
  );
}

/**
 * Urai tabel dari `readWorkbookTable`. Baris tanpa satu pun isian dilewati
 * (template yang belum diisi); baris bermasalah tetap dikembalikan dengan
 * `galat` supaya pratinjau bisa menunjukkannya.
 */
export function uraiDataDiri(
  tabel: { rows: string[][]; selAngka: boolean[][] },
  pegawai: readonly PegawaiRujukan[],
  izin: { pribadi: boolean; keuangan: boolean },
): HasilUraiDataDiri {
  const [judul = [], ...data] = tabel.rows;
  const indeks = new Map(judul.map((h, i) => [h.trim().toLowerCase(), i]));
  if (!indeks.has("id_unik") && !indeks.has("kode_karyawan")) {
    throw new Error(
      "Kolom 'id_unik' atau 'kode_karyawan' tidak ditemukan di baris judul. Pakai template dari tombol Unduh template.",
    );
  }
  const ada = (daftar: readonly string[]) => daftar.some((k) => indeks.has(k));
  const catatan: string[] = [];
  if (ada(KOLOM_PRIBADI) && !izin.pribadi) {
    catatan.push(
      "Kolom data pribadi diabaikan: Anda tidak punya izin mengubah data pribadi.",
    );
  }
  if (ada(KOLOM_KEUANGAN) && !izin.keuangan) {
    catatan.push(
      "Kolom data keuangan diabaikan: Anda tidak punya izin mengubah data keuangan.",
    );
  }
  const kolomPribadi = izin.pribadi ? KOLOM_PRIBADI : [];
  const kolomKeuangan = izin.keuangan ? KOLOM_KEUANGAN : [];
  if (!ada(kolomPribadi) && !ada(kolomKeuangan)) {
    throw new Error(
      catatan.length > 0
        ? catatan.join(" ")
        : "Tidak ada kolom data diri di berkas. Pakai template dari tombol Unduh template.",
    );
  }

  const perId = new Map(pegawai.map((p) => [p.id_unik.toLowerCase(), p]));
  const perKode = new Map(
    pegawai
      .filter((p) => p.kode_karyawan)
      .map((p) => [p.kode_karyawan.toLowerCase(), p]),
  );
  const barisPertama = new Map<string, number>();
  const hasil: BarisDataDiri[] = [];

  data.forEach((row, i) => {
    const baris = i + 2;
    const angka = tabel.selAngka[i + 1] ?? [];
    const sel = (kolom: string) => {
      const idx = indeks.get(kolom);
      return idx === undefined ? "" : (row[idx] ?? "").trim();
    };
    const id = sel("id_unik");
    const kode = sel("kode_karyawan");
    if (!id && !kode) return;

    const cocok =
      perId.get(id.toLowerCase()) ?? perKode.get(kode.toLowerCase()) ?? null;
    const dasar = {
      baris,
      id_karyawan: cocok?.id_unik ?? (id || kode),
      nama: cocok?.nama ?? sel("nama"),
      pribadi: null,
      keuangan: null,
    };
    try {
      if (!cocok) {
        throw new Error(`Karyawan '${id || kode}' tidak ditemukan.`);
      }
      const isi = (kolom: string) => {
        const nilai = sel(kolom);
        if (!nilai) return "";
        if (kolom === "tanggal_lahir") return tanggalExcel(nilai, kolom);
        if (!KOLOM_NOMOR.has(kolom)) return nilai;
        if (angka[indeks.get(kolom) ?? -1]) {
          throw new Error(
            `${kolom} tersimpan sebagai Angka di Excel, sehingga digit atau nol depannya bisa hilang. Ketik ulang dengan awalan tanda kutip (') atau format kolomnya sebagai Teks.`,
          );
        }
        return teksIdentitas(nilai, kolom);
      };
      const ambil = (kolom: readonly string[]) => {
        const terisi: IsianImpor = {};
        for (const k of kolom) {
          const nilai = isi(k);
          if (nilai) terisi[k] = nilai;
        }
        return Object.keys(terisi).length > 0 ? terisi : null;
      };
      const pribadi = ambil(kolomPribadi);
      const keuangan = ambil(kolomKeuangan);
      if (!pribadi && !keuangan) return;

      const sebelumnya = barisPertama.get(cocok.id_unik);
      if (sebelumnya !== undefined) {
        throw new Error(`Karyawan ini sudah ada di baris ${sebelumnya}.`);
      }
      barisPertama.set(cocok.id_unik, baris);

      const cekPribadi = pribadi ? validasiPribadi(pribadi) : null;
      if (cekPribadi && !cekPribadi.ok) throw new Error(cekPribadi.pesan);
      const cekKeuangan = keuangan ? validasiKeuangan(keuangan) : null;
      if (cekKeuangan && !cekKeuangan.ok) throw new Error(cekKeuangan.pesan);

      hasil.push({ ...dasar, pribadi, keuangan, galat: null });
    } catch (error) {
      hasil.push({
        ...dasar,
        galat: error instanceof Error ? error.message : String(error),
      });
    }
  });

  if (hasil.length === 0) {
    throw new Error("Tidak ada isian data diri di berkas.");
  }
  if (hasil.length > MAKS_BARIS_DATA_DIRI) {
    throw new Error(
      `Maksimal ${MAKS_BARIS_DATA_DIRI} karyawan per berkas; berkas ini berisi ${hasil.length}.`,
    );
  }
  return { baris: hasil, catatan };
}

/**
 * Draft akhir satu kelompok: sel berisi dari berkas menimpa, sisanya nilai
 * lama (sel kosong tidak menghapus). Hanya kunci `kolom` yang dikirim:
 * `isianObjek` menolak kunci asing seperti `pribadi_diubah_oleh` milik profil.
 */
export function gabungIsian(
  kolom: readonly string[],
  lama: Record<string, string | null>,
  baru: IsianImpor,
): Record<string, string | null> {
  return Object.fromEntries(kolom.map((k) => [k, baru[k] || lama[k] || null]));
}
