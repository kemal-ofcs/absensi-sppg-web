import "server-only";

// HRIS fase 1 (v36), jalur Web. Kembaran `desktop/hris.rs`: Web menulis
// langsung ke database cloud, jadi penyimpanan master di sini = penulisan
// lokal + handler cloud Rust dalam satu transaksi. Profil dan dokumen KHUSUS
// CLOUD (Q-30, Q-45).

import type { Client } from "@libsql/client";
import {
  type Executor,
  newHexId,
  text,
  withTransaction,
} from "@/lib/services/inventory";
import { HARI_HADIR_SQL } from "@/lib/validations/driver";
import {
  bulanPenuhTerakhir,
  dalamSiklusAtasan,
  INSERT_KONTRAK_SQL,
  INSERT_NAMA_DIVISI_SQL,
  JENIS_DARI_KONTRAK_SQL,
  KOLOM_KEUANGAN,
  KOLOM_PRIBADI,
  type Kontrak,
  kunciDibawa,
  kunciNama,
  MAKS_BERKAS_PER_DOKUMEN,
  MAKS_CATATAN,
  MAKS_TEKS,
  namaBentrok,
  namaMaster,
  pengaturanDariPeta,
  periksaAtasan,
  SELARASKAN_DIVISI_SQL,
  SELARASKAN_JABATAN_SQL,
  statusKerja,
  tandaKontrak,
  teksIsian,
  UPSERT_CABANG_SQL,
  UPSERT_DIVISI_SQL,
  UPSERT_JABATAN_SQL,
  validasiBerkas,
  validasiDokumen,
  validasiKeuangan,
  validasiKontrak,
  validasiPengaturan,
  validasiPribadi,
} from "@/lib/validations/hris";

type Baris = Record<string, unknown>;
const baris = (rows: unknown[]): Baris[] =>
  rows.map((r) => ({ ...(r as Baris) }));

export interface Master {
  tabel: "hr_cabang" | "hr_divisi" | "hr_jabatan";
  kolomId: "id_cabang" | "id_divisi" | "id_jabatan";
  awalanId: string;
  label: string;
}
export const MASTER_CABANG: Master = {
  tabel: "hr_cabang",
  kolomId: "id_cabang",
  awalanId: "cb-",
  label: "Cabang",
};
export const MASTER_DIVISI: Master = {
  tabel: "hr_divisi",
  kolomId: "id_divisi",
  awalanId: "dv-",
  label: "Divisi",
};
export const MASTER_JABATAN: Master = {
  tabel: "hr_jabatan",
  kolomId: "id_jabatan",
  awalanId: "jb-",
  label: "Jabatan",
};

function aktifDari(draft: Baris): number {
  const v = draft.is_aktif;
  if (v === undefined || v === null) return 1;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (v === 0 || v === 1) return v;
  throw new Error("Status aktif tidak valid.");
}

function teksTerbatas(nilai: string | undefined, label: string, maks: number) {
  if (nilai && [...nilai].length > maks)
    throw new Error(`${label} maksimal ${maks} karakter.`);
  return nilai ?? null;
}

async function semuaNama(ex: Executor, sql: string, args: unknown[] = []) {
  const res = await ex.execute({ sql, args: args as never });
  return res.rows.map((r) => [String(r[0]), String(r[1])] as const);
}

