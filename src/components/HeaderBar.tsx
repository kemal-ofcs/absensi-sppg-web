"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { BrandLogo } from "@/components/ui/BrandLogo";
import { Icon, type IconName } from "@/components/ui/Icon";
import { type AppArea, canAccessArea } from "@/lib/auth/access";
import { useAuth } from "@/lib/context/AuthContext";
import { useOnlineStatus } from "@/lib/hooks/useOnlineStatus";

interface NavigationItem {
  area: AppArea;
  href: string;
  icon: IconName;
  label: string;
}

const NAVIGATION: NavigationItem[] = [
  { area: "home", href: "/", icon: "home", label: "Home" },
  { area: "scanner", href: "/scanner", icon: "scanner", label: "QR Scanner" },
  {
    area: "dashboard",
    href: "/dashboard",
    icon: "dashboard",
    label: "Dashboard",
  },
  { area: "history", href: "/history", icon: "clock", label: "Riwayat" },
  { area: "karyawan", href: "/karyawan", icon: "user", label: "Karyawan" },
  { area: "idcards", href: "/id-cards", icon: "user", label: "ID Card" },
  { area: "shift", href: "/shift", icon: "clock", label: "Shift" },
  {
    area: "operational",
    href: "/operational",
    icon: "tools",
    label: "Operasional",
  },
  {
    area: "operators",
    href: "/operators",
    icon: "users",
    label: "Operator",
  },
  {
    area: "settings",
    href: "/settings",
    icon: "settings",
    label: "Pengaturan",
  },
];

const PRIMARY_AREAS = new Set<AppArea>([
  "home",
  "scanner",
  "dashboard",
  "history",
]);
const MOBILE_FIXED_AREAS = new Set<AppArea>(["home", "scanner", "dashboard"]);

function routeIsActive(pathname: string, href: string) {
  return href === "/"
    ? pathname === href
    : pathname === href || pathname.startsWith(`${href}/`);
}

