import "server-only";

import type { Client, InStatement } from "@libsql/client";
import { z } from "zod";
import { ApiRequestError } from "@/lib/server/http/api-response";
import { type Laporan, penugasan } from "@/lib/validations/driver";
import {
  KUNCI_PERIODE,
  pengaturanKinerjaDariPeta,
} from "@/lib/validations/hr-kinerja";
import { PERHATIAN_REKRUTMEN_SQL } from "@/lib/validations/hr-rekrutmen";
import {
  AWALAN_BUKA,
  AWALAN_BUKA_PIMPINAN,
  type BarisStokMenipis,
  BIDANG_KEJADIAN,
  type BidangTelegram,
  diparkir,
  galatTelegram,
  grupDariUpdates,
  type IsiLaporanPerjalanan,
  type IsiPengajuanHr,
  type IzinPerhatian,
  idGajiStatus,
  idHrAjuan,
  idHrDokumen,
  idHrKinerjaPeriode,
  idHrKinerjaTunggu,
  idHrKontrak,
  idHrLowongan,
  idHrMenunggu,
  idHrPelamar,
  idHrPercobaan,
  idHrPutus,
  idHrSp,
  idHrUltah,
  idHrUrgent,
  idKasbonBaru,
  idPengajuanBaru,
  idPengajuanPutus,
  idStokMenipis,
  idTripGantiIzin,
  idTripKendala,
  idTripLokasiPalsu,
  idTutupBuku,
  JAM_RINGKASAN_STOK,
  type KaryawanPeriode,
  type KejadianTelegram,
  KUNCI_AKTIF,
  KUNCI_AKTIF_SEJAK,
  KUNCI_TOKEN,
  klaimSetelahGagal,
  kunciGrup,
  kunciKirim,
  LABEL_BIDANG,
  normalisasiChatId,
  PERHATIAN_SQL_DOKUMEN,
  PERHATIAN_SQL_KONTRAK,
  PERHATIAN_SQL_SP,
  PERHATIAN_SQL_ULTAH,
  type PenilaianTunggu,
  type PerhatianHr,
  periodeKinerjaBerakhir,
  permintaanKirim,
  pesanBukaBuku,
  pesanGajiStatus,
  pesanHrDokumenKedaluwarsa,
  pesanHrKinerjaMenunggu,
  pesanHrKinerjaPeriode,
  pesanHrKontrakAkhir,
  pesanHrLowonganTutup,
  pesanHrPelamarBaru,
  pesanHrPengajuanBaru,
  pesanHrPengajuanDiputus,
  pesanHrPengajuanMenunggu,
  pesanHrPercobaanAkhir,
  pesanHrSpBerakhir,
  pesanHrUlangTahunKerja,
  pesanHrUrgentBelumDiketahui,
  pesanKasbonBaru,
  pesanPengajuanBaru,
  pesanPengajuanPutus,
  pesanStokMenipis,
  pesanTripGantiIzin,
  pesanTripKendala,
  pesanTripLokasiPalsu,
  pesanTripTutup,
  pesanTutupBuku,
  potong,
  ringkasKinerjaMenunggu,
  ringkasKinerjaPeriode,
  samarkanToken,
  statusSetelahGagal,
  TELEGRAM_BATCH,
  TELEGRAM_BIDANG,
  TELEGRAM_DRAIN_BATAL_SQL,
  TELEGRAM_DRAIN_GAGAL_SQL,
  TELEGRAM_DRAIN_KLAIM_SQL,
  TELEGRAM_DRAIN_PILIH_SQL,
  TELEGRAM_INSERT_ANTREAN_PARKIR_SQL,
  TELEGRAM_INSERT_ANTREAN_SQL,
  TELEGRAM_KEJADIAN,
  TELEGRAM_RIWAYAT,
  TELEGRAM_SQL_BUKA_BUKU,
  TELEGRAM_SQL_GAJI_STATUS,
  TELEGRAM_SQL_HR_DOKUMEN,
  TELEGRAM_SQL_HR_KINERJA_JENIS,
  TELEGRAM_SQL_HR_KINERJA_MENUNGGU,
  TELEGRAM_SQL_HR_KINERJA_PERIODE,
  TELEGRAM_SQL_HR_KONTRAK,
  TELEGRAM_SQL_HR_LOWONGAN_TUTUP,
  TELEGRAM_SQL_HR_MENUNGGU,
  TELEGRAM_SQL_HR_PELAMAR_BARU,
  TELEGRAM_SQL_HR_PENGAJUAN_BARU,
  TELEGRAM_SQL_HR_PENGAJUAN_PUTUS,
  TELEGRAM_SQL_HR_PERCOBAAN,
  TELEGRAM_SQL_HR_SP,
  TELEGRAM_SQL_HR_ULTAH,
  TELEGRAM_SQL_HR_URGENT,
  TELEGRAM_SQL_JAM_WIB,
  TELEGRAM_SQL_KASBON_BARU,
  TELEGRAM_SQL_LABEL_KENDARAAN,
  TELEGRAM_SQL_NAMA_PERSONIL,
  TELEGRAM_SQL_PENGAJUAN_BARU,
  TELEGRAM_SQL_PENGAJUAN_PUTUS,
  TELEGRAM_SQL_STOK_MENIPIS,
  TELEGRAM_SQL_TRIP_GANTI_IZIN,
  TELEGRAM_SQL_TRIP_KENDALA,
  TELEGRAM_SQL_TRIP_LAPORAN,
  TELEGRAM_SQL_TRIP_LOKASI_PALSU,
  TELEGRAM_SQL_TRIP_TUTUP,
  TELEGRAM_SQL_TUTUP_BUKU,
  TELEGRAM_UPSERT_SETTING_SQL,
  type TelegramConfig,
  type TelegramConfigDraft,
  type TelegramDrainResult,
  TRIP_TUTUP,
  tokenBotValid,
} from "@/lib/validations/telegram";

/**
 * Notifikasi grup Telegram dari Web. Kembar `desktop/telegram.rs`: alurnya,
 * SQL-nya, dan isi pesannya harus sama, karena Web dan perangkat menguras
 * antrean yang sama.
 */

const TELEGRAM_TIMEOUT_MS = 15_000;
const TELEGRAM_JEDA_MS = 1_000;

