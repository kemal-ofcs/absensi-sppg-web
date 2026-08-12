"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { useAuth } from "@/hooks/use-auth";

export function DashboardGuard({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const { isAuthenticated, isLoading } = useAuth();

  useEffect(() => {
    if (!isLoading && !isAuthenticated) router.replace("/login");
  }, [isAuthenticated, isLoading, router]);

  if (isLoading) {
    return <div className="p-8 text-sm text-zinc-400">Loading session...</div>;
  }
  if (!isAuthenticated) return null;
  return <>{children}</>;
}
