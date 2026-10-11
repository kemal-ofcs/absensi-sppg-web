import "server-only";

import type { Client } from "@libsql/client";
import { maskEmail } from "@/lib/operators/contact";
import {
  isResetHistoryStatus,
  RESET_HISTORY_DEFAULT_LIMIT,
  RESET_HISTORY_MAX_LIMIT,
  type ResetHistoryEntry,
  type ResetHistoryFilter,
  type ResetHistoryPhoto,
} from "@/lib/operators/password-reset-history";

/**
 * Riwayat pengajuan "Lupa Password" untuk peninjauan manusia.
 *
 * Mengajukan reset tidak butuh izin apa pun — alurnya memang terbuka untuk
 * semua akun. Yang dijaga izin adalah membaca dan menghapus jejaknya, karena
 * setiap baris menyimpan foto wajah pemohon. Pemeriksaan izinnya ada di route
 * handler (Web) dan `require_permission` (Desktop/Mobile); modul ini hanya
 * menyediakan query-nya.
 */

interface ParsedReport {
  reason: string;
  challenges: string[];
}

/**
 * `liveness_report` ditulis sebagai JSON oleh dua penulis berbeda: TypeScript
 * menulis vonis lengkap, Rust menyimpan vonis yang dikirim aplikasi. Pembacanya
 * harus memaafkan bentuk yang tidak dikenal — riwayat tetap berguna walau satu
 * baris lamanya tidak bisa diurai.
 */
function parseReport(value: unknown): ParsedReport {
  const empty: ParsedReport = { reason: "", challenges: [] };
  if (typeof value !== "string" || value.trim().length === 0) return empty;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object") return empty;
    const report = parsed as Record<string, unknown>;
    const rawChallenges = Array.isArray(report.challenges)
      ? report.challenges
      : [];
    return {
      reason: typeof report.reason === "string" ? report.reason : "",
      challenges: rawChallenges
        .map((item) => {
          if (typeof item === "string") return item;
          if (item && typeof item === "object") {
            const entry = item as Record<string, unknown>;
            return typeof entry.challenge === "string" ? entry.challenge : "";
          }
          return "";
        })
        .filter((item) => item.length > 0),
    };
  } catch {
    return empty;
  }
}

function text(value: unknown) {
  return value == null ? "" : String(value);
}

export async function listPasswordResetHistory(
  client: Client,
  filter: ResetHistoryFilter = {},
): Promise<ResetHistoryEntry[]> {
  const conditions: string[] = [];
  const args: (string | number)[] = [];

  if (filter.status && filter.status !== "SEMUA") {
    if (!isResetHistoryStatus(filter.status)) {
      throw new Error("Status riwayat tidak dikenal.");
    }
    conditions.push("p.status = ?");
    args.push(filter.status);
  }

  const search = (filter.search ?? "").trim();
  if (search.length > 0) {
    conditions.push(`(
      m.nama_operator LIKE ? COLLATE NOCASE
      OR m.username LIKE ? COLLATE NOCASE
      OR m.kode_operator LIKE ? COLLATE NOCASE
      OR p.identifier_used LIKE ? COLLATE NOCASE
    )`);
    const like = `%${search.slice(0, 60)}%`;
    args.push(like, like, like, like);
  }

  const limit = Math.min(
    RESET_HISTORY_MAX_LIMIT,
    Math.max(
      1,
      Number.isSafeInteger(filter.limit)
        ? (filter.limit as number)
        : RESET_HISTORY_DEFAULT_LIMIT,
    ),
  );
  args.push(limit);

  // `photo_base64` sengaja TIDAK ikut di-select: satu foto ~40 KB dan seratus
  // baris akan membuat daftar ini puluhan megabyte. Foto diambil per baris
  // lewat `getPasswordResetPhoto` hanya ketika benar-benar dibuka.
  const result = await client.execute({
    sql: `
      SELECT
        p.id, p.operator_id, p.identifier_used, p.contact_target, p.status,
        p.liveness_score, p.liveness_report, p.delivery_status, p.delivery_error,
        p.requested_at, p.verified_at, p.sent_at, p.used_at, p.expires_at,
        CASE
          WHEN p.photo_base64 IS NOT NULL AND TRIM(p.photo_base64) <> '' THEN 1
          ELSE 0
        END AS has_photo,
        m.nama_operator, m.username, m.kode_operator
      FROM password_reset_request p
      JOIN master_operator m ON m.id = p.operator_id
      ${conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : ""}
      ORDER BY p.requested_at DESC
      LIMIT ?;
    `,
    args,
  });

  return result.rows.map((row) => {
    const report = parseReport(row.liveness_report);
    const status = isResetHistoryStatus(row.status) ? row.status : "Dibatalkan";
    return {
      id: text(row.id),
      operatorId: Number(row.operator_id),
      operatorName: text(row.nama_operator),
      username: text(row.username),
      kodeOperator: text(row.kode_operator),
      identifierUsed: text(row.identifier_used),
      maskedEmail: maskEmail(text(row.contact_target)),
      status,
      livenessScore:
        row.liveness_score == null ? null : Number(row.liveness_score),
      livenessReason: report.reason,
      livenessChallenges: report.challenges,
      deliveryStatus: text(row.delivery_status),
      deliveryError: text(row.delivery_error),
      hasPhoto: Number(row.has_photo) === 1,
      requestedAt: text(row.requested_at),
      verifiedAt: text(row.verified_at),
      sentAt: text(row.sent_at),
      usedAt: text(row.used_at),
      expiresAt: text(row.expires_at),
    } satisfies ResetHistoryEntry;
  });
}

