import "server-only";

import { createHash } from "node:crypto";
import type { Client } from "@libsql/client";
import type { OperatorUser } from "@/lib/auth/operator-user";
import { AuthorizationError } from "@/lib/auth/permission-assertion";
import { newHexId, withTransaction } from "@/lib/services/inventory";
import type { HolidayWhitelistEntry } from "@/lib/validations/holiday-whitelist";
import {
  aturanCutiDariPeta,
  aturanLemburDariPeta,
  BACKUP_TUKAR_SQL,
  type BarisReimburse,
  type BayarReimburse,
  bentrokPengajuan,
  CLOUD_INSERT_BARIS_REIMBURSE_SQL,
  CLOUD_INSERT_BAYAR_REIMBURSE_SQL,
  CLOUD_INSERT_KEPUTUSAN_SQL,
  dibayarGanda,
  durasiLembur,
  GAJI_REIMBURSE_SQL,
  type GajiReimburse,
  type HariLembur,
  hariKalender,
  hitungCutiDibayar,
  INSERT_PENYESUAIAN_SQL,
  type IsiPengajuan,
  IZIN_PEMUTUS_AKTIF,
  idBarisReimburse,
  idBatalReimburse,
  idUang,
  type Jadwal,
  type JenisPengajuan,
  jadwalDariBaris,
  type Kalender,
  KELOMPOK_TIDAK_HADIR,
  type Keputusan,
  KLAIM_BERLAKU_SQL,
  type Klaim,
  KUNCI_REIMBURSE_BAYAR,
  kanonikPengajuan,
  keputusanBerlaku,
  kunciBatas,
  LEMBUR_HARIAN_SQL,
  lemburLewatBatas,
  lewatBatas,
  MAKS_LAMPIRAN,
  modeReimburse,
  nominalBerlaku,
  PENGAJUAN_RENTANG_SQL,
  PERIODE_DIBAYAR_SQL,
  PESAN_KLAIM_DIBAYAR,
  PESAN_TANPA_HARI_KERJA,
  PESAN_TUKAR_BACKUP,
  PESAN_TUKAR_NONAKTIF,
  PESAN_TUKAR_SHIFT_HILANG,
  PESAN_TUKAR_SHIFT_SAMA,
  PESAN_UANG_DIBAYAR,
  type PeriodeCuti,
  type PotongLembur,
  periksaAksi,
  periksaBatalBayarReimburse,
  periksaBayarReimburse,
  periksaJenis,
  periksaMaks,
  periksaReimbursePayroll,
  periksaSunting,
  periksaTanggalBiaya,
  periksaUrgent,
  periodeCuti,
  pesanBertumpuk,
  pesanPeriodeDibayar,
  potongLemburSpl,
  type Ringkas,
  SPL_RENTANG_SQL,
  STATUS_BELUM_DIBAYAR,
  STATUS_DIBAYAR,
  STATUS_PROSES_GAJI,
  type StatusBayar,
  SUMBER_REIMBURSE,
  SUMBER_UANG,
  statusBayar,
  statusBerlaku,
  statusPengajuan,
  TANGGAL_HADIR_SQL,
  TUKAR_RENTANG_SQL,
  tandaKeputusan,
  tanggalWajib,
  UANG_BERLAKU_SQL,
  UPSERT_JENIS_SQL,
  UPSERT_PENGAJUAN_SQL,
  upahHarian,
  validasiAturanCuti,
  validasiAturanLembur,
  validasiAturanReimburse,
  validasiBayarReimburse,
  validasiJenis,
  validasiPengajuan,
  validasiPenyesuaian,
} from "@/lib/validations/hr-pengajuan";
import { namaBentrok, validasiBerkas } from "@/lib/validations/hris";

/**
 * Cermin Web dari `desktop/hr_pengajuan.rs` (prd-hris.md §17). Web menulis
 * langsung ke database cloud; SQL, aturan, dan pesan sama dengan Rust.
 */

/** Klien atau transaksi libSQL; keduanya punya `execute` yang sama. */
type Pembaca = Pick<Client, "execute">;

/** Cermin `sidik_pengajuan`. */
export function sidikPengajuan(isi: IsiPengajuan): string {
  return createHash("sha256")
    .update(kanonikPengajuan(isi), "utf8")
    .digest("hex");
}

export interface PengajuanBerlaku {
  id_pengajuan: string;
  id_karyawan: string;
  tanggal_mulai: string;
  tanggal_selesai: string;
  kelompok: string;
  dampak_gaji: string;
  potong_jatah: boolean;
  setengah_hari: boolean;
}

/** Cermin `muat_berlaku`. */
export async function muatBerlaku(
  db: Pembaca,
  mulai: string,
  selesai: string,
): Promise<PengajuanBerlaku[]> {
  const hasil = await db.execute({
    sql: PENGAJUAN_RENTANG_SQL,
    args: [mulai, selesai],
  });
  return hasil.rows.map((r) => ({
    id_pengajuan: String(r.id_pengajuan),
    id_karyawan: String(r.id_karyawan),
    tanggal_mulai: String(r.tanggal_mulai),
    tanggal_selesai: String(r.tanggal_selesai),
    kelompok: String(r.kelompok),
    dampak_gaji: String(r.dampak_gaji),
    potong_jatah: Number(r.potong_jatah) === 1,
    setengah_hari: Number(r.setengah_hari) === 1,
  }));
}

/** Cermin `pengaju_tanggal`: karyawan yang ditutup pengajuan berlaku. */
export async function pengajuTanggal(
  db: Pembaca,
  tanggal: string,
): Promise<Set<string>> {
  return new Set(
    (await muatBerlaku(db, tanggal, tanggal)).map((p) => p.id_karyawan),
  );
}

/** Cermin `muat_kalender`. */
export async function muatKalender(
  db: Pembaca,
  mulai: string,
  selesai: string,
): Promise<Kalender> {
  const libur = await db.execute({
    sql: "SELECT tanggal FROM tbl_hari_libur WHERE status_aktif = 1 AND tanggal >= ?1 AND tanggal <= ?2;",
    args: [mulai, selesai],
  });
  const whitelist = await db.execute(
    "SELECT id, scope_type, scope_value, tanggal_libur, status_aktif FROM hari_libur_whitelist WHERE status_aktif = 1;",
  );
  return {
    libur: new Set(libur.rows.map((r) => String(r.tanggal))),
    whitelist: whitelist.rows.map(
      (r): HolidayWhitelistEntry => ({
        id: String(r.id),
        scope_type: String(r.scope_type ?? ""),
        scope_value: String(r.scope_value ?? ""),
        tanggal_libur:
          r.tanggal_libur === null ? null : String(r.tanggal_libur),
        keterangan: null,
        status_aktif: Number(r.status_aktif),
      }),
    ),
  };
}

/** Cermin `muat_jadwal`: shift SAAT INI setiap karyawan. */
export async function muatJadwal(db: Pembaca): Promise<Map<string, Jadwal>> {
  const hasil = await db.execute(
    `SELECT m.id_unik, COALESCE(m.divisi, '') AS divisi, s.hari_kerja, s.kode_shift,
            COALESCE(s.jam_kerja_normal_menit, 0) AS jam_kerja_normal_menit
     FROM master_data m LEFT JOIN tbl_shift s ON s.id_shift = m.id_shift;`,
  );
  return new Map(
    hasil.rows.map((r) => [
      String(r.id_unik),
      jadwalDariBaris({
        divisi: r.divisi,
        hari_kerja: r.hari_kerja,
        kode_shift: r.kode_shift,
        jam_kerja_normal_menit: r.jam_kerja_normal_menit,
      }),
    ]),
  );
}

/** Cermin `muat_hadir`. */
export async function muatHadir(
  db: Pembaca,
  mulai: string,
  selesai: string,
): Promise<Map<string, Set<string>>> {
  const hasil = await db.execute({
    sql: TANGGAL_HADIR_SQL,
    args: [mulai, selesai],
  });
  const peta = new Map<string, Set<string>>();
  for (const r of hasil.rows) {
    const id = String(r.id_karyawan);
    const set = peta.get(id) ?? new Set<string>();
    set.add(String(r.tanggal));
    peta.set(id, set);
  }
  return peta;
}

/** Cermin `cuti_dibayar`: kait rekap gaji (§17.6), `[hari, menit]`. */
export async function cutiDibayar(
  db: Pembaca,
  mulai: string,
  akhir: string,
): Promise<Map<string, [number, number]>> {
  const berlaku = (await muatBerlaku(db, mulai, akhir)).filter(
    (p) => p.dampak_gaji === "Dibayar",
  );
  const hasil = new Map<string, [number, number]>();
  if (berlaku.length === 0) return hasil;
  const jadwal = await muatJadwal(db);
  const kalender = await muatKalender(db, mulai, akhir);
  const hadir = await muatHadir(db, mulai, akhir);
  const tanggal = new Map<string, Array<[string, boolean]>>();
  for (const p of berlaku) {
    const j = jadwal.get(p.id_karyawan);
    if (!j) continue;
    const dari = p.tanggal_mulai > mulai ? p.tanggal_mulai : mulai;
    const sampai = p.tanggal_selesai < akhir ? p.tanggal_selesai : akhir;
    const daftar = tanggal.get(p.id_karyawan) ?? [];
    for (const t of tanggalWajib(j, kalender, dari, sampai)) {
      daftar.push([t, p.setengah_hari]);
    }
    tanggal.set(p.id_karyawan, daftar);
  }
  for (const [id, daftar] of tanggal) {
    hasil.set(
      id,
      hitungCutiDibayar(
        daftar,
        hadir.get(id) ?? new Set(),
        jadwal.get(id)?.jam_normal_menit ?? 0,
      ),
    );
  }
  return hasil;
}

