import "server-only";

import { randomBytes } from "node:crypto";
import type { Client, Transaction } from "@libsql/client";
import { trialBalance } from "@/lib/services/accounting";
import {
  bandingSaldo,
  cekPeriodeTerbuka,
  KEPUTUSAN_TUTUP,
  type KeputusanTutup,
  saldoTutupJson,
  tanggalTampil,
  validateAlasanBuka,
  validateCatatanKeputusan,
  validateTutup,
} from "@/lib/validations/tutup-buku";
import type {
  StatusTutupBuku,
  TinjauanTutupBuku,
  TutupBukuItem,
} from "@/types/accounting";

/**
 * Sisi Web tutup buku, cermin `desktop/tutup_buku.rs`. Web menulis langsung ke
 * cloud, jadi `waktu_perangkat` dan `diterima_cloud` sama-sama jam database
 * dan kode perangkatnya `WEB`.
 */

type Executor = Client | Transaction;

const KODE_PERANGKAT_WEB = "WEB";

const KOLOM_TUTUP = `id_tutup, sampai_tanggal, dibuat_oleh, kode_perangkat, waktu_perangkat,
    diterima_cloud, saldo_json, status, alasan_buka, dibuka_oleh, dibuka_pada, created_at, updated_at,
    diputuskan_oleh, diputuskan_pada, catatan_keputusan`;

