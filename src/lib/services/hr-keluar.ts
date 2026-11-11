import "server-only";

// HRIS fase 5 (v40), jalur Web. Kembaran `desktop/hr_keluar.rs`: SP dan proses
// keluar KHUSUS CLOUD (Q-63). Berlakukan/Batalkan mengubah `master_data` dan
// akun operator dalam satu transaksi (aturan 33).

import type { Client } from "@libsql/client";
import type { OperatorUser } from "@/lib/auth/operator-user";
import {
  karyawanAktor,
  muatBayar,
  muatGajiReimburse,
  muatKlaim,
  sisaCutiKeluar,
} from "@/lib/services/hr-pengajuan";
import { newHexId } from "@/lib/services/inventory";
import { sisaKasbonKaryawan } from "@/lib/services/loan";
import {
  akhirMasaSp,
  BATALKAN_SQL,
  BERLAKUKAN_SQL,
  type KeluarSah,
  MAKS_TEKS_KELUAR,
  MAKS_UPAH,
  type MasukanPesangon,
  PENGAJUAN_SESUDAH_SQL,
  PESAN_SUPERADMIN_TERAKHIR,
  PINJAMAN_PERSONIL_SQL,
  periksaTingkat,
  periksaUpah,
  type SpRingkas,
  statusKeluar,
  statusSp,
  susunRincian,
  usulanPesangon,
  usulanTingkat,
  usulanUpahPokok,
  validasiAlasan,
  validasiKeluar,
  validasiSp,
} from "@/lib/validations/hr-keluar";
import { STATUS_DIBAYAR, statusBayar } from "@/lib/validations/hr-pengajuan";
import {
  type Kontrak,
  KUNCI_SP_MASA_BULAN,
  PENGATURAN_KONTRAK_BAWAAN,
  statusKerja,
  teksIsian,
} from "@/lib/validations/hris";
import { isValidDate } from "@/lib/validations/inventory";

type Baris = Record<string, unknown>;
type Pembaca = Pick<Client, "execute">;

const teks = (nilai: unknown) => teksIsian(nilai) ?? null;
const angka = (nilai: unknown) =>
  Number.isFinite(Number(nilai)) ? Number(nilai) : 0;

async function objek(
  db: Pembaca,
  sql: string,
  args: (string | number | null)[] = [],
): Promise<Baris[]> {
  const res = await db.execute({ sql, args });
  return res.rows.map((r) => ({ ...(r as Baris) }));
}

async function hariIniCloud(db: Pembaca): Promise<string> {
  const [b] = await objek(db, "SELECT date('now', '+7 hours') AS hari;");
  return String(b?.hari ?? "");
}

async function karyawanCloud(db: Pembaca, id: string): Promise<Baris> {
  const [b] = await objek(
    db,
    "SELECT id_unik, nama, divisi, jabatan_status, status_aktif, tanggal_daftar, id_keluar FROM master_data WHERE id_unik = ?1;",
    [id],
  );
  if (!b) throw new Error("Karyawan tidak ditemukan.");
  return b;
}

function tolakDiriSendiri(sesiKaryawan: string | null, idKaryawan: string) {
  if (sesiKaryawan !== null && sesiKaryawan === idKaryawan) {
    throw new Error("Tindakan ini tidak bisa dilakukan untuk diri sendiri.");
  }
}

function alasanWajib(draft: Baris, label: string): string {
  const alasan = teks(draft.alasan);
  if (alasan && [...alasan].length > MAKS_TEKS_KELUAR) {
    throw new Error(`${label} maksimal ${MAKS_TEKS_KELUAR} karakter.`);
  }
  if (!alasan) throw new Error(`${label} wajib diisi.`);
  return alasan;
}

// ── Data karyawan dan checklist (cermin `data_karyawan`/`checklist_lokal`) ──

export interface DataKaryawan {
  tanggal_daftar: string | null;
  usulan_upah_pokok: number;
  sisa_cuti: number;
  upah_harian: number;
  pkwt_mulai: string | null;
  tunjangan_acuan: Baris[];
}

