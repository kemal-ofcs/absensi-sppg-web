"use client";

import type React from "react";
import { useEffect, useRef, useState } from "react";
import { formatBytes, optimizeImageFile } from "@/lib/client/image-optimizer";
import {
  ambilFotoPersonil,
  hapusFotoPersonil,
  simpanFotoPersonil,
} from "@/lib/gateways/personnel-photo";

export interface StagedPhotoData {
  dataUrl: string;
  base64: string;
  mime: string;
}

interface PersonnelPhotoFieldProps {
  idUnik?: string;
  nama: string;
  disabled?: boolean;
  stagedMode?: boolean;
  stagedPhoto?: StagedPhotoData | null;
  onPhotoChanged?: (photoDataUrl: string | null) => void;
  onPhotoStaged?: (staged: StagedPhotoData | null) => void;
}

export function PersonnelPhotoField({
  idUnik,
  nama,
  disabled = false,
  stagedMode = false,
  stagedPhoto = null,
  onPhotoChanged,
  onPhotoStaged,
}: PersonnelPhotoFieldProps) {
  const [photoDataUrl, setPhotoDataUrl] = useState<string | null>(
    stagedPhoto?.dataUrl || null,
  );
  const [isLoading, setIsLoading] = useState<boolean>(
    !stagedMode && Boolean(idUnik),
  );
  const [isSaving, setIsSaving] = useState<boolean>(false);
  const [statusMessage, setStatusMessage] = useState<string>("");
  const [isError, setIsError] = useState<boolean>(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (stagedMode) {
      setPhotoDataUrl(stagedPhoto?.dataUrl || null);
      setIsLoading(false);
      return;
    }
    let isMounted = true;
    async function loadPhoto() {
      if (!idUnik) {
        setIsLoading(false);
        return;
      }
      setIsLoading(true);
      try {
        const photo = await ambilFotoPersonil(idUnik);
        if (isMounted) {
          if (photo?.foto_base64) {
            const dataUrl = photo.foto_base64.startsWith("data:")
              ? photo.foto_base64
              : `data:${photo.foto_mime || "image/jpeg"};base64,${photo.foto_base64}`;
            setPhotoDataUrl(dataUrl);
            onPhotoChanged?.(dataUrl);
          } else {
            setPhotoDataUrl(null);
            onPhotoChanged?.(null);
          }
        }
      } catch (err) {
        if (isMounted) {
          console.error("Gagal memuat foto personil:", err);
        }
      } finally {
        if (isMounted) {
          setIsLoading(false);
        }
      }
    }

    loadPhoto();
    return () => {
      isMounted = false;
    };
  }, [idUnik, stagedMode, stagedPhoto?.dataUrl, onPhotoChanged]);

  async function handleFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    if (!stagedMode && !idUnik) return;

    setIsSaving(true);
    setStatusMessage("");
    setIsError(false);

    try {
      const optimized = await optimizeImageFile(file, {
        maxWidth: 600,
        maxHeight: 800,
        quality: 0.85,
        mimeType: "image/jpeg",
        fit: "contain",
      });

      let base64 = optimized.dataUrl;
      let mime = "image/jpeg";
      const match = optimized.dataUrl.match(
        /^data:(image\/[a-zA-Z+]+);base64,(.+)$/,
      );
      if (match) {
        mime = match[1];
        base64 = match[2];
      }

      const fullDataUrl = `data:${mime};base64,${base64}`;
      if (stagedMode) {
        setPhotoDataUrl(fullDataUrl);
        onPhotoChanged?.(fullDataUrl);
        onPhotoStaged?.({ dataUrl: fullDataUrl, base64, mime });
        setStatusMessage(
          `Foto siap disimpan saat data karyawan dibuat (${formatBytes(optimized.optimizedSizeBytes)})`,
        );
      } else if (idUnik) {
        await simpanFotoPersonil(idUnik, base64, mime);
        setPhotoDataUrl(fullDataUrl);
        onPhotoChanged?.(fullDataUrl);
        setStatusMessage(
          `Foto disimpan (${formatBytes(optimized.optimizedSizeBytes)})`,
        );
      }
      setIsError(false);
    } catch (err) {
      console.error("Gagal memproses foto personil:", err);
      setStatusMessage(
        err instanceof Error ? err.message : "Gagal memproses foto",
      );
      setIsError(true);
    } finally {
      setIsSaving(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    }
  }

  async function handleDeletePhoto() {
    setIsSaving(true);
    setStatusMessage("");
    setIsError(false);

    try {
      if (stagedMode) {
        setPhotoDataUrl(null);
        onPhotoChanged?.(null);
        onPhotoStaged?.(null);
        setStatusMessage("Foto dibatalkan");
      } else if (idUnik) {
        await hapusFotoPersonil(idUnik);
        setPhotoDataUrl(null);
        onPhotoChanged?.(null);
        setStatusMessage("Foto berhasil dihapus");
      }
      setIsError(false);
    } catch (err) {
      console.error("Gagal menghapus foto personil:", err);
      setStatusMessage(
        err instanceof Error ? err.message : "Gagal menghapus foto",
      );
      setIsError(true);
    } finally {
      setIsSaving(false);
    }
  }

  const initials = nama
    ? nama
        .split(" ")
        .slice(0, 2)
        .map((p) => p[0])
        .join("")
        .toUpperCase()
    : "P";

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-slate-700 bg-slate-800/40 p-4">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">
          Foto Personil (ID Card)
        </span>
        {statusMessage ? (
          <span
            className={`text-xs ${
              isError ? "text-rose-400" : "text-emerald-400"
            }`}
          >
            {statusMessage}
          </span>
        ) : null}
      </div>

      <div className="flex items-center gap-4">
        <div className="relative flex h-20 w-20 flex-shrink-0 items-center justify-center overflow-hidden rounded-full border-2 border-slate-600 bg-slate-700 shadow-inner">
          {isLoading ? (
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-sky-400 border-t-transparent" />
          ) : photoDataUrl ? (
            // biome-ignore lint/performance/noImgElement: data URL base64 avatar preview
            <img
              src={photoDataUrl}
              alt={nama || "Foto Personil"}
              className="h-full w-full object-cover"
            />
          ) : (
            <span className="text-lg font-bold text-slate-300">{initials}</span>
          )}

          {isSaving ? (
            <div className="absolute inset-0 flex items-center justify-center bg-black/60">
              <div className="h-5 w-5 animate-spin rounded-full border-2 border-white border-t-transparent" />
            </div>
          ) : null}
        </div>

        <div className="flex flex-col gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            className="hidden"
            disabled={disabled || isSaving || isLoading}
            onChange={handleFileChange}
            id={`photo-input-${idUnik}`}
          />
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={disabled || isSaving || isLoading}
              onClick={() => fileInputRef.current?.click()}
              className="inline-flex items-center rounded-md bg-sky-600 px-3 py-1.5 text-xs font-medium text-white shadow-sm transition hover:bg-sky-500 disabled:opacity-50"
            >
              {photoDataUrl ? "Ganti Foto" : "Unggah Foto"}
            </button>

            {photoDataUrl ? (
              <button
                type="button"
                disabled={disabled || isSaving || isLoading}
                onClick={handleDeletePhoto}
                className="inline-flex items-center rounded-md border border-rose-600/50 bg-rose-950/30 px-3 py-1.5 text-xs font-medium text-rose-300 transition hover:bg-rose-900/50 disabled:opacity-50"
              >
                Hapus
              </button>
            ) : null}
          </div>
          <p className="text-[11px] text-slate-400">
            Format JPEG, PNG, atau WebP. Otomatis dikompresi ke maks 500 KB.
          </p>
        </div>
      </div>
    </div>
  );
}
