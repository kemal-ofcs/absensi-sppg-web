import "server-only";

import { createHash } from "node:crypto";
import type { Client, ResultSet } from "@libsql/client";
import type { OperatorUser } from "@/lib/auth/operator-user";
import { AuthorizationError } from "@/lib/auth/permission-assertion";
import { karyawanAktor, muatKalender } from "@/lib/services/hr-pengajuan";
import { newHexId, withTransaction } from "@/lib/services/inventory";
import {
  AKSI_KINERJA,
  type Ambang,
  type AspekSah,
  awalPeriode,
  type BarisNilai,
  bentrokPeriode,
  CLOUD_BUANG_NILAI_SQL,
  CLOUD_INSERT_KEPUTUSAN_SQL,
  CLOUD_SATU_BAWAAN_SQL,
  CLOUD_UPSERT_ASPEK_SQL,
  CLOUD_UPSERT_JABATAN_SQL,
  CLOUD_UPSERT_NILAI_SQL,
  CLOUD_UPSERT_PENILAIAN_SQL,
  CLOUD_UPSERT_TEMPLATE_SQL,
  DISIPLIN_HARI_SQL,
  DISIPLIN_KARYAWAN_SQL,
  DISIPLIN_PENGAJUAN_SQL,
  DISIPLIN_PERJALANAN_SQL,
  DISIPLIN_TUKAR_SQL,
  type Disiplin,
  finalBerlaku,
  formatNilai,
  hitungDisiplin,
  type IsianNilai,
  type IsiPenilaian,
  IZIN_ASSESS,
  IZIN_FINALIZE,
  IZIN_VIEW,
  idNilai,
  JENIS_KEPUTUSAN,
  KARYAWAN_KINERJA_SQL,
  type KaryawanDisiplin,
  type KeadaanKinerja,
  type KeputusanKinerja,
  KUNCI_AMBANG,
  KUNCI_PERIODE,
  KUNCI_PREDIKAT,
  kanonikPenilaian,
  kinerjaBerlaku,
  muatUlangTemplate,
  namaGanda,
  namaTemplateDipakai,
  nilaiAkhir,
  PESAN_BELUM_FINAL_SENDIRI,
  PESAN_FINAL_LAMA,
  PESAN_TANPA_TEMPLATE,
  type PengaturanKinerja,
  pengaturanKinerjaDariPeta,
  penilaianGanda,
  periksaAksiKinerja,
  periksaAspekLama,
  periksaBuat,
  periodeRentang,
  pesanBertumpuk,
  predikatNilai,
  type RentangAktif,
  type RingkasPenilaian,
  rentangAktif,
  SP_PERIODE_SQL,
  STATUS_DIAJUKAN,
  STATUS_DIBATALKAN,
  STATUS_DRAF,
  STATUS_FINAL,
  salinanAspek,
  skorLengkap,
  statusKinerja,
  susunNilai,
  type TemplateRingkas,
  TIPE_DISIPLIN,
  tandaKinerja,
  templateKaryawan,
  validasiPengaturanKinerja,
  validasiPenilaian,
  validasiTemplate,
  WAKTU_KEPUTUSAN_SQL,
} from "@/lib/validations/hr-kinerja";
import { urutKeputusan } from "@/lib/validations/hr-pengajuan";
import type {
  HariLaporan,
  PengajuanLaporan,
  TukarLaporan,
} from "@/lib/validations/laporan-kehadiran";

/**
 * Cermin Web dari `desktop/hr_kinerja.rs` (prd-hris.md §21). Web menulis
 * langsung ke database cloud dengan SQL handler cloud yang sama; aturan dan
 * pesan sama dengan Rust. Tanpa langkah sinkron sebelum Ajukan: Web selalu
 * membaca cloud (§21.4).
 */

type Pembaca = Pick<Client, "execute">;
type Baris = Record<string, unknown>;

const objek = (rs: ResultSet): Baris[] =>
  rs.rows.map((r) =>
    Object.fromEntries(rs.columns.map((c, i) => [c, r[i] ?? null])),
  );
const s = (v: Baris, k: string) =>
  v[k] === null || v[k] === undefined ? "" : String(v[k]);
const so = (v: Baris, k: string) => s(v, k) || null;
const n = (v: Baris, k: string) => Number(v[k] ?? 0) || 0;
const punya = (actor: OperatorUser, izin: string) =>
  actor.isSuperadmin || (actor.permissions as readonly string[]).includes(izin);
const tolak = (pesan: string) => new AuthorizationError(pesan, 403);
const bandingTeks = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const isi = (v: unknown) => {
  const t = v === null || v === undefined ? "" : String(v).trim();
  return t === "" ? null : t;
};

/** Cermin `sidik_penilaian`. */
export function sidikPenilaian(isiPenilaian: IsiPenilaian): string {
  return createHash("sha256")
    .update(kanonikPenilaian(isiPenilaian), "utf8")
    .digest("hex");
}

async function hariIniWib(db: Pembaca): Promise<string> {
  const r = await db.execute("SELECT date('now', '+7 hours') AS h;");
  return String(r.rows[0]?.h ?? "");
}

async function bacaPengaturan(db: Pembaca): Promise<PengaturanKinerja> {
  const r = await db.execute({
    sql: "SELECT key, value FROM setting_gex_system WHERE key IN (?1, ?2, ?3);",
    args: [KUNCI_PERIODE, KUNCI_AMBANG, KUNCI_PREDIKAT],
  });
  return pengaturanKinerjaDariPeta(
    new Map(r.rows.map((x) => [String(x.key), String(x.value)])),
  );
}

