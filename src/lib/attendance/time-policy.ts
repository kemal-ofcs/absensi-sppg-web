export const OPERATIONAL_TIME_ZONE = "Asia/Jakarta";

export type ExplicitInstant = Date | number | string;
export type ShiftKind = "regular" | "flexible";
export type ScanKind = "Masuk" | "Pulang";
export type ProcessStatus = "Berhasil" | "Perlu Verifikasi" | "Ditolak";

export interface ShiftTimePolicy {
  kind: ShiftKind;
  jamMasuk: string;
  jamPulang: string;
  awalAbsenMenit: number;
  batasMasukMenit: number;
  toleransiMasukMenit: number;
  batasPulangMenit: number;
  bufferShiftMalamMenit: number;
  offsetIstirahatMulai: number;
  jamKerjaNormalMenit: number;
  istirahatMenit: number;
}

export interface ScanHistory {
  waktuMasuk?: ExplicitInstant | null;
  waktuPulang?: ExplicitInstant | null;
  scanTerakhir?: ExplicitInstant | null;
  jenisScanTerakhir?: ScanKind | null;
}

export type TimeDecisionReason =
  | "FLEX_ENTRY"
  | "FLEX_EXIT"
  | "ALREADY_CHECKED_OUT"
  | "TOO_EARLY"
  | "EARLY_ENTRY"
  | "ON_TIME_ENTRY"
  | "LATE_ENTRY"
  | "ENTRY_WINDOW_CLOSED"
  | "MULTI_SCAN"
  | "EARLY_CHECKOUT"
  | "NORMAL_CHECKOUT"
  | "OVERTIME_CHECKOUT"
  | "CHECKOUT_TOO_LATE"
  | "CHECKOUT_WITHOUT_ENTRY"
  | "INVALID_HISTORY";

export interface WorkMetrics {
  durasiHadirMenit: number;
  potonganIstirahatMenit: number;
  jamKerjaMenit: number;
  lemburMenit: number;
  jamKerjaKurangMenit: number;
}

export interface TimeScanDecision {
  boleh: boolean;
  alasan: TimeDecisionReason;
  jenisScan: string;
  statusProses: ProcessStatus;
  statusKehadiran: "Hadir" | null;
  keterangan: string;
  catatanSistem: string;
  tanggalKerja: string;
  menitTerlambat: number;
  menitDatangAwal: number;
  perhitungan: WorkMetrics;
}

export interface DecideTimeScanInput {
  waktuScan: ExplicitInstant;
  shift: ShiftTimePolicy;
  riwayat?: ScanHistory;
  batasMultiScanMenit: number;
}

interface OperationalDateTime {
  date: string;
  minuteOfDay: number;
  second: number;
}

const EMPTY_METRICS: WorkMetrics = {
  durasiHadirMenit: 0,
  potonganIstirahatMenit: 0,
  jamKerjaMenit: 0,
  lemburMenit: 0,
  jamKerjaKurangMenit: 0,
};

const OPERATIONAL_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: OPERATIONAL_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

export function formatTanggalOperasional(value: ExplicitInstant): string {
  return getOperationalDateTime(toExplicitDate(value, "waktu")).date;
}

export function formatJamOperasional(value: ExplicitInstant): string {
  const operational = getOperationalDateTime(toExplicitDate(value, "waktu"));
  const hour = Math.floor(operational.minuteOfDay / 60);
  const minute = operational.minuteOfDay % 60;
  return `${pad2(hour)}:${pad2(minute)}:${pad2(operational.second)}`;
}

export function formatTimestampOperasional(value: ExplicitInstant): string {
  return `${formatTanggalOperasional(value)} ${formatJamOperasional(value)}`;
}

export function tentukanTanggalKerja(
  waktuScan: ExplicitInstant,
  shift: ShiftTimePolicy,
): string {
  const waktu = toExplicitDate(waktuScan, "waktuScan");
  const lokal = getOperationalDateTime(waktu);

  if (shift.kind === "flexible") return lokal.date;

  const jamMasuk = parseClock(shift.jamMasuk, "jamMasuk");
  const jamPulang = parseClock(shift.jamPulang, "jamPulang");
  assertPolicyMinutes(shift);

  if (jamPulang >= jamMasuk) return lokal.date;

  const batasDeteksiShiftMalam =
    jamPulang + shift.batasPulangMenit + shift.bufferShiftMalamMenit;

  return lokal.minuteOfDay <= batasDeteksiShiftMalam
    ? addCalendarDays(lokal.date, -1)
    : lokal.date;
}

