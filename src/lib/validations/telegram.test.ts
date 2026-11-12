import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  INGAT_DOKUMEN_SQL,
  INGAT_JAM_SQL,
  INGAT_KONTRAK_DEKAT_SQL,
  INGAT_KONTRAK_JAUH_SQL,
  INGAT_MENUNGGU_SQL,
  INGAT_PERCOBAAN_SQL,
} from "./hris";
import {
  type BarisStokMenipis,
  BIDANG_KEJADIAN,
  diparkir,
  galatTelegram,
  grupDariUpdates,
  HR_HARI_JENDELA,
  HR_HARI_LOWONGAN,
  type IsiLaporanPerjalanan,
  IZIN_PERHATIAN,
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
  idTripGantiIzin,
  idTripKendala,
  idTripLokasiPalsu,
  izinPerhatian,
  type KaryawanPeriode,
  KELOMPOK_TANPA_NAMA,
  KLAIM_PARKIR,
  klaimSetelahGagal,
  LABEL_BIDANG,
  labelBulan,
  normalisasiChatId,
  PERHATIAN_SQL_DOKUMEN,
  PERHATIAN_SQL_KONTRAK,
  PERHATIAN_SQL_SP,
  PERHATIAN_SQL_ULTAH,
  type PenilaianTunggu,
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
  sisaHari,
  statusSetelahGagal,
  TELEGRAM_DRAIN_BATAL_SQL,
  TELEGRAM_DRAIN_GAGAL_SQL,
  TELEGRAM_DRAIN_KLAIM_SQL,
  TELEGRAM_DRAIN_PILIH_SQL,
  TELEGRAM_INSERT_ANTREAN_PARKIR_SQL,
  TELEGRAM_KEJADIAN,
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
  TELEGRAM_SQL_LABEL_KENDARAAN,
  TELEGRAM_SQL_NAMA_PERSONIL,
  TELEGRAM_SQL_TRIP_GANTI_IZIN,
  TELEGRAM_SQL_TRIP_KENDALA,
  TELEGRAM_SQL_TRIP_LAPORAN,
  TELEGRAM_SQL_TRIP_LOKASI_PALSU,
  TELEGRAM_SQL_TRIP_TUTUP,
  TRIP_TUTUP,
  tokenBotValid,
} from "./telegram";

/** Berkas ini ikut disalin ke Mobile, tempat salinan Rust-nya di `src/mobile`. */
function bacaTelegramRs() {
  const berkas = ["desktop", "mobile"]
    .map((dir) =>
      join(import.meta.dir, `../../../src-tauri/src/${dir}/telegram.rs`),
    )
    .find((path) => existsSync(path));
  expect(berkas).toBeDefined();
  return readFileSync(berkas as string, "utf8").replaceAll("\r\n", "\n");
}

/**
 * SQL yang memakai angka pengingat ditulis Rust sebagai `concat!` potongan
 * literal + makro `ingat_*_sql!` (§24.3). Setiap potongan di antara fragmen
 * wajib ada sebagai literal utuh; SQL tanpa fragmen tetap satu literal.
 */
const FRAGMEN_INGAT = [
  [INGAT_KONTRAK_JAUH_SQL, "ingat_kontrak_jauh_sql!()"],
  [INGAT_KONTRAK_DEKAT_SQL, "ingat_kontrak_dekat_sql!()"],
  [INGAT_PERCOBAAN_SQL, "ingat_percobaan_sql!()"],
  [INGAT_DOKUMEN_SQL, "ingat_dokumen_sql!()"],
  [INGAT_MENUNGGU_SQL, "ingat_menunggu_sql!()"],
  [INGAT_JAM_SQL, "ingat_jam_sql!()"],
] as const;
function harapSqlDiRust(rust: string, sql: string) {
  let potongan = [sql];
  for (const [fragmen, makro] of FRAGMEN_INGAT) {
    if (sql.includes(fragmen)) expect(rust).toContain(makro);
    potongan = potongan.flatMap((p) => p.split(fragmen));
  }
  for (const p of potongan.filter((p) => p !== "")) {
    expect(rust).toContain(`"${p}"`);
  }
}

