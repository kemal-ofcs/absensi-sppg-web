import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  aturanCutiDariPeta,
  aturanLemburDariPeta,
  BACKUP_TUKAR_SQL,
  bentrokPengajuan,
  CLOUD_INSERT_KEPUTUSAN_SQL,
  durasiLembur,
  hitungCutiDibayar,
  INSERT_PENYESUAIAN_SQL,
  type JenisPengajuan,
  type Kalender,
  type KeadaanAksi,
  type Keputusan,
  kanonikPengajuan,
  kodeKelompok,
  LAPORAN_PENGAJUAN_SQL,
  LAPORAN_TUKAR_SQL,
  LEMBUR_HARIAN_SQL,
  lemburLewatBatas,
  PENGAJUAN_BERLAKU_SQL,
  PENGAJUAN_RENTANG_SQL,
  PERIODE_DIBAYAR_SQL,
  PESAN_TANPA_HARI_KERJA,
  PESAN_TUKAR_BACKUP,
  PESAN_TUKAR_NONAKTIF,
  PESAN_TUKAR_SHIFT_HILANG,
  PESAN_TUKAR_SHIFT_SAMA,
  periksaAksi,
  periksaJenis,
  periksaMaks,
  periksaSunting,
  periksaUrgent,
  periodeCuti,
  potongLemburSpl,
  type Ringkas,
  SEED_JENIS_SQL,
  SPL_RENTANG_SQL,
  seninDari,
  statusPengajuan,
  TANGGAL_HADIR_SQL,
  TUKAR_RENTANG_SQL,
  tandaKeputusan,
  tanggalWajib,
  UPSERT_JENIS_SQL,
  UPSERT_PENGAJUAN_SQL,
  upahHarian,
  validasiAturanCuti,
  validasiAturanLembur,
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
        ...SPL_RENTANG_SQL.split(PENGAJUAN_BERLAKU_SQL),
        ...TUKAR_RENTANG_SQL.split(PENGAJUAN_BERLAKU_SQL),
        ...LAPORAN_TUKAR_SQL.split(PENGAJUAN_BERLAKU_SQL),
        BACKUP_TUKAR_SQL,
        LEMBUR_HARIAN_SQL,
        PESAN_TUKAR_NONAKTIF,
        PESAN_TUKAR_SHIFT_SAMA,
        PESAN_TUKAR_SHIFT_HILANG,
        PESAN_TUKAR_BACKUP,
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

  test("fase 3: durasi lembur dan sidik isian baru", () => {
    expect(durasiLembur("17:00", "19:30")).toEqual({ ok: true, nilai: 150 });
    expect(durasiLembur("22:00", "02:00")).toEqual({ ok: true, nilai: 240 });
    expect(gagalDengan(durasiLembur("17:00", "17:00"))).toBe(
      "Jam mulai dan selesai lembur tidak boleh sama.",
    );
    expect(gagalDengan(durasiLembur("7:00", "09:00"))).toBe(
      "Jam lembur harus berformat JJ:MM.",
    );
    expect(gagalDengan(durasiLembur("24:00", "01:00"))).toBe(
      "Jam lembur harus berformat JJ:MM.",
    );
    const dasar = {
      id_karyawan: "K1",
      potong_jatah: false,
      dampak_gaji: "Tidak Berpengaruh",
      tanggal_mulai: "2026-11-02",
      tanggal_selesai: "2026-11-02",
      setengah_hari: false,
      alasan: "Opname",
      jam_mulai: "17:00",
      jam_selesai: "19:00",
      id_karyawan_tukar: "K2",
      id_shift_asal: 1,
      id_shift_tukar: 2,
    };
    const awal =
      "K1\u001fjns-x\u001f{k}\u001f0\u001fTidak Berpengaruh\u001f2026-11-02\u001f2026-11-02\u001f0\u001fOpname";
    expect(
      kanonikPengajuan({ ...dasar, id_jenis: "jns-x", kelompok: "Lembur" }),
    ).toBe(`${awal.replace("{k}", "Lembur")}\u001f17:00\u001f19:00`);
    expect(
      kanonikPengajuan({
        ...dasar,
        id_jenis: "jns-x",
        kelompok: "Tukar Shift",
      }),
    ).toBe(`${awal.replace("{k}", "Tukar Shift")}\u001fK2\u001f1\u001f2`);
    // Kelompok lain mengabaikan isian baru: sidik fase 2 tidak berubah.
    expect(
      kanonikPengajuan({ ...dasar, id_jenis: "jns-x", kelompok: "Dinas Luar" }),
    ).toBe(awal.replace("{k}", "Dinas Luar"));
    expect(kodeKelompok("Dinas Luar")).toBe("DL");
    expect(kodeKelompok("Lembur")).toBeNull();
  });

  test("fase 3: bentrok pengajuan", () => {
    const r = (
      kelompok: string,
      id: string,
      mulai: string,
      selesai: string,
      lain: Partial<Ringkas> = {},
    ): Ringkas => ({
      kelompok,
      id_karyawan: id,
      id_karyawan_tukar: null,
      tanggal_mulai: mulai,
      tanggal_selesai: selesai,
      setengah_hari: false,
      jam_mulai: null,
      jam_selesai: null,
      ...lain,
    });
    const jam = (a: string, b: string) => ({ jam_mulai: a, jam_selesai: b });
    const t = "2026-11-02";
    const l1 = r("Lembur", "K1", t, t, jam("17:00", "19:00"));
    expect(
      bentrokPengajuan(l1, r("Lembur", "K1", t, t, jam("18:30", "20:00"))),
    ).toBe(true);
    expect(
      bentrokPengajuan(l1, r("Lembur", "K1", t, t, jam("19:00", "21:00"))),
    ).toBe(false);
    expect(
      bentrokPengajuan(l1, r("Lembur", "K2", t, t, jam("17:00", "19:00"))),
    ).toBe(false);
    expect(
      bentrokPengajuan(l1, r("Cuti", "K1", "2026-11-01", "2026-11-03")),
    ).toBe(true);
    expect(
      bentrokPengajuan(l1, r("Izin", "K1", t, t, { setengah_hari: true })),
    ).toBe(false);
    const tukar = r("Tukar Shift", "K2", t, t, { id_karyawan_tukar: "K1" });
    expect(bentrokPengajuan(l1, tukar)).toBe(false);
    expect(bentrokPengajuan(tukar, r("Cuti", "K1", t, t))).toBe(true);
    expect(bentrokPengajuan(tukar, r("Dinas Luar", "K3", t, t))).toBe(false);
    expect(
      bentrokPengajuan(
        tukar,
        r("Tukar Shift", "K3", t, t, { id_karyawan_tukar: "K2" }),
      ),
    ).toBe(true);
    expect(
      bentrokPengajuan(
        tukar,
        r("Tukar Shift", "K3", t, t, { id_karyawan_tukar: "K4" }),
      ),
    ).toBe(false);
    expect(bentrokPengajuan(r("Cuti", "K1", t, t), r("Cuti", "K2", t, t))).toBe(
      false,
    );
    expect(
      bentrokPengajuan(
        r("Dinas Luar", "K1", t, t),
        r("Sakit", "K1", t, "2026-11-04"),
      ),
    ).toBe(true);
  });

  test("fase 3: batas lembur dan potongan SPL", () => {
    expect(seninDari("2026-11-08")).toBe("2026-11-02");
    expect(seninDari("2026-11-09")).toBe("2026-11-09");
    expect(
      [
        ...lemburLewatBatas(
          [
            ["2026-11-02", 180],
            ["2026-11-02", 90],
            ["2026-11-03", 60],
            ["2026-11-09", 240],
            ["2026-11-10", 240],
            ["2026-11-11", 200],
          ],
          240,
          600,
        ),
      ].sort(),
    ).toEqual(["2026-11-02", "2026-11-09", "2026-11-10", "2026-11-11"]);
    expect(
      potongLemburSpl([
        { lembur: 120, libur_total: 0, libur_jam_kerja: 0, spl: 90 },
        { lembur: 60, libur_total: 0, libur_jam_kerja: 0, spl: 0 },
        { lembur: 0, libur_total: 600, libur_jam_kerja: 480, spl: 0 },
        { lembur: 0, libur_total: 600, libur_jam_kerja: 480, spl: 300 },
        { lembur: 30, libur_total: 0, libur_jam_kerja: 0, spl: 120 },
      ]),
    ).toEqual({
      lembur: 90,
      libur_total: 900,
      libur_jam_kerja: 660,
      tanpa_spl: 660,
    });
  });

  test("fase 3: jenis, isian, dan aturan lembur", () => {
    const jenis = validasiJenis({
      nama: "Lembur Gudang",
      kelompok: "Lembur",
      dampak_gaji: "Dibayar",
      maks_hari: 5,
    });
    expect(jenis.ok && jenis.nilai.dampak_gaji).toBe("Tidak Berpengaruh");
    expect(jenis.ok && jenis.nilai.maks_hari).toBeNull();
    expect(
      gagalDengan(
        validasiJenis({
          nama: "X",
          kelompok: "Reimburse",
          dampak_gaji: "Dibayar",
        }),
      ),
    ).toBe(
      "Kelompok harus Cuti, Izin, Sakit, Lembur, Tukar Shift, atau Dinas Luar.",
    );
    const j = (kelompok: string): JenisPengajuan => ({
      id_jenis: "j",
      nama: "J",
      kelompok,
      izin_pemutus: "hr.request.decide",
      boleh_urgent: true,
      potong_jatah: false,
      dampak_gaji: "Tidak Berpengaruh",
      maks_hari: null,
      satuan_maks: "Hari Kerja",
      wajib_dokumen: false,
      is_aktif: true,
    });
    const isian = (lain: Record<string, unknown>) => {
      const v = validasiPengajuan({
        id_karyawan: "K1",
        id_jenis: "j",
        tanggal_mulai: "2026-11-02",
        tanggal_selesai: "2026-11-02",
        alasan: "x",
        ...lain,
      });
      if (!v.ok) throw new Error(v.pesan);
      return v.nilai;
    };
    expect(
      gagalDengan(
        periksaJenis(
          isian({
            tanggal_selesai: "2026-11-03",
            jam_mulai: "17:00",
            jam_selesai: "18:00",
          }),
          j("Lembur"),
        ),
      ),
    ).toBe("Lembur diajukan per tanggal kerja.");
    expect(
      gagalDengan(periksaJenis(isian({ jam_mulai: "17:00" }), j("Lembur"))),
    ).toBe("Jam lembur harus berformat JJ:MM.");
    expect(
      periksaJenis(
        isian({ jam_mulai: "17:00", jam_selesai: "18:00" }),
        j("Lembur"),
      ).ok,
    ).toBe(true);
    expect(gagalDengan(periksaJenis(isian({}), j("Tukar Shift")))).toBe(
      "Pilih karyawan yang diajak bertukar.",
    );
    expect(
      gagalDengan(
        periksaJenis(isian({ id_karyawan_tukar: "K1" }), j("Tukar Shift")),
      ),
    ).toBe("Tukar shift harus dengan karyawan lain.");
    expect(
      gagalDengan(
        periksaJenis(
          isian({ id_karyawan_tukar: "K2", tanggal_selesai: "2026-11-03" }),
          j("Tukar Shift"),
        ),
      ),
    ).toBe("Tukar shift diajukan per tanggal.");
    expect(
      periksaJenis(isian({ id_karyawan_tukar: "K2" }), j("Tukar Shift")).ok,
    ).toBe(true);
    expect(aturanLemburDariPeta({})).toEqual({
      mode: "otomatis",
      maks_harian: 4,
      maks_mingguan: 18,
    });
    expect(
      aturanLemburDariPeta({
        hr_lembur_mode: "spl",
        hr_lembur_maks_harian: "13",
      }),
    ).toEqual({ mode: "spl", maks_harian: 4, maks_mingguan: 18 });
    expect(
      validasiAturanLembur({
        hr_lembur_mode: "spl",
        hr_lembur_maks_harian: 3,
        hr_lembur_maks_mingguan: 20,
      }),
    ).toEqual({
      ok: true,
      nilai: [
        ["hr_lembur_mode", "spl"],
        ["hr_lembur_maks_harian", "3"],
        ["hr_lembur_maks_mingguan", "20"],
      ],
    });
    expect(
      gagalDengan(
        validasiAturanLembur({
          hr_lembur_mode: "spl",
          hr_lembur_maks_harian: 0,
          hr_lembur_maks_mingguan: 20,
        }),
      ),
    ).toBe("Batas lembur harian harus 1 sampai 12 jam.");
    expect(gagalDengan(validasiAturanLembur({ hr_lembur_mode: "x" }))).toBe(
      "Mode lembur harus otomatis atau SPL.",
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
          nama: "Klaim",
          kelompok: "Reimburse",
          dampak_gaji: "Dibayar",
        }),
      ),
    ).toBe(
      "Kelompok harus Cuti, Izin, Sakit, Lembur, Tukar Shift, atau Dinas Luar.",
    );
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
