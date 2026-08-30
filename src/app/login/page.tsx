"use client";

import Link from "next/link";
import { redirect, useRouter } from "next/navigation";
import type React from "react";
import { useCallback, useEffect, useState } from "react";
import { BootstrapPanel } from "@/components/BootstrapPanel";
import { LoginSceneGate } from "@/components/visual/LoginSceneGate";
import { VisualProvider } from "@/components/visual/VisualProvider";
import { useAuth } from "@/lib/context/AuthContext";
import {
  type BootstrapStatus,
  getBootstrapStatus,
} from "@/lib/gateways/bootstrap";
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
  // Kolom kode baru muncul setelah server menyatakan password sudah benar dan
  // tinggal kode 2FA-nya. Menampilkannya lebih awal akan membocorkan akun mana
  // yang memakai verifikasi dua langkah.
  const [totpCode, setTotpCode] = useState<string>("");
  const [needsTotp, setNeedsTotp] = useState<boolean>(false);
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [bootstrapStatus, setBootstrapStatus] =
    useState<BootstrapStatus | null>(null);
  // Dibuka manual ketika kredensial database tersimpan tetapi database cloud-nya
  // tidak menjawab — misalnya database Turso lama sudah dihapus. Tanpa pintu
  // ini, layar provisioning tidak pernah muncul lagi dan tidak ada tempat untuk
  // memasukkan URL database baru.
  const [showDatabaseSetup, setShowDatabaseSetup] = useState(false);

  const refreshBootstrapStatus = useCallback(() => {
    void getBootstrapStatus()
      .then((status) => {
        setBootstrapStatus(status);
        if (status?.reachable) setShowDatabaseSetup(false);
      })
      .catch(() => setBootstrapStatus(null));
  }, []);

  useEffect(() => {
    refreshBootstrapStatus();
  }, [refreshBootstrapStatus]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !password) {
      setErrorMsg("Mohon isi Username / Kode Operator dan Password.");
      return;
    }

    setErrorMsg(null);
    setIsSubmitting(true);

    try {
      const res = await login(
        username.trim(),
        password,
        needsTotp ? totpCode : undefined,
      );
      if (res.sukses) {
        router.replace("/");
      } else {
        if (res.requiresTotp) setNeedsTotp(true);
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
  if (bootstrapStatus?.required) {
    return (
      <BootstrapPanel
        status={bootstrapStatus}
        onCompleted={refreshBootstrapStatus}
      />
    );
  }
  if (bootstrapStatus && showDatabaseSetup) {
    return (
      <BootstrapPanel
        status={bootstrapStatus}
        onCompleted={refreshBootstrapStatus}
        onCancel={() => setShowDatabaseSetup(false)}
      />
    );
  }

  return (
    <main className="min-h-screen bg-slate-950 text-slate-100 flex flex-col items-center justify-center p-4 sm:p-6 md:p-8 font-sans relative overflow-hidden select-none">
      {/* Background Decorative Glow */}
      <div className="absolute -top-40 -left-40 w-96 h-96 bg-emerald-600/15 rounded-full blur-3xl pointer-events-none"></div>
      <div className="absolute -bottom-40 -right-40 w-96 h-96 bg-sky-600/15 rounded-full blur-3xl pointer-events-none"></div>

      {/* Konstelasi 3D: hanya dimuat bila perangkat sanggup, dan tidak pernah
          menghalangi form login karena berada di lapisan paling belakang. */}
      <VisualProvider />
      <LoginSceneGate className="pointer-events-none absolute inset-0 z-0 opacity-80" />

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
              {isOnline ? "Jaringan tersedia" : "Tidak ada jaringan"}
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

        {/* Database cloud tersimpan tetapi tidak menjawab: tawarkan konfigurasi
            ulang, jangan biarkan pengguna menebak-nebak di form login. */}
        {bootstrapStatus?.configured && !bootstrapStatus.reachable ? (
          <div className="p-3.5 bg-amber-950/50 border border-amber-700/60 rounded-2xl text-amber-100 text-xs space-y-1.5">
            <p className="font-bold text-amber-300">
              Database cloud tidak dapat dihubungi
            </p>
            <p className="text-amber-200/90">
              {bootstrapStatus.message ??
                "Aplikasi ini masih menunjuk database lama."}
            </p>
            <p className="text-amber-200/70">
              Kalau jaringan aktif dan database sudah diganti atau dihapus,
              arahkan aplikasi ke database yang baru. Login offline tetap bisa
              dipakai bila perangkat ini pernah login online sebelumnya.
            </p>
            <button
              type="button"
              onClick={() => setShowDatabaseSetup(true)}
              className="mt-1 w-full min-h-10 rounded-xl border border-amber-600/50 bg-amber-500/10 px-3 text-xs font-bold text-amber-200 hover:bg-amber-500/20 transition"
            >
              Konfigurasi ulang database
            </button>
          </div>
        ) : null}

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
                placeholder="Masukkan username atau kode operator"
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

          {needsTotp ? (
            <div className="space-y-1.5">
              <label
                htmlFor="totp-input"
                className="text-xs font-semibold text-slate-300 uppercase tracking-wider block"
              >
                Kode Verifikasi 2FA
              </label>
              <input
                id="totp-input"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={16}
                value={totpCode}
                onChange={(e) => setTotpCode(e.target.value)}
                placeholder="123456 atau kode cadangan"
                className="w-full bg-slate-950/90 border border-slate-800 focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/20 text-white px-4 py-3 rounded-xl text-sm font-mono tracking-[0.3em] transition outline-none"
              />
              <p className="text-[11px] text-slate-500">
                Buka aplikasi autentikator Anda, atau masukkan salah satu kode
                cadangan.
              </p>
            </div>
          ) : null}

          <div className="text-center">
            <Link
              href="/lupa-password"
              className="text-xs font-semibold text-slate-400 transition hover:text-emerald-300"
            >
              Lupa Password?
            </Link>
          </div>
        </form>

        {/* Footer info */}
        <div className="text-center text-[10px] text-slate-600 font-mono">
          Absensi SPPG v0.1.0 • Next.js 16 + Tauri v2
        </div>
      </div>
    </main>
  );
}
