"use client";

import type { IScannerControls } from "@zxing/browser";
import Link from "next/link";
import { redirect } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { canAccessArea, hasPermission } from "@/lib/auth/access";
import { useAuth } from "@/lib/context/AuthContext";
import type { ScanResult } from "@/lib/contracts/scanner";
import {
  getCurrentCoordinates,
  type ScanTerminalInput,
  submitTerminalScan,
} from "@/lib/gateways/scanner";
import { useClock } from "@/lib/hooks/useClock";
import { useHydrated } from "@/lib/hooks/useHydrated";
import { audioSynth } from "@/lib/utils/audio";

interface ScanLogItem {
  id: string;
  waktu: string;
  nama: string;
  idUnik: string;
  divisi: string;
  jenisScan: string;
  statusProses: string;
  pesan: string;
  sukses: boolean;
}

export default function ScannerPage() {
  const isHydrated = useHydrated();
  const { user, isAuthenticated, isLoading: authLoading } = useAuth();
  const clock = useClock();

  const [mode, setMode] = useState<"camera" | "reader">("camera");
  const [scanInput, setScanInput] = useState<string>("");
  const [isProcessing, setIsProcessing] = useState<boolean>(false);
  const [audioEnabled, setAudioEnabled] = useState<boolean>(true);
  const [gpsLocation, setGpsLocation] = useState<{
    lat: number;
    lng: number;
  } | null>(null);
  const [lastResult, setLastResult] = useState<ScanResult | null>(null);
  const [scanHistory, setScanHistory] = useState<ScanLogItem[]>([]);
  const [cameraActive, setCameraActive] = useState(false);
  const [cameraMessage, setCameraMessage] = useState<string | null>(null);
  const [cameraDevices, setCameraDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>("");
  const [scanFlashStatus, setScanFlashStatus] = useState<
    "success" | "warning" | "error" | null
  >(null);

  const inputRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const scannerControlsRef = useRef<IScannerControls | null>(null);
  const cameraScanLockedRef = useRef(false);
  const lastScannedQrRef = useRef<string>("");
  const lastScannedTimeRef = useRef<number>(0);

  const connectScannerInput = useCallback((node: HTMLInputElement | null) => {
    inputRef.current = node;
    node?.focus();
  }, []);

  const stopCamera = useCallback(() => {
    scannerControlsRef.current?.stop();
    scannerControlsRef.current = null;
    const stream = videoRef.current?.srcObject;
    if (stream instanceof MediaStream) {
      for (const track of stream.getTracks()) track.stop();
    }
    if (videoRef.current) videoRef.current.srcObject = null;
    setCameraActive(false);
  }, []);

  const currentTime = clock
    ? clock.toLocaleTimeString("id-ID", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })
    : "--:--:--";
  const currentDate = clock
    ? clock.toLocaleDateString("id-ID", {
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
      })
    : "Memuat waktu...";

  // Fetch Location GPS safely
  useEffect(() => {
    if (!isHydrated) return;

    let isMounted = true;
    getCurrentCoordinates().then((coords) => {
      if (coords && isMounted) {
        setGpsLocation(coords);
      }
    });
    return () => {
      isMounted = false;
    };
  }, [isHydrated]);

  // Load available video input devices
  useEffect(() => {
    if (
      !isHydrated ||
      typeof navigator === "undefined" ||
      !navigator.mediaDevices?.enumerateDevices
    )
      return;

    navigator.mediaDevices
      .enumerateDevices()
      .then((devices) => {
        const videoDevs = devices.filter((d) => d.kind === "videoinput");
        setCameraDevices(videoDevs);
        if (videoDevs.length > 0 && !selectedDeviceId) {
          setSelectedDeviceId(videoDevs[0]?.deviceId ?? "");
        }
      })
      .catch(() => undefined);
  }, [isHydrated, selectedDeviceId]);

  useEffect(() => stopCamera, [stopCamera]);

  const handleScanSubmit = useCallback(
    async (payload: string) => {
      const cleanPayload = payload.trim();
      if (!cleanPayload || isProcessing) return;

      setIsProcessing(true);
      setScanInput("");

      try {
        const currentLocation = gpsLocation ?? (await getCurrentCoordinates());
        if (currentLocation && !gpsLocation) setGpsLocation(currentLocation);
        const input: ScanTerminalInput = {
          qrContent: cleanPayload,
          lat: currentLocation?.lat,
          lng: currentLocation?.lng,
          kodeOperator: user?.kode_operator || "OP001",
          sumberData: "Scanner",
        };

        const result = await submitTerminalScan(input);
        setLastResult(result);

        // Visual flash feedback
        if (result.sukses) {
          setScanFlashStatus("success");
        } else if (
          result.pesan.includes("Scan ganda") ||
          result.pesan.includes("cooldown")
        ) {
          setScanFlashStatus("warning");
        } else {
          setScanFlashStatus("error");
        }
        setTimeout(() => setScanFlashStatus(null), 700);

        // Suara & Audio feedback + TTS Pengumuman
        if (audioEnabled) {
          if (result.sukses) {
            audioSynth.playSuccessBeep();
            const namaPanggilan =
              result.nama?.split(" ")[0] || result.nama || "Karyawan";
            if (result.jenisScan === "Masuk") {
              audioSynth.speak(
                `Terima kasih, ${namaPanggilan}. Absen masuk tercatat.`,
              );
            } else if (result.jenisScan === "Pulang") {
              audioSynth.speak(
                `Terima kasih, ${namaPanggilan}. Absen pulang tercatat.`,
              );
            } else {
              audioSynth.speak(`Terima kasih, ${namaPanggilan}.`);
            }
          } else if (
            result.pesan.includes("Scan ganda") ||
            result.pesan.includes("cooldown")
          ) {
            audioSynth.playWarningBeep();
            audioSynth.speak("Scan ganda terdeteksi. Silakan tunggu sebentar.");
          } else {
            audioSynth.playErrorBeep();
            audioSynth.speak("Scan ditolak.");
          }
        }

        // Catat ke riwayat lokal UI
        const now = new Date();
        const timeStr = now.toLocaleTimeString("id-ID", {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        });

        setScanHistory((prev) => [
          {
            id: `${now.getTime()}-${result.idKaryawan || cleanPayload}`,
            waktu: timeStr,
            nama: result.nama || result.idKaryawan || "Karyawan",
            idUnik: result.idKaryawan || "-",
            divisi: result.divisi || "-",
            jenisScan: result.jenisScan || "Masuk",
            statusProses: result.status || "Selesai",
            pesan: result.pesan,
            sukses: result.sukses,
          },
          ...prev.slice(0, 15),
        ]);
      } catch (err: unknown) {
        const errMsg =
          err instanceof Error ? err.message : "Gagal memproses scan.";
        setScanFlashStatus("error");
        setTimeout(() => setScanFlashStatus(null), 700);

        setLastResult({
          sukses: false,
          status: "Error",
          jenisScan: "Error",
          idKaryawan: "-",
          nama: "-",
          divisi: "-",
          pesan: `System Error: ${errMsg}`,
        });
        if (audioEnabled) {
          audioSynth.playErrorBeep();
          audioSynth.speak("Terjadi kesalahan sistem.");
        }
      } finally {
        setIsProcessing(false);
        if (mode === "reader") inputRef.current?.focus();
      }
    },
    [isProcessing, gpsLocation, user, audioEnabled, mode],
  );

  const startCamera = async (deviceId?: string) => {
    setCameraMessage(null);
    cameraScanLockedRef.current = false;
    lastScannedQrRef.current = "";
    lastScannedTimeRef.current = 0;

    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraMessage("Kamera tidak tersedia pada perangkat ini.");
      return;
    }

    try {
      const video = videoRef.current;
      if (!video) {
        stopCamera();
        return;
      }

      // Hentikan stream lama jika sedang berjalan sebelum ganti device
      if (scannerControlsRef.current) {
        scannerControlsRef.current.stop();
        scannerControlsRef.current = null;
      }

      const { BrowserQRCodeReader } = await import("@zxing/browser");
      const reader = new BrowserQRCodeReader(undefined, {
        delayBetweenScanAttempts: 100,
      });

      const targetDeviceId = deviceId || selectedDeviceId;
      const constraints: MediaStreamConstraints = {
        audio: false,
        video: targetDeviceId
          ? { deviceId: { exact: targetDeviceId } }
          : { facingMode: { ideal: "environment" } },
      };

      const controls = await reader.decodeFromConstraints(
        constraints,
        video,
        (result) => {
          const qrContent = result?.getText().trim();
          if (!qrContent) return;

          const now = Date.now();
          // Cek apakah scan sedang diproses ATAU qr yang sama baru saja dipindai dalam 2 detik
          if (
            cameraScanLockedRef.current ||
            (qrContent === lastScannedQrRef.current &&
              now - lastScannedTimeRef.current < 2000)
          ) {
            return;
          }

          cameraScanLockedRef.current = true;
          lastScannedQrRef.current = qrContent;
          lastScannedTimeRef.current = now;

          // Eksekusi proses scan secara asynchronous TANPA mematikan kamera!
          void handleScanSubmit(qrContent).finally(() => {
            // Beri jeda singkat agar kartu yang sama tidak langsung ter-scan ulang seketika
            setTimeout(() => {
              cameraScanLockedRef.current = false;
            }, 1200);
          });
        },
      );

      scannerControlsRef.current = controls;
      setCameraActive(true);
    } catch (error: unknown) {
      stopCamera();
      setCameraMessage(
        error instanceof Error
          ? error.message
          : "Izin kamera ditolak atau kamera tidak dapat dibuka.",
      );
    }
  };

  // QR reader USB/wireless biasanya mengirim payload seperti input keyboard.
  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleScanSubmit(scanInput);
    }
  };

  if (!isHydrated || authLoading) {
    return (
      <div className="min-h-screen bg-slate-950 flex flex-col items-center justify-center p-6 text-slate-100 font-sans">
        <div className="flex flex-col items-center gap-3">
          <div className="w-10 h-10 border-4 border-sky-500 border-t-transparent rounded-full animate-spin"></div>
          <p className="text-xs text-slate-400 font-mono animate-pulse">
            Memuat Terminal QR...
          </p>
        </div>
      </div>
    );
  }

  if (!isAuthenticated) redirect("/login");
  if (!canAccessArea(user, "scanner")) redirect("/forbidden");

  return (
    <AppShell contentClassName="select-none overflow-x-hidden">
      {/* Header Bar Terminal */}
      <header className="flex min-h-16 flex-col gap-3 border-b border-slate-800 bg-slate-900/60 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <div className="flex items-center gap-4">
          <div>
            <h1 className="text-sm font-bold text-white tracking-wide flex items-center gap-2">
              <span className="w-2.5 h-2.5 bg-sky-400 rounded-full animate-ping"></span>
              TERMINAL QR ABSENSI SPPG
            </h1>
            <p className="text-[11px] text-slate-400 font-mono">
              Operator: {user?.nama_operator} ({user?.kode_operator}) |
              Location:{" "}
              {gpsLocation
                ? `${gpsLocation.lat.toFixed(4)}, ${gpsLocation.lng.toFixed(4)}`
                : "GPS belum tersedia"}
            </p>
          </div>
        </div>

        <div className="flex w-full items-center justify-between gap-4 sm:w-auto sm:justify-start sm:gap-6">
          {/* Audio & Status Toggle */}
          <button
            type="button"
            onClick={() => setAudioEnabled(!audioEnabled)}
            className={`px-3 py-1 rounded-full text-xs font-mono font-medium transition border ${
              audioEnabled
                ? "bg-sky-500/20 text-sky-300 border-sky-500/40"
                : "bg-slate-800 text-slate-400 border-slate-700"
            }`}
          >
            {audioEnabled ? "🔊 Suara: ON" : "🔇 Suara: OFF"}
          </button>

          {/* Clock Display */}
          <div className="text-right">
            <div className="text-lg font-bold font-mono tracking-widest text-amber-400">
              {currentTime}
            </div>
            <div className="text-[11px] text-slate-400">{currentDate}</div>
          </div>
        </div>
      </header>

      {/* Main Terminal View */}
      <div className="grid flex-1 grid-cols-1 gap-6 overflow-visible p-3 sm:p-6 lg:grid-cols-12 lg:overflow-hidden">
        {/* Left Side: Scanner Input & Active Result Display (7 Cols) */}
        <div className="lg:col-span-7 flex flex-col space-y-6">
          {/* Mode Switch Tabs */}
          <div className="flex flex-col items-stretch gap-2 rounded-xl border border-slate-800 bg-slate-900/60 p-1.5 sm:flex-row">
            <button
              type="button"
              onClick={() => {
                stopCamera();
                setMode("camera");
              }}
              className={`flex-1 py-2.5 rounded-lg text-xs font-semibold transition flex items-center justify-center gap-2 ${
                mode === "camera"
                  ? "bg-gradient-to-r from-sky-600 to-sky-500 text-white shadow-lg shadow-sky-950/60 font-bold"
                  : "text-slate-400 hover:text-slate-200"
              }`}
            >
              Kamera QR Otomatis
            </button>
            <button
              type="button"
              onClick={() => {
                stopCamera();
                setMode("reader");
              }}
              className={`flex-1 py-2.5 rounded-lg text-xs font-semibold transition flex items-center justify-center gap-2 ${
                mode === "reader"
                  ? "bg-gradient-to-r from-sky-600 to-sky-500 text-white shadow-lg shadow-sky-950/60 font-bold"
                  : "text-slate-400 hover:text-slate-200"
              }`}
            >
              QR Reader USB / Wireless
            </button>
          </div>

          {/* Scanner Input Panel */}
          {mode === "camera" ? (
            <div className="space-y-4 rounded-2xl border border-slate-800 bg-slate-900 p-4 sm:p-6">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <h2 className="text-xs font-bold uppercase tracking-wider text-slate-300 flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
                    Kamera Pemindai QR Berkelanjutan
                  </h2>
                  <p className="mt-0.5 text-[11px] text-slate-500">
                    Arahkan QR kartu ke kamera — sistem memindai terus menerus
                    tanpa henti.
                  </p>
                </div>

                <div className="flex items-center gap-2">
                  {/* Camera Device Selector if multiple cameras exist */}
                  {cameraDevices.length > 1 ? (
                    <select
                      value={selectedDeviceId}
                      onChange={(e) => {
                        setSelectedDeviceId(e.target.value);
                        if (cameraActive) {
                          startCamera(e.target.value);
                        }
                      }}
                      className="bg-slate-950 text-slate-300 text-[11px] border border-slate-700 rounded-lg px-2.5 py-1.5 outline-none font-mono"
                    >
                      {cameraDevices.map((dev, idx) => (
                        <option key={dev.deviceId} value={dev.deviceId}>
                          {dev.label || `Kamera ${idx + 1}`}
                        </option>
                      ))}
                    </select>
                  ) : null}

                  <button
                    type="button"
                    onClick={cameraActive ? stopCamera : () => startCamera()}
                    disabled={isProcessing}
                    className={`min-h-10 rounded-xl px-4 text-xs font-bold transition disabled:opacity-50 ${
                      cameraActive
                        ? "border border-rose-400/30 bg-rose-400/10 text-rose-200 hover:bg-rose-400/20"
                        : "bg-sky-400 text-slate-950 hover:bg-sky-300 shadow-md shadow-sky-950"
                    }`}
                  >
                    {cameraActive ? "Hentikan kamera" : "Mulai pindai QR"}
                  </button>
                </div>
              </div>

              {/* Camera Video Feed Container with Laser Scan Animation */}
              <div
                className={`relative aspect-video overflow-hidden rounded-2xl border transition-all duration-300 bg-slate-950 ${
                  scanFlashStatus === "success"
                    ? "border-emerald-400 ring-4 ring-emerald-500/40 shadow-2xl shadow-emerald-950"
                    : scanFlashStatus === "warning"
                      ? "border-amber-400 ring-4 ring-amber-500/40 shadow-2xl shadow-amber-950"
                      : scanFlashStatus === "error"
                        ? "border-rose-400 ring-4 ring-rose-500/40 shadow-2xl shadow-rose-950"
                        : "border-white/10 shadow-inner"
                }`}
              >
                <video
                  ref={videoRef}
                  muted
                  playsInline
                  aria-label="Pratinjau kamera pemindai QR"
                  className="size-full object-cover"
                />

                {!cameraActive ? (
                  <div className="absolute inset-0 grid place-items-center p-6 text-center text-xs text-slate-500">
                    <div className="space-y-2">
                      <div className="text-3xl">📷</div>
                      <p className="font-semibold text-slate-400">
                        Kamera belum aktif
                      </p>
                      <p className="text-[11px] text-slate-500">
                        Tekan tombol “Mulai pindai QR” untuk mengaktifkan
                        pemindaian otomatis.
                      </p>
                    </div>
                  </div>
                ) : (
                  <>
                    {/* Targeting Reticle */}
                    <div className="pointer-events-none absolute inset-[15%] rounded-2xl border-2 border-sky-400/80 shadow-[0_0_0_999px_rgba(2,8,23,0.5)]">
                      {/* Corner Accents */}
                      <div className="absolute -top-1 -left-1 w-4 h-4 border-t-2 border-l-2 border-sky-300"></div>
                      <div className="absolute -top-1 -right-1 w-4 h-4 border-t-2 border-r-2 border-sky-300"></div>
                      <div className="absolute -bottom-1 -left-1 w-4 h-4 border-b-2 border-l-2 border-sky-300"></div>
                      <div className="absolute -bottom-1 -right-1 w-4 h-4 border-b-2 border-r-2 border-sky-300"></div>

                      {/* Animated Laser Line */}
                      <div className="absolute left-0 right-0 h-0.5 bg-gradient-to-r from-transparent via-sky-400 to-transparent shadow-[0_0_8px_#38bdf8] animate-bounce"></div>
                    </div>

                    {/* Processing Overlay */}
                    {isProcessing ? (
                      <div className="absolute inset-0 bg-slate-950/40 backdrop-blur-xs flex items-center justify-center">
                        <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-slate-900/90 border border-sky-400/50 text-sky-300 text-xs font-mono">
                          <div className="w-3 h-3 border-2 border-sky-400 border-t-transparent rounded-full animate-spin"></div>
                          Memproses QR...
                        </div>
                      </div>
                    ) : null}
                  </>
                )}
              </div>

              {cameraMessage ? (
                <output className="rounded-xl border border-amber-300/20 bg-amber-300/10 p-3 text-xs text-amber-100 block">
                  {cameraMessage}
                </output>
              ) : null}
            </div>
          ) : (
            <div className="space-y-4 rounded-2xl border border-slate-800 bg-slate-900 p-4 sm:p-6">
              <div className="flex flex-col items-start gap-2 sm:flex-row sm:items-center sm:justify-between">
                <label
                  htmlFor="qr-reader-input"
                  className="text-xs uppercase font-bold tracking-wider text-slate-400 flex items-center gap-2"
                >
                  <span className="w-2 h-2 bg-sky-400 rounded-full"></span>
                  Input Scanner Otomatis (Standby)
                </label>
                <span className="text-[11px] font-mono text-slate-500">
                  QR Code kartu karyawan
                </span>
              </div>
              <div className="relative">
                <input
                  id="qr-reader-input"
                  ref={connectScannerInput}
                  type="text"
                  value={scanInput}
                  onChange={(e) => setScanInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="Arahkan QR reader ke kartu lalu tekan trigger..."
                  autoComplete="off"
                  className="w-full bg-slate-950 border-2 border-sky-500/50 focus:border-sky-400 focus:ring-4 focus:ring-sky-500/20 text-white font-mono placeholder:text-slate-600 px-4 py-3.5 rounded-xl text-sm transition outline-none"
                />
                {isProcessing && (
                  <div className="absolute right-4 top-3.5">
                    <div className="w-5 h-5 border-2 border-sky-400 border-t-transparent rounded-full animate-spin"></div>
                  </div>
                )}
              </div>
              <p className="text-[11px] text-slate-500 italic">
                Terminal menerima payload dari perangkat QR reader yang bekerja
                sebagai input keyboard dan mengirim tombol Enter.
              </p>
            </div>
          )}

          {/* Real-time Result Card */}
          {lastResult && (
            <div
              className={`animate-fadeIn space-y-4 rounded-2xl border p-4 backdrop-blur-xl transition sm:p-6 ${
                lastResult.sukses
                  ? "bg-sky-950/40 border-sky-500/60 shadow-2xl shadow-sky-950/80"
                  : lastResult.pesan.includes("Scan ganda") ||
                      lastResult.pesan.includes("cooldown")
                    ? "bg-amber-950/40 border-amber-500/60 shadow-2xl shadow-amber-950/80"
                    : "bg-rose-950/40 border-rose-500/60 shadow-2xl shadow-rose-950/80"
              }`}
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div
                    className={`w-10 h-10 rounded-full flex items-center justify-center font-bold text-lg ${
                      lastResult.sukses
                        ? "bg-sky-500/20 text-sky-400 border border-sky-500/40"
                        : lastResult.pesan.includes("Scan ganda") ||
                            lastResult.pesan.includes("cooldown")
                          ? "bg-amber-500/20 text-amber-400 border border-amber-500/40"
                          : "bg-rose-500/20 text-rose-400 border border-rose-500/40"
                    }`}
                  >
                    {lastResult.sukses
                      ? "✓"
                      : lastResult.pesan.includes("Scan ganda") ||
                          lastResult.pesan.includes("cooldown")
                        ? "⏳"
                        : "✕"}
                  </div>
                  <div>
                    <h2
                      className={`font-bold text-base ${
                        lastResult.sukses
                          ? "text-sky-300"
                          : lastResult.pesan.includes("Scan ganda") ||
                              lastResult.pesan.includes("cooldown")
                            ? "text-amber-300"
                            : "text-rose-300"
                      }`}
                    >
                      {lastResult.pesan}
                    </h2>
                    <p className="text-xs text-slate-400 font-mono">
                      Status: {lastResult.status || "Diproses"}
                    </p>
                  </div>
                </div>
              </div>

              {lastResult.nama && (
                <div className="grid grid-cols-1 gap-3 border-t border-slate-800/80 pt-4 text-xs sm:grid-cols-3">
                  <div>
                    <span className="text-slate-400 block text-[10px]">
                      Nama:
                    </span>
                    <span className="font-semibold text-white">
                      {lastResult.nama}
                    </span>
                  </div>
                  <div>
                    <span className="text-slate-400 block text-[10px]">
                      Divisi:
                    </span>
                    <span className="font-semibold text-slate-300">
                      {lastResult.divisi}
                    </span>
                  </div>
                  <div>
                    <span className="text-slate-400 block text-[10px]">
                      Jenis Scan:
                    </span>
                    <span className="font-semibold text-sky-400">
                      {lastResult.jenisScan}
                    </span>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Right Side: Real-time Scan History Log (5 Cols) */}
        <div className="flex flex-col overflow-hidden rounded-2xl border border-slate-800 bg-slate-900 p-4 sm:p-6 lg:col-span-5">
          <div className="flex items-center justify-between border-b border-slate-800 pb-4 mb-4">
            <h3 className="text-xs uppercase font-bold tracking-wider text-slate-400 flex items-center gap-2">
              <span className="w-2 h-2 bg-amber-400 rounded-full"></span>
              Riwayat Scan Real-time
            </h3>
            <span className="text-[11px] font-mono text-slate-500">
              {scanHistory.length} pada sesi ini
            </span>
          </div>

          <div className="flex-1 overflow-y-auto space-y-2.5 pr-1 font-mono text-xs">
            {scanHistory.length === 0 ? (
              <div className="text-center py-16 text-slate-600 text-xs">
                Belum ada riwayat scan pada sesi terminal ini.
              </div>
            ) : (
              scanHistory.map((item) => (
                <div
                  key={item.id}
                  className={`p-3 rounded-xl border transition flex items-center justify-between ${
                    item.sukses
                      ? "bg-slate-950/80 border-slate-800 text-slate-200"
                      : "bg-rose-950/30 border-rose-900/40 text-rose-300"
                  }`}
                >
                  <div className="space-y-0.5">
                    <div className="font-bold text-white flex items-center gap-2">
                      <span>{item.nama}</span>
                      <span className="text-[10px] px-1.5 py-0.2 bg-slate-800 rounded text-slate-400 font-normal">
                        {item.divisi}
                      </span>
                    </div>
                    <div className="text-[11px] text-slate-400">
                      {item.pesan}
                    </div>
                  </div>

                  <div className="text-right">
                    <div className="text-[11px] font-semibold text-sky-400">
                      {item.waktu}
                    </div>
                    <span
                      className={`text-[10px] font-semibold ${
                        item.sukses ? "text-sky-300" : "text-rose-400"
                      }`}
                    >
                      {item.jenisScan}
                    </span>
                  </div>
                </div>
              ))
            )}
          </div>
          <div className="mt-4 border-t border-slate-800 pt-4 text-xs text-slate-400">
            Tampilan ini hanya memuat 16 scan terakhir pada sesi terminal. Semua
            log tetap disimpan di database.{" "}
            {hasPermission(user, "dashboard.view") ? (
              <Link
                href="/history"
                className="font-bold text-sky-300 hover:text-sky-200"
              >
                Buka riwayat tersimpan
              </Link>
            ) : null}
          </div>
        </div>
      </div>
    </AppShell>
  );
}
