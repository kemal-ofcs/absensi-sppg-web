"use client";

import { invalidateWebSession } from "@/lib/auth/web-session-store";

interface ApiErrorBody {
  pesan?: string;
}

export async function requestWebApi<T>(
  url: string,
  method: "POST" | "PATCH" | "PUT" | "DELETE",
  body?: unknown,
) {
  const response = await fetch(url, {
    method,
    credentials: "same-origin",
    cache: "no-store",
    headers:
      body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let payload: (T & ApiErrorBody) | null = null;
  try {
    payload = (await response.json()) as T & ApiErrorBody;
  } catch {
    // Pesan fallback di bawah menjaga detail internal server tidak bocor.
  }
  if (response.status === 401) invalidateWebSession();
  if (!response.ok) {
    throw new Error(
      payload?.pesan ?? "Permintaan server tidak dapat diproses.",
    );
  }
  if (!payload) throw new Error("Respons server tidak valid.");
  return payload;
}