interface InfoKaryawan {
  id: string;
  nama: string;
  divisi: string;
  aktif: boolean;
  keluar: boolean;
  tanggal_daftar: string | null;
  tanggal_selesai_aktif: string | null;
  id_jabatan: string | null;
  jabatan_nama: string | null;
  id_atasan: string | null;
}

async function bacaKaryawan(
  db: Pembaca,
  id: string | null,
): Promise<InfoKaryawan[]> {
  const r = await db.execute({ sql: KARYAWAN_KINERJA_SQL, args: [id] });
  return r.rows.map((x) => ({
    id: String(x[0]),
    nama: String(x[1] ?? ""),
    divisi: String(x[2] ?? ""),
    aktif: String(x[3]) === "Aktif",
    keluar: isi(x[4]) !== null,
    tanggal_daftar: isi(x[5]),
    tanggal_selesai_aktif: isi(x[6]),
    id_jabatan: isi(x[7]),
    jabatan_nama: isi(x[8]),
    id_atasan: isi(x[9]),
  }));
}

async function satuKaryawan(db: Pembaca, id: string): Promise<InfoKaryawan> {
  const k = (await bacaKaryawan(db, id))[0];
  if (!k) throw new Error("Karyawan tidak ditemukan.");
  return k;
}

const rentangKaryawan = (k: InfoKaryawan, mulai: string, selesai: string) =>
  rentangAktif(mulai, selesai, k.tanggal_daftar, k.tanggal_selesai_aktif);

async function pemetaan(db: Pembaca): Promise<Map<string, string | null>> {
  const r = await db.execute(
    "SELECT id_jabatan, id_template FROM hr_kinerja_jabatan;",
  );
  return new Map(r.rows.map((x) => [String(x.id_jabatan), isi(x.id_template)]));
}

const ringkasTemplate = (template: Baris[]): TemplateRingkas[] =>
  template.map((t) => ({
    id_template: s(t, "id_template"),
    is_aktif: n(t, "is_aktif") === 1,
    is_bawaan: n(t, "is_bawaan") === 1,
  }));

async function aspekTemplate(db: Pembaca, id: string): Promise<AspekSah[]> {
  const r = await db.execute({
    sql: "SELECT * FROM hr_kinerja_aspek WHERE id_template = ?1 ORDER BY urutan, id_aspek;",
    args: [id],
  });
  return objek(r).map((a) => ({
    id_aspek: s(a, "id_aspek"),
    nama: s(a, "nama"),
    tipe: s(a, "tipe"),
    bobot: n(a, "bobot"),
    panduan: so(a, "panduan"),
    urutan: n(a, "urutan"),
    is_aktif: n(a, "is_aktif") === 1,
  }));
}

async function satuPenilaian(db: Pembaca, id: string): Promise<Baris> {
  const r = await db.execute({
    sql: "SELECT * FROM hr_kinerja_penilaian WHERE id_penilaian = ?1;",
    args: [id],
  });
  const p = objek(r)[0];
  if (!p) throw new Error("Penilaian tidak ditemukan.");
  return p;
}

const keKeputusan = (k: Baris): KeputusanKinerja => ({
  id_keputusan: s(k, "id_keputusan"),
  jenis: s(k, "jenis"),
  sidik: s(k, "sidik"),
  oleh: s(k, "oleh"),
  waktu_perangkat: s(k, "waktu_perangkat"),
  diterima_cloud: so(k, "diterima_cloud"),
  nilai_akhir: k.nilai_akhir === null ? null : Number(k.nilai_akhir),
  predikat: so(k, "predikat"),
});

async function petaKeputusan(
  db: Pembaca,
  ids: string[],
): Promise<Map<string, KeputusanKinerja[]>> {
  const r = await db.execute({
    sql: "SELECT * FROM hr_kinerja_keputusan WHERE id_penilaian IN (SELECT value FROM json_each(?1)) ORDER BY id_keputusan;",
    args: [JSON.stringify(ids)],
  });
  const peta = new Map<string, KeputusanKinerja[]>();
  for (const k of objek(r)) {
    const id = s(k, "id_penilaian");
    peta.set(id, [...(peta.get(id) ?? []), keKeputusan(k)]);
  }
  return peta;
}

async function petaNilai(
  db: Pembaca,
  ids: string[],
): Promise<Map<string, BarisNilai[]>> {
  const r = await db.execute({
    sql: "SELECT * FROM hr_kinerja_nilai WHERE id_penilaian IN (SELECT value FROM json_each(?1)) ORDER BY id_penilaian, urutan, id_aspek;",
    args: [JSON.stringify(ids)],
  });
  const peta = new Map<string, BarisNilai[]>();
  for (const b of objek(r)) {
    const id = s(b, "id_penilaian");
    const baris: BarisNilai = {
      id_aspek: s(b, "id_aspek"),
      aspek_nama: s(b, "aspek_nama"),
      tipe: s(b, "tipe"),
      bobot: n(b, "bobot"),
      urutan: n(b, "urutan"),
      skor: b.skor === null ? null : Number(b.skor),
      catatan: so(b, "catatan"),
      rincian: so(b, "rincian"),
    };
    peta.set(id, [...(peta.get(id) ?? []), baris]);
  }
  return peta;
}

const ringkasPenilaian = (p: Baris, status: string): RingkasPenilaian => ({
  id_penilaian: s(p, "id_penilaian"),
  id_karyawan: s(p, "id_karyawan"),
  id_ref: so(p, "id_ref"),
  periode_mulai: s(p, "periode_mulai"),
  periode_selesai: s(p, "periode_selesai"),
  dibatalkan: status === STATUS_DIBATALKAN,
});

