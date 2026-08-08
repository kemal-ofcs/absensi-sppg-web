import type { Metadata } from "next";
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
      <body>{children}</body>
    </html>
  );
}
