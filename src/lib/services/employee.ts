import { db, ensureDbInitialized } from "@/lib/db";

export interface KaryawanInput {
  id_unik: string;
  kode_karyawan: string;
  nama: string;
  divisi: string;
  jabatan_status?: string;
  no_hp?: string;
  lp: "L" | "P";
  id_shift: number;
  status_aktif?: "Aktif" | "Nonaktif";
  tanggal_daftar?: string;
  catatan?: string;
  jenis_personil?: string;
  tanggal_mulai_aktif?: string;
  tanggal_selesai_aktif?: string;
}

export function generateRandomToken(length = 8): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let token = "";
  for (let i = 0; i < length; i++) {
    token += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return token;
}

export async function getDaftarKaryawan(filter?: {
  search?: string;
  divisi?: string;
  status_aktif?: string;
}) {
  await ensureDbInitialized();

  let query = `
    SELECT m.*, s.nama_shift, c.idcard_status, c.idcard_pdf_url, c.link_qr_png
    FROM master_data m
    LEFT JOIN tbl_shift s ON m.id_shift = s.id_shift
    LEFT JOIN id_card c ON m.id_unik = c.id_unik
    WHERE 1=1
  `;
  const params: (string | number | boolean | null)[] = [];

  if (filter?.search) {
    query +=
      " AND (m.nama LIKE ? OR m.kode_karyawan LIKE ? OR m.id_unik LIKE ? OR m.divisi LIKE ?)";
    const s = `%${filter.search}%`;
    params.push(s, s, s, s);
  }

  if (filter?.divisi) {
    query += " AND m.divisi = ?";
    params.push(filter.divisi);
  }

  if (filter?.status_aktif) {
    query += " AND m.status_aktif = ?";
    params.push(filter.status_aktif);
  }

  query += " ORDER BY m.nama ASC;";

  const res = await db.execute({ sql: query, args: params });
  return res.rows as unknown as Record<string, unknown>[];
}

export async function getKaryawanById(id_unik: string) {
  await ensureDbInitialized();

  const res = await db.execute({
    sql: `
      SELECT m.*, s.nama_shift, c.idcard_status, c.idcard_pdf_url, c.link_qr_png, c.idcard_last_generate
      FROM master_data m
      LEFT JOIN tbl_shift s ON m.id_shift = s.id_shift
      LEFT JOIN id_card c ON m.id_unik = c.id_unik
      WHERE m.id_unik = ? OR m.kode_karyawan = ? LIMIT 1;
    `,
    args: [id_unik, id_unik],
  });

  return res.rows[0]
    ? (res.rows[0] as unknown as Record<string, unknown>)
    : null;
}

export async function tambahKaryawan(data: KaryawanInput) {
  await ensureDbInitialized();

  const tokenAbsensi = generateRandomToken(10);
  const qrCodePayload = `${data.id_unik}|${tokenAbsensi}`;
  const today = data.tanggal_daftar || new Date().toISOString().split("T")[0];

  // 1. Insert ke master_data
  await db.execute({
    sql: `
      INSERT INTO master_data (
        id_unik, kode_karyawan, nama, divisi, jabatan_status, no_hp, lp,
        id_shift, status_aktif, tanggal_daftar, catatan, token_absensi, qr_code,
        status_qr, jenis_personil, tanggal_mulai_aktif, tanggal_selesai_aktif, status_backup
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Generated', ?, ?, ?, 'NORMAL');
    `,
    args: [
      data.id_unik,
      data.kode_karyawan,
      data.nama,
      data.divisi,
      data.jabatan_status || "-",
      data.no_hp || "",
      data.lp,
      data.id_shift,
      data.status_aktif || "Aktif",
      today,
      data.catatan || "",
      tokenAbsensi,
      qrCodePayload,
      data.jenis_personil || "Pegawai",
      data.tanggal_mulai_aktif || today,
      data.tanggal_selesai_aktif || "",
    ],
  });

  // 2. Insert record ke id_card
  await db.execute({
    sql: `
      INSERT OR IGNORE INTO id_card (id_unik, nama, divisi, idcard_status, tanggal_generate)
      VALUES (?, ?, ?, 'Belum', ?);
    `,
    args: [data.id_unik, data.nama, data.divisi, today],
  });

  return { sukses: true, id_unik: data.id_unik, token_absensi: tokenAbsensi };
}

export async function updateKaryawan(
  id_unik: string,
  data: Partial<KaryawanInput>,
) {
  await ensureDbInitialized();

  const updates: string[] = [];
  const args: (string | number | boolean | null)[] = [];

  if (data.kode_karyawan !== undefined) {
    updates.push("kode_karyawan = ?");
    args.push(data.kode_karyawan);
  }
  if (data.nama !== undefined) {
    updates.push("nama = ?");
    args.push(data.nama);
  }
  if (data.divisi !== undefined) {
    updates.push("divisi = ?");
    args.push(data.divisi);
  }
  if (data.jabatan_status !== undefined) {
    updates.push("jabatan_status = ?");
    args.push(data.jabatan_status);
  }
  if (data.no_hp !== undefined) {
    updates.push("no_hp = ?");
    args.push(data.no_hp);
  }
  if (data.lp !== undefined) {
    updates.push("lp = ?");
    args.push(data.lp);
  }
  if (data.id_shift !== undefined) {
    updates.push("id_shift = ?");
    args.push(data.id_shift);
  }
  if (data.status_aktif !== undefined) {
    updates.push("status_aktif = ?");
    args.push(data.status_aktif);
  }
  if (data.catatan !== undefined) {
    updates.push("catatan = ?");
    args.push(data.catatan);
  }

  if (updates.length > 0) {
    args.push(id_unik);
    await db.execute({
      sql: `UPDATE master_data SET ${updates.join(", ")} WHERE id_unik = ?;`,
      args,
    });

    // Update nama & divisi di id_card
    if (data.nama || data.divisi) {
      const idCardUpdates: string[] = [];
      const idCardArgs: (string | number | boolean | null)[] = [];
      if (data.nama) {
        idCardUpdates.push("nama = ?");
        idCardArgs.push(data.nama);
      }
      if (data.divisi) {
        idCardUpdates.push("divisi = ?");
        idCardArgs.push(data.divisi);
      }
      idCardArgs.push(id_unik);
      await db.execute({
        sql: `UPDATE id_card SET ${idCardUpdates.join(", ")} WHERE id_unik = ?;`,
        args: idCardArgs,
      });
    }
  }

  return { sukses: true };
}

export async function toggleStatusKaryawan(
  id_unik: string,
  status_aktif: "Aktif" | "Nonaktif",
) {
  await ensureDbInitialized();

  await db.execute({
    sql: "UPDATE master_data SET status_aktif = ? WHERE id_unik = ?;",
    args: [status_aktif, id_unik],
  });

  return { sukses: true };
}

export async function generateTokenMassal() {
  await ensureDbInitialized();

  const listRes = await db.execute(
    "SELECT id_unik, token_absensi FROM master_data WHERE token_absensi IS NULL OR token_absensi = '';",
  );

  let updatedCount = 0;
  for (const row of listRes.rows) {
    const id = String(row.id_unik);
    const token = generateRandomToken(10);
    const qrPayload = `${id}|${token}`;

    await db.execute({
      sql: "UPDATE master_data SET token_absensi = ?, qr_code = ?, status_qr = 'Generated' WHERE id_unik = ?;",
      args: [token, qrPayload, id],
    });
    updatedCount++;
  }

  return { sukses: true, total_generated: updatedCount };
}
