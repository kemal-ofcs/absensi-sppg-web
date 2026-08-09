"use client";

import type { OperatorUser } from "@/lib/auth/operator-user";
import { isDesktopRuntime } from "@/lib/runtime/app-runtime";

interface WebSessionSnapshot {
  user: OperatorUser | null;
  isLoading: boolean;
}

interface AuthApiResponse {
  sukses: boolean;
  pesan?: string;
  operator?: OperatorUser | null;
}

const LEGACY_SESSION_KEY = "absensi_sppg_operator_session";
const LEGACY_OPERATOR_CACHE_KEY = "absensi_sppg_cached_operators_v2";
const SERVER_SNAPSHOT: WebSessionSnapshot = { user: null, isLoading: true };
let snapshot: WebSessionSnapshot = SERVER_SNAPSHOT;
let started = false;
const listeners = new Set<() => void>();

function emit(next: WebSessionSnapshot) {
  snapshot = next;
  for (const listener of listeners) listener();
}

function clearLegacyWebCredentials() {
  if (typeof window === "undefined" || isDesktopRuntime()) return;
  localStorage.removeItem(LEGACY_SESSION_KEY);
  localStorage.removeItem(LEGACY_OPERATOR_CACHE_KEY);
}

async function readResponse(response: Response) {
  try {
    return (await response.json()) as AuthApiResponse;
  } catch {
    return { sukses: false, pesan: "Respons autentikasi tidak valid." };
  }
}

export function subscribeWebSession(listener: () => void) {
  listeners.add(listener);
  if (!started && !isDesktopRuntime()) {
    started = true;
    clearLegacyWebCredentials();
    void refreshWebSession();
  }
  return () => listeners.delete(listener);
}

export function getWebSessionSnapshot() {
  return snapshot;
}

export function getWebSessionServerSnapshot() {
  return SERVER_SNAPSHOT;
}

export async function refreshWebSession() {
  if (isDesktopRuntime()) return null;
  try {
    const response = await fetch("/api/auth/session", {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
    });
    const body = await readResponse(response);
    const user = response.ok && body.sukses ? (body.operator ?? null) : null;
    emit({ user, isLoading: false });
    return user;
  } catch {
    emit({ user: null, isLoading: false });
    return null;
  }
}

export async function loginWebSession(username: string, password: string) {
  try {
    const response = await fetch("/api/auth/login", {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    const body = await readResponse(response);
    if (response.ok && body.sukses && body.operator) {
      emit({ user: body.operator, isLoading: false });
      return { sukses: true, pesan: body.pesan ?? "Login berhasil." };
    }
    emit({ user: null, isLoading: false });
    return {
      sukses: false,
      pesan: body.pesan ?? "Username atau password tidak sesuai.",
    };
  } catch {
    return {
      sukses: false,
      pesan: "Server autentikasi tidak dapat dijangkau.",
    };
  }
}

export async function logoutWebSession() {
  try {
    await fetch("/api/auth/session", {
      method: "DELETE",
      credentials: "same-origin",
      cache: "no-store",
    });
  } finally {
    emit({ user: null, isLoading: false });
  }
}

export function invalidateWebSession() {
  if (!isDesktopRuntime()) emit({ user: null, isLoading: false });
}