export function hitungMenitKerja(
  waktuMasuk: ExplicitInstant,
  waktuPulang: ExplicitInstant,
  shift: ShiftTimePolicy,
): WorkMetrics {
  const masuk = toExplicitDate(waktuMasuk, "waktuMasuk");
  const pulang = toExplicitDate(waktuPulang, "waktuPulang");
  assertPolicyMinutes(shift);

  const durasiHadirMenit = Math.max(
    0,
    Math.floor((pulang.getTime() - masuk.getTime()) / 60_000),
  );

  if (shift.kind === "flexible") {
    return {
      durasiHadirMenit,
      potonganIstirahatMenit: 0,
      jamKerjaMenit: durasiHadirMenit,
      lemburMenit: 0,
      jamKerjaKurangMenit: 0,
    };
  }

  const potonganIstirahatMenit =
    durasiHadirMenit > shift.offsetIstirahatMulai ? shift.istirahatMenit : 0;
  const jamKerjaMenit = Math.max(0, durasiHadirMenit - potonganIstirahatMenit);

  return {
    durasiHadirMenit,
    potonganIstirahatMenit,
    jamKerjaMenit,
    lemburMenit: Math.max(0, jamKerjaMenit - shift.jamKerjaNormalMenit),
    jamKerjaKurangMenit: Math.max(0, shift.jamKerjaNormalMenit - jamKerjaMenit),
  };
}

