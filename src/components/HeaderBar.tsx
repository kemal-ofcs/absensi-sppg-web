"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAuth } from "@/lib/context/AuthContext";
import { useOnlineStatus } from "@/lib/hooks/useOnlineStatus";

export function HeaderBar() {
  const { user, logout } = useAuth();
  const isOnline = useOnlineStatus();
  const pathname = usePathname();

  if (!user) return null;

  return (
    <header className="bg-slate-900/90 border-b border-slate-800 backdrop-blur-md px-4 sm:px-6 py-3 sticky top-0 z-50 flex flex-wrap items-center justify-between gap-3">
      {/* Brand & Navigation */}
      <div className="flex items-center gap-3 sm:gap-6">
        <Link href="/" className="flex items-center gap-2 group">
          <div className="w-8 h-8 bg-emerald-600 rounded-lg flex items-center justify-center font-bold text-white text-sm shadow-md shadow-emerald-950/80 group-hover:scale-105 transition">
            SPPG
          </div>
          <div>
            <h1 className="text-xs sm:text-sm font-bold text-white leading-tight">
              Absensi SPPG
            </h1>
            <span className="text-[10px] text-slate-400 font-mono hidden sm:inline">
              Production Desktop & Web
            </span>
          </div>
        </Link>

        {/* Quick Nav Links */}
        <nav className="flex items-center gap-1 bg-slate-950/60 p-1 border border-slate-800 rounded-xl text-xs font-semibold">
          <Link
            href="/"
            className={`px-2.5 py-1.5 rounded-lg transition ${
              pathname === "/"
                ? "bg-emerald-600 text-white shadow-sm"
                : "text-slate-400 hover:text-slate-200"
            }`}
          >
            🏠 Utama
          </Link>
          <Link
            href="/scanner"
            className={`px-2.5 py-1.5 rounded-lg transition ${
              pathname === "/scanner"
                ? "bg-emerald-600 text-white shadow-sm"
                : "text-slate-400 hover:text-slate-200"
            }`}
          >
            📟 Scanner
          </Link>
          <Link
            href="/dashboard"
            className={`px-2.5 py-1.5 rounded-lg transition ${
              pathname === "/dashboard"
                ? "bg-emerald-600 text-white shadow-sm"
                : "text-slate-400 hover:text-slate-200"
            }`}
          >
            📊 Dashboard
          </Link>
        </nav>
      </div>

      {/* User Info & Online Status & Logout */}
      <div className="flex items-center gap-2 sm:gap-3">
        {/* Network Status Badge */}
        <div className="hidden md:flex items-center gap-1.5 px-2.5 py-1 bg-slate-950/80 border border-slate-800 rounded-full text-[11px] font-mono">
          <span
            className={`w-2 h-2 rounded-full ${
              isOnline ? "bg-emerald-400 animate-pulse" : "bg-amber-400"
            }`}
          ></span>
          <span className="text-slate-300">
            {isOnline ? "Online" : "Offline Mode"}
          </span>
        </div>

        {/* User Operator Profile Pill */}
        <div className="flex items-center gap-2 bg-slate-950/80 border border-slate-800 px-3 py-1.5 rounded-xl">
          <div className="w-6 h-6 bg-slate-800 border border-slate-700 text-emerald-400 font-bold rounded-full flex items-center justify-center text-xs">
            {user.nama_operator.charAt(0).toUpperCase()}
          </div>
          <div className="text-left leading-tight hidden sm:block">
            <p className="text-xs font-bold text-slate-100">
              {user.nama_operator}
            </p>
            <p className="text-[10px] text-emerald-400 font-mono font-medium">
              {user.role} ({user.kode_operator})
            </p>
          </div>
        </div>

        {/* Logout Button */}
        <button
          type="button"
          onClick={logout}
          className="px-3 py-1.5 bg-rose-950/60 hover:bg-rose-900/80 text-rose-300 border border-rose-800/80 hover:border-rose-700 rounded-xl text-xs font-semibold transition flex items-center gap-1 shadow-sm"
          title="Keluar / Logout"
        >
          <span>🚪</span>
          <span className="hidden sm:inline">Logout</span>
        </button>
      </div>
    </header>
  );
}
