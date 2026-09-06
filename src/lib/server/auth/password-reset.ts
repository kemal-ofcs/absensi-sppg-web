import "server-only";

import type { Client } from "@libsql/client";
import { hashPassword, validatePasswordStrength } from "@/lib/auth/password";
import {
  createOpaqueSessionToken,
  hashSessionToken,
} from "@/lib/auth/session-token";
import {
  maskEmail,
  maskPhone,
  normalizeOperatorEmail,
} from "@/lib/operators/contact";
import { revokeOperatorSessions } from "@/lib/operators/operator-admin";
import {
  evaluateLivenessSession,
  isLivenessChallenge,
  LIVENESS_CHALLENGES,
  type LivenessChallenge,
  pickLivenessChallenges,
} from "@/lib/security/face-liveness";
import { decodeLivenessFrames } from "@/lib/security/liveness-codec";
import {
  generateRecoveryCodes,
  normalizeRecoveryCode,
} from "@/lib/security/totp";
import { buildResetEmail, sendMail } from "@/lib/server/mail/mail-store";

/** Umur permintaan sebelum verifikasi wajah selesai. */
const CHALLENGE_TTL_MINUTES = 15;
/** Umur token reset setelah email terkirim. */
export const RESET_TOKEN_TTL_MINUTES = 30;
/** Percobaan verifikasi wajah per permintaan sebelum permintaan dibatalkan. */
const MAX_LIVENESS_ATTEMPTS = 6;
/** Batas ukuran foto bukti (base64) agar satu permintaan tidak membanjiri DB. */
const MAX_PHOTO_BASE64_LENGTH = 900_000;

export class PasswordResetError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 | 429 = 400,
  ) {
    super(message);
    this.name = "PasswordResetError";
  }
}

export interface OperatorLookupResult {
  name: string;
  kodeOperator: string;
  username: string;
  maskedEmail: string;
  maskedPhone: string;
}

interface OperatorRow {
  id: number;
  name: string;
  kodeOperator: string;
  username: string;
  email: string;
  noHp: string;
}

/**
 * Mencari akun dari username, kode operator, atau email.
 *
 * Hanya akun aktif dengan role aktif yang bisa dipulihkan: memulihkan password
 * akun nonaktif akan menghidupkan kembali jalur masuk yang sengaja ditutup.
 */
async function findOperator(client: Client, identifier: string) {
  const clean = identifier.trim();
  if (clean.length < 3 || clean.length > 120) return null;
  const email = normalizeOperatorEmail(clean);
  const result = await client.execute({
    sql: `
      SELECT m.id, m.nama_operator, m.kode_operator, m.username,
             COALESCE(m.email, '') AS email, COALESCE(m.no_hp, '') AS no_hp
      FROM master_operator m
      JOIN app_role r ON r.id = m.role_id
      WHERE (
        m.username = ? COLLATE NOCASE
        OR m.kode_operator = ? COLLATE NOCASE
        OR LOWER(COALESCE(m.email, '')) = ?
      )
      AND m.status = 'Aktif' AND r.status = 'Aktif'
      LIMIT 1;
    `,
    args: [clean, clean, email],
  });
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: Number(row.id),
    name: String(row.nama_operator),
    kodeOperator: String(row.kode_operator),
    username: String(row.username),
    email: String(row.email ?? ""),
    noHp: String(row.no_hp ?? ""),
  } satisfies OperatorRow;
}

function assertRecoverable(operator: OperatorRow | null): OperatorRow {
  if (!operator) {
    throw new PasswordResetError(
      "Akun dengan username atau email tersebut tidak ditemukan.",
      404,
    );
  }
  if (!operator.email.trim()) {
    throw new PasswordResetError(
      "Akun ini belum memiliki email terdaftar sehingga link reset tidak dapat dikirim. Hubungi Admin untuk melengkapi data akun.",
      409,
    );
  }
  return operator;
}

/** Langkah 1: menampilkan identitas tersamar untuk dikonfirmasi pemohon. */
export async function lookupResetAccount(
  client: Client,
  identifier: string,
): Promise<OperatorLookupResult> {
  const operator = assertRecoverable(await findOperator(client, identifier));
  return {
    name: operator.name,
    kodeOperator: operator.kodeOperator,
    username: operator.username,
    maskedEmail: maskEmail(operator.email),
    maskedPhone: maskPhone(operator.noHp),
  };
}