export async function dataKaryawan(
  db: Pembaca,
  idKaryawan: string,
  tanggalTerakhir: string,
): Promise<DataKaryawan> {
  const [m] = await objek(
    db,
    "SELECT NULLIF(TRIM(tanggal_daftar), '') AS t FROM master_data WHERE id_unik = ?1;",
    [idKaryawan],
  );
  const [gaji] = await objek(
    db,
    `SELECT COALESCE(salary_type, 'HOURLY') AS t, COALESCE(daily_rate, 0) AS d, COALESCE(rate_per_hour, 0) AS r
     FROM salary_configs WHERE id_karyawan = ?1 AND effective_date <= ?2
     ORDER BY effective_date DESC LIMIT 1;`,
    [idKaryawan, tanggalTerakhir],
  );
  const cuti = await sisaCutiKeluar(db, idKaryawan, tanggalTerakhir);
  const kontrak = (
    (
      await db.execute({
        sql: "SELECT id_kontrak, jenis, id_ref, tanggal_mulai, tanggal_selesai, percobaan_selesai FROM hr_kontrak WHERE id_karyawan = ?1 ORDER BY tanggal_mulai, id_kontrak;",
        args: [idKaryawan],
      })
    ).rows as Baris[]
  ).map(
    (k): Kontrak => ({
      id_kontrak: String(k.id_kontrak),
      jenis: String(k.jenis),
      id_ref: teks(k.id_ref),
      tanggal_mulai: String(k.tanggal_mulai),
      tanggal_selesai: teks(k.tanggal_selesai),
      percobaan_selesai: teks(k.percobaan_selesai),
    }),
  );
  const status = statusKerja(kontrak, tanggalTerakhir);
  const pkwt =
    status.jenis === "PKWT"
      ? kontrak.find((k) => k.id_kontrak === status.id_kontrak)
      : undefined;
  return {
    tanggal_daftar: teks(m?.t),
    usulan_upah_pokok: gaji
      ? usulanUpahPokok(String(gaji.t), angka(gaji.d), angka(gaji.r))
      : 0,
    sisa_cuti: cuti.sisa,
    upah_harian: cuti.upah_harian,
    pkwt_mulai: pkwt?.tanggal_mulai ?? null,
    tunjangan_acuan: await objek(
      db,
      "SELECT name, calc_type, default_value FROM payroll_components WHERE category = 'ALLOWANCE' AND is_active = 1 AND applies_to IN ('ALL', ?1) ORDER BY name;",
      [idKaryawan],
    ),
  };
}

export async function checklistKeluar(
  db: Pembaca,
  idKaryawan: string,
  tanggalTerakhir: string,
) {
  const barang = await objek(db, PINJAMAN_PERSONIL_SQL, [idKaryawan]);
  const kasbon = await sisaKasbonKaryawan(db, idKaryawan);
  const { pembayaran, baris } = await muatBayar(db);
  const gaji = await muatGajiReimburse(db);
  const klaim = (await muatKlaim(db, "9999-12-31"))
    .filter((k) => k.id_karyawan === idKaryawan)
    .map((k) => ({
      id_klaim: k.id_klaim,
      sumber: k.sumber,
      tanggal: k.tanggal,
      nominal: k.nominal,
      keterangan: k.keterangan,
      status_bayar: statusBayar(k.id_klaim, pembayaran, baris, gaji),
    }))
    .filter((k) => k.status_bayar !== STATUS_DIBAYAR);
  const pengajuan = await objek(db, PENGAJUAN_SESUDAH_SQL, [
    idKaryawan,
    tanggalTerakhir,
  ]);
  return {
    barang,
    kasbon,
    sisa_kasbon: kasbon.reduce((n, k) => n + k.sisa, 0),
    klaim,
    pengajuan,
  };
}

// ── Surat peringatan ───────────────────────────────────────────────────────

