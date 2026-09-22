"use client";

import { requestWebApi } from "@/lib/client/api-client";
import { isDesktopRuntime } from "@/lib/runtime/app-runtime";
import { invokeDesktop } from "@/lib/runtime/desktop-commands";

export interface PersonnelPhotoResult {
  id_unik: string;
  foto_mime: string;
  foto_base64: string;
  updated_at: string;
}

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function text(value: unknown) {
  return value == null ? "" : String(value);
}

export async function ambilFotoPersonil(
  idUnik: string,
): Promise<PersonnelPhotoResult | null> {
  if (!idUnik.trim()) return null;

  if (isDesktopRuntime()) {
    const res = await invokeDesktop<unknown>("desktop_get_personnel_photo", {
      idUnik,
    });
    if (!res) return null;
    const rec = record(res);
    if (!rec.id_unik && !rec.foto_base64) return null;
    return {
      id_unik: text(rec.id_unik || idUnik),
      foto_mime: text(rec.foto_mime) || "image/jpeg",
      foto_base64: text(rec.foto_base64),
      updated_at: text(rec.updated_at),
    };
  }

  const res = await requestWebApi<{ photo?: PersonnelPhotoResult | null }>(
    "/api/personnel/photo/query",
    "POST",
    { idUnik },
  );
  return res.photo ?? null;
}

export const getPersonnelPhoto = ambilFotoPersonil;

export async function simpanFotoPersonil(
  idUnik: string,
  fotoBase64: string,
  fotoMime: string,
): Promise<{ sukses: boolean; id_unik: string }> {
  if (isDesktopRuntime()) {
    const res = record(
      await invokeDesktop("desktop_save_personnel_photo", {
        idUnik,
        fotoBase64,
        fotoMime,
      }),
    );
    return {
      sukses: Boolean(res.sukses),
      id_unik: text(res.id_unik || idUnik),
    };
  }

  return await requestWebApi<{ sukses: boolean; id_unik: string }>(
    "/api/personnel/photo/upload",
    "POST",
    { idUnik, fotoBase64, fotoMime },
  );
}

export async function hapusFotoPersonil(
  idUnik: string,
): Promise<{ sukses: boolean; id_unik: string }> {
  if (isDesktopRuntime()) {
    const res = record(
      await invokeDesktop("desktop_delete_personnel_photo", { idUnik }),
    );
    return {
      sukses: Boolean(res.sukses),
      id_unik: text(res.id_unik || idUnik),
    };
  }

  return await requestWebApi<{ sukses: boolean; id_unik: string }>(
    "/api/personnel/photo/delete",
    "POST",
    { idUnik },
  );
}