const chatIdSchema = z.string().max(40);

/** Cermin `baca_draft`: kunci asing atau yang hilang ditolak. */
export const telegramDraftSchema = z
  .object({
    aktif: z.boolean(),
    botToken: z.string().max(100),
    grup: z
      .object({
        inventaris: chatIdSchema,
        keuangan: chatIdSchema,
        pimpinan: chatIdSchema,
        armada: chatIdSchema,
        hrd: chatIdSchema,
      })
      .strict(),
    kirim: z
      .object({
        pengajuan_baru: z.boolean(),
        pengajuan_putus: z.boolean(),
        stok_menipis: z.boolean(),
        kasbon_baru: z.boolean(),
        tutup_buku: z.boolean(),
        gaji_status: z.boolean(),
        buka_buku_pimpinan: z.boolean(),
        trip_kendala: z.boolean(),
        trip_selesai: z.boolean(),
        trip_tidak_jalan: z.boolean(),
        trip_dibatalkan: z.boolean(),
        trip_ganti_izin: z.boolean(),
        trip_lokasi_palsu: z.boolean(),
        hr_kontrak_akhir: z.boolean(),
        hr_percobaan_akhir: z.boolean(),
        hr_dokumen_kedaluwarsa: z.boolean(),
        hr_sp_berakhir: z.boolean(),
        hr_pengajuan_menunggu: z.boolean(),
        hr_urgent_belum_diketahui: z.boolean(),
        hr_ulang_tahun_kerja: z.boolean(),
        hr_kinerja_menunggu: z.boolean(),
        hr_kinerja_periode: z.boolean(),
        hr_pelamar_baru: z.boolean(),
        hr_lowongan_tutup: z.boolean(),
        hr_pengajuan_baru: z.boolean(),
        hr_pengajuan_diputus: z.boolean(),
      })
      .strict(),
  })
  .strict();

export const telegramTestSchema = z
  .object({
    bidang: z.enum(TELEGRAM_BIDANG),
    chatId: chatIdSchema,
    botToken: z.string().max(100),
  })
  .strict();

function tidakValid(pesan: string): never {
  throw new ApiRequestError(pesan, 400);
}

export class Pengaturan {
  constructor(private readonly nilai: Map<string, string>) {}
  get(kunci: string) {
    return this.nilai.get(kunci) ?? "";
  }
  get aktif() {
    return this.get(KUNCI_AKTIF) === "1";
  }
  get token() {
    return this.get(KUNCI_TOKEN);
  }
  grup(bidang: BidangTelegram) {
    return this.get(kunciGrup(bidang));
  }
  kirim(kejadian: KejadianTelegram) {
    return this.get(kunciKirim(kejadian)) === "1";
  }
  /** Kejadian ini akan dikirim: sakelarnya menyala dan grupnya sudah diatur. */
  siap(kejadian: KejadianTelegram) {
    return this.kirim(kejadian) && this.grup(BIDANG_KEJADIAN[kejadian]) !== "";
  }
}

export async function bacaPengaturan(client: Client) {
  const hasil = await client.execute(
    "SELECT kunci, nilai FROM app_telegram_setting LIMIT 100;",
  );
  return new Pengaturan(
    new Map(
      hasil.rows.map((row) => [
        String(row.kunci ?? "").trim(),
        String(row.nilai ?? "").trim(),
      ]),
    ),
  );
}

function teks(nilai: unknown) {
  return nilai == null ? "" : String(nilai).trim();
}

async function kirimPesan(
  token: string,
  chatId: string,
  isi: string,
): Promise<string | null> {
  const permintaan = permintaanKirim(token, chatId, isi);
  try {
    const respons = await fetch(permintaan.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(permintaan.body),
      signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS),
    });
    const galat = galatTelegram(respons.status, await respons.text());
    return galat === null ? null : samarkanToken(galat, token);
  } catch (error) {
    const pesan = error instanceof Error ? error.message : String(error);
    return samarkanToken(`Telegram tidak dapat dihubungi: ${pesan}`, token);
  }
}

/** Token TIDAK pernah dikembalikan: hanya apakah ada dan 4 karakter terakhirnya. */
export async function getTelegramConfig(
  client: Client,
): Promise<TelegramConfig> {
  const pengaturan = await bacaPengaturan(client);
  const riwayat = await client.execute({
    sql: "SELECT id_notifikasi, kejadian, status, COALESCE(last_error, '') AS last_error, datetime(created_at, '+7 hours') AS dibuat, COALESCE(sent_at, '') AS sent_at FROM notifikasi_telegram ORDER BY created_at DESC, id_notifikasi DESC LIMIT ?;",
    args: [TELEGRAM_RIWAYAT],
  });
  return {
    aktif: pengaturan.aktif,
    tokenTersimpan: pengaturan.token !== "",
    tokenAkhir: Array.from(pengaturan.token).slice(-4).join(""),
    grup: Object.fromEntries(
      TELEGRAM_BIDANG.map((bidang) => [bidang, pengaturan.grup(bidang)]),
    ) as TelegramConfig["grup"],
    kirim: Object.fromEntries(
      TELEGRAM_KEJADIAN.map((kejadian) => [
        kejadian,
        pengaturan.kirim(kejadian),
      ]),
    ) as TelegramConfig["kirim"],
    riwayat: riwayat.rows.map((row) => ({
      id: teks(row.id_notifikasi),
      kejadian: teks(row.kejadian),
      status: teks(row.status),
      galat: teks(row.last_error),
      dibuat: teks(row.dibuat),
      terkirim: teks(row.sent_at),
    })),
  };
}

