import "server-only";

import { createHash } from "node:crypto";
import type { Client, Transaction } from "@libsql/client";
import {
  assertAkunBayar,
  balikJurnalTx,
  tulisJurnalTx,
} from "@/lib/services/accounting";
import {
  type Executor,
  NILAI_MUTASI_SQL,
  newHexId,
  text,
  wibToday,
  withTransaction,
} from "@/lib/services/inventory";
import { DITERIMA_BARIS_SQL } from "@/lib/services/inventory-pengajuan";
import { MAKS_KETERANGAN } from "@/lib/validations/accounting";
import {
  AKUN_BEBAN_BUNGA,
  AKUN_BEBAN_DENDA,
  AKUN_UTANG_CICILAN,
  accUlangDraftSchema,
  alokasiJadwal,
  type BarisJadwal,
  type BayarCicilan,
  bayarDraftSchema,
  besaranCicilan,
  bungaKumulatif,
  type DaftarCicilan,
  idCicilan,
  idJadwal,
  idJurnalCicilan,
  type KontrakCicilan,
  kanonikSyarat,
  keteranganJurnalCicilan,
  MAKS_DAFTAR_CICILAN,
  normalSidik,
  perluAccUlang,
  type Syarat,
  type SyaratPengajuan,
  statusCicilan,
  susunJurnalCicilan,
  validasiBayar,
} from "@/lib/validations/cicilan";
import {
  validateAlasan,
  validatePemutus,
} from "@/lib/validations/inventory-pengajuan";

/**
 * Cermin Web dari `desktop/cicilan.rs`. Web menulis langsung ke database
 * cloud, jadi syarat SQL di sini sama dengan handler push Rust.
 */

/** Cermin `sidik_syarat`. */
export function sidikSyarat(syarat: Syarat): string {
  return createHash("sha256")
    .update(kanonikSyarat(syarat), "utf8")
    .digest("hex");
}

/** Cermin `TERTUTUP_CICILAN_SQL` (alias `c` = keu_cicilan). */
export const TERTUTUP_CICILAN_SQL = `COALESCE((SELECT SUM(y.nominal + y.potongan) FROM keu_cicilan_bayar y
        WHERE y.id_cicilan = c.id_cicilan AND y.jenis = 'Bayar'
          AND NOT EXISTS (SELECT 1 FROM keu_cicilan_bayar_batal x WHERE x.id_bayar = y.id_bayar)), 0)`;

/** Cermin `harga_diterima_sql`: nilai barang yang sudah diterima (alias `p`). */
export function hargaDiterimaSql(): string {
  return `COALESCE((SELECT SUM(${NILAI_MUTASI_SQL}) FROM inventory_mutasi m
           JOIN inventory_barang b ON b.id_barang = m.id_barang
           JOIN inventory_pengajuan_baris r ON r.id_baris = m.id_ref
           WHERE r.id_pengajuan = p.id_pengajuan AND m.jenis = 'Masuk' AND m.alasan = 'Pengadaan'
             AND NOT EXISTS (SELECT 1 FROM inventory_mutasi x WHERE x.id_mutasi = 'batal-' || m.id_mutasi)), 0)`;
}

/** Cermin `penerimaan_dijurnal_sql`. */
function penerimaanDijurnalSql(): string {
  return `NOT EXISTS (SELECT 1 FROM inventory_mutasi m
         JOIN inventory_barang b ON b.id_barang = m.id_barang
         JOIN inventory_pengajuan_baris r ON r.id_baris = m.id_ref
         WHERE r.id_pengajuan = p.id_pengajuan AND m.jenis = 'Masuk' AND m.alasan = 'Pengadaan'
           AND NOT EXISTS (SELECT 1 FROM inventory_mutasi x WHERE x.id_mutasi = 'batal-' || m.id_mutasi)
           AND ${NILAI_MUTASI_SQL} > 0
           AND NOT EXISTS (SELECT 1 FROM keu_jurnal j WHERE j.id_jurnal = 'jrn-inv-' || m.id_mutasi))`;
}