/** Cermin `simpan_master` + handler cloud `hr-*-/save`. */
export async function simpanMaster(
  client: Client,
  master: Master,
  raw: unknown,
) {
  const draft = (raw ?? {}) as Baris;
  const nama = namaMaster(teksIsian(draft.nama) ?? "");
  if (!nama.ok) throw new Error(nama.pesan);
  const alamat = teksTerbatas(teksIsian(draft.alamat), "Alamat", MAKS_TEKS);
  const isAktif = aktifDari(draft);
  const idMasuk = teksIsian(draft[master.kolomId]) ?? null;
  return withTransaction(client, async (tx) => {
    if (idMasuk) {
      const ada = await tx.execute({
        sql: `SELECT 1 FROM ${master.tabel} WHERE ${master.kolomId} = ?1;`,
        args: [idMasuk],
      });
      if (ada.rows.length === 0)
        throw new Error(`${master.label} tidak ditemukan.`);
    }
    const lain = [
      ...(await semuaNama(
        tx,
        `SELECT ${master.kolomId}, nama FROM ${master.tabel};`,
      )),
      ...(master.tabel === "hr_divisi"
        ? await semuaNama(tx, "SELECT id_divisi, nama FROM hr_divisi_nama;")
        : []),
    ];
    if (namaBentrok(idMasuk, nama.nilai, lain)) {
      throw new Error(
        `${master.label} "${nama.nilai}" sudah ada atau pernah dipakai.`,
      );
    }
    const id = idMasuk ?? newHexId(master.awalanId);
    if (master.tabel === "hr_cabang") {
      await tx.execute({
        sql: UPSERT_CABANG_SQL,
        args: [id, nama.nilai, alamat, isAktif, null],
      });
    } else {
      await tx.execute({
        sql:
          master.tabel === "hr_divisi" ? UPSERT_DIVISI_SQL : UPSERT_JABATAN_SQL,
        args: [id, nama.nilai, isAktif, null],
      });
    }
    if (master.tabel === "hr_divisi") {
      const dipakai = await semuaNama(
        tx,
        "SELECT id_divisi, nama FROM hr_divisi_nama WHERE id_divisi = ?1;",
        [id],
      );
      if (!dipakai.some(([, n]) => kunciNama(n) === kunciNama(nama.nilai))) {
        await tx.execute({
          sql: INSERT_NAMA_DIVISI_SQL,
          args: [newHexId("dn-"), id, nama.nilai, null],
        });
      }
      for (const sql of SELARASKAN_DIVISI_SQL)
        await tx.execute({ sql, args: [id] });
    } else if (master.tabel === "hr_jabatan") {
      for (const sql of SELARASKAN_JABATAN_SQL)
        await tx.execute({ sql, args: [id] });
    }
    return { sukses: true as const, [master.kolomId]: id };
  });
}

async function bacaPengaturan(ex: Executor) {
  const res = await ex.execute(
    "SELECT key, value FROM setting_gex_system WHERE key LIKE 'hr\\_%' ESCAPE '\\';",
  );
  return pengaturanDariPeta(
    Object.fromEntries(res.rows.map((r) => [String(r.key), String(r.value)])),
  );
}

/** Cermin `simpan_pengaturan`. */
export async function simpanPengaturan(client: Client, raw: unknown) {
  const hasil = validasiPengaturan((raw ?? {}) as Baris);
  if (!hasil.ok) throw new Error(hasil.pesan);
  await withTransaction(client, async (tx) => {
    for (const [kunci, nilai] of Object.entries(hasil.nilai)) {
      await tx.execute({
        sql: `INSERT INTO setting_gex_system (key, value) VALUES (?1, ?2)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value;`,
        args: [kunci, String(nilai)],
      });
    }
  });
  return { sukses: true as const };
}

