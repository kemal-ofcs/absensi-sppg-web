import "server-only";

import { randomBytes } from "node:crypto";
import type { Client, Transaction } from "@libsql/client";
import {
  assertAkunBayar,
  type BarisTulis,
  balikJurnalTx,
  tulisJurnalTx,
} from "@/lib/services/accounting";
import { idPembalik } from "@/lib/validations/accounting";
import {
  AKUN_KAS,
  AKUN_PIUTANG_KARYAWAN,
  aturanKeputusan,
  type ItemPayroll,
  idAngsuranGaji,
  idJurnalPayroll,
  idJurnalPencairan,
  idPembatalanPinjaman,
  idPencairan,
  idTunda,
  isValidPeriode,
  MAKS_KETERANGAN_PINJAMAN,
  type PinjamanAktif,
  pinjamanDraftSchema,
  type StatusPinjaman,
  susunJurnalPayroll,
  validatePelunasan,
  validatePinjaman,
} from "@/lib/validations/loan";
import type { DetailPinjaman, OrangPeminjam, PinjamanItem } from "@/types/loan";

/**
 * Sisi Web kasbon karyawan, cermin `desktop/loan.rs`. Pesan galat wajib sama
 * dengan Rust. Web menulis langsung ke database cloud; trigger `sync_pulse`
 * membuat setiap perangkat menarik perubahannya.
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

async function hariIni(tx: Executor): Promise<string> {
  const result = await tx.execute("SELECT date('now', '+7 hours') AS hari;");
  return String(result.rows[0]?.hari ?? "");
}

/**
 * Cermin `TERPOTONG_BULAN_SQL`: potongan kasbon yang sudah masuk proses gaji
 * (selain yang ditolak) di bulan yang sama menurut bulan `period_start`.
 * Cicilan adalah jatah per bulan, bukan per proses gaji.
 */
const TERPOTONG_BULAN_SQL = `COALESCE((
        SELECT SUM(CAST(json_extract(k.value, '$.jumlah') AS INTEGER))
        FROM payroll_items i
        JOIN payroll_runs r ON r.id = i.payroll_run_id,
             json_each(i.breakdown_snapshot, '$.kasbon') k
        WHERE r.status <> 'REJECTED'
          AND substr(r.period_start, 1, 7) = ?1
          AND json_extract(k.value, '$.id_pinjaman') = p.id_pinjaman
    ), 0)`;

/** Cermin `PENDING_SQL`: potongan di proses gaji yang belum dibayar/ditolak. */
const PENDING_SQL = `COALESCE((
        SELECT SUM(CAST(json_extract(k.value, '$.jumlah') AS INTEGER))
        FROM payroll_items i
        JOIN payroll_runs r ON r.id = i.payroll_run_id,
             json_each(i.breakdown_snapshot, '$.kasbon') k
        WHERE r.status NOT IN ('PAID', 'REJECTED')
          AND json_extract(k.value, '$.id_pinjaman') = p.id_pinjaman
    ), 0)`;

const BAYAR_SQL = `COALESCE((
        SELECT SUM(m.jumlah) FROM keu_pinjaman_mutasi m
        WHERE m.id_pinjaman = p.id_pinjaman
          AND m.jenis IN ('Angsuran Gaji', 'Pelunasan Tunai')
    ), 0)`;

// ── Pembacaan ───────────────────────────────────────────────────────────────

