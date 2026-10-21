/**
 * Validasi impor Excel barang inventaris: murni, tanpa DOM, supaya bisa diuji.
 *
 * Setiap baris disimpan lewat `simpanBarangInventaris` dan, untuk barang baru
 * bersaldo, `catatMutasiInventaris` Masuk "Saldo Awal", jalur yang SAMA
 * dengan formulir, jadi tidak ada command atau rute sync kedua. Satu sel
 * cacat menolak SELURUH berkas, karena lebih mudah memperbaiki satu sel lalu
 * mengulang daripada separuh barang terimpor; penolakan backend dicatat per
 * baris.
 *
 * Kode yang cocok dengan barang yang sudah ada mengubah barang itu dan tidak
 * pernah menambah stok: stok diturunkan dari mutasi, jadi mengimpor ulang
 * berkas yang sama akan menghitung saldonya dua kali. Kolom yang tidak ada di
 * baris judul mempertahankan nilai lama; kolom yang ada tapi kosong
 * mengosongkannya. Aturan yang sama berlaku untuk kolom tambahan yang aktif,
 * dicocokkan lewat namanya; isi kolom yang nonaktif tidak pernah disentuh.
 */

import {
  angkaDariKetikan,
  angkaDariSelAngka,
  asciiLower,
  type BarangDraft,
  type BarangInventaris,
  barangDraftSchema,
  jumlahDariKetikan,
  jumlahDariSelAngka,
  KONDISI_BARANG,
  type KolomInventaris,
  type MutasiDraft,
  mutasiDraftSchema,
  normalizeTempat,
  TIPE_BARANG,
  validateAtribut,
  validateBarang,
  validateMutasi,
} from "./inventory";
export const MAX_INVENTARIS_IMPORT_ROWS = 1000;

export interface ImportRow<T> {
  /** Nomor baris di Excel (judul = baris 1), untuk pesan ke operator. */
  baris: number;
  draft: T;
}

export interface ImportReport {
  berhasil: number;
  gagal: { baris: number; pesan: string }[];
}

type Cell = (row: readonly string[], header: string) => string;

/**
 * Pembaca sel per nama kolom (tidak peka huruf besar/kecil) untuk baris data.
 * Melempar bila salah satu kolom wajib tidak ada di baris judul.
 */
function workbookColumns(
  headerRow: readonly string[],
  required: readonly string[],
): Cell {
  const headings = new Map<string, number>();
  headerRow.forEach((h, idx) => {
    headings.set(h.toLowerCase().trim(), idx);
  });
  for (const column of required) {
    if (!headings.has(column)) {
      throw new Error(
        `Kolom wajib '${column}' tidak ditemukan di baris judul Excel.`,
      );
    }
  }
  return (row, header) => {
    const colIdx = headings.get(header);
    return colIdx !== undefined && colIdx < row.length
      ? (row[colIdx] ?? "").trim()
      : "";
  };
}

/**
 * Tolak angka yang sudah dirusak Excel: kode panjang yang diketik tanpa format
 * Teks disimpan sebagai `1.98701012010011E+17`, dan digitnya tidak bisa
 * dipulihkan.
 */
function teksIdentitas(value: string, kolom: string, baris: number): string {
  if (/^[\d.]+e[+-]?\d+$/i.test(value)) {
    throw new Error(
      `Baris ${baris}: ${kolom} '${value}' sudah diubah Excel menjadi angka. Format kolom ${kolom} sebagai Teks, ketik ulang, lalu impor lagi.`,
    );
  }
  return value;
}

/**
 * Tanggal dari sel Excel: `YYYY-MM-DD` apa adanya, atau nomor seri tanggal
 * Excel (hari sejak 1899-12-30) yang muncul bila sel diformat Tanggal.
 */
function tanggalExcel(
  value: string,
  kolom: string,
  baris: number,
): string | undefined {
  if (!value) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  if (/^\d{4,6}(\.\d+)?$/.test(value)) {
    const ms = Date.UTC(1899, 11, 30) + Math.floor(Number(value)) * 86_400_000;
    return new Date(ms).toISOString().slice(0, 10);
  }
  throw new Error(
    `Baris ${baris}: ${kolom} '${value}' harus berformat YYYY-MM-DD, misalnya 2026-07-15.`,
  );
}

