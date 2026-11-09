"use client";

import { redirect } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { PerjalananWorkspace } from "@/components/perjalanan/PerjalananWorkspace";
import { PageHeader } from "@/components/ui/PageHeader";
import { canAccessArea } from "@/lib/auth/access";
import { useAuth } from "@/lib/context/AuthContext";

export default function PerjalananPage() {
  const { user, isAuthenticated, isLoading } = useAuth();

  if (!isLoading && isAuthenticated && !canAccessArea(user, "perjalanan")) {
    redirect("/forbidden");
  }

  return (
    <AppShell contentClassName="mx-auto w-full max-w-7xl px-4 sm:px-6 lg:px-8">
      <div className="space-y-6 py-6 md:py-8">
        <PageHeader
          eyebrow="Perjalanan"
          title="Surat Jalan"
          description="Buat dan cetak surat jalan, pantau laporan driver dari berangkat sampai selesai, dan tinjau laporan yang janggal. Status selalu dihitung dari laporan, tidak diketik."
        />
        {isAuthenticated ? <PerjalananWorkspace /> : null}
      </div>
    </AppShell>
  );
}
