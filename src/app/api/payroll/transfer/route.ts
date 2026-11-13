import type { NextRequest } from "next/server";
import { z } from "zod";
import { hasPermission } from "@/lib/auth/access";
import type { OperatorUser } from "@/lib/auth/operator-user";
import {
  requireWebPermission,
  requireWebSession,
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
  berkasTransfer,
  pengaturanTransfer,
  simpanPengaturanTransfer,
} from "@/lib/services/transfer";
import {
  IZIN_PENGATURAN,
  IZIN_UNDUH,
  JENIS_PENGATURAN,
} from "@/lib/validations/transfer";

export const runtime = "nodejs";

// HRIS fase 12: berkas transfer gaji ke bank (prd-hris.md §27.5), khusus
// cloud. Kembar `desktop_transfer_settings`, `desktop_transfer_settings_save`,
// dan `desktop_payroll_transfer`.
const AKSI = ["pengaturan", "simpan_pengaturan", "berkas"] as const;
type Aksi = (typeof AKSI)[number];

const bodySchema = z
  .object({
    aksi: z.enum(AKSI),
    jenis: z.enum(JENIS_PENGATURAN).optional(),
    id: z.string().trim().min(1).max(160).optional(),
    draft: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

/** Kedua izin unduh sekaligus, bukan salah satu (Q-157 (a)). */
async function pemegangUnduh(request: NextRequest): Promise<OperatorUser> {
  let actor: OperatorUser | null = null;
  for (const izin of IZIN_UNDUH) {
    actor = await requireWebPermission(request, izin);
  }
  if (!actor) throw new Error("Akses ditolak untuk tindakan ini.");
  return actor;
}

async function aktor(request: NextRequest, aksi: Aksi): Promise<OperatorUser> {
  switch (aksi) {
    // Daftar bank aktif cukup sesi (isian profil keuangan); cakupan lain
    // dinilai dari izin yang dipegang.
    case "pengaturan":
      return requireWebSession(request);
    case "simpan_pengaturan":
      return requireWebPermission(request, IZIN_PENGATURAN);
    case "berkas":
      return pemegangUnduh(request);
  }
}

export async function POST(request: NextRequest) {
  try {
    const parsed = bodySchema.safeParse(await readJsonBody(request, 200_000));
    if (!parsed.success) {
      return noStoreJson(
        { sukses: false, pesan: "Permintaan tidak valid." },
        400,
      );
    }
    const { aksi, jenis, id, draft = {} } = parsed.data;
    // `berkas` dengan `catat` menulis jejak unduhan, jadi ikut dijaga origin.
    if (aksi !== "pengaturan") assertSameOriginMutation(request);
    const actor = await aktor(request, aksi);
    await ensureServerDatabaseInitialized();
    const db = getServerDatabase();
    switch (aksi) {
      case "pengaturan": {
        const atur = hasPermission(actor, IZIN_PENGATURAN);
        const unduh = IZIN_UNDUH.every((izin) => hasPermission(actor, izin));
        return noStoreJson(await pengaturanTransfer(db, atur, unduh));
      }
      case "simpan_pengaturan":
        if (!jenis) {
          return noStoreJson(
            { sukses: false, pesan: "Jenis pengaturan tidak dikenal." },
            400,
          );
        }
        return noStoreJson(
          await simpanPengaturanTransfer(db, actor, jenis, id ?? null, draft),
        );
      case "berkas":
        return noStoreJson(await berkasTransfer(db, actor, draft));
    }
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