/** Q-85: penilaian atas diri sesi hanya terbaca setelah Final, lewat `view`. */
const bolehLihat = (
  actor: OperatorUser,
  idSesi: string | null,
  idKaryawan: string,
  status: string,
) =>
  idSesi !== idKaryawan || (status === STATUS_FINAL && punya(actor, IZIN_VIEW));

const rincianDisiplin = (nilai: readonly BarisNilai[]) =>
  nilai.find((b) => b.tipe === TIPE_DISIPLIN)?.rincian ?? null;

async function kueriJson(
  db: Pembaca,
  sql: string,
  mulai: string,
  selesai: string,
  id: string,
): Promise<Baris[]> {
  const r = await db.execute({ sql, args: [mulai, selesai, id] });
  return r.rows.map((x) => JSON.parse(String(x[0])) as Baris);
}

/** Cermin `muat_disiplin`: hitungan hidup dari database cloud. */
async function muatDisiplin(
  db: Pembaca,
  idKaryawan: string,
  rentang: RentangAktif | null,
  hariIni: string,
  ambang: Ambang,
): Promise<Disiplin> {
  const [mulai, selesai] = rentang
    ? [rentang.mulai, rentang.akhir]
    : ["9999-12-31", "0000-01-01"];
  const baca = (sql: string) => kueriJson(db, sql, mulai, selesai, idKaryawan);
  const k = (await baca(DISIPLIN_KARYAWAN_SQL))[0];
  const karyawan: KaryawanDisiplin = {
    divisi: k ? s(k, "divisi") : "",
    hari_kerja: k ? so(k, "hari_kerja") : null,
    kode_shift: k ? ((k.kode_shift as number | string | null) ?? null) : null,
  };
  const perjalanan = new Set(
    (await baca(DISIPLIN_PERJALANAN_SQL)).map((x) => s(x, "tanggal")),
  );
  return hitungDisiplin({
    mulai,
    selesai,
    hari_ini: hariIni,
    karyawan,
    hari: (await baca(DISIPLIN_HARI_SQL)) as unknown as HariLaporan[],
    pengajuan: (await baca(
      DISIPLIN_PENGAJUAN_SQL,
    )) as unknown as PengajuanLaporan[],
    tukar: (await baca(DISIPLIN_TUKAR_SQL)) as unknown as TukarLaporan[],
    perjalanan,
    kalender: await muatKalender(db, mulai, selesai),
    ambang,
  });
}

const disiplinPenilaian = (
  db: Pembaca,
  p: Baris,
  k: InfoKaryawan,
  hariIni: string,
  ambang: Ambang,
) =>
  muatDisiplin(
    db,
    k.id,
    rentangKaryawan(k, s(p, "periode_mulai"), s(p, "periode_selesai")),
    hariIni,
    ambang,
  );

/** Cermin `ringkasan`: status, nilai final, tanda. */
function ringkasan(
  p: Baris,
  keputusan: readonly KeputusanKinerja[],
  nilai: readonly BarisNilai[],
  k: InfoKaryawan | undefined,
  ganda: boolean,
  idSesi: string | null,
): Baris {
  const sidik = s(p, "sidik");
  const status = statusKinerja(sidik, keputusan);
  const berlaku =
    status === STATUS_FINAL ? finalBerlaku(sidik, keputusan) : null;
  const penuh = k
    ? (rentangKaryawan(k, s(p, "periode_mulai"), s(p, "periode_selesai"))
        ?.penuh ?? false)
    : true;
  const idAtasan = k?.id_atasan ?? null;
  const tanda = tandaKinerja({
    sidik,
    keputusan,
    penilai_oleh: s(p, "penilai_oleh"),
    id_penilai: so(p, "id_penilai"),
    id_atasan: idAtasan,
    rincian_disiplin: rincianDisiplin(nilai),
    periode_penuh: penuh,
    ganda,
  });
  const akhir = berlaku?.nilai_akhir ?? null;
  return {
    ...p,
    status,
    tanda,
    nilai_akhir: akhir,
    nilai_teks: akhir === null ? null : formatNilai(akhir),
    predikat: berlaku?.predikat ?? null,
    nama: k?.nama ?? null,
    divisi: k?.divisi ?? null,
    atasan_saya: idAtasan !== null && idAtasan === idSesi,
  };
}

/** Cermin `templates`. */
export async function templatesKinerja(db: Pembaca) {
  const [template, aspek, peta, jabatan, pengaturan] = await Promise.all([
    db
      .execute("SELECT * FROM hr_kinerja_template ORDER BY nama, id_template;")
      .then(objek),
    db
      .execute(
        "SELECT * FROM hr_kinerja_aspek ORDER BY id_template, urutan, id_aspek;",
      )
      .then(objek),
    pemetaan(db),
    db
      .execute(
        "SELECT j.id_jabatan, j.nama, j.is_aktif, k.id_template FROM hr_jabatan j LEFT JOIN hr_kinerja_jabatan k ON k.id_jabatan = j.id_jabatan ORDER BY j.nama, j.id_jabatan;",
      )
      .then(objek),
    bacaPengaturan(db),
  ]);
  const ganda = namaGanda(
    template.map((t) => [s(t, "id_template"), s(t, "nama")] as const),
  );
  return {
    template: template.map((t): Baris => {
      const id = s(t, "id_template");
      return {
        ...t,
        aspek: aspek.filter((a) => s(a, "id_template") === id),
        jabatan: [...peta]
          .filter(([, x]) => x === id)
          .map(([j]) => j)
          .sort(bandingTeks),
        nama_ganda: ganda.has(id),
      };
    }),
    jabatan,
    pengaturan,
  };
}

