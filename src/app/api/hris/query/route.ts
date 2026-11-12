import type { NextRequest } from "next/server";
import { z } from "zod";
import { hasPermission } from "@/lib/auth/access";
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
import {
  berkas,
  dokumen,
  jenisDokumen,
  kontrak,
  organisasi,
  profil,
} from "@/lib/services/hris";
import { perhatianHr } from "@/lib/services/telegram";
import { IZIN_PERHATIAN, izinPerhatian } from "@/lib/validations/telegram";

export const runtime = "nodejs";

const bodySchema = z
  .object({
    aksi: z.enum([
      "org",
      "kontrak",
      "profil",
      "dokumen",
      "jenis-dokumen",
      "berkas",
      "perhatian",
    ]),
    id: z.string().trim().min(1).max(160).optional(),
  })
  .strict();

export async function POST(request: NextRequest) {
  try {
    const parsed = bodySchema.safeParse(await readJsonBody(request));
    if (!parsed.success) {
      return noStoreJson(
        { sukses: false, pesan: "Permintaan tidak valid." },
        400,
      );
    }
    const { aksi, id } = parsed.data;
    const db = getServerDatabase();
    switch (aksi) {
      case "org":
        await requireWebPermission(request, "employees.view");
        await ensureServerDatabaseInitialized();
        return noStoreJson(await organisasi(db));
      case "kontrak":
        await requireWebPermission(request, "employees.view");
        await ensureServerDatabaseInitialized();
        return noStoreJson(await kontrak(db, id ?? null));
      case "profil": {
        const actor = await requireAnyWebPermission(request, [
          "hr.personal.view",
          "hr.finance.view",
        ]);
        if (!id) throw new Error("Karyawan tidak ditemukan.");
        await ensureServerDatabaseInitialized();
        return noStoreJson(
          await profil(
            db,
            id,
            hasPermission(actor, "hr.personal.view"),
            hasPermission(actor, "hr.finance.view"),
          ),
        );
      }
      case "dokumen":
        await requireWebPermission(request, "hr.document.view");
        if (!id) throw new Error("Karyawan tidak ditemukan.");
        await ensureServerDatabaseInitialized();
        return noStoreJson(await dokumen(db, id));
      case "jenis-dokumen":
        await requireAnyWebPermission(request, [
          "hr.org.manage",
          "hr.document.view",
        ]);
        await ensureServerDatabaseInitialized();
        return noStoreJson(await jenisDokumen(db));
      case "berkas":
        await requireWebPermission(request, "hr.document.view");
        if (!id) throw new Error("Berkas tidak ditemukan.");
        await ensureServerDatabaseInitialized();
        return noStoreJson(await berkas(db, id));
      case "perhatian": {
        // Bagian disaring per izin di backend (aturan 10, 44).
        const actor = await requireAnyWebPermission(request, [
          ...IZIN_PERHATIAN,
        ]);
        await ensureServerDatabaseInitialized();
        return noStoreJson(
          await perhatianHr(
            db,
            izinPerhatian((izin) => hasPermission(actor, izin)),
          ),
        );
      }
    }
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
