import { db, ensureDbInitialized } from "@/lib/db";

export interface ShiftInput {
  kode_shift: number;
  nama_shift: string;
  jam_masuk: string;
  jam_pulang: string;
  awal_absen_menit?: number;
  batas_masuk_menit?: number;
  toleransi_masuk_menit?: number;
  jam_kerja_normal_menit?: number;
  istirahat_menit?: number;
  batas_pulang_menit?: number;
  offset_istirahat_mulai?: number;
  offset_generate_alfa?: number;
  buffer_shift_malam_menit?: number;
}

export async function getDaftarShift() {
  await ensureDbInitialized();

  const res = await db.execute(
    "SELECT * FROM tbl_shift ORDER BY kode_shift ASC;",
  );
  return res.rows as unknown as Record<string, unknown>[];
}

export async function getShiftById(id_shift: number) {
  await ensureDbInitialized();

  const res = await db.execute({
    sql: "SELECT * FROM tbl_shift WHERE id_shift = ? OR kode_shift = ? LIMIT 1;",
    args: [id_shift, id_shift],
  });

  return res.rows[0]
    ? (res.rows[0] as unknown as Record<string, unknown>)
    : null;
}

export async function tambahShift(data: ShiftInput) {
  await ensureDbInitialized();

  const res = await db.execute({
    sql: `
      INSERT INTO tbl_shift (
        kode_shift, nama_shift, jam_masuk, jam_pulang, awal_absen_menit,
        batas_masuk_menit, toleransi_masuk_menit, jam_kerja_normal_menit,
        istirahat_menit, batas_pulang_menit, offset_istirahat_mulai,
        offset_generate_alfa, buffer_shift_malam_menit
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
    `,
    args: [
      data.kode_shift,
      data.nama_shift,
      data.jam_masuk,
      data.jam_pulang,
      data.awal_absen_menit ?? 60,
      data.batas_masuk_menit ?? 120,
      data.toleransi_masuk_menit ?? 0,
      data.jam_kerja_normal_menit ?? 480,
      data.istirahat_menit ?? 60,
      data.batas_pulang_menit ?? 240,
      data.offset_istirahat_mulai ?? 240,
      data.offset_generate_alfa ?? 180,
      data.buffer_shift_malam_menit ?? 120,
    ],
  });

  return { sukses: true, id_shift: Number(res.lastInsertRowid) };
}

export async function updateShift(id_shift: number, data: Partial<ShiftInput>) {
  await ensureDbInitialized();

  const updates: string[] = [];
  const args: (string | number | boolean | null)[] = [];

  if (data.nama_shift !== undefined) {
    updates.push("nama_shift = ?");
    args.push(data.nama_shift);
  }
  if (data.jam_masuk !== undefined) {
    updates.push("jam_masuk = ?");
    args.push(data.jam_masuk);
  }
  if (data.jam_pulang !== undefined) {
    updates.push("jam_pulang = ?");
    args.push(data.jam_pulang);
  }
  if (data.toleransi_masuk_menit !== undefined) {
    updates.push("toleransi_masuk_menit = ?");
    args.push(data.toleransi_masuk_menit);
  }
  if (data.jam_kerja_normal_menit !== undefined) {
    updates.push("jam_kerja_normal_menit = ?");
    args.push(data.jam_kerja_normal_menit);
  }
  if (data.istirahat_menit !== undefined) {
    updates.push("istirahat_menit = ?");
    args.push(data.istirahat_menit);
  }

  if (updates.length > 0) {
    args.push(id_shift);
    await db.execute({
      sql: `UPDATE tbl_shift SET ${updates.join(", ")} WHERE id_shift = ?;`,
      args,
    });
  }

  return { sukses: true };
}

export async function hapusShift(id_shift: number) {
  await ensureDbInitialized();

  // Cek apakah shift sedang digunakan di master_data
  const checkRes = await db.execute({
    sql: "SELECT COUNT(*) as count FROM master_data WHERE id_shift = ?;",
    args: [id_shift],
  });

  if (Number(checkRes.rows[0]?.count || 0) > 0) {
    return {
      sukses: false,
      pesan: "Gagal menghapus shift: Shift ini sedang digunakan oleh karyawan.",
    };
  }

  await db.execute({
    sql: "DELETE FROM tbl_shift WHERE id_shift = ?;",
    args: [id_shift],
  });

  return { sukses: true };
}
