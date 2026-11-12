import "server-only";

// HRIS fase 7 (v42), jalur Web. Kembaran `desktop/hr_rekrutmen.rs`: lowongan,
// pelamar, tahap, berkas, retensi, dan Jadikan karyawan. KHUSUS CLOUD (Q-86).
// Jadikan karyawan di Web atomik penuh: klaim, karyawan, organisasi, dan
// kontrak pertama dalam satu transaksi (§22.5).

import type { Client, InStatement } from "@libsql/client";
import type { OperatorUser } from "@/lib/auth/operator-user";
import {
  type KaryawanInput,
  susunTambahKaryawan,
} from "@/lib/services/employee";
import {
  type Executor,
  newHexId,
  wibToday,
  withTransaction,
} from "@/lib/services/inventory";
import {
  BATAL_TAHAP_SQL,
  BUKA_LOWONGAN_SQL,
  DAFTAR_LOWONGAN_SQL,
  HAPUS_BERKAS_SQL,
  HAPUS_PELAMAR_LAMA_SQL,
  INSERT_BERKAS_SQL,
  INSERT_LOWONGAN_SQL,
  INSERT_PELAMAR_SQL,
  INSERT_TAHAP_SQL,
  IZIN_JADIKAN_KARYAWAN,
  idDariPelamar,
  KLAIM_PELAMAR_SQL,
  type LowonganSah,
  MAKS_BERKAS_PER_PELAMAR,
  PELAMAR_DIHAPUS_SQL,
  PELAMAR_LOWONGAN_SQL,
  PELAMAR_SATU_SQL,
  PESAN_SUDAH_KARYAWAN,
  pelamarGanda,
  periksaBatalTahap,
  periksaTahap,
  STATUS_SEMUA_PELAMAR_SQL,
  statusLowongan,
  statusPelamar,
  TAHAP_PROSES,
  type TahapRingkas,
  TUTUP_LOWONGAN_SQL,
  UBAH_LOWONGAN_SQL,
  UBAH_PELAMAR_SQL,
  validasiLowongan,
  validasiPelamar,
} from "@/lib/validations/hr-rekrutmen";
import {
  INSERT_KONTRAK_SQL,
  JENIS_DARI_KONTRAK_SQL,
  MAKS_TEKS,
  teksIsian,
  validasiBerkas,
  validasiKontrak,
} from "@/lib/validations/hris";
import { isValidDate } from "@/lib/validations/inventory";

type Baris = Record<string, unknown>;

const teks = (nilai: unknown) => teksIsian(nilai) ?? null;
const angka = (nilai: unknown) =>
  Number.isFinite(Number(nilai)) ? Number(nilai) : 0;

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

const takDitemukan = (apa: string) => new Error(`${apa} tidak ditemukan.`);

function statusDariBaris(l: Baris, hariIni: string) {
  return statusLowongan(
    String(l.tanggal_buka ?? ""),
    teks(l.tanggal_tutup),
    teks(l.ditutup_pada) !== null,
    hariIni,
  );
}

const ringkasTahap = (baris: Baris[]): TahapRingkas[] =>
  baris.map((t) => ({
    urutan: angka(t.urutan),
    tahap: String(t.tahap ?? ""),
    dibatalkan: teks(t.dibatalkan_pada) !== null,
  }));

const tahapPelamar = (db: Executor, id: string) =>
  objek(
    db,
    "SELECT * FROM hr_pelamar_tahap WHERE id_pelamar = ?1 ORDER BY urutan;",
    [id],
  );

/** Cermin `daftar_lowongan`. */
export async function daftarLowongan(db: Executor) {
  const hariIni = await wibToday(db);
  const lowongan = await objek(db, DAFTAR_LOWONGAN_SQL);
  const pelamar = await objek(db, STATUS_SEMUA_PELAMAR_SQL);
  const hasil = lowongan.map((l): Baris => {
    const status = statusDariBaris(l, hariIni);
    const milik = pelamar.filter((p) => p.id_lowongan === l.id_lowongan);
    const hitungan: Record<string, number> = {};
    for (const p of milik) {
      const s = String(p.status ?? "");
      hitungan[s] = (hitungan[s] ?? 0) + 1;
    }
    const diterima = hitungan.Diterima ?? 0;
    const menggantung =
      status === "Ditutup"
        ? milik.filter(
            (p) =>
              teks(p.id_karyawan) === null &&
              (TAHAP_PROSES as readonly string[]).includes(
                String(p.status ?? ""),
              ),
          ).length
        : 0;
    return {
      ...l,
      status,
      jumlah_pelamar: milik.length,
      jadi_karyawan: milik.filter((p) => teks(p.id_karyawan) !== null).length,
      lewat_kuota: diterima > angka(l.jumlah),
      menggantung,
      hitungan,
    };
  });
  return { lowongan: hasil, hari_ini: hariIni };
}

