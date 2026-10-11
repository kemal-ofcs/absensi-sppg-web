"use client";

import type { FormEvent } from "react";
import { useCallback, useEffect, useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { BRANDING } from "@/lib/constants/branding";
import {
  getMailConfig,
  type MailTestResult,
  saveMailConfig,
  sendTestMail,
} from "@/lib/gateways/mail-config";
import {
  describeMailFailure,
  isMailProvider,
  MAIL_PROVIDER_LABEL,
  MAIL_PROVIDER_REQUIREMENT,
  MAIL_PROVIDERS,
  type MailConfig,
} from "@/lib/mail/mail-config";

/**
 * Konfigurasi pengirim email sistem.
 *
 * Satu-satunya konsumennya saat ini adalah link "Lupa Password". Tanpa
 * konfigurasi ini fitur tersebut mati total — tidak ada jalur lain untuk
 * menyampaikan token reset — jadi kartu ini menyatakannya terang-terangan
 * alih-alih membiarkan operator menemukannya saat sedang terkunci.
 */
export function MailSettingsCard() {
  const [config, setConfig] = useState<MailConfig | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [provider, setProvider] = useState<MailConfig["provider"]>("resend");
  const [senderEmail, setSenderEmail] = useState("");
  const [senderName, setSenderName] = useState("");
  const [resetBaseUrl, setResetBaseUrl] = useState("");
  const [isActive, setIsActive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<MailTestResult | null>(null);
  const [feedback, setFeedback] = useState<{
    tone: "success" | "error";
    text: string;
  } | null>(null);

  const applyConfig = useCallback((value: MailConfig) => {
    setConfig(value);
    setProvider(value.provider);
    setSenderEmail(value.senderEmail);
    setSenderName(value.senderName);
    setResetBaseUrl(value.resetBaseUrl);
    setIsActive(value.isActive);
    setApiKey("");
  }, []);

  useEffect(() => {
    let cancelled = false;
    void getMailConfig()
      .then((value) => {
        if (!cancelled) applyConfig(value);
      })
      .catch(() => {
        if (!cancelled) setConfig(null);
      });
    return () => {
      cancelled = true;
    };
  }, [applyConfig]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setFeedback(null);
    try {
      applyConfig(
        await saveMailConfig({
          provider,
          apiKey,
          senderEmail,
          senderName,
          resetBaseUrl,
          isActive,
        }),
      );
      setFeedback({
        tone: "success",
        text: "Konfigurasi email sistem berhasil disimpan.",
      });
    } catch (error) {
      setFeedback({
        tone: "error",
        text:
          error instanceof Error
            ? error.message
            : "Konfigurasi email tidak dapat disimpan.",
      });
    } finally {
      setBusy(false);
    }
  };

  const runTest = async () => {
    if (testing) return;
    setTesting(true);
    setTestResult(null);
    try {
      setTestResult(await sendTestMail());
    } catch (error) {
      setTestResult({
        delivered: false,
        message:
          error instanceof Error
            ? error.message
            : "Uji kirim gagal dijalankan.",
        detail: "",
        to: "",
      });
    } finally {
      setTesting(false);
    }
  };

  return (
    <section className="app-panel rounded-3xl p-5 sm:p-7">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-4">
          <span className="grid size-11 shrink-0 place-items-center rounded-2xl border border-emerald-300/20 bg-emerald-300/10 text-emerald-200">
            <Icon name="tools" className="size-5" />
          </span>
          <div>
            <h2 className="text-base font-black text-white">
              Email Sistem (Lupa Password)
            </h2>
            <p className="mt-1 max-w-2xl text-sm leading-6 text-slate-400">
              Link pemulihan password dikirim lewat HTTP API penyedia email.
              Selama konfigurasi ini nonaktif, operator yang lupa password tidak
              dapat memulihkan akunnya sendiri.
            </p>
          </div>
        </div>
        <StatusBadge tone={config?.isActive ? "success" : "warning"}>
          {config?.isActive ? "Aktif" : "Nonaktif"}
        </StatusBadge>
      </div>

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

      <form className="mt-5 grid gap-4 sm:grid-cols-2" onSubmit={submit}>
        <label className="grid gap-1.5 text-xs font-bold text-slate-300">
          Penyedia
          <select
            value={provider}
            onChange={(event) => {
              if (isMailProvider(event.target.value)) {
                setProvider(event.target.value);
              }
            }}
            className="app-input"
          >
            {MAIL_PROVIDERS.map((item) => (
              <option key={item} value={item}>
                {MAIL_PROVIDER_LABEL[item]}
              </option>
            ))}
          </select>
          <p className="mt-1 text-[11px] leading-4 text-slate-500">
            {MAIL_PROVIDER_REQUIREMENT[provider]}
          </p>
        </label>

        <label className="grid gap-1.5 text-xs font-bold text-slate-300">
          Kunci API
          <input
            type="password"
            autoComplete="off"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            placeholder={
              config?.hasApiKey
                ? "Tersimpan — isi hanya bila ingin mengganti"
                : "Tempel kunci API penyedia"
            }
            className="app-input"
          />
          <span className="font-normal leading-5 text-slate-500">
            Kunci tidak pernah ditampilkan kembali setelah disimpan.
          </span>
        </label>

        <label className="grid gap-1.5 text-xs font-bold text-slate-300">
          Email pengirim
          <input
            type="email"
            value={senderEmail}
            onChange={(event) => setSenderEmail(event.target.value)}
            placeholder="no-reply@perusahaan.co.id"
            className="app-input"
          />
        </label>

        <label className="grid gap-1.5 text-xs font-bold text-slate-300">
          Nama pengirim
          <input
            value={senderName}
            onChange={(event) => setSenderName(event.target.value)}
            placeholder={BRANDING.appDisplayName}
            className="app-input"
          />
        </label>

        <label className="grid gap-1.5 text-xs font-bold text-slate-300 sm:col-span-2">
          URL halaman reset (opsional)
          <input
            value={resetBaseUrl}
            onChange={(event) => setResetBaseUrl(event.target.value)}
            placeholder="https://absensi.perusahaan.co.id"
            className="app-input"
          />
          <span className="font-normal leading-5 text-slate-500">
            Diisi bila aplikasi Web dipasang. Bila dikosongkan, email hanya
            memuat kode reset dan operator memasukkannya di aplikasi
            Desktop/Mobile.
          </span>
        </label>

        <label className="flex items-center gap-3 text-xs font-bold text-slate-300 sm:col-span-2">
          <input
            type="checkbox"
            checked={isActive}
            onChange={(event) => setIsActive(event.target.checked)}
            className="size-4"
          />
          Aktifkan pengiriman email sistem
        </label>

        <div className="sm:col-span-2">
          <button
            type="submit"
            disabled={busy}
            className="min-h-11 rounded-xl bg-emerald-500 px-5 text-sm font-black text-slate-950 disabled:opacity-50"
          >
            {busy ? "Menyimpan..." : "Simpan konfigurasi email"}
          </button>
          <button
            type="button"
            onClick={() => void runTest()}
            disabled={testing || !config?.hasApiKey}
            className="ml-2 min-h-11 rounded-xl border border-white/15 px-4 text-sm font-bold text-slate-200 disabled:opacity-50"
          >
            {testing ? "Mengirim..." : "Kirim email uji"}
          </button>
          {testResult ? (
            <div
              className={`mt-3 rounded-xl border p-3 text-xs leading-5 ${
                testResult.delivered
                  ? "border-emerald-400/25 bg-emerald-400/10 text-emerald-100"
                  : "border-rose-400/25 bg-rose-400/10 text-rose-100"
              }`}
            >
              <p className="font-bold">{testResult.message}</p>
              {describeMailFailure(testResult.detail) ? (
                <p className="mt-1 font-semibold">
                  {describeMailFailure(testResult.detail)}
                </p>
              ) : null}
              {testResult.detail ? (
                // Penjelasan apa adanya dari penyedia. Inilah yang menjawab
                // "kenapa HTTP 403" — biasanya domain pengirim belum diverifikasi.
                <p className="mt-1 break-words font-mono text-[11px] opacity-80">
                  {testResult.detail}
                </p>
              ) : null}
            </div>
          ) : null}
          {config?.updatedAt ? (
            <p className="mt-2 text-xs text-slate-500">
              Terakhir disimpan {config.updatedAt} oleh{" "}
              {config.updatedBy || "sistem"}.
            </p>
          ) : null}
        </div>
      </form>
    </section>
  );
}
