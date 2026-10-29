"use client";

import { type ReactNode, useEffect, useState } from "react";
import { useAuth } from "@/lib/context/AuthContext";
import { AutoAlfaRunner } from "./AutoAlfaRunner";
import { AutoSyncRunner } from "./AutoSyncRunner";
import { HeaderBar } from "./HeaderBar";
import { LicenseNotice } from "./license/LicenseNotice";
import { AuroraBackground } from "./visual/AuroraBackground";
import { VisualProvider } from "./visual/VisualProvider";

/** Preferensi per perangkat, tidak ikut sinkronisasi. */
const SIDEBAR_HIDDEN_KEY = "kos.sidebar.tersembunyi";

interface AppShellProps {
  children: ReactNode;
  contentClassName?: string;
}

export function AppShell({ children, contentClassName = "" }: AppShellProps) {
  const { user } = useAuth();
  const [sidebarPinned, setSidebarPinned] = useState(true);

  useEffect(() => {
    try {
      setSidebarPinned(localStorage.getItem(SIDEBAR_HIDDEN_KEY) !== "1");
    } catch {
      // Penyimpanan tidak tersedia: sidebar tampil seperti bawaan.
    }
  }, []);

  const changeSidebarPinned = (pinned: boolean) => {
    setSidebarPinned(pinned);
    try {
      if (pinned) localStorage.removeItem(SIDEBAR_HIDDEN_KEY);
      else localStorage.setItem(SIDEBAR_HIDDEN_KEY, "1");
    } catch {
      // Tidak diingat, tetap berlaku sampai halaman dimuat ulang.
    }
  };

  return (
    <div className="app-shell min-h-dvh text-slate-100">
      <VisualProvider />
      <AuroraBackground />
      <AutoAlfaRunner />
      <AutoSyncRunner />
      <a
        href="#main-content"
        className="fixed left-4 top-3 z-[100] -translate-y-20 rounded-lg bg-white px-3 py-2 text-sm font-bold text-slate-950 shadow-xl transition-transform focus:translate-y-0"
      >
        Lewati ke konten utama
      </a>
      <HeaderBar
        sidebarPinned={sidebarPinned}
        onSidebarPinnedChange={changeSidebarPinned}
      />
      <div
        className={`flex min-h-0 flex-1 flex-col ${user && sidebarPinned ? "xl:pl-64" : ""}`}
      >
        <LicenseNotice />
        <main
          id="main-content"
          className={`visual-page-enter relative z-10 flex min-h-0 flex-1 flex-col pb-24 lg:pb-0 ${contentClassName}`}
        >
          {children}
        </main>
      </div>
    </div>
  );
}