/** Cermin `periksa_org`. */
async function periksaOrg(db: Executor, sah: LowonganSah, lama: Baris | null) {
  const daftar = [
    ["hr_jabatan", "id_jabatan", sah.id_jabatan, "Jabatan"],
    ["hr_divisi", "id_divisi", sah.id_divisi, "Divisi"],
    ["hr_cabang", "id_cabang", sah.id_cabang, "Cabang"],
  ] as const;
  for (const [tabel, kolom, nilai, label] of daftar) {
    if (!nilai) continue;
    const tetap = teks(lama?.[kolom]) === nilai;
    const b = await satu(
      db,
      `SELECT is_aktif FROM ${tabel} WHERE ${kolom} = ?1;`,
      [nilai],
    );
    if (!b) throw takDitemukan(label);
    if (!tetap && angka(b.is_aktif) !== 1)
      throw new Error(`${label} sudah nonaktif.`);
  }
}

/** Cermin `simpan_lowongan`: `simpan`, `tutup`, atau `buka`. */
export async function simpanLowongan(
  client: Client,
  actor: OperatorUser,
  raw: unknown,
) {
  const draft = (raw ?? {}) as Baris;
  const aksi = teks(draft.aksi) ?? "simpan";
  const hariIni = await wibToday(client);
  const idMasuk = teks(draft.id_lowongan);
  const lama = idMasuk
    ? await satu(
        client,
        "SELECT l.*, (SELECT MIN(tanggal_lamaran) FROM hr_pelamar p WHERE p.id_lowongan = l.id_lowongan) AS lamaran_pertama FROM hr_lowongan l WHERE l.id_lowongan = ?1;",
        [idMasuk],
      )
    : null;
  if (idMasuk && !lama) throw takDitemukan("Lowongan");
  const status = lama ? statusDariBaris(lama, hariIni) : null;
  const id = lama ? String(lama.id_lowongan) : null;
  if (aksi === "tutup" || aksi === "buka") {
    if (!lama || !id) throw takDitemukan("Lowongan");
    if (aksi === "tutup") {
      if (status === "Ditutup") throw new Error("Lowongan sudah ditutup.");
      await client.execute({
        sql: TUTUP_LOWONGAN_SQL,
        args: [id, actor.username],
      });
      return { sukses: true as const, id_lowongan: id };
    }
    if (status !== "Ditutup")
      throw new Error("Lowongan ini tidak sedang ditutup.");
    const tutup = teks(draft.tanggal_tutup);
    if (
      tutup &&
      (!isValidDate(tutup) ||
        tutup < hariIni ||
        tutup < String(lama.tanggal_buka ?? ""))
    ) {
      throw new Error("Tanggal tutup baru harus hari ini atau sesudahnya.");
    }
    await client.execute({
      sql: BUKA_LOWONGAN_SQL,
      args: [id, tutup, actor.username],
    });
    return { sukses: true as const, id_lowongan: id };
  }
  if (aksi !== "simpan") throw new Error("Aksi lowongan tidak dikenal.");
  const hasil = validasiLowongan(draft);
  if (!hasil.ok) throw new Error(hasil.pesan);
  const sah = hasil.nilai;
  if (status === "Ditutup")
    throw new Error(
      "Lowongan sudah ditutup; buka lagi dulu untuk mengubahnya.",
    );
  const pertama = teks(lama?.lamaran_pertama);
  if (pertama && sah.tanggal_buka > pertama) {
    throw new Error(
      `Tanggal buka tidak boleh sesudah lamaran pertama (${pertama}).`,
    );
  }
  await periksaOrg(client, sah, lama);
  const idSimpan = id ?? newHexId("low-");
  await client.execute({
    sql: id ? UBAH_LOWONGAN_SQL : INSERT_LOWONGAN_SQL,
    args: [
      idSimpan,
      sah.judul,
      sah.id_jabatan,
      sah.id_divisi,
      sah.id_cabang,
      sah.jumlah,
      sah.tanggal_buka,
      sah.tanggal_tutup,
      sah.keterangan,
      actor.username,
    ],
  });
  return { sukses: true as const, id_lowongan: idSimpan };
}

