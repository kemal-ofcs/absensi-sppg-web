"use client";

import { redirect } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { InventarisWorkspace } from "@/components/inventory/InventarisWorkspace";
import { PageHeader } from "@/components/ui/PageHeader";
import { canAccessArea } from "@/lib/auth/access";
import { useAuth } from "@/lib/context/AuthContext";

export default function InventarisPage() {
  const { user, isAuthenticated, isLoading } = useAuth();

  if (!isLoading && isAuthenticated && !canAccessArea(user, "inventaris")) {
    redirect("/forbidden");
  }

  return (
    <AppShell>
      <div className="space-y-6">
        <PageHeader
          eyebrow="Aset kantor"
          title="Inventaris"
          description="Stok barang per tempat dan kondisi, beserta riwayat setiap barang yang masuk, keluar, dan berpindah."
        />
        {isAuthenticated ? <InventarisWorkspace /> : null}
      </div>
    </AppShell>
  );
}
