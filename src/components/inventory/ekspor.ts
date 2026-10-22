import type { DownloadResult } from "@/lib/client/download";
import {
  AngkaExcel,
  exportToExcel,
  type SelExcel,
} from "@/lib/client/excel-export";
import { readWorkbookTable } from "@/lib/client/xlsx";
import {
  type BarangInventaris,
  type DaftarInventaris,
  formatAngka,
  formatJumlah,
  type KartuStok,
  type PosisiStok,
  type RekapPengadaan,
  SKALA_DESIMAL,
} from "@/lib/validations/inventory";
import {
  type BarisImporBarang,
  type ImportRow,
  INVENTARIS_WORKBOOK_HEADERS,
  judulAsing,
  parseInventarisRows,
} from "@/lib/validations/inventory-import";

// Export dan import Excel inventaris. `exportToExcel` sudah memilih jalur per platform:
// unduhan biasa di Web, dialog simpan di Desktop, dialog SAF di Android.

type Sel = SelExcel;

function saveWorkbook(spec: {
  headers: string[];
  rows: Record<string, Sel>[];
  filename: string;
  sheetName: string;
}): Promise<DownloadResult> {
  return exportToExcel(
    spec.filename,
    spec.sheetName,
    spec.headers,
    spec.rows.map((row) => spec.headers.map((header) => row[header])),
  );
}

/**
 * Isi kolom tambahan yang aktif, berjudul nama kolomnya. Angka ditulis
 * berformat Indonesia (`1.250,5`): penulis xlsx menyimpan semua sel sebagai
 * teks, dan impor membaca sel teks dengan format yang sama.
 */
function isiKolomTambahan(
  data: DaftarInventaris,
  barang: BarangInventaris,
): Record<string, string> {
  return Object.fromEntries(
    data.kolom
      .filter((kolom) => kolom.is_aktif)
      .map((kolom) => {
        const isi = barang.atribut[kolom.id_kolom] ?? "";
        return [
          kolom.nama,
          kolom.tipe === "Angka" && isi ? formatAngka(isi) : isi,
        ];
      }),
  );
}

/** Jumlah tersimpan sebagai sel Angka dalam satuan barangnya: 1025 → 10,25. */
function jumlahExcel(nilai: number, desimal: boolean): AngkaExcel {
  return new AngkaExcel(desimal ? nilai / SKALA_DESIMAL : nilai);
}

function judulKolomTambahan(data: DaftarInventaris): string[] {
  return data.kolom
    .filter((kolom) => kolom.is_aktif)
    .map((kolom) => kolom.nama);
}

export interface KolomEkspor {
  kunci: string;
  judul: string;
  /** Kolom milik satu tempat/batch: bila dipilih, baris dipecah per posisi. */
  perPosisi: boolean;
}

/** Pilihan dialog ekspor. Kolom tambahan berkunci `atribut:<id_kolom>`. */
export interface PilihanEkspor {
  kolom: string[];
  /** Judul kolom kosong untuk diisi tangan, misalnya "Sesuai". */
  manual: string[];
}

export const MAKS_JUDUL_MANUAL = 40;

/** Semua kolom data yang bisa diekspor, dalam urutan tampil di berkas. */
export function daftarKolomEkspor(data: DaftarInventaris): KolomEkspor[] {
  return [
    { kunci: "no", judul: "No", perPosisi: false },
    { kunci: "kode", judul: "Kode", perPosisi: false },
    { kunci: "nama", judul: "Nama barang", perPosisi: false },
    { kunci: "kategori", judul: "Kategori", perPosisi: false },
    { kunci: "tipe", judul: "Tipe", perPosisi: false },
    { kunci: "satuan", judul: "Satuan", perPosisi: false },
    ...data.kolom
      .filter((kolom) => kolom.is_aktif)
      .map((kolom) => ({
        kunci: `atribut:${kolom.id_kolom}`,
        judul: kolom.nama,
        perPosisi: false,
      })),
    { kunci: "tempat", judul: "Tempat", perPosisi: true },
    { kunci: "kondisi", judul: "Kondisi", perPosisi: true },
    { kunci: "kedaluwarsa", judul: "Kedaluwarsa", perPosisi: true },
    { kunci: "kode_unit", judul: "Kode unit", perPosisi: true },
    { kunci: "nomor_seri", judul: "Nomor seri", perPosisi: true },
    { kunci: "kuantitas", judul: "Kuantitas", perPosisi: false },
  ];
}

export function presetRekapStok(data: DaftarInventaris): PilihanEkspor {
  return {
    kolom: [
      "kode",
      "nama",
      "kategori",
      "tipe",
      "satuan",
      ...data.kolom
        .filter((kolom) => kolom.is_aktif)
        .map((kolom) => `atribut:${kolom.id_kolom}`),
      "tempat",
      "kondisi",
      "kedaluwarsa",
      "kuantitas",
    ],
    manual: [],
  };
}

export const PRESET_LEMBAR_VALIDASI: PilihanEkspor = {
  kolom: ["no", "nama", "satuan", "kuantitas"],
  manual: ["Sesuai", "Tidak sesuai", "Keterangan"],
};

