"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { BrandLogo } from "@/components/ui/BrandLogo";
import { Icon, type IconName } from "@/components/ui/Icon";
import { ThemeToggle } from "@/components/ui/ThemeToggle";
import { type AppArea, canAccessArea } from "@/lib/auth/access";
import { BRANDING } from "@/lib/constants/branding";
import { useAuth } from "@/lib/context/AuthContext";
import { useAppName } from "@/lib/hooks/useAppName";
import { useCompanyName } from "@/lib/hooks/useCompanyName";
import { useOnlineStatus } from "@/lib/hooks/useOnlineStatus";

interface NavigationItem {
  area: AppArea;
  href: string;
  icon: IconName;
  label: string;
}

interface NavigationGroup {
  label: string;
  items: NavigationItem[];
}

const NAVIGATION_GROUPS: NavigationGroup[] = [
  {
    label: "Absensi",
    items: [
      { area: "home", href: "/", icon: "home", label: "Home" },
      {
        area: "scanner",
        href: "/scanner",
        icon: "scanner",
        label: "QR Scanner",
      },
      {
        area: "dashboard",
        href: "/dashboard",
        icon: "dashboard",
        label: "Dashboard",
      },
      { area: "history", href: "/history", icon: "clock", label: "Riwayat" },
      {
        area: "audit",
        href: "/audit-absensi",
        icon: "alert",
        label: "Audit Absensi",
      },
      {
        area: "attendance_photo",
        href: "/foto-absensi",
        icon: "eye",
        label: "Foto Absensi",
      },
      {
        area: "face_template",
        href: "/wajah",
        icon: "user",
        label: "Pendaftaran Wajah",
      },
    ],
  },
  {
    label: "SDM",
    items: [
      { area: "karyawan", href: "/karyawan", icon: "user", label: "Karyawan" },
      { area: "idcards", href: "/id-cards", icon: "user", label: "ID Card" },
      { area: "shift", href: "/shift", icon: "clock", label: "Shift" },
      {
        area: "holidays",
        href: "/holidays",
        icon: "calendar",
        label: "Hari Libur",
      },
      {
        area: "payroll",
        href: "/payroll",
        icon: "document",
        label: "Penggajian",
      },
      { area: "kasbon", href: "/kasbon", icon: "users", label: "Kasbon" },
    ],
  },
  {
    label: "Keuangan & Aset",
    items: [
      {
        area: "keuangan",
        href: "/keuangan",
        icon: "document",
        label: "Keuangan",
      },
      {
        area: "inventaris",
        href: "/inventaris",
        icon: "box",
        label: "Inventaris",
      },
      {
        area: "operational",
        href: "/operational",
        icon: "tools",
        label: "Operasional",
      },
    ],
  },
  {
    label: "Sistem",
    items: [
      {
        area: "operators",
        href: "/operators",
        icon: "users",
        label: "Operator",
      },
      {
        area: "password_reset",
        href: "/riwayat-reset-password",
        icon: "lock",
        label: "Riwayat Reset",
      },
      {
        area: "settings",
        href: "/settings",
        icon: "settings",
        label: "Pengaturan",
      },
    ],
  },
];

const MOBILE_FIXED_AREAS = new Set<AppArea>(["home", "scanner", "dashboard"]);

/** Lebar `xl` Tailwind: di atasnya sidebar menempel, di bawahnya melayang. */
const SIDEBAR_PINNED_QUERY = "(min-width: 80rem)";

function routeIsActive(pathname: string, href: string) {
  return href === "/"
    ? pathname === href
    : pathname === href || pathname.startsWith(`${href}/`);
}

function NavigationLink({
  item,
  pathname,
  onNavigate,
}: {
  item: NavigationItem;
  pathname: string;
  onNavigate?: () => void;
}) {
  const active = routeIsActive(pathname, item.href);
  return (
    <Link
      href={item.href}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      className={`group flex min-h-10 items-center gap-2.5 rounded-xl px-3 text-sm font-bold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300 ${
        active
          ? "bg-sky-400 text-slate-950 shadow-lg shadow-sky-950/20"
          : "text-slate-300 hover:bg-white/[0.07] hover:text-white"
      }`}
    >
      <Icon name={item.icon} className="size-4 shrink-0" />
      <span className="truncate">{item.label}</span>
    </Link>
  );
}

