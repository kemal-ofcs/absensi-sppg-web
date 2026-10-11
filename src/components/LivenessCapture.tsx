"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  analyzeFrame,
  evaluateChallengeSignals,
  evaluateLivenessSession,
  type FrameSignals,
  LIVENESS_CHALLENGE_LABEL,
  LIVENESS_FRAME_HEIGHT,
  LIVENESS_FRAME_WIDTH,
  type LivenessChallenge,
  type LivenessFrame,
} from "@/lib/security/face-liveness";
import type { LivenessFramePayload } from "@/lib/security/liveness-codec";
import { encodeFrameBytes } from "@/lib/security/liveness-codec";

/**
 * Jarak antar-frame. Perangkat lambat otomatis menghasilkan lebih sedikit
 * frame per detik; itu tidak menjadi masalah karena tidak ada tenggat.
 */
const FRAME_GAP_MS = 110;
/**
 * Panjang jendela bergulir yang dinilai — sekitar 2,6 detik gerakan terakhir.
 *
 * Penilaian dijalankan ulang atas jendela ini pada SETIAP frame baru, jadi
 * gerakan yang benar akan tertangkap kapan pun ia dilakukan. Tidak ada lagi
 * "jendela perekaman" yang bisa menutup tepat sebelum pengguna berkedip.
 */
const ROLLING_FRAMES = 24;
/** Frame minimal sebelum jendela mulai dinilai, supaya garis dasarnya bermakna. */
const MIN_EVAL_FRAMES = 10;
/** Jeda membaca instruksi sebelum sistem mulai memperhatikan. */
const PREPARE_MS = 900;
/** Lama tanda centang ditahan supaya pengguna sempat melihat langkahnya diterima. */
const CONFIRM_MS = 800;
/**
 * Jaring pengaman, bukan tenggat. Setelah sekian lama tanpa gerakan yang
 * terbaca, sistem menawarkan bantuan — pengguna tidak pernah dilempar keluar.
 */
const HINT_AFTER_MS = 22_000;
const PHOTO_WIDTH = 480;
const PHOTO_HEIGHT = 360;

type Phase =
  | "idle"
  | "aiming"
  | "prepare"
  | "watching"
  | "confirmed"
  | "stuck"
  | "done"
  | "error";

export interface LivenessCaptureResult {
  frames: LivenessFramePayload[];
  photoBase64: string;
  photoMime: string;
}

interface LivenessCaptureProps {
  challenges: readonly LivenessChallenge[];
  busy: boolean;
  onComplete: (result: LivenessCaptureResult) => void;
  onCancel: () => void;
  /**
   * Meminta server mengganti tantangan pada langkah ini. Dipakai ketika sebuah
   * tantangan memang tidak pernah terbaca oleh kamera perangkat.
   */
  onSwapChallenge?: (stepIndex: number) => Promise<void>;
}

/**
 * Verifikasi wajah berkelanjutan, mengikuti pola aplikasi perbankan.
 *
 * Sistem menampilkan satu instruksi lalu MEMPERHATIKAN TERUS sampai gerakan itu
 * benar-benar terbaca — tidak ada hitungan mundur dan tidak ada jendela
 * perekaman yang bisa berakhir sebelum pengguna sempat bergerak. Begitu terbaca,
 * langkah itu dikunci dengan tanda centang lalu instruksi berikutnya muncul.
 *
 * Versi sebelumnya merekam selama durasi tetap lalu menilai sekali di akhir;
 * kedipan yang terjadi setengah detik setelah jendela ditutup dianggap gagal,
 * dan seluruh langkah harus diulang. Itulah sebab utama satu permintaan bisa
 * perlu belasan kali percobaan.
 */
