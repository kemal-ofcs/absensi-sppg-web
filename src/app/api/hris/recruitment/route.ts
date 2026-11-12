import type { NextRequest } from "next/server";
import { z } from "zod";
import type { OperatorUser } from "@/lib/auth/operator-user";
import type { PermissionKey } from "@/lib/rbac/catalog";
import {
  requireAnyWebPermission,
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
  berkasPelamar,
  bersihkanPelamar,
  catatTahap,
  daftarLowongan,
  daftarPelamar,
  hapusPelamar,
  jadikanKaryawan,
  rincianPelamar,
  simpanBerkas,
  simpanLowongan,
  simpanPelamar,
} from "@/lib/services/hr-rekrutmen";
import { IZIN_JADIKAN_KARYAWAN } from "@/lib/validations/hr-rekrutmen";

export const runtime = "nodejs";

// HRIS fase 7: rekrutmen (prd-hris.md §22.3–§22.6), khusus cloud. Izin per
// aksi; aturan rinci dinilai service, kembar `desktop/hr_rekrutmen.rs`.
const BACA: readonly PermissionKey[] = ["hr.recruit.view", "hr.recruit.manage"];
const IZIN = {
  daftar: BACA,
  pelamar: BACA,
  rincian: BACA,
  berkas: BACA,
  "simpan-lowongan": ["hr.recruit.manage"],
  "simpan-pelamar": ["hr.recruit.manage"],
  tahap: ["hr.recruit.manage"],
  "simpan-berkas": ["hr.recruit.manage"],
  // Q-100: ketiganya sekaligus, bukan salah satu.
  jadikan: IZIN_JADIKAN_KARYAWAN,
  hapus: ["hr.recruit.delete"],
  // Retensi: aturan tetap, cukup sesi (Q-93).
  bersihkan: [],
} as const satisfies Record<string, readonly PermissionKey[]>;
type Aksi = keyof typeof IZIN;

const AKSI_BACA = new Set<Aksi>(["daftar", "pelamar", "rincian", "berkas"]);

const bodySchema = z
  .object({
    aksi: z.enum(Object.keys(IZIN) as [Aksi, ...Aksi[]]),
    id: z.string().trim().min(1).max(160).optional(),
    draft: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

async function aktor(request: NextRequest, aksi: Aksi): Promise<OperatorUser> {
  const izin: readonly PermissionKey[] = IZIN[aksi];
  if (izin.length === 0) return requireWebSession(request);
  if (aksi === "jadikan") {
    let actor: OperatorUser | null = null;
    for (const satu of izin) actor = await requireWebPermission(request, satu);
    if (!actor) throw new Error("Akses ditolak untuk tindakan ini.");
    return actor;
  }
  return izin.length === 1
    ? requireWebPermission(request, izin[0])
    : requireAnyWebPermission(request, izin);
}

export async function POST(request: NextRequest) {
  try {
    // Berkas lamaran maks 1 MB (base64 ±1,4 MB), satu per permintaan.
    const parsed = bodySchema.safeParse(await readJsonBody(request, 1_600_000));
    if (!parsed.success) {
      return noStoreJson(
        { sukses: false, pesan: "Permintaan tidak valid." },
        400,
      );
    }
    const { aksi, id = "", draft = {} } = parsed.data;
    if (!AKSI_BACA.has(aksi)) assertSameOriginMutation(request);
    const actor = await aktor(request, aksi);
    await ensureServerDatabaseInitialized();
    const db = getServerDatabase();
    switch (aksi) {
      case "daftar":
        return noStoreJson(await daftarLowongan(db));
      case "pelamar":
        return noStoreJson(await daftarPelamar(db, id));
      case "rincian":
        return noStoreJson(await rincianPelamar(db, id));
      case "berkas":
        return noStoreJson(await berkasPelamar(db, id));
      case "simpan-lowongan":
        return noStoreJson(await simpanLowongan(db, actor, draft));
      case "simpan-pelamar":
        return noStoreJson(await simpanPelamar(db, actor, draft));
      case "tahap":
        return noStoreJson(await catatTahap(db, actor, draft));
      case "simpan-berkas":
        return noStoreJson(await simpanBerkas(db, draft));
      case "jadikan":
        return noStoreJson(await jadikanKaryawan(db, actor, draft));
      case "hapus":
        return noStoreJson(await hapusPelamar(db, id));
      case "bersihkan":
        return noStoreJson(await bersihkanPelamar(db));
    }
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
