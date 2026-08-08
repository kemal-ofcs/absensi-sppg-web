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
    SELECT c.*, m.kode_karyawan, m.status_aktif, m.token_absensi, m.qr_code
    FROM id_card c
    JOIN master_data m ON c.id_unik = m.id_unik
    WHERE 1=1
  `;
  const params: (string | number | boolean | null)[] = [];

  if (filter?.status) {
    query += " AND c.idcard_status = ?";
    params.push(filter.status);
  }

  if (filter?.search) {
    query += " AND (c.nama LIKE ? OR c.id_unik LIKE ? OR c.divisi LIKE ?)";
    const s = `%${filter.search}%`;
    params.push(s, s, s);
  }

  query += " ORDER BY c.nama ASC;";

  const res = await db.execute({ sql: query, args: params });
  return res.rows as unknown as Record<string, unknown>[];
}

export async function updateStatusIdCard(data: IdCardUpdateInput) {
  await ensureDbInitialized();

  const now = new Date().toISOString();
  const today = now.split("T")[0];

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

export async function generateQrPngDataUrl(
  id_unik: string,
  token: string,
): Promise<string> {
  // Payload string QR format: ID_Unik|Token
  const payload = `${id_unik}|${token}`;

  // Menggunakan API QR Server public / Canvas SVG generator data URL
  const qrApiUrl = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(payload)}`;

  return qrApiUrl;
}
