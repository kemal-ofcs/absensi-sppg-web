import { describe, expect, test } from "bun:test";
import type { IdCardElement } from "@/types/id-card";
import { resolveElementText } from "./id-card-renderer";

function elemen(sourceKey: IdCardElement["sourceKey"]): IdCardElement {
  return {
    id: "uji",
    type: "text",
    side: "front",
    sourceKey,
    label: "Label",
    x: 0,
    y: 0,
    fontSize: 12,
    color: "#ffffff",
  };
}

describe("jenis kelamin di kartu", () => {
  const gender = elemen("employee.gender");

  test("kode L/P dari data induk diterjemahkan", () => {
    expect(resolveElementText(gender, { lp: "P" })).toBe("Perempuan");
    expect(resolveElementText(gender, { lp: " l " })).toBe("Laki-laki");
    expect(resolveElementText(gender, { jenis_kelamin: "P", lp: "L" })).toBe(
      "Perempuan",
    );
  });

  test("teks yang sudah berupa kata dipakai apa adanya", () => {
    expect(resolveElementText(gender, { jenis_kelamin: "Perempuan" })).toBe(
      "Perempuan",
    );
  });

  test("yang kosong tidak pernah menjadi Laki-laki di kartu sungguhan", () => {
    expect(resolveElementText(gender, {})).toBe("");
    expect(resolveElementText(gender, { lp: null })).toBe("");
    expect(resolveElementText(gender, {}, null, true)).toBe("Laki-laki");
  });
});

describe("data kosong lain di kartu", () => {
  for (const sourceKey of [
    "employee.position",
    "employee.department",
  ] as const) {
    test(`${sourceKey}: kosong di kartu sungguhan, contoh di perancang`, () => {
      expect(resolveElementText(elemen(sourceKey), {})).toBe("");
      expect(resolveElementText(elemen(sourceKey), {}, null, true)).not.toBe(
        "",
      );
    });
  }

  test("data yang terisi tidak berubah", () => {
    const orang = { jabatan_status: "Supervisor", divisi: "Gudang" };
    expect(resolveElementText(elemen("employee.position"), orang)).toBe(
      "Supervisor",
    );
    expect(resolveElementText(elemen("employee.department"), orang)).toBe(
      "Gudang",
    );
  });
});
