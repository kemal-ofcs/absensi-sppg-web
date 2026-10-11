"use client";

import { useCallback, useEffect, useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { StatusBadge } from "@/components/ui/StatusBadge";
import {
  beginTwoFactorSetup,
  confirmTwoFactorSetup,
  disableTwoFactor,
  getTwoFactorStatus,
  type TwoFactorSetup,
  type TwoFactorStatus,
} from "@/lib/gateways/two-factor";

/**
 * Pengaturan verifikasi dua langkah untuk akun yang sedang login.
 *
 * Dipilih menggantikan penyedia identitas pihak ketiga karena TOTP tidak
 * memerlukan jaringan sama sekali — kode dihitung dari rahasia bersama dan
 * waktu, sehingga operator tetap bisa masuk di lokasi tanpa sinyal.
 */
type Mode = "idle" | "setup" | "recovery" | "disable";

export function TwoFactorCard() {
  const [status, setStatus] = useState<TwoFactorStatus | null>(null);
  const [mode, setMode] = useState<Mode>("idle");
  const [setup, setSetup] = useState<TwoFactorSetup | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{
    tone: "success" | "error";
    text: string;
  } | null>(null);

  const refresh = useCallback(async () => {
    try {
      setStatus(await getTwoFactorStatus());
    } catch {
      setStatus(null);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const fail = (error: unknown, fallback: string) =>
    setFeedback({
      tone: "error",
      text: error instanceof Error ? error.message : fallback,
    });

  const startSetup = async () => {
    setBusy(true);
    setFeedback(null);
    try {
      setSetup(await beginTwoFactorSetup());
      setCode("");
      setMode("setup");
    } catch (error) {
      fail(error, "Pendaftaran 2FA tidak dapat dimulai.");
    } finally {
      setBusy(false);
    }
  };

  const confirmSetup = async () => {
    setBusy(true);
    setFeedback(null);
    try {
      const result = await confirmTwoFactorSetup(code);
      setRecoveryCodes(result.recoveryCodes);
      setCode("");
      setMode("recovery");
      await refresh();
    } catch (error) {
      fail(error, "Kode tidak dapat diverifikasi.");
    } finally {
      setBusy(false);
    }
  };

  const turnOff = async () => {
    setBusy(true);
    setFeedback(null);
    try {
      await disableTwoFactor(code);
      setCode("");
      setMode("idle");
      setFeedback({
        tone: "success",
        text: "Verifikasi dua langkah dimatikan.",
      });
      await refresh();
    } catch (error) {
      fail(error, "Verifikasi dua langkah tidak dapat dimatikan.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="app-panel rounded-3xl p-5 sm:p-7">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-4">
          <span className="grid size-11 shrink-0 place-items-center rounded-2xl border border-violet-300/20 bg-violet-300/10 text-violet-200">
            <Icon name="lock" className="size-5" />
          </span>
          <div>
            <h2 className="text-base font-black text-white">
              Verifikasi Dua Langkah (2FA)
            </h2>
            <p className="mt-1 max-w-2xl text-sm leading-6 text-slate-400">
              Kode 6 digit dari aplikasi autentikator, diminta setiap login
              setelah password benar. Kodenya dihitung dari waktu, bukan dari
              jaringan — jadi tetap bekerja di lokasi tanpa sinyal.
            </p>
          </div>
        </div>
        <StatusBadge tone={status?.enabled ? "success" : "warning"}>
          {status === null ? "Memuat" : status.enabled ? "Aktif" : "Nonaktif"}
        </StatusBadge>
      </div>

      {status?.requiredByRole && !status.enabled ? (
        <p className="mt-4 rounded-xl border border-amber-400/30 bg-amber-400/10 p-3 text-sm text-amber-100">
          Role akun Anda mewajibkan verifikasi dua langkah. Aktifkan sekarang —
          tanpa itu Anda tidak akan bisa login lagi setelah keluar.
        </p>
      ) : null}

      {feedback ? (
        <p
          className={`mt-4 rounded-xl border p-3 text-sm ${
            feedback.tone === "success"
              ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-200"
              : "border-rose-500/30 bg-rose-500/10 text-rose-200"
          }`}
        >
          {feedback.text}
        </p>
      ) : null}

      {mode === "idle" ? (
        <div className="mt-5 space-y-3">
          {status?.enabled ? (
            <>
              <p className="text-sm text-slate-400">
                Sisa kode cadangan: {status.recoveryRemaining} dari 8.
              </p>
              <button
                type="button"
                onClick={() => {
                  setCode("");
                  setFeedback(null);
                  setMode("disable");
                }}
                className="min-h-11 rounded-xl border border-rose-400/30 px-4 text-sm font-black text-rose-200"
              >
                Matikan 2FA
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => void startSetup()}
              disabled={busy}
              className="min-h-11 rounded-xl bg-violet-500 px-5 text-sm font-black text-white disabled:opacity-50"
            >
              {busy ? "Menyiapkan..." : "Aktifkan 2FA"}
            </button>
          )}
        </div>
      ) : null}

      {mode === "setup" && setup ? (
        <div className="mt-5 space-y-4">
          <ol className="space-y-2 text-sm leading-6 text-slate-300">
            <li>
              1. Buka Google Authenticator, Authy, atau aplikasi autentikator
              lain.
            </li>
            <li>2. Pilih tambah akun, lalu masukkan kunci di bawah ini.</li>
            <li>3. Ketik kode 6 digit yang muncul untuk membuktikannya.</li>
          </ol>

          {/* Kunci ditampilkan sebagai teks, bukan QR: menggambar QR butuh
              pustaka tambahan, sementara semua aplikasi autentikator menerima
              entri manual. Dikelompokkan empat-empat supaya mudah disalin. */}
          <div className="rounded-2xl border border-white/10 bg-slate-950/60 p-4">
            <p className="text-[11px] font-bold uppercase tracking-wider text-slate-500">
              Kunci akun (entri manual)
            </p>
            <p className="mt-1 break-all font-mono text-lg font-black tracking-widest text-white">
              {(setup.secret.match(/.{1,4}/g) ?? []).join(" ")}
            </p>
          </div>

          <label className="grid gap-1.5 text-xs font-bold text-slate-300">
            Kode 6 digit dari aplikasi autentikator
            <input
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={7}
              value={code}
              onChange={(event) => setCode(event.target.value)}
              placeholder="123456"
              className="app-input font-mono text-lg tracking-[0.4em]"
            />
          </label>

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void confirmSetup()}
              disabled={busy}
              className="min-h-11 rounded-xl bg-violet-500 px-5 text-sm font-black text-white disabled:opacity-50"
            >
              {busy ? "Memeriksa..." : "Aktifkan sekarang"}
            </button>
            <button
              type="button"
              onClick={() => setMode("idle")}
              className="min-h-11 rounded-xl border border-white/15 px-4 text-sm font-bold text-slate-300"
            >
              Batal
            </button>
          </div>
        </div>
      ) : null}

      {mode === "recovery" ? (
        <div className="mt-5 space-y-4">
          <p className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm text-emerald-200">
            2FA aktif. Simpan kode cadangan di bawah ini sekarang juga.
          </p>
          {/* Ditampilkan sekali seumur pendaftaran: yang tersimpan di database
              hanya hash-nya, jadi tidak ada cara menampilkannya lagi nanti. */}
          <div className="grid grid-cols-2 gap-2 rounded-2xl border border-white/10 bg-slate-950/60 p-4 font-mono text-sm text-white sm:grid-cols-4">
            {recoveryCodes.map((item) => (
              <span key={item}>{item}</span>
            ))}
          </div>
          <p className="text-xs leading-5 text-slate-400">
            Setiap kode hanya bisa dipakai satu kali, sebagai pengganti kode
            autentikator bila ponsel Anda hilang. Catat di tempat aman — halaman
            ini tidak akan menampilkannya lagi.
          </p>
          <button
            type="button"
            onClick={() => {
              setRecoveryCodes([]);
              setMode("idle");
            }}
            className="min-h-11 rounded-xl bg-emerald-500 px-5 text-sm font-black text-slate-950"
          >
            Saya sudah menyimpannya
          </button>
        </div>
      ) : null}

      {mode === "disable" ? (
        <div className="mt-5 space-y-4">
          <p className="text-sm leading-6 text-slate-300">
            Masukkan kode dari aplikasi autentikator, atau salah satu kode
            cadangan, untuk mematikan 2FA.
          </p>
          <label className="grid gap-1.5 text-xs font-bold text-slate-300">
            Kode verifikasi
            <input
              autoComplete="one-time-code"
              maxLength={16}
              value={code}
              onChange={(event) => setCode(event.target.value)}
              placeholder="123456 atau ABCD-EFGH"
              className="app-input font-mono"
            />
          </label>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void turnOff()}
              disabled={busy}
              className="min-h-11 rounded-xl bg-rose-500 px-5 text-sm font-black text-white disabled:opacity-50"
            >
              {busy ? "Memproses..." : "Matikan 2FA"}
            </button>
            <button
              type="button"
              onClick={() => setMode("idle")}
              className="min-h-11 rounded-xl border border-white/15 px-4 text-sm font-bold text-slate-300"
            >
              Batal
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