async function bacaAturanLembur(db: Pembaca) {
  const r = await db.execute(
    "SELECT key, value FROM setting_gex_system WHERE key LIKE 'hr\\_lembur\\_%' ESCAPE '\\';",
  );
  return aturanLemburDariPeta(
    new Map(r.rows.map((x) => [String(x.key), String(x.value)])),
  );
}

/** Cermin `muat_spl`: menit SPL berlaku per `karyawan|tanggal`. */
export async function muatSpl(
  db: Pembaca,
  mulai: string,
  akhir: string,
): Promise<Map<string, number>> {
  const r = await db.execute({ sql: SPL_RENTANG_SQL, args: [mulai, akhir] });
  const hasil = new Map<string, number>();
  for (const x of r.rows) {
    const kunci = `${String(x.id_karyawan)}|${String(x.tanggal_mulai)}`;
    const d = durasiLembur(
      String(x.jam_mulai ?? ""),
      String(x.jam_selesai ?? ""),
    );
    hasil.set(kunci, (hasil.get(kunci) ?? 0) + (d.ok ? d.nilai : 0));
  }
  return hasil;
}

/** Cermin `lembur_spl`: mode dan potongan per karyawan bila mode `spl`. */
export async function lemburSpl(
  db: Pembaca,
  mulai: string,
  akhir: string,
): Promise<{ mode: string; potong: Map<string, PotongLembur> }> {
  const aturan = await bacaAturanLembur(db);
  const potong = new Map<string, PotongLembur>();
  if (aturan.mode !== "spl") return { mode: aturan.mode, potong };
  const spl = await muatSpl(db, mulai, akhir);
  const r = await db.execute({ sql: LEMBUR_HARIAN_SQL, args: [mulai, akhir] });
  const hari = new Map<string, HariLembur[]>();
  for (const x of r.rows) {
    const nilai = Object.values(x);
    const id = String(nilai[0]);
    const daftar = hari.get(id) ?? [];
    daftar.push({
      lembur: Number(nilai[2]),
      libur_total: Number(nilai[3]),
      libur_jam_kerja: Number(nilai[4]),
      spl: spl.get(`${id}|${String(nilai[1])}`) ?? 0,
    });
    hari.set(id, daftar);
  }
  for (const [id, daftar] of hari) potong.set(id, potongLemburSpl(daftar));
  return { mode: aturan.mode, potong };
}

/** Cermin `muat_tukar`: shift tukar berlaku per `karyawan|tanggal`. */
export async function muatTukar(
  db: Pembaca,
  mulai: string,
  akhir: string,
): Promise<Map<string, number>> {
  const r = await db.execute({ sql: TUKAR_RENTANG_SQL, args: [mulai, akhir] });
  const hasil = new Map<string, number>();
  for (const x of r.rows) {
    const [id, tanggal, shift] = Object.values(x);
    if (id === null || shift === null) continue;
    const kunci = `${String(id)}|${String(tanggal)}`;
    if (!hasil.has(kunci)) hasil.set(kunci, Number(shift));
  }
  return hasil;
}

// ── Reimbursement dan pembayaran terpisah (§19.4), cermin Rust ─────────────

/** Cermin `muat_klaim`. */
export async function muatKlaim(db: Pembaca, sampai: string): Promise<Klaim[]> {
  const hasil: Klaim[] = [];
  for (const [sql, sumber, args] of [
    [KLAIM_BERLAKU_SQL, SUMBER_REIMBURSE, [sampai]],
    [UANG_BERLAKU_SQL, SUMBER_UANG, []],
  ] as const) {
    const r = await db.execute({ sql, args: [...args] });
    for (const x of r.rows) {
      const [id, karyawan, tanggal, nominal, keterangan] = Object.values(x);
      hasil.push({
        id_klaim: String(id),
        sumber,
        id_karyawan: String(karyawan),
        tanggal: String(tanggal),
        nominal: Number(nominal),
        keterangan: String(keterangan),
      });
    }
  }
  return hasil;
}

/** Cermin `muat_bayar`. */
// ponytail: dibaca utuh tiap kali; saring per karyawan bila tabelnya membesar.
export async function muatBayar(db: Pembaca): Promise<{
  pembayaran: BayarReimburse[];
  baris: BarisReimburse[];
}> {
  const b = await db.execute(
    `SELECT id_bayar, jenis, id_ref, id_karyawan, tanggal, total, keterangan, dicatat_oleh, created_at
     FROM hr_reimburse_bayar ORDER BY tanggal, created_at, id_bayar;`,
  );
  const r = await db.execute(
    "SELECT id_baris, id_bayar, sumber, id_klaim, nominal FROM hr_reimburse_bayar_baris ORDER BY id_bayar, id_baris;",
  );
  return {
    pembayaran: b.rows.map((x) => ({
      id_bayar: String(x.id_bayar),
      jenis: String(x.jenis),
      id_ref: teksAtauNull(x.id_ref),
      id_karyawan: String(x.id_karyawan),
      tanggal: String(x.tanggal),
      total: Number(x.total),
      keterangan: teksAtauNull(x.keterangan),
      dicatat_oleh: String(x.dicatat_oleh),
      created_at: String(x.created_at),
    })),
    baris: r.rows.map((x) => ({
      id_baris: String(x.id_baris),
      id_bayar: String(x.id_bayar),
      sumber: String(x.sumber),
      id_klaim: String(x.id_klaim),
      nominal: Number(x.nominal),
    })),
  };
}

/** Cermin `muat_gaji_reimburse`. */
export async function muatGajiReimburse(db: Pembaca): Promise<GajiReimburse[]> {
  const r = await db.execute(GAJI_REIMBURSE_SQL);
  const hasil: GajiReimburse[] = [];
  for (const x of r.rows) {
    const [idRun, status, idKlaim, nominal] = Object.values(x);
    if (idKlaim === null || idKlaim === undefined) continue;
    hasil.push({
      id_run: String(idRun),
      status: String(status),
      id_klaim: String(idKlaim),
      nominal: Number(nominal ?? 0),
    });
  }
  return hasil;
}

/** Cermin `baca_mode_reimburse`. */
export async function bacaModeReimburse(db: Pembaca): Promise<string> {
  const r = await db.execute({
    sql: "SELECT value FROM setting_gex_system WHERE key = ?1;",
    args: [KUNCI_REIMBURSE_BAYAR],
  });
  const nilai = r.rows[0]?.value;
  return modeReimburse(
    nilai === null || nilai === undefined ? null : String(nilai),
  );
}

/**
 * Cermin `reimburse_gaji`: kait rekap gaji mode `gaji` (§19.4), klaim
 * Reimburse berlaku bertanggal ≤ `akhir` yang Belum dibayar, per karyawan.
 */
export async function reimburseGaji(
  db: Pembaca,
  akhir: string,
): Promise<Map<string, Array<[string, number]>>> {
  const hasil = new Map<string, Array<[string, number]>>();
  if ((await bacaModeReimburse(db)) !== "gaji") return hasil;
  const klaim = await muatKlaim(db, akhir);
  const { pembayaran, baris } = await muatBayar(db);
  const gaji = await muatGajiReimburse(db);
  for (const k of klaim) {
    if (k.sumber !== SUMBER_REIMBURSE) continue;
    if (
      statusBayar(k.id_klaim, pembayaran, baris, gaji) !== STATUS_BELUM_DIBAYAR
    )
      continue;
    const daftar = hasil.get(k.id_karyawan) ?? [];
    daftar.push([k.id_klaim, k.nominal]);
    hasil.set(k.id_karyawan, daftar);
  }
  return hasil;
}

/** Cermin `periksa_reimburse_run`, dipanggil di transaksi transisi PAID. */
export async function periksaReimburseRun(
  db: Pembaca,
  idRun: string,
  entri: ReadonlyArray<readonly [string, number]>,
): Promise<void> {
  if (entri.length === 0) return;
  const klaim = await muatKlaim(db, "9999-12-31");
  const { pembayaran, baris } = await muatBayar(db);
  const gaji = await muatGajiReimburse(db);
  const cek = periksaReimbursePayroll(
    idRun,
    entri,
    klaim,
    pembayaran,
    baris,
    gaji,
  );
  if (!cek.ok) throw new Error(cek.pesan);
}

// ── Penulisan Web (langsung ke cloud), cermin `desktop/hr_pengajuan.rs` ─────

type Baris = Record<string, unknown>;

const punya = (actor: OperatorUser, izin: string) =>
  actor.isSuperadmin || (actor.permissions as readonly string[]).includes(izin);
const samaOrang = (a: string, b: string) =>
  a.trim().toLowerCase() === b.trim().toLowerCase();
const teksId = (nilai: unknown) =>
  typeof nilai === "string" && nilai.trim() !== "" ? nilai.trim() : null;