/** Cermin `KONTRAK_BERBAYAR_MUTASI_SQL`. Parameter: id mutasi. */
export const KONTRAK_BERBAYAR_MUTASI_SQL = `SELECT COALESCE(c.nomor_kontrak, p.nomor) AS kontrak
    FROM inventory_mutasi m
    JOIN inventory_pengajuan_baris r ON r.id_baris = m.id_ref
    JOIN inventory_pengajuan p ON p.id_pengajuan = r.id_pengajuan AND p.cara_bayar = 'Cicilan'
    JOIN keu_cicilan c ON c.id_pengajuan = p.id_pengajuan
    WHERE m.id_mutasi = ? AND m.jenis = 'Masuk' AND m.alasan = 'Pengadaan'
      AND EXISTS (SELECT 1 FROM keu_cicilan_bayar y
        WHERE y.id_cicilan = c.id_cicilan
          AND NOT EXISTS (SELECT 1 FROM keu_cicilan_bayar_batal x WHERE x.id_bayar = y.id_bayar))
    LIMIT 1;`;

/** Cermin `AKUN_UTANG_MUTASI_SQL`. Parameter: id mutasi. */
export const AKUN_UTANG_MUTASI_SQL = `SELECT c.id_akun_utang
    FROM inventory_mutasi m
    JOIN inventory_pengajuan_baris r ON r.id_baris = m.id_ref
    JOIN inventory_pengajuan p ON p.id_pengajuan = r.id_pengajuan AND p.cara_bayar = 'Cicilan'
    JOIN keu_cicilan c ON c.id_pengajuan = p.id_pengajuan
    WHERE m.id_mutasi = ? AND m.jenis = 'Masuk' AND m.alasan = 'Pengadaan'
    LIMIT 1;`;

/** Cermin `barang_belum_lunas_sql`. */
export function barangBelumLunasSql(): string {
  return `SELECT DISTINCT m.id_barang, COALESCE(c.nomor_kontrak, p.nomor) AS kontrak, c.kreditur
         FROM inventory_mutasi m
         JOIN inventory_pengajuan_baris r ON r.id_baris = m.id_ref
         JOIN inventory_pengajuan p ON p.id_pengajuan = r.id_pengajuan AND p.cara_bayar = 'Cicilan'
         JOIN keu_cicilan c ON c.id_pengajuan = p.id_pengajuan
         WHERE m.jenis = 'Masuk' AND m.alasan = 'Pengadaan'
           AND NOT EXISTS (SELECT 1 FROM inventory_mutasi x WHERE x.id_mutasi = 'batal-' || m.id_mutasi)
           AND c.ditutup_pada IS NULL AND p.dibatalkan_pada IS NULL AND p.ditolak_pada IS NULL
           AND ${TERTUTUP_CICILAN_SQL} < (SELECT COALESCE(SUM(j.nominal), 0) FROM keu_cicilan_jadwal j WHERE j.id_cicilan = c.id_cicilan)
         ORDER BY m.id_barang
         LIMIT ${MAKS_DAFTAR_CICILAN};`;
}

async function tulisJadwal(
  tx: Transaction,
  id: string,
  jadwal: readonly BarisJadwal[],
) {
  await tx.execute({
    sql: "DELETE FROM keu_cicilan_jadwal WHERE id_cicilan = ?;",
    args: [id],
  });
  for (const baris of jadwal) {
    await tx.execute({
      sql: `INSERT INTO keu_cicilan_jadwal (id_jadwal, id_cicilan, ke, jatuh_tempo, nominal)
            VALUES (?, ?, ?, ?, ?);`,
      args: [
        idJadwal(id, baris.ke),
        id,
        baris.ke,
        baris.jatuh_tempo,
        baris.nominal,
      ],
    });
  }
}

/** Cermin `simpan_syarat_tx`: syarat Draf, akun bawaan hanya saat dibuat. */
export async function simpanSyaratTx(
  tx: Transaction,
  idPengajuan: string,
  syarat: Syarat,
) {
  const id = idCicilan(idPengajuan);
  await tx.execute({
    sql: `INSERT INTO keu_cicilan (
            id_cicilan, id_pengajuan, kreditur, nomor_kontrak, uang_muka, pola, setiap, satuan,
            id_akun_utang, id_akun_bunga, id_akun_denda, sidik_syarat, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
          ON CONFLICT(id_cicilan) DO UPDATE SET
            kreditur = excluded.kreditur,
            nomor_kontrak = excluded.nomor_kontrak,
            uang_muka = excluded.uang_muka,
            pola = excluded.pola,
            setiap = excluded.setiap,
            satuan = excluded.satuan,
            sidik_syarat = excluded.sidik_syarat,
            updated_at = datetime('now');`,
    args: [
      id,
      idPengajuan,
      syarat.kreditur,
      syarat.nomor_kontrak,
      syarat.uang_muka,
      syarat.pola,
      syarat.setiap,
      syarat.satuan,
      AKUN_UTANG_CICILAN,
      AKUN_BEBAN_BUNGA,
      AKUN_BEBAN_DENDA,
      sidikSyarat(syarat),
    ],
  });
  await tulisJadwal(tx, id, syarat.jadwal);
}

