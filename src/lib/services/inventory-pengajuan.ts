import "server-only";

import { createHash } from "node:crypto";
import type { Client, Transaction } from "@libsql/client";
import {
  aktifkanTx,
  hargaDiterimaSql,
  setujuiTx,
  simpanSyaratTx,
  syaratPerPengajuan,
} from "@/lib/services/cicilan";
import {
  type Executor,
  newHexId,
  recordMutationTx,
  saveItemTx,
  text,
  wibToday,
  withTransaction,
} from "@/lib/services/inventory";
import { SERI_WEB } from "@/lib/validations/accounting";
import {
  type Syarat,
  syaratDraftSchema,
  validasiSyarat,
  wajibTerimaPenuh,
} from "@/lib/validations/cicilan";
import {
  barangDraftSchema,
  isValidDate,
  mutasiDraftSchema,
} from "@/lib/validations/inventory";
import {
  type BarisPengajuan,
  type BarisValid,
  type DaftarPengajuan,
  type FotoPenerimaan,
  formatNomorPengajuan,
  type HasilPenerimaan,
  idBarangBaru,
  idBarisPengajuan,
  keputusanDraftSchema,
  MAKS_DAFTAR_PENGAJUAN,
  nilaiBaris,
  type PenerimaanPengajuan,
  type Pengajuan,
  penerimaanDraftSchema,
  pengajuanDraftSchema,
  type StatusPengajuan,
  statusPengajuan,
  validateAlasan,
  validateKeputusan,
  validatePemutus,
  validatePenerimaan,
  validatePengajuan,
} from "@/lib/validations/inventory-pengajuan";

/**
 * Cermin Web dari `desktop/inventory_pengajuan.rs`. Web menulis langsung ke
 * database cloud, jadi syarat "masih Menunggu" di sini sama dengan syarat SQL
 * yang dipakai handler push Rust.
 */

/** Cermin `sidik_baris`. */
export function sidikBaris(baris: readonly BarisValid[]): string {
  const kanonik = baris
    .map((b, indeks) =>
      [
        String(indeks + 1),
        b.id_barang ?? "",
        b.nama_barang,
        b.satuan,
        b.desimal ? "1" : "0",
        String(b.jumlah),
        String(b.harga_satuan),
      ].join("\u001f"),
    )
    .join("\u001e");
  return createHash("sha256").update(kanonik, "utf8").digest("hex");
}

/** Cermin `DITERIMA_BARIS_SQL`. */
export const DITERIMA_BARIS_SQL = `COALESCE((SELECT SUM(m.jumlah) FROM inventory_mutasi m
        WHERE m.id_ref = r.id_baris AND m.jenis = 'Masuk' AND m.alasan = 'Pengadaan'
          AND NOT EXISTS (SELECT 1 FROM inventory_mutasi x WHERE x.id_mutasi = 'batal-' || m.id_mutasi)), 0)`;

/** Cermin `pengajuan_terbuka_sql`. */
const PENGAJUAN_TERBUKA_SQL = `p.dibatalkan_pada IS NULL AND p.ditolak_pada IS NULL AND p.ditutup_pada IS NULL
         AND (p.disetujui_pada IS NULL OR EXISTS (
             SELECT 1 FROM inventory_pengajuan_baris r
             WHERE r.id_pengajuan = p.id_pengajuan AND ${DITERIMA_BARIS_SQL} < r.jumlah))`;

/** Cermin `pilih_sql`. */
const PILIH_SQL = `WITH pilih AS (
            SELECT p.id_pengajuan FROM inventory_pengajuan p
            WHERE (${PENGAJUAN_TERBUKA_SQL}) OR (p.tanggal >= ?1 AND p.tanggal <= ?2)
            ORDER BY p.tanggal DESC, p.id_pengajuan DESC
            LIMIT ${MAKS_DAFTAR_PENGAJUAN + 1}
         )`;

