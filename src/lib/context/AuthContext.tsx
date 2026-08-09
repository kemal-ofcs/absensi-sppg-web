"use client";

import { useRouter } from "next/navigation";
import type React from "react";
import {
  createContext,
  useCallback,
  useContext,
  useState,
  useSyncExternalStore,
} from "react";
import type { OperatorUser } from "@/lib/auth/operator-user";
import {
  getWebSessionServerSnapshot,
  getWebSessionSnapshot,
  loginWebSession,
  logoutWebSession,
  subscribeWebSession,
} from "@/lib/auth/web-session-store";
import { isDesktopRuntime } from "@/lib/runtime/app-runtime";

export type { OperatorUser } from "@/lib/auth/operator-user";

interface AuthContextType {
  user: OperatorUser | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  login: (
    username: string,
    passwordPlain: string,
  ) => Promise<{ sukses: boolean; pesan: string }>;
  logout: () => void;
}

const STORAGE_KEY = "absensi_sppg_operator_session";
const SESSION_CHANGE_EVENT = "absensi-sppg:session-change";

function subscribeToSession(onStoreChange: () => void) {
  const handleStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === STORAGE_KEY) {
      onStoreChange();
    }
  };

  window.addEventListener("storage", handleStorage);
  window.addEventListener(SESSION_CHANGE_EVENT, onStoreChange);

  return () => {
    window.removeEventListener("storage", handleStorage);
    window.removeEventListener(SESSION_CHANGE_EVENT, onStoreChange);
  };
}

function getSessionSnapshot() {
  return localStorage.getItem(STORAGE_KEY);
}

function parseSession(snapshot: string | null): OperatorUser | null {
  if (!snapshot) return null;

  try {
    const parsed = JSON.parse(snapshot) as Partial<OperatorUser>;
    if (
      !Number.isSafeInteger(parsed.id) ||
      typeof parsed.roleId !== "number" ||
      typeof parsed.roleKey !== "string" ||
      typeof parsed.isSuperadmin !== "boolean" ||
      !Array.isArray(parsed.permissions)
    ) {
      return null;
    }
    return parsed as OperatorUser;
  } catch {
    return null;
  }
}

function writeSession(user: OperatorUser | null) {
  if (user) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(user));
  } else {
    localStorage.removeItem(STORAGE_KEY);
  }

  window.dispatchEvent(new Event(SESSION_CHANGE_EVENT));
}

const AuthContext = createContext<AuthContextType>({
  user: null,
  isAuthenticated: false,
  isLoading: true,
  login: async () => ({ sukses: false, pesan: "AuthContext belum terpasang." }),
  logout: () => {},
});

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const legacySessionSnapshot = useSyncExternalStore(
    subscribeToSession,
    getSessionSnapshot,
    () => null,
  );
  const webSessionSnapshot = useSyncExternalStore(
    subscribeWebSession,
    getWebSessionSnapshot,
    getWebSessionServerSnapshot,
  );
  const isDesktop = isDesktopRuntime();
  const user = isDesktop
    ? parseSession(legacySessionSnapshot)
    : webSessionSnapshot.user;
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const router = useRouter();

  const login = useCallback(async (username: string, passwordPlain: string) => {
    setIsLoading(true);
    try {
      if (!isDesktopRuntime()) {
        return await loginWebSession(username, passwordPlain);
      }
      const { verifikasiLoginOperator } = await import(
        "@/lib/services/operator"
      );
      const result = await verifikasiLoginOperator(username, passwordPlain);
      if (result.sukses && result.operator) {
        const sessionUser: OperatorUser = {
          id: result.operator.id,
          kode_operator: result.operator.kodeOperator,
          nama_operator: result.operator.name,
          username: result.operator.username,
          role: result.operator.roleName,
          roleId: result.operator.roleId,
          roleKey: result.operator.roleKey,
          isSuperadmin: result.operator.isSuperadmin,
          permissions: result.operator.permissions,
          permissionRevision: result.operator.permissionRevision,
          loginAt: new Date().toISOString(),
        };

        writeSession(sessionUser);
        return { sukses: true, pesan: result.pesan };
      }
      return { sukses: false, pesan: result.pesan };
    } catch (err: unknown) {
      const msg =
        err instanceof Error
          ? err.message
          : "Terjadi kesalahan saat memproses login.";
      return { sukses: false, pesan: msg };
    } finally {
      setIsLoading(false);
    }
  }, []);

  const logout = useCallback(() => {
    if (isDesktopRuntime()) {
      writeSession(null);
      router.push("/login");
      return;
    }
    void logoutWebSession().finally(() => router.push("/login"));
  }, [router]);

  return (
    <AuthContext.Provider
      value={{
        user,
        isAuthenticated: !!user,
        isLoading: isLoading || (!isDesktop && webSessionSnapshot.isLoading),
        login,
        logout,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
