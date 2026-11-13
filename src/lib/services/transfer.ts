import "server-only";

// HRIS fase 12: berkas transfer gaji ke bank (prd-hris.md §27), jalur Web.
// Kembar `desktop/transfer.rs` (bagian "Bacaan dan tulisan cloud"), diuji
// dengan alur yang sama (`transfer.test.ts` ↔ `transfer_cloud_pengaturan_dan_baris`).
// Tabelnya khusus cloud; jejak unduhan ditulis langsung ke `payroll_audit_logs`.

import type { Client } from "@libsql/client";
import type { OperatorUser } from "@/lib/auth/operator-user";
import { type Executor, newHexId, wibToday } from "@/lib/services/inventory";
import { namaBentrok, teksIsian } from "@/lib/validations/hris";
import {
  BANK_SQL,
  BARIS_TRANSFER_SQL,
  type BankBaris,
  bacaAlias,
  bankBentrok,
  CATAT_UNDUH_SQL,
  FORMAT_SQL,
  type FormatSusun,
  type ItemTransfer,
  JENIS_PENGATURAN,
  type JenisPengaturan,
  type KolomFormat,
  kolomTeks,
  PESAN_DEBET_NONAKTIF,
  PESAN_FORMAT_GANDA,
  PESAN_FORMAT_NONAKTIF,
  PESAN_REKENING_GANDA,
  PESAN_STATUS_RUN,
  pesanBankGanda,
  REKENING_SQL,
  RIWAYAT_UNDUH_SQL,
  RUN_TRANSFER_SQL,
  rekeningBentrok,
  SIMPAN_BANK_SQL,
  SIMPAN_FORMAT_SQL,
  SIMPAN_REKENING_SQL,
  STATUS_RUN_TRANSFER,
  susunTransfer,
  validasiBank,
  validasiFormat,
  validasiKolom,
  validasiPilihanTransfer,
  validasiRekening,
} from "@/lib/validations/transfer";

type Baris = Record<string, unknown>;
type Nilai = string | number | null;

const teks = (nilai: unknown) => teksIsian(nilai) ?? null;
const aktif = (baris: Baris, kunci: string) => Number(baris[kunci]) === 1;
const takDitemukan = (apa: string) => new Error(`${apa} tidak ditemukan.`);

async function objek(
  db: Executor,
  sql: string,
  args: Nilai[] = [],
): Promise<Baris[]> {
  const res = await db.execute({ sql, args });
  return res.rows.map((r) => ({ ...(r as Baris) }));
}

const teksAtauNull = (nilai: unknown) =>
  typeof nilai === "string" ? nilai : null;

/** Cermin `bank_tampil`: `alias` sebagai larik. */
const bankTampil = (b: Baris): Baris => ({
  ...b,
  alias: bacaAlias(teksAtauNull(b.alias)),
});

/** Cermin `format_tampil`: `kolom` sebagai larik, null bila tidak lagi sah. */
function formatTampil(f: Baris): Baris {
  let kolom: KolomFormat[] | null = null;
  try {
    const sah = validasiKolom(JSON.parse(teksAtauNull(f.kolom) ?? ""));
    kolom = sah.ok ? sah.nilai : null;
  } catch {
    kolom = null;
  }
  return { ...f, kolom };
}

const keBank = (b: Baris): BankBaris => ({
  id_bank: String(b.id_bank),
  nama: String(b.nama),
  kode: teksAtauNull(b.kode),
  alias: teksAtauNull(b.alias),
  is_aktif: Number(b.is_aktif),
});

/** Cermin `pengaturan`. */
export async function pengaturanTransfer(
  db: Executor,
  atur: boolean,
  unduh: boolean,
) {
  const bank = (await objek(db, BANK_SQL))
    .filter((b) => atur || aktif(b, "is_aktif"))
    .map(bankTampil);
  if (!atur && !unduh) return { bank, rekening: [], format: [], atur, unduh };
  const rekening = (await objek(db, REKENING_SQL)).filter(
    (r) => atur || (aktif(r, "is_aktif") && aktif(r, "bank_aktif")),
  );
  const format = (await objek(db, FORMAT_SQL))
    .filter((f) => atur || aktif(f, "is_aktif"))
    .map(formatTampil);
  return { bank, rekening, format, atur, unduh };
}

