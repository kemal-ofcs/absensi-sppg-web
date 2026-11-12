import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { type Client, createClient } from "@libsql/client";

mock.module("server-only", () => ({}));

const { initDatabaseSchema } = await import("@/lib/db-schema");
const {
  bacaPengaturan,
  catatHarianPada,
  drainTelegram,
  getTelegramConfig,
  perhatianHr,
  saveTelegramConfig,
} = await import("./telegram");
const {
  izinPerhatian,
  KLAIM_PARKIR,
  klaimSetelahGagal,
  statusSetelahGagal,
  TELEGRAM_DRAIN_GAGAL_SQL,
  TELEGRAM_DRAIN_KLAIM_SQL,
  TELEGRAM_DRAIN_PILIH_SQL,
  TELEGRAM_INSERT_ANTREAN_PARKIR_SQL,
  TELEGRAM_INSERT_ANTREAN_SQL,
  TELEGRAM_KEJADIAN,
  TELEGRAM_SQL_JAM_WIB,
  TELEGRAM_SQL_STOK_MENIPIS,
} = await import("@/lib/validations/telegram");
const { tanggalTampil } = await import("@/lib/validations/tutup-buku");

const TOKEN = "123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw0";
const fetchAsli = globalThis.fetch;
// SATU klien untuk seluruh berkas, direset per tes:
// di Bun Windows, klien libsql baru setelah klien lain ditutup bisa segfault.
const client: Client = createClient({ url: "file::memory:" });

type Kiriman = { url: string; body: Record<string, unknown> };
let kiriman: Kiriman[] = [];
let jawaban: () => Response = () =>
  new Response('{"ok":true,"result":{}}', { status: 200 });

beforeAll(async () => {
  await initDatabaseSchema(client);
});

beforeEach(async () => {
  await client.batch(
    [
      "DELETE FROM app_telegram_setting;",
      "DELETE FROM notifikasi_telegram;",
      "DELETE FROM inventory_pengajuan;",
      "DELETE FROM inventory_pengajuan_baris;",
      "DELETE FROM inventory_barang;",
      "DELETE FROM keu_pinjaman;",
      "DELETE FROM keu_tutup_buku;",
      "DELETE FROM payroll_audit_logs;",
      "DELETE FROM payroll_runs;",
      "DELETE FROM drv_laporan;",
      "DELETE FROM drv_perjalanan;",
      "DELETE FROM drv_kendaraan;",
      "DELETE FROM drv_jenis_kendaraan;",
      "DELETE FROM master_data;",
      "DELETE FROM hr_jabatan;",
      "DELETE FROM hr_dokumen_jenis;",
      "DELETE FROM hr_dokumen;",
      "DELETE FROM hr_profil;",
      "DELETE FROM hr_kontrak;",
      "DELETE FROM hr_sp;",
      "DELETE FROM hr_pengajuan;",
      "DELETE FROM hr_pengajuan_keputusan;",
      "DELETE FROM hr_lowongan;",
      "DELETE FROM hr_pelamar;",
    ],
    "write",
  );
  kiriman = [];
  jawaban = () => new Response('{"ok":true,"result":{}}', { status: 200 });
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    kiriman.push({ url, body: JSON.parse(String(init?.body ?? "{}")) });
    return jawaban();
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = fetchAsli;
});

afterAll(() => {
  client.close();
});

async function aktifkan(kirim: Record<string, string> = {}) {
  const nilai: Record<string, string> = {
    bot_token: TOKEN,
    aktif: "1",
    "grup:inventaris": "-100111",
    "grup:keuangan": "-222",
    "grup:pimpinan": "-333",
    "kirim:pengajuan_baru": "1",
    "kirim:pengajuan_putus": "1",
    "kirim:stok_menipis": "0",
    ...kirim,
  };
  for (const [kunci, isi] of Object.entries(nilai)) {
    await client.execute({
      sql: "INSERT OR REPLACE INTO app_telegram_setting (kunci, nilai) VALUES (?, ?);",
      args: [kunci, isi],
    });
  }
  await client.execute(
    "INSERT OR REPLACE INTO app_telegram_setting (kunci, nilai) VALUES ('aktif_sejak', datetime('now', '-1 hour'));",
  );
}

async function pengajuan(
  id: string,
  dibuat: string,
  keputusan: { disetujuiOleh?: string } = {},
) {
  await client.execute({
    sql: `INSERT INTO inventory_pengajuan (id_pengajuan, tanggal, seri, nomor_urut, nomor, keperluan,
            sidik_baris, diajukan_oleh, disetujui_pada, disetujui_oleh, created_at)
          VALUES (?, '2026-11-08', 'W', 1, ?, 'Alat tulis', 'x', 'sarpras', ?, ?, datetime('now', ?));`,
    args: [
      id,
      `PB-${id}`,
      keputusan.disetujuiOleh ? "2026-11-08 09:00:00" : null,
      keputusan.disetujuiOleh ?? null,
      dibuat,
    ],
  });
  if (keputusan.disetujuiOleh) {
    await client.execute({
      sql: "UPDATE inventory_pengajuan SET disetujui_pada = datetime('now', '+7 hours', '-5 minutes') WHERE id_pengajuan = ?;",
      args: [id],
    });
  }
  await client.batch(
    [
      {
        sql: "INSERT INTO inventory_pengajuan_baris (id_baris, id_pengajuan, urutan, nama_barang, satuan, desimal, jumlah, harga_satuan) VALUES (?, ?, 1, 'Kertas', 'rim', 0, 2, 50000);",
        args: [`${id}-1`, id],
      },
      {
        sql: "INSERT INTO inventory_pengajuan_baris (id_baris, id_pengajuan, urutan, nama_barang, satuan, desimal, jumlah, harga_satuan) VALUES (?, ?, 2, 'Cairan', 'liter', 1, 150, 10000);",
        args: [`${id}-2`, id],
      },
    ],
    "write",
  );
}

