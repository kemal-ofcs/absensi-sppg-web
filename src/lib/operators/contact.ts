/**
 * Normalisasi dan validasi kontak operator (email + nomor HP).
 *
 * Dipakai bersama oleh validasi Master Operator, bootstrap Superadmin, dan
 * pencarian akun pada alur "Lupa Password". Satu sumber aturan supaya email
 * yang lolos saat pembuatan akun pasti cocok dengan email yang dicari saat
 * reset password — perbedaan sekecil huruf besar/kecil sudah cukup membuat
 * operator gagal mereset password miliknya sendiri.
 */

/** Longgar pada bentuk, ketat pada struktur: satu @, domain bertitik, tanpa spasi. */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/;

export const OPERATOR_EMAIL_MAX_LENGTH = 120;

/** Email disimpan lowercase karena index unik memakai LOWER(email). */
export function normalizeOperatorEmail(value: string) {
  return value.trim().toLowerCase();
}

/**
 * Nomor HP Indonesia disimpan dalam bentuk kanonik `+62…`.
 *
 * `0812…`, `62812…`, `+62 812-…`, dan `(0812) …` semuanya menunjuk nomor yang
 * sama. Tanpa normalisasi, satu operator bisa tersimpan dengan empat bentuk
 * berbeda dan pencarian nomor tidak pernah cocok.
 */
export function normalizeOperatorPhone(value: string) {
  const digits = value.replace(/[^\d+]/g, "");
  if (!digits) return "";
  const bare = digits.startsWith("+") ? digits.slice(1) : digits;
  if (!/^\d+$/.test(bare)) return "";
  if (bare.startsWith("62")) return `+${bare}`;
  if (bare.startsWith("0")) return `+62${bare.slice(1)}`;
  if (bare.startsWith("8")) return `+62${bare}`;
  // Nomor luar Indonesia tetap diterima apa adanya selama sudah memakai
  // awalan internasional eksplisit.
  return digits.startsWith("+") ? `+${bare}` : "";
}

export function isValidOperatorEmail(value: string) {
  const email = normalizeOperatorEmail(value);
  return email.length <= OPERATOR_EMAIL_MAX_LENGTH && EMAIL_PATTERN.test(email);
}

export function isValidOperatorPhone(value: string) {
  const phone = normalizeOperatorPhone(value);
  if (!phone.startsWith("+")) return false;
  const digits = phone.slice(1);
  return digits.length >= 9 && digits.length <= 15;
}

/**
 * Melempar pesan berbahasa Indonesia yang siap ditampilkan bila kontak tidak
 * memenuhi syarat. Email dan nomor HP wajib untuk setiap akun operator.
 */
export function assertOperatorContact(email: string, phone: string) {
  if (!email.trim()) {
    throw new Error("Email operator wajib diisi.");
  }
  if (!isValidOperatorEmail(email)) {
    throw new Error("Format email operator tidak valid.");
  }
  if (!phone.trim()) {
    throw new Error("Nomor HP operator wajib diisi.");
  }
  if (!isValidOperatorPhone(phone)) {
    throw new Error(
      "Nomor HP operator tidak valid. Gunakan format 08xxxxxxxxxx atau +62xxxxxxxxxx.",
    );
  }
}

/**
 * Menyamarkan email untuk ditampilkan pada layar "Lupa Password".
 *
 * Layar itu terbuka tanpa login, jadi email lengkap tidak boleh ditampilkan:
 * ia akan mengubah form pencarian menjadi alat panen alamat email.
 */
export function maskEmail(value: string) {
  const email = normalizeOperatorEmail(value);
  const at = email.lastIndexOf("@");
  if (at < 1) return "";
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const head = local.slice(0, 1);
  const tail = local.length > 2 ? local.slice(-1) : "";
  const dot = domain.indexOf(".");
  const maskedDomain =
    dot > 1
      ? `${domain.slice(0, 1)}${"*".repeat(Math.max(1, dot - 1))}${domain.slice(dot)}`
      : domain;
  return `${head}${"*".repeat(Math.max(2, local.length - head.length - tail.length))}${tail}@${maskedDomain}`;
}

/** Menyamarkan nomor HP: hanya awalan negara dan empat digit terakhir. */
export function maskPhone(value: string) {
  const phone = normalizeOperatorPhone(value);
  if (!phone) return "";
  const digits = phone.slice(1);
  if (digits.length <= 4) return `+${"*".repeat(digits.length)}`;
  const prefix = digits.slice(0, 2);
  const tail = digits.slice(-4);
  return `+${prefix}${"*".repeat(digits.length - 6)}${tail}`;
}