export interface ResetChallengeIssue {
  requestId: string;
  challengeToken: string;
  challenges: LivenessChallenge[];
  maskedEmail: string;
  expiresAt: string;
}

function randomId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

/**
 * Stempel waktu permintaan reset SELALU dihasilkan SQLite, bukan JavaScript.
 *
 * Baris yang sama bisa dibuat Desktop (Rust) dan dibaca Web (TS). Rust menulis
 * `datetime('now')` — "2026-08-29 10:15:00" — sedangkan `new Date()` di JS
 * memparsing bentuk itu sebagai waktu LOKAL, sehingga token bisa terbaca masih
 * berlaku berjam-jam setelah kedaluwarsa di perangkat dengan zona waktu
 * berbeda. Membandingkan di dalam SQL menghilangkan seluruh kelas bug ini.
 */
const NOW_SQL = "datetime('now')";

function expirySql(minutes: number) {
  return `datetime('now', '+${minutes} minutes')`;
}

/**
 * Langkah 2: pemohon mengetik ulang identitasnya, lalu server menerbitkan
 * tantangan liveness.
 *
 * Pengetikan ulang bukan sekadar formalitas UI — ia dilakukan setelah identitas
 * tersamar ditampilkan, sehingga orang yang asal menebak username akan berhenti
 * di sini alih-alih meneruskan permintaan atas nama orang lain.
 */
export async function confirmResetAccount(
  client: Client,
  identifier: string,
  confirmation: string,
  context: { ipHash?: string; userAgentHash?: string } = {},
): Promise<ResetChallengeIssue> {
  const operator = assertRecoverable(await findOperator(client, identifier));
  const confirmed = await findOperator(client, confirmation);
  if (!confirmed || confirmed.id !== operator.id) {
    throw new PasswordResetError(
      "Konfirmasi username atau email tidak cocok dengan akun yang dipilih.",
    );
  }

  // Permintaan lama yang belum tuntas dibatalkan: satu akun hanya boleh punya
  // satu permintaan hidup, supaya token lama tidak ikut berlaku.
  await client.execute({
    sql: `
      UPDATE password_reset_request
      SET status = 'Dibatalkan'
      WHERE operator_id = ? AND status IN ('Menunggu Verifikasi', 'Terkirim');
    `,
    args: [operator.id],
  });

  const challenges = pickLivenessChallenges();
  const challengeToken = createOpaqueSessionToken();
  const requestId = randomId();

  const inserted = await client.execute({
    sql: `
      INSERT INTO password_reset_request (
        id, operator_id, identifier_used, contact_channel, contact_target,
        challenge_hash, challenge_sequence, status,
        requested_at, expires_at, request_ip_hash, user_agent_hash
      ) VALUES (?, ?, ?, 'email', ?, ?, ?, 'Menunggu Verifikasi', ${NOW_SQL}, ${expirySql(
        CHALLENGE_TTL_MINUTES,
      )}, ?, ?)
      RETURNING expires_at;
    `,
    args: [
      requestId,
      operator.id,
      identifier.trim().slice(0, 120),
      operator.email,
      await hashSessionToken(challengeToken),
      JSON.stringify(challenges),
      context.ipHash ?? null,
      context.userAgentHash ?? null,
    ],
  });
  const expiresAt = String(inserted.rows[0]?.expires_at ?? "");

  return {
    requestId,
    challengeToken,
    challenges,
    maskedEmail: maskEmail(operator.email),
    expiresAt,
  };
}

interface PendingRequestRow {
  id: string;
  operatorId: number;
  contactTarget: string;
  challenges: LivenessChallenge[];
  operatorName: string;
  attempts: number;
  swaps: number;
}

