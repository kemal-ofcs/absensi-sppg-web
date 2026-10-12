"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Modal } from "@/components/ui/Modal";
import { hasPermission } from "@/lib/auth/access";
import {
  averageEmbeddings,
  loadFaceEngine,
  readFaceEmbedding,
  toFaceVector,
} from "@/lib/client/face-engine";
import { openFaceCamera, stopVideoStream } from "@/lib/client/scan-photo";
import { useAuth } from "@/lib/context/AuthContext";
import {
  deleteFaceTemplate,
  type FaceTemplateStatus,
  listFaceTemplates,
  saveFaceTemplate,
} from "@/lib/gateways/face-template";
import { ambilFotoPersonil } from "@/lib/gateways/personnel-photo";
import { FACE_MODEL_ID } from "@/lib/validations/face-match";

/**
 * Pendaftaran wajah untuk verifikasi 1:1 saat scan. Satu komponen untuk ketiga
 * build (`filesToCopy`); halaman Web dan Mobile hanya membungkusnya.
 *
 * Pendaftaran lewat kamera SENGAJA tanpa uji liveness: yang mendaftarkan
 * adalah pemegang izin sensitif `face_template.manage` yang berhadapan
 * langsung dengan orangnya, dan pendaftaran massal dari foto profil memang
 * memakai foto. Uji liveness di sini tidak menutup celah apa pun.
 */

type Filter = "semua" | "belum" | "terdaftar" | "ulang";

// Gaya bersama komponen ini. Disalin ke Mobile bersama berkasnya
// (`filesToCopy`), jadi tidak boleh bergantung pada komponen yang hanya ada di
// salah satu workspace.
const INPUT =
  "w-full min-h-11 text-sm rounded-lg px-3 py-2 bg-slate-900 border border-slate-700 text-slate-100 focus:outline-none focus:ring-2 focus:ring-sky-500";
const LABEL = "block text-xs font-medium text-slate-300 mb-1";
const TOMBOL_UTAMA =
  "min-h-11 px-4 py-2 text-sm font-semibold rounded-lg bg-sky-600 hover:bg-sky-500 text-white transition-colors disabled:opacity-60 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-300";
const TOMBOL_KEDUA =
  "min-h-11 px-3 py-2 text-sm font-medium rounded-lg border border-slate-700 text-slate-200 hover:bg-slate-800 transition-colors disabled:opacity-60 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500";
const TOMBOL_BAHAYA =
  "min-h-11 px-4 py-2 text-sm font-semibold rounded-lg bg-rose-600 hover:bg-rose-500 text-white disabled:opacity-60 focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-300";

function pesanGalat(error: unknown, cadangan: string): string {
  return error instanceof Error && error.message ? error.message : cadangan;
}

const CAMERA_SAMPLES = 5;
const CAMERA_MAX_ATTEMPTS = 25;

function statusOf(row: FaceTemplateStatus): Exclude<Filter, "semua"> {
  if (!row.sumber) return "belum";
  return row.model === FACE_MODEL_ID ? "terdaftar" : "ulang";
}

const STATUS_TEXT: Record<Exclude<Filter, "semua">, string> = {
  belum: "Belum terdaftar",
  terdaftar: "Terdaftar",
  ulang: "Perlu daftar ulang",
};

const STATUS_STYLE: Record<Exclude<Filter, "semua">, string> = {
  belum: "border-amber-400/25 bg-amber-400/10 text-amber-200",
  terdaftar: "border-emerald-400/25 bg-emerald-400/10 text-emerald-200",
  ulang: "border-rose-400/25 bg-rose-400/10 text-rose-200",
};

function loadImage(src: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Foto tidak dapat dibaca."));
    image.src = src;
  });
}

