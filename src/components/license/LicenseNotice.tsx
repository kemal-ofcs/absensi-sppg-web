"use client";

import { useEffect, useState } from "react";
import { Modal } from "@/components/ui/Modal";
import { useLicenseStatus } from "@/lib/hooks/useLicenseStatus";
import { LicenseActivationPanel } from "./LicenseActivationPanel";

/** Satu kali per jalannya aplikasi; tombol di pita tetap bisa membukanya lagi. */
const DISMISSED_KEY = "sppg.license.readOnlyDismissed";

function wasDismissed() {
  try {
    return window.sessionStorage.getItem(DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

function rememberDismissed() {
  try {
    window.sessionStorage.setItem(DISMISSED_KEY, "1");
  } catch {
    // Penyimpanan sesi tidak tersedia: dialognya muncul lagi, tidak lebih.
  }
}

/**
 * Pemberitahuan mode baca-saja untuk shell aplikasi (Desktop dan Mobile).
 *
 * Saat masa sewa habis atau versi aplikasi tidak tercakup masa
 * pembaruan, dialog "Aktifkan lisensi" langsung muncul setelah login, dan pita
 * di atas halaman tetap menyediakannya selama mode baca-saja berlaku. Tidak
 * merender apa pun di Web maupun saat lisensinya aktif.
 */
export function LicenseNotice() {
  const { status, setStatus } = useLicenseStatus();
  const [open, setOpen] = useState(false);
  const readOnly = status?.state === "read_only";

  useEffect(() => {
    if (readOnly && !wasDismissed()) setOpen(true);
  }, [readOnly]);

  if (!status || !readOnly) return null;

  const close = () => {
    rememberDismissed();
    setOpen(false);
  };

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/10 bg-amber-950/50 px-4 py-2 text-xs text-amber-100">
        <span>
          <span className="font-bold text-amber-300">Mode baca-saja.</span> Data
          tetap bisa dilihat, diekspor, dan disinkronkan.
        </span>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="min-h-9 rounded-lg border border-white/10 bg-slate-900/80 px-3 font-bold text-amber-300 transition hover:bg-slate-800"
        >
          Aktifkan lisensi
        </button>
      </div>
      <Modal isOpen={open} onClose={close} title="Lisensi" hideFooter>
        <LicenseActivationPanel
          status={status}
          onInstalled={(next) => {
            setStatus(next);
            close();
          }}
          onDismiss={close}
          dismissLabel="Lanjut dalam mode baca-saja"
        />
      </Modal>
    </>
  );
}

const sameName = (a: string, b: string) =>
  a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * "Berlisensi untuk …" di kepala halaman. Disembunyikan bila sama dengan nama
 * lembaga di profil — pada pemasangan resmi keduanya identik dan barisnya
 * hanya mengulang. Yang tampil justru salinan yang profilnya sudah diganti ke
 * nama lain: nama pembeli aslinya tetap terbaca.
 */
export function LicenseHolderLabel({
  className,
  unlessEqualTo,
}: {
  className?: string;
  unlessEqualTo?: string | null;
}) {
  const { status } = useLicenseStatus();
  const holder = status?.license?.holder;
  if (!holder || (unlessEqualTo && sameName(holder, unlessEqualTo))) {
    return null;
  }
  return <span className={className}>Berlisensi untuk {holder}</span>;
}
