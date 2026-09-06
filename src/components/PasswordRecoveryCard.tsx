"use client";

import { useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { issueRecoveryCodes } from "@/lib/gateways/two-factor";

/**
 * Kode pemulihan password untuk akun yang sedang login.
 *
 * Jalan masuk terakhir ketika password terlupa dan tidak ada siapa pun yang
 * bisa menyetujui pemulihan — keadaan yang pasti dialami Superadmin, karena
 * tidak ada akun di atasnya. Pada pemasangan tanpa internet, tidak ada email
 * yang bisa dikirim, sehingga inilah satu-satunya jaring pengaman yang tersisa.
 *
 * SENGAJA hanya untuk akun sendiri: mencetak kode bagi akun orang lain berarti
 * membuat kunci cadangan ke akun itu tanpa pemiliknya pernah tahu.
 */
export function PasswordRecoveryCard() {
  const [codes, setCodes] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  const issue = async () => {
    setBusy(true);
    setError(null);
    try {
      setCodes(await issueRecoveryCodes());
      setConfirming(false);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Kode pemulihan tidak dapat diterbitkan.",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="app-panel rounded-3xl p-5 sm:p-7">
      <div className="flex items-start gap-4">
        <span className="grid size-11 shrink-0 place-items-center rounded-2xl border border-amber-300/20 bg-amber-300/10 text-amber-200">
          <Icon name="lock" className="size-5" />
        </span>
        <div className="min-w-0">
          <h2 className="text-base font-black text-white">
            Kode pemulihan password
          </h2>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-slate-400">
            Dipakai untuk masuk kembali bila password akun ini terlupa dan tidak
            ada siapa pun yang bisa menyetujui pemulihan. Bekerja tanpa
            internet, dan hanya berlaku untuk akun Anda sendiri.
          </p>
        </div>
      </div>

      {codes ? (
        <div className="mt-5 space-y-3">
          <ul className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {codes.map((code) => (
              <li
                key={code}
                className="recovery-code-pill select-all rounded-xl border border-amber-400/25 bg-amber-400/10 px-2 py-2.5 text-center font-mono text-xs font-black tracking-wider text-amber-100"
              >
                {code}
              </li>
            ))}
          </ul>
          <p className="rounded-xl border border-rose-500/30 bg-rose-500/10 p-3 text-[11px] font-bold leading-4 text-rose-200">
            Cetak atau salin sekarang. Kode ini tidak tersimpan dalam bentuk
            aslinya dan tidak dapat ditampilkan ulang. Seluruh kode lama sudah
            tidak berlaku — buang kertas lamanya.
          </p>
          <button
            type="button"
            onClick={() => setCodes(null)}
            className="recovery-code-btn min-h-11 w-full rounded-xl bg-white/10 text-xs font-black text-slate-200 transition hover:bg-white/20"
          >
            Saya sudah menyimpannya
          </button>
        </div>
      ) : confirming ? (
        <div className="mt-5 space-y-3">
          <p className="rounded-xl border border-amber-400/30 bg-amber-400/10 p-3 text-[11px] font-bold leading-4 text-amber-100">
            Menerbitkan kode baru membuat seluruh kode lama tidak berlaku,
            termasuk yang sudah tercetak. Lanjutkan hanya bila kertas lamanya
            hilang, habis, atau pernah dilihat orang lain.
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void issue()}
              disabled={busy}
              className="min-h-11 rounded-xl bg-amber-400 px-5 text-xs font-black text-slate-950 transition hover:bg-amber-300 disabled:opacity-50"
            >
              {busy ? "Menerbitkan..." : "Ya, terbitkan kode baru"}
            </button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              disabled={busy}
              className="min-h-11 rounded-xl border border-white/15 px-4 text-xs font-bold text-slate-300 transition hover:bg-white/5 disabled:opacity-50"
            >
              Batal
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setConfirming(true)}
          className="mt-5 min-h-11 rounded-xl border border-amber-400/40 bg-amber-400/10 px-4 text-xs font-black text-amber-200 transition hover:bg-amber-400/20"
        >
          Terbitkan kode pemulihan baru
        </button>
      )}

      {error ? (
        <p className="mt-4 rounded-xl border border-rose-500/30 bg-rose-500/10 p-3 text-[11px] font-bold leading-4 text-rose-200">
          {error}
        </p>
      ) : null}
    </section>
  );
}