/** Cermin `periksa_bank`. */
async function periksaBank(db: Executor, idBank: string, tetap: boolean) {
  const [baris] = await objek(
    db,
    "SELECT is_aktif FROM app_bank WHERE id_bank = ?1;",
    [idBank],
  );
  if (!baris) throw takDitemukan("Bank");
  if (!tetap && !aktif(baris, "is_aktif"))
    throw new Error("Bank sudah nonaktif.");
}

/** Cermin `baris_lama`. */
function barisLama(
  daftar: readonly Baris[],
  kunci: string,
  id: string | null,
  apa: string,
): Baris | null {
  if (id === null) return null;
  const lama = daftar.find((b) => teks(b[kunci]) === id);
  if (!lama) throw takDitemukan(apa);
  return lama;
}

/** Cermin `simpan_pengaturan`. */
export async function simpanPengaturanTransfer(
  db: Client,
  actor: OperatorUser,
  jenis: JenisPengaturan,
  id: string | null,
  draft: Record<string, unknown>,
) {
  if (!(JENIS_PENGATURAN as readonly string[]).includes(jenis)) {
    throw new Error("Jenis pengaturan tidak dikenal.");
  }
  const oleh = actor.username;
  if (jenis === "bank") {
    const semua = await objek(db, BANK_SQL);
    const lama = barisLama(semua, "id_bank", id, "Bank");
    const sah = validasiBank(draft, lama ? teks(lama.nama) : null);
    if (!sah.ok) throw new Error(sah.pesan);
    const bentrok = bankBentrok(id, sah.nilai, semua.map(keBank));
    if (bentrok !== null) throw new Error(pesanBankGanda(bentrok));
    const idBaru = id ?? newHexId("bnk-");
    const v = sah.nilai;
    await db.execute({
      sql: SIMPAN_BANK_SQL,
      args: [idBaru, v.nama, v.kode, JSON.stringify(v.alias), v.is_aktif, oleh],
    });
    return { sukses: true as const, id: idBaru };
  }
  if (jenis === "rekening") {
    const semua = await objek(db, REKENING_SQL);
    const lama = barisLama(semua, "id_rekening", id, "Rekening");
    const sah = validasiRekening(draft);
    if (!sah.ok) throw new Error(sah.pesan);
    const v = sah.nilai;
    await periksaBank(
      db,
      v.id_bank,
      lama !== null && teks(lama.id_bank) === v.id_bank,
    );
    const daftar = semua.map((r) => ({
      id_rekening: String(r.id_rekening),
      id_bank: String(r.id_bank),
      no_rekening: String(r.no_rekening),
    }));
    if (rekeningBentrok(id, v, daftar)) throw new Error(PESAN_REKENING_GANDA);
    const idBaru = id ?? newHexId("rek-");
    await db.execute({
      sql: SIMPAN_REKENING_SQL,
      args: [
        idBaru,
        v.id_bank,
        v.no_rekening,
        v.nama_rekening,
        v.keterangan,
        v.is_aktif,
        oleh,
      ],
    });
    return { sukses: true as const, id: idBaru };
  }
  const semua = await objek(db, FORMAT_SQL);
  const lama = barisLama(semua, "id_format", id, "Format");
  const sah = validasiFormat(draft);
  if (!sah.ok) throw new Error(sah.pesan);
  const v = sah.nilai;
  if (v.id_bank !== null) {
    await periksaBank(
      db,
      v.id_bank,
      lama !== null && teks(lama.id_bank) === v.id_bank,
    );
  }
  const nama = semua.map(
    (f) => [teks(f.id_format) ?? "", teks(f.nama) ?? ""] as const,
  );
  if (namaBentrok(id, v.nama, nama)) throw new Error(PESAN_FORMAT_GANDA);
  const idBaru = id ?? newHexId("fmt-");
  await db.execute({
    sql: SIMPAN_FORMAT_SQL,
    args: [
      idBaru,
      v.nama,
      v.id_bank,
      v.jenis,
      v.pemisah,
      v.pakai_judul,
      v.kutip,
      v.desimal,
      v.cakupan,
      kolomTeks(v.kolom),
      v.maks_berita,
      v.is_aktif,
      oleh,
    ],
  });
  return { sukses: true as const, id: idBaru };
}