/**
 * Cermin `aktifkan_tx`: syarat final saat penerimaan penuh. Web menulis
 * langsung, jadi syarat cloud `CLOUD_AKTIFKAN_CICILAN_SQL` (belum ada
 * pembayaran) diperiksa di sini juga.
 */
export async function aktifkanTx(
  tx: Transaction,
  idPengajuan: string,
  syarat: Syarat,
) {
  const id = idCicilan(idPengajuan);
  const hasil = await tx.execute({
    sql: `UPDATE keu_cicilan SET kreditur = ?, nomor_kontrak = ?, uang_muka = ?, pola = ?,
                 setiap = ?, satuan = ?, sidik_syarat = ?,
                 diaktifkan_pada = datetime('now', '+7 hours'), updated_at = datetime('now')
          WHERE id_cicilan = ?;`,
    args: [
      syarat.kreditur,
      syarat.nomor_kontrak,
      syarat.uang_muka,
      syarat.pola,
      syarat.setiap,
      syarat.satuan,
      sidikSyarat(syarat),
      id,
    ],
  });
  if (hasil.rowsAffected === 0) {
    throw new Error(
      "Kontrak cicilan pengajuan ini tidak ditemukan. Muat ulang daftarnya.",
    );
  }
  await tulisJadwal(tx, id, syarat.jadwal);
}

async function assertAkun(
  tx: Executor,
  idAkun: string,
  kelompok: string,
  label: string,
) {
  const result = await tx.execute({
    sql: "SELECT EXISTS(SELECT 1 FROM keu_akun WHERE id_akun = ? AND kelompok = ? AND is_aktif = 1) AS sah;",
    args: [idAkun, kelompok],
  });
  if (Number(result.rows[0]?.sah) !== 1) {
    throw new Error(`${label} harus akun ${kelompok} yang aktif.`);
  }
}

/** Cermin `setujui_tx`: total yang di-ACC dan akun kontrak. */
export async function setujuiTx(
  tx: Transaction,
  idPengajuan: string,
  sidikDilihat: string | null | undefined,
  akun: [string | null, string | null, string | null],
) {
  const id = idCicilan(idPengajuan);
  const result = await tx.execute({
    sql: "SELECT sidik_syarat FROM keu_cicilan WHERE id_cicilan = ?;",
    args: [id],
  });
  const sidik = result.rows[0] ? String(result.rows[0].sidik_syarat) : null;
  if (sidik === null || normalSidik(sidikDilihat) !== sidik) {
    throw new Error(
      "Syarat cicilan berubah sejak daftar ini dimuat. Muat ulang lalu periksa lagi.",
    );
  }
  const utang = akun[0] ?? AKUN_UTANG_CICILAN;
  const bunga = akun[1] ?? AKUN_BEBAN_BUNGA;
  const denda = akun[2] ?? AKUN_BEBAN_DENDA;
  await assertAkun(tx, utang, "Kewajiban", "Akun utang");
  await assertAkun(tx, bunga, "Beban", "Akun beban bunga");
  await assertAkun(tx, denda, "Beban", "Akun beban denda");
  await tx.execute({
    sql: `UPDATE keu_cicilan SET
            total_disetujui = (SELECT COALESCE(SUM(j.nominal), 0) FROM keu_cicilan_jadwal j
                               WHERE j.id_cicilan = keu_cicilan.id_cicilan),
            id_akun_utang = ?, id_akun_bunga = ?, id_akun_denda = ?, updated_at = datetime('now')
          WHERE id_cicilan = ?;`,
    args: [utang, bunga, denda, id],
  });
}

