import path from "node:path";
import type { NextConfig } from "next";

const isDesktopBuild = process.env.SPPG_BUILD_TARGET === "desktop";
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

const nextConfig: NextConfig = {
  ...(isDesktopBuild ? { output: "export" as const } : {}),
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
