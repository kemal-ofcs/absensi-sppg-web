import "server-only";

// HRIS fase 7 (v42), jalur Web. Kembaran `desktop/hr_pelatihan.rs`:
// pelatihan, peserta, dan sertifikat (= `hr_dokumen` berjenis
// `dok-sertifikat`, Q-97). KHUSUS CLOUD (Q-87). Biaya tanpa jurnal (Q-98).

import type { Client, InStatement } from "@libsql/client";
import type { OperatorUser } from "@/lib/auth/operator-user";
import { hapusDokumen } from "@/lib/services/hris";
import { type Executor, newHexId, wibToday } from "@/lib/services/inventory";
import {
  BATAL_PELATIHAN_SQL,
  BERKAS_PESERTA_SQL,
  BERKAS_SERTIFIKAT_SQL,
  DAFTAR_PELATIHAN_SQL,
  HASIL_PESERTA_SQL,
  INSERT_PELATIHAN_SQL,
  idPeserta,
  JENIS_SERTIFIKAT,
  LEPAS_PESERTA_SQL,
  PESAN_PELATIHAN_BATAL,
  PESAN_PESERTA_BERSERTIFIKAT,
  PESAN_SERTIFIKAT_NONAKTIF,
  PESERTA_SQL,
  RIWAYAT_SQL,
  statusPelatihan,
  TAMBAH_PESERTA_SQL,
  TAUT_SERTIFIKAT_SQL,
  UBAH_PELATIHAN_SQL,
  validasiBatalPelatihan,
  validasiPelatihan,
  validasiPeserta,
} from "@/lib/validations/hr-pelatihan";
import {
  INSERT_BERKAS_DOKUMEN_SQL,
  MAKS_BERKAS_PER_DOKUMEN,
  MAKS_TEKS,
  SIMPAN_DOKUMEN_SQL,
  teksIsian,
  validasiBerkas,
  validasiDokumen,
} from "@/lib/validations/hris";

type Baris = Record<string, unknown>;

const teks = (nilai: unknown) => teksIsian(nilai) ?? null;
const angka = (nilai: unknown) =>
  Number.isFinite(Number(nilai)) ? Number(nilai) : 0;
const takDitemukan = (apa: string) => new Error(`${apa} tidak ditemukan.`);

async function objek(
  db: Executor,
  sql: string,
  args: (string | number | null)[] = [],
): Promise<Baris[]> {
  const res = await db.execute({ sql, args });
  return res.rows.map((r) => ({ ...(r as Baris) }));
}

async function satu(
  db: Executor,
  sql: string,
  args: (string | number | null)[] = [],
): Promise<Baris | null> {
  return (await objek(db, sql, args))[0] ?? null;
}

const denganStatus = (b: Baris, hariIni: string): Baris => ({
  ...b,
  status: statusPelatihan(
    String(b.tanggal_mulai ?? ""),
    String(b.tanggal_selesai ?? ""),
    teks(b.dibatalkan_pada) !== null,
    hariIni,
  ),
});

async function pelatihan(db: Executor, id: string): Promise<Baris> {
  const b = await satu(
    db,
    "SELECT * FROM hr_pelatihan WHERE id_pelatihan = ?1;",
    [id],
  );
  if (!b) throw takDitemukan("Pelatihan");
  return b;
}

/** Cermin `daftar`: pelatihan satu tahun (bawaan tahun berjalan WIB). */
export async function daftarPelatihan(db: Executor, tahun: number | null) {
  const hariIni = await wibToday(db);
  const t = tahun ?? Number(hariIni.slice(0, 4));
  const daftar = await objek(db, DAFTAR_PELATIHAN_SQL, [
    String(t).padStart(4, "0"),
  ]);
  return {
    pelatihan: daftar.map((b) => denganStatus(b, hariIni)),
    tahun: t,
    hari_ini: hariIni,
  };
}

/** Cermin `rincian`. */
export async function rincianPelatihan(db: Executor, idPelatihan: string) {
  const hariIni = await wibToday(db);
  const data = denganStatus(await pelatihan(db, idPelatihan), hariIni);
  const peserta = await objek(db, PESERTA_SQL, [idPelatihan]);
  const berkas = await objek(db, BERKAS_PESERTA_SQL, [idPelatihan]);
  const jenis = await satu(
    db,
    "SELECT is_aktif FROM hr_dokumen_jenis WHERE id_jenis = ?1;",
    [JENIS_SERTIFIKAT],
  );
  return {
    pelatihan: data,
    peserta: peserta.map((p) => ({
      ...p,
      berkas:
        p.id_dokumen == null
          ? []
          : berkas.filter((b) => b.id_dokumen === p.id_dokumen),
    })),
    sertifikat_aktif: angka(jenis?.is_aktif) === 1,
  };
}