/** `master_operator.id_karyawan` sesi Web (tidak dimuat sesi). */
export async function karyawanAktor(db: Pembaca, actor: OperatorUser) {
  const r = await db.execute({
    sql: "SELECT id_karyawan FROM master_operator WHERE id = ?1;",
    args: [actor.id],
  });
  return teksId(r.rows[0]?.id_karyawan);
}

export interface BarisPengajuan {
  id_pengajuan: string;
  id_karyawan: string;
  id_jenis: string;
  kelompok: string;
  potong_jatah: boolean;
  dampak_gaji: string;
  tanggal_mulai: string;
  tanggal_selesai: string;
  setengah_hari: boolean;
  alasan: string;
  sidik: string;
  diajukan_oleh: string;
  waktu_perangkat: string;
  created_at: string;
  jam_mulai: string | null;
  jam_selesai: string | null;
  id_karyawan_tukar: string | null;
  id_shift_asal: number | null;
  id_shift_tukar: number | null;
  /** Reimburse (v39). */
  nominal: number | null;
}

const KOLOM_PENGAJUAN =
  "p.id_pengajuan, p.id_karyawan, p.id_jenis, p.kelompok, p.potong_jatah, p.dampak_gaji, p.tanggal_mulai, p.tanggal_selesai, p.setengah_hari, p.alasan, p.sidik, p.diajukan_oleh, p.waktu_perangkat, p.created_at, p.jam_mulai, p.jam_selesai, p.id_karyawan_tukar, p.id_shift_asal, p.id_shift_tukar, p.nominal";

const teksAtauNull = (nilai: unknown) =>
  nilai === null || nilai === undefined ? null : String(nilai);
const angkaAtauNull = (nilai: unknown) =>
  nilai === null || nilai === undefined ? null : Number(nilai);

/** Cermin `BarisPengajuan::ringkas`. */
export function ringkasPengajuan(p: BarisPengajuan): Ringkas {
  return {
    kelompok: p.kelompok,
    id_karyawan: p.id_karyawan,
    id_karyawan_tukar: p.id_karyawan_tukar,
    tanggal_mulai: p.tanggal_mulai,
    tanggal_selesai: p.tanggal_selesai,
    setengah_hari: p.setengah_hari,
    jam_mulai: p.jam_mulai,
    jam_selesai: p.jam_selesai,
  };
}

function barisPengajuan(r: Baris): BarisPengajuan {
  return {
    id_pengajuan: String(r.id_pengajuan),
    id_karyawan: String(r.id_karyawan),
    id_jenis: String(r.id_jenis),
    kelompok: String(r.kelompok),
    potong_jatah: Number(r.potong_jatah) === 1,
    dampak_gaji: String(r.dampak_gaji),
    tanggal_mulai: String(r.tanggal_mulai),
    tanggal_selesai: String(r.tanggal_selesai),
    setengah_hari: Number(r.setengah_hari) === 1,
    alasan: String(r.alasan),
    sidik: String(r.sidik),
    diajukan_oleh: String(r.diajukan_oleh),
    waktu_perangkat: String(r.waktu_perangkat),
    created_at: String(r.created_at),
    jam_mulai: teksAtauNull(r.jam_mulai),
    jam_selesai: teksAtauNull(r.jam_selesai),
    id_karyawan_tukar: teksAtauNull(r.id_karyawan_tukar),
    id_shift_asal: angkaAtauNull(r.id_shift_asal),
    id_shift_tukar: angkaAtauNull(r.id_shift_tukar),
    nominal: angkaAtauNull(r.nominal),
  };
}

async function bacaPengajuan(
  db: Pembaca,
  idKaryawan: string | null,
  mulai: string,
  selesai: string,
): Promise<BarisPengajuan[]> {
  const r = await db.execute({
    sql: `SELECT ${KOLOM_PENGAJUAN} FROM hr_pengajuan p
          WHERE (?1 IS NULL OR p.id_karyawan = ?1 OR p.id_karyawan_tukar = ?1) AND p.tanggal_mulai <= ?3 AND p.tanggal_selesai >= ?2
          ORDER BY p.tanggal_mulai DESC, p.id_pengajuan LIMIT 2000;`,
    args: [idKaryawan, mulai, selesai],
  });
  return r.rows.map((x) => barisPengajuan(x as unknown as Baris));
}

async function bacaSatuPengajuan(db: Pembaca, id: string) {
  const r = await db.execute({
    sql: `SELECT ${KOLOM_PENGAJUAN} FROM hr_pengajuan p WHERE p.id_pengajuan = ?1;`,
    args: [id],
  });
  return r.rows[0] ? barisPengajuan(r.rows[0] as unknown as Baris) : null;
}

async function bacaKeputusan(
  db: Pembaca,
  ids: readonly string[],
): Promise<Map<string, Keputusan[]>> {
  const hasil = new Map<string, Keputusan[]>();
  if (ids.length === 0) return hasil;
  const r = await db.execute({
    sql: `SELECT id_pengajuan, id_keputusan, jenis, sidik, oleh, waktu_perangkat, diterima_cloud, nominal_disetujui
          FROM hr_pengajuan_keputusan
          WHERE id_pengajuan IN (SELECT value FROM json_each(?1))
          ORDER BY id_pengajuan, id_keputusan;`,
    args: [JSON.stringify(ids)],
  });
  for (const x of r.rows) {
    const id = String(x.id_pengajuan);
    const daftar = hasil.get(id) ?? [];
    daftar.push({
      id_keputusan: String(x.id_keputusan),
      jenis: String(x.jenis),
      sidik: String(x.sidik),
      oleh: String(x.oleh),
      waktu_perangkat: String(x.waktu_perangkat),
      diterima_cloud:
        x.diterima_cloud === null ? null : String(x.diterima_cloud),
      nominal_disetujui: angkaAtauNull(x.nominal_disetujui),
    });
    hasil.set(id, daftar);
  }
  return hasil;
}

async function bacaJenisSemua(db: Pembaca): Promise<JenisPengajuan[]> {
  const r = await db.execute(
    `SELECT id_jenis, nama, kelompok, izin_pemutus, boleh_urgent, potong_jatah, dampak_gaji, maks_hari, satuan_maks, wajib_dokumen, is_aktif, batas_bulanan
     FROM hr_jenis_pengajuan ORDER BY kelompok, nama, id_jenis;`,
  );
  return r.rows.map((x) => ({
    id_jenis: String(x.id_jenis),
    nama: String(x.nama),
    kelompok: String(x.kelompok),
    izin_pemutus: String(x.izin_pemutus),
    boleh_urgent: Number(x.boleh_urgent) === 1,
    potong_jatah: Number(x.potong_jatah) === 1,
    dampak_gaji: String(x.dampak_gaji),
    maks_hari: x.maks_hari === null ? null : Number(x.maks_hari),
    satuan_maks: String(x.satuan_maks),
    wajib_dokumen: Number(x.wajib_dokumen) === 1,
    is_aktif: Number(x.is_aktif) === 1,
    batas_bulanan: angkaAtauNull(x.batas_bulanan),
  }));
}

async function waktuSekarang(db: Pembaca): Promise<string> {
  const r = await db.execute("SELECT datetime('now') AS w;");
  return String(r.rows[0]?.w);
}

async function hariIniWib(db: Pembaca): Promise<string> {
  const r = await db.execute("SELECT date('now', '+7 hours') AS t;");
  return String(r.rows[0]?.t);
}

async function tolakBilaDibayar(db: Pembaca, mulai: string, selesai: string) {
  const r = await db.execute({
    sql: PERIODE_DIBAYAR_SQL,
    args: [mulai, selesai],
  });
  const run = r.rows[0];
  if (run) {
    throw new Error(
      pesanPeriodeDibayar(String(run.period_start), String(run.period_end)),
    );
  }
}

async function tulisKeputusan(
  db: Pembaca,
  id: string,
  idPengajuan: string,
  jenis: string,
  sidik: string,
  alasan: string | null,
  oleh: string,
  nominalDisetujui: number | null = null,
) {
  await db.execute({
    sql: CLOUD_INSERT_KEPUTUSAN_SQL,
    args: [
      id,
      idPengajuan,
      jenis,
      sidik,
      alasan,
      oleh,
      await waktuSekarang(db),
      null,
      nominalDisetujui,
    ],
  });
}

/** Cermin `simpan_jenis`. */
export async function simpanJenis(client: Client, raw: unknown) {
  const draft = (raw ?? {}) as Baris;
  const sah = validasiJenis(draft);
  if (!sah.ok) throw new Error(sah.pesan);
  const jenis = sah.nilai;
  const idMasuk = teksId(draft.id_jenis);
  return withTransaction(client, async (tx) => {
    const semua = await bacaJenisSemua(tx);
    if (idMasuk && !semua.some((j) => j.id_jenis === idMasuk)) {
      throw new Error("Jenis pengajuan tidak ditemukan.");
    }
    if (
      namaBentrok(
        idMasuk,
        jenis.nama,
        semua.map((j) => [j.id_jenis, j.nama] as const),
      )
    ) {
      throw new Error(`Jenis pengajuan "${jenis.nama}" sudah ada.`);
    }
    const id = idMasuk ?? newHexId("jns-");
    await tx.execute({
      sql: UPSERT_JENIS_SQL,
      args: [
        id,
        jenis.nama,
        jenis.kelompok,
        jenis.izin_pemutus,
        jenis.boleh_urgent ? 1 : 0,
        jenis.potong_jatah ? 1 : 0,
        jenis.dampak_gaji,
        jenis.maks_hari,
        jenis.satuan_maks,
        jenis.wajib_dokumen ? 1 : 0,
        jenis.is_aktif ? 1 : 0,
        null,
        jenis.batas_bulanan,
        1,
      ],
    });
    return { sukses: true as const, id_jenis: id };
  });
}