function isiKolom(
  kunci: string,
  barang: BarangInventaris,
  posisi: PosisiStok[],
  nomor: number,
  data: DaftarInventaris,
): Sel {
  // Mode per posisi selalu membawa tepat satu posisi; mode per barang memakai
  // `posisi` hanya untuk menjumlah kuantitasnya.
  const satu = posisi.length === 1 ? posisi[0] : undefined;
  switch (kunci) {
    case "no":
      return new AngkaExcel(nomor);
    case "kode":
      return barang.kode_barang;
    case "nama":
      return barang.nama_barang;
    case "kategori":
      return barang.kategori ?? "";
    case "tipe":
      return barang.tipe;
    case "satuan":
      return barang.satuan;
    case "tempat":
      return satu?.tempat ?? "";
    case "kondisi":
      return satu?.kondisi ?? "";
    case "kedaluwarsa":
      return satu?.tanggal_expired ?? "";
    case "kode_unit":
      return satu?.kode_unit ?? "";
    case "nomor_seri":
      return satu?.nomor_seri ?? "";
    case "kuantitas":
      return jumlahExcel(
        posisi.reduce((total, item) => total + item.saldo, 0),
        barang.desimal,
      );
    default: {
      const kolom = data.kolom.find(
        (item) => `atribut:${item.id_kolom}` === kunci,
      );
      const isi = kolom ? (barang.atribut[kolom.id_kolom] ?? "") : "";
      return kolom?.tipe === "Angka" && isi ? formatAngka(isi) : isi;
    }
  }
}

/**
 * Judul dan baris berkas ekspor. `barang` sudah tersaring seperti di layar;
 * `tempat` membuang posisi di tempat lain. Barang tanpa posisi tetap muncul
 * berkuantitas 0, karena justru itu yang perlu dicocokkan dengan fisiknya.
 */
export function susunEkspor(
  data: DaftarInventaris,
  barang: BarangInventaris[],
  tempat: string,
  pilihan: PilihanEkspor,
): { headers: string[]; rows: Record<string, Sel>[] } {
  const kolom = daftarKolomEkspor(data).filter((item) =>
    pilihan.kolom.includes(item.kunci),
  );
  const manual = pilihan.manual.map((judul) => judul.trim());
  const headers = [...kolom.map((item) => item.judul), ...manual];
  if (headers.length === 0) throw new Error("Pilih minimal satu kolom.");
  if (manual.some((judul) => !judul)) {
    throw new Error("Judul kolom isian manual tidak boleh kosong.");
  }
  const sudah = new Set<string>();
  for (const judul of headers) {
    const kunci = judul.toLowerCase();
    // Baris ditulis berkunci judul, jadi judul kembar saling menimpa.
    if (sudah.has(kunci))
      throw new Error(`Judul kolom ${judul} dipakai dua kali.`);
    sudah.add(kunci);
  }

  const perPosisi = kolom.some((item) => item.perPosisi);
  const kelompok = barang.flatMap((item) => {
    const posisi = tempat
      ? item.posisi.filter(
          (p) => p.tempat.toLowerCase() === tempat.toLowerCase(),
        )
      : item.posisi;
    if (!perPosisi || posisi.length === 0) return [{ barang: item, posisi }];
    return posisi.map((p) => ({ barang: item, posisi: [p] }));
  });
  const rows = kelompok.map((baris, index) =>
    Object.fromEntries([
      ...kolom.map((item) => [
        item.judul,
        isiKolom(item.kunci, baris.barang, baris.posisi, index + 1, data),
      ]),
      ...manual.map((judul) => [judul, ""]),
    ]),
  );
  return { headers, rows };
}

export function eksporInventaris(
  data: DaftarInventaris,
  barang: BarangInventaris[],
  tempat: string,
  pilihan: PilihanEkspor,
): Promise<DownloadResult> {
  const { headers, rows } = susunEkspor(data, barang, tempat, pilihan);
  const akhiran = tempat
    ? `-${tempat.replace(/[\\/:*?"<>|\s]+/g, "-").toLowerCase()}`
    : "";
  return saveWorkbook({
    headers,
    rows,
    filename: `inventaris-${data.hari_ini}${akhiran}.xlsx`,
    sheetName: "Inventaris",
  });
}

/**
 * Template impor yang sudah berisi semua barang beserta kodenya, sehingga
 * mengubah massal cukup unduh, sunting, lalu impor kembali.
 */
