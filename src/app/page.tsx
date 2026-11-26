"use client";

import Link from "next/link";
import { redirect, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { PerluPerhatian } from "@/components/hris/PerluPerhatian";
import { LicenseHolderLabel } from "@/components/license/LicenseNotice";
import { FeedbackBanner } from "@/components/ui/FeedbackBanner";
import { Icon } from "@/components/ui/Icon";
import { MemuatHalaman } from "@/components/ui/MemuatHalaman";
import { QuickActionGrid } from "@/components/ui/QuickActionGrid";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { AnimatedCounter } from "@/components/visual/AnimatedCounter";
import { SpotlightCard } from "@/components/visual/SpotlightCard";
import { SyncPulse } from "@/components/visual/SyncPulse";
import { TiltCard } from "@/components/visual/TiltCard";
import { canAccessArea, hasPermission } from "@/lib/auth/access";
import { BRANDING } from "@/lib/constants/branding";
import { useAuth } from "@/lib/context/AuthContext";
import { getDashboardMetrics } from "@/lib/gateways/report";
import { requestSyncNow } from "@/lib/gateways/sync-status";
import { useHydrated } from "@/lib/hooks/useHydrated";
import { useOnlineStatus } from "@/lib/hooks/useOnlineStatus";
import { useVisualTier } from "@/lib/stores/visual-store";
import { IZIN_PERHATIAN } from "@/lib/validations/telegram";
import type { VisualTier } from "@/lib/visual/gpu-tier";

interface DashboardMetrics {
  hadirHariIni: number;
  persentaseKehadiran: number;
  terlambatHariIni: number;
  totalKaryawan: number;
}

const TIER_BADGES: Record<VisualTier, { label: string; tone: string }> = {
  high: {
    label: "GPU Tinggi",
    tone: "text-emerald-300 border-emerald-400/30 bg-emerald-400/10",
  },
  medium: {
    label: "GPU Sedang",
    tone: "text-sky-300 border-sky-400/30 bg-sky-400/10",
  },
  low: {
    label: "GPU Rendah",
    tone: "text-amber-300 border-amber-300/30 bg-amber-300/10",
  },
  off: {
    label: "Efek Mati",
    tone: "text-slate-400 border-slate-700 bg-slate-800/40",
  },
};

function getLocalGreeting(hours: number): string {
  if (hours >= 4 && hours < 11) return "Selamat Pagi";
  if (hours >= 11 && hours < 15) return "Selamat Siang";
  if (hours >= 15 && hours < 18) return "Selamat Sore";
  return "Selamat Malam";
}

export default function Home() {
  const isHydrated = useHydrated();
  const isOnline = useOnlineStatus();
  const visualTier = useVisualTier();
  const { user, isAuthenticated, isLoading: authLoading } = useAuth();
  const router = useRouter();
  const canViewDashboard = hasPermission(user, "dashboard.view");

  const [metrics, setMetrics] = useState<DashboardMetrics | null>(null);
  const [metricsError, setMetricsError] = useState<string | null>(null);
  const [currentTimeStr, setCurrentTimeStr] = useState<string>("");
  const [currentDateStr, setCurrentDateStr] = useState<string>("");
  const [greeting, setGreeting] = useState<string>("Selamat datang");

  // Real-time monotonic digital clock & Indonesian formatted date
  useEffect(() => {
    const updateTime = () => {
      const now = new Date();
      setGreeting(getLocalGreeting(now.getHours()));
      setCurrentTimeStr(
        now.toLocaleTimeString("id-ID", {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
          hour12: false,
        }),
      );
      setCurrentDateStr(
        now.toLocaleDateString("id-ID", {
          weekday: "long",
          day: "numeric",
          month: "long",
          year: "numeric",
        }),
      );
    };

    updateTime();
    const interval = setInterval(updateTime, 1000);
    return () => clearInterval(interval);
  }, []);

  // Fetch Dashboard summary metrics
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
      <MemuatHalaman
        pesan={`Memuat Command Center ${BRANDING.appDisplayName}…`}
      />
    );
  }

  if (!isAuthenticated) redirect("/login");
  if (!canAccessArea(user, "home")) {
    // Akun Driver (hanya lapor perjalanan) langsung ke layarnya.
    redirect(canAccessArea(user, "driver") ? "/driver" : "/forbidden");
  }

  return (
    <AppShell contentClassName="mx-auto w-full max-w-7xl gap-8 px-4 py-6 sm:px-6 md:py-8 lg:px-8">
      {/* =========================================================================
          1. HERO COMMAND CENTER SECTION: Rich, Midnight Slate, Clean & Spacious
          ========================================================================= */}
      <section className="relative overflow-hidden rounded-3xl border border-white/10 bg-gradient-to-br from-slate-900 via-slate-900 to-sky-950/60 p-6 shadow-2xl backdrop-blur-xl sm:p-8 md:p-10">
        {/* Glow ambient background elements */}
        <div className="pointer-events-none absolute -right-16 -top-16 size-96 rounded-full bg-sky-500/15 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-20 -left-20 size-80 rounded-full bg-amber-400/10 blur-3xl" />

        <div className="relative flex flex-col items-start justify-between gap-6 lg:flex-row lg:items-center">
          {/* Left Column: Command Center Header & Greeting */}
          <div className="max-w-3xl space-y-4">
            {/* Status Badges */}
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge tone="info">
                <span className="mr-1.5 inline-block size-2 animate-pulse rounded-full bg-sky-400" />
                Command Center
              </StatusBadge>
              <StatusBadge tone="warning">
                {user?.isSuperadmin ? "Superadmin RBAC" : "Operator Aktif"}
              </StatusBadge>
              {currentDateStr ? (
                <span className="rounded-xl border border-white/10 bg-white/[0.05] px-3 py-1 text-xs font-semibold text-slate-300">
                  {currentDateStr} • {currentTimeStr || "00:00:00"} WIB
                </span>
              ) : null}
            </div>

            {/* Greeting & Title */}
            <div>
              <h1 className="text-2xl font-black tracking-tight text-white sm:text-3xl lg:text-4xl">
                {greeting},
                <span className="ml-2.5 bg-gradient-to-r from-sky-300 via-sky-200 to-amber-200 bg-clip-text text-transparent">
                  {user?.nama_operator}
                </span>
              </h1>
              <p className="mt-2 text-xs leading-6 text-slate-400 sm:text-sm">
                Pusat kendali kehadiran karyawan, terminal QR Code terenkripsi,
                penggajian PPh 21, dan sinkronisasi cloud dua arah Turso.
              </p>
            </div>

            {/* Quick Action Button Group */}
            <div className="flex flex-wrap items-center gap-3 pt-2">
              {canAccessArea(user, "scanner") ? (
                <Link
                  href="/scanner"
                  className="group relative inline-flex min-h-12 items-center justify-center gap-2.5 rounded-2xl bg-sky-700 px-6 text-sm font-black text-on-accent shadow-lg shadow-sky-950/30 transition hover:bg-sky-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-200"
                >
                  <Icon
                    name="scanner"
                    className="size-5 transition group-hover:scale-110"
                  />
                  <span>Buka Terminal QR</span>
                </Link>
              ) : null}

              {canViewDashboard ? (
                <Link
                  href="/dashboard"
                  className="inline-flex min-h-12 items-center justify-center gap-2 rounded-2xl border border-white/15 bg-white/[0.06] px-5 text-sm font-bold text-white shadow-lg transition hover:bg-white/[0.12] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300"
                >
                  <Icon name="dashboard" className="size-4 text-amber-300" />
                  <span>Dashboard KPI</span>
                </Link>
              ) : null}

              <button
                type="button"
                onClick={requestSyncNow}
                title="Sinkronisasikan database lokal ke cloud Turso sekarang"
                className="inline-flex min-h-12 items-center justify-center gap-2 rounded-2xl border border-white/10 bg-slate-950/60 px-4 text-xs font-bold text-slate-300 shadow-md transition hover:bg-slate-900 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300"
              >
                <Icon name="sync" className="size-4 text-sky-400" />
                <span>Sync Cloud</span>
              </button>
            </div>
          </div>

          {/* Right Column: Operational Snapshot Info */}
          <div className="flex flex-col gap-2 rounded-2xl border border-white/10 bg-slate-950/60 p-4 text-xs text-slate-400 backdrop-blur-md sm:min-w-64">
            <p className="font-bold text-slate-200">Integritas Sistem</p>
            <div className="flex items-center gap-2">
              <span className="size-2 rounded-full bg-emerald-400" />
              <span>Vault AES-256-GCM Aktif</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="size-2 rounded-full bg-sky-400" />
              <span>Monotonic Drift Guard 0ms</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="size-2 rounded-full bg-amber-400" />
              <span>Offline SQLite Terlindungi</span>
            </div>
          </div>
        </div>
      </section>

      {/* Metrics Error Feedback */}
      {canViewDashboard && metricsError ? (
        <FeedbackBanner tone="error" onDismiss={() => setMetricsError(null)}>
          <p className="font-bold">Ringkasan kehadiran belum tersedia</p>
          <p className="mt-1 text-xs opacity-80">{metricsError}</p>
        </FeedbackBanner>
      ) : null}

      {/* =========================================================================
          2. KPI SUMMARY BENTO CARDS: 3D Tilt + Spotlight + Animated Counter
          ========================================================================= */}
      <section aria-labelledby="summary-title" className="space-y-3">
        <div className="flex items-center justify-between">
          <h2
            id="summary-title"
            className="text-xs font-black uppercase tracking-[0.2em] text-amber-300"
          >
            Ringkasan Kehadiran Hari Ini
          </h2>
          <span className="text-[11px] font-medium text-slate-400">
            Pembaruan Waktu Nyata
          </span>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {/* Card 1: Total Karyawan */}
          {canViewDashboard ? (
            <TiltCard maxTilt={5}>
              <SpotlightCard className="h-full rounded-2xl">
                <article className="app-panel relative flex h-full flex-col justify-between overflow-hidden rounded-2xl p-5 shadow-lg">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold uppercase tracking-wider text-slate-400">
                      Total Karyawan
                    </span>
                    <span className="grid size-8 place-items-center rounded-xl border border-sky-400/25 bg-sky-400/10 text-sky-300">
                      <Icon name="users" className="size-4" />
                    </span>
                  </div>
                  <div className="mt-4">
                    <p className="text-3xl font-black tracking-tight text-white sm:text-4xl">
                      <AnimatedCounter
                        value={metrics?.totalKaryawan ?? 0}
                        durationSeconds={0.9}
                      />
                    </p>
                    <div className="mt-2 flex items-center gap-2">
                      <span className="inline-block size-1.5 rounded-full bg-sky-400" />
                      <p className="text-xs font-medium text-slate-400">
                        Personil terdaftar aktif
                      </p>
                    </div>
                  </div>
                </article>
              </SpotlightCard>
            </TiltCard>
          ) : null}

          {/* Card 2: Hadir Hari Ini */}
          {canViewDashboard ? (
            <TiltCard maxTilt={5}>
              <SpotlightCard className="h-full rounded-2xl">
                <article className="app-panel relative flex h-full flex-col justify-between overflow-hidden rounded-2xl p-5 shadow-lg">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold uppercase tracking-wider text-slate-400">
                      Hadir Hari Ini
                    </span>
                    <span className="grid size-8 place-items-center rounded-xl border border-emerald-400/25 bg-emerald-400/10 text-emerald-300">
                      <Icon name="check" className="size-4" />
                    </span>
                  </div>
                  <div className="mt-4">
                    <div className="flex items-baseline justify-between gap-2">
                      <p className="text-3xl font-black tracking-tight text-white sm:text-4xl">
                        <AnimatedCounter
                          value={metrics?.hadirHariIni ?? 0}
                          durationSeconds={0.9}
                        />
                      </p>
                      <span className="rounded-lg border border-emerald-400/30 bg-emerald-400/10 px-2 py-0.5 text-xs font-black text-emerald-300">
                        <AnimatedCounter
                          value={metrics?.persentaseKehadiran ?? 0}
                          suffix="%"
                          durationSeconds={0.9}
                        />
                      </span>
                    </div>
                    {/* Visual Percentage Bar */}
                    <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-slate-800">
                      <div
                        className="h-full rounded-full bg-gradient-to-r from-emerald-500 to-sky-400 transition-all duration-1000"
                        style={{
                          width: `${Math.min(metrics?.persentaseKehadiran ?? 0, 100)}%`,
                        }}
                      />
                    </div>
                  </div>
                </article>
              </SpotlightCard>
            </TiltCard>
          ) : null}

          {/* Card 3: Terlambat */}
          {canViewDashboard ? (
            <TiltCard maxTilt={5}>
              <SpotlightCard className="h-full rounded-2xl">
                <article className="app-panel relative flex h-full flex-col justify-between overflow-hidden rounded-2xl p-5 shadow-lg">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold uppercase tracking-wider text-slate-400">
                      Terlambat
                    </span>
                    <span className="grid size-8 place-items-center rounded-xl border border-amber-300/25 bg-amber-300/10 text-amber-200">
                      <Icon name="clock" className="size-4" />
                    </span>
                  </div>
                  <div className="mt-4">
                    <p className="text-3xl font-black tracking-tight text-white sm:text-4xl">
                      <AnimatedCounter
                        value={metrics?.terlambatHariIni ?? 0}
                        durationSeconds={0.9}
                      />
                    </p>
                    <div className="mt-2 flex items-center gap-2">
                      <span className="inline-block size-1.5 rounded-full bg-amber-400" />
                      <p className="text-xs font-medium text-slate-400">
                        Melewati batas toleransi shift
                      </p>
                    </div>
                  </div>
                </article>
              </SpotlightCard>
            </TiltCard>
          ) : null}

          {/* Card 4: Status Koneksi & Sync Pulse */}
          <TiltCard maxTilt={5}>
            <SpotlightCard className="h-full rounded-2xl">
              <article className="app-panel relative flex h-full flex-col justify-between overflow-hidden rounded-2xl p-5 shadow-lg">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold uppercase tracking-wider text-slate-400">
                    Koneksi & Sinkronisasi
                  </span>
                  <SyncPulse />
                </div>
                <div className="mt-4">
                  <div className="flex items-center gap-2">
                    <span
                      className={`size-2.5 rounded-full ${isOnline ? "bg-emerald-400 shadow-sm animate-pulse" : "bg-amber-400"}`}
                    />
                    <p
                      className={`text-base font-black sm:text-lg ${isOnline ? "text-emerald-200" : "text-amber-200"}`}
                    >
                      {isOnline ? "Jaringan Terhubung" : "Mode Offline Lokal"}
                    </p>
                  </div>
                  <p className="mt-1.5 text-xs leading-5 text-slate-400">
                    {isOnline
                      ? "Sinkronisasi pipeline Turso aktif dua arah."
                      : "Absensi disimpan di SQLite lokal dan siap push."}
                  </p>
                </div>
              </article>
            </SpotlightCard>
          </TiltCard>
        </div>
      </section>

      {/* Kartu "Perlu perhatian" (§24.5, Q-123): hanya bila ada isinya. Nama
          membuka rincian karyawan di /hris pada tab alasannya. */}
      {IZIN_PERHATIAN.some((izin) => hasPermission(user, izin)) ? (
        <PerluPerhatian
          sembunyiBilaKosong
          onPilihKaryawan={
            canAccessArea(user, "hris")
              ? (idKaryawan, tab) =>
                  router.push(
                    `/hris?karyawan=${encodeURIComponent(idKaryawan)}&tab=${tab}`,
                  )
              : undefined
          }
          onBukaKinerja={
            canAccessArea(user, "hris") &&
            (
              [
                "hr.performance.view",
                "hr.performance.assess",
                "hr.performance.config",
                "hr.performance.finalize",
              ] as const
            ).some((izin) => hasPermission(user, izin))
              ? () => router.push("/hris?tab=kinerja")
              : undefined
          }
          onBukaRekrutmen={
            canAccessArea(user, "hris") &&
            (hasPermission(user, "hr.recruit.view") ||
              hasPermission(user, "hr.recruit.manage"))
              ? () => router.push("/hris?tab=rekrutmen")
              : undefined
          }
        />
      ) : null}

      {/* =========================================================================
          3. AKSES CEPAT: ubin navy + emas, disaring area akses
          ========================================================================= */}
      <section aria-labelledby="modules-title" className="space-y-4">
        <div>
          <p className="page-header-eyebrow text-[11px] font-bold uppercase tracking-[0.2em]">
            Pusat Modul Sistem
          </p>
          <h2
            id="modules-title"
            className="page-header-title mt-0.5 text-xl font-black sm:text-2xl"
          >
            Pilih Pekerjaan Utama
          </h2>
        </div>

        <QuickActionGrid />
      </section>

      {/* =========================================================================
          4. PERFORMANCE & GPU TIER FOOTER STATUS BAR
          ========================================================================= */}
      <footer className="mt-2 flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-white/10 bg-slate-950/60 px-5 py-3 text-xs text-slate-400 backdrop-blur-md">
        <div className="flex flex-wrap items-center gap-2 sm:gap-3">
          <span className="font-bold text-slate-300">Akselerasi Grafis:</span>
          <span
            className={`rounded-full border px-2.5 py-0.5 text-[11px] font-bold ${TIER_BADGES[visualTier]?.tone}`}
          >
            {TIER_BADGES[visualTier]?.label ?? "Otomatis"}
          </span>
          <span className="hidden text-slate-600 sm:inline">•</span>
          <span className="text-[11px] text-slate-500">
            Offline-First Local SQLite Engine • Monotonic Drift Protection
          </span>
        </div>

        <Link
          href="/settings"
          className="inline-flex items-center gap-1.5 font-bold text-sky-300 hover:text-sky-200 hover:underline"
        >
          <Icon name="settings" className="size-3.5" />
          <span>Atur Kualitas Visual</span>
        </Link>
        <LicenseHolderLabel className="w-full text-[10px] text-slate-500" />
      </footer>
    </AppShell>
  );
}
