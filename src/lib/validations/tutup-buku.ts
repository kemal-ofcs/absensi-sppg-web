import { type Hasil, isValidDate } from "./accounting";

/**
 * Aturan murni tutup buku (Tahap 1), cermin `desktop/tutup_buku.rs` dengan
 * vektor yang sama. Pesan galat wajib identik dengan Rust.
 */

/** WAJIB sama dengan CHECK `keu_tutup_buku.status` dan `STATUS_TUTUP`. */
export const STATUS_TUTUP = [
  "Aktif",
  "Dibuka",
  "Digantikan",
  "Menunggu",
] as const;
export type StatusTutup = (typeof STATUS_TUTUP)[number];

export const MAKS_ALASAN_BUKA = 150;
export const MAKS_CATATAN_KEPUTUSAN = 150;

/** Cermin `KEPUTUSAN_TUTUP`: versi yang `Menunggu` dipakai atau ditolak. */
export const KEPUTUSAN_TUTUP = ["pakai", "tolak"] as const;
export type KeputusanTutup = (typeof KEPUTUSAN_TUTUP)[number];

/** `2026-09-30` → `30/09/2026`. */
export function tanggalTampil(tanggal: string): string {
  const bagian = tanggal.split("-");
  return bagian.length === 3
    ? `${bagian[2]}/${bagian[1]}/${bagian[0]}`
    : tanggal;
}

/** `2026-10-14 08:05:09` → `14/10/2026 08:05:09 WIB`. Hanya untuk tampilan. */
export function waktuTampil(waktu: string): string {
  const [tanggal, jam] = waktu.split(" ");
  return jam ? `${tanggalTampil(tanggal ?? "")} ${jam} WIB` : waktu;
}

/** Cermin `cek_periode_terbuka`. */
export function cekPeriodeTerbuka(
  tanggal: string,
  batas: string | null,
): Hasil<true> {
  if (batas !== null && tanggal <= batas) {
    return {
      ok: false,
      error: `Tanggal ${tanggalTampil(tanggal)} masuk periode yang sudah ditutup (sampai ${tanggalTampil(batas)}). Catat dengan tanggal sesudahnya, atau minta pemegang izin tutup buku membuka periode itu.`,
    };
  }
  return { ok: true, value: true };
}

/** Cermin `validate_tutup`. */
export function validateTutup(
  sampaiMentah: string,
  batas: string | null,
  hariIni: string,
): Hasil<string> {
  const sampai = sampaiMentah.trim();
  if (!isValidDate(sampai)) {
    return { ok: false, error: "Tanggal tutup buku tidak valid." };
  }
  if (sampai >= hariIni) {
    return { ok: false, error: "Tanggal tutup buku harus sebelum hari ini." };
  }
  if (batas !== null && sampai <= batas) {
    return {
      ok: false,
      error: `Buku sudah ditutup sampai ${tanggalTampil(batas)}. Pilih tanggal sesudahnya.`,
    };
  }
  return { ok: true, value: sampai };
}

/** Cermin `validate_alasan_buka`. */
export function validateAlasanBuka(alasanMentah: string): Hasil<string> {
  const alasan = alasanMentah.trim();
  if (!alasan) {
    return { ok: false, error: "Alasan membuka kembali wajib diisi." };
  }
  if ([...alasan].length > MAKS_ALASAN_BUKA) {
    return {
      ok: false,
      error: `Alasan paling banyak ${MAKS_ALASAN_BUKA} karakter.`,
    };
  }
  return { ok: true, value: alasan };
}

/**
 * Cermin `saldo_tutup_json`: potret saldo kanonik (urut `id_akun` secara
 * biner, akun bersaldo nol dibuang), sama byte per byte dengan Rust.
 */
export function saldoTutupJson(
  akun: ReadonlyArray<{ id_akun: string; debit: number; kredit: number }>,
): string {
  const isi = akun
    .filter((a) => a.debit !== 0 || a.kredit !== 0)
    .sort((a, b) =>
      a.id_akun < b.id_akun ? -1 : a.id_akun > b.id_akun ? 1 : 0,
    )
    .map(
      (a) =>
        `{"id_akun":${JSON.stringify(a.id_akun)},"debit":${a.debit},"kredit":${a.kredit}}`,
    );
  return `[${isi.join(",")}]`;
}

/** Cermin `validate_catatan_keputusan`: boleh kosong, paling banyak 150. */
export function validateCatatanKeputusan(
  catatanMentah: string,
): Hasil<string | null> {
  const catatan = catatanMentah.trim();
  if ([...catatan].length > MAKS_CATATAN_KEPUTUSAN) {
    return {
      ok: false,
      error: `Catatan paling banyak ${MAKS_CATATAN_KEPUTUSAN} karakter.`,
    };
  }
  return { ok: true, value: catatan || null };
}

function saldoBersih(jsonSaldo: string): Map<string, number> {
  let isi: unknown;
  try {
    isi = JSON.parse(jsonSaldo);
  } catch {
    // Potret yang tidak terbaca diperlakukan kosong, sama dengan Rust.
    return new Map();
  }
  const hasil = new Map<string, number>();
  if (!Array.isArray(isi)) return hasil;
  for (const item of isi) {
    if (item && typeof item.id_akun === "string") {
      hasil.set(
        item.id_akun,
        (Number(item.debit) || 0) - (Number(item.kredit) || 0),
      );
    }
  }
  return hasil;
}

/**
 * Cermin `banding_saldo`: akun yang saldo bersihnya (debit - kredit) berbeda
 * antara dua potret, urut `id_akun` secara biner.
 */
export function bandingSaldo(
  sebelum: string,
  sesudah: string,
): Array<[string, number, number]> {
  const a = saldoBersih(sebelum);
  const b = saldoBersih(sesudah);
  const kunci = [...new Set([...a.keys(), ...b.keys()])].sort((x, y) =>
    x < y ? -1 : x > y ? 1 : 0,
  );
  return kunci
    .map((id): [string, number, number] => [id, a.get(id) ?? 0, b.get(id) ?? 0])
    .filter(([, x, y]) => x !== y);
}