/** Cermin `riwayat`. */
export async function riwayatPelatihan(db: Executor, idKaryawan: string) {
  const hariIni = await wibToday(db);
  const daftar = await objek(db, RIWAYAT_SQL, [idKaryawan]);
  return { riwayat: daftar.map((b) => denganStatus(b, hariIni)) };
}

/** Cermin `simpan`: `simpan` atau `batal`. */
export async function simpanPelatihan(
  client: Client,
  actor: OperatorUser,
  raw: unknown,
) {
  const draft = (raw ?? {}) as Baris;
  const aksi = teks(draft.aksi) ?? "simpan";
  const idMasuk = teks(draft.id_pelatihan);
  const lama = idMasuk ? await pelatihan(client, idMasuk) : null;
  const dibatalkan = teks(lama?.dibatalkan_pada) !== null;
  if (aksi === "batal") {
    if (!lama || !idMasuk) throw takDitemukan("Pelatihan");
    const alasan = validasiBatalPelatihan(draft, dibatalkan);
    if (!alasan.ok) throw new Error(alasan.pesan);
    await client.execute({
      sql: BATAL_PELATIHAN_SQL,
      args: [idMasuk, actor.username, alasan.nilai],
    });
    return { sukses: true as const, id_pelatihan: idMasuk };
  }
  if (aksi !== "simpan") throw new Error("Aksi pelatihan tidak dikenal.");
  const hasil = validasiPelatihan(draft);
  if (!hasil.ok) throw new Error(hasil.pesan);
  if (dibatalkan) throw new Error(PESAN_PELATIHAN_BATAL);
  const v = hasil.nilai;
  const id = idMasuk ?? newHexId("plt-");
  await client.execute({
    sql: idMasuk ? UBAH_PELATIHAN_SQL : INSERT_PELATIHAN_SQL,
    args: [
      id,
      v.nama,
      v.penyelenggara,
      v.tanggal_mulai,
      v.tanggal_selesai,
      v.lokasi,
      v.biaya,
      v.keterangan,
      actor.username,
    ],
  });
  return { sukses: true as const, id_pelatihan: id };
}

/** Cermin `simpan_peserta`: `tambah`, `lepas`, atau `hasil`. */
export async function simpanPeserta(
  client: Client,
  actor: OperatorUser,
  raw: unknown,
) {
  const draft = (raw ?? {}) as Baris;
  const idPelatihan = teks(draft.id_pelatihan);
  if (!idPelatihan) throw takDitemukan("Pelatihan");
  const data = await pelatihan(client, idPelatihan);
  if (teks(data.dibatalkan_pada)) throw new Error(PESAN_PELATIHAN_BATAL);
  const aksi = teks(draft.aksi) ?? "";
  if (aksi === "tambah") {
    const daftar = Array.isArray(draft.id_karyawan)
      ? draft.id_karyawan
          .filter((x): x is string => typeof x === "string")
          .map((x) => x.trim())
          .filter(Boolean)
      : [];
    if (daftar.length === 0) throw new Error("Karyawan wajib dipilih.");
    if (daftar.length > 500)
      throw new Error("Maksimal 500 peserta sekali tambah.");
    for (const id of daftar) {
      const k = await satu(
        client,
        "SELECT nama, status_aktif FROM master_data WHERE id_unik = ?1;",
        [id],
      );
      if (!k) throw takDitemukan("Karyawan");
      if (k.status_aktif !== "Aktif") {
        throw new Error(
          `${String(k.nama ?? "")} tidak aktif dan tidak bisa menjadi peserta.`,
        );
      }
    }
    await client.batch(
      daftar.map((id) => ({
        sql: TAMBAH_PESERTA_SQL,
        args: [idPelatihan, id, actor.username],
      })),
      "write",
    );
    return { sukses: true as const };
  }
  if (aksi === "lepas" || aksi === "hasil") {
    const sah = validasiPeserta(draft);
    if (!sah.ok) throw new Error(sah.pesan);
    const id = idPeserta(idPelatihan, sah.nilai.id_karyawan);
    const peserta = await satu(
      client,
      "SELECT id_dokumen FROM hr_pelatihan_peserta WHERE id_peserta = ?1;",
      [id],
    );
    if (!peserta) throw takDitemukan("Peserta");
    if (aksi === "lepas") {
      if (teks(peserta.id_dokumen))
        throw new Error(PESAN_PESERTA_BERSERTIFIKAT);
      await client.execute({ sql: LEPAS_PESERTA_SQL, args: [id] });
    } else {
      await client.execute({
        sql: HASIL_PESERTA_SQL,
        args: [id, sah.nilai.hasil, sah.nilai.catatan],
      });
    }
    return { sukses: true as const };
  }
  throw new Error("Aksi peserta tidak dikenal.");
}

/**
 * Cermin `simpan_sertifikat`: `simpan` (data + berkas baru + tautan, satu
 * batch), `hapus` (lewat `hapusDokumen`, yang melepas tautan), atau
 * `hapus_berkas`. Jenis dikunci `dok-sertifikat`, karyawan = peserta.
 */