/** Cermin `organisasi`. */
export async function organisasi(client: Client) {
  const [
    cabang,
    divisi,
    jabatan,
    namaDivisi,
    jumlah,
    tanpaMaster,
    atasan,
    aturan,
  ] = await Promise.all([
    client.execute("SELECT * FROM hr_cabang ORDER BY is_aktif DESC, nama;"),
    client.execute("SELECT * FROM hr_divisi ORDER BY is_aktif DESC, nama;"),
    client.execute("SELECT * FROM hr_jabatan ORDER BY is_aktif DESC, nama;"),
    semuaNama(
      client,
      "SELECT id_divisi, nama FROM hr_divisi_nama ORDER BY created_at, id_nama;",
    ),
    client.execute(`SELECT 'id_cabang' AS kolom, id_cabang AS id, COUNT(*) AS n FROM master_data WHERE COALESCE(id_cabang, '') <> '' AND status_aktif = 'Aktif' GROUP BY id_cabang
        UNION ALL SELECT 'id_divisi', id_divisi, COUNT(*) FROM master_data WHERE COALESCE(id_divisi, '') <> '' AND status_aktif = 'Aktif' GROUP BY id_divisi
        UNION ALL SELECT 'id_jabatan', id_jabatan, COUNT(*) FROM master_data WHERE COALESCE(id_jabatan, '') <> '' AND status_aktif = 'Aktif' GROUP BY id_jabatan;`),
    client.execute(
      "SELECT MIN(TRIM(divisi)) AS teks, COUNT(*) AS jumlah FROM master_data WHERE COALESCE(id_divisi, '') = '' AND TRIM(COALESCE(divisi, '')) <> '' GROUP BY LOWER(TRIM(divisi)) ORDER BY teks;",
    ),
    client.execute("SELECT id_unik, id_atasan FROM master_data;"),
    bacaPengaturan(client),
  ]);
  const hitung = new Map(
    jumlah.rows.map((r) => [`${r.kolom}:${r.id}`, Number(r.n)] as const),
  );
  const daftar = (
    rows: unknown[],
    master: Master,
    namaLama: ReadonlyArray<readonly [string, string]>,
  ) => {
    const semua = baris(rows);
    const pembanding = [
      ...semua.map((b) => [String(b[master.kolomId]), String(b.nama)] as const),
      ...namaLama,
    ];
    return semua.map((b) => {
      const id = String(b[master.kolomId]);
      const nama = String(b.nama);
      return {
        ...b,
        jumlah: hitung.get(`${master.kolomId}:${id}`) ?? 0,
        nama_ganda: namaBentrok(id, nama, pembanding),
        ...(master.tabel === "hr_divisi"
          ? {
              nama_lama: namaLama
                .filter(
                  ([i, n]) => i === id && kunciNama(n) !== kunciNama(nama),
                )
                .map(([, n]) => n),
            }
          : {}),
      };
    });
  };
  const peta = new Map(
    atasan.rows.map(
      (r) => [String(r.id_unik), text(r.id_atasan) || null] as const,
    ),
  );
  return {
    cabang: daftar(cabang.rows, MASTER_CABANG, []),
    divisi: daftar(divisi.rows, MASTER_DIVISI, namaDivisi),
    jabatan: daftar(jabatan.rows, MASTER_JABATAN, []),
    tanpa_master: baris(tanpaMaster.rows),
    atasan_siklus: dalamSiklusAtasan(peta),
    pengaturan: aturan,
  };
}

// ── Kontrak ────────────────────────────────────────────────────────────────

/** Cermin `kontrak`. */
export async function kontrak(client: Client, idKaryawan?: string | null) {
  const [hari, aturan, rows] = await Promise.all([
    client.execute("SELECT date('now', '+7 hours') AS d;"),
    bacaPengaturan(client),
    client.execute({
      sql: "SELECT * FROM hr_kontrak WHERE (?1 IS NULL OR id_karyawan = ?1) ORDER BY id_karyawan, tanggal_mulai, id_kontrak;",
      args: [idKaryawan || null],
    }),
  ]);
  const hariIni = String(hari.rows[0]?.d ?? "");
  const per = new Map<string, { kontrak: Kontrak[]; lengkap: Baris[] }>();
  for (const r of baris(rows.rows)) {
    const id = String(r.id_karyawan);
    const isi = per.get(id) ?? { kontrak: [], lengkap: [] };
    isi.kontrak.push({
      id_kontrak: String(r.id_kontrak),
      jenis: String(r.jenis),
      id_ref: text(r.id_ref) || null,
      tanggal_mulai: String(r.tanggal_mulai),
      tanggal_selesai: text(r.tanggal_selesai) || null,
      percobaan_selesai: text(r.percobaan_selesai) || null,
    });
    isi.lengkap.push(r);
    per.set(id, isi);
  }
  const bulan = bulanPenuhTerakhir(hariIni, aturan.hr_harian_batas_bulan);
  const ringkas = async (id: string, k: Kontrak[]) => {
    const status = statusKerja(k, hariIni);
    const hadir: number[] = [];
    if (status.jenis === "Harian Lepas") {
      for (const [awal, akhir] of bulan) {
        const r = await client.execute({
          sql: `SELECT ${HARI_HADIR_SQL} AS n FROM master_data md WHERE md.id_unik = ?3;`,
          args: [awal, akhir, id],
        });
        hadir.push(Number(r.rows[0]?.n ?? 0));
      }
    }
    return {
      id_karyawan: id,
      status,
      tanda: tandaKontrak(k, aturan, hariIni, hadir),
    };
  };
  if (idKaryawan) {
    const isi = per.get(idKaryawan) ?? { kontrak: [], lengkap: [] };
    return {
      ...(await ringkas(idKaryawan, isi.kontrak)),
      kontrak: isi.lengkap,
      hari_ini: hariIni,
    };
  }
  const ids = [...per.keys()].sort();
  const karyawan = [];
  for (const id of ids)
    karyawan.push(await ringkas(id, per.get(id)?.kontrak ?? []));
  return { karyawan, hari_ini: hariIni };
}

