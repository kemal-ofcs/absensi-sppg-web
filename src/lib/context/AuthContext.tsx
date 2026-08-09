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
import { verifikasiLoginOperator } from "@/lib/services/operator";

export interface OperatorUser {
  id: number;
  kode_operator: string;
  nama_operator: string;
  username: string;
  role: string;
  loginAt?: string;
}

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
    return JSON.parse(snapshot) as OperatorUser;
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
  const sessionSnapshot = useSyncExternalStore(
    subscribeToSession,
    getSessionSnapshot,
    () => null,
  );
  const user = parseSession(sessionSnapshot);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const router = useRouter();

  const login = useCallback(async (username: string, passwordPlain: string) => {
    setIsLoading(true);
    try {
      const result = await verifikasiLoginOperator(username, passwordPlain);
      if (result.sukses && result.operator) {
        const sessionUser: OperatorUser = {
          id: result.operator.id,
          kode_operator: result.operator.kode_operator,
          nama_operator: result.operator.nama_operator,
          username: result.operator.username,
          role: result.operator.role,
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
    writeSession(null);
    router.push("/login");
  }, [router]);

  return (
    <AuthContext.Provider
      value={{
        user,
        isAuthenticated: !!user,
        isLoading,
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