export async function simpanSertifikat(
  client: Client,
  actor: OperatorUser,
  raw: unknown,
) {
  const draft = (raw ?? {}) as Baris;
  const idPelatihan = teks(draft.id_pelatihan);
  if (!idPelatihan) throw takDitemukan("Pelatihan");
  const idKaryawan = teks(draft.id_karyawan);
  if (!idKaryawan) throw new Error("Karyawan wajib dipilih.");
  const id = idPeserta(idPelatihan, idKaryawan);
  const data = await pelatihan(client, idPelatihan);
  const peserta = await satu(
    client,
    "SELECT id_dokumen FROM hr_pelatihan_peserta WHERE id_peserta = ?1;",
    [id],
  );
  if (!peserta) throw takDitemukan("Peserta");
  const idDokumen = teks(peserta.id_dokumen);
  const aksi = teks(draft.aksi) ?? "simpan";
  if (aksi === "hapus") {
    if (!idDokumen) throw takDitemukan("Sertifikat");
    return hapusDokumen(client, idDokumen);
  }
  if (aksi === "hapus_berkas") {
    if (!idDokumen) throw takDitemukan("Sertifikat");
    const idBerkas = teks(draft.id_berkas);
    if (!idBerkas) throw takDitemukan("Berkas");
    await client.execute({
      sql: "DELETE FROM hr_dokumen_berkas WHERE id_berkas = ?1 AND id_dokumen = ?2;",
      args: [idBerkas, idDokumen],
    });
    return { sukses: true as const };
  }
  if (aksi !== "simpan") throw new Error("Aksi sertifikat tidak dikenal.");
  const sah = validasiDokumen({
    ...draft,
    id_karyawan: idKaryawan,
    id_jenis: JENIS_SERTIFIKAT,
    id_dokumen: idDokumen,
    catatan: teks(draft.catatan) ?? teks(data.nama),
  });
  if (!sah.ok) throw new Error(sah.pesan);
  const berkasBaru = Array.isArray(draft.berkas)
    ? (draft.berkas as Baris[])
    : [];
  for (const b of berkasBaru) {
    const galat = validasiBerkas(
      teks(b.mime_type) ?? "",
      typeof b.data_base64 === "string" ? b.data_base64 : "",
    );
    if (galat) throw new Error(galat);
    const nama = teks(b.nama_berkas);
    if (nama && [...nama].length > MAKS_TEKS)
      throw new Error(`Nama berkas maksimal ${MAKS_TEKS} karakter.`);
  }
  if (!idDokumen) {
    const jenis = await satu(
      client,
      "SELECT is_aktif FROM hr_dokumen_jenis WHERE id_jenis = ?1;",
      [JENIS_SERTIFIKAT],
    );
    if (angka(jenis?.is_aktif) !== 1)
      throw new Error(PESAN_SERTIFIKAT_NONAKTIF);
  }
  const idDok = idDokumen ?? newHexId("hd-");
  const terpakai = new Set(
    idDokumen
      ? (
          await objek(
            client,
            "SELECT urutan FROM hr_dokumen_berkas WHERE id_dokumen = ?1;",
            [idDokumen],
          )
        ).map((b) => angka(b.urutan))
      : [],
  );
  const slot = Array.from(
    { length: MAKS_BERKAS_PER_DOKUMEN },
    (_, i) => i + 1,
  ).filter((u) => !terpakai.has(u));
  if (berkasBaru.length > slot.length)
    throw new Error(`Satu dokumen maksimal ${MAKS_BERKAS_PER_DOKUMEN} berkas.`);
  const v = sah.nilai;
  const statements: InStatement[] = [
    {
      sql: SIMPAN_DOKUMEN_SQL,
      args: [
        idDok,
        v.id_karyawan,
        v.id_jenis,
        v.nomor,
        v.tanggal_terbit,
        v.tanggal_kedaluwarsa,
        v.catatan,
        actor.username,
      ],
    },
    ...berkasBaru.map((b, i) => ({
      sql: INSERT_BERKAS_DOKUMEN_SQL,
      args: [
        newHexId("hb-"),
        idDok,
        slot[i],
        teks(b.nama_berkas),
        teks(b.mime_type),
        String(b.data_base64),
      ],
    })),
    { sql: TAUT_SERTIFIKAT_SQL, args: [id, idDok] },
  ];
  await client.batch(statements, "write");
  return { sukses: true as const, id_dokumen: idDok };
}

/** Cermin `berkas_sertifikat`: hanya berkas yang tertaut ke peserta. */
export async function berkasSertifikat(db: Executor, idBerkas: string) {
  const b = await satu(db, BERKAS_SERTIFIKAT_SQL, [idBerkas]);
  if (!b) throw takDitemukan("Berkas");
  return b;
}
