import {
  detikUtc,
  type KodeTanda,
  type StatusPerjalanan,
} from "@/lib/validations/driver";

/** Teks "Perlu ditinjau" untuk setiap kode tanda dari `tandaTinjau`. */
export const LABEL_TANDA: Record<KodeTanda, string> = {
  urutan_janggal: "Urutan laporan janggal (jam HP mungkin diubah mundur)",
  jam_maju: "Jam HP lebih maju dari jam server",
  tanpa_gps: "Laporan driver tanpa GPS",
  tanpa_foto: "Laporan driver tanpa foto",
  akurasi_nol: "Akurasi GPS persis 0 m (curigai lokasi palsu)",
  akurasi_buruk: "Akurasi GPS buruk",
  luar_radius: "Dilaporkan di luar radius lokasi terdaftar",
  kecepatan_mustahil: "Perpindahan terlalu cepat (> 150 km/jam)",
  menunggu_persetujuan: "Ganti darurat atau minta izin belum diputuskan",
  muat_beda: "Jumlah dimuat berbeda dari surat jalan",
  sisa_muatan: "Ada muatan yang belum tercatat dibongkar",
  lokasi_palsu: "HP mendeteksi lokasi palsu (aplikasi pemalsu GPS)",
  dibayar_ganda: "Upah surat jalan tercatat di lebih dari satu pembayaran",
  upah_berubah: "Status, penerima, atau upah berubah setelah dibayar",
};

export const WARNA_STATUS: Record<StatusPerjalanan, string> = {
  Direncanakan: "border-slate-500/40 bg-slate-500/15 text-slate-200",
  Berjalan: "border-sky-400/40 bg-sky-400/15 text-sky-100",
  Selesai: "border-emerald-400/40 bg-emerald-400/15 text-emerald-100",
  Dibatalkan: "border-rose-400/40 bg-rose-400/15 text-rose-100",
  "Tidak Jalan": "border-amber-300/40 bg-amber-300/15 text-amber-100",
};

/** Waktu laporan (UTC `YYYY-MM-DD HH:MM:SS`) sebagai teks WIB. */
export function waktuWib(utc: string | null | undefined): string {
  const detik = utc ? detikUtc(utc) : null;
  if (detik === null) return utc ?? "-";
  return `${new Intl.DateTimeFormat("id-ID", {
    timeZone: "Asia/Jakarta",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(detik * 1000))} WIB`;
}

/** Waktu sekarang dalam bentuk `datetime('now')` (UTC), untuk laporan dispatcher. */
export function sekarangUtc(): string {
  return new Date().toISOString().slice(0, 19).replace("T", " ");
}

/** Tautan keluar ke aplikasi peta, bukan request dari aplikasi (PRD §5.3). */
export function tautanMaps(lat: number, lng: number): string {
  return `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
}

/** Berat ×100 → teks kg Indonesia (2 desimal bila perlu). */
export function beratKg(x100: number | null | undefined): string {
  if (x100 == null) return "-";
  return `${new Intl.NumberFormat("id-ID", { maximumFractionDigits: 2 }).format(x100 / 100)} kg`;
}

/** Ketikan berat Indonesia ("1.250,5") → ×100; kosong = null, salah = NaN. */
export function bacaBerat(teks: string): number | null {
  const bersih = teks.trim().replaceAll(".", "").replace(",", ".");
  if (!bersih) return null;
  if (!/^\d+(\.\d{1,2})?$/.test(bersih)) return Number.NaN;
  return Math.round(Number(bersih) * 100);
}

export function rentangBawaan(): { dari: string; sampai: string } {
  const hari = (selisih: number) =>
    new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta" }).format(
      new Date(Date.now() + selisih * 86_400_000),
    );
  return { dari: hari(-7), sampai: hari(7) };
}