/** Cermin `simpan_template`. */
export async function simpanTemplateKinerja(
  client: Client,
  actor: OperatorUser,
  raw: unknown,
) {
  const sah = validasiTemplate(raw);
  if (!sah.ok) throw new Error(sah.pesan);
  const v = sah.nilai;
  const idMasuk = isi((raw as Baris | null)?.id_template);
  return withTransaction(client, async (tx) => {
    const semua = objek(
      await tx.execute("SELECT id_template, nama FROM hr_kinerja_template;"),
    );
    if (idMasuk && !semua.some((t) => s(t, "id_template") === idMasuk)) {
      throw new Error("Template tidak ditemukan.");
    }
    const id = idMasuk ?? newHexId("ktp-");
    const pasangan = semua.map(
      (t) => [s(t, "id_template"), s(t, "nama")] as const,
    );
    if (namaTemplateDipakai(v.nama, id, pasangan)) {
      throw new Error(`Template "${v.nama}" sudah ada.`);
    }
    const lama = (await aspekTemplate(tx, id)).map(
      (a) => [a.id_aspek, a.tipe] as const,
    );
    const cek = periksaAspekLama(v.aspek, lama);
    if (!cek.ok) throw new Error(cek.pesan);
    for (const j of v.jabatan) {
      const ada = await tx.execute({
        sql: "SELECT 1 FROM hr_jabatan WHERE id_jabatan = ?1;",
        args: [j],
      });
      if (ada.rows.length === 0) throw new Error("Jabatan tidak ditemukan.");
    }
    await tx.execute({
      sql: CLOUD_UPSERT_TEMPLATE_SQL,
      args: [
        id,
        v.nama,
        v.keterangan,
        v.is_bawaan ? 1 : 0,
        v.is_aktif ? 1 : 0,
        actor.username,
        null,
      ],
    });
    if (v.is_bawaan) {
      await tx.execute({ sql: CLOUD_SATU_BAWAAN_SQL, args: [id] });
    }
    for (const a of v.aspek) {
      await tx.execute({
        sql: CLOUD_UPSERT_ASPEK_SQL,
        args: [
          a.id_aspek || `${id}:${newHexId("")}`,
          id,
          a.nama,
          a.tipe,
          a.bobot,
          a.panduan,
          a.urutan,
          a.is_aktif ? 1 : 0,
          null,
        ],
      });
    }
    const peta = await pemetaan(tx);
    for (const j of v.jabatan) {
      if (peta.get(j) !== id) {
        await tx.execute({
          sql: CLOUD_UPSERT_JABATAN_SQL,
          args: [j, id, actor.username, id],
        });
      }
    }
    for (const [j, t] of peta) {
      if (t === id && !v.jabatan.includes(j)) {
        await tx.execute({
          sql: CLOUD_UPSERT_JABATAN_SQL,
          args: [j, null, actor.username, id],
        });
      }
    }
    return { sukses: true as const, id_template: id };
  });
}

/** Cermin `simpan_pengaturan`: Web menulis setting langsung ke cloud. */
export async function simpanPengaturanKinerja(client: Client, raw: unknown) {
  const sah = validasiPengaturanKinerja(raw);
  if (!sah.ok) throw new Error(sah.pesan);
  await withTransaction(client, async (tx) => {
    for (const [kunci, nilai] of sah.nilai) {
      await tx.execute({
        sql: `INSERT INTO setting_gex_system (key, value) VALUES (?1, ?2)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value;`,
        args: [kunci, nilai],
      });
    }
  });
  return { sukses: true as const };
}

async function periodeFilter(
  db: Pembaca,
  filter: Baris,
  pengaturan: PengaturanKinerja,
): Promise<[string, string, string]> {
  const jenis = isi(filter.periode_jenis) ?? pengaturan.periode;
  const mulai =
    isi(filter.periode_mulai) ?? awalPeriode(jenis, await hariIniWib(db));
  if (!mulai) {
    throw new Error(
      "Jenis periode harus Bulanan, Kuartal, Semester, atau Tahunan.",
    );
  }
  const rentang = periodeRentang(jenis, mulai);
  if (!rentang.ok) throw new Error(rentang.pesan);
  return [jenis, rentang.nilai[0], rentang.nilai[1]];
}