export async function listLoans(
  client: Client,
): Promise<{ items: PinjamanItem[] }> {
  const result = await client.execute(
    `SELECT p.id_pinjaman, p.id_karyawan, p.nama_karyawan, p.pokok, p.cicilan,
            p.mulai_potong, p.keterangan, p.status, p.tanggal_pengajuan, p.tanggal_cair,
            ${BAYAR_SQL} AS bayar,
            ${PENDING_SQL} AS pending,
            (SELECT group_concat(t.periode, ',') FROM keu_pinjaman_tunda t
              WHERE t.id_pinjaman = p.id_pinjaman) AS tunda
     FROM keu_pinjaman p
     ORDER BY CASE p.status WHEN 'Diajukan' THEN 0 WHEN 'Disetujui' THEN 1 ELSE 2 END,
              p.created_at DESC, p.id_pinjaman
     LIMIT 1000;`,
  );
  return {
    items: result.rows.map((row) => {
      const pokok = Number(row.pokok);
      const bayar = Number(row.bayar);
      const status = String(row.status) as StatusPinjaman;
      const sisa = pokok - bayar;
      return {
        id_pinjaman: String(row.id_pinjaman),
        id_karyawan: String(row.id_karyawan),
        nama_karyawan: String(row.nama_karyawan),
        pokok,
        cicilan: Number(row.cicilan),
        mulai_potong: String(row.mulai_potong),
        keterangan: text(row.keterangan),
        lebih_potong: status === "Disetujui" && sisa < 0,
        status,
        tanggal_pengajuan: String(row.tanggal_pengajuan),
        tanggal_cair: text(row.tanggal_cair),
        terbayar: bayar,
        sisa,
        potongan_tertunda: Number(row.pending),
        tunda: row.tunda ? String(row.tunda).split(",") : [],
      };
    }),
  };
}

export async function loanDetail(
  client: Client,
  idPinjaman: string,
): Promise<DetailPinjaman> {
  const pinjaman = await client.execute({
    sql: `SELECT id_pinjaman, id_karyawan, nama_karyawan, pokok, cicilan, mulai_potong,
                 keterangan, status, tanggal_pengajuan, diajukan_oleh, diputuskan_oleh,
                 tanggal_cair, id_akun_kas, created_at, updated_at
          FROM keu_pinjaman WHERE id_pinjaman = ?;`,
    args: [idPinjaman],
  });
  const row = pinjaman.rows[0];
  if (!row) throw new Error("Pinjaman tidak ditemukan.");
  const mutasi = await client.execute({
    sql: `SELECT id_mutasi, jenis, jumlah, tanggal, id_ref, id_jurnal, dicatat_oleh, created_at
          FROM keu_pinjaman_mutasi WHERE id_pinjaman = ?
          ORDER BY tanggal, created_at, id_mutasi
          LIMIT 500;`,
    args: [idPinjaman],
  });
  const tunda = await client.execute({
    sql: `SELECT id_tunda, periode, alasan, dibuat_oleh FROM keu_pinjaman_tunda
          WHERE id_pinjaman = ? ORDER BY periode LIMIT 200;`,
    args: [idPinjaman],
  });
  return {
    pinjaman: {
      id_pinjaman: String(row.id_pinjaman),
      id_karyawan: String(row.id_karyawan),
      nama_karyawan: String(row.nama_karyawan),
      pokok: Number(row.pokok),
      cicilan: Number(row.cicilan),
      mulai_potong: String(row.mulai_potong),
      keterangan: text(row.keterangan),
      status: String(row.status) as StatusPinjaman,
      tanggal_pengajuan: String(row.tanggal_pengajuan),
      diajukan_oleh: String(row.diajukan_oleh),
      diputuskan_oleh: text(row.diputuskan_oleh),
      tanggal_cair: text(row.tanggal_cair),
      id_akun_kas: text(row.id_akun_kas),
      created_at: String(row.created_at),
      updated_at: String(row.updated_at),
    },
    mutasi: mutasi.rows.map((item) => ({
      id_mutasi: String(item.id_mutasi),
      jenis: String(item.jenis) as DetailPinjaman["mutasi"][number]["jenis"],
      jumlah: Number(item.jumlah),
      tanggal: String(item.tanggal),
      id_ref: text(item.id_ref),
      id_jurnal: text(item.id_jurnal),
      dicatat_oleh: String(item.dicatat_oleh),
      created_at: String(item.created_at),
    })),
    tunda: tunda.rows.map((item) => ({
      id_tunda: String(item.id_tunda),
      periode: String(item.periode),
      alasan: text(item.alasan),
      dibuat_oleh: String(item.dibuat_oleh),
    })),
  };
}

/** Cermin `loan_people`: personil aktif, dengan izin kasbon. */
export async function loanPeople(
  client: Client,
): Promise<{ items: OrangPeminjam[] }> {
  const result = await client.execute(
    `SELECT id_unik, nama, divisi FROM master_data
     WHERE COALESCE(status_aktif, 'Aktif') = 'Aktif'
     ORDER BY nama, id_unik
     LIMIT 3000;`,
  );
  return {
    items: result.rows.map((row) => ({
      id_karyawan: String(row.id_unik),
      nama: String(row.nama),
      divisi: String(row.divisi),
    })),
  };
}