/** Cermin `CLOUD_APPROVE_PENGAJUAN_SQL`: ACC hanya atas isi yang dilihat. */
const APPROVE_SQL = `UPDATE inventory_pengajuan
    SET disetujui_pada = datetime('now', '+7 hours'), disetujui_oleh = ?, sidik_disetujui = ?,
        catatan_persetujuan = ?, updated_at = datetime('now')
    WHERE id_pengajuan = ? AND sidik_baris = ?
      AND disetujui_pada IS NULL AND ditolak_pada IS NULL AND dibatalkan_pada IS NULL;`;

async function statusPengajuanDb(
  tx: Executor,
  idPengajuan: string,
): Promise<StatusPengajuan> {
  const header = await tx.execute({
    sql: `SELECT dibatalkan_pada, ditolak_pada, disetujui_pada, ditutup_pada
          FROM inventory_pengajuan WHERE id_pengajuan = ?;`,
    args: [idPengajuan],
  });
  const row = header.rows[0];
  if (!row) throw new Error("Pengajuan tidak ditemukan.");
  const baris = await tx.execute({
    sql: `SELECT r.jumlah, ${DITERIMA_BARIS_SQL} AS diterima FROM inventory_pengajuan_baris r
          WHERE r.id_pengajuan = ? ORDER BY r.urutan;`,
    args: [idPengajuan],
  });
  return statusPengajuan({
    dibatalkan: row.dibatalkan_pada !== null,
    ditolak: row.ditolak_pada !== null,
    disetujui: row.disetujui_pada !== null,
    ditutup: row.ditutup_pada !== null,
    baris: baris.rows.map((b) => ({
      jumlah: Number(b.jumlah),
      diterima: Number(b.diterima),
    })),
  });
}

async function wajibMenunggu(tx: Executor, idPengajuan: string) {
  const status = await statusPengajuanDb(tx, idPengajuan);
  if (status !== "Menunggu") {
    throw new Error(
      `Pengajuan ini berstatus ${status} dan tidak bisa diubah lagi.`,
    );
  }
}

/** Cermin `isi_barang_terdaftar`. */
async function isiBarangTerdaftar(tx: Executor, baris: BarisValid[]) {
  for (const [indeks, item] of baris.entries()) {
    if (item.id_barang === null) continue;
    const result = await tx.execute({
      sql: `SELECT nama_barang, satuan, desimal, status_aktif
            FROM inventory_barang WHERE id_barang = ?;`,
      args: [item.id_barang],
    });
    const barang = result.rows[0];
    const nomor = indeks + 1;
    if (!barang) throw new Error(`Baris ${nomor}: barang tidak ditemukan.`);
    if (Number(barang.status_aktif) !== 1) {
      throw new Error(
        `Baris ${nomor}: ${String(barang.nama_barang)} sudah dinonaktifkan.`,
      );
    }
    item.nama_barang = String(barang.nama_barang);
    item.satuan = String(barang.satuan);
    item.desimal = Number(barang.desimal) === 1;
  }
}