export function WajahWorkspace() {
  const { user } = useAuth();
  const canManage = hasPermission(user, "face_template.manage");
  const isSubmittingRef = useRef(false);

  const [rows, setRows] = useState<FaceTemplateStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [message, setMessage] = useState<{
    tone: "ok" | "error";
    text: string;
  } | null>(null);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<Filter>("semua");
  const [enrollTarget, setEnrollTarget] = useState<FaceTemplateStatus | null>(
    null,
  );
  const [deleteTarget, setDeleteTarget] = useState<FaceTemplateStatus | null>(
    null,
  );
  const [bulkOpen, setBulkOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      setRows(await listFaceTemplates());
      setLoadError(null);
    } catch (error) {
      setLoadError(pesanGalat(error, "Daftar karyawan tidak dapat dimuat."));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const counts = useMemo(() => {
    const result = { belum: 0, terdaftar: 0, ulang: 0 };
    for (const row of rows) result[statusOf(row)] += 1;
    return result;
  }, [rows]);

  const visible = useMemo(() => {
    const term = search.trim().toLowerCase();
    return rows
      .filter((row) => filter === "semua" || statusOf(row) === filter)
      .filter(
        (row) =>
          !term ||
          row.nama.toLowerCase().includes(term) ||
          row.idUnik.toLowerCase().includes(term) ||
          row.divisi.toLowerCase().includes(term),
      )
      .slice(0, 300);
  }, [rows, filter, search]);

  const confirmDelete = async () => {
    if (!deleteTarget || isSubmittingRef.current) return;
    isSubmittingRef.current = true;
    try {
      await deleteFaceTemplate(deleteTarget.idUnik);
      setMessage({
        tone: "ok",
        text: `Wajah ${deleteTarget.nama} dihapus. Scan berikutnya ditandai "Belum Terdaftar".`,
      });
      setDeleteTarget(null);
      await load();
    } catch (error) {
      setMessage({
        tone: "error",
        text: pesanGalat(error, "Wajah gagal dihapus."),
      });
    } finally {
      isSubmittingRef.current = false;
    }
  };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-2">
        {(["terdaftar", "belum", "ulang"] as const).map((key) => (
          <div
            key={key}
            className="rounded-2xl border border-white/10 bg-slate-900/70 p-3"
          >
            <p className="text-[11px] font-semibold text-slate-400">
              {STATUS_TEXT[key]}
            </p>
            <p className="mt-1 text-xl font-black text-white">{counts[key]}</p>
          </div>
        ))}
      </div>

      {message ? (
        <output
          className={`block rounded-xl border px-3 py-2 text-sm ${
            message.tone === "ok"
              ? "border-emerald-400/25 bg-emerald-400/10 text-emerald-200"
              : "border-rose-400/25 bg-rose-400/10 text-rose-200"
          }`}
        >
          {message.text}
        </output>
      ) : null}

      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="flex-1">
          <label htmlFor="wajah-cari" className={LABEL}>
            Cari karyawan
          </label>
          <input
            id="wajah-cari"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Nama, ID, atau divisi"
            className={INPUT}
          />
        </div>
        <div className="sm:w-56">
          <label htmlFor="wajah-filter" className={LABEL}>
            Status pendaftaran
          </label>
          <select
            id="wajah-filter"
            value={filter}
            onChange={(event) => setFilter(event.target.value as Filter)}
            className={INPUT}
          >
            <option value="semua">Semua</option>
            <option value="belum">Belum terdaftar</option>
            <option value="terdaftar">Terdaftar</option>
            <option value="ulang">Perlu daftar ulang</option>
          </select>
        </div>
        {canManage ? (
          <button
            type="button"
            onClick={() => setBulkOpen(true)}
            disabled={counts.belum + counts.ulang === 0}
            className={TOMBOL_KEDUA}
          >
            Daftar massal dari foto profil
          </button>
        ) : null}
      </div>

      {loading ? (
        <p className="py-10 text-center text-sm text-slate-400">
          Memuat daftar karyawan…
        </p>
      ) : loadError ? (
        <div className="space-y-3 rounded-2xl border border-rose-400/25 bg-rose-400/10 p-4 text-center">
          <p className="text-sm text-rose-200">
            {loadError} Periksa koneksi, lalu muat ulang.
          </p>
          <button
            type="button"
            onClick={() => {
              setLoading(true);
              void load();
            }}
            className={TOMBOL_KEDUA}
          >
            Muat ulang
          </button>
        </div>
      ) : rows.length === 0 ? (
        <p className="py-10 text-center text-sm text-slate-400">
          Belum ada karyawan aktif. Tambahkan karyawan lebih dulu di menu
          Karyawan, lalu daftarkan wajahnya di sini.
        </p>
      ) : visible.length === 0 ? (
        <p className="py-10 text-center text-sm text-slate-400">
          Tidak ada karyawan yang cocok dengan pencarian atau status ini.
        </p>
      ) : (
        <ul className="divide-y divide-white/5 rounded-2xl border border-white/10 bg-slate-900/50">
          {visible.map((row) => {
            const status = statusOf(row);
            return (
              <li
                key={row.idUnik}
                className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-white">
                    {row.nama || row.idUnik}
                  </p>
                  <p className="truncate text-xs text-slate-400">
                    {row.jabatan ? `${row.jabatan} · ` : ""}
                    {row.idUnik}
                    {row.divisi ? ` · ${row.divisi}` : ""}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold ${STATUS_STYLE[status]}`}
                  >
                    {STATUS_TEXT[status]}
                    {row.sumber === "foto_profil" ? " · dari foto" : ""}
                  </span>
                  {canManage ? (
                    <>
                      <button
                        type="button"
                        onClick={() => setEnrollTarget(row)}
                        className={TOMBOL_KEDUA}
                      >
                        {status === "belum" ? "Daftarkan" : "Daftar ulang"}
                      </button>
                      {row.sumber ? (
                        <button
                          type="button"
                          onClick={() => setDeleteTarget(row)}
                          aria-label={`Hapus wajah ${row.nama}`}
                          className={TOMBOL_KEDUA}
                        >
                          Hapus
                        </button>
                      ) : null}
                    </>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {visible.length === 300 ? (
        <p className="text-center text-xs text-slate-400">
          Menampilkan 300 karyawan pertama. Persempit dengan pencarian.
        </p>
      ) : null}

      {enrollTarget ? (
        <CameraEnrollModal
          target={enrollTarget}
          onClose={() => setEnrollTarget(null)}
          onSaved={(nama) => {
            setEnrollTarget(null);
            setMessage({ tone: "ok", text: `Wajah ${nama} terdaftar.` });
            void load();
          }}
        />
      ) : null}

      {bulkOpen ? (
        <BulkEnrollModal
          targets={rows.filter((row) => statusOf(row) !== "terdaftar")}
          onClose={() => {
            setBulkOpen(false);
            void load();
          }}
        />
      ) : null}

      {deleteTarget ? (
        <Modal
          isOpen
          title="Hapus wajah terdaftar?"
          onClose={() => setDeleteTarget(null)}
        >
          <p className="text-sm text-slate-300">
            Wajah <strong className="text-white">{deleteTarget.nama}</strong>{" "}
            dihapus dari semua terminal pada sinkronisasi berikutnya. Absensinya
            tetap berjalan dan ditandai &ldquo;Belum Terdaftar&rdquo;.
          </p>
          <div className="mt-4 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setDeleteTarget(null)}
              className={TOMBOL_KEDUA}
            >
              Batal
            </button>
            <button
              type="button"
              onClick={() => void confirmDelete()}
              className={TOMBOL_BAHAYA}
            >
              Hapus wajah
            </button>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}

function CameraEnrollModal({
  target,
  onClose,
  onSaved,
}: {
  target: FaceTemplateStatus;
  onClose: () => void;
  onSaved: (nama: string) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const isSubmittingRef = useRef(false);
  const [facing, setFacing] = useState<"user" | "environment">("user");
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);

  // Kamera dilepas saat modal tertutup, terpisah dari effect pembuka kamera
  // (aturan siklus kamera repo ini).
  useEffect(() => () => stopVideoStream(videoRef.current), []);

  useEffect(() => {
    let cancelled = false;
    setReady(false);
    void (async () => {
      try {
        void loadFaceEngine().catch(() => undefined);
        const stream = await openFaceCamera(facing);
        const video = videoRef.current;
        if (cancelled || !video) {
          for (const track of stream.getTracks()) track.stop();
          return;
        }
        stopVideoStream(video);
        video.srcObject = stream;
        await video.play();
        if (!cancelled) setReady(true);
      } catch {
        if (!cancelled) {
          setError(
            "Kamera tidak dapat dibuka. Izinkan akses kamera atau tutup aplikasi lain yang sedang memakainya, lalu tekan Ganti kamera.",
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [facing]);

  const capture = async () => {
    const video = videoRef.current;
    if (!video || isSubmittingRef.current) return;
    isSubmittingRef.current = true;
    setBusy(true);
    setError(null);
    setProgress(0);
    try {
      const samples: number[][] = [];
      for (
        let attempt = 0;
        attempt < CAMERA_MAX_ATTEMPTS && samples.length < CAMERA_SAMPLES;
        attempt++
      ) {
        const embedding = await readFaceEmbedding(video);
        if (embedding) {
          samples.push(embedding);
          setProgress(samples.length);
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      if (samples.length < 3) {
        setError(
          "Wajah belum terbaca dengan jelas. Hadapkan wajah lurus ke kamera di tempat yang cukup terang, lalu coba lagi.",
        );
        return;
      }
      const vector = toFaceVector(averageEmbeddings(samples));
      if (!vector) {
        setError("Data wajah tidak valid. Coba lagi.");
        return;
      }
      await saveFaceTemplate({
        idUnik: target.idUnik,
        model: vector.model,
        vektor: vector.vektor,
        jumlahSampel: samples.length,
        sumber: "kamera",
      });
      onSaved(target.nama);
    } catch (caught) {
      setError(pesanGalat(caught, "Wajah gagal didaftarkan."));
    } finally {
      isSubmittingRef.current = false;
      setBusy(false);
    }
  };

  return (
    <Modal isOpen title={`Daftarkan wajah ${target.nama}`} onClose={onClose}>
      <div className="space-y-3">
        <video
          ref={videoRef}
          muted
          playsInline
          aria-label="Pratinjau kamera pendaftaran wajah"
          className="aspect-[4/3] w-full rounded-2xl border border-white/10 bg-black object-cover"
        />
        <p className="text-xs text-slate-400">
          Minta {target.nama} menatap kamera dengan wajah tidak tertutup. Sistem
          mengambil {CAMERA_SAMPLES} sampel lalu menggabungkannya.
        </p>
        {busy ? (
          <output className="block text-sm text-sky-200">
            Mengambil sampel {progress}/{CAMERA_SAMPLES}…
          </output>
        ) : null}
        {error ? (
          <p className="text-sm text-rose-200" role="alert">
            {error}
          </p>
        ) : null}
        <div className="flex flex-wrap justify-end gap-2">
          <button
            type="button"
            onClick={() =>
              setFacing((current) =>
                current === "user" ? "environment" : "user",
              )
            }
            disabled={busy}
            className={TOMBOL_KEDUA}
          >
            Ganti kamera
          </button>
          <button
            type="button"
            onClick={() => void capture()}
            disabled={!ready || busy}
            className={TOMBOL_UTAMA}
          >
            {busy ? "Mendaftarkan…" : "Ambil sampel wajah"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function BulkEnrollModal({
  targets,
  onClose,
}: {
  targets: FaceTemplateStatus[];
  onClose: () => void;
}) {
  const isSubmittingRef = useRef(false);
  const cancelRef = useRef(false);
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(false);
  const [tally, setTally] = useState({
    diproses: 0,
    berhasil: 0,
    tanpaFoto: 0,
    tidakTerbaca: 0,
    gagal: 0,
  });

  useEffect(
    () => () => {
      cancelRef.current = true;
    },
    [],
  );

  const run = async () => {
    if (isSubmittingRef.current) return;
    isSubmittingRef.current = true;
    cancelRef.current = false;
    setRunning(true);
    const result = {
      diproses: 0,
      berhasil: 0,
      tanpaFoto: 0,
      tidakTerbaca: 0,
      gagal: 0,
    };
    try {
      await loadFaceEngine();
      // ponytail: satu per satu, bukan paralel — perangkat murah kehabisan
      // memori GPU bila beberapa foto dianalisis bersamaan.
      for (const target of targets) {
        if (cancelRef.current) break;
        result.diproses += 1;
        try {
          const photo = await ambilFotoPersonil(target.idUnik);
          if (!photo?.foto_base64) {
            result.tanpaFoto += 1;
          } else {
            const image = await loadImage(
              `data:${photo.foto_mime};base64,${photo.foto_base64}`,
            );
            const embedding = await readFaceEmbedding(image);
            const vector = embedding ? toFaceVector(embedding) : null;
            if (!vector) {
              result.tidakTerbaca += 1;
            } else {
              await saveFaceTemplate({
                idUnik: target.idUnik,
                model: vector.model,
                vektor: vector.vektor,
                jumlahSampel: 1,
                sumber: "foto_profil",
              });
              result.berhasil += 1;
            }
          }
        } catch {
          result.gagal += 1;
        }
        setTally({ ...result });
      }
    } catch {
      result.gagal = targets.length - result.berhasil;
      setTally({ ...result });
    } finally {
      isSubmittingRef.current = false;
      setRunning(false);
      setDone(true);
    }
  };

  return (
    <Modal
      isOpen
      title="Daftar massal dari foto profil"
      onClose={() => {
        cancelRef.current = true;
        onClose();
      }}
    >
      <div className="space-y-3 text-sm text-slate-300">
        <p>
          {targets.length} karyawan belum terdaftar atau perlu daftar ulang.
          Wajahnya diambil dari foto profil yang sudah ada. Foto kartu biasanya
          kurang tajam dibanding kamera langsung, jadi karyawan yang sering
          &ldquo;Tidak Cocok&rdquo; sebaiknya didaftarkan ulang lewat kamera.
        </p>
        {running || done ? (
          <dl className="grid grid-cols-2 gap-2 rounded-2xl border border-white/10 bg-slate-950/60 p-3 text-xs">
            <dt>Diproses</dt>
            <dd className="text-right font-semibold text-white">
              {tally.diproses}/{targets.length}
            </dd>
            <dt>Berhasil</dt>
            <dd className="text-right font-semibold text-emerald-200">
              {tally.berhasil}
            </dd>
            <dt>Tanpa foto profil</dt>
            <dd className="text-right">{tally.tanpaFoto}</dd>
            <dt>Wajah tidak terbaca</dt>
            <dd className="text-right">{tally.tidakTerbaca}</dd>
            <dt>Gagal disimpan</dt>
            <dd className="text-right">{tally.gagal}</dd>
          </dl>
        ) : null}
        <div className="flex justify-end gap-2">
          {running ? (
            <button
              type="button"
              onClick={() => {
                cancelRef.current = true;
              }}
              className={TOMBOL_KEDUA}
            >
              Hentikan
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void run()}
              disabled={done || targets.length === 0}
              className={TOMBOL_UTAMA}
            >
              Daftarkan {targets.length} karyawan
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}