export async function saveTelegramConfig(
  client: Client,
  draft: TelegramConfigDraft,
): Promise<TelegramConfig> {
  const botToken = draft.botToken.trim();
  if (botToken !== "" && !tokenBotValid(botToken)) {
    tidakValid(
      "Token bot tidak valid. Salin utuh dari BotFather, contoh 123456789:AAH...",
    );
  }
  const grup = TELEGRAM_BIDANG.map((bidang) => {
    const id = normalisasiChatId(draft.grup[bidang]);
    if (id === null) {
      tidakValid(
        `Id grup ${LABEL_BIDANG[bidang]} tidak valid. Pakai tombol Cari grup.`,
      );
    }
    return [bidang, id] as const;
  });
  const lama = await bacaPengaturan(client);
  if (draft.aktif && botToken === "" && lama.token === "") {
    tidakValid(
      "Isi token bot lebih dulu sebelum mengaktifkan notifikasi Telegram.",
    );
  }
  const setting = (kunci: string, nilai: string): InStatement => ({
    sql: TELEGRAM_UPSERT_SETTING_SQL,
    args: [kunci, nilai],
  });
  const statements: InStatement[] = [
    setting(KUNCI_AKTIF, draft.aktif ? "1" : "0"),
  ];
  if (botToken !== "") statements.push(setting(KUNCI_TOKEN, botToken));
  // Kejadian sebelum Telegram dinyalakan tidak pernah dikirim.
  if (draft.aktif && (!lama.aktif || lama.get(KUNCI_AKTIF_SEJAK) === "")) {
    statements.push({
      sql: "INSERT INTO app_telegram_setting (kunci, nilai, updated_at) VALUES (?, datetime('now'), datetime('now')) ON CONFLICT(kunci) DO UPDATE SET nilai = excluded.nilai, updated_at = excluded.updated_at;",
      args: [KUNCI_AKTIF_SEJAK],
    });
  }
  for (const [bidang, id] of grup)
    statements.push(setting(kunciGrup(bidang), id));
  for (const kejadian of TELEGRAM_KEJADIAN) {
    statements.push(
      setting(kunciKirim(kejadian), draft.kirim[kejadian] ? "1" : "0"),
    );
  }
  await client.batch(statements, "write");
  return getTelegramConfig(client);
}

async function tokenDipakai(client: Client, dikirim: string) {
  const token = dikirim.trim();
  if (token !== "") {
    if (!tokenBotValid(token)) tidakValid("Token bot tidak valid.");
    return token;
  }
  const pengaturan = await bacaPengaturan(client);
  if (pengaturan.token === "") tidakValid("Isi token bot lebih dulu.");
  return pengaturan.token;
}

/** Grup yang terlihat bot dalam 24 jam terakhir (`getUpdates`). */
export async function findTelegramGroups(client: Client, botToken: string) {
  const token = await tokenDipakai(client, botToken);
  let respons: Response;
  try {
    respons = await fetch(`https://api.telegram.org/bot${token}/getUpdates`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS),
    });
  } catch (error) {
    const pesan = error instanceof Error ? error.message : String(error);
    throw new ApiRequestError(
      samarkanToken(`Telegram tidak dapat dihubungi: ${pesan}`, token),
      400,
    );
  }
  const badan = await respons.text();
  const galat = galatTelegram(respons.status, badan);
  if (galat !== null) {
    throw new ApiRequestError(samarkanToken(galat, token), 400);
  }
  return { grup: grupDariUpdates(JSON.parse(badan)) };
}

/** Kirim pesan uji langsung, tanpa antrean, supaya hasilnya terlihat seketika. */
export async function sendTelegramTest(
  client: Client,
  input: z.infer<typeof telegramTestSchema>,
) {
  const chatId = normalisasiChatId(input.chatId);
  if (!chatId) tidakValid("Id grup belum diisi atau tidak valid.");
  const token = await tokenDipakai(client, input.botToken);
  const galat = await kirimPesan(
    token,
    chatId,
    `Pesan uji notifikasi Telegram. Grup ini akan menerima notifikasi bidang ${LABEL_BIDANG[input.bidang]}.`,
  );
  if (galat !== null) throw new ApiRequestError(galat, 400);
  return { terkirim: true };
}

async function antrekan(
  client: Client,
  id: string,
  kejadian: KejadianTelegram,
  isi: string,
) {
  await client.execute({
    sql: TELEGRAM_INSERT_ANTREAN_SQL,
    args: [id, kejadian, isi],
  });
}

/** Cermin `antrekan_parkir`: kejadian HR masuk antrean diparkir (§23.2). */
async function antrekanParkir(
  client: Client,
  id: string,
  kejadian: KejadianTelegram,
  isi: string,
) {
  await client.execute({
    sql: TELEGRAM_INSERT_ANTREAN_PARKIR_SQL,
    args: [id, kejadian, isi],
  });
}

/** Cermin `catat_kejadian`. Idempoten: id deterministik. */
async function catatKejadian(client: Client, pengaturan: Pengaturan) {
  const sejak = pengaturan.get(KUNCI_AKTIF_SEJAK);
  if (sejak === "") return;
  if (pengaturan.siap("pengajuan_baru")) {
    const hasil = await client.execute({
      sql: TELEGRAM_SQL_PENGAJUAN_BARU,
      args: [sejak],
    });
    for (const row of hasil.rows) {
      await antrekan(
        client,
        idPengajuanBaru(teks(row.id_pengajuan)),
        "pengajuan_baru",
        pesanPengajuanBaru({
          nomor: teks(row.nomor),
          keperluan: teks(row.keperluan),
          total: Number(row.total ?? 0),
          jumlahBaris: Number(row.jumlah_baris ?? 0),
          pengaju: teks(row.pengaju),
          caraBayar: teks(row.cara_bayar),
        }),
      );
    }
  }
  if (pengaturan.siap("pengajuan_putus")) {
    const hasil = await client.execute({
      sql: TELEGRAM_SQL_PENGAJUAN_PUTUS,
      args: [sejak],
    });
    for (const row of hasil.rows) {
      await antrekan(
        client,
        idPengajuanPutus(teks(row.id_pengajuan)),
        "pengajuan_putus",
        pesanPengajuanPutus({
          nomor: teks(row.nomor),
          keperluan: teks(row.keperluan),
          total: Number(row.total ?? 0),
          disetujui: Number(row.disetujui) === 1,
          pemutus: teks(row.pemutus),
          catatan: teks(row.catatan),
        }),
      );
    }
  }
  if (pengaturan.siap("kasbon_baru")) {
    const hasil = await client.execute({
      sql: TELEGRAM_SQL_KASBON_BARU,
      args: [sejak],
    });
    for (const row of hasil.rows) {
      await antrekan(
        client,
        idKasbonBaru(teks(row.id_pinjaman)),
        "kasbon_baru",
        pesanKasbonBaru(
          Number(row.pokok ?? 0),
          Number(row.cicilan ?? 0),
          teks(row.mulai_potong),
        ),
      );
    }
  }
  if (pengaturan.siap("tutup_buku")) {
    const tutup = await client.execute({
      sql: TELEGRAM_SQL_TUTUP_BUKU,
      args: [sejak],
    });
    for (const row of tutup.rows) {
      await antrekan(
        client,
        idTutupBuku(teks(row.id_tutup)),
        "tutup_buku",
        pesanTutupBuku(
          teks(row.sampai_tanggal),
          teks(row.oleh),
          teks(row.status) === "Menunggu",
        ),
      );
    }
    await catatBukaBuku(client, sejak, AWALAN_BUKA, "tutup_buku");
  }
  if (pengaturan.siap("buka_buku_pimpinan")) {
    await catatBukaBuku(
      client,
      sejak,
      AWALAN_BUKA_PIMPINAN,
      "buka_buku_pimpinan",
    );
  }
  if (pengaturan.siap("gaji_status")) {
    const hasil = await client.execute({
      sql: TELEGRAM_SQL_GAJI_STATUS,
      args: [sejak],
    });
    for (const row of hasil.rows) {
      const isi = pesanGajiStatus({
        status: teks(row.new_status),
        periodeAwal: teks(row.period_start),
        periodeAkhir: teks(row.period_end),
        pegawai: Number(row.total_employees ?? 0),
        totalBersih: Number(row.total_net_payout ?? 0),
        oleh: teks(row.oleh),
        catatan: teks(row.notes),
      });
      if (isi !== null) {
        await antrekan(client, idGajiStatus(teks(row.id)), "gaji_status", isi);
      }
    }
  }
  await catatArmada(client, pengaturan, sejak);
  await catatPengajuanHr(client, pengaturan, sejak);
  await catatHarian(client, pengaturan);
}