async function loadPendingRequest(
  client: Client,
  requestId: string,
  challengeToken: string,
): Promise<PendingRequestRow> {
  const result = await client.execute({
    sql: `
      SELECT p.id, p.operator_id, p.contact_target, p.challenge_sequence,
             p.status, p.liveness_report, m.nama_operator,
             CASE WHEN p.expires_at <= datetime('now') THEN 1 ELSE 0 END AS is_expired
      FROM password_reset_request p
      JOIN master_operator m ON m.id = p.operator_id
      WHERE p.id = ? AND p.challenge_hash = ? LIMIT 1;
    `,
    args: [requestId, await hashSessionToken(challengeToken)],
  });
  const row = result.rows[0];
  if (!row) {
    throw new PasswordResetError("Sesi verifikasi tidak ditemukan.", 404);
  }
  if (String(row.status) !== "Menunggu Verifikasi") {
    throw new PasswordResetError(
      "Sesi verifikasi ini sudah tidak berlaku. Ulangi dari awal.",
      409,
    );
  }
  if (Number(row.is_expired ?? 0) === 1) {
    await client.execute({
      sql: "UPDATE password_reset_request SET status = 'Kedaluwarsa' WHERE id = ?;",
      args: [requestId],
    });
    throw new PasswordResetError(
      "Waktu verifikasi habis. Ulangi permintaan dari awal.",
      409,
    );
  }

  let challenges: LivenessChallenge[] = [];
  try {
    const parsed: unknown = JSON.parse(String(row.challenge_sequence));
    if (Array.isArray(parsed)) {
      challenges = parsed.filter(isLivenessChallenge);
    }
  } catch {
    challenges = [];
  }
  if (challenges.length === 0) {
    throw new PasswordResetError(
      "Tantangan verifikasi rusak. Ulangi permintaan dari awal.",
      409,
    );
  }

  let attempts = 0;
  let swaps = 0;
  try {
    const report: unknown = JSON.parse(String(row.liveness_report ?? "{}"));
    if (report && typeof report === "object") {
      const parsed = report as { attempts?: unknown; swaps?: unknown };
      attempts = Number(parsed.attempts) || 0;
      swaps = Number(parsed.swaps) || 0;
    }
  } catch {
    attempts = 0;
    swaps = 0;
  }

  return {
    id: String(row.id),
    operatorId: Number(row.operator_id),
    contactTarget: String(row.contact_target),
    challenges,
    operatorName: String(row.nama_operator),
    attempts,
    swaps,
  };
}

/** Penggantian tantangan yang boleh diminta satu permintaan reset. */
const MAX_CHALLENGE_SWAPS = 2;

/**
 * Mengganti satu tantangan yang tidak bisa dipenuhi perangkat pemohon.
 *
 * Deteksi kedipan bergantung pada beberapa piksel pita mata; pada kamera kelas
 * bawah, ruang redup, atau wajah berkacamata, tantangan itu bisa memang tidak
 * pernah terbaca — dan tanpa jalan keluar, pemiliknya terkunci selamanya dari
 * akunnya sendiri. Yang diganti hanya satu langkah, tetap dipilih server,
 * tetap acak, dan jumlah penggantiannya dibatasi supaya bukan menjadi cara
 * memilih tantangan termudah.
 */
export async function swapResetChallenge(
  client: Client,
  requestId: string,
  challengeToken: string,
  stepIndex: number,
): Promise<LivenessChallenge[]> {
  const pending = await loadPendingRequest(client, requestId, challengeToken);
  if (
    !Number.isSafeInteger(stepIndex) ||
    stepIndex < 0 ||
    stepIndex >= pending.challenges.length
  ) {
    throw new PasswordResetError("Langkah tantangan tidak dikenal.");
  }
  if (pending.swaps >= MAX_CHALLENGE_SWAPS) {
    throw new PasswordResetError(
      `Penggantian tantangan sudah mencapai batas (${MAX_CHALLENGE_SWAPS}). Ulangi permintaan dari awal di tempat yang lebih terang.`,
      409,
    );
  }

  const used = new Set(pending.challenges);
  const alternatives = LIVENESS_CHALLENGES.filter((item) => !used.has(item));
  if (alternatives.length === 0) {
    throw new PasswordResetError(
      "Tidak ada tantangan pengganti yang tersisa.",
      409,
    );
  }
  const replacement = alternatives[
    Math.floor(Math.random() * alternatives.length)
  ] as LivenessChallenge;
  const next = [...pending.challenges];
  next[stepIndex] = replacement;

  await client.execute({
    sql: `
      UPDATE password_reset_request
      SET challenge_sequence = ?, liveness_report = ?
      WHERE id = ? AND status = 'Menunggu Verifikasi';
    `,
    args: [
      JSON.stringify(next),
      JSON.stringify({ attempts: pending.attempts, swaps: pending.swaps + 1 }),
      pending.id,
    ],
  });
  return next;
}

