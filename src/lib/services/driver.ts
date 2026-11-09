import "server-only";

import type { Client, Transaction } from "@libsql/client";
import { AuthorizationError } from "@/lib/auth/permission-assertion";
import {
  type Executor,
  newHexId,
  text,
  withTransaction,
} from "@/lib/services/inventory";
import { SERI_WEB } from "@/lib/validations/accounting";
import {
  AKURASI_PERINGATAN_M,
  type BarisBayar,
  batalBayarDraftSchema,
  bayarAktif,
  bayarUpahDraftSchema,
  daftarTarifDraftSchema,
  FOTO_SEGERA_DIHAPUS_SQL,
  type FotoSegeraDihapus,
  formatNomorSuratJalan,
  gantiMenunggu,
  HAPUS_FOTO_LAMA_SQL,
  idBarisBayar,
  idBatalBayar,
  idMuatan,
  kendaraanDraftSchema,
  type Laporan,
  type LaporanBaris,
  laporanDraftSchema,
  lokasiDraftSchema,
  MAKS_DAFTAR_BAYAR,
  MAKS_DAFTAR_PERJALANAN,
  MAKS_REKAP_UPAH,
  MAKS_SURAT_JALAN_PER_BAYAR,
  type MasterPerjalanan,
  type MuatanBaris,
  normalisasiPrefix,
  PESAN_SUDAH_DIBAYAR,
  type Pembayaran,
  type PembayaranUpahItem,
  type PerjalananItem,
  penerimaUpah,
  penugasan,
  periksaBatalBayar,
  periksaBayarUpah,
  periksaUrutan,
  perjalananDraftSchema,
  prefixTersimpan,
  type RincianPerjalanan,
  type SuratJalanUpah,
  statusPerjalanan,
  tandaTinjau,
  tandaUpah,
  upahSuratJalan,
  urutkan,
  validateBatalBayar,
  validateBayarUpah,
  validateDaftarTarif,
  validateKendaraan,
  validateKeputusan,
  validateLaporan,
  validateLokasi,
  validatePerjalanan,
} from "@/lib/validations/driver";
import { isValidDate } from "@/lib/validations/inventory";

/**
 * Cermin Web dari penulisan lokal `desktop/driver.rs`. Web menulis langsung ke
 * database cloud, jadi tidak ada outbox: trigger `sync_pulse` yang memberi tahu
 * perangkat. Pesan galat sama dengan Rust.
 *
 * Laporan dari Web hanya laporan dispatcher. Laporan driver (foto + GPS) hanya
 * dari aplikasi Mobile, yang menulis lewat outbox.
 */

function ditolakTarif(): AuthorizationError {
  return new AuthorizationError(
    "Mengubah tarif butuh izin tarif surat jalan.",
    403,
  );
}

async function ada(
  tx: Executor,
  sql: string,
  args: (string | number | null)[],
): Promise<boolean> {
  const result = await tx.execute({ sql, args });
  return result.rows.length > 0;
}

export interface DaftarTarif {
  tabel: "drv_jenis_kendaraan" | "drv_kategori_tujuan";
  kolomId: "id_jenis" | "id_kategori";
  awalanId: string;
  label: string;
  judul: string;
}

export const DAFTAR_JENIS_KENDARAAN: DaftarTarif = {
  tabel: "drv_jenis_kendaraan",
  kolomId: "id_jenis",
  awalanId: "jkd-",
  label: "jenis kendaraan",
  judul: "Jenis kendaraan",
};

export const DAFTAR_KATEGORI_TUJUAN: DaftarTarif = {
  tabel: "drv_kategori_tujuan",
  kolomId: "id_kategori",
  awalanId: "ktj-",
  label: "kategori tujuan",
  judul: "Kategori tujuan",
};

/** Cermin `simpan_daftar_tarif`. */
export async function simpanDaftarTarif(
  client: Client,
  daftar: DaftarTarif,
  bolehUbahTarif: boolean,
  raw: unknown,
): Promise<{ sukses: true; id: string }> {
  const parsed = daftarTarifDraftSchema.safeParse(raw);
  if (!parsed.success) throw new Error("Data tidak valid.");
  const valid = validateDaftarTarif(parsed.data, daftar.label);
  if (!valid.ok) throw new Error(valid.error);
  const { tabel, kolomId } = daftar;
  return withTransaction(client, async (tx) => {
    let id = parsed.data.id?.trim() || null;
    if (id) {
      const lama = await tx.execute({
        sql: `SELECT tarif FROM ${tabel} WHERE ${kolomId} = ?;`,
        args: [id],
      });
      if (lama.rows.length === 0) {
        throw new Error(`${daftar.judul} tidak ditemukan.`);
      }
      if (
        Number(lama.rows[0]?.tarif) !== valid.value.tarif &&
        !bolehUbahTarif
      ) {
        throw ditolakTarif();
      }
    } else {
      if (valid.value.tarif !== 0 && !bolehUbahTarif) {
        throw ditolakTarif();
      }
      id = newHexId(daftar.awalanId);
    }
    if (
      await ada(
        tx,
        `SELECT 1 FROM ${tabel} WHERE lower(trim(nama)) = lower(?) AND ${kolomId} <> ?;`,
        [valid.value.nama, id],
      )
    ) {
      throw new Error(`Nama ${daftar.label} sudah dipakai.`);
    }
    await tx.execute({
      sql: `INSERT INTO ${tabel} (${kolomId}, nama, tarif, status_aktif, created_at, updated_at)
            VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))
            ON CONFLICT(${kolomId}) DO UPDATE SET nama = excluded.nama,
              tarif = excluded.tarif, status_aktif = excluded.status_aktif,
              updated_at = datetime('now');`,
      args: [
        id,
        valid.value.nama,
        valid.value.tarif,
        valid.value.status_aktif ? 1 : 0,
      ],
    });
    return { sukses: true as const, id };
  });
}