/** Cermin `syarat_per_pengajuan`. `pilih` = CTE `pilih` milik `listPengajuan`. */
export async function syaratPerPengajuan(
  client: Executor,
  pilih: string,
  dari: string,
  sampai: string,
): Promise<Map<string, SyaratPengajuan>> {
  const hasil = new Map<string, SyaratPengajuan>();
  const kontrak = await client.execute({
    sql: `${pilih}
          SELECT c.id_pengajuan, c.kreditur, c.nomor_kontrak, c.uang_muka, c.pola, c.setiap,
                 c.satuan, c.sidik_syarat, c.id_akun_utang, c.id_akun_bunga, c.id_akun_denda,
                 c.total_disetujui, c.diaktifkan_pada
          FROM keu_cicilan c
          WHERE c.id_pengajuan IN (SELECT id_pengajuan FROM pilih);`,
    args: [dari, sampai],
  });
  for (const row of kontrak.rows) {
    hasil.set(String(row.id_pengajuan), {
      kreditur: String(row.kreditur),
      nomor_kontrak: text(row.nomor_kontrak),
      uang_muka: Number(row.uang_muka),
      pola: String(row.pola) as SyaratPengajuan["pola"],
      setiap: row.setiap === null ? null : Number(row.setiap),
      satuan: text(row.satuan) as SyaratPengajuan["satuan"],
      sidik_syarat: String(row.sidik_syarat),
      id_akun_utang: String(row.id_akun_utang),
      id_akun_bunga: String(row.id_akun_bunga),
      id_akun_denda: String(row.id_akun_denda),
      total_disetujui:
        row.total_disetujui === null ? null : Number(row.total_disetujui),
      diaktifkan_pada: text(row.diaktifkan_pada),
      jadwal: [],
    });
  }
  const jadwal = await client.execute({
    sql: `${pilih}
          SELECT c.id_pengajuan, j.ke, j.jatuh_tempo, j.nominal
          FROM keu_cicilan_jadwal j
          JOIN keu_cicilan c ON c.id_cicilan = j.id_cicilan
          WHERE c.id_pengajuan IN (SELECT id_pengajuan FROM pilih)
          ORDER BY c.id_pengajuan, j.ke;`,
    args: [dari, sampai],
  });
  for (const row of jadwal.rows) {
    hasil.get(String(row.id_pengajuan))?.jadwal.push({
      ke: Number(row.ke),
      jatuh_tempo: String(row.jatuh_tempo),
      nominal: Number(row.nominal),
    });
  }
  return hasil;
}

/** Satu kontrak beserta turunannya, untuk pemeriksaan sebelum menulis. */
interface KontrakDb {
  data: KontrakCicilan;
  sidik_disetujui_ulang: string | null;
}

