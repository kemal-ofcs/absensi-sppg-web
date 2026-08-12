export const PRODUCT_CONFIG = {
  name: process.env.NEXT_PUBLIC_APP_NAME?.trim() || "Hybrid Starter",
  description: "Reusable local-first desktop and cloud application foundation",
  version: process.env.NEXT_PUBLIC_APP_VERSION?.trim() || "0.1.0",
  storagePrefix: "hybrid-starter",
} as const;