export interface ResetVerificationResult {
  delivered: boolean;
  /**
   * Jalur yang benar-benar dipakai permintaan ini.
   *
   * Layar terakhir membacanya untuk memutuskan kalimat penutupnya. Tanpa ini
   * ia akan menyuruh pengguna membuka kotak masuk pada pemasangan yang tidak
   * pernah mengirim email apa pun — bug yang persis pernah terjadi.
   */
  mode: "email" | "in_app";
  maskedEmail: string;
  message: string;
  score: number;
}

/**
 * Langkah 3: menilai rekaman verifikasi wajah, lalu mengirim link reset.
 *
 * Vonis dihitung ulang di sini dari frame piksel mentah yang dikirim klien —
 * nilai liveness apa pun yang ikut dalam payload klien tidak dipakai. Foto
 * bukti tetap disimpan walaupun verifikasi gagal pada percobaan terakhir,
 * karena justru percobaan gagal yang paling perlu diaudit.
 */
/**
 * Jalur penyerahan token pemulihan yang berlaku pada instalasi ini.
 *
 * Cerminan `password_reset_route` di `turso.rs`, dan urutannya WAJIB tetap
 * sama: nilai eksplisit di `setting_gex_system` menang lebih dulu, baru
 * status email dipakai sebagai bawaan. Satu database yang sama bisa dilayani
 * Web dan Desktop bergantian; kalau keduanya menyimpulkan jalur yang berbeda,
 * sebuah permintaan bisa menunggu persetujuan yang tidak pernah diminta.
 *
 * Bawaannya ditentukan otomatis, bukan dipaksakan: pemasangan yang sudah
 * mengaktifkan email tetap memakai email setelah pembaruan, sisanya memakai
 * persetujuan di aplikasi.
 */
export async function resolvePasswordResetRoute(
  client: Client,
): Promise<"email" | "in_app"> {
  const explicit = await client.execute({
    sql: "SELECT value FROM setting_gex_system WHERE key = 'password_reset_route' LIMIT 1;",
    args: [],
  });
  const chosen = String(explicit.rows[0]?.value ?? "").trim();
  if (chosen) return chosen === "email" ? "email" : "in_app";

  const config = await client.execute({
    sql: "SELECT COALESCE(is_active, 0) AS is_active FROM app_mail_config WHERE id = 'default' LIMIT 1;",
    args: [],
  });
  return Number(config.rows[0]?.is_active ?? 0) === 1 ? "email" : "in_app";
}

export interface ResetApprovalResult {
  token: string;
  berlakuMenit: number;
  namaOperator: string;
  identifier: string;
}

/**
 * Setujui permintaan pemulihan, lalu serahkan tokennya SEKALI.
 *
 * Token baru dibuat di sini, bukan saat verifikasi wajah. Itu disengaja: kalau
 * ia dibuat lebih dulu, bentuk aslinya harus disimpan di suatu tempat sampai
 * disetujui — dan database hanya boleh memegang hash-nya.
 *
 * Peninjau manusia yang melihat foto wajah pemohon adalah faktor kedua di
 * jalur ini, dan sebenarnya lebih kuat daripada email: email hanya membuktikan
 * penguasaan kotak masuk, bukan siapa yang meminta.
 *
 * Pemanggil WAJIB sudah memeriksa izin `password_reset.approve`.
 */