/** Cermin `muat_kontrak`. */
export async function muatKontrak(
  client: Executor,
  id: string | null,
  hariIni: string,
): Promise<{ kontrak: KontrakDb[]; terpotong: boolean }> {
  const pilih = `WITH pilih AS (
            SELECT c.id_cicilan FROM keu_cicilan c
            JOIN inventory_pengajuan p ON p.id_pengajuan = c.id_pengajuan
            WHERE p.cara_bayar = 'Cicilan' AND (?1 IS NULL OR c.id_cicilan = ?1)
            ORDER BY p.tanggal DESC, c.id_cicilan DESC
            LIMIT ${MAKS_DAFTAR_CICILAN + 1}
         )`;
  const kepala = await client.execute({
    sql: `${pilih}
          SELECT c.*, p.tanggal AS tanggal_pengajuan, p.nomor AS nomor_pengajuan, p.keperluan,
                 p.diajukan_oleh,
                 p.dibatalkan_pada IS NOT NULL OR p.ditolak_pada IS NOT NULL AS pengajuan_batal,
                 p.disetujui_pada IS NULL AS pengajuan_menunggu,
                 p.ditutup_pada IS NOT NULL AS pengajuan_ditutup,
                 NOT EXISTS (SELECT 1 FROM inventory_pengajuan_baris r
                             WHERE r.id_pengajuan = p.id_pengajuan AND ${DITERIMA_BARIS_SQL} < r.jumlah) AS diterima_penuh,
                 COALESCE((SELECT SUM(CASE WHEN r.desimal = 1 THEN (r.jumlah * r.harga_satuan + 50) / 100
                                           ELSE r.jumlah * r.harga_satuan END)
                           FROM inventory_pengajuan_baris r WHERE r.id_pengajuan = p.id_pengajuan), 0) AS total_pengajuan,
                 ${hargaDiterimaSql()} AS harga_diterima,
                 ${TERTUTUP_CICILAN_SQL} AS tertutup,
                 ${penerimaanDijurnalSql()} AS dijurnal,
                 (SELECT group_concat(r.nama_barang, ', ') FROM inventory_pengajuan_baris r
                  WHERE r.id_pengajuan = p.id_pengajuan) AS barang
          FROM keu_cicilan c
          JOIN inventory_pengajuan p ON p.id_pengajuan = c.id_pengajuan
          WHERE c.id_cicilan IN (SELECT id_cicilan FROM pilih)
          ORDER BY p.tanggal DESC, c.id_cicilan DESC;`,
    args: [id],
  });
  const jadwalResult = await client.execute({
    sql: `${pilih}
          SELECT j.id_cicilan, j.ke, j.jatuh_tempo, j.nominal FROM keu_cicilan_jadwal j
          WHERE j.id_cicilan IN (SELECT id_cicilan FROM pilih)
          ORDER BY j.id_cicilan, j.ke;`,
    args: [id],
  });
  const bayarResult = await client.execute({
    sql: `${pilih}
          SELECT y.*, x.alasan AS batal_alasan, x.dibatalkan_oleh AS batal_oleh,
                 x.created_at AS batal_pada, j.nomor AS nomor_jurnal
          FROM keu_cicilan_bayar y
          LEFT JOIN keu_cicilan_bayar_batal x ON x.id_bayar = y.id_bayar
          LEFT JOIN keu_jurnal j ON j.id_jurnal = 'jrn-' || y.id_bayar
          WHERE y.id_cicilan IN (SELECT id_cicilan FROM pilih)
          ORDER BY y.id_cicilan, y.created_at, y.rowid;`,
    args: [id],
  });
  const jadwalPer = new Map<string, BarisJadwal[]>();
  for (const row of jadwalResult.rows) {
    const idC = String(row.id_cicilan);
    const daftar = jadwalPer.get(idC) ?? [];
    daftar.push({
      ke: Number(row.ke),
      jatuh_tempo: String(row.jatuh_tempo),
      nominal: Number(row.nominal),
    });
    jadwalPer.set(idC, daftar);
  }
  const bayarPer = new Map<string, BayarCicilan[]>();
  const dendaPer = new Map<string, number>();
  for (const row of bayarResult.rows) {
    const idC = String(row.id_cicilan);
    const bayar: BayarCicilan = {
      id_bayar: String(row.id_bayar),
      id_cicilan: idC,
      jenis: String(row.jenis) as BayarCicilan["jenis"],
      tanggal: String(row.tanggal),
      nominal: Number(row.nominal),
      potongan: Number(row.potongan),
      alasan_potongan: text(row.alasan_potongan),
      keterangan: text(row.keterangan),
      referensi: text(row.referensi),
      id_akun_bayar: String(row.id_akun_bayar),
      dicatat_oleh: String(row.dicatat_oleh),
      created_at: String(row.created_at),
      batal:
        row.batal_alasan === null
          ? null
          : {
              alasan: String(row.batal_alasan),
              oleh: String(row.batal_oleh),
              pada: String(row.batal_pada),
            },
      nomor_jurnal: text(row.nomor_jurnal),
    };
    if (bayar.jenis === "Denda" && bayar.batal === null) {
      dendaPer.set(idC, (dendaPer.get(idC) ?? 0) + bayar.nominal);
    }
    const daftar = bayarPer.get(idC) ?? [];
    daftar.push(bayar);
    bayarPer.set(idC, daftar);
  }

  const kontrak = kepala.rows.slice(0, MAKS_DAFTAR_CICILAN).map((row) => {
    const idC = String(row.id_cicilan);
    const jadwal = jadwalPer.get(idC) ?? [];
    const diterimaPenuh = Number(row.diterima_penuh) === 1;
    const diaktifkan = row.diaktifkan_pada !== null;
    const harga =
      diterimaPenuh && diaktifkan
        ? Number(row.harga_diterima)
        : Number(row.total_pengajuan);
    const b = besaranCicilan(harga, jadwal);
    const tertutup = Number(row.tertutup);
    const alokasi = alokasiJadwal(jadwal, tertutup, hariIni);
    const sidik = String(row.sidik_syarat);
    const totalDisetujui =
      row.total_disetujui === null ? null : Number(row.total_disetujui);
    const sidikUlang = text(row.sidik_disetujui_ulang);
    const status = statusCicilan({
      pengajuan_batal: Number(row.pengajuan_batal) === 1,
      pengajuan_menunggu: Number(row.pengajuan_menunggu) === 1,
      pengajuan_ditutup: Number(row.pengajuan_ditutup) === 1,
      diterima_penuh: diterimaPenuh,
      diaktifkan,
      ditutup: row.ditutup_pada !== null,
      perlu_acc_ulang: perluAccUlang(
        b.total_bayar,
        totalDisetujui,
        sidik,
        sidikUlang,
      ),
      tertutup,
      total_bayar: b.total_bayar,
      ada_terlambat: alokasi.some((a) => a.status === "Terlambat"),
    });
    const bungaKum = bungaKumulatif(b, tertutup);
    const pokokTerbayar = Math.min(tertutup, b.total_bayar) - bungaKum;
    const data: KontrakCicilan = {
      id_cicilan: idC,
      id_pengajuan: String(row.id_pengajuan),
      nomor_pengajuan: String(row.nomor_pengajuan),
      tanggal_pengajuan: String(row.tanggal_pengajuan),
      keperluan: String(row.keperluan),
      barang: text(row.barang) ?? "",
      diajukan_oleh: String(row.diajukan_oleh),
      kreditur: String(row.kreditur),
      nomor_kontrak: text(row.nomor_kontrak),
      uang_muka: Number(row.uang_muka),
      pola: String(row.pola) as KontrakCicilan["pola"],
      setiap: row.setiap === null ? null : Number(row.setiap),
      satuan: text(row.satuan),
      id_akun_utang: String(row.id_akun_utang),
      id_akun_bunga: String(row.id_akun_bunga),
      id_akun_denda: String(row.id_akun_denda),
      sidik_syarat: sidik,
      total_disetujui: totalDisetujui,
      diaktifkan_pada: text(row.diaktifkan_pada),
      disetujui_ulang_pada: text(row.disetujui_ulang_pada),
      disetujui_ulang_oleh: text(row.disetujui_ulang_oleh),
      ditutup_pada: text(row.ditutup_pada),
      ditutup_oleh: text(row.ditutup_oleh),
      alasan_tutup: text(row.alasan_tutup),
      status,
      harga_tunai: b.harga_tunai,
      total_angsuran: b.total_angsuran,
      total_bayar: b.total_bayar,
      bunga: b.bunga,
      tertutup,
      sisa_pokok: Math.max(b.total_bayar - b.bunga - pokokTerbayar, 0),
      sisa_bunga: b.bunga - bungaKum,
      lebih_bayar: Math.max(tertutup - b.total_bayar, 0),
      total_denda: dendaPer.get(idC) ?? 0,
      penerimaan_dijurnal: Number(row.dijurnal) === 1,
      jadwal: jadwal.map((baris, indeks) => ({
        ...baris,
        ...(alokasi[indeks] ?? { terbayar: 0, status: "Belum" as const }),
      })),
      bayar: bayarPer.get(idC) ?? [],
    };
    return { data, sidik_disetujui_ulang: sidikUlang };
  });
  return { kontrak, terpotong: kepala.rows.length > MAKS_DAFTAR_CICILAN };
}

