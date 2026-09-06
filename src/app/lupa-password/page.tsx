"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import type { FormEvent } from "react";
import { useCallback, useState } from "react";
import {
  LivenessCapture,
  type LivenessCaptureResult,
} from "@/components/LivenessCapture";
import { BRANDING } from "@/lib/constants/branding";
import {
  confirmResetAccount,
  lookupResetAccount,
  type ResetAccountPreview,
  type ResetChallenge,
  recoverWithCode,
  swapResetChallenge,
  verifyResetLiveness,
} from "@/lib/gateways/password-reset";
import { useHydrated } from "@/lib/hooks/useHydrated";

/**
 * Alur pemulihan password, lima langkah.
 *
 * `cari` -> `konfirmasi` (apakah ini akun Anda?) -> `ulangi` (ketik ulang
 * identitas) -> `foto` (verifikasi wajah) -> `terkirim`.
 *
 * Langkah "ulangi" sengaja dipertahankan meskipun terasa berulang: identitas
 * tersamar baru saja ditampilkan di layar, jadi mengetik ulang adalah satu-
 * satunya titik di alur ini yang memaksa pemohon menyatakan kembali akun mana
 * yang ia klaim setelah melihat petunjuknya.
 */
type Step =
  | "cari"
  | "konfirmasi"
  | "ulangi"
  | "foto"
  | "terkirim"
  | "kode-pemulihan"
  | "pulih";