/**
 * Simpan baris demi baris. Penolakan backend dicatat per baris dan impor
 * berlanjut, supaya operator melihat SEMUA baris yang bentrok sekaligus.
 */
export async function runImport<T>(
  items: ImportRow<T>[],
  simpan: (draft: T) => Promise<unknown>,
): Promise<ImportReport> {
  const report: ImportReport = { berhasil: 0, gagal: [] };
  for (const item of items) {
    try {
      await simpan(item.draft);
      report.berhasil += 1;
    } catch (error) {
      report.gagal.push({
        baris: item.baris,
        pesan: error instanceof Error ? error.message : "Gagal disimpan.",
      });
    }
  }
  return report;
}

/** Ringkasan untuk banner: jumlah, lalu lima kegagalan pertama. */
export function describeImportReport(report: ImportReport): string {
  const ringkas = `Impor barang selesai: ${report.berhasil} tersimpan, ${report.gagal.length} gagal.`;
  if (report.gagal.length === 0) return ringkas;
  const contoh = report.gagal
    .slice(0, 5)
    .map((item) => `Baris ${item.baris}: ${item.pesan}`)
    .join(" · ");
  const sisa =
    report.gagal.length > 5 ? ` (+${report.gagal.length - 5} lainnya)` : "";
  return `${ringkas} ${contoh}${sisa}`;
}

export const INVENTARIS_WORKBOOK_HEADERS = [
  "Kode",
  "Nama barang",
  "Kategori",
  "Tipe",
  "Satuan",
  "Bisa kedaluwarsa",
  "Desimal",
  "Stok minimum",
  "Tempat utama",
  "Catatan",
  "Saldo awal",
  "Tempat saldo",
  "Kondisi",
  "Tanggal kedaluwarsa",
] as const;

export interface BarisImporBarang {
  barang: BarangDraft;
  /** Saldo awal barang baru; `id_barang` diisi setelah barangnya tersimpan. */
  saldo: MutasiDraft | null;
  baru: boolean;
  /** Barang lama yang barisnya membawa saldo: diabaikan, dilaporkan. */
  saldoDiabaikan: boolean;
  /** Barang bermutasi yang kolom Desimal-nya berbeda: dipertahankan, dilaporkan. */
  desimalDiabaikan: boolean;
}

function pilihan<T extends string>(
  daftar: readonly T[],
  raw: string,
): T | undefined {
  return daftar.find((item) => asciiLower(item) === asciiLower(raw));
}

/**
 * Jumlah stok tersimpan (×100 untuk barang desimal). Ketikan berformat
 * Indonesia: `10.000` dan `10.000,00` diterima; `10,22` hanya untuk barang
 * desimal. Sel Angka Excel bertitik desimal dan tidak pernah bertitik ribuan.
 */
function bilangan(
  raw: string,
  kolom: string,
  baris: number,
  selAngka: boolean,
  desimal: boolean,
): number {
  if (!raw) return 0;
  const nilai = selAngka
    ? jumlahDariSelAngka(raw, desimal)
    : jumlahDariKetikan(raw, desimal);
  if (nilai !== null) return nilai;
  throw new Error(
    desimal
      ? `Baris ${baris}: ${kolom} '${raw}' harus angka 0 atau lebih dengan paling banyak 2 angka di belakang koma, misalnya 2,5.`
      : /^[\d.,]+$/.test(raw)
        ? `Baris ${baris}: ${kolom} '${raw}' harus bilangan bulat. Untuk barang yang ditimbang atau diukur, isi kolom Desimal dengan Ya.`
        : `Baris ${baris}: ${kolom} '${raw}' harus bilangan bulat 0 atau lebih.`,
  );
}

function kunciJudul(judul: string): string {
  return asciiLower(normalizeTempat(judul));
}

/**
 * Judul di baris pertama yang bukan kolom bawaan maupun kolom tambahan aktif,
 * misalnya kolom "No" buatan sendiri atau nama kolom yang sudah diganti.
 * Isinya diabaikan dan dilaporkan, tidak menolak berkas.
 */
export function judulAsing(
  judul: readonly string[],
  kolom: readonly KolomInventaris[],
): string[] {
  const dikenal = new Set([
    ...INVENTARIS_WORKBOOK_HEADERS.map(kunciJudul),
    ...kolom
      .filter((item) => item.is_aktif)
      .map((item) => kunciJudul(item.nama)),
  ]);
  return judul
    .map((item) => normalizeTempat(item))
    .filter((item) => item && !dikenal.has(kunciJudul(item)));
}

