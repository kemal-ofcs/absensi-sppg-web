/**
 * Hari kerja mingguan dan hari libur massal.
 *
 * Libur mingguan adalah ATURAN, bukan baris `tbl_hari_libur`: karyawan
 * mengikuti `tbl_shift.hari_kerja`. Libur nasional tetap data per tanggal.
 *
 * Cermin `desktop/hari_kerja.rs`; keduanya diuji dengan vektor yang sama.
 */

type Hasil<T> = { ok: true; value: T } | { ok: false; error: string };

/** Bawaan kolom `tbl_shift.hari_kerja`: tujuh hari, perilaku sebelum v50. */
export const HARI_KERJA_SEMUA = "1,2,3,4,5,6,7";

export const NAMA_HARI = [
  "Senin",
  "Selasa",
  "Rabu",
  "Kamis",
  "Jumat",
  "Sabtu",
  "Minggu",
] as const;

/**
 * Cermin `validate_hari_kerja`. Masukan daftar angka 1 (Senin) s.d. 7
 * (Minggu); hasilnya teks kanonik terurut, misalnya `"1,2,3,4,5"`. Bentuk itu
 * yang dibaca payroll lewat `instr()`, jadi hanya bentuk ini yang boleh
 * tersimpan.
 */
export function validateHariKerja(nilai: unknown): Hasil<string> {
  if (!Array.isArray(nilai) || nilai.length === 0) {
    return { ok: false, error: "Pilih minimal satu hari kerja." };
  }
  if (nilai.some((hari) => !Number.isInteger(hari) || hari < 1 || hari > 7)) {
    return {
      ok: false,
      error: "Hari kerja harus angka 1 (Senin) sampai 7 (Minggu).",
    };
  }
  if (new Set(nilai).size !== nilai.length) {
    return { ok: false, error: "Hari kerja tidak boleh ganda." };
  }
  return {
    ok: true,
    value: [...(nilai as number[])].sort((a, b) => a - b).join(","),
  };
}

/**
 * Cermin `parse_hari_kerja`. Nilai kosong atau rusak berarti tujuh hari,
 * supaya shift lama tidak tiba-tiba punya hari libur.
 */
export function parseHariKerja(tersimpan: string | null | undefined): number[] {
  const bagian = (tersimpan ?? "").split(",").map((s) => s.trim());
  const hasil = validateHariKerja(
    bagian.every((s) => /^[1-7]$/.test(s)) ? bagian.map(Number) : [],
  );
  return hasil.ok ? hasil.value.split(",").map(Number) : [1, 2, 3, 4, 5, 6, 7];
}

/** Teks pendek untuk kartu shift: "Setiap hari", "Senin s.d. Jumat", atau daftar. */
export function ringkasHariKerja(hari: readonly number[]): string {
  if (hari.length === 7) return "Setiap hari";
  const nama = hari.map((h) => NAMA_HARI[h - 1]);
  const berurutan = hari.every((h, i) => i === 0 || h === hari[i - 1] + 1);
  return berurutan && hari.length >= 3
    ? `${nama[0]} s.d. ${nama[nama.length - 1]}`
    : nama.join(", ");
}

/** Cermin `tanggal_valid`: `YYYY-MM-DD` yang benar-benar ada di kalender. */
export function tanggalValid(tanggal: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(tanggal)) return false;
  const [y, m, d] = tanggal.split("-").map(Number);
  const waktu = new Date(Date.UTC(y, m - 1, d));
  return (
    waktu.getUTCFullYear() === y &&
    waktu.getUTCMonth() === m - 1 &&
    waktu.getUTCDate() === d
  );
}

/** Cermin `hari_iso`: 1 = Senin s.d. 7 = Minggu, `null` bila tanggal tidak sah. */
export function hariIso(tanggal: string): number | null {
  if (!tanggalValid(tanggal)) return null;
  const [y, m, d] = tanggal.split("-").map(Number);
  const w = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return w === 0 ? 7 : w;
}

