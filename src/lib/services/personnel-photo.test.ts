import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

mock.module("server-only", () => ({}));

const testDirectory = mkdtempSync(join(tmpdir(), "sppg-photo-test-"));
process.env.TURSO_DATABASE_URL = `file:${join(testDirectory, "test.db")}`;

const { db, ensureDbInitialized } = await import("@/lib/db");
const { deletePersonnelPhoto, getPersonnelPhoto, savePersonnelPhoto } =
  await import("./personnel-photo");

beforeAll(async () => {
  await ensureDbInitialized();
  await db.execute({
    sql: `INSERT INTO master_data (
      id_unik, kode_karyawan, nama, divisi, id_shift, status_aktif
    ) VALUES (?, ?, ?, ?, ?, ?);`,
    args: [
      "EMP-PHOTO-001",
      "EMP001",
      "Karyawan Uji",
      "Operasional",
      1,
      "Aktif",
    ],
  });
});

afterAll(() => {
  try {
    db.close();
    rmSync(testDirectory, { recursive: true, force: true });
  } catch {}
});

describe("Personnel Photo Service", () => {
  const sampleId = "EMP-PHOTO-001";
  const sampleBase64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

  test("getPersonnelPhoto mengembalikan null jika belum ada foto", async () => {
    const photo = await getPersonnelPhoto("NON-EXISTENT");
    expect(photo).toBeNull();
  });

  test("savePersonnelPhoto menolak MIME type tidak valid", async () => {
    expect(
      savePersonnelPhoto(sampleId, sampleBase64, "image/bmp"),
    ).rejects.toThrow("Format foto tidak didukung");
  });

  test("savePersonnelPhoto menolak foto kosong", async () => {
    expect(savePersonnelPhoto(sampleId, "", "image/jpeg")).rejects.toThrow(
      "Foto personil tidak boleh kosong",
    );
  });

  test("savePersonnelPhoto menolak ID kosong", async () => {
    expect(savePersonnelPhoto("", sampleBase64, "image/jpeg")).rejects.toThrow(
      "ID personil wajib diisi",
    );
  });

  test("savePersonnelPhoto menolak ukuran foto lebih dari 500 KB", async () => {
    const hugeBase64 = "A".repeat(512_001);
    expect(
      savePersonnelPhoto(sampleId, hugeBase64, "image/jpeg"),
    ).rejects.toThrow("Ukuran foto melebihi batas maksimal 500 KB");
  });

  test("savePersonnelPhoto menyimpan foto dengan sukses dan getPersonnelPhoto membacanya", async () => {
    const res = await savePersonnelPhoto(sampleId, sampleBase64, "image/png");
    expect(res.sukses).toBe(true);
    expect(res.id_unik).toBe(sampleId);

    const fetched = await getPersonnelPhoto(sampleId);
    expect(fetched).not.toBeNull();
    expect(fetched?.id_unik).toBe(sampleId);
    expect(fetched?.foto_mime).toBe("image/png");
    expect(fetched?.foto_base64).toBe(sampleBase64);
  });

  test("savePersonnelPhoto memperbarui foto yang sudah ada (upsert)", async () => {
    const newBase64 = "NEW_BASE64_DATA_HERE";
    await savePersonnelPhoto(sampleId, newBase64, "image/jpeg");

    const fetched = await getPersonnelPhoto(sampleId);
    expect(fetched?.foto_mime).toBe("image/jpeg");
    expect(fetched?.foto_base64).toBe(newBase64);
  });

  test("deletePersonnelPhoto menghapus foto personil", async () => {
    const res = await deletePersonnelPhoto(sampleId);
    expect(res.sukses).toBe(true);

    const fetched = await getPersonnelPhoto(sampleId);
    expect(fetched).toBeNull();
  });
});
