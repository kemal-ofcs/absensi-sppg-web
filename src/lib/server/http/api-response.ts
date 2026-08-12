import "server-only";

import { NextResponse } from "next/server";
import { AuthorizationError } from "@/lib/auth/permission-assertion";
import {
  JsonBodyError,
  readBoundedJsonBody,
} from "@/lib/server/http/json-body";

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
  try {
    return await readBoundedJsonBody<T>(request, maxBytes);
  } catch (error) {
    if (error instanceof JsonBodyError) {
      throw new ApiRequestError(error.message, error.status);
    }
    throw error;
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
        pesan: "Kode, username, ID, atau nama unik tersebut sudah digunakan.",
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
