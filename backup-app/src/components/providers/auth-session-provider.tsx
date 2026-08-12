"use client";

import type { Session } from "next-auth";
import { SessionProvider, useSession } from "next-auth/react";
import { createContext, useContext, useEffect, useState } from "react";
import { isTauri } from "@/core/env";
import { useStore } from "@/lib/store/use-store";

type AuthSessionContextValue = {
  desktopRuntime: boolean;
  status: "authenticated" | "unauthenticated" | "loading";
  session: Session | null;
};

const AuthSessionRuntimeContext = createContext<AuthSessionContextValue>({
  desktopRuntime: false,
  status: "loading",
  session: null,
});

function DesktopSessionProvider({ children }: { children: React.ReactNode }) {
  const user = useStore((state) => state.user);

  return (
    <AuthSessionRuntimeContext.Provider
      value={{
        desktopRuntime: true,
        status: user ? "authenticated" : "unauthenticated",
        session: null,
      }}
    >
      {children}
    </AuthSessionRuntimeContext.Provider>
  );
}

function WebSessionProvider({ children }: { children: React.ReactNode }) {
  function SessionRuntimeBridge({ children }: { children: React.ReactNode }) {
    const { data, status } = useSession();

    return (
      <AuthSessionRuntimeContext.Provider
        value={{
          desktopRuntime: false,
          status,
          session: data ?? null,
        }}
      >
        {children}
      </AuthSessionRuntimeContext.Provider>
    );
  }

  return (
    <SessionProvider refetchOnWindowFocus={false} refetchInterval={0}>
      <SessionRuntimeBridge>{children}</SessionRuntimeBridge>
    </SessionProvider>
  );
}

export function AuthSessionProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [runtimeMode, setRuntimeMode] = useState<"pending" | "desktop" | "web">(
    "pending",
  );

  useEffect(() => {
    let cancelled = false;

    const resolveRuntimeMode = () => {
      if (cancelled) {
        return;
      }

      if (isTauri()) {
        setRuntimeMode("desktop");
        return;
      }

      setRuntimeMode((currentMode) => {
        if (currentMode === "pending") {
          window.setTimeout(resolveRuntimeMode, 100);
        }

        return currentMode === "pending" ? "pending" : currentMode;
      });
    };

    const finalizeWebRuntime = window.setTimeout(() => {
      if (cancelled) {
        return;
      }

      if (isTauri()) {
        setRuntimeMode("desktop");
        return;
      }

      setRuntimeMode("web");
    }, 1500);

    resolveRuntimeMode();

    return () => {
      cancelled = true;
      window.clearTimeout(finalizeWebRuntime);
    };
  }, []);

  if (runtimeMode === "pending") {
    return (
      <AuthSessionRuntimeContext.Provider
        value={{
          desktopRuntime: false,
          status: "loading",
          session: null,
        }}
      >
        {children}
      </AuthSessionRuntimeContext.Provider>
    );
  }

  if (runtimeMode === "desktop") {
    return <DesktopSessionProvider>{children}</DesktopSessionProvider>;
  }

  return <WebSessionProvider>{children}</WebSessionProvider>;
}

export function useAuthSessionRuntime() {
  return useContext(AuthSessionRuntimeContext);
}
