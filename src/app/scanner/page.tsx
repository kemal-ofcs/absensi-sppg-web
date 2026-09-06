"use client";

import type { IScannerControls } from "@zxing/browser";
import Link from "next/link";
import { redirect } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { canAccessArea, hasPermission } from "@/lib/auth/access";
import {
  getCachedCoordinates,
  watchCoordinates,
} from "@/lib/client/geolocation";
import {
  captureScanPhoto,
  isFaceVisible,
  openFaceCamera,
  type ScanPhotoCapture,
  stopVideoStream,
} from "@/lib/client/scan-photo";
import { useAuth } from "@/lib/context/AuthContext";
import type { ScanResult, ScanTerminalInput } from "@/lib/contracts/scanner";
import { getScanSecurity } from "@/lib/gateways/scan-security";
import { submitTerminalScan } from "@/lib/gateways/scanner";
import { requestSyncNow } from "@/lib/gateways/sync-status";
import { useClock } from "@/lib/hooks/useClock";
import { useCompanyName } from "@/lib/hooks/useCompanyName";
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
  const companyName = useCompanyName();
  // Jawabannya dihitung backend (sakelar induk DAN sakelar role), lalu dibaca
  // ulang setiap siklus sync. Menggabungkannya di sini dari objek sesi React
  // akan memakai salinan yang dibekukan saat login — sakelar role yang baru
  // diubah tidak akan pernah terlihat sampai aplikasi ditutup.
  const [requiresScanPhoto, setRequiresScanPhoto] = useState(false);

  // Sakelar induk hidup di setting yang ikut sinkronisasi, jadi ia dibaca ulang
  // setiap siklus sync selesai — mematikannya dari Desktop lain langsung
  // berlaku di terminal ini tanpa perlu login ulang.
  useEffect(() => {
    if (!isHydrated || !isAuthenticated) return;
    let cancelled = false;
    const muat = () => {
      getScanSecurity()
        .then((settings) => {
          if (!cancelled) setRequiresScanPhoto(settings.photoRequiredForMe);
        })
        .catch(() => undefined);
    };
    muat();
    window.addEventListener("sppg:sync-completed", muat);
    return () => {
      cancelled = true;
      window.removeEventListener("sppg:sync-completed", muat);
    };
  }, [isHydrated, isAuthenticated]);

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
  // Penahanan scan untuk foto wajah. Begitu QR terbaca dan role mewajibkan
  // foto, scan DITAHAN di sini: kamera hadap-depan dibuka, orangnya difoto
  // beserta latarnya, baru scan dikirim. Memotret pada detik QR terbaca akan
  // menghasilkan foto kartu identitas yang sedang ditempelkan ke lensa.
  const [pendingScan, setPendingScan] = useState<string | null>(null);
  const [faceCameraReady, setFaceCameraReady] = useState(false);
  const [faceVisible, setFaceVisible] = useState(false);
  /** Wajah terdeteksi stabil dan sedang dihitung mundur untuk jepretan. */
  const [faceHolding, setFaceHolding] = useState(false);
  const [faceCountdown, setFaceCountdown] = useState(0);
  const [faceMessage, setFaceMessage] = useState<string | null>(null);
  const [cameraMessage, setCameraMessage] = useState<string | null>(null);
  const [cameraDevices, setCameraDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>("");
  const [scanFlashStatus, setScanFlashStatus] = useState<
    "success" | "warning" | "error" | null
  >(null);

  const inputRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const faceVideoRef = useRef<HTMLVideoElement>(null);
  const faceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Kamera QR sedang hidup sebelum penahanan, jadi wajib dinyalakan lagi. */
  const resumeCameraRef = useRef(false);
  /** `startCamera` didefinisikan setelah blok ini; ref menjembataninya. */
  const startCameraRef = useRef<((deviceId?: string) => Promise<void>) | null>(
    null,
  );
  const scannerControlsRef = useRef<IScannerControls | null>(null);
  const cameraScanLockedRef = useRef(false);
  const isSubmittingRef = useRef(false);
  const lastScannedQrRef = useRef<string>("");
  const lastScannedTimeRef = useRef<number>(0);
  // Cached GPS — updated silently in the background so scan submissions
  // can read coordinates synchronously (0 ms latency, no blocking await).
  const cachedGpsRef = useRef<{ lat: number; lng: number } | null>(null);

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

  // Background GPS watcher — keeps cachedGpsRef and gpsLocation fresh
  // without blocking scan submission even if the device has no GPS chip.
  useEffect(() => {
    if (!isHydrated) return;
    // Seed with any already-cached value immediately (0 ms)
    const seed = getCachedCoordinates();
    if (seed) {
      cachedGpsRef.current = seed;
      setGpsLocation(seed);
    }
    const stopWatch = watchCoordinates();
    // Periodically push watch updates into cachedGpsRef and state
    const interval = setInterval(() => {
      const fresh = getCachedCoordinates();
      if (fresh) {
        cachedGpsRef.current = fresh;
        setGpsLocation(fresh);
      }
    }, 5_000);
    return () => {
      stopWatch();
      clearInterval(interval);
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

  const stopFaceCamera = useCallback(() => {
    if (faceTimerRef.current) {
      clearTimeout(faceTimerRef.current);
      faceTimerRef.current = null;
    }
    stopVideoStream(faceVideoRef.current);
    setFaceCameraReady(false);
    setFaceVisible(false);
    setFaceHolding(false);
    setFaceCountdown(0);
  }, []);

  // Pembersihan saat unmount SAJA — dependency kosong. Menautkannya ke effect
  // yang bergantung pada state akan mematikan kamera WebView Android tepat
  // setelah dibuka (aturan siklus kamera repo ini).
  useEffect(() => () => stopFaceCamera(), [stopFaceCamera]);

  const submitScan = useCallback(
    async (cleanPayload: string, photo: ScanPhotoCapture | null) => {
      if (isSubmittingRef.current) return;

      isSubmittingRef.current = true;
      setIsProcessing(true);
      setScanInput("");

      try {
        // Read GPS from memory cache (0 ms — no blocking await)
        const currentLocation = cachedGpsRef.current ?? gpsLocation;
        const input: ScanTerminalInput = {
          qrContent: cleanPayload,
          lat: currentLocation?.lat,
          lng: currentLocation?.lng,
          kodeOperator: user?.kode_operator || "OP001",
          sumberData: "Scanner",
          fotoBase64: photo?.base64,
          fotoMime: photo?.mime,
        };

        const result = await submitTerminalScan(input);
        setLastResult(result);

        // Bangunkan siklus sinkronisasi, JANGAN menunggu jadwal berikutnya.
        //
        // Absensi adalah satu-satunya mutasi bervolume tinggi yang tidak punya
        // pemicu push sendiri: hanya lima perintah pengaturan yang memanggil
        // `push_outbox` langsung, dan halaman ini tidak termasuk. Tanpa
        // panggilan ini sebuah scan menunggu sampai 30 detik sebelum terkirim —
        // dan pada terminal yang jendelanya tersembunyi, sampai 90 detik.
        //
        // Sengaja LEPAS dari alur scan (tidak di-`await`) supaya tidak menambah
        // satu milidetik pun ke waktu respons terminal, dan sudah di-throttle
        // 5 detik oleh AutoSyncRunner sehingga antrean panjang saat jam masuk
        // tidak berubah menjadi badai siklus.
        if (result.sukses) requestSyncNow();

        // Visual flash feedback
        if (result.sukses) {
          setScanFlashStatus("success");
        } else if (
          result.pesan.includes("Scan ganda") ||
          result.pesan.includes("cooldown") ||
          result.pesan.includes("Multi Scan Ditolak")
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
            result.pesan.includes("cooldown") ||
            result.pesan.includes("Multi Scan Ditolak")
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
        isSubmittingRef.current = false;
        setIsProcessing(false);
        if (mode === "reader") inputRef.current?.focus();
      }
    },
    [user, audioEnabled, mode, gpsLocation],
  );

  /**
   * Gerbang scan.
   *
   * Tanpa kewajiban foto, scan langsung dikirim seperti sebelumnya. Dengan
   * kewajiban foto, QR ditahan sampai wajah orangnya terpotret — backend
   * menegakkan aturan yang sama, jadi gerbang di sini hanya soal alur layar.
   */
  const handleScanSubmit = useCallback(
    async (payload: string) => {
      const cleanPayload = payload.trim();
      if (!cleanPayload || isSubmittingRef.current || pendingScan) return;
      if (!requiresScanPhoto) {
        await submitScan(cleanPayload, null);
        return;
      }

      setScanInput("");
      setFaceMessage(null);
      // Kamera QR dimatikan lebih dulu: pada ponsel, membuka kamera kedua
      // sementara stream pemindai masih hidup membuat keduanya saling mematikan.
      // Status kamera dibaca dari REF, bukan dari state: callback pemindai
      // dibuat sekali saat kamera dinyalakan dan membekukan nilai state saat
      // itu (`cameraActive === false`, karena kameranya baru mau hidup). Dengan
      // state, kamera pemindai tidak pernah menyala lagi setelah foto diambil.
      const qrCameraLive = scannerControlsRef.current !== null;
      resumeCameraRef.current = qrCameraLive;
      if (qrCameraLive) stopCamera();
      // Kameranya dibuka pada effect di bawah, bukan di sini: elemen <video>
      // baru ada di DOM setelah React merender panel penahanan.
      setPendingScan(cleanPayload);
    },
    [requiresScanPhoto, submitScan, pendingScan, stopCamera],
  );

  // Buka kamera hadap-depan begitu panel penahanan terpasang.
  useEffect(() => {
    if (!pendingScan) return;
    let cancelled = false;
    void (async () => {
      try {
        // Desktop pada umumnya hanya punya satu webcam yang menghadap ke
        // orang di depan layar, jadi "user" (kamera hadap-depan) selalu benar
        // di sini.
        const stream = await openFaceCamera("user");
        const video = faceVideoRef.current;
        if (cancelled || !video) {
          for (const track of stream.getTracks()) track.stop();
          return;
        }
        video.srcObject = stream;
        await video.play();
        if (!cancelled) setFaceCameraReady(true);
      } catch {
        if (!cancelled) {
          setFaceMessage(
            "Kamera tidak dapat dibuka. Role Anda mewajibkan foto bukti, jadi scan tidak bisa diproses tanpa kamera.",
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pendingScan]);

  /**
   * Nyalakan kembali kamera pemindai setelah penahanan selesai.
   *
   * Debounce QR terakhir ikut disegarkan: kartu yang sama masih berada di depan
   * lensa saat kamera hidup lagi, dan tanpa ini ia langsung terbaca ulang lalu
   * ditolak backend sebagai scan ganda — terlihat seperti kegagalan bagi
   * operator, padahal absensinya sudah tercatat.
   */
  const resumeQrCamera = useCallback(() => {
    if (!resumeCameraRef.current) return;
    resumeCameraRef.current = false;
    lastScannedTimeRef.current = Date.now();
    void startCameraRef.current?.();
  }, []);

  const closePhotoHold = useCallback(() => {
    stopFaceCamera();
    setPendingScan(null);
    resumeQrCamera();
    if (mode === "reader") inputRef.current?.focus();
  }, [mode, stopFaceCamera, resumeQrCamera]);

  const capturePhotoAndSubmit = useCallback(async () => {
    const qr = pendingScan;
    if (!qr) return;
    const photo = captureScanPhoto(faceVideoRef.current);
    if (!photo) {
      setFaceMessage("Foto belum terambil. Coba lagi.");
      return;
    }
    stopFaceCamera();
    setPendingScan(null);
    await submitScan(qr, photo);
    // Kamera pemindai baru dinyalakan SETELAH scan terkirim, supaya kartu yang
    // masih menempel di lensa tidak terbaca ulang selagi permintaan berjalan.
    resumeQrCamera();
  }, [pendingScan, stopFaceCamera, resumeQrCamera, submitScan]);

  // Fase membidik lalu menahan diam sejenak sebelum memotret sendiri.
  //
  // Deteksi wajah masuk bingkai saja mudah diakali: karyawan cukup melintas
  // sekilas di depan kamera lalu menyingkir sebelum jepretan sungguhan,
  // sehingga foto yang tersimpan kosong atau buram. Begitu wajah terdeteksi,
  // sistem WAJIB melihatnya tetap ada selama HOLD_STILL_MS berturut-turut —
  // wajah yang hilang di tengah jalan membatalkan hitungan dan mengulang dari
  // awal — baru jepretan diambil, dengan teks "Jangan bergerak" di layar.
  //
  // Deteksi wajahnya memakai ulang detektor piksel milik verifikasi "Lupa
  // Password" dan hanya berperan sebagai pemandu — jepretan tetap berjalan
  // otomatis setelah tenggat FORCE_AFTER_MS meski wajah tidak pernah terbaca
  // sama sekali, supaya kamera murah atau ruangan gelap tidak pernah
  // memblokir absensi seseorang.
  useEffect(() => {
    if (!pendingScan || !faceCameraReady) return;
    const TICK_MS = 150;
    const HOLD_STILL_MS = 1_400;
    const FORCE_AFTER_MS = 20_000;
    const startedAt = Date.now();
    let holdStartedAt: number | null = null;

    const tick = () => {
      const visible = isFaceVisible(faceVideoRef.current);
      const now = Date.now();
      setFaceVisible(visible);
      holdStartedAt = visible ? (holdStartedAt ?? now) : null;
      const holding = holdStartedAt !== null;
      setFaceHolding(holding);
      const holdElapsed = holding ? now - (holdStartedAt as number) : 0;
      setFaceCountdown(
        Math.max(0, Math.ceil((HOLD_STILL_MS - holdElapsed) / 1000)),
      );
      const overallElapsed = now - startedAt;
      if (
        (holding && holdElapsed >= HOLD_STILL_MS) ||
        overallElapsed >= FORCE_AFTER_MS
      ) {
        void capturePhotoAndSubmit();
        return;
      }
      faceTimerRef.current = setTimeout(tick, TICK_MS);
    };

    faceTimerRef.current = setTimeout(tick, TICK_MS);
    return () => {
      if (faceTimerRef.current) clearTimeout(faceTimerRef.current);
    };
  }, [pendingScan, faceCameraReady, capturePhotoAndSubmit]);

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
        // Ultra-fast decode: 40ms delay = up to ~25 FPS QR recognition
        delayBetweenScanAttempts: 40,
      });

      const targetDeviceId = deviceId || selectedDeviceId;
      const constraints: MediaStreamConstraints = {
        audio: false,
        video: targetDeviceId
          ? {
              deviceId: { exact: targetDeviceId },
              width: { ideal: 1280 },
              height: { ideal: 720 },
            }
          : {
              facingMode: { ideal: "environment" },
              width: { ideal: 1280 },
              height: { ideal: 720 },
            },
      };

      const handleDecodeResult = (
        result: { getText: () => string } | undefined,
      ) => {
        const qrContent = result?.getText().trim();
        if (!qrContent) return;

        const now = Date.now();
        // Only lock the SAME card — different cards queue instantly
        const isSameQrTooSoon =
          qrContent === lastScannedQrRef.current &&
          now - lastScannedTimeRef.current < 2500;
        if (isSubmittingRef.current || isSameQrTooSoon) {
          return;
        }

        lastScannedQrRef.current = qrContent;
        lastScannedTimeRef.current = now;

        // Eksekusi proses scan secara asynchronous TANPA mematikan kamera!
        void handleScanSubmit(qrContent);
      };

      let controls: IScannerControls;
      try {
        controls = await reader.decodeFromConstraints(
          constraints,
          video,
          handleDecodeResult,
        );
      } catch {
        // Fallback ke constraint video dasar jika facingMode/resolution ditolak oleh webcam
        controls = await reader.decodeFromConstraints(
          { audio: false, video: true },
          video,
          handleDecodeResult,
        );
      }

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
      const val = scanInput.trim();
      if (val && !isSubmittingRef.current) {
        setScanInput("");
        void handleScanSubmit(val);
      }
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

  startCameraRef.current = startCamera;

  return (
    <AppShell contentClassName="select-none overflow-x-hidden">
      {/* Penahanan scan untuk foto wajah + latar. Panel ini menutupi layar
          supaya jelas bahwa absensi BELUM terkirim sampai fotonya diambil. */}
      {pendingScan ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/95 p-4">
          <div className="w-full max-w-md space-y-4 rounded-3xl border border-white/10 bg-slate-900 p-5">
            <div>
              <p className="text-[11px] font-bold uppercase tracking-wider text-amber-300">
                QR terbaca — absensi ditahan
              </p>
              <h2 className="mt-1 text-lg font-black text-white">
                Ambil foto wajah &amp; latar
              </h2>
              <p className="mt-1 text-xs leading-5 text-slate-400">
                Hadapkan wajah ke kamera bersama latar tempat Anda berdiri. Foto
                diambil otomatis setelah wajah terdeteksi dan Anda tahan diam
                sejenak, dan absensi baru dikirim setelah fotonya tersimpan.
              </p>
            </div>

            <div className="relative overflow-hidden rounded-2xl border border-white/10 bg-slate-950">
              {/* Cermin: orang melihat dirinya seperti di cermin sehingga mudah
                  memposisikan wajah. Piksel yang difoto tetap yang asli. */}
              <video
                ref={faceVideoRef}
                muted
                playsInline
                aria-label="Pratinjau kamera foto bukti absensi"
                className="aspect-[4/3] w-full scale-x-[-1] object-cover"
              >
                <track kind="captions" />
              </video>
              {faceCameraReady ? (
                <>
                  {faceHolding ? (
                    <div className="absolute inset-0 flex items-center justify-center bg-slate-950/30">
                      <div className="rounded-2xl bg-slate-950/80 px-5 py-3 text-center">
                        <p className="text-lg font-black text-emerald-300">
                          Jangan bergerak
                        </p>
                        <p className="mt-0.5 font-mono text-xs text-slate-300">
                          Foto diambil dalam {faceCountdown}s
                        </p>
                      </div>
                    </div>
                  ) : null}
                  <div className="absolute inset-x-0 bottom-0 flex items-center justify-between gap-2 bg-gradient-to-t from-slate-950 to-transparent p-3">
                    <span
                      className={`rounded-full px-2.5 py-1 text-[11px] font-black ${
                        faceHolding
                          ? "bg-emerald-400/20 text-emerald-200"
                          : faceVisible
                            ? "bg-sky-400/20 text-sky-200"
                            : "bg-amber-400/20 text-amber-200"
                      }`}
                    >
                      {faceHolding
                        ? "Menahan diam..."
                        : faceVisible
                          ? "Wajah terdeteksi"
                          : "Posisikan wajah"}
                    </span>
                  </div>
                </>
              ) : (
                <div className="absolute inset-0 grid place-items-center text-xs text-slate-400">
                  Menyalakan kamera...
                </div>
              )}
            </div>

            {faceMessage ? (
              <output className="block rounded-xl border border-rose-400/30 bg-rose-400/10 p-3 text-xs text-rose-100">
                {faceMessage}
              </output>
            ) : null}

            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => void capturePhotoAndSubmit()}
                disabled={!faceCameraReady}
                className="min-h-11 flex-1 rounded-xl bg-emerald-400 px-4 text-sm font-black text-slate-950 disabled:opacity-50"
              >
                Ambil foto sekarang
              </button>
              <button
                type="button"
                onClick={closePhotoHold}
                className="min-h-11 rounded-xl border border-white/15 px-4 text-sm font-bold text-slate-300"
              >
                Batalkan scan
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* Header Bar Terminal */}
      <header className="scanner-terminal-header flex min-h-16 flex-col gap-3 border-b border-white/10 bg-slate-950/80 px-4 py-3 shadow-lg shadow-slate-950/20 backdrop-blur-xl sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <div className="flex items-center gap-4">
          <div>
            <h1 className="scanner-terminal-title text-sm font-bold text-white tracking-wide flex items-center gap-2">
              <span className="w-2.5 h-2.5 bg-sky-400 rounded-full animate-ping"></span>
              TERMINAL QR ABSENSI {companyName.toUpperCase()}
            </h1>
            <p className="scanner-terminal-meta text-[11px] text-slate-400 font-mono">
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
            className={`scanner-terminal-audio px-3 py-1 rounded-full text-xs font-mono font-medium transition border ${
              audioEnabled
                ? "bg-sky-500/20 text-sky-300 border-sky-500/40 hover:bg-sky-500/30"
                : "bg-slate-800/80 text-slate-400 border-slate-700 hover:bg-slate-800"
            }`}
          >
            {audioEnabled ? "🔊 Suara: ON" : "🔇 Suara: OFF"}
          </button>

          {/* Clock Display */}
          <div className="text-right">
            <div className="scanner-terminal-clock-time text-lg font-bold font-mono tracking-widest text-amber-400">
              {currentTime}
            </div>
            <div className="scanner-terminal-clock-date text-[11px] text-slate-400">
              {currentDate}
            </div>
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
                  ? "bg-gradient-to-r from-sky-600 to-sky-500 text-white shadow-md font-bold"
                  : "text-slate-400 hover:text-white"
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
                  ? "bg-gradient-to-r from-sky-600 to-sky-500 text-white shadow-md font-bold"
                  : "text-slate-400 hover:text-white"
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

              {/* Camera Video Feed Container with Laser Scan Animation & Dynamic Overlay HUD */}
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
                    <div className="pointer-events-none absolute inset-[12%] sm:inset-[15%] rounded-2xl border-2 border-sky-400/80 shadow-[0_0_0_999px_rgba(2,8,23,0.5)]">
                      {/* Corner Accents */}
                      <div className="absolute -top-1 -left-1 w-4 h-4 border-t-2 border-l-2 border-sky-300"></div>
                      <div className="absolute -top-1 -right-1 w-4 h-4 border-t-2 border-r-2 border-sky-300"></div>
                      <div className="absolute -bottom-1 -left-1 w-4 h-4 border-b-2 border-l-2 border-sky-300"></div>
                      <div className="absolute -bottom-1 -right-1 w-4 h-4 border-b-2 border-r-2 border-sky-300"></div>

                      {/* Animated Laser Line */}
                      <div className="absolute left-0 right-0 h-0.5 bg-gradient-to-r from-transparent via-sky-400 to-transparent shadow-[0_0_8px_#38bdf8] animate-bounce"></div>
                    </div>

                    {/* Processing Overlay Indicator */}
                    {isProcessing ? (
                      <div className="absolute top-4 left-1/2 -translate-x-1/2 z-20">
                        <div className="flex items-center gap-2 px-3.5 py-1.5 rounded-full bg-slate-900/95 border border-sky-400/60 text-sky-300 text-xs font-mono shadow-xl backdrop-blur-md animate-pulse">
                          <div className="w-3.5 h-3.5 border-2 border-sky-400 border-t-transparent rounded-full animate-spin"></div>
                          <span>Memproses QR...</span>
                        </div>
                      </div>
                    ) : null}

                    {/* Glassmorphic Scan Result HUD Overlay */}
                    {lastResult ? (
                      <div className="absolute inset-x-3 bottom-3 z-30 animate-in fade-in zoom-in-95 duration-200">
                        <div
                          className={`rounded-2xl border p-3.5 sm:p-4 backdrop-blur-xl shadow-2xl transition ${
                            lastResult.sukses
                              ? "bg-slate-950/90 border-emerald-400/60 shadow-emerald-950/60"
                              : lastResult.pesan.includes("Scan ganda") ||
                                  lastResult.pesan.includes("cooldown")
                                ? "bg-slate-950/90 border-amber-400/60 shadow-amber-950/60"
                                : "bg-slate-950/90 border-rose-400/60 shadow-rose-950/60"
                          }`}
                        >
                          <div className="flex items-center justify-between gap-3">
                            <div className="flex items-center gap-3 min-w-0">
                              <div
                                className={`size-9 sm:size-10 shrink-0 rounded-xl flex items-center justify-center font-bold text-base sm:text-lg ${
                                  lastResult.sukses
                                    ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/40"
                                    : lastResult.pesan.includes("Scan ganda") ||
                                        lastResult.pesan.includes("cooldown")
                                      ? "bg-amber-500/20 text-amber-300 border border-amber-500/40"
                                      : "bg-rose-500/20 text-rose-300 border border-rose-500/40"
                                }`}
                              >
                                {lastResult.sukses
                                  ? "✓"
                                  : lastResult.pesan.includes("Scan ganda") ||
                                      lastResult.pesan.includes("cooldown")
                                    ? "⏳"
                                    : "✕"}
                              </div>
                              <div className="min-w-0">
                                <h3
                                  className={`font-black text-sm sm:text-base truncate ${
                                    lastResult.sukses
                                      ? "text-emerald-300"
                                      : lastResult.pesan.includes(
                                            "Scan ganda",
                                          ) ||
                                          lastResult.pesan.includes("cooldown")
                                        ? "text-amber-300"
                                        : "text-rose-300"
                                  }`}
                                >
                                  {lastResult.pesan}
                                </h3>
                                <p className="text-[11px] text-slate-300 font-mono truncate">
                                  {lastResult.nama ? (
                                    <>
                                      <span className="font-bold text-white">
                                        {lastResult.nama}
                                      </span>
                                      {lastResult.divisi
                                        ? ` · ${lastResult.divisi}`
                                        : ""}
                                      {lastResult.jenisScan
                                        ? ` · Absen ${lastResult.jenisScan}`
                                        : ""}
                                    </>
                                  ) : (
                                    `Status: ${lastResult.status || "Diproses"}`
                                  )}
                                </p>
                              </div>
                            </div>

                            <button
                              type="button"
                              onClick={() => setLastResult(null)}
                              aria-label="Tutup notifikasi"
                              className="size-7 shrink-0 grid place-items-center rounded-lg bg-white/10 text-slate-400 hover:text-white text-sm"
                            >
                              &times;
                            </button>
                          </div>
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
                  className="text-xs font-semibold text-white flex items-center gap-2"
                >
                  <span className="w-2 h-2 bg-sky-400 rounded-full"></span>
                  Input Scanner Otomatis (Standby)
                </label>
                <span className="text-[11px] font-mono text-slate-400">
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
              <p className="text-[11px] text-slate-400 italic">
                Terminal menerima payload dari perangkat QR reader yang bekerja
                sebagai input keyboard dan mengirim tombol Enter.
              </p>

              {requiresScanPhoto ? (
                <p className="rounded-2xl border border-amber-300/20 bg-amber-300/5 p-3 text-[11px] leading-5 text-amber-200/90">
                  Role Anda mewajibkan foto bukti. Setelah QR terbaca, terminal
                  menahan sebentar dan membuka kamera untuk memotret wajah dan
                  latar orang yang absen sebelum data dikirim.
                </p>
              ) : null}

              {/* Reader mode result card */}
              {lastResult && (
                <div
                  className={`animate-fadeIn space-y-4 rounded-2xl border p-4 backdrop-blur-xl transition sm:p-6 ${
                    lastResult.sukses
                      ? "bg-sky-950/40 border-sky-500/60 shadow-lg shadow-sky-950/60"
                      : lastResult.pesan.includes("Scan ganda") ||
                          lastResult.pesan.includes("cooldown")
                        ? "bg-amber-950/40 border-amber-500/60 shadow-lg shadow-amber-950/60"
                        : "bg-rose-950/40 border-rose-500/60 shadow-lg shadow-rose-950/60"
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