function NavigationLink({
  item,
  pathname,
  compact = false,
  onNavigate,
}: {
  item: NavigationItem;
  pathname: string;
  compact?: boolean;
  onNavigate?: () => void;
}) {
  const active = routeIsActive(pathname, item.href);
  return (
    <Link
      href={item.href}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      className={`group flex min-h-11 items-center gap-3 rounded-xl font-bold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300 ${
        compact ? "px-3 text-xs" : "px-4 text-sm"
      } ${
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

export function HeaderBar() {
  const { user, logout } = useAuth();
  const isOnline = useOnlineStatus();
  const pathname = usePathname();
  const [desktopMenuOpen, setDesktopMenuOpen] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  useEffect(() => {
    if (!desktopMenuOpen && !mobileMenuOpen) return;
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setDesktopMenuOpen(false);
        setMobileMenuOpen(false);
      }
    };
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [desktopMenuOpen, mobileMenuOpen]);

  useEffect(() => {
    if (!mobileMenuOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [mobileMenuOpen]);

  if (!user) return null;

  const visibleNavigation = NAVIGATION.filter((item) =>
    canAccessArea(user, item.area),
  );
  const primaryNavigation = visibleNavigation.filter((item) =>
    PRIMARY_AREAS.has(item.area),
  );
  const managementNavigation = visibleNavigation.filter(
    (item) => !PRIMARY_AREAS.has(item.area),
  );
  const activeManagementItem = managementNavigation.find((item) =>
    routeIsActive(pathname, item.href),
  );

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

  return (
    <>
      <header className="sticky top-0 z-50 border-b border-white/10 bg-slate-950/90 px-3 py-2.5 shadow-xl shadow-slate-950/30 backdrop-blur-xl sm:px-5">
        <div className="mx-auto flex w-full max-w-7xl items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-4">
            <Link
              href="/"
              onClick={() => {
                setDesktopMenuOpen(false);
                setMobileMenuOpen(false);
              }}
              className="group flex min-w-0 shrink-0 items-center gap-2.5 rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300"
              aria-label="Buka Home Absensi SPPG"
            >
              <BrandLogo size={38} />
              <span className="min-w-0 leading-tight">
                <span className="block max-w-32 truncate text-sm font-black tracking-tight text-white">
                  Absensi SPPG
                </span>
                <span className="flex items-center gap-1.5 text-[10px] font-medium text-slate-400">
                  <span
                    className={`size-1.5 rounded-full ${isOnline ? "bg-emerald-400" : "bg-amber-300"}`}
                  />
                  <span className="sm:hidden">
                    {isOnline ? "Online" : "Offline"}
                  </span>
                  <span className="hidden sm:inline">Desktop & Web</span>
                </span>
              </span>
            </Link>

            <nav
              aria-label="Navigasi utama"
              className="hidden items-center gap-1 rounded-2xl border border-white/10 bg-white/[0.04] p-1 lg:flex"
            >
              {primaryNavigation.map((item) => (
                <NavigationLink
                  key={item.href}
                  item={item}
                  pathname={pathname}
                  compact
                  onNavigate={() => setDesktopMenuOpen(false)}
                />
              ))}

              {managementNavigation.length > 0 ? (
                <div className="relative">
                  <button
                    type="button"
                    aria-expanded={desktopMenuOpen}
                    aria-controls="desktop-management-menu"
                    onClick={() => setDesktopMenuOpen((open) => !open)}
                    className={`flex min-h-11 items-center gap-2 rounded-xl px-3 text-xs font-bold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300 ${
                      activeManagementItem
                        ? "bg-sky-400 text-slate-950"
                        : "text-slate-300 hover:bg-white/[0.07] hover:text-white"
                    }`}
                  >
                    <Icon
                      name={activeManagementItem?.icon ?? "tools"}
                      className="size-4"
                    />
                    <span className="max-w-24 truncate">
                      {activeManagementItem?.label ?? "Kelola"}
                    </span>
                    <span
                      aria-hidden="true"
                      className={`text-[10px] transition ${desktopMenuOpen ? "rotate-180" : ""}`}
                    >
                      ▼
                    </span>
                  </button>

                  {desktopMenuOpen ? (
                    <div
                      id="desktop-management-menu"
                      className="absolute left-0 top-[calc(100%+0.65rem)] z-50 w-64 rounded-2xl border border-white/10 bg-slate-900/98 p-2 shadow-2xl shadow-slate-950/70 backdrop-blur-xl"
                    >
                      <p className="px-3 pb-2 pt-1 text-[10px] font-bold uppercase tracking-[0.18em] text-slate-500">
                        Manajemen aplikasi
                      </p>
                      {managementNavigation.map((item) => (
                        <NavigationLink
                          key={item.href}
                          item={item}
                          pathname={pathname}
                          onNavigate={() => setDesktopMenuOpen(false)}
                        />
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </nav>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            <span
              className={`hidden min-h-8 items-center gap-2 rounded-full border px-3 text-[11px] font-bold 2xl:inline-flex ${
                isOnline
                  ? "border-emerald-400/25 bg-emerald-400/10 text-emerald-200"
                  : "border-amber-300/25 bg-amber-300/10 text-amber-200"
              }`}
            >
              <Icon
                name={isOnline ? "wifi" : "wifi-off"}
                className="size-3.5"
              />
              {isOnline ? "Jaringan tersedia" : "Menunggu jaringan"}
            </span>

            <div className="hidden min-w-0 items-center gap-2 rounded-xl border border-white/10 bg-white/[0.04] px-3 py-1.5 xl:flex">
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
              className="grid size-10 place-items-center rounded-xl border border-rose-400/20 bg-rose-400/10 text-rose-200 transition hover:bg-rose-400/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-300 sm:size-11"
            >
              <Icon name="logout" className="size-4" />
            </button>
          </div>
        </div>
      </header>

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
              <button
                type="button"
                onClick={() => setMobileMenuOpen(false)}
                className="grid size-10 place-items-center rounded-xl bg-white/[0.06] text-xl text-slate-300"
                aria-label="Tutup semua menu"
              >
                ×
              </button>
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