// Vektor yang sama diuji di `desktop/telegram.rs` (modul `tests`).
describe("aturan murni Telegram", () => {
  test("token dan chat id", () => {
    expect(tokenBotValid("123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw0")).toBe(
      true,
    );
    expect(tokenBotValid("123456789AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw0")).toBe(
      false,
    );
    expect(tokenBotValid("12:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw0")).toBe(false);
    expect(tokenBotValid("123456789:pendek")).toBe(false);
    expect(
      tokenBotValid("123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PAL Dsaw0"),
    ).toBe(false);

    expect(normalisasiChatId("  ")).toBe("");
    expect(normalisasiChatId(" -1001234567890 ")).toBe("-1001234567890");
    expect(normalisasiChatId("12345")).toBe("12345");
    expect(normalisasiChatId("-")).toBeNull();
    expect(normalisasiChatId("https://t.me/+abc")).toBeNull();
    expect(normalisasiChatId("@grupku")).toBeNull();
  });

  test("samarkan dan potong", () => {
    expect(
      samarkanToken("gagal ke /bot123:ABC/sendMessage dan 123:ABC", "123:ABC"),
    ).toBe("gagal ke /bot***/sendMessage dan ***");
    expect(samarkanToken("apa adanya", "")).toBe("apa adanya");
    expect(potong("  pendek  ", 10)).toBe("pendek");
    expect(potong("ééééé", 5)).toBe("ééééé");
    expect(potong("ééééééé", 5)).toBe("éééé…");
  });

  test("isi pesan pengajuan", () => {
    expect(
      pesanPengajuanBaru({
        nomor: "PB-2026-0012",
        keperluan: "Alat tulis",
        total: 2_450_000,
        jumlahBaris: 6,
        pengaju: "Sarpras",
        caraBayar: "Tunai",
      }),
    ).toBe(
      "📦 Pengajuan pembelian baru: PB-2026-0012\nKeperluan: Alat tulis\nTotal: Rp2.450.000 (6 barang)\nDiajukan oleh: Sarpras\nMenunggu ACC di aplikasi.",
    );
    expect(
      pesanPengajuanBaru({
        nomor: "PB-1",
        keperluan: "Laptop",
        total: 9_000_000,
        jumlahBaris: 1,
        pengaju: "Budi",
        caraBayar: "Cicilan",
      }),
    ).toBe(
      "📦 Pengajuan pembelian baru: PB-1\nKeperluan: Laptop\nTotal: Rp9.000.000 (1 barang)\nCara bayar: Cicilan\nDiajukan oleh: Budi\nMenunggu ACC di aplikasi.",
    );
    expect(
      pesanPengajuanPutus({
        nomor: "PB-1",
        keperluan: "Laptop",
        total: 9_000_000,
        disetujui: true,
        pemutus: "Bendahara",
        catatan: "",
      }),
    ).toBe(
      "✅ Pengajuan PB-1 disetujui\nKeperluan: Laptop\nTotal: Rp9.000.000\nDisetujui oleh: Bendahara",
    );
    expect(
      pesanPengajuanPutus({
        nomor: "PB-1",
        keperluan: "Laptop",
        total: 9_000_000,
        disetujui: false,
        pemutus: "Bendahara",
        catatan: "Anggaran habis",
      }),
    ).toBe(
      "❌ Pengajuan PB-1 ditolak\nKeperluan: Laptop\nTotal: Rp9.000.000\nDitolak oleh: Bendahara\nAlasan: Anggaran habis",
    );
  });

  test("isi pesan stok", () => {
    expect(pesanStokMenipis([])).toBeNull();
    const barang = (i: number): BarisStokMenipis => ({
      kode: `BRG-${i}`,
      nama: "Kertas A4",
      satuan: "rim",
      desimal: false,
      stok: 3,
      minimum: 10,
    });
    expect(
      pesanStokMenipis([
        barang(1),
        {
          kode: "BRG-2",
          nama: "Cairan pel",
          satuan: "liter",
          desimal: true,
          stok: 150,
          minimum: 500,
        },
      ]),
    ).toBe(
      "⚠️ 2 barang di bawah stok minimum\n• Kertas A4 (BRG-1): 3 dari minimum 10 rim\n• Cairan pel (BRG-2): 1,50 dari minimum 5 liter",
    );
    const pesan =
      pesanStokMenipis(Array.from({ length: 32 }, (_, i) => barang(i + 1))) ??
      "";
    expect(pesan.startsWith("⚠️ 32 barang di bawah stok minimum\n")).toBe(true);
    expect(
      pesan.endsWith(
        "• Kertas A4 (BRG-30): 3 dari minimum 10 rim\ndan 2 barang lainnya.",
      ),
    ).toBe(true);
  });

  test("permintaan dan galat", () => {
    expect(permintaanKirim("1:A", "-100", "Halo")).toEqual({
      url: "https://api.telegram.org/bot1:A/sendMessage",
      body: { chat_id: "-100", text: "Halo", disable_web_page_preview: true },
    });
    expect(galatTelegram(200, '{"ok":true,"result":{}}')).toBeNull();
    expect(
      galatTelegram(
        400,
        '{"ok":false,"error_code":400,"description":"Bad Request: chat not found"}',
      ),
    ).toBe("Telegram: Bad Request: chat not found");
    expect(galatTelegram(502, "<html>")).toBe("Telegram: HTTP 502");
    expect(galatTelegram(200, '{"ok":false}')).toBe("Telegram: HTTP 200");
  });

  test("grup dari getUpdates", () => {
    const respons = {
      ok: true,
      result: [
        {
          update_id: 1,
          my_chat_member: {
            chat: { id: -100111, title: "Inventaris", type: "supergroup" },
            new_chat_member: { status: "member" },
          },
        },
        {
          update_id: 2,
          message: {
            chat: { id: 555, first_name: "Budi", type: "private" },
            text: "/start",
          },
        },
        {
          update_id: 3,
          message: {
            chat: { id: -222, title: "Keuangan", type: "group" },
            text: "/start",
          },
        },
        {
          update_id: 4,
          edited_message: {
            chat: {
              id: -100111,
              title: "Inventaris Kantor",
              type: "supergroup",
            },
          },
        },
        {
          update_id: 5,
          my_chat_member: {
            chat: { id: -333, title: "Lama", type: "group" },
            new_chat_member: { status: "member" },
          },
        },
        {
          update_id: 6,
          my_chat_member: {
            chat: { id: -333, title: "Lama", type: "group" },
            new_chat_member: { status: "kicked" },
          },
        },
        { update_id: 7, message: { chat: { id: "-444", type: "group" } } },
      ],
    };
    expect(grupDariUpdates(respons)).toEqual([
      { id: "-100111", judul: "Inventaris Kantor" },
      { id: "-222", judul: "Keuangan" },
    ]);
    expect(grupDariUpdates({ ok: false })).toEqual([]);
  });

  test("isi pesan keuangan", () => {
    expect(labelBulan("2026-01")).toBe("Januari 2026");
    expect(labelBulan("2026-13")).toBe("2026-13");
    expect(labelBulan("")).toBe("");
    expect(statusSetelahGagal(0)).toEqual({ status: "Menunggu", percobaan: 1 });
    expect(statusSetelahGagal(1)).toEqual({ status: "Menunggu", percobaan: 2 });
    expect(statusSetelahGagal(2)).toEqual({ status: "Gagal", percobaan: 3 });
    expect(pesanKasbonBaru(2_000_000, 500_000, "2026-12")).toBe(
      "💰 Pengajuan kasbon baru\nPokok: Rp2.000.000\nCicilan: Rp500.000 per bulan, mulai potong gaji Desember 2026\nMenunggu keputusan di aplikasi.",
    );
    expect(pesanTutupBuku("2026-09-30", "Bendahara", false)).toBe(
      "🔒 Buku ditutup sampai 30/09/2026\nOleh: Bendahara",
    );
    expect(pesanTutupBuku("2026-09-30", "Bendahara", true)).toBe(
      "🔒 Buku ditutup sampai 30/09/2026\nOleh: Bendahara\nBentrok dengan tutup buku lain, menunggu keputusan di aplikasi.",
    );
    expect(pesanBukaBuku("2026-09-30", "Kepala TU", "Salah input jurnal")).toBe(
      "🔓 Buku dibuka kembali (tutup sampai 30/09/2026)\nOleh: Kepala TU\nAlasan: Salah input jurnal",
    );
    expect(pesanBukaBuku("2026-09-30", "Kepala TU", " ")).toBe(
      "🔓 Buku dibuka kembali (tutup sampai 30/09/2026)\nOleh: Kepala TU",
    );
  });

  test("isi pesan gaji", () => {
    const isi = {
      status: "REVIEWED",
      periodeAwal: "2026-10-01",
      periodeAkhir: "2026-10-31",
      pegawai: 42,
      totalBersih: 187_400_000,
      oleh: "Bendahara",
      catatan: "",
    };
    expect(pesanGajiStatus(isi)).toBe(
      "💼 Proses gaji 01/10/2026–31/10/2026 menunggu persetujuan\n42 pegawai · total bersih Rp187.400.000\nOleh: Bendahara",
    );
    expect(
      pesanGajiStatus({
        ...isi,
        status: "PAID",
        periodeAwal: "2026-09-26",
        periodeAkhir: "2026-10-25",
        pegawai: 40,
        totalBersih: 150_000_000,
        catatan: "transfer",
      }),
    ).toBe(
      "💼 Proses gaji 26/09/2026–25/10/2026 sudah dibayar\n40 pegawai · total bersih Rp150.000.000\nOleh: Bendahara",
    );
    expect(
      pesanGajiStatus({
        ...isi,
        status: "REJECTED",
        oleh: "Direktur",
        catatan: "Lembur belum diverifikasi",
      }),
    ).toBe(
      "💼 Proses gaji 01/10/2026–31/10/2026 ditolak\n42 pegawai · total bersih Rp187.400.000\nOleh: Direktur\nAlasan: Lembur belum diverifikasi",
    );
    expect(
      pesanGajiStatus({
        ...isi,
        status: "SUBMITTED",
        totalBersih: 1,
        oleh: "x",
      }),
    ).toBeNull();
    const kecil = {
      ...isi,
      status: "APPROVED",
      totalBersih: 9_000_000,
      oleh: "Direktur",
    };
    expect(pesanGajiStatus({ ...kecil, pegawai: 2 })).toBe(
      "💼 Proses gaji 01/10/2026–31/10/2026 disetujui\n2 pegawai\nOleh: Direktur",
    );
    expect(pesanGajiStatus({ ...kecil, pegawai: 3 })).toBe(
      "💼 Proses gaji 01/10/2026–31/10/2026 disetujui\n3 pegawai · total bersih Rp9.000.000\nOleh: Direktur",
    );
  });

  test("pemetaan kejadian", () => {
    expect(BIDANG_KEJADIAN.gaji_status).toBe("pimpinan");
    expect(BIDANG_KEJADIAN.buka_buku_pimpinan).toBe("pimpinan");
    expect(BIDANG_KEJADIAN.kasbon_baru).toBe("keuangan");
    expect(BIDANG_KEJADIAN.tutup_buku).toBe("keuangan");
    expect(BIDANG_KEJADIAN.pengajuan_baru).toBe("keuangan");
    expect(BIDANG_KEJADIAN.pengajuan_putus).toBe("inventaris");
    expect(BIDANG_KEJADIAN.stok_menipis).toBe("inventaris");
    for (const kejadian of TELEGRAM_KEJADIAN.slice(7, 13)) {
      expect(BIDANG_KEJADIAN[kejadian]).toBe("armada");
    }
    for (const kejadian of TELEGRAM_KEJADIAN.slice(13)) {
      expect(kejadian.startsWith("hr_")).toBe(true);
      expect(BIDANG_KEJADIAN[kejadian]).toBe("hrd");
    }
    expect(LABEL_BIDANG.hrd).toBe("HRD");
    for (const { kejadian } of TRIP_TUTUP) {
      expect(TELEGRAM_KEJADIAN).toContain(kejadian);
    }
    expect(idTripKendala("lap-1")).toBe("drv-kendala:lap-1");
    expect(idTripGantiIzin("lap-2")).toBe("drv-ganti:lap-2");
    expect(idTripLokasiPalsu("lap-3")).toBe("drv-palsu:lap-3");
    expect(idHrKontrak("ktr-1", 30, 7)).toBe("hr-kontrak:ktr-1:jauh");
    expect(idHrKontrak("ktr-1", 8, 7)).toBe("hr-kontrak:ktr-1:jauh");
    expect(idHrKontrak("ktr-1", 7, 7)).toBe("hr-kontrak:ktr-1:dekat");
    expect(idHrKontrak("ktr-1", 0, 7)).toBe("hr-kontrak:ktr-1:dekat");
    // Angka diubah: id tetap menurut tahap, bukan angkanya (Q-116).
    expect(idHrKontrak("ktr-1", 8, 10)).toBe("hr-kontrak:ktr-1:dekat");
    expect(idHrKontrak("ktr-1", 20, 3)).toBe("hr-kontrak:ktr-1:jauh");
    expect(idHrPercobaan("ktr-1")).toBe("hr-coba:ktr-1");
    expect(idHrDokumen("dok-1", "2026-12-12")).toBe("hr-dok:dok-1:2026-12-12");
    expect(idHrSp("sp-1")).toBe("hr-sp:sp-1");
    expect(idHrMenunggu("2026-11-12")).toBe("hr-tunggu:2026-11-12");
    expect(idHrUrgent("2026-11-12")).toBe("hr-urgent:2026-11-12");
    expect(idHrUltah("2026-11-12")).toBe("hr-ultah:2026-11-12");
    expect(TELEGRAM_KEJADIAN).toHaveLength(26);
    expect(idHrKinerjaTunggu("2026-11-12")).toBe(
      "hr-kinerja-tunggu:2026-11-12",
    );
    expect(idHrKinerjaPeriode("2026-01-01")).toBe(
      "hr-kinerja-periode:2026-01-01",
    );
    expect(idHrPelamar("2026-11-12")).toBe("hr-pelamar:2026-11-12");
    expect(idHrLowongan("L4", "2026-11-14")).toBe("hr-lowongan:L4:2026-11-14");
    expect(idHrAjuan("p1")).toBe("hr-ajuan:p1");
    expect(idHrPutus("q5")).toBe("hr-putus:q5");
    expect(TELEGRAM_INSERT_ANTREAN_PARKIR_SQL).toContain(`'${KLAIM_PARKIR}'`);
  });

  // Vektor yang sama diuji di `desktop/telegram.rs` (`izin_kartu_perhatian`).
  test("izin kartu perhatian", () => {
    const tidakAda = {
      kontrak: false,
      dokumen: false,
      sp: false,
      pengajuan: false,
      hanyaReimburse: false,
      rekrutmen: false,
      kinerja: false,
    };
    const dari = (izin: string[]) => izinPerhatian((p) => izin.includes(p));
    expect(dari(["employees.view"])).toEqual({
      ...tidakAda,
      kontrak: true,
      hanyaReimburse: true,
    });
    expect(dari(["reimburse.decide"])).toEqual({
      ...tidakAda,
      pengajuan: true,
      hanyaReimburse: true,
    });
    expect(
      dari([
        "hr.request.view",
        "hr.recruit.manage",
        "hr.warning.view",
        "hr.document.view",
      ]),
    ).toEqual({
      ...tidakAda,
      dokumen: true,
      sp: true,
      pengajuan: true,
      rekrutmen: true,
    });
    expect(izinPerhatian(() => true)).toEqual({
      kontrak: true,
      dokumen: true,
      sp: true,
      pengajuan: true,
      hanyaReimburse: false,
      rekrutmen: true,
      kinerja: true,
    });
    // Kinerja (Q-122): `view` atau `finalize`; `assess` saja tidak membuka.
    for (const izin of ["hr.performance.view", "hr.performance.finalize"]) {
      expect(dari([izin])).toEqual({
        ...tidakAda,
        kinerja: true,
        hanyaReimburse: true,
      });
    }
    expect(dari(["hr.performance.assess"])).toEqual({
      ...tidakAda,
      hanyaReimburse: true,
    });
    expect(IZIN_PERHATIAN as readonly string[]).not.toContain(
      "hr.performance.assess",
    );
    const rust = bacaTelegramRs();
    for (const sql of [
      PERHATIAN_SQL_KONTRAK,
      PERHATIAN_SQL_DOKUMEN,
      PERHATIAN_SQL_SP,
      PERHATIAN_SQL_ULTAH,
    ]) {
      harapSqlDiRust(rust, sql);
      for (const terlarang of [
        "nik",
        "hr_profil",
        "nominal",
        "alasan",
        "pelanggaran",
        "harapan",
        "nomor",
        "hr_pelamar",
      ]) {
        expect(sql).not.toMatch(new RegExp(`\\b${terlarang}\\b`));
      }
    }
    expect(rust).toContain(
      `pub const IZIN_PERHATIAN: [&str; ${IZIN_PERHATIAN.length}] = [\n${IZIN_PERHATIAN.map((izin) => `    "${izin}",\n`).join("")}];`,
    );
  });

  // Vektor yang sama diuji di `desktop/telegram.rs` (`baris_parkir_tidak_disentuh_predikat_lama`).
  test("parkir klaim", () => {
    expect(TELEGRAM_KEJADIAN.filter(diparkir)).toEqual(
      TELEGRAM_KEJADIAN.slice(13),
    );
    expect(diparkir("gaji")).toBe(false);
    expect(klaimSetelahGagal("hr_sp_berakhir", "Menunggu")).toEqual({
      klaimOleh: "gen:2",
      klaimSampai: "9999-12-31 23:59:59",
    });
    expect(klaimSetelahGagal("hr_ulang_tahun_kerja", "Gagal")).toEqual({
      klaimOleh: null,
      klaimSampai: null,
    });
    expect(klaimSetelahGagal("stok_menipis", "Menunggu")).toEqual({
      klaimOleh: null,
      klaimSampai: null,
    });
    expect(klaimSetelahGagal("trip_kendala", "Menunggu")).toEqual({
      klaimOleh: null,
      klaimSampai: null,
    });
    const rust = bacaTelegramRs();
    for (const sql of [
      TELEGRAM_DRAIN_PILIH_SQL,
      TELEGRAM_DRAIN_BATAL_SQL,
      TELEGRAM_DRAIN_KLAIM_SQL,
      TELEGRAM_DRAIN_GAGAL_SQL,
    ]) {
      expect(rust).toContain(`"${sql}"`);
    }
  });

  test("SQL HRD disalin harfiah ke telegram.rs dan tidak membaca kolom terlarang", () => {
    const rust = bacaTelegramRs();
    const daftar = [
      TELEGRAM_INSERT_ANTREAN_PARKIR_SQL,
      TELEGRAM_SQL_HR_KONTRAK,
      TELEGRAM_SQL_HR_PERCOBAAN,
      TELEGRAM_SQL_HR_DOKUMEN,
      TELEGRAM_SQL_HR_SP,
      TELEGRAM_SQL_HR_MENUNGGU,
      TELEGRAM_SQL_HR_URGENT,
      TELEGRAM_SQL_HR_ULTAH,
    ];
    for (const sql of [...daftar, TELEGRAM_SQL_JAM_WIB]) {
      harapSqlDiRust(rust, sql);
    }
    // Angka yang bisa diatur dibaca lewat fragmen, bukan literal (§24.3).
    expect(TELEGRAM_SQL_HR_KONTRAK).toContain(INGAT_KONTRAK_JAUH_SQL);
    expect(TELEGRAM_SQL_HR_KONTRAK).toContain(INGAT_KONTRAK_DEKAT_SQL);
    expect(TELEGRAM_SQL_HR_PERCOBAAN).toContain(INGAT_PERCOBAAN_SQL);
    expect(TELEGRAM_SQL_HR_DOKUMEN).toContain(INGAT_DOKUMEN_SQL);
    expect(TELEGRAM_SQL_HR_MENUNGGU).toContain(INGAT_MENUNGGU_SQL);
    expect(TELEGRAM_SQL_JAM_WIB).toContain(INGAT_JAM_SQL);
    expect(rust).not.toContain("pub const HR_HARI_");
    expect(rust).toContain(
      `pub(crate) const KLAIM_PARKIR: &str = "${KLAIM_PARKIR}";`,
    );
    // Q-32 / §23.3: kolom yang tidak pernah boleh terkirim tidak dibaca.
    for (const sql of daftar) {
      for (const terlarang of [
        "nik",
        "hr_profil",
        "nominal",
        "alasan",
        "alasan_tingkat",
        "alasan_cabut",
        "pelanggaran",
        "harapan",
        "nomor",
        "hr_pelamar",
        "hr_lowongan",
      ]) {
        expect(sql).not.toMatch(new RegExp(`\\b${terlarang}\\b`));
      }
    }
  });

  test("SQL perjalanan disalin harfiah ke telegram.rs", () => {
    const rust = bacaTelegramRs();
    for (const sql of [
      TELEGRAM_SQL_TRIP_KENDALA,
      TELEGRAM_SQL_TRIP_TUTUP,
      TELEGRAM_SQL_TRIP_GANTI_IZIN,
      TELEGRAM_SQL_TRIP_LOKASI_PALSU,
      TELEGRAM_SQL_TRIP_LAPORAN,
      TELEGRAM_SQL_NAMA_PERSONIL,
      TELEGRAM_SQL_LABEL_KENDARAAN,
    ]) {
      expect(rust).toContain(`"${sql}"`);
    }
    expect(rust).toContain(
      '("Tidak Jalan", "trip_tidak_jalan", "drv-tidak-jalan:")',
    );
  });

  // Vektor yang sama diuji di `desktop/telegram.rs` (`isi_pesan_hrd`).
  test("isi pesan HRD", () => {
    expect(sisaHari(0)).toBe("hari ini");
    expect(sisaHari(7)).toBe("7 hari lagi");
    expect(
      pesanHrKontrakAkhir({
        nama: "Budi Santoso",
        jabatan: "Staf Gudang",
        tanggal: "2026-12-12",
        sisa: 30,
      }),
    ).toBe(
      "📄 Kontrak PKWT berakhir 30 hari lagi (12/12/2026)\nKaryawan: Budi Santoso · Staf Gudang",
    );
    expect(
      pesanHrKontrakAkhir({
        nama: "Budi Santoso",
        jabatan: "",
        tanggal: "2026-11-12",
        sisa: 0,
      }),
    ).toBe(
      "📄 Kontrak PKWT berakhir hari ini (12/11/2026)\nKaryawan: Budi Santoso",
    );
    expect(
      pesanHrPercobaanAkhir({
        nama: "Sari",
        jabatan: "Kasir",
        tanggal: "2026-11-15",
        sisa: 3,
      }),
    ).toBe(
      "⏳ Masa percobaan berakhir 3 hari lagi (15/11/2026)\nKaryawan: Sari · Kasir",
    );
    expect(
      pesanHrDokumenKedaluwarsa({
        jenisDokumen: "SIM B1",
        nama: "Andi",
        jabatan: "Driver",
        tanggal: "2026-11-19",
        sisa: 7,
      }),
    ).toBe(
      "🪪 Dokumen SIM B1 kedaluwarsa 7 hari lagi (19/11/2026)\nKaryawan: Andi · Driver",
    );
    expect(
      pesanHrSpBerakhir({
        tingkat: "SP2",
        nama: "Andi",
        jabatan: "Driver",
        tanggal: "2026-11-12",
      }),
    ).toBe("📋 Masa berlaku SP2 berakhir 12/11/2026\nKaryawan: Andi · Driver");
    expect(
      pesanHrPengajuanMenunggu(
        [
          { kelompok: "Cuti", jumlah: 3 },
          { kelompok: "Izin", jumlah: 1 },
          { kelompok: "Reimburse", jumlah: 2 },
        ],
        "2026-11-08",
        2,
      ),
    ).toBe(
      "📥 6 pengajuan menunggu lebih dari 2 hari\nCuti 3, Izin 1, Reimburse 2\nPaling lama sejak 08/11/2026",
    );
    expect(
      pesanHrPengajuanMenunggu(
        [{ kelompok: "Cuti", jumlah: 1 }],
        "2026-11-01",
        5,
      ),
    ).toBe(
      "📥 1 pengajuan menunggu lebih dari 5 hari\nCuti 1\nPaling lama sejak 01/11/2026",
    );
    expect(pesanHrPengajuanMenunggu([], "2026-11-08", 2)).toBeNull();
    expect(pesanHrUrgentBelumDiketahui(2, "2026-11-10")).toBe(
      "⚡ 2 pengajuan urgent belum diketahui HRD\nPaling lama sejak 10/11/2026",
    );
    expect(pesanHrUrgentBelumDiketahui(0, "2026-11-10")).toBeNull();

    expect(pesanHrUlangTahunKerja([])).toBeNull();
    expect(
      pesanHrUlangTahunKerja([
        { nama: "Budi", jabatan: "Staf Gudang", tahun: 3 },
        { nama: "Sari", jabatan: "", tahun: 1 },
      ]),
    ).toBe(
      "🎉 Ulang tahun kerja hari ini\n• Budi (Staf Gudang), 3 tahun\n• Sari, 1 tahun",
    );
    const pesan =
      pesanHrUlangTahunKerja(
        Array.from({ length: 32 }, (_, i) => ({
          nama: `Karyawan ${i + 1}`,
          jabatan: "Staf",
          tahun: 2,
        })),
      ) ?? "";
    expect(
      pesan.startsWith(
        "🎉 Ulang tahun kerja hari ini\n• Karyawan 1 (Staf), 2 tahun\n",
      ),
    ).toBe(true);
    expect(
      pesan.endsWith("• Karyawan 30 (Staf), 2 tahun\ndan 2 lainnya."),
    ).toBe(true);
  });

  // Vektor yang sama diuji di `desktop/telegram.rs` (`isi_pesan_perjalanan`).
  test("isi pesan perjalanan", () => {
    const isi: IsiLaporanPerjalanan = {
      nomor: "SJ-2611-WAB12-001",
      driver: "Budi Santoso",
      kendaraan: "CDD B 1234 XYZ",
      tempat: "Tol Cikampek KM 57",
      keterangan: "Radiator bocor",
      waktu: "2026-11-09 14:32:05",
      telatMenit: 0,
    };
    expect(
      pesanTripKendala({
        ...isi,
        jenisKendala: "Kendaraan Rusak",
        terlambatMenit: 90,
      }),
    ).toBe(
      "🚧 Kendala Kendaraan Rusak: SJ-2611-WAB12-001\nDriver: Budi Santoso · CDD B 1234 XYZ\nTempat: Tol Cikampek KM 57\nPerkiraan terlambat: 90 menit\nKeterangan: Radiator bocor\nWaktu: 09/11/2026 14:32:05 WIB",
    );
    const polos = {
      ...isi,
      kendaraan: "",
      tempat: "",
      keterangan: "",
      telatMenit: 31,
    };
    expect(
      pesanTripKendala({ ...polos, jenisKendala: "", terlambatMenit: 0 }),
    ).toBe(
      "🚧 Kendala: SJ-2611-WAB12-001\nDriver: Budi Santoso\nWaktu: 09/11/2026 14:32:05 WIB\nDikirim terlambat (offline).",
    );
    expect(
      pesanTripKendala({
        ...polos,
        telatMenit: 30,
        jenisKendala: "Macet",
        terlambatMenit: null,
      }),
    ).not.toContain("terlambat");

    const selesai = { ...isi, tempat: "Gudang Cikarang 2", keterangan: "" };
    expect(pesanTripTutup({ ...selesai, jenis: "Selesai", oleh: "" })).toBe(
      "🏁 Surat jalan SJ-2611-WAB12-001 selesai\nDriver: Budi Santoso · CDD B 1234 XYZ\nTempat: Gudang Cikarang 2\nWaktu: 09/11/2026 14:32:05 WIB",
    );
    expect(
      pesanTripTutup({
        ...isi,
        tempat: "",
        keterangan: "HP driver mati",
        jenis: "Selesai",
        oleh: "Dispatcher 1",
      }),
    ).toBe(
      "🏁 Surat jalan SJ-2611-WAB12-001 selesai\nDriver: Budi Santoso · CDD B 1234 XYZ\nOleh: Dispatcher 1\nAlasan: HP driver mati\nWaktu: 09/11/2026 14:32:05 WIB",
    );
    expect(
      pesanTripTutup({
        ...isi,
        tempat: "",
        keterangan: "Diterima satpam",
        jenis: "Selesai",
        oleh: "",
      }),
    ).toBe(
      "🏁 Surat jalan SJ-2611-WAB12-001 selesai\nDriver: Budi Santoso · CDD B 1234 XYZ\nCatatan: Diterima satpam\nWaktu: 09/11/2026 14:32:05 WIB",
    );
    const batal = {
      ...isi,
      tempat: "",
      keterangan: "Pelanggan menunda",
      telatMenit: 45,
      oleh: "Dispatcher 1",
    };
    expect(pesanTripTutup({ ...batal, jenis: "Tidak Jalan" })).toBe(
      "⛔ Surat jalan SJ-2611-WAB12-001 tidak jalan\nDriver: Budi Santoso · CDD B 1234 XYZ\nOleh: Dispatcher 1\nAlasan: Pelanggan menunda\nWaktu: 09/11/2026 14:32:05 WIB\nDikirim terlambat (offline).",
    );
    expect(
      pesanTripTutup({ ...batal, jenis: "Dibatalkan" })?.split("\n")[0],
    ).toBe("🛑 Surat jalan SJ-2611-WAB12-001 dibatalkan");
    expect(pesanTripTutup({ ...batal, jenis: "Kendala", oleh: "" })).toBeNull();

    expect(
      pesanTripGantiIzin({
        ...isi,
        keterangan: "Mesin mati",
        gantiDriver: false,
        darurat: true,
        dari: "CDD B 1234 XYZ",
        ke: "CDE B 999 AA",
      }),
    ).toBe(
      "🔁 Ganti kendaraan darurat: SJ-2611-WAB12-001\nDari: CDD B 1234 XYZ\nKe: CDE B 999 AA\nDilaporkan oleh: Budi Santoso\nAlasan: Mesin mati\nSudah berlaku. Setujui atau tolak di aplikasi.\nWaktu: 09/11/2026 14:32:05 WIB",
    );
    expect(
      pesanTripGantiIzin({
        ...isi,
        keterangan: "",
        driver: "Andi",
        gantiDriver: true,
        darurat: false,
        dari: "Budi Santoso",
        ke: "Andi",
      }),
    ).toBe(
      "🔁 Minta izin ganti driver: SJ-2611-WAB12-001\nDari: Budi Santoso\nKe: Andi\nDilaporkan oleh: Andi\nBerlaku setelah disetujui di aplikasi.\nWaktu: 09/11/2026 14:32:05 WIB",
    );

    expect(
      pesanTripLokasiPalsu({ ...selesai, jenisLaporan: "Tiba Bongkar" }),
    ).toBe(
      "⚠️ Perlu ditinjau: lokasi palsu terdeteksi\nSurat jalan: SJ-2611-WAB12-001\nLaporan: Tiba Bongkar · Gudang Cikarang 2\nDriver: Budi Santoso · CDD B 1234 XYZ\nWaktu: 09/11/2026 14:32:05 WIB",
    );
    expect(pesanTripLokasiPalsu({ ...polos, jenisLaporan: "Berangkat" })).toBe(
      "⚠️ Perlu ditinjau: lokasi palsu terdeteksi\nSurat jalan: SJ-2611-WAB12-001\nLaporan: Berangkat\nDriver: Budi Santoso\nWaktu: 09/11/2026 14:32:05 WIB\nDikirim terlambat (offline).",
    );
  });
});

