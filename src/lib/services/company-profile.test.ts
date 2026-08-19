import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

mock.module("server-only", () => ({}));

const testDirectory = mkdtempSync(join(tmpdir(), "sppg-company-test-"));
process.env.TURSO_DATABASE_URL = `file:${join(testDirectory, "test.db")}`;

const { db, ensureDbInitialized } = await import("@/lib/db");
const { getCompanyProfile, updateCompanyProfile } = await import(
  "./company-profile"
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

describe("Company Profile Service", () => {
  test("getCompanyProfile mengembalikan default profile jika belum ada data", async () => {
    const profile = await getCompanyProfile();
    expect(profile).toBeDefined();
    expect(profile.id).toBe("default_company");
    expect(profile.company_name).toBe("SPPG");
  });

  test("updateCompanyProfile memperbarui profil instansi dengan benar", async () => {
    const updated = await updateCompanyProfile({
      company_name: "SPPG Pusat Jakarta",
      branch_name: "Wilayah 1",
      phone: "021-999888",
      email: "kontak@sppg-pusat.id",
      leader_name: "Budi Santoso, M.Kom",
      leader_title: "Kepala Pusat",
      timezone: "Asia/Jakarta",
    });

    expect(updated.company_name).toBe("SPPG Pusat Jakarta");
    expect(updated.branch_name).toBe("Wilayah 1");
    expect(updated.phone).toBe("021-999888");
    expect(updated.leader_name).toBe("Budi Santoso, M.Kom");

    const fetched = await getCompanyProfile();
    expect(fetched.company_name).toBe("SPPG Pusat Jakarta");
  });
});
