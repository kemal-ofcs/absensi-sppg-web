import "server-only";

import { db, ensureDbInitialized } from "@/lib/db";

export interface PersonnelPhotoData {
  id_unik: string;
  foto_mime: string;
  foto_base64: string;
  updated_at: string;
}

export async function getPersonnelPhoto(
  idUnik: string,
): Promise<PersonnelPhotoData | null> {
  await ensureDbInitialized();
  const res = await db.execute({
    sql: "SELECT id_unik, foto_mime, foto_base64, updated_at FROM personil_foto WHERE id_unik = ?;",
    args: [idUnik],
  });
  if (res.rows.length === 0) return null;
  const row = res.rows[0];
  return {
    id_unik: String(row.id_unik),
    foto_mime: String(row.foto_mime),
    foto_base64: String(row.foto_base64),
    updated_at: String(row.updated_at),
  };
}

export async function savePersonnelPhoto(
  idUnik: string,
  fotoBase64: string,
  fotoMime: string,
): Promise<{ sukses: boolean; id_unik: string }> {
  await ensureDbInitialized();

  const id = idUnik.trim();
  if (!id) {
    throw new Error("ID personil wajib diisi.");
  }
  const mime = fotoMime.trim();
  if (!["image/jpeg", "image/png", "image/webp"].includes(mime)) {
    throw new Error(
      "Format foto tidak didukung. Gunakan JPEG, PNG, atau WebP.",
    );
  }
  const b64 = fotoBase64.trim();
  if (!b64) {
    throw new Error("Foto personil tidak boleh kosong.");
  }
  if (b64.length > 512_000) {
    throw new Error("Ukuran foto melebihi batas maksimal 500 KB.");
  }

  const now = new Date().toISOString();
  await db.execute({
    sql: `
      INSERT INTO personil_foto (id_unik, foto_mime, foto_base64, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(id_unik) DO UPDATE SET
        foto_mime = excluded.foto_mime,
        foto_base64 = excluded.foto_base64,
        updated_at = excluded.updated_at;
    `,
    args: [id, mime, b64, now],
  });

  return { sukses: true, id_unik: id };
}

export async function deletePersonnelPhoto(
  idUnik: string,
): Promise<{ sukses: boolean; id_unik: string }> {
  await ensureDbInitialized();
  const id = idUnik.trim();
  if (!id) {
    throw new Error("ID personil wajib diisi.");
  }
  await db.execute({
    sql: "DELETE FROM personil_foto WHERE id_unik = ?;",
    args: [id],
  });
  return { sukses: true, id_unik: id };
}
