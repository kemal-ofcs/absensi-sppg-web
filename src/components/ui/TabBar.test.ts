import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TabBar, tabTujuan } from "./TabBar";

const TABS = [
  { id: "a", label: "A" },
  { id: "b", label: "B" },
  { id: "c", label: "C" },
] as const;

const html = (extra: { panelId?: string } = {}) =>
  renderToStaticMarkup(
    createElement(TabBar<"a" | "b" | "c">, {
      tabs: TABS,
      value: "b",
      onChange: () => {},
      idPrefix: "uji",
      ariaLabel: "Bagian uji",
      ...extra,
    }),
  );

describe("tabTujuan", () => {
  test("panah kanan/kiri berputar, Home/End ke ujung", () => {
    expect(tabTujuan("ArrowRight", 0, 3)).toBe(1);
    expect(tabTujuan("ArrowRight", 2, 3)).toBe(0);
    expect(tabTujuan("ArrowLeft", 0, 3)).toBe(2);
    expect(tabTujuan("Home", 2, 3)).toBe(0);
    expect(tabTujuan("End", 0, 3)).toBe(2);
  });

  test("panah atas/bawah hanya saat vertikal; tombol lain null", () => {
    expect(tabTujuan("ArrowDown", 0, 3)).toBeNull();
    expect(tabTujuan("ArrowDown", 0, 3, true)).toBe(1);
    expect(tabTujuan("ArrowUp", 0, 3, true)).toBe(2);
    expect(tabTujuan("Enter", 0, 3)).toBeNull();
    expect(tabTujuan("ArrowRight", 0, 0)).toBeNull();
  });
});

describe("TabBar", () => {
  test("ARIA tablist, id, panel per tab, roving tabindex", () => {
    const out = html();
    expect(out).toContain('role="tablist"');
    expect(out).toContain('aria-label="Bagian uji"');
    expect(out).toContain('id="tab-uji-b"');
    expect(out).toContain('aria-controls="panel-uji-a"');
    expect(out.match(/aria-selected="true"/g)?.length).toBe(1);
    expect(out).toMatch(/id="tab-uji-b"[^>]*tabindex="0"/);
    expect(out.match(/tabindex="-1"/g)?.length).toBe(2);
  });

  test("panelId bersama dipakai semua tab", () => {
    const out = html({ panelId: "panel-satu" });
    expect(out.match(/aria-controls="panel-satu"/g)?.length).toBe(3);
  });
});
