import { describe, expect, test } from "bun:test";
import {
  diDalamJendelaScanMasuk,
  diDalamRentangKoreksiMasuk,
  hitungJamKerjaNormalMenit,
  hitungMenitKerja,
  hitungTerlambatDanDatangAwal,
  hitungUlangAbsensiDariJam,
  jendelaScanMasuk,
  putuskanScanWaktu,
  type ShiftTimePolicy,
  tentukanTanggalKerja,
} from "./time-policy";

const SHIFT_PAGI: ShiftTimePolicy = {
  kind: "regular",
  jamMasuk: "07:00",
  jamPulang: "15:00",
  awalAbsenMenit: 60,
  batasMasukMenit: 15,
  toleransiMasukMenit: 30,
  batasPulangMenit: 120,
  bufferShiftMalamMenit: 120,
  offsetIstirahatMulai: 240,
  jamKerjaNormalMenit: 420,
  istirahatMenit: 60,
};

const SHIFT_MALAM: ShiftTimePolicy = {
  ...SHIFT_PAGI,
  jamMasuk: "23:00",
  jamPulang: "07:00",
};

const SHIFT_FLEKSIBEL: ShiftTimePolicy = {
  ...SHIFT_PAGI,
  kind: "flexible",
  jamMasuk: "00:00",
  jamPulang: "23:59",
  awalAbsenMenit: 0,
  batasMasukMenit: 1440,
  toleransiMasukMenit: 0,
  batasPulangMenit: 1440,
  bufferShiftMalamMenit: 0,
  offsetIstirahatMulai: 0,
  jamKerjaNormalMenit: 0,
  istirahatMenit: 0,
};

function jakarta(date: string, time: string): string {
  return `${date}T${time}:00+07:00`;
}

function scan(
  waktuScan: string,
  options: {
    shift?: ShiftTimePolicy;
    masuk?: string;
    pulang?: string;
    scanTerakhir?: string;
    jenisScanTerakhir?: "Masuk" | "Pulang";
    batasMultiScanMenit?: number;
  } = {},
) {
  return putuskanScanWaktu({
    waktuScan,
    shift: options.shift ?? SHIFT_PAGI,
    batasMultiScanMenit: options.batasMultiScanMenit ?? 10,
    riwayat: {
      waktuMasuk: options.masuk,
      waktuPulang: options.pulang,
      scanTerakhir: options.scanTerakhir,
      jenisScanTerakhir: options.jenisScanTerakhir,
    },
  });
}