type Baris = Record<string, unknown>;

/**
 * Cermin `tugas_sebelum`: driver dan kendaraan yang bertugas TEPAT SEBELUM
 * laporan `row`, menurut ganti yang berlaku saat itu.
 */
async function tugasSebelum(client: Client, row: Baris) {
  const semua = await client.execute({
    sql: TELEGRAM_SQL_TRIP_LAPORAN,
    args: [teks(row.id_perjalanan)],
  });
  const opsi = (nilai: unknown) => teks(nilai) || null;
  const sasaran = [teks(row.waktu_perangkat), teks(row.id_laporan)] as const;
  const laporan: Laporan[] = semua.rows
    .map((l) => ({
      id_laporan: teks(l.id_laporan),
      jenis: teks(l.jenis),
      mode_ganti: opsi(l.mode_ganti),
      id_ref: opsi(l.id_ref),
      waktu_perangkat: teks(l.waktu_perangkat),
      id_karyawan_baru: opsi(l.id_karyawan_baru),
      id_kendaraan_baru: opsi(l.id_kendaraan_baru),
    }))
    .filter(
      (l) =>
        l.waktu_perangkat < sasaran[0] ||
        (l.waktu_perangkat === sasaran[0] && l.id_laporan < sasaran[1]),
    );
  return penugasan(teks(row.awal_karyawan), teks(row.awal_kendaraan), laporan);
}

async function satuTeks(
  client: Client,
  sql: string,
  id: string,
  kolom: string,
) {
  if (id === "") return "";
  const hasil = await client.execute({ sql, args: [id] });
  return teks(hasil.rows[0]?.[kolom]);
}

/** Cermin `nama_personil`: nama, lalu `cadangan`, lalu id-nya. */
async function namaPersonil(client: Client, id: string, cadangan = "") {
  const nama = await satuTeks(client, TELEGRAM_SQL_NAMA_PERSONIL, id, "nama");
  return nama || cadangan || id || "-";
}

/** Cermin `label_kendaraan`. */
async function labelKendaraan(client: Client, id: string) {
  return (
    (await satuTeks(client, TELEGRAM_SQL_LABEL_KENDARAAN, id, "label")) || id
  );
}

/** Cermin `catat_armada`: kejadian perjalanan (v34) ke grup Armada. */
async function catatArmada(
  client: Client,
  pengaturan: Pengaturan,
  sejak: string,
) {
  const sumber: {
    kejadian: KejadianTelegram;
    sql: string;
    args: string[];
    awalan: string;
  }[] = [];
  if (pengaturan.siap("trip_kendala")) {
    sumber.push({
      kejadian: "trip_kendala",
      sql: TELEGRAM_SQL_TRIP_KENDALA,
      args: [sejak],
      awalan: "",
    });
  }
  for (const { jenis, kejadian, awalan } of TRIP_TUTUP) {
    if (pengaturan.siap(kejadian)) {
      sumber.push({
        kejadian,
        sql: TELEGRAM_SQL_TRIP_TUTUP,
        args: [sejak, jenis, awalan],
        awalan,
      });
    }
  }
  if (pengaturan.siap("trip_ganti_izin")) {
    sumber.push({
      kejadian: "trip_ganti_izin",
      sql: TELEGRAM_SQL_TRIP_GANTI_IZIN,
      args: [sejak],
      awalan: "",
    });
  }
  if (pengaturan.siap("trip_lokasi_palsu")) {
    sumber.push({
      kejadian: "trip_lokasi_palsu",
      sql: TELEGRAM_SQL_TRIP_LOKASI_PALSU,
      args: [sejak],
      awalan: "",
    });
  }

  for (const { kejadian, sql, args, awalan } of sumber) {
    const hasil = await client.execute({ sql, args });
    for (const row of hasil.rows) {
      const tugas = await tugasSebelum(client, row);
      const pelapor = teks(row.id_karyawan);
      const oleh = teks(row.oleh);
      const driver =
        pelapor === ""
          ? await namaPersonil(client, tugas.id_karyawan)
          : await namaPersonil(client, pelapor, oleh);
      const jenis = teks(row.jenis);
      const gantiDriver = jenis === "Ganti Driver";
      const isi: IsiLaporanPerjalanan = {
        nomor: teks(row.nomor),
        driver,
        kendaraan:
          kejadian === "trip_ganti_izin"
            ? ""
            : await labelKendaraan(client, tugas.id_kendaraan),
        tempat: teks(row.nama_lokasi),
        keterangan: teks(row.keterangan),
        waktu: teks(row.waktu_wib),
        telatMenit: Number(row.telat_menit ?? 0),
      };
      const idLaporan = teks(row.id_laporan);
      let id: string;
      let pesan: string | null;
      if (kejadian === "trip_kendala") {
        id = idTripKendala(idLaporan);
        pesan = pesanTripKendala({
          ...isi,
          jenisKendala: teks(row.jenis_kendala),
          terlambatMenit: Number(row.terlambat_menit ?? 0),
        });
      } else if (kejadian === "trip_ganti_izin") {
        const [dari, ke] = gantiDriver
          ? [
              await namaPersonil(client, tugas.id_karyawan),
              await namaPersonil(client, teks(row.id_karyawan_baru)),
            ]
          : [
              await labelKendaraan(client, tugas.id_kendaraan),
              await labelKendaraan(client, teks(row.id_kendaraan_baru)),
            ];
        id = idTripGantiIzin(idLaporan);
        pesan = pesanTripGantiIzin({
          ...isi,
          gantiDriver,
          darurat: teks(row.mode_ganti) === "Darurat",
          dari,
          ke,
        });
      } else if (kejadian === "trip_lokasi_palsu") {
        id = idTripLokasiPalsu(idLaporan);
        pesan = pesanTripLokasiPalsu({ ...isi, jenisLaporan: jenis });
      } else {
        id = `${awalan}${teks(row.id_perjalanan)}`;
        pesan = pesanTripTutup({
          ...isi,
          jenis,
          oleh: pelapor === "" ? oleh : "",
        });
      }
      if (pesan !== null) await antrekan(client, id, kejadian, pesan);
    }
  }
}

