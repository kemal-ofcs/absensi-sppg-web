"use client";

import {
  analyzeFrame,
  LIVENESS_FRAME_HEIGHT,
  LIVENESS_FRAME_WIDTH,
} from "@/lib/security/face-liveness";

/**
 * Foto bukti absensi: wajah orang yang absen beserta latar tempat ia berdiri.
 *
 * Alurnya sengaja MENAHAN scan. Begitu QR terbaca, terminal berhenti sejenak,
 * membuka kamera foto, menunggu wajah masuk bingkai, lalu memotret dan
 * baru mengirim scan. Versi pertama fitur ini memotret dari kamera pemindai QR
 * pada detik QR terbaca — yang terfoto justru kartu identitas yang sedang
 * ditempelkan ke lensa, bukan orangnya, sehingga fotonya tidak membuktikan
 * apa pun tentang siapa yang hadir dan di mana.
 *
 * Ukuran 480x360 JPEG mutu 0,7 (~30-60 KB). Foto ikut event `attendance/scan`
 * ke cloud, jadi setiap kilobyte tambahan dibayar oleh setiap scan di jaringan
 * seluler.
 */

export const SCAN_PHOTO_WIDTH = 480;
export const SCAN_PHOTO_HEIGHT = 360;
export const SCAN_PHOTO_QUALITY = 0.7;
export const SCAN_PHOTO_MIME = "image/jpeg" as const;

export interface ScanPhotoCapture {
  base64: string;
  mime: typeof SCAN_PHOTO_MIME;
}

let sharedCanvas: HTMLCanvasElement | null = null;

function canvas() {
  if (typeof document === "undefined") return null;
  if (!sharedCanvas) sharedCanvas = document.createElement("canvas");
  return sharedCanvas;
}

/**
 * Ambil satu frame sebagai base64 murni (tanpa awalan `data:`).
 *
 * Mengembalikan `null` bila video belum punya frame — pemanggil memperlakukan
 * itu sebagai "foto belum tersedia" dan menahan scan, bukan mengirim gambar
 * kosong yang tidak membuktikan apa pun.
 */
export function captureScanPhoto(
  video: HTMLVideoElement | null,
): ScanPhotoCapture | null {
  if (!video || video.videoWidth === 0 || video.videoHeight === 0) return null;
  const surface = canvas();
  if (!surface) return null;
  surface.width = SCAN_PHOTO_WIDTH;
  surface.height = SCAN_PHOTO_HEIGHT;
  const context = surface.getContext("2d");
  if (!context) return null;
  context.drawImage(video, 0, 0, SCAN_PHOTO_WIDTH, SCAN_PHOTO_HEIGHT);
  const dataUrl = surface.toDataURL(SCAN_PHOTO_MIME, SCAN_PHOTO_QUALITY);
  const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  return base64 ? { base64, mime: SCAN_PHOTO_MIME } : null;
}

/**
 * Apakah ada wajah di dalam bingkai saat ini.
 *
 * Memakai ulang detektor piksel tanpa dependensi milik verifikasi "Lupa
 * Password" (`face-liveness.ts`) — tidak ada model ML baru yang dibundel dan
 * tidak ada pelonggaran CSP. Dipakai HANYA sebagai pemandu: pemotretan tetap
 * bisa dilakukan manual, dan tetap berjalan otomatis setelah tenggat, supaya
 * kamera murah yang gagal mengenali wajah tidak pernah memblokir absensi.
 */
export function isFaceVisible(video: HTMLVideoElement | null): boolean {
  if (!video || video.videoWidth === 0) return false;
  const surface = canvas();
  if (!surface) return false;
  surface.width = LIVENESS_FRAME_WIDTH;
  surface.height = LIVENESS_FRAME_HEIGHT;
  const context = surface.getContext("2d", { willReadFrequently: true });
  if (!context) return false;
  context.drawImage(video, 0, 0, LIVENESS_FRAME_WIDTH, LIVENESS_FRAME_HEIGHT);
  const image = context.getImageData(
    0,
    0,
    LIVENESS_FRAME_WIDTH,
    LIVENESS_FRAME_HEIGHT,
  );
  // RGBA -> RGB: kanal alfa selalu 255 pada tangkapan kamera.
  const rgb = new Uint8Array(LIVENESS_FRAME_WIDTH * LIVENESS_FRAME_HEIGHT * 3);
  for (let index = 0; index < rgb.length / 3; index += 1) {
    rgb[index * 3] = image.data[index * 4] as number;
    rgb[index * 3 + 1] = image.data[index * 4 + 1] as number;
    rgb[index * 3 + 2] = image.data[index * 4 + 2] as number;
  }
  return analyzeFrame({
    challenge: "KEDIP",
    offsetMs: 0,
    width: LIVENESS_FRAME_WIDTH,
    height: LIVENESS_FRAME_HEIGHT,
    rgb,
  }).faceDetected;
}

