"use client";

import type { KeyboardEvent, ReactNode } from "react";

/**
 * Id tab `tab-{idPrefix}-{id}`; panel `panel-{idPrefix}-{id}` per tab, atau satu
 * `panelId` bersama. Gaya di `.tab-bar*` globals.css.
 */
export interface TabItem<T extends string> {
  id: T;
  label: string;
  icon?: ReactNode;
  badge?: ReactNode;
}

interface TabBarProps<T extends string> {
  tabs: readonly TabItem<T>[];
  value: T;
  onChange: (id: T) => void;
  idPrefix: string;
  ariaLabel: string;
  panelId?: string;
  /** Tersusun tegak di layar >= 1024px (panah atas/bawah ikut aktif). */
  vertikalLg?: boolean;
}

/** Indeks tab tujuan untuk tombol keyboard, atau null bila tombol bukan navigasi. */
export function tabTujuan(
  tombol: string,
  sekarang: number,
  jumlah: number,
  vertikal = false,
): number | null {
  if (jumlah === 0) return null;
  const maju = tombol === "ArrowRight" || (vertikal && tombol === "ArrowDown");
  const mundur = tombol === "ArrowLeft" || (vertikal && tombol === "ArrowUp");
  if (maju) return (sekarang + 1) % jumlah;
  if (mundur) return (sekarang - 1 + jumlah) % jumlah;
  if (tombol === "Home") return 0;
  if (tombol === "End") return jumlah - 1;
  return null;
}

export function TabBar<T extends string>({
  tabs,
  value,
  onChange,
  idPrefix,
  ariaLabel,
  panelId,
  vertikalLg = false,
}: TabBarProps<T>) {
  const aktif = Math.max(
    0,
    tabs.findIndex((t) => t.id === value),
  );
  const idTab = (id: T) => `tab-${idPrefix}-${id}`;

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const tujuan = tabTujuan(e.key, aktif, tabs.length, vertikalLg);
    if (tujuan === null) return;
    e.preventDefault();
    const tab = tabs[tujuan];
    onChange(tab.id);
    document.getElementById(idTab(tab.id))?.focus();
  };

  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      data-vertikal-lg={vertikalLg ? "" : undefined}
      onKeyDown={onKeyDown}
      className="tab-bar"
    >
      {tabs.map((tab, i) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          id={idTab(tab.id)}
          aria-selected={tab.id === value}
          aria-controls={panelId ?? `panel-${idPrefix}-${tab.id}`}
          tabIndex={i === aktif ? 0 : -1}
          onClick={() => onChange(tab.id)}
          className="tab-bar-tab"
        >
          {tab.icon}
          {tab.label}
          {tab.badge}
        </button>
      ))}
    </div>
  );
}
