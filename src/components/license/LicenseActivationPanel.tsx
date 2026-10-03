"use client";

import {
  type ChangeEvent,
  type FormEvent,
  useId,
  useRef,
  useState,
} from "react";
import {
  installLicense,
  LICENSE_ISSUER,
  LICENSE_KIND_LABEL,
  type LicenseState,
  type LicenseStatus,
  licenseTargetNoun,
} from "@/lib/gateways/license";

const TITLES: Record<LicenseState, string> = {
  missing: "Aktifkan lisensi aplikasi",
  invalid: "Lisensi tidak sah",
  device_not_listed: "Belum terdaftar di lisensi",
  read_only: "Aktifkan lisensi baru",
  active: "Ganti lisensi",
};

/** Batas berkas yang wajar untuk satu lisensi (200 kode perangkat ≈ 7 KB). */
const MAX_LICENSE_FILE_BYTES = 20_000;

type Props = {
  status: LicenseStatus;
  onInstalled: (status: LicenseStatus) => void;
  /** Tombol sekunder, mis. "Lanjut dalam mode baca-saja". */
  onDismiss?: () => void;
  dismissLabel?: string;
};

/**
 * Formulir aktivasi lisensi: kode perangkat untuk diminta ke penyedia, lalu
 * tempel teks `LIS1.…` atau pilih berkas `.lic`. Dipakai layar login,
 * pemberitahuan mode baca-saja, dan kartu Lisensi di Pengaturan — identik di
 * Web-Desktop dan Mobile (`filesToCopy` di `sync-frontend-lib.ts`).
 */
export function LicenseActivationPanel({
  status,
  onInstalled,
  onDismiss,
  dismissLabel,
}: Props) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const isSubmittingRef = useRef(false);
  const textId = useId();
  const fileId = useId();

  const noun = licenseTargetNoun();
  const deviceName = status.deviceName?.trim() || null;

  // Nama ikut disalin supaya penerbit tahu kode itu milik PC atau HP yang mana.
  const copyDeviceCode = async () => {
    const copyText = deviceName
      ? `Nama ${noun}: ${deviceName}\nKode ${noun}: ${status.deviceCode}`
      : status.deviceCode;
    try {
      await navigator.clipboard.writeText(copyText);
      setCopied(true);
    } catch {
      setError(
        "Kode tidak bisa disalin otomatis. Tekan lama kodenya lalu salin manual.",
      );
    }
  };

  const readFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (file.size > MAX_LICENSE_FILE_BYTES) {
      setError("Berkas itu terlalu besar untuk sebuah lisensi.");
      return;
    }
    setText((await file.text()).trim());
    setError(null);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (isSubmittingRef.current) return;
    if (!text.trim()) {
      setError("Tempel teks lisensi atau pilih berkas .lic terlebih dahulu.");
      return;
    }
    isSubmittingRef.current = true;
    setIsSubmitting(true);
    setError(null);
    try {
      const next = await installLicense(text);
      setText("");
      onInstalled(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Lisensi gagal dipasang.");
    } finally {
      isSubmittingRef.current = false;
      setIsSubmitting(false);
    }
  };

  const license = status.license;
  const tone =
    status.state === "read_only" || status.state === "missing"
      ? "p-3.5 bg-amber-950/50 border border-white/10 rounded-2xl text-amber-100 text-xs"
      : "p-3.5 bg-rose-950/60 border border-rose-800/80 rounded-2xl text-rose-300 text-xs";

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="space-y-1">
        <h2 className="text-base font-bold text-white">
          {TITLES[status.state]}
        </h2>
        {license ? (
          <p className="text-xs text-slate-400">
            Lisensi {LICENSE_KIND_LABEL[license.kind]} untuk{" "}
            <span className="font-semibold text-slate-300">
              {license.holder}
            </span>
          </p>
        ) : null}
      </div>

      {status.message ? <p className={tone}>{status.message}</p> : null}

      <div className="space-y-1.5">
        {deviceName ? (
          <>
            <p className="text-xs font-semibold text-slate-300 uppercase tracking-wider">
              Nama {noun}
            </p>
            <p className="select-all break-words rounded-xl border border-slate-800 bg-slate-950/90 px-3 py-2.5 text-center text-sm font-bold text-white">
              {deviceName}
            </p>
          </>
        ) : null}
        <p className="text-xs font-semibold text-slate-300 uppercase tracking-wider">
          Kode {noun} ini
        </p>
        <div className="flex items-center gap-2">
          <code className="flex-1 select-all rounded-xl border border-slate-800 bg-slate-950/90 px-3 py-2.5 text-center font-mono text-sm font-bold tracking-wider text-white">
            {status.deviceCode}
          </code>
          <button
            type="button"
            onClick={copyDeviceCode}
            aria-label={
              deviceName ? `Salin nama dan kode ${noun}` : `Salin kode ${noun}`
            }
            className="min-h-10 rounded-xl border border-slate-700 bg-slate-800/80 px-3 text-xs font-bold text-slate-300 transition hover:bg-slate-700"
          >
            {copied ? "Tersalin" : "Salin"}
          </button>
        </div>
        <p className="text-[11px] text-slate-500">
          Kirim {deviceName ? "nama dan kode" : "kode"} ini kepada{" "}
          {LICENSE_ISSUER} saat meminta atau memperpanjang lisensi.
        </p>
      </div>

      <div className="space-y-1.5">
        <label
          htmlFor={textId}
          className="text-xs font-semibold text-slate-300 uppercase tracking-wider block"
        >
          Teks lisensi
        </label>
        <textarea
          id={textId}
          value={text}
          onChange={(event) => setText(event.target.value)}
          rows={4}
          spellCheck={false}
          autoComplete="off"
          placeholder="LIS1.…"
          className="w-full resize-y rounded-xl border border-slate-800 bg-slate-950/90 px-3 py-2.5 font-mono text-[11px] text-white outline-none transition focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/20 break-all"
        />
        <label
          htmlFor={fileId}
          className="inline-flex min-h-10 cursor-pointer items-center rounded-xl border border-slate-700 bg-slate-800/80 px-3 text-xs font-bold text-slate-300 transition hover:bg-slate-700"
        >
          Pilih berkas .lic
        </label>
        <input
          id={fileId}
          type="file"
          accept=".lic,.txt,text/plain"
          onChange={readFile}
          className="sr-only"
        />
      </div>

      {error ? (
        <p
          role="alert"
          className="p-3.5 bg-rose-950/60 border border-rose-800/80 rounded-2xl text-rose-300 text-xs"
        >
          {error}
        </p>
      ) : null}

      <div className="flex flex-col gap-2 sm:flex-row-reverse">
        <button
          type="submit"
          disabled={isSubmitting}
          className="flex-1 min-h-11 rounded-xl bg-gradient-to-r from-emerald-600 to-emerald-500 px-4 text-sm font-bold text-white shadow-lg shadow-emerald-950/50 transition hover:from-emerald-500 hover:to-emerald-400 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isSubmitting ? "Memeriksa lisensi…" : "Aktifkan lisensi"}
        </button>
        {onDismiss ? (
          <button
            type="button"
            onClick={onDismiss}
            className="flex-1 min-h-11 rounded-xl border border-slate-700 bg-slate-800/80 px-4 text-sm font-bold text-slate-300 transition hover:bg-slate-700"
          >
            {dismissLabel ?? "Nanti saja"}
          </button>
        ) : null}
      </div>

      <p className="text-center text-[10px] font-mono text-slate-600">
        Build {status.buildDate}
      </p>
    </form>
  );
}