export function unduhTemplateBarang(
  data: DaftarInventaris,
): Promise<DownloadResult> {
  const rows = data.barang.map((barang) => ({
    Kode: barang.kode_barang,
    "Nama barang": barang.nama_barang,
    Kategori: barang.kategori ?? "",
    Tipe: barang.tipe,
    Satuan: barang.satuan,
    "Bisa kedaluwarsa": barang.bisa_expired ? "Ya" : "Tidak",
    Desimal: barang.desimal ? "Ya" : "Tidak",
    // Teks berformat Indonesia, dibaca impor apa adanya: 1.000 atau 2,5.
    "Stok minimum": formatJumlah(barang.stok_minimum, barang.desimal),
    "Tempat utama": barang.tempat_utama ?? "",
    Catatan: barang.catatan ?? "",
    ...isiKolomTambahan(data, barang),
  }));
  // Kolom tambahan di antara data barang dan kolom saldo awal.
  const akhirDataBarang = INVENTARIS_WORKBOOK_HEADERS.indexOf("Catatan") + 1;
  return saveWorkbook({
    headers: [
      ...INVENTARIS_WORKBOOK_HEADERS.slice(0, akhirDataBarang),
      ...judulKolomTambahan(data),
      ...INVENTARIS_WORKBOOK_HEADERS.slice(akhirDataBarang),
    ],
    rows,
    filename: `template-barang-${data.hari_ini}.xlsx`,
    sheetName: "Barang",
  });
}

export async function bacaImporBarang(
  file: File,
  data: DaftarInventaris,
): Promise<{ baris: ImportRow<BarisImporBarang>[]; judulAsing: string[] }> {
  const { rows, selAngka } = await readWorkbookTable(file);
  return {
    baris: parseInventarisRows(
      rows,
      data.barang,
      data.hari_ini,
      data.kolom,
      selAngka,
    ),
    judulAsing: judulAsing(rows[0] ?? [], data.kolom),
  };
}

export function eksporKartuStok(
  barang: BarangInventaris,
  kartu: KartuStok,
  dari: string,
  sampai: string,
): Promise<DownloadResult> {
  const headers = [
    "Tanggal",
    "Jenis",
    "Alasan",
    "Dari",
    "Ke",
    "Penerima",
    "Keperluan",
    "Masuk",
    "Keluar",
    "Saldo",
    "Nomor dokumen",
    "Dicatat oleh",
    "Status",
  ];
  const rows: Record<string, Sel>[] = [
    {
      Tanggal: `Sebelum ${dari}`,
      Alasan: "Saldo awal",
      Saldo: jumlahExcel(kartu.saldo_awal, barang.desimal),
    },
    ...kartu.baris.map((baris) => ({
      Tanggal: baris.tanggal,
      Jenis: baris.jenis,
      Alasan: baris.alasan,
      Dari: baris.tempat_asal ?? "",
      Ke: baris.tempat_tujuan ?? "",
      Penerima: baris.penerima_nama ?? "",
      Keperluan: baris.keperluan ?? "",
      Masuk: baris.masuk ? jumlahExcel(baris.masuk, barang.desimal) : "",
      Keluar: baris.keluar ? jumlahExcel(baris.keluar, barang.desimal) : "",
      Saldo: jumlahExcel(baris.saldo, barang.desimal),
      "Nomor dokumen": baris.nomor_dokumen ?? "",
      "Dicatat oleh": baris.dicatat_oleh,
      Status: baris.dibatalkan ? "Dibatalkan" : "",
    })),
  ];
  return saveWorkbook({
    headers,
    rows,
    filename: `kartu-stok-${barang.kode_barang}-${dari}-${sampai}.xlsx`,
    sheetName: "Kartu Stok",
  });
}

/** Rincian per baris, ditutup baris total per sumber dana dan total keseluruhan. */
export function eksporPengadaan(
  rekap: RekapPengadaan,
  dari: string,
  sampai: string,
): Promise<DownloadResult> {
  const headers = [
    "Sumber dana",
    "Tanggal",
    "Kode",
    "Nama barang",
    "Alasan",
    "Jumlah",
    "Satuan",
    "Harga satuan",
    "Nilai",
    "Nomor dokumen",
    "Disimpan di",
  ];
  const rows: Record<string, Sel>[] = rekap.baris.map((baris) => ({
    "Sumber dana": baris.sumber_dana || "Tanpa sumber dana",
    Tanggal: baris.tanggal,
    Kode: baris.kode_barang,
    "Nama barang": baris.nama_barang,
    Alasan: baris.alasan,
    Jumlah: jumlahExcel(baris.jumlah, baris.desimal),
    Satuan: baris.satuan,
    "Harga satuan":
      baris.harga_satuan === null ? "" : new AngkaExcel(baris.harga_satuan),
    Nilai: baris.harga_satuan === null ? "" : new AngkaExcel(baris.nilai),
    "Nomor dokumen": baris.nomor_dokumen ?? "",
    "Disimpan di": baris.tempat_tujuan ?? "",
  }));
  rows.push({});
  for (const item of rekap.rekap) {
    rows.push({
      "Sumber dana": `Total ${item.sumber_dana}`,
      Nilai: new AngkaExcel(item.nilai),
      "Nomor dokumen":
        item.tanpa_harga > 0 ? `${item.tanpa_harga} baris tanpa harga` : "",
    });
  }
  rows.push({
    "Sumber dana": "Total keseluruhan",
    Nilai: new AngkaExcel(rekap.total_nilai),
  });
  return saveWorkbook({
    headers,
    rows,
    filename: `rekap-pengadaan-${dari}-${sampai}.xlsx`,
    sheetName: "Rekap Pengadaan",
  });
}
