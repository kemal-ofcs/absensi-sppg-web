"use client";

import type React from "react";
import {
  createContext,
  useCallback,
  useContext,
  useState,
  useSyncExternalStore,
} from "react";
import {
  getDesktopSessionServerSnapshot,
  getDesktopSessionSnapshot,
  loginDesktopSession,
  logoutDesktopSession,
  subscribeDesktopSession,
} from "@/lib/auth/desktop-session-store";
import { redirectAfterLogout } from "@/lib/auth/logout-navigation";
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

const AuthContext = createContext<AuthContextType>({
  user: null,
  isAuthenticated: false,
  isLoading: true,
  login: async () => ({ sukses: false, pesan: "AuthContext belum terpasang." }),
  logout: () => {},
});

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const desktopSessionSnapshot = useSyncExternalStore(
    subscribeDesktopSession,
    getDesktopSessionSnapshot,
    getDesktopSessionServerSnapshot,
  );
  const webSessionSnapshot = useSyncExternalStore(
    subscribeWebSession,
    getWebSessionSnapshot,
    getWebSessionServerSnapshot,
  );
  const isDesktop = isDesktopRuntime();
  const user = isDesktop
    ? desktopSessionSnapshot.user
    : webSessionSnapshot.user;
  const [isLoading, setIsLoading] = useState<boolean>(false);

  const login = useCallback(async (username: string, passwordPlain: string) => {
    setIsLoading(true);
    try {
      if (!isDesktopRuntime()) {
        return await loginWebSession(username, passwordPlain);
      }
      return await loginDesktopSession(username, passwordPlain);
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
    setIsLoading(true);
    const logoutRequest = isDesktopRuntime()
      ? logoutDesktopSession()
      : logoutWebSession();

    void logoutRequest
      .catch(() => undefined)
      .finally(() => redirectAfterLogout());
  }, []);

  return (
    <AuthContext.Provider
      value={{
        user,
        isAuthenticated: !!user,
        isLoading:
          isLoading ||
          (isDesktop
            ? desktopSessionSnapshot.isLoading
            : webSessionSnapshot.isLoading),
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