/** Cermin `simpan_kendaraan`. */
export async function simpanKendaraan(
  client: Client,
  raw: unknown,
): Promise<{ sukses: true; id: string }> {
  const parsed = kendaraanDraftSchema.safeParse(raw);
  if (!parsed.success) throw new Error("Data kendaraan tidak valid.");
  const valid = validateKendaraan(parsed.data);
  if (!valid.ok) throw new Error(valid.error);
  const k = valid.value;
  return withTransaction(client, async (tx) => {
    let id = parsed.data.id_kendaraan?.trim() || null;
    if (id) {
      if (
        !(await ada(tx, "SELECT 1 FROM drv_kendaraan WHERE id_kendaraan = ?;", [
          id,
        ]))
      ) {
        throw new Error("Kendaraan tidak ditemukan.");
      }
    } else {
      id = newHexId("knd-");
    }
    if (
      !(await ada(
        tx,
        `SELECT 1 FROM drv_jenis_kendaraan WHERE id_jenis = ? AND (status_aktif = 1
           OR id_jenis = (SELECT id_jenis FROM drv_kendaraan WHERE id_kendaraan = ?));`,
        [k.id_jenis, id],
      ))
    ) {
      throw new Error("Jenis kendaraan tidak ditemukan atau nonaktif.");
    }
    if (
      await ada(
        tx,
        "SELECT 1 FROM drv_kendaraan WHERE identitas = ? AND id_kendaraan <> ?;",
        [k.identitas, id],
      )
    ) {
      throw new Error("Plat atau nomor kendaraan sudah terdaftar.");
    }
    await tx.execute({
      sql: `INSERT INTO drv_kendaraan (id_kendaraan, id_jenis, identitas, nama, catatan,
              status_aktif, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
            ON CONFLICT(id_kendaraan) DO UPDATE SET id_jenis = excluded.id_jenis,
              identitas = excluded.identitas, nama = excluded.nama,
              catatan = excluded.catatan, status_aktif = excluded.status_aktif,
              updated_at = datetime('now');`,
      args: [
        id,
        k.id_jenis,
        k.identitas,
        k.nama,
        k.catatan,
        k.status_aktif ? 1 : 0,
      ],
    });
    return { sukses: true as const, id };
  });
}

/** Cermin `simpan_lokasi`. */
export async function simpanLokasi(
  client: Client,
  raw: unknown,
): Promise<{ sukses: true; id: string }> {
  const parsed = lokasiDraftSchema.safeParse(raw);
  if (!parsed.success) throw new Error("Data lokasi tidak valid.");
  const valid = validateLokasi(parsed.data);
  if (!valid.ok) throw new Error(valid.error);
  const l = valid.value;
  return withTransaction(client, async (tx) => {
    let id = parsed.data.id_lokasi?.trim() || null;
    if (id) {
      if (
        !(await ada(tx, "SELECT 1 FROM drv_lokasi WHERE id_lokasi = ?;", [id]))
      ) {
        throw new Error("Lokasi tidak ditemukan.");
      }
    } else {
      id = newHexId("lok-");
    }
    await tx.execute({
      sql: `INSERT INTO drv_lokasi (id_lokasi, nama, jenis, lat, lng, radius_m, status_aktif,
              created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
            ON CONFLICT(id_lokasi) DO UPDATE SET nama = excluded.nama, jenis = excluded.jenis,
              lat = excluded.lat, lng = excluded.lng, radius_m = excluded.radius_m,
              status_aktif = excluded.status_aktif, updated_at = datetime('now');`,
      args: [
        id,
        l.nama,
        l.jenis,
        l.lat,
        l.lng,
        l.radius_m,
        l.status_aktif ? 1 : 0,
      ],
    });
    return { sukses: true as const, id };
  });
}

interface KeadaanPerjalanan {
  id_karyawan: string;
  id_kendaraan: string;
  laporan: Laporan[];
}

