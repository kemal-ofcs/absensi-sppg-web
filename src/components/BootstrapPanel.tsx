"use client";

import { type FormEvent, useCallback, useEffect, useState } from "react";
import {
  type BootstrapStatus,
  bootstrapSuperadmin,
  checkBootstrapDatabase,
  type DatabaseCheckResult,
  linkBootstrapDatabase,
} from "@/lib/gateways/bootstrap";
import {
  type DatabaseCheckTone,
  summarizeDatabaseCheck,
} from "@/lib/utils/bootstrap-check";

type BootstrapPanelProps = {
  status: BootstrapStatus;
  onCompleted: () => void;
};

const TONE_CARD: Record<DatabaseCheckTone, string> = {
  success: "border-emerald-400/30 bg-emerald-950/40 text-emerald-100",
  warning: "border-amber-400/30 bg-amber-950/40 text-amber-100",
  danger: "border-rose-500/30 bg-rose-950/50 text-rose-100",
};

const TONE_BADGE: Record<DatabaseCheckTone, string> = {
  success: "bg-emerald-400 text-emerald-950",
  warning: "bg-amber-400 text-amber-950",
  danger: "bg-rose-400 text-rose-950",
};

const TONE_LABEL: Record<DatabaseCheckTone, string> = {
  success: "Aman",
  warning: "Perhatian",
  danger: "Bahaya",
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
  const [checking, setChecking] = useState(false);
  const [linking, setLinking] = useState(false);
  const [check, setCheck] = useState<DatabaseCheckResult | null>(null);
  const [editingDatabase, setEditingDatabase] = useState(false);
  const [forceProceed, setForceProceed] = useState(false);

  const needsCredentials = !status.configured || editingDatabase;
  const summary = check ? summarizeDatabaseCheck(check) : null;
  const provisioningUnlocked = Boolean(
    summary?.canCreateSuperadmin &&
      (!summary.requiresConfirmation || forceProceed),
  );

  const resetCheck = useCallback(() => {
    setCheck(null);
    setForceProceed(false);
  }, []);

  const runCheck = useCallback(
    async (credentials: { databaseUrl?: string; authToken?: string }) => {
      setChecking(true);
      setFeedback("");
      try {
        setCheck(await checkBootstrapDatabase(credentials));
        setForceProceed(false);
      } catch (error: unknown) {
        setCheck(null);
        setFeedback(
          error instanceof Error
            ? error.message
            : "Pemeriksaan database tidak dapat diproses.",
        );
      } finally {
        setChecking(false);
      }
    },
    [],
  );

  // Kredensial sudah tersimpan di vault: periksa otomatis tanpa input ulang.
  useEffect(() => {
    if (status.configured && !editingDatabase) {
      void runCheck({});
    }
  }, [status.configured, editingDatabase, runCheck]);

  const handleCheck = () => {
    void runCheck(needsCredentials ? { databaseUrl, authToken } : {});
  };

  const handleUseExisting = async () => {
    setLinking(true);
    setFeedback("");
    try {
      await linkBootstrapDatabase(
        needsCredentials ? { databaseUrl, authToken } : {},
      );
      onCompleted();
    } catch (error: unknown) {
      setFeedback(
        error instanceof Error
          ? error.message
          : "Database tidak dapat digunakan.",
      );
    } finally {
      setLinking(false);
    }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!provisioningUnlocked) {
      setFeedback(
        "Periksa database terlebih dahulu sebelum membuat Superadmin.",
      );
      return;
    }
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
        databaseUrl: needsCredentials ? databaseUrl : undefined,
        authToken: needsCredentials ? authToken : undefined,
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
          Cek database, lalu buat Superadmin
        </h1>
        <p className="mt-2 text-sm leading-6 text-slate-400">
          Database diperiksa lebih dulu agar salah input URL dapat ditahan, dan
          agar terlihat apakah Superadmin sudah pernah dibuat di sana.
        </p>
        {status.configured ? (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <p className="min-w-0 flex-1 truncate rounded-xl border border-white/10 bg-slate-950/70 px-3 py-2 font-mono text-xs text-sky-200">
              {status.serverOrigin}
            </p>
            <button
              type="button"
              onClick={() => {
                setEditingDatabase((value) => !value);
                resetCheck();
              }}
              className="min-h-9 rounded-xl border border-white/15 px-3 text-xs font-bold text-slate-300 hover:border-sky-400/40 hover:text-sky-200"
            >
              {editingDatabase ? "Batal ganti" : "Ganti database"}
            </button>
          </div>
        ) : null}
        {feedback ? (
          <div className="mt-4 rounded-xl border border-rose-500/30 bg-rose-950/50 p-3 text-xs text-rose-200">
            {feedback}
          </div>
        ) : null}

        <div className="mt-5 grid gap-4">
          {needsCredentials ? (
            <>
              <label className="grid gap-1.5 text-xs font-bold text-slate-300">
                URL database Turso
                <input
                  type="url"
                  value={databaseUrl}
                  onChange={(event) => {
                    setDatabaseUrl(event.target.value);
                    resetCheck();
                  }}
                  placeholder="libsql://database-anda.turso.io"
                  className="min-h-11 rounded-xl border border-white/15 bg-slate-950 px-3 font-mono text-xs text-white"
                />
              </label>
              <label className="grid gap-1.5 text-xs font-bold text-slate-300">
                Auth Token Turso
                <input
                  type="password"
                  value={authToken}
                  onChange={(event) => {
                    setAuthToken(event.target.value);
                    resetCheck();
                  }}
                  autoComplete="off"
                  className="min-h-11 rounded-xl border border-white/15 bg-slate-950 px-3 font-mono text-xs text-white"
                />
              </label>
            </>
          ) : null}
          <button
            type="button"
            onClick={handleCheck}
            disabled={
              checking ||
              linking ||
              submitting ||
              (needsCredentials && (!databaseUrl.trim() || !authToken.trim()))
            }
            className="min-h-12 rounded-2xl border border-sky-400/40 bg-sky-400/10 px-4 text-sm font-black text-sky-200 disabled:opacity-50"
          >
            {checking ? "Memeriksa database..." : "Cek database"}
          </button>
        </div>

        {summary ? (
          <div
            className={`mt-4 rounded-2xl border p-4 text-xs ${TONE_CARD[summary.tone]}`}
          >
            <div className="flex items-start gap-2">
              <span
                className={`mt-0.5 shrink-0 rounded-full px-2 py-0.5 text-[10px] font-black uppercase tracking-wider ${TONE_BADGE[summary.tone]}`}
              >
                {TONE_LABEL[summary.tone]}
              </span>
              <p className="font-black leading-5">{summary.title}</p>
            </div>
            <p className="mt-2 leading-5 opacity-90">{summary.detail}</p>
            {summary.facts.length > 0 ? (
              <dl className="mt-3 grid gap-1.5 border-t border-white/10 pt-3 sm:grid-cols-2">
                {summary.facts.map((fact) => (
                  <div
                    key={fact.label}
                    className="flex items-baseline justify-between gap-2 sm:block"
                  >
                    <dt className="text-[10px] font-bold uppercase tracking-wider opacity-70">
                      {fact.label}
                    </dt>
                    <dd className="truncate font-mono text-xs">{fact.value}</dd>
                  </div>
                ))}
              </dl>
            ) : null}
            {summary.canUseExisting ? (
              <button
                type="button"
                onClick={() => void handleUseExisting()}
                disabled={linking}
                className="mt-4 min-h-11 w-full rounded-2xl bg-emerald-400 px-4 text-sm font-black text-emerald-950 disabled:opacity-50"
              >
                {linking
                  ? "Menyimpan konfigurasi..."
                  : "Gunakan database ini & lanjut login"}
              </button>
            ) : null}
            {summary.requiresConfirmation ? (
              <label className="mt-4 flex items-start gap-2 rounded-xl border border-white/15 bg-slate-950/50 p-3 text-[11px] font-bold leading-4">
                <input
                  type="checkbox"
                  checked={forceProceed}
                  onChange={(event) => setForceProceed(event.target.checked)}
                  className="mt-0.5 size-4 accent-rose-400"
                />
                Saya sudah memastikan database ini benar dan tetap ingin
                melanjutkan pembuatan Superadmin.
              </label>
            ) : null}
          </div>
        ) : null}

        {provisioningUnlocked ? (
          <form onSubmit={submit} className="mt-5 grid gap-4">
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
                Minimal 12 karakter: huruf besar, kecil, angka, simbol, dan
                tidak memuat username.
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
        ) : (
          <p className="mt-5 rounded-2xl border border-white/10 bg-slate-950/60 p-4 text-xs leading-5 text-slate-400">
            Form pembuatan Superadmin terbuka setelah database berhasil
            diperiksa dan dinyatakan siap.
          </p>
        )}
      </section>
    </main>
  );
}
