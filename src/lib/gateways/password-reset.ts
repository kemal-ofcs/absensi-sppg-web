"use client";

import { requestWebApi } from "@/lib/client/api-client";
import { isDesktopRuntime } from "@/lib/runtime/app-runtime";
import { invokeDesktop } from "@/lib/runtime/desktop-commands";
import {
  evaluateLivenessSession,
  type LivenessChallenge,
} from "@/lib/security/face-liveness";
import {
  decodeLivenessFrames,
  type LivenessFramePayload,
} from "@/lib/security/liveness-codec";

export interface ResetAccountPreview {
  name: string;
  kodeOperator: string;
  username: string;
  maskedEmail: string;
  maskedPhone: string;
}

export interface ResetChallenge {
  requestId: string;
  challengeToken: string;
  challenges: LivenessChallenge[];
  maskedEmail: string;
  expiresAt: string;
}

export interface ResetDelivery {
  delivered: boolean;
  maskedEmail: string;
  message: string;
  score: number;
}

export interface ResetTokenPreview {
  operatorName: string;
  username: string;
  maskedEmail: string;
  expiresAt: string;
}

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function asChallenges(value: unknown): LivenessChallenge[] {
  return Array.isArray(value) ? (value as LivenessChallenge[]) : [];
}

/**
 * Alur "Lupa Password" berjalan tanpa sesi login.
 *
 * Web memanggil route handler `POST /api/password-reset`; Desktop/Mobile
 * memanggil command Rust yang bicara langsung ke Turso, karena pemasangan
 * Desktop bisa saja tidak punya aplikasi Web sama sekali.
 */
export async function lookupResetAccount(identifier: string) {
  if (isDesktopRuntime()) {
    const payload = await invokeDesktop<JsonRecord>(
      "desktop_password_reset_lookup",
      { identifier },
    );
    const account = record(payload.account);
    return {
      name: String(account.name ?? ""),
      kodeOperator: String(account.kode_operator ?? account.kodeOperator ?? ""),
      username: String(account.username ?? ""),
      maskedEmail: String(account.masked_email ?? account.maskedEmail ?? ""),
      maskedPhone: String(account.masked_phone ?? account.maskedPhone ?? ""),
    } satisfies ResetAccountPreview;
  }
  const response = await requestWebApi<{ account: ResetAccountPreview }>(
    "/api/password-reset",
    "POST",
    { step: "lookup", identifier },
  );
  return response.account;
}

export async function confirmResetAccount(
  identifier: string,
  confirmation: string,
) {
  if (isDesktopRuntime()) {
    const payload = await invokeDesktop<JsonRecord>(
      "desktop_password_reset_confirm",
      { identifier, confirmation },
    );
    const challenge = record(payload.challenge);
    return {
      requestId: String(challenge.request_id ?? challenge.requestId ?? ""),
      challengeToken: String(
        challenge.challenge_token ?? challenge.challengeToken ?? "",
      ),
      challenges: asChallenges(challenge.challenges),
      maskedEmail: String(
        challenge.masked_email ?? challenge.maskedEmail ?? "",
      ),
      expiresAt: String(challenge.expires_at ?? challenge.expiresAt ?? ""),
    } satisfies ResetChallenge;
  }
  const response = await requestWebApi<{ challenge: ResetChallenge }>(
    "/api/password-reset",
    "POST",
    { step: "confirm", identifier, confirmation },
  );
  return response.challenge;
}

/**
 * Di mana vonis liveness dihitung — dan kenapa berbeda per runtime.
 *
 * Web: frame piksel mentah dikirim ke route handler dan server menghitung
 * ulang vonisnya sendiri. Klien di sana adalah browser milik siapa saja, jadi
 * apa pun yang dilaporkannya tidak bernilai bukti.
 *
 * Desktop/Mobile: tidak ada server aplikasi — Tauri bicara langsung ke
 * LibSQL. Vonis dihitung di sini memakai modul yang sama persis, lalu Rust
 * yang memverifikasi bahwa urutan tantangan pada vonis itu cocok dengan yang
 * ia terbitkan dan simpan di database. Mengirim ~300 KB frame mentah ke Rust
 * tidak akan menambah jaminan apa pun karena Rust tidak punya penilai kedua;
 * yang menambah jaminan adalah urutan tantangan acak yang hanya diketahui
 * database, dan itu tetap diperiksa.
 */