/** Cermin `catat_buka_buku`: awalan id menentukan grup tujuannya. */
async function catatBukaBuku(
  client: Client,
  sejak: string,
  awalan: string,
  kejadian: KejadianTelegram,
) {
  const buka = await client.execute({
    sql: TELEGRAM_SQL_BUKA_BUKU,
    args: [sejak, awalan],
  });
  for (const row of buka.rows) {
    await antrekan(
      client,
      `${awalan}${teks(row.id_tutup)}`,
      kejadian,
      pesanBukaBuku(
        teks(row.sampai_tanggal),
        teks(row.oleh),
        teks(row.alasan_buka),
      ),
    );
  }
}

async function belumTercatat(client: Client, id: string) {
  const sudah = await client.execute({
    sql: "SELECT 1 AS ada FROM notifikasi_telegram WHERE id_notifikasi = ? LIMIT 1;",
    args: [id],
  });
  return sudah.rows.length === 0;
}

/**
 * Cermin `catat_harian`: kejadian berbasis tanggal, mulai 07.00 WIB jam
 * database. Stok sekali per tanggal; pengingat HR lihat `catatHrd`.
 */
async function catatHarian(client: Client, pengaturan: Pengaturan) {
  if (
    !pengaturan.siap("stok_menipis") &&
    !TELEGRAM_KEJADIAN.some((k) => diparkir(k) && pengaturan.siap(k))
  ) {
    return;
  }
  const jam = (await client.execute(TELEGRAM_SQL_JAM_WIB)).rows[0];
  if (!jam) return;
  await catatHarianPada(
    client,
    pengaturan,
    teks(jam.tanggal),
    Number(jam.jam),
    Number(jam.jam_hr),
  );
}

/**
 * Cermin `catat_harian_pada`. `tanggal`/`jam`/`jamHr` dari
 * `TELEGRAM_SQL_JAM_WIB`; diekspor supaya batas jam bisa diuji tanpa
 * bergantung jam saat tes berjalan. Stok tetap mulai `JAM_RINGKASAN_STOK`,
 * pengingat HR mulai `hr_ingat_jam` (§24.3).
 */
export async function catatHarianPada(
  client: Client,
  pengaturan: Pengaturan,
  tanggal: string,
  jam: number,
  jamHr: number,
) {
  if (jam >= JAM_RINGKASAN_STOK && pengaturan.siap("stok_menipis")) {
    await catatStok(client, tanggal);
  }
  if (jam >= jamHr) await catatHrd(client, pengaturan, tanggal);
}

async function catatStok(client: Client, tanggal: string) {
  const idStok = idStokMenipis(tanggal);
  if (await belumTercatat(client, idStok)) {
    const daftar: BarisStokMenipis[] = (
      await client.execute(TELEGRAM_SQL_STOK_MENIPIS)
    ).rows.map((row) => ({
      kode: teks(row.kode_barang),
      nama: teks(row.nama_barang),
      satuan: teks(row.satuan),
      desimal: Number(row.desimal) === 1,
      stok: Number(row.stok_baik ?? 0),
      minimum: Number(row.stok_minimum ?? 0),
    }));
    const isi = pesanStokMenipis(daftar);
    if (isi !== null) await antrekan(client, idStok, "stok_menipis", isi);
  }
}

async function baris(client: Client, sql: string, args: string[] = []) {
  return (await client.execute({ sql, args })).rows;
}

/**
 * Cermin `catat_hrd`: pengingat HR ke grup HRD (§23.3). Pengingat per
 * karyawan memeriksa id-nya di SQL sumber (`NOT EXISTS`); tiga ringkasan
 * harian lewat `belumTercatat` seperti stok. Semua masuk antrean diparkir.
 */