/** Cermin `catat_kontrak`. */
export async function catatKontrak(client: Client, oleh: string, raw: unknown) {
  const sah = validasiKontrak((raw ?? {}) as Baris);
  if (!sah.ok) throw new Error(sah.pesan);
  const v = sah.nilai;
  return withTransaction(client, async (tx) => {
    const ada = await tx.execute({
      sql: "SELECT 1 FROM master_data WHERE id_unik = ?1;",
      args: [v.id_karyawan],
    });
    if (ada.rows.length === 0) throw new Error("Karyawan tidak ditemukan.");
    const id = newHexId("ktr-");
    await tx.execute({
      sql: INSERT_KONTRAK_SQL,
      args: [
        id,
        v.id_karyawan,
        v.jenis,
        null,
        v.nomor,
        v.tanggal_mulai,
        v.tanggal_selesai,
        v.percobaan_selesai,
        v.catatan,
        oleh,
        null,
      ],
    });
    await tx.execute({ sql: JENIS_DARI_KONTRAK_SQL, args: [v.id_karyawan] });
    return { sukses: true as const, id_kontrak: id };
  });
}

/** Cermin `batal_kontrak`. */
export async function batalKontrak(client: Client, oleh: string, raw: unknown) {
  const draft = (raw ?? {}) as Baris;
  const idKontrak = teksIsian(draft.id_kontrak);
  if (!idKontrak) throw new Error("Kontrak tidak ditemukan.");
  const alasan = teksTerbatas(teksIsian(draft.alasan), "Alasan", MAKS_CATATAN);
  if (!alasan) throw new Error("Alasan pembatalan wajib diisi.");
  return withTransaction(client, async (tx) => {
    const asal = await tx.execute({
      sql: "SELECT id_karyawan, jenis FROM hr_kontrak WHERE id_kontrak = ?1;",
      args: [idKontrak],
    });
    const r = asal.rows[0];
    if (!r || String(r.jenis) === "Pembatalan")
      throw new Error("Kontrak tidak ditemukan.");
    const id = `batal-${idKontrak}`;
    const sudah = await tx.execute({
      sql: "SELECT 1 FROM hr_kontrak WHERE id_kontrak = ?1;",
      args: [id],
    });
    if (sudah.rows.length > 0) throw new Error("Kontrak sudah dibatalkan.");
    const hari = await tx.execute("SELECT date('now', '+7 hours') AS d;");
    await tx.execute({
      sql: INSERT_KONTRAK_SQL,
      args: [
        id,
        String(r.id_karyawan),
        "Pembatalan",
        idKontrak,
        null,
        String(hari.rows[0]?.d),
        null,
        null,
        alasan,
        oleh,
        null,
      ],
    });
    await tx.execute({
      sql: JENIS_DARI_KONTRAK_SQL,
      args: [String(r.id_karyawan)],
    });
    return { sukses: true as const, id_kontrak: id };
  });
}

// ── Organisasi karyawan (dipakai `employee.ts`) ────────────────────────────

export interface OrgKaryawan {
  id_cabang: string | null;
  id_divisi: string | null;
  divisi: string;
  id_jabatan: string | null;
  jabatan_status: string | null;
  id_atasan: string | null;
}

async function masterById(ex: Executor, master: Master, id: string) {
  const r = await ex.execute({
    sql: `SELECT nama, is_aktif FROM ${master.tabel} WHERE ${master.kolomId} = ?1;`,
    args: [id],
  });
  const b = r.rows[0];
  return b ? { nama: String(b.nama), aktif: Number(b.is_aktif) === 1 } : null;
}

