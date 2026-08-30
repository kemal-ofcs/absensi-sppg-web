import "server-only";

import type { Client } from "@libsql/client";
import { hashSessionToken } from "@/lib/auth/session-token";
import {
  buildOtpAuthUri,
  generateRecoveryCodes,
  generateTotpSecret,
  normalizeRecoveryCode,
  TOTP_WINDOW_ONLINE,
  verifyTotp,
} from "@/lib/security/totp";

/**
 * Verifikasi dua langkah berbasis TOTP.
 *
 * Dipilih menggantikan penyedia identitas pihak ketiga karena tidak memerlukan
 * jaringan: kode dihitung dari rahasia bersama dan waktu, sehingga janji
 * offline-first aplikasi ini tetap utuh.
 */

export class TwoFactorError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 | 409 = 400,
  ) {
    super(message);
    this.name = "TwoFactorError";
  }
}

export interface TwoFactorStatus {
  enabled: boolean;
  confirmedAt: string;
  /** Sisa kode cadangan yang belum terpakai. */
  recoveryRemaining: number;
  /** Role operator ini mewajibkan 2FA. */
  requiredByRole: boolean;
}

/**
 * Waktu SELALU diambil dari jam database, bukan jam proses yang menjalankan
 * verifikasi.
 *
 * Web berjalan di Vercel dan Desktop/Mobile di perangkat operator; kalau
 * masing-masing memakai jamnya sendiri, satu kode yang sah bisa diterima di
 * satu platform dan ditolak di platform lain. Prinsip yang sama dipakai
 * `time_policy.rs` untuk stempel absensi dan alur "Lupa Password".
 */
async function databaseUnixSeconds(client: Client) {
  const result = await client.execute(
    "SELECT CAST(strftime('%s','now') AS INTEGER) AS now;",
  );
  const seconds = Number(result.rows[0]?.now);
  if (!Number.isFinite(seconds)) {
    throw new TwoFactorError("Jam database tidak dapat dibaca.", 409);
  }
  return seconds;
}

interface OperatorTotpRow {
  secret: string;
  enabled: boolean;
  confirmedAt: string;
  recoveryCodes: string[];
  username: string;
  requireTotp: boolean;
}

async function readOperatorTotp(
  client: Client,
  operatorId: number,
): Promise<OperatorTotpRow> {
  const result = await client.execute({
    sql: `
      SELECT COALESCE(m.totp_secret, '') AS totp_secret,
             COALESCE(m.totp_enabled, 0) AS totp_enabled,
             COALESCE(m.totp_confirmed_at, '') AS totp_confirmed_at,
             COALESCE(m.totp_recovery_codes, '[]') AS totp_recovery_codes,
             m.username,
             COALESCE(r.require_totp, 0) AS require_totp
      FROM master_operator m
      LEFT JOIN app_role r ON r.id = m.role_id
      WHERE m.id = ? LIMIT 1;
    `,
    args: [operatorId],
  });
  const row = result.rows[0];
  if (!row) throw new TwoFactorError("Operator tidak ditemukan.", 404);

  let recoveryCodes: string[] = [];
  try {
    const parsed: unknown = JSON.parse(String(row.totp_recovery_codes));
    if (Array.isArray(parsed)) {
      recoveryCodes = parsed.filter(
        (item): item is string => typeof item === "string",
      );
    }
  } catch {
    recoveryCodes = [];
  }

  return {
    secret: String(row.totp_secret ?? ""),
    enabled: Number(row.totp_enabled) === 1,
    confirmedAt: String(row.totp_confirmed_at ?? ""),
    recoveryCodes,
    username: String(row.username ?? ""),
    requireTotp: Number(row.require_totp) === 1,
  };
}

export async function getTwoFactorStatus(
  client: Client,
  operatorId: number,
): Promise<TwoFactorStatus> {
  const row = await readOperatorTotp(client, operatorId);
  return {
    enabled: row.enabled,
    confirmedAt: row.confirmedAt,
    recoveryRemaining: row.recoveryCodes.length,
    requiredByRole: row.requireTotp,
  };
}

export interface TwoFactorSetup {
  secret: string;
  otpauthUri: string;
}

/**
 * Menerbitkan rahasia baru dan menyimpannya dalam keadaan BELUM aktif.
 *
 * 2FA baru menyala setelah operator membuktikan aplikasi autentikatornya
 * benar-benar menghasilkan kode yang cocok. Mengaktifkannya lebih awal akan
 * mengunci orang yang salah memindai QR dari akunnya sendiri.
 */
export async function beginTwoFactorSetup(
  client: Client,
  operatorId: number,
): Promise<TwoFactorSetup> {
  const row = await readOperatorTotp(client, operatorId);
  if (row.enabled) {
    throw new TwoFactorError(
      "Verifikasi dua langkah sudah aktif. Nonaktifkan dulu sebelum mendaftarkan perangkat baru.",
      409,
    );
  }
  const secret = generateTotpSecret();
  await client.execute({
    sql: `
      UPDATE master_operator
      SET totp_secret = ?, totp_enabled = 0, totp_confirmed_at = NULL,
          totp_recovery_codes = NULL
      WHERE id = ?;
    `,
    args: [secret, operatorId],
  });
  return {
    secret,
    otpauthUri: buildOtpAuthUri({
      secret,
      accountLabel: row.username,
      issuer: "Absensi SPPG",
    }),
  };
}

