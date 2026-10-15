"use client";

import { redirect } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { KeuanganWorkspace } from "@/components/keuangan/KeuanganWorkspace";
import { PageHeader } from "@/components/ui/PageHeader";
import { canAccessArea } from "@/lib/auth/access";
import { useAuth } from "@/lib/context/AuthContext";

export default function KeuanganPage() {
  const { user, isAuthenticated, isLoading } = useAuth();

  if (!isLoading && isAuthenticated && !canAccessArea(user, "keuangan")) {
    redirect("/forbidden");
  }

  return (
    <AppShell>
      <div className="space-y-6">
        <PageHeader
          eyebrow="Keuangan"
          title="Pembukuan"
          description="Jurnal umum, buku besar, dan neraca saldo. Saldo selalu dihitung dari jurnal, dan jurnal yang salah dibatalkan dengan jurnal pembalik, tidak dihapus."
        />
        {isAuthenticated ? <KeuanganWorkspace /> : null}
      </div>
    </AppShell>
  );
}