describe("mesin aturan waktu scan shift reguler", () => {
  // Shift 07:00, awal 60, batas tepat waktu 15, toleransi 30:
  // 05:45 ─ awal absen ─ 06:45 ─ tepat waktu ─ 07:00 ─ terlambat ─ 07:30.
  test("menolak shift pagi sebelum jendela Awal Absen Masuk dibuka", () => {
    const result = scan(jakarta("2026-08-12", "05:44"));
    expect(result.alasan).toBe("TOO_EARLY");
    expect(result.boleh).toBe(false);
  });

  test("menerima datang lebih awal di jendela Awal Absen Masuk", () => {
    const result = scan(jakarta("2026-08-12", "06:00"));
    expect(result.alasan).toBe("EARLY_ENTRY");
    expect(result.keterangan).toBe("Datang Lebih Awal");
    expect(result.menitDatangAwal).toBe(60);
  });

  test("jendela Tepat Waktu berada sebelum jam masuk", () => {
    const result = scan(jakarta("2026-08-12", "06:50"));
    expect(result.alasan).toBe("ON_TIME_ENTRY");
    expect(result.keterangan).toBe("Tepat Waktu");
    expect(result.menitTerlambat).toBe(0);
    expect(result.menitDatangAwal).toBe(10);
  });

  test("scan tepat pada jam masuk masih tepat waktu", () => {
    const result = scan(jakarta("2026-08-12", "07:00"));
    expect(result.alasan).toBe("ON_TIME_ENTRY");
    expect(result.menitTerlambat).toBe(0);
  });

  test("terlambat dihitung sejak jam masuk selama masih dalam toleransi", () => {
    const result = scan(jakarta("2026-08-12", "07:20"));
    expect(result.alasan).toBe("LATE_ENTRY");
    expect(result.menitTerlambat).toBe(20);
  });

  test("menolak masuk setelah jam masuk + toleransi", () => {
    const result = scan(jakarta("2026-08-12", "07:31"));
    expect(result.alasan).toBe("ENTRY_WINDOW_CLOSED");
    expect(result.boleh).toBe(false);
  });

  test("tidak langsung menganggap scan kedua sebagai pulang", () => {
    const masuk = jakarta("2026-08-12", "07:00");
    const result = scan(jakarta("2026-08-12", "07:10"), {
      masuk,
      scanTerakhir: masuk,
      jenisScanTerakhir: "Masuk",
    });
    expect(result.alasan).toBe("MULTI_SCAN");
    expect(result.statusProses).toBe("Ditolak");
  });

  test("mencatat pulang lebih awal dan kekurangan kerja dalam menit", () => {
    const result = scan(jakarta("2026-08-12", "14:00"), {
      masuk: jakarta("2026-08-12", "07:00"),
    });
    expect(result.alasan).toBe("EARLY_CHECKOUT");
    expect(result.keterangan).toBe("Pulang Lebih Awal");
    expect(result.perhitungan).toEqual({
      durasiHadirMenit: 420,
      potonganIstirahatMenit: 60,
      jamKerjaMenit: 360,
      lemburMenit: 0,
      jamKerjaKurangMenit: 60,
    });
  });

  test("menerima pulang normal", () => {
    const result = scan(jakarta("2026-08-12", "15:00"), {
      masuk: jakarta("2026-08-12", "07:00"),
    });
    expect(result.alasan).toBe("NORMAL_CHECKOUT");
    expect(result.keterangan).toBe("Pulang Normal");
    expect(result.perhitungan.jamKerjaMenit).toBe(420);
  });

  test("menghitung lembur dalam menit selama jendela pulang masih terbuka", () => {
    const result = scan(jakarta("2026-08-12", "16:00"), {
      masuk: jakarta("2026-08-12", "07:00"),
    });
    expect(result.alasan).toBe("OVERTIME_CHECKOUT");
    expect(result.perhitungan.lemburMenit).toBe(60);
  });

  test("menolak pulang melewati batas akhir", () => {
    const result = scan(jakarta("2026-08-12", "17:01"), {
      masuk: jakarta("2026-08-12", "07:00"),
    });
    expect(result.alasan).toBe("CHECKOUT_TOO_LATE");
    expect(result.boleh).toBe(false);
  });

  test("menolak scan ketiga setelah jam pulang tercatat", () => {
    const result = scan(jakarta("2026-08-12", "16:00"), {
      masuk: jakarta("2026-08-12", "07:00"),
      pulang: jakarta("2026-08-12", "15:00"),
    });
    expect(result.alasan).toBe("ALREADY_CHECKED_OUT");
  });

  test("mencatat pulang tanpa masuk sebagai Perlu Verifikasi", () => {
    const result = scan(jakarta("2026-08-12", "15:30"));
    expect(result.alasan).toBe("CHECKOUT_WITHOUT_ENTRY");
    expect(result.statusProses).toBe("Perlu Verifikasi");
    expect(result.jenisScan).toBe("Pulang");
  });
});

describe("tanggal kerja dan timezone operasional", () => {
  test("shift malam sebelum tengah malam memakai tanggal masuk", () => {
    const waktu = "2026-08-12T16:15:00Z"; // 23:15 Asia/Jakarta
    expect(tentukanTanggalKerja(waktu, SHIFT_MALAM)).toBe("2026-08-12");
    expect(scan(waktu, { shift: SHIFT_MALAM }).tanggalKerja).toBe("2026-08-12");
  });

  test("shift malam setelah tengah malam tetap memakai tanggal masuk", () => {
    const masuk = jakarta("2026-08-12", "23:00");
    const result = scan(jakarta("2026-08-13", "07:00"), {
      shift: SHIFT_MALAM,
      masuk,
    });
    expect(result.tanggalKerja).toBe("2026-08-12");
    expect(result.alasan).toBe("NORMAL_CHECKOUT");
  });

  test("buffer shift malam mempertahankan tanggal kerja lama", () => {
    expect(
      tentukanTanggalKerja(jakarta("2026-08-13", "10:30"), SHIFT_MALAM),
    ).toBe("2026-08-12");
  });
});