/** Cermin `list_installments`. */
export async function listCicilan(client: Client): Promise<DaftarCicilan> {
  const hariIni = await wibToday(client);
  const { kontrak, terpotong } = await muatKontrak(client, null, hariIni);
  return {
    kontrak: kontrak.map((k) => k.data),
    terpotong,
    hari_ini: hariIni,
  };
}

async function satuKontrak(
  tx: Executor,
  id: string,
  hariIni: string,
): Promise<KontrakCicilan> {
  const { kontrak } = await muatKontrak(tx, id.trim(), hariIni);
  const satu = kontrak[0];
  if (!satu) throw new Error("Kontrak cicilan tidak ditemukan.");
  return satu.data;
}

/** Cermin `reapprove`. */
export async function reapproveCicilan(
  client: Client,
  operator: string,
  superadmin: boolean,
  raw: unknown,
): Promise<{ sukses: true }> {
  const parsed = accUlangDraftSchema.safeParse(raw);
  if (!parsed.success) throw new Error("Data ACC ulang tidak valid.");
  return withTransaction(client, async (tx) => {
    const kontrak = await satuKontrak(
      tx,
      parsed.data.id_cicilan,
      await wibToday(tx),
    );
    if (kontrak.status !== "Menunggu ACC ulang") {
      throw new Error(
        `Kontrak ini berstatus ${kontrak.status}, bukan Menunggu ACC ulang.`,
      );
    }
    if (normalSidik(parsed.data.sidik_syarat) !== kontrak.sidik_syarat) {
      throw new Error(
        "Syarat cicilan berubah sejak daftar ini dimuat. Muat ulang lalu periksa lagi.",
      );
    }
    const pemutus = validatePemutus(
      kontrak.diajukan_oleh,
      operator,
      superadmin,
    );
    if (!pemutus.ok) throw new Error(pemutus.error);
    await tx.execute({
      sql: `UPDATE keu_cicilan SET disetujui_ulang_pada = datetime('now', '+7 hours'),
                   disetujui_ulang_oleh = ?, sidik_disetujui_ulang = sidik_syarat,
                   updated_at = datetime('now')
            WHERE id_cicilan = ?;`,
      args: [operator, kontrak.id_cicilan],
    });
    return { sukses: true as const };
  });
}