/** Cermin `simpan_pengajuan`. */
export async function simpanPengajuan(
  client: Client,
  actor: OperatorUser,
  raw: unknown,
) {
  const draft = (raw ?? {}) as Baris;
  const sah = validasiPengajuan(draft);
  if (!sah.ok) throw new Error(sah.pesan);
  const v = sah.nilai;
  const idMasuk = teksId(draft.id_pengajuan);
  const karyawanSesi = await karyawanAktor(client, actor);
  if (v.urgent) {
    if (idMasuk) throw new Error("Pengajuan urgent hanya bisa dibuat baru.");
    if (!punya(actor, "hr.request.urgent")) {
      throw new AuthorizationError(
        "Kamu tidak punya izin mengajukan urgent.",
        403,
      );
    }
  }
  return withTransaction(client, async (tx) => {
    const ada = await tx.execute({
      sql: "SELECT 1 FROM master_data WHERE id_unik = ?1;",
      args: [v.id_karyawan],
    });
    if (ada.rows.length === 0) throw new Error("Karyawan tidak ditemukan.");
    const jenis = (await bacaJenisSemua(tx)).find(
      (j) => j.id_jenis === v.id_jenis,
    );
    if (!jenis) throw new Error("Jenis pengajuan tidak ditemukan.");
    const cek = periksaJenis(v, jenis);
    if (!cek.ok) throw new Error(cek.pesan);
    const reimburse = jenis.kelompok === "Reimburse";
    if (reimburse) {
      const t = periksaTanggalBiaya(v.tanggal_mulai, await hariIniWib(tx));
      if (!t.ok) throw new Error(t.pesan);
    }
    const nominal = reimburse ? v.nominal : null;
    const lembur = jenis.kelompok === "Lembur";
    const jamMulai = lembur ? v.jam_mulai : null;
    const jamSelesai = lembur ? v.jam_selesai : null;
    const idTukar =
      jenis.kelompok === "Tukar Shift" ? v.id_karyawan_tukar : null;
    if (v.urgent) {
      const u = periksaUrgent(
        karyawanSesi === v.id_karyawan ||
          (idTukar !== null && karyawanSesi === idTukar),
      );
      if (!u.ok) throw new Error(u.pesan);
    }
    const [idShiftAsal, idShiftTukar] =
      idTukar === null
        ? [null, null]
        : await shiftTukarBaru(tx, v.id_karyawan, idTukar, v.tanggal_mulai);
    const jadwal = (await muatJadwal(tx)).get(v.id_karyawan);
    if (!jadwal) throw new Error("Karyawan tidak ditemukan.");
    const kalender = await muatKalender(tx, v.tanggal_mulai, v.tanggal_selesai);
    const wajib = tanggalWajib(
      jadwal,
      kalender,
      v.tanggal_mulai,
      v.tanggal_selesai,
    );
    // Lembur dan tukar shift sah di hari libur karyawan itu.
    if ((KELOMPOK_TIDAK_HADIR as readonly string[]).includes(jenis.kelompok)) {
      if (wajib.length === 0) throw new Error(PESAN_TANPA_HARI_KERJA);
      const maks = periksaMaks(
        jenis,
        wajib.length,
        hariKalender(v.tanggal_mulai, v.tanggal_selesai),
      );
      if (!maks.ok) throw new Error(maks.pesan);
    }
    // Nota bulan lalu yang gajinya sudah dibayar adalah kasus biasa (§19.3).
    if (!reimburse) {
      await tolakBilaDibayar(tx, v.tanggal_mulai, v.tanggal_selesai);
    }

    let pengaju = actor.username;
    let createdAt: string | null = null;
    if (idMasuk) {
      const lama = await bacaSatuPengajuan(tx, idMasuk);
      if (!lama) throw new Error("Pengajuan tidak ditemukan.");
      const kep = (await bacaKeputusan(tx, [idMasuk])).get(idMasuk) ?? [];
      const sunting = periksaSunting(
        statusPengajuan(lama.sidik, kep),
        samaOrang(lama.diajukan_oleh, actor.username),
        actor.isSuperadmin,
      );
      if (!sunting.ok) throw new Error(sunting.pesan);
      if (lama.kelompok !== "Reimburse") {
        await tolakBilaDibayar(tx, lama.tanggal_mulai, lama.tanggal_selesai);
      }
      pengaju = lama.diajukan_oleh;
      createdAt = lama.created_at;
    }

    const baru: Ringkas = {
      kelompok: jenis.kelompok,
      id_karyawan: v.id_karyawan,
      id_karyawan_tukar: idTukar,
      tanggal_mulai: v.tanggal_mulai,
      tanggal_selesai: v.tanggal_selesai,
      setengah_hari: v.setengah_hari,
      jam_mulai: jamMulai,
      jam_selesai: jamSelesai,
    };
    const lain: BarisPengajuan[] = [];
    for (const orang of idTukar === null
      ? [v.id_karyawan]
      : [v.id_karyawan, idTukar]) {
      for (const p of await bacaPengajuan(
        tx,
        orang,
        v.tanggal_mulai,
        v.tanggal_selesai,
      )) {
        if (
          p.id_pengajuan !== idMasuk &&
          !lain.some((q) => q.id_pengajuan === p.id_pengajuan)
        ) {
          lain.push(p);
        }
      }
    }
    const kepLain = await bacaKeputusan(
      tx,
      lain.map((p) => p.id_pengajuan),
    );
    for (const p of lain) {
      const status = statusPengajuan(
        p.sidik,
        kepLain.get(p.id_pengajuan) ?? [],
      );
      if (
        (status === "Menunggu" || statusBerlaku(status)) &&
        bentrokPengajuan(baru, ringkasPengajuan(p))
      ) {
        throw new Error(pesanBertumpuk(p.tanggal_mulai, p.tanggal_selesai));
      }
    }

    const id = idMasuk ?? newHexId("pgn-");
    const sidik = sidikPengajuan({
      id_karyawan: v.id_karyawan,
      id_jenis: v.id_jenis,
      kelompok: jenis.kelompok,
      potong_jatah: jenis.potong_jatah,
      dampak_gaji: jenis.dampak_gaji,
      tanggal_mulai: v.tanggal_mulai,
      tanggal_selesai: v.tanggal_selesai,
      setengah_hari: v.setengah_hari,
      alasan: v.alasan,
      jam_mulai: jamMulai,
      jam_selesai: jamSelesai,
      id_karyawan_tukar: idTukar,
      id_shift_asal: idShiftAsal,
      id_shift_tukar: idShiftTukar,
      nominal,
    });
    await tx.execute({
      sql: UPSERT_PENGAJUAN_SQL,
      args: [
        id,
        v.id_karyawan,
        v.id_jenis,
        jenis.kelompok,
        jenis.potong_jatah ? 1 : 0,
        jenis.dampak_gaji,
        v.tanggal_mulai,
        v.tanggal_selesai,
        v.setengah_hari ? 1 : 0,
        v.alasan,
        sidik,
        pengaju,
        await waktuSekarang(tx),
        createdAt,
        jamMulai,
        jamSelesai,
        idTukar,
        idShiftAsal,
        idShiftTukar,
        nominal,
      ],
    });
    if (v.urgent) {
      await tulisKeputusan(
        tx,
        `urgent-${id}`,
        id,
        "Setujui Urgent",
        sidik,
        null,
        actor.username,
      );
    }
    return {
      sukses: true as const,
      id_pengajuan: id,
      hari_kerja: wajib.length,
    };
  });
}

/** Cermin `shift_tukar_baru`. */
async function shiftTukarBaru(
  db: Pembaca,
  idKaryawan: string,
  idTukar: string,
  tanggal: string,
): Promise<[number, number]> {
  const shift = async (id: string, wajibAktif: boolean) => {
    const r = await db.execute({
      sql: "SELECT id_shift FROM master_data WHERE id_unik = ?1 AND (?2 = 0 OR status_aktif = 'Aktif');",
      args: [id, wajibAktif ? 1 : 0],
    });
    const nilai = r.rows[0]?.id_shift;
    return nilai === null || nilai === undefined ? null : Number(nilai);
  };
  const asal = await shift(idKaryawan, false);
  if (asal === null) throw new Error(PESAN_TUKAR_SHIFT_HILANG);
  const lain = await shift(idTukar, true);
  if (lain === null) throw new Error(PESAN_TUKAR_NONAKTIF);
  if (asal === lain) throw new Error(PESAN_TUKAR_SHIFT_SAMA);
  const ada = await db.execute({
    sql: "SELECT COUNT(*) AS n FROM tbl_shift WHERE id_shift IN (?1, ?2);",
    args: [asal, lain],
  });
  if (Number(ada.rows[0]?.n) !== 2) throw new Error(PESAN_TUKAR_SHIFT_HILANG);
  const backup = await db.execute({
    sql: BACKUP_TUKAR_SQL,
    args: [tanggal, idKaryawan, idTukar],
  });
  if (backup.rows.length > 0) throw new Error(PESAN_TUKAR_BACKUP);
  return [asal, lain];
}