async function masterByTeks(ex: Executor, master: Master, teks: string) {
  const daftar = await semuaNama(
    ex,
    master.tabel === "hr_divisi"
      ? "SELECT id_divisi, nama FROM hr_divisi_nama ORDER BY created_at, id_nama;"
      : "SELECT id_jabatan, nama FROM hr_jabatan ORDER BY created_at, id_jabatan;",
  );
  const kunci = kunciNama(teks);
  return daftar.find(([, n]) => kunciNama(n) === kunci)?.[0] ?? null;
}

/** Cermin `org_dari_draft`. `idKaryawan` kosong = karyawan baru. */
export async function orgDariDraft(
  ex: Executor,
  idKaryawan: string,
  draft: Baris,
): Promise<OrgKaryawan> {
  const lamaRes = idKaryawan
    ? await ex.execute({
        sql: "SELECT id_cabang, id_divisi, divisi, id_jabatan, jabatan_status, id_atasan FROM master_data WHERE id_unik = ?1;",
        args: [idKaryawan],
      })
    : null;
  const l = lamaRes?.rows[0];
  const baru = !l;
  const lama: OrgKaryawan = {
    id_cabang: text(l?.id_cabang) || null,
    id_divisi: text(l?.id_divisi) || null,
    divisi: text(l?.divisi) ?? "",
    id_jabatan: text(l?.id_jabatan) || null,
    jabatan_status: l?.jabatan_status == null ? null : String(l.jabatan_status),
    id_atasan: text(l?.id_atasan) || null,
  };
  const pilih = async (master: Master, id: string, idLama: string | null) => {
    const m = await masterById(ex, master, id);
    if (!m) throw new Error(`${master.label} tidak ditemukan.`);
    if (!m.aktif && idLama !== id)
      throw new Error(`${master.label} "${m.nama}" sudah nonaktif.`);
    return m.nama;
  };

  let id_divisi: string | null;
  let divisi: string;
  const idDivisi = teksIsian(draft.id_divisi);
  const teksDivisi = teksIsian(draft.divisi);
  if (idDivisi) {
    divisi = await pilih(MASTER_DIVISI, idDivisi, lama.id_divisi);
    id_divisi = idDivisi;
  } else if (teksDivisi) {
    const id = await masterByTeks(ex, MASTER_DIVISI, teksDivisi);
    if (id) {
      divisi = await pilih(MASTER_DIVISI, id, lama.id_divisi);
      id_divisi = id;
    } else if (!baru && kunciNama(teksDivisi) === kunciNama(lama.divisi)) {
      id_divisi = lama.id_divisi;
      divisi = lama.divisi;
    } else {
      throw new Error(
        `Divisi '${teksDivisi}' belum terdaftar di Pengaturan → Organisasi.`,
      );
    }
  } else if (baru) {
    throw new Error("Divisi wajib dipilih.");
  } else {
    id_divisi = lama.id_divisi;
    divisi = lama.divisi;
  }

  let id_jabatan = lama.id_jabatan;
  let jabatan_status = lama.jabatan_status;
  const idJabatan = kunciDibawa(draft, "id_jabatan");
  if (typeof idJabatan === "string") {
    jabatan_status = await pilih(MASTER_JABATAN, idJabatan, lama.id_jabatan);
    id_jabatan = idJabatan;
  } else if (idJabatan === null) {
    id_jabatan = null;
  } else {
    const teks = teksIsian(draft.jabatan_status);
    if (teks && teks !== "-") {
      const id = await masterByTeks(ex, MASTER_JABATAN, teks);
      if (id) {
        jabatan_status = await pilih(MASTER_JABATAN, id, lama.id_jabatan);
        id_jabatan = id;
      } else if (
        !(
          lama.jabatan_status &&
          kunciNama(lama.jabatan_status) === kunciNama(teks)
        )
      ) {
        throw new Error(
          `Jabatan '${teks}' belum terdaftar di Pengaturan → Organisasi.`,
        );
      }
    }
  }

  let id_cabang = lama.id_cabang;
  const idCabang = kunciDibawa(draft, "id_cabang");
  if (typeof idCabang === "string") {
    await pilih(MASTER_CABANG, idCabang, lama.id_cabang);
    id_cabang = idCabang;
  } else if (idCabang === null) {
    id_cabang = null;
  }

  let id_atasan = lama.id_atasan;
  const idAtasan = kunciDibawa(draft, "id_atasan");
  if (typeof idAtasan === "string") {
    const semua = await ex.execute(
      "SELECT id_unik, id_atasan FROM master_data;",
    );
    const peta = new Map(
      semua.rows.map(
        (r) => [String(r.id_unik), text(r.id_atasan) || null] as const,
      ),
    );
    const diri = idKaryawan || teksIsian(draft.id_unik) || "";
    const galat = periksaAtasan(diri, idAtasan, peta);
    if (galat) throw new Error(galat);
    id_atasan = idAtasan;
  } else if (idAtasan === null) {
    id_atasan = null;
  }

  return {
    id_cabang,
    id_divisi,
    divisi,
    id_jabatan,
    jabatan_status,
    id_atasan,
  };
}