export function HeaderBar({
  sidebarPinned,
  onSidebarPinnedChange,
}: {
  sidebarPinned: boolean;
  onSidebarPinnedChange: (pinned: boolean) => void;
}) {
  const { user, logout } = useAuth();
  const isOnline = useOnlineStatus();
  const pathname = usePathname();
  const appName = useAppName();
  const companyName = useCompanyName();
  const [sidebarOverlayOpen, setSidebarOverlayOpen] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  useEffect(() => {
    if (!sidebarOverlayOpen && !mobileMenuOpen) return;
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setSidebarOverlayOpen(false);
        setMobileMenuOpen(false);
      }
    };
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [sidebarOverlayOpen, mobileMenuOpen]);

  useEffect(() => {
    if (!mobileMenuOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [mobileMenuOpen]);

  if (!user) return null;

  const visibleGroups = NAVIGATION_GROUPS.map((group) => ({
    ...group,
    items: group.items.filter((item) => canAccessArea(user, item.area)),
  })).filter((group) => group.items.length > 0);
  const visibleNavigation = visibleGroups.flatMap((group) => group.items);

  const mobileNavigation = visibleNavigation.filter((item) =>
    MOBILE_FIXED_AREAS.has(item.area),
  );
  const contextualMobileItem =
    visibleNavigation.find(
      (item) =>
        !MOBILE_FIXED_AREAS.has(item.area) &&
        routeIsActive(pathname, item.href),
    ) ?? visibleNavigation.find((item) => item.area === "history");
  if (
    contextualMobileItem &&
    !mobileNavigation.some((item) => item.area === contextualMobileItem.area)
  ) {
    mobileNavigation.push(contextualMobileItem);
  }
  const hasMoreMobileItems = visibleNavigation.some(
    (item) => !mobileNavigation.some((direct) => direct.area === item.area),
  );

  const toggleSidebar = () => {
    if (window.matchMedia(SIDEBAR_PINNED_QUERY).matches) {
      onSidebarPinnedChange(!sidebarPinned);
    } else {
      setSidebarOverlayOpen((open) => !open);
    }
  };
  const closeMenus = () => {
    setSidebarOverlayOpen(false);
    setMobileMenuOpen(false);
  };

  return (
    <>
      <header className="sticky top-0 z-50 h-16 border-b border-white/10 bg-slate-950/90 px-3 shadow-xl shadow-slate-950/30 backdrop-blur-xl sm:px-5">
        <div className="flex h-full w-full items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <button
              type="button"
              onClick={toggleSidebar}
              aria-controls="app-sidebar"
              aria-label="Tampilkan atau sembunyikan menu samping"
              title="Menu samping"
              className="hidden size-10 shrink-0 place-items-center rounded-xl text-slate-300 transition hover:bg-white/[0.07] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300 lg:grid"
            >
              <Icon name="menu" className="size-5" />
            </button>
            <Link
              href="/"
              onClick={closeMenus}
              className="group flex min-w-0 shrink-0 items-center gap-2 rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300"
              aria-label={`Buka Home ${BRANDING.appDisplayName}`}
            >
              <BrandLogo size={36} />
              <span className="min-w-0 leading-tight">
                <span className="block max-w-36 truncate text-sm font-black tracking-tight text-white xl:max-w-44">
                  {appName}
                </span>
                <span className="block max-w-28 truncate text-[10px] font-semibold text-sky-300 xl:max-w-36">
                  {companyName}
                </span>
                <span className="flex items-center gap-1.5 text-[10px] font-medium text-slate-400">
                  <span
                    className={`size-1.5 rounded-full ${isOnline ? "bg-emerald-400" : "bg-amber-300"}`}
                  />
                  <span className="truncate">
                    {isOnline ? "Online" : "Offline"}
                  </span>
                </span>
              </span>
            </Link>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            <ThemeToggle variant="compact" />

            <div className="hidden min-w-0 items-center gap-2 rounded-xl border border-white/10 bg-white/[0.04] px-2.5 py-1.5 lg:flex">
              <span className="grid size-7 shrink-0 place-items-center rounded-full bg-gradient-to-br from-amber-300 to-amber-500 text-xs font-black text-slate-950">
                {user.nama_operator.charAt(0).toUpperCase()}
              </span>
              <span className="min-w-0 leading-tight">
                <span className="block max-w-28 truncate text-xs font-bold text-white">
                  {user.nama_operator}
                </span>
                <span className="block text-[10px] font-medium text-sky-300">
                  {user.role}
                </span>
              </span>
            </div>

            <button
              type="button"
              onClick={logout}
              aria-label="Keluar dari aplikasi"
              title="Keluar"
              className="grid size-10 place-items-center rounded-xl border border-rose-400/20 bg-rose-400/10 text-rose-200 transition hover:bg-rose-400/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-300"
            >
              <Icon name="logout" className="size-4" />
            </button>
          </div>
        </div>
      </header>

      {sidebarOverlayOpen ? (
        <button
          type="button"
          aria-label="Tutup menu samping"
          onClick={() => setSidebarOverlayOpen(false)}
          className="fixed inset-0 top-16 z-30 hidden bg-black/40 backdrop-blur-sm lg:block xl:hidden"
        />
      ) : null}

      <aside
        id="app-sidebar"
        className={`fixed bottom-0 left-0 top-16 z-40 hidden w-64 flex-col overflow-y-auto overscroll-contain border-r border-white/10 bg-slate-950/90 px-3 pb-6 pt-2 shadow-xl shadow-slate-950/30 backdrop-blur-xl ${
          sidebarOverlayOpen ? "lg:flex" : ""
        } ${sidebarPinned ? "xl:flex" : "xl:hidden"}`}
      >
        <nav aria-label="Navigasi utama">
          {visibleGroups.map((group) => (
            <div key={group.label} className="pt-3">
              <p className="px-3 pb-1.5 text-[10px] font-bold uppercase tracking-[0.18em] text-slate-500">
                {group.label}
              </p>
              <div className="grid gap-0.5">
                {group.items.map((item) => (
                  <NavigationLink
                    key={item.href}
                    item={item}
                    pathname={pathname}
                    onNavigate={() => setSidebarOverlayOpen(false)}
                  />
                ))}
              </div>
            </div>
          ))}
        </nav>
      </aside>

      {mobileMenuOpen ? (
        <div className="fixed inset-0 z-[60] lg:hidden">
          <button
            type="button"
            aria-label="Tutup menu"
            onClick={() => setMobileMenuOpen(false)}
            className="absolute inset-0 bg-slate-950/75 backdrop-blur-sm"
          />
          <section
            id="mobile-all-menu"
            role="dialog"
            aria-modal="true"
            aria-label="Semua menu aplikasi"
            className="absolute inset-x-3 bottom-[calc(4.75rem+env(safe-area-inset-bottom))] max-h-[min(70dvh,34rem)] overflow-y-auto rounded-3xl border border-white/10 bg-slate-900 p-4 shadow-2xl shadow-black/70 sm:inset-x-6"
          >
            <div className="mb-4 flex items-center justify-between gap-3">
              <div>
                <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-sky-300">
                  Navigasi
                </p>
                <h2 className="text-base font-bold text-white">
                  Semua menu aplikasi
                </h2>
                <p className="mt-0.5 max-w-52 truncate text-xs text-slate-400">
                  {user.nama_operator} · {user.role}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <ThemeToggle variant="segmented" />
                <button
                  type="button"
                  onClick={() => setMobileMenuOpen(false)}
                  className="grid size-10 place-items-center rounded-xl bg-white/[0.06] text-xl text-slate-300"
                  aria-label="Tutup semua menu"
                >
                  &times;
                </button>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {visibleNavigation.map((item) => (
                <NavigationLink
                  key={item.href}
                  item={item}
                  pathname={pathname}
                  onNavigate={() => setMobileMenuOpen(false)}
                />
              ))}
            </div>
          </section>
        </div>
      ) : null}

      <nav
        aria-label="Navigasi mobile"
        className="mobile-safe-bottom fixed inset-x-0 bottom-0 z-[70] border-t border-white/10 bg-slate-950/96 px-2 pt-2 shadow-[0_-14px_40px_rgba(2,8,23,0.55)] backdrop-blur-xl lg:hidden"
      >
        <div className="mx-auto flex w-full max-w-xl items-stretch justify-around gap-1">
          {mobileNavigation.map((item) => {
            const active = routeIsActive(pathname, item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={() => setMobileMenuOpen(false)}
                aria-current={active ? "page" : undefined}
                className={`flex min-h-14 min-w-0 flex-1 flex-col items-center justify-center gap-1 rounded-xl px-1 text-[10px] font-bold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300 ${
                  active
                    ? "bg-sky-400/15 text-sky-200"
                    : "text-slate-400 hover:bg-white/[0.06] hover:text-white"
                }`}
              >
                <Icon name={item.icon} className="size-5" />
                <span className="w-full truncate text-center">
                  {item.label}
                </span>
              </Link>
            );
          })}

          {hasMoreMobileItems ? (
            <button
              type="button"
              aria-expanded={mobileMenuOpen}
              aria-controls="mobile-all-menu"
              onClick={() => setMobileMenuOpen((open) => !open)}
              className={`flex min-h-14 min-w-0 flex-1 flex-col items-center justify-center gap-1 rounded-xl px-1 text-[10px] font-bold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300 ${
                mobileMenuOpen
                  ? "bg-sky-400/15 text-sky-200"
                  : "text-slate-400 hover:bg-white/[0.06] hover:text-white"
              }`}
            >
              <Icon name="tools" className="size-5" />
              <span>Menu</span>
            </button>
          ) : null}
        </div>
      </nav>
    </>
  );
}
