import type { Metadata } from "next";
import { NuqsAdapter } from "nuqs/adapters/next/app";
import { Toaster } from "sonner";
import { AuthSessionProvider } from "@/components/providers/auth-session-provider";
import { PRODUCT_CONFIG } from "@/config/product";
import { primeServerRuntimeWarmup } from "@/lib/runtime/server-warmup";
import "./globals.css";

export const metadata: Metadata = {
  title: PRODUCT_CONFIG.name,
  description: PRODUCT_CONFIG.description,
  manifest: "/manifest.json",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  primeServerRuntimeWarmup();
  return (
    <html lang="en">
      <body className="font-sans antialiased">
        <AuthSessionProvider>
          <NuqsAdapter>{children}</NuqsAdapter>
        </AuthSessionProvider>
        <Toaster position="top-right" richColors closeButton />
      </body>
    </html>
  );
}