/** Cermin `putuskan`. */
export async function putuskan(
  client: Client,
  actor: OperatorUser,
  raw: unknown,
) {
  const draft = (raw ?? {}) as Baris;
  const id = teksId(draft.id_pengajuan);
  if (!id) throw new Error("Pengajuan tidak ditemukan.");
  const aksi = typeof draft.aksi === "string" ? draft.aksi.trim() : "";
  const alasan = typeof draft.alasan === "string" ? draft.alasan.trim() : "";
  const mentah = draft.nominal_disetujui;
  const nominalDisetujui =
    mentah === undefined || mentah === null || mentah === "" ? null : mentah;
  if (nominalDisetujui !== null && !Number.isInteger(nominalDisetujui)) {
    throw new Error("Nominal disetujui harus bilangan bulat rupiah.");
  }
  const idKaryawanSesi = await karyawanAktor(client, actor);
  return withTransaction(client, async (tx) => {
    const p = await bacaSatuPengajuan(tx, id);
    if (!p) throw new Error("Pengajuan tidak ditemukan.");
    const reimburse = p.kelompok === "Reimburse";
    const kep = (await bacaKeputusan(tx, [id])).get(id) ?? [];
    const status = statusPengajuan(p.sidik, kep);
    const izinPemutus =
      (await bacaJenisSemua(tx)).find((j) => j.id_jenis === p.id_jenis)
        ?.izin_pemutus ?? IZIN_PEMUTUS_AKTIF;
    const cek = periksaAksi(aksi, alasan, nominalDisetujui as number | null, {
      status,
      sudah_diketahui: kep.some((k) => k.jenis === "Diketahui"),
      pengaju_sendiri: samaOrang(p.diajukan_oleh, actor.username),
      superadmin: actor.isSuperadmin,
      karyawan_sendiri:
        idKaryawanSesi === p.id_karyawan ||
        (p.id_karyawan_tukar !== null &&
          idKaryawanSesi === p.id_karyawan_tukar),
      boleh_putus: punya(actor, izinPemutus),
      reimburse,
      nominal: p.nominal ?? 0,
    });
    if (!cek.ok) throw new Error(cek.pesan);
    if (reimburse) {
      // Klaim yang sudah dibayar atau ada di proses gaji tidak dibatalkan (§19.3).
      if (aksi === "Batal") {
        const { pembayaran, baris } = await muatBayar(tx);
        const gaji = await muatGajiReimburse(tx);
        if (statusBayar(id, pembayaran, baris, gaji) !== STATUS_BELUM_DIBAYAR) {
          throw new Error(PESAN_KLAIM_DIBAYAR);
        }
      }
    } else if (aksi === "Setujui" || aksi === "Batal") {
      await tolakBilaDibayar(tx, p.tanggal_mulai, p.tanggal_selesai);
    }
    const idKeputusan =
      aksi === "Diketahui"
        ? `tahu-${id}`
        : aksi === "Batal"
          ? `batal-${id}`
          : newHexId("kpt-");
    await tulisKeputusan(
      tx,
      idKeputusan,
      id,
      aksi,
      p.sidik,
      alasan || null,
      actor.username,
      nominalDisetujui as number | null,
    );
    return { sukses: true as const, id_keputusan: idKeputusan };
  });
}

const tanggalAtau = (nilai: unknown, bawaan: string) =>
  typeof nilai === "string" && /^\d{4}-\d{2}-\d{2}$/.test(nilai)
    ? nilai
    : bawaan;

/** Cermin `info_klaim`: status bayar, dibayar ganda, dan lewat batas. */
async function infoKlaim(
  db: Pembaca,
  baris: readonly BarisPengajuan[],
  jenis: readonly JenisPengajuan[],
) {
  const info = {
    statusBayar: new Map<string, StatusBayar>(),
    ganda: new Set<string>(),
    lewatBatas: new Set<string>(),
  };
  const klaim = baris.filter((p) => p.kelompok === "Reimburse");
  if (klaim.length === 0) return info;
  const tanggal = klaim.map((p) => p.tanggal_mulai).sort();
  const { pembayaran, baris: barisBayar } = await muatBayar(db);
  const gaji = await muatGajiReimburse(db);
  for (const p of klaim) {
    const id = p.id_pengajuan;
    info.statusBayar.set(id, statusBayar(id, pembayaran, barisBayar, gaji));
    if (dibayarGanda(id, pembayaran, barisBayar, gaji)) info.ganda.add(id);
  }
  // Batas dihitung atas seluruh klaim di bulan-bulan itu, bukan hanya yang tersaring.
  const sebulan = (
    await bacaPengajuan(
      db,
      null,
      `${(tanggal[0] ?? "").slice(0, 7)}-01`,
      `${(tanggal.at(-1) ?? "").slice(0, 7)}-31`,
    )
  ).filter((p) => p.kelompok === "Reimburse");
  const keputusan = await bacaKeputusan(
    db,
    sebulan.map((p) => p.id_pengajuan),
  );
  const hitung: Array<[string, string, string, number]> = [];
  for (const p of sebulan) {
    const kep = keputusan.get(p.id_pengajuan) ?? [];
    const status = statusPengajuan(p.sidik, kep);
    const nominal = p.nominal ?? 0;
    if (status === "Menunggu") {
      hitung.push([p.id_karyawan, p.id_jenis, p.tanggal_mulai, nominal]);
    } else if (statusBerlaku(status)) {
      hitung.push([
        p.id_karyawan,
        p.id_jenis,
        p.tanggal_mulai,
        nominalBerlaku(nominal, keputusanBerlaku(p.sidik, kep)),
      ]);
    }
  }
  const batas = new Map<string, number>();
  for (const j of jenis) {
    if (j.batas_bulanan !== null) batas.set(j.id_jenis, j.batas_bulanan);
  }
  info.lewatBatas = lewatBatas(hitung, batas);
  return info;
}

/**
 * Cermin `daftar`. Tanpa `hr.request.view`, hanya klaim Reimburse yang
 * dikembalikan (§19.5).
 */
export async function daftarPengajuan(
  client: Client,
  raw: unknown,
  hanyaReimburse = false,
) {
  const filter = (raw ?? {}) as Baris;
  const baris = (
    await bacaPengajuan(
      client,
      teksId(filter.id_karyawan),
      tanggalAtau(filter.dari, "0000-01-01"),
      tanggalAtau(filter.sampai, "9999-12-31"),
    )
  ).filter((p) => !hanyaReimburse || p.kelompok === "Reimburse");
  const keputusan = await bacaKeputusan(
    client,
    baris.map((p) => p.id_pengajuan),
  );
  const jenis = await bacaJenisSemua(client);
  const info = await infoKlaim(client, baris, jenis);
  const namaRes = await client.execute(
    "SELECT id_unik, nama FROM master_data;",
  );
  const nama = new Map(
    namaRes.rows.map((r) => [String(r.id_unik), String(r.nama)]),
  );
  const awal = baris.map((p) => p.tanggal_mulai).sort()[0] ?? "0000-01-01";
  const akhir =
    baris
      .map((p) => p.tanggal_selesai)
      .sort()
      .at(-1) ?? "0000-01-01";
  const jadwal = await muatJadwal(client);
  const kalender = await muatKalender(client, awal, akhir);
  const hadir = await muatHadir(client, awal, akhir);
  const status = baris.map((p) =>
    statusPengajuan(p.sidik, keputusan.get(p.id_pengajuan) ?? []),
  );
  const aktif = (s: string) => s === "Menunggu" || statusBerlaku(s);
  const aturanLembur = await bacaAturanLembur(client);
  const menitLembur = (p: BarisPengajuan) => {
    const d = durasiLembur(p.jam_mulai ?? "", p.jam_selesai ?? "");
    return d.ok ? d.nilai : null;
  };
  const splAktif = new Map<string, Array<[string, number]>>();
  baris.forEach((p, i) => {
    if (p.kelompok === "Lembur" && aktif(status[i] ?? "")) {
      const daftar = splAktif.get(p.id_karyawan) ?? [];
      daftar.push([p.tanggal_mulai, menitLembur(p) ?? 0]);
      splAktif.set(p.id_karyawan, daftar);
    }
  });
  const lewatBatas = new Map(
    [...splAktif].map(([id, spl]) => [
      id,
      lemburLewatBatas(
        spl,
        aturanLembur.maks_harian * 60,
        aturanLembur.maks_mingguan * 60,
      ),
    ]),
  );
  const pengajuan = baris.map((p, i) => {
    const kep = keputusan.get(p.id_pengajuan) ?? [];
    const statusIni = status[i] ?? "Menunggu";
    const tanda = tandaKeputusan(p.sidik, p.diajukan_oleh, kep);
    if (
      aktif(statusIni) &&
      baris.some(
        (q, j) =>
          j !== i &&
          aktif(status[j] ?? "") &&
          bentrokPengajuan(ringkasPengajuan(p), ringkasPengajuan(q)),
      )
    ) {
      tanda.push("bertumpuk");
    }
    if (
      p.kelompok === "Lembur" &&
      aktif(statusIni) &&
      lewatBatas.get(p.id_karyawan)?.has(p.tanggal_mulai)
    ) {
      tanda.push("lembur_lewat_batas");
    }
    const j = (KELOMPOK_TIDAK_HADIR as readonly string[]).includes(p.kelompok)
      ? jadwal.get(p.id_karyawan)
      : undefined;
    const wajib = j
      ? tanggalWajib(j, kalender, p.tanggal_mulai, p.tanggal_selesai)
      : [];
    if (statusBerlaku(statusIni) && !p.setengah_hari) {
      const h = hadir.get(p.id_karyawan);
      if (h && wajib.some((t) => h.has(t))) tanda.push("hadir_saat_cuti");
    }
    const jenisIni = jenis.find((x) => x.id_jenis === p.id_jenis);
    const reimburse = p.kelompok === "Reimburse";
    const statusBayarIni = info.statusBayar.get(p.id_pengajuan) ?? null;
    if (reimburse) {
      if (
        aktif(statusIni) &&
        info.lewatBatas.has(
          kunciBatas(p.id_karyawan, p.id_jenis, p.tanggal_mulai),
        )
      ) {
        tanda.push("lewat_batas");
      }
      if (info.ganda.has(p.id_pengajuan)) tanda.push("dibayar_ganda");
      if (!statusBerlaku(statusIni) && statusBayarIni === STATUS_DIBAYAR) {
        tanda.push("dibayar_batal");
      }
    }
    return {
      pengajuan: p,
      nominal_berlaku:
        reimburse && p.nominal !== null && statusBerlaku(statusIni)
          ? nominalBerlaku(p.nominal, keputusanBerlaku(p.sidik, kep))
          : null,
      status_bayar: statusBayarIni,
      batas_bulanan: jenisIni?.batas_bulanan ?? null,
      nama_karyawan: nama.get(p.id_karyawan) ?? null,
      nama_karyawan_tukar:
        p.id_karyawan_tukar === null
          ? null
          : (nama.get(p.id_karyawan_tukar) ?? null),
      menit_lembur: menitLembur(p),
      nama_jenis: jenisIni?.nama ?? null,
      izin_pemutus: jenisIni?.izin_pemutus ?? IZIN_PEMUTUS_AKTIF,
      wajib_dokumen: jenisIni?.wajib_dokumen ?? false,
      status: statusIni,
      tanda,
      hari_kerja: wajib.length,
      sudah_diketahui: kep.some((k) => k.jenis === "Diketahui"),
    };
  });
  return {
    pengajuan,
    jenis,
    aturan_lembur: aturanLembur,
    mode_reimburse: await bacaModeReimburse(client),
  };
}

