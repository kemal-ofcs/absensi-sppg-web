import "server-only";

import { NextResponse } from "next/server";
import { AuthorizationError } from "@/lib/auth/permission-assertion";

export class ApiRequestError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 409 | 413 | 415,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

export function noStoreJson(body: unknown, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

export async function readJsonBody<T>(request: Request, maxBytes = 16_384) {
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("application/json")) {
    throw new ApiRequestError("Content-Type harus application/json.", 415);
  }
  if (Number(request.headers.get("content-length") ?? 0) > maxBytes) {
    throw new ApiRequestError("Payload terlalu besar.", 413);
  }
  try {
    return (await request.json()) as T;
  } catch {
    throw new ApiRequestError("Payload JSON tidak valid.", 400);
  }
}

export function toApiErrorResponse(error: unknown) {
  if (error instanceof AuthorizationError || error instanceof ApiRequestError) {
    return noStoreJson({ sukses: false, pesan: error.message }, error.status);
  }

  const message = error instanceof Error ? error.message : "Operasi gagal.";
  if (message.includes("UNIQUE")) {
    return noStoreJson(
      {
        sukses: false,
        pesan: "Kode operator, username, atau nama role sudah digunakan.",
      },
      409,
    );
  }
  const isConflict =
    message.includes("terakhir") ||
    message.includes("masih dipakai") ||
    message.includes("histori") ||
    message.includes("tidak dapat dihapus");
  return noStoreJson({ sukses: false, pesan: message }, isConflict ? 409 : 400);
}

export function parsePositiveId(value: unknown, label: string) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new ApiRequestError(`${label} tidak valid.`, 400);
  }
  return parsed;
}
