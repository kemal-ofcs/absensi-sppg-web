import type { NextConfig } from "next";

const isDesktopBuild = process.env.SPPG_BUILD_TARGET === "desktop";

const nextConfig: NextConfig = {
  ...(isDesktopBuild ? { output: "export" as const } : {}),
  images: {
    unoptimized: true,
  },
  reactCompiler: true,
};

export default nextConfig;