/** Cermin `tulis_org`, sebagai statement (dipakai juga impor ber-batch). */
export function orgStatements(idKaryawan: string, org: OrgKaryawan) {
  return [
    {
      sql: `UPDATE master_data SET id_cabang = ?1, id_divisi = ?2, divisi = ?3, id_jabatan = ?4,
            jabatan_status = COALESCE(?5, jabatan_status), id_atasan = ?6 WHERE id_unik = ?7;`,
      args: [
        org.id_cabang,
        org.id_divisi,
        org.divisi,
        org.id_jabatan,
        org.jabatan_status,
        org.id_atasan,
        idKaryawan,
      ],
    },
    { sql: JENIS_DARI_KONTRAK_SQL, args: [idKaryawan] },
  ];
}

/** Cermin `tulis_org`. */
export async function tulisOrg(
  ex: Executor,
  idKaryawan: string,
  org: OrgKaryawan,
) {
  for (const statement of orgStatements(idKaryawan, org)) {
    await ex.execute(statement);
  }
}

// ── Khusus cloud: profil dan dokumen ───────────────────────────────────────

async function karyawanAda(client: Client, id: string) {
  const r = await client.execute({
    sql: "SELECT 1 FROM master_data WHERE id_unik = ?1;",
    args: [id],
  });
  if (r.rows.length === 0) throw new Error("Karyawan tidak ditemukan.");
}

/** Cermin `profil`. */
export async function profil(
  client: Client,
  id: string,
  pribadi: boolean,
  keuangan: boolean,
) {
  const r = await client.execute({
    sql: "SELECT * FROM hr_profil WHERE id_karyawan = ?1;",
    args: [id],
  });
  const b = (r.rows[0] ?? {}) as Baris;
  const ambil = (kolom: readonly string[], jejak: string) =>
    Object.fromEntries(
      [...kolom, `${jejak}_diubah_oleh`, `${jejak}_diubah_pada`].map((k) => [
        k,
        b[k] ?? null,
      ]),
    );
  return {
    id_karyawan: id,
    pribadi: pribadi ? ambil(KOLOM_PRIBADI, "pribadi") : null,
    keuangan: keuangan ? ambil(KOLOM_KEUANGAN, "keuangan") : null,
  };
}

/** Cermin `sql_simpan_profil`. */
function sqlSimpanProfil(kolom: readonly string[], jejak: string) {
  const semua = [...kolom, `${jejak}_diubah_oleh`, `${jejak}_diubah_pada`];
  const tanda = Array.from({ length: kolom.length + 1 }, (_, i) => `?${i + 2}`);
  return `INSERT INTO hr_profil (id_karyawan, ${semua.join(", ")}) VALUES (?1, ${tanda.join(", ")}, datetime('now')) ON CONFLICT(id_karyawan) DO UPDATE SET ${semua.map((k) => `${k} = excluded.${k}`).join(", ")};`;
}

/** Cermin `simpan_profil`. */
export async function simpanProfil(
  client: Client,
  id: string,
  kelompok: "pribadi" | "keuangan",
  raw: unknown,
  oleh: string,
) {
  const hasil =
    kelompok === "pribadi" ? validasiPribadi(raw) : validasiKeuangan(raw);
  if (!hasil.ok) throw new Error(hasil.pesan);
  await karyawanAda(client, id);
  await client.execute({
    sql: sqlSimpanProfil(
      kelompok === "pribadi" ? KOLOM_PRIBADI : KOLOM_KEUANGAN,
      kelompok,
    ),
    args: [id, ...hasil.nilai, oleh],
  });
  return { sukses: true as const };
}