export async function approvePasswordReset(
  client: Client,
  actorId: number,
  requestId: string,
): Promise<ResetApprovalResult> {
  const found = await client.execute({
    sql: `
      SELECT p.id, p.status, p.delivery_status, p.identifier_used,
             COALESCE(m.nama_operator, '') AS nama_operator,
             CASE WHEN p.expires_at <= ${NOW_SQL} THEN 1 ELSE 0 END AS kedaluwarsa
      FROM password_reset_request p
      LEFT JOIN master_operator m ON m.id = p.operator_id
      WHERE p.id = ? LIMIT 1;
    `,
    args: [requestId.trim()],
  });
  const row = found.rows[0];
  if (!row) {
    throw new PasswordResetError("Permintaan pemulihan tidak ditemukan.", 404);
  }
  if (String(row.status ?? "") !== "Menunggu Verifikasi") {
    throw new PasswordResetError(
      "Permintaan ini sudah diproses sebelumnya.",
      409,
    );
  }
  if (String(row.delivery_status ?? "") !== "Menunggu Persetujuan") {
    throw new PasswordResetError(
      "Permintaan ini tidak menunggu persetujuan.",
      409,
    );
  }
  if (Number(row.kedaluwarsa ?? 0) === 1) {
    await client.execute({
      sql: "UPDATE password_reset_request SET status = 'Kedaluwarsa' WHERE id = ?;",
      args: [requestId.trim()],
    });
    throw new PasswordResetError(
      "Permintaan ini sudah kedaluwarsa. Minta pemohon mengulang dari awal.",
      409,
    );
  }

  const resetToken = createOpaqueSessionToken();
  const applied = await client.execute({
    sql: `
      UPDATE password_reset_request
      SET token_hash = ?, status = 'Terkirim', delivery_status = 'Disetujui',
          delivery_error = NULL, sent_at = ${NOW_SQL},
          expires_at = ${expirySql(RESET_TOKEN_TTL_MINUTES)}
      WHERE id = ? AND status = 'Menunggu Verifikasi';
    `,
    args: [await hashSessionToken(resetToken), requestId.trim()],
  });
  if (Number(applied.rowsAffected ?? 0) === 0) {
    throw new PasswordResetError(
      "Permintaan ini sudah diproses oleh orang lain.",
      409,
    );
  }

  await client
    .execute({
      sql: `INSERT INTO role_permission_audit (actor_operator_id, action, detail, created_at) VALUES (?, 'password-reset-approve', ?, ${NOW_SQL});`,
      args: [actorId, requestId.trim()],
    })
    .catch(() => undefined);

  return {
    token: resetToken,
    berlakuMenit: RESET_TOKEN_TTL_MINUTES,
    namaOperator: String(row.nama_operator ?? ""),
    identifier: String(row.identifier_used ?? ""),
  };
}

/**
 * Terbitkan ulang kode pemulihan password untuk sebuah akun.
 *
 * Yang tersimpan hanya hash SHA-256-nya, sama seperti kode cadangan 2FA.
 * Bentuk aslinya dikembalikan SEKALI dan tidak pernah bisa dibaca lagi — jadi
 * pemanggil wajib menampilkannya sampai pengguna menyatakan sudah menyimpan.
 *
 * Menerbitkan ulang MENGGANTI seluruh kode lama: daftar yang sebagiannya sudah
 * tercetak di kertas lama tidak boleh tetap berlaku bersamaan dengan yang baru.
 */
export async function issuePasswordRecoveryCodes(
  client: Client,
  operatorId: number,
): Promise<string[]> {
  const codes = generateRecoveryCodes();
  const hashes = await Promise.all(
    codes.map((code) => hashSessionToken(normalizeRecoveryCode(code))),
  );
  await client.execute({
    sql: `UPDATE master_operator SET password_recovery_codes = ?, password_recovery_created_at = ${NOW_SQL} WHERE id = ?;`,
    args: [JSON.stringify(hashes), operatorId],
  });
  return codes;
}

/**
 * Masuk kembali memakai kode pemulihan cetak, lalu setel password baru.
 *
 * Cerminan `password_recovery_with_code` di `turso.rs`. Kode yang dipakai
 * LANGSUNG DIHAPUS sebelum password diganti — kode sekali pakai yang masih
 * hidup setelah dipakai bukan lagi kode sekali pakai.
 *
 * Akun yang tidak ada dan kode yang salah dijawab dengan pesan yang SAMA.
 * Membedakannya akan mengubah layar ini menjadi alat memetakan akun mana yang
 * ada.
 */
