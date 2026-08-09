import type { Metadata } from "next";
import { AuthProvider } from "@/lib/context/AuthContext";
import "./globals.css";

export const metadata: Metadata = {
  title: "Absensi SPPG",
  description: "Aplikasi absensi SPPG berbasis Next.js dan Tauri.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="id">
      <body className="antialiased bg-slate-950 text-slate-100">
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}