/**
 * Mengaktifkan 2FA setelah kode pertama terbukti cocok, lalu menerbitkan kode
 * cadangan satu kali.
 *
 * Kode cadangan disimpan sebagai hash: kebocoran database tidak boleh langsung
 * menyerahkan jalan masuk kedua ke setiap akun.
 */
export async function confirmTwoFactorSetup(
  client: Client,
  operatorId: number,
  code: string,
) {
  const row = await readOperatorTotp(client, operatorId);
  if (row.enabled) {
    throw new TwoFactorError("Verifikasi dua langkah sudah aktif.", 409);
  }
  if (!row.secret) {
    throw new TwoFactorError(
      "Pendaftaran belum dimulai. Buka kembali layar pengaturan 2FA.",
      409,
    );
  }
  const now = await databaseUnixSeconds(client);
  if (!(await verifyTotp(row.secret, code, now, TOTP_WINDOW_ONLINE))) {
    throw new TwoFactorError(
      "Kode tidak cocok. Pastikan jam ponsel Anda otomatis dan kodenya belum berganti.",
    );
  }

  const recoveryCodes = generateRecoveryCodes();
  const hashed = await Promise.all(
    recoveryCodes.map((item) => hashSessionToken(normalizeRecoveryCode(item))),
  );
  await client.execute({
    sql: `
      UPDATE master_operator
      SET totp_enabled = 1, totp_confirmed_at = datetime('now'),
          totp_recovery_codes = ?
      WHERE id = ?;
    `,
    args: [JSON.stringify(hashed), operatorId],
  });
  return { recoveryCodes };
}

/**
 * Mematikan 2FA.
 *
 * `requireProof` benar ketika operator mematikan 2FA miliknya sendiri: tanpa
 * bukti, siapa pun yang menumpang sesi terbuka bisa melucuti lapisan kedua itu.
 * Admin yang menolong operator kehilangan ponsel memakai `requireProof: false`,
 * dan tindakan itu dijaga izin `operators.manage`.
 */
export async function disableTwoFactor(
  client: Client,
  operatorId: number,
  options: { requireProof: boolean; code?: string },
) {
  const row = await readOperatorTotp(client, operatorId);
  if (!row.enabled) {
    throw new TwoFactorError("Verifikasi dua langkah memang belum aktif.", 409);
  }
  if (options.requireProof) {
    const accepted = await consumeTotpOrRecovery(
      client,
      operatorId,
      row,
      options.code ?? "",
    );
    if (!accepted) {
      throw new TwoFactorError("Kode verifikasi tidak cocok.", 403);
    }
  }
  await client.execute({
    sql: `
      UPDATE master_operator
      SET totp_secret = NULL, totp_enabled = 0, totp_confirmed_at = NULL,
          totp_recovery_codes = NULL
      WHERE id = ?;
    `,
    args: [operatorId],
  });
  return { disabled: true as const };
}

/**
 * Memeriksa kode TOTP atau kode cadangan.
 *
 * Kode cadangan yang cocok langsung dihapus dari daftar — sekali pakai berarti
 * sekali pakai, dan penghapusannya harus terjadi pada percobaan yang berhasil
 * itu juga, bukan nanti.
 */
async function consumeTotpOrRecovery(
  client: Client,
  operatorId: number,
  row: OperatorTotpRow,
  code: string,
) {
  const now = await databaseUnixSeconds(client);
  if (await verifyTotp(row.secret, code, now, TOTP_WINDOW_ONLINE)) return true;

  const normalized = normalizeRecoveryCode(code);
  if (normalized.length < 6) return false;
  const hashed = await hashSessionToken(normalized);
  if (!row.recoveryCodes.includes(hashed)) return false;

  const remaining = row.recoveryCodes.filter((item) => item !== hashed);
  await client.execute({
    sql: "UPDATE master_operator SET totp_recovery_codes = ? WHERE id = ?;",
    args: [JSON.stringify(remaining), operatorId],
  });
  return true;
}

export type TwoFactorGate =
  | { outcome: "not_required" }
  | { outcome: "enrollment_required" }
  | { outcome: "code_required" }
  | { outcome: "code_invalid" }
  | { outcome: "accepted" };

/**
 * Gerbang 2FA pada saat login, dijalankan SETELAH password terbukti benar.
 *
 * Urutan itu penting: memberi tahu bahwa sebuah akun memakai 2FA sebelum
 * passwordnya benar akan mengubah layar login menjadi alat pemetaan akun mana
 * yang bernilai diserang.
 */
export async function evaluateTwoFactorGate(
  client: Client,
  operatorId: number,
  code: string | undefined,
): Promise<TwoFactorGate> {
  const row = await readOperatorTotp(client, operatorId);
  if (!row.enabled) {
    // Role yang mewajibkan 2FA tetapi operatornya belum mendaftar: login
    // ditahan, dan pesannya mengarahkan ke pendaftaran — bukan menuduh
    // passwordnya salah.
    return row.requireTotp
      ? { outcome: "enrollment_required" }
      : { outcome: "not_required" };
  }
  const clean = (code ?? "").trim();
  if (clean.length === 0) return { outcome: "code_required" };
  const accepted = await consumeTotpOrRecovery(client, operatorId, row, clean);
  return accepted ? { outcome: "accepted" } : { outcome: "code_invalid" };
}
