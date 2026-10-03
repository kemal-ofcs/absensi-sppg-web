import "server-only";

import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Token pemasangan: satu-satunya hal yang membedakan orang yang memasang
 * server dari orang yang kebetulan membuka URL-nya lebih dulu.
 *
 * Aplikasi Web terbuka ke jaringan. Layar "buat Superadmin pertama" tanpa
 * bukti apa pun berarti pengunjung pertama mengambil alih seluruh sistem.
 * Token ini hanya ada di `.env` server, jadi hanya pemasangnya yang tahu.
 */
export const SETUP_TOKEN_MIN_LENGTH = 32;

export type SetupTokenState =
  | { state: "disabled" }
  /** Diisi tetapi terlalu pendek: diperlakukan sama dengan tidak diisi. */
  | { state: "weak" }
  | { state: "ready"; token: string };

export function resolveSetupToken(
  environment: Record<string, string | undefined>,
): SetupTokenState {
  const token = environment.KOS_SETUP_TOKEN?.trim() ?? "";
  if (!token) return { state: "disabled" };
  if (token.length < SETUP_TOKEN_MIN_LENGTH) return { state: "weak" };
  return { state: "ready", token };
}

/**
 * Bandingkan lewat digest supaya kedua masukan selalu sama panjang:
 * `timingSafeEqual` melempar galat pada panjang berbeda, dan cabang
 * "panjangnya beda" yang keluar lebih cepat membocorkan panjang token.
 */
export function matchesSetupToken(expected: string, candidate: string) {
  const digest = (value: string) =>
    createHash("sha256").update(value, "utf8").digest();
  return timingSafeEqual(digest(expected), digest(candidate.trim()));
}