/** Cermin `rincian`. */
export async function rincianPengajuan(
  client: Client,
  id: string,
  hanyaReimburse = false,
) {
  if (
    hanyaReimburse &&
    (await bacaSatuPengajuan(client, id))?.kelompok !== "Reimburse"
  ) {
    throw new AuthorizationError(
      "Kamu hanya bisa melihat klaim reimbursement.",
      403,
    );
  }
  const r = await client.execute({
    sql: `SELECT id_keputusan, jenis, sidik, alasan, oleh, waktu_perangkat, diterima_cloud, nominal_disetujui
          FROM hr_pengajuan_keputusan WHERE id_pengajuan = ?1
          ORDER BY diterima_cloud IS NULL, diterima_cloud, waktu_perangkat, id_keputusan;`,
    args: [id],
  });
  return { keputusan: r.rows.map((x) => ({ ...x })) };
}

async function bacaAturan(db: Pembaca) {
  const r = await db.execute(
    "SELECT key, value FROM setting_gex_system WHERE key LIKE 'hr\\_cuti\\_%' ESCAPE '\\';",
  );
  return aturanCutiDariPeta(
    new Map(r.rows.map((x) => [String(x.key), String(x.value)])),
  );
}

async function bacaPenyesuaian(db: Pembaca, idKaryawan: string) {
  const r = await db.execute({
    sql: "SELECT * FROM hr_cuti_penyesuaian WHERE id_karyawan = ?1 ORDER BY periode, created_at, id_penyesuaian;",
    args: [idKaryawan],
  });
  const semua = r.rows.map((x) => ({ ...x }) as Baris);
  const batal = new Set(
    semua.filter((b) => b.jenis === "Pembatalan").map((b) => String(b.id_ref)),
  );
  return semua
    .filter((b) => b.jenis !== "Pembatalan")
    .map((b) => ({
      baris: b,
      dibatalkan: batal.has(String(b.id_penyesuaian)),
    }));
}

/** Cermin `hitung_jatah`. */
async function hitungJatah(db: Pembaca, idKaryawan: string) {
  const aturan = await bacaAturan(db);
  const m = await db.execute({
    sql: "SELECT NULLIF(TRIM(tanggal_daftar), '') AS t FROM master_data WHERE id_unik = ?1;",
    args: [idKaryawan],
  });
  const masuk = teksId(m.rows[0]?.t);
  const berlaku = (await muatBerlaku(db, "0000-01-01", "9999-12-31")).filter(
    (p) => p.id_karyawan === idKaryawan && p.potong_jatah,
  );
  let terpakai: string[] = [];
  if (berlaku.length > 0) {
    const awal = berlaku.map((p) => p.tanggal_mulai).sort()[0] ?? "";
    const akhir =
      berlaku
        .map((p) => p.tanggal_selesai)
        .sort()
        .at(-1) ?? "";
    const j = (await muatJadwal(db)).get(idKaryawan);
    const kalender = await muatKalender(db, awal, akhir);
    const hadir =
      (await muatHadir(db, awal, akhir)).get(idKaryawan) ?? new Set<string>();
    if (j) {
      const unik = new Set<string>();
      for (const p of berlaku) {
        for (const t of tanggalWajib(
          j,
          kalender,
          p.tanggal_mulai,
          p.tanggal_selesai,
        )) {
          if (!hadir.has(t)) unik.add(t);
        }
      }
      terpakai = [...unik].sort();
    }
  }
  const penyesuaian = await bacaPenyesuaian(db, idKaryawan);
  const adj = penyesuaian
    .filter((p) => !p.dibatalkan)
    .map((p) => [String(p.baris.periode), Number(p.baris.hari)] as const);
  const periode = periodeCuti(
    masuk,
    aturan,
    terpakai,
    adj,
    await hariIniWib(db),
  );
  return { aturan, tanggal_masuk: masuk, periode, penyesuaian };
}

/** Cermin `status_bayar_uang`: status bayar setiap penyesuaian `Diuangkan`. */
async function statusBayarUang(
  db: Pembaca,
  penyesuaian: ReadonlyArray<{ baris: Baris }>,
): Promise<Map<string, StatusBayar>> {
  const hasil = new Map<string, StatusBayar>();
  const uang = penyesuaian.filter((x) => x.baris.jenis === "Diuangkan");
  if (uang.length === 0) return hasil;
  const { pembayaran, baris } = await muatBayar(db);
  for (const x of uang) {
    const id = String(x.baris.id_penyesuaian);
    hasil.set(id, statusBayar(id, pembayaran, baris, []));
  }
  return hasil;
}

/**
 * Sisa cuti periode yang memuat `tanggal` dan upah harian pada tanggal itu:
 * dasar baris UPH Cuti saat karyawan keluar (§20.5). Cermin `sisa_cuti_keluar`.
 */
export async function sisaCutiKeluar(
  db: Pembaca,
  idKaryawan: string,
  tanggal: string,
): Promise<{ sisa: number; upah_harian: number }> {
  const { periode } = await hitungJatah(db, idKaryawan);
  const p = periode.find(
    (x) => !x.sebelum_berhak && x.mulai <= tanggal && tanggal <= x.selesai,
  );
  const g = await db.execute({
    sql: `SELECT COALESCE(salary_type, 'HOURLY') AS t, COALESCE(daily_rate, 0) AS d, COALESCE(rate_per_hour, 0) AS r
          FROM salary_configs WHERE id_karyawan = ?1 AND effective_date <= ?2
          ORDER BY effective_date DESC LIMIT 1;`,
    args: [idKaryawan, tanggal],
  });
  const gaji = g.rows[0];
  const normal = (await muatJadwal(db)).get(idKaryawan)?.jam_normal_menit ?? 0;
  return {
    sisa: Math.max(p?.sisa ?? 0, 0),
    upah_harian: gaji
      ? upahHarian(String(gaji.t), Number(gaji.d), Number(gaji.r), normal)
      : 0,
  };
}

/** Cermin `jatah`. */
export async function jatahCuti(client: Client, idKaryawan: string) {
  const jatah = await hitungJatah(client, idKaryawan);
  const bayar = await statusBayarUang(client, jatah.penyesuaian);
  return {
    ...jatah,
    penyesuaian: jatah.penyesuaian.map((x) => ({
      ...x,
      status_bayar: bayar.get(String(x.baris.id_penyesuaian)) ?? null,
    })),
  };
}

/** Cermin `simpan_penyesuaian`. */
export async function simpanPenyesuaian(
  client: Client,
  oleh: string,
  raw: unknown,
) {
  const sah = validasiPenyesuaian((raw ?? {}) as Baris);
  if (!sah.ok) throw new Error(sah.pesan);
  const v = sah.nilai;
  return withTransaction(client, async (tx) => {
    const { periode } = await hitungJatah(tx, v.id_karyawan);
    if (!periode.some((p) => p.mulai === v.periode)) {
      throw new Error("Periode itu bukan periode cuti karyawan ini.");
    }
    const id = newHexId("cps-");
    await tx.execute({
      sql: INSERT_PENYESUAIAN_SQL,
      args: [
        id,
        v.id_karyawan,
        v.periode,
        v.jenis,
        null,
        v.hari,
        null,
        v.alasan,
        oleh,
        null,
      ],
    });
    return { sukses: true as const, id_penyesuaian: id };
  });
}