// ── Penulisan ───────────────────────────────────────────────────────────────

export async function saveLoan(
  client: Client,
  operator: string,
  rawDraft: unknown,
): Promise<{ sukses: true; id_pinjaman: string }> {
  const parsed = pinjamanDraftSchema.safeParse(rawDraft);
  if (!parsed.success) throw new Error("Data pinjaman tidak valid.");
  const hasil = validatePinjaman(parsed.data);
  if (!hasil.ok) throw new Error(hasil.error);
  const valid = hasil.value;

  return withTransaction(client, async (tx) => {
    const orang = await tx.execute({
      sql: "SELECT nama FROM master_data WHERE id_unik = ?;",
      args: [valid.id_karyawan],
    });
    if (!orang.rows[0]) throw new Error("Karyawan tidak ditemukan.");
    let idPinjaman = parsed.data.id_pinjaman?.trim() ?? "";
    if (idPinjaman) {
      const lama = await tx.execute({
        sql: "SELECT status FROM keu_pinjaman WHERE id_pinjaman = ?;",
        args: [idPinjaman],
      });
      if (!lama.rows[0]) throw new Error("Pinjaman tidak ditemukan.");
      if (String(lama.rows[0].status) !== "Diajukan") {
        throw new Error("Hanya pengajuan yang bisa diubah.");
      }
    } else {
      idPinjaman = newId("pjm-");
    }
    await tx.execute({
      sql: `INSERT INTO keu_pinjaman (
              id_pinjaman, id_karyawan, nama_karyawan, pokok, cicilan, mulai_potong,
              keterangan, status, tanggal_pengajuan, diajukan_oleh, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 'Diajukan', ?, ?, datetime('now'), datetime('now'))
            ON CONFLICT(id_pinjaman) DO UPDATE SET
              id_karyawan = excluded.id_karyawan,
              nama_karyawan = excluded.nama_karyawan,
              pokok = excluded.pokok,
              cicilan = excluded.cicilan,
              mulai_potong = excluded.mulai_potong,
              keterangan = excluded.keterangan,
              updated_at = excluded.updated_at;`,
      args: [
        idPinjaman,
        valid.id_karyawan,
        String(orang.rows[0].nama),
        valid.pokok,
        valid.cicilan,
        valid.mulai_potong,
        valid.keterangan,
        await hariIni(tx),
        operator,
      ],
    });
    return { sukses: true as const, id_pinjaman: idPinjaman };
  });
}

/** Cermin `catat_mutasi_tx`: `OR IGNORE` untuk id deterministik. */
async function catatMutasiTx(
  tx: Transaction,
  data: {
    id_mutasi: string;
    id_pinjaman: string;
    jenis: string;
    jumlah: number;
    tanggal: string;
    id_ref: string | null;
    id_jurnal: string | null;
    dicatat_oleh: string;
  },
) {
  await tx.execute({
    sql: `INSERT OR IGNORE INTO keu_pinjaman_mutasi (
            id_mutasi, id_pinjaman, jenis, jumlah, tanggal, id_ref, id_jurnal,
            dicatat_oleh, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'));`,
    args: [
      data.id_mutasi,
      data.id_pinjaman,
      data.jenis,
      data.jumlah,
      data.tanggal,
      data.id_ref,
      data.id_jurnal,
      data.dicatat_oleh,
    ],
  });
}

function barisDua(
  debitAkun: string,
  kreditAkun: string,
  jumlah: number,
  prefix: string,
): BarisTulis[] {
  return [
    {
      id_baris: `${prefix}-1`,
      id_akun: debitAkun,
      debit: jumlah,
      kredit: 0,
      keterangan: null,
      urutan: 1,
    },
    {
      id_baris: `${prefix}-2`,
      id_akun: kreditAkun,
      debit: 0,
      kredit: jumlah,
      keterangan: null,
      urutan: 2,
    },
  ];
}