/** Cermin `close`. */
export async function closeCicilan(
  client: Client,
  operator: string,
  idCicilanTutup: string,
  alasan: string,
): Promise<{ sukses: true }> {
  const valid = validateAlasan(alasan, "Alasan penutupan");
  if (!valid.ok) throw new Error(valid.error);
  return withTransaction(client, async (tx) => {
    const kontrak = await satuKontrak(tx, idCicilanTutup, await wibToday(tx));
    if (
      ![
        "Menunggu barang",
        "Menunggu ACC ulang",
        "Berjalan",
        "Menunggak",
      ].includes(kontrak.status)
    ) {
      throw new Error(
        `Kontrak berstatus ${kontrak.status} tidak bisa ditutup.`,
      );
    }
    await tx.execute({
      sql: `UPDATE keu_cicilan SET ditutup_pada = datetime('now', '+7 hours'), ditutup_oleh = ?,
                   alasan_tutup = ?, updated_at = datetime('now')
            WHERE id_cicilan = ?;`,
      args: [operator, valid.value, kontrak.id_cicilan],
    });
    return { sukses: true as const };
  });
}

/** Cermin `record_payment`. */
export async function catatBayarCicilan(
  client: Client,
  operator: string,
  raw: unknown,
): Promise<{ sukses: true; id_bayar: string }> {
  const parsed = bayarDraftSchema.safeParse(raw);
  if (!parsed.success) throw new Error("Data pembayaran tidak valid.");
  const draft = parsed.data;
  return withTransaction(client, async (tx) => {
    const hariIni = await wibToday(tx);
    const kontrak = await satuKontrak(tx, draft.id_cicilan, hariIni);
    const boleh =
      draft.jenis.trim() === "Denda"
        ? ["Berjalan", "Menunggak", "Lunas"].includes(kontrak.status)
        : ["Berjalan", "Menunggak"].includes(kontrak.status);
    if (!boleh) {
      throw new Error(
        `Kontrak ini berstatus ${kontrak.status}; pembayaran belum bisa dicatat.`,
      );
    }
    if (!kontrak.penerimaan_dijurnal) {
      throw new Error(
        "Jurnal penerimaan barang kontrak ini belum dicatat. Catat dulu di tab Dari Inventaris.",
      );
    }
    const valid = validasiBayar(
      draft,
      kontrak.tanggal_pengajuan,
      hariIni,
      kontrak.total_bayar - kontrak.tertutup,
    );
    if (!valid.ok) throw new Error(valid.error);
    const bayar = valid.value;
    const idAkunBayar = draft.id_akun_bayar.trim();
    await assertAkunBayar(tx, idAkunBayar);

    const idBayar = newHexId("cby-");
    await tx.execute({
      sql: `INSERT INTO keu_cicilan_bayar (
              id_bayar, id_cicilan, jenis, tanggal, nominal, potongan, alasan_potongan, keterangan,
              referensi, id_akun_bayar, dicatat_oleh, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%d %H:%M:%f', 'now'));`,
      args: [
        idBayar,
        kontrak.id_cicilan,
        bayar.jenis,
        bayar.tanggal,
        bayar.nominal,
        bayar.potongan,
        bayar.alasan_potongan,
        bayar.keterangan,
        bayar.referensi,
        idAkunBayar,
        operator,
      ],
    });
    const idJurnal = idJurnalCicilan(idBayar);
    const baris = susunJurnalCicilan(
      bayar.jenis,
      bayar.nominal,
      bayar.potongan,
      kontrak.tertutup,
      besaranCicilan(kontrak.harga_tunai, kontrak.jadwal),
      {
        utang: kontrak.id_akun_utang,
        bunga: kontrak.id_akun_bunga,
        denda: kontrak.id_akun_denda,
        bayar: idAkunBayar,
      },
    );
    await tulisJurnalTx(
      tx,
      {
        id_jurnal: idJurnal,
        tanggal: bayar.tanggal,
        keterangan: keteranganJurnalCicilan(
          bayar.jenis,
          kontrak.kreditur,
          kontrak.nomor_pengajuan,
          bayar.keterangan,
        ),
        sumber: "Cicilan",
        id_sumber: idBayar,
        id_jurnal_batal: null,
        dibuat_oleh: operator,
      },
      baris.map(([idAkun, debit, kredit], indeks) => ({
        id_baris: `${idJurnal}-${indeks + 1}`,
        id_akun: idAkun,
        debit,
        kredit,
        keterangan: null,
        urutan: indeks + 1,
      })),
    );
    return { sukses: true as const, id_bayar: idBayar };
  });
}