export async function recoverWithRecoveryCode(
  client: Client,
  input: { identifier: string; code: string; newPassword: string },
): Promise<{ namaOperator: string; sisaKode: number }> {
  const identifier = input.identifier.trim();
  if (!identifier) {
    throw new PasswordResetError("Username atau kode operator wajib diisi.");
  }
  const strengthError = validatePasswordStrength(input.newPassword);
  if (strengthError) throw new PasswordResetError(strengthError);

  const normalized = normalizeRecoveryCode(input.code);
  if (!normalized) {
    throw new PasswordResetError("Kode pemulihan wajib diisi.");
  }

  const ditolak = () =>
    new PasswordResetError(
      "Kode pemulihan tidak sesuai, atau sudah pernah dipakai.",
      409,
    );

  const found = await client.execute({
    sql: `
      SELECT m.id, COALESCE(m.password_recovery_codes, '[]') AS kode,
             COALESCE(m.nama_operator, '') AS nama_operator
      FROM master_operator m
      JOIN app_role r ON r.id = m.role_id
      WHERE (m.username = ? COLLATE NOCASE OR m.kode_operator = ? COLLATE NOCASE)
        AND m.status = 'Aktif' AND r.status = 'Aktif'
      LIMIT 1;
    `,
    args: [identifier, identifier],
  });
  const row = found.rows[0];
  if (!row) throw ditolak();

  let stored: string[] = [];
  try {
    const parsed: unknown = JSON.parse(String(row.kode ?? "[]"));
    stored = Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    stored = [];
  }

  const hashed = await hashSessionToken(normalized);
  if (!stored.includes(hashed)) throw ditolak();

  const operatorId = Number(row.id);
  const remaining = stored.filter((item) => item !== hashed);
  await client.execute({
    sql: "UPDATE master_operator SET password_recovery_codes = ? WHERE id = ?;",
    args: [JSON.stringify(remaining), operatorId],
  });

  await client.execute({
    sql: `UPDATE master_operator SET password_hash = ?, updated_at = ${NOW_SQL} WHERE id = ?;`,
    args: [await hashPassword(input.newPassword), operatorId],
  });
  await revokeOperatorSessions(client, operatorId, "password-recovery");

  return {
    namaOperator: String(row.nama_operator ?? ""),
    sisaKode: remaining.length,
  };
}

