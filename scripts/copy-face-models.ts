/**
 * Salin model pengenal wajah dari `@vladmandic/human` ke `public/models/wajah/`.
 *
 * Dijalankan sebagai `postinstall`, satu-satunya langkah yang dilewati SEMUA
 * jalur build (dev, build Web/Desktop/Mobile, Dockerfile, paket Windows).
 * Model disalin, tidak di-commit: ±9 MB biner di git selamanya, dan salinan
 * yang di-commit bisa tertinggal dari versi library yang terpasang — vektor
 * dari model yang berbeda tidak sebanding (`FACE_MODEL_ID`).
 */
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const MODELS = ["blazeface", "facemesh", "faceres"];
const source = join("node_modules", "@vladmandic", "human", "models");
const target = join("public", "models", "wajah");

if (!existsSync(source)) {
  // Install tanpa dependensi aplikasi (mis. hanya devDependencies di CI audit).
  console.warn("Model wajah tidak ditemukan; verifikasi wajah tidak tersedia.");
  process.exit(0);
}
mkdirSync(target, { recursive: true });
for (const name of MODELS) {
  for (const ext of [".json", ".bin"]) {
    copyFileSync(join(source, name + ext), join(target, name + ext));
  }
}
console.log(`Model wajah disalin ke ${target}`);
