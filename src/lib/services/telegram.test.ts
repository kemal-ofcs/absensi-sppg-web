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
const { drainTelegram, getTelegramConfig, saveTelegramConfig } = await import(
  "./telegram"
);
const { TELEGRAM_SQL_JAM_WIB, TELEGRAM_SQL_STOK_MENIPIS } = await import(
  "@/lib/validations/telegram"
);

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

describe("konfigurasi Telegram", () => {
  const draft = {
    aktif: true,
    botToken: "",
    grup: {
      inventaris: " -100111 ",
      keuangan: "",
      pimpinan: "",
      armada: "-444",
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
        },
      }),
    ).rejects.toThrow("Id grup Inventaris tidak valid");
  });
});
