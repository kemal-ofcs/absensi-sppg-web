import "server-only";

import { createHash } from "node:crypto";
import type { Client } from "@libsql/client";
import type { OperatorUser } from "@/lib/auth/operator-user";
import { AuthorizationError } from "@/lib/auth/permission-assertion";
import { newHexId, withTransaction } from "@/lib/services/inventory";
import type { HolidayWhitelistEntry } from "@/lib/validations/holiday-whitelist";
import {
  aturanCutiDariPeta,
  CLOUD_INSERT_KEPUTUSAN_SQL,
  hariKalender,
  hitungCutiDibayar,
  INSERT_PENYESUAIAN_SQL,
  type IsiPengajuan,
  IZIN_PEMUTUS_AKTIF,
  idUang,
  type Jadwal,
  type JenisPengajuan,
  jadwalDariBaris,
  type Kalender,
  type Keputusan,
  kanonikPengajuan,
  MAKS_LAMPIRAN,
  PENGAJUAN_RENTANG_SQL,
  PERIODE_DIBAYAR_SQL,
  PESAN_TANPA_HARI_KERJA,
  type PeriodeCuti,
  periksaAksi,
  periksaJenis,
  periksaMaks,
  periksaSunting,
  periksaUrgent,
  periodeCuti,
  pesanBertumpuk,
  pesanPeriodeDibayar,
  statusBerlaku,
  statusPengajuan,
  TANGGAL_HADIR_SQL,
  tandaKeputusan,
  tanggalWajib,
  UPSERT_JENIS_SQL,
  UPSERT_PENGAJUAN_SQL,
  upahHarian,
  validasiAturanCuti,
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

// ── Penulisan Web (langsung ke cloud), cermin `desktop/hr_pengajuan.rs` ─────

type Baris = Record<string, unknown>;

const punya = (actor: OperatorUser, izin: string) =>
  actor.isSuperadmin || (actor.permissions as readonly string[]).includes(izin);
const samaOrang = (a: string, b: string) =>
  a.trim().toLowerCase() === b.trim().toLowerCase();
const teksId = (nilai: unknown) =>
  typeof nilai === "string" && nilai.trim() !== "" ? nilai.trim() : null;

/** `master_operator.id_karyawan` sesi Web (tidak dimuat sesi). */
async function karyawanAktor(db: Pembaca, actor: OperatorUser) {
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
}

const KOLOM_PENGAJUAN =
  "p.id_pengajuan, p.id_karyawan, p.id_jenis, p.kelompok, p.potong_jatah, p.dampak_gaji, p.tanggal_mulai, p.tanggal_selesai, p.setengah_hari, p.alasan, p.sidik, p.diajukan_oleh, p.waktu_perangkat, p.created_at";

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
          WHERE (?1 IS NULL OR p.id_karyawan = ?1) AND p.tanggal_mulai <= ?3 AND p.tanggal_selesai >= ?2
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
    sql: `SELECT id_pengajuan, id_keputusan, jenis, sidik, oleh, waktu_perangkat, diterima_cloud
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
    });
    hasil.set(id, daftar);
  }
  return hasil;
}

async function bacaJenisSemua(db: Pembaca): Promise<JenisPengajuan[]> {
  const r = await db.execute(
    `SELECT id_jenis, nama, kelompok, izin_pemutus, boleh_urgent, potong_jatah, dampak_gaji, maks_hari, satuan_maks, wajib_dokumen, is_aktif
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
  const sendiri = (await karyawanAktor(client, actor)) === v.id_karyawan;
  if (v.urgent) {
    if (idMasuk) throw new Error("Pengajuan urgent hanya bisa dibuat baru.");
    if (!punya(actor, "hr.request.urgent")) {
      throw new AuthorizationError(
        "Kamu tidak punya izin mengajukan urgent.",
        403,
      );
    }
    const u = periksaUrgent(sendiri);
    if (!u.ok) throw new Error(u.pesan);
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
    const jadwal = (await muatJadwal(tx)).get(v.id_karyawan);
    if (!jadwal) throw new Error("Karyawan tidak ditemukan.");
    const kalender = await muatKalender(tx, v.tanggal_mulai, v.tanggal_selesai);
    const wajib = tanggalWajib(
      jadwal,
      kalender,
      v.tanggal_mulai,
      v.tanggal_selesai,
    );
    if (wajib.length === 0) throw new Error(PESAN_TANPA_HARI_KERJA);
    const maks = periksaMaks(
      jenis,
      wajib.length,
      hariKalender(v.tanggal_mulai, v.tanggal_selesai),
    );
    if (!maks.ok) throw new Error(maks.pesan);
    await tolakBilaDibayar(tx, v.tanggal_mulai, v.tanggal_selesai);

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
      await tolakBilaDibayar(tx, lama.tanggal_mulai, lama.tanggal_selesai);
      pengaju = lama.diajukan_oleh;
      createdAt = lama.created_at;
    }

    const lain = (
      await bacaPengajuan(tx, v.id_karyawan, v.tanggal_mulai, v.tanggal_selesai)
    ).filter((p) => p.id_pengajuan !== idMasuk);
    const kepLain = await bacaKeputusan(
      tx,
      lain.map((p) => p.id_pengajuan),
    );
    for (const p of lain) {
      const status = statusPengajuan(
        p.sidik,
        kepLain.get(p.id_pengajuan) ?? [],
      );
      if (status === "Menunggu" || statusBerlaku(status)) {
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
  const idKaryawanSesi = await karyawanAktor(client, actor);
  return withTransaction(client, async (tx) => {
    const p = await bacaSatuPengajuan(tx, id);
    if (!p) throw new Error("Pengajuan tidak ditemukan.");
    const kep = (await bacaKeputusan(tx, [id])).get(id) ?? [];
    const status = statusPengajuan(p.sidik, kep);
    const izinPemutus =
      (await bacaJenisSemua(tx)).find((j) => j.id_jenis === p.id_jenis)
        ?.izin_pemutus ?? IZIN_PEMUTUS_AKTIF;
    const cek = periksaAksi(aksi, alasan, {
      status,
      sudah_diketahui: kep.some((k) => k.jenis === "Diketahui"),
      pengaju_sendiri: samaOrang(p.diajukan_oleh, actor.username),
      superadmin: actor.isSuperadmin,
      karyawan_sendiri: idKaryawanSesi === p.id_karyawan,
      boleh_putus: punya(actor, izinPemutus),
    });
    if (!cek.ok) throw new Error(cek.pesan);
    if (aksi === "Setujui" || aksi === "Batal") {
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
    );
    return { sukses: true as const, id_keputusan: idKeputusan };
  });
}

const tanggalAtau = (nilai: unknown, bawaan: string) =>
  typeof nilai === "string" && /^\d{4}-\d{2}-\d{2}$/.test(nilai)
    ? nilai
    : bawaan;

/** Cermin `daftar`. */
export async function daftarPengajuan(client: Client, raw: unknown) {
  const filter = (raw ?? {}) as Baris;
  const baris = await bacaPengajuan(
    client,
    teksId(filter.id_karyawan),
    tanggalAtau(filter.dari, "0000-01-01"),
    tanggalAtau(filter.sampai, "9999-12-31"),
  );
  const keputusan = await bacaKeputusan(
    client,
    baris.map((p) => p.id_pengajuan),
  );
  const jenis = await bacaJenisSemua(client);
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
  const pengajuan = baris.map((p, i) => {
    const kep = keputusan.get(p.id_pengajuan) ?? [];
    const statusIni = status[i] ?? "Menunggu";
    const tanda = tandaKeputusan(p.sidik, p.diajukan_oleh, kep);
    if (
      aktif(statusIni) &&
      baris.some(
        (q, j) =>
          j !== i &&
          q.id_karyawan === p.id_karyawan &&
          aktif(status[j] ?? "") &&
          q.tanggal_mulai <= p.tanggal_selesai &&
          q.tanggal_selesai >= p.tanggal_mulai,
      )
    ) {
      tanda.push("bertumpuk");
    }
    const j = jadwal.get(p.id_karyawan);
    const wajib = j
      ? tanggalWajib(j, kalender, p.tanggal_mulai, p.tanggal_selesai)
      : [];
    if (statusBerlaku(statusIni) && !p.setengah_hari) {
      const h = hadir.get(p.id_karyawan);
      if (h && wajib.some((t) => h.has(t))) tanda.push("hadir_saat_cuti");
    }
    const jenisIni = jenis.find((x) => x.id_jenis === p.id_jenis);
    return {
      pengajuan: p,
      nama_karyawan: nama.get(p.id_karyawan) ?? null,
      nama_jenis: jenisIni?.nama ?? null,
      izin_pemutus: jenisIni?.izin_pemutus ?? IZIN_PEMUTUS_AKTIF,
      wajib_dokumen: jenisIni?.wajib_dokumen ?? false,
      status: statusIni,
      tanda,
      hari_kerja: wajib.length,
      sudah_diketahui: kep.some((k) => k.jenis === "Diketahui"),
    };
  });
  return { pengajuan, jenis };
}

/** Cermin `rincian`. */
export async function rincianPengajuan(client: Client, id: string) {
  const r = await client.execute({
    sql: `SELECT id_keputusan, jenis, sidik, alasan, oleh, waktu_perangkat, diterima_cloud
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

/** Cermin `jatah`. */
export async function jatahCuti(client: Client, idKaryawan: string) {
  return hitungJatah(client, idKaryawan);
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
  const diuangkan: Array<{ nama: string; baris: Baris }> = [];
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
      for (const x of penyesuaian) {
        if (x.baris.jenis === "Diuangkan" && !x.dibatalkan) {
          diuangkan.push({ nama, baris: x.baris });
        }
      }
    }
  }
  return { aturan, belum_diproses: belum, diuangkan };
}

/** Cermin `simpan_aturan`. */
export async function simpanAturanCuti(client: Client, raw: unknown) {
  const hasil = validasiAturanCuti((raw ?? {}) as Baris);
  if (!hasil.ok) throw new Error(hasil.pesan);
  await withTransaction(client, async (tx) => {
    for (const [kunci, nilai] of hasil.nilai) {
      await tx.execute({
        sql: `INSERT INTO setting_gex_system (key, value) VALUES (?1, ?2)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value;`,
        args: [kunci, nilai],
      });
    }
  });
  return { sukses: true as const };
}

// ── Lampiran khusus cloud (Q-51), cermin `lampiran`/`tambah_lampiran` ──────

async function pengajuCloud(db: Pembaca, idPengajuan: string) {
  const r = await db.execute({
    sql: "SELECT diajukan_oleh FROM hr_pengajuan WHERE id_pengajuan = ?1;",
    args: [idPengajuan],
  });
  return r.rows[0] ? String(r.rows[0].diajukan_oleh) : null;
}

function bolehUbahLampiran(actor: OperatorUser, pengaju: string) {
  if (
    !samaOrang(pengaju, actor.username) &&
    !punya(actor, "hr.request.decide")
  ) {
    throw new AuthorizationError(
      "Hanya pengaju atau HRD yang bisa mengubah lampiran pengajuan ini.",
      403,
    );
  }
}

export async function lampiran(client: Client, idPengajuan: string) {
  const r = await client.execute({
    sql: "SELECT id_berkas, urutan, nama_berkas, mime_type, diunggah_oleh, created_at FROM hr_pengajuan_berkas WHERE id_pengajuan = ?1 ORDER BY urutan;",
    args: [idPengajuan],
  });
  return { berkas: r.rows.map((x) => ({ ...x })) };
}

export async function isiLampiran(client: Client, idBerkas: string) {
  const r = await client.execute({
    sql: "SELECT id_berkas, nama_berkas, mime_type, data_base64 FROM hr_pengajuan_berkas WHERE id_berkas = ?1;",
    args: [idBerkas],
  });
  if (!r.rows[0]) throw new Error("Berkas tidak ditemukan.");
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
  const pengaju = await pengajuCloud(client, idPengajuan);
  if (pengaju === null) {
    throw new Error(
      "Pengajuan belum sampai ke database. Sinkronkan dulu, lalu coba lagi.",
    );
  }
  bolehUbahLampiran(actor, pengaju);
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
  bolehUbahLampiran(
    actor,
    (await pengajuCloud(client, String(r.rows[0].id_pengajuan))) ?? "",
  );
  await client.execute({
    sql: "DELETE FROM hr_pengajuan_berkas WHERE id_berkas = ?1;",
    args: [idBerkas],
  });
  return { sukses: true as const };
}
