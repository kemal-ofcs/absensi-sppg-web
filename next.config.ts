import path from "node:path";
import type { NextConfig } from "next";

const isDesktopBuild = process.env.SPPG_BUILD_TARGET === "desktop";
const zxingBrowserEntry = path.resolve(
  process.cwd(),
  "node_modules/@zxing/browser/es2015/index.js",
);
const zxingLibraryEntry = path.resolve(
  process.cwd(),
  "node_modules/@zxing/library/es2015/index.js",
);

const nextConfig: NextConfig = {
  ...(isDesktopBuild ? { output: "export" as const } : {}),
  devIndicators: false,
  turbopack: {
    resolveAlias: {
      "@zxing/browser": zxingBrowserEntry,
      "@zxing/library": zxingLibraryEntry,
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
