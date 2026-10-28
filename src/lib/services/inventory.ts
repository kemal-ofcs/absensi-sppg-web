import "server-only";

import { randomUUID } from "node:crypto";
import type { Client, InStatement, Transaction } from "@libsql/client";
import { balikJurnalTx, tulisJurnalTx } from "@/lib/services/accounting";
import { batasTutup } from "@/lib/services/tutup-buku";
import {
  ALASAN_FORMULIR,
  asciiLower,
  type BarangDraftParsed,
  type BarangInventaris,
  type BarisBelumDijurnal,
  type BarisDokumen,
  type BarisPengadaan,
  bacaAtribut,
  barangDraftSchema,
  type DaftarInventaris,
  type DaftarJurnalInventaris,
  type DaftarPinjaman,
  type DokumenInventaris,
  formatKodeBarang,
  formatKodeUnit,
  type HasilServis,
  idJurnalInventaris,
  idJurnalServis,
  idMutasiKondisiServis,
  idPembatalan,
  isMutasiServis,
  isValidDate,
  jenisBeritaAcara,
  jurnalInventarisDraftSchema,
  type KartuStok,
  KELOMPOK_AKUN_JURNAL_INVENTARIS,
  KETERANGAN_BALIK_INVENTARIS,
  KODE_PREFIX_SETTING_KEY,
  KONDISI_BARANG,
  type KolomInventaris,
  type KolomUntukAtribut,
  type KondisiBarang,
  type KopPerusahaan,
  keteranganJurnalInventaris,
  keteranganJurnalServis,
  kolomDraftSchema,
  kondisiHasilServis,
  MAKS_BARIS_DOKUMEN,
  MAKS_BARIS_KARTU_STOK,
  MAKS_BARIS_PENGADAAN,
  MAKS_BARIS_PINJAMAN,
  MAKS_DAFTAR_JURNAL_INVENTARIS,
  MAKS_JUMLAH,
  MAKS_JURNAL_INVENTARIS,
  MAKS_KOLOM_AKTIF,
  MAKS_RIWAYAT_SERVIS,
  MAKS_SERVIS_TERBUKA,
  MAKS_UNIT_DAFTAR,
  type MutasiAsal,
  type MutasiDraftParsed,
  type MutasiValid,
  mutasiDraftSchema,
  nomorKodeBerikutnya,
  normalizeKodePrefix,
  normalizeTempat,
  opnameDraftSchema,
  type PenerimaInventaris,
  type PinjamanAktif,
  type PosisiStok,
  parseKodePrefixes,
  pasanganAkunJurnalInventaris,
  pasanganAkunJurnalServis,
  type RekapPengadaan,
  type RiwayatOpname,
  type RiwayatServis,
  rekapSumberDana,
  type ServisInventaris,
  servisDraftSchema,
  statusKedaluwarsa,
  statusServis,
  stokMenipis,
  susunPembatalan,
  type TipeBarang,
  type TipeKolom,
  tutupServisDraftSchema,
  unitDraftSchema,
  validasiUnit,
  validasiUnitEdit,
  validateAlasanBatalServis,
  validateAtribut,
  validateBarang,
  validateIsianServis,
  validateKodePrefixes,
  validateKolom,
  validateMutasi,
  validateOpname,
  validateTutupServis,
} from "@/lib/validations/inventory";

/**
 * Cermin Web dari `desktop/inventory.rs`. Web menulis langsung ke database
 * cloud, jadi pemeriksaan saldo di sini memakai data paling lengkap yang ada;
 * Desktop/Mobile memeriksa saldo lokalnya sendiri.
 */

export type Executor = Pick<Client | Transaction, "execute">;

/**
 * Nilai satu mutasi dalam rupiah. Harga satuan selalu per 1 satuan, jadi
 * barang desimal dibagi 100 dan dibulatkan ke rupiah terdekat per baris.
 * Cermin `NILAI_MUTASI_SQL` di `inventory.rs`.
 */
const NILAI_MUTASI_SQL = `CASE WHEN b.desimal = 1
        THEN (m.jumlah * COALESCE(m.harga_satuan, 0) + 50) / 100
        ELSE m.jumlah * COALESCE(m.harga_satuan, 0) END`;

export function newHexId(prefix: string): string {
  return `${prefix}${randomUUID().replaceAll("-", "")}`;
}

async function readKodePrefixes(client: Executor): Promise<string[]> {
  const result = await client.execute({
    sql: "SELECT value FROM setting_gex_system WHERE key = ?;",
    args: [KODE_PREFIX_SETTING_KEY],
  });
  return parseKodePrefixes(text(result.rows[0]?.value));
}

/**
 * Cermin `next_item_code`. Nomor urut per awalan dihitung dari data yang
 * terlihat penulisnya, jadi perangkat offline bisa menerbitkan nomor yang
 * sama; kembarannya ditandai `kode_ganda` di daftar barang.
 */
async function nextItemCode(
  tx: Transaction,
  prefix: string,
  idBarang: string,
): Promise<string> {
  const result = await tx.execute({
    sql: "SELECT kode_barang FROM inventory_barang WHERE kode_barang LIKE ? || '-%';",
    args: [prefix],
  });
  let nomor = nomorKodeBerikutnya(
    prefix,
    result.rows.map((row) => String(row.kode_barang)),
  );
  let kode = formatKodeBarang(prefix, nomor);
  while (await kodeDipakai(tx, kode, idBarang)) {
    nomor += 1;
    kode = formatKodeBarang(prefix, nomor);
  }
  return kode;
}

/** Cermin `save_code_prefixes`. Web menulis langsung ke cloud. */
export async function saveCodePrefixes(
  client: Client,
  prefixes: readonly string[],
): Promise<{ sukses: true; kode_prefix: string[] }> {
  const checked = validateKodePrefixes(prefixes);
  if (!checked.ok) throw new Error(checked.error);
  await client.execute({
    sql: `INSERT INTO setting_gex_system (key, value) VALUES (?, ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value;`,
    args: [KODE_PREFIX_SETTING_KEY, JSON.stringify(checked.value)],
  });
  return { sukses: true, kode_prefix: checked.value };
}

/** Cermin `list_kolom`: urut waktu dibuat, nama kembar ditandai. */
async function listKolom(client: Executor): Promise<KolomInventaris[]> {
  const result = await client.execute(
    `SELECT k.id_kolom, k.nama, k.tipe, k.is_aktif,
            EXISTS(SELECT 1 FROM inventory_kolom lain
                   WHERE LOWER(lain.nama) = LOWER(k.nama) AND lain.id_kolom <> k.id_kolom
                     AND lain.dihapus_pada IS NULL) AS ganda
     FROM inventory_kolom k
     WHERE k.dihapus_pada IS NULL
     ORDER BY k.created_at, k.id_kolom
     -- batas: kolom aktif dibatasi MAKS_KOLOM_AKTIF saat menyimpan
     ;`,
  );
  return result.rows.map((row) => ({
    id_kolom: String(row.id_kolom),
    nama: String(row.nama),
    tipe: String(row.tipe) as TipeKolom,
    is_aktif: Number(row.is_aktif) === 1,
    nama_ganda: Number(row.ganda) === 1,
  }));
}

/** Cermin `read_kolom_info`: termasuk kolom yang dihapus, untuk membuang isinya. */
async function kolomUntukAtribut(
  client: Executor,
): Promise<KolomUntukAtribut[]> {
  const result = await client.execute(
    "SELECT id_kolom, nama, tipe, dihapus_pada IS NOT NULL AS dihapus FROM inventory_kolom;",
  );
  return result.rows.map((row) => ({
    id_kolom: String(row.id_kolom),
    nama: String(row.nama),
    tipe: String(row.tipe) as TipeKolom,
    dihapus: Number(row.dihapus) === 1,
  }));
}

/** Cermin `save_column`. */
export async function saveColumn(
  client: Client,
  rawDraft: unknown,
): Promise<{ sukses: true; id_kolom: string }> {
  const parsed = kolomDraftSchema.safeParse(rawDraft);
  if (!parsed.success) throw new Error("Data kolom tidak valid.");
  const checked = validateKolom(parsed.data);
  if (!checked.ok) throw new Error(checked.error);
  const valid = checked.value;

  return withTransaction(client, async (tx) => {
    const requestedId = parsed.data.id_kolom?.trim() || null;
    let sudahAktif = false;
    if (requestedId) {
      const existing = await tx.execute({
        sql: "SELECT tipe, is_aktif, dihapus_pada FROM inventory_kolom WHERE id_kolom = ?;",
        args: [requestedId],
      });
      const row = existing.rows[0];
      if (!row) throw new Error("Kolom tidak ditemukan.");
      if (row.dihapus_pada !== null)
        throw new Error("Kolom ini sudah dihapus.");
      if (String(row.tipe) !== valid.tipe) {
        throw new Error("Tipe kolom tidak bisa diubah setelah dibuat.");
      }
      sudahAktif = Number(row.is_aktif) === 1;
    }
    const idKolom = requestedId ?? newHexId("kol-");

    const dipakai = await tx.execute({
      sql: `SELECT EXISTS(SELECT 1 FROM inventory_kolom
                          WHERE LOWER(nama) = LOWER(?) AND id_kolom <> ?
                            AND dihapus_pada IS NULL) AS ada;`,
      args: [valid.nama, idKolom],
    });
    if (Number(dipakai.rows[0]?.ada) === 1) {
      throw new Error("Nama kolom sudah dipakai kolom lain.");
    }
    if (valid.is_aktif && !sudahAktif) {
      const aktif = await tx.execute({
        sql: "SELECT COUNT(*) AS jumlah FROM inventory_kolom WHERE is_aktif = 1 AND id_kolom <> ?;",
        args: [idKolom],
      });
      if (Number(aktif.rows[0]?.jumlah) >= MAKS_KOLOM_AKTIF) {
        throw new Error("Maksimal 20 kolom tambahan aktif.");
      }
    }

    await tx.execute({
      sql: `INSERT INTO inventory_kolom (id_kolom, nama, tipe, is_aktif, created_at, updated_at)
            VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))
            ON CONFLICT(id_kolom) DO UPDATE SET
              nama = excluded.nama,
              is_aktif = excluded.is_aktif,
              updated_at = excluded.updated_at;`,
      args: [idKolom, valid.nama, valid.tipe, valid.is_aktif ? 1 : 0],
    });
    return { sukses: true as const, id_kolom: idKolom };
  });
}

/**
 * Cermin `delete_column`: tandai `dihapus_pada`, lalu buang isinya dari setiap
 * barang di transaksi yang sama.
 */
export async function deleteColumn(
  client: Client,
  rawId: unknown,
): Promise<{ sukses: true; barang_dibersihkan: number }> {
  const idKolom = typeof rawId === "string" ? rawId.trim() : "";
  if (!/^kol-[0-9a-f]{1,32}$/.test(idKolom)) {
    throw new Error("Kolom tidak ditemukan.");
  }
  return withTransaction(client, async (tx) => {
    const existing = await tx.execute({
      sql: "SELECT dihapus_pada FROM inventory_kolom WHERE id_kolom = ?;",
      args: [idKolom],
    });
    const row = existing.rows[0];
    if (!row) throw new Error("Kolom tidak ditemukan.");
    if (row.dihapus_pada !== null) throw new Error("Kolom ini sudah dihapus.");
    await tx.execute({
      sql: `UPDATE inventory_kolom
            SET dihapus_pada = datetime('now'), is_aktif = 0, updated_at = datetime('now')
            WHERE id_kolom = ?;`,
      args: [idKolom],
    });
    // `idKolom` sudah lolos pola heksadesimal, jadi aman disusun menjadi path JSON.
    const path = `$."${idKolom}"`;
    const dibersihkan = await tx.execute({
      sql: `UPDATE inventory_barang
            SET atribut = NULLIF(json_remove(atribut, ?), '{}'), updated_at = datetime('now')
            WHERE json_valid(atribut) AND json_extract(atribut, ?) IS NOT NULL;`,
      args: [path, path],
    });
    return {
      sukses: true as const,
      barang_dibersihkan: dibersihkan.rowsAffected,
    };
  });
}

