import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { type Client, createClient } from "@libsql/client";
import { initDatabaseSchema } from "@/lib/db-schema";
import { insertOperator } from "@/lib/operators/operator-admin";
import {
  DEFAULT_ROLE_PERMISSIONS,
  isPermissionKey,
  SENSITIVE_MUTATION_PERMISSIONS,
  SUPERADMIN_ONLY_PERMISSIONS,
} from "@/lib/rbac/catalog";

// Modul ini ditandai `server-only`, penanda build Next.js yang tidak dapat
// di-resolve runner test. Pola yang sama dipakai `api-response.test.ts`.
mock.module("server-only", () => ({}));

const {
  deletePasswordResetHistory,
  getPasswordResetPhoto,
  listPasswordResetHistory,
  purgePasswordResetHistory,
} = await import("@/lib/server/auth/password-reset-audit");

let client: Client;
let operatorId: number;
let otherOperatorId: number;

async function seedOperator(
  kode: string,
  username: string,
  nama: string,
  email: string,
) {
  const roles = await client.execute(
    "SELECT id FROM app_role WHERE role_key = 'operator' LIMIT 1;",
  );
  const result = await insertOperator(client, {
    kodeOperator: kode,
    name: nama,
    username,
    email,
    noHp: "081200000001",
    password: "PasswordLamaKuat1",
    roleId: Number(roles.rows[0]?.id),
    status: "Aktif",
  });
  return result.id;
}

/** Menaruh satu baris riwayat langsung ke DB, meniru pengajuan yang selesai. */
async function seedRequest(input: {
  id: string;
  operatorId: number;
  status: string;
  identifier?: string;
  photo?: string | null;
  score?: number | null;
  report?: string | null;
  ageDays?: number;
  deliveryStatus?: string | null;
  deliveryError?: string | null;
}) {
  const age = input.ageDays ?? 0;
  const modifier = age > 0 ? `-${age} days` : "+0 days";
  await client.execute({
    sql: `
      INSERT INTO password_reset_request (
        id, operator_id, identifier_used, contact_channel, contact_target,
        challenge_hash, challenge_sequence, status, liveness_score, liveness_report,
        photo_mime, photo_base64, delivery_status, delivery_error,
        requested_at, expires_at
      ) VALUES (
        ?, ?, ?, 'email', 'target@sppg.id',
        'hash', '["KEDIP"]', ?, ?, ?,
        'image/jpeg', ?, ?, ?,
        datetime('now', '${modifier}'), datetime('now', '+30 minutes')
      );
    `,
    args: [
      input.id,
      input.operatorId,
      input.identifier ?? "operator01",
      input.status,
      input.score ?? null,
      input.report ?? null,
      input.photo ?? null,
      input.deliveryStatus ?? null,
      input.deliveryError ?? null,
    ],
  });
}

beforeAll(async () => {
  client = createClient({ url: "file::memory:" });
  await initDatabaseSchema(client);
  operatorId = await seedOperator(
    "OPS001",
    "operator01",
    "Operator Satu",
    "operator01@sppg.id",
  );
  otherOperatorId = await seedOperator(
    "OPS002",
    "operator02",
    "Budi Dua",
    "operator02@sppg.id",
  );
});

beforeEach(async () => {
  await client.execute("DELETE FROM password_reset_request;");
});

afterAll(() => client.close());

describe("katalog RBAC riwayat reset", () => {
  test("mendaftarkan izin lihat dan hapus sebagai izin yang bisa diatur", () => {
    expect(isPermissionKey("password_reset.view")).toBe(true);
    expect(isPermissionKey("password_reset.delete")).toBe(true);
    // Bukan izin khusus Superadmin: justru harus bisa diberikan ke role lain
    // lewat halaman Role & Akses.
    expect(SUPERADMIN_ONLY_PERMISSIONS.has("password_reset.view")).toBe(false);
    expect(SUPERADMIN_ONLY_PERMISSIONS.has("password_reset.delete")).toBe(
      false,
    );
  });

  test("Admin bawaan boleh melihat, tetapi menghapus harus diberikan sadar", () => {
    expect(DEFAULT_ROLE_PERMISSIONS.admin).toContain("password_reset.view");
    expect(DEFAULT_ROLE_PERMISSIONS.admin).not.toContain(
      "password_reset.delete",
    );
    expect(SENSITIVE_MUTATION_PERMISSIONS.has("password_reset.delete")).toBe(
      true,
    );
  });

  test("Operator dan Scanner bawaan tidak melihat riwayat siapa pun", () => {
    expect(DEFAULT_ROLE_PERMISSIONS.operator).not.toContain(
      "password_reset.view",
    );
    expect(DEFAULT_ROLE_PERMISSIONS.scanner).not.toContain(
      "password_reset.view",
    );
  });
});

