import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

mock.module("server-only", () => ({}));

const testDirectory = mkdtempSync(join(tmpdir(), "sppg-holiday-test-"));
process.env.TURSO_DATABASE_URL = `file:${join(testDirectory, "test.db")}`;

const { db, ensureDbInitialized } = await import("@/lib/db");
const {
  cekHariLiburAktif,
  getDaftarHariLibur,
  hapusHariLibur,
  tambahHariLibur,
  updateHariLibur,
} = await import("./holiday");

beforeAll(async () => {
  await ensureDbInitialized();
});

beforeEach(async () => {
  await db.execute("DELETE FROM tbl_hari_libur;");
});

afterAll(() => {
  try {
    db.close();
    rmSync(testDirectory, { recursive: true, force: true });
  } catch {}
});

describe("Holiday Service (Hari Libur)", () => {
  test("tambah, list, update, dan hapus hari libur", async () => {
    // 1. Tambah hari libur
    const addRes = await tambahHariLibur({
      tanggal: "2026-08-17",
      nama_libur: "Hari Kemerdekaan RI",
      jenis_libur: "Libur Nasional",
      keterangan: "HUT RI ke-81",
      status_aktif: 1,
    });
    expect(addRes.sukses).toBe(true);
    expect(addRes.id_libur).toBeGreaterThan(0);

    // 2. Cek hari libur aktif
    const active = await cekHariLiburAktif("2026-08-17");
    expect(active).not.toBeNull();
    expect(active?.nama_libur).toBe("Hari Kemerdekaan RI");
    expect(active?.status_aktif).toBe(1);

    // Tanggal lain tidak aktif
    const nonHoliday = await cekHariLiburAktif("2026-08-18");
    expect(nonHoliday).toBeNull();

    // 3. Update status aktif menjadi nonaktif (0)
    await updateHariLibur(addRes.id_libur, { status_aktif: 0 });
    const deactCheck = await cekHariLiburAktif("2026-08-17");
    expect(deactCheck).toBeNull(); // Karena status_aktif = 0, cekHariLiburAktif mengembalikan null

    // 4. List semua hari libur
    const list = await getDaftarHariLibur();
    expect(list.length).toBe(1);
    expect(list[0].status_aktif).toBe(0);

    // 5. Hapus hari libur
    await hapusHariLibur(addRes.id_libur);
    const listAfterDelete = await getDaftarHariLibur();
    expect(listAfterDelete.length).toBe(0);
  });
});
