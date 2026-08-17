import "server-only";

import { db, ensureDbInitialized } from "@/lib/db";

export interface PenugasanBackupInput {
  tanggal_tugas: string; // YYYY-MM-DD
  id_karyawan_asal: string;
  id_karyawan_pengganti: string;
  id_shift_backup: number;
  alasan_backup?: string;
  kode_operator: string;
  catatan?: string;
}

export function generateIdBackup(): string {
  const now = new Date();
  const dateStr = now.toISOString().split("T")[0].replace(/-/g, "");
  const randomNum = Math.floor(100 + Math.random() * 900);
  return `BCK-${dateStr}-${randomNum}`;
}

function normalizeDate(raw: string): string {
  const clean = raw.trim();
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(clean)) {
    const [d, m, y] = clean.split("/");
    return `${y}-${m}-${d}`;
  }
  return clean;
}

export async function buatPenugasanBackup(input: PenugasanBackupInput) {
  await ensureDbInitialized();

  const date = normalizeDate(input.tanggal_tugas);

  // 1. Validasi Karyawan Asal & Karyawan Pengganti
  const asalRes = await db.execute({
    sql: "SELECT * FROM master_data WHERE (id_unik = ? OR kode_karyawan = ?) AND status_aktif = 'Aktif' LIMIT 1;",
    args: [input.id_karyawan_asal, input.id_karyawan_asal],
  });

  if (asalRes.rows.length === 0) {
    return {
      sukses: false,
      pesan: `Gagal: Karyawan asal '${input.id_karyawan_asal}' tidak ditemukan atau non-aktif.`,
    };
  }

  const penggantiRes = await db.execute({
    sql: "SELECT * FROM master_data WHERE (id_unik = ? OR kode_karyawan = ?) AND status_aktif = 'Aktif' LIMIT 1;",
    args: [input.id_karyawan_pengganti, input.id_karyawan_pengganti],
  });

  if (penggantiRes.rows.length === 0) {
    return {
      sukses: false,
      pesan: `Gagal: Karyawan pengganti '${input.id_karyawan_pengganti}' tidak ditemukan atau non-aktif.`,
    };
  }

  const asal = asalRes.rows[0] as Record<string, unknown>;
  const pengganti = penggantiRes.rows[0] as Record<string, unknown>;

  if (String(asal.id_unik) === String(pengganti.id_unik)) {
    return {
      sukses: false,
      pesan:
        "Gagal: Karyawan asal dan karyawan pengganti tidak boleh orang yang sama.",
    };
  }

  // Guard duplikasi: cek backup aktif yang sudah ada untuk karyawan+tanggal yang sama
  const duplikasiRes = await db.execute({
    sql: `SELECT id_backup FROM backup_karyawan
          WHERE tanggal_tugas = ? AND id_karyawan_asal = ? AND status_tugas = 'Aktif'
          LIMIT 1;`,
    args: [date, String(asal.id_unik)],
  });
  if (duplikasiRes.rows.length > 0) {
    return {
      sukses: false,
      pesan: `Gagal: Sudah ada penugasan backup aktif untuk '${String(asal.nama)}' pada tanggal ${date}. (ID: ${String(duplikasiRes.rows[0]?.id_backup || "")})`,
    };
  }

  const idBackup = generateIdBackup();
  const nowStr = new Date().toISOString();

  await db.execute({
    sql: `
      INSERT INTO backup_karyawan (
        id_backup, tanggal_tugas, id_karyawan_asal, nama_karyawan_asal, divisi_asal,
        id_shift_asal, id_karyawan_pengganti, nama_karyawan_pengganti, divisi_pengganti,
        id_shift_normal_pengganti, id_shift_backup, alasan_backup, status_tugas,
        kode_operator, waktu_input, catatan
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Aktif', ?, ?, ?);
    `,
    args: [
      idBackup,
      date,
      String(asal.id_unik),
      String(asal.nama),
      String(asal.divisi),
      Number(asal.id_shift || 1),
      String(pengganti.id_unik),
      String(pengganti.nama),
      String(pengganti.divisi),
      Number(pengganti.id_shift || 1),
      input.id_shift_backup,
      input.alasan_backup || "Penggantian Shift",
      input.kode_operator,
      nowStr,
      input.catatan || "",
    ],
  });

  return {
    sukses: true,
    pesan: `Penugasan backup ${pengganti.nama} menggantikan ${asal.nama} berhasil dibuat.`,
    id_backup: idBackup,
  };
}

export async function batalkanPenugasanBackup(
  id_backup: string,
  kode_operator: string,
) {
  await ensureDbInitialized();

  const nowStr = new Date().toISOString();
  await db.execute({
    sql: `UPDATE backup_karyawan SET 
          status_tugas = 'Dibatalkan', waktu_dibatalkan = ?, operator_pembatalan = ?
          WHERE id_backup = ?;`,
    args: [nowStr, kode_operator, id_backup],
  });

  return {
    sukses: true,
    pesan: `Penugasan backup '${id_backup}' berhasil dibatalkan.`,
  };
}

export async function getDaftarBackup(filter?: {
  tanggal?: string;
  status_tugas?: string;
}) {
  await ensureDbInitialized();

  let query = "SELECT * FROM backup_karyawan WHERE 1=1";
  const params: (string | number | boolean | null)[] = [];

  if (filter?.tanggal) {
    query += " AND tanggal_tugas = ?";
    params.push(filter.tanggal);
  }
  if (filter?.status_tugas) {
    query += " AND status_tugas = ?";
    params.push(filter.status_tugas);
  }

  query += " ORDER BY waktu_input DESC;";

  const res = await db.execute({ sql: query, args: params });
  return res.rows as unknown as Record<string, unknown>[];
}