/**
 * Cermin `wajib_masuk`: apakah seseorang dijadwalkan masuk pada tanggal itu.
 * Libur mingguannya dinilai lebih dulu; pada tanggal libur aktif hanya yang
 * masuk whitelist (`masukSaatLibur`) yang dijadwalkan. Tanggal yang tidak sah
 * dianggap hari kerja, perilaku sebelum aturan ini ada.
 */
export function wajibMasuk(p: {
  tanggal: string;
  hariMasuk: readonly number[];
  libur: boolean;
  masukSaatLibur: boolean;
}): boolean {
  const hari = hariIso(p.tanggal);
  if (hari !== null && !p.hariMasuk.includes(hari)) return false;
  return !p.libur || p.masukSaatLibur;
}

// ── Hari libur massal: impor libur nasional dan rentang tanggal ─────────────

export const JENIS_LIBUR = [
  "Libur Nasional",
  "Cuti Bersama",
  "Libur Khusus",
] as const;

/** Batas satu kali simpan; rentang dan impor setahun jauh di bawahnya. */
export const MAKS_LIBUR_MASSAL = 120;

export interface LiburMassal {
  tanggal: string;
  nama_libur: string;
  jenis_libur: string;
  keterangan: string | null;
}

/**
 * Cermin `validate_libur_massal`. Tanggal ganda di dalam satu kiriman ditolak,
 * bukan digabung, karena namanya bisa berbeda dan memilih salah satunya
 * berarti menebak.
 */
export function validateLiburMassal(nilai: unknown): Hasil<LiburMassal[]> {
  if (!Array.isArray(nilai) || nilai.length === 0) {
    return { ok: false, error: "Pilih minimal satu tanggal libur." };
  }
  if (nilai.length > MAKS_LIBUR_MASSAL) {
    return {
      ok: false,
      error: `Paling banyak ${MAKS_LIBUR_MASSAL} tanggal sekali simpan.`,
    };
  }
  const hasil: LiburMassal[] = [];
  const terlihat = new Set<string>();
  for (const item of nilai) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      return { ok: false, error: "Data hari libur tidak valid." };
    }
    const baris = item as Record<string, unknown>;
    const tanggal =
      typeof baris.tanggal === "string" ? baris.tanggal.trim() : "";
    if (!tanggalValid(tanggal)) {
      return { ok: false, error: `Tanggal "${tanggal}" tidak valid.` };
    }
    if (terlihat.has(tanggal)) {
      return { ok: false, error: `Tanggal ${tanggal} tercantum dua kali.` };
    }
    terlihat.add(tanggal);
    const nama =
      typeof baris.nama_libur === "string" ? baris.nama_libur.trim() : "";
    if (!nama || [...nama].length > 120) {
      return {
        ok: false,
        error: `Nama libur ${tanggal} wajib diisi, maksimal 120 karakter.`,
      };
    }
    const jenis =
      typeof baris.jenis_libur === "string" ? baris.jenis_libur.trim() : "";
    if (!(JENIS_LIBUR as readonly string[]).includes(jenis)) {
      return { ok: false, error: `Jenis libur ${tanggal} tidak dikenal.` };
    }
    const keterangan =
      typeof baris.keterangan === "string" && baris.keterangan.trim()
        ? baris.keterangan.trim()
        : null;
    hasil.push({ tanggal, nama_libur: nama, jenis_libur: jenis, keterangan });
  }
  return { ok: true, value: hasil };
}

/**
 * Setiap tanggal dari `mulai` sampai `sampai` (inklusif). Hanya dipakai layar
 * untuk menyusun kiriman; backend menilai hasilnya lewat `validateLiburMassal`.
 */
export function rentangTanggal(mulai: string, sampai: string): string[] {
  if (!tanggalValid(mulai) || !tanggalValid(sampai) || sampai < mulai) {
    return [];
  }
  const [y, m, d] = mulai.split("-").map(Number);
  const hasil: string[] = [];
  for (let i = 0; hasil.length <= MAKS_LIBUR_MASSAL; i++) {
    const t = new Date(Date.UTC(y, m - 1, d + i)).toISOString().slice(0, 10);
    if (t > sampai) break;
    hasil.push(t);
  }
  return hasil;
}