/**
 * Buka kamera untuk memotret wajah + latar orang yang absen.
 *
 * Kamera yang benar TIDAK sama di semua perangkat, dan memaksa "user" di
 * semua tempat adalah bug: laptop/Desktop pada umumnya hanya punya SATU
 * webcam yang menghadap ke orang di depan layar, jadi `user` (atau apa pun)
 * kebetulan selalu benar di sana. Tetapi terminal Mobile dipasang dengan
 * kamera BELAKANG menghadap keluar ke karyawan yang mendekatkan QR-nya —
 * persis kamera yang dipakai memindai QR (`facingMode: "environment"`).
 * Memaksa kamera depan di HP berarti memotret ke arah operator/tembok di
 * belakang ponsel, bukan wajah karyawan.
 *
 * Karena itu `deviceId` kamera pemindai QR yang menang bila ada: arah kamera
 * ditentukan cara terminal itu dipakai, bukan jenis build-nya. Petugas yang
 * memegang HP memilih kamera belakang untuk QR, dan wajah yang harus terfoto
 * ada di arah yang sama (siswa di depannya, bukan petugasnya); tablet kios
 * yang layarnya menghadap siswa memilih kamera depan untuk keduanya.
 * `preferredFacing` hanya dipakai ketika kamera pemindai belum diketahui.
 *
 * Constraint bertingkat: perangkat yang tidak punya kamera pada arah yang
 * diminta tetap mendapat stream alih-alih gagal total.
 */
export async function openFaceCamera(
  preferredFacing: "user" | "environment" = "user",
  deviceId?: string,
): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("Kamera tidak tersedia pada perangkat ini.");
  }
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        ...(deviceId
          ? { deviceId: { exact: deviceId } }
          : { facingMode: { ideal: preferredFacing } }),
        width: { ideal: 960 },
        height: { ideal: 720 },
      },
    });
  } catch {
    return navigator.mediaDevices.getUserMedia({ audio: false, video: true });
  }
}

/**
 * Kamera pemindai yang dipilih di terminal ini, diingat per perangkat.
 *
 * Tanpa ini pilihan kembali ke bawaan setiap kali halaman dibuka, sehingga
 * tablet kios yang memakai kamera depan harus diatur ulang setiap pagi.
 * `localStorage`, bukan setting tersinkron: satu sekolah bisa punya tablet kios
 * dan HP petugas sekaligus, dan id kamera hanya bermakna di perangkatnya.
 */
const SCANNER_CAMERA_KEY = "kos.scanner.kamera";

export function readScannerCamera(): string {
  try {
    return localStorage.getItem(SCANNER_CAMERA_KEY) ?? "";
  } catch {
    return "";
  }
}

export function saveScannerCamera(deviceId: string) {
  try {
    localStorage.setItem(SCANNER_CAMERA_KEY, deviceId);
  } catch {
    // Mode privat atau penyimpanan diblokir: pilihan hanya berlaku sesi ini.
  }
}

/**
 * Id kamera yang sedang mengalirkan gambar ke elemen video ini.
 *
 * Dibaca dari stream pemindai QR SEBELUM dimatikan, supaya foto diambil dari
 * kamera yang barusan membaca kartu — termasuk ketika pemindai jatuh ke
 * constraint `video: true` atau id di pemilih kamera masih kosong karena
 * browser belum memberi izin saat daftar kameranya dibaca.
 */
export function liveCameraId(video: HTMLVideoElement | null) {
  const stream = video?.srcObject;
  if (!(stream instanceof MediaStream)) return undefined;
  return stream.getVideoTracks()[0]?.getSettings().deviceId || undefined;
}

/** Hentikan seluruh track sebuah elemen video dan lepaskan sumbernya. */
export function stopVideoStream(video: HTMLVideoElement | null) {
  const stream = video?.srcObject;
  if (stream instanceof MediaStream) {
    for (const track of stream.getTracks()) track.stop();
  }
  if (video) video.srcObject = null;
}
