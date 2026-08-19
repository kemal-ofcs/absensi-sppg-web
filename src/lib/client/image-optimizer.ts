/**
 * Client-Side Image Optimizer untuk ID Card, Logo Instansi, dan Tanda Tangan
 * Mengompres dan menyesuaikan resolusi gambar ke standar 300 DPI HD di sisi klien
 * agar SQLite lokal & Cloud sync tetap cepat, ringan, dan tidak error payload size.
 */

export interface OptimizeImageOptions {
  maxWidth?: number;
  maxHeight?: number;
  quality?: number; // 0.85 - 0.95
  mimeType?: "image/jpeg" | "image/png";
  fit?: "cover" | "contain" | "exact";
}

export interface OptimizedImageResult {
  dataUrl: string;
  originalSizeBytes: number;
  optimizedSizeBytes: number;
  width: number;
  height: number;
  reductionPercentage: number;
}

export async function optimizeImageFile(
  file: File,
  options: OptimizeImageOptions = {},
): Promise<OptimizedImageResult> {
  const originalSizeBytes = file.size;

  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });

  return optimizeImageDataUrl(dataUrl, originalSizeBytes, options);
}

export async function optimizeImageDataUrl(
  dataUrl: string,
  originalSizeBytes?: number,
  options: OptimizeImageOptions = {},
): Promise<OptimizedImageResult> {
  const {
    maxWidth = 1011,
    maxHeight = 638,
    quality = 0.92,
    mimeType = "image/jpeg",
    fit = "exact",
  } = options;

  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      let targetW = img.naturalWidth || img.width;
      let targetH = img.naturalHeight || img.height;

      if (fit === "exact") {
        targetW = maxWidth;
        targetH = maxHeight;
      } else if (fit === "cover" || fit === "contain") {
        const ratio = Math.min(maxWidth / targetW, maxHeight / targetH);
        targetW = Math.round(targetW * ratio);
        targetH = Math.round(targetH * ratio);
      } else {
        // scale-down if larger than max
        if (targetW > maxWidth || targetH > maxHeight) {
          const ratio = Math.min(maxWidth / targetW, maxHeight / targetH);
          targetW = Math.round(targetW * ratio);
          targetH = Math.round(targetH * ratio);
        }
      }

      const canvas = document.createElement("canvas");
      canvas.width = targetW;
      canvas.height = targetH;

      const ctx = canvas.getContext("2d");
      if (!ctx) {
        return reject(new Error("Gagal menginisialisasi 2D canvas optimizer"));
      }

      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";

      ctx.drawImage(img, 0, 0, targetW, targetH);

      const optimizedDataUrl = canvas.toDataURL(mimeType, quality);
      const approxBytes = Math.round((optimizedDataUrl.length * 3) / 4);
      const originalBytes = originalSizeBytes || approxBytes;
      const reduction = Math.max(
        0,
        Math.round(((originalBytes - approxBytes) / originalBytes) * 100),
      );

      resolve({
        dataUrl: optimizedDataUrl,
        originalSizeBytes: originalBytes,
        optimizedSizeBytes: approxBytes,
        width: targetW,
        height: targetH,
        reductionPercentage: reduction,
      });
    };
    img.onerror = () =>
      reject(new Error("Gagal memuat gambar untuk dioptimasi"));
    img.src = dataUrl;
  });
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / k ** i).toFixed(1)} ${sizes[i]}`;
}
