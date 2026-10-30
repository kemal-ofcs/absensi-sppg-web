"use client";

import { redirect } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { KasbonWorkspace } from "@/components/keuangan/KasbonWorkspace";
import { PageHeader } from "@/components/ui/PageHeader";
import { canAccessArea } from "@/lib/auth/access";
import { useAuth } from "@/lib/context/AuthContext";

export default function KasbonPage() {
  const { user, isAuthenticated, isLoading } = useAuth();

  if (!isLoading && isAuthenticated && !canAccessArea(user, "kasbon")) {
    redirect("/forbidden");
  }

  return (
    <AppShell contentClassName="mx-auto w-full max-w-7xl px-4 sm:px-6 lg:px-8">
      <div className="space-y-6 py-6 md:py-8">
        <PageHeader
          eyebrow="Keuangan"
          title="Kasbon Karyawan"
          description="Pinjaman karyawan yang dicicil lewat potong gaji. Sisa selalu dihitung dari cicilan yang benar-benar dipotong atau dilunasi, dan setiap uang yang berpindah tercatat di pembukuan."
        />
        {isAuthenticated ? <KasbonWorkspace /> : null}
      </div>
    </AppShell>
  );
}
