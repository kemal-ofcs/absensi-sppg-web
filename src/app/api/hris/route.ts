import type { NextRequest } from "next/server";
import { z } from "zod";
import type { PermissionKey } from "@/lib/rbac/catalog";
import { requireWebPermission } from "@/lib/server/auth/authorize";
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
  batalKontrak,
  catatKontrak,
  hapusBerkas,
  hapusDokumen,
  MASTER_CABANG,
  MASTER_DIVISI,
  MASTER_JABATAN,
  simpanDokumen,
  simpanJenisDokumen,
  simpanMaster,
  simpanPengaturan,
  simpanProfil,
  tambahBerkas,
} from "@/lib/services/hris";

export const runtime = "nodejs";

// Mutasi HRIS fase 1. Isi `draft` divalidasi presisi oleh validator kembar
// Rust di `validations/hris.ts` (kunci asing ditolak di profil).
const IZIN = {
  cabang: "hr.org.manage",
  divisi: "hr.org.manage",
  jabatan: "hr.org.manage",
  pengaturan: "hr.org.manage",
  "jenis-dokumen": "hr.org.manage",
  kontrak: "hr.contract.manage",
  "batal-kontrak": "hr.contract.manage",
  pribadi: "hr.personal.manage",
  keuangan: "hr.finance.manage",
  dokumen: "hr.document.manage",
  "hapus-dokumen": "hr.document.manage",
  berkas: "hr.document.manage",
  "hapus-berkas": "hr.document.manage",
} as const satisfies Record<string, PermissionKey>;

const bodySchema = z
  .object({
    aksi: z.enum(
      Object.keys(IZIN) as [keyof typeof IZIN, ...(keyof typeof IZIN)[]],
    ),
    id: z.string().trim().min(1).max(160).optional(),
    draft: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export async function POST(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    const parsed = bodySchema.safeParse(await readJsonBody(request));
    if (!parsed.success) {
      return noStoreJson(
        { sukses: false, pesan: "Permintaan tidak valid." },
        400,
      );
    }
    const { aksi, id = "", draft = {} } = parsed.data;
    const actor = await requireWebPermission(request, IZIN[aksi]);
    await ensureServerDatabaseInitialized();
    const db = getServerDatabase();
    const oleh = actor.username;
    switch (aksi) {
      case "cabang":
        return noStoreJson(await simpanMaster(db, MASTER_CABANG, draft));
      case "divisi":
        return noStoreJson(await simpanMaster(db, MASTER_DIVISI, draft));
      case "jabatan":
        return noStoreJson(await simpanMaster(db, MASTER_JABATAN, draft));
      case "pengaturan":
        return noStoreJson(await simpanPengaturan(db, draft));
      case "jenis-dokumen":
        return noStoreJson(await simpanJenisDokumen(db, draft));
      case "kontrak":
        return noStoreJson(await catatKontrak(db, oleh, draft));
      case "batal-kontrak":
        return noStoreJson(await batalKontrak(db, oleh, draft));
      case "pribadi":
      case "keuangan":
        return noStoreJson(await simpanProfil(db, id, aksi, draft, oleh));
      case "dokumen":
        return noStoreJson(await simpanDokumen(db, draft, oleh));
      case "hapus-dokumen":
        return noStoreJson(await hapusDokumen(db, id));
      case "berkas":
        return noStoreJson(await tambahBerkas(db, draft));
      case "hapus-berkas":
        return noStoreJson(await hapusBerkas(db, id));
    }
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