export async function verifyResetLiveness(
  client: Client,
  input: {
    requestId: string;
    challengeToken: string;
    frames: unknown;
    photoBase64: string;
    photoMime: string;
  },
): Promise<ResetVerificationResult> {
  const pending = await loadPendingRequest(
    client,
    input.requestId,
    input.challengeToken,
  );

  const photo = input.photoBase64.trim();
  if (!photo || photo.length > MAX_PHOTO_BASE64_LENGTH) {
    throw new PasswordResetError(
      "Foto verifikasi tidak valid atau terlalu besar.",
    );
  }

  let verdict: ReturnType<typeof evaluateLivenessSession>;
  try {
    verdict = evaluateLivenessSession(
      pending.challenges,
      decodeLivenessFrames(input.frames),
    );
  } catch (error) {
    throw new PasswordResetError(
      error instanceof Error
        ? error.message
        : "Rekaman verifikasi tidak dapat dibaca.",
    );
  }

  const attempts = pending.attempts + 1;
  const report = JSON.stringify({
    attempts,
    swaps: pending.swaps,
    score: verdict.score,
    passed: verdict.passed,
    reason: verdict.reason,
    faceRatio: verdict.faceRatio,
    motion: verdict.motion,
    challenges: verdict.challenges,
  });

  if (!verdict.passed) {
    const exhausted = attempts >= MAX_LIVENESS_ATTEMPTS;
    await client.execute({
      sql: `
        UPDATE password_reset_request
        SET liveness_report = ?, liveness_score = ?, photo_mime = ?, photo_base64 = ?,
            status = CASE WHEN ? = 1 THEN 'Dibatalkan' ELSE status END
        WHERE id = ?;
      `,
      args: [
        report,
        verdict.score,
        input.photoMime.slice(0, 40),
        photo,
        exhausted ? 1 : 0,
        pending.id,
      ],
    });
    throw new PasswordResetError(
      exhausted
        ? `${verdict.reason} Batas percobaan tercapai, ulangi permintaan dari awal.`
        : `${verdict.reason} Sisa percobaan: ${MAX_LIVENESS_ATTEMPTS - attempts}.`,
      409,
    );
  }

  // Jalur persetujuan di aplikasi: tidak ada token yang dibuat di sini, dan
  // tidak ada yang dikirim ke mana pun. Permintaannya tetap "Menunggu
  // Verifikasi" sampai seorang peninjau melihat foto wajahnya dan menyetujui —
  // barulah token dibuat, sekali, di layar peninjau. Tanpa cabang ini, sebuah
  // pemasangan tanpa konfigurasi email akan selalu gagal mengirim, dan
  // kegagalan itu MEMBATALKAN permintaannya sehingga fitur ini mati total.
  if ((await resolvePasswordResetRoute(client)) !== "email") {
    await client.execute({
      sql: `
        UPDATE password_reset_request
        SET liveness_score = ?, liveness_report = ?, photo_mime = ?, photo_base64 = ?,
            contact_channel = 'in_app', delivery_status = 'Menunggu Persetujuan',
            delivery_error = NULL, verified_at = ${NOW_SQL},
            expires_at = ${expirySql(RESET_TOKEN_TTL_MINUTES)}
        WHERE id = ? AND status = 'Menunggu Verifikasi';
      `,
      args: [
        verdict.score,
        report,
        input.photoMime.slice(0, 40),
        photo,
        pending.id,
      ],
    });
    return {
      delivered: false,
      mode: "in_app",
      maskedEmail: maskEmail(pending.contactTarget),
      message: `Permintaan Anda sudah tercatat dan menunggu persetujuan Superadmin. Hubungi Superadmin untuk meninjau, lalu minta kode pemulihan yang berlaku ${RESET_TOKEN_TTL_MINUTES} menit.`,
      score: verdict.score,
    };
  }

  const resetToken = createOpaqueSessionToken();
  const tokenHash = await hashSessionToken(resetToken);

  await client.execute({
    sql: `
      UPDATE password_reset_request
      SET token_hash = ?, status = 'Terkirim', liveness_score = ?, liveness_report = ?,
          photo_mime = ?, photo_base64 = ?, verified_at = ${NOW_SQL},
          expires_at = ${expirySql(RESET_TOKEN_TTL_MINUTES)}
      WHERE id = ? AND status = 'Menunggu Verifikasi';
    `,
    args: [
      tokenHash,
      verdict.score,
      report,
      input.photoMime.slice(0, 40),
      photo,
      pending.id,
    ],
  });

  const config = await client.execute({
    sql: "SELECT COALESCE(reset_base_url, '') AS reset_base_url FROM app_mail_config WHERE id = 'default' LIMIT 1;",
    args: [],
  });
  const baseUrl = String(config.rows[0]?.reset_base_url ?? "").replace(
    /\/+$/,
    "",
  );
  const message = buildResetEmail({
    operatorName: pending.operatorName,
    resetLink: baseUrl
      ? `${baseUrl}/lupa-password/reset?token=${encodeURIComponent(resetToken)}`
      : "",
    resetCode: resetToken,
    expiresInMinutes: RESET_TOKEN_TTL_MINUTES,
  });
  const delivery = await sendMail(
    client,
    pending.contactTarget,
    message.subject,
    message.text,
    message.html,
  );

  await client.execute({
    sql: `
      UPDATE password_reset_request
      SET delivery_status = ?, delivery_error = ?,
          sent_at = CASE WHEN ? = 1 THEN ${NOW_SQL} ELSE NULL END,
          status = CASE WHEN ? = 1 THEN 'Terkirim' ELSE 'Dibatalkan' END
      WHERE id = ?;
    `,
    args: [
      delivery.delivered ? "Terkirim" : "Gagal",
      delivery.delivered ? null : delivery.detail || delivery.message,
      delivery.delivered ? 1 : 0,
      delivery.delivered ? 1 : 0,
      pending.id,
    ],
  });

  if (!delivery.delivered) {
    throw new PasswordResetError(delivery.message, 409);
  }

  return {
    delivered: true,
    mode: "email",
    maskedEmail: maskEmail(pending.contactTarget),
    message: `Link reset password sudah dikirim ke ${maskEmail(pending.contactTarget)}. Berlaku ${RESET_TOKEN_TTL_MINUTES} menit.`,
    score: verdict.score,
  };
}