async function masaSp(db: Pembaca): Promise<number> {
  const [b] = await objek(
    db,
    "SELECT value FROM setting_gex_system WHERE key = ?1;",
    [KUNCI_SP_MASA_BULAN],
  );
  const n = /^\d+$/.test(String(b?.value ?? "").trim()) ? Number(b?.value) : 0;
  return n >= 1 && n <= 12 ? n : PENGATURAN_KONTRAK_BAWAAN[KUNCI_SP_MASA_BULAN];
}

const spRingkas = (daftar: Baris[]): SpRingkas[] =>
  daftar.map((b) => ({
    tingkat: String(b.tingkat ?? ""),
    tanggal: String(b.tanggal ?? ""),
    berlaku_sampai: String(b.berlaku_sampai ?? ""),
    dicabut: teks(b.dicabut_pada) !== null,
  }));

const denganStatusSp = (b: Baris, hariIni: string): Baris => ({
  ...b,
  status: statusSp(
    String(b.tanggal ?? ""),
    String(b.berlaku_sampai ?? ""),
    teks(b.dicabut_pada) !== null,
    hariIni,
  ),
});

/** Cermin `daftar_sp`. */
export async function daftarSp(client: Client, idKaryawan: string | null) {
  const hariIni = await hariIniCloud(client);
  if (!idKaryawan) {
    const semua = await objek(
      client,
      "SELECT s.*, m.nama, m.divisi FROM hr_sp s LEFT JOIN master_data m ON m.id_unik = s.id_karyawan ORDER BY s.tanggal DESC, s.created_at DESC LIMIT 500;",
    );
    return {
      sp: semua.map((b) => denganStatusSp(b, hariIni)),
      hari_ini: hariIni,
    };
  }
  const daftar = await objek(
    client,
    "SELECT * FROM hr_sp WHERE id_karyawan = ?1 ORDER BY tanggal DESC, created_at DESC;",
    [idKaryawan],
  );
  const usulan = usulanTingkat(spRingkas(daftar), hariIni);
  const [kop] = await objek(
    client,
    "SELECT company_name, logo_url, address FROM company_profile WHERE id = 'default_company';",
  );
  return {
    sp: daftar.map((b) => denganStatusSp(b, hariIni)),
    usulan,
    masa_bulan: await masaSp(client),
    penanda_terakhir: daftar[0]
      ? { nama: daftar[0].penanda_nama, jabatan: daftar[0].penanda_jabatan }
      : null,
    kop: kop ?? null,
    hari_ini: hariIni,
  };
}