export function putuskanScanWaktu(
  input: DecideTimeScanInput,
): TimeScanDecision {
  const waktuScan = toExplicitDate(input.waktuScan, "waktuScan");
  const riwayat = input.riwayat ?? {};
  const waktuMasuk = riwayat.waktuMasuk
    ? toExplicitDate(riwayat.waktuMasuk, "riwayat.waktuMasuk")
    : null;
  const waktuPulang = riwayat.waktuPulang
    ? toExplicitDate(riwayat.waktuPulang, "riwayat.waktuPulang")
    : null;
  const scanTerakhir = riwayat.scanTerakhir
    ? toExplicitDate(riwayat.scanTerakhir, "riwayat.scanTerakhir")
    : null;

  assertPolicyMinutes(input.shift);
  assertNonNegativeInteger(input.batasMultiScanMenit, "batasMultiScanMenit");

  const tanggalKerja = waktuMasuk
    ? getOperationalDateTime(waktuMasuk).date
    : waktuPulang
      ? getOperationalDateTime(waktuPulang).date
      : tentukanTanggalKerja(waktuScan, input.shift);

  if (waktuPulang) {
    return decision({
      boleh: false,
      alasan: "ALREADY_CHECKED_OUT",
      jenisScan: "Pulang Ditolak",
      statusProses: "Ditolak",
      keterangan: "",
      catatanSistem: "Scan pulang sudah tercatat sebelumnya",
      tanggalKerja,
    });
  }

  if (waktuMasuk && waktuScan.getTime() < waktuMasuk.getTime()) {
    return decision({
      boleh: false,
      alasan: "INVALID_HISTORY",
      jenisScan: "Scan Ditolak",
      statusProses: "Ditolak",
      keterangan: "",
      catatanSistem: "Waktu scan lebih awal daripada riwayat masuk",
      tanggalKerja,
    });
  }

  if (
    waktuMasuk &&
    scanTerakhir &&
    riwayat.jenisScanTerakhir === "Masuk" &&
    input.batasMultiScanMenit > 0
  ) {
    const selisihMs = waktuScan.getTime() - scanTerakhir.getTime();

    if (selisihMs < 0) {
      return decision({
        boleh: false,
        alasan: "INVALID_HISTORY",
        jenisScan: "Scan Ditolak",
        statusProses: "Ditolak",
        keterangan: "",
        catatanSistem: "Waktu scan lebih awal daripada scan terakhir",
        tanggalKerja,
      });
    }

    if (selisihMs <= input.batasMultiScanMenit * 60_000) {
      return decision({
        boleh: false,
        alasan: "MULTI_SCAN",
        jenisScan: "Multi Scan Ditolak",
        statusProses: "Ditolak",
        keterangan: "",
        catatanSistem: `Kemungkinan scan masuk ganda dalam ${input.batasMultiScanMenit} menit`,
        tanggalKerja,
      });
    }
  }

  if (input.shift.kind === "flexible") {
    if (!waktuMasuk) {
      return decision({
        boleh: true,
        alasan: "FLEX_ENTRY",
        jenisScan: "Masuk",
        statusProses: "Berhasil",
        keterangan: "Fleksibel",
        catatanSistem: "Scan masuk shift fleksibel",
        tanggalKerja,
      });
    }

    return decision({
      boleh: true,
      alasan: "FLEX_EXIT",
      jenisScan: "Pulang",
      statusProses: "Berhasil",
      keterangan: "Fleksibel",
      catatanSistem: "Scan pulang shift fleksibel",
      tanggalKerja,
      perhitungan: hitungMenitKerja(waktuMasuk, waktuScan, input.shift),
    });
  }

  const lokal = getOperationalDateTime(waktuScan);
  const menitPadaGarisWaktu =
    calendarDayDifference(tanggalKerja, lokal.date) * 1440 + lokal.minuteOfDay;
  const jamMasuk = parseClock(input.shift.jamMasuk, "jamMasuk");
  const jamPulangDasar = parseClock(input.shift.jamPulang, "jamPulang");
  const jamPulang =
    jamPulangDasar < jamMasuk ? jamPulangDasar + 1440 : jamPulangDasar;
  const awalMasuk = jamMasuk - input.shift.awalAbsenMenit;
  const batasMasukNormal = jamMasuk + input.shift.batasMasukMenit;
  const batasAkhirMasuk = batasMasukNormal + input.shift.toleransiMasukMenit;
  const batasAkhirPulang = jamPulang + input.shift.batasPulangMenit;

  if (!waktuMasuk) {
    if (
      menitPadaGarisWaktu >= jamPulang &&
      menitPadaGarisWaktu <= batasAkhirPulang
    ) {
      return decision({
        boleh: true,
        alasan: "CHECKOUT_WITHOUT_ENTRY",
        jenisScan: "Pulang",
        statusProses: "Perlu Verifikasi",
        keterangan: "Perlu Verifikasi",
        catatanSistem: "Scan pulang tanpa data scan masuk",
        tanggalKerja,
      });
    }

    if (menitPadaGarisWaktu < awalMasuk) {
      return decision({
        boleh: false,
        alasan: "TOO_EARLY",
        jenisScan: "Masuk Ditolak - Terlalu Awal",
        statusProses: "Ditolak",
        keterangan: "",
        catatanSistem: "Scan sebelum batas datang awal shift",
        tanggalKerja,
      });
    }

    if (menitPadaGarisWaktu < jamMasuk) {
      return decision({
        boleh: true,
        alasan: "EARLY_ENTRY",
        jenisScan: "Masuk",
        statusProses: "Berhasil",
        keterangan: "Datang Lebih Awal",
        catatanSistem: "Scan masuk dalam jendela datang awal",
        tanggalKerja,
        menitDatangAwal: jamMasuk - menitPadaGarisWaktu,
      });
    }

    if (menitPadaGarisWaktu <= batasMasukNormal) {
      return decision({
        boleh: true,
        alasan: "ON_TIME_ENTRY",
        jenisScan: "Masuk",
        statusProses: "Berhasil",
        keterangan: "Tepat Waktu",
        catatanSistem: "Scan masuk tepat waktu",
        tanggalKerja,
      });
    }

    if (menitPadaGarisWaktu <= batasAkhirMasuk) {
      return decision({
        boleh: true,
        alasan: "LATE_ENTRY",
        jenisScan: "Masuk",
        statusProses: "Berhasil",
        keterangan: "Terlambat",
        catatanSistem: "Scan masuk dalam toleransi keterlambatan",
        tanggalKerja,
        menitTerlambat: menitPadaGarisWaktu - batasMasukNormal,
      });
    }

    return decision({
      boleh: false,
      alasan: "ENTRY_WINDOW_CLOSED",
      jenisScan: "Masuk Ditolak",
      statusProses: "Ditolak",
      keterangan: "",
      catatanSistem: "Melewati batas toleransi masuk",
      tanggalKerja,
    });
  }

  if (menitPadaGarisWaktu > batasAkhirPulang) {
    return decision({
      boleh: false,
      alasan: "CHECKOUT_TOO_LATE",
      jenisScan: "Pulang Ditolak",
      statusProses: "Ditolak",
      keterangan: "",
      catatanSistem: "Melewati batas waktu pulang shift",
      tanggalKerja,
    });
  }

  const perhitungan = hitungMenitKerja(waktuMasuk, waktuScan, input.shift);

  if (menitPadaGarisWaktu < jamPulang) {
    return decision({
      boleh: true,
      alasan: "EARLY_CHECKOUT",
      jenisScan: "Pulang",
      statusProses: "Berhasil",
      keterangan: "Pulang Lebih Awal",
      catatanSistem: "Pulang lebih awal",
      tanggalKerja,
      perhitungan,
    });
  }

  if (perhitungan.lemburMenit > 0) {
    return decision({
      boleh: true,
      alasan: "OVERTIME_CHECKOUT",
      jenisScan: "Pulang",
      statusProses: "Berhasil",
      keterangan: "Pulang Lembur",
      catatanSistem: "Pulang lembur",
      tanggalKerja,
      perhitungan,
    });
  }

  return decision({
    boleh: true,
    alasan: "NORMAL_CHECKOUT",
    jenisScan: "Pulang",
    statusProses: "Berhasil",
    keterangan:
      perhitungan.jamKerjaKurangMenit > 0
        ? "Pulang Lebih Awal"
        : "Pulang Normal",
    catatanSistem: "Pulang dalam jendela normal",
    tanggalKerja,
    perhitungan,
  });
}