export async function getPasswordResetPhoto(
  client: Client,
  requestId: string,
): Promise<ResetHistoryPhoto> {
  const id = requestId.trim();
  if (id.length === 0 || id.length > 64) {
    throw new Error("ID permintaan tidak valid.");
  }
  const result = await client.execute({
    sql: "SELECT photo_mime, photo_base64 FROM password_reset_request WHERE id = ? LIMIT 1;",
    args: [id],
  });
  const row = result.rows[0];
  if (!row) throw new Error("Permintaan tidak ditemukan.");
  const base64 = text(row.photo_base64).trim();
  if (base64.length === 0) {
    throw new Error("Permintaan ini tidak menyimpan foto verifikasi.");
  }
  return { mime: text(row.photo_mime) || "image/jpeg", base64 };
}

/**
 * Menghapus satu baris riwayat beserta foto buktinya.
 *
 * Permintaan yang masih hidup (`Terkirim`, belum dipakai) ikut mati bersama
 * barisnya — itu memang konsekuensi menghapus jejak, dan disebutkan ke pengguna
 * lewat pesan konfirmasi di UI. Yang tidak boleh terjadi adalah menghapus
 * diam-diam tanpa pemohon tahu, karena itu pemiliknya cukup mengajukan ulang.
 */
export async function deletePasswordResetHistory(
  client: Client,
  requestId: string,
) {
  const id = requestId.trim();
  if (id.length === 0 || id.length > 64) {
    throw new Error("ID permintaan tidak valid.");
  }
  const result = await client.execute({
    sql: "DELETE FROM password_reset_request WHERE id = ?;",
    args: [id],
  });
  if (Number(result.rowsAffected ?? 0) === 0) {
    throw new Error("Riwayat tidak ditemukan atau sudah dihapus.");
  }
  return { deleted: 1 };
}

/**
 * Membersihkan riwayat yang sudah selesai dan lebih tua dari `days` hari.
 *
 * Baris yang masih `Terkirim` atau `Menunggu Verifikasi` sengaja dilewati:
 * membersihkan arsip tidak boleh memutus pemulihan yang sedang berjalan.
 */
export async function purgePasswordResetHistory(client: Client, days: number) {
  if (!Number.isSafeInteger(days) || days < 1 || days > 3650) {
    throw new Error("Rentang hari pembersihan tidak valid.");
  }
  const result = await client.execute({
    sql: `
      DELETE FROM password_reset_request
      WHERE status IN ('Terpakai', 'Kedaluwarsa', 'Dibatalkan')
        AND requested_at <= datetime('now', ?);
    `,
    args: [`-${days} days`],
  });
  return { deleted: Number(result.rowsAffected ?? 0) };
}
