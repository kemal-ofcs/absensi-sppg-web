"use client";

import { redirect } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { DriverWorkspace } from "@/components/perjalanan/DriverWorkspace";
import { PageHeader } from "@/components/ui/PageHeader";
import { canAccessArea } from "@/lib/auth/access";
import { useAuth } from "@/lib/context/AuthContext";

export default function DriverPage() {
  const { user, isAuthenticated, isLoading } = useAuth();

  if (!isLoading && isAuthenticated && !canAccessArea(user, "driver")) {
    redirect("/forbidden");
  }

  return (
    <AppShell contentClassName="mx-auto w-full max-w-3xl px-4 sm:px-6">
      <div className="space-y-6 py-6 md:py-8">
        <PageHeader
          eyebrow="Perjalanan"
          title="Lapor Perjalanan"
          description="Laporkan setiap tahap perjalanan dengan foto dan lokasi. Laporan tersimpan di perangkat dan terkirim otomatis saat ada sinyal."
        />
        {isAuthenticated ? <DriverWorkspace /> : null}
      </div>
    </AppShell>
  );
}
