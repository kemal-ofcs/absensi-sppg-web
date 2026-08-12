import "server-only";

import { db, ensureDbInitialized } from "@/lib/db";

export interface IdCardUpdateInput {
  id_unik: string;
  idcard_status: "Belum" | "Berhasil" | "Gagal";
  idcard_pdf_url?: string;
  link_qr_png?: string;
  idcard_catatan?: string;
}

export async function getDaftarIdCard(filter?: {
  status?: string;
  search?: string;
}) {
  await ensureDbInitialized();

  let query = `
    SELECT c.id_card_id, m.id_unik, m.nama, m.divisi,
      COALESCE(c.idcard_status, 'Belum') AS idcard_status,
      c.idcard_pdf_url, c.idcard_last_generate, c.idcard_catatan,
      c.tanggal_generate, c.link_qr_png, m.kode_karyawan, m.status_aktif,
      m.token_absensi, m.qr_code
    FROM master_data m
    LEFT JOIN id_card c ON c.id_unik = m.id_unik
    WHERE 1=1
  `;
  const params: (string | number | boolean | null)[] = [];

  if (filter?.status) {
    query += " AND COALESCE(c.idcard_status, 'Belum') = ?";
    params.push(filter.status);
  }

  if (filter?.search) {
    query += " AND (m.nama LIKE ? OR m.id_unik LIKE ? OR m.divisi LIKE ?)";
    const s = `%${filter.search}%`;
    params.push(s, s, s);
  }

  query += " ORDER BY m.nama ASC;";

  const res = await db.execute({ sql: query, args: params });
  return res.rows as unknown as Record<string, unknown>[];
}

export async function updateStatusIdCard(data: IdCardUpdateInput) {
  await ensureDbInitialized();

  const now = new Date().toISOString();
  const today = now.split("T")[0];

  await db.execute({
    sql: `INSERT OR IGNORE INTO id_card
      (id_unik, nama, divisi, idcard_status, tanggal_generate)
      SELECT id_unik, nama, divisi, 'Belum', ? FROM master_data
      WHERE id_unik = ?;`,
    args: [today, data.id_unik],
  });

  const updates: string[] = [
    "idcard_status = ?",
    "tanggal_generate = ?",
    "idcard_last_generate = ?",
  ];
  const args: (string | number | boolean | null)[] = [
    data.idcard_status,
    today,
    now,
  ];

  if (data.idcard_pdf_url !== undefined) {
    updates.push("idcard_pdf_url = ?");
    args.push(data.idcard_pdf_url);
  }
  if (data.link_qr_png !== undefined) {
    updates.push("link_qr_png = ?");
    args.push(data.link_qr_png);
  }
  if (data.idcard_catatan !== undefined) {
    updates.push("idcard_catatan = ?");
    args.push(data.idcard_catatan);
  }

  args.push(data.id_unik);

  await db.execute({
    sql: `UPDATE id_card SET ${updates.join(", ")} WHERE id_unik = ?;`,
    args,
  });

  return { sukses: true };
}