async function tulisBaris(
  tx: Transaction,
  idPengajuan: string,
  baris: readonly BarisValid[],
) {
  await tx.execute({
    sql: "DELETE FROM inventory_pengajuan_baris WHERE id_pengajuan = ?;",
    args: [idPengajuan],
  });
  for (const [indeks, item] of baris.entries()) {
    const urutan = indeks + 1;
    await tx.execute({
      sql: `INSERT INTO inventory_pengajuan_baris (
              id_baris, id_pengajuan, urutan, id_barang, nama_barang, satuan, desimal,
              jumlah, harga_satuan
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      args: [
        idBarisPengajuan(idPengajuan, urutan),
        idPengajuan,
        urutan,
        item.id_barang,
        item.nama_barang,
        item.satuan,
        item.desimal ? 1 : 0,
        item.jumlah,
        item.harga_satuan,
      ],
    });
  }
}

/** Cermin `save_request`. */
export async function savePengajuan(
  client: Client,
  operator: string,
  raw: unknown,
): Promise<{ sukses: true; id_pengajuan: string }> {
  const parsed = pengajuanDraftSchema.safeParse(raw);
  if (!parsed.success) throw new Error("Data pengajuan tidak valid.");
  const draft = parsed.data;
  return withTransaction(client, async (tx) => {
    const valid = validatePengajuan(draft, await wibToday(tx));
    if (!valid.ok) throw new Error(valid.error);
    const isian = valid.value;
    await isiBarangTerdaftar(tx, isian.baris);
    const sidik = sidikBaris(isian.baris);
    let syarat: Syarat | null = null;
    if (isian.cara_bayar === "Cicilan") {
      const total = isian.baris.reduce(
        (jumlah, b) => jumlah + nilaiBaris(b.jumlah, b.harga_satuan, b.desimal),
        0,
      );
      const hasil = validasiSyarat(
        draft.cicilan ?? syaratDraftSchema.parse({}),
        total,
        isian.tanggal,
        isian.tanggal,
      );
      if (!hasil.ok) throw new Error(hasil.error);
      syarat = hasil.value;
    }

    let idPengajuan = draft.id_pengajuan?.trim() || null;
    if (idPengajuan) {
      await wajibMenunggu(tx, idPengajuan);
      await tx.execute({
        sql: `UPDATE inventory_pengajuan SET tanggal = ?, keperluan = ?, sumber_dana = ?,
                     catatan = ?, sidik_baris = ?, cara_bayar = ?, updated_at = datetime('now')
              WHERE id_pengajuan = ?;`,
        args: [
          isian.tanggal,
          isian.keperluan,
          isian.sumber_dana,
          isian.catatan,
          sidik,
          isian.cara_bayar,
          idPengajuan,
        ],
      });
    } else {
      idPengajuan = newHexId("pgj-");
      const tahun = isian.tanggal.slice(0, 4);
      const urut = await tx.execute({
        sql: `SELECT COALESCE(MAX(nomor_urut), 0) + 1 AS n FROM inventory_pengajuan
              WHERE seri = ? AND substr(tanggal, 1, 4) = ?
              -- batas: agregat, selalu satu baris
              ;`,
        args: [SERI_WEB, tahun],
      });
      const nomorUrut = Number(urut.rows[0]?.n ?? 1);
      await tx.execute({
        sql: `INSERT INTO inventory_pengajuan (
                id_pengajuan, tanggal, seri, nomor_urut, nomor, keperluan, sumber_dana,
                catatan, sidik_baris, diajukan_oleh, cara_bayar, created_at, updated_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'));`,
        args: [
          idPengajuan,
          isian.tanggal,
          SERI_WEB,
          nomorUrut,
          formatNomorPengajuan(tahun, SERI_WEB, nomorUrut),
          isian.keperluan,
          isian.sumber_dana,
          isian.catatan,
          sidik,
          operator,
          isian.cara_bayar,
        ],
      });
    }
    await tulisBaris(tx, idPengajuan, isian.baris);
    // Kontrak lama dibiarkan saat pindah ke Tunai: pembacanya menyaring cara bayar.
    if (syarat) await simpanSyaratTx(tx, idPengajuan, syarat);
    return { sukses: true as const, id_pengajuan: idPengajuan };
  });
}

/** Cermin `cancel_request`. */
export async function cancelPengajuan(
  client: Client,
  operator: string,
  idPengajuan: string,
  alasan: string,
): Promise<{ sukses: true }> {
  const valid = validateAlasan(alasan, "Alasan pembatalan");
  if (!valid.ok) throw new Error(valid.error);
  const id = idPengajuan.trim();
  return withTransaction(client, async (tx) => {
    await wajibMenunggu(tx, id);
    await tx.execute({
      sql: `UPDATE inventory_pengajuan SET dibatalkan_pada = datetime('now', '+7 hours'),
                   dibatalkan_oleh = ?, alasan_batal = ?, updated_at = datetime('now')
            WHERE id_pengajuan = ?;`,
      args: [operator, valid.value, id],
    });
    return { sukses: true as const };
  });
}