/** Cermin `daftar_pelamar`. */
export async function daftarPelamar(db: Executor, idLowongan: string) {
  const semua = await daftarLowongan(db);
  const lowongan = semua.lowongan.find((l) => l.id_lowongan === idLowongan);
  if (!lowongan) throw takDitemukan("Lowongan");
  const pelamar = await objek(db, PELAMAR_LOWONGAN_SQL, [idLowongan]);
  const ganda = new Set(
    pelamarGanda(
      pelamar.map((p) => [
        String(p.id_pelamar ?? ""),
        String(p.nama ?? ""),
        teks(p.no_hp),
      ]),
    ),
  );
  return {
    lowongan,
    pelamar: pelamar.map((p) => ({
      ...p,
      mungkin_ganda: ganda.has(String(p.id_pelamar ?? "")),
    })),
    hari_ini: semua.hari_ini,
  };
}

/** Cermin `rincian_pelamar`. */
export async function rincianPelamar(db: Executor, idPelamar: string) {
  const pelamar = await satu(db, PELAMAR_SATU_SQL, [idPelamar]);
  if (!pelamar) throw takDitemukan("Pelamar");
  return {
    pelamar,
    tahap: await tahapPelamar(db, idPelamar),
    berkas: await objek(
      db,
      "SELECT id_berkas, urutan, nama_berkas, mime_type, length(data_base64) AS panjang, created_at FROM hr_pelamar_berkas WHERE id_pelamar = ?1 ORDER BY urutan;",
      [idPelamar],
    ),
  };
}

/** Cermin `simpan_pelamar`. */
export async function simpanPelamar(
  client: Client,
  actor: OperatorUser,
  raw: unknown,
) {
  const draft = (raw ?? {}) as Baris;
  const idLowongan = teks(draft.id_lowongan);
  if (!idLowongan) throw new Error("Lowongan wajib dipilih.");
  const hariIni = await wibToday(client);
  const lowongan = await satu(
    client,
    "SELECT tanggal_buka FROM hr_lowongan WHERE id_lowongan = ?1;",
    [idLowongan],
  );
  if (!lowongan) throw takDitemukan("Lowongan");
  const hasil = validasiPelamar(
    draft,
    String(lowongan.tanggal_buka ?? ""),
    hariIni,
  );
  if (!hasil.ok) throw new Error(hasil.pesan);
  const sah = hasil.nilai;
  const isi = [
    sah.nama,
    sah.no_hp,
    sah.email,
    sah.lp,
    sah.tanggal_lahir,
    sah.alamat,
    sah.pendidikan,
    sah.sumber,
    sah.tanggal_lamaran,
    sah.catatan,
  ];
  if (sah.id_pelamar) {
    const lama = await satu(
      client,
      "SELECT id_lowongan, id_karyawan, (SELECT MIN(t.tanggal) FROM hr_pelamar_tahap t WHERE t.id_pelamar = p.id_pelamar AND t.urutan > 1 AND t.dibatalkan_pada IS NULL) AS tahap_pertama FROM hr_pelamar p WHERE p.id_pelamar = ?1;",
      [sah.id_pelamar],
    );
    if (!lama) throw takDitemukan("Pelamar");
    if (teks(lama.id_karyawan)) throw new Error(PESAN_SUDAH_KARYAWAN);
    if (teks(lama.id_lowongan) !== sah.id_lowongan) {
      throw new Error(
        "Lowongan pelamar tidak bisa dipindah; hapus lalu catat ulang di lowongan yang benar.",
      );
    }
    const tahapPertama = teks(lama.tahap_pertama);
    if (tahapPertama && tahapPertama < sah.tanggal_lamaran) {
      throw new Error(
        "Tanggal lamaran tidak boleh sesudah tahap yang sudah dicatat.",
      );
    }
    await client.execute({
      sql: UBAH_PELAMAR_SQL,
      args: [sah.id_pelamar, ...isi, actor.username],
    });
    return { sukses: true as const, id_pelamar: sah.id_pelamar };
  }
  const id = newHexId("plm-");
  await client.batch(
    [
      {
        sql: INSERT_PELAMAR_SQL,
        args: [id, sah.id_lowongan, ...isi, actor.username],
      },
      {
        sql: INSERT_TAHAP_SQL,
        args: [id, 1, "Lamaran", sah.tanggal_lamaran, null, actor.username],
      },
    ],
    "write",
  );
  return { sukses: true as const, id_pelamar: id };
}

