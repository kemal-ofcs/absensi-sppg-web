import type { DownloadResult } from "@/lib/client/download";
import { exportToExcel } from "@/lib/client/excel-export";
import type {
  BarangInventaris,
  DaftarInventaris,
  KartuStok,
  RekapPengadaan,
} from "@/lib/validations/inventory";

// Export Excel inventaris. `exportToExcel` sudah memilih jalur per platform:
// unduhan biasa di Web, dialog simpan di Desktop, dialog SAF di Android.

type Sel = string | number | boolean | null | undefined;

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

export function eksporRekapStok(
  data: DaftarInventaris,
): Promise<DownloadResult> {
  const headers = [
    "Kode",
    "Nama barang",
    "Kategori",
    "Tipe",
    "Satuan",
    "Tempat",
    "Kondisi",
    "Kedaluwarsa",
    "Saldo",
  ];
  const rows = data.barang.flatMap((barang) =>
    barang.posisi.map((posisi) => ({
      Kode: barang.kode_barang,
      "Nama barang": barang.nama_barang,
      Kategori: barang.kategori ?? "",
      Tipe: barang.tipe,
      Satuan: barang.satuan,
      Tempat: posisi.tempat,
      Kondisi: posisi.kondisi,
      Kedaluwarsa: posisi.tanggal_expired ?? "",
      Saldo: posisi.saldo,
    })),
  );
  return saveWorkbook({
    headers,
    rows,
    filename: `rekap-stok-${data.hari_ini}.xlsx`,
    sheetName: "Rekap Stok",
  });
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
      Saldo: kartu.saldo_awal,
    },
    ...kartu.baris.map((baris) => ({
      Tanggal: baris.tanggal,
      Jenis: baris.jenis,
      Alasan: baris.alasan,
      Dari: baris.tempat_asal ?? "",
      Ke: baris.tempat_tujuan ?? "",
      Penerima: baris.penerima_nama ?? "",
      Keperluan: baris.keperluan ?? "",
      Masuk: baris.masuk || "",
      Keluar: baris.keluar || "",
      Saldo: baris.saldo,
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
    Jumlah: baris.jumlah,
    Satuan: baris.satuan,
    "Harga satuan": baris.harga_satuan ?? "",
    Nilai: baris.harga_satuan === null ? "" : baris.nilai,
    "Nomor dokumen": baris.nomor_dokumen ?? "",
    "Disimpan di": baris.tempat_tujuan ?? "",
  }));
  rows.push({});
  for (const item of rekap.rekap) {
    rows.push({
      "Sumber dana": `Total ${item.sumber_dana}`,
      Nilai: item.nilai,
      "Nomor dokumen":
        item.tanpa_harga > 0 ? `${item.tanpa_harga} baris tanpa harga` : "",
    });
  }
  rows.push({ "Sumber dana": "Total keseluruhan", Nilai: rekap.total_nilai });
  return saveWorkbook({
    headers,
    rows,
    filename: `rekap-pengadaan-${dari}-${sampai}.xlsx`,
    sheetName: "Rekap Pengadaan",
  });
}