/** Cermin `decide_request`. */
export async function decidePengajuan(
  client: Client,
  operator: string,
  superadmin: boolean,
  raw: unknown,
): Promise<{ sukses: true }> {
  const parsed = keputusanDraftSchema.safeParse(raw);
  if (!parsed.success) throw new Error("Data keputusan tidak valid.");
  const valid = validateKeputusan(parsed.data);
  if (!valid.ok) throw new Error(valid.error);
  const id = parsed.data.id_pengajuan.trim();
  return withTransaction(client, async (tx) => {
    const status = await statusPengajuanDb(tx, id);
    if (status !== "Menunggu") {
      throw new Error(`Pengajuan ini berstatus ${status}, bukan Menunggu.`);
    }
    const pengaju = await tx.execute({
      sql: "SELECT diajukan_oleh FROM inventory_pengajuan WHERE id_pengajuan = ?;",
      args: [id],
    });
    const pemutus = validatePemutus(
      String(pengaju.rows[0]?.diajukan_oleh ?? ""),
      operator,
      superadmin,
    );
    if (!pemutus.ok) throw new Error(pemutus.error);
    const keputusan = valid.value;
    if (keputusan.keputusan === "ACC") {
      const hasil = await tx.execute({
        sql: APPROVE_SQL,
        args: [
          operator,
          keputusan.sidik,
          keputusan.catatan,
          id,
          keputusan.sidik,
        ],
      });
      if (hasil.rowsAffected === 0) {
        throw new Error(
          "Isi pengajuan berubah sejak daftar ini dimuat. Muat ulang lalu periksa lagi.",
        );
      }
      const cara = await tx.execute({
        sql: "SELECT cara_bayar FROM inventory_pengajuan WHERE id_pengajuan = ?;",
        args: [id],
      });
      const bersih = (nilai: string | null | undefined) =>
        nilai?.trim() || null;
      if (String(cara.rows[0]?.cara_bayar) === "Cicilan") {
        await setujuiTx(tx, id, parsed.data.sidik_syarat, [
          bersih(parsed.data.id_akun_utang),
          bersih(parsed.data.id_akun_bunga),
          bersih(parsed.data.id_akun_denda),
        ]);
      } else if (bersih(parsed.data.sidik_syarat)) {
        // Dilihat sebagai Cicilan, sekarang Tunai.
        throw new Error(
          "Isi pengajuan berubah sejak daftar ini dimuat. Muat ulang lalu periksa lagi.",
        );
      }
    } else {
      await tx.execute({
        sql: `UPDATE inventory_pengajuan SET ditolak_pada = datetime('now', '+7 hours'),
                     ditolak_oleh = ?, alasan_tolak = ?, updated_at = datetime('now')
              WHERE id_pengajuan = ?;`,
        args: [operator, keputusan.alasan, id],
      });
    }
    return { sukses: true as const };
  });
}

/** Cermin `close_request`. */
export async function closePengajuan(
  client: Client,
  operator: string,
  idPengajuan: string,
  alasan: string,
): Promise<{ sukses: true }> {
  const valid = validateAlasan(alasan, "Alasan penutupan");
  if (!valid.ok) throw new Error(valid.error);
  const id = idPengajuan.trim();
  return withTransaction(client, async (tx) => {
    const status = await statusPengajuanDb(tx, id);
    if (status !== "Disetujui" && status !== "Diterima sebagian") {
      throw new Error(
        "Hanya pengajuan Disetujui atau Diterima sebagian yang bisa ditutup.",
      );
    }
    await tx.execute({
      sql: `UPDATE inventory_pengajuan SET ditutup_pada = datetime('now', '+7 hours'),
                   ditutup_oleh = ?, alasan_tutup = ?, updated_at = datetime('now')
            WHERE id_pengajuan = ?;`,
      args: [operator, valid.value, id],
    });
    return { sukses: true as const };
  });
}

