"use client";

import {
  clearForcedLogoutMarker,
  hasForcedLogoutMarker,
  setForcedLogoutMarker,
} from "@/lib/auth/logout-marker";
import type { OperatorUser } from "@/lib/auth/operator-user";
import { isDesktopRuntime } from "@/lib/runtime/app-runtime";
import { invokeDesktop } from "@/lib/runtime/desktop-commands";

type DesktopSessionMode = "online" | "offline";

interface DesktopLoginResponse {
  sukses: boolean;
  pesan: string;
  operator: OperatorUser;
  mode: DesktopSessionMode;
  offlineReady: boolean;
  offlineValidUntil?: number | null;
}

interface DesktopSessionSnapshot {
  user: OperatorUser | null;
  isLoading: boolean;
  mode: DesktopSessionMode | null;
}

const LEGACY_SESSION_KEY = "absensi_sppg_operator_session";
const SERVER_SNAPSHOT: DesktopSessionSnapshot = {
  user: null,
  isLoading: true,
  mode: null,
};
let snapshot: DesktopSessionSnapshot = SERVER_SNAPSHOT;
let started = false;
const listeners = new Set<() => void>();

function emit(next: DesktopSessionSnapshot) {
  snapshot = next;
  for (const listener of listeners) listener();
}

async function refreshDesktopSession() {
  if (!isDesktopRuntime()) return null;
  if (hasForcedLogoutMarker()) {
    emit({ user: null, isLoading: false, mode: null });
    try {
      await invokeDesktop<void>("desktop_logout");
    } catch {
      // Marker mencegah sesi lama dipulihkan sampai login baru berhasil.
    }
    return null;
  }
  try {
    const user = await invokeDesktop<OperatorUser | null>(
      "desktop_get_session",
    );
    emit({ user, isLoading: false, mode: null });
    return user;
  } catch {
    emit({ user: null, isLoading: false, mode: null });
    return null;
  }
}

export function subscribeDesktopSession(listener: () => void) {
  listeners.add(listener);
  if (!started && isDesktopRuntime()) {
    started = true;
    localStorage.removeItem(LEGACY_SESSION_KEY);
    void refreshDesktopSession();
  }
  return () => listeners.delete(listener);
}

export function getDesktopSessionSnapshot() {
  return snapshot;
}

export function getDesktopSessionServerSnapshot() {
  return SERVER_SNAPSHOT;
}

export async function loginDesktopSession(
  identifier: string,
  password: string,
) {
  const result = await invokeDesktop<DesktopLoginResponse>("desktop_login", {
    identifier,
    password,
  });
  if (!result.sukses || !result.operator) {
    emit({ user: null, isLoading: false, mode: null });
    return {
      sukses: false,
      pesan: result.pesan || "Login Desktop tidak berhasil.",
    };
  }
  clearForcedLogoutMarker();
  emit({ user: result.operator, isLoading: false, mode: result.mode });
  return { sukses: true, pesan: result.pesan };
}

export async function logoutDesktopSession() {
  setForcedLogoutMarker();
  emit({ user: null, isLoading: false, mode: null });
  try {
    await invokeDesktop<void>("desktop_logout");
  } catch {
    // Logout UI tetap final; command dicoba lagi setelah reload.
  }
}

export function invalidateDesktopSession() {
  emit({ user: null, isLoading: false, mode: null });
}