function text(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

/** Tanggal batas yang berlaku, atau `null`. Cermin `batas_tutup`. */
export async function batasTutup(tx: Executor): Promise<string | null> {
  const result = await tx.execute(
    `SELECT MAX(sampai_tanggal) AS batas FROM keu_tutup_buku WHERE status = 'Aktif'
     -- batas: agregat, selalu satu baris
     ;`,
  );
  return text(result.rows[0]?.batas);
}

/** Gerbang setiap penulis jurnal. Cermin `assert_periode_terbuka`. */
export async function assertPeriodeTerbuka(
  tx: Executor,
  tanggal: string,
): Promise<void> {
  const hasil = cekPeriodeTerbuka(tanggal, await batasTutup(tx));
  if (!hasil.ok) throw new Error(hasil.error);
}

function barisTutup(row: Record<string, unknown>): TutupBukuItem {
  return {
    id_tutup: String(row.id_tutup),
    sampai_tanggal: String(row.sampai_tanggal),
    dibuat_oleh: String(row.dibuat_oleh),
    kode_perangkat: String(row.kode_perangkat),
    waktu_perangkat: String(row.waktu_perangkat),
    diterima_cloud: text(row.diterima_cloud),
    saldo_json: String(row.saldo_json),
    status: String(row.status) as TutupBukuItem["status"],
    alasan_buka: text(row.alasan_buka),
    dibuka_oleh: text(row.dibuka_oleh),
    dibuka_pada: text(row.dibuka_pada),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
    diputuskan_oleh: text(row.diputuskan_oleh),
    diputuskan_pada: text(row.diputuskan_pada),
    catatan_keputusan: text(row.catatan_keputusan),
  };
}

/** Potret saldo kanonik saat ini sampai `sampai`. Cermin `saldo_sekarang`. */
async function saldoSekarang(client: Client, sampai: string): Promise<string> {
  return saldoTutupJson((await trialBalance(client, sampai)).items);
}

async function bacaTutup(
  tx: Executor,
  id: string,
): Promise<TutupBukuItem | null> {
  const hasil = await tx.execute({
    sql: `SELECT ${KOLOM_TUTUP} FROM keu_tutup_buku WHERE id_tutup = ?;`,
    args: [id],
  });
  const row = hasil.rows[0];
  return row ? barisTutup(row as unknown as Record<string, unknown>) : null;
}

/** Cermin `status`, termasuk tanda "perlu ditinjau" (Tahap 2). */
export async function status(client: Client): Promise<StatusTutupBuku> {
  const [hasil, batas] = await Promise.all([
    client.execute(
      `SELECT ${KOLOM_TUTUP} FROM keu_tutup_buku
       ORDER BY sampai_tanggal DESC, waktu_perangkat DESC, id_tutup
       LIMIT 200;`,
    ),
    batasTutup(client),
  ]);
  const cache = new Map<string, string>();
  let perhatian = 0;
  const riwayat: TutupBukuItem[] = [];
  for (const row of hasil.rows) {
    const baris = barisTutup(row as unknown as Record<string, unknown>);
    let perlu = false;
    if (baris.status === "Aktif") {
      let sekarang = cache.get(baris.sampai_tanggal);
      if (sekarang === undefined) {
        sekarang = await saldoSekarang(client, baris.sampai_tanggal);
        cache.set(baris.sampai_tanggal, sekarang);
      }
      perlu = baris.saldo_json !== sekarang;
    }
    if (perlu || baris.status === "Menunggu") perhatian += 1;
    riwayat.push({ ...baris, perlu_ditinjau: perlu });
  }
  return { batas, perlu_perhatian: perhatian, riwayat };
}

// ── Tahap 2: tinjauan dan keputusan ─────────────────────────────────────────

/** Cermin `PAKAI_SINGKIRKAN_SQL`, `PAKAI_SQL`, dan `TOLAK_SQL`. */
const PAKAI_SINGKIRKAN_SQL = `UPDATE keu_tutup_buku
    SET status = 'Digantikan', diputuskan_oleh = ?, diputuskan_pada = ?, catatan_keputusan = ?,
        updated_at = datetime('now')
    WHERE sampai_tanggal = (SELECT sampai_tanggal FROM keu_tutup_buku WHERE id_tutup = ?)
      AND id_tutup <> ?
      AND status IN ('Aktif', 'Menunggu')
      AND EXISTS (SELECT 1 FROM keu_tutup_buku WHERE id_tutup = ? AND status IN ('Aktif', 'Menunggu'));`;
const PAKAI_SQL = `UPDATE keu_tutup_buku
    SET status = 'Aktif', diputuskan_oleh = ?, diputuskan_pada = ?, catatan_keputusan = ?,
        updated_at = datetime('now')
    WHERE id_tutup = ? AND status IN ('Aktif', 'Menunggu');`;
const TOLAK_SQL = `UPDATE keu_tutup_buku
    SET status = 'Digantikan', diputuskan_oleh = ?, diputuskan_pada = ?, catatan_keputusan = ?,
        updated_at = datetime('now')
    WHERE id_tutup = ? AND status IN ('Aktif', 'Menunggu');`;

/** Cermin `statement_keputusan`. */
function statementKeputusan(
  id: string,
  keputusan: KeputusanTutup,
  oleh: string,
  pada: string,
  catatan: string | null,
) {
  const awal = [oleh, pada, catatan];
  return keputusan === "pakai"
    ? [
        { sql: PAKAI_SINGKIRKAN_SQL, args: [...awal, id, id, id] },
        { sql: PAKAI_SQL, args: [...awal, id] },
      ]
    : [{ sql: TOLAK_SQL, args: [...awal, id] }];
}

async function waktuSekarang(tx: Executor): Promise<string> {
  const hasil = await tx.execute(
    "SELECT datetime('now', '+7 hours') AS waktu;",
  );
  return String(hasil.rows[0]?.waktu ?? "");
}

/** Cermin `review`. */
export async function review(
  client: Client,
  idTutup: string,
): Promise<TinjauanTutupBuku> {
  const tutup = await bacaTutup(client, idTutup);
  if (!tutup) throw new Error("Tutup buku tidak ditemukan.");
  let pembanding: TutupBukuItem | null = null;
  let jurnal: TinjauanTutupBuku["jurnal"] = [];
  let selisih: Array<[string, number, number]> = [];
  if (tutup.status === "Menunggu") {
    const hasil = await client.execute({
      sql: `SELECT ${KOLOM_TUTUP} FROM keu_tutup_buku
            WHERE sampai_tanggal = ? AND status = 'Aktif' AND id_tutup <> ?
            ORDER BY id_tutup LIMIT 1;`,
      args: [tutup.sampai_tanggal, idTutup],
    });
    const row = hasil.rows[0];
    pembanding = row
      ? barisTutup(row as unknown as Record<string, unknown>)
      : null;
    selisih = bandingSaldo(pembanding?.saldo_json ?? "[]", tutup.saldo_json);
  } else if (tutup.status === "Aktif") {
    selisih = bandingSaldo(
      tutup.saldo_json,
      await saldoSekarang(client, tutup.sampai_tanggal),
    );
    if (selisih.length > 0) {
      const hasil = await client.execute({
        sql: `SELECT j.id_jurnal, j.tanggal, j.nomor, j.keterangan, j.sumber, j.dibuat_oleh,
                     j.created_at, COALESCE(SUM(b.debit), 0) AS total
              FROM keu_jurnal j
              LEFT JOIN keu_jurnal_baris b ON b.id_jurnal = j.id_jurnal
              WHERE j.tanggal <= ? AND j.created_at > ?
              GROUP BY j.id_jurnal
              ORDER BY j.created_at DESC, j.id_jurnal
              LIMIT 200;`,
        args: [tutup.sampai_tanggal, tutup.created_at],
      });
      jurnal = hasil.rows.map((row) => ({
        id_jurnal: String(row.id_jurnal),
        tanggal: String(row.tanggal),
        nomor: String(row.nomor),
        keterangan: String(row.keterangan),
        sumber: String(row.sumber),
        dibuat_oleh: String(row.dibuat_oleh),
        created_at: String(row.created_at),
        total: Number(row.total),
      }));
    }
  }
  const akun = new Map<string, { kode: string; nama: string }>();
  if (selisih.length > 0) {
    const hasil = await client.execute({
      sql: `SELECT id_akun, kode, nama FROM keu_akun WHERE id_akun IN (${selisih.map(() => "?").join(", ")});`,
      args: selisih.map(([id]) => id),
    });
    for (const row of hasil.rows) {
      akun.set(String(row.id_akun), {
        kode: String(row.kode),
        nama: String(row.nama),
      });
    }
  }
  return {
    tutup,
    pembanding,
    selisih: selisih.map(([id_akun, sebelum, sesudah]) => ({
      id_akun,
      kode: akun.get(id_akun)?.kode ?? "",
      nama: akun.get(id_akun)?.nama ?? id_akun,
      sebelum,
      sesudah,
    })),
    jurnal,
  };
}

/** Cermin `decide`: versi yang `Menunggu` dipakai atau ditolak. */
export async function decide(
  client: Client,
  operator: string,
  idTutup: string,
  keputusan: string,
  catatanMentah: string,
): Promise<{ sukses: true; batas: string | null }> {
  if (!(KEPUTUSAN_TUTUP as readonly string[]).includes(keputusan)) {
    throw new Error("Keputusan tidak dikenal.");
  }
  const catatan = validateCatatanKeputusan(catatanMentah);
  if (!catatan.ok) throw new Error(catatan.error);
  return withTransaction(client, async (tx) => {
    const tutup = await bacaTutup(tx, idTutup);
    if (!tutup) throw new Error("Tutup buku tidak ditemukan.");
    if (tutup.status !== "Menunggu") {
      throw new Error(
        "Hanya tutup buku yang menunggu keputusan yang bisa diputuskan.",
      );
    }
    const pada = await waktuSekarang(tx);
    for (const statement of statementKeputusan(
      idTutup,
      keputusan as KeputusanTutup,
      operator,
      pada,
      catatan.value,
    )) {
      await tx.execute(statement);
    }
    return { sukses: true as const, batas: await batasTutup(tx) };
  });
}

/** Cermin `revise`: tutup ulang dengan saldo sekarang. */
export async function revise(
  client: Client,
  operator: string,
  idTutup: string,
  catatanMentah: string,
): Promise<{ sukses: true; tutup: TutupBukuItem }> {
  const catatan = validateCatatanKeputusan(catatanMentah);
  if (!catatan.ok) throw new Error(catatan.error);
  const tutup = await bacaTutup(client, idTutup);
  if (!tutup) throw new Error("Tutup buku tidak ditemukan.");
  if (tutup.status !== "Aktif") {
    throw new Error("Hanya tutup buku yang berlaku yang bisa ditutup ulang.");
  }
  const sekarang = await saldoSekarang(client, tutup.sampai_tanggal);
  if (tutup.saldo_json === sekarang) {
    throw new Error("Saldo periode ini tidak berubah sejak ditutup.");
  }
  const idBaru = `tb-${randomBytes(16).toString("hex")}`;
  return withTransaction(client, async (tx) => {
    const pada = await waktuSekarang(tx);
    for (const statement of statementKeputusan(
      idTutup,
      "tolak",
      operator,
      pada,
      catatan.value ?? "Ditutup ulang dengan saldo sekarang.",
    )) {
      await tx.execute(statement);
    }
    await tx.execute({
      sql: `INSERT INTO keu_tutup_buku (
              id_tutup, sampai_tanggal, dibuat_oleh, kode_perangkat, waktu_perangkat,
              diterima_cloud, saldo_json, status
            ) VALUES (?, ?, ?, ?, datetime('now', '+7 hours'), datetime('now', '+7 hours'), ?, 'Aktif');`,
      args: [
        idBaru,
        tutup.sampai_tanggal,
        operator,
        KODE_PERANGKAT_WEB,
        sekarang,
      ],
    });
    const baru = await bacaTutup(tx, idBaru);
    if (!baru) throw new Error("Tutup buku baru tidak tersimpan.");
    return { sukses: true as const, tutup: baru };
  });
}

async function withTransaction<T>(
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

/** Cermin `close`: tutup buku sampai `sampai` dengan potret saldo saat itu. */
export async function close(
  client: Client,
  operator: string,
  sampaiMentah: string,
): Promise<{ sukses: true; tutup: TutupBukuItem }> {
  const hariIni = await client.execute(
    "SELECT date('now', '+7 hours') AS hari;",
  );
  const valid = validateTutup(
    sampaiMentah,
    await batasTutup(client),
    String(hariIni.rows[0]?.hari ?? ""),
  );
  if (!valid.ok) throw new Error(valid.error);
  const neraca = await trialBalance(client, valid.value);
  const saldo = saldoTutupJson(neraca.items);
  const id = `tb-${randomBytes(16).toString("hex")}`;
  return withTransaction(client, async (tx) => {
    // Dicek ulang di dalam transaksi: tutup buku lain bisa masuk di antaranya.
    const batas = await batasTutup(tx);
    if (batas !== null && valid.value <= batas) {
      throw new Error(
        `Buku sudah ditutup sampai ${tanggalTampil(batas)}. Pilih tanggal sesudahnya.`,
      );
    }
    await tx.execute({
      sql: `INSERT INTO keu_tutup_buku (
              id_tutup, sampai_tanggal, dibuat_oleh, kode_perangkat, waktu_perangkat,
              diterima_cloud, saldo_json, status
            ) VALUES (?, ?, ?, ?, datetime('now', '+7 hours'), datetime('now', '+7 hours'), ?, 'Aktif');`,
      args: [id, valid.value, operator, KODE_PERANGKAT_WEB, saldo],
    });
    const baris = await tx.execute({
      sql: `SELECT ${KOLOM_TUTUP} FROM keu_tutup_buku WHERE id_tutup = ?;`,
      args: [id],
    });
    return {
      sukses: true as const,
      tutup: barisTutup(baris.rows[0] as unknown as Record<string, unknown>),
    };
  });
}

/** Cermin `reopen`: buka kembali batas terakhir, dengan alasan. */
export async function reopen(
  client: Client,
  operator: string,
  alasanMentah: string,
): Promise<{ sukses: true; batas: string | null }> {
  const alasan = validateAlasanBuka(alasanMentah);
  if (!alasan.ok) throw new Error(alasan.error);
  return withTransaction(client, async (tx) => {
    const batas = await batasTutup(tx);
    if (batas === null) throw new Error("Belum ada periode yang ditutup.");
    await tx.execute({
      sql: `UPDATE keu_tutup_buku
            SET status = 'Dibuka', alasan_buka = ?, dibuka_oleh = ?,
                dibuka_pada = datetime('now', '+7 hours'), updated_at = datetime('now')
            WHERE sampai_tanggal = ? AND status = 'Aktif';`,
      args: [alasan.value, operator, batas],
    });
    return { sukses: true as const, batas: await batasTutup(tx) };
  });
}