export async function jenisDokumen(client: Client) {
  const r = await client.execute(
    "SELECT * FROM hr_dokumen_jenis ORDER BY is_aktif DESC, nama;",
  );
  return baris(r.rows);
}

/** Cermin `simpan_jenis_dokumen`. */
export async function simpanJenisDokumen(client: Client, raw: unknown) {
  const draft = (raw ?? {}) as Baris;
  const nama = namaMaster(teksIsian(draft.nama) ?? "");
  if (!nama.ok) throw new Error(nama.pesan);
  const isAktif = aktifDari(draft);
  const idMasuk = teksIsian(draft.id_jenis) ?? null;
  const lain = await semuaNama(
    client,
    "SELECT id_jenis, nama FROM hr_dokumen_jenis;",
  );
  if (idMasuk && !lain.some(([i]) => i === idMasuk)) {
    throw new Error("Jenis dokumen tidak ditemukan.");
  }
  if (namaBentrok(idMasuk, nama.nilai, lain)) {
    throw new Error(`Jenis dokumen "${nama.nilai}" sudah ada.`);
  }
  const id = idMasuk ?? newHexId("dok-");
  await client.execute({
    sql: `INSERT INTO hr_dokumen_jenis (id_jenis, nama, is_aktif) VALUES (?1, ?2, ?3)
          ON CONFLICT(id_jenis) DO UPDATE SET nama = excluded.nama, is_aktif = excluded.is_aktif, updated_at = datetime('now');`,
    args: [id, nama.nilai, isAktif],
  });
  return { sukses: true as const, id_jenis: id };
}

/** Cermin `dokumen`: tanpa isi berkas. */
export async function dokumen(client: Client, idKaryawan: string) {
  const [d, b, jenis] = await Promise.all([
    client.execute({
      sql: "SELECT d.*, j.nama AS nama_jenis FROM hr_dokumen d LEFT JOIN hr_dokumen_jenis j ON j.id_jenis = d.id_jenis WHERE d.id_karyawan = ?1 ORDER BY j.nama, d.created_at;",
      args: [idKaryawan],
    }),
    client.execute({
      sql: "SELECT b.id_berkas, b.id_dokumen, b.urutan, b.nama_berkas, b.mime_type, length(b.data_base64) AS panjang FROM hr_dokumen_berkas b JOIN hr_dokumen d ON d.id_dokumen = b.id_dokumen WHERE d.id_karyawan = ?1 ORDER BY b.id_dokumen, b.urutan;",
      args: [idKaryawan],
    }),
    jenisDokumen(client),
  ]);
  const berkas = baris(b.rows);
  return {
    dokumen: baris(d.rows).map((x) => ({
      ...x,
      berkas: berkas.filter((f) => f.id_dokumen === x.id_dokumen),
    })),
    jenis,
  };
}