/** Cermin `batal_penyesuaian`. */
export async function batalPenyesuaian(
  client: Client,
  oleh: string,
  raw: unknown,
) {
  const draft = (raw ?? {}) as Baris;
  const id = teksId(draft.id_penyesuaian);
  if (!id) throw new Error("Penyesuaian tidak ditemukan.");
  const alasan = typeof draft.alasan === "string" ? draft.alasan.trim() : "";
  if (alasan === "") throw new Error("Alasan pembatalan wajib diisi.");
  if ([...alasan].length > 500) {
    throw new Error("Alasan maksimal 500 karakter.");
  }
  return withTransaction(client, async (tx) => {
    const r = await tx.execute({
      sql: "SELECT id_karyawan, periode, jenis FROM hr_cuti_penyesuaian WHERE id_penyesuaian = ?1;",
      args: [id],
    });
    const row = r.rows[0];
    if (!row) throw new Error("Penyesuaian tidak ditemukan.");
    const idBatal = `batal-${id}`;
    const sudah = await tx.execute({
      sql: "SELECT 1 FROM hr_cuti_penyesuaian WHERE id_penyesuaian = ?1;",
      args: [idBatal],
    });
    if (row.jenis === "Pembatalan" || sudah.rows.length > 0) {
      throw new Error("Penyesuaian ini sudah dibatalkan.");
    }
    if (row.jenis === "Diuangkan") {
      const { pembayaran, baris } = await muatBayar(tx);
      if (statusBayar(id, pembayaran, baris, []) === STATUS_DIBAYAR) {
        throw new Error(PESAN_UANG_DIBAYAR);
      }
    }
    await tx.execute({
      sql: INSERT_PENYESUAIAN_SQL,
      args: [
        idBatal,
        String(row.id_karyawan),
        String(row.periode),
        "Pembatalan",
        id,
        0,
        null,
        alasan,
        oleh,
        null,
      ],
    });
    return { sukses: true as const, id_penyesuaian: idBatal };
  });
}

/** Cermin `proses_akhir_periode`. */
export async function prosesAkhirPeriode(
  client: Client,
  oleh: string,
  raw: unknown,
) {
  const draft = (raw ?? {}) as Baris;
  const idKaryawan = teksId(draft.id_karyawan);
  if (!idKaryawan) throw new Error("Pilih karyawan.");
  const periodeKunci = teksId(draft.periode);
  if (!periodeKunci) throw new Error("Periode tidak valid.");
  return withTransaction(client, async (tx) => {
    const { aturan, periode } = await hitungJatah(tx, idKaryawan);
    if (aturan.sisa !== "diuangkan") {
      throw new Error("Sisa cuti tidak diatur untuk diuangkan.");
    }
    const hariIni = await hariIniWib(tx);
    const p = periode.find(
      (x) => x.mulai === periodeKunci && !x.sebelum_berhak,
    );
    if (!p) throw new Error("Periode itu bukan periode cuti karyawan ini.");
    if (p.selesai >= hariIni) throw new Error("Periode itu belum berakhir.");
    const id = idUang(idKaryawan, periodeKunci);
    const sudah = await tx.execute({
      sql: "SELECT 1 FROM hr_cuti_penyesuaian WHERE id_penyesuaian = ?1;",
      args: [id],
    });
    if (sudah.rows.length > 0) throw new Error("Periode ini sudah diproses.");
    if (p.sisa <= 0) throw new Error("Tidak ada sisa cuti untuk diuangkan.");
    const g = await tx.execute({
      sql: `SELECT COALESCE(salary_type, 'HOURLY') AS t, COALESCE(daily_rate, 0) AS d, COALESCE(rate_per_hour, 0) AS r
            FROM salary_configs WHERE id_karyawan = ?1 AND effective_date <= ?2
            ORDER BY effective_date DESC LIMIT 1;`,
      args: [idKaryawan, p.selesai],
    });
    const gaji = g.rows[0];
    if (!gaji) throw new Error("Karyawan ini belum punya pengaturan gaji.");
    const normal =
      (await muatJadwal(tx)).get(idKaryawan)?.jam_normal_menit ?? 0;
    const nominal =
      p.sisa *
      upahHarian(String(gaji.t), Number(gaji.d), Number(gaji.r), normal);
    const alasan = `Sisa cuti periode ${p.mulai} s.d. ${p.selesai} diuangkan.`;
    await tx.execute({
      sql: INSERT_PENYESUAIAN_SQL,
      args: [
        id,
        idKaryawan,
        periodeKunci,
        "Diuangkan",
        null,
        -p.sisa,
        nominal,
        alasan,
        oleh,
        null,
      ],
    });
    return {
      sukses: true as const,
      id_penyesuaian: id,
      hari: p.sisa,
      nominal,
    };
  });
}

/** Cermin `akhir_periode`. */
export async function akhirPeriode(client: Client) {
  const aturan = await bacaAturan(client);
  const belum: Array<{
    id_karyawan: string;
    nama: string;
    periode: PeriodeCuti;
  }> = [];
  const diuangkan: Array<{
    nama: string;
    baris: Baris;
    status_bayar: StatusBayar | null;
  }> = [];
  if (aturan.sisa === "diuangkan") {
    const hariIni = await hariIniWib(client);
    const k = await client.execute(
      "SELECT id_unik, nama FROM master_data WHERE status_aktif = 'Aktif' ORDER BY nama;",
    );
    for (const row of k.rows) {
      const id = String(row.id_unik);
      const nama = String(row.nama);
      const { periode, penyesuaian } = await hitungJatah(client, id);
      for (const p of periode) {
        if (p.sebelum_berhak || p.selesai >= hariIni || p.sisa <= 0) continue;
        const kunci = idUang(id, p.mulai);
        if (!penyesuaian.some((x) => x.baris.id_penyesuaian === kunci)) {
          belum.push({ id_karyawan: id, nama, periode: p });
        }
      }
      const bayar = await statusBayarUang(client, penyesuaian);
      for (const x of penyesuaian) {
        if (x.baris.jenis === "Diuangkan" && !x.dibatalkan) {
          diuangkan.push({
            nama,
            baris: x.baris,
            status_bayar: bayar.get(String(x.baris.id_penyesuaian)) ?? null,
          });
        }
      }
    }
  }
  return {
    aturan,
    aturan_lembur: await bacaAturanLembur(client),
    mode_reimburse: await bacaModeReimburse(client),
    belum_diproses: belum,
    diuangkan,
  };
}

/** Cermin `simpan_aturan`: aturan cuti dan lembur. */
export async function simpanAturanCuti(client: Client, raw: unknown) {
  const hasil = validasiAturanCuti((raw ?? {}) as Baris);
  if (!hasil.ok) throw new Error(hasil.pesan);
  const lembur = validasiAturanLembur((raw ?? {}) as Baris);
  if (!lembur.ok) throw new Error(lembur.pesan);
  const reimburse = validasiAturanReimburse((raw ?? {}) as Baris);
  if (!reimburse.ok) throw new Error(reimburse.pesan);
  await withTransaction(client, async (tx) => {
    for (const [kunci, nilai] of [
      ...hasil.nilai,
      ...lembur.nilai,
      ...reimburse.nilai,
    ]) {
      await tx.execute({
        sql: `INSERT INTO setting_gex_system (key, value) VALUES (?1, ?2)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value;`,
        args: [kunci, nilai],
      });
    }
  });
  return { sukses: true as const };
}

// ── Pembayaran terpisah (§19.4), cermin `catat_bayar_reimburse` dkk. ───────

/** Cermin `catat_bayar_reimburse`. */
export async function catatBayarReimburse(
  client: Client,
  oleh: string,
  raw: unknown,
) {
  return withTransaction(client, async (tx) => {
    const valid = validasiBayarReimburse(
      (raw ?? {}) as Baris,
      await hariIniWib(tx),
    );
    if (!valid.ok) throw new Error(valid.pesan);
    const klaim = await muatKlaim(tx, "9999-12-31");
    const { pembayaran, baris } = await muatBayar(tx);
    const gaji = await muatGajiReimburse(tx);
    const dibayar = periksaBayarReimburse(
      valid.nilai,
      klaim,
      pembayaran,
      baris,
      gaji,
    );
    if (!dibayar.ok) throw new Error(dibayar.pesan);
    const total = dibayar.nilai.reduce((n, k) => n + k.nominal, 0);
    const idBayar = newHexId("rbb-");
    await tx.execute({
      sql: CLOUD_INSERT_BAYAR_REIMBURSE_SQL,
      args: [
        idBayar,
        "Bayar",
        null,
        valid.nilai.id_karyawan,
        valid.nilai.tanggal,
        total,
        valid.nilai.keterangan,
        oleh,
        null,
      ],
    });
    for (const k of dibayar.nilai) {
      await tx.execute({
        sql: CLOUD_INSERT_BARIS_REIMBURSE_SQL,
        args: [
          idBarisReimburse(idBayar, k.id_klaim),
          idBayar,
          k.sumber,
          k.id_klaim,
          k.nominal,
        ],
      });
    }
    return { sukses: true as const, id_bayar: idBayar, total };
  });
}

