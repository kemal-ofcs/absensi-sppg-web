import "server-only";

import { AuthorizationError } from "@/lib/auth/permission-assertion";
import { isSameOriginRequest } from "@/lib/auth/request-origin";

export function isSameOriginMutation(request: Request) {
  return isSameOriginRequest(request);
}

export function assertSameOriginMutation(request: Request) {
  if (!isSameOriginMutation(request)) {
    throw new AuthorizationError("Origin tidak diizinkan.", 403);
  }
}

export function acceptsJson(request: Request) {
  return request.headers
    .get("content-type")
    ?.toLowerCase()
    .startsWith("application/json");
}

/**
 * Alamat pemanggil untuk rate limit dan allowlist IP scanner Web.
 *
 * Yang dibaca adalah entri PALING KANAN `X-Forwarded-For`, dikurangi jumlah
 * proxy tepercaya (`KOS_TRUSTED_PROXY_HOPS`, bawaan 1). Entri paling kiri
 * adalah isian klien: di belakang nginx/Caddy yang MENAMBAHKAN alamat, klien
 * bebas menulisnya sendiri dan lolos dari rate limit maupun allowlist IP. Di
 * Vercel header ini ditimpa platform (satu alamat), jadi hasilnya sama.
 */
export function getClientAddress(request: Request) {
  // Nama lama `SPPG_TRUSTED_PROXY_HOPS` tetap dibaca; nama `KOS_` yang menang.
  const hops = Math.max(
    1,
    Number(
      process.env.KOS_TRUSTED_PROXY_HOPS ?? process.env.SPPG_TRUSTED_PROXY_HOPS,
    ) || 1,
  );
  const rantai = (request.headers.get("x-forwarded-for") ?? "")
    .split(",")
    .map((alamat) => alamat.trim())
    .filter(Boolean);
  return (
    rantai[rantai.length - hops] ??
    (request.headers.get("x-real-ip")?.trim() || "unknown")
  );
}
