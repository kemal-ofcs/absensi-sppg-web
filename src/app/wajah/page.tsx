"use client";

import { redirect } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { PageHeader } from "@/components/ui/PageHeader";
import { WajahWorkspace } from "@/components/wajah/WajahWorkspace";
import { canAccessArea } from "@/lib/auth/access";
import { useAuth } from "@/lib/context/AuthContext";

export default function WajahPage() {
  const { user, isAuthenticated, isLoading } = useAuth();

  if (!isLoading && isAuthenticated && !canAccessArea(user, "face_template")) {
    redirect("/forbidden");
  }

  return (
    <AppShell>
      <div className="space-y-6">
        <PageHeader
          eyebrow="Keamanan absensi"
          title="Pendaftaran Wajah"
          description="Wajah yang dicocokkan dengan pemilik kartu saat scan. Berlaku bila verifikasi wajah dinyalakan di Pengaturan."
        />
        {isAuthenticated ? <WajahWorkspace /> : null}
      </div>
    </AppShell>
  );
}