/** Cermin `daftar`. */
export async function daftarKinerja(
  client: Client,
  actor: OperatorUser,
  raw: unknown,
) {
  const filter = (raw ?? {}) as Baris;
  const idSesi = await karyawanAktor(client, actor);
  const pengaturan = await bacaPengaturan(client);
  const [jenis, mulai, selesai] = await periodeFilter(
    client,
    filter,
    pengaturan,
  );
  const hariIni = await hariIniWib(client);
  // `id_karyawan` = riwayat satu karyawan di semua periode; tanpa itu = satu periode.
  const idKaryawan = isi(filter.id_karyawan);
  const semua = objek(
    await client.execute(
      idKaryawan
        ? {
            sql: "SELECT * FROM hr_kinerja_penilaian WHERE id_karyawan = ?1 ORDER BY periode_mulai DESC, created_at, id_penilaian;",
            args: [idKaryawan],
          }
        : {
            sql: "SELECT * FROM hr_kinerja_penilaian WHERE periode_mulai <= ?2 AND periode_selesai >= ?1 ORDER BY periode_mulai, id_penilaian;",
            args: [mulai, selesai],
          },
    ),
  );
  const ids = semua.map((p) => s(p, "id_penilaian"));
  const keputusan = await petaKeputusan(client, ids);
  const nilai = await petaNilai(client, ids);
  const karyawan = new Map(
    (await bacaKaryawan(client, null)).map((k) => [k.id, k]),
  );
  const kep = (id: string) => keputusan.get(id) ?? [];
  const status = (p: Baris) =>
    statusKinerja(s(p, "sidik"), kep(s(p, "id_penilaian")));
  const ringkas = semua.map((p) => ringkasPenilaian(p, status(p)));
  const ganda = penilaianGanda(ringkas);
  // Nilai berlaku per akar (§21.7); akar dan koreksinya termuat bersama.
  const keluargaFinal = new Map<
    string,
    { id_penilaian: string; final: KeputusanKinerja }[]
  >();
  for (const p of semua) {
    const id = s(p, "id_penilaian");
    const f =
      status(p) === STATUS_FINAL ? finalBerlaku(s(p, "sidik"), kep(id)) : null;
    if (!f) continue;
    const akar = so(p, "id_ref") ?? id;
    keluargaFinal.set(akar, [
      ...(keluargaFinal.get(akar) ?? []),
      { id_penilaian: id, final: f },
    ]);
  }
  const berlaku = new Set(
    [...keluargaFinal.values()].map((a) => kinerjaBerlaku(a)),
  );
  const penilaian = semua
    .filter((p) => bolehLihat(actor, idSesi, s(p, "id_karyawan"), status(p)))
    .map((p): Baris => {
      const id = s(p, "id_penilaian");
      return {
        ...ringkasan(
          p,
          kep(id),
          nilai.get(id) ?? [],
          karyawan.get(s(p, "id_karyawan")),
          ganda.has(id),
          idSesi,
        ),
        berlaku: berlaku.has(id),
      };
    });
  const template = objek(
    await client.execute(
      "SELECT id_template, nama, is_aktif, is_bawaan FROM hr_kinerja_template;",
    ),
  );
  const ringkasT = ringkasTemplate(template);
  const peta = await pemetaan(client);
  const belum = [...karyawan.values()]
    .filter((k) => k.aktif && !k.keluar && k.id !== idSesi)
    .filter((k) => idKaryawan === null || k.id === idKaryawan)
    .filter((k) => rentangKaryawan(k, mulai, selesai) !== null)
    .filter(
      (k) =>
        !ringkas.some(
          (r) => r.id_karyawan === k.id && r.id_ref === null && !r.dibatalkan,
        ),
    )
    .sort((a, b) => bandingTeks(a.nama, b.nama) || bandingTeks(a.id, b.id));
  return {
    periode: {
      jenis,
      mulai,
      selesai,
      bisa_diajukan: selesai <= hariIni,
    },
    pengaturan,
    penilaian,
    belum_dinilai: belum.map((k) => {
      const t = templateKaryawan(k.id_jabatan, peta, ringkasT);
      const namaT = t
        ? (template.find((x) => s(x, "id_template") === t)?.nama ?? null)
        : null;
      return {
        id_karyawan: k.id,
        nama: k.nama,
        divisi: k.divisi,
        jabatan_nama: k.jabatan_nama,
        id_template: t,
        template_nama: namaT === null ? null : String(namaT),
        atasan_saya: k.id_atasan !== null && k.id_atasan === idSesi,
      };
    }),
  };
}

function keadaan(
  actor: OperatorUser,
  idSesi: string | null,
  p: Baris,
  status: string,
  nilai: readonly BarisNilai[],
  hariIni: string,
  disiplinSama: boolean,
): KeadaanKinerja {
  return {
    status,
    koreksi: so(p, "id_ref") !== null,
    karyawan_sendiri: idSesi !== null && idSesi === s(p, "id_karyawan"),
    boleh_assess: punya(actor, IZIN_ASSESS),
    boleh_finalize: punya(actor, IZIN_FINALIZE),
    skor_lengkap: skorLengkap(nilai),
    periode_selesai: s(p, "periode_selesai") <= hariIni,
    disiplin_sama: disiplinSama,
    akar_final: false,
    koreksi_terbuka: false,
  };
}

/** Cermin `keluarga`. */
async function keluarga(db: Pembaca, idAkar: string) {
  const anggota = objek(
    await db.execute({
      sql: "SELECT * FROM hr_kinerja_penilaian WHERE id_penilaian = ?1 OR id_ref = ?1 ORDER BY created_at, id_penilaian;",
      args: [idAkar],
    }),
  );
  const keputusan = await petaKeputusan(
    db,
    anggota.map((p) => s(p, "id_penilaian")),
  );
  let akarFinal = false;
  let terbuka = false;
  const kandidat: { id_penilaian: string; final: KeputusanKinerja }[] = [];
  for (const p of anggota) {
    const id = s(p, "id_penilaian");
    const kep = keputusan.get(id) ?? [];
    const sidik = s(p, "sidik");
    const status = statusKinerja(sidik, kep);
    if (id === idAkar) akarFinal = status === STATUS_FINAL;
    else if (status === STATUS_DRAF || status === STATUS_DIAJUKAN) {
      terbuka = true;
    }
    const f = status === STATUS_FINAL ? finalBerlaku(sidik, kep) : null;
    if (f) kandidat.push({ id_penilaian: id, final: f });
  }
  return {
    akarFinal,
    terbuka,
    berlaku: kinerjaBerlaku(kandidat),
    anggota,
  };
}