async function catatHrd(
  client: Client,
  pengaturan: Pengaturan,
  tanggal: string,
) {
  if (pengaturan.siap("hr_kontrak_akhir")) {
    for (const row of await baris(client, TELEGRAM_SQL_HR_KONTRAK)) {
      const sisa = Number(row.sisa ?? 0);
      await antrekanParkir(
        client,
        idHrKontrak(teks(row.id_kontrak), sisa, Number(row.dekat ?? 0)),
        "hr_kontrak_akhir",
        pesanHrKontrakAkhir({
          nama: teks(row.nama),
          jabatan: teks(row.jabatan),
          tanggal: teks(row.tanggal_selesai),
          sisa,
        }),
      );
    }
  }
  if (pengaturan.siap("hr_percobaan_akhir")) {
    for (const row of await baris(client, TELEGRAM_SQL_HR_PERCOBAAN)) {
      await antrekanParkir(
        client,
        idHrPercobaan(teks(row.id_kontrak)),
        "hr_percobaan_akhir",
        pesanHrPercobaanAkhir({
          nama: teks(row.nama),
          jabatan: teks(row.jabatan),
          tanggal: teks(row.percobaan_selesai),
          sisa: Number(row.sisa ?? 0),
        }),
      );
    }
  }
  if (pengaturan.siap("hr_dokumen_kedaluwarsa")) {
    for (const row of await baris(client, TELEGRAM_SQL_HR_DOKUMEN)) {
      const tanggalKedaluwarsa = teks(row.tanggal_kedaluwarsa);
      await antrekanParkir(
        client,
        idHrDokumen(teks(row.id_dokumen), tanggalKedaluwarsa),
        "hr_dokumen_kedaluwarsa",
        pesanHrDokumenKedaluwarsa({
          jenisDokumen: teks(row.jenis_dokumen),
          nama: teks(row.nama),
          jabatan: teks(row.jabatan),
          tanggal: tanggalKedaluwarsa,
          sisa: Number(row.sisa ?? 0),
        }),
      );
    }
  }
  const sejak = pengaturan.get(KUNCI_AKTIF_SEJAK);
  if (pengaturan.siap("hr_sp_berakhir") && sejak !== "") {
    for (const row of await baris(client, TELEGRAM_SQL_HR_SP, [sejak])) {
      await antrekanParkir(
        client,
        idHrSp(teks(row.id_sp)),
        "hr_sp_berakhir",
        pesanHrSpBerakhir({
          tingkat: teks(row.tingkat),
          nama: teks(row.nama),
          jabatan: teks(row.jabatan),
          tanggal: teks(row.berlaku_sampai),
        }),
      );
    }
  }

  const idMenunggu = idHrMenunggu(tanggal);
  if (
    pengaturan.siap("hr_pengajuan_menunggu") &&
    (await belumTercatat(client, idMenunggu))
  ) {
    const rows = await baris(client, TELEGRAM_SQL_HR_MENUNGGU);
    const palingLama = rows
      .map((row) => teks(row.sejak))
      .reduce((a, b) => (a === "" || b < a ? b : a), "");
    const isi = pesanHrPengajuanMenunggu(
      rows.map((row) => ({
        kelompok: teks(row.kelompok),
        jumlah: Number(row.jumlah ?? 0),
      })),
      palingLama,
      Number(rows[0]?.hari ?? 0),
    );
    if (isi !== null) {
      await antrekanParkir(client, idMenunggu, "hr_pengajuan_menunggu", isi);
    }
  }
  const idUrgent = idHrUrgent(tanggal);
  if (
    pengaturan.siap("hr_urgent_belum_diketahui") &&
    (await belumTercatat(client, idUrgent))
  ) {
    const row = (await baris(client, TELEGRAM_SQL_HR_URGENT))[0];
    const isi = row
      ? pesanHrUrgentBelumDiketahui(Number(row.jumlah ?? 0), teks(row.sejak))
      : null;
    if (isi !== null) {
      await antrekanParkir(client, idUrgent, "hr_urgent_belum_diketahui", isi);
    }
  }
  const idUltah = idHrUltah(tanggal);
  if (
    pengaturan.siap("hr_ulang_tahun_kerja") &&
    (await belumTercatat(client, idUltah))
  ) {
    const isi = pesanHrUlangTahunKerja(
      (await baris(client, TELEGRAM_SQL_HR_ULTAH)).map((row) => ({
        nama: teks(row.nama),
        jabatan: teks(row.jabatan),
        tahun: Number(row.tahun ?? 0),
      })),
    );
    if (isi !== null) {
      await antrekanParkir(client, idUltah, "hr_ulang_tahun_kerja", isi);
    }
  }
  await catatKinerjaRekrutmen(client, pengaturan, tanggal);
}

/** Cermin `keputusan_json`: JSON rusak = tanpa isi. */
function jsonDaftar<T>(nilai: unknown): T[] {
  try {
    const hasil: unknown = JSON.parse(teks(nilai));
    return Array.isArray(hasil) ? (hasil as T[]) : [];
  } catch {
    return [];
  }
}

/** Cermin `ringkas_menunggu_cloud`: ringkasan "menunggu Final" dari cloud. */
async function ringkasMenungguCloud(client: Client) {
  const daftar: PenilaianTunggu[] = (
    await baris(client, TELEGRAM_SQL_HR_KINERJA_MENUNGGU)
  ).map((row) => ({
    sidik: teks(row.sidik),
    sejak: teks(row.sejak),
    keputusan: jsonDaftar(row.keputusan),
  }));
  return ringkasKinerjaMenunggu(daftar);
}

/** Cermin `jenis_periode_cloud`: kosong atau rusak = bawaan. */
async function jenisPeriodeCloud(client: Client) {
  const nilai = teks(
    (await baris(client, TELEGRAM_SQL_HR_KINERJA_JENIS))[0]?.value,
  );
  return pengaturanKinerjaDariPeta(new Map([[KUNCI_PERIODE, nilai]])).periode;
}

/** Cermin `ringkas_periode_cloud`: ringkasan satu periode dari cloud. */
async function ringkasPeriodeCloud(
  client: Client,
  jenis: string,
  mulai: string,
  selesai: string,
) {
  const daftar: KaryawanPeriode[] = (
    await baris(client, TELEGRAM_SQL_HR_KINERJA_PERIODE, [jenis, mulai])
  ).map((row) => ({
    tanggal_daftar: teks(row.tanggal_daftar) || null,
    tanggal_selesai_aktif: teks(row.tanggal_selesai_aktif) || null,
    penilaian: jsonDaftar(row.penilaian),
  }));
  return ringkasKinerjaPeriode(daftar, mulai, selesai);
}

/**
 * Cermin `catat_kinerja_rekrutmen`: kejadian kinerja dan rekrutmen berbasis
 * tanggal (§24.4). Kinerja hanya angka (Q-117), rekrutmen tanpa data pelamar
 * (Q-86). Ringkasan sekali per tanggal lewat `belumTercatat`, periode sekali
 * per `periode_mulai`, lowongan diperiksa di SQL sumber.
 */
