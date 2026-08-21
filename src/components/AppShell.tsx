"use client";

import type { ReactNode } from "react";
import { AutoAlfaRunner } from "./AutoAlfaRunner";
import { AutoSyncRunner } from "./AutoSyncRunner";
import { HeaderBar } from "./HeaderBar";

interface AppShellProps {
  children: ReactNode;
  contentClassName?: string;
}

export function AppShell({ children, contentClassName = "" }: AppShellProps) {
  return (
    <div className="app-shell min-h-dvh text-slate-100">
      <AutoAlfaRunner />
      <AutoSyncRunner />
      <a
        href="#main-content"
        className="fixed left-4 top-3 z-[100] -translate-y-20 rounded-lg bg-white px-3 py-2 text-sm font-bold text-slate-950 shadow-xl transition-transform focus:translate-y-0"
      >
        Lewati ke konten utama
      </a>
      <HeaderBar />
      <main
        id="main-content"
        className={`flex min-h-0 flex-1 flex-col pb-24 lg:pb-0 ${contentClassName}`}
      >
        {children}
      </main>
    </div>
  );
}
