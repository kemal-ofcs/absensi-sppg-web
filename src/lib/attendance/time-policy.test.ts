import { describe, expect, test } from "bun:test";
import {
  hitungMenitKerja,
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
  test("menolak shift pagi sebelum jendela dibuka", () => {
    const result = scan(jakarta("2026-08-12", "05:59"));
    expect(result.alasan).toBe("TOO_EARLY");
    expect(result.boleh).toBe(false);
  });

  test("menerima datang lebih awal di dalam jendela", () => {
    const result = scan(jakarta("2026-08-12", "06:30"));
    expect(result.alasan).toBe("EARLY_ENTRY");
    expect(result.menitDatangAwal).toBe(30);
  });

  test("menganggap batas masuk normal sebagai tepat waktu", () => {
    const result = scan(jakarta("2026-08-12", "07:15"));
    expect(result.alasan).toBe("ON_TIME_ENTRY");
    expect(result.menitTerlambat).toBe(0);
  });

  test("menerima terlambat yang masih dalam toleransi", () => {
    const result = scan(jakarta("2026-08-12", "07:30"));
    expect(result.alasan).toBe("LATE_ENTRY");
    expect(result.menitTerlambat).toBe(15);
  });

  test("menolak masuk setelah toleransi berakhir", () => {
    const result = scan(jakarta("2026-08-12", "07:46"));
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
});

describe("input waktu eksplisit", () => {
  test("menolak timestamp string tanpa offset timezone", () => {
    expect(() => scan("2026-08-12 07:00:00")).toThrow(
      "offset timezone eksplisit",
    );
  });
});