export function LivenessCapture({
  challenges,
  busy,
  onComplete,
  onCancel,
  onSwapChallenge,
}: LivenessCaptureProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  /** Frame dari langkah yang sudah diterima, berurutan per tantangan. */
  const acceptedRef = useRef<LivenessFrame[][]>([]);
  /** Jendela bergulir langkah yang sedang berjalan. */
  const windowFramesRef = useRef<LivenessFrame[]>([]);
  const windowSignalsRef = useRef<FrameSignals[]>([]);
  const startedAtRef = useRef(0);
  const watchStartedAtRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const onCompleteRef = useRef(onComplete);
  useEffect(() => {
    onCompleteRef.current = onComplete;
  }, [onComplete]);

  const [phase, setPhase] = useState<Phase>("idle");
  const [challengeIndex, setChallengeIndex] = useState(0);
  const [faceVisible, setFaceVisible] = useState(false);
  const [signal, setSignal] = useState(0);
  const [message, setMessage] = useState<string | null>(null);

  const stopCamera = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const stream = videoRef.current?.srcObject;
    if (stream instanceof MediaStream) {
      for (const track of stream.getTracks()) track.stop();
    }
    if (videoRef.current) videoRef.current.srcObject = null;
  }, []);

  // Pembersihan saat unmount SAJA. Menautkannya ke effect yang bergantung pada
  // state akan mematikan kamera WebView Android tepat setelah dibuka.
  useEffect(() => () => stopCamera(), [stopCamera]);

  const readCanvas = useCallback(() => {
    const video = videoRef.current;
    if (!video || video.videoWidth === 0) return null;
    if (!canvasRef.current) {
      canvasRef.current = document.createElement("canvas");
    }
    return { video, canvas: canvasRef.current };
  }, []);

  const grabFrame = useCallback(
    (challenge: LivenessChallenge): LivenessFrame | null => {
      const surface = readCanvas();
      if (!surface) return null;
      const { video, canvas } = surface;
      canvas.width = LIVENESS_FRAME_WIDTH;
      canvas.height = LIVENESS_FRAME_HEIGHT;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) return null;
      context.drawImage(
        video,
        0,
        0,
        LIVENESS_FRAME_WIDTH,
        LIVENESS_FRAME_HEIGHT,
      );
      const image = context.getImageData(
        0,
        0,
        LIVENESS_FRAME_WIDTH,
        LIVENESS_FRAME_HEIGHT,
      );
      // RGBA -> RGB: kanal alfa selalu 255 pada tangkapan kamera dan hanya
      // membengkakkan payload sepertiga tanpa menambah informasi.
      const rgb = new Uint8Array(
        LIVENESS_FRAME_WIDTH * LIVENESS_FRAME_HEIGHT * 3,
      );
      for (let index = 0; index < rgb.length / 3; index += 1) {
        rgb[index * 3] = image.data[index * 4] as number;
        rgb[index * 3 + 1] = image.data[index * 4 + 1] as number;
        rgb[index * 3 + 2] = image.data[index * 4 + 2] as number;
      }
      return {
        challenge,
        offsetMs: Math.round(performance.now() - startedAtRef.current),
        width: LIVENESS_FRAME_WIDTH,
        height: LIVENESS_FRAME_HEIGHT,
        rgb,
      };
    },
    [readCanvas],
  );

  const grabPhoto = useCallback(() => {
    const surface = readCanvas();
    if (!surface) return "";
    const { video, canvas } = surface;
    canvas.width = PHOTO_WIDTH;
    canvas.height = PHOTO_HEIGHT;
    const context = canvas.getContext("2d");
    if (!context) return "";
    context.drawImage(video, 0, 0, PHOTO_WIDTH, PHOTO_HEIGHT);
    const dataUrl = canvas.toDataURL("image/jpeg", 0.72);
    return dataUrl.slice(dataUrl.indexOf(",") + 1);
  }, [readCanvas]);

  const startCamera = useCallback(async () => {
    setMessage(null);
    if (!navigator.mediaDevices?.getUserMedia) {
      setPhase("error");
      setMessage("Kamera tidak tersedia pada perangkat ini.");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: "user",
          width: { ideal: 640 },
          height: { ideal: 480 },
        },
      });
      const video = videoRef.current;
      if (!video) {
        for (const track of stream.getTracks()) track.stop();
        return;
      }
      video.srcObject = stream;
      await video.play();
      acceptedRef.current = [];
      windowFramesRef.current = [];
      windowSignalsRef.current = [];
      startedAtRef.current = performance.now();
      setChallengeIndex(0);
      setPhase("aiming");
    } catch {
      setPhase("error");
      setMessage(
        "Izin kamera ditolak. Aktifkan izin kamera lalu coba lagi — verifikasi wajah wajib untuk memulihkan password.",
      );
    }
  }, []);

  // Gerbang penempatan wajah: menunggu sampai wajah benar-benar terdeteksi
  // sebelum instruksi diberikan, supaya frame gelap saat kamera masih menyetel
  // eksposur tidak ikut dinilai.
  useEffect(() => {
    if (phase !== "aiming") return;
    const challenge = challenges[challengeIndex];
    if (!challenge) return;
    let stable = 0;
    const tick = () => {
      const frame = grabFrame(challenge);
      const detected = frame ? analyzeFrame(frame).faceDetected : false;
      setFaceVisible(detected);
      stable = detected ? stable + 1 : 0;
      if (stable >= 3) {
        setPhase("prepare");
        return;
      }
      timerRef.current = setTimeout(tick, 160);
    };
    timerRef.current = setTimeout(tick, 160);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [phase, challengeIndex, challenges, grabFrame]);

  useEffect(() => {
    if (phase !== "prepare") return;
    timerRef.current = setTimeout(() => {
      windowFramesRef.current = [];
      windowSignalsRef.current = [];
      watchStartedAtRef.current = performance.now();
      setPhase("watching");
    }, PREPARE_MS);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [phase]);

  // Inti pola perbankan: memperhatikan tanpa henti, menilai ulang jendela
  // bergulir setiap frame, dan berhenti pada detik gerakan itu terbaca.
  useEffect(() => {
    if (phase !== "watching") return;
    const challenge = challenges[challengeIndex];
    if (!challenge) return;

    const tick = () => {
      const frame = grabFrame(challenge);
      if (frame) {
        const signals = analyzeFrame(frame);
        setFaceVisible(signals.faceDetected);
        setSignal(signals.eyeOpenness);

        windowFramesRef.current.push(frame);
        windowSignalsRef.current.push(signals);
        if (windowFramesRef.current.length > ROLLING_FRAMES) {
          windowFramesRef.current.shift();
          windowSignalsRef.current.shift();
        }

        if (windowSignalsRef.current.length >= MIN_EVAL_FRAMES) {
          const verdict = evaluateChallengeSignals(
            challenge,
            windowSignalsRef.current,
          );
          if (verdict.passed) {
            acceptedRef.current[challengeIndex] = [...windowFramesRef.current];
            setMessage(null);
            setPhase("confirmed");
            return;
          }
        }
      }

      if (performance.now() - watchStartedAtRef.current > HINT_AFTER_MS) {
        setPhase("stuck");
        return;
      }
      timerRef.current = setTimeout(tick, FRAME_GAP_MS);
    };

    timerRef.current = setTimeout(tick, FRAME_GAP_MS);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [phase, challengeIndex, challenges, grabFrame]);

  // Tanda centang ditahan sebentar supaya langkah yang diterima terasa selesai,
  // baru instruksi berikutnya muncul.
  useEffect(() => {
    if (phase !== "confirmed") return;
    timerRef.current = setTimeout(() => {
      if (challengeIndex + 1 < challenges.length) {
        setChallengeIndex(challengeIndex + 1);
        setPhase("aiming");
        return;
      }

      // Server menilai ulang SELURUH rangkaian dengan pemeriksaan tambahan
      // (porsi frame berwajah dan mikro-gerak). Diperiksa di sini lebih dulu
      // supaya kegagalan itu tidak muncul setelah semua langkah tuntas.
      const whole = evaluateLivenessSession(
        challenges,
        acceptedRef.current.flat(),
      );
      if (!whole.passed) {
        setMessage(whole.reason);
        setPhase("stuck");
        return;
      }

      const photoBase64 = grabPhoto();
      setPhase("done");
      stopCamera();
      onCompleteRef.current({
        frames: acceptedRef.current.flat().map((frame) => ({
          challenge: frame.challenge,
          offsetMs: frame.offsetMs,
          width: frame.width,
          height: frame.height,
          rgb: encodeFrameBytes(frame.rgb),
        })),
        photoBase64,
        photoMime: "image/jpeg",
      });
    }, CONFIRM_MS);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [phase, challengeIndex, challenges, grabPhoto, stopCamera]);

  const keepTrying = () => {
    setMessage(null);
    windowFramesRef.current = [];
    windowSignalsRef.current = [];
    setPhase("aiming");
  };

  const swapChallenge = async () => {
    if (!onSwapChallenge) return;
    setMessage(null);
    try {
      await onSwapChallenge(challengeIndex);
      keepTrying();
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "Tantangan pengganti tidak dapat diambil.",
      );
      setPhase("stuck");
    }
  };

  const challenge = challenges[challengeIndex];
  const watching = phase === "watching";
  const active =
    phase === "aiming" ||
    phase === "prepare" ||
    watching ||
    phase === "confirmed";

  return (
    <div className="space-y-4">
      <ol className="flex gap-2">
        {challenges.map((item, index) => (
          <li key={item} className="flex-1">
            <div
              className={`h-1.5 rounded-full ${
                index < challengeIndex ||
                (index === challengeIndex && phase === "confirmed")
                  ? "bg-emerald-400"
                  : index === challengeIndex
                    ? "bg-sky-400"
                    : "bg-white/10"
              }`}
            />
            <p
              className={`mt-1 text-[10px] font-bold ${
                index < challengeIndex
                  ? "text-emerald-300"
                  : index === challengeIndex
                    ? "text-sky-300"
                    : "text-slate-600"
              }`}
            >
              {index < challengeIndex ? "Selesai" : `Langkah ${index + 1}`}
            </p>
          </li>
        ))}
      </ol>

      <div className="relative overflow-hidden rounded-2xl border border-white/10 bg-slate-900">
        {/* Cermin: orang melihat dirinya seperti di cermin, jadi instruksi
            "tengok kiri" terasa alami. Analisis tetap pada piksel asli. */}
        <video
          ref={videoRef}
          playsInline
          muted
          className="aspect-[4/3] w-full scale-x-[-1] object-cover"
        >
          <track kind="captions" />
        </video>

        {phase === "idle" || phase === "error" ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-slate-950/80 p-6 text-center">
            <p className="text-sm text-slate-300">
              Wajah Anda akan direkam sebagai bukti permintaan pemulihan
              password.
            </p>
            <button
              type="button"
              onClick={() => void startCamera()}
              disabled={busy}
              className="min-h-11 rounded-xl bg-emerald-500 px-5 text-sm font-black text-slate-950 disabled:opacity-50"
            >
              {phase === "error" ? "Coba lagi" : "Nyalakan kamera"}
            </button>
          </div>
        ) : null}

        {phase === "confirmed" ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-emerald-950/70">
            <div className="grid size-16 place-items-center rounded-full bg-emerald-400 text-3xl font-black text-slate-950">
              ✓
            </div>
            <p className="text-sm font-black text-emerald-200">Terbaca</p>
          </div>
        ) : null}

        {active && phase !== "confirmed" ? (
          <div className="absolute inset-x-0 bottom-0 space-y-2 bg-gradient-to-t from-slate-950 to-transparent p-4">
            <p className="text-center text-xs font-bold uppercase tracking-wider text-emerald-300">
              Langkah {challengeIndex + 1} dari {challenges.length}
            </p>
            <p className="text-center text-lg font-black text-white">
              {challenge ? LIVENESS_CHALLENGE_LABEL[challenge] : ""}
            </p>
            <p className="text-center text-xs text-slate-300">
              {phase === "aiming"
                ? faceVisible
                  ? "Wajah terdeteksi..."
                  : "Posisikan wajah di tengah bingkai."
                : phase === "prepare"
                  ? "Bersiap..."
                  : faceVisible
                    ? "Silakan lakukan — tidak perlu terburu-buru."
                    : "Wajah keluar bingkai — dekatkan lagi."}
            </p>
          </div>
        ) : null}

        {phase === "stuck" ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-slate-950/85 p-6 text-center">
            <p className="text-sm font-black text-white">
              Gerakan belum terbaca
            </p>
            <p className="max-w-xs text-xs leading-5 text-slate-300">
              {message ??
                "Tambah cahaya di depan wajah, dekatkan wajah sampai memenuhi sepertiga bingkai, lalu lakukan gerakannya lebih tegas."}
            </p>
            <div className="flex flex-wrap justify-center gap-2">
              <button
                type="button"
                onClick={keepTrying}
                className="min-h-11 rounded-xl bg-emerald-500 px-4 text-sm font-black text-slate-950"
              >
                Coba lagi
              </button>
              {onSwapChallenge ? (
                <button
                  type="button"
                  onClick={() => void swapChallenge()}
                  className="min-h-11 rounded-xl border border-sky-400/40 bg-sky-400/10 px-4 text-sm font-bold text-sky-200"
                >
                  Ganti tantangan lain
                </button>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>

      {watching ? (
        <div className="space-y-2">
          <p className="text-center text-[11px] text-slate-400">
            Sistem sedang memperhatikan. Langkah ini otomatis lanjut begitu
            gerakan Anda terbaca.
          </p>
          {challenge === "KEDIP" ? (
            // Bilah sinyal mata: pengguna bisa melihat sendiri apakah
            // kedipannya terbaca kamera, alih-alih menebak setelah gagal.
            <div>
              <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500">
                Sinyal mata — harus turun tajam saat berkedip
              </p>
              <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-white/10">
                <div
                  className="h-full rounded-full bg-sky-400 transition-[width] duration-100"
                  style={{ width: `${Math.min(100, signal * 400)}%` }}
                />
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      {message && phase !== "stuck" ? (
        <p className="rounded-xl border border-rose-500/30 bg-rose-500/10 p-3 text-xs text-rose-200">
          {message}
        </p>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => {
            stopCamera();
            onCancel();
          }}
          className="min-h-11 rounded-xl border border-white/15 px-4 text-sm font-bold text-slate-300"
        >
          Batal
        </button>
      </div>
    </div>
  );
}
