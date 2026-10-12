"use client";

import { requestWebApi } from "@/lib/client/api-client";
import { isDesktopRuntime } from "@/lib/runtime/app-runtime";
import { invokeDesktop } from "@/lib/runtime/desktop-commands";
import {
  type FaceTemplateDraft,
  type FaceTemplateStatus,
  toFaceTemplateStatus,
} from "@/lib/validations/face-match";

export type {
  FaceTemplateDraft,
  FaceTemplateStatus,
} from "@/lib/validations/face-match";

/**
 * Pendaftaran wajah. Desktop/Mobile membaca SQLite lokal (`personil_wajah`
 * ikut snapshot, jadi daftarnya ada saat offline) dan menulis lewat outbox;
 * Web membaca dan menulis database cloud langsung.
 */
export async function listFaceTemplates(): Promise<FaceTemplateStatus[]> {
  const rows = isDesktopRuntime()
    ? await invokeDesktop<unknown[]>("desktop_list_face_templates")
    : (
        await requestWebApi<{ entries: unknown[] }>(
          "/api/face-template",
          "POST",
          {},
        )
      ).entries;
  return (Array.isArray(rows) ? rows : []).map((row) =>
    toFaceTemplateStatus((row ?? {}) as Record<string, unknown>),
  );
}

export async function saveFaceTemplate(draft: FaceTemplateDraft) {
  if (isDesktopRuntime()) {
    return invokeDesktop<{ sukses: boolean }>("desktop_save_face_template", {
      draft,
    });
  }
  return requestWebApi<{ sukses: boolean }>("/api/face-template", "PUT", draft);
}

export async function deleteFaceTemplate(idUnik: string) {
  if (isDesktopRuntime()) {
    return invokeDesktop<{ sukses: boolean }>("desktop_delete_face_template", {
      idUnik,
    });
  }
  return requestWebApi<{ sukses: boolean }>("/api/face-template", "DELETE", {
    idUnik,
  });
}
