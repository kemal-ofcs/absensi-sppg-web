import "server-only";

import type { Client } from "@libsql/client";
import { ApiRequestError } from "@/lib/server/http/api-response";
import {
  type FaceTemplateDraft,
  type FaceTemplateStatus,
  toFaceTemplateStatus,
  validateFaceTemplate,
} from "@/lib/validations/face-match";

/**
 * Pendaftaran wajah untuk Web. Cermin `face_match.rs` (Desktop/Mobile): aturan
 * simpannya `validateFaceTemplate` ↔ `validate_template`, dan barisnya sama
 * dengan yang didorong lewat event `face-template/save`.
 */

export async function listFaceTemplates(
  client: Client,
): Promise<FaceTemplateStatus[]> {
  // Kembar dengan `LIST_TEMPLATES_SQL` di `face_match.rs`.
  const result = await client.execute(
    `SELECT m.id_unik, COALESCE(m.nama, '') AS nama, COALESCE(m.jabatan_status, '') AS jabatan,
                    COALESCE(m.divisi, '') AS divisi, w.model, w.jumlah_sampel, w.sumber,
                    w.dibuat_oleh, w.updated_at
             FROM master_data m
             LEFT JOIN personil_wajah w ON w.id_unik = m.id_unik
             WHERE COALESCE(m.status_aktif, 'Aktif') <> 'Nonaktif' OR w.id_unik IS NOT NULL
             ORDER BY m.nama COLLATE NOCASE
             -- batas: satu baris per karyawan, dibatasi jumlah karyawan perusahaan
             ;`,
  );
  return result.rows.map((row) =>
    toFaceTemplateStatus(row as unknown as Record<string, unknown>),
  );
}

export async function saveFaceTemplate(
  client: Client,
  draft: FaceTemplateDraft,
  dibuatOleh: string,
) {
  const message = validateFaceTemplate(draft);
  if (message) throw new ApiRequestError(message, 400);
  const idUnik = draft.idUnik.trim();
  const personil = await client.execute({
    sql: "SELECT 1 FROM master_data WHERE id_unik = ?;",
    args: [idUnik],
  });
  if (!personil.rows.length) {
    throw new ApiRequestError("Karyawan tidak ditemukan.", 404);
  }
  await client.execute({
    sql: `INSERT INTO personil_wajah (id_unik, model, vektor, jumlah_sampel, sumber, dibuat_oleh, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
          ON CONFLICT(id_unik) DO UPDATE SET
            model = excluded.model, vektor = excluded.vektor,
            jumlah_sampel = excluded.jumlah_sampel, sumber = excluded.sumber,
            dibuat_oleh = excluded.dibuat_oleh, updated_at = excluded.updated_at;`,
    args: [
      idUnik,
      draft.model,
      draft.vektor.trim(),
      draft.jumlahSampel,
      draft.sumber,
      dibuatOleh,
    ],
  });
  return { sukses: true };
}

export async function deleteFaceTemplate(client: Client, idUnik: string) {
  const id = idUnik.trim();
  if (!id) throw new ApiRequestError("Karyawan wajib dipilih.", 400);
  await client.execute({
    sql: "DELETE FROM personil_wajah WHERE id_unik = ?;",
    args: [id],
  });
  return { sukses: true };
}
