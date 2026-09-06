/**
 * TOTP (RFC 6238) untuk verifikasi dua langkah.
 *
 * Dipilih menggantikan penyedia identitas pihak ketiga karena satu alasan yang
 * menentukan pada aplikasi ini: TOTP **tidak butuh jaringan sama sekali**. Kode
 * dihitung dari rahasia bersama dan waktu, jadi operator tetap bisa masuk di
 * dapur tanpa sinyal — janji offline-first aplikasi ini tidak berkurang.
 *
 * SHA-1, bukan SHA-256. Bukan karena lebih aman, melainkan karena Google
 * Authenticator secara historis mengabaikan parameter `algorithm` pada URI
 * otpauth dan selalu memakai SHA-1. Memakai SHA-256 membuat kode yang muncul di
 * aplikasi autentikator TIDAK PERNAH cocok, tanpa pesan error yang menjelaskan.
 * Penggunaan SHA-1 di dalam HMAC tidak terpengaruh kelemahan tumbukan SHA-1.
 */

/** Panjang langkah waktu TOTP, detik. Nilai baku RFC 6238 dan semua autentikator. */
export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;
/** Panjang rahasia dalam byte. 20 byte = 32 karakter base32. */
export const TOTP_SECRET_BYTES = 20;

/**
 * Toleransi langkah waktu saat verifikasi.
 *
 * `online` sempit karena waktunya diambil dari jam server database — satu-satunya
 * jam yang dipercaya aplikasi ini, prinsip yang sama dipakai `time_policy.rs`
 * untuk stempel absensi. `offline` lebih lebar karena terpaksa memakai jam
 * perangkat, yang pada ponsel murah bisa meleset satu menit lebih.
 */
export const TOTP_WINDOW_ONLINE = 1;
export const TOTP_WINDOW_OFFLINE = 4;

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function encodeBase32(bytes: Uint8Array) {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

/**
 * Membaca base32 dengan memaafkan bentuk yang biasa diketik manusia: spasi,
 * tanda hubung, huruf kecil, dan padding `=` semuanya diterima.
 */
export function decodeBase32(value: string) {
  const clean = value.replace(/[\s-]/g, "").replace(/=+$/, "").toUpperCase();
  let bits = 0;
  let accumulator = 0;
  const output: number[] = [];
  for (const character of clean) {
    const index = BASE32_ALPHABET.indexOf(character);
    if (index < 0)
      throw new Error("Rahasia 2FA memuat karakter yang tidak valid.");
    accumulator = (accumulator << 5) | index;
    bits += 5;
    if (bits >= 8) {
      output.push((accumulator >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(output);
}

export function generateTotpSecret() {
  return encodeBase32(
    crypto.getRandomValues(new Uint8Array(TOTP_SECRET_BYTES)),
  );
}

async function hmacSha1(key: Uint8Array, message: Uint8Array) {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(key).buffer,
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    cryptoKey,
    new Uint8Array(message).buffer,
  );
  return new Uint8Array(signature);
}

/** HOTP (RFC 4226): HMAC dari pencacah, lalu pemotongan dinamis jadi 6 digit. */
export async function generateHotp(secretBase32: string, counter: number) {
  const key = decodeBase32(secretBase32);
  if (key.length === 0) throw new Error("Rahasia 2FA kosong.");
  const message = new Uint8Array(8);
  let remaining = counter;
  for (let index = 7; index >= 0; index -= 1) {
    message[index] = remaining & 0xff;
    remaining = Math.floor(remaining / 256);
  }
  const digest = await hmacSha1(key, message);
  const offset = (digest[digest.length - 1] as number) & 0x0f;
  const binary =
    (((digest[offset] as number) & 0x7f) << 24) |
    (((digest[offset + 1] as number) & 0xff) << 16) |
    (((digest[offset + 2] as number) & 0xff) << 8) |
    ((digest[offset + 3] as number) & 0xff);
  return (binary % 10 ** TOTP_DIGITS).toString().padStart(TOTP_DIGITS, "0");
}

export function totpCounter(unixSeconds: number) {
  return Math.floor(unixSeconds / TOTP_STEP_SECONDS);
}

export async function generateTotp(secretBase32: string, unixSeconds: number) {
  return generateHotp(secretBase32, totpCounter(unixSeconds));
}

/**
 * Memverifikasi kode terhadap jendela langkah waktu di sekitar `unixSeconds`.
 *
 * Perbandingannya waktu-tetap supaya lama pemrosesan tidak membocorkan berapa
 * banyak digit awal yang sudah benar.
 */
export async function verifyTotp(
  secretBase32: string,
  code: string,
  unixSeconds: number,
  window: number = TOTP_WINDOW_ONLINE,
) {
  const clean = code.replace(/\D/g, "");
  if (clean.length !== TOTP_DIGITS) return false;
  const center = totpCounter(unixSeconds);
  let matched = false;
  for (let offset = -window; offset <= window; offset += 1) {
    const counter = center + offset;
    if (counter < 0) continue;
    const expected = await generateHotp(secretBase32, counter);
    if (constantTimeEquals(expected, clean)) matched = true;
  }
  return matched;
}

function constantTimeEquals(left: string, right: string) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

/**
 * URI `otpauth://` yang dibaca aplikasi autentikator lewat QR.
 *
 * `issuer` muncul sebagai nama aplikasi di daftar autentikator, dan sengaja
 * diulang pada label supaya beberapa akun SPPG tidak tampil bertumpuk tanpa
 * keterangan di ponsel yang sama.
 */
export function buildOtpAuthUri(input: {
  secret: string;
  accountLabel: string;
  issuer: string;
}) {
  const label = encodeURIComponent(`${input.issuer}:${input.accountLabel}`);
  const params = new URLSearchParams({
    secret: input.secret,
    issuer: input.issuer,
    algorithm: "SHA1",
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/** Jumlah kode cadangan yang diterbitkan saat 2FA diaktifkan. */
export const RECOVERY_CODE_COUNT = 8;

/**
 * Kode cadangan sekali pakai, untuk operator yang kehilangan ponselnya.
 *
 * Tanpa ini, ponsel hilang berarti akun terkunci total dan hanya bisa
 * dipulihkan Admin. Formatnya dikelompokkan empat-empat supaya mudah disalin
 * tangan ke kertas.
 */
export function generateRecoveryCodes(count = RECOVERY_CODE_COUNT) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from({ length: count }, () => {
    const bytes = crypto.getRandomValues(new Uint8Array(8));
    const raw = Array.from(
      bytes,
      (byte) => alphabet[byte % alphabet.length],
    ).join("");
    return `${raw.slice(0, 4)}-${raw.slice(4, 8)}`;
  });
}

/**
 * Bentuk baku sebuah kode cadangan sebelum di-hash atau dibandingkan.
 *
 * Membuang SETIAP karakter non-alfanumerik, bukan hanya spasi dan tanda
 * hubung. Ini cerminan `normalize_recovery_code` di `turso.rs`, yang memakai
 * `is_ascii_alphanumeric`: satu kode yang sama harus menghasilkan hash yang
 * sama di Web maupun Desktop/Mobile, jadi kedua sisi tidak boleh berbeda
 * dalam menerima karakter pemisah yang tidak disengaja.
 */
export function normalizeRecoveryCode(value: string) {
  return value.replace(/[^0-9A-Za-z]/g, "").toUpperCase();
}
