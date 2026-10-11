"use client";

import Link from "next/link";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { Icon } from "@/components/ui/Icon";
import { useAuth } from "@/lib/context/AuthContext";
import { useHydrated } from "@/lib/hooks/useHydrated";

export default function ForbiddenPage() {
  const isHydrated = useHydrated();
  const { isAuthenticated, isLoading } = useAuth();

  if (!isHydrated || isLoading) {
    return <div className="min-h-dvh bg-slate-950" />;
  }
  if (!isAuthenticated) redirect("/login");

  return (
    <AppShell contentClassName="grid place-items-center px-4 py-10">
      <section className="app-panel w-full max-w-xl rounded-3xl p-7 text-center sm:p-10">
        <span className="mx-auto grid size-16 place-items-center rounded-2xl border border-amber-300/25 bg-amber-300/10 text-amber-200">
          <Icon name="lock" className="size-7" />
        </span>
        <p className="mt-6 text-xs font-black uppercase tracking-[0.24em] text-amber-300">
          Akses dibatasi
        </p>
        <h1 className="mt-3 text-2xl font-black text-white">
          Role kamu belum memiliki permission
        </h1>
        <p className="mx-auto mt-3 max-w-md text-sm leading-6 text-slate-400">
          Hubungi Superadmin bila fitur ini dibutuhkan untuk pekerjaanmu. Tidak
          ada data yang diubah.
        </p>
        <Link
          href="/"
          className="mt-7 inline-flex min-h-11 items-center justify-center rounded-xl bg-sky-400 px-5 text-sm font-black text-slate-950 transition hover:bg-sky-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-200"
        >
          Kembali ke Home
        </Link>
      </section>
    </AppShell>
  );
}