describe("shift fleksibel", () => {
  test("menerima tepat satu masuk dan satu pulang tanpa aturan terlambat", () => {
    const masuk = scan(jakarta("2026-08-12", "13:00"), {
      shift: SHIFT_FLEKSIBEL,
    });
    const pulang = scan(jakarta("2026-08-12", "17:00"), {
      shift: SHIFT_FLEKSIBEL,
      masuk: jakarta("2026-08-12", "13:00"),
    });
    const ketiga = scan(jakarta("2026-08-12", "18:00"), {
      shift: SHIFT_FLEKSIBEL,
      masuk: jakarta("2026-08-12", "13:00"),
      pulang: jakarta("2026-08-12", "17:00"),
    });

    expect(masuk.alasan).toBe("FLEX_ENTRY");
    expect(masuk.menitTerlambat).toBe(0);
    expect(pulang.alasan).toBe("FLEX_EXIT");
    expect(pulang.perhitungan).toEqual({
      durasiHadirMenit: 240,
      potonganIstirahatMenit: 0,
      jamKerjaMenit: 240,
      lemburMenit: 0,
      jamKerjaKurangMenit: 0,
    });
    expect(ketiga.alasan).toBe("ALREADY_CHECKED_OUT");
  });
});

describe("potongan istirahat", () => {
  test("belum diterapkan tepat pada offset istirahat", () => {
    const result = hitungMenitKerja(
      jakarta("2026-08-12", "07:00"),
      jakarta("2026-08-12", "11:00"),
      SHIFT_PAGI,
    );
    expect(result.durasiHadirMenit).toBe(240);
    expect(result.potonganIstirahatMenit).toBe(0);
    expect(result.jamKerjaMenit).toBe(240);
  });

  test("diterapkan setelah durasi melewati offset istirahat", () => {
    const result = hitungMenitKerja(
      jakarta("2026-08-12", "07:00"),
      jakarta("2026-08-12", "11:01"),
      SHIFT_PAGI,
    );
    expect(result.durasiHadirMenit).toBe(241);
    expect(result.potonganIstirahatMenit).toBe(60);
    expect(result.jamKerjaMenit).toBe(181);
  });

  test("dipotong penuh bila pulang melewati jam masuk + offset", () => {
    // Istirahat mulai 07:00 + 240 = 11:00, lamanya 60 menit. Vektor yang
    // sama dengan `istirahat_dipotong_penuh_setelah_jam_masuk_ditambah_offset`.
    const cases: Array<[string, number, number]> = [
      ["10:30", 0, 210],
      ["11:00", 0, 240],
      ["11:01", 60, 181],
      ["11:30", 60, 210],
      ["12:00", 60, 240],
    ];
    for (const [pulang, potongan, kerja] of cases) {
      const result = hitungMenitKerja(
        jakarta("2026-08-12", "07:00"),
        jakarta("2026-08-12", pulang),
        SHIFT_PAGI,
      );
      expect([result.potonganIstirahatMenit, result.jamKerjaMenit]).toEqual([
        potongan,
        kerja,
      ]);
    }
  });

  test("offset diukur dari jam masuk shift, bukan dari jam scan", () => {
    const result = hitungMenitKerja(
      jakarta("2026-08-12", "06:00"),
      jakarta("2026-08-12", "10:30"),
      SHIFT_PAGI,
    );
    expect(result.potonganIstirahatMenit).toBe(0);
    expect(result.jamKerjaMenit).toBe(210);
  });
});

describe("jam kerja dimulai dari jam masuk shift", () => {
  test("datang di jendela tepat waktu tidak menambah jam kerja maupun lembur", () => {
    const result = hitungMenitKerja(
      jakarta("2026-08-12", "06:00"),
      jakarta("2026-08-12", "15:00"),
      SHIFT_PAGI,
    );
    expect(result).toEqual({
      durasiHadirMenit: 540,
      potonganIstirahatMenit: 60,
      jamKerjaMenit: 420,
      lemburMenit: 0,
      jamKerjaKurangMenit: 0,
    });
  });

  test("terlambat tetap dihitung dari jam scan sebenarnya", () => {
    const result = hitungMenitKerja(
      jakarta("2026-08-12", "07:10"),
      jakarta("2026-08-12", "15:00"),
      SHIFT_PAGI,
    );
    expect(result.jamKerjaMenit).toBe(410);
    expect(result.jamKerjaKurangMenit).toBe(10);
  });

  test("shift malam memakai jam masuk pada tanggal kerjanya", () => {
    const result = hitungMenitKerja(
      jakarta("2026-08-12", "22:00"),
      jakarta("2026-08-13", "07:00"),
      SHIFT_MALAM,
    );
    expect(result.durasiHadirMenit).toBe(540);
    expect(result.potonganIstirahatMenit).toBe(60);
    expect(result.jamKerjaMenit).toBe(420);
  });
});