/** Cermin `simpan_sp`. */
export async function simpanSp(
  client: Client,
  actor: OperatorUser,
  raw: unknown,
) {
  const hariIni = await hariIniCloud(client);
  const hasil = validasiSp((raw ?? {}) as Baris, hariIni);
  if (!hasil.ok) throw new Error(hasil.pesan);
  const sah = hasil.nilai;
  tolakDiriSendiri(await karyawanAktor(client, actor), sah.id_karyawan);
  if (sah.id_sp) {
    const [lama] = await objek(
      client,
      "SELECT * FROM hr_sp WHERE id_sp = ?1;",
      [sah.id_sp],
    );
    if (!lama) throw new Error("SP tidak ditemukan.");
    if (teks(lama.dicabut_pada)) throw new Error("SP ini sudah dicabut.");
    if (
      lama.id_karyawan !== sah.id_karyawan ||
      lama.tingkat !== sah.tingkat ||
      lama.tanggal !== sah.tanggal
    ) {
      throw new Error(
        "Tingkat dan tanggal SP tidak bisa diubah. Cabut SP ini lalu buat yang baru.",
      );
    }
    await client.execute({
      sql: `UPDATE hr_sp SET nomor = ?2, pelanggaran = ?3, harapan = ?4, penanda_nama = ?5, penanda_jabatan = ?6,
                   diubah_oleh = ?7, diubah_pada = datetime('now')
            WHERE id_sp = ?1 AND dicabut_pada IS NULL;`,
      args: [
        sah.id_sp,
        sah.nomor,
        sah.pelanggaran,
        sah.harapan,
        sah.penanda_nama,
        sah.penanda_jabatan,
        actor.username,
      ],
    });
    return { sukses: true as const, id_sp: sah.id_sp };
  }
  const karyawan = await karyawanCloud(client, sah.id_karyawan);
  if (karyawan.status_aktif !== "Aktif")
    throw new Error("SP hanya untuk karyawan aktif.");
  const masuk = teks(karyawan.tanggal_daftar);
  if (masuk && sah.tanggal < masuk) {
    throw new Error("Tanggal SP tidak boleh sebelum tanggal masuk karyawan.");
  }
  const riwayat = await objek(
    client,
    "SELECT tingkat, tanggal, berlaku_sampai, dicabut_pada FROM hr_sp WHERE id_karyawan = ?1;",
    [sah.id_karyawan],
  );
  const usulan = usulanTingkat(spRingkas(riwayat), sah.tanggal).tingkat;
  const cocok = periksaTingkat(sah.tingkat, usulan, sah.alasan_tingkat);
  if (!cocok.ok) throw new Error(cocok.pesan);
  const masaBulan = await masaSp(client);
  const berlakuSampai = akhirMasaSp(sah.tanggal, masaBulan);
  if (!berlakuSampai) throw new Error("Tanggal SP tidak valid.");
  const idSp = newHexId("sp-");
  await client.execute({
    sql: `INSERT INTO hr_sp (id_sp, id_karyawan, tingkat, tanggal, masa_bulan, berlaku_sampai, nomor, pelanggaran, harapan,
                             usulan_tingkat, alasan_tingkat, penanda_nama, penanda_jabatan, dicatat_oleh)
          VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14);`,
    args: [
      idSp,
      sah.id_karyawan,
      sah.tingkat,
      sah.tanggal,
      masaBulan,
      berlakuSampai,
      sah.nomor,
      sah.pelanggaran,
      sah.harapan,
      usulan,
      sah.tingkat !== usulan ? sah.alasan_tingkat : null,
      sah.penanda_nama,
      sah.penanda_jabatan,
      actor.username,
    ],
  });
  return { sukses: true as const, id_sp: idSp };
}

/** Cermin `cabut_sp`. */
export async function cabutSp(
  client: Client,
  actor: OperatorUser,
  raw: unknown,
) {
  const draft = (raw ?? {}) as Baris;
  const idSp = teks(draft.id_sp);
  if (!idSp) throw new Error("SP tidak ditemukan.");
  const alasan = alasanWajib(draft, "Alasan pencabutan");
  const [lama] = await objek(
    client,
    "SELECT id_karyawan, dicabut_pada FROM hr_sp WHERE id_sp = ?1;",
    [idSp],
  );
  if (!lama) throw new Error("SP tidak ditemukan.");
  tolakDiriSendiri(
    await karyawanAktor(client, actor),
    String(lama.id_karyawan ?? ""),
  );
  if (teks(lama.dicabut_pada)) throw new Error("SP ini sudah dicabut.");
  await client.execute({
    sql: "UPDATE hr_sp SET dicabut_oleh = ?2, dicabut_pada = datetime('now'), alasan_cabut = ?3 WHERE id_sp = ?1 AND dicabut_pada IS NULL;",
    args: [idSp, actor.username, alasan],
  });
  return { sukses: true as const };
}

// ── Karyawan keluar ────────────────────────────────────────────────────────