/** Cermin `list_requests`. */
export async function listPengajuan(
  client: Client,
  dari: string,
  sampai: string,
): Promise<DaftarPengajuan> {
  if (!isValidDate(dari) || !isValidDate(sampai) || dari > sampai) {
    throw new Error("Rentang tanggal tidak valid.");
  }
  const hariIni = await wibToday(client);
  const header = await client.execute({
    sql: `${PILIH_SQL}
          SELECT p.*, (SELECT COUNT(*) FROM inventory_pengajuan y WHERE y.nomor = p.nomor) > 1 AS nomor_ganda
          FROM inventory_pengajuan p
          WHERE p.id_pengajuan IN (SELECT id_pengajuan FROM pilih)
          ORDER BY p.tanggal DESC, p.id_pengajuan DESC;`,
    args: [dari, sampai],
  });
  const barisResult = await client.execute({
    sql: `${PILIH_SQL}
          SELECT r.id_pengajuan, r.id_baris, r.urutan, r.id_barang, b.kode_barang,
                 r.nama_barang, r.satuan, r.desimal, r.jumlah, r.harga_satuan,
                 ${DITERIMA_BARIS_SQL} AS diterima, b.id_barang AS barang_terdaftar
          FROM inventory_pengajuan_baris r
          LEFT JOIN inventory_barang b ON b.id_barang = COALESCE(r.id_barang, 'brg-' || r.id_baris)
          WHERE r.id_pengajuan IN (SELECT id_pengajuan FROM pilih)
          ORDER BY r.id_pengajuan, r.urutan;`,
    args: [dari, sampai],
  });
  // Harga sebenarnya per baris, dikelompokkan, untuk tanda selisih (§3.5).
  const hargaResult = await client.execute({
    sql: `${PILIH_SQL}
          SELECT m.id_ref, COALESCE(m.harga_satuan, 0) AS harga_satuan, SUM(m.jumlah) AS jumlah
          FROM inventory_mutasi m
          JOIN inventory_pengajuan_baris r ON r.id_baris = m.id_ref
          WHERE r.id_pengajuan IN (SELECT id_pengajuan FROM pilih)
            AND m.jenis = 'Masuk' AND m.alasan = 'Pengadaan'
            AND NOT EXISTS (SELECT 1 FROM inventory_mutasi x WHERE x.id_mutasi = 'batal-' || m.id_mutasi)
          GROUP BY m.id_ref, COALESCE(m.harga_satuan, 0)
          ORDER BY m.id_ref, COALESCE(m.harga_satuan, 0);`,
    args: [dari, sampai],
  });
  const hargaPerBaris = new Map<
    string,
    { harga_satuan: number; jumlah: number }[]
  >();
  for (const row of hargaResult.rows) {
    const id = String(row.id_ref);
    const daftar = hargaPerBaris.get(id) ?? [];
    daftar.push({
      harga_satuan: Number(row.harga_satuan),
      jumlah: Number(row.jumlah),
    });
    hargaPerBaris.set(id, daftar);
  }
  const penerimaanResult = await client.execute({
    sql: `${PILIH_SQL}
          SELECT t.id_pengajuan, t.id_penerimaan, t.tanggal, t.catatan, t.jumlah_foto, t.dicatat_oleh
          FROM inventory_penerimaan t
          WHERE t.id_pengajuan IN (SELECT id_pengajuan FROM pilih)
          ORDER BY t.tanggal, t.created_at, t.id_penerimaan;`,
    args: [dari, sampai],
  });
  const penerimaanPer = new Map<string, PenerimaanPengajuan[]>();
  for (const row of penerimaanResult.rows) {
    const id = String(row.id_pengajuan);
    const daftar = penerimaanPer.get(id) ?? [];
    daftar.push({
      id_penerimaan: String(row.id_penerimaan),
      tanggal: String(row.tanggal),
      catatan: text(row.catatan),
      jumlah_foto: Number(row.jumlah_foto),
      dicatat_oleh: String(row.dicatat_oleh),
    });
    penerimaanPer.set(id, daftar);
  }
  const syaratPer = await syaratPerPengajuan(client, PILIH_SQL, dari, sampai);
  const perPengajuan = new Map<string, BarisPengajuan[]>();
  for (const row of barisResult.rows) {
    const desimal = Number(row.desimal) === 1;
    const jumlah = Number(row.jumlah);
    const harga = Number(row.harga_satuan);
    const id = String(row.id_pengajuan);
    const daftar = perPengajuan.get(id) ?? [];
    daftar.push({
      id_baris: String(row.id_baris),
      urutan: Number(row.urutan),
      id_barang: text(row.id_barang),
      kode_barang: text(row.kode_barang),
      nama_barang: String(row.nama_barang),
      satuan: String(row.satuan),
      desimal,
      jumlah,
      harga_satuan: harga,
      nilai: nilaiBaris(jumlah, harga, desimal),
      diterima: Number(row.diterima),
      barang_terdaftar: text(row.barang_terdaftar),
      harga_diterima: [],
    });
    perPengajuan.set(id, daftar);
  }

  const pengajuan: Pengajuan[] = header.rows
    .slice(0, MAKS_DAFTAR_PENGAJUAN)
    .map((row) => {
      const id = String(row.id_pengajuan);
      const baris = perPengajuan.get(id) ?? [];
      for (const item of baris) {
        item.harga_diterima = hargaPerBaris.get(item.id_baris) ?? [];
      }
      return {
        id_pengajuan: id,
        tanggal: String(row.tanggal),
        nomor: String(row.nomor),
        nomor_ganda: Number(row.nomor_ganda) === 1,
        keperluan: String(row.keperluan),
        sumber_dana: text(row.sumber_dana),
        catatan: text(row.catatan),
        sidik_baris: String(row.sidik_baris),
        cara_bayar: String(row.cara_bayar) === "Cicilan" ? "Cicilan" : "Tunai",
        cicilan:
          String(row.cara_bayar) === "Cicilan"
            ? (syaratPer.get(id) ?? null)
            : null,
        diajukan_oleh: String(row.diajukan_oleh),
        disetujui_pada: text(row.disetujui_pada),
        disetujui_oleh: text(row.disetujui_oleh),
        catatan_persetujuan: text(row.catatan_persetujuan),
        ditolak_pada: text(row.ditolak_pada),
        ditolak_oleh: text(row.ditolak_oleh),
        alasan_tolak: text(row.alasan_tolak),
        dibatalkan_pada: text(row.dibatalkan_pada),
        dibatalkan_oleh: text(row.dibatalkan_oleh),
        alasan_batal: text(row.alasan_batal),
        ditutup_pada: text(row.ditutup_pada),
        ditutup_oleh: text(row.ditutup_oleh),
        alasan_tutup: text(row.alasan_tutup),
        status: statusPengajuan({
          dibatalkan: row.dibatalkan_pada !== null,
          ditolak: row.ditolak_pada !== null,
          disetujui: row.disetujui_pada !== null,
          ditutup: row.ditutup_pada !== null,
          baris,
        }),
        total: baris.reduce((jumlah, b) => jumlah + b.nilai, 0),
        baris,
        penerimaan: penerimaanPer.get(id) ?? [],
      };
    });
  return {
    pengajuan,
    terpotong: header.rows.length > MAKS_DAFTAR_PENGAJUAN,
    hari_ini: hariIni,
  };
}