export async function wibToday(client: Executor): Promise<string> {
  const result = await client.execute(
    "SELECT date('now', '+7 hours') AS hari;",
  );
  return String(result.rows[0]?.hari ?? "");
}

export async function withTransaction<T>(
  client: Client,
  work: (tx: Transaction) => Promise<T>,
): Promise<T> {
  const tx = await client.transaction("write");
  try {
    const result = await work(tx);
    await tx.commit();
    return result;
  } catch (error) {
    await tx.rollback();
    throw error;
  } finally {
    tx.close();
  }
}

export function text(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

/** Cermin `canonical_tempat`. */
async function canonicalTempat(client: Executor, tempat: string | null) {
  if (tempat === null) return null;
  const result = await client.execute({
    sql: `SELECT tempat FROM (
            SELECT tempat_tujuan AS tempat FROM inventory_mutasi WHERE tempat_tujuan IS NOT NULL
            UNION ALL
            SELECT tempat_utama FROM inventory_barang WHERE tempat_utama IS NOT NULL
          ) WHERE LOWER(tempat) = LOWER(?) LIMIT 1;`,
    args: [tempat],
  });
  return text(result.rows[0]?.tempat) ?? tempat;
}

async function saldoPosisi(
  client: Executor,
  idBarang: string,
  tempat: string,
  kondisi: string,
  idBatch: string | null,
): Promise<number> {
  const result = await client.execute({
    sql: `SELECT COALESCE(SUM(saldo), 0) AS saldo FROM inventory_saldo
          WHERE id_barang = ? AND LOWER(tempat) = LOWER(?) AND kondisi = ? AND id_batch IS ?;`,
    args: [idBarang, tempat, kondisi, idBatch],
  });
  return Number(result.rows[0]?.saldo ?? 0);
}

export async function listInventory(client: Client): Promise<DaftarInventaris> {
  const posisiResult = await client.execute(
    `SELECT s.id_barang, s.tempat, s.kondisi, s.id_batch, s.saldo, m.tanggal_expired,
            CAST(julianday(m.tanggal_expired) - julianday(date('now', '+7 hours')) AS INTEGER) AS sisa_hari,
            u.kode_unit, u.nomor_seri, u.catatan AS catatan_unit
     FROM inventory_saldo s
     LEFT JOIN inventory_mutasi m ON m.id_mutasi = s.id_batch
     LEFT JOIN inventory_unit u ON u.id_unit = s.id_batch
     WHERE s.saldo <> 0
     ORDER BY s.id_barang, m.tanggal_expired IS NULL, m.tanggal_expired, u.kode_unit, s.tempat
     -- batas: satu baris per posisi stok (barang × tempat × kondisi × batch) yang saldonya bukan nol
     ;`,
  );
  const posisiPerBarang = new Map<string, PosisiStok[]>();
  for (const row of posisiResult.rows) {
    const id = String(row.id_barang);
    const list = posisiPerBarang.get(id) ?? [];
    list.push({
      tempat: String(row.tempat),
      kondisi: String(row.kondisi) as KondisiBarang,
      id_batch: text(row.id_batch),
      saldo: Number(row.saldo),
      tanggal_expired: text(row.tanggal_expired),
      sisa_hari: row.sisa_hari === null ? null : Number(row.sisa_hari),
      status_kedaluwarsa:
        row.sisa_hari === null
          ? null
          : statusKedaluwarsa(Number(row.sisa_hari)),
      kode_unit: text(row.kode_unit),
      nomor_seri: text(row.nomor_seri),
      catatan_unit: text(row.catatan_unit),
    });
    posisiPerBarang.set(id, list);
  }
  const dilacak = new Set(
    (
      await client.execute("SELECT DISTINCT id_barang FROM inventory_unit;")
    ).rows.map((row) => String(row.id_barang)),
  );

  const barangResult = await client.execute(
    `SELECT id_barang, kode_barang, nama_barang, kategori, tipe, satuan, bisa_expired,
            stok_minimum, tempat_utama, catatan, status_aktif, atribut, desimal,
            EXISTS(SELECT 1 FROM inventory_mutasi m WHERE m.id_barang = inventory_barang.id_barang) AS punya_mutasi
     FROM inventory_barang
     ORDER BY status_aktif DESC, nama_barang COLLATE NOCASE
     -- batas: satu baris per barang; EXISTS hanya memeriksa ada tidaknya mutasi
     ;`,
  );
  const barang: BarangInventaris[] = barangResult.rows.map((row) => {
    const posisi = posisiPerBarang.get(String(row.id_barang)) ?? [];
    const stokBaik = posisi
      .filter((entry) => entry.kondisi === "Baik")
      .reduce((sum, entry) => sum + entry.saldo, 0);
    return {
      id_barang: String(row.id_barang),
      kode_barang: String(row.kode_barang),
      nama_barang: String(row.nama_barang),
      kategori: text(row.kategori),
      tipe: String(row.tipe) as TipeBarang,
      satuan: String(row.satuan),
      bisa_expired: Number(row.bisa_expired) === 1,
      desimal: Number(row.desimal) === 1,
      punya_mutasi: Number(row.punya_mutasi) === 1,
      stok_minimum: Number(row.stok_minimum),
      tempat_utama: text(row.tempat_utama),
      catatan: text(row.catatan),
      status_aktif: Number(row.status_aktif) === 1,
      kode_ganda: false,
      stok_total: posisi.reduce((sum, entry) => sum + entry.saldo, 0),
      stok_baik: stokBaik,
      stok_menipis: stokMenipis(stokBaik, Number(row.stok_minimum)),
      posisi,
      dilacak_unit: dilacak.has(String(row.id_barang)),
      atribut: bacaAtribut(row.atribut),
    };
  });

  const tempatResult = await client.execute(
    `SELECT tempat FROM inventory_saldo WHERE saldo <> 0
     UNION
     SELECT tempat_utama FROM inventory_barang
     WHERE tempat_utama IS NOT NULL AND status_aktif = 1
     ORDER BY 1 COLLATE NOCASE;`,
  );
  const tempat: string[] = [];
  for (const row of tempatResult.rows) {
    const value = String(row.tempat);
    if (!tempat.some((known) => asciiLower(known) === asciiLower(value))) {
      tempat.push(value);
    }
  }

  const kategoriResult = await client.execute(
    `SELECT DISTINCT kategori FROM inventory_barang
     WHERE kategori IS NOT NULL ORDER BY kategori COLLATE NOCASE;`,
  );
  const kategori = kategoriResult.rows.map((row) => String(row.kategori));

  // Cermin `list_inventory`: kode kembar dari dua perangkat offline hanya
  // terlihat di sini, karena DB sengaja tanpa UNIQUE.
  const jumlahKode = new Map<string, number>();
  for (const item of barang) {
    const key = asciiLower(item.kode_barang);
    jumlahKode.set(key, (jumlahKode.get(key) ?? 0) + 1);
  }
  for (const item of barang) {
    item.kode_ganda = (jumlahKode.get(asciiLower(item.kode_barang)) ?? 0) > 1;
  }

  return {
    barang,
    tempat,
    kategori,
    kode_prefix: await readKodePrefixes(client),
    kolom: await listKolom(client),
    servis: await listServisTerbuka(client),
    hari_ini: await wibToday(client),
    nama_perusahaan: (await kopPerusahaan(client)).nama ?? null,
  };
}

/** Cermin `list_recipients`. */
export async function listRecipients(
  client: Client,
): Promise<PenerimaInventaris> {
  const personil = await client.execute(
    `SELECT id_unik, nama, jenis_personil, divisi
     FROM master_data
     WHERE status_aktif = 'Aktif'
     ORDER BY nama COLLATE NOCASE;`,
  );
  const divisi = await client.execute(
    `SELECT MIN(TRIM(divisi)) AS divisi FROM master_data
     WHERE status_aktif = 'Aktif' AND TRIM(COALESCE(divisi, '')) <> ''
     GROUP BY LOWER(TRIM(divisi))
     ORDER BY 1 COLLATE NOCASE;`,
  );
  return {
    personil: personil.rows.map((row) => ({
      id: String(row.id_unik),
      nama: String(row.nama),
      jenis: text(row.jenis_personil),
      divisi: text(row.divisi),
    })),
    divisi: divisi.rows.map((row) => String(row.divisi)),
  };
}

async function kodeDipakai(tx: Transaction, kode: string, idBarang: string) {
  const result = await tx.execute({
    sql: `SELECT EXISTS(SELECT 1 FROM inventory_barang
                        WHERE LOWER(kode_barang) = LOWER(?) AND id_barang <> ?) AS ada;`,
    args: [kode, idBarang],
  });
  return Number(result.rows[0]?.ada) === 1;
}

/** Cermin `save_item`. */
export async function saveItem(
  client: Client,
  rawDraft: unknown,
): Promise<{ sukses: true; id_barang: string; kode_barang: string }> {
  const parsed = barangDraftSchema.safeParse(rawDraft);
  if (!parsed.success) throw new Error("Data barang tidak valid.");
  const draft = parsed.data;
  return withTransaction(client, async (tx) => ({
    sukses: true as const,
    ...(await saveItemTx(tx, draft, null)),
  }));
}

/**
 * Cermin `save_item_tx`: inti `saveItem` di dalam transaksi pemanggil.
 * `idBaru` = id untuk barang baru (penerimaan pengajuan memakai
 * `brg-<id_baris>`); null = id acak.
 */
export async function saveItemTx(
  tx: Transaction,
  draft: BarangDraftParsed,
  idBaru: string | null,
): Promise<{ id_barang: string; kode_barang: string }> {
  const checked = validateBarang(draft);
  if (!checked.ok) throw new Error(checked.error);
  const valid = checked.value;
  const requestedId = draft.id_barang?.trim() || null;
  let idBarang = requestedId ?? idBaru ?? newHexId("brg-");
  if (requestedId) {
    const existing = await tx.execute({
      sql: "SELECT satuan, bisa_expired, desimal FROM inventory_barang WHERE id_barang = ?;",
      args: [requestedId],
    });
    const row = existing.rows[0];
    if (!row) throw new Error("Barang tidak ditemukan.");
    // Desimal mengubah arti setiap jumlah yang sudah tercatat (×100).
    const berubah =
      String(row.satuan) !== valid.satuan ||
      (Number(row.bisa_expired) === 1) !== valid.bisa_expired ||
      (Number(row.desimal) === 1) !== valid.desimal;
    if (berubah) {
      const history = await tx.execute({
        sql: "SELECT EXISTS(SELECT 1 FROM inventory_mutasi WHERE id_barang = ? LIMIT 1) AS ada;",
        args: [requestedId],
      });
      if (Number(history.rows[0]?.ada) === 1) {
        throw new Error(
          "Satuan, desimal, dan pengaturan kedaluwarsa tidak bisa diubah setelah barang punya riwayat mutasi.",
        );
      }
    }
    idBarang = requestedId;
  }

  let kode = valid.kode_barang;
  if (kode !== null) {
    if (await kodeDipakai(tx, kode, idBarang)) {
      throw new Error("Kode barang sudah dipakai barang lain.");
    }
  } else {
    const prefixes = await readKodePrefixes(tx);
    const diminta = draft.kode_prefix?.trim();
    let prefix = prefixes[0] as string;
    if (diminta) {
      const normal = normalizeKodePrefix(diminta);
      if (normal === null || !prefixes.includes(normal)) {
        throw new Error("Awalan kode tidak terdaftar.");
      }
      prefix = normal;
    }
    kode = await nextItemCode(tx, prefix, idBarang);
  }
  const tempatUtama = await canonicalTempat(tx, valid.tempat_utama);
  const atribut = validateAtribut(draft.atribut, await kolomUntukAtribut(tx));
  if (!atribut.ok) throw new Error(atribut.error);

  await tx.execute({
    sql: `INSERT INTO inventory_barang (
              id_barang, kode_barang, nama_barang, kategori, tipe, satuan, bisa_expired,
              stok_minimum, tempat_utama, catatan, status_aktif, created_at, updated_at, atribut,
              desimal
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'), ?, ?)
            ON CONFLICT(id_barang) DO UPDATE SET
              kode_barang = excluded.kode_barang,
              nama_barang = excluded.nama_barang,
              kategori = excluded.kategori,
              tipe = excluded.tipe,
              satuan = excluded.satuan,
              bisa_expired = excluded.bisa_expired,
              stok_minimum = excluded.stok_minimum,
              tempat_utama = excluded.tempat_utama,
              catatan = excluded.catatan,
              status_aktif = excluded.status_aktif,
              updated_at = excluded.updated_at,
              atribut = excluded.atribut,
              desimal = excluded.desimal;`,
    args: [
      idBarang,
      kode,
      valid.nama_barang,
      valid.kategori,
      valid.tipe,
      valid.satuan,
      valid.bisa_expired ? 1 : 0,
      valid.stok_minimum,
      tempatUtama,
      valid.catatan,
      valid.status_aktif ? 1 : 0,
      Object.keys(atribut.value).length > 0
        ? JSON.stringify(atribut.value)
        : null,
      valid.desimal ? 1 : 0,
    ],
  });
  return { id_barang: idBarang, kode_barang: kode };
}

function insertMutasiStatement(
  idMutasi: string,
  idBarang: string,
  valid: MutasiValid,
  idRef: string | null,
  dicatatOleh: string,
): InStatement {
  return {
    sql: `INSERT INTO inventory_mutasi (
            id_mutasi, id_barang, jenis, alasan, tanggal, jumlah, tempat_asal, kondisi_asal,
            tempat_tujuan, kondisi_tujuan, id_batch, tanggal_expired, id_ref, penerima_tipe,
            penerima_id, penerima_nama, keperluan, sumber_dana, nomor_dokumen, harga_satuan,
            catatan, dicatat_oleh, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'));`,
    args: [
      idMutasi,
      idBarang,
      valid.jenis,
      valid.alasan,
      valid.tanggal,
      valid.jumlah,
      valid.tempat_asal,
      valid.kondisi_asal,
      valid.tempat_tujuan,
      valid.kondisi_tujuan,
      valid.id_batch,
      valid.tanggal_expired,
      idRef,
      valid.penerima_tipe,
      valid.penerima_id,
      valid.penerima_nama,
      valid.keperluan,
      valid.sumber_dana,
      valid.nomor_dokumen,
      valid.harga_satuan,
      valid.catatan,
      dicatatOleh,
    ],
  };
}

/** Cermin `record_mutation`. `dicatatOleh` selalu dari sesi, tidak dari body. */
export async function recordMutation(
  client: Client,
  dicatatOleh: string,
  rawDraft: unknown,
): Promise<{ sukses: true; id_mutasi: string }> {
  const parsed = mutasiDraftSchema.safeParse(rawDraft);
  if (!parsed.success) throw new Error("Data mutasi tidak valid.");
  const draft = parsed.data;
  return withTransaction(client, async (tx) => ({
    sukses: true as const,
    id_mutasi: await recordMutationTx(tx, dicatatOleh, draft, null),
  }));
}

/**
 * Cermin `record_mutation_tx`: inti pencatatan mutasi di dalam transaksi milik
 * pemanggil, supaya kunjungan UKS bisa menulis barisnya dan obatnya atomik.
 * `idRef` menautkan mutasi ke catatan asalnya; untuk Pengembalian nilainya
 * tetap dari draft.
 */
export async function recordMutationTx(
  tx: Transaction,
  dicatatOleh: string,
  draft: MutasiDraftParsed,
  idRef: string | null,
): Promise<string> {
  const idBarang = draft.id_barang.trim();
  const barangResult = await tx.execute({
    sql: "SELECT tipe, bisa_expired FROM inventory_barang WHERE id_barang = ?;",
    args: [idBarang],
  });
  const barang = barangResult.rows[0];
  if (!barang) throw new Error("Barang tidak ditemukan.");
  const dilacak = await barangDilacak(tx, idBarang);
  const checked = validasiUnit({
    dilacak,
    per_unit: draft.per_unit,
    tipe: String(barang.tipe),
    bisa_expired: Number(barang.bisa_expired) === 1,
    jenis: draft.jenis,
    alasan: draft.alasan,
    jumlah: draft.jumlah,
    unit: draft.unit,
  });
  if (!checked.ok) throw new Error(checked.error);
  // Pengembalian unit membawa batch (= unit) dari peminjamannya sendiri.
  if (!(dilacak || draft.per_unit) || draft.alasan === "Pengembalian") {
    return recordSatu(tx, dicatatOleh, draft, idRef, null, false);
  }

  // Beberapa unit dalam satu aksi berbagi satu nomor dokumen.
  const satu: MutasiDraftParsed = {
    ...draft,
    jumlah: 1,
    unit: [],
    per_unit: false,
    nomor_dokumen:
      draft.nomor_dokumen?.trim() ||
      (draft.jumlah > 1 ? await nomorDokumenUnit(tx) : draft.nomor_dokumen),
  };
  let pertama: string | null = null;
  if (draft.jenis === "Masuk") {
    for (let i = 0; i < draft.jumlah; i++) {
      const id = await recordSatu(tx, dicatatOleh, satu, idRef, null, true);
      await buatUnit(tx, idBarang, id);
      pertama ??= id;
    }
  } else {
    for (const idUnit of checked.value) {
      const milik = await tx.execute({
        sql: "SELECT EXISTS(SELECT 1 FROM inventory_unit WHERE id_unit = ? AND id_barang = ?) AS ada;",
        args: [idUnit, idBarang],
      });
      if (Number(milik.rows[0]?.ada) !== 1) {
        throw new Error("Unit tidak ditemukan.");
      }
      const id = await recordSatu(tx, dicatatOleh, satu, idRef, idUnit, false);
      pertama ??= id;
    }
  }
  if (pertama === null) throw new Error("Mutasi tidak tersimpan.");
  return pertama;
}

async function barangDilacak(tx: Executor, idBarang: string): Promise<boolean> {
  const result = await tx.execute({
    sql: "SELECT EXISTS(SELECT 1 FROM inventory_unit WHERE id_barang = ?) AS ada;",
    args: [idBarang],
  });
  return Number(result.rows[0]?.ada) === 1;
}

async function nomorDokumenUnit(tx: Executor): Promise<string> {
  const acak = randomUUID().replaceAll("-", "").slice(0, 4).toUpperCase();
  return `UNT-${(await wibToday(tx)).replaceAll("-", "")}-${acak}`;
}

/** Cermin `buat_unit`: nomor urut dihitung dari unit yang sudah ada. */
async function buatUnit(
  tx: Transaction,
  idBarang: string,
  idUnit: string,
): Promise<void> {
  const result = await tx.execute({
    sql: `SELECT b.kode_barang,
                 (SELECT COUNT(*) FROM inventory_unit u WHERE u.id_barang = b.id_barang) AS jumlah
          FROM inventory_barang b WHERE b.id_barang = ?;`,
    args: [idBarang],
  });
  const row = result.rows[0];
  if (!row) throw new Error("Barang tidak ditemukan.");
  await tx.execute({
    sql: `INSERT INTO inventory_unit (id_unit, id_barang, kode_unit, created_at, updated_at)
          VALUES (?, ?, ?, datetime('now'), datetime('now'));`,
    args: [
      idUnit,
      idBarang,
      formatKodeUnit(String(row.kode_barang), Number(row.jumlah) + 1),
    ],
  });
}

/** Cermin `register_units`: stok lama tanpa nomor menjadi unit. */
export async function registerUnits(
  client: Client,
  dicatatOleh: string,
  idBarang: string,
): Promise<{ sukses: true; jumlah: number; nomor_dokumen: string }> {
  const id = idBarang.trim();
  return withTransaction(client, async (tx) => {
    const barang = (
      await tx.execute({
        sql: "SELECT tipe, bisa_expired, status_aktif FROM inventory_barang WHERE id_barang = ?;",
        args: [id],
      })
    ).rows[0];
    if (!barang) throw new Error("Barang tidak ditemukan.");
    if (String(barang.tipe) !== "Aset" || Number(barang.bisa_expired) === 1) {
      throw new Error(
        "Hanya aset tanpa kedaluwarsa yang bisa dicatat per unit.",
      );
    }
    if (Number(barang.status_aktif) !== 1) {
      throw new Error("Barang sudah dinonaktifkan.");
    }
    const posisi = (
      await tx.execute({
        sql: `SELECT tempat, kondisi, saldo FROM inventory_saldo
              WHERE id_barang = ? AND id_batch IS NULL AND saldo > 0
              ORDER BY tempat, kondisi;`,
        args: [id],
      })
    ).rows.map((row) => ({
      tempat: String(row.tempat),
      kondisi: String(row.kondisi),
      saldo: Number(row.saldo),
    }));
    const total = posisi.reduce((sum, item) => sum + item.saldo, 0);
    if (total === 0) {
      throw new Error("Tidak ada stok yang belum terdaftar sebagai unit.");
    }
    if (total > MAKS_UNIT_DAFTAR) {
      throw new Error(
        "Stok terlalu banyak untuk didaftarkan sekaligus (maksimal 1000 unit).",
      );
    }
    const tanggal = await wibToday(tx);
    const nomor = await nomorDokumenUnit(tx);
    const dasar: MutasiValid = {
      jenis: "Keluar",
      alasan: "Distribusi",
      tanggal,
      jumlah: 1,
      tempat_asal: null,
      kondisi_asal: null,
      tempat_tujuan: null,
      kondisi_tujuan: null,
      id_batch: null,
      tanggal_expired: null,
      id_ref: null,
      penerima_tipe: null,
      penerima_id: null,
      penerima_nama: null,
      keperluan: null,
      sumber_dana: null,
      nomor_dokumen: nomor,
      harga_satuan: null,
      catatan: "Pendaftaran unit",
    };
    for (const item of posisi) {
      await tx.execute(
        insertMutasiStatement(
          newHexId("mts-"),
          id,
          {
            ...dasar,
            jumlah: item.saldo,
            tempat_asal: item.tempat,
            kondisi_asal: item.kondisi,
          },
          null,
          dicatatOleh,
        ),
      );
      for (let i = 0; i < item.saldo; i++) {
        const idUnit = newHexId("mts-");
        await tx.execute(
          insertMutasiStatement(
            idUnit,
            id,
            {
              ...dasar,
              jenis: "Masuk",
              tempat_tujuan: item.tempat,
              kondisi_tujuan: item.kondisi,
              id_batch: idUnit,
            },
            null,
            dicatatOleh,
          ),
        );
        await buatUnit(tx, id, idUnit);
      }
    }
    return { sukses: true as const, jumlah: total, nomor_dokumen: nomor };
  });
}

/** Cermin `save_unit`. Kode unit tidak bisa diubah karena sudah tercetak. */
export async function saveUnit(
  client: Client,
  rawDraft: unknown,
): Promise<{ sukses: true }> {
  const parsed = unitDraftSchema.safeParse(rawDraft);
  if (!parsed.success) throw new Error("Data unit tidak valid.");
  const checked = validasiUnitEdit(parsed.data);
  if (!checked.ok) throw new Error(checked.error);
  const result = await client.execute({
    sql: `UPDATE inventory_unit SET nomor_seri = ?, catatan = ?, updated_at = datetime('now')
          WHERE id_unit = ?;`,
    args: [
      checked.value.nomor_seri,
      checked.value.catatan,
      parsed.data.id_unit.trim(),
    ],
  });
  if (result.rowsAffected === 0) throw new Error("Unit tidak ditemukan.");
  return { sukses: true as const };
}

/** Inti satu baris mutasi; cermin `record_satu`. */
async function recordSatu(
  tx: Transaction,
  dicatatOleh: string,
  draft: MutasiDraftParsed,
  idRef: string | null,
  unit: string | null,
  jadikanBatch: boolean,
): Promise<string> {
  {
    const idBarang = draft.id_barang.trim();
    const barangResult = await tx.execute({
      sql: "SELECT tipe, satuan, bisa_expired, status_aktif FROM inventory_barang WHERE id_barang = ?;",
      args: [idBarang],
    });
    const barang = barangResult.rows[0];
    if (!barang) throw new Error("Barang tidak ditemukan.");
    const bisaExpired = Number(barang.bisa_expired) === 1;
    const satuan = String(barang.satuan);

    const hariIni = await wibToday(tx);
    const checked = validateMutasi(
      draft,
      { tipe: String(barang.tipe), bisa_expired: bisaExpired },
      hariIni,
    );
    if (!checked.ok) throw new Error(checked.error);
    const valid = checked.value;
    if (unit !== null) valid.id_batch = unit;
    if (idRef !== null) valid.id_ref = idRef;
    if (!(ALASAN_FORMULIR as readonly string[]).includes(valid.alasan)) {
      throw new Error("Alasan ini belum bisa dicatat dari formulir.");
    }
    if (valid.jenis === "Masuk" && Number(barang.status_aktif) !== 1) {
      throw new Error("Barang sudah dinonaktifkan.");
    }

    valid.tempat_asal = await canonicalTempat(tx, valid.tempat_asal);
    valid.tempat_tujuan = await canonicalTempat(tx, valid.tempat_tujuan);

    if (valid.penerima_tipe === "Personil" && valid.penerima_id) {
      const result = await tx.execute({
        sql: "SELECT nama FROM master_data WHERE id_unik = ?;",
        args: [valid.penerima_id],
      });
      const nama = text(result.rows[0]?.nama);
      if (nama === null) throw new Error("Penerima tidak ditemukan.");
      valid.penerima_nama = nama;
    } else if (valid.penerima_tipe === "Divisi") {
      // Cermin Rust: ejaan divisi diambil dari data personil.
      const result = await tx.execute({
        sql: `SELECT TRIM(divisi) AS divisi FROM master_data
              WHERE status_aktif = 'Aktif' AND LOWER(TRIM(divisi)) = LOWER(?)
              ORDER BY TRIM(divisi) LIMIT 1;`,
        args: [valid.penerima_nama ?? ""],
      });
      const nama = text(result.rows[0]?.divisi);
      if (nama === null) throw new Error("Divisi tidak ditemukan.");
      valid.penerima_nama = nama;
    }

    if (valid.id_ref !== null && valid.alasan === "Pengembalian") {
      const pinjaman = await loadPinjaman(tx, valid.id_ref, idBarang);
      const sisa = pinjaman.jumlah - (await jumlahKembali(tx, valid.id_ref));
      if (valid.jumlah > sisa) {
        throw new Error(
          `Sisa yang belum kembali hanya ${Math.max(sisa, 0)} ${satuan}.`,
        );
      }
      // Barang kembali ke batch asalnya dan membawa nama peminjamnya.
      valid.id_batch = pinjaman.id_batch;
      valid.penerima_tipe =
        pinjaman.penerima_tipe as MutasiValid["penerima_tipe"];
      valid.penerima_id = pinjaman.penerima_id;
      valid.penerima_nama = pinjaman.penerima_nama;
    }

    if (valid.id_batch !== null) {
      const result = await tx.execute({
        sql: `SELECT EXISTS(SELECT 1 FROM inventory_mutasi
                            WHERE id_mutasi = ? AND id_barang = ? AND jenis = 'Masuk') AS ada;`,
        args: [valid.id_batch, idBarang],
      });
      if (Number(result.rows[0]?.ada) !== 1)
        throw new Error("Batch tidak ditemukan.");
    }

    if (valid.tempat_asal !== null && valid.kondisi_asal !== null) {
      const saldo = await saldoPosisi(
        tx,
        idBarang,
        valid.tempat_asal,
        valid.kondisi_asal,
        valid.id_batch,
      );
      if (saldo < valid.jumlah) {
        throw new Error(
          `Stok di ${valid.tempat_asal} (${valid.kondisi_asal}) hanya ${Math.max(saldo, 0)} ${satuan}.`,
        );
      }
    }

    const idMutasi = newHexId("mts-");
    if (
      valid.jenis === "Masuk" &&
      (bisaExpired || jadikanBatch) &&
      valid.id_batch === null
    ) {
      valid.id_batch = idMutasi;
    }
    await tx.execute(
      insertMutasiStatement(
        idMutasi,
        idBarang,
        valid,
        valid.id_ref,
        dicatatOleh,
      ),
    );
    return idMutasi;
  }
}

/** Cermin `cancel_mutation`. */
export async function cancelMutation(
  client: Client,
  dicatatOleh: string,
  idMutasi: string,
  alasanBatal: string,
): Promise<{ sukses: true; id_mutasi: string }> {
  const alasan = alasanBatal.trim();
  if (!alasan) throw new Error("Alasan pembatalan wajib diisi.");
  if (Array.from(alasan).length > 500) {
    throw new Error("Alasan pembatalan maksimal 500 karakter.");
  }

  return withTransaction(client, async (tx) => {
    const result = await tx.execute({
      sql: `SELECT m.id_mutasi, m.jenis, m.alasan, m.jumlah, m.tempat_asal, m.kondisi_asal,
                   m.tempat_tujuan, m.kondisi_tujuan, m.id_batch, m.id_barang, b.satuan
            FROM inventory_mutasi m
            JOIN inventory_barang b ON b.id_barang = m.id_barang
            WHERE m.id_mutasi = ?;`,
      args: [idMutasi.trim()],
    });
    const row = result.rows[0];
    if (!row) throw new Error("Mutasi tidak ditemukan.");
    const asal: MutasiAsal = {
      id_mutasi: String(row.id_mutasi),
      jenis: String(row.jenis),
      alasan: String(row.alasan),
      jumlah: Number(row.jumlah),
      tempat_asal: text(row.tempat_asal),
      kondisi_asal: text(row.kondisi_asal),
      tempat_tujuan: text(row.tempat_tujuan),
      kondisi_tujuan: text(row.kondisi_tujuan),
      id_batch: text(row.id_batch),
    };
    const idBarang = String(row.id_barang);
    const satuan = String(row.satuan);
    if (isMutasiServis(asal.id_mutasi)) {
      throw new Error(
        "Mutasi ini dibuat dari penutupan servis dan tidak bisa dibatalkan. Catat Perubahan Kondisi baru bila kondisinya salah.",
      );
    }
    const built = susunPembatalan(asal);
    if (!built.ok) throw new Error(built.error);
    const kebalikan = built.value;

    const existing = await tx.execute({
      sql: "SELECT EXISTS(SELECT 1 FROM inventory_mutasi WHERE id_mutasi = ?) AS ada;",
      args: [kebalikan.id_mutasi],
    });
    if (Number(existing.rows[0]?.ada) === 1) {
      throw new Error("Mutasi ini sudah dibatalkan.");
    }
    // Peminjaman yang sudah (sebagian) kembali akan terhitung masuk dua kali.
    if (
      asal.alasan === "Peminjaman" &&
      (await jumlahKembali(tx, asal.id_mutasi)) > 0
    ) {
      throw new Error("Batalkan dulu pengembalian peminjaman ini.");
    }

    if (kebalikan.tempat_asal !== null && kebalikan.kondisi_asal !== null) {
      const saldo = await saldoPosisi(
        tx,
        idBarang,
        kebalikan.tempat_asal,
        kebalikan.kondisi_asal,
        kebalikan.id_batch,
      );
      if (saldo < kebalikan.jumlah) {
        throw new Error(
          `Stok di ${kebalikan.tempat_asal} (${kebalikan.kondisi_asal}) tinggal ${Math.max(saldo, 0)} ${satuan}, tidak cukup untuk membatalkan mutasi ini.`,
        );
      }
    }

    const valid: MutasiValid = {
      jenis: kebalikan.jenis as MutasiValid["jenis"],
      alasan: kebalikan.alasan,
      tanggal: await wibToday(tx),
      jumlah: kebalikan.jumlah,
      tempat_asal: kebalikan.tempat_asal,
      kondisi_asal: kebalikan.kondisi_asal,
      tempat_tujuan: kebalikan.tempat_tujuan,
      kondisi_tujuan: kebalikan.kondisi_tujuan,
      id_batch: kebalikan.id_batch,
      tanggal_expired: null,
      id_ref: asal.id_mutasi,
      penerima_tipe: null,
      penerima_id: null,
      penerima_nama: null,
      keperluan: null,
      sumber_dana: null,
      nomor_dokumen: null,
      harga_satuan: null,
      catatan: alasan,
    };
    await tx.execute(
      insertMutasiStatement(
        kebalikan.id_mutasi,
        idBarang,
        valid,
        asal.id_mutasi,
        dicatatOleh,
      ),
    );
    // Cermin `cancel_mutation`: jurnal pengadaan/hibah ikut dibalik di
    // transaksi yang sama. Tanpa jurnal: tidak ada apa-apa.
    await balikJurnalTx(
      tx,
      idJurnalInventaris(asal.id_mutasi),
      KETERANGAN_BALIK_INVENTARIS,
      dicatatOleh,
    );
    return { sukses: true as const, id_mutasi: kebalikan.id_mutasi };
  });
}

interface Pinjaman {
  jumlah: number;
  id_batch: string | null;
  penerima_tipe: string | null;
  penerima_id: string | null;
  penerima_nama: string | null;
}

/** Cermin `load_pinjaman`. */
async function loadPinjaman(
  tx: Transaction,
  idPinjam: string,
  idBarang: string,
): Promise<Pinjaman> {
  const result = await tx.execute({
    sql: `SELECT jumlah, id_batch, penerima_tipe, penerima_id, penerima_nama
          FROM inventory_mutasi
          WHERE id_mutasi = ? AND id_barang = ? AND jenis = 'Keluar' AND alasan = 'Peminjaman';`,
    args: [idPinjam, idBarang],
  });
  const row = result.rows[0];
  if (!row) throw new Error("Peminjaman tidak ditemukan.");
  const batal = await tx.execute({
    sql: "SELECT EXISTS(SELECT 1 FROM inventory_mutasi WHERE id_mutasi = ?) AS ada;",
    args: [idPembatalan(idPinjam)],
  });
  if (Number(batal.rows[0]?.ada) === 1) {
    throw new Error("Peminjaman ini sudah dibatalkan.");
  }
  return {
    jumlah: Number(row.jumlah),
    id_batch: text(row.id_batch),
    penerima_tipe: text(row.penerima_tipe),
    penerima_id: text(row.penerima_id),
    penerima_nama: text(row.penerima_nama),
  };
}

/** Cermin `jumlah_kembali`: tanpa pengembalian yang dibatalkan. */
async function jumlahKembali(tx: Executor, idPinjam: string): Promise<number> {
  const result = await tx.execute({
    sql: `SELECT COALESCE(SUM(r.jumlah), 0) AS kembali FROM inventory_mutasi r
          WHERE r.id_ref = ? AND r.alasan = 'Pengembalian'
            AND NOT EXISTS (SELECT 1 FROM inventory_mutasi b WHERE b.id_mutasi = 'batal-' || r.id_mutasi);`,
    args: [idPinjam],
  });
  return Number(result.rows[0]?.kembali ?? 0);
}

/** Cermin `list_loans`: peminjaman yang belum kembali penuh. */
export async function listLoans(client: Client): Promise<DaftarPinjaman> {
  const result = await client.execute(
    `SELECT * FROM (
       SELECT p.id_mutasi, p.id_barang, b.nama_barang, b.kode_barang, b.satuan, b.tipe,
              p.tanggal, p.jumlah, p.tempat_asal, p.kondisi_asal, p.id_batch,
              p.penerima_tipe, p.penerima_nama, p.keperluan,
              COALESCE((SELECT SUM(r.jumlah) FROM inventory_mutasi r
                        WHERE r.id_ref = p.id_mutasi AND r.alasan = 'Pengembalian'
                          AND NOT EXISTS (SELECT 1 FROM inventory_mutasi rb
                                          WHERE rb.id_mutasi = 'batal-' || r.id_mutasi)), 0) AS kembali,
              CAST(julianday(date('now', '+7 hours')) - julianday(p.tanggal) AS INTEGER) AS lama_hari,
              p.created_at, b.desimal
       FROM inventory_mutasi p
       JOIN inventory_barang b ON b.id_barang = p.id_barang
       WHERE p.alasan = 'Peminjaman'
         AND NOT EXISTS (SELECT 1 FROM inventory_mutasi pb WHERE pb.id_mutasi = 'batal-' || p.id_mutasi)
     ) WHERE jumlah > kembali
     ORDER BY tanggal, created_at, id_mutasi
     LIMIT 501;`,
  );
  const baris: PinjamanAktif[] = result.rows.map((row) => ({
    id_mutasi: String(row.id_mutasi),
    id_barang: String(row.id_barang),
    nama_barang: String(row.nama_barang),
    kode_barang: String(row.kode_barang),
    satuan: String(row.satuan),
    desimal: Number(row.desimal) === 1,
    tipe: String(row.tipe) as TipeBarang,
    tanggal: String(row.tanggal),
    jumlah: Number(row.jumlah),
    tempat_asal: text(row.tempat_asal),
    kondisi_asal: text(row.kondisi_asal),
    id_batch: text(row.id_batch),
    penerima_tipe: text(row.penerima_tipe),
    penerima_nama: text(row.penerima_nama),
    keperluan: text(row.keperluan),
    kembali: Number(row.kembali),
    sisa: Number(row.jumlah) - Number(row.kembali),
    lama_hari: Number(row.lama_hari),
  }));
  const terpotong = baris.length > MAKS_BARIS_PINJAMAN;
  return { baris: baris.slice(0, MAKS_BARIS_PINJAMAN), terpotong };
}

/** Cermin `record_opname`: semua selisih dalam satu transaksi. */
export async function recordOpname(
  client: Client,
  dicatatOleh: string,
  rawDraft: unknown,
): Promise<{ sukses: true; nomor_dokumen: string; jumlah_selisih: number }> {
  const parsed = opnameDraftSchema.safeParse(rawDraft);
  if (!parsed.success) throw new Error("Data opname tidak valid.");
  const checked = validateOpname(parsed.data);
  if (!checked.ok) throw new Error(checked.error);
  const valid = checked.value;

  return withTransaction(client, async (tx) => {
    const tempat = (await canonicalTempat(tx, valid.tempat)) as string;
    const hariIni = await wibToday(tx);
    const acak = randomUUID().replaceAll("-", "").slice(0, 4).toUpperCase();
    const nomor = `OPN-${hariIni.replaceAll("-", "")}-${acak}`;
    let jumlahSelisih = 0;

    for (const baris of valid.baris) {
      const barangResult = await tx.execute({
        sql: "SELECT tipe, bisa_expired, nama_barang FROM inventory_barang WHERE id_barang = ?;",
        args: [baris.id_barang],
      });
      const barang = barangResult.rows[0];
      if (!barang) throw new Error("Barang pada baris opname tidak ditemukan.");
      const nama = String(barang.nama_barang);
      const kondisi =
        String(barang.tipe) === "Habis Pakai" ? "Baik" : baris.kondisi;
      let idBatch: string | null = null;
      if (Number(barang.bisa_expired) === 1) {
        if (baris.id_batch === null)
          throw new Error(`Pilih batch untuk ${nama}.`);
        const ada = await tx.execute({
          sql: `SELECT EXISTS(SELECT 1 FROM inventory_mutasi
                              WHERE id_mutasi = ? AND id_barang = ? AND jenis = 'Masuk') AS ada;`,
          args: [baris.id_batch, baris.id_barang],
        });
        if (Number(ada.rows[0]?.ada) !== 1) {
          throw new Error(`Batch ${nama} tidak ditemukan.`);
        }
        idBatch = baris.id_batch;
      } else if (baris.id_batch !== null) {
        // Cermin `record_opname`: barang per unit, tiap unit batch-nya sendiri.
        const milik = await tx.execute({
          sql: "SELECT EXISTS(SELECT 1 FROM inventory_unit WHERE id_unit = ? AND id_barang = ?) AS ada;",
          args: [baris.id_batch, baris.id_barang],
        });
        if (Number(milik.rows[0]?.ada) !== 1) {
          throw new Error(`Unit ${nama} tidak ditemukan.`);
        }
        if (baris.fisik > 1) {
          throw new Error(`Satu unit ${nama} hanya bisa dihitung 0 atau 1.`);
        }
        idBatch = baris.id_batch;
      }

      const sistem = await saldoPosisi(
        tx,
        baris.id_barang,
        tempat,
        kondisi,
        idBatch,
      );
      const selisih = baris.fisik - sistem;
      if (selisih === 0) continue;
      const masuk = selisih > 0;
      const mutasi: MutasiValid = {
        jenis: masuk ? "Masuk" : "Keluar",
        alasan: "Selisih Opname",
        tanggal: hariIni,
        jumlah: Math.abs(selisih),
        tempat_asal: masuk ? null : tempat,
        kondisi_asal: masuk ? null : kondisi,
        tempat_tujuan: masuk ? tempat : null,
        kondisi_tujuan: masuk ? kondisi : null,
        id_batch: idBatch,
        tanggal_expired: null,
        id_ref: null,
        penerima_tipe: null,
        penerima_id: null,
        penerima_nama: null,
        keperluan: null,
        sumber_dana: null,
        nomor_dokumen: nomor,
        harga_satuan: null,
        catatan: valid.catatan,
      };
      await tx.execute(
        insertMutasiStatement(
          newHexId("mts-"),
          baris.id_barang,
          mutasi,
          null,
          dicatatOleh,
        ),
      );
      jumlahSelisih += 1;
    }
    return {
      sukses: true as const,
      nomor_dokumen: nomor,
      jumlah_selisih: jumlahSelisih,
    };
  });
}

/** Cermin `kop_perusahaan`: hanya kolom tampilan, dengan izin inventaris. */
export async function kopPerusahaan(client: Client): Promise<KopPerusahaan> {
  const result = await client.execute(
    `SELECT company_name, branch_name, logo_url, address, phone, email, website,
            leader_name, leader_title, leader_nip
     FROM company_profile ORDER BY id = 'default_company' DESC LIMIT 1;`,
  );
  const row = result.rows[0];
  if (!row) return {};
  return {
    nama: text(row.company_name),
    cabang: text(row.branch_name),
    logo_url: text(row.logo_url),
    alamat: text(row.address),
    telepon: text(row.phone),
    email: text(row.email),
    website: text(row.website),
    kepala_nama: text(row.leader_name),
    kepala_jabatan: text(row.leader_title),
    kepala_nip: text(row.leader_nip),
  };
}

/** Cermin `document`. */
export async function documentInventaris(
  client: Client,
  idMutasi: string,
): Promise<DokumenInventaris> {
  const id = idMutasi.trim();
  const asal = await client.execute({
    sql: "SELECT alasan, nomor_dokumen FROM inventory_mutasi WHERE id_mutasi = ?;",
    args: [id],
  });
  const row = asal.rows[0];
  if (!row) throw new Error("Mutasi tidak ditemukan.");
  const jenis = jenisBeritaAcara(String(row.alasan));
  if (jenis === null) throw new Error("Mutasi ini tidak punya berita acara.");
  const batal = await client.execute({
    sql: "SELECT EXISTS(SELECT 1 FROM inventory_mutasi WHERE id_mutasi = ?) AS ada;",
    args: [idPembatalan(id)],
  });
  if (Number(batal.rows[0]?.ada) === 1) {
    throw new Error(
      "Mutasi ini sudah dibatalkan, berita acaranya tidak bisa dicetak.",
    );
  }
  const nomor = text(row.nomor_dokumen)?.trim() || null;
  const result = await client.execute({
    sql: `SELECT m.id_mutasi, m.tanggal, m.alasan, m.jumlah, m.tempat_asal, m.kondisi_asal,
                 m.tempat_tujuan, m.kondisi_tujuan, bm.tanggal_expired, m.penerima_nama,
                 m.keperluan, m.catatan, m.dicatat_oleh, b.nama_barang, b.kode_barang, b.satuan,
                 b.desimal
          FROM inventory_mutasi m
          JOIN inventory_barang b ON b.id_barang = m.id_barang
          LEFT JOIN inventory_mutasi bm ON bm.id_mutasi = m.id_batch
          WHERE (m.nomor_dokumen = ?1 OR (?1 IS NULL AND m.id_mutasi = ?2))
            AND NOT EXISTS (SELECT 1 FROM inventory_mutasi x WHERE x.id_mutasi = 'batal-' || m.id_mutasi)
          ORDER BY m.created_at, m.id_mutasi
          LIMIT 501;`,
    args: [nomor, id],
  });
  const baris: BarisDokumen[] = [];
  let terpotong = false;
  for (const item of result.rows) {
    if (jenisBeritaAcara(String(item.alasan)) !== jenis) continue;
    if (baris.length === MAKS_BARIS_DOKUMEN) {
      terpotong = true;
      break;
    }
    baris.push({
      id_mutasi: String(item.id_mutasi),
      tanggal: String(item.tanggal),
      alasan: String(item.alasan),
      jumlah: Number(item.jumlah),
      tempat_asal: text(item.tempat_asal),
      kondisi_asal: text(item.kondisi_asal),
      tempat_tujuan: text(item.tempat_tujuan),
      kondisi_tujuan: text(item.kondisi_tujuan),
      tanggal_expired: text(item.tanggal_expired),
      penerima_nama: text(item.penerima_nama),
      keperluan: text(item.keperluan),
      catatan: text(item.catatan),
      dicatat_oleh: String(item.dicatat_oleh),
      nama_barang: String(item.nama_barang),
      kode_barang: String(item.kode_barang),
      satuan: String(item.satuan),
      desimal: Number(item.desimal) === 1,
    });
  }
  return {
    jenis,
    nomor_dokumen: nomor,
    tanggal: baris[0]?.tanggal ?? null,
    dicatat_oleh: baris[0]?.dicatat_oleh ?? null,
    penerima_nama: baris.find((b) => b.penerima_nama)?.penerima_nama ?? null,
    kop: await kopPerusahaan(client),
    baris,
    terpotong,
  };
}

/** Cermin `opname_history`. */
export async function opnameHistory(
  client: Client,
): Promise<{ riwayat: RiwayatOpname[] }> {
  const result = await client.execute(
    `SELECT m.nomor_dokumen, MIN(m.tanggal) AS tanggal,
            MIN(COALESCE(m.tempat_asal, m.tempat_tujuan)) AS tempat,
            COUNT(*) AS jumlah_selisih, MIN(m.dicatat_oleh) AS dicatat_oleh,
            MIN(m.id_mutasi) AS id_mutasi, MAX(m.created_at) AS dibuat
     FROM inventory_mutasi m
     WHERE m.alasan = 'Selisih Opname' AND m.nomor_dokumen IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM inventory_mutasi x WHERE x.id_mutasi = 'batal-' || m.id_mutasi)
     GROUP BY m.nomor_dokumen
     ORDER BY dibuat DESC
     LIMIT 50;`,
  );
  return {
    riwayat: result.rows.map((row) => ({
      nomor_dokumen: String(row.nomor_dokumen),
      tanggal: String(row.tanggal),
      tempat: text(row.tempat),
      jumlah_selisih: Number(row.jumlah_selisih),
      dicatat_oleh: String(row.dicatat_oleh),
      id_mutasi: String(row.id_mutasi),
    })),
  };
}

/** Cermin `procurement`. */
export async function procurement(
  client: Client,
  dari: string,
  sampai: string,
): Promise<RekapPengadaan> {
  if (!isValidDate(dari) || !isValidDate(sampai)) {
    throw new Error("Rentang tanggal tidak valid.");
  }
  if (dari > sampai) {
    throw new Error("Tanggal awal tidak boleh setelah tanggal akhir.");
  }
  const result = await client.execute({
    sql: `SELECT m.tanggal, b.kode_barang, b.nama_barang, b.satuan, m.alasan, m.jumlah,
                 m.harga_satuan, COALESCE(m.sumber_dana, '') AS sumber_dana, m.nomor_dokumen,
                 m.tempat_tujuan, ${NILAI_MUTASI_SQL} AS nilai, b.desimal, j.nomor AS nomor_jurnal
          FROM inventory_mutasi m
          JOIN inventory_barang b ON b.id_barang = m.id_barang
          LEFT JOIN keu_jurnal j ON j.id_jurnal = 'jrn-inv-' || m.id_mutasi
          WHERE m.jenis = 'Masuk' AND m.alasan IN ('Pengadaan', 'Hibah', 'Saldo Awal')
            AND m.tanggal >= ? AND m.tanggal <= ?
            AND NOT EXISTS (SELECT 1 FROM inventory_mutasi x WHERE x.id_mutasi = 'batal-' || m.id_mutasi)
          ORDER BY sumber_dana COLLATE NOCASE, m.tanggal, m.created_at
          LIMIT 5001;`,
    args: [dari, sampai],
  });
  const semua: BarisPengadaan[] = result.rows.map((row) => ({
    tanggal: String(row.tanggal),
    kode_barang: String(row.kode_barang),
    nama_barang: String(row.nama_barang),
    satuan: String(row.satuan),
    alasan: String(row.alasan),
    jumlah: Number(row.jumlah),
    harga_satuan: row.harga_satuan === null ? null : Number(row.harga_satuan),
    sumber_dana: String(row.sumber_dana),
    nomor_dokumen: text(row.nomor_dokumen),
    tempat_tujuan: text(row.tempat_tujuan),
    nilai: Number(row.nilai),
    desimal: Number(row.desimal) === 1,
    nomor_jurnal: text(row.nomor_jurnal),
  }));
  const baris = semua.slice(0, MAKS_BARIS_PENGADAAN);
  const rekap = rekapSumberDana(
    baris.map((b) => ({
      sumber_dana: b.sumber_dana,
      nilai: b.nilai,
      tanpa_harga: b.harga_satuan === null,
    })),
  );
  return {
    baris,
    rekap,
    total_nilai: rekap.reduce((sum, item) => sum + item.nilai, 0),
    terpotong: semua.length > MAKS_BARIS_PENGADAAN,
  };
}

/** Cermin `SYARAT_JURNAL_INVENTARIS_SQL` di `inventory.rs`. */
const SYARAT_JURNAL_INVENTARIS_SQL = `m.jenis = 'Masuk' AND m.alasan IN ('Pengadaan', 'Hibah')
        AND m.harga_satuan IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM inventory_mutasi x WHERE x.id_mutasi = 'batal-' || m.id_mutasi)
        AND NOT EXISTS (SELECT 1 FROM keu_jurnal j WHERE j.id_jurnal = 'jrn-inv-' || m.id_mutasi)`;

/** Cermin `JURNAL_INVENTARIS_YATIM_SQL`. */
const JURNAL_INVENTARIS_YATIM_SQL = `SELECT j.id_jurnal, j.nomor, j.tanggal, j.keterangan, j.id_sumber
    FROM keu_jurnal j
    WHERE j.sumber = 'Inventaris' AND j.id_sumber IS NOT NULL
      AND j.id_jurnal = 'jrn-inv-' || j.id_sumber
      AND EXISTS (SELECT 1 FROM inventory_mutasi x WHERE x.id_mutasi = 'batal-' || j.id_sumber)
      AND NOT EXISTS (SELECT 1 FROM keu_jurnal p WHERE p.id_jurnal = 'batal-' || j.id_jurnal)
    ORDER BY j.tanggal, j.id_jurnal
    LIMIT 200;`;

const KOLOM_BARIS_JURNAL = `m.id_mutasi, m.tanggal, m.alasan, b.tipe, b.nama_barang, b.satuan,
    b.desimal, m.jumlah`;

/** Cermin `journal_pending`. */
export async function journalPending(
  client: Client,
  dari: string,
  sampai: string,
): Promise<DaftarJurnalInventaris> {
  if (!isValidDate(dari) || !isValidDate(sampai) || dari > sampai) {
    throw new Error("Rentang tanggal tidak valid.");
  }
  const batas = await batasTutup(client);
  const result = await client.execute({
    sql: `SELECT ${KOLOM_BARIS_JURNAL}, ${NILAI_MUTASI_SQL} AS nilai, m.nomor_dokumen,
                 b.kode_barang, COALESCE(m.sumber_dana, '') AS sumber_dana, m.harga_satuan,
                 (SELECT r.id_pengajuan FROM inventory_pengajuan_baris r WHERE r.id_baris = m.id_ref) AS id_pengajuan
          FROM inventory_mutasi m
          JOIN inventory_barang b ON b.id_barang = m.id_barang
          WHERE ${SYARAT_JURNAL_INVENTARIS_SQL}
            AND ${NILAI_MUTASI_SQL} > 0
            AND m.tanggal >= ? AND m.tanggal <= ?
          ORDER BY m.tanggal, m.created_at, m.id_mutasi
          LIMIT 501;`,
    args: [dari, sampai],
  });
  const semua: BarisBelumDijurnal[] = result.rows.map((row) => ({
    id_mutasi: String(row.id_mutasi),
    tanggal: String(row.tanggal),
    alasan: String(row.alasan) as BarisBelumDijurnal["alasan"],
    tipe: String(row.tipe) as TipeBarang,
    kode_barang: String(row.kode_barang),
    nama_barang: String(row.nama_barang),
    satuan: String(row.satuan),
    desimal: Number(row.desimal) === 1,
    jumlah: Number(row.jumlah),
    harga_satuan: Number(row.harga_satuan),
    nilai: Number(row.nilai),
    sumber_dana: String(row.sumber_dana),
    nomor_dokumen: text(row.nomor_dokumen),
    id_pengajuan: text(row.id_pengajuan),
    periode_tertutup: batas !== null && String(row.tanggal) <= batas,
  }));
  const yatim = await client.execute(JURNAL_INVENTARIS_YATIM_SQL);
  const servis = await client.execute({
    sql: `SELECT s.id_servis, s.tanggal_selesai, b.kode_barang, b.nama_barang, u.kode_unit,
                 s.penyedia, s.biaya
          FROM inventory_servis s
          JOIN inventory_barang b ON b.id_barang = s.id_barang
          LEFT JOIN inventory_unit u ON u.id_unit = s.id_unit
          WHERE ${SYARAT_JURNAL_SERVIS_SQL}
            AND s.tanggal_selesai >= ? AND s.tanggal_selesai <= ?
          ORDER BY s.tanggal_selesai, s.id_servis
          LIMIT ${MAKS_DAFTAR_JURNAL_INVENTARIS};`,
    args: [dari, sampai],
  });
  return {
    baris: semua.slice(0, MAKS_DAFTAR_JURNAL_INVENTARIS),
    terpotong: semua.length > MAKS_DAFTAR_JURNAL_INVENTARIS,
    perlu_dibalik: yatim.rows.map((row) => ({
      id_jurnal: String(row.id_jurnal),
      nomor: String(row.nomor),
      tanggal: String(row.tanggal),
      keterangan: String(row.keterangan),
      id_mutasi: String(row.id_sumber),
    })),
    servis: servis.rows.map((row) => ({
      id_servis: String(row.id_servis),
      tanggal: String(row.tanggal_selesai),
      kode_barang: String(row.kode_barang),
      nama_barang: String(row.nama_barang),
      kode_unit: text(row.kode_unit),
      penyedia: text(row.penyedia),
      nilai: Number(row.biaya),
      periode_tertutup: batas !== null && String(row.tanggal_selesai) <= batas,
    })),
    batas_tutup: batas,
  };
}

/** Cermin `SYARAT_JURNAL_SERVIS_SQL`. */
const SYARAT_JURNAL_SERVIS_SQL = `s.tanggal_selesai IS NOT NULL AND s.dibatalkan_pada IS NULL
        AND s.biaya > 0
        AND NOT EXISTS (SELECT 1 FROM keu_jurnal j WHERE j.id_jurnal = 'jrn-' || s.id_servis)`;

/** Cermin `assert_akun_kelompok` di `inventory.rs`. */
async function assertAkunKelompok(
  tx: Executor,
  idAkun: string,
  kelompok: readonly string[],
) {
  const result = await tx.execute({
    sql: "SELECT kelompok FROM keu_akun WHERE id_akun = ? AND is_aktif = 1;",
    args: [idAkun],
  });
  const nilai = text(result.rows[0]?.kelompok);
  if (nilai === null || !kelompok.includes(nilai)) {
    throw new Error(
      `Akun yang dipilih harus akun ${kelompok.join(" atau ")} yang aktif.`,
    );
  }
}

function unikTerisi(daftar: readonly string[]): string[] {
  const hasil: string[] = [];
  for (const id of daftar.map((item) => item.trim())) {
    if (id && !hasil.includes(id)) hasil.push(id);
  }
  return hasil;
}

/**
 * Cermin `journal_post`: satu jurnal per baris dan pembalikan jurnal yatim,
 * semuanya dalam SATU transaksi. Nilai dihitung ulang dari mutasi.
 */
export async function journalPost(
  client: Client,
  operator: string,
  raw: unknown,
): Promise<{ sukses: true; dijurnal: number; dibalik: number }> {
  const parsed = jurnalInventarisDraftSchema.safeParse(raw);
  if (!parsed.success) throw new Error("Data jurnal inventaris tidak valid.");
  const draft = parsed.data;
  const idMutasi = unikTerisi(draft.id_mutasi);
  const balik = unikTerisi(draft.balik);
  const idServis = unikTerisi(draft.id_servis);
  if (idMutasi.length === 0 && balik.length === 0 && idServis.length === 0) {
    throw new Error("Pilih minimal satu baris.");
  }
  if (
    idMutasi.length + balik.length + idServis.length >
    MAKS_JURNAL_INVENTARIS
  ) {
    throw new Error(
      `Paling banyak ${MAKS_JURNAL_INVENTARIS} baris sekali catat.`,
    );
  }

  return withTransaction(client, async (tx) => {
    for (const id of idMutasi) {
      const result = await tx.execute({
        sql: `SELECT ${KOLOM_BARIS_JURNAL}, ${NILAI_MUTASI_SQL} AS nilai, m.nomor_dokumen
              FROM inventory_mutasi m
              JOIN inventory_barang b ON b.id_barang = m.id_barang
              WHERE m.id_mutasi = ? AND ${SYARAT_JURNAL_INVENTARIS_SQL};`,
        args: [id],
      });
      const row = result.rows[0];
      if (!row || Number(row.nilai) <= 0) {
        throw new Error(
          "Ada baris yang sudah dijurnal, dibatalkan, atau tidak bisa dijurnal. Muat ulang daftarnya.",
        );
      }
      const alasan = String(row.alasan);
      const pasangan = pasanganAkunJurnalInventaris(
        String(row.tipe),
        alasan,
        draft,
      );
      if (!pasangan.ok) throw new Error(pasangan.error);
      const { debit, kredit } = pasangan.value;
      await assertAkunKelompok(
        tx,
        debit,
        KELOMPOK_AKUN_JURNAL_INVENTARIS.akun_debit_aset,
      );
      await assertAkunKelompok(
        tx,
        kredit,
        alasan === "Hibah"
          ? KELOMPOK_AKUN_JURNAL_INVENTARIS.akun_kredit_hibah
          : KELOMPOK_AKUN_JURNAL_INVENTARIS.akun_kredit_bayar,
      );
      const idJurnal = idJurnalInventaris(String(row.id_mutasi));
      const nilai = Number(row.nilai);
      await tulisJurnalTx(
        tx,
        {
          id_jurnal: idJurnal,
          tanggal: String(row.tanggal),
          keterangan: keteranganJurnalInventaris(
            alasan,
            String(row.nama_barang),
            Number(row.jumlah),
            Number(row.desimal) === 1,
            String(row.satuan),
            text(row.nomor_dokumen),
          ),
          sumber: "Inventaris",
          id_sumber: String(row.id_mutasi),
          id_jurnal_batal: null,
          dibuat_oleh: operator,
        },
        [
          {
            id_baris: `${idJurnal}-1`,
            id_akun: debit,
            debit: nilai,
            kredit: 0,
            keterangan: null,
            urutan: 1,
          },
          {
            id_baris: `${idJurnal}-2`,
            id_akun: kredit,
            debit: 0,
            kredit: nilai,
            keterangan: null,
            urutan: 2,
          },
        ],
      );
    }

    for (const id of balik) {
      const result = await tx.execute({
        sql: `SELECT EXISTS(
                SELECT 1 FROM keu_jurnal j
                WHERE j.id_jurnal = ? AND j.sumber = 'Inventaris' AND j.id_sumber IS NOT NULL
                  AND EXISTS (SELECT 1 FROM inventory_mutasi x WHERE x.id_mutasi = 'batal-' || j.id_sumber)
                  AND NOT EXISTS (SELECT 1 FROM keu_jurnal p WHERE p.id_jurnal = 'batal-' || j.id_jurnal)) AS yatim;`,
        args: [id],
      });
      if (Number(result.rows[0]?.yatim) !== 1) {
        throw new Error(
          "Ada jurnal yang sudah dibalik atau mutasinya belum dibatalkan. Muat ulang daftarnya.",
        );
      }
      await balikJurnalTx(tx, id, KETERANGAN_BALIK_INVENTARIS, operator);
    }

    for (const id of idServis) {
      const result = await tx.execute({
        sql: `SELECT s.tanggal_selesai, b.nama_barang, u.kode_unit, s.penyedia, s.biaya
              FROM inventory_servis s
              JOIN inventory_barang b ON b.id_barang = s.id_barang
              LEFT JOIN inventory_unit u ON u.id_unit = s.id_unit
              WHERE s.id_servis = ? AND ${SYARAT_JURNAL_SERVIS_SQL};`,
        args: [id],
      });
      const row = result.rows[0];
      if (!row) {
        throw new Error(
          "Ada servis yang sudah dijurnal atau tidak bisa dijurnal. Muat ulang daftarnya.",
        );
      }
      const pasangan = pasanganAkunJurnalServis(draft);
      if (!pasangan.ok) throw new Error(pasangan.error);
      const { debit, kredit } = pasangan.value;
      await assertAkunKelompok(
        tx,
        debit,
        KELOMPOK_AKUN_JURNAL_INVENTARIS.akun_debit_servis,
      );
      await assertAkunKelompok(
        tx,
        kredit,
        KELOMPOK_AKUN_JURNAL_INVENTARIS.akun_kredit_bayar,
      );
      const idJurnal = idJurnalServis(id);
      const biaya = Number(row.biaya);
      await tulisJurnalTx(
        tx,
        {
          id_jurnal: idJurnal,
          tanggal: String(row.tanggal_selesai),
          keterangan: keteranganJurnalServis(
            String(row.nama_barang),
            text(row.kode_unit),
            text(row.penyedia),
          ),
          sumber: "Inventaris",
          id_sumber: id,
          id_jurnal_batal: null,
          dibuat_oleh: operator,
        },
        [
          {
            id_baris: `${idJurnal}-1`,
            id_akun: debit,
            debit: biaya,
            kredit: 0,
            keterangan: null,
            urutan: 1,
          },
          {
            id_baris: `${idJurnal}-2`,
            id_akun: kredit,
            debit: 0,
            kredit: biaya,
            keterangan: null,
            urutan: 2,
          },
        ],
      );
    }
    return {
      sukses: true as const,
      dijurnal: idMutasi.length + idServis.length,
      dibalik: balik.length,
    };
  });
}

// Servis aset (v29)

/** Cermin `KOLOM_SERVIS_SQL` di `inventory.rs`. */
const KOLOM_SERVIS_SQL = `s.id_servis, s.id_barang, b.kode_barang, b.nama_barang, s.id_unit, u.kode_unit,
    s.jumlah, s.tempat, s.kondisi_awal, s.tanggal_mulai, s.penyedia, s.keluhan, s.tanggal_selesai,
    s.hasil, s.biaya, s.catatan_selesai, s.dibatalkan_pada, s.alasan_batal, s.dibuka_oleh, s.ditutup_oleh,
    CAST(julianday(COALESCE(s.tanggal_selesai, date('now', '+7 hours'))) - julianday(s.tanggal_mulai) AS INTEGER) AS lama_hari
    FROM inventory_servis s
    JOIN inventory_barang b ON b.id_barang = s.id_barang
    LEFT JOIN inventory_unit u ON u.id_unit = s.id_unit`;

function bacaServis(row: Record<string, unknown>): ServisInventaris {
  const tanggalSelesai = text(row.tanggal_selesai);
  const dibatalkanPada = text(row.dibatalkan_pada);
  return {
    id_servis: String(row.id_servis),
    id_barang: String(row.id_barang),
    kode_barang: String(row.kode_barang),
    nama_barang: String(row.nama_barang),
    id_unit: text(row.id_unit),
    kode_unit: text(row.kode_unit),
    jumlah: Number(row.jumlah),
    tempat: String(row.tempat),
    kondisi_awal: String(row.kondisi_awal) as KondisiBarang,
    tanggal_mulai: String(row.tanggal_mulai),
    penyedia: text(row.penyedia),
    keluhan: String(row.keluhan),
    status: statusServis(tanggalSelesai, dibatalkanPada),
    tanggal_selesai: tanggalSelesai,
    hasil: text(row.hasil) as HasilServis | null,
    biaya:
      row.biaya === null || row.biaya === undefined ? null : Number(row.biaya),
    catatan_selesai: text(row.catatan_selesai),
    dibatalkan_pada: dibatalkanPada,
    alasan_batal: text(row.alasan_batal),
    dibuka_oleh: String(row.dibuka_oleh),
    ditutup_oleh: text(row.ditutup_oleh),
    lama_hari: Number(row.lama_hari),
  };
}

/** Cermin `list_servis_terbuka`. */
async function listServisTerbuka(
  client: Executor,
): Promise<ServisInventaris[]> {
  const result = await client.execute(
    `SELECT ${KOLOM_SERVIS_SQL}
     WHERE s.tanggal_selesai IS NULL AND s.dibatalkan_pada IS NULL
     ORDER BY s.tanggal_mulai, s.id_servis
     LIMIT ${MAKS_SERVIS_TERBUKA};`,
  );
  return result.rows.map((row) => bacaServis(row as Record<string, unknown>));
}

/** Cermin `service_history`. */
export async function serviceHistory(
  client: Client,
  dari: string,
  sampai: string,
  idBarang: string | null,
): Promise<RiwayatServis> {
  if (!isValidDate(dari) || !isValidDate(sampai) || dari > sampai) {
    throw new Error("Rentang tanggal tidak valid.");
  }
  const barang = idBarang?.trim() || null;
  const result = await client.execute({
    sql: `SELECT ${KOLOM_SERVIS_SQL}
          WHERE s.tanggal_mulai >= ? AND s.tanggal_mulai <= ?
            AND (? IS NULL OR s.id_barang = ?)
          ORDER BY s.tanggal_mulai DESC, s.id_servis DESC
          LIMIT 1001;`,
    args: [dari, sampai, barang, barang],
  });
  const semua = result.rows.map((row) =>
    bacaServis(row as Record<string, unknown>),
  );
  return {
    baris: semua.slice(0, MAKS_RIWAYAT_SERVIS),
    terpotong: semua.length > MAKS_RIWAYAT_SERVIS,
  };
}

/** Cermin `servis_terbuka`. */
async function servisTerbuka(tx: Executor, idServis: string) {
  const result = await tx.execute({
    sql: `SELECT id_barang, id_unit, jumlah, tempat, kondisi_awal, tanggal_mulai
          FROM inventory_servis
          WHERE id_servis = ? AND tanggal_selesai IS NULL AND dibatalkan_pada IS NULL;`,
    args: [idServis],
  });
  const row = result.rows[0];
  if (!row) {
    throw new Error(
      "Servis ini sudah ditutup, dibatalkan, atau tidak ditemukan.",
    );
  }
  return {
    id_barang: String(row.id_barang),
    id_unit: text(row.id_unit),
    jumlah: Number(row.jumlah),
    tempat: String(row.tempat),
    kondisi_awal: String(row.kondisi_awal),
    tanggal_mulai: String(row.tanggal_mulai),
  };
}

/** Cermin `save_service`: buka servis, atau ubah isian servis yang masih terbuka. */
export async function saveService(
  client: Client,
  operator: string,
  raw: unknown,
): Promise<{ sukses: true; id_servis: string }> {
  const parsed = servisDraftSchema.safeParse(raw);
  if (!parsed.success) throw new Error("Data servis tidak valid.");
  const draft = parsed.data;
  return withTransaction(client, async (tx) => {
    const hariIni = await wibToday(tx);
    const isian = validateIsianServis(
      draft.tanggal_mulai,
      draft.penyedia,
      draft.keluhan,
      hariIni,
    );
    if (!isian.ok) throw new Error(isian.error);
    const { tanggal_mulai, penyedia, keluhan } = isian.value;

    const idUbah = draft.id_servis?.trim();
    if (idUbah) {
      await servisTerbuka(tx, idUbah);
      await tx.execute({
        sql: `UPDATE inventory_servis SET tanggal_mulai = ?, penyedia = ?, keluhan = ?,
                     updated_at = datetime('now')
              WHERE id_servis = ?;`,
        args: [tanggal_mulai, penyedia, keluhan, idUbah],
      });
      return { sukses: true as const, id_servis: idUbah };
    }

    const idBarang = draft.id_barang.trim();
    const barang = await tx.execute({
      sql: "SELECT tipe, satuan, status_aktif FROM inventory_barang WHERE id_barang = ?;",
      args: [idBarang],
    });
    const info = barang.rows[0];
    if (!info) throw new Error("Barang tidak ditemukan.");
    if (String(info.tipe) !== "Aset") {
      throw new Error("Hanya barang Aset yang bisa diservis.");
    }
    if (Number(info.status_aktif) !== 1) {
      throw new Error("Barang sudah dinonaktifkan.");
    }
    const unitAda = await tx.execute({
      sql: "SELECT EXISTS(SELECT 1 FROM inventory_unit WHERE id_barang = ?) AS ada;",
      args: [idBarang],
    });
    const dilacak = Number(unitAda.rows[0]?.ada) === 1;
    const idUnit = draft.id_unit?.trim() || null;

    let jumlah: number;
    let tempat: string;
    let kondisiAwal: string;
    if (dilacak) {
      if (!idUnit) throw new Error("Pilih unit yang diservis.");
      const posisi = await tx.execute({
        sql: `SELECT tempat, kondisi FROM inventory_saldo
              WHERE id_barang = ? AND id_batch = ? AND saldo > 0 LIMIT 1;`,
        args: [idBarang, idUnit],
      });
      const baris = posisi.rows[0];
      if (!baris) {
        throw new Error(
          "Unit ini tidak punya stok (sudah keluar, hilang, atau afkir).",
        );
      }
      const sedang = await tx.execute({
        sql: `SELECT EXISTS(SELECT 1 FROM inventory_servis
                WHERE id_unit = ? AND tanggal_selesai IS NULL AND dibatalkan_pada IS NULL) AS ada;`,
        args: [idUnit],
      });
      if (Number(sedang.rows[0]?.ada) === 1) {
        throw new Error("Unit ini masih dalam servis.");
      }
      jumlah = 1;
      tempat = String(baris.tempat);
      kondisiAwal = String(baris.kondisi);
    } else {
      if (idUnit) throw new Error("Barang ini tidak dicatat per unit.");
      jumlah = draft.jumlah ?? 0;
      if (jumlah < 1 || jumlah > MAKS_JUMLAH) {
        throw new Error("Jumlah yang diservis tidak valid.");
      }
      const normal = normalizeTempat(draft.tempat ?? "");
      if (!normal) throw new Error("Tempat barang wajib diisi.");
      tempat = (await canonicalTempat(tx, normal)) ?? normal;
      kondisiAwal = (draft.kondisi_awal ?? "").trim();
      if (!(KONDISI_BARANG as readonly string[]).includes(kondisiAwal)) {
        throw new Error("Kondisi barang tidak dikenal.");
      }
      const saldo = await saldoPosisi(tx, idBarang, tempat, kondisiAwal, null);
      const sedang = await tx.execute({
        sql: `SELECT COALESCE(SUM(jumlah), 0) AS n FROM inventory_servis
              WHERE id_barang = ? AND id_unit IS NULL AND LOWER(tempat) = LOWER(?)
                AND kondisi_awal = ? AND tanggal_selesai IS NULL AND dibatalkan_pada IS NULL;`,
        args: [idBarang, tempat, kondisiAwal],
      });
      const tersedia = saldo - Number(sedang.rows[0]?.n ?? 0);
      if (jumlah > tersedia) {
        throw new Error(
          `Stok ${kondisiAwal} di ${tempat} yang belum diservis tinggal ${Math.max(tersedia, 0)} ${String(info.satuan)}.`,
        );
      }
    }

    const id = newHexId("srv-");
    await tx.execute({
      sql: `INSERT INTO inventory_servis (
              id_servis, id_barang, id_unit, jumlah, tempat, kondisi_awal, tanggal_mulai,
              penyedia, keluhan, dibuka_oleh, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'));`,
      args: [
        id,
        idBarang,
        idUnit,
        jumlah,
        tempat,
        kondisiAwal,
        tanggal_mulai,
        penyedia,
        keluhan,
        operator,
      ],
    });
    return { sukses: true as const, id_servis: id };
  });
}

/** Cermin `close_service`. */
export async function closeService(
  client: Client,
  operator: string,
  raw: unknown,
): Promise<{ sukses: true; id_servis: string }> {
  const parsed = tutupServisDraftSchema.safeParse(raw);
  if (!parsed.success) throw new Error("Data penutupan servis tidak valid.");
  const idServis = parsed.data.id_servis.trim();
  return withTransaction(client, async (tx) => {
    const servis = await servisTerbuka(tx, idServis);
    const hariIni = await wibToday(tx);
    const valid = validateTutupServis(
      parsed.data,
      servis.tanggal_mulai,
      hariIni,
    );
    if (!valid.ok) throw new Error(valid.error);
    const { tanggal_selesai, hasil, biaya, catatan_selesai } = valid.value;

    const kondisiBaru = kondisiHasilServis(servis.kondisi_awal, hasil);
    if (kondisiBaru) {
      const saldo = await saldoPosisi(
        tx,
        servis.id_barang,
        servis.tempat,
        servis.kondisi_awal,
        servis.id_unit,
      );
      if (saldo < servis.jumlah) {
        throw new Error(
          `Stok ${servis.kondisi_awal} di ${servis.tempat} tinggal ${Math.max(saldo, 0)}, tidak cukup untuk mencatat kondisinya. Barang sudah dipindah sejak dibawa servis? Catat pemindahannya kembali dulu.`,
        );
      }
      const mutasi: MutasiValid = {
        jenis: "Pindah",
        alasan: "Perubahan Kondisi",
        tanggal: tanggal_selesai,
        jumlah: servis.jumlah,
        tempat_asal: servis.tempat,
        kondisi_asal: servis.kondisi_awal as KondisiBarang,
        tempat_tujuan: servis.tempat,
        kondisi_tujuan: kondisiBaru,
        id_batch: servis.id_unit,
        tanggal_expired: null,
        id_ref: idServis,
        penerima_tipe: null,
        penerima_id: null,
        penerima_nama: null,
        keperluan: null,
        sumber_dana: null,
        nomor_dokumen: null,
        harga_satuan: null,
        catatan: `Hasil servis: ${hasil}`,
      };
      await tx.execute(
        insertMutasiStatement(
          idMutasiKondisiServis(idServis),
          servis.id_barang,
          mutasi,
          idServis,
          operator,
        ),
      );
    }

    await tx.execute({
      sql: `UPDATE inventory_servis SET tanggal_selesai = ?, hasil = ?, biaya = ?,
                   catatan_selesai = ?, ditutup_oleh = ?, updated_at = datetime('now')
            WHERE id_servis = ?;`,
      args: [
        tanggal_selesai,
        hasil,
        biaya,
        catatan_selesai,
        operator,
        idServis,
      ],
    });
    return { sukses: true as const, id_servis: idServis };
  });
}

/** Cermin `cancel_service`. */
export async function cancelService(
  client: Client,
  operator: string,
  idServis: string,
  alasan: string,
): Promise<{ sukses: true }> {
  const valid = validateAlasanBatalServis(alasan);
  if (!valid.ok) throw new Error(valid.error);
  const id = idServis.trim();
  return withTransaction(client, async (tx) => {
    await servisTerbuka(tx, id);
    await tx.execute({
      sql: `UPDATE inventory_servis SET dibatalkan_pada = datetime('now', '+7 hours'),
                   alasan_batal = ?, ditutup_oleh = ?, updated_at = datetime('now')
            WHERE id_servis = ?;`,
      args: [valid.value, operator, id],
    });
    return { sukses: true as const };
  });
}

/** Cermin `stock_card`. */
export async function stockCard(
  client: Client,
  idBarang: string,
  tempatFilter: string | null,
  dari: string,
  sampai: string,
): Promise<KartuStok> {
  if (!isValidDate(dari) || !isValidDate(sampai)) {
    throw new Error("Rentang tanggal tidak valid.");
  }
  if (dari > sampai) {
    throw new Error("Tanggal awal tidak boleh setelah tanggal akhir.");
  }
  const tempat = normalizeTempat(tempatFilter ?? "") || null;

  const awal = await client.execute({
    sql: `SELECT COALESCE(SUM(
            CASE WHEN tempat_tujuan IS NOT NULL AND (?2 IS NULL OR LOWER(tempat_tujuan) = LOWER(?2)) THEN jumlah ELSE 0 END
          - CASE WHEN tempat_asal IS NOT NULL AND (?2 IS NULL OR LOWER(tempat_asal) = LOWER(?2)) THEN jumlah ELSE 0 END
          ), 0) AS saldo
          FROM inventory_mutasi
          WHERE id_barang = ?1 AND tanggal < ?3
          -- batas: agregat, selalu satu baris
          ;`,
    args: [idBarang, tempat, dari],
  });
  const saldoAwal = Number(awal.rows[0]?.saldo ?? 0);

  const rows = await client.execute({
    sql: `SELECT * FROM (
            SELECT m.id_mutasi, m.tanggal, m.jenis, m.alasan, m.jumlah, m.tempat_asal,
                   m.kondisi_asal, m.tempat_tujuan, m.kondisi_tujuan, m.id_batch,
                   m.tanggal_expired, m.id_ref, m.penerima_tipe, m.penerima_nama, m.keperluan,
                   m.sumber_dana, m.nomor_dokumen, m.harga_satuan, m.catatan, m.dicatat_oleh,
                   m.created_at,
                   CASE WHEN m.tempat_tujuan IS NOT NULL AND (?2 IS NULL OR LOWER(m.tempat_tujuan) = LOWER(?2)) THEN m.jumlah ELSE 0 END AS masuk,
                   CASE WHEN m.tempat_asal IS NOT NULL AND (?2 IS NULL OR LOWER(m.tempat_asal) = LOWER(?2)) THEN m.jumlah ELSE 0 END AS keluar,
                   EXISTS(SELECT 1 FROM inventory_mutasi b WHERE b.id_mutasi = 'batal-' || m.id_mutasi) AS dibatalkan
            FROM inventory_mutasi m
            WHERE m.id_barang = ?1 AND m.tanggal >= ?3 AND m.tanggal <= ?4
          ) WHERE masuk > 0 OR keluar > 0
          ORDER BY tanggal, created_at, id_mutasi
          LIMIT 1001;`,
    args: [idBarang, tempat, dari, sampai],
  });

  let saldo = saldoAwal;
  const baris: KartuStok["baris"] = [];
  for (const row of rows.rows) {
    if (baris.length === MAKS_BARIS_KARTU_STOK) {
      return { saldo_awal: saldoAwal, baris, terpotong: true };
    }
    const masuk = Number(row.masuk);
    const keluar = Number(row.keluar);
    saldo += masuk - keluar;
    baris.push({
      id_mutasi: String(row.id_mutasi),
      tanggal: String(row.tanggal),
      jenis: String(row.jenis) as KartuStok["baris"][number]["jenis"],
      alasan: String(row.alasan),
      jumlah: Number(row.jumlah),
      tempat_asal: text(row.tempat_asal),
      kondisi_asal: text(row.kondisi_asal),
      tempat_tujuan: text(row.tempat_tujuan),
      kondisi_tujuan: text(row.kondisi_tujuan),
      id_batch: text(row.id_batch),
      tanggal_expired: text(row.tanggal_expired),
      id_ref: text(row.id_ref),
      penerima_tipe: text(row.penerima_tipe),
      penerima_nama: text(row.penerima_nama),
      keperluan: text(row.keperluan),
      sumber_dana: text(row.sumber_dana),
      nomor_dokumen: text(row.nomor_dokumen),
      harga_satuan: row.harga_satuan === null ? null : Number(row.harga_satuan),
      catatan: text(row.catatan),
      dicatat_oleh: String(row.dicatat_oleh),
      created_at: String(row.created_at),
      dibatalkan: Number(row.dibatalkan) === 1,
      masuk,
      keluar,
      saldo,
    });
  }
  return { saldo_awal: saldoAwal, baris, terpotong: false };
}
