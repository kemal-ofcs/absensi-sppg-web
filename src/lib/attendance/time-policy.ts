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

/**
 * Menit terakhir sebuah hari kalender (23:59).
 *
 * Dipakai sebagai penutup jendela untuk shift fleksibel: shift itu berjalan
 * 00:00-23:59 tanpa aturan, sehingga satu-satunya batas yang masuk akal
 * adalah pergantian hari.
 */
export const MENIT_AKHIR_HARI = 1439;

/** Selisih hari kalender antara dua tanggal `YYYY-MM-DD` (setara `days_between` di Rust). */
export function selisihHariKalender(from: string, to: string): number {
  const [fy, fm, fd] = from.split("-").map(Number);
  const [ty, tm, td] = to.split("-").map(Number);
  if ([fy, fm, fd, ty, tm, td].some((value) => !Number.isFinite(value))) {
    return 0;
  }
  const millisPerDay = 86_400_000;
  return Math.round(
    (Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / millisPerDay,
  );
}

/**
 * Shift "tanpa kewajiban jam tetap" (lihat `05-business-logic-edge-cases.md` §2).
 *
 * Sengaja TIDAK melihat `kode_shift`: kolom itu adalah *stable business key*
 * untuk rekonsiliasi shift offline (`03-schema-4layer-consistency.md`), bukan
 * penanda fleksibel. Porting lama menyamakan `kode_shift === 4` dengan
 * fleksibel, sehingga shift reguler apa pun yang kebetulan memakai kode 4
 * diam-diam dilewati scanner dan Generate Alfa.
 */
export function jenisShift(
  jamMasuk: string,
  jamPulang: string,
  jamKerjaNormalMenit: number,
): ShiftKind {
  return isShiftFleksibel(jamMasuk, jamPulang, jamKerjaNormalMenit)
    ? "flexible"
    : "regular";
}

export function isShiftFleksibel(
  jamMasuk: string,
  jamPulang: string,
  jamKerjaNormalMenit: number,
): boolean {
  if (!Number.isFinite(jamKerjaNormalMenit) || jamKerjaNormalMenit <= 0) {
    return true;
  }
  try {
    const masuk = parseClock(jamMasuk, "jamMasuk");
    const pulang = parseClock(jamPulang, "jamPulang");
    // Rentang yang menutupi satu hari penuh: tidak ada jam masuk/pulang efektif.
    return masuk === pulang || (masuk === 0 && pulang === 1439);
  } catch {
    return false;
  }
}

export type AturanJendelaMasuk = Pick<
  ShiftTimePolicy,
  "awalAbsenMenit" | "batasMasukMenit" | "toleransiMasukMenit"
>;

/**
 * Batas-batas jendela scan masuk, dalam menit RELATIF terhadap Jam Masuk.
 *
 * Seluruh jendelanya tersusun mundur dari Jam Masuk, lalu maju sebatas
 * toleransi (contoh 07:00, awal 120, batas 60, toleransi 30):
 *
 *   04:00 ─ Awal Absen Masuk ─ 06:00 ─ Tepat Waktu ─ 07:00 ─ Terlambat ─ 07:30
 *   buka = -(batas + awal)     tepatWaktu = -batas   0      tutup = +toleransi
 *
 * Sebelum `buka` absensi belum dibuka; setelah `tutup` scan masuk ditolak dan
 * karyawannya harus menghubungi Admin/Operator. Satu-satunya tempat rumus ini
 * dieja di TypeScript — cerminannya `entry_window_offsets` di `time_policy.rs`.
 */
export function jendelaScanMasuk(aturan: AturanJendelaMasuk): {
  bukaMenit: number;
  tepatWaktuMenit: number;
  tutupMenit: number;
} {
  return {
    bukaMenit: -(aturan.batasMasukMenit + aturan.awalAbsenMenit),
    tepatWaktuMenit: -aturan.batasMasukMenit,
    tutupMenit: aturan.toleransiMasukMenit,
  };
}

/** Apakah selisih (menit scan − Jam Masuk) masih di dalam jendela scan masuk. */
export function diDalamJendelaScanMasuk(
  selisihMenit: number,
  aturan: AturanJendelaMasuk,
): boolean {
  const jendela = jendelaScanMasuk(aturan);
  return (
    selisihMenit >= jendela.bukaMenit && selisihMenit <= jendela.tutupMenit
  );
}

/**
 * Rentang jam masuk yang boleh dicatat lewat KOREKSI ADMIN: sejak absensi
 * dibuka sampai sebelum Jam Pulang.
 *
 * Sengaja lebih longgar daripada `diDalamJendelaScanMasuk`: karyawan yang
 * datang melewati toleransi keterlambatan ditolak scanner dan diarahkan ke
 * Admin/Operator, jadi koreksi adalah satu-satunya jalan mencatat kehadirannya.
 * Bila koreksi memakai jendela scanner, orang itu tidak bisa dicatat sama sekali.
 */
export function diDalamRentangKoreksiMasuk(
  selisihMenit: number,
  aturan: AturanJendelaMasuk & Pick<ShiftTimePolicy, "jamMasuk" | "jamPulang">,
): boolean {
  if (selisihMenit < jendelaScanMasuk(aturan).bukaMenit) return false;
  let masuk: number;
  let pulang: number;
  try {
    masuk = parseClock(aturan.jamMasuk, "jamMasuk");
    pulang = parseClock(aturan.jamPulang, "jamPulang");
  } catch {
    return diDalamJendelaScanMasuk(selisihMenit, aturan);
  }
  if (pulang <= masuk) pulang += 1440;
  return (
    selisihMenit < pulang - masuk ||
    selisihMenit <= jendelaScanMasuk(aturan).tutupMenit
  );
}

/**
 * Menit terlambat dan menit datang awal, keduanya diukur dari Jam Masuk.
 *
 * Terlambat dihitung sejak Jam Masuk (bukan sejak akhir jendela Tepat Waktu):
 * jendela Tepat Waktu kini berada SEBELUM Jam Masuk, sehingga menit pertama
 * setelah Jam Masuk sudah terhitung terlambat.
 */
export function hitungTerlambatDanDatangAwal(
  masukMenit: number,
  jamMasukMenit: number,
): { menitTerlambat: number; menitDatangAwal: number } {
  return {
    menitTerlambat: Math.max(0, masukMenit - jamMasukMenit),
    menitDatangAwal: Math.max(0, jamMasukMenit - masukMenit),
  };
}

/**
 * Jam Kerja Normal sebuah shift: (Jam Pulang − Jam Masuk) − Istirahat.
 *
 * Shift malam (jam pulang < jam masuk) melewati tengah malam, jadi jam
 * pulangnya digeser +1440. Cerminan Rust: `calculate_normal_work_minutes`.
 */
export function hitungJamKerjaNormalMenit(
  jamMasuk: string,
  jamPulang: string,
  istirahatMenit: number,
): number {
  let masuk: number;
  let pulang: number;
  try {
    masuk = parseClock(jamMasuk, "jamMasuk");
    pulang = parseClock(jamPulang, "jamPulang");
  } catch {
    return 0;
  }
  if (pulang < masuk) pulang += 1440;
  return Math.max(0, pulang - masuk - (Number(istirahatMenit) || 0));
}

export type AturanJamKerja = Pick<
  ShiftTimePolicy,
  "offsetIstirahatMulai" | "istirahatMenit" | "jamKerjaNormalMenit"
>;

/**
 * Inti perhitungan jam kerja shift reguler. Semua argumen waktunya dalam
 * DETIK pada garis waktu yang sama (asal garis waktunya bebas, asal ketiganya
 * seragam), supaya pemanggil yang hanya punya jam "HH:mm" (koreksi admin,
 * import) dan pemanggil yang punya instant lengkap (scanner) memakai rumus
 * yang sama persis.
 *
 * - Jam kerja dimulai dari Jam Masuk shift: datang lebih awal tidak menambah
 *   jam kerja maupun lembur. Datang terlambat tetap dihitung dari jam scan.
 * - Istirahat dimulai pada Jam Masuk + Offset Potong Istirahat. Pulang setelah
 *   titik itu memotong istirahat PENUH; pulang sebelum atau tepat pada titik
 *   itu tidak dipotong sama sekali.
 *
 * Cerminan Rust: `calculate_work_on_timeline` di `time_policy.rs`.
 */
export function hitungMenitKerjaPadaGarisWaktu(
  masukDetik: number,
  pulangDetik: number,
  jamMasukShiftDetik: number,
  aturan: AturanJamKerja,
): WorkMetrics {
  const durasiHadirMenit = Math.max(
    0,
    Math.floor((pulangDetik - masukDetik) / 60),
  );
  const mulaiKerjaDetik = Math.max(masukDetik, jamMasukShiftDetik);
  const mulaiIstirahatDetik =
    jamMasukShiftDetik + aturan.offsetIstirahatMulai * 60;
  const selesaiIstirahatDetik =
    mulaiIstirahatDetik + aturan.istirahatMenit * 60;
  const potonganIstirahatMenit =
    pulangDetik > mulaiIstirahatDetik && mulaiKerjaDetik < selesaiIstirahatDetik
      ? aturan.istirahatMenit
      : 0;
  const jamKerjaMenit = Math.max(
    0,
    Math.floor(Math.max(0, pulangDetik - mulaiKerjaDetik) / 60) -
      potonganIstirahatMenit,
  );

  return {
    durasiHadirMenit,
    potonganIstirahatMenit,
    jamKerjaMenit,
    lemburMenit: Math.max(0, jamKerjaMenit - aturan.jamKerjaNormalMenit),
    jamKerjaKurangMenit: Math.max(
      0,
      aturan.jamKerjaNormalMenit - jamKerjaMenit,
    ),
  };
}

/**
 * Menempatkan jam masuk "HH:mm" (menit-dalam-hari) pada garis waktu shift:
 * selisihnya terhadap Jam Masuk dinormalkan ke ±12 jam, sehingga scan 23:30
 * untuk shift 01:00 terbaca 90 menit SEBELUM jam masuk (−30), dan scan 00:10
 * untuk shift 22:00 terbaca 130 menit SESUDAHNYA (1450).
 */
export function menitMasukPadaGarisWaktuShift(
  masukMenit: number,
  jamMasukMenit: number,
): number {
  let selisih = masukMenit - jamMasukMenit;
  if (selisih < -720) selisih += 1440;
  if (selisih > 720) selisih -= 1440;
  return jamMasukMenit + selisih;
}

export interface AturanShiftDariJam extends AturanJamKerja {
  jamMasuk: string;
  jamPulang: string;
}

/**
 * Membaca aturan jam kerja dari baris `tbl_shift` mentah. Bawaan untuk kolom
 * NULL mengikuti DDL, sama dengan yang dipakai jalur admin sebelum ini.
 */
export function aturanShiftDariBaris(
  row: Record<string, unknown> | undefined,
): AturanShiftDariJam & AturanJendelaMasuk {
  return {
    jamMasuk: String(row?.jam_masuk || "07:00"),
    jamPulang: String(row?.jam_pulang || "15:00"),
    jamKerjaNormalMenit: Number(row?.jam_kerja_normal_menit ?? 480),
    istirahatMenit: Number(row?.istirahat_menit ?? 60),
    offsetIstirahatMulai: Number(row?.offset_istirahat_mulai ?? 240),
    awalAbsenMenit: Number(row?.awal_absen_menit ?? 120),
    batasMasukMenit: Number(row?.batas_masuk_menit ?? 60),
    toleransiMasukMenit: Number(row?.toleransi_masuk_menit ?? 0),
  };
}

export interface HasilHitungDariJam {
  menitTerlambat: number;
  menitDatangAwal: number;
  jamKerja: number;
  lembur: number;
  jamKerjaKurang: number;
}

/**
 * Perhitungan ulang untuk jalur admin (edit riwayat, koreksi, import, hapus
 * log, sync-push) yang hanya memegang jam masuk "HH:mm" dan durasi hadir yang
 * sudah dihitung pemanggilnya (termasuk lintas tengah malam). Rumusnya sama
 * dengan scanner: terlambat/datang awal diukur dari Jam Masuk, jam kerja
 * dimulai dari Jam Masuk, istirahat dipotong penuh setelah Jam Masuk + Offset.
 *
 * Shift fleksibel tidak punya jam masuk efektif: terlambat/datang awal selalu
 * 0 dan jam kerjanya durasi hadir dikurangi istirahat, seperti sebelumnya.
 * Cerminan Rust: `recalculate_from_clock` di `time_policy.rs`.
 */
export function hitungUlangAbsensiDariJam(input: {
  masukMenit: number | null;
  durasiMenit: number | null;
  shift: AturanShiftDariJam;
}): HasilHitungDariJam {
  const hasil: HasilHitungDariJam = {
    menitTerlambat: 0,
    menitDatangAwal: 0,
    jamKerja: 0,
    lembur: 0,
    jamKerjaKurang: 0,
  };
  if (input.masukMenit === null) return hasil;

  const { shift } = input;
  const normal = shift.jamKerjaNormalMenit;
  if (isShiftFleksibel(shift.jamMasuk, shift.jamPulang, normal)) {
    if (input.durasiMenit !== null) {
      hasil.jamKerja = Math.max(0, input.durasiMenit - shift.istirahatMenit);
      hasil.lembur = Math.max(0, hasil.jamKerja - normal);
      hasil.jamKerjaKurang = Math.max(0, normal - hasil.jamKerja);
    }
    return hasil;
  }

  let jamMasukMenit: number;
  try {
    jamMasukMenit = parseClock(shift.jamMasuk, "jamMasuk");
  } catch {
    return hasil;
  }
  const masuk = menitMasukPadaGarisWaktuShift(input.masukMenit, jamMasukMenit);
  const selisih = hitungTerlambatDanDatangAwal(masuk, jamMasukMenit);
  hasil.menitTerlambat = selisih.menitTerlambat;
  hasil.menitDatangAwal = selisih.menitDatangAwal;

  if (input.durasiMenit !== null) {
    const kerja = hitungMenitKerjaPadaGarisWaktu(
      masuk * 60,
      (masuk + input.durasiMenit) * 60,
      jamMasukMenit * 60,
      shift,
    );
    hasil.jamKerja = kerja.jamKerjaMenit;
    hasil.lembur = kerja.lemburMenit;
    hasil.jamKerjaKurang = kerja.jamKerjaKurangMenit;
  }
  return hasil;
}

/**
 * Menit pada garis waktu tanggal kerja saat jendela scan masuk tertutup:
 * Jam Masuk + Toleransi Keterlambatan (sama dengan `tutupMenit` pada
 * `jendelaScanMasuk`). Setelah menit ini scanner menolak scan masuk, jadi
 * karyawan tanpa baris absensi memang benar-benar "belum absen padahal jam
 * absen sudah lewat".
 */
export function menitPenutupanScanMasuk(shift: ShiftTimePolicy): number {
  // Karyawan shift fleksibel bebas datang jam berapa pun, jadi tidak ada menit
  // di tengah hari yang membuatnya "belum absen padahal sudah lewat".
  if (shift.kind === "flexible") return MENIT_AKHIR_HARI;
  return (
    parseClock(shift.jamMasuk, "jamMasuk") + jendelaScanMasuk(shift).tutupMenit
  );
}

/**
 * Menit pada garis waktu tanggal kerja saat jendela scan pulang tertutup.
 * Untuk shift malam jam pulang ada di hari berikutnya, jadi nilainya > 1440.
 */
export function menitPenutupanScanPulang(shift: ShiftTimePolicy): number {
  // Shift fleksibel tidak punya jam pulang efektif: kewajibannya berakhir
  // bersama hari kalendernya. Rumus reguler akan menambahkan batasPulangMenit
  // ke 23:59 dan mendorong penilaian jauh ke hari berikutnya.
  if (shift.kind === "flexible") return MENIT_AKHIR_HARI;
  const jamMasuk = parseClock(shift.jamMasuk, "jamMasuk");
  const jamPulangDasar = parseClock(shift.jamPulang, "jamPulang");
  const isMalam = jamPulangDasar < jamMasuk;
  const jamPulang = isMalam ? jamPulangDasar + 1440 : jamPulangDasar;
  const buffer = isMalam ? shift.bufferShiftMalamMenit : 0;
  return jamPulang + shift.batasPulangMenit + buffer;
}

/**
 * Menit pada garis waktu tanggal kerja saat Alfa otomatis boleh dibuat.
 *
 * Anchor-nya adalah penutupan jendela scan pulang (jam pulang + batas pulang +
 * buffer shift malam), lalu ditambah `offsetGenerateAlfa`. Offset DITAMBAHKAN,
 * bukan dikurangi, supaya Alfa tidak pernah dibuat selagi karyawan masih
 * berhak scan pulang.
 */
export function menitGenerateAlfa(
  shift: ShiftTimePolicy,
  offsetGenerateAlfaMenit: number,
): number {
  const offset = Number.isFinite(offsetGenerateAlfaMenit)
    ? Math.max(0, offsetGenerateAlfaMenit)
    : 0;
  return menitPenutupanScanPulang(shift) + offset;
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

  // Jam Masuk shift sebagai instant: tengah malam tanggal kerja (dihitung dari
  // komponen operasional scan masuk, jadi tidak ada offset zona yang dieja di
  // sini) ditambah jam masuknya.
  const lokalMasuk = getOperationalDateTime(masuk);
  const tanggalKerja = tentukanTanggalKerja(masuk, shift);
  const tengahMalamTanggalKerjaMs =
    masuk.getTime() -
    masuk.getUTCMilliseconds() -
    (lokalMasuk.minuteOfDay * 60 + lokalMasuk.second) * 1000 +
    calendarDayDifference(lokalMasuk.date, tanggalKerja) * 86_400_000;
  const jamMasukShiftMs =
    tengahMalamTanggalKerjaMs + parseClock(shift.jamMasuk, "jamMasuk") * 60_000;

  return hitungMenitKerjaPadaGarisWaktu(
    masuk.getTime() / 1000,
    pulang.getTime() / 1000,
    jamMasukShiftMs / 1000,
    shift,
  );
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
    ? tentukanTanggalKerja(waktuMasuk, input.shift)
    : waktuPulang
      ? tentukanTanggalKerja(waktuPulang, input.shift)
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
  const jendelaMasuk = jendelaScanMasuk(input.shift);
  const awalMasuk = jamMasuk + jendelaMasuk.bukaMenit;
  const mulaiTepatWaktu = jamMasuk + jendelaMasuk.tepatWaktuMenit;
  const batasAkhirMasuk = jamMasuk + jendelaMasuk.tutupMenit;
  const batasAkhirPulang = jamPulang + input.shift.batasPulangMenit;
  const selisihMasuk = hitungTerlambatDanDatangAwal(
    menitPadaGarisWaktu,
    jamMasuk,
  );

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
        catatanSistem: "Scan sebelum jendela Awal Absen Masuk dibuka",
        tanggalKerja,
      });
    }

    if (menitPadaGarisWaktu < mulaiTepatWaktu) {
      return decision({
        boleh: true,
        alasan: "EARLY_ENTRY",
        jenisScan: "Masuk",
        statusProses: "Berhasil",
        keterangan: "Datang Lebih Awal",
        catatanSistem: "Scan masuk dalam jendela Awal Absen Masuk",
        tanggalKerja,
        menitDatangAwal: selisihMasuk.menitDatangAwal,
      });
    }

    if (menitPadaGarisWaktu <= jamMasuk) {
      return decision({
        boleh: true,
        alasan: "ON_TIME_ENTRY",
        jenisScan: "Masuk",
        statusProses: "Berhasil",
        keterangan: "Tepat Waktu",
        catatanSistem: "Scan masuk tepat waktu",
        tanggalKerja,
        menitDatangAwal: selisihMasuk.menitDatangAwal,
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
        menitTerlambat: selisihMasuk.menitTerlambat,
      });
    }

    return decision({
      boleh: false,
      alasan: "ENTRY_WINDOW_CLOSED",
      jenisScan: "Masuk Ditolak",
      statusProses: "Ditolak",
      keterangan: "",
      catatanSistem:
        "Melewati batas toleransi keterlambatan, perlu Admin/Operator",
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
