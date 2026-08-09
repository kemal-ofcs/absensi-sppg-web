"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
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
  { area: "karyawan", href: "/karyawan", icon: "user", label: "Karyawan" },
  { area: "shift", href: "/shift", icon: "clock", label: "Shift" },
  {
    area: "operators",
    href: "/operators",
    icon: "users",
    label: "Master Operator",
  },
  {
    area: "settings",
    href: "/settings",
    icon: "settings",
    label: "Settings",
  },
];

export function HeaderBar() {
  const { user, logout } = useAuth();
  const isOnline = useOnlineStatus();
  const pathname = usePathname();

  if (!user) return null;

  const visibleNavigation = NAVIGATION.filter((item) =>
    canAccessArea(user, item.area),
  );

  return (
    <>
      <header className="sticky top-0 z-50 border-b border-white/10 bg-slate-950/85 px-4 py-3 shadow-xl shadow-slate-950/30 backdrop-blur-xl sm:px-6">
        <div className="mx-auto flex w-full max-w-7xl items-center justify-between gap-4">
          <div className="flex min-w-0 items-center gap-5">
            <Link
              href="/"
              className="group flex min-w-0 items-center gap-3 rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300"
              aria-label="Buka Home Absensi SPPG"
            >
              <BrandLogo size={40} />
              <span className="min-w-0">
                <span className="block truncate text-sm font-black tracking-tight text-white">
                  Absensi SPPG
                </span>
                <span className="hidden text-[10px] font-medium text-slate-400 sm:block">
                  Desktop & Web
                </span>
              </span>
            </Link>

            <nav
              aria-label="Navigasi utama"
              className="hidden items-center gap-1 rounded-2xl border border-white/10 bg-white/[0.04] p-1 lg:flex"
            >
              {visibleNavigation.map((item) => {
                const isActive = pathname === item.href;
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    aria-current={isActive ? "page" : undefined}
                    className={`inline-flex min-h-10 items-center gap-2 rounded-xl px-3 text-xs font-bold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300 ${
                      isActive
                        ? "bg-sky-400 text-slate-950 shadow-lg shadow-sky-950/20"
                        : "text-slate-300 hover:bg-white/[0.07] hover:text-white"
                    }`}
                  >
                    <Icon name={item.icon} className="size-4" />
                    {item.label}
                  </Link>
                );
              })}
            </nav>
          </div>

          <div className="flex shrink-0 items-center gap-2 sm:gap-3">
            <span
              className={`hidden min-h-8 items-center gap-2 rounded-full border px-3 text-[11px] font-bold sm:inline-flex ${
                isOnline
                  ? "border-sky-400/25 bg-sky-400/10 text-sky-200"
                  : "border-amber-300/25 bg-amber-300/10 text-amber-200"
              }`}
            >
              <Icon
                name={isOnline ? "wifi" : "wifi-off"}
                className="size-3.5"
              />
              {isOnline ? "Jaringan tersedia" : "Menunggu jaringan"}
            </span>

            <div className="hidden min-w-0 items-center gap-2 rounded-xl border border-white/10 bg-white/[0.04] px-3 py-1.5 md:flex">
              <span className="grid size-7 shrink-0 place-items-center rounded-full bg-gradient-to-br from-amber-300 to-amber-500 text-xs font-black text-slate-950">
                {user.nama_operator.charAt(0).toUpperCase()}
              </span>
              <span className="min-w-0 leading-tight">
                <span className="block max-w-32 truncate text-xs font-bold text-white">
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
              className="grid size-11 place-items-center rounded-xl border border-rose-400/20 bg-rose-400/10 text-rose-200 transition hover:bg-rose-400/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-300"
            >
              <Icon name="logout" className="size-4" />
            </button>
          </div>
        </div>
      </header>

      <nav
        aria-label="Navigasi mobile"
        className="mobile-safe-bottom fixed inset-x-0 bottom-0 z-50 overflow-x-auto border-t border-white/10 bg-slate-950/95 px-2 pt-2 shadow-[0_-14px_40px_rgba(2,8,23,0.55)] backdrop-blur-xl lg:hidden"
      >
        <div className="mx-auto flex min-w-max items-stretch justify-center gap-1">
          {visibleNavigation.map((item) => {
            const isActive = pathname === item.href;
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={isActive ? "page" : undefined}
                className={`flex min-h-14 min-w-[68px] flex-col items-center justify-center gap-1 rounded-xl px-2 text-[10px] font-bold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300 ${
                  isActive
                    ? "bg-sky-400/15 text-sky-200"
                    : "text-slate-400 hover:bg-white/[0.06] hover:text-white"
                }`}
              >
                <Icon name={item.icon} className="size-5" />
                <span className="max-w-full truncate">{item.label}</span>
              </Link>
            );
          })}
        </div>
      </nav>
    </>
  );
}