async function sisaEfektif(tx: Executor, idPinjaman: string) {
  const result = await tx.execute({
    sql: `SELECT p.pokok - ${BAYAR_SQL} - ${PENDING_SQL} AS sisa
          FROM keu_pinjaman p WHERE p.id_pinjaman = ?;`,
    args: [idPinjaman],
  });
  return Number(result.rows[0]?.sisa ?? 0);
}

export async function decideLoan(
  client: Client,
  operator: string,
  idPinjaman: string,
  aksi: string,
  idAkunKas: string | null,
): Promise<{ sukses: true; status: StatusPinjaman }> {
  return withTransaction(client, async (tx) => {
    const lama = await tx.execute({
      sql: "SELECT status, pokok, nama_karyawan FROM keu_pinjaman WHERE id_pinjaman = ?;",
      args: [idPinjaman],
    });
    const row = lama.rows[0];
    if (!row) throw new Error("Pinjaman tidak ditemukan.");
    const angsuran = await tx.execute({
      sql: `SELECT EXISTS(SELECT 1 FROM keu_pinjaman_mutasi
                          WHERE id_pinjaman = ? AND jenis IN ('Angsuran Gaji', 'Pelunasan Tunai')) AS ada;`,
      args: [idPinjaman],
    });
    const keputusan = aturanKeputusan(
      String(row.status),
      aksi,
      Number(angsuran.rows[0]?.ada) === 1,
    );
    if (!keputusan.ok) throw new Error(keputusan.error);
    const statusBaru = keputusan.value;
    const pokok = Number(row.pokok);
    const nama = String(row.nama_karyawan);
    const tanggal = await hariIni(tx);

    if (aksi === "setujui") {
      const akun = idAkunKas || AKUN_KAS;
      await assertAkunBayar(tx, akun);
      await tx.execute({
        sql: `UPDATE keu_pinjaman SET status = ?, diputuskan_oleh = ?, tanggal_cair = ?,
                     id_akun_kas = ?, updated_at = datetime('now')
              WHERE id_pinjaman = ?;`,
        args: [statusBaru, operator, tanggal, akun, idPinjaman],
      });
      const idJurnal = idJurnalPencairan(idPinjaman);
      await tulisJurnalTx(
        tx,
        {
          id_jurnal: idJurnal,
          tanggal,
          keterangan: `Pencairan kasbon ${nama}`,
          sumber: "Kasbon",
          id_sumber: idPinjaman,
          id_jurnal_batal: null,
          dibuat_oleh: operator,
        },
        barisDua(AKUN_PIUTANG_KARYAWAN, akun, pokok, idJurnal),
      );
      await catatMutasiTx(tx, {
        id_mutasi: idPencairan(idPinjaman),
        id_pinjaman: idPinjaman,
        jenis: "Pencairan",
        jumlah: pokok,
        tanggal,
        id_ref: null,
        id_jurnal: idJurnal,
        dicatat_oleh: operator,
      });
    } else if (aksi === "tolak") {
      await tx.execute({
        sql: `UPDATE keu_pinjaman SET status = ?, diputuskan_oleh = ?, updated_at = datetime('now')
              WHERE id_pinjaman = ?;`,
        args: [statusBaru, operator, idPinjaman],
      });
    } else {
      await tx.execute({
        sql: `UPDATE keu_pinjaman SET status = ?, updated_at = datetime('now')
              WHERE id_pinjaman = ?;`,
        args: [statusBaru, idPinjaman],
      });
      const idJurnal = idJurnalPencairan(idPinjaman);
      await balikJurnalTx(tx, idJurnal, `Pembatalan kasbon ${nama}`, operator);
      await catatMutasiTx(tx, {
        id_mutasi: idPembatalanPinjaman(idPinjaman),
        id_pinjaman: idPinjaman,
        jenis: "Pembatalan",
        jumlah: pokok,
        tanggal,
        id_ref: null,
        id_jurnal: idPembalik(idJurnal),
        dicatat_oleh: operator,
      });
    }
    return { sukses: true as const, status: statusBaru };
  });
}

