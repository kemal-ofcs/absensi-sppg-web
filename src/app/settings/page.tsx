"use client";

import { redirect } from "next/navigation";
import type { ChangeEvent } from "react";
import { useState } from "react";
import { AppShell } from "@/components/AppShell";
import { BrandLogo } from "@/components/ui/BrandLogo";
import { Icon } from "@/components/ui/Icon";
import { PageHeader } from "@/components/ui/PageHeader";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { canAccessArea } from "@/lib/auth/access";
import { useAuth } from "@/lib/context/AuthContext";
import { resetAppLogo, saveAppLogo, useAppLogo } from "@/lib/hooks/useAppLogo";
import { useHydrated } from "@/lib/hooks/useHydrated";
import { useOnlineStatus } from "@/lib/hooks/useOnlineStatus";

const MAX_LOGO_SIZE = 1024 * 1024;
const ALLOWED_LOGO_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

interface FeedbackMessage {
  message: string;
  type: "success" | "error";
}

export default function SettingsPage() {
  const isHydrated = useHydrated();
  const isOnline = useOnlineStatus();
  const logoUrl = useAppLogo();
  const { user, isAuthenticated, isLoading: authLoading } = useAuth();
  const [feedback, setFeedback] = useState<FeedbackMessage | null>(null);

  const handleLogoUpload = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    if (!ALLOWED_LOGO_TYPES.has(file.type)) {
      setFeedback({
        type: "error",
        message: "Gunakan gambar PNG, JPG, atau WebP.",
      });
      event.target.value = "";
      return;
    }

    if (file.size > MAX_LOGO_SIZE) {
      setFeedback({
        type: "error",
        message: "Ukuran logo maksimal 1 MB agar aplikasi tetap ringan.",
      });
      event.target.value = "";
      return;
    }

    const reader = new FileReader();
    reader.onerror = () => {
      setFeedback({
        type: "error",
        message: "File logo tidak dapat dibaca. Silakan coba file lain.",
      });
    };
    reader.onload = () => {
      if (typeof reader.result !== "string") return;

      try {
        saveAppLogo(reader.result);
        setFeedback({
          type: "success",
          message: "Logo berhasil diperbarui dan langsung diterapkan.",
        });
      } catch {
        setFeedback({
          type: "error",
          message:
            "Penyimpanan lokal penuh. Gunakan logo berukuran lebih kecil.",
        });
      }
    };
    reader.readAsDataURL(file);
    event.target.value = "";
  };

  const handleResetLogo = () => {
    resetAppLogo();
    setFeedback({
      type: "success",
      message: "Logo dikembalikan ke identitas default SPPG.",
    });
  };

  if (!isHydrated || authLoading) {
    return (
      <div className="grid min-h-dvh place-items-center bg-slate-950 p-6 text-slate-100">
        <output className="flex flex-col items-center gap-3">
          <div className="size-10 animate-spin rounded-full border-4 border-sky-400 border-t-transparent" />
          <p className="text-xs font-medium text-slate-400">
            Memuat pengaturan aplikasi...
          </p>
        </output>
      </div>
    );
  }

  if (!isAuthenticated) redirect("/login");
  if (!canAccessArea(user, "settings")) redirect("/forbidden");

  return (
    <AppShell contentClassName="mx-auto w-full max-w-6xl gap-7 px-4 py-6 sm:px-6 lg:px-8 lg:py-9">
      <PageHeader
        eyebrow="Identitas & preferensi aplikasi"
        title="Pengaturan aplikasi"
        description="Kelola identitas visual dan lihat status runtime. Pengaturan operasional lain akan ditambahkan bertahap tanpa mengubah fondasi data yang ada."
        actions={
          <StatusBadge tone={isOnline ? "info" : "warning"}>
            <Icon name={isOnline ? "wifi" : "wifi-off"} className="size-3.5" />
            {isOnline ? "Jaringan tersedia" : "Bekerja offline"}
          </StatusBadge>
        }
      />

      {feedback ? (
        <div
          role={feedback.type === "error" ? "alert" : "status"}
          className={`flex items-start gap-3 rounded-2xl border p-4 text-sm ${
            feedback.type === "success"
              ? "border-emerald-400/25 bg-emerald-400/10 text-emerald-100"
              : "border-rose-400/25 bg-rose-400/10 text-rose-100"
          }`}
        >
          <Icon
            name={feedback.type === "success" ? "check" : "tools"}
            className="mt-0.5 size-4 shrink-0"
          />
          <span>{feedback.message}</span>
          <button
            type="button"
            onClick={() => setFeedback(null)}
            className="ml-auto rounded-lg px-2 py-1 text-xs font-bold hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
          >
            Tutup
          </button>
        </div>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[1.15fr_0.85fr]">
        <section className="app-panel rounded-3xl p-5 sm:p-7">
          <div className="flex items-start gap-4">
            <span className="grid size-11 shrink-0 place-items-center rounded-2xl border border-sky-300/20 bg-sky-300/10 text-sky-200">
              <Icon name="upload" className="size-5" />
            </span>
            <div>
              <h2 className="text-base font-black text-white">Logo aplikasi</h2>
              <p className="mt-1 text-sm leading-6 text-slate-400">
                Gunakan logo persegi atau horizontal dengan latar transparan
                agar tampil konsisten pada header dan laporan.
              </p>
            </div>
          </div>

          <div className="mt-6 grid min-h-56 place-items-center rounded-2xl border border-dashed border-white/15 bg-slate-950/60 p-6 text-center">
            <div className="flex flex-col items-center gap-3">
              <BrandLogo size={96} />
              <div>
                <p className="text-sm font-bold text-white">
                  {logoUrl ? "Logo khusus terpasang" : "Logo default SPPG"}
                </p>
                <p className="mt-1 text-xs text-slate-500">
                  PNG, JPG, atau WebP · Maksimal 1 MB
                </p>
              </div>
            </div>
          </div>

          <div className="mt-5 flex flex-col gap-3 sm:flex-row">
            <label
              htmlFor="logo-upload-input"
              className="inline-flex min-h-11 flex-1 cursor-pointer items-center justify-center gap-2 rounded-xl bg-sky-400 px-4 text-sm font-black text-slate-950 shadow-lg shadow-sky-950/20 transition hover:bg-sky-300 focus-within:ring-2 focus-within:ring-sky-200"
            >
              <Icon name="upload" className="size-4" />
              Pilih logo baru
              <input
                id="logo-upload-input"
                type="file"
                accept="image/png,image/jpeg,image/webp"
                onChange={handleLogoUpload}
                className="sr-only"
              />
            </label>
            {logoUrl ? (
              <button
                type="button"
                onClick={handleResetLogo}
                className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-white/10 bg-white/[0.05] px-4 text-sm font-bold text-slate-200 transition hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300"
              >
                <Icon name="reset" className="size-4" />
                Gunakan default
              </button>
            ) : null}
          </div>

          <p className="mt-4 text-xs leading-5 text-amber-100/70">
            Saat ini logo tersimpan di perangkat ini. Sinkronisasi logo lintas
            perangkat akan ditentukan pada tahap offline–online.
          </p>
        </section>

        <section className="app-panel rounded-3xl p-5 sm:p-7">
          <div className="flex items-start gap-4">
            <span className="grid size-11 shrink-0 place-items-center rounded-2xl border border-amber-300/20 bg-amber-300/10 text-amber-200">
              <Icon name="palette" className="size-5" />
            </span>
            <div>
              <h2 className="text-base font-black text-white">Sistem visual</h2>
              <p className="mt-1 text-sm leading-6 text-slate-400">
                Palet utama yang konsisten untuk Web dan Desktop.
              </p>
            </div>
          </div>

          <div className="mt-6 grid grid-cols-1 gap-2 sm:grid-cols-3">
            {[
              ["Putih", "bg-white", "#F8FAFC"],
              ["Biru muda", "bg-sky-400", "#38BDF8"],
              ["Gold", "bg-amber-300", "#F6C453"],
            ].map(([label, color, value]) => (
              <div
                key={label}
                className="rounded-2xl border border-white/10 bg-white/[0.04] p-3"
              >
                <span className={`block h-14 rounded-xl ${color}`} />
                <p className="mt-3 text-xs font-bold text-white">{label}</p>
                <p className="mt-0.5 text-[10px] text-slate-500">{value}</p>
              </div>
            ))}
          </div>

          <dl className="mt-6 divide-y divide-white/10 rounded-2xl border border-white/10 bg-slate-950/50 px-4">
            <div className="flex items-center justify-between gap-4 py-3 text-xs">
              <dt className="text-slate-400">Aplikasi</dt>
              <dd className="font-bold text-white">Absensi SPPG v0.1.0</dd>
            </div>
            <div className="flex items-center justify-between gap-4 py-3 text-xs">
              <dt className="text-slate-400">Frontend</dt>
              <dd className="font-bold text-sky-200">Next.js 16 · React 19</dd>
            </div>
            <div className="flex items-center justify-between gap-4 py-3 text-xs">
              <dt className="text-slate-400">Desktop</dt>
              <dd className="font-bold text-sky-200">Tauri 2</dd>
            </div>
            <div className="flex items-center justify-between gap-4 py-3 text-xs">
              <dt className="text-slate-400">Jaringan</dt>
              <dd
                className={
                  isOnline
                    ? "font-bold text-sky-200"
                    : "font-bold text-amber-200"
                }
              >
                {isOnline ? "Tersedia" : "Tidak tersedia"}
              </dd>
            </div>
          </dl>
        </section>
      </div>
    </AppShell>
  );
}