/** Cermin `rincian_lengkap`: SP dibaca dari database yang sama (cloud). */
export async function rincianKinerja(
  client: Client,
  actor: OperatorUser,
  id: string,
) {
  const idSesi = await karyawanAktor(client, actor);
  const p = await satuPenilaian(client, id);
  const kep = ((await petaKeputusan(client, [id])).get(id) ?? []).sort(
    urutKeputusan,
  );
  const nilai = (await petaNilai(client, [id])).get(id) ?? [];
  const status = statusKinerja(s(p, "sidik"), kep);
  if (!bolehLihat(actor, idSesi, s(p, "id_karyawan"), status)) {
    throw tolak(PESAN_BELUM_FINAL_SENDIRI);
  }
  const k = (await bacaKaryawan(client, s(p, "id_karyawan")))[0];
  const pengaturan = await bacaPengaturan(client);
  const hariIni = await hariIniWib(client);
  const disiplin =
    k && nilai.some((b) => b.tipe === TIPE_DISIPLIN)
      ? await disiplinPenilaian(client, p, k, hariIni, pengaturan.ambang)
      : null;
  const disiplinBerubah =
    disiplin !== null && rincianDisiplin(nilai) !== disiplin.rincian;
  const idAkar = so(p, "id_ref") ?? id;
  const kel = await keluarga(client, idAkar);
  const idsKel = kel.anggota.map((x) => s(x, "id_penilaian"));
  const kepKel = await petaKeputusan(client, idsKel);
  const nilaiKel = await petaNilai(client, idsKel);
  const riwayat = kel.anggota
    .filter((x) =>
      bolehLihat(
        actor,
        idSesi,
        s(x, "id_karyawan"),
        statusKinerja(s(x, "sidik"), kepKel.get(s(x, "id_penilaian")) ?? []),
      ),
    )
    .map((x) => {
      const idx = s(x, "id_penilaian");
      return ringkasan(
        x,
        kepKel.get(idx) ?? [],
        nilaiKel.get(idx) ?? [],
        k,
        false,
        idSesi,
      );
    });
  const kd: KeadaanKinerja = {
    ...keadaan(actor, idSesi, p, status, nilai, hariIni, !disiplinBerubah),
    akar_final: kel.akarFinal,
    koreksi_terbuka: kel.terbuka,
  };
  const boleh = Object.fromEntries(
    AKSI_KINERJA.map((aksi) => [
      aksi,
      // Koreksi selalu dinilai atas akarnya, bukan baris ini.
      periksaAksiKinerja(aksi, "-", {
        ...kd,
        koreksi: aksi === "Koreksi" ? false : kd.koreksi,
      }).ok,
    ]),
  );
  const sp = objek(
    await client.execute({
      sql: SP_PERIODE_SQL,
      args: [
        s(p, "id_karyawan"),
        s(p, "periode_mulai"),
        s(p, "periode_selesai"),
      ],
    }),
  );
  return {
    penilaian: ringkasan(p, kep, nilai, k, false, idSesi),
    nilai,
    keputusan: kep,
    disiplin,
    disiplin_berubah: disiplinBerubah,
    riwayat,
    id_akar: idAkar,
    id_berlaku: kel.berlaku,
    boleh,
    pengaturan,
    sp,
  };
}

interface Dasar {
  id: string;
  id_ref: string | null;
  alasan_koreksi: string | null;
  id_template: string;
  template_nama: string;
  id_jabatan: string | null;
  jabatan_nama: string | null;
  dibuat_oleh: string;
  baris: BarisNilai[];
}

/** Cermin `dasar_template`. */
async function dasarTemplate(
  db: Pembaca,
  k: InfoKaryawan,
): Promise<[string, string, BarisNilai[]]> {
  const template = objek(
    await db.execute(
      "SELECT id_template, nama, is_aktif, is_bawaan FROM hr_kinerja_template;",
    ),
  );
  const id = templateKaryawan(
    k.id_jabatan,
    await pemetaan(db),
    ringkasTemplate(template),
  );
  if (!id) throw new Error(PESAN_TANPA_TEMPLATE);
  const nama = s(
    template.find((t) => s(t, "id_template") === id) ?? {},
    "nama",
  );
  const baris = salinanAspek(await aspekTemplate(db, id));
  if (baris.length === 0) throw new Error(PESAN_TANPA_TEMPLATE);
  return [id, nama, baris];
}

function wajib<T>(
  hasil: { ok: true; nilai: T } | { ok: false; pesan: string },
) {
  if (!hasil.ok) throw new Error(hasil.pesan);
  return hasil.nilai;
}