export async function payOffLoan(
  client: Client,
  operator: string,
  idPinjaman: string,
  jumlah: number,
  idAkunKas: string | null,
): Promise<{ sukses: true; id_mutasi: string }> {
  return withTransaction(client, async (tx) => {
    const lama = await tx.execute({
      sql: "SELECT status, nama_karyawan FROM keu_pinjaman WHERE id_pinjaman = ?;",
      args: [idPinjaman],
    });
    const row = lama.rows[0];
    if (!row) throw new Error("Pinjaman tidak ditemukan.");
    if (String(row.status) !== "Disetujui") {
      throw new Error(
        "Hanya pinjaman yang sudah disetujui yang bisa dilunasi.",
      );
    }
    const cek = validatePelunasan(jumlah, await sisaEfektif(tx, idPinjaman));
    if (!cek.ok) throw new Error(cek.error);
    const akun = idAkunKas || AKUN_KAS;
    await assertAkunBayar(tx, akun);

    const tanggal = await hariIni(tx);
    const idMutasi = newId("lns-");
    const idJurnal = `jrn-${idMutasi}`;
    await tulisJurnalTx(
      tx,
      {
        id_jurnal: idJurnal,
        tanggal,
        keterangan: `Pelunasan kasbon ${String(row.nama_karyawan)}`,
        sumber: "Kasbon",
        id_sumber: idPinjaman,
        id_jurnal_batal: null,
        dibuat_oleh: operator,
      },
      barisDua(akun, AKUN_PIUTANG_KARYAWAN, jumlah, idJurnal),
    );
    await catatMutasiTx(tx, {
      id_mutasi: idMutasi,
      id_pinjaman: idPinjaman,
      jenis: "Pelunasan Tunai",
      jumlah,
      tanggal,
      id_ref: null,
      id_jurnal: idJurnal,
      dicatat_oleh: operator,
    });
    return { sukses: true as const, id_mutasi: idMutasi };
  });
}

export async function deferLoan(
  client: Client,
  operator: string,
  idPinjaman: string,
  periode: string,
  alasanMentah: string | null,
): Promise<{ sukses: true; id_tunda: string }> {
  if (!isValidPeriode(periode)) {
    throw new Error("Bulan penundaan tidak valid.");
  }
  const alasan = alasanMentah?.trim() || null;
  if (alasan && Array.from(alasan).length > MAKS_KETERANGAN_PINJAMAN) {
    throw new Error("Alasan penundaan maksimal 100 karakter.");
  }
  const status = await client.execute({
    sql: "SELECT status FROM keu_pinjaman WHERE id_pinjaman = ?;",
    args: [idPinjaman],
  });
  if (String(status.rows[0]?.status ?? "") !== "Disetujui") {
    throw new Error("Hanya pinjaman yang sudah disetujui yang bisa ditunda.");
  }
  const id = idTunda(idPinjaman, periode);
  await client.execute({
    sql: `INSERT OR IGNORE INTO keu_pinjaman_tunda (id_tunda, id_pinjaman, periode, alasan, dibuat_oleh, created_at)
          VALUES (?, ?, ?, ?, ?, datetime('now'));`,
    args: [id, idPinjaman, periode, alasan, operator],
  });
  return { sukses: true as const, id_tunda: id };
}

export async function undeferLoan(
  client: Client,
  idTundaHapus: string,
): Promise<{ sukses: true }> {
  await client.execute({
    sql: "DELETE FROM keu_pinjaman_tunda WHERE id_tunda = ?;",
    args: [idTundaHapus],
  });
  return { sukses: true as const };
}

// ── Integrasi payroll ───────────────────────────────────────────────────────

