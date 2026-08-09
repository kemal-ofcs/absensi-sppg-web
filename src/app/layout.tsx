import type { Metadata } from "next";
import { AuthProvider } from "@/lib/context/AuthContext";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "Absensi SPPG",
    template: "%s · Absensi SPPG",
  },
  description:
    "Sistem operasional absensi SPPG untuk Web dan Desktop dengan dukungan online dan offline.",
  applicationName: "Absensi SPPG",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="id">
      <body>
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}
