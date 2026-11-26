import { describe, expect, test } from "bun:test";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Sakelar } from "./Sakelar";

const html = (props: Parameters<typeof Sakelar>[0]) =>
  renderToStaticMarkup(createElement(Sakelar, props));

describe("Sakelar", () => {
  test("role switch dengan aria-checked mengikuti keadaan", () => {
    const nyala = html({ checked: true, onChange: () => {}, label: "Uji" });
    expect(nyala).toContain('role="switch"');
    expect(nyala).toContain('aria-checked="true"');
    expect(nyala).toContain('aria-label="Uji"');
    expect(nyala).toContain(">Aktif<");
    const mati = html({ checked: false, onChange: () => {}, label: "Uji" });
    expect(mati).toContain('aria-checked="false"');
    expect(mati).toContain(">Nonaktif<");
  });

  test("tampilkanStatus=false menyembunyikan teks status", () => {
    const out = html({
      checked: true,
      onChange: () => {},
      label: "Uji",
      tampilkanStatus: false,
    });
    expect(out).not.toContain("sakelar-status");
  });

  test("disabled diteruskan ke tombol", () => {
    expect(
      html({
        checked: false,
        onChange: () => {},
        label: "Uji",
        disabled: true,
      }),
    ).toContain("disabled");
  });

  test("klik membalik nilai", () => {
    const dipanggil: boolean[] = [];
    for (const checked of [true, false]) {
      const akar = Sakelar({
        checked,
        onChange: (v) => dipanggil.push(v),
        label: "Uji",
      });
      const tombol = (akar.props as { children: ReactElement[] }).children[1];
      (tombol.props as { onClick: () => void }).onClick();
    }
    expect(dipanggil).toEqual([false, true]);
  });
});