describe("pengirim Telegram", () => {
  test("belum aktif: tidak mencatat dan tidak mengirim apa pun", async () => {
    await pengajuan("a", "-10 minutes");
    const hasil = await drainTelegram(client, "uji", { jedaMs: 0 });
    expect(hasil.pesan).toBe("Notifikasi Telegram belum aktif.");
    expect(kiriman).toHaveLength(0);
    const antrean = await client.execute(
      "SELECT COUNT(*) AS n FROM notifikasi_telegram;",
    );
    expect(Number(antrean.rows[0]?.n)).toBe(0);
  });

  test("pengajuan baru ke grup Keuangan, sekali saja", async () => {
    await aktifkan();
    await pengajuan("a", "-10 minutes");
    // Dibuat sebelum Telegram diaktifkan: tidak dikirim.
    await pengajuan("lama", "-2 hours");

    const hasil = await drainTelegram(client, "uji", { jedaMs: 0 });
    expect(hasil).toMatchObject({ diproses: 1, terkirim: 1, gagal: 0 });
    expect(kiriman).toHaveLength(1);
    expect(kiriman[0]?.url).toBe(
      `https://api.telegram.org/bot${TOKEN}/sendMessage`,
    );
    expect(kiriman[0]?.body).toEqual({
      chat_id: "-222",
      // 2 × 50.000 + 1,50 × 10.000
      text: "📦 Pengajuan pembelian baru: PB-a\nKeperluan: Alat tulis\nTotal: Rp115.000 (2 barang)\nDiajukan oleh: sarpras\nMenunggu ACC di aplikasi.",
      disable_web_page_preview: true,
    });

    await drainTelegram(client, "uji", { jedaMs: 0 });
    expect(kiriman).toHaveLength(1);
  });

  test("keputusan ACC ke grup Inventaris; pengajuan yang sudah diputus tidak dikirim sebagai baru", async () => {
    await aktifkan();
    await pengajuan("b", "-10 minutes", { disetujuiOleh: "bendahara" });
    await drainTelegram(client, "uji", { jedaMs: 0 });
    expect(kiriman).toHaveLength(1);
    expect(kiriman[0]?.body.chat_id).toBe("-100111");
    expect(String(kiriman[0]?.body.text)).toStartWith(
      "✅ Pengajuan PB-b disetujui\n",
    );
  });

  test("gagal kirim: dicoba ulang dan token tidak bocor ke pesan galat", async () => {
    await aktifkan();
    await pengajuan("c", "-10 minutes");
    jawaban = () => {
      throw new Error(`connect ECONNREFUSED /bot${TOKEN}/sendMessage`);
    };
    const hasil = await drainTelegram(client, "uji", { jedaMs: 0 });
    expect(hasil.gagal).toBe(1);
    const baris = await client.execute(
      "SELECT status, attempt_count, last_error, klaim_oleh FROM notifikasi_telegram;",
    );
    expect(baris.rows[0]?.status).toBe("Menunggu");
    expect(Number(baris.rows[0]?.attempt_count)).toBe(1);
    expect(baris.rows[0]?.klaim_oleh).toBeNull();
    expect(String(baris.rows[0]?.last_error)).not.toContain(TOKEN);
    expect(String(baris.rows[0]?.last_error)).toContain("/bot***/");
  });

  test("kejadian yang dimatikan setelah tercatat dibatalkan, tidak dikirim", async () => {
    await aktifkan();
    await client.execute(
      "INSERT INTO notifikasi_telegram (id_notifikasi, kejadian, isi_pesan) VALUES ('pgj-baru:z', 'pengajuan_baru', 'x'), ('asing', 'gaji', 'y');",
    );
    await client.execute(
      "UPDATE app_telegram_setting SET nilai = '0' WHERE kunci = 'kirim:pengajuan_baru';",
    );
    const hasil = await drainTelegram(client, "uji", { jedaMs: 0 });
    expect(hasil.dibatalkan).toBe(2);
    expect(kiriman).toHaveLength(0);
  });

  test("SQL stok dan jam WIB berjalan pada skema nyata", async () => {
    await client.execute(
      "INSERT INTO inventory_barang (id_barang, kode_barang, nama_barang, tipe, satuan, stok_minimum) VALUES ('b1', 'BRG-1', 'Kertas A4', 'Habis Pakai', 'rim', 5), ('b2', 'BRG-2', 'Spidol', 'Habis Pakai', 'pcs', 0);",
    );
    const stok = await client.execute(TELEGRAM_SQL_STOK_MENIPIS);
    expect(stok.rows.map((row) => row.kode_barang)).toEqual(["BRG-1"]);
    expect(Number(stok.rows[0]?.stok_baik)).toBe(0);
    const jam = await client.execute(TELEGRAM_SQL_JAM_WIB);
    expect(String(jam.rows[0]?.tanggal)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("kejadian keuangan", () => {
  test("kasbon baru dan tutup/buka buku ke grup Keuangan, tanpa nama karyawan", async () => {
    await aktifkan({ "kirim:kasbon_baru": "1", "kirim:tutup_buku": "1" });
    await client.batch(
      [
        `INSERT INTO keu_pinjaman (id_pinjaman, id_karyawan, nama_karyawan, pokok, cicilan, mulai_potong,
           status, tanggal_pengajuan, diajukan_oleh, created_at)
         VALUES ('k1', 'kar-1', 'Siti Rahma', 2000000, 500000, '2026-12', 'Diajukan', '2026-11-08', 'siti', datetime('now', '-5 minutes')),
                ('k2', 'kar-2', 'Andi', 1000000, 250000, '2026-12', 'Disetujui', '2026-11-08', 'andi', datetime('now', '-5 minutes'));`,
        `INSERT INTO keu_tutup_buku (id_tutup, sampai_tanggal, dibuat_oleh, kode_perangkat, waktu_perangkat, saldo_json, status, created_at)
         VALUES ('t1', '2026-09-30', 'bendahara', 'web', '2026-11-08 08:00:00', '{}', 'Aktif', datetime('now', '-5 minutes')),
                ('t0', '2026-08-31', 'bendahara', 'web', '2026-09-01 08:00:00', '{}', 'Dibuka', datetime('now', '-60 days'));`,
        `UPDATE keu_tutup_buku SET alasan_buka = 'Salah input', dibuka_oleh = 'kepala',
           dibuka_pada = datetime('now', '+7 hours', '-2 minutes') WHERE id_tutup = 't0';`,
      ],
      "write",
    );
    const hasil = await drainTelegram(client, "uji", { jedaMs: 0 });
    expect(hasil.terkirim).toBe(3);
    expect(kiriman.every((item) => item.body.chat_id === "-222")).toBe(true);
    const teks = kiriman.map((item) => String(item.body.text));
    expect(teks).toContain(
      "💰 Pengajuan kasbon baru\nPokok: Rp2.000.000\nCicilan: Rp500.000 per bulan, mulai potong gaji Desember 2026\nMenunggu keputusan di aplikasi.",
    );
    expect(teks.join("\n")).not.toContain("Siti");
    expect(teks).toContain(
      "🔒 Buku ditutup sampai 30/09/2026\nOleh: bendahara",
    );
    expect(teks).toContain(
      "🔓 Buku dibuka kembali (tutup sampai 31/08/2026)\nOleh: kepala\nAlasan: Salah input",
    );
  });
});

describe("kejadian pimpinan", () => {
  test("status gaji ke grup Pimpinan: hanya angka agregat, SUBMITTED tidak dikirim", async () => {
    await aktifkan({ "kirim:gaji_status": "1" });
    await client.batch(
      [
        `INSERT INTO payroll_runs (id, idempotency_key, period_start, period_end, status,
           total_gross_payout, total_net_payout, total_employees, created_by)
         VALUES ('run1', 'k-run1', '2026-10-01', '2026-10-31', 'REVIEWED', 200000000, 187400000, 42, 'staf');`,
        `INSERT INTO payroll_items (id, payroll_run_id, id_karyawan, nama_karyawan, divisi, total_regular_hours,
           total_overtime_hours, total_overtime_index, rate_per_hour, basic_salary, overtime_salary,
           gross_salary, net_salary, breakdown_snapshot)
         VALUES ('it1', 'run1', 'kar-1', 'Siti Rahma', 'Guru', 160, 0, 0, 25000, 4000000, 0, 4000000, 3800000, '{}');`,
        `INSERT INTO payroll_audit_logs (id, payroll_run_id, action, old_status, new_status, performed_by, notes, created_at)
         VALUES ('a1', 'run1', 'TRANSITION_STATUS', 'DRAFT', 'SUBMITTED', 'staf', '', strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-3 minutes')),
                ('a2', 'run1', 'TRANSITION_STATUS', 'SUBMITTED', 'REVIEWED', 'bendahara', '', strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-2 minutes')),
                ('a0', 'run1', 'TRANSITION_STATUS', 'DRAFT', 'REVIEWED', 'bendahara', '', strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-2 hours'));`,
      ],
      "write",
    );
    const hasil = await drainTelegram(client, "uji", { jedaMs: 0 });
    expect(hasil.terkirim).toBe(1);
    expect(kiriman[0]?.body).toMatchObject({
      chat_id: "-333",
      text: "💼 Proses gaji 01/10/2026–31/10/2026 menunggu persetujuan\n42 pegawai · total bersih Rp187.400.000\nOleh: bendahara",
    });
    expect(String(kiriman[0]?.body.text)).not.toContain("Siti");
  });

  test("buku dibuka kembali: satu pesan ke Keuangan dan satu ke Pimpinan", async () => {
    await aktifkan({
      "kirim:tutup_buku": "1",
      "kirim:buka_buku_pimpinan": "1",
    });
    await client.execute(
      `INSERT INTO keu_tutup_buku (id_tutup, sampai_tanggal, dibuat_oleh, kode_perangkat, waktu_perangkat, saldo_json,
         status, alasan_buka, dibuka_oleh, dibuka_pada, created_at)
       VALUES ('t9', '2026-08-31', 'bendahara', 'web', '2026-09-01 08:00:00', '{}', 'Dibuka', 'Salah input', 'kepala',
         datetime('now', '+7 hours', '-2 minutes'), datetime('now', '-60 days'));`,
    );
    await drainTelegram(client, "uji", { jedaMs: 0 });
    expect(kiriman.map((item) => item.body.chat_id).sort()).toEqual([
      "-222",
      "-333",
    ]);
    const id = await client.execute(
      "SELECT id_notifikasi FROM notifikasi_telegram ORDER BY id_notifikasi;",
    );
    expect(id.rows.map((row) => row.id_notifikasi)).toEqual([
      "buka-pimpinan:t9",
      "buka:t9",
    ]);
  });
});

// Cermin `catat_armada_dari_data_cloud` di `desktop/telegram.rs`.
describe("kejadian armada", () => {
  test("kendala, ganti, selesai, lokasi palsu, dan tidak jalan ke grup Armada", async () => {
    await aktifkan({
      "grup:armada": "-444",
      "kirim:trip_kendala": "1",
      "kirim:trip_selesai": "1",
      "kirim:trip_tidak_jalan": "1",
      "kirim:trip_dibatalkan": "1",
      "kirim:trip_ganti_izin": "1",
      "kirim:trip_lokasi_palsu": "1",
    });
    const laporan = (
      id: string,
      perjalanan: string,
      jenis: string,
      waktu: string,
      kolom: Record<string, string | number | null> = {},
      diterima = "datetime('now', '-1 minute')",
    ) => {
      const nama = Object.keys(kolom);
      return {
        sql: `INSERT INTO drv_laporan (id_laporan, id_perjalanan, jenis, waktu_perangkat, dilaporkan_oleh, diterima_cloud${nama.map((n) => `, ${n}`).join("")})
              VALUES (?, ?, ?, ${waktu}, ?, ${diterima}${nama.map(() => ", ?").join("")});`,
        args: [
          id,
          perjalanan,
          jenis,
          kolom.id_karyawan ? "hp-driver" : "dispatcher",
          ...Object.values(kolom),
        ],
      };
    };
    await client.batch(
      [
        `INSERT OR IGNORE INTO tbl_shift (id_shift, kode_shift, nama_shift, jam_masuk, jam_pulang,
           jam_kerja_normal_menit, istirahat_menit, batas_pulang_menit,
           buffer_shift_malam_menit, offset_generate_alfa, hari_kerja)
         VALUES (1, 1, 'Kantor', '07:00', '15:00', 480, 60, 240, 120, 180, '1,2,3,4,5');`,
        `INSERT INTO master_data (id_unik, nama, divisi, id_shift, status_aktif)
         VALUES ('d1', 'Budi', 'Armada', 1, 'Aktif'), ('d2', 'Andi', 'Armada', 1, 'Aktif');`,
        `INSERT INTO drv_jenis_kendaraan (id_jenis, nama, tarif) VALUES ('j1', 'CDD', 100000), ('j2', 'CDE', 50000);`,
        `INSERT INTO drv_kendaraan (id_kendaraan, id_jenis, identitas)
         VALUES ('v1', 'j1', 'B 1 A'), ('v2', 'j2', 'B 2 B');`,
        `INSERT INTO drv_perjalanan (id_perjalanan, tanggal, seri, nomor_urut, nomor, id_karyawan, id_kendaraan,
           id_jenis, id_kategori, tarif_kendaraan, tarif_tujuan, dibuat_oleh)
         VALUES ('t1', '2026-11-09', 'WEB', 1, 'SJ-1', 'd1', 'v1', 'j1', 'k1', 100000, 0, 'dispatcher'),
                ('t2', '2026-11-09', 'WEB', 2, 'SJ-2', 'd2', 'v1', 'j1', 'k1', 100000, 0, 'dispatcher'),
                ('t3', '2026-11-09', 'WEB', 3, 'SJ-3', 'd1', 'v1', 'j1', 'k1', 100000, 0, 'dispatcher');`,
        laporan("l1", "t1", "Berangkat", "'2026-11-09 01:00:00'", {
          id_karyawan: "d1",
        }),
        laporan("l2", "t1", "Kendala", "'2026-11-09 02:00:00'", {
          id_karyawan: "d1",
          jenis_kendala: "Macet",
          terlambat_menit: 30,
          nama_lokasi: "Tol Cikampek",
        }),
        laporan("l3", "t1", "Ganti Kendaraan", "'2026-11-09 03:00:00'", {
          id_karyawan: "d1",
          mode_ganti: "Darurat",
          id_kendaraan_baru: "v2",
          keterangan: "Mesin mati",
        }),
        laporan("l4", "t1", "Selesai", "'2026-11-09 05:00:00'", {
          id_karyawan: "d1",
          nama_lokasi: "Gudang Cikarang",
          lokasi_palsu: 1,
        }),
        // Selesai kembar dari perangkat lain: tetap satu pesan per surat jalan.
        laporan("l4b", "t1", "Selesai", "'2026-11-09 05:01:00'", {
          id_karyawan: "d1",
        }),
        laporan("l5", "t2", "Tidak Jalan", "datetime('now', '-2 minutes')", {
          keterangan: "Pelanggan menunda",
        }),
        // Minta izin yang sudah diputuskan tidak dikirim.
        laporan("l6", "t3", "Ganti Driver", "'2026-11-09 04:00:00'", {
          id_karyawan: "d1",
          mode_ganti: "Minta Izin",
          id_karyawan_baru: "d2",
        }),
        laporan("l7", "t3", "Disetujui", "'2026-11-09 04:05:00'", {
          id_ref: "l6",
        }),
        // Sampai di cloud sebelum Telegram diaktifkan: tidak dikirim.
        laporan(
          "l8",
          "t3",
          "Kendala",
          "'2026-11-09 04:10:00'",
          { id_karyawan: "d2", jenis_kendala: "Ban" },
          "datetime('now', '-2 hours')",
        ),
      ],
      "write",
    );

    const hasil = await drainTelegram(client, "uji", { jedaMs: 0 });
    expect(hasil.terkirim).toBe(5);
    expect(kiriman.every((item) => item.body.chat_id === "-444")).toBe(true);
    const teks = kiriman.map((item) => String(item.body.text));
    expect(teks).toContain(
      "🚧 Kendala Macet: SJ-1\nDriver: Budi · CDD B 1 A\nTempat: Tol Cikampek\nPerkiraan terlambat: 30 menit\nWaktu: 09/11/2026 09:00:00 WIB\nDikirim terlambat (offline).",
    );
    expect(teks).toContain(
      "🔁 Ganti kendaraan darurat: SJ-1\nDari: CDD B 1 A\nKe: CDE B 2 B\nDilaporkan oleh: Budi\nAlasan: Mesin mati\nSudah berlaku. Setujui atau tolak di aplikasi.\nWaktu: 09/11/2026 10:00:00 WIB\nDikirim terlambat (offline).",
    );
    expect(teks).toContain(
      "🏁 Surat jalan SJ-1 selesai\nDriver: Budi · CDE B 2 B\nTempat: Gudang Cikarang\nWaktu: 09/11/2026 12:00:00 WIB\nDikirim terlambat (offline).",
    );
    expect(teks).toContain(
      "⚠️ Perlu ditinjau: lokasi palsu terdeteksi\nSurat jalan: SJ-1\nLaporan: Selesai · Gudang Cikarang\nDriver: Budi · CDE B 2 B\nWaktu: 09/11/2026 12:00:00 WIB\nDikirim terlambat (offline).",
    );
    const tidakJalan = teks.find((isi) => isi.startsWith("⛔"));
    expect(tidakJalan).toStartWith(
      "⛔ Surat jalan SJ-2 tidak jalan\nDriver: Andi · CDD B 1 A\nOleh: dispatcher\nAlasan: Pelanggan menunda\nWaktu: ",
    );
    expect(tidakJalan).not.toContain("terlambat");

    kiriman = [];
    expect((await drainTelegram(client, "uji", { jedaMs: 0 })).terkirim).toBe(
      0,
    );
  });
});

/**
 * Data uji pengingat HR, disalin harfiah dari `DATA_HRD` di
 * `desktop/telegram.rs` (`catat_hrd_dari_data_cloud`), relatif terhadap jam
 * database.
 */
const DATA_HRD = [
  `INSERT OR REPLACE INTO app_telegram_setting (kunci, nilai) VALUES ('aktif_sejak', datetime('now', '-3 days'));`,
  `INSERT OR IGNORE INTO tbl_shift (id_shift, kode_shift, nama_shift, jam_masuk, jam_pulang, jam_kerja_normal_menit, istirahat_menit, batas_pulang_menit, buffer_shift_malam_menit, offset_generate_alfa, hari_kerja) VALUES (1, 1, 'Kantor', '07:00', '15:00', 480, 60, 240, 120, 180, '1,2,3,4,5');`,
  `INSERT INTO hr_jabatan (id_jabatan, nama) VALUES ('jab-1', 'Staf Gudang');`,
  `INSERT INTO hr_dokumen_jenis (id_jenis, nama) VALUES ('dj-sim', 'SIM B1');`,
  `INSERT INTO master_data (id_unik, nama, divisi, id_shift, status_aktif, tanggal_daftar, id_jabatan, jabatan_status) VALUES
           ('k1', 'Budi', 'Gudang', 1, 'Aktif', date('now', '+7 hours', '-4 years'), 'jab-1', NULL),
           ('k2', 'Sari', 'Kantor', 1, 'Aktif', date('now', '+7 hours', '-8 years'), NULL, 'Kasir'),
           ('k3', 'Dodi', 'Kantor', 1, 'Nonaktif', date('now', '+7 hours', '-4 years'), NULL, NULL),
           ('k4', 'Andi', 'Kantor', 1, 'Aktif', date('now', '+7 hours'), NULL, NULL),
           ('k5', 'Eko', 'Kantor', 1, 'Aktif', date('now', '+7 hours', '-1 month'), NULL, NULL);`,
  `INSERT INTO hr_profil (id_karyawan, nik) VALUES ('k1', '3201000000000001');`,
  `INSERT INTO hr_kontrak (id_kontrak, id_karyawan, jenis, id_ref, nomor, tanggal_mulai, tanggal_selesai, percobaan_selesai, dicatat_oleh) VALUES
           ('c1', 'k1', 'PKWT', NULL, 'NOMOR-RAHASIA', '2026-01-01', date('now', '+7 hours', '+20 days'), NULL, 'hrd'),
           ('c2', 'k2', 'PKWT', NULL, NULL, '2026-01-01', date('now', '+7 hours', '+5 days'), date('now', '+7 hours', '+3 days'), 'hrd'),
           ('c3', 'k3', 'PKWT', NULL, NULL, '2026-01-01', date('now', '+7 hours', '+5 days'), NULL, 'hrd'),
           ('c4', 'k4', 'PKWT', NULL, NULL, '2026-01-01', date('now', '+7 hours', '+10 days'), NULL, 'hrd'),
           ('c4b', 'k4', 'PKWTT', NULL, NULL, '2026-02-01', NULL, NULL, 'hrd'),
           ('c5', 'k5', 'PKWT', NULL, NULL, '2026-01-01', date('now', '+7 hours', '+3 days'), date('now', '+7 hours', '+1 day'), 'hrd'),
           ('batal-c5', 'k5', 'Pembatalan', 'c5', NULL, '2026-01-01', NULL, NULL, 'hrd'),
           ('c6', 'k1', 'PKWT', NULL, NULL, '2025-01-01', date('now', '+7 hours', '+2 days'), NULL, 'hrd');`,
  `INSERT INTO hr_dokumen (id_dokumen, id_karyawan, id_jenis, nomor, tanggal_kedaluwarsa, dicatat_oleh) VALUES
           ('d1', 'k1', 'dj-sim', 'B1-RAHASIA', date('now', '+7 hours', '+30 days'), 'hrd'),
           ('d2', 'k1', 'dj-sim', NULL, date('now', '+7 hours', '+31 days'), 'hrd'),
           ('d3', 'k3', 'dj-sim', NULL, date('now', '+7 hours', '+2 days'), 'hrd'),
           ('d4', 'k2', 'dj-sim', NULL, date('now', '+7 hours', '-1 day'), 'hrd');`,
  `INSERT INTO hr_sp (id_sp, id_karyawan, tingkat, tanggal, masa_bulan, berlaku_sampai, pelanggaran, usulan_tingkat, penanda_nama, penanda_jabatan, dicatat_oleh, dicabut_pada) VALUES
           ('s1', 'k2', 'SP2', '2026-01-01', 6, date('now', '+7 hours'), 'Pelanggaran rahasia', 'SP2', 'Direktur', 'Direktur', 'hrd', NULL),
           ('s2', 'k1', 'SP1', '2026-01-01', 6, date('now', '+7 hours'), 'x', 'SP1', 'Direktur', 'Direktur', 'hrd', datetime('now')),
           ('s3', 'k1', 'SP1', '2026-01-01', 6, date('now', '+7 hours', '-7 days'), 'x', 'SP1', 'Direktur', 'Direktur', 'hrd', NULL),
           ('s4', 'k1', 'SP1', '2026-01-01', 6, date('now', '+7 hours', '-5 days'), 'x', 'SP1', 'Direktur', 'Direktur', 'hrd', NULL),
           ('s5', 'k1', 'SP3', '2026-01-01', 6, date('now', '+7 hours', '-2 days'), 'x', 'SP3', 'Direktur', 'Direktur', 'hrd', NULL);`,
  `INSERT INTO hr_pengajuan (id_pengajuan, id_karyawan, id_jenis, kelompok, dampak_gaji, tanggal_mulai, tanggal_selesai, alasan, sidik, diajukan_oleh, waktu_perangkat, created_at, nominal) VALUES
           ('p1', 'k1', 'j', 'Cuti', 'Dibayar', '2026-12-01', '2026-12-01', 'Alasan rahasia', 's1', 'k1', '2026-11-01 00:00:00', datetime('now', '-3 days'), NULL),
           ('p2', 'k2', 'j', 'Cuti', 'Dibayar', '2026-12-01', '2026-12-01', 'Alasan rahasia', 's2', 'k2', '2026-11-01 00:00:00', datetime('now', '-4 days'), NULL),
           ('p3', 'k2', 'j', 'Reimburse', 'Tidak Berpengaruh', '2026-11-01', '2026-11-01', 'Alasan rahasia', 's3', 'k2', '2026-11-01 00:00:00', datetime('now', '-3 days'), 987654),
           ('p4', 'k1', 'j', 'Izin', 'Dibayar', '2026-12-01', '2026-12-01', 'Alasan rahasia', 's4', 'k1', '2026-11-01 00:00:00', datetime('now', '-1 day'), NULL),
           ('p5', 'k1', 'j', 'Sakit', 'Dibayar', '2026-12-01', '2026-12-01', 'Alasan rahasia', 's5', 'k1', '2026-11-01 00:00:00', datetime('now', '-5 days'), NULL),
           ('p6', 'k1', 'j', 'Izin', 'Dibayar', '2026-12-01', '2026-12-01', 'Alasan rahasia', 's6', 'k1', '2026-11-01 00:00:00', datetime('now', '-5 days'), NULL),
           ('p7', 'k3', 'j', 'Cuti', 'Dibayar', '2026-12-01', '2026-12-01', 'Alasan rahasia', 's7', 'k3', '2026-11-01 00:00:00', datetime('now', '-5 days'), NULL),
           ('p8', 'k2', 'j', 'Izin', 'Dibayar', '2026-12-01', '2026-12-01', 'Alasan rahasia', 's8', 'k2', '2026-11-01 00:00:00', datetime('now', '-3 days'), NULL),
           ('p9', 'k1', 'j', 'Izin', 'Dibayar', '2026-12-01', '2026-12-01', 'Alasan rahasia', 's9', 'k1', '2026-11-01 00:00:00', datetime('now', '-1 day'), NULL),
           ('p10', 'k2', 'j', 'Izin', 'Dibayar', '2026-12-01', '2026-12-01', 'Alasan rahasia', 's10', 'k2', '2026-11-01 00:00:00', datetime('now', '-6 days'), NULL),
           ('p11', 'k1', 'j', 'Izin', 'Dibayar', '2026-12-01', '2026-12-01', 'Alasan rahasia', 's11', 'k1', '2026-11-01 00:00:00', datetime('now', '-6 days'), NULL);`,
  `INSERT INTO hr_pengajuan_keputusan (id_keputusan, id_pengajuan, jenis, sidik, alasan, oleh, waktu_perangkat, diterima_cloud) VALUES
           ('q5', 'p5', 'Setujui', 's5', NULL, 'hrd', '2026-11-01 01:00:00', datetime('now')),
           ('q6', 'p6', 'Batal', 's6', 'Alasan rahasia', 'k1', '2026-11-01 01:00:00', datetime('now')),
           ('q8', 'p8', 'Tolak', 'lama', 'Alasan rahasia', 'hrd', '2026-11-01 01:00:00', datetime('now')),
           ('q9', 'p9', 'Setujui Urgent', 's9', NULL, 'atasan', '2026-11-01 01:00:00', datetime('now')),
           ('q10', 'p10', 'Setujui Urgent', 's10', NULL, 'atasan', '2026-11-01 01:00:00', datetime('now')),
           ('q10b', 'p10', 'Diketahui', 's10', NULL, 'hrd', '2026-11-01 02:00:00', datetime('now')),
           ('q11', 'p11', 'Setujui Urgent', 's11', NULL, 'atasan', '2026-11-01 01:00:00', datetime('now')),
           ('q11b', 'p11', 'Batal', 's11', NULL, 'k1', '2026-11-01 02:00:00', datetime('now'));`,
];
async function aktifkanHrd(kirim: readonly string[]) {
  const nilai: [string, string][] = [
    ["bot_token", TOKEN],
    ["aktif", "1"],
    ["grup:hrd", "-555"],
    ...kirim.map((kejadian): [string, string] => [`kirim:${kejadian}`, "1"]),
  ];
  for (const [kunci, isi] of nilai) {
    await client.execute({
      sql: "INSERT OR REPLACE INTO app_telegram_setting (kunci, nilai) VALUES (?, ?);",
      args: [kunci, isi],
    });
  }
}

async function antreanUji() {
  return (
    await client.execute(
      "SELECT id_notifikasi, isi_pesan, COALESCE(klaim_oleh, '') AS klaim_oleh FROM notifikasi_telegram ORDER BY id_notifikasi;",
    )
  ).rows.map((row) => ({
    id: String(row.id_notifikasi),
    isi: String(row.isi_pesan),
    klaim: String(row.klaim_oleh),
  }));
}

const KEJADIAN_HRD = TELEGRAM_KEJADIAN.slice(13);

describe("pengingat HRD", () => {
  // Cermin `catat_hrd_dari_data_cloud` (Rust): data dan isi pesan sama.
  test("kejadian hrd", async () => {
    await client.batch(DATA_HRD, "write");
    await aktifkanHrd(KEJADIAN_HRD);
    const t = (
      await client.execute(
        "SELECT date('now', '+7 hours') AS t, date('now', '+7 hours', '+5 days') AS k2, date('now', '+7 hours', '+3 days') AS c2, date('now', '+7 hours', '+20 days') AS k1, date('now', '+7 hours', '+30 days') AS d1, date('now', '+7 hours', '-2 days') AS s5, date('now', '+7 hours', '-4 days') AS p2, date('now', '+7 hours', '-1 day') AS p9;",
      )
    ).rows[0] as unknown as Record<string, string>;
    const hariIni = String(t.t);
    const pengaturan = await bacaPengaturan(client);

    // Sebelum 07.00 WIB tidak ada yang dicatat.
    await catatHarianPada(client, pengaturan, hariIni, 6);
    expect(await antreanUji()).toEqual([]);

    await catatHarianPada(client, pengaturan, hariIni, 7);
    await catatHarianPada(client, pengaturan, hariIni, 12);
    const antrean = await antreanUji();
    const harap = [
      "hr-coba:c2",
      `hr-dok:d1:${t.d1}`,
      "hr-kontrak:c1:30",
      "hr-kontrak:c2:7",
      "hr-sp:s1",
      "hr-sp:s5",
      `hr-tunggu:${hariIni}`,
      `hr-ultah:${hariIni}`,
      `hr-urgent:${hariIni}`,
    ];
    expect(antrean.map((baris) => baris.id)).toEqual(harap);
    expect(antrean.every((baris) => baris.klaim === KLAIM_PARKIR)).toBe(true);
    const isi = (id: string) => antrean.find((baris) => baris.id === id)?.isi;
    expect(isi("hr-kontrak:c2:7")).toBe(
      `📄 Kontrak PKWT berakhir 5 hari lagi (${tanggalTampil(String(t.k2))})\nKaryawan: Sari · Kasir`,
    );
    expect(isi("hr-kontrak:c1:30")).toBe(
      `📄 Kontrak PKWT berakhir 20 hari lagi (${tanggalTampil(String(t.k1))})\nKaryawan: Budi · Staf Gudang`,
    );
    expect(isi("hr-coba:c2")).toBe(
      `⏳ Masa percobaan berakhir 3 hari lagi (${tanggalTampil(String(t.c2))})\nKaryawan: Sari · Kasir`,
    );
    expect(isi(`hr-dok:d1:${t.d1}`)).toBe(
      `🪪 Dokumen SIM B1 kedaluwarsa 30 hari lagi (${tanggalTampil(String(t.d1))})\nKaryawan: Budi · Staf Gudang`,
    );
    expect(isi("hr-sp:s1")).toBe(
      `📋 Masa berlaku SP2 berakhir ${tanggalTampil(hariIni)}\nKaryawan: Sari · Kasir`,
    );
    expect(isi("hr-sp:s5")).toBe(
      `📋 Masa berlaku SP3 berakhir ${tanggalTampil(String(t.s5))}\nKaryawan: Budi · Staf Gudang`,
    );
    expect(isi(`hr-tunggu:${hariIni}`)).toBe(
      `📥 4 pengajuan menunggu lebih dari 2 hari\nCuti 2, Izin 1, Reimburse 1\nPaling lama sejak ${tanggalTampil(String(t.p2))}`,
    );
    expect(isi(`hr-urgent:${hariIni}`)).toBe(
      `⚡ 1 pengajuan urgent belum diketahui HRD\nPaling lama sejak ${tanggalTampil(String(t.p9))}`,
    );
    expect(isi(`hr-ultah:${hariIni}`)).toBe(
      "🎉 Ulang tahun kerja hari ini\n• Budi (Staf Gudang), 4 tahun\n• Sari (Kasir), 8 tahun",
    );
    // Q-32: tidak ada isi rahasia yang ikut.
    for (const baris of antrean) {
      for (const rahasia of [
        "rahasia",
        "RAHASIA",
        "3201000000000001",
        "987654",
        "Dodi",
        "Eko",
      ]) {
        expect(baris.isi).not.toContain(rahasia);
      }
    }

    // Dokumen diperpanjang: tanggal baru = id baru (Q-104).
    await client.execute(
      "UPDATE hr_dokumen SET tanggal_kedaluwarsa = date('now', '+7 hours', '+29 days') WHERE id_dokumen = 'd1';",
    );
    await catatHarianPada(client, pengaturan, hariIni, 8);
    expect(await antreanUji()).toHaveLength(harap.length + 1);

    // Pengirim mengambil baris parkir dan mengirimnya ke grup HRD.
    const hasil = await drainTelegram(client, "uji", { jedaMs: 0 });
    expect(hasil.terkirim).toBe(harap.length + 1);
    expect(kiriman.every((item) => item.body.chat_id === "-555")).toBe(true);
    const sisa = await client.execute(
      "SELECT COUNT(*) AS n FROM notifikasi_telegram WHERE status <> 'Terkirim' OR klaim_oleh IS NOT NULL;",
    );
    expect(Number(sisa.rows[0]?.n)).toBe(0);
  });

  // Cermin `baris_parkir_tidak_disentuh_predikat_lama` (Rust).
  test("baris parkir tidak disentuh predikat lama", async () => {
    const PILIH_V33 =
      "SELECT id_notifikasi, kejadian, isi_pesan, attempt_count FROM notifikasi_telegram WHERE status = 'Menunggu' AND (klaim_sampai IS NULL OR klaim_sampai < datetime('now')) ORDER BY created_at ASC, id_notifikasi ASC LIMIT ?;";
    const BATAL_V33 =
      "UPDATE notifikasi_telegram SET status = 'Dibatalkan', last_error = ? WHERE id_notifikasi = ? AND status = 'Menunggu' AND (klaim_sampai IS NULL OR klaim_sampai < datetime('now'));";
    const KLAIM_V33 =
      "UPDATE notifikasi_telegram SET klaim_oleh = ?, klaim_sampai = datetime('now', '+5 minutes') WHERE id_notifikasi = ? AND status = 'Menunggu' AND (klaim_sampai IS NULL OR klaim_sampai < datetime('now'));";
    const pilih = async (sql: string) =>
      (await client.execute({ sql, args: [20] })).rows.map((row) =>
        String(row.id_notifikasi),
      );
    const ubah = async (sql: string, args: (string | number | null)[]) =>
      (await client.execute({ sql, args })).rowsAffected;
    const keadaan = async () => {
      const row = (
        await client.execute(
          "SELECT status, attempt_count, COALESCE(klaim_oleh, '') AS klaim_oleh, COALESCE(klaim_sampai, '') AS klaim_sampai FROM notifikasi_telegram WHERE id_notifikasi = 'hr-sp:s1';",
        )
      ).rows[0];
      return `${row?.status}|${row?.attempt_count}|${row?.klaim_oleh}|${row?.klaim_sampai}`;
    };
    const gagal = async (
      percobaan: number,
      kejadian: string,
      id: string,
      oleh: string,
    ) => {
      const { status, percobaan: attempts } = statusSetelahGagal(percobaan);
      const { klaimOleh, klaimSampai } = klaimSetelahGagal(kejadian, status);
      return ubah(TELEGRAM_DRAIN_GAGAL_SQL, [
        status,
        attempts,
        "galat",
        klaimOleh,
        klaimSampai,
        id,
        oleh,
      ]);
    };

    await client.execute({
      sql: TELEGRAM_INSERT_ANTREAN_PARKIR_SQL,
      args: ["hr-sp:s1", "hr_sp_berakhir", "isi hr"],
    });
    await client.execute({
      sql: TELEGRAM_INSERT_ANTREAN_SQL,
      args: ["stok:2026-11-12", "stok_menipis", "isi stok"],
    });

    // Build lama: tidak terlihat, tidak bisa diklaim atau dibatalkan.
    expect(await pilih(PILIH_V33)).toEqual(["stok:2026-11-12"]);
    expect(await ubah(KLAIM_V33, ["lama", "hr-sp:s1"])).toBe(0);
    expect(await ubah(BATAL_V33, ["x", "hr-sp:s1"])).toBe(0);
    expect(await keadaan()).toBe("Menunggu|0|gen:2|9999-12-31 23:59:59");

    // Build ini: terlihat dan diklaim atomik (klaim kedua kalah).
    expect(await pilih(TELEGRAM_DRAIN_PILIH_SQL)).toEqual([
      "hr-sp:s1",
      "stok:2026-11-12",
    ]);
    expect(await ubah(TELEGRAM_DRAIN_KLAIM_SQL, ["pc-1", "hr-sp:s1"])).toBe(1);
    expect(await ubah(TELEGRAM_DRAIN_KLAIM_SQL, ["pc-2", "hr-sp:s1"])).toBe(0);

    // Gagal kirim yang masih boleh dicoba: kembali diparkir.
    expect(await gagal(0, "hr_sp_berakhir", "hr-sp:s1", "pc-1")).toBe(1);
    expect(await keadaan()).toBe("Menunggu|1|gen:2|9999-12-31 23:59:59");
    expect(await pilih(PILIH_V33)).toEqual(["stok:2026-11-12"]);
    expect(await ubah(BATAL_V33, ["x", "hr-sp:s1"])).toBe(0);

    // Batas percobaan: Gagal, klaim dikosongkan.
    expect(await ubah(TELEGRAM_DRAIN_KLAIM_SQL, ["pc-1", "hr-sp:s1"])).toBe(1);
    expect(await gagal(2, "hr_sp_berakhir", "hr-sp:s1", "pc-1")).toBe(1);
    expect(await keadaan()).toBe("Gagal|3||");

    // Kejadian lama tetap tidak diparkir.
    expect(
      await ubah(TELEGRAM_DRAIN_KLAIM_SQL, ["pc-1", "stok:2026-11-12"]),
    ).toBe(1);
    expect(await gagal(0, "stok_menipis", "stok:2026-11-12", "pc-1")).toBe(1);
    expect(await pilih(PILIH_V33)).toEqual(["stok:2026-11-12"]);
  });

  test("gagal kirim lewat drainTelegram: baris HR kembali diparkir", async () => {
    await aktifkanHrd(["hr_sp_berakhir"]);
    await client.execute({
      sql: TELEGRAM_INSERT_ANTREAN_PARKIR_SQL,
      args: ["hr-sp:s1", "hr_sp_berakhir", "isi hr"],
    });
    jawaban = () => new Response('{"ok":false}', { status: 502 });
    const hasil = await drainTelegram(client, "uji", { jedaMs: 0 });
    expect(hasil).toMatchObject({ diproses: 1, gagal: 1 });
    const row = (
      await client.execute(
        "SELECT status, attempt_count, klaim_oleh, klaim_sampai FROM notifikasi_telegram WHERE id_notifikasi = 'hr-sp:s1';",
      )
    ).rows[0];
    expect(row?.status).toBe("Menunggu");
    expect(Number(row?.attempt_count)).toBe(1);
    expect(row?.klaim_oleh).toBe(KLAIM_PARKIR);
    expect(row?.klaim_sampai).toBe("9999-12-31 23:59:59");

    // Sakelar dimatikan: build ini membatalkan baris parkir.
    await client.execute(
      "UPDATE app_telegram_setting SET nilai = '0' WHERE kunci = 'kirim:hr_sp_berakhir';",
    );
    const batal = await drainTelegram(client, "uji", { jedaMs: 0 });
    expect(batal.dibatalkan).toBe(1);
  });
});

/** Disalin harfiah dari `DATA_REKRUTMEN` di `desktop/telegram.rs`. */
const DATA_REKRUTMEN = [
  `INSERT INTO hr_lowongan (id_lowongan, judul, jumlah, tanggal_buka, ditutup_pada, dicatat_oleh) VALUES
           ('L1', 'Staf Gudang', 1, '2025-01-01', datetime('now', '-12 months', '+10 days'), 'hrd'),
           ('L2', 'Kasir', 1, '2025-01-01', datetime('now'), 'hrd'),
           ('L3', 'Driver', 1, '2025-01-01', NULL, 'hrd');`,
  `INSERT INTO hr_pelamar (id_pelamar, id_lowongan, nama, tanggal_lamaran, id_karyawan, dicatat_oleh) VALUES
           ('pl1', 'L1', 'Pelamar Rahasia', '2025-01-02', NULL, 'hrd'),
           ('pl2', 'L1', 'Pelamar Rahasia', '2025-01-02', NULL, 'hrd'),
           ('pl3', 'L1', 'Pelamar Rahasia', '2025-01-02', 'k1', 'hrd'),
           ('pl4', 'L2', 'Pelamar Rahasia', '2025-01-02', NULL, 'hrd'),
           ('pl5', 'L3', 'Pelamar Rahasia', '2025-01-02', NULL, 'hrd');`,
];
// Cermin `perhatian_menurut_izin` (Rust): data dan hasil sama.
describe("kartu perlu perhatian", () => {
  test("perhatian", async () => {
    await client.batch([...DATA_HRD, ...DATA_REKRUTMEN], "write");
    const t = (
      await client.execute(
        "SELECT date('now', '+7 hours') AS t, date('now', '+7 hours', '+5 days') AS k2, date('now', '+7 hours', '+3 days') AS c2, date('now', '+7 hours', '+20 days') AS k1, date('now', '+7 hours', '+30 days') AS d1, date('now', '+7 hours', '-1 day') AS d4, date('now', '+7 hours', '-4 days') AS p2, date('now', '+7 hours', '-1 day') AS p9, date('now', '+7 hours', '-3 days') AS p3;",
      )
    ).rows[0] as unknown as Record<string, string>;

    const semua = await perhatianHr(
      client,
      izinPerhatian(() => true),
    );
    expect(semua.kontrak).toEqual([
      {
        jenis: "Percobaan",
        id_karyawan: "k2",
        nama: "Sari",
        jabatan: "Kasir",
        tanggal: t.c2,
        sisa: 3,
      },
      {
        jenis: "PKWT",
        id_karyawan: "k2",
        nama: "Sari",
        jabatan: "Kasir",
        tanggal: t.k2,
        sisa: 5,
      },
      {
        jenis: "PKWT",
        id_karyawan: "k1",
        nama: "Budi",
        jabatan: "Staf Gudang",
        tanggal: t.k1,
        sisa: 20,
      },
    ]);
    expect(semua.dokumen).toEqual([
      {
        id_karyawan: "k2",
        nama: "Sari",
        jabatan: "Kasir",
        jenis_dokumen: "SIM B1",
        tanggal: t.d4,
        sisa: -1,
      },
      {
        id_karyawan: "k1",
        nama: "Budi",
        jabatan: "Staf Gudang",
        jenis_dokumen: "SIM B1",
        tanggal: t.d1,
        sisa: 30,
      },
    ]);
    expect(semua.sp).toEqual([
      {
        id_karyawan: "k2",
        nama: "Sari",
        jabatan: "Kasir",
        tingkat: "SP2",
        tanggal: t.t,
        sisa: 0,
      },
    ]);
    expect(semua.pengajuan).toEqual({
      menunggu: [
        { kelompok: "Cuti", jumlah: 2 },
        { kelompok: "Izin", jumlah: 1 },
        { kelompok: "Reimburse", jumlah: 1 },
      ],
      menunggu_sejak: t.p2 as string,
      urgent: 1,
      urgent_sejak: t.p9 as string,
    });
    expect(semua.ulang_tahun).toEqual([
      {
        id_karyawan: "k1",
        nama: "Budi",
        jabatan: "Staf Gudang",
        tanggal: t.t as string,
        tahun: 4,
      },
      {
        id_karyawan: "k2",
        nama: "Sari",
        jabatan: "Kasir",
        tanggal: t.t as string,
        tahun: 8,
      },
    ]);
    expect(semua.rekrutmen).toHaveLength(1);
    const lowongan = semua.rekrutmen?.[0];
    expect(lowongan).toMatchObject({
      id_lowongan: "L1",
      judul: "Staf Gudang",
      jumlah: 2,
    });
    const hapus = String(lowongan?.tanggal_hapus);
    expect(hapus > String(t.t) && hapus <= String(t.d1)).toBe(true);
    expect(JSON.stringify(semua)).not.toContain("Rahasia");

    // Tanpa izin: bagiannya tidak dibaca dan kuncinya tidak ada.
    const reimburse = await perhatianHr(
      client,
      izinPerhatian((p) => p === "reimburse.decide"),
    );
    expect(Object.keys(reimburse)).toEqual(["pengajuan"]);
    expect(reimburse.pengajuan).toEqual({
      menunggu: [{ kelompok: "Reimburse", jumlah: 1 }],
      menunggu_sejak: t.p3 as string,
      urgent: 0,
      urgent_sejak: "",
    });
    const karyawan = await perhatianHr(
      client,
      izinPerhatian((p) => p === "employees.view"),
    );
    expect(Object.keys(karyawan).sort()).toEqual(["kontrak", "ulang_tahun"]);
    const sp = await perhatianHr(
      client,
      izinPerhatian((p) => p === "hr.warning.view"),
    );
    expect(Object.keys(sp)).toEqual(["sp"]);
    const kosong = await perhatianHr(client, {
      kontrak: false,
      dokumen: false,
      sp: false,
      pengajuan: false,
      hanyaReimburse: false,
      rekrutmen: false,
    });
    expect(kosong).toEqual({});
  });
});

describe("konfigurasi Telegram", () => {
  const draft = {
    aktif: true,
    botToken: "",
    grup: {
      inventaris: " -100111 ",
      keuangan: "",
      pimpinan: "",
      armada: "-444",
      hrd: "",
    },
    kirim: {
      pengajuan_baru: true,
      pengajuan_putus: true,
      stok_menipis: false,
      kasbon_baru: false,
      tutup_buku: false,
      gaji_status: false,
      buka_buku_pimpinan: false,
      trip_kendala: true,
      trip_selesai: false,
      trip_tidak_jalan: false,
      trip_dibatalkan: false,
      trip_ganti_izin: false,
      trip_lokasi_palsu: false,
      hr_kontrak_akhir: false,
      hr_percobaan_akhir: false,
      hr_dokumen_kedaluwarsa: false,
      hr_sp_berakhir: false,
      hr_pengajuan_menunggu: false,
      hr_urgent_belum_diketahui: false,
      hr_ulang_tahun_kerja: false,
    },
  };

  test("aktif tanpa token ditolak", async () => {
    await expect(saveTelegramConfig(client, draft)).rejects.toThrow(
      "Isi token bot lebih dulu",
    );
  });

  test("token disimpan tetapi tidak pernah dikembalikan; aktif_sejak diisi", async () => {
    const config = await saveTelegramConfig(client, {
      ...draft,
      botToken: TOKEN,
    });
    expect(config).toMatchObject({
      aktif: true,
      tokenTersimpan: true,
      tokenAkhir: "saw0",
      grup: {
        inventaris: "-100111",
        keuangan: "",
        pimpinan: "",
        armada: "-444",
      },
    });
    expect(JSON.stringify(config)).not.toContain(TOKEN);
    const sejak = await client.execute(
      "SELECT nilai FROM app_telegram_setting WHERE kunci = 'aktif_sejak';",
    );
    expect(String(sejak.rows[0]?.nilai)).toMatch(/^\d{4}-\d{2}-\d{2} /);

    // Simpan ulang tanpa token: token lama tetap.
    await saveTelegramConfig(client, draft);
    expect((await getTelegramConfig(client)).tokenTersimpan).toBe(true);
  });

  test("id grup yang bukan angka ditolak", async () => {
    await expect(
      saveTelegramConfig(client, {
        ...draft,
        botToken: TOKEN,
        grup: {
          inventaris: "t.me/abc",
          keuangan: "",
          pimpinan: "",
          armada: "",
          hrd: "",
        },
      }),
    ).rejects.toThrow("Id grup Inventaris tidak valid");
  });
});