describe("listPasswordResetHistory", () => {
  test("mengembalikan riwayat terbaru lebih dulu dengan email tersamar", async () => {
    await seedRequest({
      id: "r-lama",
      operatorId,
      status: "Terpakai",
      ageDays: 3,
    });
    await seedRequest({ id: "r-baru", operatorId, status: "Terkirim" });

    const entries = await listPasswordResetHistory(client);
    expect(entries.map((item) => item.id)).toEqual(["r-baru", "r-lama"]);
    expect(entries[0]?.operatorName).toBe("Operator Satu");
    expect(entries[0]?.maskedEmail).not.toContain("target@sppg.id");
    expect(entries[0]?.maskedEmail).toContain("@");
  });

  test("tidak pernah membawa foto pada daftar, hanya penandanya", async () => {
    await seedRequest({
      id: "r-foto",
      operatorId,
      status: "Terpakai",
      photo: "Zm90bw==",
    });
    await seedRequest({ id: "r-kosong", operatorId, status: "Dibatalkan" });

    const entries = await listPasswordResetHistory(client);
    const withPhoto = entries.find((item) => item.id === "r-foto");
    const without = entries.find((item) => item.id === "r-kosong");
    expect(withPhoto?.hasPhoto).toBe(true);
    expect(without?.hasPhoto).toBe(false);
    // Daftar harus tetap ringan: satu foto ~40 KB dan ratusan baris akan
    // membuat balasannya puluhan megabyte.
    expect(JSON.stringify(entries)).not.toContain("Zm90bw==");
  });

  test("menyaring berdasarkan status", async () => {
    await seedRequest({ id: "r-1", operatorId, status: "Terpakai" });
    await seedRequest({ id: "r-2", operatorId, status: "Dibatalkan" });

    const entries = await listPasswordResetHistory(client, {
      status: "Dibatalkan",
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.id).toBe("r-2");
  });

  test("mencari berdasarkan nama, username, atau identitas yang diketik", async () => {
    await seedRequest({ id: "r-satu", operatorId, status: "Terpakai" });
    await seedRequest({
      id: "r-dua",
      operatorId: otherOperatorId,
      status: "Terpakai",
      identifier: "budi@sppg.id",
    });

    expect(
      (await listPasswordResetHistory(client, { search: "Budi" })).map(
        (item) => item.id,
      ),
    ).toEqual(["r-dua"]);
    expect(
      (await listPasswordResetHistory(client, { search: "operator01" })).map(
        (item) => item.id,
      ),
    ).toEqual(["r-satu"]);
  });

  test("laporan liveness yang rusak tidak menjatuhkan seluruh daftar", async () => {
    await seedRequest({
      id: "r-rusak",
      operatorId,
      status: "Dibatalkan",
      report: "{bukan json",
    });
    await seedRequest({
      id: "r-baik",
      operatorId,
      status: "Dibatalkan",
      score: 0.42,
      report: JSON.stringify({
        reason: "Kedipan tidak terdeteksi.",
        challenges: [{ challenge: "KEDIP" }, { challenge: "TENGOK_KIRI" }],
      }),
    });

    const entries = await listPasswordResetHistory(client);
    const rusak = entries.find((item) => item.id === "r-rusak");
    const baik = entries.find((item) => item.id === "r-baik");
    expect(rusak?.livenessReason).toBe("");
    expect(baik?.livenessReason).toBe("Kedipan tidak terdeteksi.");
    expect(baik?.livenessChallenges).toEqual(["KEDIP", "TENGOK_KIRI"]);
    expect(baik?.livenessScore).toBeCloseTo(0.42, 5);
  });

  test("menghormati batas jumlah baris", async () => {
    for (let index = 0; index < 5; index += 1) {
      await seedRequest({
        id: `r-${index}`,
        operatorId,
        status: "Terpakai",
        ageDays: index,
      });
    }
    expect(await listPasswordResetHistory(client, { limit: 2 })).toHaveLength(
      2,
    );
  });
});

describe("getPasswordResetPhoto", () => {
  test("mengembalikan foto beserta mime-nya", async () => {
    await seedRequest({
      id: "r-foto",
      operatorId,
      status: "Terpakai",
      photo: "Zm90bw==",
    });
    const photo = await getPasswordResetPhoto(client, "r-foto");
    expect(photo).toEqual({ mime: "image/jpeg", base64: "Zm90bw==" });
  });

  test("menolak permintaan tanpa foto dan id yang tidak dikenal", async () => {
    await seedRequest({ id: "r-kosong", operatorId, status: "Dibatalkan" });
    await expect(getPasswordResetPhoto(client, "r-kosong")).rejects.toThrow(
      "tidak menyimpan foto",
    );
    await expect(getPasswordResetPhoto(client, "entah")).rejects.toThrow(
      "tidak ditemukan",
    );
    await expect(getPasswordResetPhoto(client, "  ")).rejects.toThrow(
      "tidak valid",
    );
  });
});

describe("deletePasswordResetHistory", () => {
  test("menghapus satu baris beserta fotonya", async () => {
    await seedRequest({
      id: "r-hapus",
      operatorId,
      status: "Terpakai",
      photo: "Zm90bw==",
    });
    await deletePasswordResetHistory(client, "r-hapus");
    expect(await listPasswordResetHistory(client)).toHaveLength(0);
  });

  test("menolak id yang sudah tidak ada", async () => {
    await expect(
      deletePasswordResetHistory(client, "tidak-ada"),
    ).rejects.toThrow("tidak ditemukan");
  });
});

describe("purgePasswordResetHistory", () => {
  test("hanya membuang riwayat selesai yang sudah lewat batas umur", async () => {
    await seedRequest({
      id: "r-selesai-lama",
      operatorId,
      status: "Terpakai",
      ageDays: 120,
    });
    await seedRequest({
      id: "r-selesai-baru",
      operatorId,
      status: "Kedaluwarsa",
      ageDays: 10,
    });
    // Masih hidup: membersihkan arsip tidak boleh memutus pemulihan berjalan.
    await seedRequest({
      id: "r-hidup",
      operatorId,
      status: "Terkirim",
      ageDays: 200,
    });

    const result = await purgePasswordResetHistory(client, 90);
    expect(result.deleted).toBe(1);
    const sisa = (await listPasswordResetHistory(client)).map(
      (item) => item.id,
    );
    expect(sisa.sort()).toEqual(["r-hidup", "r-selesai-baru"]);
  });

  test("menolak rentang hari yang tidak masuk akal", async () => {
    await expect(purgePasswordResetHistory(client, 0)).rejects.toThrow(
      "tidak valid",
    );
    await expect(purgePasswordResetHistory(client, 99_999)).rejects.toThrow(
      "tidak valid",
    );
  });
});
