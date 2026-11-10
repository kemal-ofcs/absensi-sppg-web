import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  aturanCutiDariPeta,
  CLOUD_INSERT_KEPUTUSAN_SQL,
  hitungCutiDibayar,
  INSERT_PENYESUAIAN_SQL,
  type JenisPengajuan,
  type Kalender,
  type KeadaanAksi,
  type Keputusan,
  kanonikPengajuan,
  LAPORAN_PENGAJUAN_SQL,
  PENGAJUAN_BERLAKU_SQL,
  PENGAJUAN_RENTANG_SQL,
  PERIODE_DIBAYAR_SQL,
  PESAN_TANPA_HARI_KERJA,
  periksaAksi,
  periksaJenis,
  periksaMaks,
  periksaSunting,
  periksaUrgent,
  periodeCuti,
  SEED_JENIS_SQL,
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
} from "./hr-pengajuan";

// Vektor yang sama dengan `mod tests` di `desktop/hr_pengajuan.rs`.

const kep = (
  id: string,
  jenis: string,
  sidik: string,
  oleh: string,
  waktu: string,
  cloud: string | null,
): Keputusan => ({
  id_keputusan: id,
  jenis,
  sidik,
  oleh,
  waktu_perangkat: waktu,
  diterima_cloud: cloud,
});

const gagalDengan = (hasil: { ok: boolean; pesan?: string }) =>
  hasil.ok ? null : hasil.pesan;