describe("rumus bersama jendela masuk dan jam kerja normal", () => {
  test("jendela masuk disusun mundur dari jam masuk", () => {
    // Vektor yang sama dengan `jendela_masuk_disusun_mundur_dari_jam_masuk`.
    const aturan = {
      awalAbsenMenit: 120,
      batasMasukMenit: 60,
      toleransiMasukMenit: 30,
    };
    expect(jendelaScanMasuk(aturan)).toEqual({
      bukaMenit: -180,
      tepatWaktuMenit: -60,
      tutupMenit: 30,
    });
    expect(diDalamJendelaScanMasuk(-181, aturan)).toBe(false);
    expect(diDalamJendelaScanMasuk(-180, aturan)).toBe(true);
    expect(diDalamJendelaScanMasuk(0, aturan)).toBe(true);
    expect(diDalamJendelaScanMasuk(30, aturan)).toBe(true);
    expect(diDalamJendelaScanMasuk(31, aturan)).toBe(false);
    expect(hitungTerlambatDanDatangAwal(430, 420)).toEqual({
      menitTerlambat: 10,
      menitDatangAwal: 0,
    });
    expect(hitungTerlambatDanDatangAwal(400, 420)).toEqual({
      menitTerlambat: 0,
      menitDatangAwal: 20,
    });
  });

  test("koreksi admin boleh mencatat masuk setelah toleransi, sebelum jam pulang", () => {
    const aturan = {
      awalAbsenMenit: 120,
      batasMasukMenit: 60,
      toleransiMasukMenit: 0,
      jamMasuk: "07:00",
      jamPulang: "15:00",
    };
    expect(diDalamRentangKoreksiMasuk(-181, aturan)).toBe(false);
    expect(diDalamRentangKoreksiMasuk(45, aturan)).toBe(true);
    expect(diDalamRentangKoreksiMasuk(479, aturan)).toBe(true);
    expect(diDalamRentangKoreksiMasuk(480, aturan)).toBe(false);
  });

  test("jam kerja normal tidak lagi ditambah batas masuk", () => {
    expect(hitungJamKerjaNormalMenit("07:00", "15:00", 60)).toBe(420);
    expect(hitungJamKerjaNormalMenit("22:00", "06:00", 60)).toBe(420);
    expect(hitungJamKerjaNormalMenit("07:00", "07:30", 60)).toBe(0);
    expect(hitungJamKerjaNormalMenit("bukan-jam", "15:00", 60)).toBe(0);
  });

  test("perhitungan ulang jalur admin sama dengan scanner", () => {
    const shift = {
      jamMasuk: "07:00",
      jamPulang: "15:00",
      jamKerjaNormalMenit: 420,
      istirahatMenit: 60,
      offsetIstirahatMulai: 240,
    };
    expect(
      hitungUlangAbsensiDariJam({
        masukMenit: 6 * 60,
        durasiMenit: 9 * 60,
        shift,
      }),
    ).toEqual({
      menitTerlambat: 0,
      menitDatangAwal: 60,
      jamKerja: 420,
      lembur: 0,
      jamKerjaKurang: 0,
    });
    expect(
      hitungUlangAbsensiDariJam({
        masukMenit: 7 * 60 + 10,
        durasiMenit: null,
        shift,
      }),
    ).toEqual({
      menitTerlambat: 10,
      menitDatangAwal: 0,
      jamKerja: 0,
      lembur: 0,
      jamKerjaKurang: 0,
    });
    // Shift malam: masuk 00:10 untuk shift 22:00 terbaca terlambat 130 menit.
    expect(
      hitungUlangAbsensiDariJam({
        masukMenit: 10,
        durasiMenit: null,
        shift: { ...shift, jamMasuk: "22:00", jamPulang: "06:00" },
      }).menitTerlambat,
    ).toBe(130);
    // Shift fleksibel: tidak ada terlambat, istirahat tetap dikurangi.
    expect(
      hitungUlangAbsensiDariJam({
        masukMenit: 13 * 60,
        durasiMenit: 240,
        shift: {
          ...shift,
          jamMasuk: "00:00",
          jamPulang: "23:59",
          jamKerjaNormalMenit: 1439,
          istirahatMenit: 0,
        },
      }).menitTerlambat,
    ).toBe(0);
  });
});

describe("input waktu eksplisit", () => {
  test("menolak timestamp string tanpa offset timezone", () => {
    expect(() => scan("2026-08-12 07:00:00")).toThrow(
      "offset timezone eksplisit",
    );
  });
});