async function catatKinerjaRekrutmen(
  client: Client,
  pengaturan: Pengaturan,
  tanggal: string,
) {
  const idTunggu = idHrKinerjaTunggu(tanggal);
  if (
    pengaturan.siap("hr_kinerja_menunggu") &&
    (await belumTercatat(client, idTunggu))
  ) {
    const { jumlah, sejak } = await ringkasMenungguCloud(client);
    const isi = pesanHrKinerjaMenunggu(jumlah, sejak);
    if (isi !== null) {
      await antrekanParkir(client, idTunggu, "hr_kinerja_menunggu", isi);
    }
  }
  if (pengaturan.siap("hr_kinerja_periode")) {
    const jenis = await jenisPeriodeCloud(client);
    const periode = periodeKinerjaBerakhir(jenis, tanggal);
    if (periode) {
      const [mulai, selesai] = periode;
      const idPeriode = idHrKinerjaPeriode(mulai);
      if (await belumTercatat(client, idPeriode)) {
        const isi = pesanHrKinerjaPeriode(
          jenis,
          mulai,
          selesai,
          await ringkasPeriodeCloud(client, jenis, mulai, selesai),
        );
        if (isi !== null) {
          await antrekanParkir(client, idPeriode, "hr_kinerja_periode", isi);
        }
      }
    }
  }
  const idPelamar = idHrPelamar(tanggal);
  if (
    pengaturan.siap("hr_pelamar_baru") &&
    (await belumTercatat(client, idPelamar))
  ) {
    const isi = pesanHrPelamarBaru(
      (await baris(client, TELEGRAM_SQL_HR_PELAMAR_BARU, [tanggal])).map(
        (row) => ({ judul: teks(row.judul), jumlah: Number(row.jumlah ?? 0) }),
      ),
    );
    if (isi !== null) {
      await antrekanParkir(client, idPelamar, "hr_pelamar_baru", isi);
    }
  }
  if (pengaturan.siap("hr_lowongan_tutup")) {
    for (const row of await baris(client, TELEGRAM_SQL_HR_LOWONGAN_TUTUP)) {
      const tutup = teks(row.tanggal_tutup);
      await antrekanParkir(
        client,
        idHrLowongan(teks(row.id_lowongan), tutup),
        "hr_lowongan_tutup",
        pesanHrLowonganTutup({
          judul: teks(row.judul),
          tanggal: tutup,
          sisa: Number(row.sisa ?? 0),
          pelamar: Number(row.pelamar ?? 0),
          kuota: Number(row.kuota ?? 0),
        }),
      );
    }
  }
}

function isiPengajuanHr(row: Record<string, unknown>): IsiPengajuanHr {
  return {
    kelompok: teks(row.kelompok),
    nama: teks(row.nama),
    jabatan: teks(row.jabatan),
    mulai: teks(row.tanggal_mulai),
    selesai: teks(row.tanggal_selesai),
  };
}

/**
 * Cermin `catat_pengajuan_hr`: kejadian per pengajuan HR ke grup HRD
 * (§24.4, Q-120, Q-121), diparkir. `sejak` = `aktif_sejak`; batas 7 hari jam
 * cloud dan id-nya diperiksa di SQL sumber. Diekspor untuk tes.
 */
export async function catatPengajuanHr(
  client: Client,
  pengaturan: Pengaturan,
  sejak: string,
) {
  if (pengaturan.siap("hr_pengajuan_baru")) {
    for (const row of await baris(client, TELEGRAM_SQL_HR_PENGAJUAN_BARU, [
      sejak,
    ])) {
      await antrekanParkir(
        client,
        idHrAjuan(teks(row.id_pengajuan)),
        "hr_pengajuan_baru",
        pesanHrPengajuanBaru(isiPengajuanHr(row)),
      );
    }
  }
  if (pengaturan.siap("hr_pengajuan_diputus")) {
    for (const row of await baris(client, TELEGRAM_SQL_HR_PENGAJUAN_PUTUS, [
      sejak,
    ])) {
      await antrekanParkir(
        client,
        idHrPutus(teks(row.id_keputusan)),
        "hr_pengajuan_diputus",
        pesanHrPengajuanDiputus(
          isiPengajuanHr(row),
          teks(row.jenis),
          teks(row.oleh),
        ),
      );
    }
  }
}

function hasil(
  sukses: boolean,
  [diproses, terkirim, gagal, dibatalkan]: [number, number, number, number],
  pesan: string,
): TelegramDrainResult {
  return { sukses, diproses, terkirim, gagal, dibatalkan, pesan };
}

/**
 * Cermin `telegram::drain`: catat kejadian baru, lalu kirim antrean
 * `Menunggu`. Setiap baris diklaim atomik seperti antrean WA, jadi Web dan
 * perangkat aman berjalan bersamaan.
 */
export async function drainTelegram(
  client: Client,
  pengirim = "web",
  { jedaMs = TELEGRAM_JEDA_MS }: { jedaMs?: number } = {},
): Promise<TelegramDrainResult> {
  const pengaturan = await bacaPengaturan(client);
  if (!pengaturan.aktif || pengaturan.token === "") {
    return hasil(true, [0, 0, 0, 0], "Notifikasi Telegram belum aktif.");
  }
  const token = pengaturan.token;

  await client.execute(
    "DELETE FROM notifikasi_telegram WHERE status <> 'Menunggu' AND created_at < datetime('now', '-30 days');",
  );
  await catatKejadian(client, pengaturan);

  const antrean = await client.execute({
    sql: TELEGRAM_DRAIN_PILIH_SQL,
    args: [TELEGRAM_BATCH],
  });

  let terkirim = 0;
  let gagal = 0;
  let dibatalkan = 0;
  for (const row of antrean.rows) {
    const id = teks(row.id_notifikasi);
    const kejadian = teks(row.kejadian) as KejadianTelegram;
    const bidang = BIDANG_KEJADIAN[kejadian];
    const chatId =
      bidang && pengaturan.kirim(kejadian) ? pengaturan.grup(bidang) : "";
    if (chatId === "") {
      const batal = await client.execute({
        sql: TELEGRAM_DRAIN_BATAL_SQL,
        args: ["Kejadian dimatikan atau grupnya belum diatur.", id],
      });
      if (batal.rowsAffected > 0) dibatalkan++;
      continue;
    }

    const klaim = await client.execute({
      sql: TELEGRAM_DRAIN_KLAIM_SQL,
      args: [pengirim, id],
    });
    if (klaim.rowsAffected === 0) continue;

    const galat = await kirimPesan(token, chatId, teks(row.isi_pesan));
    if (galat === null) {
      await client.execute({
        sql: "UPDATE notifikasi_telegram SET status = 'Terkirim', sent_at = datetime('now', '+7 hours'), last_error = NULL, klaim_oleh = NULL, klaim_sampai = NULL WHERE id_notifikasi = ? AND klaim_oleh = ?;",
        args: [id, pengirim],
      });
      terkirim++;
    } else {
      const { status, percobaan } = statusSetelahGagal(
        Number(row.attempt_count ?? 0),
      );
      const { klaimOleh, klaimSampai } = klaimSetelahGagal(kejadian, status);
      await client.execute({
        sql: TELEGRAM_DRAIN_GAGAL_SQL,
        args: [
          status,
          percobaan,
          potong(galat, 500),
          klaimOleh,
          klaimSampai,
          id,
          pengirim,
        ],
      });
      gagal++;
    }
    if (jedaMs > 0) await new Promise((r) => setTimeout(r, jedaMs));
  }

  return hasil(
    true,
    [antrean.rows.length, terkirim, gagal, dibatalkan],
    `${terkirim} terkirim, ${gagal} gagal, ${dibatalkan} dibatalkan.`,
  );
}