function angkaAtauNull(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function laporanDariBaris(l: Record<string, unknown>): Laporan {
  return {
    id_laporan: String(l.id_laporan),
    jenis: String(l.jenis),
    mode_ganti: text(l.mode_ganti),
    id_ref: text(l.id_ref),
    waktu_perangkat: String(l.waktu_perangkat),
    diterima_cloud: text(l.diterima_cloud),
    id_karyawan: text(l.id_karyawan),
    id_karyawan_baru: text(l.id_karyawan_baru),
    id_kendaraan_baru: text(l.id_kendaraan_baru),
    id_lokasi: text(l.id_lokasi),
    lat: angkaAtauNull(l.lat),
    lng: angkaAtauNull(l.lng),
    akurasi_m: angkaAtauNull(l.akurasi_m),
    foto_sha256: text(l.foto_sha256),
    lokasi_palsu: Number(l.lokasi_palsu) === 1,
  };
}

/** Cermin `KeadaanPerjalanan::baca`. */
async function bacaKeadaan(
  tx: Transaction,
  id: string,
): Promise<KeadaanPerjalanan> {
  const header = await tx.execute({
    sql: "SELECT id_karyawan, id_kendaraan FROM drv_perjalanan WHERE id_perjalanan = ?;",
    args: [id],
  });
  const row = header.rows[0];
  if (!row) throw new Error("Surat jalan tidak ditemukan.");
  const laporan = await tx.execute({
    sql: `SELECT id_laporan, jenis, mode_ganti, id_ref, waktu_perangkat, diterima_cloud,
                 id_karyawan, id_karyawan_baru, id_kendaraan_baru, id_lokasi, lat, lng,
                 akurasi_m, foto_sha256, lokasi_palsu
          FROM drv_laporan WHERE id_perjalanan = ?
          -- batas: laporan satu surat jalan, belasan baris
          ;`,
    args: [id],
  });
  return {
    id_karyawan: String(row.id_karyawan),
    id_kendaraan: String(row.id_kendaraan),
    laporan: laporan.rows.map(laporanDariBaris),
  };
}

/** Cermin `simpan_perjalanan`. */
export async function simpanPerjalanan(
  client: Client,
  operator: string,
  raw: unknown,
): Promise<{ sukses: true; id_perjalanan: string }> {
  const parsed = perjalananDraftSchema.safeParse(raw);
  if (!parsed.success) throw new Error("Data surat jalan tidak valid.");
  const valid = validatePerjalanan(parsed.data);
  if (!valid.ok) throw new Error(valid.error);
  const v = valid.value;
  return withTransaction(client, async (tx) => {
    if (
      !(await ada(
        tx,
        "SELECT 1 FROM master_data WHERE id_unik = ? AND status_aktif = 'Aktif';",
        [v.id_karyawan],
      ))
    ) {
      throw new Error("Driver tidak ditemukan atau nonaktif.");
    }
    const kendaraan = await tx.execute({
      sql: `SELECT k.id_jenis, j.tarif FROM drv_kendaraan k
            JOIN drv_jenis_kendaraan j ON j.id_jenis = k.id_jenis
            WHERE k.id_kendaraan = ? AND k.status_aktif = 1;`,
      args: [v.id_kendaraan],
    });
    const k = kendaraan.rows[0];
    if (!k) throw new Error("Kendaraan tidak ditemukan atau nonaktif.");
    const idJenis = String(k.id_jenis);
    const tarifJenis = Number(k.tarif);
    const kategori = await tx.execute({
      sql: "SELECT tarif FROM drv_kategori_tujuan WHERE id_kategori = ? AND status_aktif = 1;",
      args: [v.id_kategori],
    });
    if (kategori.rows.length === 0) {
      throw new Error("Kategori tujuan tidak ditemukan atau nonaktif.");
    }
    const tarifKategori = Number(kategori.rows[0]?.tarif);

    let id = parsed.data.id_perjalanan?.trim() || null;
    if (id) {
      const keadaan = await bacaKeadaan(tx, id);
      if (statusPerjalanan(keadaan.laporan) !== "Direncanakan") {
        throw new Error(
          "Surat jalan yang sudah berjalan atau ditutup tidak bisa diubah.",
        );
      }
      await tx.execute({
        sql: `UPDATE drv_perjalanan SET tanggal = ?, id_karyawan = ?, id_kendaraan = ?,
                tarif_kendaraan = CASE WHEN id_jenis = ? THEN tarif_kendaraan ELSE ? END,
                tarif_tujuan = CASE WHEN id_kategori = ? THEN tarif_tujuan ELSE ? END,
                id_jenis = ?, id_kategori = ?, catatan = ?, dicetak_pada = NULL,
                updated_at = datetime('now')
              WHERE id_perjalanan = ?;`,
        args: [
          v.tanggal,
          v.id_karyawan,
          v.id_kendaraan,
          idJenis,
          tarifJenis,
          v.id_kategori,
          tarifKategori,
          idJenis,
          v.id_kategori,
          v.catatan,
          id,
        ],
      });
    } else {
      id = newHexId("trp-");
      const setelan = await tx.execute(
        "SELECT value FROM setting_gex_system WHERE key = 'sj_prefix';",
      );
      const prefix = prefixTersimpan(text(setelan.rows[0]?.value));
      const urut = await tx.execute({
        sql: `SELECT COALESCE(MAX(nomor_urut), 0) + 1 AS n FROM drv_perjalanan
              WHERE seri = ? AND substr(tanggal, 1, 7) = substr(?, 1, 7)
              -- batas: agregat, selalu satu baris
              ;`,
        args: [SERI_WEB, v.tanggal],
      });
      const nomorUrut = Number(urut.rows[0]?.n ?? 1);
      await tx.execute({
        sql: `INSERT INTO drv_perjalanan (id_perjalanan, tanggal, seri, nomor_urut, nomor,
                id_karyawan, id_kendaraan, id_jenis, id_kategori, tarif_kendaraan,
                tarif_tujuan, catatan, dibuat_oleh, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'));`,
        args: [
          id,
          v.tanggal,
          SERI_WEB,
          nomorUrut,
          formatNomorSuratJalan(prefix, v.tanggal, SERI_WEB, nomorUrut),
          v.id_karyawan,
          v.id_kendaraan,
          idJenis,
          v.id_kategori,
          tarifJenis,
          tarifKategori,
          v.catatan,
          operator,
        ],
      });
    }
    for (const [indeks, m] of v.muatan.entries()) {
      const urutan = indeks + 1;
      await tx.execute({
        sql: `INSERT INTO drv_muatan (id_muatan, id_perjalanan, urutan, tempat_muat,
                tempat_bongkar, nama_barang, jenis_barang, qty, satuan, berat_kg_x100)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(id_muatan) DO UPDATE SET tempat_muat = excluded.tempat_muat,
                tempat_bongkar = excluded.tempat_bongkar, nama_barang = excluded.nama_barang,
                jenis_barang = excluded.jenis_barang, qty = excluded.qty,
                satuan = excluded.satuan, berat_kg_x100 = excluded.berat_kg_x100;`,
        args: [
          idMuatan(id, urutan),
          id,
          urutan,
          m.tempat_muat,
          m.tempat_bongkar,
          m.nama_barang,
          m.jenis_barang,
          m.qty,
          m.satuan,
          m.berat_kg_x100,
        ],
      });
    }
    await tx.execute({
      sql: "DELETE FROM drv_muatan WHERE id_perjalanan = ? AND urutan > ?;",
      args: [id, v.muatan.length],
    });
    return { sukses: true as const, id_perjalanan: id };
  });
}

/** Cermin `tandai_dicetak`. */
export async function tandaiDicetak(
  client: Client,
  idPerjalanan: string,
): Promise<{ sukses: true }> {
  const id = idPerjalanan.trim();
  return withTransaction(client, async (tx) => {
    await bacaKeadaan(tx, id);
    await tx.execute({
      sql: `UPDATE drv_perjalanan SET dicetak_pada = datetime('now'), updated_at = datetime('now')
            WHERE id_perjalanan = ?;`,
      args: [id],
    });
    return { sukses: true as const };
  });
}

/** Cermin `atur_penerima_upah`. */
export async function aturPenerimaUpah(
  client: Client,
  idPerjalanan: string,
  idKaryawan: string | null,
): Promise<{ sukses: true }> {
  const id = idPerjalanan.trim();
  const penerima = idKaryawan?.trim() || null;
  return withTransaction(client, async (tx) => {
    const keadaan = await bacaKeadaan(tx, id);
    await tolakBilaDibayar(tx, id);
    if (statusPerjalanan(keadaan.laporan) !== "Selesai") {
      throw new Error("Upah hanya untuk surat jalan yang Selesai.");
    }
    if (
      penerima &&
      !(await ada(tx, "SELECT 1 FROM master_data WHERE id_unik = ?;", [
        penerima,
      ]))
    ) {
      throw new Error("Penerima upah tidak ditemukan.");
    }
    await tx.execute({
      sql: `UPDATE drv_perjalanan SET id_karyawan_upah = ?, updated_at = datetime('now')
            WHERE id_perjalanan = ?;`,
      args: [penerima, id],
    });
    return { sukses: true as const };
  });
}

/**
 * Cermin `catat_laporan` untuk dispatcher (tanpa GPS dan foto). `diterima_cloud`
 * = jam database, karena Web menulis langsung ke cloud.
 */
export async function catatLaporanDispatcher(
  client: Client,
  operator: string,
  raw: unknown,
): Promise<{ sukses: true; id_laporan: string; sudah_tercatat?: true }> {
  const parsed = laporanDraftSchema.safeParse(raw);
  if (!parsed.success) throw new Error("Data laporan tidak valid.");
  const valid = validateLaporan(parsed.data, false, false);
  if (!valid.ok) throw new Error(valid.error);
  const v = valid.value;
  const idLaporan = parsed.data.id_laporan?.trim() || newHexId("lap-");
  return withTransaction(client, async (tx) => {
    if (
      await ada(tx, "SELECT 1 FROM drv_laporan WHERE id_laporan = ?;", [
        idLaporan,
      ])
    ) {
      return {
        sukses: true as const,
        id_laporan: idLaporan,
        sudah_tercatat: true as const,
      };
    }
    const keadaan = await bacaKeadaan(tx, v.id_perjalanan);
    const urutan = periksaUrutan(keadaan.laporan, v.jenis);
    if (!urutan.ok) throw new Error(urutan.error);
    // Cermin Rust: menyetujui ganti driver bisa menggeser penerima upah.
    if (v.jenis === "Disetujui") await tolakBilaDibayar(tx, v.id_perjalanan);
    const bertugas = penugasan(
      keadaan.id_karyawan,
      keadaan.id_kendaraan,
      keadaan.laporan,
    );
    if (v.id_ref) {
      const keputusan = validateKeputusan(keadaan.laporan, v.id_ref);
      if (!keputusan.ok) throw new Error(keputusan.error);
    }
    if (v.id_karyawan_baru) {
      if (v.id_karyawan_baru === bertugas.id_karyawan) {
        throw new Error("Driver pengganti sama dengan driver yang bertugas.");
      }
      if (
        !(await ada(
          tx,
          "SELECT 1 FROM master_data WHERE id_unik = ? AND status_aktif = 'Aktif';",
          [v.id_karyawan_baru],
        ))
      ) {
        throw new Error("Driver pengganti tidak ditemukan atau nonaktif.");
      }
    }
    if (v.id_kendaraan_baru) {
      if (v.id_kendaraan_baru === bertugas.id_kendaraan) {
        throw new Error(
          "Kendaraan pengganti sama dengan kendaraan yang bertugas.",
        );
      }
      if (
        !(await ada(
          tx,
          "SELECT 1 FROM drv_kendaraan WHERE id_kendaraan = ? AND status_aktif = 1;",
          [v.id_kendaraan_baru],
        ))
      ) {
        throw new Error("Kendaraan pengganti tidak ditemukan atau nonaktif.");
      }
    }
    await tx.execute({
      sql: `INSERT INTO drv_laporan (id_laporan, id_perjalanan, jenis, mode_ganti, id_ref,
              jenis_kendala, terlambat_menit, id_lokasi, nama_lokasi, lat, lng, akurasi_m,
              waktu_perangkat, waktu_gps, diterima_cloud, id_karyawan, id_karyawan_baru,
              id_kendaraan_baru, keterangan, foto_sha256, dilaporkan_oleh, created_at)
            VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, NULL,
              datetime('now'), NULL, ?, ?, ?, NULL, ?, datetime('now'));`,
      args: [
        idLaporan,
        v.id_perjalanan,
        v.jenis,
        v.mode_ganti,
        v.id_ref,
        v.waktu_perangkat,
        v.id_karyawan_baru,
        v.id_kendaraan_baru,
        v.keterangan,
        operator,
      ],
    });
    return { sukses: true as const, id_laporan: idLaporan };
  });
}

// ── Pengaturan dan pembacaan layar dispatcher (cermin Rust) ────────────────

const KUNCI_PREFIX_SJ = "sj_prefix";

/** Cermin `simpan_prefix`. Nomor yang sudah ada tidak berubah. */
export async function simpanPrefix(
  client: Client,
  masukan: string,
): Promise<{ sukses: true; prefix: string }> {
  const hasil = normalisasiPrefix(masukan);
  if (!hasil.ok) throw new Error(hasil.error);
  await client.execute({
    sql: `INSERT INTO setting_gex_system (key, value) VALUES (?, ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value;`,
    args: [KUNCI_PREFIX_SJ, hasil.value],
  });
  return { sukses: true, prefix: hasil.value };
}

function baris<T>(rows: unknown[]): T[] {
  return rows.map((row) => ({ ...(row as Record<string, unknown>) }) as T);
}

/** Cermin `master_perjalanan`. */
export async function masterPerjalanan(
  client: Client,
): Promise<MasterPerjalanan> {
  const [prefix, jenis, kategori, kendaraan, lokasi, personil] =
    await Promise.all([
      client.execute({
        sql: "SELECT value FROM setting_gex_system WHERE key = ?;",
        args: [KUNCI_PREFIX_SJ],
      }),
      client.execute(
        "SELECT id_jenis, nama, tarif, status_aktif FROM drv_jenis_kendaraan ORDER BY nama;",
      ),
      client.execute(
        "SELECT id_kategori, nama, tarif, status_aktif FROM drv_kategori_tujuan ORDER BY nama;",
      ),
      client.execute(
        "SELECT id_kendaraan, id_jenis, identitas, nama, catatan, status_aktif FROM drv_kendaraan ORDER BY identitas;",
      ),
      client.execute(
        "SELECT id_lokasi, nama, jenis, lat, lng, radius_m, status_aktif FROM drv_lokasi ORDER BY nama;",
      ),
      client.execute(
        "SELECT id_unik, nama, divisi FROM master_data WHERE status_aktif = 'Aktif' ORDER BY nama;",
      ),
    ]);
  return {
    prefix: prefixTersimpan(text(prefix.rows[0]?.value)),
    jenis: baris(jenis.rows),
    kategori: baris(kategori.rows),
    kendaraan: baris(kendaraan.rows),
    lokasi: baris(lokasi.rows),
    personil: baris(personil.rows),
  };
}

async function petaNama(
  client: Executor,
  sql: string,
): Promise<Map<string, string>> {
  const hasil = await client.execute(sql);
  return new Map(hasil.rows.map((r) => [String(r[0]), String(r[1])]));
}

function kelompok<T extends { id: string }>(rows: T[]): Map<string, T[]> {
  const peta = new Map<string, T[]>();
  for (const row of rows) peta.set(row.id, [...(peta.get(row.id) ?? []), row]);
  return peta;
}

/** Cermin `baca_bayar`: pembayaran dan baris untuk surat jalan `dalam`. */
async function bacaBayar(
  client: Executor,
  dalam: string,
  args: string[],
): Promise<{ pembayaran: Pembayaran[]; baris: BarisBayar[] }> {
  const [baris, pembayaran] = await Promise.all([
    client.execute({
      sql: `SELECT id_bayar, id_perjalanan, upah FROM drv_upah_bayar_baris WHERE ${dalam};`,
      args,
    }),
    client.execute({
      sql: `SELECT id_bayar, jenis, id_ref, id_karyawan FROM drv_upah_bayar
            WHERE id_bayar IN (SELECT id_bayar FROM drv_upah_bayar_baris WHERE ${dalam})
               OR id_ref IN (SELECT id_bayar FROM drv_upah_bayar_baris WHERE ${dalam});`,
      args,
    }),
  ]);
  return {
    pembayaran: pembayaran.rows.map((r) => ({
      id_bayar: String(r.id_bayar),
      jenis: String(r.jenis),
      id_ref: text(r.id_ref),
      id_karyawan: String(r.id_karyawan),
    })),
    baris: baris.rows.map((r) => ({
      id_bayar: String(r.id_bayar),
      id_perjalanan: String(r.id_perjalanan),
      upah: Number(r.upah),
    })),
  };
}

/** Cermin `tolak_bila_dibayar`. */
async function tolakBilaDibayar(
  tx: Executor,
  idPerjalanan: string,
): Promise<void> {
  const { pembayaran, baris } = await bacaBayar(tx, "id_perjalanan = ?1", [
    idPerjalanan,
  ]);
  if (bayarAktif(idPerjalanan, pembayaran, baris).length > 0) {
    throw new Error(PESAN_SUDAH_DIBAYAR);
  }
}

/** Cermin `kumpulkan`. `syarat` = saringan atas `drv_perjalanan p`. */
async function kumpulkanPerjalanan(
  client: Executor,
  syarat: string,
  args: string[],
  batas: number = MAKS_DAFTAR_PERJALANAN,
): Promise<PerjalananItem[]> {
  const dalam = `id_perjalanan IN (SELECT p.id_perjalanan FROM drv_perjalanan p WHERE ${syarat})`;
  const [
    headers,
    laporanRows,
    rencanaRows,
    dilaporRows,
    lokasiRows,
    namaPersonil,
    identitas,
    namaKategori,
    dataBayar,
  ] = await Promise.all([
    client.execute({
      sql: `SELECT p.* FROM drv_perjalanan p WHERE ${syarat}
            ORDER BY p.tanggal DESC, p.nomor DESC
            LIMIT ${batas};`,
      args,
    }),
    client.execute({
      sql: `SELECT id_laporan, jenis, mode_ganti, id_ref, waktu_perangkat, diterima_cloud,
                   id_karyawan, id_karyawan_baru, id_kendaraan_baru, id_lokasi, lat, lng,
                   akurasi_m, foto_sha256, id_perjalanan, lokasi_palsu
            FROM drv_laporan WHERE ${dalam}
            -- batas: laporan surat jalan yang dibaca saja, belasan per surat jalan
            ;`,
      args,
    }),
    client.execute({
      sql: `SELECT id_perjalanan, id_muatan, qty FROM drv_muatan WHERE ${dalam};`,
      args,
    }),
    client.execute({
      sql: `SELECT l.id_perjalanan, m.id_laporan, m.id_muatan, m.qty
            FROM drv_laporan_muatan m JOIN drv_laporan l ON l.id_laporan = m.id_laporan
            WHERE l.${dalam};`,
      args,
    }),
    client.execute("SELECT id_lokasi, lat, lng, radius_m FROM drv_lokasi;"),
    petaNama(client, "SELECT id_unik, nama FROM master_data;"),
    petaNama(client, "SELECT id_kendaraan, identitas FROM drv_kendaraan;"),
    petaNama(client, "SELECT id_kategori, nama FROM drv_kategori_tujuan;"),
    bacaBayar(client, dalam, args),
  ]);
  const bayarPerSj = kelompok(
    dataBayar.baris.map((b) => ({ id: b.id_perjalanan, ...b })),
  );
  const laporan = kelompok(
    laporanRows.rows.map((r) => ({
      id: String(r.id_perjalanan),
      laporan: laporanDariBaris(r),
    })),
  );
  const rencana = kelompok(
    rencanaRows.rows.map((r) => ({
      id: String(r.id_perjalanan),
      id_muatan: String(r.id_muatan),
      qty: Number(r.qty),
    })),
  );
  const dilapor = kelompok(
    dilaporRows.rows.map((r) => ({
      id: String(r.id_perjalanan),
      id_laporan: String(r.id_laporan),
      id_muatan: String(r.id_muatan),
      qty: Number(r.qty),
    })),
  );
  const lokasi = lokasiRows.rows.map((r) => ({
    id_lokasi: String(r.id_lokasi),
    lat: Number(r.lat),
    lng: Number(r.lng),
    radius_m: Number(r.radius_m),
  }));
  const nama = (peta: Map<string, string>, id: string | null) =>
    id === null ? null : (peta.get(id) ?? null);

  return headers.rows.map((h) => {
    const id = String(h.id_perjalanan);
    const refs = (laporan.get(id) ?? []).map((r) => r.laporan);
    const awalKaryawan = String(h.id_karyawan);
    const awalKendaraan = String(h.id_kendaraan);
    const status = statusPerjalanan(refs);
    const tugas = penugasan(awalKaryawan, awalKendaraan, refs);
    const rencanaTrip = rencana.get(id) ?? [];
    const tarifKendaraan = Number(h.tarif_kendaraan);
    const tarifTujuan = Number(h.tarif_tujuan);
    const upah = upahSuratJalan(tarifKendaraan, tarifTujuan);
    const idUpah = text(h.id_karyawan_upah);
    const penerima = penerimaUpah(status, idUpah, refs, tugas.id_karyawan);
    const terakhir = urutkan(refs).at(-1);
    const barisSj = bayarPerSj.get(id) ?? [];
    const sj: SuratJalanUpah = {
      id_perjalanan: id,
      nomor: String(h.nomor),
      status,
      penerima,
      upah,
    };
    return {
      id_perjalanan: id,
      tanggal: String(h.tanggal),
      nomor: String(h.nomor),
      status,
      catatan: text(h.catatan),
      dicetak_pada: text(h.dicetak_pada),
      dibuat_oleh: String(h.dibuat_oleh),
      id_karyawan_awal: awalKaryawan,
      id_kendaraan_awal: awalKendaraan,
      identitas_kendaraan_awal: nama(identitas, awalKendaraan),
      id_karyawan: tugas.id_karyawan,
      nama_karyawan: nama(namaPersonil, tugas.id_karyawan),
      id_kendaraan: tugas.id_kendaraan,
      identitas_kendaraan: nama(identitas, tugas.id_kendaraan),
      id_jenis: String(h.id_jenis),
      id_kategori: String(h.id_kategori),
      nama_kategori: nama(namaKategori, String(h.id_kategori)),
      tarif_kendaraan: tarifKendaraan,
      tarif_tujuan: tarifTujuan,
      upah,
      bayar: bayarAktif(id, dataBayar.pembayaran, barisSj),
      id_karyawan_upah: idUpah,
      penerima_upah: penerima,
      nama_penerima_upah: nama(namaPersonil, penerima),
      jumlah_muatan: rencanaTrip.length,
      laporan_terakhir: terakhir
        ? { jenis: terakhir.jenis, waktu_perangkat: terakhir.waktu_perangkat }
        : null,
      menunggu_persetujuan: gantiMenunggu(refs),
      tanda: [
        ...tandaTinjau(
          refs,
          lokasi,
          rencanaTrip,
          dilapor.get(id) ?? [],
          AKURASI_PERINGATAN_M,
        ),
        ...tandaUpah([sj], dataBayar.pembayaran, barisSj),
      ],
    };
  });
}

/** Cermin `daftar_perjalanan`. */
export async function daftarPerjalanan(
  client: Client,
  dari: string,
  sampai: string,
): Promise<{ items: PerjalananItem[] }> {
  const [a, b] = [dari.trim(), sampai.trim()];
  if (!isValidDate(a) || !isValidDate(b) || a > b) {
    throw new Error("Rentang tanggal tidak valid.");
  }
  return {
    items: await kumpulkanPerjalanan(client, "p.tanggal BETWEEN ?1 AND ?2", [
      a,
      b,
    ]),
  };
}

// ── Pembayaran upah (v35, cermin Rust) ─────────────────────────────────────

/** Cermin `catat_bayar_upah`. Total = jumlah upah surat jalannya saat ini. */
export async function catatBayarUpah(
  client: Client,
  operator: string,
  raw: unknown,
): Promise<{ sukses: true; id_bayar: string; total: number }> {
  const parsed = bayarUpahDraftSchema.safeParse(raw);
  if (!parsed.success) throw new Error("Data pembayaran tidak valid.");
  const valid = validateBayarUpah(parsed.data);
  if (!valid.ok) throw new Error(valid.error);
  const v = valid.value;
  const pilihan = JSON.stringify(v.id_perjalanan);
  return withTransaction(client, async (tx) => {
    const items = await kumpulkanPerjalanan(
      tx,
      "p.id_perjalanan IN (SELECT value FROM json_each(?1))",
      [pilihan],
      MAKS_SURAT_JALAN_PER_BAYAR,
    );
    const { pembayaran, baris } = await bacaBayar(
      tx,
      "id_perjalanan IN (SELECT value FROM json_each(?1))",
      [pilihan],
    );
    const upah = periksaBayarUpah(
      v,
      items.map((i) => ({
        id_perjalanan: i.id_perjalanan,
        nomor: i.nomor,
        status: i.status,
        penerima: i.penerima_upah,
        upah: i.upah,
      })),
      pembayaran,
      baris,
    );
    if (!upah.ok) throw new Error(upah.error);
    const total = upah.value.reduce((s, n) => s + n, 0);
    const idBayar = newHexId("upb-");
    await tx.execute({
      sql: `INSERT INTO drv_upah_bayar
              (id_bayar, jenis, id_ref, id_karyawan, tanggal, total, keterangan, dicatat_oleh)
            VALUES (?, 'Bayar', NULL, ?, ?, ?, ?, ?);`,
      args: [idBayar, v.id_karyawan, v.tanggal, total, v.keterangan, operator],
    });
    for (const [i, idPerjalanan] of v.id_perjalanan.entries()) {
      await tx.execute({
        sql: `INSERT INTO drv_upah_bayar_baris (id_baris, id_bayar, id_perjalanan, upah)
              VALUES (?, ?, ?, ?);`,
        args: [
          idBarisBayar(idBayar, idPerjalanan),
          idBayar,
          idPerjalanan,
          upah.value[i],
        ],
      });
    }
    return { sukses: true as const, id_bayar: idBayar, total };
  });
}

/** Cermin `batal_bayar_upah`. */
export async function batalBayarUpah(
  client: Client,
  operator: string,
  raw: unknown,
): Promise<{ sukses: true; id_bayar: string }> {
  const parsed = batalBayarDraftSchema.safeParse(raw);
  if (!parsed.success) throw new Error("Data pembatalan tidak valid.");
  const valid = validateBatalBayar(parsed.data);
  if (!valid.ok) throw new Error(valid.error);
  const { id_bayar: idBayar, alasan } = valid.value;
  return withTransaction(client, async (tx) => {
    const rows = await tx.execute({
      sql: `SELECT id_bayar, jenis, id_ref, id_karyawan FROM drv_upah_bayar
            WHERE id_bayar = ?1 OR id_ref = ?1;`,
      args: [idBayar],
    });
    const cek = periksaBatalBayar(
      rows.rows.map((r) => ({
        id_bayar: String(r.id_bayar),
        jenis: String(r.jenis),
        id_ref: text(r.id_ref),
        id_karyawan: String(r.id_karyawan),
      })),
      idBayar,
    );
    if (!cek.ok) throw new Error(cek.error);
    const id = idBatalBayar(idBayar);
    await tx.execute({
      sql: `INSERT INTO drv_upah_bayar
              (id_bayar, jenis, id_ref, id_karyawan, tanggal, total, keterangan, dicatat_oleh)
            SELECT ?1, 'Pembatalan', id_bayar, id_karyawan, date('now', '+7 hours'), total, ?2, ?3
            FROM drv_upah_bayar WHERE id_bayar = ?4;`,
      args: [id, alasan, operator, idBayar],
    });
    return { sukses: true as const, id_bayar: id };
  });
}

function rentangSah(dari: string, sampai: string): [string, string] {
  const [a, b] = [dari.trim(), sampai.trim()];
  if (!isValidDate(a) || !isValidDate(b) || a > b) {
    throw new Error("Rentang tanggal tidak valid.");
  }
  return [a, b];
}

/** Cermin `rekap_upah`. Pengelompokan dilakukan di layar. */
export async function rekapUpah(
  client: Client,
  dari: string,
  sampai: string,
): Promise<{ items: PerjalananItem[] }> {
  return {
    items: await kumpulkanPerjalanan(
      client,
      "p.tanggal BETWEEN ?1 AND ?2",
      rentangSah(dari, sampai),
      MAKS_REKAP_UPAH,
    ),
  };
}

/** Cermin `daftar_bayar_upah`. */
export async function daftarBayarUpah(
  client: Client,
  dari: string,
  sampai: string,
): Promise<{ items: PembayaranUpahItem[] }> {
  const args = rentangSah(dari, sampai);
  const [items, barisRows] = await Promise.all([
    client.execute({
      sql: `SELECT b.id_bayar, b.id_karyawan, m.nama AS nama_karyawan, b.tanggal, b.total,
                   b.keterangan, b.dicatat_oleh, b.created_at,
                   x.tanggal AS tanggal_batal, x.keterangan AS alasan_batal,
                   x.dicatat_oleh AS dibatalkan_oleh
            FROM drv_upah_bayar b
            LEFT JOIN master_data m ON m.id_unik = b.id_karyawan
            LEFT JOIN drv_upah_bayar x ON x.jenis = 'Pembatalan' AND x.id_ref = b.id_bayar
            WHERE b.jenis = 'Bayar' AND b.tanggal BETWEEN ?1 AND ?2
            GROUP BY b.id_bayar
            ORDER BY b.tanggal DESC, b.created_at DESC
            LIMIT ${MAKS_DAFTAR_BAYAR};`,
      args,
    }),
    client.execute({
      sql: `SELECT r.id_bayar, r.id_perjalanan, r.upah, p.nomor, p.tanggal
            FROM drv_upah_bayar_baris r
            JOIN drv_upah_bayar b ON b.id_bayar = r.id_bayar
            LEFT JOIN drv_perjalanan p ON p.id_perjalanan = r.id_perjalanan
            WHERE b.jenis = 'Bayar' AND b.tanggal BETWEEN ?1 AND ?2
            ORDER BY p.tanggal, p.nomor;`,
      args,
    }),
  ]);
  const suratJalan = baris<PembayaranUpahItem["surat_jalan"][number]>(
    barisRows.rows,
  );
  return {
    items: baris<Omit<PembayaranUpahItem, "surat_jalan">>(items.rows).map(
      (item) => ({
        ...item,
        total: Number(item.total),
        surat_jalan: suratJalan
          .filter((s) => s.id_bayar === item.id_bayar)
          .map((s) => ({ ...s, upah: Number(s.upah) })),
      }),
    ),
  };
}

/** Cermin `rincian_perjalanan`. Di Web semua foto ada di database yang sama. */
export async function rincianPerjalanan(
  client: Client,
  idPerjalanan: string,
): Promise<RincianPerjalanan> {
  const id = idPerjalanan.trim();
  const [item] = await kumpulkanPerjalanan(client, "p.id_perjalanan = ?1", [
    id,
  ]);
  if (!item) throw new Error("Surat jalan tidak ditemukan.");
  const [laporan, rincian, muatan] = await Promise.all([
    client.execute({
      sql: `SELECT l.*, EXISTS (SELECT 1 FROM drv_laporan_foto f WHERE f.id_laporan = l.id_laporan) AS foto_lokal
            FROM drv_laporan l WHERE l.id_perjalanan = ?1
            ORDER BY l.waktu_perangkat, l.id_laporan
            -- batas: laporan satu surat jalan, belasan baris
            ;`,
      args: [id],
    }),
    client.execute({
      sql: `SELECT m.id_laporan, m.id_muatan, m.qty, m.berat_kg_x100
            FROM drv_laporan_muatan m JOIN drv_laporan l ON l.id_laporan = m.id_laporan
            WHERE l.id_perjalanan = ?1 ORDER BY m.id_baris;`,
      args: [id],
    }),
    client.execute({
      sql: "SELECT * FROM drv_muatan WHERE id_perjalanan = ?1 ORDER BY urutan;",
      args: [id],
    }),
  ]);
  const rincianBaris = baris<LaporanBaris["muatan"][number]>(rincian.rows);
  return {
    item,
    muatan: baris<MuatanBaris>(muatan.rows),
    laporan: baris<LaporanBaris>(laporan.rows).map((l) => ({
      ...l,
      foto_lokal: Number(l.foto_lokal),
      muatan: rincianBaris.filter((m) => m.id_laporan === l.id_laporan),
    })),
  };
}

/** Foto satu laporan (pola foto penerimaan). `null` = belum terkirim. */
export async function fotoLaporan(
  client: Client,
  idLaporan: string,
): Promise<{ mime_type: string; data_base64: string } | null> {
  const id = idLaporan.trim();
  if (!id || id.length > 200) throw new Error("Foto tidak valid.");
  const hasil = await client.execute({
    sql: "SELECT mime_type, data_base64 FROM drv_laporan_foto WHERE id_laporan = ? LIMIT 1;",
    args: [id],
  });
  const row = hasil.rows[0];
  return row
    ? { mime_type: String(row.mime_type), data_base64: String(row.data_base64) }
    : null;
}

/** Cermin `hapus_foto_laporan_lama` (masa simpan 90 hari, jam database). */
export async function hapusFotoLama(
  client: Client,
): Promise<{ cloud: number }> {
  const hasil = await client.execute(HAPUS_FOTO_LAMA_SQL);
  return { cloud: hasil.rowsAffected };
}

/** Cermin `foto_laporan_segera_dihapus`. */
export async function fotoSegeraDihapus(
  client: Client,
): Promise<FotoSegeraDihapus> {
  const hasil = await client.execute(FOTO_SEGERA_DIHAPUS_SQL);
  const row = hasil.rows[0];
  return {
    jumlah: Number(row?.jumlah ?? 0),
    tanggal_tertua: text(row?.tanggal_tertua),
  };
}