/** Cermin `batal_bayar_reimburse`. */
export async function batalBayarReimburse(
  client: Client,
  oleh: string,
  raw: unknown,
) {
  const draft = (raw ?? {}) as Baris;
  const idBayar = teksId(draft.id_bayar);
  if (!idBayar) throw new Error("Pembayaran tidak ditemukan.");
  const alasan = typeof draft.alasan === "string" ? draft.alasan.trim() : "";
  if (alasan === "") throw new Error("Alasan pembatalan wajib diisi.");
  if ([...alasan].length > 500) {
    throw new Error("Alasan maksimal 500 karakter.");
  }
  return withTransaction(client, async (tx) => {
    const { pembayaran } = await muatBayar(tx);
    const cek = periksaBatalBayarReimburse(pembayaran, idBayar);
    if (!cek.ok) throw new Error(cek.pesan);
    const asal = pembayaran.find((p) => p.id_bayar === idBayar);
    const id = idBatalReimburse(idBayar);
    await tx.execute({
      sql: CLOUD_INSERT_BAYAR_REIMBURSE_SQL,
      args: [
        id,
        "Pembatalan",
        idBayar,
        asal?.id_karyawan ?? "",
        await hariIniWib(tx),
        asal?.total ?? 0,
        alasan,
        oleh,
        null,
      ],
    });
    return { sukses: true as const, id_bayar: id };
  });
}

/** Cermin `ringkasan_reimburse`. */
export async function ringkasanReimburse(client: Client, raw: unknown) {
  const draft = (raw ?? {}) as Baris;
  const dari = typeof draft.dari === "string" ? draft.dari.trim() : "";
  const sampai = typeof draft.sampai === "string" ? draft.sampai.trim() : "";
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(dari) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(sampai) ||
    dari > sampai
  ) {
    throw new Error("Rentang tanggal tidak valid.");
  }
  const namaRes = await client.execute(
    "SELECT id_unik, nama FROM master_data;",
  );
  const nama = new Map(
    namaRes.rows.map((r) => [String(r.id_unik), String(r.nama)]),
  );
  const klaim = await muatKlaim(client, "9999-12-31");
  const { pembayaran, baris } = await muatBayar(client);
  const gaji = await muatGajiReimburse(client);
  const belum: Array<{ klaim: Klaim; nama: string | null }> = [];
  const prosesGaji: Array<{ klaim: Klaim; nama: string | null }> = [];
  for (const k of klaim) {
    const item = { klaim: k, nama: nama.get(k.id_karyawan) ?? null };
    const status = statusBayar(k.id_klaim, pembayaran, baris, gaji);
    if (status === STATUS_BELUM_DIBAYAR) belum.push(item);
    else if (status === STATUS_PROSES_GAJI) prosesGaji.push(item);
  }
  const riwayat = pembayaran
    .filter(
      (p) => p.jenis === "Bayar" && p.tanggal >= dari && p.tanggal <= sampai,
    )
    .reverse()
    .map((p) => ({
      bayar: p,
      nama: nama.get(p.id_karyawan) ?? null,
      batal:
        pembayaran.find(
          (x) => x.jenis === "Pembatalan" && x.id_ref === p.id_bayar,
        ) ?? null,
      baris: baris
        .filter((b) => b.id_bayar === p.id_bayar)
        .map((b) => ({
          baris: b,
          keterangan:
            klaim.find((k) => k.id_klaim === b.id_klaim)?.keterangan ?? null,
        })),
    }));
  return {
    mode: await bacaModeReimburse(client),
    belum_dibayar: belum,
    proses_gaji: prosesGaji,
    riwayat,
  };
}

// ── Lampiran khusus cloud (Q-51), cermin `lampiran`/`tambah_lampiran` ──────

/** Cermin `PENGAJU_CLOUD_SQL`. */
async function pengajuCloud(db: Pembaca, idPengajuan: string) {
  const r = await db.execute({
    sql: "SELECT p.diajukan_oleh, p.kelompok, COALESCE((SELECT j.izin_pemutus FROM hr_jenis_pengajuan j WHERE j.id_jenis = p.id_jenis), 'hr.request.decide') AS izin_pemutus FROM hr_pengajuan p WHERE p.id_pengajuan = ?1;",
    args: [idPengajuan],
  });
  const x = r.rows[0];
  return x
    ? {
        pengaju: String(x.diajukan_oleh),
        kelompok: String(x.kelompok),
        izin_pemutus: String(x.izin_pemutus),
      }
    : null;
}

/** Pengaju, HRD, atau pemegang pemutus jenisnya (nota reimbursement). */
function bolehUbahLampiran(
  actor: OperatorUser,
  pengaju: string,
  izinPemutus: string,
) {
  if (
    !samaOrang(pengaju, actor.username) &&
    !punya(actor, "hr.request.decide") &&
    !punya(actor, izinPemutus)
  ) {
    throw new AuthorizationError(
      "Hanya pengaju atau pemutusnya yang bisa mengubah lampiran pengajuan ini.",
      403,
    );
  }
}

/** Tanpa `hr.request.view`, lampiran hanya terbaca untuk klaim Reimburse. */
async function bolehBacaLampiran(
  db: Pembaca,
  idPengajuan: string,
  hanyaReimburse: boolean,
) {
  if (
    hanyaReimburse &&
    (await pengajuCloud(db, idPengajuan))?.kelompok !== "Reimburse"
  ) {
    throw new AuthorizationError(
      "Kamu hanya bisa melihat nota reimbursement.",
      403,
    );
  }
}

export async function lampiran(
  client: Client,
  idPengajuan: string,
  hanyaReimburse = false,
) {
  await bolehBacaLampiran(client, idPengajuan, hanyaReimburse);
  const r = await client.execute({
    sql: "SELECT id_berkas, urutan, nama_berkas, mime_type, diunggah_oleh, created_at FROM hr_pengajuan_berkas WHERE id_pengajuan = ?1 ORDER BY urutan;",
    args: [idPengajuan],
  });
  return { berkas: r.rows.map((x) => ({ ...x })) };
}

export async function isiLampiran(
  client: Client,
  idBerkas: string,
  hanyaReimburse = false,
) {
  const r = await client.execute({
    sql: "SELECT id_berkas, id_pengajuan, nama_berkas, mime_type, data_base64 FROM hr_pengajuan_berkas WHERE id_berkas = ?1;",
    args: [idBerkas],
  });
  if (!r.rows[0]) throw new Error("Berkas tidak ditemukan.");
  await bolehBacaLampiran(
    client,
    String(r.rows[0].id_pengajuan),
    hanyaReimburse,
  );
  return { ...r.rows[0] };
}

export async function tambahLampiran(
  client: Client,
  actor: OperatorUser,
  raw: unknown,
) {
  const draft = (raw ?? {}) as Baris;
  const idPengajuan = teksId(draft.id_pengajuan);
  if (!idPengajuan) throw new Error("Pengajuan tidak ditemukan.");
  const mime =
    typeof draft.mime_type === "string" ? draft.mime_type.trim() : "";
  const data = typeof draft.data_base64 === "string" ? draft.data_base64 : "";
  const salah = validasiBerkas(mime, data);
  if (salah) throw new Error(salah);
  const namaBerkas = teksId(draft.nama_berkas)?.slice(0, 255) ?? null;
  const asal = await pengajuCloud(client, idPengajuan);
  if (asal === null) {
    throw new Error(
      "Pengajuan belum sampai ke database. Sinkronkan dulu, lalu coba lagi.",
    );
  }
  bolehUbahLampiran(actor, asal.pengaju, asal.izin_pemutus);
  const r = await client.execute({
    sql: "SELECT urutan FROM hr_pengajuan_berkas WHERE id_pengajuan = ?1;",
    args: [idPengajuan],
  });
  const terpakai = new Set(r.rows.map((x) => Number(x.urutan)));
  const urutan = Array.from({ length: MAKS_LAMPIRAN }, (_, i) => i + 1).find(
    (u) => !terpakai.has(u),
  );
  if (urutan === undefined) {
    throw new Error(`Satu pengajuan maksimal ${MAKS_LAMPIRAN} lampiran.`);
  }
  const id = newHexId("pb-");
  await client.execute({
    sql: "INSERT INTO hr_pengajuan_berkas (id_berkas, id_pengajuan, urutan, nama_berkas, mime_type, data_base64, diunggah_oleh) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7);",
    args: [id, idPengajuan, urutan, namaBerkas, mime, data, actor.username],
  });
  return { sukses: true as const, id_berkas: id };
}

export async function hapusLampiran(
  client: Client,
  actor: OperatorUser,
  idBerkas: string,
) {
  const r = await client.execute({
    sql: "SELECT id_pengajuan FROM hr_pengajuan_berkas WHERE id_berkas = ?1;",
    args: [idBerkas],
  });
  if (!r.rows[0]) throw new Error("Berkas tidak ditemukan.");
  const asal = await pengajuCloud(client, String(r.rows[0].id_pengajuan));
  bolehUbahLampiran(
    actor,
    asal?.pengaju ?? "",
    asal?.izin_pemutus ?? "hr.request.decide",
  );
  await client.execute({
    sql: "DELETE FROM hr_pengajuan_berkas WHERE id_berkas = ?1;",
    args: [idBerkas],
  });
  return { sukses: true as const };
}