/** Cermin `catat_tahap`: `catat` atau `batal`, lalu status dibaca ulang. */
export async function catatTahap(
  client: Client,
  actor: OperatorUser,
  raw: unknown,
) {
  const draft = (raw ?? {}) as Baris;
  const idPelamar = teks(draft.id_pelamar);
  if (!idPelamar) throw takDitemukan("Pelamar");
  const hariIni = await wibToday(client);
  const pelamar = await satu(
    client,
    "SELECT tanggal_lamaran, id_karyawan FROM hr_pelamar WHERE id_pelamar = ?1;",
    [idPelamar],
  );
  if (!pelamar) throw takDitemukan("Pelamar");
  const sudahKaryawan = teks(pelamar.id_karyawan) !== null;
  const tahap = ringkasTahap(await tahapPelamar(client, idPelamar));
  const aksi = teks(draft.aksi) ?? "catat";
  if (aksi === "catat") {
    if (sudahKaryawan) throw new Error(PESAN_SUDAH_KARYAWAN);
    const status = statusPelamar(tahap);
    if (!status) throw new Error("Pelamar belum punya tahap.");
    const sah = periksaTahap(
      draft,
      status.tahap,
      String(pelamar.tanggal_lamaran ?? ""),
      hariIni,
    );
    if (!sah.ok) throw new Error(sah.pesan);
    const urutan = Math.max(0, ...tahap.map((t) => t.urutan)) + 1;
    try {
      await client.execute({
        sql: INSERT_TAHAP_SQL,
        args: [
          idPelamar,
          urutan,
          sah.nilai.tahap,
          sah.nilai.tanggal,
          sah.nilai.catatan,
          actor.username,
        ],
      });
    } catch (error) {
      if (String(error).includes("UNIQUE constraint failed")) {
        throw new Error(
          "Tahap pelamar ini baru saja diubah orang lain. Muat ulang lalu coba lagi.",
        );
      }
      throw error;
    }
  } else if (aksi === "batal") {
    const sah = periksaBatalTahap(tahap, sudahKaryawan, draft);
    if (!sah.ok) throw new Error(sah.pesan);
    const [urutan, alasan] = sah.nilai;
    await client.execute({
      sql: BATAL_TAHAP_SQL,
      args: [idPelamar, urutan, actor.username, alasan],
    });
  } else {
    throw new Error("Aksi tahap tidak dikenal.");
  }
  const sekarang = statusPelamar(
    ringkasTahap(await tahapPelamar(client, idPelamar)),
  );
  return { sukses: true as const, status: sekarang?.tahap ?? null };
}

/** Cermin `berkas_pelamar`. */
export async function berkasPelamar(db: Executor, idBerkas: string) {
  const b = await satu(
    db,
    "SELECT id_berkas, nama_berkas, mime_type, data_base64 FROM hr_pelamar_berkas WHERE id_berkas = ?1;",
    [idBerkas],
  );
  if (!b) throw takDitemukan("Berkas");
  return b;
}

