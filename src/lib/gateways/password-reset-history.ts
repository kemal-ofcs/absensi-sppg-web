"use client";

import { requestWebApi } from "@/lib/client/api-client";
import type {
  ResetHistoryEntry,
  ResetHistoryFilter,
  ResetHistoryPhoto,
} from "@/lib/operators/password-reset-history";
import { isResetHistoryStatus } from "@/lib/operators/password-reset-history";
import { isDesktopRuntime } from "@/lib/runtime/app-runtime";
import { invokeDesktop } from "@/lib/runtime/desktop-commands";

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function text(value: unknown) {
  return value == null ? "" : String(value);
}

function normalizeEntry(value: JsonRecord): ResetHistoryEntry {
  const status = value.status;
  return {
    id: text(value.id),
    operatorId: Number(value.operatorId ?? value.operator_id ?? 0),
    operatorName: text(value.operatorName ?? value.nama_operator),
    username: text(value.username),
    kodeOperator: text(value.kodeOperator ?? value.kode_operator),
    identifierUsed: text(value.identifierUsed ?? value.identifier_used),
    maskedEmail: text(value.maskedEmail ?? value.masked_email),
    status: isResetHistoryStatus(status) ? status : "Dibatalkan",
    livenessScore:
      value.livenessScore == null && value.liveness_score == null
        ? null
        : Number(value.livenessScore ?? value.liveness_score),
    livenessReason: text(value.livenessReason ?? value.liveness_reason),
    livenessChallenges: Array.isArray(
      value.livenessChallenges ?? value.liveness_challenges,
    )
      ? ((value.livenessChallenges ?? value.liveness_challenges) as unknown[])
          .map(text)
          .filter((item) => item.length > 0)
      : [],
    deliveryStatus: text(value.deliveryStatus ?? value.delivery_status),
    deliveryError: text(value.deliveryError ?? value.delivery_error),
    hasPhoto: value.hasPhoto === true || Number(value.has_photo ?? 0) === 1,
    requestedAt: text(value.requestedAt ?? value.requested_at),
    verifiedAt: text(value.verifiedAt ?? value.verified_at),
    sentAt: text(value.sentAt ?? value.sent_at),
    usedAt: text(value.usedAt ?? value.used_at),
    expiresAt: text(value.expiresAt ?? value.expires_at),
  };
}

/**
 * Riwayat pengajuan "Lupa Password".
 *
 * Web memakai route handler; Desktop/Mobile memanggil command Rust yang bicara
 * langsung ke Turso. Penjaga izinnya ada di kedua sisi (`requireWebPermission`
 * dan `require_permission`), jadi menyembunyikan menu di UI hanya soal
 * kenyamanan, bukan keamanan.
 */
export async function getPasswordResetHistory(filter: ResetHistoryFilter = {}) {
  const payload = {
    status: filter.status ?? "SEMUA",
    search: filter.search ?? "",
    limit: filter.limit,
  };
  if (isDesktopRuntime()) {
    const response = await invokeDesktop<JsonRecord>(
      "desktop_list_password_reset_history",
      payload,
    );
    const entries = response.entries;
    return (Array.isArray(entries) ? entries : []).map((item) =>
      normalizeEntry(record(item)),
    );
  }
  const response = await requestWebApi<{ entries: ResetHistoryEntry[] }>(
    "/api/password-reset/history/query",
    "POST",
    payload,
  );
  return response.entries.map((item) =>
    normalizeEntry(item as unknown as JsonRecord),
  );
}

export async function getPasswordResetPhoto(requestId: string) {
  if (isDesktopRuntime()) {
    const response = await invokeDesktop<JsonRecord>(
      "desktop_get_password_reset_photo",
      { requestId },
    );
    const photo = record(response.photo);
    return {
      mime: text(photo.mime) || "image/jpeg",
      base64: text(photo.base64),
    } satisfies ResetHistoryPhoto;
  }
  const response = await requestWebApi<{ photo: ResetHistoryPhoto }>(
    "/api/password-reset/history/query",
    "POST",
    { photoRequestId: requestId },
  );
  return response.photo;
}

export interface ResetApprovalResult {
  /** Kode pemulihan, diserahkan SEKALI kepada peninjau. */
  token: string;
  berlakuMenit: number;
  namaOperator: string;
  identifier: string;
}

/**
 * Setujui permintaan pemulihan, lalu terima kodenya sekali.
 *
 * Jalur ini dipakai ketika instalasi tidak mengirim token lewat email — antara
 * lain seluruh pemasangan Mode Database Lokal, yang memang tidak punya jaringan.
 * Peninjau melihat foto wajah pemohon lebih dulu; itulah faktor kedua di jalur
 * ini, dan sebenarnya lebih kuat daripada email yang hanya membuktikan
 * penguasaan kotak masuk.
 *
 * Kodenya TIDAK disimpan dalam bentuk asli di mana pun — database hanya
 * memegang hash-nya — sehingga balasan ini adalah satu-satunya kesempatan
 * membacanya. Layar pemanggil wajib menampilkannya sampai peninjau menutupnya
 * sendiri.
 */
export async function approvePasswordReset(
  requestId: string,
): Promise<ResetApprovalResult> {
  const response = isDesktopRuntime()
    ? await invokeDesktop<JsonRecord>("desktop_password_reset_approve", {
        requestId,
      })
    : ((await requestWebApi<JsonRecord>(
        "/api/password-reset/history/approve",
        "POST",
        { requestId },
      )) as JsonRecord);
  return {
    token: text(response.token),
    berlakuMenit: Number(response.berlakuMenit ?? 30),
    namaOperator: text(response.namaOperator),
    identifier: text(response.identifier),
  };
}

/**
 * Jalur penyerahan token yang berlaku pada instalasi ini: `email` atau `in_app`.
 *
 * Dibaca layar riwayat supaya tombol persetujuan hanya muncul ketika memang
 * relevan, dan layar "Lupa Password" tidak menjanjikan email pada pemasangan
 * yang tidak punya jaringan.
 */
export async function getPasswordResetRoute(): Promise<"email" | "in_app"> {
  const response = isDesktopRuntime()
    ? await invokeDesktop<JsonRecord>("desktop_password_reset_route", {})
    : ((await requestWebApi<JsonRecord>("/api/password-reset", "POST", {
        step: "route",
      })) as JsonRecord);
  return text(response.route) === "email" ? "email" : "in_app";
}

export async function deletePasswordResetHistory(requestId: string) {
  if (isDesktopRuntime()) {
    await invokeDesktop<JsonRecord>("desktop_delete_password_reset_history", {
      requestId,
    });
    return { sukses: true as const };
  }
  await requestWebApi<{ sukses: true }>(
    "/api/password-reset/history",
    "DELETE",
    { requestId },
  );
  return { sukses: true as const };
}

export async function purgePasswordResetHistory(olderThanDays: number) {
  if (isDesktopRuntime()) {
    const response = await invokeDesktop<JsonRecord>(
      "desktop_purge_password_reset_history",
      { olderThanDays },
    );
    return { deleted: Number(response.deleted ?? 0) };
  }
  const response = await requestWebApi<{ deleted: number }>(
    "/api/password-reset/history",
    "DELETE",
    { olderThanDays },
  );
  return { deleted: Number(response.deleted ?? 0) };
}