describe("hr-pengajuan", () => {
  test("teks SQL kembar dengan Rust", () => {
    const [awalan, akhiran] = PENGAJUAN_RENTANG_SQL.split(
      PENGAJUAN_BERLAKU_SQL,
    );
    for (const dir of ["desktop", "mobile"]) {
      const lokasi = [
        join(import.meta.dir, `../../../src-tauri/src/${dir}/hr_pengajuan.rs`),
        join(
          import.meta.dir,
          `../../../../mobile/src-tauri/src/${dir}/hr_pengajuan.rs`,
        ),
      ].find(existsSync);
      if (!lokasi) continue;
      const rust = readFileSync(lokasi, "utf8").replaceAll("\r\n", "\n");
      for (const sql of [
        SEED_JENIS_SQL,
        PENGAJUAN_BERLAKU_SQL,
        awalan,
        akhiran,
        TANGGAL_HADIR_SQL,
        PERIODE_DIBAYAR_SQL,
        ...LAPORAN_PENGAJUAN_SQL.split(PENGAJUAN_BERLAKU_SQL),
        UPSERT_JENIS_SQL,
        UPSERT_PENGAJUAN_SQL,
        CLOUD_INSERT_KEPUTUSAN_SQL,
        INSERT_PENYESUAIAN_SQL,
        PESAN_TANPA_HARI_KERJA,
      ]) {
        expect(rust.includes(sql ?? "tidak ada")).toBe(true);
      }
    }
  });

  test("teks kanonik sidik", () => {
    expect(
      kanonikPengajuan({
        id_karyawan: "K1",
        id_jenis: "jns-sakit",
        kelompok: "Sakit",
        potong_jatah: false,
        dampak_gaji: "Dibayar",
        tanggal_mulai: "2026-11-02",
        tanggal_selesai: "2026-11-03",
        setengah_hari: false,
        alasan: "Demam",
      }),
    ).toBe(
      "K1\u001fjns-sakit\u001fSakit\u001f0\u001fDibayar\u001f2026-11-02\u001f2026-11-03\u001f0\u001fDemam",
    );
  });

  test("status dan tanda", () => {
    expect(statusPengajuan("s1", [])).toBe("Menunggu");
    const gugur = [
      kep(
        "a",
        "Setujui",
        "lama",
        "hrd",
        "2026-11-01 01:00:00",
        "2026-11-01 01:00:05",
      ),
    ];
    expect(statusPengajuan("s1", gugur)).toBe("Menunggu");
    expect(tandaKeputusan("s1", "atasan", gugur)).toEqual(["keputusan_gugur"]);
    const ganda = [
      kep("b", "Tolak", "s1", "hrd2", "2026-11-01 00:00:00", null),
      kep(
        "a",
        "Setujui",
        "s1",
        "hrd1",
        "2026-11-01 02:00:00",
        "2026-11-01 02:00:01",
      ),
    ];
    expect(statusPengajuan("s1", ganda)).toBe("Disetujui");
    expect(tandaKeputusan("s1", "atasan", ganda)).toEqual(["keputusan_ganda"]);
    const urgent = [
      kep(
        "urgent-p",
        "Setujui Urgent",
        "s1",
        "Atasan",
        "2026-11-01 00:00:00",
        null,
      ),
    ];
    expect(statusPengajuan("s1", urgent)).toBe("Disetujui (urgent)");
    expect(tandaKeputusan("s1", "atasan ", urgent)).toEqual([
      "perlu_diketahui",
    ]);
    const sendiri = [
      kep("c", "Tolak", "s1", "HRD", "2026-11-01 00:00:00", null),
    ];
    expect(tandaKeputusan("s1", "hrd", sendiri)).toEqual(["diputus_sendiri"]);
    const diketahui = [
      ...urgent,
      kep("tahu-p", "Diketahui", "s1", "hrd", "2026-11-01 03:00:00", null),
    ];
    expect(tandaKeputusan("s1", "hrd", diketahui)).toEqual([]);
    const batal = [
      ...urgent,
      kep("batal-p", "Batal", "s1", "hrd", "2026-11-02 00:00:00", null),
    ];
    expect(statusPengajuan("s1", batal)).toBe("Dibatalkan");
    expect(tandaKeputusan("s1", "Atasan", batal)).toEqual([]);
  });

  test("aturan aksi", () => {
    const k = (status: string): KeadaanAksi => ({
      status,
      boleh_putus: true,
      sudah_diketahui: false,
      pengaju_sendiri: false,
      superadmin: false,
      karyawan_sendiri: false,
    });
    const izin = "Kamu tidak punya izin memutus jenis pengajuan ini.";
    const sendiri = "Pengajuan untuk dirimu sendiri harus diputus orang lain.";
    expect(gagalDengan(periksaAksi("Hapus", "", k("Menunggu")))).toBe(
      "Keputusan tidak dikenal.",
    );
    expect(periksaAksi("Setujui", "", k("Menunggu")).ok).toBe(true);
    expect(gagalDengan(periksaAksi("Tolak", " ", k("Menunggu")))).toBe(
      "Alasan penolakan wajib diisi.",
    );
    expect(gagalDengan(periksaAksi("Setujui", "", k("Disetujui")))).toBe(
      "Pengajuan ini tidak lagi menunggu keputusan.",
    );
    expect(
      gagalDengan(
        periksaAksi("Setujui", "", { ...k("Menunggu"), boleh_putus: false }),
      ),
    ).toBe(izin);
    expect(
      gagalDengan(
        periksaAksi("Setujui", "", {
          ...k("Menunggu"),
          karyawan_sendiri: true,
          superadmin: true,
        }),
      ),
    ).toBe(sendiri);
    expect(gagalDengan(periksaAksi("Diketahui", "", k("Disetujui")))).toBe(
      "Hanya pengajuan urgent yang belum diketahui yang bisa ditandai.",
    );
    expect(periksaAksi("Diketahui", "", k("Disetujui (urgent)")).ok).toBe(true);
    expect(gagalDengan(periksaAksi("Batal", "", k("Menunggu")))).toBe(
      "Alasan pembatalan wajib diisi.",
    );
    expect(gagalDengan(periksaAksi("Batal", "Salah", k("Menunggu")))).toBe(
      "Hanya pengaju yang bisa membatalkan pengajuan yang masih menunggu.",
    );
    expect(
      periksaAksi("Batal", "Salah", {
        ...k("Menunggu"),
        pengaju_sendiri: true,
        boleh_putus: false,
      }).ok,
    ).toBe(true);
    expect(
      periksaAksi("Batal", "Ternyata masuk", k("Disetujui (urgent)")).ok,
    ).toBe(true);
    expect(gagalDengan(periksaAksi("Batal", "x", k("Ditolak")))).toBe(
      "Pengajuan yang ditolak atau dibatalkan tidak bisa dibatalkan lagi.",
    );
    expect(
      gagalDengan(periksaAksi("Setujui", "a".repeat(501), k("Menunggu"))),
    ).toBe("Alasan maksimal 500 karakter.");
    expect(gagalDengan(periksaSunting("Disetujui", true, false))).toBe(
      "Pengajuan yang sudah diputus tidak bisa disunting.",
    );
    expect(gagalDengan(periksaSunting("Menunggu", false, false))).toBe(
      "Hanya pengaju yang bisa menyunting pengajuan ini.",
    );
    expect(periksaSunting("Menunggu", false, true).ok).toBe(true);
    expect(periksaUrgent(true).ok).toBe(false);
  });

  test("isian pengajuan dan jenis", () => {
    const dasar = {
      id_karyawan: "K1",
      id_jenis: "jns-izin-dibayar",
      tanggal_mulai: "2026-11-02",
      tanggal_selesai: "2026-11-02",
      setengah_hari: true,
      alasan: "  Urusan bank  ",
    };
    const sah = validasiPengajuan(dasar);
    if (!sah.ok) throw new Error(sah.pesan);
    expect(sah.nilai.alasan).toBe("Urusan bank");
    expect(sah.nilai.setengah_hari && !sah.nilai.urgent).toBe(true);
    const salah = (ubah: Record<string, unknown>) =>
      gagalDengan(validasiPengajuan({ ...dasar, ...ubah }));
    expect(salah({ id_karyawan: "" })).toBe("Pilih karyawan.");
    expect(salah({ id_jenis: " " })).toBe("Pilih jenis pengajuan.");
    expect(salah({ tanggal_mulai: "2026-02-30" })).toBe(
      "Tanggal pengajuan tidak valid.",
    );
    expect(salah({ tanggal_mulai: "2026-11-03", setengah_hari: false })).toBe(
      "Tanggal selesai tidak boleh sebelum tanggal mulai.",
    );
    expect(salah({ tanggal_mulai: "2025-11-01", setengah_hari: false })).toBe(
      "Rentang pengajuan paling panjang 366 hari.",
    );
    expect(salah({ tanggal_selesai: "2026-11-03" })).toBe(
      "Setengah hari hanya untuk satu tanggal.",
    );
    expect(salah({ alasan: "" })).toBe("Alasan wajib diisi.");

    const jenis: JenisPengajuan = {
      id_jenis: "jns-cuti-menikah",
      nama: "Cuti Menikah",
      kelompok: "Cuti",
      izin_pemutus: "hr.request.decide",
      boleh_urgent: false,
      potong_jatah: false,
      dampak_gaji: "Dibayar",
      maks_hari: 3,
      satuan_maks: "Hari Kerja",
      wajib_dokumen: false,
      is_aktif: true,
    };
    expect(gagalDengan(periksaJenis(sah.nilai, jenis))).toBe(
      "Setengah hari hanya untuk kelompok Izin.",
    );
    expect(
      gagalDengan(
        periksaJenis(
          { ...sah.nilai, setengah_hari: false, urgent: true },
          jenis,
        ),
      ),
    ).toBe("Jenis pengajuan ini tidak boleh urgent.");
    expect(periksaMaks(jenis, 3, 5).ok).toBe(true);
    expect(gagalDengan(periksaMaks(jenis, 4, 4))).toBe(
      "Cuti Menikah paling lama 3 hari kerja.",
    );
    expect(
      gagalDengan(
        periksaMaks({ ...jenis, satuan_maks: "Hari Kalender" }, 2, 4),
      ),
    ).toBe("Cuti Menikah paling lama 3 hari kalender.");

    const j = validasiJenis({
      nama: " Cuti Khusus ",
      kelompok: "Cuti",
      dampak_gaji: "Dibayar",
      maks_hari: 5,
      potong_jatah: 1,
    });
    if (!j.ok) throw new Error(j.pesan);
    expect([
      j.nilai.nama,
      j.nilai.maks_hari,
      j.nilai.satuan_maks,
      j.nilai.is_aktif,
    ]).toEqual(["Cuti Khusus", 5, "Hari Kerja", true]);
    expect(
      gagalDengan(
        validasiJenis({
          nama: "Lembur",
          kelompok: "Lembur",
          dampak_gaji: "Dibayar",
        }),
      ),
    ).toBe("Kelompok harus Cuti, Izin, atau Sakit.");
    expect(
      gagalDengan(
        validasiJenis({
          nama: "X",
          kelompok: "Izin",
          dampak_gaji: "Dibayar",
          potong_jatah: true,
        }),
      ),
    ).toBe("Hanya kelompok Cuti yang bisa memotong jatah cuti.");
    expect(
      gagalDengan(
        validasiJenis({
          nama: "X",
          kelompok: "Izin",
          dampak_gaji: "Dibayar",
          maks_hari: 0,
        }),
      ),
    ).toBe("Batas hari harus 1 sampai 366.");
  });

  test("hari wajib dan cuti dibayar", () => {
    const jadwal = {
      hari_masuk: [1, 2, 3, 4, 5],
      divisi: "Kantor",
      kode_shift: 1,
      jam_normal_menit: 480,
    };
    const kalender: Kalender = {
      libur: new Set(["2026-11-04"]),
      whitelist: [],
    };
    expect(tanggalWajib(jadwal, kalender, "2026-11-01", "2026-11-08")).toEqual([
      "2026-11-02",
      "2026-11-03",
      "2026-11-05",
      "2026-11-06",
    ]);
    kalender.whitelist.push({
      id: "1",
      scope_type: "DIVISI",
      scope_value: "Kantor",
      tanggal_libur: null,
      keterangan: null,
      status_aktif: 1,
    });
    expect(tanggalWajib(jadwal, kalender, "2026-11-04", "2026-11-04")).toEqual([
      "2026-11-04",
    ]);
    const hadir = new Set(["2026-11-03", "2026-11-05"]);
    expect(
      hitungCutiDibayar(
        [
          ["2026-11-02", false],
          ["2026-11-03", false],
          ["2026-11-05", true],
          ["2026-11-06", true],
          ["2026-11-06", false],
        ],
        hadir,
        480,
      ),
    ).toEqual([2, 1200]);
    expect(hitungCutiDibayar([["2026-11-09", true]], new Set(), 481)).toEqual([
      1, 240,
    ]);
    expect(upahHarian("FLAT_DAILY", 150_000, 0, 480)).toBe(150_000);
    expect(upahHarian("HOURLY", 0, 25_001, 450)).toBe(187_508);
  });

  test("aturan cuti", () => {
    const a = aturanCutiDariPeta({
      hr_cuti_periode: "kalender",
      hr_cuti_hak: "61",
      hr_cuti_sisa: "dibawa",
      hr_cuti_bawa_bulan: " 2 ",
    });
    expect([a.periode, a.hak, a.sisa, a.bawa_bulan]).toEqual([
      "kalender",
      12,
      "dibawa",
      2,
    ]);
    const lengkap = {
      hr_cuti_periode: "kalender",
      hr_cuti_sisa: "hangus",
      hr_cuti_hak: 12,
      hr_cuti_syarat_bulan: 12,
      hr_cuti_prorata: 1,
      hr_cuti_bawa_maks: 6,
      hr_cuti_bawa_bulan: 3,
    };
    const sah = validasiAturanCuti(lengkap);
    expect(sah.ok && sah.nilai.length).toBe(7);
    expect(
      gagalDengan(validasiAturanCuti({ ...lengkap, hr_cuti_bawa_bulan: 0 })),
    ).toBe("Batas pakai sisa dibawa harus 1 sampai 12.");
    expect(
      gagalDengan(validasiAturanCuti({ hr_cuti_periode: "bulanan" })),
    ).toBe("Periode cuti harus kalender atau ulang tahun kerja.");
  });

  test("jatah ulang tahun kerja dengan bawaan", () => {
    const aturan = { ...aturanCutiDariPeta({}), sisa: "dibawa" };
    const p = periodeCuti(
      "2024-03-15",
      aturan,
      ["2025-02-10", "2026-03-16", "2026-03-17", "2026-03-18", "2026-06-20"],
      [["2025-03-15", -2]],
      "2026-11-10",
    );
    expect([
      p[0]?.mulai,
      p[0]?.selesai,
      p[0]?.sebelum_berhak,
      p[0]?.sisa,
    ]).toEqual(["2024-03-15", "2025-03-14", true, -1]);
    expect([p[1]?.mulai, p[1]?.bawaan, p[1]?.penyesuaian, p[1]?.sisa]).toEqual([
      "2025-03-15",
      0,
      -2,
      10,
    ]);
    expect([
      p[2]?.mulai,
      p[2]?.bawaan,
      p[2]?.bawaan_hangus,
      p[2]?.bawaan_sampai,
      p[2]?.terpakai,
      p[2]?.sisa,
    ]).toEqual(["2026-03-15", 6, 3, "2026-06-14", 4, 11]);
    expect(p.length).toBe(3);
  });

  test("jatah kalender prorata", () => {
    const aturan = {
      ...aturanCutiDariPeta({}),
      periode: "kalender",
      prorata: true,
    };
    const p = periodeCuti(
      "2025-04-20",
      aturan,
      ["2026-05-04"],
      [],
      "2026-11-10",
    );
    expect([p[0]?.mulai, p[0]?.selesai, p[0]?.hak, p[0]?.sisa]).toEqual([
      "2026-04-20",
      "2026-12-31",
      8,
      7,
    ]);
    expect(p.length).toBe(1);
    const tanpa = { ...aturanCutiDariPeta({}), periode: "kalender" };
    const q = periodeCuti("2025-04-01", tanpa, [], [], "2027-01-05");
    expect(q.map((x) => [x.mulai, x.hak])).toEqual([
      ["2026-04-01", 12],
      ["2027-01-01", 12],
    ]);
    expect(periodeCuti(null, tanpa, [], [], "2027-01-05")).toEqual([]);
  });

  test("isian penyesuaian", () => {
    const dasar = {
      id_karyawan: "K1",
      periode: "2026-01-01",
      jenis: "Saldo Awal",
      hari: -4,
      alasan: "Dipakai sebelum aplikasi",
    };
    expect(validasiPenyesuaian(dasar).ok).toBe(true);
    expect(gagalDengan(validasiPenyesuaian({ ...dasar, hari: 0 }))).toBe(
      "Jumlah hari harus bilangan bulat selain 0, paling banyak 366.",
    );
    expect(
      gagalDengan(validasiPenyesuaian({ ...dasar, jenis: "Diuangkan" })),
    ).toBe("Jenis penyesuaian harus Saldo Awal atau Koreksi.");
    expect(gagalDengan(validasiPenyesuaian({ ...dasar, periode: "x" }))).toBe(
      "Periode tidak valid.",
    );
  });
});