/** Cermin `simpan_alasan`. */
export async function simpanAlasan(client: Client, raw: unknown) {
  const hasil = validasiAlasan((raw ?? {}) as Baris);
  if (!hasil.ok) throw new Error(hasil.pesan);
  const sah = hasil.nilai;
  const kembar = await objek(
    client,
    "SELECT 1 AS ada FROM hr_keluar_alasan WHERE LOWER(TRIM(nama)) = LOWER(?1) AND id_alasan <> COALESCE(?2, '');",
    [sah.nama, sah.id_alasan],
  );
  if (kembar.length > 0) throw new Error("Nama alasan itu sudah dipakai.");
  const id = sah.id_alasan ?? newHexId("klr-");
  await client.execute({
    sql: `INSERT INTO hr_keluar_alasan (id_alasan, nama, pengali_up, pengali_upmk, uph, kompensasi_pkwt, uang_pisah, dasar_hukum, is_aktif)
          VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
          ON CONFLICT(id_alasan) DO UPDATE SET nama = excluded.nama, pengali_up = excluded.pengali_up,
             pengali_upmk = excluded.pengali_upmk, uph = excluded.uph, kompensasi_pkwt = excluded.kompensasi_pkwt,
             uang_pisah = excluded.uang_pisah, dasar_hukum = excluded.dasar_hukum, is_aktif = excluded.is_aktif,
             updated_at = datetime('now');`,
    args: [
      id,
      sah.nama,
      sah.pengali_up,
      sah.pengali_upmk,
      sah.uph ? 1 : 0,
      sah.kompensasi_pkwt ? 1 : 0,
      sah.uang_pisah ? 1 : 0,
      sah.dasar_hukum,
      sah.is_aktif ? 1 : 0,
    ],
  });
  return { sukses: true as const, id_alasan: id };
}

const denganStatusKeluar = (b: Baris, hariIni: string): Baris => ({
  ...b,
  status: statusKeluar(
    String(b.tanggal_terakhir ?? ""),
    teks(b.berlaku_pada) !== null,
    teks(b.dibatalkan_pada) !== null,
    hariIni,
  ),
});

/** Cermin `daftar_keluar`. */
export async function daftarKeluar(client: Client) {
  const hariIni = await hariIniCloud(client);
  const daftar = await objek(
    client,
    `SELECT k.id_keluar, k.id_karyawan, k.alasan_nama, k.tanggal_pemberitahuan, k.tanggal_terakhir, k.dicatat_oleh, k.created_at,
            k.berlaku_oleh, k.berlaku_pada, k.dibatalkan_oleh, k.dibatalkan_pada, k.alasan_batal, m.nama, m.divisi,
            COALESCE((SELECT SUM(r.nominal) FROM hr_keluar_rincian r WHERE r.id_keluar = k.id_keluar), 0) AS total
     FROM hr_keluar k LEFT JOIN master_data m ON m.id_unik = k.id_karyawan
     ORDER BY k.tanggal_terakhir DESC, k.created_at DESC LIMIT 500;`,
  );
  return {
    keluar: daftar.map((b) => denganStatusKeluar(b, hariIni)),
    alasan: await objek(
      client,
      "SELECT * FROM hr_keluar_alasan ORDER BY is_aktif DESC, nama;",
    ),
    hari_ini: hariIni,
  };
}

const akunTertaut = (db: Pembaca, idKaryawan: string) =>
  objek(
    db,
    `SELECT m.id, m.username, m.nama_operator, m.status, COALESCE(r.is_superadmin, 0) AS is_superadmin
     FROM master_operator m LEFT JOIN app_role r ON r.id = m.role_id WHERE m.id_karyawan = ?1 ORDER BY m.username;`,
    [idKaryawan],
  );

async function alasanSatu(db: Pembaca, id: string): Promise<Baris> {
  const [b] = await objek(
    db,
    "SELECT * FROM hr_keluar_alasan WHERE id_alasan = ?1;",
    [id],
  );
  if (!b) throw new Error("Alasan keluar tidak ditemukan.");
  return b;
}

const masukanPesangon = (
  alasan: Baris,
  data: DataKaryawan,
  upah: number,
  tanggalTerakhir: string,
): MasukanPesangon => ({
  upah,
  masa_kerja_mulai: data.tanggal_daftar,
  tanggal_terakhir: tanggalTerakhir,
  pengali_up: angka(alasan.pengali_up),
  pengali_upmk: angka(alasan.pengali_upmk),
  uph: angka(alasan.uph) === 1,
  kompensasi_pkwt: angka(alasan.kompensasi_pkwt) === 1,
  uang_pisah: angka(alasan.uang_pisah) === 1,
  sisa_cuti: data.sisa_cuti,
  upah_harian: data.upah_harian,
  pkwt_mulai: data.pkwt_mulai,
});

