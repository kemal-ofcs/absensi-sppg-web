import type { NextRequest } from "next/server";
import { z } from "zod";
import type { PermissionKey } from "@/lib/rbac/catalog";
import {
  requireAnyWebPermission,
  requireWebPermission,
} from "@/lib/server/auth/authorize";
import {
  ensureServerDatabaseInitialized,
  getServerDatabase,
} from "@/lib/server/db";
import {
  noStoreJson,
  readJsonBody,
  toApiErrorResponse,
} from "@/lib/server/http/api-response";
import { assertSameOriginMutation } from "@/lib/server/http/request-security";
import {
  daftarKinerja,
  putuskanKinerja,
  rincianKinerja,
  simpanKinerja,
  simpanPengaturanKinerja,
  simpanTemplateKinerja,
  templatesKinerja,
} from "@/lib/services/hr-kinerja";

export const runtime = "nodejs";

// HRIS fase 6: penilaian kinerja (prd-hris.md §21). Izin per aksi; aturan rinci
// (tidak untuk diri sendiri, koreksi hanya `finalize`, penilaian atas diri
// sendiri baru terbaca setelah Final lewat `view`) dinilai service, kembar
// `desktop/hr_kinerja.rs`.
const NILAI: readonly PermissionKey[] = [
  "hr.performance.assess",
  "hr.performance.finalize",
];
const BACA: readonly PermissionKey[] = ["hr.performance.view", ...NILAI];
const IZIN: Record<string, readonly PermissionKey[]> = {
  templates: [...BACA, "hr.performance.config"],
  "simpan-template": ["hr.performance.config"],
  pengaturan: ["hr.performance.config"],
  daftar: BACA,
  rincian: BACA,
  simpan: NILAI,
  putuskan: NILAI,
};

const AKSI_BACA = new Set(["templates", "daftar", "rincian"]);

const bodySchema = z
  .object({
    aksi: z.enum([
      "templates",
      "simpan-template",
      "pengaturan",
      "daftar",
      "rincian",
      "simpan",
      "putuskan",
    ]),
    id: z.string().trim().min(1).max(160).optional(),
    draft: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export async function POST(request: NextRequest) {
  try {
    const parsed = bodySchema.safeParse(await readJsonBody(request, 262_144));
    if (!parsed.success) {
      return noStoreJson(
        { sukses: false, pesan: "Permintaan tidak valid." },
        400,
      );
    }
    const { aksi, id = "", draft = {} } = parsed.data;
    if (!AKSI_BACA.has(aksi)) assertSameOriginMutation(request);
    const izin = IZIN[aksi] ?? [];
    const actor =
      izin.length === 1
        ? await requireWebPermission(request, izin[0] as PermissionKey)
        : await requireAnyWebPermission(request, izin);
    await ensureServerDatabaseInitialized();
    const db = getServerDatabase();
    switch (aksi) {
      case "templates":
        return noStoreJson(await templatesKinerja(db));
      case "simpan-template":
        return noStoreJson(await simpanTemplateKinerja(db, actor, draft));
      case "pengaturan":
        return noStoreJson(await simpanPengaturanKinerja(db, draft));
      case "daftar":
        return noStoreJson(await daftarKinerja(db, actor, draft));
      case "rincian":
        return noStoreJson(await rincianKinerja(db, actor, id));
      case "simpan":
        return noStoreJson(await simpanKinerja(db, actor, draft));
      case "putuskan":
        return noStoreJson(await putuskanKinerja(db, actor, draft));
    }
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
