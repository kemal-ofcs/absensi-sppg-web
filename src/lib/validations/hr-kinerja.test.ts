import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as K from "./hr-kinerja";
import {
  AMBANG_BAWAAN,
  type AspekSah,
  awalPeriode,
  type BarisNilai,
  bacaPredikat,
  bentrokPeriode,
  DISIPLIN_HARI_SQL,
  DISIPLIN_KARYAWAN_SQL,
  DISIPLIN_PENGAJUAN_SQL,
  DISIPLIN_PERJALANAN_SQL,
  DISIPLIN_TUKAR_SQL,
  type Disiplin,
  finalBerlaku,
  formatNilai,
  hitungDisiplin,
  type InfoTanda,
  type IsianNilai,
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
  PESAN_AMBANG,
  PESAN_DIRI_SENDIRI,
  PESAN_DISIPLIN_BERUBAH,
  PESAN_DISIPLIN_MANUAL,
  PESAN_IZIN,
  PREDIKAT_BAWAAN,
  pengaturanKinerjaDariPeta,
  penilaianGanda,
  periksaAksiKinerja,
  periksaAspekLama,
  periksaBuat,
  periodeRentang,
  pesanBertumpuk,
  predikatNilai,
  type RingkasPenilaian,
  rentangAktif,
  rincianSah,
  STATUS_DIAJUKAN,
  STATUS_DIBATALKAN,
  STATUS_DRAF,
  STATUS_FINAL,
  skorDisiplin,
  skorLengkap,
  statusKinerja,
  susunNilai,
  TIPE_DISIPLIN,
  TIPE_MANUAL,
  tandaKinerja,
  templateKaryawan,
  validasiPengaturanKinerja,
  validasiPenilaian,
  validasiTemplate,
} from "./hr-kinerja";
import { type Kalender, PENGAJUAN_BERLAKU_SQL } from "./hr-pengajuan";
import type {
  HariLaporan,
  PengajuanLaporan,
  TukarLaporan,
} from "./laporan-kehadiran";

// Vektor yang sama dengan `mod tests` di `desktop/hr_kinerja.rs`.

const pesan = (hasil: { ok: boolean; pesan?: string }) =>
  hasil.ok ? "" : (hasil.pesan ?? "");

const hari = (tanggal: string, kode: string): HariLaporan => ({
  id: "K1",
  tanggal,
  hadir: kode === "H" || kode === "T" ? 1 : 0,
  telat: kode === "T" ? 10 : 0,
  menit: kode === "T" ? 10 : 0,
  sakit: kode === "S" ? 1 : 0,
  izin: kode === "I" ? 1 : 0,
  dispensasi: kode === "D" ? 1 : 0,
  alfa: kode === "A" ? 1 : 0,
});

const tanggalMaret = (n: number) =>
  Array.from(
    { length: n },
    (_, i) => `2026-03-${String(i + 1).padStart(2, "0")}`,
  );

const kalenderKosong = (): Kalender => ({ libur: new Set(), whitelist: [] });

const setiapHari: KaryawanDisiplin = {
  divisi: "Gudang",
  hari_kerja: null,
  kode_shift: 1,
};

function hitung(
  mulai: string,
  selesai: string,
  hariIni: string,
  karyawan: KaryawanDisiplin,
  baris: HariLaporan[],
  pengajuan: PengajuanLaporan[] = [],
  tukar: TukarLaporan[] = [],
  perjalanan: string[] = [],
  kalender: Kalender = kalenderKosong(),
): Disiplin {
  return hitungDisiplin({
    mulai,
    selesai,
    hari_ini: hariIni,
    karyawan,
    hari: baris,
    pengajuan,
    tukar,
    perjalanan: new Set(perjalanan),
    kalender,
    ambang: [...AMBANG_BAWAAN],
  });
}

const baris = (
  id: string,
  tipe: string,
  bobot: number,
  urutan: number,
  skor: number | null,
): BarisNilai => ({
  id_aspek: id,
  aspek_nama: id.toUpperCase(),
  tipe,
  bobot,
  urutan,
  skor,
  catatan: null,
  rincian: null,
});

const kep = (
  id: string,
  jenis: string,
  sidik: string,
  waktu: string,
  cloud: string | null,
): KeputusanKinerja => ({
  id_keputusan: id,
  jenis,
  sidik,
  oleh: "hrd",
  waktu_perangkat: waktu,
  diterima_cloud: cloud,
});