/** Cermin `rincian_keluar`. */
export async function rincianKeluar(client: Client, idKeluar: string) {
  const hariIni = await hariIniCloud(client);
  const [header] = await objek(
    client,
    "SELECT * FROM hr_keluar WHERE id_keluar = ?1;",
    [idKeluar],
  );
  if (!header) throw new Error("Proses keluar tidak ditemukan.");
  const idKaryawan = String(header.id_karyawan ?? "");
  const tanggalTerakhir = String(header.tanggal_terakhir ?? "");
  const data = await dataKaryawan(client, idKaryawan, tanggalTerakhir);
  const alasan = await alasanSatu(client, String(header.id_alasan ?? ""));
  const upah = angka(header.upah_pokok) + angka(header.tunjangan_tetap);
  return {
    keluar: denganStatusKeluar(header, hariIni),
    karyawan: await karyawanCloud(client, idKaryawan),
    rincian: await objek(
      client,
      "SELECT * FROM hr_keluar_rincian WHERE id_keluar = ?1 ORDER BY urutan;",
      [idKeluar],
    ),
    usulan: usulanPesangon(
      masukanPesangon(alasan, data, upah, tanggalTerakhir),
    ),
    data,
    checklist: await checklistKeluar(client, idKaryawan, tanggalTerakhir),
    akun: await akunTertaut(client, idKaryawan),
    alasan,
    hari_ini: hariIni,
  };
}

/** Cermin `pratinjau_keluar`. */
export async function pratinjauKeluar(
  client: Client,
  idKaryawan: string,
  idAlasan: string,
  tanggalTerakhir: string,
) {
  if (!isValidDate(tanggalTerakhir))
    throw new Error("Tanggal hari kerja terakhir tidak valid.");
  const data = await dataKaryawan(client, idKaryawan, tanggalTerakhir);
  const alasan = await alasanSatu(client, idAlasan);
  return {
    karyawan: await karyawanCloud(client, idKaryawan),
    usulan: usulanPesangon(
      masukanPesangon(alasan, data, data.usulan_upah_pokok, tanggalTerakhir),
    ),
    data,
    checklist: await checklistKeluar(client, idKaryawan, tanggalTerakhir),
    akun: await akunTertaut(client, idKaryawan),
    alasan,
    hari_ini: await hariIniCloud(client),
  };
}

const BELUM_BERLAKU =
  "EXISTS (SELECT 1 FROM hr_keluar k WHERE k.id_keluar = ?1 AND k.berlaku_pada IS NULL AND k.dibatalkan_pada IS NULL)";

