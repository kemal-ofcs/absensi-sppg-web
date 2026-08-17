"use client";

import { redirect } from "next/navigation";
import type { ChangeEvent, FormEvent } from "react";
import { useEffect, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { BrandLogo } from "@/components/ui/BrandLogo";
import { Icon } from "@/components/ui/Icon";
import { Modal } from "@/components/ui/Modal";
import { PageHeader } from "@/components/ui/PageHeader";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { canAccessArea, hasPermission } from "@/lib/auth/access";
import { getCurrentCoordinates } from "@/lib/client/geolocation";
import { useAuth } from "@/lib/context/AuthContext";
import {
  getAutoAlfaSetting,
  type RingkasanAlfa,
  saveAutoAlfaSetting,
  triggerGenerateAlfa,
} from "@/lib/gateways/alfa";
import {
  type GeofenceSettings,
  getGeofenceSettings,
  saveGeofenceSettings,
} from "@/lib/gateways/geofence";
import {
  getScannerSafetySettings,
  type ScannerSafetySettings,
  saveScannerSafetySettings,
} from "@/lib/gateways/scanner-settings";
import {
  clearFailedSync,
  getSyncConflicts,
  getSyncStatus,
  isDesktopSyncAvailable,
  resolveSyncConflicts,
  retryFailedSync,
  type SyncConflict,
  type SyncStatus,
  syncNow,
} from "@/lib/gateways/sync-status";
import { resetAppLogo, saveAppLogo, useAppLogo } from "@/lib/hooks/useAppLogo";
import { useHydrated } from "@/lib/hooks/useHydrated";
import { useOnlineStatus } from "@/lib/hooks/useOnlineStatus";
import { validateGeofenceSettings } from "@/lib/validations/geofence";
import { validateScannerSafetySettings } from "@/lib/validations/scanner-settings";

const MAX_LOGO_SIZE = 1024 * 1024;
const ALLOWED_LOGO_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

const SYNC_TABLE_LABELS = [
  ["employees", "Karyawan"],
  ["idCards", "ID Card"],
  ["shifts", "Shift"],
  ["settings", "Pengaturan"],
  ["backups", "Penugasan backup"],
  ["corrections", "Koreksi"],
  ["imports", "Import offline"],
  ["attendance", "Absensi harian"],
  ["scanLogs", "Riwayat scan"],
] as const;

function formatSyncTime(timestamp: number | null | undefined) {
  if (!timestamp) return "Belum pernah berhasil";
  return new Intl.DateTimeFormat("id-ID", {
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(new Date(timestamp * 1000));
}

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
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null);
  const [conflicts, setConflicts] = useState<SyncConflict[]>([]);
  const [syncBusy, setSyncBusy] = useState(false);
  const [geofence, setGeofence] = useState<GeofenceSettings>({
    enabled: false,
    latitude: 0,
    longitude: 0,
    radiusMeter: 100,
  });
  const [geofenceBusy, setGeofenceBusy] = useState(false);
  const [scannerSafety, setScannerSafety] = useState<ScannerSafetySettings>({
    antiDoubleScanSeconds: 60,
    batasMultiScanMenit: 5,
  });
  const [scannerSafetyBusy, setScannerSafetyBusy] = useState(false);
  const [autoAlfaEnabled, setAutoAlfaEnabled] = useState(true);
  const [autoAlfaBusy, setAutoAlfaBusy] = useState(false);
  const [alfaTriggerBusy, setAlfaTriggerBusy] = useState(false);
  const [alfaModalResult, setAlfaModalResult] = useState<RingkasanAlfa | null>(
    null,
  );

  useEffect(() => {
    if (!isHydrated || !isAuthenticated) return;
    let cancelled = false;

    getAutoAlfaSetting()
      .then((enabled) => {
        if (!cancelled) setAutoAlfaEnabled(enabled);
      })
      .catch(() => undefined);

    if (!user?.isSuperadmin) return;
    setGeofenceBusy(true);
    setScannerSafetyBusy(true);
    getGeofenceSettings()
      .then((settings) => {
        if (!cancelled) setGeofence(settings);
      })
      .catch((error) => {
        if (!cancelled) {
          setFeedback({
            type: "error",
            message:
              error instanceof Error
                ? error.message
                : "Pengaturan geofencing tidak dapat dibaca.",
          });
        }
      })
      .finally(() => {
        if (!cancelled) setGeofenceBusy(false);
      });

    getScannerSafetySettings()
      .then((settings) => {
        if (!cancelled) setScannerSafety(settings);
      })
      .catch((error) => {
        if (!cancelled) {
          setFeedback({
            type: "error",
            message:
              error instanceof Error
                ? error.message
                : "Pengaturan keamanan scanner tidak dapat dibaca.",
          });
        }
      })
      .finally(() => {
        if (!cancelled) setScannerSafetyBusy(false);
      });

    return () => {
      cancelled = true;
    };
  }, [isAuthenticated, isHydrated, user?.isSuperadmin]);

  const handleAutoAlfaToggle = async (enabled: boolean) => {
    setAutoAlfaBusy(true);
    try {
      await saveAutoAlfaSetting(enabled);
      setAutoAlfaEnabled(enabled);
      setFeedback({
        type: "success",
        message: `Pengaturan Auto Alfa berhasil diubah menjadi ${enabled ? "Aktif" : "Nonaktif"}.`,
      });
    } catch (error) {
      setFeedback({
        type: "error",
        message:
          error instanceof Error
            ? error.message
            : "Gagal menyimpan pengaturan Auto Alfa.",
      });
    } finally {
      setAutoAlfaBusy(false);
    }
  };

  const handleTriggerAlfaNow = async () => {
    setAlfaTriggerBusy(true);
    try {
      const result = await triggerGenerateAlfa();
      setAlfaModalResult(result);
    } catch (error) {
      setFeedback({
        type: "error",
        message:
          error instanceof Error
            ? error.message
            : "Gagal menjalankan Generate Alfa manual.",
      });
    } finally {
      setAlfaTriggerBusy(false);
    }
  };

  const refreshSync = async (synchronize = false) => {
    setSyncBusy(true);
    try {
      const status = synchronize ? await syncNow() : await getSyncStatus();
      const conflictItems = await getSyncConflicts();
      setSyncStatus(status);
      setConflicts(conflictItems);
      if (synchronize)
        setFeedback({
          type: "success",
          message:
            "Sinkronisasi berhasil: event lokal terkirim dan snapshot server diterapkan ke database Desktop.",
        });
    } catch (error) {
      try {
        const [currentStatus, currentConflicts] = await Promise.all([
          getSyncStatus(),
          getSyncConflicts(),
        ]);
        setSyncStatus(currentStatus);
        setConflicts(currentConflicts);
      } catch {
        // Pesan utama tetap berasal dari kegagalan sinkronisasi.
      }
      setFeedback({
        type: "error",
        message:
          error instanceof Error
            ? error.message
            : "Status sinkronisasi tidak dapat dibaca.",
      });
    } finally {
      setSyncBusy(false);
    }
  };

  const retryFailed = async () => {
    setSyncBusy(true);
    try {
      const status = await retryFailedSync();
      setSyncStatus(status);
      setConflicts(await getSyncConflicts());
      setFeedback({
        type: "success",
        message: "Antrean gagal sudah dicoba ulang.",
      });
    } catch (error) {
      setFeedback({
        type: "error",
        message:
          error instanceof Error ? error.message : "Retry sinkronisasi gagal.",
      });
    } finally {
      setSyncBusy(false);
    }
  };

  const resolveConflicts = async (eventId?: string) => {
    setSyncBusy(true);
    try {
      const status = await resolveSyncConflicts(eventId);
      setSyncStatus(status);
      setConflicts(await getSyncConflicts());
      setFeedback({
        type: "success",
        message: eventId
          ? "Konflik berhasil diselesaikan (mengikuti master server)."
          : "Semua konflik berhasil diselesaikan (mengikuti master server).",
      });
    } catch (error) {
      setFeedback({
        type: "error",
        message:
          error instanceof Error
            ? error.message
            : "Gagal menyelesaikan konflik sinkronisasi.",
      });
    } finally {
      setSyncBusy(false);
    }
  };

  const clearFailed = async () => {
    setSyncBusy(true);
    try {
      const status = await clearFailedSync();
      setSyncStatus(status);
      setConflicts(await getSyncConflicts());
      setFeedback({
        type: "success",
        message: "Antrean gagal berhasil dibersihkan.",
      });
    } catch (error) {
      setFeedback({
        type: "error",
        message:
          error instanceof Error
            ? error.message
            : "Gagal membersihkan antrean gagal.",
      });
    } finally {
      setSyncBusy(false);
    }
  };

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

  const useCurrentLocation = async () => {
    setGeofenceBusy(true);
    const coordinates = await getCurrentCoordinates();
    setGeofenceBusy(false);
    if (!coordinates) {
      const isDesktop =
        typeof window !== "undefined" &&
        (window.navigator.userAgent.includes("Tauri") ||
          !window.navigator.onLine ||
          window.location.protocol === "tauri:");
      setFeedback({
        type: "error",
        message: isDesktop
          ? "Lokasi tidak dapat dideteksi. Di Desktop/Windows, pastikan izin 'Lokasi' untuk aplikasi ini sudah diaktifkan di Pengaturan Windows → Privasi & keamanan → Lokasi, lalu coba lagi."
          : "Lokasi tidak dapat dideteksi. Pastikan Anda mengizinkan akses lokasi di browser (klik ikon kunci / info di bilah alamat), lalu coba lagi. Jika menggunakan VPN atau firewall, nonaktifkan sementara.",
      });
      return;
    }
    setGeofence((current) => ({
      ...current,
      latitude: Number(coordinates.lat.toFixed(7)),
      longitude: Number(coordinates.lng.toFixed(7)),
    }));
    setFeedback({
      type: "success",
      message: "Koordinat perangkat berhasil dimasukkan ke form.",
    });
  };

  const handleGeofenceSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const validationMessage = Object.values(
      validateGeofenceSettings(geofence),
    )[0];
    if (validationMessage) {
      setFeedback({ type: "error", message: validationMessage });
      return;
    }
    setGeofenceBusy(true);
    try {
      setGeofence(await saveGeofenceSettings(geofence));
      setFeedback({
        type: "success",
        message: geofence.enabled
          ? "Geofencing aktif. Scan kini wajib berada di dalam radius kantor."
          : "Geofencing dinonaktifkan.",
      });
    } catch (error) {
      setFeedback({
        type: "error",
        message:
          error instanceof Error
            ? error.message
            : "Pengaturan geofencing gagal disimpan.",
      });
    } finally {
      setGeofenceBusy(false);
    }
  };

  const handleScannerSafetySubmit = async (
    event: FormEvent<HTMLFormElement>,
  ) => {
    event.preventDefault();
    const validationMessage = Object.values(
      validateScannerSafetySettings(scannerSafety),
    )[0];
    if (validationMessage) {
      setFeedback({ type: "error", message: validationMessage });
      return;
    }
    setScannerSafetyBusy(true);
    try {
      setScannerSafety(await saveScannerSafetySettings(scannerSafety));
      setFeedback({
        type: "success",
        message:
          "Pengaturan keamanan scanner dan multi-scan berhasil disimpan.",
      });
    } catch (error) {
      setFeedback({
        type: "error",
        message:
          error instanceof Error
            ? error.message
            : "Pengaturan keamanan scanner gagal disimpan.",
      });
    } finally {
      setScannerSafetyBusy(false);
    }
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

      {user?.isSuperadmin ? (
        <section className="app-panel rounded-3xl p-5 sm:p-7">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div className="flex items-start gap-4">
              <span className="grid size-11 shrink-0 place-items-center rounded-2xl border border-emerald-300/20 bg-emerald-300/10 text-emerald-200">
                <Icon name="scanner" className="size-5" />
              </span>
              <div>
                <h2 className="text-base font-black text-white">
                  Lokasi kantor & geofencing
                </h2>
                <p className="mt-1 max-w-2xl text-sm leading-6 text-slate-400">
                  Saat aktif, setiap scan wajib mengirim GPS dan berada di dalam
                  radius kantor. Scan tanpa lokasi atau di luar area akan
                  ditolak dan tetap dicatat pada Riwayat.
                </p>
              </div>
            </div>
            <StatusBadge tone={geofence.enabled ? "info" : "neutral"}>
              {geofence.enabled ? "Geofencing aktif" : "Geofencing nonaktif"}
            </StatusBadge>
          </div>

          <form
            onSubmit={handleGeofenceSubmit}
            className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4"
          >
            <label className="space-y-1.5 text-xs font-bold text-slate-300">
              Latitude kantor
              <input
                type="number"
                step="any"
                min={-90}
                max={90}
                value={geofence.latitude}
                onChange={(event) =>
                  setGeofence((current) => ({
                    ...current,
                    latitude: Number(event.target.value),
                  }))
                }
                className="min-h-11 w-full rounded-xl border border-white/10 bg-slate-950 px-3 font-mono text-white outline-none focus:border-sky-400"
              />
            </label>
            <label className="space-y-1.5 text-xs font-bold text-slate-300">
              Longitude kantor
              <input
                type="number"
                step="any"
                min={-180}
                max={180}
                value={geofence.longitude}
                onChange={(event) =>
                  setGeofence((current) => ({
                    ...current,
                    longitude: Number(event.target.value),
                  }))
                }
                className="min-h-11 w-full rounded-xl border border-white/10 bg-slate-950 px-3 font-mono text-white outline-none focus:border-sky-400"
              />
            </label>
            <label className="space-y-1.5 text-xs font-bold text-slate-300">
              Radius maksimal (meter)
              <input
                type="number"
                min={10}
                max={10_000}
                step={1}
                value={geofence.radiusMeter}
                onChange={(event) =>
                  setGeofence((current) => ({
                    ...current,
                    radiusMeter: Number(event.target.value),
                  }))
                }
                className="min-h-11 w-full rounded-xl border border-white/10 bg-slate-950 px-3 font-mono text-white outline-none focus:border-sky-400"
              />
            </label>
            <label className="flex min-h-11 items-center gap-3 self-end rounded-xl border border-white/10 bg-slate-950 px-4 text-xs font-bold text-white">
              <input
                type="checkbox"
                checked={geofence.enabled}
                onChange={(event) =>
                  setGeofence((current) => ({
                    ...current,
                    enabled: event.target.checked,
                  }))
                }
                className="size-4 accent-sky-400"
              />
              Wajibkan lokasi saat scan
            </label>

            <div className="flex flex-col gap-2 sm:col-span-2 sm:flex-row lg:col-span-4">
              <button
                type="button"
                disabled={geofenceBusy}
                onClick={useCurrentLocation}
                className="min-h-11 rounded-xl border border-white/10 bg-white/[0.05] px-4 text-xs font-bold text-slate-200 disabled:opacity-50"
              >
                Gunakan lokasi perangkat ini
              </button>
              <button
                type="submit"
                disabled={geofenceBusy || !isOnline}
                className="min-h-11 rounded-xl bg-sky-400 px-5 text-xs font-black text-slate-950 disabled:opacity-50"
              >
                {geofenceBusy ? "Memproses..." : "Simpan pengaturan lokasi"}
              </button>
            </div>
            {!isOnline ? (
              <p className="text-xs text-amber-200 sm:col-span-2 lg:col-span-4">
                Perubahan lokasi global memerlukan koneksi online agar konsisten
                di seluruh perangkat.
              </p>
            ) : null}
          </form>
        </section>
      ) : null}

      {user?.isSuperadmin ? (
        <section className="app-panel rounded-3xl p-5 sm:p-7">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div className="flex items-start gap-4">
              <span className="grid size-11 shrink-0 place-items-center rounded-2xl border border-sky-300/20 bg-sky-300/10 text-sky-200">
                <Icon name="tools" className="size-5" />
              </span>
              <div>
                <h2 className="text-base font-black text-white">
                  Keamanan Pemindai & Anti Double-Scan
                </h2>
                <p className="mt-1 max-w-2xl text-sm leading-6 text-slate-400">
                  Konfigurasikan durasi perlindungan multi-scan dan jeda
                  cooldown pemindaian untuk mencegah scan ganda atau salah
                  deteksi shift secara otomatis.
                </p>
              </div>
            </div>
            <StatusBadge tone="info">
              {scannerSafety.batasMultiScanMenit > 0
                ? `Multi-Scan: ${scannerSafety.batasMultiScanMenit} mnt`
                : "Multi-Scan nonaktif"}
            </StatusBadge>
          </div>

          <form
            onSubmit={handleScannerSafetySubmit}
            className="mt-6 grid gap-6 sm:grid-cols-2"
          >
            <div className="space-y-2 rounded-2xl border border-white/10 bg-slate-950/60 p-4">
              <label
                htmlFor="batas-multi-scan-input"
                className="block text-xs font-bold text-slate-300"
              >
                Batas Multi-Scan Masuk (Menit)
              </label>
              <p className="text-[11px] leading-5 text-slate-500">
                Scan masuk ulang dalam kurun waktu ini akan ditolak agar tidak
                dianggap sebagai scan pulang atau duplikat (Default: 5 menit).
              </p>
              <div className="flex items-center gap-3 pt-1">
                <input
                  id="batas-multi-scan-input"
                  type="number"
                  min={0}
                  max={120}
                  step={1}
                  value={scannerSafety.batasMultiScanMenit}
                  onChange={(event) =>
                    setScannerSafety((current) => ({
                      ...current,
                      batasMultiScanMenit: Math.max(
                        0,
                        Number(event.target.value),
                      ),
                    }))
                  }
                  className="min-h-11 w-32 rounded-xl border border-white/10 bg-slate-950 px-3 font-mono text-white outline-none focus:border-sky-400"
                />
                <span className="text-xs font-medium text-slate-400">
                  Menit
                </span>
              </div>
              <div className="flex flex-wrap gap-1.5 pt-1">
                {[1, 3, 5, 10, 15].map((val) => (
                  <button
                    key={val}
                    type="button"
                    onClick={() =>
                      setScannerSafety((c) => ({
                        ...c,
                        batasMultiScanMenit: val,
                      }))
                    }
                    className={`rounded-lg border px-2.5 py-1 font-mono text-xs font-semibold transition ${
                      scannerSafety.batasMultiScanMenit === val
                        ? "border-sky-400 bg-sky-400/20 text-sky-200"
                        : "border-white/10 bg-white/[0.04] text-slate-400 hover:text-white"
                    }`}
                  >
                    {val} mnt
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-2 rounded-2xl border border-white/10 bg-slate-950/60 p-4">
              <label
                htmlFor="cooldown-anti-double-input"
                className="block text-xs font-bold text-slate-300"
              >
                Cooldown Anti Double-Scan (Detik)
              </label>
              <p className="text-[11px] leading-5 text-slate-500">
                Jeda waktu minimal sebelum scanner membaca kembali QR/kartu yang
                sama guna mencegah scan instan berturut-turut (Default: 60
                detik).
              </p>
              <div className="flex items-center gap-3 pt-1">
                <input
                  id="cooldown-anti-double-input"
                  type="number"
                  min={0}
                  max={600}
                  step={5}
                  value={scannerSafety.antiDoubleScanSeconds}
                  onChange={(event) =>
                    setScannerSafety((current) => ({
                      ...current,
                      antiDoubleScanSeconds: Math.max(
                        0,
                        Number(event.target.value),
                      ),
                    }))
                  }
                  className="min-h-11 w-32 rounded-xl border border-white/10 bg-slate-950 px-3 font-mono text-white outline-none focus:border-sky-400"
                />
                <span className="text-xs font-medium text-slate-400">
                  Detik (
                  {Math.round((scannerSafety.antiDoubleScanSeconds / 60) * 10) /
                    10}{" "}
                  mnt)
                </span>
              </div>
              <div className="flex flex-wrap gap-1.5 pt-1">
                {[10, 30, 60, 120, 300].map((val) => (
                  <button
                    key={val}
                    type="button"
                    onClick={() =>
                      setScannerSafety((c) => ({
                        ...c,
                        antiDoubleScanSeconds: val,
                      }))
                    }
                    className={`rounded-lg border px-2.5 py-1 font-mono text-xs font-semibold transition ${
                      scannerSafety.antiDoubleScanSeconds === val
                        ? "border-sky-400 bg-sky-400/20 text-sky-200"
                        : "border-white/10 bg-white/[0.04] text-slate-400 hover:text-white"
                    }`}
                  >
                    {val >= 60 ? `${val / 60} mnt` : `${val} dtk`}
                  </button>
                ))}
              </div>
            </div>

            <div className="sm:col-span-2">
              <button
                type="submit"
                disabled={scannerSafetyBusy}
                className="min-h-11 rounded-xl bg-sky-400 px-5 text-xs font-black text-slate-950 shadow-lg shadow-sky-950/20 transition hover:bg-sky-300 disabled:opacity-50"
              >
                {scannerSafetyBusy
                  ? "Menyimpan..."
                  : "Simpan Pengaturan Scanner"}
              </button>
            </div>
          </form>
        </section>
      ) : null}

      {hasPermission(user, "settings.manage") ||
      hasPermission(user, "alfa.trigger") ? (
        <section className="app-panel rounded-3xl p-5 sm:p-7">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div className="flex items-start gap-4">
              <span className="grid size-11 shrink-0 place-items-center rounded-2xl border border-amber-300/20 bg-amber-300/10 text-amber-200">
                <Icon name="clock" className="size-5" />
              </span>
              <div>
                <h2 className="text-base font-black text-white">
                  Otomasi Generate Alfa Harian
                </h2>
                <p className="mt-1 max-w-2xl text-sm leading-6 text-slate-400">
                  Secara otomatis membuat entri status Alfa untuk karyawan aktif
                  sesi NORMAL yang belum hadir atau tidak memiliki koreksi
                  Sakit/Izin/Dispen setelah batas cutoff shift (jam pulang
                  dikurangi offset). Pada hari libur aktif, Generate Alfa
                  otomatis dinonaktifkan.
                </p>
              </div>
            </div>
            <StatusBadge tone={autoAlfaEnabled ? "success" : "neutral"}>
              {autoAlfaEnabled ? "Auto-Alfa Aktif" : "Auto-Alfa Nonaktif"}
            </StatusBadge>
          </div>

          <div className="mt-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between rounded-2xl border border-white/10 bg-slate-950/60 p-5">
            <div className="space-y-1">
              <span className="text-sm font-bold text-white">
                Status Otomasi Generate Alfa
              </span>
              <p className="text-xs text-slate-400">
                Matikan tombol ini jika Anda ingin menangguhkan penandaan Alfa
                otomatis di seluruh sistem.
              </p>
            </div>
            <div className="flex items-center gap-4">
              {hasPermission(user, "settings.manage") ? (
                <label className="relative inline-flex cursor-pointer items-center">
                  <input
                    type="checkbox"
                    checked={autoAlfaEnabled}
                    disabled={autoAlfaBusy}
                    onChange={(e) => handleAutoAlfaToggle(e.target.checked)}
                    className="sr-only peer"
                  />
                  <div className="h-6 w-11 rounded-full bg-slate-800 peer peer-checked:bg-amber-400 peer-focus:outline-none after:absolute after:top-0.5 after:left-[2px] after:h-5 after:w-5 after:rounded-full after:border after:border-slate-300 after:bg-white after:transition-all after:content-[''] peer-checked:after:translate-x-full peer-checked:after:border-white disabled:opacity-50" />
                </label>
              ) : null}
            </div>
          </div>

          {hasPermission(user, "alfa.trigger") ? (
            <div className="mt-4 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between rounded-2xl border border-white/10 bg-white/[0.02] p-5">
              <div>
                <span className="text-sm font-bold text-white">
                  Jalankan Generate Alfa Sekarang
                </span>
                <p className="text-xs text-slate-400">
                  Evaluasi kehadiran seluruh karyawan aktif saat ini dan tandai
                  Alfa bagi yang telah melewati batas waktu cutoff.
                </p>
              </div>
              <button
                type="button"
                disabled={alfaTriggerBusy}
                onClick={handleTriggerAlfaNow}
                className="flex items-center gap-2 rounded-xl bg-amber-400 px-5 py-2.5 text-xs font-bold text-slate-950 shadow-lg shadow-amber-400/20 transition hover:bg-amber-300 disabled:opacity-50 active:scale-95 shrink-0"
              >
                {alfaTriggerBusy ? (
                  <Icon name="clock" className="size-4 animate-spin" />
                ) : (
                  <Icon name="check" className="size-4" />
                )}
                <span>
                  {alfaTriggerBusy ? "Memproses..." : "Eksekusi Sekarang"}
                </span>
              </button>
            </div>
          ) : null}
        </section>
      ) : null}

      {isDesktopSyncAvailable() && hasPermission(user, "sync.view") ? (
        <section className="app-panel rounded-3xl p-5 sm:p-7">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <h2 className="text-base font-black text-white">
                Sinkronisasi Desktop
              </h2>
              <p className="mt-1 text-sm text-slate-400">
                Perubahan lokal dikirim ke server, kemudian snapshot operasional
                server diterapkan kembali ke database Desktop.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                disabled={syncBusy}
                onClick={() => refreshSync(false)}
                className="min-h-10 rounded-xl border border-white/10 px-4 text-xs font-bold text-slate-200 disabled:opacity-50"
              >
                Periksa status
              </button>
              <button
                type="button"
                disabled={syncBusy || !isOnline}
                onClick={() => refreshSync(true)}
                className="min-h-10 rounded-xl bg-sky-400 px-4 text-xs font-black text-slate-950 disabled:opacity-50"
              >
                Sinkronkan sekarang
              </button>
              {hasPermission(user, "sync.retry") &&
              (syncStatus?.failed ?? 0) > 0 ? (
                <>
                  <button
                    type="button"
                    disabled={syncBusy || !isOnline}
                    onClick={retryFailed}
                    className="min-h-10 rounded-xl bg-amber-300 px-4 text-xs font-black text-slate-950 disabled:opacity-50"
                  >
                    Coba ulang gagal
                  </button>
                  <button
                    type="button"
                    disabled={syncBusy}
                    onClick={clearFailed}
                    className="min-h-10 rounded-xl border border-rose-400/40 bg-rose-400/10 px-4 text-xs font-bold text-rose-200 hover:bg-rose-400/20 disabled:opacity-50"
                  >
                    Bersihkan antrean gagal
                  </button>
                </>
              ) : null}
            </div>
          </div>
          <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[
              ["Menunggu", syncStatus?.pending ?? 0],
              ["Event terkirim (total)", syncStatus?.synced ?? 0],
              ["Gagal", syncStatus?.failed ?? 0],
              ["Konflik", syncStatus?.conflict ?? 0],
            ].map(([label, value]) => (
              <div
                key={label}
                className="rounded-2xl border border-white/10 bg-slate-950/50 p-4"
              >
                <p className="text-xs text-slate-400">{label}</p>
                <p className="mt-1 text-2xl font-black text-white">{value}</p>
              </div>
            ))}
          </div>
          <div className="mt-4 rounded-2xl border border-white/10 bg-slate-950/50 p-4">
            <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-sm font-black text-white">
                Snapshot operasional lokal
              </p>
              <p className="text-xs text-slate-400">
                Terakhir berhasil: {formatSyncTime(syncStatus?.lastSyncAt)} ·
                Revisi {syncStatus?.lastRevision ?? 0}
              </p>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
              {SYNC_TABLE_LABELS.map(([key, label]) => (
                <div
                  key={key}
                  className="rounded-xl border border-white/5 bg-white/[0.03] px-3 py-2"
                >
                  <p className="text-[11px] text-slate-400">{label}</p>
                  <p className="mt-0.5 text-lg font-black text-white">
                    {syncStatus?.tableCounts?.[key] ?? 0}
                  </p>
                </div>
              ))}
            </div>
            <p className="mt-3 text-xs leading-5 text-slate-400">
              Snapshot mencakup sembilan tabel operasional di atas. Riwayat
              absensi, koreksi, backup, dan import dibatasi 31 hari terakhir;
              riwayat scan maksimal 5.000 baris. Operator, role, session, dan
              audit keamanan tetap dikelola server dan tidak disalin ke database
              operasional offline.
            </p>
          </div>
          {conflicts.length > 0 ? (
            <div className="mt-5 rounded-2xl border border-rose-400/20 bg-rose-400/5 p-4">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="text-sm font-black text-rose-100">
                    Konflik perlu ditinjau ({conflicts.length})
                  </p>
                  <p className="mt-0.5 text-xs text-slate-400">
                    Konflik terjadi saat data lokal berbeda versi dengan master
                    server.
                  </p>
                </div>
                {hasPermission(user, "sync.retry") ? (
                  <button
                    type="button"
                    disabled={syncBusy}
                    onClick={() => resolveConflicts()}
                    className="min-h-9 self-start rounded-xl bg-rose-400/20 px-3.5 text-xs font-black text-rose-100 hover:bg-rose-400/30 disabled:opacity-50 sm:self-auto"
                  >
                    Selesaikan Semua (Ikuti Server)
                  </button>
                ) : null}
              </div>
              <ul className="mt-3 space-y-2 text-xs text-rose-100/80">
                {conflicts.slice(0, 10).map((item) => (
                  <li
                    key={item.eventId}
                    className="flex flex-col gap-1 rounded-xl border border-rose-400/10 bg-slate-950/40 p-3 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div>
                      <span className="font-bold">
                        {item.domain} · {item.entityKey}
                      </span>{" "}
                      — {item.reason}
                    </div>
                    {hasPermission(user, "sync.retry") ? (
                      <button
                        type="button"
                        disabled={syncBusy}
                        onClick={() => resolveConflicts(item.eventId)}
                        className="self-end shrink-0 rounded-lg border border-white/10 px-2.5 py-1 text-[11px] font-bold text-slate-200 hover:bg-white/10 disabled:opacity-50 sm:self-auto"
                      >
                        Selesaikan
                      </button>
                    ) : null}
                  </li>
                ))}
              </ul>
              <p className="mt-3 text-xs text-slate-400">
                Menyelesaikan konflik akan menandai antrean selesai dan
                mempertahankan snapshot master dari server.
              </p>
            </div>
          ) : null}
        </section>
      ) : null}

      {alfaModalResult ? (
        <Modal
          titleId="alfa-modal-summary"
          onClose={() => setAlfaModalResult(null)}
          title="Ringkasan Eksekusi Generate Alfa"
        >
          <div className="space-y-4">
            <div
              className={`rounded-2xl border p-4 ${
                alfaModalResult.status === "SELESAI"
                  ? "border-emerald-500/20 bg-emerald-500/10 text-emerald-300"
                  : alfaModalResult.status === "LIBUR"
                    ? "border-amber-500/20 bg-amber-500/10 text-amber-300"
                    : "border-sky-500/20 bg-sky-500/10 text-sky-300"
              }`}
            >
              <div className="flex items-center gap-2 font-bold">
                <Icon
                  name={
                    alfaModalResult.status === "SELESAI" ? "check" : "calendar"
                  }
                  className="size-5"
                />
                <span>Status: {alfaModalResult.status}</span>
              </div>
              <p className="mt-1 text-xs">{alfaModalResult.pesan}</p>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-xl border border-white/10 bg-slate-950/60 p-3">
                <div className="text-[11px] text-slate-400">
                  Alfa Baru Dibuat
                </div>
                <div className="text-xl font-black text-amber-400">
                  {alfaModalResult.jumlahAlfaDibuat}
                </div>
              </div>
              <div className="rounded-xl border border-white/10 bg-slate-950/60 p-3">
                <div className="text-[11px] text-slate-400">
                  Sudah Ada / Hadir
                </div>
                <div className="text-xl font-black text-emerald-400">
                  {alfaModalResult.jumlahSudahAda}
                </div>
              </div>
              <div className="rounded-xl border border-white/10 bg-slate-950/60 p-3">
                <div className="text-[11px] text-slate-400">
                  Belum Cutoff Shift
                </div>
                <div className="text-xl font-black text-sky-400">
                  {alfaModalResult.jumlahBelumWaktunya}
                </div>
              </div>
              <div className="rounded-xl border border-white/10 bg-slate-950/60 p-3">
                <div className="text-[11px] text-slate-400">
                  Shift Fleksibel
                </div>
                <div className="text-xl font-black text-purple-400">
                  {alfaModalResult.jumlahFleksibel}
                </div>
              </div>
            </div>

            <div className="flex justify-end pt-2">
              <button
                type="button"
                onClick={() => setAlfaModalResult(null)}
                className="rounded-xl bg-sky-500 px-5 py-2 text-xs font-bold text-white shadow-lg shadow-sky-500/20 transition hover:bg-sky-400"
              >
                Tutup Ringkasan
              </button>
            </div>
          </div>
        </Modal>
      ) : null}
    </AppShell>
  );
}
