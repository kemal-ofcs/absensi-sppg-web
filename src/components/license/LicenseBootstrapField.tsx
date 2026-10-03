"use client";

import { useId } from "react";
import { LICENSE_ISSUER, licenseTargetNoun } from "@/lib/gateways/license";
import { useLicenseStatus } from "@/lib/hooks/useLicenseStatus";

type Props = {
  value: string;
  onChange: (value: string) => void;
};

/**
 * Kolom lisensi pada provisioning Superadmin pertama. Database baru tidak
 * bisa diprovisioning tanpa lisensi, jadi kodenya ditampilkan di sini juga:
 * lisensi yang dikunci ke perangkat (atau, di Web, ke server) harus diminta
 * sebelum formulir ini bisa diselesaikan. Tidak merender apa pun pada build Web
 * yang tidak menegakkan lisensi.
 *
 * Pemasangan baru biasanya sudah mengaktifkan lisensi di layar pertama
 * (sebelum provisioning); bootstrap memakai lisensi itu bila kolom ini kosong,
 * jadi yang ditampilkan cukup konfirmasinya.
 */
export function LicenseBootstrapField({ value, onChange }: Props) {
  const { status } = useLicenseStatus();
  const textId = useId();
  if (!status) return null;
  if (status.state === "active" && status.license) {
    return (
      <p className="rounded-xl border border-white/10 bg-slate-950/60 p-3 text-xs text-slate-300">
        Lisensi aktif untuk{" "}
        <span className="font-bold text-white">{status.license.holder}</span>{" "}
        sudah terpasang di {licenseTargetNoun()} ini.
      </p>
    );
  }

  return (
    <div className="space-y-1.5">
      <label
        htmlFor={textId}
        className="text-xs font-semibold text-slate-300 uppercase tracking-wider block"
      >
        Teks lisensi
      </label>
      <textarea
        id={textId}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        rows={3}
        spellCheck={false}
        autoComplete="off"
        placeholder="LIS1.…"
        className="w-full resize-y rounded-xl border border-slate-800 bg-slate-950/90 px-3 py-2.5 font-mono text-[11px] text-white outline-none transition focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/20 break-all"
      />
      <p className="text-[11px] text-slate-500">
        {status.deviceName ? (
          <>
            Nama {licenseTargetNoun()} ini:{" "}
            <span className="select-all font-bold text-slate-300">
              {status.deviceName}
            </span>
            , kode
          </>
        ) : (
          "Kode"
        )}{" "}
        {licenseTargetNoun()} ini:{" "}
        <code className="select-all font-mono font-bold text-slate-300">
          {status.deviceCode}
        </code>
        . Kirim kepada {LICENSE_ISSUER} untuk mendapatkan lisensi.
      </p>
    </div>
  );
}
