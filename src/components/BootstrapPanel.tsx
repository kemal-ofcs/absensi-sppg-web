"use client";

import { type FormEvent, useState } from "react";
import {
  type BootstrapStatus,
  bootstrapSuperadmin,
} from "@/lib/gateways/bootstrap";

type BootstrapPanelProps = {
  status: BootstrapStatus;
  onCompleted: () => void;
};

export function BootstrapPanel({ status, onCompleted }: BootstrapPanelProps) {
  const [databaseUrl, setDatabaseUrl] = useState("");
  const [authToken, setAuthToken] = useState("");
  const [name, setName] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [feedback, setFeedback] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (password !== confirmation) {
      setFeedback("Konfirmasi password tidak sama.");
      return;
    }
    setSubmitting(true);
    setFeedback("");
    try {
      await bootstrapSuperadmin({
        kodeOperator: "SPD001",
        namaOperator: name,
        username,
        password,
        databaseUrl: status.configured ? undefined : databaseUrl,
        authToken: status.configured ? undefined : authToken,
      });
      setPassword("");
      setConfirmation("");
      setAuthToken("");
      onCompleted();
    } catch (error: unknown) {
      setFeedback(
        error instanceof Error
          ? error.message
          : "Bootstrap Superadmin tidak dapat diproses.",
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="grid min-h-dvh place-items-center bg-slate-950 p-4 text-slate-100 sm:p-6">
      <section className="w-full max-w-lg rounded-3xl border border-sky-400/20 bg-slate-900/95 p-6 shadow-2xl sm:p-8">
        <p className="text-xs font-black uppercase tracking-[0.18em] text-sky-300">
          Provisioning satu kali
        </p>
        <h1 className="mt-2 text-2xl font-black text-white">
          Buat Superadmin pertama
        </h1>
        <p className="mt-2 text-sm leading-6 text-slate-400">
          Tidak ada akun bawaan. Form ini otomatis ditutup permanen setelah
          Superadmin aktif berhasil dibuat.
        </p>
        {status.configured ? (
          <p className="mt-3 truncate rounded-xl border border-white/10 bg-slate-950/70 px-3 py-2 font-mono text-xs text-sky-200">
            {status.serverOrigin}
          </p>
        ) : null}
        {feedback ? (
          <div className="mt-4 rounded-xl border border-rose-500/30 bg-rose-950/50 p-3 text-xs text-rose-200">
            {feedback}
          </div>
        ) : null}
        <form onSubmit={submit} className="mt-5 grid gap-4">
          {!status.configured ? (
            <>
              <label className="grid gap-1.5 text-xs font-bold text-slate-300">
                URL database Turso
                <input
                  type="url"
                  required
                  value={databaseUrl}
                  onChange={(event) => setDatabaseUrl(event.target.value)}
                  placeholder="libsql://database-anda.turso.io"
                  className="min-h-11 rounded-xl border border-white/15 bg-slate-950 px-3 font-mono text-xs text-white"
                />
              </label>
              <label className="grid gap-1.5 text-xs font-bold text-slate-300">
                Auth Token Turso
                <input
                  type="password"
                  required
                  value={authToken}
                  onChange={(event) => setAuthToken(event.target.value)}
                  autoComplete="off"
                  className="min-h-11 rounded-xl border border-white/15 bg-slate-950 px-3 font-mono text-xs text-white"
                />
              </label>
            </>
          ) : null}
          <div className="grid gap-4 sm:grid-cols-[7rem_1fr]">
            <label className="grid gap-1.5 text-xs font-bold text-slate-300">
              Kode
              <input
                value="SPD001"
                readOnly
                className="min-h-11 rounded-xl border border-white/10 bg-slate-800 px-3 font-mono text-xs text-slate-300"
              />
            </label>
            <label className="grid min-w-0 gap-1.5 text-xs font-bold text-slate-300">
              Nama lengkap
              <input
                required
                minLength={3}
                maxLength={120}
                value={name}
                onChange={(event) => setName(event.target.value)}
                autoComplete="name"
                className="min-h-11 min-w-0 rounded-xl border border-white/15 bg-slate-950 px-3 text-sm text-white"
              />
            </label>
          </div>
          <label className="grid gap-1.5 text-xs font-bold text-slate-300">
            Username
            <input
              required
              minLength={3}
              maxLength={64}
              pattern="[A-Za-z0-9._-]+"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              autoComplete="username"
              className="min-h-11 rounded-xl border border-white/15 bg-slate-950 px-3 text-sm text-white"
            />
          </label>
          <label className="grid gap-1.5 text-xs font-bold text-slate-300">
            Password kuat
            <input
              required
              minLength={12}
              maxLength={128}
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="new-password"
              className="min-h-11 rounded-xl border border-white/15 bg-slate-950 px-3 text-sm text-white"
            />
            <span className="font-normal leading-5 text-slate-500">
              Minimal 12 karakter: huruf besar, kecil, angka, simbol, dan tidak
              memuat username.
            </span>
          </label>
          <label className="grid gap-1.5 text-xs font-bold text-slate-300">
            Ulangi password
            <input
              required
              minLength={12}
              maxLength={128}
              type="password"
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              autoComplete="new-password"
              className="min-h-11 rounded-xl border border-white/15 bg-slate-950 px-3 text-sm text-white"
            />
          </label>
          <button
            type="submit"
            disabled={submitting}
            className="min-h-12 rounded-2xl bg-sky-400 px-4 text-sm font-black text-slate-950 disabled:opacity-50"
          >
            {submitting ? "Mengamankan database..." : "Aktifkan Superadmin"}
          </button>
        </form>
      </section>
    </main>
  );
}
