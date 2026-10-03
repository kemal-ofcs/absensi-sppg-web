import path from "node:path";
import type { NextConfig } from "next";

const isDesktopBuild = process.env.SPPG_BUILD_TARGET === "desktop";
/**
 * Build untuk image Docker dan paket Windows self-hosted: hasilnya
 * `.next/standalone`, server yang berjalan tanpa `src/` dan tanpa
 * `node_modules` lengkap, sehingga yang diserahkan ke pembeli tidak memuat
 * source code.
 *
 * Sengaja hanya aktif bila diminta (`Dockerfile` dan `build-paket.ts` yang
 * menyetelnya). `next start` tidak melayani build standalone, dan Vercel tidak
 * memerlukannya.
 */
const isStandaloneBuild =
  !isDesktopBuild && process.env.KOS_BUILD_STANDALONE === "1";
const zxingBrowserModule = "@zxing/browser/es2015/index.js";
const zxingLibraryModule = "@zxing/library/es2015/index.js";
const zxingBrowserEntry = path.resolve(
  process.cwd(),
  "node_modules/@zxing/browser/es2015/index.js",
);
const zxingLibraryEntry = path.resolve(
  process.cwd(),
  "node_modules/@zxing/library/es2015/index.js",
);

/**
 * Header keamanan build Web. Tanpa CSP apa pun, nama personil berisi
 * `<img onerror>` yang lolos ke `innerHTML` langsung berjalan di sesi admin;
 * aturan ini sengaja minimal (tanpa `script-src`) supaya script tema inline dan
 * chunk Next.js tidak ikut terblokir.
 */
const SECURITY_HEADERS = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(self), geolocation=(self), microphone=()",
  },
  {
    key: "Content-Security-Policy",
    value: "frame-ancestors 'none'; object-src 'none'; base-uri 'none'",
  },
];

/**
 * Sakelar lisensi dan tanggal build DITANAM ke dalam hasil build lewat `env`,
 * bukan dibaca dari `.env` saat server berjalan. Sakelar yang dibaca saat jalan
 * bisa dimatikan pembeli dengan satu baris di `.env`; yang ditanam hanya bisa
 * diubah dengan membangun ulang dari source, yang tidak mereka pegang.
 *
 * Yang menyalakannya: image self-hosted, paket Windows, dan project Vercel
 * milik klien sewa (env project diisi sebelum build). Bawaannya MATI, jadi
 * deployment demo milik pemilik aplikasi tidak terpengaruh.
 */
const licenseEnforced = process.env.KOS_LICENSE_ENFORCED === "1" ? "1" : "0";
const buildDateWib = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Jakarta",
}).format(new Date());

const nextConfig: NextConfig = {
  env: {
    KOS_LICENSE_ENFORCED: licenseEnforced,
    KOS_BUILD_DATE: buildDateWib,
  },
  // Static export Desktop tidak melayani header; di sana CSP Tauri yang berlaku.
  ...(isDesktopBuild
    ? { output: "export" as const }
    : {
        ...(isStandaloneBuild ? { output: "standalone" as const } : {}),
        async headers() {
          return [{ source: "/:path*", headers: SECURITY_HEADERS }];
        },
      }),
  devIndicators: false,
  turbopack: {
    root: process.cwd(),
    resolveAlias: {
      "@zxing/browser": zxingBrowserModule,
      "@zxing/library": zxingLibraryModule,
    },
  },
  webpack(config) {
    config.resolve.alias = {
      ...config.resolve.alias,
      "@zxing/browser$": zxingBrowserEntry,
      "@zxing/library$": zxingLibraryEntry,
    };
    return config;
  },
  images: {
    unoptimized: true,
  },
  reactCompiler: true,
};

export default nextConfig;