/** Cermin `simpan_keluar`. */
export async function simpanKeluar(
  client: Client,
  actor: OperatorUser,
  raw: unknown,
) {
  const hasil = validasiKeluar((raw ?? {}) as Baris);
  if (!hasil.ok) throw new Error(hasil.pesan);
  const sah: KeluarSah = hasil.nilai;
  tolakDiriSendiri(await karyawanAktor(client, actor), sah.id_karyawan);
  const karyawan = await karyawanCloud(client, sah.id_karyawan);
  const data = await dataKaryawan(
    client,
    sah.id_karyawan,
    sah.tanggal_terakhir,
  );
  if (data.tanggal_daftar && sah.tanggal_terakhir < data.tanggal_daftar) {
    throw new Error(
      "Hari kerja terakhir tidak boleh sebelum tanggal masuk karyawan.",
    );
  }
  const terbuka = await objek(
    client,
    "SELECT id_keluar, berlaku_pada FROM hr_keluar WHERE id_karyawan = ?1 AND dibatalkan_pada IS NULL;",
    [sah.id_karyawan],
  );
  if (sah.id_keluar) {
    const lama = terbuka.find((b) => b.id_keluar === sah.id_keluar);
    if (!lama)
      throw new Error("Proses keluar tidak ditemukan atau sudah dibatalkan.");
    if (teks(lama.berlaku_pada))
      throw new Error("Proses keluar yang sudah berlaku tidak bisa diubah.");
  } else {
    if (terbuka.length > 0) {
      throw new Error(
        "Karyawan ini sudah punya proses keluar yang belum dibatalkan.",
      );
    }
    if (karyawan.status_aktif !== "Aktif")
      throw new Error("Proses keluar hanya untuk karyawan aktif.");
  }
  const alasan = await alasanSatu(client, sah.id_alasan);
  if (angka(alasan.is_aktif) !== 1 && !sah.id_keluar)
    throw new Error("Alasan keluar sudah nonaktif.");
  const upahPokok = sah.upah_pokok ?? data.usulan_upah_pokok;
  const upahCocok = periksaUpah(
    upahPokok,
    data.usulan_upah_pokok,
    sah.alasan_upah,
  );
  if (!upahCocok.ok) throw new Error(upahCocok.pesan);
  const upah = upahPokok + sah.tunjangan_tetap;
  if (upah > MAKS_UPAH)
    throw new Error("Upah pokok + tunjangan tetap terlalu besar.");
  const rincian = susunRincian(
    usulanPesangon(masukanPesangon(alasan, data, upah, sah.tanggal_terakhir)),
    sah.rincian,
  );
  if (!rincian.ok) throw new Error(rincian.pesan);

  const id = sah.id_keluar ?? newHexId("klr-");
  await client.batch(
    [
      {
        sql: `INSERT INTO hr_keluar (id_keluar, id_karyawan, id_alasan, alasan_nama, id_sp, tanggal_pemberitahuan, tanggal_terakhir,
                                     keterangan, masa_kerja_mulai, upah_pokok, usulan_upah_pokok, alasan_upah, tunjangan_tetap,
                                     kartu_ditarik, catatan_checklist, dicatat_oleh)
              VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)
              ON CONFLICT(id_keluar) DO UPDATE SET id_alasan = excluded.id_alasan, alasan_nama = excluded.alasan_nama,
                 id_sp = excluded.id_sp, tanggal_pemberitahuan = excluded.tanggal_pemberitahuan,
                 tanggal_terakhir = excluded.tanggal_terakhir, keterangan = excluded.keterangan,
                 masa_kerja_mulai = excluded.masa_kerja_mulai, upah_pokok = excluded.upah_pokok,
                 usulan_upah_pokok = excluded.usulan_upah_pokok, alasan_upah = excluded.alasan_upah,
                 tunjangan_tetap = excluded.tunjangan_tetap, kartu_ditarik = excluded.kartu_ditarik,
                 catatan_checklist = excluded.catatan_checklist, diubah_oleh = excluded.dicatat_oleh,
                 diubah_pada = datetime('now')
              WHERE hr_keluar.berlaku_pada IS NULL AND hr_keluar.dibatalkan_pada IS NULL;`,
        args: [
          id,
          sah.id_karyawan,
          sah.id_alasan,
          String(alasan.nama ?? ""),
          sah.id_sp,
          sah.tanggal_pemberitahuan,
          sah.tanggal_terakhir,
          sah.keterangan,
          data.tanggal_daftar,
          upahPokok,
          data.usulan_upah_pokok,
          upahPokok !== data.usulan_upah_pokok ? sah.alasan_upah : null,
          sah.tunjangan_tetap,
          sah.kartu_ditarik ? 1 : 0,
          sah.catatan_checklist,
          actor.username,
        ],
      },
      {
        sql: `DELETE FROM hr_keluar_rincian WHERE id_keluar = ?1 AND ${BELUM_BERLAKU};`,
        args: [id],
      },
      ...rincian.nilai.map((r) => ({
        sql: `INSERT INTO hr_keluar_rincian (id_keluar, id_rincian, komponen, dasar, usulan, nominal, alasan_ubah, urutan)
              SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8 WHERE ${BELUM_BERLAKU};`,
        args: [
          id,
          `${id}:${r.komponen}`,
          r.komponen,
          r.dasar,
          r.usulan,
          r.nominal,
          r.alasan_ubah,
          r.urutan,
        ],
      })),
    ],
    "write",
  );
  return { sukses: true as const, id_keluar: id };
}

