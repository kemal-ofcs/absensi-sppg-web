"use client";

import { redirect } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { HeaderBar } from "@/components/HeaderBar";
import { useAuth } from "@/lib/context/AuthContext";
import { useClock } from "@/lib/hooks/useClock";
import { useHydrated } from "@/lib/hooks/useHydrated";
import type { ScanResult } from "@/lib/services/attendance";
import {
  getCurrentCoordinates,
  type ScanTerminalInput,
  submitTerminalScan,
} from "@/lib/services/scanner";
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

  const [mode, setMode] = useState<"hardware" | "simulasi">("hardware");
  const [scanInput, setScanInput] = useState<string>("");
  const [isProcessing, setIsProcessing] = useState<boolean>(false);
  const [audioEnabled, setAudioEnabled] = useState<boolean>(true);
  const [gpsLocation, setGpsLocation] = useState<{
    lat: number;
    lng: number;
  } | null>(null);
  const [lastResult, setLastResult] = useState<ScanResult | null>(null);
  const [scanHistory, setScanHistory] = useState<ScanLogItem[]>([]);

  const inputRef = useRef<HTMLInputElement>(null);
  const connectScannerInput = useCallback((node: HTMLInputElement | null) => {
    inputRef.current = node;
    node?.focus();
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

  const handleScanSubmit = useCallback(
    async (payload: string) => {
      const cleanPayload = payload.trim();
      if (!cleanPayload || isProcessing) return;

      setIsProcessing(true);
      setScanInput("");

      try {
        const input: ScanTerminalInput = {
          qrContent: cleanPayload,
          lat: gpsLocation?.lat,
          lng: gpsLocation?.lng,
          kodeOperator: user?.kode_operator || "OP001",
          sumberData: "Scanner",
        };

        const result = await submitTerminalScan(input);
        setLastResult(result);

        // Suara & Audio feedback
        if (audioEnabled) {
          if (result.sukses) {
            audioSynth.playSuccessBeep();
          } else if (result.pesan.includes("Scan ganda")) {
            audioSynth.playWarningBeep();
          } else {
            audioSynth.playErrorBeep();
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
        }
      } finally {
        setIsProcessing(false);
        if (mode === "hardware") {
          setTimeout(() => inputRef.current?.focus(), 100);
        }
      }
    },
    [isProcessing, gpsLocation, user, audioEnabled, mode],
  );

  // Keyboard handler untuk Hardware Barcode Scanner (USB / Wireless)
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
          <div className="w-10 h-10 border-4 border-emerald-500 border-t-transparent rounded-full animate-spin"></div>
          <p className="text-xs text-slate-400 font-mono animate-pulse">
            Memuat Terminal Scanner...
          </p>
        </div>
      </div>
    );
  }

  if (!isAuthenticated) redirect("/login");

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans select-none overflow-x-hidden">
      <HeaderBar />

      {/* Header Bar Terminal */}
      <header className="h-16 border-b border-slate-800 bg-slate-900/60 px-6 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <div>
            <h1 className="text-sm font-bold text-white tracking-wide flex items-center gap-2">
              <span className="w-2.5 h-2.5 bg-emerald-400 rounded-full animate-ping"></span>
              TERMINAL SCANNER ABSENSI SPPG
            </h1>
            <p className="text-[11px] text-slate-400 font-mono">
              Operator: {user?.nama_operator} ({user?.kode_operator}) |
              Location:{" "}
              {gpsLocation
                ? `${gpsLocation.lat.toFixed(4)}, ${gpsLocation.lng.toFixed(4)}`
                : "Kantor Pusat"}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-6">
          {/* Audio & Status Toggle */}
          <button
            type="button"
            onClick={() => setAudioEnabled(!audioEnabled)}
            className={`px-3 py-1 rounded-full text-xs font-mono font-medium transition border ${
              audioEnabled
                ? "bg-emerald-500/20 text-emerald-300 border-emerald-500/40"
                : "bg-slate-800 text-slate-400 border-slate-700"
            }`}
          >
            {audioEnabled ? "🔊 Suara: ON" : "🔇 Suara: OFF"}
          </button>

          {/* Clock Display */}
          <div className="text-right">
            <div className="text-lg font-bold font-mono tracking-widest text-emerald-400">
              {currentTime}
            </div>
            <div className="text-[11px] text-slate-400">{currentDate}</div>
          </div>
        </div>
      </header>

      {/* Main Terminal View */}
      <div className="flex-1 p-6 grid grid-cols-1 lg:grid-cols-12 gap-6 overflow-hidden">
        {/* Left Side: Scanner Input & Active Result Display (7 Cols) */}
        <div className="lg:col-span-7 flex flex-col space-y-6">
          {/* Mode Switch Tabs */}
          <div className="bg-slate-900/60 p-1.5 border border-slate-800 rounded-xl flex items-center gap-2">
            <button
              type="button"
              onClick={() => setMode("hardware")}
              className={`flex-1 py-2.5 rounded-lg text-xs font-semibold transition flex items-center justify-center gap-2 ${
                mode === "hardware"
                  ? "bg-emerald-600 text-white shadow-lg shadow-emerald-950/60"
                  : "text-slate-400 hover:text-slate-200"
              }`}
            >
              📟 Barcode Reader USB / Wireless (Hardware)
            </button>
            <button
              type="button"
              onClick={() => setMode("simulasi")}
              className={`flex-1 py-2.5 rounded-lg text-xs font-semibold transition flex items-center justify-center gap-2 ${
                mode === "simulasi"
                  ? "bg-emerald-600 text-white shadow-lg shadow-emerald-950/60"
                  : "text-slate-400 hover:text-slate-200"
              }`}
            >
              📷 Simulasi Quick QR Code
            </button>
          </div>

          {/* Scanner Input Panel */}
          {mode === "hardware" ? (
            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-4">
              <div className="flex items-center justify-between">
                <label
                  htmlFor="barcode-input"
                  className="text-xs uppercase font-bold tracking-wider text-slate-400 flex items-center gap-2"
                >
                  <span className="w-2 h-2 bg-emerald-400 rounded-full"></span>
                  Input Scanner Otomatis (Standby)
                </label>
                <span className="text-[11px] font-mono text-slate-500">
                  Scan QR / Barcode Card
                </span>
              </div>
              <div className="relative">
                <input
                  id="barcode-input"
                  ref={connectScannerInput}
                  type="text"
                  value={scanInput}
                  onChange={(e) => setScanInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="Arahkan Barcode Scanner ke sini & Tekan Trigger..."
                  autoComplete="off"
                  className="w-full bg-slate-950 border-2 border-emerald-500/50 focus:border-emerald-400 focus:ring-4 focus:ring-emerald-500/20 text-white font-mono placeholder:text-slate-600 px-4 py-3.5 rounded-xl text-sm transition outline-none"
                />
                {isProcessing && (
                  <div className="absolute right-4 top-3.5">
                    <div className="w-5 h-5 border-2 border-emerald-400 border-t-transparent rounded-full animate-spin"></div>
                  </div>
                )}
              </div>
              <p className="text-[11px] text-slate-500 italic">
                * Terminal akan mendeteksi pembacaan dari alat scanner hardware
                secara otomatis saat barcode dipindai.
              </p>
            </div>
          ) : (
            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-4">
              <h3 className="text-xs uppercase font-bold tracking-wider text-slate-400">
                Tombol Simulasi Quick Scan Karyawan
              </h3>
              <div className="grid grid-cols-2 gap-3">
                <button
                  type="button"
                  onClick={() => handleScanSubmit("EMP_TEST_001|TOKEN123")}
                  disabled={isProcessing}
                  className="p-3 bg-slate-800 hover:bg-slate-700 border border-slate-700 active:scale-95 rounded-xl text-left transition disabled:opacity-50"
                >
                  <div className="text-xs font-bold text-emerald-400">
                    Budi Santoso (K001)
                  </div>
                  <div className="text-[11px] text-slate-400">
                    EMP_TEST_001 | Shift 1 Pagi
                  </div>
                </button>

                <button
                  type="button"
                  onClick={() => handleScanSubmit("EMP_TEST_002|TOKEN456")}
                  disabled={isProcessing}
                  className="p-3 bg-slate-800 hover:bg-slate-700 border border-slate-700 active:scale-95 rounded-xl text-left transition disabled:opacity-50"
                >
                  <div className="text-xs font-bold text-sky-400">
                    Siti Aminah (K002)
                  </div>
                  <div className="text-[11px] text-slate-400">
                    EMP_TEST_002 | Keuangan
                  </div>
                </button>
              </div>
            </div>
          )}

          {/* Real-time Result Card */}
          {lastResult && (
            <div
              className={`p-6 rounded-2xl border backdrop-blur-xl transition animate-fadeIn space-y-4 ${
                lastResult.sukses
                  ? "bg-emerald-950/40 border-emerald-500/60 shadow-2xl shadow-emerald-950/80"
                  : lastResult.pesan.includes("Scan ganda")
                    ? "bg-amber-950/40 border-amber-500/60 shadow-2xl shadow-amber-950/80"
                    : "bg-rose-950/40 border-rose-500/60 shadow-2xl shadow-rose-950/80"
              }`}
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div
                    className={`w-10 h-10 rounded-full flex items-center justify-center font-bold text-lg ${
                      lastResult.sukses
                        ? "bg-emerald-500/20 text-emerald-400 border border-emerald-500/40"
                        : lastResult.pesan.includes("Scan ganda")
                          ? "bg-amber-500/20 text-amber-400 border border-amber-500/40"
                          : "bg-rose-500/20 text-rose-400 border border-rose-500/40"
                    }`}
                  >
                    {lastResult.sukses
                      ? "✓"
                      : lastResult.pesan.includes("Scan ganda")
                        ? "⏳"
                        : "✕"}
                  </div>
                  <div>
                    <h2
                      className={`font-bold text-base ${
                        lastResult.sukses
                          ? "text-emerald-300"
                          : lastResult.pesan.includes("Scan ganda")
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
                <div className="pt-4 border-t border-slate-800/80 grid grid-cols-3 gap-3 text-xs">
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
                    <span className="font-semibold text-emerald-400">
                      {lastResult.jenisScan}
                    </span>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Right Side: Real-time Scan History Log (5 Cols) */}
        <div className="lg:col-span-5 bg-slate-900 border border-slate-800 rounded-2xl p-6 flex flex-col overflow-hidden">
          <div className="flex items-center justify-between border-b border-slate-800 pb-4 mb-4">
            <h3 className="text-xs uppercase font-bold tracking-wider text-slate-400 flex items-center gap-2">
              <span className="w-2 h-2 bg-sky-400 rounded-full"></span>
              Riwayat Scan Real-time
            </h3>
            <span className="text-[11px] font-mono text-slate-500">
              {scanHistory.length} Record
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
                    <div className="text-[11px] font-semibold text-emerald-400">
                      {item.waktu}
                    </div>
                    <span
                      className={`text-[10px] font-semibold ${
                        item.sukses ? "text-emerald-300" : "text-rose-400"
                      }`}
                    >
                      {item.jenisScan}
                    </span>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