function decision(
  value: Omit<
    TimeScanDecision,
    "statusKehadiran" | "menitTerlambat" | "menitDatangAwal" | "perhitungan"
  > &
    Partial<
      Pick<
        TimeScanDecision,
        "statusKehadiran" | "menitTerlambat" | "menitDatangAwal" | "perhitungan"
      >
    >,
): TimeScanDecision {
  return {
    ...value,
    statusKehadiran: value.boleh ? "Hadir" : null,
    menitTerlambat: value.menitTerlambat ?? 0,
    menitDatangAwal: value.menitDatangAwal ?? 0,
    perhitungan: value.perhitungan ?? { ...EMPTY_METRICS },
  };
}

function getOperationalDateTime(value: Date): OperationalDateTime {
  const parts = OPERATIONAL_FORMATTER.formatToParts(value);
  const values = Object.fromEntries(
    parts
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  const hour = Number(values.hour);
  const minute = Number(values.minute);
  const second = Number(values.second);

  return {
    date: `${values.year}-${values.month}-${values.day}`,
    minuteOfDay: hour * 60 + minute,
    second,
  };
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function toExplicitDate(value: ExplicitInstant, label: string): Date {
  if (
    typeof value === "string" &&
    !/(?:Z|[+-]\d{2}:\d{2})$/i.test(value.trim())
  ) {
    throw new Error(`${label} harus memiliki offset timezone eksplisit.`);
  }

  const date =
    value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`${label} tidak valid.`);
  }
  return date;
}

function parseClock(value: string, label: string): number {
  const match = /^(\d{2}):(\d{2})(?::\d{2})?$/.exec(value.trim());
  if (!match) throw new Error(`${label} harus berformat HH:mm.`);

  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) {
    throw new Error(`${label} berada di luar rentang waktu 24 jam.`);
  }
  return hour * 60 + minute;
}

function assertPolicyMinutes(shift: ShiftTimePolicy): void {
  const fields: Array<[number, string]> = [
    [shift.awalAbsenMenit, "awalAbsenMenit"],
    [shift.batasMasukMenit, "batasMasukMenit"],
    [shift.toleransiMasukMenit, "toleransiMasukMenit"],
    [shift.batasPulangMenit, "batasPulangMenit"],
    [shift.bufferShiftMalamMenit, "bufferShiftMalamMenit"],
    [shift.offsetIstirahatMulai, "offsetIstirahatMulai"],
    [shift.jamKerjaNormalMenit, "jamKerjaNormalMenit"],
    [shift.istirahatMenit, "istirahatMenit"],
  ];

  for (const [value, label] of fields) assertNonNegativeInteger(value, label);
}

function assertNonNegativeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} harus berupa menit bilangan bulat non-negatif.`);
  }
}

function addCalendarDays(date: string, days: number): string {
  const parsed = parseCalendarDate(date);
  const result = new Date(
    Date.UTC(parsed.year, parsed.month - 1, parsed.day + days),
  );
  return result.toISOString().slice(0, 10);
}

function calendarDayDifference(from: string, to: string): number {
  const start = parseCalendarDate(from);
  const end = parseCalendarDate(to);
  return Math.round(
    (Date.UTC(end.year, end.month - 1, end.day) -
      Date.UTC(start.year, start.month - 1, start.day)) /
      86_400_000,
  );
}

function parseCalendarDate(value: string): {
  year: number;
  month: number;
  day: number;
} {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new Error(`Tanggal kalender tidak valid: ${value}`);
  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
  };
}
