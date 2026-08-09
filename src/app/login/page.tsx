"use client";

import { redirect, useRouter } from "next/navigation";
import type React from "react";
import { useState } from "react";
import { useAuth } from "@/lib/context/AuthContext";
import { useHydrated } from "@/lib/hooks/useHydrated";
import { useOnlineStatus } from "@/lib/hooks/useOnlineStatus";

export default function LoginPage() {
  const isHydrated = useHydrated();
  const isOnline = useOnlineStatus();
  const { user, login, isAuthenticated, isLoading: authLoading } = useAuth();
  const router = useRouter();

  const [username, setUsername] = useState<string>("");
  const [password, setPassword] = useState<string>("");
  const [showPassword, setShowPassword] = useState<boolean>(false);
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !password.trim()) {
      setErrorMsg("Mohon isi Username / Kode Operator dan Password.");
      return;
    }

    setErrorMsg(null);
    setIsSubmitting(true);

    try {
      const res = await login(username.trim(), password.trim());
      if (res.sukses) {
        router.push("/");
      } else {
        setErrorMsg(res.pesan);
      }
    } catch (err: unknown) {
      const msg =
        err instanceof Error
          ? err.message
          : "Gagal melakukan verifikasi login.";
      setErrorMsg(msg);
    } finally {
      setIsSubmitting(false);
    }
  };

  const fillDemoAdmin = () => {
    setUsername("admin");
    setPassword("admin123");
    setErrorMsg(null);
  };

  if (!isHydrated || authLoading) {
    return (
      <div className="min-h-screen bg-slate-950 flex flex-col items-center justify-center p-6 text-slate-100 font-sans">
        <div className="flex flex-col items-center gap-3">
          <div className="w-10 h-10 border-4 border-emerald-500 border-t-transparent rounded-full animate-spin"></div>
          <p className="text-xs text-slate-400 font-mono animate-pulse">
            Memuat Sistem Otentikasi...
          </p>
        </div>
      </div>
    );
  }

  if (isAuthenticated && user) redirect("/");

  return (
    <main className="min-h-screen bg-slate-950 text-slate-100 flex flex-col items-center justify-center p-4 sm:p-6 md:p-8 font-sans relative overflow-hidden select-none">
      {/* Background Decorative Glow */}
      <div className="absolute -top-40 -left-40 w-96 h-96 bg-emerald-600/15 rounded-full blur-3xl pointer-events-none"></div>
      <div className="absolute -bottom-40 -right-40 w-96 h-96 bg-sky-600/15 rounded-full blur-3xl pointer-events-none"></div>

      {/* Main Glass Card Container */}
      <div className="w-full max-w-md bg-slate-900/80 border border-slate-800 backdrop-blur-2xl rounded-3xl p-6 sm:p-8 shadow-2xl space-y-6 relative z-10">
        {/* Header Branding */}
        <div className="text-center space-y-2">
          <div className="inline-flex items-center gap-2 px-3 py-1 bg-slate-800/80 border border-slate-700/80 rounded-full text-xs font-mono">
            <span
              className={`w-2 h-2 rounded-full ${
                isOnline ? "bg-emerald-400 animate-pulse" : "bg-amber-400"
              }`}
            ></span>
            <span className="text-slate-300">
              {isOnline
                ? "Mode Online (Turso Cloud)"
                : "Mode Offline (SQLite Local)"}
            </span>
          </div>

          <div className="pt-2">
            <div className="w-12 h-12 bg-gradient-to-tr from-emerald-600 to-sky-500 rounded-2xl mx-auto flex items-center justify-center shadow-lg shadow-emerald-950/60 font-bold text-white text-xl">
              🔑
            </div>
            <h1 className="text-xl sm:text-2xl font-extrabold text-white tracking-tight mt-3">
              Absensi SPPG
            </h1>
            <p className="text-xs text-slate-400">
              Masuk ke Sistem Absensi & Manajemen Operator
            </p>
          </div>
        </div>

        {/* Error Alert Message */}
        {errorMsg && (
          <div className="p-3.5 bg-rose-950/60 border border-rose-800/80 rounded-2xl text-rose-300 text-xs flex items-start gap-2.5 animate-fadeIn">
            <span className="text-base leading-none">⚠️</span>
            <div className="flex-1 font-medium">{errorMsg}</div>
          </div>
        )}

        {/* Login Form */}
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <label
              htmlFor="username-input"
              className="text-xs font-semibold text-slate-300 uppercase tracking-wider block"
            >
              Username / Kode Operator
            </label>
            <div className="relative">
              <input
                id="username-input"
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="Masukkan username (contoh: admin / OP001)"
                autoComplete="username"
                className="w-full bg-slate-950/90 border border-slate-800 focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/20 text-white px-4 py-3 rounded-xl text-xs sm:text-sm font-mono transition outline-none"
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <label
              htmlFor="password-input"
              className="text-xs font-semibold text-slate-300 uppercase tracking-wider block"
            >
              Kata Sandi / PIN
            </label>
            <div className="relative">
              <input
                id="password-input"
                type={showPassword ? "text" : "password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Masukkan kata sandi..."
                autoComplete="current-password"
                className="w-full bg-slate-950/90 border border-slate-800 focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/20 text-white px-4 py-3 pr-12 rounded-xl text-xs sm:text-sm font-mono transition outline-none"
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-200 text-xs px-2 py-1 rounded transition"
              >
                {showPassword ? "🙈 Sembunyi" : "👁️ Lihat"}
              </button>
            </div>
          </div>

          <button
            type="submit"
            disabled={isSubmitting}
            className="w-full py-3.5 px-4 bg-gradient-to-r from-emerald-600 to-emerald-500 hover:from-emerald-500 hover:to-emerald-400 active:scale-[0.99] text-white font-bold text-sm rounded-xl transition shadow-lg shadow-emerald-950/50 flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isSubmitting ? (
              <>
                <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
                <span>Memverifikasi Login...</span>
              </>
            ) : (
              <span>Masuk Aplikasi →</span>
            )}
          </button>
        </form>

        {/* Quick Demo Login Helper */}
        <div className="pt-4 border-t border-slate-800/80 text-center space-y-2">
          <p className="text-[11px] text-slate-500">
            Gunakan kredensial berikut untuk uji coba pertama:
          </p>
          <button
            type="button"
            onClick={fillDemoAdmin}
            className="w-full py-2 px-3 bg-slate-800/80 hover:bg-slate-800 border border-slate-700 text-slate-300 rounded-xl text-xs font-mono transition flex items-center justify-center gap-1.5"
          >
            <span>⚡ Quick Demo:</span>
            <span className="text-emerald-400 font-bold">admin</span> /{" "}
            <span className="text-emerald-400 font-bold">admin123</span>
          </button>
        </div>

        {/* Footer info */}
        <div className="text-center text-[10px] text-slate-600 font-mono">
          Absensi SPPG v0.1.0 • Next.js 16 + Tauri v2
        </div>
      </div>
    </main>
  );
}
