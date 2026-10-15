import "server-only";

import { randomBytes } from "node:crypto";
import type { Client, InStatement, Transaction } from "@libsql/client";
import { assertPeriodeTerbuka } from "@/lib/services/tutup-buku";
import {
  AKUN_SISTEM_IDS,
  type AkunSaldo,
  akunDraftSchema,
  aturanUbahAkun,
  type BarisJurnalValid,
  formatNomorJurnal,
  idPembalik,
  isValidDate,
  type JurnalAsal,
  jurnalDraftSchema,
  kolomNeracaSaldo,
  MAKS_AKUN_KAS,
  MAKS_BARIS_BUKU_BESAR,
  type SaldoNormal,
  SERI_WEB,
  SUMBER_JURNAL,
  type SumberJurnal,
  saldoAkun,
  saldoBerjalan,
  susunAktivitas,
  susunArusKas,
  susunPembalik,
  susunPosisiKeuangan,
  validateAkun,
  validateJurnal,
} from "@/lib/validations/accounting";
import type {
  AkunItem,
  BukuBesar,
  JurnalDetail,
  JurnalItem,
  LaporanAktivitas,
  LaporanArusKas,
  LaporanPosisiKeuangan,
  NeracaSaldo,
} from "@/types/accounting";

/**
 * Sisi Web modul akuntansi, cermin `desktop/accounting.rs`. Web menulis
 * langsung ke database cloud; trigger `sync_pulse` membuat setiap perangkat
 * menarik perubahannya. Pesan galat wajib sama dengan Rust.
 */

type Executor = Client | Transaction;

function newId(prefix: string): string {
  return `${prefix}${randomBytes(16).toString("hex")}`;
}