export interface ResetTokenInfo {
  operatorName: string;
  username: string;
  maskedEmail: string;
  expiresAt: string;
}

async function loadTokenRequest(client: Client, token: string) {
  const clean = token.trim();
  if (clean.length < 16 || clean.length > 256) {
    throw new PasswordResetError("Token reset tidak valid.", 404);
  }
  const result = await client.execute({
    sql: `
      SELECT p.id, p.operator_id, p.contact_target, p.status, p.expires_at,
             m.nama_operator, m.username,
             CASE WHEN p.expires_at <= datetime('now') THEN 1 ELSE 0 END AS is_expired
      FROM password_reset_request p
      JOIN master_operator m ON m.id = p.operator_id
      WHERE p.token_hash = ? LIMIT 1;
    `,
    args: [await hashSessionToken(clean)],
  });
  const row = result.rows[0];
  if (!row) {
    throw new PasswordResetError(
      "Token reset tidak dikenal atau sudah dipakai.",
      404,
    );
  }
  if (String(row.status) === "Terpakai") {
    throw new PasswordResetError("Token reset ini sudah pernah dipakai.", 409);
  }
  if (String(row.status) !== "Terkirim") {
    throw new PasswordResetError("Token reset sudah tidak berlaku.", 409);
  }
  if (Number(row.is_expired ?? 0) === 1) {
    await client.execute({
      sql: "UPDATE password_reset_request SET status = 'Kedaluwarsa' WHERE id = ?;",
      args: [String(row.id)],
    });
    throw new PasswordResetError(
      "Token reset sudah kedaluwarsa. Ulangi permintaan dari awal.",
      409,
    );
  }
  return {
    id: String(row.id),
    operatorId: Number(row.operator_id),
    contactTarget: String(row.contact_target),
    operatorName: String(row.nama_operator),
    username: String(row.username),
    expiresAt: String(row.expires_at),
  };
}

/** Langkah 4: memvalidasi token sebelum form password baru ditampilkan. */
export async function inspectResetToken(
  client: Client,
  token: string,
): Promise<ResetTokenInfo> {
  const request = await loadTokenRequest(client, token);
  return {
    operatorName: request.operatorName,
    username: request.username,
    maskedEmail: maskEmail(request.contactTarget),
    expiresAt: request.expiresAt,
  };
}

/**
 * Langkah 5: password lama benar-benar digantikan yang baru.
 *
 * Seluruh sesi aktif operator ikut dicabut. Kalau tidak, penyerang yang sudah
 * terlanjur masuk tetap memegang sesi hidup walaupun pemilik sah sudah
 * mengganti passwordnya.
 */
export async function completePasswordReset(
  client: Client,
  token: string,
  password: string,
) {
  const request = await loadTokenRequest(client, token);
  const strengthError = validatePasswordStrength(password);
  if (strengthError) throw new PasswordResetError(strengthError);

  const passwordHash = await hashPassword(password);
  // Token dikonsumsi LEBIH DULU. Kalau password diganti duluan, dua permintaan
  // paralel dengan token yang sama akan sama-sama menulis password — dan yang
  // kalah lomba tetap sempat mengubah password sebelum ditolak.
  const consumed = await client.execute({
    sql: `
      UPDATE password_reset_request
      SET status = 'Terpakai', used_at = ${NOW_SQL}
      WHERE id = ? AND status = 'Terkirim';
    `,
    args: [request.id],
  });
  if (Number(consumed.rowsAffected ?? 0) === 0) {
    throw new PasswordResetError("Token reset ini sudah pernah dipakai.", 409);
  }
  await client.execute({
    sql: `UPDATE master_operator SET password_hash = ?, updated_at = ${NOW_SQL} WHERE id = ?;`,
    args: [passwordHash, request.operatorId],
  });
  await revokeOperatorSessions(client, request.operatorId, "password-reset");
  return { username: request.username };
}
