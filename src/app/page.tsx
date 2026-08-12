"use client";

import Link from "next/link";
import { redirect } from "next/navigation";
import { useEffect, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { FeedbackBanner } from "@/components/ui/FeedbackBanner";
import { Icon, type IconName } from "@/components/ui/Icon";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { type AppArea, canAccessArea, hasPermission } from "@/lib/auth/access";
import { useAuth } from "@/lib/context/AuthContext";
import { getDashboardMetrics } from "@/lib/gateways/report";
import { useHydrated } from "@/lib/hooks/useHydrated";
import { useOnlineStatus } from "@/lib/hooks/useOnlineStatus";

interface DashboardMetrics {
  hadirHariIni: number;
  persentaseKehadiran: number;
  terlambatHariIni: number;
  totalKaryawan: number;
}

interface ModuleCard {
  area: AppArea;
  description: string;
  href: string;
  icon: IconName;
  label: string;
  title: string;
  tone: "amber" | "sky";
}

const MODULES: ModuleCard[] = [
  {
    area: "scanner",
    href: "/scanner",
    icon: "scanner",
    label: "Buka QR Scanner",
    title: "Terminal QR Absensi",
    description:
      "Pindai QR Code kartu karyawan dengan feedback suara, pencegahan scan ganda, dan koordinat GPS.",
    tone: "sky",
  },
  {
    area: "dashboard",
    href: "/dashboard",
    icon: "dashboard",
    label: "Lihat dashboard",
    title: "Dashboard & Rekap",
    description:
      "Pantau KPI kehadiran harian dan bulanan, leaderboard, serta ekspor laporan CSV.",
    tone: "amber",
  },
  {
    area: "karyawan",
    href: "/karyawan",
    icon: "user",
    label: "Kelola karyawan",
    title: "Master Data Karyawan",
    description:
      "Kelola profil, shift, status aktif, pencarian, dan token QR karyawan.",
    tone: "sky",
  },
  {
    area: "shift",
    href: "/shift",
    icon: "clock",
    label: "Kelola shift",
    title: "Pengaturan Shift",
    description:
      "Atur jadwal masuk, pulang, toleransi keterlambatan, dan durasi kerja.",
    tone: "amber",
  },
  {
    area: "settings",
    href: "/settings",
    icon: "settings",
    label: "Buka settings",
    title: "Settings Aplikasi",
    description:
      "Kelola identitas visual dan logo yang tersimpan pada perangkat ini.",
    tone: "sky",
  },
  {
    area: "operational",
    href: "/operational",
    icon: "tools",
    label: "Buka operasional",
    title: "Koreksi & Backup",
    description:
      "Kelola Koreksi Admin, penugasan karyawan pengganti, dan Import Offline dengan antrean sinkronisasi.",
    tone: "amber",
  },
  {
    area: "operators",
    href: "/operators",
    icon: "users",
    label: "Kelola operator",
    title: "Master Operator",
    description:
      "Kelola akun, role dinamis, dan permission aplikasi khusus Superadmin.",
    tone: "amber",
  },
];

export default function Home() {
  const isHydrated = useHydrated();
  const isOnline = useOnlineStatus();
  const { user, isAuthenticated, isLoading: authLoading } = useAuth();
  const canViewDashboard = hasPermission(user, "dashboard.view");
  const [metrics, setMetrics] = useState<DashboardMetrics | null>(null);
  const [metricsError, setMetricsError] = useState<string | null>(null);

  useEffect(() => {
    if (!isHydrated || !isAuthenticated || !canViewDashboard) return;

    let isCancelled = false;
    setMetricsError(null);
    getDashboardMetrics()
      .then((data) => {
        if (!isCancelled) setMetrics(data);
      })
      .catch((error: unknown) => {
        if (isCancelled) return;
        setMetricsError(
          error instanceof Error
            ? error.message
            : "Ringkasan hari ini belum dapat dimuat.",
        );
      });

    return () => {
      isCancelled = true;
    };
  }, [isHydrated, isAuthenticated, canViewDashboard]);

  if (!isHydrated || authLoading) {
    return (
      <div className="grid min-h-dvh place-items-center bg-slate-950 p-6 text-slate-100">
        <output className="flex flex-col items-center gap-3">
          <div className="size-10 animate-spin rounded-full border-4 border-sky-400 border-t-transparent" />
          <p className="text-xs font-medium text-slate-400">
            Memuat Home aplikasi...
          </p>
        </output>
      </div>
    );
  }

  if (!isAuthenticated) redirect("/login");
  if (!canAccessArea(user, "home")) redirect("/forbidden");

  const visibleModules = MODULES.filter((item) =>
    canAccessArea(user, item.area),
  );

  return (
    <AppShell contentClassName="mx-auto w-full max-w-7xl gap-8 px-4 py-6 sm:px-6 md:py-8 lg:px-8">
      <section className="relative overflow-hidden rounded-3xl border border-white/10 bg-gradient-to-br from-slate-900 via-slate-900 to-sky-950/50 p-6 shadow-2xl sm:p-8">
        <div className="pointer-events-none absolute -right-20 -top-20 size-72 rounded-full bg-sky-400/10 blur-3xl" />
        <div className="relative flex flex-col items-start justify-between gap-6 md:flex-row md:items-center">
          <div className="max-w-3xl">
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge tone="info">Command Center</StatusBadge>
              <StatusBadge tone="warning">Gold Pro</StatusBadge>
            </div>
            <h1 className="mt-4 text-2xl font-black tracking-tight text-white sm:text-3xl">
              Selamat datang,
              <span className="ml-2 text-sky-300">{user?.nama_operator}</span>
            </h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-400">
              Kelola kehadiran, terminal QR, data karyawan, shift, dan laporan
              dari satu pusat kerja.
            </p>
          </div>
          {canAccessArea(user, "scanner") ? (
            <Link
              href="/scanner"
              className="inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-2xl bg-sky-400 px-5 text-sm font-black text-slate-950 shadow-lg shadow-sky-950/30 transition hover:bg-sky-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-200 md:w-auto"
            >
              <Icon name="scanner" className="size-5" />
              Buka QR Scanner
            </Link>
          ) : null}
        </div>
      </section>

      {canViewDashboard && metricsError ? (
        <FeedbackBanner tone="error" onDismiss={() => setMetricsError(null)}>
          <p className="font-bold">Ringkasan belum tersedia</p>
          <p className="mt-1 text-xs opacity-80">{metricsError}</p>
        </FeedbackBanner>
      ) : null}

      <section aria-labelledby="summary-title">
        <h2 id="summary-title" className="sr-only">
          Ringkasan kehadiran
        </h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {canViewDashboard ? (
            <article className="app-panel rounded-2xl p-5">
              <p className="text-xs font-bold uppercase tracking-wider text-slate-400">
                Total karyawan
              </p>
              <p className="mt-3 text-3xl font-black text-white">
                {metrics?.totalKaryawan ?? 0}
              </p>
              <p className="mt-1 text-xs text-slate-500">Terdaftar</p>
            </article>
          ) : null}
          {canViewDashboard ? (
            <article className="app-panel rounded-2xl p-5">
              <p className="text-xs font-bold uppercase tracking-wider text-slate-400">
                Hadir hari ini
              </p>
              <p className="mt-3 text-3xl font-black text-white">
                {metrics?.hadirHariIni ?? 0}
              </p>
              <p className="mt-1 text-xs text-slate-500">
                {metrics?.persentaseKehadiran ?? 0}% kehadiran
              </p>
            </article>
          ) : null}
          {canViewDashboard ? (
            <article className="app-panel rounded-2xl p-5">
              <p className="text-xs font-bold uppercase tracking-wider text-slate-400">
                Terlambat
              </p>
              <p className="mt-3 text-3xl font-black text-white">
                {metrics?.terlambatHariIni ?? 0}
              </p>
              <p className="mt-1 text-xs text-slate-500">Hari ini</p>
            </article>
          ) : null}
          <article className="app-panel rounded-2xl p-5">
            <p className="text-xs font-bold uppercase tracking-wider text-slate-400">
              Koneksi
            </p>
            <p
              className={`mt-3 text-lg font-black ${isOnline ? "text-sky-200" : "text-amber-200"}`}
            >
              {isOnline ? "Jaringan tersedia" : "Menunggu jaringan"}
            </p>
            <p className="mt-1 text-xs leading-5 text-slate-500">
              Status jaringan, bukan konfirmasi sinkronisasi data.
            </p>
          </article>
        </div>
      </section>

      <section aria-labelledby="modules-title">
        <p className="text-[11px] font-bold uppercase tracking-[0.2em] text-amber-300">
          Modul aplikasi
        </p>
        <h2 id="modules-title" className="mt-1 text-xl font-black text-white">
          Pilih pekerjaan utama
        </h2>
        <div className="mt-4 grid grid-cols-1 gap-5 md:grid-cols-2 lg:grid-cols-3">
          {visibleModules.map((module) => (
            <Link
              key={module.href}
              href={module.href}
              className={`group rounded-3xl border bg-slate-900/80 p-6 shadow-xl transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300 ${module.tone === "sky" ? "border-sky-400/15 hover:border-sky-400/45" : "border-amber-300/15 hover:border-amber-300/45"}`}
            >
              <span
                className={`grid size-12 place-items-center rounded-2xl border ${module.tone === "sky" ? "border-sky-400/25 bg-sky-400/10 text-sky-200" : "border-amber-300/25 bg-amber-300/10 text-amber-200"}`}
              >
                <Icon name={module.icon} className="size-6" />
              </span>
              <h3 className="mt-5 text-lg font-black text-white">
                {module.title}
              </h3>
              <p className="mt-2 text-sm leading-6 text-slate-400">
                {module.description}
              </p>
              <span className="mt-5 inline-flex items-center gap-1 text-xs font-bold text-sky-200">
                {module.label}
                <Icon name="chevron-right" className="size-3.5" />
              </span>
            </Link>
          ))}
        </div>
      </section>
    </AppShell>
  );
}
