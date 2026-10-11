"use client";

import { useState } from "react";
import { useAuth } from "@/lib/context/AuthContext";
import { LICENSE_KIND_LABEL, licenseTargetNoun } from "@/lib/gateways/license";
import { useLicenseStatus } from "@/lib/hooks/useLicenseStatus";
import { LicenseActivationPanel } from "./LicenseActivationPanel";

function describeDaysLeft(days: number) {
  if (days <= 0) return "Sewa sudah berakhir";
  if (days === 1) return "Hari terakhir sewa";
  return `${days} hari`;
}

const STATE_LABEL = {
  active: "Aktif",
  read_only: "Mode baca-saja",
  missing: "Belum ada lisensi",
  invalid: "Tidak sah",
  device_not_listed: "Tidak terdaftar di lisensi",
} as const;

/**
 * Kartu Lisensi di Pengaturan, KHUSUS Superadmin: sisa sewa dan daftar
 * perangkat adalah urusan pemilik lembaga, bukan operator. Operator tetap
 * melihat dialog "Aktifkan lisensi" saat sewa habis (`LicenseNotice`). Tidak
 * merender apa pun pada build Web yang tidak menegakkan lisensi.
 */
export function LicenseCard() {
  const { user } = useAuth();
  const { status, setStatus } = useLicenseStatus();
  const [replacing, setReplacing] = useState(false);
  if (!status || !user?.isSuperadmin) return null;

  const license = status.license;
  const rows: [string, string][] = license
    ? [
        ["Pemegang", license.holder],
        ["Nomor lisensi", license.id],
        ["Jenis", LICENSE_KIND_LABEL[license.kind]],
        ["Terbit", license.issued],
        ["Pembaruan sampai", license.updatesUntil],
        ["Berlaku sampai", license.validUntil ?? "Selamanya"],
        ...(status.daysLeft === null
          ? []
          : ([["Sisa sewa", describeDaysLeft(status.daysLeft)]] as [
              string,
              string,
            ][])),
        [
          "Perangkat",
          license.devices.length
            ? `${license.devices.length} terdaftar${status.deviceBound ? "" : " (perangkat ini tidak wajib terdaftar)"}`
            : "Tidak dikunci ke perangkat",
        ],
        [
          "Versi Web",
          license.webInstance
            ? `${license.webInstance}, ${license.websites.length ? license.websites.join(", ") : "alamat apa pun"}`
            : "Tidak dicakup",
        ],
      ]
    : [];

  return (
    <section className="rounded-3xl border border-white/10 bg-slate-900/80 p-5 sm:p-7 space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-base font-bold text-white">Lisensi</h2>
          <p className="text-xs text-slate-400">
            Status: {STATE_LABEL[status.state]}
          </p>
        </div>
        {!replacing ? (
          <button
            type="button"
            onClick={() => setReplacing(true)}
            className="min-h-10 rounded-xl border border-slate-700 bg-slate-800/80 px-3 text-xs font-bold text-slate-300 transition hover:bg-slate-700"
          >
            {status.state === "active" ? "Ganti lisensi" : "Aktifkan lisensi"}
          </button>
        ) : null}
      </div>

      {rows.length ? (
        <dl className="grid grid-cols-1 gap-x-4 gap-y-2 text-xs sm:grid-cols-2">
          {rows.map(([label, value]) => (
            <div key={label} className="min-w-0">
              <dt className="text-slate-500">{label}</dt>
              <dd className="font-semibold text-slate-300 break-words">
                {value}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}

      <div className="space-y-1 text-xs text-slate-400">
        {status.deviceName ? (
          <p>
            Nama {licenseTargetNoun()} ini:{" "}
            <span className="select-all font-bold text-slate-300 break-words">
              {status.deviceName}
            </span>
          </p>
        ) : null}
        <p>
          Kode {licenseTargetNoun()} ini:{" "}
          <code className="select-all font-mono font-bold text-slate-300">
            {status.deviceCode}
          </code>
        </p>
      </div>

      {replacing ? (
        <div className="border-t border-white/10 pt-4">
          <LicenseActivationPanel
            status={status}
            onInstalled={(next) => {
              setStatus(next);
              setReplacing(false);
            }}
            onDismiss={() => setReplacing(false)}
            dismissLabel="Batal"
          />
        </div>
      ) : null}
    </section>
  );
}
