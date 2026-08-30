"use client";

import Link from "next/link";
import { redirect } from "next/navigation";
import { useEffect, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { FeedbackBanner } from "@/components/ui/FeedbackBanner";
import { Icon, type IconName } from "@/components/ui/Icon";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { AnimatedCounter } from "@/components/visual/AnimatedCounter";
import { FadeIn } from "@/components/visual/FadeIn";
import { SpotlightCard } from "@/components/visual/SpotlightCard";
import { SyncPulse } from "@/components/visual/SyncPulse";
import { TiltCard } from "@/components/visual/TiltCard";
import { type AppArea, canAccessArea, hasPermission } from "@/lib/auth/access";
import { useAuth } from "@/lib/context/AuthContext";
import { getDashboardMetrics } from "@/lib/gateways/report";
import { requestSyncNow } from "@/lib/gateways/sync-status";
import { useHydrated } from "@/lib/hooks/useHydrated";
import { useOnlineStatus } from "@/lib/hooks/useOnlineStatus";
import { useVisualTier } from "@/lib/stores/visual-store";
import type { VisualTier } from "@/lib/visual/gpu-tier";

interface DashboardMetrics {
  hadirHariIni: number;
  persentaseKehadiran: number;
  terlambatHariIni: number;
  totalKaryawan: number;
}

type ModuleCategory = "all" | "ops" | "master" | "system";

interface ModuleCard {
  area: AppArea;
  category: ModuleCategory;
  description: string;
  featured?: boolean;
  href: string;
  icon: IconName;
  label: string;
  title: string;
  tone: "sky" | "amber" | "emerald" | "violet";
}

const MODULES: ModuleCard[] = [
  {
    area: "scanner",
    category: "ops",
    featured: true,
    href: "/scanner",
    icon: "scanner",
    label: "Buka Terminal Scanner",
    title: "Terminal QR Absensi",
    description:
      "Pindai QR Code kartu karyawan instan dengan audio feedback, perlindungan anti-double scan, dan geofencing GPS 0ms.",
    tone: "sky",
  },
  {
    area: "dashboard",
    category: "ops",
    featured: true,
    href: "/dashboard",
    icon: "dashboard",
    label: "Buka Dashboard",
    title: "Dashboard & Rekap KPI",
    description:
      "Pantau performa kehadiran harian, grafik tren mingguan, leaderboard kedisiplinan, dan ekspor laporan CSV.",
    tone: "amber",
  },
  {
    area: "history",
    category: "ops",
    href: "/history",
    icon: "clock",
    label: "Lihat Riwayat",
    title: "Riwayat & Log Scan",
    description:
      "Audit log scan waktu-nyata, rekap kehadiran harian, riwayat koreksi admin, dan ekspor data Microsoft Excel.",
    tone: "sky",
  },
  {
    area: "payroll",
    category: "ops",
    href: "/payroll",
    icon: "document",
    label: "Buka Penggajian",
    title: "Penggajian & PPh 21",
    description:
      "Perhitungan gaji presisi rust_decimal, kalkulasi PPh 21 TER Pasal 17 UU HPP, BPJS Kesehatan & Ketenagakerjaan.",
    tone: "emerald",
  },
  {
    area: "karyawan",
    category: "master",
    href: "/karyawan",
    icon: "user",
    label: "Kelola Karyawan",
    title: "Master Data Karyawan",
    description:
      "Kelola database personil, penetapan shift kerja, status aktif karyawan, dan regenerasi token enkripsi QR.",
    tone: "sky",
  },
  {
    area: "idcards",
    category: "master",
    href: "/id-cards",
    icon: "user",
    label: "Cetak Kartu",
    title: "ID Card & Desain Kartu",
    description:
      "Desain tata letak kartu CR80, manajemen elemen dinamis instansi, dan cetak massal format lembar A4 resolusi tinggi.",
    tone: "amber",
  },
  {
    area: "shift",
    category: "master",
    href: "/shift",
    icon: "clock",
    label: "Atur Shift",
    title: "Pengaturan Shift Kerja",
    description:
      "Konfigurasi jam masuk, toleransi keterlambatan, shift malam lintas hari, dan jadwal kerja fleksibel.",
    tone: "amber",
  },
  {
    area: "holidays",
    category: "master",
    href: "/holidays",
    icon: "calendar",
    label: "Kelola Kalender",
    title: "Kalender Hari Libur",
    description:
      "Penjadwalan hari libur nasional dan cuti bersama instansi untuk pengecualian sistem auto-alfa otomatis.",
    tone: "sky",
  },
  {
    area: "operational",
    category: "ops",
    href: "/operational",
    icon: "tools",
    label: "Buka Operasional",
    title: "Koreksi & Backup",
    description:
      "Penyesuaian kehadiran manual dengan audit trail immutable, penugasan karyawan pengganti, dan impor offline.",
    tone: "amber",
  },
  {
    area: "operators",
    category: "system",
    href: "/operators",
    icon: "users",
    label: "Kelola Operator",
    title: "Master Operator & RBAC",
    description:
      "Manajemen akun staf, pembagian hak akses dynamic permission, dan audit login sistem khusus Superadmin.",
    tone: "violet",
  },
  {
    area: "password_reset",
    category: "system",
    href: "/riwayat-reset-password",
    icon: "lock",
    label: "Lihat Riwayat",
    title: "Riwayat Reset Password",
    description:
      "Siapa saja yang mengajukan Lupa Password, foto verifikasi wajahnya, hasil uji liveness, dan status pengiriman link pemulihan.",
    tone: "violet",
  },
  {
    area: "settings",
    category: "system",
    href: "/settings",
    icon: "settings",
    label: "Buka Pengaturan",
    title: "Pengaturan Sistem",
    description:
      "Konfigurasi sinkronisasi Turso Vault AES-GCM, tier performa grafis, Geofence radius kantor, dan profil instansi.",
    tone: "sky",
  },
];

const CATEGORY_TABS: { id: ModuleCategory; label: string }[] = [
  { id: "all", label: "Semua Modul" },
  { id: "ops", label: "Operasional & Presensi" },
  { id: "master", label: "Master Data & Kartu" },
  { id: "system", label: "Sistem & Keamanan" },
];

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

const TONE_CLASSES: Record<
  "sky" | "amber" | "emerald" | "violet",
  {
    borderHover: string;
    iconBadge: string;
    label: string;
  }
> = {
  sky: {
    borderHover: "border-sky-400/15 hover:border-sky-400/45",
    iconBadge: "border-sky-400/25 bg-sky-400/10 text-sky-200",
    label: "text-sky-300",
  },
  amber: {
    borderHover: "border-amber-300/15 hover:border-amber-300/45",
    iconBadge: "border-amber-300/25 bg-amber-300/10 text-amber-200",
    label: "text-amber-300",
  },
  emerald: {
    borderHover: "border-emerald-400/15 hover:border-emerald-400/45",
    iconBadge: "border-emerald-400/25 bg-emerald-400/10 text-emerald-200",
    label: "text-emerald-300",
  },
  violet: {
    borderHover: "border-violet-400/15 hover:border-violet-400/45",
    iconBadge: "border-violet-400/25 bg-violet-400/10 text-violet-200",
    label: "text-violet-300",
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
  const canViewDashboard = hasPermission(user, "dashboard.view");

  const [metrics, setMetrics] = useState<DashboardMetrics | null>(null);
  const [metricsError, setMetricsError] = useState<string | null>(null);
  const [selectedCategory, setSelectedCategory] =
    useState<ModuleCategory>("all");
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
      <div className="grid min-h-dvh place-items-center bg-slate-950 p-6 text-slate-100">
        <output className="flex flex-col items-center gap-3">
          <div className="size-10 animate-spin rounded-full border-4 border-sky-400 border-t-transparent" />
          <p className="text-xs font-medium text-slate-400">
            Memuat Command Center Absensi SPPG...
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

  const filteredModules = visibleModules.filter((item) =>
    selectedCategory === "all" ? true : item.category === selectedCategory,
  );

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
                  className="group relative inline-flex min-h-12 items-center justify-center gap-2.5 rounded-2xl bg-sky-400 px-6 text-sm font-black text-slate-950 shadow-lg shadow-sky-950/30 transition hover:bg-sky-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-200"
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
                      className={`text-base font-black sm:text-lg ${isOnline ? "text-sky-200" : "text-amber-200"}`}
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

      {/* =========================================================================
          3. WORKSPACE MODULES: Modern Bento Grid with Midnight Slate Cards
          ========================================================================= */}
      <section aria-labelledby="modules-title" className="space-y-4">
        <div className="flex flex-col items-start justify-between gap-3 sm:flex-row sm:items-center">
          <div>
            <p className="text-[11px] font-bold uppercase tracking-[0.2em] text-amber-300">
              Pusat Modul Sistem
            </p>
            <h2
              id="modules-title"
              className="mt-0.5 text-xl font-black text-white sm:text-2xl"
            >
              Pilih Pekerjaan Utama
            </h2>
          </div>

          {/* Category Filter Tabs */}
          <nav
            aria-label="Kategori modul"
            className="flex flex-wrap items-center gap-1 rounded-2xl border border-white/10 bg-slate-950/60 p-1 backdrop-blur-md"
          >
            {CATEGORY_TABS.map((tab) => {
              const isSelected = selectedCategory === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setSelectedCategory(tab.id)}
                  className={`rounded-xl px-3 py-1.5 text-xs font-bold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300 ${
                    isSelected
                      ? "bg-sky-500 text-white shadow-md shadow-sky-950/40"
                      : "text-slate-400 hover:bg-white/[0.06] hover:text-white"
                  }`}
                >
                  {tab.label}
                </button>
              );
            })}
          </nav>
        </div>

        {/* Modules Grid */}
        <div className="grid grid-cols-1 gap-5 md:grid-cols-2 lg:grid-cols-3">
          {filteredModules.map((module, index) => {
            const toneStyle = TONE_CLASSES[module.tone];

            return (
              <FadeIn
                className="h-full"
                delaySeconds={index * 0.04}
                key={module.href}
              >
                <TiltCard maxTilt={6}>
                  <SpotlightCard className="h-full rounded-3xl">
                    <Link
                      href={module.href}
                      className={`group flex h-full flex-col justify-between rounded-3xl border bg-slate-900/80 p-6 shadow-xl backdrop-blur-md transition-all duration-200 hover:-translate-y-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300 ${toneStyle.borderHover} ${
                        module.featured
                          ? "ring-1 ring-sky-400/20 md:col-span-2 lg:col-span-1"
                          : ""
                      }`}
                    >
                      <div>
                        <div className="flex items-center justify-between">
                          <span
                            className={`grid size-12 place-items-center rounded-2xl border transition-colors duration-200 ${toneStyle.iconBadge}`}
                          >
                            <Icon name={module.icon} className="size-6" />
                          </span>
                          {module.featured ? (
                            <span className="rounded-full border border-sky-400/30 bg-sky-400/10 px-2.5 py-0.5 text-[10px] font-black uppercase tracking-wider text-sky-200">
                              Modul Utama
                            </span>
                          ) : null}
                        </div>

                        <h3 className="mt-5 text-lg font-black tracking-tight text-white group-hover:text-sky-200">
                          {module.title}
                        </h3>
                        <p className="mt-2 text-xs leading-6 text-slate-400 group-hover:text-slate-300">
                          {module.description}
                        </p>
                      </div>

                      <div className="mt-6 flex items-center justify-between border-t border-white/5 pt-4">
                        <span
                          className={`inline-flex items-center gap-1 text-xs font-bold transition ${toneStyle.label}`}
                        >
                          {module.label}
                          <Icon
                            name="chevron-right"
                            className="size-3.5 transition group-hover:translate-x-1"
                          />
                        </span>
                        <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500">
                          SPPG Module
                        </span>
                      </div>
                    </Link>
                  </SpotlightCard>
                </TiltCard>
              </FadeIn>
            );
          })}
        </div>
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
      </footer>
    </AppShell>
  );
}
