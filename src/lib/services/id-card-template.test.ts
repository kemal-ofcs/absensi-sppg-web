import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IdCardElement } from "@/types/id-card";

mock.module("server-only", () => ({}));

const testDirectory = mkdtempSync(join(tmpdir(), "sppg-idcard-test-"));
process.env.TURSO_DATABASE_URL = `file:${join(testDirectory, "test.db")}`;

const { db, ensureDbInitialized } = await import("@/lib/db");
const { getIdCardTemplate, saveIdCardTemplate } = await import(
  "./id-card-template"
);

beforeAll(async () => {
  await ensureDbInitialized();
});

afterAll(() => {
  try {
    db.close();
    rmSync(testDirectory, { recursive: true, force: true });
  } catch {}
});

describe("ID Card Template Service", () => {
  test("getIdCardTemplate mengembalikan default template dengan elemen awal", async () => {
    const template = await getIdCardTemplate("default_template");
    expect(template).toBeDefined();
    expect(template.id).toBe("default_template");
    expect(template.orientation).toBe("landscape");
    expect(template.elements.length).toBeGreaterThan(0);
  });

  test("saveIdCardTemplate menyimpan dan memperbarui konfigurasi elemen template", async () => {
    const customElements: IdCardElement[] = [
      {
        id: "el-custom-title",
        type: "static_text",
        side: "front",
        sourceKey: "static_text",
        staticValue: "KARTU SPPG KHUSUS",
        label: "Judul Khusus",
        x: 10,
        y: 10,
        fontSize: 16,
        color: "#ffffff",
      },
    ];

    const saved = await saveIdCardTemplate({
      id: "default_template",
      name: "Template Custom SPPG",
      orientation: "portrait",
      elements: customElements,
      isActive: true,
    });

    expect(saved.name).toBe("Template Custom SPPG");
    expect(saved.orientation).toBe("portrait");
    expect(saved.elements.length).toBe(1);
    expect(saved.elements[0].staticValue).toBe("KARTU SPPG KHUSUS");

    const fetched = await getIdCardTemplate("default_template");
    expect(fetched.orientation).toBe("portrait");
    expect(fetched.elements[0].label).toBe("Judul Khusus");
  });
});