/** Cermin `cancel_payment`. */
export async function batalBayarCicilan(
  client: Client,
  operator: string,
  idBayarBatal: string,
  alasan: string,
): Promise<{ sukses: true }> {
  const valid = validateAlasan(alasan, "Alasan pembatalan");
  if (!valid.ok) throw new Error(valid.error);
  const id = idBayarBatal.trim();
  return withTransaction(client, async (tx) => {
    const result = await tx.execute({
      sql: `SELECT y.id_cicilan, y.jenis,
                   EXISTS (SELECT 1 FROM keu_cicilan_bayar_batal x WHERE x.id_bayar = y.id_bayar) AS batal
            FROM keu_cicilan_bayar y WHERE y.id_bayar = ?;`,
      args: [id],
    });
    const row = result.rows[0];
    if (!row) throw new Error("Pembayaran tidak ditemukan.");
    if (Number(row.batal) === 1) {
      throw new Error("Pembayaran ini sudah dibatalkan.");
    }
    if (String(row.jenis) === "Bayar") {
      const terakhir = await tx.execute({
        sql: `SELECT y.id_bayar FROM keu_cicilan_bayar y
              WHERE y.id_cicilan = ? AND y.jenis = 'Bayar'
                AND NOT EXISTS (SELECT 1 FROM keu_cicilan_bayar_batal x WHERE x.id_bayar = y.id_bayar)
              ORDER BY y.created_at DESC, y.rowid DESC LIMIT 1;`,
        args: [String(row.id_cicilan)],
      });
      if (String(terakhir.rows[0]?.id_bayar ?? "") !== id) {
        throw new Error(
          "Hanya pembayaran terakhir yang bisa dibatalkan. Batalkan dulu pembayaran sesudahnya.",
        );
      }
    }
    await tx.execute({
      sql: `INSERT INTO keu_cicilan_bayar_batal (id_bayar, alasan, dibatalkan_oleh, created_at)
            VALUES (?, ?, ?, datetime('now'));`,
      args: [id, valid.value, operator],
    });
    await balikJurnalTx(
      tx,
      idJurnalCicilan(id),
      Array.from(`Pembatalan pembayaran cicilan: ${valid.value}`)
        .slice(0, MAKS_KETERANGAN)
        .join(""),
      operator,
    );
    return { sukses: true as const };
  });
}
