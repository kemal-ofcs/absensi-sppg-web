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
  akhirPeriode,
  batalPenyesuaian,
  daftarPengajuan,
  hapusLampiran,
  isiLampiran,
  jatahCuti,
  lampiran,
  prosesAkhirPeriode,
  putuskan,
  rincianPengajuan,
  simpanAturanCuti,
  simpanJenis,
  simpanPengajuan,
  simpanPenyesuaian,
  tambahLampiran,
} from "@/lib/services/hr-pengajuan";

export const runtime = "nodejs";

// HRIS fase 2: pengajuan cuti/izin/sakit dan jatah cuti (prd-hris.md §17).
// Izin per aksi; aturan rinci (tidak untuk diri sendiri, izin pemutus per
// jenis, pengaju) dinilai service, kembar `desktop/hr_pengajuan.rs`.
const IZIN: Record<string, readonly PermissionKey[]> = {
  daftar: ["hr.request.view"],
  rincian: ["hr.request.view"],
  jatah: ["hr.request.view"],
  "akhir-periode": ["hr.request.view"],
  lampiran: ["hr.request.view"],
  berkas: ["hr.request.view"],
  ajukan: ["hr.request.submit"],
  putuskan: ["hr.request.submit", "hr.request.decide"],
  jenis: ["hr.org.manage"],
  aturan: ["hr.org.manage"],
  penyesuaian: ["hr.leave.adjust"],
  "batal-penyesuaian": ["hr.leave.adjust"],
  "proses-periode": ["hr.leave.adjust"],
  "tambah-berkas": ["hr.request.submit", "hr.request.decide"],
  "hapus-berkas": ["hr.request.submit", "hr.request.decide"],
};

const AKSI_BACA = new Set([
  "daftar",
  "rincian",
  "jatah",
  "akhir-periode",
  "lampiran",
  "berkas",
]);

const bodySchema = z
  .object({
    aksi: z.enum([
      "daftar",
      "rincian",
      "jatah",
      "akhir-periode",
      "lampiran",
      "berkas",
      "ajukan",
      "putuskan",
      "jenis",
      "aturan",
      "penyesuaian",
      "batal-penyesuaian",
      "proses-periode",
      "tambah-berkas",
      "hapus-berkas",
    ]),
    id: z.string().trim().min(1).max(160).optional(),
    draft: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export async function POST(request: NextRequest) {
  try {
    const parsed = bodySchema.safeParse(
      // Satu lampiran maks 1 MB (±1,4 juta karakter base64).
      await readJsonBody(request, 1_600_000),
    );
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
      case "daftar":
        return noStoreJson(await daftarPengajuan(db, draft));
      case "rincian":
        return noStoreJson(await rincianPengajuan(db, id));
      case "jatah":
        return noStoreJson(await jatahCuti(db, id));
      case "akhir-periode":
        return noStoreJson(await akhirPeriode(db));
      case "lampiran":
        return noStoreJson(await lampiran(db, id));
      case "berkas":
        return noStoreJson(await isiLampiran(db, id));
      case "ajukan":
        return noStoreJson(await simpanPengajuan(db, actor, draft));
      case "putuskan":
        return noStoreJson(await putuskan(db, actor, draft));
      case "jenis":
        return noStoreJson(await simpanJenis(db, draft));
      case "aturan":
        return noStoreJson(await simpanAturanCuti(db, draft));
      case "penyesuaian":
        return noStoreJson(await simpanPenyesuaian(db, actor.username, draft));
      case "batal-penyesuaian":
        return noStoreJson(await batalPenyesuaian(db, actor.username, draft));
      case "proses-periode":
        return noStoreJson(await prosesAkhirPeriode(db, actor.username, draft));
      case "tambah-berkas":
        return noStoreJson(await tambahLampiran(db, actor, draft));
      case "hapus-berkas":
        return noStoreJson(await hapusLampiran(db, actor, id));
    }
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