/** Cermin `simpan`: buat, ubah draf, muat ulang template, buat koreksi. */
export async function simpanKinerja(
  client: Client,
  actor: OperatorUser,
  raw: unknown,
) {
  const draft = (raw ?? {}) as Baris;
  const v = wajib(validasiPenilaian(draft));
  const idMasuk = isi(draft.id_penilaian);
  const muatUlang = draft.muat_ulang === true || draft.muat_ulang === 1;
  const idSesi = await karyawanAktor(client, actor);
  return withTransaction(client, async (tx) => {
    const hariIni = await hariIniWib(tx);
    const k = await satuKaryawan(tx, v.id_karyawan);
    const pengaturan = await bacaPengaturan(tx);
    const dasarKeadaan: KeadaanKinerja = {
      status: "",
      koreksi: false,
      karyawan_sendiri: idSesi !== null && idSesi === k.id,
      boleh_assess: punya(actor, IZIN_ASSESS),
      boleh_finalize: punya(actor, IZIN_FINALIZE),
      skor_lengkap: false,
      periode_selesai: false,
      disiplin_sama: false,
      akar_final: false,
      koreksi_terbuka: false,
    };
    let dasar: Dasar;
    if (idMasuk) {
      const p = await satuPenilaian(tx, idMasuk);
      if (
        s(p, "id_karyawan") !== v.id_karyawan ||
        s(p, "periode_jenis") !== v.periode_jenis ||
        s(p, "periode_mulai") !== v.periode_mulai ||
        so(p, "id_ref") !== v.id_ref
      ) {
        throw new Error(
          "Karyawan, periode, dan rujukan penilaian tidak bisa diubah.",
        );
      }
      const kep = (await petaKeputusan(tx, [idMasuk])).get(idMasuk) ?? [];
      const status = statusKinerja(s(p, "sidik"), kep);
      wajib(
        periksaAksiKinerja("Simpan", "", {
          ...dasarKeadaan,
          status,
          koreksi: v.id_ref !== null,
        }),
      );
      // Cloud melewati save sesudah Final/Batal; jangan simpan diam-diam.
      if (kep.some((x) => x.jenis === "Final" || x.jenis === "Batal")) {
        throw new Error(PESAN_FINAL_LAMA);
      }
      const lama = (await petaNilai(tx, [idMasuk])).get(idMasuk) ?? [];
      dasar = {
        id: idMasuk,
        id_ref: v.id_ref,
        alasan_koreksi: v.alasan_koreksi,
        id_template: s(p, "id_template"),
        template_nama: s(p, "template_nama"),
        id_jabatan: so(p, "id_jabatan"),
        jabatan_nama: so(p, "jabatan_nama"),
        dibuat_oleh: s(p, "dibuat_oleh"),
        baris: lama,
      };
      if (muatUlang) {
        if (v.id_ref !== null) {
          throw new Error(
            "Koreksi tidak memuat ulang template; nilainya disalin dari penilaian yang berlaku.",
          );
        }
        const [t, nama, baru] = await dasarTemplate(tx, k);
        dasar = {
          ...dasar,
          id_template: t,
          template_nama: nama,
          id_jabatan: k.id_jabatan,
          jabatan_nama: k.jabatan_nama,
          baris: muatUlangTemplate(baru, lama),
        };
      }
    } else if (v.id_ref === null) {
      wajib(periksaAksiKinerja("Simpan", "", dasarKeadaan));
      const rentang = rentangKaryawan(k, v.periode_mulai, v.periode_selesai);
      wajib(periksaBuat(k.aktif, k.keluar, v.periode_mulai, hariIni, rentang));
      const milik = objek(
        await tx.execute({
          sql: "SELECT * FROM hr_kinerja_penilaian WHERE id_karyawan = ?1;",
          args: [k.id],
        }),
      );
      const kep = await petaKeputusan(
        tx,
        milik.map((p) => s(p, "id_penilaian")),
      );
      const lain = milik.map((p) =>
        ringkasPenilaian(
          p,
          statusKinerja(s(p, "sidik"), kep.get(s(p, "id_penilaian")) ?? []),
        ),
      );
      const x = bentrokPeriode(
        {
          id_penilaian: "",
          id_karyawan: k.id,
          id_ref: null,
          periode_mulai: v.periode_mulai,
          periode_selesai: v.periode_selesai,
          dibatalkan: false,
        },
        lain,
      );
      if (x)
        throw new Error(pesanBertumpuk(x.periode_mulai, x.periode_selesai));
      const [t, nama, baris] = await dasarTemplate(tx, k);
      dasar = {
        id: newHexId("knj-"),
        id_ref: null,
        alasan_koreksi: null,
        id_template: t,
        template_nama: nama,
        id_jabatan: k.id_jabatan,
        jabatan_nama: k.jabatan_nama,
        dibuat_oleh: actor.username,
        baris,
      };
    } else {
      const asal = await satuPenilaian(tx, v.id_ref);
      const idAkar = so(asal, "id_ref") ?? v.id_ref;
      const kel = await keluarga(tx, idAkar);
      wajib(
        periksaAksiKinerja("Koreksi", "", {
          ...dasarKeadaan,
          akar_final: kel.akarFinal,
          koreksi_terbuka: kel.terbuka,
        }),
      );
      const akar = kel.anggota.find((x) => s(x, "id_penilaian") === idAkar);
      if (!akar) throw new Error("Penilaian tidak ditemukan.");
      if (
        s(akar, "id_karyawan") !== v.id_karyawan ||
        s(akar, "periode_jenis") !== v.periode_jenis ||
        s(akar, "periode_mulai") !== v.periode_mulai
      ) {
        throw new Error(
          "Karyawan dan periode koreksi harus sama dengan penilaian asal.",
        );
      }
      // Baris disalin dari penilaian yang berlaku, bukan dari template.
      const idSumber = kel.berlaku ?? idAkar;
      const sumber = kel.anggota.find((x) => s(x, "id_penilaian") === idSumber);
      if (!sumber) throw new Error("Penilaian tidak ditemukan.");
      dasar = {
        id: newHexId("knj-"),
        id_ref: idAkar,
        alasan_koreksi: v.alasan_koreksi,
        id_template: s(sumber, "id_template"),
        template_nama: s(sumber, "template_nama"),
        id_jabatan: so(sumber, "id_jabatan"),
        jabatan_nama: so(sumber, "jabatan_nama"),
        dibuat_oleh: actor.username,
        baris: (await petaNilai(tx, [idSumber])).get(idSumber) ?? [],
      };
    }
    // Isian kosong atau muat ulang = pertahankan skor yang sudah ada.
    const isian: IsianNilai[] =
      muatUlang || v.nilai.length === 0
        ? dasar.baris.map((b) => ({
            id_aspek: b.id_aspek,
            skor: b.skor,
            catatan: b.catatan,
          }))
        : v.nilai;
    const disiplin = dasar.baris.some((b) => b.tipe === TIPE_DISIPLIN)
      ? await muatDisiplin(
          tx,
          k.id,
          rentangKaryawan(k, v.periode_mulai, v.periode_selesai),
          hariIni,
          pengaturan.ambang,
        )
      : null;
    const hasil = wajib(susunNilai(dasar.baris, isian, disiplin));
    const sidik = sidikPenilaian({
      id_karyawan: k.id,
      id_ref: dasar.id_ref,
      periode_mulai: v.periode_mulai,
      periode_selesai: v.periode_selesai,
      id_template: dasar.id_template,
      catatan: v.catatan,
      nilai: hasil,
    });
    const waktu = String(
      (await tx.execute("SELECT datetime('now') AS w;")).rows[0]?.w ?? "",
    );
    const id = dasar.id;
    await tx.execute({
      sql: CLOUD_UPSERT_PENILAIAN_SQL,
      args: [
        id,
        k.id,
        dasar.id_ref,
        dasar.alasan_koreksi,
        v.periode_jenis,
        v.periode_mulai,
        v.periode_selesai,
        dasar.id_template,
        dasar.template_nama,
        dasar.id_jabatan,
        dasar.jabatan_nama,
        idSesi,
        actor.username,
        v.catatan,
        sidik,
        dasar.dibuat_oleh,
        waktu,
        null,
      ],
    });
    await tx.execute({
      sql: CLOUD_BUANG_NILAI_SQL,
      args: [id, JSON.stringify(hasil.map((b) => idNilai(id, b.id_aspek)))],
    });
    for (const b of hasil) {
      await tx.execute({
        sql: CLOUD_UPSERT_NILAI_SQL,
        args: [
          idNilai(id, b.id_aspek),
          id,
          b.id_aspek,
          b.aspek_nama,
          b.tipe,
          b.bobot,
          b.urutan,
          b.skor,
          b.catatan,
          b.rincian,
        ],
      });
    }
    return {
      sukses: true as const,
      id_penilaian: id,
      sidik,
      disiplin,
      status: STATUS_DRAF,
    };
  });
}