function text(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
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

function assertRentang(dari: string, sampai: string) {
  if (!isValidDate(dari) || !isValidDate(sampai) || dari > sampai) {
    throw new Error("Rentang tanggal tidak valid.");
  }
}

// ── Akun ────────────────────────────────────────────────────────────────────

export async function listAccounts(
  client: Client,
): Promise<{ items: AkunItem[] }> {
  const result = await client.execute(
    `SELECT a.id_akun, a.kode, a.nama, a.kelompok, a.saldo_normal, a.is_aktif,
            EXISTS(SELECT 1 FROM keu_jurnal_baris b WHERE b.id_akun = a.id_akun) AS punya_jurnal
     FROM keu_akun a
     ORDER BY a.kode, a.id_akun
     LIMIT 1000;`,
  );
  return {
    items: result.rows.map((row) => ({
      id_akun: String(row.id_akun),
      kode: String(row.kode),
      nama: String(row.nama),
      kelompok: String(row.kelompok) as AkunItem["kelompok"],
      saldo_normal: String(row.saldo_normal) as SaldoNormal,
      is_aktif: Number(row.is_aktif) === 1,
      sistem: AKUN_SISTEM_IDS.has(String(row.id_akun)),
      punya_jurnal: Number(row.punya_jurnal) === 1,
    })),
  };
}

export async function saveAccount(
  client: Client,
  rawDraft: unknown,
): Promise<{ sukses: true; id_akun: string }> {
  const parsed = akunDraftSchema.safeParse(rawDraft);
  if (!parsed.success) throw new Error("Data akun tidak valid.");
  const hasil = validateAkun(parsed.data);
  if (!hasil.ok) throw new Error(hasil.error);
  const valid = hasil.value;

  return withTransaction(client, async (tx) => {
    let idAkun = parsed.data.id_akun?.trim() ?? "";
    if (idAkun) {
      const lama = await tx.execute({
        sql: "SELECT kelompok, saldo_normal FROM keu_akun WHERE id_akun = ?;",
        args: [idAkun],
      });
      const row = lama.rows[0];
      if (!row) throw new Error("Akun tidak ditemukan.");
      const dipakai = await tx.execute({
        sql: "SELECT EXISTS(SELECT 1 FROM keu_jurnal_baris WHERE id_akun = ?) AS ada;",
        args: [idAkun],
      });
      const aturan = aturanUbahAkun(
        {
          kelompok: String(row.kelompok),
          saldo_normal: String(row.saldo_normal),
          sistem: AKUN_SISTEM_IDS.has(idAkun),
          punya_jurnal: Number(dipakai.rows[0]?.ada) === 1,
        },
        valid,
      );
      if (!aturan.ok) throw new Error(aturan.error);
    } else {
      idAkun = newId("akun-");
    }

    const kode = await tx.execute({
      sql: "SELECT EXISTS(SELECT 1 FROM keu_akun WHERE LOWER(kode) = LOWER(?) AND id_akun <> ?) AS ada;",
      args: [valid.kode, idAkun],
    });
    if (Number(kode.rows[0]?.ada) === 1) {
      throw new Error("Kode akun sudah dipakai akun lain.");
    }

    await tx.execute({
      sql: `INSERT INTO keu_akun (
              id_akun, kode, nama, kelompok, saldo_normal, is_aktif, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
            ON CONFLICT(id_akun) DO UPDATE SET
              kode = excluded.kode,
              nama = excluded.nama,
              kelompok = excluded.kelompok,
              saldo_normal = excluded.saldo_normal,
              is_aktif = excluded.is_aktif,
              updated_at = excluded.updated_at;`,
      args: [
        idAkun,
        valid.kode,
        valid.nama,
        valid.kelompok,
        valid.saldo_normal,
        valid.is_aktif ? 1 : 0,
      ],
    });
    return { sukses: true as const, id_akun: idAkun };
  });
}

// ── Jurnal ──────────────────────────────────────────────────────────────────

/** Cermin `assert_akun_aktif`: pesan menyebut baris pertama yang memakai akun itu. */
async function assertAkunAktif(tx: Executor, baris: BarisJurnalValid[]) {
  const diperiksa = new Set<string>();
  for (const [indeks, item] of baris.entries()) {
    if (diperiksa.has(item.id_akun)) continue;
    diperiksa.add(item.id_akun);
    const result = await tx.execute({
      sql: "SELECT is_aktif FROM keu_akun WHERE id_akun = ?;",
      args: [item.id_akun],
    });
    if (Number(result.rows[0]?.is_aktif ?? 0) !== 1) {
      throw new Error(
        `Baris ${indeks + 1}: akun tidak ditemukan atau nonaktif.`,
      );
    }
  }
}

export interface HeaderTulis {
  id_jurnal: string;
  tanggal: string;
  keterangan: string;
  sumber: SumberJurnal;
  id_sumber: string | null;
  id_jurnal_batal: string | null;
  dibuat_oleh: string;
}

export interface BarisTulis {
  id_baris: string;
  id_akun: string;
  debit: number;
  kredit: number;
  keterangan: string | null;
  urutan: number;
}

/**
 * Cermin `tulis_jurnal_tx`. Seri Web satu untuk seluruh server; nomor urutnya
 * dihitung di dalam transaksi tulis, sehingga dua permintaan bersamaan tidak
 * mendapat nomor yang sama.
 */
/** Nomor urut berikutnya untuk seri Web pada tahun itu. Panggil di dalam transaksi tulis. */
export async function nomorUrutBerikutnya(
  tx: Executor,
  tahun: string,
): Promise<number> {
  const urut = await tx.execute({
    sql: `SELECT COALESCE(MAX(nomor_urut), 0) + 1 AS n FROM keu_jurnal
          WHERE seri = ? AND substr(tanggal, 1, 4) = ?
          -- batas: agregat, selalu satu baris
          ;`,
    args: [SERI_WEB, tahun],
  });
  return Number(urut.rows[0]?.n ?? 1);
}

/**
 * Statement satu jurnal utuh bernomor `nomorUrut`. Dipakai `tulisJurnalTx`
 * dan penerbitan massal, yang mengirim ratusan jurnal dalam SATU batch
 * supaya tidak menjadi ribuan round-trip ke database jarak jauh.
 */
export function statementJurnal(
  header: HeaderTulis,
  baris: BarisTulis[],
  nomorUrut: number,
): InStatement[] {
  const tahun = header.tanggal.slice(0, 4);
  return [
    {
      sql: `INSERT INTO keu_jurnal (
              id_jurnal, tanggal, seri, nomor_urut, nomor, keterangan, sumber,
              id_sumber, id_jurnal_batal, dibuat_oleh, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
            ON CONFLICT(id_jurnal) DO NOTHING;`,
      args: [
        header.id_jurnal,
        header.tanggal,
        SERI_WEB,
        nomorUrut,
        formatNomorJurnal(tahun, SERI_WEB, nomorUrut),
        header.keterangan,
        header.sumber,
        header.id_sumber,
        header.id_jurnal_batal,
        header.dibuat_oleh,
      ],
    },
    ...baris.map((item) => ({
      sql: `INSERT INTO keu_jurnal_baris (
              id_baris, id_jurnal, id_akun, debit, kredit, keterangan, urutan
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id_baris) DO NOTHING;`,
      args: [
        item.id_baris,
        header.id_jurnal,
        item.id_akun,
        item.debit,
        item.kredit,
        item.keterangan,
        item.urutan,
      ],
    })),
  ];
}

export async function tulisJurnalTx(
  tx: Transaction,
  header: HeaderTulis,
  baris: BarisTulis[],
): Promise<string> {
  // Idempoten untuk id deterministik (`pay-<run>`, `jrn-cair-<pinjaman>`),
  // cermin `tulis_jurnal_tx`: jurnal yang sudah ada tidak ditulis ulang.
  const ada = await tx.execute({
    sql: "SELECT nomor FROM keu_jurnal WHERE id_jurnal = ?;",
    args: [header.id_jurnal],
  });
  if (ada.rows[0]) return String(ada.rows[0].nomor);
  await assertPeriodeTerbuka(tx, header.tanggal);
  const tahun = header.tanggal.slice(0, 4);
  const nomorUrut = await nomorUrutBerikutnya(tx, tahun);
  for (const statement of statementJurnal(header, baris, nomorUrut)) {
    await tx.execute(statement);
  }
  return formatNomorJurnal(tahun, SERI_WEB, nomorUrut);
}

/**
 * Cermin `balik_jurnal_tx`: pembalik untuk jurnal MODUL (kasbon), tanpa
 * pemeriksaan `sumber` milik `susunPembalik`. Bertanggal hari ini (WIB).
 */
export async function balikJurnalTx(
  tx: Transaction,
  idJurnal: string,
  keterangan: string,
  dibuatOleh: string,
): Promise<void> {
  const barisAsal = await tx.execute({
    sql: `SELECT id_baris, id_akun, debit, kredit, keterangan, urutan
          FROM keu_jurnal_baris WHERE id_jurnal = ?
          ORDER BY urutan, id_baris
          LIMIT 100;`,
    args: [idJurnal],
  });
  if (barisAsal.rows.length === 0) return;
  const hari = await tx.execute("SELECT date('now', '+7 hours') AS hari;");
  await tulisJurnalTx(
    tx,
    {
      id_jurnal: idPembalik(idJurnal),
      tanggal: String(hari.rows[0]?.hari ?? ""),
      keterangan,
      sumber: "Pembatalan",
      id_sumber: null,
      id_jurnal_batal: idJurnal,
      dibuat_oleh: dibuatOleh,
    },
    barisAsal.rows.map((item) => ({
      id_baris: idPembalik(String(item.id_baris)),
      id_akun: String(item.id_akun),
      debit: Number(item.kredit),
      kredit: Number(item.debit),
      keterangan: text(item.keterangan),
      urutan: Number(item.urutan),
    })),
  );
}

/** Cermin `assert_akun_bayar`: akun pembayaran wajib akun Aset yang aktif. */
export async function assertAkunBayar(tx: Executor, idAkun: string) {
  const result = await tx.execute({
    sql: "SELECT EXISTS(SELECT 1 FROM keu_akun WHERE id_akun = ? AND kelompok = 'Aset' AND is_aktif = 1) AS sah;",
    args: [idAkun],
  });
  if (Number(result.rows[0]?.sah) !== 1) {
    throw new Error("Akun pembayaran harus akun aset yang aktif.");
  }
}

export async function postJournal(
  client: Client,
  dibuatOleh: string,
  rawDraft: unknown,
): Promise<{ sukses: true; id_jurnal: string; nomor: string }> {
  const parsed = jurnalDraftSchema.safeParse(rawDraft);
  if (!parsed.success) throw new Error("Data jurnal tidak valid.");
  const hasil = validateJurnal(parsed.data);
  if (!hasil.ok) throw new Error(hasil.error);
  const valid = hasil.value;

  return withTransaction(client, async (tx) => {
    await assertAkunAktif(tx, valid.baris);
    const idJurnal = newId("jrn-");
    const nomor = await tulisJurnalTx(
      tx,
      {
        id_jurnal: idJurnal,
        tanggal: valid.tanggal,
        keterangan: valid.keterangan,
        sumber: "Manual",
        id_sumber: null,
        id_jurnal_batal: null,
        dibuat_oleh: dibuatOleh,
      },
      valid.baris.map((item, indeks) => ({
        id_baris: newId("jb-"),
        ...item,
        urutan: indeks + 1,
      })),
    );
    return { sukses: true as const, id_jurnal: idJurnal, nomor };
  });
}

export async function reverseJournal(
  client: Client,
  dibuatOleh: string,
  idJurnal: string,
  alasan: string,
): Promise<{ sukses: true; id_jurnal: string; nomor: string }> {
  return withTransaction(client, async (tx) => {
    const header = await tx.execute({
      sql: "SELECT nomor, sumber FROM keu_jurnal WHERE id_jurnal = ?;",
      args: [idJurnal],
    });
    const row = header.rows[0];
    if (!row) throw new Error("Jurnal tidak ditemukan.");
    const sudah = await tx.execute({
      sql: "SELECT EXISTS(SELECT 1 FROM keu_jurnal WHERE id_jurnal = ?) AS ada;",
      args: [idPembalik(idJurnal)],
    });
    if (Number(sudah.rows[0]?.ada) === 1) {
      throw new Error("Jurnal ini sudah dibatalkan.");
    }
    const barisAsal = await tx.execute({
      sql: `SELECT id_baris, id_akun, debit, kredit, keterangan, urutan
            FROM keu_jurnal_baris WHERE id_jurnal = ?
            ORDER BY urutan, id_baris
            LIMIT 100;`,
      args: [idJurnal],
    });
    const asal: JurnalAsal = {
      id_jurnal: idJurnal,
      nomor: String(row.nomor),
      sumber: String(row.sumber),
      baris: barisAsal.rows.map((item) => ({
        id_baris: String(item.id_baris),
        id_akun: String(item.id_akun),
        debit: Number(item.debit),
        kredit: Number(item.kredit),
        keterangan: text(item.keterangan),
        urutan: Number(item.urutan),
      })),
    };
    const pembalik = susunPembalik(asal, alasan);
    if (!pembalik.ok) throw new Error(pembalik.error);

    // Pembalik bertanggal hari pembatalan (WIB), bukan tanggal jurnal asal.
    const hari = await tx.execute("SELECT date('now', '+7 hours') AS hari;");
    const nomor = await tulisJurnalTx(
      tx,
      {
        id_jurnal: pembalik.value.id_jurnal,
        tanggal: String(hari.rows[0]?.hari ?? ""),
        keterangan: pembalik.value.keterangan,
        sumber: "Pembatalan",
        id_sumber: null,
        id_jurnal_batal: idJurnal,
        dibuat_oleh: dibuatOleh,
      },
      pembalik.value.baris,
    );
    return {
      sukses: true as const,
      id_jurnal: pembalik.value.id_jurnal,
      nomor,
    };
  });
}

// ── Pembacaan ───────────────────────────────────────────────────────────────

export async function listJournals(
  client: Client,
  dari: string,
  sampai: string,
  sumber: string | null,
): Promise<{ items: JurnalItem[] }> {
  assertRentang(dari, sampai);
  const sumberBersih = sumber?.trim() || null;
  if (
    sumberBersih &&
    !(SUMBER_JURNAL as readonly string[]).includes(sumberBersih)
  ) {
    throw new Error("Sumber jurnal tidak dikenal.");
  }
  let query = `SELECT j.id_jurnal, j.tanggal, j.nomor, j.keterangan, j.sumber, j.id_jurnal_batal,
           j.dibuat_oleh, j.created_at,
           COALESCE((SELECT SUM(b.debit) FROM keu_jurnal_baris b WHERE b.id_jurnal = j.id_jurnal), 0) AS total,
           EXISTS(SELECT 1 FROM keu_jurnal x WHERE x.id_jurnal = 'batal-' || j.id_jurnal) AS dibatalkan,
           (SELECT COUNT(*) FROM keu_jurnal y WHERE y.nomor = j.nomor) > 1 AS nomor_ganda
    FROM keu_jurnal j
    WHERE j.tanggal >= ? AND j.tanggal <= ?`;
  const args: string[] = [dari, sampai];
  if (sumberBersih) {
    query += " AND j.sumber = ?";
    args.push(sumberBersih);
  }
  // `LIMIT 300` = `BATAS_DAFTAR_JURNAL`.
  query +=
    " ORDER BY j.tanggal DESC, j.created_at DESC, j.id_jurnal DESC LIMIT 300;";
  const result = await client.execute({ sql: query, args });
  return {
    items: result.rows.map((row) => ({
      id_jurnal: String(row.id_jurnal),
      tanggal: String(row.tanggal),
      nomor: String(row.nomor),
      keterangan: String(row.keterangan),
      sumber: String(row.sumber) as SumberJurnal,
      id_jurnal_batal: text(row.id_jurnal_batal),
      dibuat_oleh: String(row.dibuat_oleh),
      created_at: String(row.created_at),
      total: Number(row.total),
      dibatalkan: Number(row.dibatalkan) === 1,
      nomor_ganda: Number(row.nomor_ganda) === 1,
    })),
  };
}

export async function getJournal(
  client: Client,
  idJurnal: string,
): Promise<JurnalDetail> {
  const header = await client.execute({
    sql: `SELECT j.id_jurnal, j.tanggal, j.nomor, j.keterangan, j.sumber, j.id_sumber,
                 j.id_jurnal_batal, j.dibuat_oleh, j.created_at,
                 (SELECT x.nomor FROM keu_jurnal x WHERE x.id_jurnal = 'batal-' || j.id_jurnal) AS nomor_pembalik
          FROM keu_jurnal j WHERE j.id_jurnal = ?;`,
    args: [idJurnal],
  });
  const row = header.rows[0];
  if (!row) throw new Error("Jurnal tidak ditemukan.");
  const baris = await client.execute({
    sql: `SELECT b.id_baris, b.id_akun, COALESCE(a.kode, '') AS kode_akun,
                 COALESCE(a.nama, b.id_akun) AS nama_akun, b.debit, b.kredit, b.keterangan, b.urutan
          FROM keu_jurnal_baris b
          LEFT JOIN keu_akun a ON a.id_akun = b.id_akun
          WHERE b.id_jurnal = ?
          ORDER BY b.urutan, b.id_baris
          LIMIT 100;`,
    args: [idJurnal],
  });
  return {
    jurnal: {
      id_jurnal: String(row.id_jurnal),
      tanggal: String(row.tanggal),
      nomor: String(row.nomor),
      keterangan: String(row.keterangan),
      sumber: String(row.sumber) as SumberJurnal,
      id_sumber: text(row.id_sumber),
      id_jurnal_batal: text(row.id_jurnal_batal),
      dibuat_oleh: String(row.dibuat_oleh),
      created_at: String(row.created_at),
      nomor_pembalik: text(row.nomor_pembalik),
    },
    baris: baris.rows.map((item) => ({
      id_baris: String(item.id_baris),
      id_akun: String(item.id_akun),
      kode_akun: String(item.kode_akun),
      nama_akun: String(item.nama_akun),
      debit: Number(item.debit),
      kredit: Number(item.kredit),
      keterangan: text(item.keterangan),
      urutan: Number(item.urutan),
    })),
  };
}

/** Cermin `ledger`: saldo akhir dari agregat, tetap benar meski baris terpotong. */
export async function ledger(
  client: Client,
  idAkun: string,
  dari: string,
  sampai: string,
): Promise<BukuBesar> {
  assertRentang(dari, sampai);
  const akunRes = await client.execute({
    sql: `SELECT id_akun, kode, nama, kelompok, saldo_normal, is_aktif
          FROM keu_akun WHERE id_akun = ?;`,
    args: [idAkun],
  });
  const akunRow = akunRes.rows[0];
  if (!akunRow) throw new Error("Akun tidak ditemukan.");
  const saldoNormal = String(akunRow.saldo_normal) as SaldoNormal;

  const awal = await client.execute({
    sql: `SELECT COALESCE(SUM(b.debit), 0) AS debit, COALESCE(SUM(b.kredit), 0) AS kredit
          FROM keu_jurnal_baris b
          JOIN keu_jurnal j ON j.id_jurnal = b.id_jurnal
          WHERE b.id_akun = ? AND j.tanggal < ?
          -- batas: agregat, selalu satu baris
          ;`,
    args: [idAkun, dari],
  });
  const periode = await client.execute({
    sql: `SELECT COALESCE(SUM(b.debit), 0) AS debit, COALESCE(SUM(b.kredit), 0) AS kredit,
                 COUNT(*) AS jumlah
          FROM keu_jurnal_baris b
          JOIN keu_jurnal j ON j.id_jurnal = b.id_jurnal
          WHERE b.id_akun = ? AND j.tanggal >= ? AND j.tanggal <= ?
          -- batas: agregat, selalu satu baris
          ;`,
    args: [idAkun, dari, sampai],
  });
  const rows = await client.execute({
    sql: `SELECT j.id_jurnal, j.tanggal, j.nomor, j.keterangan, j.sumber,
                 b.keterangan AS keterangan_baris, b.debit, b.kredit
          FROM keu_jurnal_baris b
          JOIN keu_jurnal j ON j.id_jurnal = b.id_jurnal
          WHERE b.id_akun = ? AND j.tanggal >= ? AND j.tanggal <= ?
          ORDER BY j.tanggal, j.created_at, j.id_jurnal, b.urutan
          LIMIT 1000;`,
    args: [idAkun, dari, sampai],
  });

  const saldoAwal = saldoAkun(
    saldoNormal,
    Number(awal.rows[0]?.debit ?? 0),
    Number(awal.rows[0]?.kredit ?? 0),
  );
  const totalDebit = Number(periode.rows[0]?.debit ?? 0);
  const totalKredit = Number(periode.rows[0]?.kredit ?? 0);
  const mutasi = rows.rows.map((row) => ({
    debit: Number(row.debit),
    kredit: Number(row.kredit),
  }));
  const saldo = saldoBerjalan(saldoNormal, saldoAwal, mutasi);

  return {
    akun: {
      id_akun: String(akunRow.id_akun),
      kode: String(akunRow.kode),
      nama: String(akunRow.nama),
      kelompok: String(akunRow.kelompok) as BukuBesar["akun"]["kelompok"],
      saldo_normal: saldoNormal,
      is_aktif: Number(akunRow.is_aktif),
    },
    saldo_awal: saldoAwal,
    total_debit: totalDebit,
    total_kredit: totalKredit,
    saldo_akhir: saldoAwal + saldoAkun(saldoNormal, totalDebit, totalKredit),
    terpotong: Number(periode.rows[0]?.jumlah ?? 0) > MAKS_BARIS_BUKU_BESAR,
    baris: rows.rows.map((row, indeks) => ({
      id_jurnal: String(row.id_jurnal),
      tanggal: String(row.tanggal),
      nomor: String(row.nomor),
      keterangan: text(row.keterangan_baris) ?? String(row.keterangan),
      sumber: String(row.sumber) as SumberJurnal,
      debit: mutasi[indeks].debit,
      kredit: mutasi[indeks].kredit,
      saldo: saldo[indeks],
    })),
  };
}

/** Cermin `trial_balance`. Baris tanpa header (belum tersinkron) tidak dihitung. */
export async function trialBalance(
  client: Client,
  sampai: string,
): Promise<NeracaSaldo> {
  if (!isValidDate(sampai)) throw new Error("Tanggal tidak valid.");
  const result = await client.execute({
    sql: `SELECT a.id_akun, a.kode, a.nama, a.kelompok, a.saldo_normal, a.is_aktif,
                 COALESCE(t.debit, 0) AS debit, COALESCE(t.kredit, 0) AS kredit
          FROM keu_akun a
          LEFT JOIN (
              SELECT b.id_akun, SUM(b.debit) AS debit, SUM(b.kredit) AS kredit
              FROM keu_jurnal_baris b
              JOIN keu_jurnal j ON j.id_jurnal = b.id_jurnal
              WHERE j.tanggal <= ?
              GROUP BY b.id_akun
          ) t ON t.id_akun = a.id_akun
          ORDER BY a.kode, a.id_akun
          LIMIT 1000;`,
    args: [sampai],
  });
  let totalDebit = 0;
  let totalKredit = 0;
  const items = result.rows
    .filter(
      (row) =>
        Number(row.is_aktif) === 1 ||
        Number(row.debit) !== 0 ||
        Number(row.kredit) !== 0,
    )
    .map((row) => {
      const kolom = kolomNeracaSaldo(Number(row.debit), Number(row.kredit));
      totalDebit += kolom.debit;
      totalKredit += kolom.kredit;
      return {
        id_akun: String(row.id_akun),
        kode: String(row.kode),
        nama: String(row.nama),
        kelompok: String(
          row.kelompok,
        ) as NeracaSaldo["items"][number]["kelompok"],
        saldo_normal: String(row.saldo_normal) as SaldoNormal,
        debit: kolom.debit,
        kredit: kolom.kredit,
      };
    });
  return { items, total_debit: totalDebit, total_kredit: totalKredit };
}

// ── Laporan keuangan perusahaan (K4a) ──────────────────────────────────────────

/** Cermin `saldo_per_akun`. */
async function saldoPerAkun(
  client: Client,
  dari: string,
  sampai: string,
): Promise<AkunSaldo[]> {
  const result = await client.execute({
    sql: `SELECT a.id_akun, a.kode, a.nama, a.kelompok, a.saldo_normal,
                 COALESCE(t.debit, 0) AS debit, COALESCE(t.kredit, 0) AS kredit
          FROM keu_akun a
          LEFT JOIN (
              SELECT b.id_akun, SUM(b.debit) AS debit, SUM(b.kredit) AS kredit
              FROM keu_jurnal_baris b
              JOIN keu_jurnal j ON j.id_jurnal = b.id_jurnal
              WHERE j.tanggal >= ?1 AND j.tanggal <= ?2
              GROUP BY b.id_akun
          ) t ON t.id_akun = a.id_akun
          ORDER BY a.kode, a.id_akun
          LIMIT 1000;`,
    args: [dari, sampai],
  });
  return result.rows.map((row) => ({
    id_akun: String(row.id_akun),
    kode: String(row.kode),
    nama: String(row.nama),
    kelompok: String(row.kelompok),
    saldo_normal: String(row.saldo_normal),
    debit: Number(row.debit),
    kredit: Number(row.kredit),
  }));
}

/** Cermin `report_position`. */
export async function reportPosition(
  client: Client,
  sampai: string,
): Promise<LaporanPosisiKeuangan> {
  if (!isValidDate(sampai)) throw new Error("Tanggal tidak valid.");
  return {
    sampai,
    ...susunPosisiKeuangan(await saldoPerAkun(client, "0001-01-01", sampai)),
  };
}

/** Cermin `report_activity`. */
export async function reportActivity(
  client: Client,
  dari: string,
  sampai: string,
): Promise<LaporanAktivitas> {
  assertRentang(dari, sampai);
  return {
    dari,
    sampai,
    ...susunAktivitas(await saldoPerAkun(client, dari, sampai)),
  };
}

/** Cermin `report_cashflow`. */
export async function reportCashflow(
  client: Client,
  dari: string,
  sampai: string,
  akunKas: readonly string[],
): Promise<LaporanArusKas> {
  assertRentang(dari, sampai);
  const akun: string[] = [];
  for (const id of akunKas) {
    const bersih = id.trim();
    if (bersih && !akun.includes(bersih)) akun.push(bersih);
  }
  if (akun.length === 0) throw new Error("Pilih minimal satu akun kas.");
  if (akun.length > MAKS_AKUN_KAS)
    throw new Error("Akun kas paling banyak 20.");
  const namaAkun: LaporanArusKas["akun_kas"] = [];
  for (const id of akun) {
    const baris = await client.execute({
      sql: "SELECT kode, nama, kelompok FROM keu_akun WHERE id_akun = ?;",
      args: [id],
    });
    const row = baris.rows[0];
    if (!row || String(row.kelompok) !== "Aset") {
      throw new Error("Akun kas harus akun aset.");
    }
    namaAkun.push({
      id_akun: id,
      kode: String(row.kode),
      nama: String(row.nama),
    });
  }
  const daftar = akun.map((_, i) => `?${i + 3}`).join(", ");
  const args = [dari, sampai, ...akun];
  const awal = await client.execute({
    sql: `SELECT COALESCE(SUM(b.debit - b.kredit), 0) AS saldo
          FROM keu_jurnal_baris b
          JOIN keu_jurnal j ON j.id_jurnal = b.id_jurnal
          WHERE j.tanggal < ?1 AND b.id_akun IN (${daftar})
          -- batas: agregat, selalu satu baris
          ;`,
    args,
  });
  const mutasi = await client.execute({
    sql: `SELECT COALESCE(asal.sumber, j.sumber) AS sumber,
                 SUM(b.debit) AS debit, SUM(b.kredit) AS kredit
          FROM keu_jurnal_baris b
          JOIN keu_jurnal j ON j.id_jurnal = b.id_jurnal
          LEFT JOIN keu_jurnal asal ON asal.id_jurnal = j.id_jurnal_batal
          WHERE j.tanggal >= ?1 AND j.tanggal <= ?2 AND b.id_akun IN (${daftar})
          GROUP BY 1
          -- batas: agregat per sumber jurnal
          ;`,
    args,
  });
  return {
    dari,
    sampai,
    akun_kas: namaAkun,
    ...susunArusKas(
      Number(awal.rows[0]?.saldo ?? 0),
      mutasi.rows.map((row) => ({
        sumber: String(row.sumber),
        debit: Number(row.debit),
        kredit: Number(row.kredit),
      })),
    ),
  };
}
