import "server-only";

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
  izinkan_multi_sesi?: number | boolean;
}

/**
 * Mengkonversi format "HH:mm" atau "HH:mm:ss" ke total menit dari 00:00
 */
export function ubahJamKeMenit(
  nilaiJam: string | null | undefined,
): number | null {
  if (!nilaiJam) return null;

  const match = /^(\d{2}):(\d{2})(?::\d{2})?$/.exec(nilaiJam.trim());
  if (!match) return null;
  const jam = Number.parseInt(match[1], 10);
  const menit = Number.parseInt(match[2], 10);
  if (Number.isNaN(jam) || Number.isNaN(menit)) return null;
  return jam * 60 + menit;
}

/**
 * Menghitung jam kerja normal dalam satuan MENIT sesuai acuan code-sheet/13.1_Helper_Tambahan.txt
 * Rumus: (jamPulang - jamMasuk) - istirahat + batasMasuk
 */
export function kalkulasiJamKerjaNormalMenit(
  jamMasuk: string,
  jamPulang: string,
  istirahatMenit: number = 60,
  batasMasukMenit: number = 60,
): number {
  const menitMasuk = ubahJamKeMenit(jamMasuk);
  let menitPulang = ubahJamKeMenit(jamPulang);

  if (menitMasuk === null || menitPulang === null) {
    return 0;
  }

  // Penanganan Shift Malam (jika jam pulang melewati tengah malam)
  if (menitPulang < menitMasuk) {
    menitPulang += 1440; // Tambah 24 jam (1440 menit)
  }

  const istirahat = Number(istirahatMenit || 0);
  const batasMasuk = Number(batasMasukMenit || 0);

  const totalMenit = menitPulang - menitMasuk - istirahat + batasMasuk;
  return totalMenit > 0 ? totalMenit : 0;
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

  const awalAbsen = data.awal_absen_menit ?? 120;
  const batasMasuk = data.batas_masuk_menit ?? 60;
  const istirahat = data.istirahat_menit ?? 60;
  const jamKerjaNormal =
    data.jam_kerja_normal_menit ??
    kalkulasiJamKerjaNormalMenit(
      data.jam_masuk,
      data.jam_pulang,
      istirahat,
      batasMasuk,
    );

  const res = await db.execute({
    sql: `
      INSERT INTO tbl_shift (
        kode_shift, nama_shift, jam_masuk, jam_pulang, awal_absen_menit,
        batas_masuk_menit, toleransi_masuk_menit, jam_kerja_normal_menit,
        istirahat_menit, batas_pulang_menit, offset_istirahat_mulai,
        offset_generate_alfa, buffer_shift_malam_menit, izinkan_multi_sesi
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
    `,
    args: [
      data.kode_shift,
      data.nama_shift,
      data.jam_masuk,
      data.jam_pulang,
      awalAbsen,
      batasMasuk,
      data.toleransi_masuk_menit ?? 0,
      jamKerjaNormal,
      istirahat,
      data.batas_pulang_menit ?? 240,
      data.offset_istirahat_mulai ?? 240,
      data.offset_generate_alfa ?? 180,
      data.buffer_shift_malam_menit ?? 120,
      data.izinkan_multi_sesi === true || Number(data.izinkan_multi_sesi) === 1
        ? 1
        : 0,
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
  if (data.awal_absen_menit !== undefined) {
    updates.push("awal_absen_menit = ?");
    args.push(data.awal_absen_menit);
  }
  if (data.batas_masuk_menit !== undefined) {
    updates.push("batas_masuk_menit = ?");
    args.push(data.batas_masuk_menit);
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
  if (data.batas_pulang_menit !== undefined) {
    updates.push("batas_pulang_menit = ?");
    args.push(data.batas_pulang_menit);
  }
  if (data.offset_istirahat_mulai !== undefined) {
    updates.push("offset_istirahat_mulai = ?");
    args.push(data.offset_istirahat_mulai);
  }
  if (data.offset_generate_alfa !== undefined) {
    updates.push("offset_generate_alfa = ?");
    args.push(data.offset_generate_alfa);
  }
  if (data.buffer_shift_malam_menit !== undefined) {
    updates.push("buffer_shift_malam_menit = ?");
    args.push(data.buffer_shift_malam_menit);
  }
  if (data.izinkan_multi_sesi !== undefined) {
    updates.push("izinkan_multi_sesi = ?");
    args.push(
      data.izinkan_multi_sesi === true || Number(data.izinkan_multi_sesi) === 1
        ? 1
        : 0,
    );
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