/** Cermin `simpan_dokumen`. */
export async function simpanDokumen(
  client: Client,
  raw: unknown,
  oleh: string,
) {
  const sah = validasiDokumen((raw ?? {}) as Baris);
  if (!sah.ok) throw new Error(sah.pesan);
  const v = sah.nilai;
  await karyawanAda(client, v.id_karyawan);
  let jenisLama: string | null = null;
  if (v.id_dokumen) {
    const r = await client.execute({
      sql: "SELECT id_jenis, id_karyawan FROM hr_dokumen WHERE id_dokumen = ?1;",
      args: [v.id_dokumen],
    });
    const l = r.rows[0];
    if (!l || String(l.id_karyawan) !== v.id_karyawan)
      throw new Error("Dokumen tidak ditemukan.");
    jenisLama = String(l.id_jenis);
  }
  const j = await client.execute({
    sql: "SELECT is_aktif FROM hr_dokumen_jenis WHERE id_jenis = ?1;",
    args: [v.id_jenis],
  });
  if (!j.rows[0]) throw new Error("Jenis dokumen tidak ditemukan.");
  if (Number(j.rows[0].is_aktif) !== 1 && jenisLama !== v.id_jenis) {
    throw new Error("Jenis dokumen sudah nonaktif.");
  }
  const id = v.id_dokumen ?? newHexId("hd-");
  await client.execute({
    sql: `INSERT INTO hr_dokumen (id_dokumen, id_karyawan, id_jenis, nomor, tanggal_terbit, tanggal_kedaluwarsa, catatan, dicatat_oleh)
          VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
          ON CONFLICT(id_dokumen) DO UPDATE SET id_jenis = excluded.id_jenis, nomor = excluded.nomor,
             tanggal_terbit = excluded.tanggal_terbit, tanggal_kedaluwarsa = excluded.tanggal_kedaluwarsa,
             catatan = excluded.catatan, updated_at = datetime('now');`,
    args: [
      id,
      v.id_karyawan,
      v.id_jenis,
      v.nomor,
      v.tanggal_terbit,
      v.tanggal_kedaluwarsa,
      v.catatan,
      oleh,
    ],
  });
  return { sukses: true as const, id_dokumen: id };
}

/** Cermin `hapus_dokumen`: dokumen + berkasnya, satu transaksi. */
export async function hapusDokumen(client: Client, id: string) {
  await client.batch(
    [
      {
        sql: "DELETE FROM hr_dokumen_berkas WHERE id_dokumen = ?1;",
        args: [id],
      },
      { sql: "DELETE FROM hr_dokumen WHERE id_dokumen = ?1;", args: [id] },
    ],
    "write",
  );
  return { sukses: true as const };
}

/** Cermin `tambah_berkas`. */
export async function tambahBerkas(client: Client, raw: unknown) {
  const draft = (raw ?? {}) as Baris;
  const idDokumen = teksIsian(draft.id_dokumen);
  if (!idDokumen) throw new Error("Dokumen tidak ditemukan.");
  const mime = teksIsian(draft.mime_type) ?? "";
  const data = typeof draft.data_base64 === "string" ? draft.data_base64 : "";
  const galat = validasiBerkas(mime, data);
  if (galat) throw new Error(galat);
  const namaBerkas = teksTerbatas(
    teksIsian(draft.nama_berkas),
    "Nama berkas",
    MAKS_TEKS,
  );
  const ada = await client.execute({
    sql: "SELECT 1 FROM hr_dokumen WHERE id_dokumen = ?1;",
    args: [idDokumen],
  });
  if (ada.rows.length === 0) throw new Error("Dokumen tidak ditemukan.");
  const terpakai = new Set(
    (
      await client.execute({
        sql: "SELECT urutan FROM hr_dokumen_berkas WHERE id_dokumen = ?1;",
        args: [idDokumen],
      })
    ).rows.map((r) => Number(r.urutan)),
  );
  const urutan = Array.from(
    { length: MAKS_BERKAS_PER_DOKUMEN },
    (_, i) => i + 1,
  ).find((u) => !terpakai.has(u));
  if (!urutan)
    throw new Error(`Satu dokumen maksimal ${MAKS_BERKAS_PER_DOKUMEN} berkas.`);
  const id = newHexId("hb-");
  await client.execute({
    sql: "INSERT INTO hr_dokumen_berkas (id_berkas, id_dokumen, urutan, nama_berkas, mime_type, data_base64) VALUES (?1, ?2, ?3, ?4, ?5, ?6);",
    args: [id, idDokumen, urutan, namaBerkas, mime, data],
  });
  return { sukses: true as const, id_berkas: id };
}

export async function berkas(client: Client, id: string) {
  const r = await client.execute({
    sql: "SELECT id_berkas, nama_berkas, mime_type, data_base64 FROM hr_dokumen_berkas WHERE id_berkas = ?1;",
    args: [id],
  });
  if (!r.rows[0]) throw new Error("Berkas tidak ditemukan.");
  return { ...(r.rows[0] as Baris) };
}

export async function hapusBerkas(client: Client, id: string) {
  await client.execute({
    sql: "DELETE FROM hr_dokumen_berkas WHERE id_berkas = ?1;",
    args: [id],
  });
  return { sukses: true as const };
}