/** Cermin `berkas_transfer`. */
export async function berkasTransfer(
  db: Client,
  actor: OperatorUser,
  draft: Record<string, unknown>,
) {
  const sah = validasiPilihanTransfer(draft);
  if (!sah.ok) throw new Error(sah.pesan);
  const pilihan = sah.nilai;
  const [run] = await objek(db, RUN_TRANSFER_SQL, [pilihan.run_id]);
  if (!run) throw takDitemukan("Proses gaji");
  const status = teks(run.status) ?? "";
  if (!(STATUS_RUN_TRANSFER as readonly string[]).includes(status)) {
    throw new Error(PESAN_STATUS_RUN);
  }
  const debet = (await objek(db, REKENING_SQL)).find(
    (r) =>
      teks(r.id_rekening) === pilihan.id_rekening &&
      aktif(r, "is_aktif") &&
      aktif(r, "bank_aktif"),
  );
  if (!debet) throw new Error(PESAN_DEBET_NONAKTIF);
  let format: Baris | null = null;
  if (pilihan.id_format !== null) {
    const f = (await objek(db, FORMAT_SQL)).find(
      (b) => teks(b.id_format) === pilihan.id_format && aktif(b, "is_aktif"),
    );
    format = f ? formatTampil(f) : null;
    if (!format || format.kolom === null)
      throw new Error(PESAN_FORMAT_NONAKTIF);
  }
  const tanggal_efektif = pilihan.tanggal_efektif ?? (await wibToday(db));
  const item: ItemTransfer[] = (
    await objek(db, BARIS_TRANSFER_SQL, [pilihan.run_id])
  ).map((r) => ({
    id_karyawan: String(r.id_karyawan),
    nama_karyawan: String(r.nama_karyawan),
    kode_karyawan: teksAtauNull(r.kode_karyawan),
    net_salary: Number(r.net_salary),
    id_keluar: teksAtauNull(r.id_keluar),
    bank: teksAtauNull(r.bank),
    no_rekening: teksAtauNull(r.no_rekening),
    nama_rekening: teksAtauNull(r.nama_rekening),
  }));
  const formatSusun: FormatSusun | null = format
    ? {
        cakupan: String(format.cakupan),
        kolom: format.kolom as KolomFormat[],
        maks_berita:
          format.maks_berita === null ? null : Number(format.maks_berita),
      }
    : null;
  const susunan = susunTransfer({
    run: {
      period_start: String(run.period_start),
      period_end: String(run.period_end),
    },
    item,
    bank: (await objek(db, BANK_SQL)).map(keBank),
    debet: {
      id_bank: String(debet.id_bank),
      no_rekening: String(debet.no_rekening),
      nama_rekening: String(debet.nama_rekening),
    },
    format: formatSusun,
    tanggal_efektif,
  });
  const riwayat = await objek(db, RIWAYAT_UNDUH_SQL, [pilihan.run_id]);
  if (pilihan.catat) {
    // Kunci urut abjad: sama dengan `json!` Rust yang diserialkan berurutan.
    const catatan = JSON.stringify({
      format: format ? teks(format.nama) : null,
      id_format: pilihan.id_format,
      id_rekening: pilihan.id_rekening,
      jumlah_baris: susunan.ringkasan.jumlah_baris,
      rekening_debet: susunan.rekening_debet,
      tanggal_efektif: susunan.tanggal_efektif,
      total: susunan.ringkasan.total,
    });
    await db.execute({
      sql: CATAT_UNDUH_SQL,
      args: [newHexId("trf-"), pilihan.run_id, status, actor.username, catatan],
    });
  }
  return { run, debet, format, susunan, riwayat, dicatat: pilihan.catat };
}