// Vektor yang sama diuji di `desktop/telegram.rs` (`ringkas_kinerja` dan
// `isi_pesan_hrd_fase9`).
describe("kejadian HR fase 9", () => {
  const kk = (id: string, jenis: string, sidik: string, diterima: string) => ({
    id_keputusan: id,
    jenis,
    sidik,
    oleh: "hrd",
    waktu_perangkat: "2026-11-01 00:00:00.000",
    diterima_cloud: diterima,
  });

  test("periode kinerja berakhir", () => {
    const smt: [string, string] = ["2026-01-01", "2026-06-30"];
    expect(periodeKinerjaBerakhir("Semester", "2026-07-01")).toEqual(smt);
    expect(periodeKinerjaBerakhir("Semester", "2026-07-07")).toEqual(smt);
    expect(periodeKinerjaBerakhir("Semester", "2026-07-08")).toBeNull();
    expect(periodeKinerjaBerakhir("Semester", "2026-06-30")).toBeNull();
    expect(periodeKinerjaBerakhir("Bulanan", "2026-03-01")).toEqual([
      "2026-02-01",
      "2026-02-28",
    ]);
    expect(periodeKinerjaBerakhir("Tahunan", "2027-01-03")).toEqual([
      "2026-01-01",
      "2026-12-31",
    ]);
    expect(periodeKinerjaBerakhir("Kuartal", "2026-01-05")).toEqual([
      "2025-10-01",
      "2025-12-31",
    ]);
    expect(periodeKinerjaBerakhir("Mingguan", "2026-07-01")).toBeNull();
    expect(periodeKinerjaBerakhir("Semester", "bukan")).toBeNull();
    expect(HR_HARI_JENDELA).toBe(7);
  });

  test("ringkas kinerja", () => {
    const tunggu: PenilaianTunggu[] = [
      {
        sidik: "s1",
        sejak: "2026-11-05",
        keputusan: [kk("a1", "Ajukan", "s1", "2026-11-05 03:00:00")],
      },
      {
        sidik: "s2",
        sejak: "2026-11-01",
        keputusan: [
          kk("a2", "Ajukan", "s2", "2026-11-01 03:00:00"),
          kk("b2", "Kembalikan", "s2", "2026-11-01 04:00:00"),
        ],
      },
      {
        sidik: "s3",
        sejak: "2026-11-03",
        keputusan: [
          kk("a3", "Ajukan", "s3", "2026-11-03 05:00:00"),
          kk("b3", "Kembalikan", "s3", "2026-11-03 04:00:00"),
        ],
      },
      {
        sidik: "s4",
        sejak: "2026-10-01",
        keputusan: [
          kk("a4", "Ajukan", "s4", "2026-10-01 03:00:00"),
          kk("c4", "Batal", "s4", "2026-10-02 03:00:00"),
        ],
      },
    ];
    expect(ringkasKinerjaMenunggu(tunggu)).toEqual({
      jumlah: 2,
      sejak: "2026-11-03",
    });
    expect(ringkasKinerjaMenunggu([])).toEqual({ jumlah: 0, sejak: "" });

    const nilai = (sidik: string, ...keputusan: ReturnType<typeof kk>[]) => ({
      sidik,
      keputusan,
    });
    const karyawan: KaryawanPeriode[] = [
      {
        tanggal_daftar: "2020-01-01",
        tanggal_selesai_aktif: null,
        penilaian: [
          nilai("s1", kk("f1", "Final", "s1", "2026-07-02 00:00:00")),
        ],
      },
      {
        tanggal_daftar: null,
        tanggal_selesai_aktif: null,
        penilaian: [
          nilai("s2", kk("a2", "Ajukan", "s2", "2026-07-02 00:00:00")),
        ],
      },
      {
        tanggal_daftar: "2026-03-01",
        tanggal_selesai_aktif: null,
        penilaian: [],
      },
      {
        tanggal_daftar: "2026-07-01",
        tanggal_selesai_aktif: null,
        penilaian: [],
      },
      {
        tanggal_daftar: null,
        tanggal_selesai_aktif: "2025-12-31",
        penilaian: [],
      },
      {
        tanggal_daftar: null,
        tanggal_selesai_aktif: null,
        penilaian: [
          nilai("s6", kk("c6", "Batal", "s6", "2026-07-02 00:00:00")),
          nilai("s6b"),
        ],
      },
      {
        tanggal_daftar: null,
        tanggal_selesai_aktif: null,
        penilaian: [
          nilai("s7", kk("c7", "Batal", "s7", "2026-07-02 00:00:00")),
        ],
      },
    ];
    expect(ringkasKinerjaPeriode(karyawan, "2026-01-01", "2026-06-30")).toEqual(
      { belum: 2, draf: 1, diajukan: 1 },
    );
  });

  test("isi pesan HRD fase 9", () => {
    expect(pesanHrKinerjaMenunggu(2, "2026-11-03")).toBe(
      "📊 2 penilaian kinerja menunggu Final\nPaling lama sejak 03/11/2026",
    );
    expect(pesanHrKinerjaMenunggu(1, "")).toBe(
      "📊 1 penilaian kinerja menunggu Final",
    );
    expect(pesanHrKinerjaMenunggu(0, "2026-11-03")).toBeNull();
    expect(
      pesanHrKinerjaPeriode("Semester", "2026-01-01", "2026-06-30", {
        belum: 2,
        draf: 1,
        diajukan: 1,
      }),
    ).toBe(
      "📊 Periode Semester 01/01/2026 s.d. 30/06/2026 berakhir: 2 belum dinilai, 1 masih draf, 1 diajukan",
    );
    expect(
      pesanHrKinerjaPeriode("Semester", "2026-01-01", "2026-06-30", {
        belum: 0,
        draf: 0,
        diajukan: 0,
      }),
    ).toBeNull();
    expect(
      pesanHrPelamarBaru([
        { judul: "Admin Gudang", jumlah: 2 },
        { judul: "Sopir", jumlah: 1 },
      ]),
    ).toBe("👥 3 pelamar baru kemarin\n• Admin Gudang: 2\n• Sopir: 1");
    expect(pesanHrPelamarBaru([])).toBeNull();
    const banyak =
      pesanHrPelamarBaru(
        Array.from({ length: 32 }, (_, i) => ({
          judul: `Lowongan ${i + 1}`,
          jumlah: 1,
        })),
      ) ?? "";
    expect(
      banyak.startsWith("👥 32 pelamar baru kemarin\n• Lowongan 1: 1\n"),
    ).toBe(true);
    expect(banyak.endsWith("• Lowongan 30: 1\ndan 2 lainnya.")).toBe(true);
    expect(
      pesanHrLowonganTutup({
        judul: "Admin Gudang",
        tanggal: "2026-11-14",
        sisa: 2,
        pelamar: 3,
        kuota: 2,
      }),
    ).toBe(
      "📢 Lowongan Admin Gudang tutup 2 hari lagi (14/11/2026)\nPelamar: 3 · Kuota: 2",
    );
    expect(
      pesanHrLowonganTutup({
        judul: "Sopir",
        tanggal: "2026-11-12",
        sisa: 0,
        pelamar: 0,
        kuota: 1,
      }),
    ).toBe(
      "📢 Lowongan Sopir tutup hari ini (12/11/2026)\nPelamar: 0 · Kuota: 1",
    );

    const cuti = {
      kelompok: "Cuti",
      nama: "Budi",
      jabatan: "Staf Gudang",
      mulai: "2026-12-01",
      selesai: "2026-12-03",
    };
    const sakit = {
      kelompok: KELOMPOK_TANPA_NAMA,
      nama: "Sari",
      jabatan: "Kasir",
      mulai: "2026-11-12",
      selesai: "2026-11-12",
    };
    const izin = {
      kelompok: "Izin",
      nama: "Budi",
      jabatan: "",
      mulai: "2026-12-05",
      selesai: "2026-12-05",
    };
    expect(pesanHrPengajuanBaru(cuti)).toBe(
      "📝 Pengajuan Cuti baru\nKaryawan: Budi · Staf Gudang\nTanggal: 01/12/2026 s.d. 03/12/2026",
    );
    expect(pesanHrPengajuanBaru(sakit)).toBe(
      "📝 1 pengajuan Sakit baru\nTanggal: 12/11/2026",
    );
    expect(pesanHrPengajuanDiputus(cuti, "Setujui", "HRD Satu")).toBe(
      "✅ Pengajuan Cuti disetujui\nKaryawan: Budi · Staf Gudang\nTanggal: 01/12/2026 s.d. 03/12/2026\nOleh: HRD Satu",
    );
    expect(pesanHrPengajuanDiputus(izin, "Tolak", "hrd")).toBe(
      "❌ Pengajuan Izin ditolak\nKaryawan: Budi\nTanggal: 05/12/2026\nOleh: hrd",
    );
    expect(pesanHrPengajuanDiputus(sakit, "Setujui Urgent", "atasan")).toBe(
      "✅ 1 pengajuan Sakit disetujui (urgent)\nTanggal: 12/11/2026\nOleh: atasan",
    );
    for (const isi of [
      pesanHrPengajuanBaru(sakit),
      pesanHrPengajuanDiputus(sakit, "Tolak", "hrd"),
    ]) {
      expect(isi).not.toContain("Sari");
      expect(isi).not.toContain("Kasir");
    }
  });

  test("SQL HRD fase 9 disalin harfiah ke telegram.rs dan tidak membaca kolom terlarang", () => {
    const rust = bacaTelegramRs();
    const kinerja = [
      TELEGRAM_SQL_HR_KINERJA_MENUNGGU,
      TELEGRAM_SQL_HR_KINERJA_PERIODE,
      TELEGRAM_SQL_HR_KINERJA_JENIS,
    ];
    const rekrutmen = [
      TELEGRAM_SQL_HR_PELAMAR_BARU,
      TELEGRAM_SQL_HR_LOWONGAN_TUTUP,
    ];
    const pengajuan = [
      TELEGRAM_SQL_HR_PENGAJUAN_BARU,
      TELEGRAM_SQL_HR_PENGAJUAN_PUTUS,
    ];
    for (const sql of [...kinerja, ...rekrutmen, ...pengajuan]) {
      expect(rust).toContain(`"${sql}"`);
      for (const terlarang of [
        "nik",
        "hr_profil",
        "nominal",
        "nominal_disetujui",
        "alasan",
        "alasan_koreksi",
        "nilai_akhir",
        "predikat",
        "hr_kinerja_nilai",
        "catatan",
        "pelanggaran",
        "nomor",
      ]) {
        expect(sql).not.toMatch(new RegExp(`\\b${terlarang}\\b`));
      }
    }
    // Rekrutmen: hanya judul dan hitungan, tidak satu kolom pun milik pelamar.
    for (const sql of rekrutmen) {
      for (const terlarang of [
        "nama",
        "no_hp",
        "email",
        "alamat",
        "tanggal_lahir",
        "pendidikan",
        "sumber",
      ]) {
        expect(sql).not.toMatch(new RegExp(`\\b${terlarang}\\b`));
      }
    }
    // Id di `NOT EXISTS` sama dengan fungsi id-nya.
    expect(TELEGRAM_SQL_HR_LOWONGAN_TUTUP).toContain(
      "'hr-lowongan:' || l.id_lowongan || ':' || l.tanggal_tutup",
    );
    expect(TELEGRAM_SQL_HR_PENGAJUAN_BARU).toContain(`'${idHrAjuan("")}'`);
    expect(TELEGRAM_SQL_HR_PENGAJUAN_PUTUS).toContain(`'${idHrPutus("")}'`);
    expect(TELEGRAM_SQL_HR_LOWONGAN_TUTUP).toContain(
      `'+${HR_HARI_LOWONGAN} days'`,
    );
    expect(rust).toContain(
      `pub(crate) const HR_HARI_JENDELA: i64 = ${HR_HARI_JENDELA};`,
    );
    expect(rust).toContain(
      `pub(crate) const KELOMPOK_TANPA_NAMA: &str = "${KELOMPOK_TANPA_NAMA}";`,
    );
  });
});