/** Cermin `berlakukan`. */
export async function berlakukan(
  client: Client,
  actor: OperatorUser,
  idKeluar: string,
) {
  const hariIni = await hariIniCloud(client);
  const [header] = await objek(
    client,
    "SELECT * FROM hr_keluar WHERE id_keluar = ?1;",
    [idKeluar],
  );
  if (!header) throw new Error("Proses keluar tidak ditemukan.");
  const idKaryawan = String(header.id_karyawan ?? "");
  const tanggalTerakhir = String(header.tanggal_terakhir ?? "");
  tolakDiriSendiri(await karyawanAktor(client, actor), idKaryawan);
  const status = statusKeluar(
    tanggalTerakhir,
    teks(header.berlaku_pada) !== null,
    teks(header.dibatalkan_pada) !== null,
    hariIni,
  );
  if (status === "Dijadwalkan") {
    throw new Error(
      "Proses keluar baru bisa diberlakukan pada hari kerja terakhir.",
    );
  }
  if (status === "Berlaku") throw new Error("Proses keluar ini sudah berlaku.");
  if (status === "Dibatalkan")
    throw new Error("Proses keluar ini sudah dibatalkan.");
  const akun = await akunTertaut(client, idKaryawan);
  if (akun.some((a) => angka(a.id) === actor.id)) {
    throw new Error("Tindakan ini tidak bisa dilakukan untuk diri sendiri.");
  }
  const superTertaut = akun.filter(
    (a) => angka(a.is_superadmin) === 1 && a.status === "Aktif",
  ).length;
  if (superTertaut > 0) {
    const [b] = await objek(
      client,
      "SELECT COUNT(*) AS total FROM master_operator m JOIN app_role r ON r.id = m.role_id WHERE r.is_superadmin = 1 AND m.status = 'Aktif';",
    );
    if (angka(b?.total) <= superTertaut)
      throw new Error(PESAN_SUPERADMIN_TERAKHIR);
  }
  const [jumlah] = await objek(
    client,
    "SELECT COALESCE(SUM(nominal), 0) AS total FROM hr_keluar_rincian WHERE id_keluar = ?1;",
    [idKeluar],
  );
  const potret = {
    ...(await checklistKeluar(client, idKaryawan, tanggalTerakhir)),
    total_rincian: angka(jumlah?.total),
    akun,
  };
  // Statement pertama tidak memakai `?4`; jumlah argumen wajib pas.
  const args = [idKeluar, actor.username, JSON.stringify(potret), idKaryawan];
  await client.batch(
    BERLAKUKAN_SQL.map((sql, i) => ({
      sql,
      args: args.slice(0, i === 0 ? 3 : 4),
    })),
    "write",
  );
  return { sukses: true as const };
}

/** Cermin `batalkan`. */
export async function batalkan(
  client: Client,
  actor: OperatorUser,
  raw: unknown,
) {
  const draft = (raw ?? {}) as Baris;
  const idKeluar = teks(draft.id_keluar);
  if (!idKeluar) throw new Error("Proses keluar tidak ditemukan.");
  const alasan = alasanWajib(draft, "Alasan pembatalan");
  const [header] = await objek(
    client,
    "SELECT id_karyawan, dibatalkan_pada FROM hr_keluar WHERE id_keluar = ?1;",
    [idKeluar],
  );
  if (!header) throw new Error("Proses keluar tidak ditemukan.");
  tolakDiriSendiri(
    await karyawanAktor(client, actor),
    String(header.id_karyawan ?? ""),
  );
  if (teks(header.dibatalkan_pada))
    throw new Error("Proses keluar ini sudah dibatalkan.");
  const args = [idKeluar, actor.username, alasan];
  await client.batch(
    BATALKAN_SQL.map((sql, i) => ({
      sql,
      args: args.slice(0, i === 0 ? 1 : 3),
    })),
    "write",
  );
  return { sukses: true as const };
}