/** Cermin `pinjaman_aktif`: per karyawan, pinjaman tertua lebih dulu, yang lunas tidak ikut. */
export async function pinjamanAktif(
  client: Executor,
  bulan: string,
): Promise<Map<string, PinjamanAktif[]>> {
  const result = await client.execute({
    sql: `SELECT p.id_karyawan, p.id_pinjaman,
                 p.cicilan - ${TERPOTONG_BULAN_SQL} AS cicilan_sisa,
                 p.pokok - ${BAYAR_SQL} - ${PENDING_SQL} AS sisa_efektif
          FROM keu_pinjaman p
          WHERE p.status = 'Disetujui' AND p.mulai_potong <= ?1
            AND NOT EXISTS (SELECT 1 FROM keu_pinjaman_tunda t
                            WHERE t.id_pinjaman = p.id_pinjaman AND t.periode = ?1)
          ORDER BY p.id_karyawan, p.tanggal_cair, p.created_at, p.id_pinjaman
          LIMIT 5000;`,
    args: [bulan],
  });
  const hasil = new Map<string, PinjamanAktif[]>();
  for (const row of result.rows) {
    const sisa = Number(row.sisa_efektif);
    const cicilan = Number(row.cicilan_sisa);
    // Lunas, atau jatah bulan ini sudah terpenuhi.
    if (sisa <= 0 || cicilan <= 0) continue;
    const id = String(row.id_karyawan);
    const daftar = hasil.get(id) ?? [];
    daftar.push({
      id_pinjaman: String(row.id_pinjaman),
      cicilan,
      sisa_efektif: sisa,
    });
    hasil.set(id, daftar);
  }
  return hasil;
}

/** Cermin `catat_pembayaran_payroll_tx`: angsuran + jurnal payroll, di transaksi transisi PAID. */
export async function catatPembayaranPayrollTx(
  tx: Transaction,
  runId: string,
  idAkunBayar: string,
  operator: string,
): Promise<void> {
  const run = await tx.execute({
    sql: "SELECT period_start, period_end FROM payroll_runs WHERE id = ?;",
    args: [runId],
  });
  const periode = run.rows[0];
  const rows = await tx.execute({
    sql: `SELECT id, gross_salary, net_salary, pph21_amount, bpjs_employee_total,
                 bpjs_company_total, breakdown_snapshot
          FROM payroll_items WHERE payroll_run_id = ?
          ORDER BY id
          LIMIT 5000;`,
    args: [runId],
  });
  const tanggal = await hariIni(tx);
  const idJurnal = idJurnalPayroll(runId);
  const items: ItemPayroll[] = [];
  for (const row of rows.rows) {
    const idItem = String(row.id);
    let kasbon: Array<{ id_pinjaman: string; jumlah: number }> = [];
    try {
      const breakdown = JSON.parse(String(row.breakdown_snapshot ?? "{}"));
      if (Array.isArray(breakdown?.kasbon)) {
        kasbon = breakdown.kasbon
          .filter(
            (entri: { id_pinjaman?: unknown; jumlah?: unknown }) =>
              typeof entri?.id_pinjaman === "string" &&
              Number.isInteger(entri?.jumlah) &&
              Number(entri.jumlah) > 0,
          )
          .map((entri: { id_pinjaman: string; jumlah: number }) => ({
            id_pinjaman: entri.id_pinjaman,
            jumlah: entri.jumlah,
          }));
      }
    } catch {
      kasbon = [];
    }
    for (const entri of kasbon) {
      await catatMutasiTx(tx, {
        id_mutasi: idAngsuranGaji(idItem, entri.id_pinjaman),
        id_pinjaman: entri.id_pinjaman,
        jenis: "Angsuran Gaji",
        jumlah: entri.jumlah,
        tanggal,
        id_ref: idItem,
        id_jurnal: idJurnal,
        dicatat_oleh: operator,
      });
    }
    items.push({
      gross: Number(row.gross_salary),
      net: Number(row.net_salary),
      pph21: Number(row.pph21_amount),
      bpjs_karyawan: Number(row.bpjs_employee_total),
      bpjs_perusahaan: Number(row.bpjs_company_total),
      kasbon: kasbon.reduce((sum, entri) => sum + entri.jumlah, 0),
    });
  }

  const baris = susunJurnalPayroll(items, idAkunBayar).map((item, indeks) => ({
    id_baris: `${idJurnal}-${indeks + 1}`,
    id_akun: item.id_akun,
    debit: item.debit,
    kredit: item.kredit,
    keterangan: null,
    urutan: indeks + 1,
  }));
  if (baris.length >= 2) {
    await tulisJurnalTx(
      tx,
      {
        id_jurnal: idJurnal,
        tanggal,
        keterangan: `Pembayaran gaji periode ${String(periode?.period_start ?? "")} s.d. ${String(periode?.period_end ?? "")}`,
        sumber: "Payroll",
        id_sumber: runId,
        id_jurnal_batal: null,
        dibuat_oleh: operator,
      },
      baris,
    );
  }
}
