"use client";

import { redirect } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { HrisWorkspace } from "@/components/hris/HrisWorkspace";
import { PageHeader } from "@/components/ui/PageHeader";
import { canAccessArea } from "@/lib/auth/access";
import { useAuth } from "@/lib/context/AuthContext";

export default function HrisPage() {
  const { user, isAuthenticated, isLoading } = useAuth();

  if (!isLoading && isAuthenticated && !canAccessArea(user, "hris")) {
    redirect("/forbidden");
  }

  return (
    <AppShell contentClassName="mx-auto w-full max-w-7xl px-4 sm:px-6 lg:px-8">
      <div className="space-y-6 py-6 md:py-8">
        <PageHeader
          eyebrow="Kepegawaian"
          title="HRIS"
          description="Struktur organisasi, data pribadi dan keuangan karyawan, kontrak kerja, dan dokumen. Data pribadi, keuangan, dan dokumen hanya tersimpan di database pusat."
        />
        {isAuthenticated ? <HrisWorkspace /> : null}
      </div>
    </AppShell>
  );
}