export async function verifyResetLiveness(input: {
  requestId: string;
  challengeToken: string;
  frames: LivenessFramePayload[];
  photoBase64: string;
  photoMime: string;
  challenges: readonly LivenessChallenge[];
}) {
  if (isDesktopRuntime()) {
    const verdict = evaluateLivenessSession(
      input.challenges,
      decodeLivenessFrames(input.frames),
    );
    if (!verdict.passed) throw new Error(verdict.reason);
    const payload = await invokeDesktop<JsonRecord>(
      "desktop_password_reset_verify",
      {
        requestId: input.requestId,
        challengeToken: input.challengeToken,
        verdict: {
          passed: verdict.passed,
          score: verdict.score,
          reason: verdict.reason,
          face_ratio: verdict.faceRatio,
          motion: verdict.motion,
          challenges: verdict.challenges.map((item) => item.challenge),
        },
        photoBase64: input.photoBase64,
        photoMime: input.photoMime,
      },
    );
    const delivery = record(payload.delivery);
    return {
      delivered: delivery.delivered === true,
      maskedEmail: String(delivery.masked_email ?? delivery.maskedEmail ?? ""),
      message: String(delivery.message ?? ""),
      score: Number(delivery.score ?? 0),
    } satisfies ResetDelivery;
  }
  const response = await requestWebApi<{ delivery: ResetDelivery }>(
    "/api/password-reset",
    "POST",
    {
      step: "verify",
      requestId: input.requestId,
      challengeToken: input.challengeToken,
      frames: input.frames,
      photoBase64: input.photoBase64,
      photoMime: input.photoMime,
    },
  );
  return response.delivery;
}

/**
 * Meminta tantangan pengganti untuk satu langkah.
 *
 * Server yang memilih penggantinya, tetap acak dan tetap dibatasi jumlahnya,
 * jadi ini bukan cara pemohon memilih tantangan termudah — hanya jalan keluar
 * ketika sebuah tantangan memang tidak pernah terbaca oleh kamera perangkatnya.
 */
export async function swapResetChallenge(
  requestId: string,
  challengeToken: string,
  stepIndex: number,
) {
  if (isDesktopRuntime()) {
    const payload = await invokeDesktop<JsonRecord>(
      "desktop_password_reset_swap_challenge",
      { requestId, challengeToken, stepIndex },
    );
    return asChallenges(payload.challenges);
  }
  const response = await requestWebApi<{ challenges: LivenessChallenge[] }>(
    "/api/password-reset",
    "POST",
    { step: "swap-challenge", requestId, challengeToken, stepIndex },
  );
  return response.challenges;
}

export async function inspectResetToken(token: string) {
  if (isDesktopRuntime()) {
    const payload = await invokeDesktop<JsonRecord>(
      "desktop_password_reset_inspect",
      { token },
    );
    const info = record(payload.token);
    return {
      operatorName: String(info.operator_name ?? info.operatorName ?? ""),
      username: String(info.username ?? ""),
      maskedEmail: String(info.masked_email ?? info.maskedEmail ?? ""),
      expiresAt: String(info.expires_at ?? info.expiresAt ?? ""),
    } satisfies ResetTokenPreview;
  }
  const response = await requestWebApi<{ token: ResetTokenPreview }>(
    "/api/password-reset",
    "POST",
    { step: "inspect-token", token },
  );
  return response.token;
}

export async function completePasswordReset(token: string, password: string) {
  if (isDesktopRuntime()) {
    await invokeDesktop<JsonRecord>("desktop_password_reset_complete", {
      token,
      password,
    });
    return { sukses: true as const };
  }
  await requestWebApi<{ sukses: true }>("/api/password-reset", "POST", {
    step: "complete",
    token,
    password,
  });
  return { sukses: true as const };
}
