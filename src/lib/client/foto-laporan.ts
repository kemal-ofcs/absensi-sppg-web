"use client";

import {
  jarakMeter,
  MAKS_FOTO_BASE64,
  MIME_FOTO,
} from "@/lib/validations/driver";

/**
 * Foto + GPS laporan perjalanan driver (PRD §5, §6.3). Foto hanya dari kamera
 * langsung: tidak ada input berkas atau galeri. Stempel dicetak ke foto
 * sebelum dikirim, tetapi hanya tampilan: acuannya kolom laporan dan
 * `foto_sha256` yang dihitung backend.
 */

export interface PosisiLaporan {
  lat: number;
  lng: number;
  akurasi: number;
  /** Stempel waktu fix GPS sebagai UTC `YYYY-MM-DD HH:MM:SS`. */
  waktuGps: string | null;
}

export function utcTeks(waktu: Date): string {
  return waktu.toISOString().slice(0, 19).replace("T", " ");
}

/** Lokasi saat tombol ditekan. Tidak ada pelacakan latar belakang (§6.6). */
export function ambilPosisi(): Promise<PosisiLaporan> {
  return new Promise((resolve, reject) => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      reject(new Error("GPS tidak tersedia pada perangkat ini."));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) =>
        resolve({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          akurasi: pos.coords.accuracy,
          waktuGps: Number.isFinite(pos.timestamp)
            ? utcTeks(new Date(pos.timestamp))
            : null,
        }),
      (galat) =>
        reject(
          new Error(
            galat.code === galat.PERMISSION_DENIED
              ? "Izin lokasi ditolak. Izinkan lokasi untuk aplikasi ini lalu coba lagi."
              : "Lokasi GPS belum didapat. Nyalakan GPS lalu coba lagi.",
          ),
        ),
      { enableHighAccuracy: true, timeout: 20_000, maximumAge: 0 },
    );
  });
}

export interface LokasiPilihan {
  id_lokasi: string;
  nama: string;
  lat: number;
  lng: number;
  radius_m: number;
}

/** Lokasi terdaftar terdekat yang radiusnya mencakup posisi ini. */
export function lokasiTerdekat(
  posisi: Pick<PosisiLaporan, "lat" | "lng">,
  lokasi: readonly LokasiPilihan[],
): LokasiPilihan | null {
  let terbaik: { lokasi: LokasiPilihan; jarak: number } | null = null;
  for (const l of lokasi) {
    const jarak = jarakMeter(posisi.lat, posisi.lng, l.lat, l.lng);
    if (jarak <= l.radius_m && (!terbaik || jarak < terbaik.jarak)) {
      terbaik = { lokasi: l, jarak };
    }
  }
  return terbaik?.lokasi ?? null;
}

export interface FotoTerstempel {
  mime_type: typeof MIME_FOTO;
  data_base64: string;
  dataUrl: string;
}

const SISI_TERPANJANG = 960;
const PERCOBAAN: { skala: number; kualitas: number }[] = [
  { skala: 1, kualitas: 0.6 },
  { skala: 1, kualitas: 0.45 },
  { skala: 0.8, kualitas: 0.45 },
  { skala: 0.65, kualitas: 0.4 },
];

/**
 * Potret frame kamera, cetak stempel di bagian bawah, lalu kompres JPEG
 * sampai muat `MAKS_FOTO_BASE64` (±100 KB rata-rata).
 */
export function potretTerstempel(
  video: HTMLVideoElement,
  stempel: readonly string[],
): FotoTerstempel {
  const lebarAsli = video.videoWidth;
  const tinggiAsli = video.videoHeight;
  if (!lebarAsli || !tinggiAsli) {
    throw new Error("Kamera belum siap. Tunggu gambar muncul lalu coba lagi.");
  }
  const dasar = Math.min(1, SISI_TERPANJANG / Math.max(lebarAsli, tinggiAsli));
  for (const { skala, kualitas } of PERCOBAAN) {
    const lebar = Math.round(lebarAsli * dasar * skala);
    const tinggi = Math.round(tinggiAsli * dasar * skala);
    const canvas = document.createElement("canvas");
    canvas.width = lebar;
    canvas.height = tinggi;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Foto tidak bisa diproses di perangkat ini.");
    ctx.drawImage(video, 0, 0, lebar, tinggi);
    const huruf = Math.max(12, Math.round(lebar / 40));
    const tinggiBaris = Math.round(huruf * 1.3);
    const tinggiPita = tinggiBaris * stempel.length + huruf;
    ctx.fillStyle = "rgba(0, 0, 0, 0.55)";
    ctx.fillRect(0, tinggi - tinggiPita, lebar, tinggiPita);
    ctx.fillStyle = "#ffffff";
    ctx.font = `600 ${huruf}px sans-serif`;
    ctx.textBaseline = "top";
    stempel.forEach((baris, i) => {
      ctx.fillText(
        baris,
        Math.round(huruf / 2),
        tinggi - tinggiPita + Math.round(huruf / 2) + i * tinggiBaris,
        lebar - huruf,
      );
    });
    const dataUrl = canvas.toDataURL(MIME_FOTO, kualitas);
    const data_base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
    if (data_base64.length <= MAKS_FOTO_BASE64) {
      return { mime_type: MIME_FOTO, data_base64, dataUrl };
    }
  }
  throw new Error(
    "Foto terlalu besar. Ambil ulang dengan kamera yang lebih stabil.",
  );
}

/** Waktu WIB untuk stempel foto, misalnya `08 Nov 2026 14:32:05 WIB`. */
export function waktuStempel(waktu: Date): string {
  return `${new Intl.DateTimeFormat("id-ID", {
    timeZone: "Asia/Jakarta",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(waktu)} WIB`;
}
