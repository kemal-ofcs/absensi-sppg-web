"use client";

import type { Session } from "next-auth";
import { getSession, signIn, signOut } from "next-auth/react";
import { useEffect, useMemo, useState } from "react";
import { useAuthSessionRuntime } from "@/components/providers/auth-session-provider";
import type { AuthRole } from "@/core/auth/roles";
import { isTauri } from "@/core/env";
import {
  clearForcedLogoutMarker,
  setForcedLogoutMarker,
} from "@/lib/auth/logout-marker";
import { type UserSession, useStore } from "@/lib/store/use-store";

type DesktopLoginResponse = {
  success: boolean;
  user?: UserSession | null;
  error?: string | null;
};

function buildWebSession(
  user: NonNullable<Session["user"]>,
): UserSession | null {
  if (!user.id) return null;
  const now = new Date();
  return {
    id: user.id,
    fullName: user.name || "",
    email: user.email || "",
    username: null,
    role: ((user as { role?: AuthRole }).role || "staff") as AuthRole,
    isActive: true,
    lastLoginAt: now,
    provider: null,
    providerId: null,
    version: 1,
    hlc: null,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    syncStatus: "synced",
  };
}

async function nativeDesktopLogin(identifier: string, password: string) {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<DesktopLoginResponse>("verify_local_desktop_login", {
    request: { identifier, password },
  });
}

export function useAuth() {
  const runtime = useAuthSessionRuntime();
  const storedUser = useStore((state) => state.user);
  const setUser = useStore((state) => state.login);
  const clearUser = useStore((state) => state.logout);
  const [mounted, setMounted] = useState(false);
  const desktopRuntime = runtime.desktopRuntime || (mounted && isTauri());
  const webUser = useMemo(
    () =>
      runtime.session?.user ? buildWebSession(runtime.session.user) : null,
    [runtime.session?.user],
  );
  const user = desktopRuntime ? storedUser : webUser;

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    const storeMatchesSession =
      storedUser?.id === webUser?.id &&
      storedUser?.email === webUser?.email &&
      storedUser?.role === webUser?.role &&
      storedUser?.version === webUser?.version;

    if (
      !desktopRuntime &&
      runtime.status === "authenticated" &&
      webUser &&
      !storeMatchesSession
    ) {
      setUser(webUser);
    }
    if (!desktopRuntime && runtime.status === "unauthenticated" && storedUser)
      clearUser();
  }, [desktopRuntime, runtime.status, webUser, storedUser, setUser, clearUser]);

  async function login(identifier: string, password: string) {
    const normalized = identifier.trim().toLowerCase();
    if (desktopRuntime) {
      let result: DesktopLoginResponse;
      try {
        result = await nativeDesktopLogin(normalized, password);
      } catch (error) {
        console.warn(
          "[AUTH] Native login was not ready; initializing local DB.",
          error,
        );
        result = { success: false, error: "LOCAL_DB_NOT_READY" };
      }

      if (!result.success && result.error !== "INVALID_CREDENTIALS") {
        const { apiPost } = await import("@/lib/api/request");
        result = await apiPost<DesktopLoginResponse>("/api/auth/login", {
          identifier: normalized,
          password,
        });
      }
      if (!result.success || !result.user) {
        return {
          success: false as const,
          error:
            result.error === "INVALID_CREDENTIALS"
              ? "Email/username atau password salah"
              : result.error || "Login desktop gagal diproses",
        };
      }
      setUser(result.user);
      clearForcedLogoutMarker();
      return { success: true as const };
    }

    const signInResult = await signIn("credentials", {
      email: normalized,
      password,
      redirect: false,
    });
    if (!signInResult || signInResult.error) {
      return {
        success: false as const,
        error: "Email/username atau password salah",
      };
    }
    const latestSession = await getSession();
    const nextUser = latestSession?.user
      ? buildWebSession(latestSession.user)
      : null;
    if (!nextUser)
      return { success: false as const, error: "Sesi login gagal dibuat" };
    setUser(nextUser);
    clearForcedLogoutMarker();
    return { success: true as const };
  }

  async function logout() {
    setForcedLogoutMarker();
    clearUser();
    if (!desktopRuntime) await signOut({ redirect: true, redirectTo: "/" });
  }

  return {
    user,
    isAuthenticated: Boolean(user),
    isLoading: !mounted || (!desktopRuntime && runtime.status === "loading"),
    session: runtime.session,
    sessionStatus: runtime.status,
    authSource: user
      ? desktopRuntime
        ? "desktop-store"
        : "next-auth"
      : "none",
    login,
    logout,
    refreshSession: async () => Boolean(user),
  };
}