/** Cermin `simpan_berkas`: `tambah` (maks 3) atau `hapus`. */
export async function simpanBerkas(client: Client, raw: unknown) {
  const draft = (raw ?? {}) as Baris;
  const aksi = teks(draft.aksi) ?? "tambah";
  if (aksi === "tambah") {
    const idPelamar = teks(draft.id_pelamar);
    if (!idPelamar) throw takDitemukan("Pelamar");
    const mime = teks(draft.mime_type) ?? "";
    const data = typeof draft.data_base64 === "string" ? draft.data_base64 : "";
    const galat = validasiBerkas(mime, data);
    if (galat) throw new Error(galat);
    const namaBerkas = teks(draft.nama_berkas);
    if (namaBerkas && [...namaBerkas].length > MAKS_TEKS)
      throw new Error(`Nama berkas maksimal ${MAKS_TEKS} karakter.`);
    const pelamar = await satu(
      client,
      "SELECT id_karyawan FROM hr_pelamar WHERE id_pelamar = ?1;",
      [idPelamar],
    );
    if (!pelamar) throw takDitemukan("Pelamar");
    if (teks(pelamar.id_karyawan)) throw new Error(PESAN_SUDAH_KARYAWAN);
    const terpakai = new Set(
      (
        await objek(
          client,
          "SELECT urutan FROM hr_pelamar_berkas WHERE id_pelamar = ?1;",
          [idPelamar],
        )
      ).map((b) => angka(b.urutan)),
    );
    const urutan = Array.from(
      { length: MAKS_BERKAS_PER_PELAMAR },
      (_, i) => i + 1,
    ).find((u) => !terpakai.has(u));
    if (!urutan)
      throw new Error(
        `Satu pelamar maksimal ${MAKS_BERKAS_PER_PELAMAR} berkas.`,
      );
    const id = newHexId("pb-");
    await client.execute({
      sql: INSERT_BERKAS_SQL,
      args: [id, idPelamar, urutan, namaBerkas, mime, data],
    });
    return { sukses: true as const, id_berkas: id };
  }
  if (aksi === "hapus") {
    const idBerkas = teks(draft.id_berkas);
    if (!idBerkas) throw takDitemukan("Berkas");
    const b = await satu(
      client,
      "SELECT p.id_karyawan FROM hr_pelamar_berkas b JOIN hr_pelamar p ON p.id_pelamar = b.id_pelamar WHERE b.id_berkas = ?1;",
      [idBerkas],
    );
    if (!b) throw takDitemukan("Berkas");
    if (teks(b.id_karyawan)) throw new Error(PESAN_SUDAH_KARYAWAN);
    await client.execute({ sql: HAPUS_BERKAS_SQL, args: [idBerkas] });
    return { sukses: true as const };
  }
  throw new Error("Aksi berkas tidak dikenal.");
}

/** Cermin `hapus_pelamar` (`hr.recruit.delete`). */
export async function hapusPelamar(client: Client, idPelamar: string) {
  const pelamar = await satu(
    client,
    "SELECT id_karyawan FROM hr_pelamar WHERE id_pelamar = ?1;",
    [idPelamar],
  );
  if (!pelamar) throw takDitemukan("Pelamar");
  if (teks(pelamar.id_karyawan))
    throw new Error(
      "Pelamar yang sudah dijadikan karyawan tidak bisa dihapus.",
    );
  await client.batch(
    HAPUS_PELAMAR_LAMA_SQL.map((sql) => ({ sql, args: [idPelamar] })),
    "write",
  );
  return { sukses: true as const };
}

/** Cermin `bersihkan_pelamar`: retensi berjam database, hasil hanya hitungan. */
export async function bersihkanPelamar(client: Client) {
  const [b] = await objek(
    client,
    `SELECT COUNT(*) AS n FROM hr_pelamar p WHERE ${PELAMAR_DIHAPUS_SQL};`,
    [null],
  );
  const n = angka(b?.n);
  if (n > 0) {
    await client.batch(
      HAPUS_PELAMAR_LAMA_SQL.map((sql) => ({ sql, args: [null] })),
      "write",
    );
  }
  return { dihapus: n };
}

/** Cermin `periksa_izin_jadikan`: penjaga kedua di samping rute (Q-100). */
function periksaIzinJadikan(actor: OperatorUser) {
  const lengkap = IZIN_JADIKAN_KARYAWAN.every((izin) =>
    actor.permissions.includes(izin),
  );
  if (!actor.isSuperadmin && !lengkap)
    throw new Error("Akses ditolak untuk tindakan ini.");
}

/**
 * Cermin `jadikan_karyawan`, tetapi atomik penuh: klaim pelamar, isian awal
 * profil, karyawan, organisasi, dan kontrak pertama dalam SATU transaksi
 * cloud. Klaim yang sudah milik id ini (dibuat Desktop yang tertutup di
 * tengah) diselesaikan di sini selama karyawannya belum ada di cloud.
 */