/** Cermin `objek_kolom`: baris → objek berisi kolom teks dan angka saja. */
function objekKolom<T>(
  rows: Record<string, unknown>[],
  kolomTeks: readonly string[],
  kolomAngka: readonly string[],
): T[] {
  return rows.map((row) => {
    const objek: Record<string, string | number> = {};
    for (const kunci of kolomTeks) objek[kunci] = teks(row[kunci]);
    for (const kunci of kolomAngka) objek[kunci] = Number(row[kunci] ?? 0);
    return objek as T;
  });
}

type BagianPerhatian<K extends keyof PerhatianHr> = NonNullable<PerhatianHr[K]>;

/**
 * Cermin `telegram::perhatian`: isi kartu "Perlu perhatian" dari cloud
 * (Q-102). Bagian tanpa izin tidak dibaca sama sekali dan kuncinya tidak ada.
 */
export async function perhatianHr(
  client: Client,
  izin: IzinPerhatian,
): Promise<PerhatianHr> {
  const jam = (await client.execute(TELEGRAM_SQL_JAM_WIB)).rows[0];
  return perhatianHrPada(client, izin, teks(jam?.tanggal));
}

/**
 * Cermin `perhatian_pada`. `tanggal` = tanggal WIB jam database; diekspor
 * supaya jendela periode kinerja bisa diuji tanpa bergantung tanggal tes.
 */
export async function perhatianHrPada(
  client: Client,
  izin: IzinPerhatian,
  tanggal: string,
): Promise<PerhatianHr> {
  const hasil: PerhatianHr = {};
  if (izin.kontrak) {
    hasil.kontrak = objekKolom<BagianPerhatian<"kontrak">[number]>(
      await baris(client, PERHATIAN_SQL_KONTRAK),
      ["jenis", "id_karyawan", "nama", "jabatan", "tanggal"],
      ["sisa"],
    );
    hasil.ulang_tahun = objekKolom<BagianPerhatian<"ulang_tahun">[number]>(
      await baris(client, PERHATIAN_SQL_ULTAH),
      ["id_karyawan", "nama", "jabatan", "tanggal"],
      ["tahun"],
    );
  }
  if (izin.dokumen) {
    hasil.dokumen = objekKolom<BagianPerhatian<"dokumen">[number]>(
      await baris(client, PERHATIAN_SQL_DOKUMEN),
      ["id_karyawan", "nama", "jabatan", "jenis_dokumen", "tanggal"],
      ["sisa"],
    );
  }
  if (izin.sp) {
    hasil.sp = objekKolom<BagianPerhatian<"sp">[number]>(
      await baris(client, PERHATIAN_SQL_SP),
      ["id_karyawan", "nama", "jabatan", "tingkat", "tanggal"],
      ["sisa"],
    );
  }
  if (izin.pengajuan) {
    const menunggu = (await baris(client, TELEGRAM_SQL_HR_MENUNGGU)).filter(
      (row) => !izin.hanyaReimburse || teks(row.kelompok) === "Reimburse",
    );
    // Reimburse tidak pernah urgent; pemegang `reimburse.decide` saja tidak
    // melihat hitungan kelompok lain.
    const urgent = izin.hanyaReimburse
      ? undefined
      : (await baris(client, TELEGRAM_SQL_HR_URGENT))[0];
    hasil.pengajuan = {
      menunggu: objekKolom(menunggu, ["kelompok"], ["jumlah", "hari"]),
      menunggu_sejak: menunggu
        .map((row) => teks(row.sejak))
        .reduce((a, b) => (a === "" || b < a ? b : a), ""),
      urgent: urgent ? Number(urgent.jumlah ?? 0) : 0,
      urgent_sejak: urgent ? teks(urgent.sejak) : "",
    };
  }
  if (izin.rekrutmen) {
    hasil.rekrutmen = objekKolom<BagianPerhatian<"rekrutmen">[number]>(
      await baris(client, PERHATIAN_REKRUTMEN_SQL),
      ["id_lowongan", "judul", "tanggal_hapus"],
      ["jumlah"],
    );
  }
  // Kinerja (§24.5, Q-122): hanya angka, dengan aturan yang sama dengan
  // kejadian Telegram `hr_kinerja_menunggu`/`hr_kinerja_periode`.
  if (izin.kinerja) {
    const { jumlah, sejak } = await ringkasMenungguCloud(client);
    const jenis = await jenisPeriodeCloud(client);
    const rentang = periodeKinerjaBerakhir(jenis, tanggal);
    let periode: NonNullable<PerhatianHr["kinerja"]>["periode"] = null;
    if (rentang) {
      const [mulai, selesai] = rentang;
      periode = {
        jenis,
        mulai,
        selesai,
        ...(await ringkasPeriodeCloud(client, jenis, mulai, selesai)),
      };
    }
    hasil.kinerja = { menunggu: jumlah, menunggu_sejak: sejak, periode };
  }
  return hasil;
}
