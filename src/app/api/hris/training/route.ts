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
  berkasSertifikat,
  daftarPelatihan,
  rincianPelatihan,
  riwayatPelatihan,
  simpanPelatihan,
  simpanPeserta,
  simpanSertifikat,
} from "@/lib/services/hr-pelatihan";

export const runtime = "nodejs";

// HRIS fase 7: pelatihan (prd-hris.md §22.7), khusus cloud. Kembar
// `desktop/hr_pelatihan.rs`. Berkas sertifikat dari layar ini mengikuti izin
// pelatihan; dari tab Dokumen tetap `hr.document.view` (§22.8).
const BACA: readonly PermissionKey[] = [
  "hr.training.view",
  "hr.training.manage",
];
const IZIN = {
  daftar: BACA,
  rincian: BACA,
  riwayat: BACA,
  berkas: BACA,
  simpan: ["hr.training.manage"],
  peserta: ["hr.training.manage"],
  sertifikat: ["hr.training.manage"],
} as const satisfies Record<string, readonly PermissionKey[]>;
type Aksi = keyof typeof IZIN;

const AKSI_BACA = new Set<Aksi>(["daftar", "rincian", "riwayat", "berkas"]);

const bodySchema = z
  .object({
    aksi: z.enum(Object.keys(IZIN) as [Aksi, ...Aksi[]]),
    id: z.string().trim().min(1).max(160).optional(),
    tahun: z.number().int().min(2000).max(2100).optional(),
    draft: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export async function POST(request: NextRequest) {
  try {
    // Sertifikat bisa membawa sampai 5 berkas × 1 MB (base64 ±1,4 MB).
    const parsed = bodySchema.safeParse(await readJsonBody(request, 8_000_000));
    if (!parsed.success) {
      return noStoreJson(
        { sukses: false, pesan: "Permintaan tidak valid." },
        400,
      );
    }
    const { aksi, id = "", tahun, draft = {} } = parsed.data;
    if (!AKSI_BACA.has(aksi)) assertSameOriginMutation(request);
    const izin: readonly PermissionKey[] = IZIN[aksi];
    const actor =
      izin.length === 1
        ? await requireWebPermission(request, izin[0])
        : await requireAnyWebPermission(request, izin);
    await ensureServerDatabaseInitialized();
    const db = getServerDatabase();
    switch (aksi) {
      case "daftar":
        return noStoreJson(await daftarPelatihan(db, tahun ?? null));
      case "rincian":
        return noStoreJson(await rincianPelatihan(db, id));
      case "riwayat":
        return noStoreJson(await riwayatPelatihan(db, id));
      case "berkas":
        return noStoreJson(await berkasSertifikat(db, id));
      case "simpan":
        return noStoreJson(await simpanPelatihan(db, actor, draft));
      case "peserta":
        return noStoreJson(await simpanPeserta(db, actor, draft));
      case "sertifikat":
        return noStoreJson(await simpanSertifikat(db, actor, draft));
    }
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
