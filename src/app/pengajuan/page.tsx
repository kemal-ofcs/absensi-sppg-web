"use client";

import { redirect } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { PengajuanWorkspace } from "@/components/hris/PengajuanWorkspace";
import { PageHeader } from "@/components/ui/PageHeader";
import { canAccessArea } from "@/lib/auth/access";
import { useAuth } from "@/lib/context/AuthContext";

export default function PengajuanPage() {
  const { user, isAuthenticated, isLoading } = useAuth();

  if (!isLoading && isAuthenticated && !canAccessArea(user, "pengajuan")) {
    redirect("/forbidden");
  }

  return (
    <AppShell contentClassName="mx-auto w-full max-w-5xl px-4 sm:px-6 lg:px-8">
      <div className="space-y-6 py-6 md:py-8">
        <PageHeader
          eyebrow="Kepegawaian"
          title="Cuti & Izin"
          description="Pengajuan cuti, izin, dan sakit beserta persetujuannya. Pengajuan yang disetujui tidak di-Alfa-kan dan ikut dihitung di gaji sesuai jenisnya."
        />
        {isAuthenticated ? <PengajuanWorkspace /> : null}
      </div>
    </AppShell>
  );
}