/** Cermin `putuskan`: Ajukan, Kembalikan, Final, Batal. */
export async function putuskanKinerja(
  client: Client,
  actor: OperatorUser,
  raw: unknown,
) {
  const draft = (raw ?? {}) as Baris;
  const id = isi(draft.id_penilaian);
  if (!id) throw new Error("Penilaian tidak ditemukan.");
  const aksi = typeof draft.aksi === "string" ? draft.aksi.trim() : "";
  const alasan = typeof draft.alasan === "string" ? draft.alasan.trim() : "";
  if (!(JENIS_KEPUTUSAN as readonly string[]).includes(aksi)) {
    throw new Error("Aksi penilaian tidak dikenal.");
  }
  const idSesi = await karyawanAktor(client, actor);
  return withTransaction(client, async (tx) => {
    const p = await satuPenilaian(tx, id);
    const kep = (await petaKeputusan(tx, [id])).get(id) ?? [];
    const nilai = (await petaNilai(tx, [id])).get(id) ?? [];
    const sidik = s(p, "sidik");
    const status = statusKinerja(sidik, kep);
    const hariIni = await hariIniWib(tx);
    const pengaturan = await bacaPengaturan(tx);
    // Penjaga backend Q-72: angka disiplin yang diajukan harus hitungan kini.
    let disiplinSama = true;
    if (aksi === "Ajukan" && nilai.some((b) => b.tipe === TIPE_DISIPLIN)) {
      const k = await satuKaryawan(tx, s(p, "id_karyawan"));
      const d = await disiplinPenilaian(tx, p, k, hariIni, pengaturan.ambang);
      disiplinSama = rincianDisiplin(nilai) === d.rincian;
    }
    wajib(
      periksaAksiKinerja(
        aksi,
        alasan,
        keadaan(actor, idSesi, p, status, nilai, hariIni, disiplinSama),
      ),
    );
    let akhir: number | null = null;
    let namaPredikat: string | null = null;
    if (aksi === "Final") {
      akhir = nilaiAkhir(nilai);
      if (akhir === null) {
        throw new Error("Isi skor semua aspek sebelum mengajukan.");
      }
      namaPredikat = predikatNilai(akhir, pengaturan.predikat);
    }
    // Batal berid tetap: dua perangkat yang membatalkan menghasilkan PK sama.
    const idKeputusan = aksi === "Batal" ? `batal-${id}` : newHexId("kkn-");
    const waktu = String(
      (await tx.execute({ sql: WAKTU_KEPUTUSAN_SQL, args: [id] }))
        .rows[0]?.[0] ?? "",
    );
    await tx.execute({
      sql: CLOUD_INSERT_KEPUTUSAN_SQL,
      args: [
        idKeputusan,
        id,
        aksi,
        sidik,
        alasan || null,
        akhir,
        namaPredikat,
        actor.username,
        waktu,
        null,
      ],
    });
    const semua = (await petaKeputusan(tx, [id])).get(id) ?? [];
    return {
      sukses: true as const,
      id_keputusan: idKeputusan,
      status: statusKinerja(sidik, semua),
    };
  });
}