/**
 * `selAngka` menandai sel Excel bertipe Angka (lihat `readWorkbookTable`):
 * isinya bertitik desimal, sedangkan sel lain dibaca sebagai ketikan
 * berformat Indonesia.
 */
export function parseInventarisRows(
  rows: string[][],
  daftar: readonly BarangInventaris[],
  hariIni: string,
  kolom: readonly KolomInventaris[] = [],
  selAngka: readonly (readonly boolean[])[] = [],
): ImportRow<BarisImporBarang>[] {
  const judul = rows[0] ?? [];
  const val = workbookColumns(judul, ["nama barang"]);
  const judulKecil = judul.map((h) => h.toLowerCase().trim());
  const adaKolom = new Set(judulKecil);
  const kolomDiFile: { kolom: KolomInventaris; indeks: number }[] = [];
  for (const item of kolom.filter((k) => k.is_aktif)) {
    const indeks = judul.findIndex(
      (h) => kunciJudul(h) === kunciJudul(item.nama),
    );
    if (indeks < 0) continue;
    if (kolomDiFile.some((ada) => ada.indeks === indeks)) {
      throw new Error(
        `Kolom tambahan '${item.nama}' ada dua. Ganti nama salah satunya, lalu impor lagi.`,
      );
    }
    kolomDiFile.push({ kolom: item, indeks });
  }
  if (rows.length < 2) {
    throw new Error("Tidak ada data barang yang ditemukan di file.");
  }
  if (rows.length - 1 > MAX_INVENTARIS_IMPORT_ROWS) {
    throw new Error(
      `Maksimal ${MAX_INVENTARIS_IMPORT_ROWS} barang per file. Pecah berkasnya menjadi beberapa file.`,
    );
  }

  const perKode = new Map<string, BarangInventaris[]>();
  for (const barang of daftar) {
    const k = asciiLower(barang.kode_barang.trim());
    perKode.set(k, [...(perKode.get(k) ?? []), barang]);
  }
  const kodeDiFile = new Set<string>();
  const hasil: ImportRow<BarisImporBarang>[] = [];

  rows.slice(1).forEach((row, index) => {
    const baris = index + 2;
    if (row.every((cell) => !cell.trim())) return;
    // `lastIndexOf`: judul ganda dibaca dari kolom terakhir, sama seperti `val`.
    const selAngkaDi = (judulKolom: string) =>
      Boolean(selAngka[index + 1]?.[judulKecil.lastIndexOf(judulKolom)]);

    const kode = teksIdentitas(val(row, "kode"), "Kode", baris);
    let lama: BarangInventaris | undefined;
    if (kode) {
      const k = asciiLower(kode);
      if (kodeDiFile.has(k)) {
        throw new Error(
          `Baris ${baris}: Kode '${kode}' muncul dua kali di file.`,
        );
      }
      kodeDiFile.add(k);
      const cocok = perKode.get(k) ?? [];
      if (cocok.length > 1) {
        throw new Error(
          `Baris ${baris}: Kode '${kode}' dipakai ${cocok.length} barang. Ganti kode barang yang ganda di daftar barang, lalu impor lagi.`,
        );
      }
      lama = cocok[0];
    }
    const kol = (kolom: string, nilaiLama: string | null | undefined) =>
      adaKolom.has(kolom) ? val(row, kolom) : (nilaiLama ?? "");

    const tipeMentah = kol("tipe", lama?.tipe);
    const tipe = pilihan(TIPE_BARANG, tipeMentah);
    if (!tipe) {
      throw new Error(
        `Baris ${baris}: Tipe '${tipeMentah}' harus Aset atau Habis Pakai.`,
      );
    }
    const expiredMentah = kol(
      "bisa kedaluwarsa",
      lama ? (lama.bisa_expired ? "Ya" : "Tidak") : "",
    );
    const expired = asciiLower(expiredMentah);
    if (expired !== "" && expired !== "ya" && expired !== "tidak") {
      throw new Error(
        `Baris ${baris}: Bisa kedaluwarsa '${expiredMentah}' harus Ya atau Tidak.`,
      );
    }
    const desimalMentah = kol(
      "desimal",
      lama ? (lama.desimal ? "Ya" : "Tidak") : "",
    );
    const desimalFile = asciiLower(desimalMentah);
    if (desimalFile !== "" && desimalFile !== "ya" && desimalFile !== "tidak") {
      throw new Error(
        `Baris ${baris}: Desimal '${desimalMentah}' harus Ya atau Tidak.`,
      );
    }
    // Mengubah desimal barang bermutasi akan mengubah arti setiap jumlah
    // yang sudah tercatat (×100), jadi nilai lamanya dipertahankan.
    const desimalDiabaikan = Boolean(
      lama?.punya_mutasi && (desimalFile === "ya") !== lama.desimal,
    );
    const desimal = desimalDiabaikan
      ? Boolean(lama?.desimal)
      : desimalFile === "ya";

    const barang: BarangDraft = {
      id_barang: lama?.id_barang ?? null,
      kode_barang: kode || null,
      nama_barang: kol("nama barang", lama?.nama_barang),
      kategori: kol("kategori", lama?.kategori),
      tipe,
      satuan: kol("satuan", lama?.satuan),
      bisa_expired: expired === "ya",
      desimal,
      stok_minimum: adaKolom.has("stok minimum")
        ? bilangan(
            val(row, "stok minimum"),
            "Stok minimum",
            baris,
            selAngkaDi("stok minimum"),
            desimal,
          )
        : (lama?.stok_minimum ?? 0),
      tempat_utama: kol("tempat utama", lama?.tempat_utama),
      catatan: kol("catatan", lama?.catatan),
      status_aktif: lama?.status_aktif ?? true,
    };
    const cekBarang = validateBarang(barangDraftSchema.parse(barang));
    if (!cekBarang.ok) throw new Error(`Baris ${baris}: ${cekBarang.error}`);

    const atribut: Record<string, string> = { ...(lama?.atribut ?? {}) };
    for (const { kolom: item, indeks } of kolomDiFile) {
      const isi = (row[indeks] ?? "").trim();
      if (!isi) {
        delete atribut[item.id_kolom];
      } else if (item.tipe === "Angka") {
        const angka = selAngka[index + 1]?.[indeks]
          ? angkaDariSelAngka(isi)
          : angkaDariKetikan(isi);
        if (angka === null) {
          throw new Error(
            `Baris ${baris}: ${item.nama} '${isi}' bukan angka. Pakai koma untuk desimal, misalnya 2,5.`,
          );
        }
        atribut[item.id_kolom] = angka;
      } else {
        atribut[item.id_kolom] = isi;
      }
    }
    const cekAtribut = validateAtribut(atribut, kolom);
    if (!cekAtribut.ok) throw new Error(`Baris ${baris}: ${cekAtribut.error}`);
    barang.atribut = cekAtribut.value;

    const jumlah = bilangan(
      val(row, "saldo awal"),
      "Saldo awal",
      baris,
      selAngkaDi("saldo awal"),
      desimal,
    );
    let saldo: MutasiDraft | null = null;
    if (jumlah > 0 && !lama) {
      const kondisiMentah = val(row, "kondisi");
      const kondisi = kondisiMentah
        ? pilihan(KONDISI_BARANG, kondisiMentah)
        : "Baik";
      if (!kondisi) {
        throw new Error(
          `Baris ${baris}: Kondisi '${kondisiMentah}' harus ${KONDISI_BARANG.join(", ")}.`,
        );
      }
      saldo = {
        id_barang: "",
        jenis: "Masuk",
        alasan: "Saldo Awal",
        jumlah,
        tempat_tujuan: val(row, "tempat saldo") || barang.tempat_utama,
        kondisi_tujuan: kondisi,
        tanggal_expired:
          tanggalExcel(
            val(row, "tanggal kedaluwarsa"),
            "Tanggal kedaluwarsa",
            baris,
          ) ?? null,
      };
      const cekSaldo = validateMutasi(
        mutasiDraftSchema.parse(saldo),
        { tipe, bisa_expired: cekBarang.value.bisa_expired },
        hariIni,
      );
      if (!cekSaldo.ok) {
        throw new Error(`Baris ${baris}: saldo awal: ${cekSaldo.error}`);
      }
    }

    hasil.push({
      baris,
      draft: {
        barang,
        saldo,
        baru: !lama,
        saldoDiabaikan: jumlah > 0 && Boolean(lama),
        desimalDiabaikan,
      },
    });
  });
  return hasil;
}
