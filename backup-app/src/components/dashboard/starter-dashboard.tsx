"use client";

import { LogOut } from "lucide-react";
import { SyncPanel } from "@/components/dashboard/sync-panel";
import { ProductManagement } from "@/modules/products/product-management";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { isTauri } from "@/core/env";
import { useAuth } from "@/hooks/use-auth";

export function StarterDashboard() {
  const { user, logout } = useAuth();
  return (
    <main className="min-h-screen bg-zinc-950 p-5 text-zinc-100 md:p-10">
      <div className="mx-auto max-w-4xl space-y-6">
        <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
          <div>
            <p className="text-sm text-cyan-400">Hybrid Foundation Ready</p>
            <h1 className="text-3xl font-semibold">Starter Dashboard</h1>
          </div>
          <Button variant="outline" onClick={() => void logout()}>
            <LogOut className="mr-2 h-4 w-4" />
            Logout
          </Button>
        </div>
        <Card className="border-zinc-800 bg-zinc-900 text-zinc-100">
          <CardHeader>
            <CardTitle>Authenticated successfully</CardTitle>
            <CardDescription className="text-zinc-400">
              Aplikasi hybrid siap dikembangkan. Tambahkan modul baru Anda di <code>src/modules</code>.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <dl className="grid gap-3 text-sm sm:grid-cols-3">
              <div>
                <dt className="text-zinc-500">Name</dt>
                <dd>{user?.fullName}</dd>
              </div>
              <div>
                <dt className="text-zinc-500">Role</dt>
                <dd className="capitalize">{user?.role}</dd>
              </div>
              <div>
                <dt className="text-zinc-500">Runtime</dt>
                <dd>{isTauri() ? "Desktop / SQLite Lokal" : "Web / Turso Cloud"}</dd>
              </div>
            </dl>
          </CardContent>
        </Card>

        {/* Demo Modul Produk POS / Sync */}
        <ProductManagement />

        {/* Panel Sinkronisasi Cloud */}
        <SyncPanel />

        <div className="rounded-lg border border-amber-900/60 bg-amber-950/20 p-4 text-sm text-amber-100">
          Kredensial Default Starter: <code>admin</code> / <code>admin123</code>.
          Ganti password sebelum deploy ke production.
        </div>
      </div>
    </main>
  );
}

