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
  batalkan,
  berlakukan,
  cabutSp,
  daftarKeluar,
  daftarSp,
  pratinjauKeluar,
  rincianKeluar,
  simpanAlasan,
  simpanKeluar,
  simpanSp,
} from "@/lib/services/hr-keluar";

export const runtime = "nodejs";

// HRIS fase 5: surat peringatan dan karyawan keluar (prd-hris.md §20), khusus
// cloud. Izin per aksi; aturan rinci (tidak untuk diri sendiri, usulan tingkat,
// usulan pesangon) dinilai service, kembar `desktop/hr_keluar.rs`.
const LIHAT_KELUAR: readonly PermissionKey[] = [
  "hr.offboard.view",
  "hr.offboard.manage",
];
const IZIN = {
  "sp-daftar": ["hr.warning.view"],
  "sp-simpan": ["hr.warning.manage"],
  "sp-cabut": ["hr.warning.cancel"],
  daftar: LIHAT_KELUAR,
  rincian: LIHAT_KELUAR,
  pratinjau: LIHAT_KELUAR,
  simpan: ["hr.offboard.manage"],
  berlakukan: ["hr.offboard.manage"],
  batalkan: ["hr.offboard.manage"],
  alasan: ["hr.offboard.manage"],
} as const satisfies Record<string, readonly PermissionKey[]>;
type Aksi = keyof typeof IZIN;

const AKSI_BACA = new Set<Aksi>([
  "sp-daftar",
  "daftar",
  "rincian",
  "pratinjau",
]);

const bodySchema = z
  .object({
    aksi: z.enum(Object.keys(IZIN) as [Aksi, ...Aksi[]]),
    id: z.string().trim().min(1).max(160).optional(),
    draft: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

const teks = (nilai: unknown) =>
  typeof nilai === "string" ? nilai.trim() : "";

export async function POST(request: NextRequest) {
  try {
    const parsed = bodySchema.safeParse(await readJsonBody(request));
    if (!parsed.success) {
      return noStoreJson(
        { sukses: false, pesan: "Permintaan tidak valid." },
        400,
      );
    }
    const { aksi, id = "", draft = {} } = parsed.data;
    if (!AKSI_BACA.has(aksi)) assertSameOriginMutation(request);
    const izin: readonly PermissionKey[] = IZIN[aksi];
    const actor =
      izin.length === 1
        ? await requireWebPermission(request, izin[0])
        : await requireAnyWebPermission(request, izin);
    await ensureServerDatabaseInitialized();
    const db = getServerDatabase();
    switch (aksi) {
      case "sp-daftar":
        return noStoreJson(await daftarSp(db, id || null));
      case "sp-simpan":
        return noStoreJson(await simpanSp(db, actor, draft));
      case "sp-cabut":
        return noStoreJson(await cabutSp(db, actor, draft));
      case "daftar":
        return noStoreJson(await daftarKeluar(db));
      case "rincian":
        return noStoreJson(await rincianKeluar(db, id));
      case "pratinjau":
        return noStoreJson(
          await pratinjauKeluar(
            db,
            teks(draft.id_karyawan),
            teks(draft.id_alasan),
            teks(draft.tanggal_terakhir),
          ),
        );
      case "simpan":
        return noStoreJson(await simpanKeluar(db, actor, draft));
      case "berlakukan":
        return noStoreJson(await berlakukan(db, actor, id));
      case "batalkan":
        return noStoreJson(await batalkan(db, actor, draft));
      case "alasan":
        return noStoreJson(await simpanAlasan(db, draft));
    }
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
