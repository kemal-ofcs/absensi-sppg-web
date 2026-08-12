import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Keep Next.js server capabilities enabled (App Router + API routes).
  // Phase 1 UI depends on /api/* contract, so static export is not compatible.
  output: "standalone",
  devIndicators: false,
  images: {
    unoptimized: true,
  },
  reactStrictMode: true,
  reactCompiler: process.env.NEXT_REACT_COMPILER !== "0",
};

export default nextConfig;
