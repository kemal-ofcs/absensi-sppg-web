import { describe, expect, test } from "bun:test";

import {
  assertPromotionOrder,
  detectUniqueCollisions,
  PROMOTION_EXCLUDED_TABLES,
  PROMOTION_PLAN,
  type PromotionTable,
  planIdRemap,
} from "@/lib/server/database-promotion";

function spec(overrides: Partial<PromotionTable> = {}): PromotionTable {
  return {
    table: "master_data",
    uniqueColumns: ["kode_karyawan"],
    dependsOn: [],
    ...overrides,
  };
}

describe("urutan penyalinan", () => {
  test("setiap tabel muncul setelah tabel yang dirujuknya", () => {
    expect(() => assertPromotionOrder()).not.toThrow();
  });

  /**
   * Menyalin operator sebelum role akan gagal dengan pelanggaran foreign key di
   * tengah transaksi — setelah sebagian data sudah berpindah.
   */
  test("urutan yang terbalik ditolak dan menyebut kedua tabelnya", () => {
    expect(() =>
      assertPromotionOrder([
        spec({ table: "master_operator", dependsOn: ["app_role"] }),
        spec({ table: "app_role" }),
      ]),
    ).toThrow(/master_operator.*app_role/);
  });

  test("tidak ada tabel yang terdaftar dua kali", () => {
    const names = PROMOTION_PLAN.map((entry) => entry.table);
    expect(new Set(names).size).toBe(names.length);
  });

  test("tabel yang dikecualikan tidak ikut rencana promosi", () => {
    const planned = new Set(PROMOTION_PLAN.map((entry) => entry.table));
    for (const excluded of PROMOTION_EXCLUDED_TABLES) {
      expect(planned.has(excluded)).toBe(false);
    }
  });
});

describe("deteksi tabrakan nilai unik", () => {
  /** Dua orang berbeda memakai satu kode karyawan: promosi WAJIB berhenti. */
  test("nilai sama dengan kunci berbeda dilaporkan sebagai tabrakan", () => {
    const collisions = detectUniqueCollisions(
      spec({ autoIncrementPk: "id" }),
      [{ id: 1, kode_karyawan: "K-001" }],
      [{ id: 9, kode_karyawan: "K-001" }],
    );
    expect(collisions).toHaveLength(1);
    expect(collisions[0]?.column).toBe("kode_karyawan");
    expect(collisions[0]?.value).toBe("K-001");
    expect(collisions[0]?.destinationKey).toBe("9");
  });

  /** Promosi yang diulang harus aman — baris yang sama bukan tabrakan. */
  test("baris yang sama persis bukan tabrakan", () => {
    const collisions = detectUniqueCollisions(
      spec({ autoIncrementPk: "id" }),
      [{ id: 1, kode_karyawan: "K-001" }],
      [{ id: 1, kode_karyawan: "K-001" }],
    );
    expect(collisions).toHaveLength(0);
  });

  /**
   * `kode_karyawan` dan `token_absensi` boleh NULL di skema. Nilai kosong bukan
   * nilai yang bertabrakan — memperlakukannya begitu akan menghentikan promosi
   * pada setiap database yang punya lebih dari satu baris tanpa kode.
   */
  test("nilai kosong dan null diabaikan", () => {
    const collisions = detectUniqueCollisions(
      spec({
        autoIncrementPk: "id",
        uniqueColumns: ["kode_karyawan", "token_absensi"],
      }),
      [
        { id: 1, kode_karyawan: null, token_absensi: "" },
        { id: 2, kode_karyawan: "", token_absensi: null },
      ],
      [
        { id: 8, kode_karyawan: null, token_absensi: "" },
        { id: 9, kode_karyawan: "", token_absensi: null },
      ],
    );
    expect(collisions).toHaveLength(0);
  });

  test("beberapa kolom unik diperiksa seluruhnya", () => {
    const collisions = detectUniqueCollisions(
      spec({
        table: "master_operator",
        autoIncrementPk: "id",
        uniqueColumns: ["kode_operator", "username"],
      }),
      [{ id: 1, kode_operator: "OP-1", username: "budi" }],
      [
        { id: 5, kode_operator: "OP-1", username: "lain" },
        { id: 6, kode_operator: "OP-9", username: "budi" },
      ],
    );
    expect(collisions).toHaveLength(2);
    expect(collisions.map((entry) => entry.column).sort()).toEqual([
      "kode_operator",
      "username",
    ]);
  });
});

describe("pemetaan ulang kunci AUTOINCREMENT", () => {
  /**
   * Inti masalah promosi: dua perangkat yang berjalan sendiri-sendiri hampir
   * pasti memakai id 1..n untuk baris yang berbeda.
   */
  test("id yang bentrok diberi nilai baru di atas nilai tertinggi tujuan", () => {
    const remap = planIdRemap(
      spec({ table: "app_role", autoIncrementPk: "id" }),
      [{ id: 1 }, { id: 2 }],
      [{ id: 1 }, { id: 2 }, { id: 7 }],
    );
    expect(remap.get(1)).toBe(8);
    expect(remap.get(2)).toBe(9);
  });

  /** Rujukan yang sudah benar tidak diguncang tanpa perlu. */
  test("id yang belum dipakai tujuan dipertahankan apa adanya", () => {
    const remap = planIdRemap(
      spec({ table: "app_role", autoIncrementPk: "id" }),
      [{ id: 50 }],
      [{ id: 1 }],
    );
    expect(remap.size).toBe(0);
  });

  test("tabel berkunci TEXT tidak menghasilkan pemetaan apa pun", () => {
    const remap = planIdRemap(
      spec({ table: "hari_libur_whitelist", uniqueColumns: [] }),
      [{ id: "hlw-abc" }],
      [{ id: "hlw-xyz" }],
    );
    expect(remap.size).toBe(0);
  });

  test("id baru tidak pernah bertabrakan satu sama lain", () => {
    const remap = planIdRemap(
      spec({ table: "app_role", autoIncrementPk: "id" }),
      [{ id: 1 }, { id: 2 }, { id: 3 }],
      [{ id: 1 }, { id: 2 }, { id: 3 }],
    );
    const assigned = [...remap.values()];
    expect(new Set(assigned).size).toBe(assigned.length);
    expect(Math.min(...assigned)).toBeGreaterThan(3);
  });
});
