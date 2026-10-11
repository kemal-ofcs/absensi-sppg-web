"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import type { FormEvent } from "react";
import { Suspense, useCallback, useEffect, useState } from "react";
import { validatePasswordStrength } from "@/lib/auth/password";
import { BRANDING } from "@/lib/constants/branding";
import {
  completePasswordReset,
  inspectResetToken,
  type ResetTokenPreview,
} from "@/lib/gateways/password-reset";
import { useHydrated } from "@/lib/hooks/useHydrated";

/**
 * Halaman pembuatan password baru.
 *
 * Token dibaca dari query string (`?token=`) ketika pengguna mengklik tautan
 * email, dan bisa ditempel manual pada pemasangan Desktop yang emailnya hanya
 * memuat kode — di sana tidak ada URL aplikasi Web untuk dituju.
 */
export default function ResetPasswordPage() {
  return (
    <Suspense fallback={<PageShell>Memuat...</PageShell>}>
      <ResetPasswordForm />
    </Suspense>
  );
}

function ResetPasswordForm() {
  const isHydrated = useHydrated();
  const router = useRouter();
  const searchParams = useSearchParams();

  const [token, setToken] = useState("");
  const [preview, setPreview] = useState<ResetTokenPreview | null>(null);
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  const verifyToken = useCallback(async (value: string) => {
    const clean = value.trim();
    if (!clean) return;
    setBusy(true);
    setError(null);
    try {
      setPreview(await inspectResetToken(clean));
      setNotice(null);
    } catch (cause) {
      setPreview(null);
      setError(
        cause instanceof Error ? cause.message : "Token tidak dapat diperiksa.",
      );
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    const fromLink = searchParams.get("token")?.trim();
    if (!fromLink) return;
    setToken(fromLink);
    void verifyToken(fromLink);
  }, [searchParams, verifyToken]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    if (password !== confirmation) {
      setError("Konfirmasi password tidak sama.");
      return;
    }
    const strength = validatePasswordStrength(password);
    if (strength) {
      setError(strength);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await completePasswordReset(token.trim(), password);
      setDone(true);
      setPassword("");
      setConfirmation("");
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Password baru tidak dapat disimpan.",
      );
    } finally {
      setBusy(false);
    }
  };

  if (!isHydrated) return <PageShell>Memuat...</PageShell>;

  if (done) {
    return (
      <PageShell>
        <div className="space-y-4 text-center">
          <h1 className="text-2xl font-black text-white">Password diganti</h1>
          <p className="text-sm text-slate-300">
            Password lama sudah digantikan yang baru. Seluruh sesi lama pada
            akun ini juga telah dikeluarkan demi keamanan.
          </p>
          <button
            type="button"
            onClick={() => router.replace("/login")}
            className="min-h-12 w-full rounded-2xl bg-emerald-500 text-sm font-black text-slate-950"
          >
            Login dengan password baru
          </button>
        </div>
      </PageShell>
    );
  }

  return (
    <PageShell>
      <header className="space-y-1">
        <p className="text-xs font-black uppercase tracking-[0.2em] text-emerald-400">
          {BRANDING.appDisplayName}
        </p>
        <h1 className="text-2xl font-black text-white">Buat Password Baru</h1>
      </header>

      {error ? (
        <p className="rounded-xl border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-200">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p className="rounded-xl border border-sky-500/30 bg-sky-500/10 p-3 text-sm text-sky-200">
          {notice}
        </p>
      ) : null}

      <div className="space-y-2">
        <label className="grid gap-1.5 text-xs font-bold text-slate-300">
          Kode / token reset
          <input
            required
            value={token}
            onChange={(event) => {
              setToken(event.target.value);
              setPreview(null);
            }}
            placeholder="Tempel kode dari email"
            className="min-h-11 rounded-xl border border-white/15 bg-slate-950 px-3 font-mono text-xs text-white"
          />
        </label>
        {!preview ? (
          <button
            type="button"
            disabled={busy || token.trim().length === 0}
            onClick={() => void verifyToken(token)}
            className="min-h-11 w-full rounded-xl border border-white/15 text-sm font-bold text-slate-300 disabled:opacity-50"
          >
            {busy ? "Memeriksa kode..." : "Periksa kode"}
          </button>
        ) : null}
      </div>

      {preview ? (
        <form className="space-y-4" onSubmit={submit}>
          <div className="space-y-1 rounded-2xl border border-white/10 bg-slate-950/60 p-4 text-sm">
            <p className="text-base font-black text-white">
              {preview.operatorName}
            </p>
            <p className="text-slate-400">@{preview.username}</p>
            <p className="text-slate-400">{preview.maskedEmail}</p>
          </div>
          <label className="grid gap-1.5 text-xs font-bold text-slate-300">
            Password baru
            <input
              required
              type="password"
              minLength={12}
              maxLength={128}
              autoComplete="new-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className="min-h-11 rounded-xl border border-white/15 bg-slate-950 px-3 text-sm text-white"
            />
            <span className="font-normal leading-5 text-slate-500">
              Minimal 12 karakter dengan huruf besar, huruf kecil, dan angka.
            </span>
          </label>
          <label className="grid gap-1.5 text-xs font-bold text-slate-300">
            Ulangi password baru
            <input
              required
              type="password"
              minLength={12}
              maxLength={128}
              autoComplete="new-password"
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              className="min-h-11 rounded-xl border border-white/15 bg-slate-950 px-3 text-sm text-white"
            />
          </label>
          <button
            type="submit"
            disabled={busy}
            className="min-h-12 w-full rounded-2xl bg-emerald-500 text-sm font-black text-slate-950 disabled:opacity-50"
          >
            {busy ? "Menyimpan..." : "Simpan password baru"}
          </button>
        </form>
      ) : null}

      <footer className="border-t border-white/10 pt-4 text-center">
        <Link
          href="/login"
          className="text-xs font-bold text-slate-400 hover:text-emerald-300"
        >
          Kembali ke halaman login
        </Link>
      </footer>
    </PageShell>
  );
}

function PageShell({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-slate-950 p-4 font-sans text-slate-100 sm:p-6">
      <div className="pointer-events-none absolute -top-40 -left-40 h-96 w-96 rounded-full bg-emerald-600/15 blur-3xl" />
      <div className="pointer-events-none absolute -right-40 -bottom-40 h-96 w-96 rounded-full bg-sky-600/15 blur-3xl" />
      <section className="relative z-10 w-full max-w-lg space-y-5 rounded-3xl border border-white/10 bg-slate-900/70 p-6 shadow-2xl backdrop-blur sm:p-8">
        {children}
      </section>
    </main>
  );
}