describe("hr-kinerja", () => {
  test("teks SQL kembar dengan Rust", () => {
    for (const dir of ["desktop", "mobile"]) {
      const lokasi = [
        join(import.meta.dir, `../../../src-tauri/src/${dir}/hr_kinerja.rs`),
        join(
          import.meta.dir,
          `../../../../mobile/src-tauri/src/${dir}/hr_kinerja.rs`,
        ),
      ].find(existsSync);
      if (!lokasi) continue;
      const rust = readFileSync(lokasi, "utf8").replaceAll("\r\n", "\n");
      for (const sql of [
        DISIPLIN_KARYAWAN_SQL,
        DISIPLIN_HARI_SQL,
        ...DISIPLIN_PENGAJUAN_SQL.split(PENGAJUAN_BERLAKU_SQL),
        ...DISIPLIN_TUKAR_SQL.split(PENGAJUAN_BERLAKU_SQL),
        DISIPLIN_PERJALANAN_SQL,
        PREDIKAT_BAWAAN,
        PESAN_DIRI_SENDIRI,
        PESAN_IZIN,
        PESAN_DISIPLIN_BERUBAH,
        PESAN_AMBANG,
        PESAN_DISIPLIN_MANUAL,
        // SQL penulisan cloud dan pembacaan yang dipakai service Web (§21.9).
        K.CLOUD_UPSERT_TEMPLATE_SQL,
        K.CLOUD_SATU_BAWAAN_SQL,
        K.CLOUD_UPSERT_ASPEK_SQL,
        K.CLOUD_UPSERT_JABATAN_SQL,
        K.CLOUD_UPSERT_PENILAIAN_SQL,
        K.CLOUD_BUANG_NILAI_SQL,
        K.CLOUD_UPSERT_NILAI_SQL,
        K.CLOUD_INSERT_KEPUTUSAN_SQL,
        K.SP_PERIODE_SQL,
        K.WAKTU_KEPUTUSAN_SQL,
        K.KARYAWAN_KINERJA_SQL,
        K.PESAN_TANPA_TEMPLATE,
        K.PESAN_FINAL_LAMA,
        K.PESAN_BELUM_FINAL_SENDIRI,
        K.PESAN_SP_OFFLINE,
        `"${K.IZIN_VIEW}"`,
        `"${K.IZIN_ASSESS}"`,
        `"${K.IZIN_CONFIG}"`,
        `"${K.IZIN_FINALIZE}"`,
      ]) {
        expect(rust).toContain(sql);
      }
    }
    expect(DISIPLIN_PENGAJUAN_SQL.split(PENGAJUAN_BERLAKU_SQL)).toHaveLength(2);
    expect(DISIPLIN_TUKAR_SQL.split(PENGAJUAN_BERLAKU_SQL)).toHaveLength(3);
  });

  test("vektor disiplin §21.6", () => {
    // D = 20 (tepat 17, telat 2, alfa 1) → P = 900 → skor 4.
    let t = tanggalMaret(20);
    let h = [
      ...t.slice(0, 17).map((d) => hari(d, "H")),
      ...t.slice(17, 19).map((d) => hari(d, "T")),
      hari(t[19], "A"),
    ];
    let d = hitung("2026-03-01", "2026-03-20", "2026-12-31", setiapHari, h);
    expect([d.hari, d.permil, d.skor]).toEqual([20, 900, 4]);
    expect(d.rincian).toBe("20|17|2|1|0|0|900|950,900,800,700");
    // D = 21 (tepat 20, telat 1) → P = 976 → skor 5.
    t = tanggalMaret(21);
    h = [...t.slice(0, 20).map((x) => hari(x, "H")), hari(t[20], "T")];
    d = hitung("2026-03-01", "2026-03-21", "2026-12-31", setiapHari, h);
    expect([d.hari, d.permil, d.skor]).toEqual([21, 976, 5]);
    // D = 3 (kosong 3) → P = 0 → skor 1.
    d = hitung("2026-03-01", "2026-03-03", "2026-12-31", setiapHari, []);
    expect([d.hari, d.kosong, d.permil, d.skor]).toEqual([3, 3, 0, 1]);
    // Tepat 10 + 4 hari cuti berlaku → D = 10, P = 1000 → skor 5.
    t = tanggalMaret(14);
    h = t.slice(0, 10).map((x) => hari(x, "H"));
    const cuti = [
      {
        id: "K1",
        mulai: "2026-03-11",
        selesai: "2026-03-14",
        kelompok: "Cuti",
      },
    ];
    d = hitung("2026-03-01", "2026-03-14", "2026-12-31", setiapHari, h, cuti);
    expect([d.hari, d.dikecualikan, d.permil, d.skor]).toEqual([
      10, 4, 1000, 5,
    ]);
    // D = 0: skor tidak dihitung, P kosong di rincian.
    d = hitung("2026-03-05", "2026-03-04", "2026-12-31", setiapHari, []);
    expect([d.hari, d.permil, d.skor]).toEqual([0, null, null]);
    expect(d.rincian).toBe("0|0|0|0|0|0||950,900,800,700");
    expect(rincianSah(d.rincian)).toBe(true);
  });

  test("vektor disiplin campuran (2026-11-02 Senin)", () => {
    const karyawan: KaryawanDisiplin = {
      divisi: "Gudang",
      hari_kerja: "1,2,3,4,5",
      kode_shift: 1,
    };
    const kalender: Kalender = {
      libur: new Set(["2026-11-09", "2026-11-13"]),
      whitelist: [
        {
          id: "w1",
          scope_type: "DIVISI",
          scope_value: "Gudang",
          tanggal_libur: "2026-11-13",
          keterangan: null,
          status_aktif: 1,
        },
      ],
    };
    const h = [
      hari("2026-11-02", "H"),
      hari("2026-11-03", "T"),
      hari("2026-11-05", "S"),
      hari("2026-11-06", "A"),
      hari("2026-11-08", "H"),
      hari("2026-11-10", "A"),
    ];
    const ajuan = [
      {
        id: "K1",
        mulai: "2026-11-06",
        selesai: "2026-11-06",
        kelompok: "Cuti",
      },
      {
        id: "K1",
        mulai: "2026-11-11",
        selesai: "2026-11-11",
        kelompok: "Lembur",
      },
    ];
    const tukar = [
      { id: "K1", tanggal: "2026-11-12", hari_kerja: "6,7", kode_shift: 2 },
    ];
    const d = hitung(
      "2026-11-02",
      "2026-11-15",
      "2026-11-13",
      karyawan,
      h,
      ajuan,
      tukar,
      ["2026-11-04"],
      kalender,
    );
    expect([
      d.tepat,
      d.telat,
      d.alfa,
      d.kosong,
      d.dikecualikan,
      d.hari,
      d.permil,
      d.skor,
    ]).toEqual([3, 1, 1, 2, 2, 7, 500, 1]);
    expect(d.rincian).toBe("7|3|1|1|2|2|500|950,900,800,700");
  });

  test("vektor nilai akhir §21.7", () => {
    const bawaan = bacaPredikat(PREDIKAT_BAWAAN);
    if (!bawaan.ok) throw new Error(bawaan.pesan);
    const b = [
      baris("a", TIPE_MANUAL, 40, 0, 4),
      baris("b", TIPE_MANUAL, 35, 1, 5),
      baris("c", TIPE_MANUAL, 25, 2, 3),
    ];
    expect(nilaiAkhir(b)).toBe(7750);
    expect(formatNilai(7750)).toBe("77,50");
    expect(predikatNilai(7750, bawaan.nilai)).toBe("Baik");
    const semua = (s: number) => b.map((x) => ({ ...x, skor: s }));
    expect(nilaiAkhir(semua(5))).toBe(10_000);
    expect(predikatNilai(10_000, bawaan.nilai)).toBe("Sangat Baik");
    expect(nilaiAkhir(semua(1))).toBe(0);
    expect(predikatNilai(0, bawaan.nilai)).toBe("Sangat Kurang");
    expect(formatNilai(0)).toBe("0,00");
    expect(nilaiAkhir([b[0], { ...b[1], skor: null }, b[2]])).toBeNull();
    expect(skorDisiplin(899, [...AMBANG_BAWAAN])).toBe(3);
    expect(skorDisiplin(699, [...AMBANG_BAWAAN])).toBe(1);
  });

  const drafTemplate = (): Record<string, unknown> => ({
    nama: "  Staf   Gudang ",
    aspek: [
      { nama: "Kerja sama", tipe: "Manual", bobot: 40 },
      {
        nama: "Disiplin",
        tipe: "Otomatis Disiplin",
        bobot: 35,
        panduan: "Dari absensi",
      },
      { nama: "Lama", tipe: "Manual", bobot: 90, is_aktif: false },
      { nama: "Ketelitian", tipe: "Manual", bobot: 25 },
    ],
    jabatan: ["jbt-1", " jbt-2 ", "jbt-1"],
  });

  test("validasi template §21.3", () => {
    const hasil = validasiTemplate(drafTemplate());
    if (!hasil.ok) throw new Error(hasil.pesan);
    const t = hasil.nilai;
    expect(t.nama).toBe("Staf Gudang");
    expect(t.is_aktif && !t.is_bawaan).toBe(true);
    expect(t.aspek.map((a) => a.urutan)).toEqual([0, 1, 2, 3]);
    expect(t.jabatan).toEqual(["jbt-1", "jbt-2"]);
    const ubah = (f: (d: Record<string, unknown>) => void) => {
      const d = drafTemplate();
      f(d);
      return pesan(validasiTemplate(d));
    };
    const aspek = (d: Record<string, unknown>, i: number) =>
      (d.aspek as Record<string, unknown>[])[i];
    expect(
      ubah((d) => {
        aspek(d, 0).bobot = 41;
      }),
    ).toBe("Total bobot aspek aktif harus 100, sekarang 101.");
    expect(
      ubah((d) => {
        aspek(d, 0).bobot = 0;
      }),
    ).toBe("Bobot aspek Kerja sama harus bilangan bulat 1 sampai 100.");
    expect(
      ubah((d) => {
        aspek(d, 3).tipe = "Otomatis Disiplin";
      }),
    ).toBe("Paling banyak satu aspek Otomatis Disiplin.");
    expect(
      ubah((d) => {
        aspek(d, 3).nama = "kerja  SAMA";
      }),
    ).toBe("Nama aspek kerja SAMA dipakai dua kali.");
    expect(
      ubah((d) => {
        aspek(d, 0).tipe = "Angka";
      }),
    ).toBe("Tipe aspek harus Manual atau Otomatis Disiplin.");
    expect(
      ubah((d) => {
        d.nama = " ";
      }),
    ).toBe("Nama template wajib diisi.");
    expect(
      ubah((d) => {
        d.aspek = [];
      }),
    ).toBe("Template butuh minimal satu aspek aktif.");
    expect(
      ubah((d) => {
        d.is_bawaan = true;
        d.is_aktif = false;
      }),
    ).toBe(
      "Template bawaan tidak bisa dinonaktifkan. Jadikan template lain bawaan dulu.",
    );
    expect(
      ubah((d) => {
        d.jabatan = [""];
      }),
    ).toBe("Daftar jabatan tidak valid.");

    // Aspek lama tidak boleh hilang, tipenya terkunci.
    const lama = [["ktp-1:a", TIPE_MANUAL]] as const;
    const asp: AspekSah[] = t.aspek.map((a) => ({ ...a }));
    asp[0].id_aspek = "ktp-1:a";
    expect(periksaAspekLama(asp, lama).ok).toBe(true);
    asp[0].tipe = TIPE_DISIPLIN;
    expect(pesan(periksaAspekLama(asp, lama))).toBe(
      "Tipe aspek Kerja sama tidak bisa diubah setelah dibuat.",
    );
    expect(pesan(periksaAspekLama(t.aspek, lama))).toBe(
      "Aspek lama tidak boleh dihapus; nonaktifkan saja.",
    );
    asp[0].id_aspek = "ktp-1:x";
    expect(pesan(periksaAspekLama(asp, lama))).toBe(
      "Aspek tidak dikenal; muat ulang template.",
    );
    const semua = [
      ["t1", "Staf"],
      ["t2", " staf "],
      ["t3", "Sopir"],
    ] as const;
    expect(namaTemplateDipakai("STAF", "t3", semua)).toBe(true);
    expect(namaTemplateDipakai("Sopir", "t3", semua)).toBe(false);
    expect([...namaGanda(semua)].sort()).toEqual(["t1", "t2"]);
  });

  test("template karyawan Q-79", () => {
    const t = (id: string, aktif: boolean, bawaan: boolean) => ({
      id_template: id,
      is_aktif: aktif,
      is_bawaan: bawaan,
    });
    const daftar = [
      t("ktp-a", true, false),
      t("ktp-b", false, false),
      t("ktp-z", true, true),
      t("ktp-y", true, true),
    ];
    const peta = new Map<string, string | null>([
      ["jbt-1", "ktp-a"],
      ["jbt-2", "ktp-b"],
      ["jbt-3", null],
    ]);
    expect(templateKaryawan("jbt-1", peta, daftar)).toBe("ktp-a");
    expect(templateKaryawan("jbt-2", peta, daftar)).toBe("ktp-y");
    expect(templateKaryawan("jbt-3", peta, daftar)).toBe("ktp-y");
    expect(templateKaryawan(null, peta, daftar)).toBe("ktp-y");
    expect(templateKaryawan("jbt-2", peta, daftar.slice(0, 2))).toBeNull();
  });

  test("periode dan rentang aktif", () => {
    expect(periodeRentang("Bulanan", "2026-02-01")).toEqual({
      ok: true,
      nilai: ["2026-02-01", "2026-02-28"],
    });
    expect(periodeRentang("Kuartal", "2026-10-01")).toEqual({
      ok: true,
      nilai: ["2026-10-01", "2026-12-31"],
    });
    expect(periodeRentang("Semester", "2026-07-01")).toEqual({
      ok: true,
      nilai: ["2026-07-01", "2026-12-31"],
    });
    expect(periodeRentang("Tahunan", "2028-01-01")).toEqual({
      ok: true,
      nilai: ["2028-01-01", "2028-12-31"],
    });
    expect(pesan(periodeRentang("Kuartal", "2026-02-01"))).toBe(
      "Tanggal 2026-02-01 bukan awal periode kuartal.",
    );
    expect(pesan(periodeRentang("Bulanan", "2026-02-02"))).toBe(
      "Tanggal 2026-02-02 bukan awal periode bulanan.",
    );
    expect(pesan(periodeRentang("Mingguan", "2026-02-01"))).toBe(
      "Jenis periode harus Bulanan, Kuartal, Semester, atau Tahunan.",
    );
    expect(pesan(periodeRentang("Bulanan", "2026-02-30"))).toBe(
      "Tanggal mulai periode tidak valid.",
    );
    expect(awalPeriode("Semester", "2026-11-12")).toBe("2026-07-01");
    expect(awalPeriode("Kuartal", "2026-05-31")).toBe("2026-04-01");
    expect(awalPeriode("Tahunan", "2026-05-31")).toBe("2026-01-01");

    const penuh = rentangAktif("2026-01-01", "2026-06-30", "2020-01-01", null);
    expect(penuh?.penuh).toBe(true);
    expect(
      rentangAktif("2026-01-01", "2026-06-30", "2026-03-15", "2026-05-31"),
    ).toEqual({ mulai: "2026-03-15", akhir: "2026-05-31", penuh: false });
    expect(
      rentangAktif("2026-01-01", "2026-06-30", "2026-07-01", null),
    ).toBeNull();
    expect(rentangAktif("2026-01-01", "2026-06-30", "rusak", "")?.penuh).toBe(
      true,
    );

    expect(
      pesan(periksaBuat(false, true, "2026-01-01", "2026-11-12", penuh)),
    ).toBe("Karyawan ini sudah keluar; penilaian baru tidak bisa dibuat.");
    expect(
      pesan(periksaBuat(false, false, "2026-01-01", "2026-11-12", penuh)),
    ).toBe("Karyawan nonaktif tidak bisa dinilai.");
    expect(
      pesan(periksaBuat(true, false, "2027-01-01", "2026-11-12", penuh)),
    ).toBe("Periode ini belum dimulai.");
    expect(
      pesan(periksaBuat(true, false, "2026-01-01", "2026-11-12", null)),
    ).toBe("Karyawan ini tidak aktif selama periode itu.");
    expect(periksaBuat(true, false, "2026-11-01", "2026-11-12", penuh).ok).toBe(
      true,
    );
  });

  test("bertumpuk dan ganda Q-73", () => {
    const p = (
      id: string,
      kar: string,
      ref: string | null,
      mulai: string,
      selesai: string,
      batal: boolean,
    ): RingkasPenilaian => ({
      id_penilaian: id,
      id_karyawan: kar,
      id_ref: ref,
      periode_mulai: mulai,
      periode_selesai: selesai,
      dibatalkan: batal,
    });
    const semua = [
      p("knj-1", "K1", null, "2026-01-01", "2026-06-30", false),
      p("knj-2", "K1", null, "2026-04-01", "2026-06-30", false),
      p("knj-3", "K1", "knj-1", "2026-01-01", "2026-06-30", false),
      p("knj-4", "K1", null, "2026-07-01", "2026-12-31", true),
      p("knj-5", "K2", null, "2026-01-01", "2026-06-30", false),
    ];
    expect(
      bentrokPeriode(
        p("baru", "K1", null, "2026-07-01", "2026-09-30", false),
        semua,
      ),
    ).toBeNull();
    expect(
      bentrokPeriode(
        p("baru", "K1", null, "2026-06-01", "2026-06-30", false),
        semua,
      )?.id_penilaian,
    ).toBe("knj-1");
    expect([...penilaianGanda(semua)].sort()).toEqual(["knj-1", "knj-2"]);
    expect(pesanBertumpuk("2026-01-01", "2026-06-30")).toBe(
      "Karyawan ini sudah punya penilaian untuk periode 2026-01-01 s.d. 2026-06-30.",
    );
  });

  test("validasi dan susun nilai", () => {
    const draf = {
      id_karyawan: "K1",
      periode_jenis: "Semester",
      periode_mulai: "2026-07-01",
      catatan: " Baik ",
      alasan_koreksi: "tidak dipakai",
      nilai: [
        { id_aspek: "a", skor: 4, catatan: "Rapi" },
        { id_aspek: "d", skor: 2 },
        { id_aspek: "c", skor: "" },
      ],
    };
    const p = validasiPenilaian(draf);
    if (!p.ok) throw new Error(p.pesan);
    expect([
      p.nilai.periode_selesai,
      p.nilai.catatan,
      p.nilai.alasan_koreksi,
    ]).toEqual(["2026-12-31", "Baik", null]);
    expect(p.nilai.nilai[2].skor).toBeNull();
    const ubah = (f: (d: Record<string, unknown>) => void) => {
      const d = structuredClone(draf) as Record<string, unknown>;
      f(d);
      return pesan(validasiPenilaian(d));
    };
    const nilai = (d: Record<string, unknown>, i: number) =>
      (d.nilai as Record<string, unknown>[])[i];
    expect(
      ubah((d) => {
        nilai(d, 0).skor = 6;
      }),
    ).toBe("Skor harus bilangan bulat 1 sampai 5.");
    expect(
      ubah((d) => {
        nilai(d, 0).skor = "4";
      }),
    ).toBe("Skor harus bilangan bulat 1 sampai 5.");
    expect(
      ubah((d) => {
        nilai(d, 1).id_aspek = "a";
      }),
    ).toBe("Aspek ganda dalam isian nilai.");
    expect(
      ubah((d) => {
        d.id_ref = "knj-1";
      }),
    ).toBe("");
    expect(
      ubah((d) => {
        d.id_ref = "knj-1";
        d.alasan_koreksi = " ";
      }),
    ).toBe("Alasan koreksi wajib diisi.");
    expect(
      ubah((d) => {
        d.id_karyawan = "";
      }),
    ).toBe("Pilih karyawan.");

    const salinan = [
      baris("a", TIPE_MANUAL, 40, 0, null),
      baris("d", TIPE_DISIPLIN, 35, 1, null),
      baris("c", TIPE_MANUAL, 25, 2, null),
    ];
    const disiplin = (skor: number | null, rincian: string): Disiplin => ({
      hari: 0,
      tepat: 0,
      telat: 0,
      alfa: 0,
      kosong: 0,
      dikecualikan: 0,
      permil: null,
      ambang: [...AMBANG_BAWAAN],
      skor,
      rincian,
    });
    const d4 = disiplin(4, "20|17|2|1|0|0|900|950,900,800,700");
    const susun = susunNilai(salinan, p.nilai.nilai, d4);
    if (!susun.ok) throw new Error(susun.pesan);
    const hasil = susun.nilai;
    expect(hasil[0].skor).toBe(4);
    expect([hasil[1].skor, hasil[1].rincian]).toEqual([
      4,
      "20|17|2|1|0|0|900|950,900,800,700",
    ]);
    expect(skorLengkap(hasil)).toBe(false);
    const d0 = disiplin(null, "0|0|0|0|0|5||950,900,800,700");
    expect(pesan(susunNilai(salinan, p.nilai.nilai, d0))).toBe(
      PESAN_DISIPLIN_MANUAL,
    );
    const isian: IsianNilai[] = p.nilai.nilai.map((n) => ({ ...n }));
    isian[1].catatan = "Cuti panjang";
    const manual = susunNilai(salinan, isian, d0);
    expect(manual.ok && manual.nilai[1].skor).toBe(2);
    isian.push({ id_aspek: "x", skor: null, catatan: null });
    expect(pesan(susunNilai(salinan, isian, d0))).toBe(
      "Aspek penilaian tidak dikenal; muat ulang template.",
    );

    // Muat ulang: skor aspek yang masih ada dipertahankan.
    let ulang = muatUlangTemplate(
      [
        baris("c", TIPE_MANUAL, 60, 0, null),
        baris("e", TIPE_MANUAL, 40, 1, null),
      ],
      hasil,
    );
    expect(ulang.map((b) => b.skor)).toEqual([null, null]);
    ulang = muatUlangTemplate([baris("a", TIPE_MANUAL, 60, 0, null)], hasil);
    expect([ulang[0].skor, ulang[0].bobot]).toEqual([4, 60]);
  });

  test("teks kanonik sidik", () => {
    const nilai = [
      {
        ...baris("d", TIPE_DISIPLIN, 35, 1, 4),
        rincian: "20|17|2|1|0|0|900|950,900,800,700",
      },
      { ...baris("a", TIPE_MANUAL, 65, 0, 5), catatan: "Rapi" },
    ];
    expect(
      kanonikPenilaian({
        id_karyawan: "K1",
        id_ref: null,
        periode_mulai: "2026-07-01",
        periode_selesai: "2026-12-31",
        id_template: "ktp-1",
        catatan: "Baik",
        nilai,
      }),
    ).toBe(
      "K1\u001f\u001f2026-07-01\u001f2026-12-31\u001fktp-1\u001fBaik\u001fa\u001fManual\u001f65\u001f5\u001fRapi\u001f\u001fd\u001fOtomatis Disiplin\u001f35\u001f4\u001f\u001f20|17|2|1|0|0|900|950,900,800,700",
    );
  });

  test("status, tanda, dan nilai berlaku", () => {
    const w = (n: number) => `2026-12-31 10:0${n}:00`;
    expect(statusKinerja("s1", [])).toBe(STATUS_DRAF);
    const ajukan = kep("k1", "Ajukan", "s1", w(1), w(1));
    expect(statusKinerja("s1", [ajukan])).toBe(STATUS_DIAJUKAN);
    expect(statusKinerja("s2", [ajukan])).toBe(STATUS_DRAF);
    const kembali = kep("k2", "Kembalikan", "s1", w(2), w(2));
    expect(statusKinerja("s1", [ajukan, kembali])).toBe(STATUS_DRAF);
    const ajukan2 = kep("k3", "Ajukan", "s1", w(3), null);
    expect(statusKinerja("s1", [ajukan, kembali, ajukan2])).toBe(
      STATUS_DIAJUKAN,
    );
    const final1 = kep("k4", "Final", "s1", w(4), w(4));
    const semua = [ajukan, kembali, ajukan2, final1];
    expect(statusKinerja("s1", semua)).toBe(STATUS_FINAL);
    expect(statusKinerja("s9", semua)).toBe(STATUS_DRAF);
    const batal = [...semua, kep("k5", "Batal", "s1", w(5), null)];
    expect(statusKinerja("s1", batal)).toBe(STATUS_DIBATALKAN);

    const info = (sidik: string, keputusan: KeputusanKinerja[]): InfoTanda => ({
      sidik,
      keputusan,
      penilai_oleh: "atasan",
      id_penilai: "K9",
      id_atasan: "K9",
      rincian_disiplin: "20|17|2|1|0|0|900|950,900,800,700",
      periode_penuh: true,
      ganda: false,
    });
    expect(tandaKinerja(info("s1", semua))).toEqual([]);
    expect(tandaKinerja(info("s9", semua))).toEqual(["final_gugur"]);
    expect(tandaKinerja(info("s1", batal))).toEqual(["final_dibatalkan"]);
    expect(
      tandaKinerja({
        ...info("s1", semua),
        penilai_oleh: " HRD ",
        id_penilai: null,
        rincian_disiplin: "0|0|0|0|0|3||950,900,800,700",
        periode_penuh: false,
        ganda: true,
      }),
    ).toEqual([
      "penilaian_ganda",
      "dinilai_dan_difinalkan_sama",
      "bukan_atasan_langsung",
      "disiplin_manual",
      "periode_tidak_penuh",
    ]);

    // Nilai berlaku = Final paling akhir di antara akar dan koreksinya.
    const fAkar = kep(
      "f1",
      "Final",
      "s1",
      "2026-12-31 10:00:00",
      "2027-01-02 08:00:00",
    );
    const fKoreksi = kep(
      "f2",
      "Final",
      "s2",
      "2027-01-01 09:00:00",
      "2027-01-05 08:00:00",
    );
    expect(
      kinerjaBerlaku([
        { id_penilaian: "knj-1", final: fAkar },
        { id_penilaian: "knj-2", final: fKoreksi },
      ]),
    ).toBe("knj-2");
    expect(kinerjaBerlaku([])).toBeNull();
    expect(
      finalBerlaku("s1", [final1, kep("k0", "Final", "s1", w(0), w(0))])
        ?.id_keputusan,
    ).toBe("k0");
  });

  test("aksi kinerja §21.5", () => {
    const dasar: KeadaanKinerja = {
      status: STATUS_DRAF,
      koreksi: false,
      karyawan_sendiri: false,
      boleh_assess: true,
      boleh_finalize: false,
      skor_lengkap: true,
      periode_selesai: true,
      disiplin_sama: true,
      akar_final: false,
      koreksi_terbuka: false,
    };
    const cek = (aksi: string, alasan: string, ubah: Partial<KeadaanKinerja>) =>
      pesan(periksaAksiKinerja(aksi, alasan, { ...dasar, ...ubah }));
    expect(cek("Simpan", "", {})).toBe("");
    expect(cek("Simpan", "", { status: "" })).toBe("");
    expect(cek("Simpan", "", { status: STATUS_DIAJUKAN })).toBe(
      "Penilaian yang sudah diajukan atau selesai tidak bisa disunting.",
    );
    expect(cek("Simpan", "", { karyawan_sendiri: true })).toBe(
      PESAN_DIRI_SENDIRI,
    );
    expect(cek("Simpan", "", { boleh_assess: false })).toBe(PESAN_IZIN);
    expect(
      cek("Simpan", "", {
        boleh_assess: false,
        boleh_finalize: true,
        koreksi: true,
      }),
    ).toBe("");
    expect(cek("Ajukan", "", {})).toBe("");
    expect(cek("Ajukan", "", { skor_lengkap: false })).toBe(
      "Isi skor semua aspek sebelum mengajukan.",
    );
    expect(cek("Ajukan", "", { periode_selesai: false })).toBe(
      "Penilaian baru bisa diajukan sejak hari terakhir periode.",
    );
    expect(cek("Ajukan", "", { disiplin_sama: false })).toBe(
      PESAN_DISIPLIN_BERUBAH,
    );
    expect(cek("Ajukan", "", { status: STATUS_FINAL })).toBe(
      "Hanya draf yang bisa diajukan.",
    );
    const diajukan = { status: STATUS_DIAJUKAN, boleh_finalize: true };
    expect(cek("Final", "", diajukan)).toBe("");
    expect(cek("Final", "", { status: STATUS_DIAJUKAN })).toBe(PESAN_IZIN);
    expect(cek("Kembalikan", " ", diajukan)).toBe(
      "Alasan pengembalian wajib diisi.",
    );
    expect(cek("Kembalikan", "Skor tidak sesuai", diajukan)).toBe("");
    expect(cek("Final", "", { boleh_finalize: true })).toBe(
      "Penilaian ini tidak sedang diajukan.",
    );
    expect(cek("Batal", "Salah karyawan", {})).toBe("");
    expect(cek("Batal", "", {})).toBe("Alasan pembatalan wajib diisi.");
    expect(cek("Batal", "x", { status: STATUS_FINAL })).toBe(
      "Penilaian final tidak bisa dibatalkan; buat koreksi.",
    );
    expect(cek("Batal", "x", { status: STATUS_DIBATALKAN })).toBe(
      "Penilaian ini sudah dibatalkan.",
    );
    expect(cek("Koreksi", "", { akar_final: true })).toBe(PESAN_IZIN);
    const koreksi = { boleh_finalize: true, akar_final: true };
    expect(cek("Koreksi", "", koreksi)).toBe("");
    expect(cek("Koreksi", "", { boleh_finalize: true })).toBe(
      "Koreksi hanya untuk penilaian yang sudah final.",
    );
    expect(cek("Koreksi", "", { ...koreksi, koreksi_terbuka: true })).toBe(
      "Penilaian ini masih punya koreksi yang belum selesai.",
    );
    expect(cek("Hapus", "", {})).toBe("Aksi penilaian tidak dikenal.");
    expect(cek("Batal", "x".repeat(501), {})).toBe(
      "Alasan maksimal 500 karakter.",
    );
  });

  test("pengaturan kinerja", () => {
    const bawaan = pengaturanKinerjaDariPeta(new Map());
    expect(bawaan.periode).toBe("Semester");
    expect(bawaan.ambang).toEqual([950, 900, 800, 700]);
    expect(bawaan.predikat).toHaveLength(5);
    const rusak = new Map([
      [KUNCI_PERIODE, "Mingguan"],
      [KUNCI_AMBANG, "900,950,800,700"],
      [KUNCI_PREDIKAT, "5000:Baik"],
    ]);
    expect(pengaturanKinerjaDariPeta(rusak)).toEqual(bawaan);
    const sah = validasiPengaturanKinerja({
      [KUNCI_PERIODE]: "Kuartal",
      [KUNCI_AMBANG]: " 990, 950 ,900,850 ",
      [KUNCI_PREDIKAT]: "8000: Baik | 0:Perlu Bimbingan",
    });
    if (!sah.ok) throw new Error(sah.pesan);
    expect(sah.nilai).toEqual([
      [KUNCI_PERIODE, "Kuartal"],
      [KUNCI_AMBANG, "990,950,900,850"],
      [KUNCI_PREDIKAT, "8000:Baik|0:Perlu Bimbingan"],
    ]);
    expect(pengaturanKinerjaDariPeta(new Map(sah.nilai)).ambang).toEqual([
      990, 950, 900, 850,
    ]);
    const salah = (kunci: string, nilai: string) =>
      pesan(
        validasiPengaturanKinerja({
          [KUNCI_PERIODE]: "Semester",
          [KUNCI_AMBANG]: "950,900,800,700",
          [KUNCI_PREDIKAT]: PREDIKAT_BAWAAN,
          [kunci]: nilai,
        }),
      );
    expect(salah(KUNCI_PERIODE, "Mingguan")).toBe(
      "Jenis periode harus Bulanan, Kuartal, Semester, atau Tahunan.",
    );
    expect(salah(KUNCI_AMBANG, "950,950,800,700")).toBe(PESAN_AMBANG);
    expect(salah(KUNCI_AMBANG, "1001,900,800,700")).toBe(PESAN_AMBANG);
    expect(salah(KUNCI_AMBANG, "950,900,800")).toBe(PESAN_AMBANG);
    expect(salah(KUNCI_AMBANG, "950,900,800,0")).toBe(PESAN_AMBANG);
    expect(salah(KUNCI_PREDIKAT, "0:Kurang")).toBe(
      "Predikat harus 2 sampai 7 tingkat.",
    );
    expect(salah(KUNCI_PREDIKAT, "9000:Baik|100:Kurang")).toBe(
      "Ambang predikat harus turun dan yang terakhir 0.",
    );
    expect(salah(KUNCI_PREDIKAT, "4000:Baik|9000:Kurang|0:X")).toBe(
      "Ambang predikat harus turun dan yang terakhir 0.",
    );
    expect(salah(KUNCI_PREDIKAT, "9000:Baik|0:")).toBe(
      "Nama predikat 1 sampai 50 karakter, tanpa tanda : dan |.",
    );
    expect(salah(KUNCI_PREDIKAT, "9000:A:B|0:C")).toBe(
      "Nama predikat 1 sampai 50 karakter, tanpa tanda : dan |.",
    );
    expect(salah(KUNCI_PREDIKAT, "Baik|0:C")).toBe(
      "Setiap predikat berbentuk ambang:nama, misalnya 7500:Baik.",
    );
    expect(salah(KUNCI_PREDIKAT, "10001:Baik|0:C")).toBe(
      "Setiap predikat berbentuk ambang:nama, misalnya 7500:Baik.",
    );

    expect(rincianSah("7|3|1|1|2|2|500|950,900,800,700")).toBe(true);
    expect(rincianSah("7|3|1|1|1|2|500|950,900,800,700")).toBe(false);
    expect(rincianSah("0|0|0|0|0|0|0|950,900,800,700")).toBe(false);
    expect(rincianSah("7|3|1|1|2|2|1001|950,900,800,700")).toBe(false);
    expect(rincianSah("7|3|1|1|2|2|500|950,900,800")).toBe(false);
    expect(rincianSah("7|+3|1|1|2|2|500|950,900,800,700")).toBe(false);
    expect(rincianSah("7|3|1|1|2|2|+500|950,900,800,700")).toBe(false);
  });
});