export default function LupaPasswordPage() {
  const isHydrated = useHydrated();
  const router = useRouter();

  const [step, setStep] = useState<Step>("cari");
  const [identifier, setIdentifier] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [account, setAccount] = useState<ResetAccountPreview | null>(null);
  const [challenge, setChallenge] = useState<ResetChallenge | null>(null);
  const [deliveryMessage, setDeliveryMessage] = useState("");
  /**
   * Jalur penyerahan token yang dipakai permintaan ini.
   *
   * Pada pemasangan tanpa konfigurasi email — termasuk seluruh Mode Database
   * Lokal — tidak ada email yang dikirim, sehingga layar terakhir tidak boleh
   * menyuruh pengguna membuka kotak masuknya.
   */
  const [deliveryMode, setDeliveryMode] = useState<"email" | "in_app">("email");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [recoveryCode, setRecoveryCode] = useState("");
  const [recoveryPassword, setRecoveryPassword] = useState("");
  const [recoveryConfirm, setRecoveryConfirm] = useState("");
  const [sisaKode, setSisaKode] = useState(0);

  const fail = useCallback((cause: unknown) => {
    setError(
      cause instanceof Error
        ? cause.message
        : "Permintaan tidak dapat diproses.",
    );
  }, []);

  const submitRecovery = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    if (recoveryPassword !== recoveryConfirm) {
      setError("Konfirmasi password baru tidak sama.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const hasil = await recoverWithCode({
        identifier,
        code: recoveryCode,
        newPassword: recoveryPassword,
      });
      setSisaKode(hasil.sisaKode);
      setRecoveryCode("");
      setRecoveryPassword("");
      setRecoveryConfirm("");
      setStep("pulih");
    } catch (cause) {
      fail(cause);
    } finally {
      setBusy(false);
    }
  };

  const submitLookup = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      setAccount(await lookupResetAccount(identifier.trim()));
      setStep("konfirmasi");
    } catch (cause) {
      fail(cause);
    } finally {
      setBusy(false);
    }
  };

  const submitConfirmation = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      setChallenge(
        await confirmResetAccount(identifier.trim(), confirmation.trim()),
      );
      setStep("foto");
    } catch (cause) {
      fail(cause);
    } finally {
      setBusy(false);
    }
  };

  const submitLiveness = useCallback(
    async (result: LivenessCaptureResult) => {
      if (!challenge) return;
      setBusy(true);
      setError(null);
      try {
        const delivery = await verifyResetLiveness({
          requestId: challenge.requestId,
          challengeToken: challenge.challengeToken,
          frames: result.frames,
          photoBase64: result.photoBase64,
          photoMime: result.photoMime,
          challenges: challenge.challenges,
        });
        setDeliveryMessage(delivery.message);
        setDeliveryMode(delivery.mode);
        setStep("terkirim");
      } catch (cause) {
        fail(cause);
        // Tantangan lama sudah dipakai; pemohon harus mengulang dari langkah
        // konfirmasi supaya server menerbitkan urutan tantangan yang baru.
        setStep("ulangi");
        setChallenge(null);
      } finally {
        setBusy(false);
      }
    },
    [challenge, fail],
  );

  // Tantangan pengganti diterbitkan server, lalu urutan di layar ikut
  // diperbarui supaya langkah yang sudah lolos tidak perlu diulang.
  const swapChallenge = useCallback(
    async (stepIndex: number) => {
      if (!challenge) return;
      const next = await swapResetChallenge(
        challenge.requestId,
        challenge.challengeToken,
        stepIndex,
      );
      setChallenge({ ...challenge, challenges: next });
    },
    [challenge],
  );

  const restart = () => {
    setStep("cari");
    setIdentifier("");
    setConfirmation("");
    setAccount(null);
    setChallenge(null);
    setError(null);
    setDeliveryMessage("");
  };

  if (!isHydrated) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-slate-950 text-slate-100">
        <div className="h-10 w-10 animate-spin rounded-full border-4 border-emerald-500 border-t-transparent" />
      </main>
    );
  }

  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-slate-950 p-4 font-sans text-slate-100 sm:p-6">
      <div className="pointer-events-none absolute -top-40 -left-40 h-96 w-96 rounded-full bg-emerald-600/15 blur-3xl" />
      <div className="pointer-events-none absolute -right-40 -bottom-40 h-96 w-96 rounded-full bg-sky-600/15 blur-3xl" />

      <section className="relative z-10 w-full max-w-lg space-y-5 rounded-3xl border border-white/10 bg-slate-900/70 p-6 shadow-2xl backdrop-blur sm:p-8">
        <header className="space-y-1">
          <p className="text-xs font-black uppercase tracking-[0.2em] text-emerald-400">
            {BRANDING.appDisplayName}
          </p>
          <h1 className="text-2xl font-black">Lupa Password</h1>
          <p className="text-sm text-slate-400">
            {step === "terkirim"
              ? "Permintaan berhasil diverifikasi."
              : "Kami akan memverifikasi wajah Anda sebelum mengirim link pemulihan."}
          </p>
        </header>

        <StepIndicator step={step} />

        {error ? (
          <p className="rounded-xl border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-200">
            {error}
          </p>
        ) : null}

        {step === "cari" ? (
          <form className="space-y-4" onSubmit={submitLookup}>
            <label className="grid gap-1.5 text-xs font-bold text-slate-300">
              Username atau email
              <input
                required
                minLength={3}
                maxLength={120}
                autoComplete="username"
                value={identifier}
                onChange={(event) => setIdentifier(event.target.value)}
                placeholder="operator01 atau operator@sppg.id"
                className="min-h-11 rounded-xl border border-white/15 bg-slate-950 px-3 text-sm text-white"
              />
            </label>
            <button
              type="submit"
              disabled={busy}
              className="min-h-12 w-full rounded-2xl bg-emerald-500 text-sm font-black text-slate-950 disabled:opacity-50"
            >
              {busy ? "Mencari akun..." : "Cari akun"}
            </button>

            {/* Jalur kedua, untuk akun yang tidak bisa menunggu peninjau —
                terutama Superadmin, yang tidak punya siapa pun di atasnya. */}
            <button
              type="button"
              onClick={() => {
                setError(null);
                setStep("kode-pemulihan");
              }}
              className="min-h-11 w-full rounded-2xl border border-amber-400/30 text-xs font-bold text-amber-200 transition hover:bg-amber-400/10"
            >
              Saya punya kode pemulihan cetak
            </button>
          </form>
        ) : null}

        {step === "kode-pemulihan" ? (
          <form className="space-y-4" onSubmit={submitRecovery}>
            <p className="rounded-2xl border border-amber-400/25 bg-amber-400/10 p-3 text-[11px] leading-4 text-amber-100">
              Masukkan salah satu kode yang dicetak saat aplikasi pertama kali
              dipasang. Setiap kode hanya berlaku sekali, dan cara ini bekerja
              tanpa internet.
            </p>
            <label className="grid gap-1.5 text-xs font-bold text-slate-300">
              Username atau kode operator
              <input
                required
                autoComplete="username"
                value={identifier}
                onChange={(event) => setIdentifier(event.target.value)}
                className="min-h-11 rounded-xl border border-white/15 bg-slate-950 px-3 text-sm text-white"
              />
            </label>
            <label className="grid gap-1.5 text-xs font-bold text-slate-300">
              Kode pemulihan
              <input
                required
                value={recoveryCode}
                onChange={(event) => setRecoveryCode(event.target.value)}
                placeholder="XXXX-XXXX"
                autoComplete="off"
                className="min-h-11 rounded-xl border border-white/15 bg-slate-950 px-3 font-mono text-sm uppercase tracking-wider text-white"
              />
            </label>
            <label className="grid gap-1.5 text-xs font-bold text-slate-300">
              Password baru
              <input
                required
                type="password"
                minLength={8}
                autoComplete="new-password"
                value={recoveryPassword}
                onChange={(event) => setRecoveryPassword(event.target.value)}
                className="min-h-11 rounded-xl border border-white/15 bg-slate-950 px-3 text-sm text-white"
              />
            </label>
            <label className="grid gap-1.5 text-xs font-bold text-slate-300">
              Ulangi password baru
              <input
                required
                type="password"
                minLength={8}
                autoComplete="new-password"
                value={recoveryConfirm}
                onChange={(event) => setRecoveryConfirm(event.target.value)}
                className="min-h-11 rounded-xl border border-white/15 bg-slate-950 px-3 text-sm text-white"
              />
            </label>
            <button
              type="submit"
              disabled={busy}
              className="min-h-12 w-full rounded-2xl bg-amber-400 text-sm font-black text-slate-950 disabled:opacity-50"
            >
              {busy ? "Memulihkan..." : "Pulihkan akses"}
            </button>
            <button
              type="button"
              onClick={() => {
                setError(null);
                setStep("cari");
              }}
              className="min-h-10 w-full text-xs font-bold text-slate-400"
            >
              Kembali
            </button>
          </form>
        ) : null}

        {step === "pulih" ? (
          <div className="space-y-4">
            <p className="rounded-2xl border border-emerald-500/30 bg-emerald-500/10 p-4 text-sm leading-6 text-emerald-200">
              Password berhasil diganti dan seluruh sesi lama dicabut. Silakan
              masuk memakai password baru Anda.
            </p>
            <p className="text-[11px] leading-4 text-slate-400">
              Sisa kode pemulihan: <strong>{sisaKode}</strong>. Terbitkan
              kumpulan kode baru dari halaman Master Operator bila sisanya
              menipis.
            </p>
            <button
              type="button"
              onClick={() => router.replace("/login")}
              className="min-h-12 w-full rounded-2xl bg-emerald-500 text-sm font-black text-slate-950"
            >
              Ke halaman masuk
            </button>
          </div>
        ) : null}

        {step === "konfirmasi" && account ? (
          <div className="space-y-4">
            <div className="space-y-1 rounded-2xl border border-white/10 bg-slate-950/60 p-4 text-sm">
              <p className="text-base font-black text-white">{account.name}</p>
              <p className="text-slate-400">
                {account.kodeOperator} · @{account.username}
              </p>
              <p className="text-slate-400">Email: {account.maskedEmail}</p>
              <p className="text-slate-400">
                Nomor HP: {account.maskedPhone || "belum diisi"}
              </p>
            </div>
            <p className="text-sm text-slate-300">
              Apakah akun ini milik Anda?
            </p>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => {
                  setConfirmation("");
                  setStep("ulangi");
                }}
                className="min-h-11 flex-1 rounded-xl bg-emerald-500 px-4 text-sm font-black text-slate-950"
              >
                Ya, akun saya
              </button>
              <button
                type="button"
                onClick={restart}
                className="min-h-11 rounded-xl border border-white/15 px-4 text-sm font-bold text-slate-300"
              >
                Bukan, cari lagi
              </button>
            </div>
          </div>
        ) : null}

        {step === "ulangi" && account ? (
          <form className="space-y-4" onSubmit={submitConfirmation}>
            <p className="text-sm text-slate-300">
              Untuk memastikan, ketik ulang username atau email akun{" "}
              <strong className="text-white">{account.name}</strong>.
            </p>
            <label className="grid gap-1.5 text-xs font-bold text-slate-300">
              Ulangi username atau email
              <input
                required
                minLength={3}
                maxLength={120}
                autoComplete="off"
                value={confirmation}
                onChange={(event) => setConfirmation(event.target.value)}
                className="min-h-11 rounded-xl border border-white/15 bg-slate-950 px-3 text-sm text-white"
              />
            </label>
            <div className="flex flex-wrap gap-2">
              <button
                type="submit"
                disabled={busy}
                className="min-h-12 flex-1 rounded-2xl bg-emerald-500 text-sm font-black text-slate-950 disabled:opacity-50"
              >
                {busy ? "Memeriksa..." : "Lanjut ke verifikasi wajah"}
              </button>
              <button
                type="button"
                onClick={restart}
                className="min-h-12 rounded-2xl border border-white/15 px-4 text-sm font-bold text-slate-300"
              >
                Ulangi
              </button>
            </div>
          </form>
        ) : null}

        {step === "foto" && challenge ? (
          <div className="space-y-4">
            <p className="text-sm text-slate-300">
              Ikuti {challenge.challenges.length} instruksi berikut. Rekaman ini
              dipakai untuk memastikan pemohon adalah orang sungguhan, bukan
              foto, dan disimpan sebagai bukti audit.
            </p>
            <LivenessCapture
              challenges={challenge.challenges}
              busy={busy}
              onComplete={(result) => void submitLiveness(result)}
              onSwapChallenge={swapChallenge}
              onCancel={restart}
            />
          </div>
        ) : null}

        {step === "terkirim" ? (
          <div className="space-y-4">
            <p className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm text-emerald-200">
              {deliveryMessage}
            </p>
            {deliveryMode === "in_app" ? (
              <p className="text-sm text-slate-300">
                Tidak ada email yang dikirim: pemasangan ini memang tidak
                memakai jalur email. Hubungi Superadmin agar meninjau foto Anda
                di halaman Riwayat Reset Password, lalu minta kode pemulihan
                yang ditampilkan di layarnya. Masukkan kode itu di bawah.
              </p>
            ) : (
              <p className="text-sm text-slate-300">
                Buka email tersebut lalu klik tautannya untuk membuat password
                baru. Bila email hanya memuat kode, masukkan kode itu di bawah.
              </p>
            )}
            <button
              type="button"
              onClick={() => router.push("/lupa-password/reset")}
              className="min-h-12 w-full rounded-2xl bg-emerald-500 text-sm font-black text-slate-950"
            >
              Saya sudah punya kode reset
            </button>
          </div>
        ) : null}

        <footer className="border-t border-white/10 pt-4 text-center">
          <Link
            href="/login"
            className="text-xs font-bold text-slate-400 hover:text-emerald-300"
          >
            Kembali ke halaman login
          </Link>
        </footer>
      </section>
    </main>
  );
}

const STEP_LABELS: { key: Step; label: string }[] = [
  { key: "cari", label: "Cari" },
  { key: "konfirmasi", label: "Konfirmasi" },
  { key: "ulangi", label: "Ulangi" },
  { key: "foto", label: "Foto" },
  { key: "terkirim", label: "Kirim" },
];

function StepIndicator({ step }: { step: Step }) {
  const activeIndex = STEP_LABELS.findIndex((item) => item.key === step);
  return (
    <ol className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider">
      {STEP_LABELS.map((item, index) => (
        <li key={item.key} className="flex flex-1 flex-col gap-1">
          <span
            className={`h-1 rounded-full ${
              index <= activeIndex ? "bg-emerald-400" : "bg-white/10"
            }`}
          />
          <span
            className={
              index <= activeIndex ? "text-emerald-300" : "text-slate-600"
            }
          >
            {item.label}
          </span>
        </li>
      ))}
    </ol>
  );
}