export async function jadikanKaryawan(
  client: Client,
  actor: OperatorUser,
  raw: unknown,
) {
  periksaIzinJadikan(actor);
  const draft = (raw ?? {}) as Baris;
  const idPelamar = teks(draft.id_pelamar);
  if (!idPelamar) throw takDitemukan("Pelamar");
  const id = idDariPelamar(idPelamar);
  if (!id.ok) throw new Error(id.pesan);
  const isianKaryawan = draft.karyawan;
  if (!isianKaryawan || typeof isianKaryawan !== "object")
    throw new Error("Data karyawan wajib diisi.");
  const karyawan: Baris = {
    ...(isianKaryawan as Baris),
    id_unik: id.nilai.id_unik,
    kode_karyawan:
      teks((isianKaryawan as Baris).kode_karyawan) ?? id.nilai.kode_karyawan,
  };
  const isianKontrak = draft.kontrak;
  if (!isianKontrak || typeof isianKontrak !== "object")
    throw new Error("Kontrak pertama wajib diisi.");
  const kontrak = validasiKontrak({
    ...(isianKontrak as Baris),
    id_karyawan: id.nilai.id_unik,
  });
  if (!kontrak.ok) throw new Error(kontrak.pesan);
  // Cermin `periksa_draft_karyawan`.
  if (
    !teks(karyawan.nama) ||
    String(karyawan.nama).trim().length < 2 ||
    !angka(karyawan.id_shift)
  ) {
    throw new Error("Data karyawan belum lengkap atau tidak valid.");
  }

  return withTransaction(client, async (tx) => {
    const pelamar = await satu(tx, PELAMAR_SATU_SQL, [idPelamar]);
    if (!pelamar) throw takDitemukan("Pelamar");
    const klaim = teks(pelamar.id_karyawan);
    const sudahAda =
      (await satu(tx, "SELECT 1 AS ada FROM master_data WHERE id_unik = ?1;", [
        id.nilai.id_unik,
      ])) !== null;
    let lanjutan = false;
    if (klaim === null) {
      if (pelamar.status !== "Diterima")
        throw new Error(
          "Hanya pelamar berstatus Diterima yang bisa dijadikan karyawan.",
        );
      if (sudahAda)
        throw new Error("Data karyawan untuk pelamar ini sudah ada.");
      const kode = String(karyawan.kode_karyawan);
      if (
        await satu(
          tx,
          "SELECT 1 AS ada FROM master_data WHERE kode_karyawan = ?1;",
          [kode],
        )
      ) {
        throw new Error(`Kode karyawan ${kode} sudah dipakai karyawan lain.`);
      }
      const menang = await tx.execute({
        sql: KLAIM_PELAMAR_SQL[0],
        args: [idPelamar, id.nilai.id_unik, actor.username],
      });
      if (menang.rowsAffected === 0)
        throw new Error("Pelamar ini sudah dijadikan karyawan.");
    } else if (klaim === id.nilai.id_unik) {
      lanjutan = true;
    } else {
      throw new Error("Pelamar ini sudah dijadikan karyawan.");
    }
    await tx.execute({
      sql: KLAIM_PELAMAR_SQL[1],
      args: [idPelamar, id.nilai.id_unik, actor.username],
    });
    if (lanjutan && sudahAda) {
      return {
        sukses: true as const,
        id_unik: id.nilai.id_unik,
        sudah_ada: "cloud" as const,
      };
    }
    const { statements, tokenAbsensi } = await susunTambahKaryawan(
      tx,
      karyawan as unknown as KaryawanInput,
    );
    const v = kontrak.nilai;
    const semua: InStatement[] = [
      ...statements,
      {
        sql: INSERT_KONTRAK_SQL,
        args: [
          id.nilai.id_kontrak,
          v.id_karyawan,
          v.jenis,
          null,
          v.nomor,
          v.tanggal_mulai,
          v.tanggal_selesai,
          v.percobaan_selesai,
          v.catatan,
          actor.username,
          null,
        ],
      },
      { sql: JENIS_DARI_KONTRAK_SQL, args: [v.id_karyawan] },
    ];
    for (const statement of semua) await tx.execute(statement);
    return {
      sukses: true as const,
      id_unik: id.nilai.id_unik,
      token_absensi: tokenAbsensi,
      id_kontrak: id.nilai.id_kontrak,
      lanjutan,
    };
  });
}