async function mutasiBaris(
  tx: Executor,
  idBaris: string,
): Promise<Set<string>> {
  const result = await tx.execute({
    sql: `SELECT id_mutasi FROM inventory_mutasi WHERE id_ref = ? AND jenis = 'Masuk'
          -- batas: satu baris pengajuan, paling banyak sejumlah unit yang di-ACC
          ;`,
    args: [idBaris],
  });
  return new Set(result.rows.map((row) => String(row.id_mutasi)));
}

function galatBaris(urutan: number, error: unknown): Error {
  const pesan = error instanceof Error ? error.message : "Operasi gagal.";
  return new Error(`Baris ${urutan}: ${pesan}`);
}

/** Cermin `receive_request`: satu transaksi, barang baru berid `brg-<id_baris>`. */
export async function receivePengajuan(
  client: Client,
  operator: string,
  raw: unknown,
): Promise<HasilPenerimaan> {
  const parsed = penerimaanDraftSchema.safeParse(raw);
  if (!parsed.success) throw new Error("Data penerimaan tidak valid.");
  const draft = parsed.data;
  const idPengajuan = draft.id_pengajuan.trim();
  return withTransaction(client, async (tx) => {
    const status = await statusPengajuanDb(tx, idPengajuan);
    if (status !== "Disetujui" && status !== "Diterima sebagian") {
      throw new Error(
        "Penerimaan hanya untuk pengajuan Disetujui atau Diterima sebagian.",
      );
    }
    const header = await tx.execute({
      sql: `SELECT nomor, sumber_dana, disetujui_pada, tanggal, cara_bayar
            FROM inventory_pengajuan WHERE id_pengajuan = ?;`,
      args: [idPengajuan],
    });
    const info = header.rows[0];
    if (!info) throw new Error("Pengajuan tidak ditemukan.");
    const accResult = await tx.execute({
      sql: `SELECT r.id_baris, r.urutan, r.id_barang, r.nama_barang, r.satuan, r.desimal,
                   r.jumlah, ${DITERIMA_BARIS_SQL} AS diterima
            FROM inventory_pengajuan_baris r WHERE r.id_pengajuan = ? ORDER BY r.urutan;`,
      args: [idPengajuan],
    });
    const acc = accResult.rows.map((row) => ({
      id_baris: String(row.id_baris),
      urutan: Number(row.urutan),
      id_barang: text(row.id_barang),
      nama_barang: String(row.nama_barang),
      satuan: String(row.satuan),
      desimal: Number(row.desimal) === 1,
      jumlah: Number(row.jumlah),
      diterima: Number(row.diterima),
    }));
    const valid = validatePenerimaan(
      draft,
      String(info.disetujui_pada).slice(0, 10),
      await wibToday(tx),
      acc,
    );
    if (!valid.ok) throw new Error(valid.error);
    const { tanggal, catatan, dicatat } = valid.value;
    const bercicilan = String(info.cara_bayar) === "Cicilan";
    if (bercicilan) {
      const penuh = wajibTerimaPenuh(
        acc.map((b) => [b.id_baris, b.urutan, b.jumlah - b.diterima]),
        draft.baris.map((b) => [b.id_baris, b.jumlah]),
      );
      if (!penuh.ok) throw new Error(penuh.error);
      if (!draft.cicilan) throw new Error("Syarat cicilan final wajib diisi.");
    }

    const label: HasilPenerimaan["label"] = [];
    for (const indeks of dicatat) {
      const isian = draft.baris[indeks];
      const baris = acc.find((b) => b.id_baris === isian?.id_baris.trim());
      if (!isian || !baris) throw new Error("Data penerimaan tidak valid.");
      let idBarang = baris.id_barang;
      if (idBarang === null) {
        idBarang = idBarangBaru(baris.id_baris);
        const ada = await tx.execute({
          sql: "SELECT EXISTS(SELECT 1 FROM inventory_barang WHERE id_barang = ?) AS ada;",
          args: [idBarang],
        });
        if (Number(ada.rows[0]?.ada) !== 1) {
          try {
            await saveItemTx(
              tx,
              barangDraftSchema.parse({
                nama_barang: isian.nama_barang?.trim() || baris.nama_barang,
                satuan: isian.satuan?.trim() || baris.satuan,
                desimal: baris.desimal,
                tipe: isian.tipe ?? "",
                kategori: isian.kategori ?? null,
                bisa_expired: isian.bisa_expired,
                tempat_utama: isian.tempat ?? null,
                status_aktif: true,
              }),
              idBarang,
            );
          } catch (error) {
            throw galatBaris(baris.urutan, error);
          }
        }
      }
      const sebelum = await mutasiBaris(tx, baris.id_baris);
      try {
        await recordMutationTx(
          tx,
          operator,
          mutasiDraftSchema.parse({
            id_barang: idBarang,
            jenis: "Masuk",
            alasan: "Pengadaan",
            tanggal,
            jumlah: isian.jumlah,
            tempat_tujuan: isian.tempat ?? null,
            kondisi_tujuan: isian.kondisi?.trim() || "Baik",
            tanggal_expired: isian.tanggal_expired ?? null,
            sumber_dana: text(info.sumber_dana),
            nomor_dokumen: String(info.nomor),
            harga_satuan: isian.harga_satuan,
            catatan,
            per_unit: isian.per_unit,
          }),
          baris.id_baris,
        );
      } catch (error) {
        throw galatBaris(baris.urutan, error);
      }
      const baru = [...(await mutasiBaris(tx, baris.id_baris))]
        .filter((id) => !sebelum.has(id))
        .sort();
      label.push({ id_barang: idBarang, jumlah: isian.jumlah, mutasi: baru });
    }

    // Syarat final dinilai terhadap harga sebenarnya, jadi sesudah mutasinya
    // tertulis; galat apa pun membatalkan seluruh transaksi.
    if (bercicilan && draft.cicilan) {
      const harga = await tx.execute({
        sql: `SELECT ${hargaDiterimaSql()} AS harga FROM inventory_pengajuan p WHERE p.id_pengajuan = ?;`,
        args: [idPengajuan],
      });
      const syarat = validasiSyarat(
        draft.cicilan,
        Number(harga.rows[0]?.harga ?? 0),
        String(info.tanggal),
        tanggal,
      );
      if (!syarat.ok) throw new Error(syarat.error);
      await aktifkanTx(tx, idPengajuan, syarat.value);
    }

    const idPenerimaan = newHexId("trm-");
    await tx.execute({
      sql: `INSERT INTO inventory_penerimaan (
              id_penerimaan, id_pengajuan, tanggal, catatan, jumlah_foto, dicatat_oleh, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, datetime('now'));`,
      args: [
        idPenerimaan,
        idPengajuan,
        tanggal,
        catatan,
        draft.foto.length,
        operator,
      ],
    });
    for (const [indeks, foto] of draft.foto.entries()) {
      const urutan = indeks + 1;
      await tx.execute({
        sql: `INSERT INTO inventory_penerimaan_foto (
                id_foto, id_penerimaan, urutan, mime_type, data_base64, created_at
              ) VALUES (?, ?, ?, ?, ?, datetime('now'));`,
        args: [
          `${idPenerimaan}-${urutan}`,
          idPenerimaan,
          urutan,
          foto.mime_type,
          foto.data_base64,
        ],
      });
    }
    return { sukses: true, id_penerimaan: idPenerimaan, label };
  });
}

/** Cermin `desktop_inventory_receipt_photo`: `null` bila foto belum terkirim. */
export async function fotoPenerimaan(
  client: Client,
  idFoto: string,
): Promise<FotoPenerimaan | null> {
  const result = await client.execute({
    sql: "SELECT mime_type, data_base64 FROM inventory_penerimaan_foto WHERE id_foto = ? LIMIT 1;",
    args: [idFoto.trim()],
  });
  const row = result.rows[0];
  return row
    ? { mime_type: String(row.mime_type), data_base64: String(row.data_base64) }
    : null;
}
