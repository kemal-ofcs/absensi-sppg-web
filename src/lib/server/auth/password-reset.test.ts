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
import { verifyPassword } from "@/lib/auth/password";
import { hashSessionToken } from "@/lib/auth/session-token";
import { initDatabaseSchema } from "@/lib/db-schema";
import { insertOperator } from "@/lib/operators/operator-admin";
import {
  LIVENESS_FRAME_HEIGHT,
  LIVENESS_FRAME_WIDTH,
  type LivenessChallenge,
} from "@/lib/security/face-liveness";
import {
  encodeFrameBytes,
  type LivenessFramePayload,
} from "@/lib/security/liveness-codec";

// Modul ini ditandai `server-only`, penanda build Next.js yang tidak dapat
// di-resolve runner test. Pola yang sama dipakai `api-response.test.ts`.
mock.module("server-only", () => ({}));

const {
  completePasswordReset,
  confirmResetAccount,
  inspectResetToken,
  lookupResetAccount,
  PasswordResetError,
  swapResetChallenge,
  verifyResetLiveness,
} = await import("@/lib/server/auth/password-reset");

let client: Client;
let operatorId: number;

async function seedOperator() {
  const roles = await client.execute(
    "SELECT id FROM app_role WHERE role_key = 'operator' LIMIT 1;",
  );
  const result = await insertOperator(client, {
    kodeOperator: "OPS001",
    name: "Operator Satu",
    username: "operator01",
    email: "operator01@sppg.id",
    noHp: "081200000001",
    password: "PasswordLamaKuat1",
    roleId: Number(roles.rows[0]?.id),
    status: "Aktif",
  });
  return result.id;
}

/**
 * Elips warna kulit dengan dua mata gelap, sama seperti pada uji liveness.
 *
 * Cukup untuk membuktikan bahwa alur ini menerima rekaman yang benar dan
 * menolak rekaman yang urutan tantangannya tidak cocok — bukan untuk menguji
 * ketelitian algoritma liveness itu sendiri, yang punya berkas uji terpisah.
 */
function renderFrame(
  challenge: LivenessChallenge,
  offsetMs: number,
  options: {
    centerX?: number;
    radiusX?: number;
    eyeOpen?: boolean;
    seed: number;
  },
): LivenessFramePayload {
  const width = LIVENESS_FRAME_WIDTH;
  const height = LIVENESS_FRAME_HEIGHT;
  const centerX = options.centerX ?? 0.5;
  const radiusX = options.radiusX ?? 0.28;
  const radiusY = 0.42;
  const rgb = new Uint8Array(width * height * 3);
  let seed = options.seed;
  const noise = () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return (seed / 4294967296) * 6 - 3;
  };
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 3;
      const dx = (x - centerX * width) / (radiusX * width);
      const dy = (y - 0.5 * height) / (radiusY * height);
      const value = noise();
      if (dx * dx + dy * dy > 1) {
        rgb[offset] = 60 + value;
        rgb[offset + 1] = 70 + value;
        rgb[offset + 2] = 95 + value;
        continue;
      }
      const eyeRow = 0.5 * height - radiusY * height * 0.25;
      const eyeSpan = Math.max(1.2, radiusY * height * 0.16);
      const onEye =
        Math.abs(y - eyeRow) <= eyeSpan &&
        Math.abs(Math.abs(x - centerX * width) - radiusX * width * 0.42) <=
          eyeSpan * 1.4;
      if (onEye && options.eyeOpen !== false) {
        rgb[offset] = 46 + value;
        rgb[offset + 1] = 34 + value;
        rgb[offset + 2] = 30 + value;
        continue;
      }
      rgb[offset] = 205 + value;
      rgb[offset + 1] = 148 + value;
      rgb[offset + 2] = 122 + value;
    }
  }
  return {
    challenge,
    offsetMs,
    width,
    height,
    rgb: encodeFrameBytes(rgb),
  };
}

function framesFor(challenge: LivenessChallenge, base: number) {
  switch (challenge) {
    case "KEDIP":
      return [
        renderFrame(challenge, 0, { seed: base + 1 }),
        renderFrame(challenge, 120, { seed: base + 2 }),
        renderFrame(challenge, 240, { seed: base + 3, eyeOpen: false }),
        renderFrame(challenge, 360, { seed: base + 4, eyeOpen: false }),
        renderFrame(challenge, 480, { seed: base + 5 }),
        renderFrame(challenge, 600, { seed: base + 6 }),
      ];
    case "TENGOK_KIRI":
      return [0.5, 0.46, 0.4, 0.36, 0.38, 0.44].map((centerX, index) =>
        renderFrame(challenge, index * 120, { seed: base + index, centerX }),
      );
    case "TENGOK_KANAN":
      return [0.5, 0.55, 0.6, 0.64, 0.62, 0.56].map((centerX, index) =>
        renderFrame(challenge, index * 120, { seed: base + index, centerX }),
      );
    case "DEKATKAN_WAJAH":
      return [0.28, 0.31, 0.35, 0.38, 0.39, 0.38].map((radiusX, index) =>
        renderFrame(challenge, index * 120, { seed: base + index, radiusX }),
      );
    default:
      return [0.38, 0.36, 0.33, 0.3, 0.29, 0.3].map((radiusX, index) =>
        renderFrame(challenge, index * 120, { seed: base + index, radiusX }),
      );
  }
}

function framesForSession(challenges: readonly LivenessChallenge[]) {
  return challenges.flatMap((challenge, index) =>
    framesFor(challenge, (index + 1) * 1_000),
  );
}

async function activateMail() {
  await client.execute(`
    UPDATE app_mail_config
    SET api_key = 'test-key', sender_email = 'no-reply@sppg.id',
        sender_name = 'Absensi SPPG', is_active = 1
    WHERE id = 'default';
  `);
}

let baselinePasswordHash = "";

// Satu database untuk seluruh berkas, bukan satu per test.
// `initDatabaseSchema` menjalankan puluhan DDL plus seed, dan `insertOperator`
// menghitung PBKDF2 600 ribu iterasi; mengulangnya dua puluh kali membuat
// berkas ini berjalan belasan detik dan sempat membuat runner Bun crash saat
// keluar. Yang perlu diisolasi antar-test hanyalah baris yang alur ini tulis,
// jadi baris itulah yang direset.
beforeAll(async () => {
  client = createClient({ url: "file::memory:" });
  await initDatabaseSchema(client);
  operatorId = await seedOperator();
  const seeded = await client.execute({
    sql: "SELECT password_hash FROM master_operator WHERE id = ?;",
    args: [operatorId],
  });
  baselinePasswordHash = String(seeded.rows[0]?.password_hash);
});

beforeEach(async () => {
  await client.execute("DELETE FROM password_reset_request;");
  await client.execute("DELETE FROM app_session;");
  await client.execute({
    sql: `
      UPDATE master_operator
      SET status = 'Aktif', email = 'operator01@sppg.id',
          no_hp = '+6281200000001', password_hash = ?
      WHERE id = ?;
    `,
    args: [baselinePasswordHash, operatorId],
  });
  await client.execute(`
    UPDATE app_mail_config
    SET api_key = NULL, sender_email = NULL, sender_name = NULL,
        reset_base_url = NULL, is_active = 0
    WHERE id = 'default';
  `);
});

afterAll(() => client.close());

describe("lookupResetAccount", () => {
  test("menemukan akun lewat username dan menyamarkan kontaknya", async () => {
    const account = await lookupResetAccount(client, "operator01");
    expect(account.name).toBe("Operator Satu");
    expect(account.kodeOperator).toBe("OPS001");
    // Email lengkap tidak boleh bocor ke layar yang terbuka tanpa login.
    expect(account.maskedEmail).not.toContain("operator01@sppg.id");
    expect(account.maskedEmail).toContain("@");
    expect(account.maskedPhone).toContain("*");
  });

  test("menemukan akun lewat email tanpa peduli huruf besar-kecil", async () => {
    const account = await lookupResetAccount(client, "OPERATOR01@SPPG.ID");
    expect(account.username).toBe("operator01");
  });

  test("menolak akun yang tidak ada", async () => {
    await expect(lookupResetAccount(client, "tidak-ada")).rejects.toThrow(
      "tidak ditemukan",
    );
  });

  test("menolak akun nonaktif", async () => {
    await client.execute({
      sql: "UPDATE master_operator SET status = 'Nonaktif' WHERE id = ?;",
      args: [operatorId],
    });
    await expect(lookupResetAccount(client, "operator01")).rejects.toThrow(
      "tidak ditemukan",
    );
  });

  test("menolak akun tanpa email dengan pesan yang jelas", async () => {
    await client.execute({
      sql: "UPDATE master_operator SET email = NULL WHERE id = ?;",
      args: [operatorId],
    });
    await expect(lookupResetAccount(client, "operator01")).rejects.toThrow(
      "belum memiliki email",
    );
  });
});

describe("confirmResetAccount", () => {
  test("menerbitkan tantangan ketika konfirmasi cocok", async () => {
    const issued = await confirmResetAccount(
      client,
      "operator01",
      "operator01@sppg.id",
    );
    expect(issued.requestId).toHaveLength(32);
    expect(issued.challengeToken.length).toBeGreaterThan(20);
    expect(issued.challenges).toHaveLength(3);
    expect(new Set(issued.challenges).size).toBe(3);

    const stored = await client.execute(
      "SELECT challenge_hash, status FROM password_reset_request;",
    );
    // Yang tersimpan hanya hash-nya; token asli tidak pernah menetap di DB.
    expect(String(stored.rows[0]?.challenge_hash)).toBe(
      await hashSessionToken(issued.challengeToken),
    );
    expect(stored.rows[0]?.status).toBe("Menunggu Verifikasi");
  });

  test("menolak konfirmasi yang menunjuk akun lain", async () => {
    await expect(
      confirmResetAccount(client, "operator01", "OPS999"),
    ).rejects.toThrow("tidak cocok");
  });

  test("permintaan baru membatalkan permintaan lama akun yang sama", async () => {
    await confirmResetAccount(client, "operator01", "operator01");
    await confirmResetAccount(client, "operator01", "operator01");
    const rows = await client.execute(
      "SELECT status FROM password_reset_request ORDER BY requested_at;",
    );
    expect(rows.rows.map((row) => String(row.status))).toEqual([
      "Dibatalkan",
      "Menunggu Verifikasi",
    ]);
  });
});

describe("swapResetChallenge", () => {
  test("mengganti satu langkah dengan tantangan yang belum dipakai", async () => {
    const issued = await confirmResetAccount(
      client,
      "operator01",
      "operator01",
    );
    const semula = issued.challenges;
    const next = await swapResetChallenge(
      client,
      issued.requestId,
      issued.challengeToken,
      0,
    );
    expect(next).toHaveLength(3);
    // Langkah lain tidak ikut berubah: yang sudah dikerjakan tidak boleh
    // dipaksa diulang hanya karena satu langkah diganti.
    expect(next.slice(1)).toEqual(semula.slice(1));
    expect(next[0]).not.toBe(semula[0]);
    // Tidak boleh menghasilkan tantangan kembar dalam satu rangkaian.
    expect(new Set(next).size).toBe(3);
  });

  test("urutan baru benar-benar tersimpan dan dipakai saat verifikasi", async () => {
    const issued = await confirmResetAccount(
      client,
      "operator01",
      "operator01",
    );
    const next = await swapResetChallenge(
      client,
      issued.requestId,
      issued.challengeToken,
      1,
    );
    const row = await client.execute(
      "SELECT challenge_sequence FROM password_reset_request;",
    );
    expect(JSON.parse(String(row.rows[0]?.challenge_sequence))).toEqual(next);
  });

  test("dibatasi dua kali penggantian per permintaan", async () => {
    const issued = await confirmResetAccount(
      client,
      "operator01",
      "operator01",
    );
    await swapResetChallenge(
      client,
      issued.requestId,
      issued.challengeToken,
      0,
    );
    await swapResetChallenge(
      client,
      issued.requestId,
      issued.challengeToken,
      1,
    );
    await expect(
      swapResetChallenge(client, issued.requestId, issued.challengeToken, 2),
    ).rejects.toThrow("mencapai batas");
  });

  test("menolak indeks langkah di luar rangkaian", async () => {
    const issued = await confirmResetAccount(
      client,
      "operator01",
      "operator01",
    );
    await expect(
      swapResetChallenge(client, issued.requestId, issued.challengeToken, 9),
    ).rejects.toThrow("Langkah tantangan tidak dikenal");
  });

  test("menolak token tantangan yang salah", async () => {
    const issued = await confirmResetAccount(
      client,
      "operator01",
      "operator01",
    );
    await expect(
      swapResetChallenge(
        client,
        issued.requestId,
        "token-palsu-panjang-sekali",
        0,
      ),
    ).rejects.toThrow("tidak ditemukan");
  });
});

describe("verifyResetLiveness", () => {
  test("menolak rekaman yang urutan tantangannya tidak cocok", async () => {
    const issued = await confirmResetAccount(
      client,
      "operator01",
      "operator01",
    );
    // Urutan sengaja dibalik: server memakai urutan yang IA terbitkan, bukan
    // yang diklaim klien.
    const reversed = [...issued.challenges].reverse();
    await expect(
      verifyResetLiveness(client, {
        requestId: issued.requestId,
        challengeToken: issued.challengeToken,
        frames: framesForSession(reversed),
        photoBase64: "Zm90bw==",
        photoMime: "image/jpeg",
      }),
    ).rejects.toThrow(PasswordResetError);
  });

  test("menolak token tantangan yang salah", async () => {
    const issued = await confirmResetAccount(
      client,
      "operator01",
      "operator01",
    );
    await expect(
      verifyResetLiveness(client, {
        requestId: issued.requestId,
        challengeToken: "token-palsu-yang-panjang-sekali",
        frames: framesForSession(issued.challenges),
        photoBase64: "Zm90bw==",
        photoMime: "image/jpeg",
      }),
    ).rejects.toThrow("tidak ditemukan");
  });

  test("menolak permintaan yang sudah kedaluwarsa", async () => {
    const issued = await confirmResetAccount(
      client,
      "operator01",
      "operator01",
    );
    await client.execute(
      "UPDATE password_reset_request SET expires_at = datetime('now', '-1 minutes');",
    );
    await expect(
      verifyResetLiveness(client, {
        requestId: issued.requestId,
        challengeToken: issued.challengeToken,
        frames: framesForSession(issued.challenges),
        photoBase64: "Zm90bw==",
        photoMime: "image/jpeg",
      }),
    ).rejects.toThrow("Waktu verifikasi habis");
  });

  test("liveness lolos tetapi email belum dikonfigurasi: permintaan dibatalkan", async () => {
    const issued = await confirmResetAccount(
      client,
      "operator01",
      "operator01",
    );
    await expect(
      verifyResetLiveness(client, {
        requestId: issued.requestId,
        challengeToken: issued.challengeToken,
        frames: framesForSession(issued.challenges),
        photoBase64: "Zm90bw==",
        photoMime: "image/jpeg",
      }),
    ).rejects.toThrow("Pengiriman email belum dikonfigurasi");

    const row = await client.execute(
      "SELECT status, delivery_status, photo_base64, liveness_score FROM password_reset_request;",
    );
    // Token yang tidak pernah sampai ke pemiliknya tidak boleh tetap hidup,
    // tetapi foto buktinya tetap disimpan untuk audit.
    expect(row.rows[0]?.status).toBe("Dibatalkan");
    expect(row.rows[0]?.delivery_status).toBe("Gagal");
    expect(row.rows[0]?.photo_base64).toBe("Zm90bw==");
    expect(Number(row.rows[0]?.liveness_score)).toBeGreaterThan(0.6);
  });

  test("menolak foto yang kosong", async () => {
    const issued = await confirmResetAccount(
      client,
      "operator01",
      "operator01",
    );
    await expect(
      verifyResetLiveness(client, {
        requestId: issued.requestId,
        challengeToken: issued.challengeToken,
        frames: framesForSession(issued.challenges),
        photoBase64: "   ",
        photoMime: "image/jpeg",
      }),
    ).rejects.toThrow("Foto verifikasi tidak valid");
  });
});

describe("inspectResetToken & completePasswordReset", () => {
  /** Menaruh token terverifikasi langsung ke DB, meniru email yang terkirim. */
  async function issueToken(token: string, expiresMinutes = 30) {
    await activateMail();
    // SQLite menolak modifier "+-1 minutes" dan menghasilkan NULL; tandanya
    // harus tunggal.
    const modifier =
      expiresMinutes < 0
        ? `-${Math.abs(expiresMinutes)} minutes`
        : `+${expiresMinutes} minutes`;
    await client.execute({
      sql: `
        INSERT INTO password_reset_request (
          id, operator_id, identifier_used, contact_channel, contact_target,
          challenge_hash, challenge_sequence, token_hash, status,
          requested_at, verified_at, sent_at, expires_at, delivery_status
        ) VALUES (
          'req-uji', ?, 'operator01', 'email', 'operator01@sppg.id',
          'hash-tantangan', '["KEDIP"]', ?, 'Terkirim',
          datetime('now'), datetime('now'), datetime('now'),
          datetime('now', '${modifier}'), 'Terkirim'
        );
      `,
      args: [operatorId, await hashSessionToken(token)],
    });
  }

  test("menampilkan pemilik token yang masih berlaku", async () => {
    await issueToken("token-reset-yang-panjang-sekali");
    const info = await inspectResetToken(
      client,
      "token-reset-yang-panjang-sekali",
    );
    expect(info.operatorName).toBe("Operator Satu");
    expect(info.username).toBe("operator01");
  });

  test("menolak token yang tidak dikenal", async () => {
    await expect(
      inspectResetToken(client, "token-yang-tidak-pernah-ada"),
    ).rejects.toThrow("tidak dikenal");
  });

  test("menolak token yang kedaluwarsa", async () => {
    await issueToken("token-reset-yang-panjang-sekali", -1);
    await expect(
      inspectResetToken(client, "token-reset-yang-panjang-sekali"),
    ).rejects.toThrow("kedaluwarsa");
  });

  test("password lama benar-benar digantikan yang baru", async () => {
    await issueToken("token-reset-yang-panjang-sekali");
    const before = await client.execute({
      sql: "SELECT password_hash FROM master_operator WHERE id = ?;",
      args: [operatorId],
    });
    const oldHash = String(before.rows[0]?.password_hash);

    await completePasswordReset(
      client,
      "token-reset-yang-panjang-sekali",
      "PasswordBaruKuat1",
    );

    const after = await client.execute({
      sql: "SELECT password_hash FROM master_operator WHERE id = ?;",
      args: [operatorId],
    });
    const newHash = String(after.rows[0]?.password_hash);
    expect(newHash).not.toBe(oldHash);
    expect((await verifyPassword("PasswordBaruKuat1", newHash)).valid).toBe(
      true,
    );
    expect((await verifyPassword("PasswordLamaKuat1", newHash)).valid).toBe(
      false,
    );
  });

  test("token hanya dapat dipakai satu kali", async () => {
    await issueToken("token-reset-yang-panjang-sekali");
    await completePasswordReset(
      client,
      "token-reset-yang-panjang-sekali",
      "PasswordBaruKuat1",
    );
    await expect(
      completePasswordReset(
        client,
        "token-reset-yang-panjang-sekali",
        "PasswordLainKuat2",
      ),
    ).rejects.toThrow("sudah pernah dipakai");
  });

  test("password lemah ditolak dan token tetap utuh", async () => {
    await issueToken("token-reset-yang-panjang-sekali");
    await expect(
      completePasswordReset(
        client,
        "token-reset-yang-panjang-sekali",
        "pendek",
      ),
    ).rejects.toThrow("minimal 12 karakter");
    const row = await client.execute(
      "SELECT status FROM password_reset_request WHERE id = 'req-uji';",
    );
    expect(row.rows[0]?.status).toBe("Terkirim");
  });

  test("seluruh sesi aktif operator ikut dicabut", async () => {
    await issueToken("token-reset-yang-panjang-sekali");
    await client.execute({
      sql: `
        INSERT INTO app_session (
          session_id, token_hash, operator_id, permission_revision,
          created_at, expires_at, last_seen_at
        ) VALUES ('sesi-uji', 'hash-sesi', ?, 1,
          datetime('now'), datetime('now', '+1 day'), datetime('now'));
      `,
      args: [operatorId],
    });

    await completePasswordReset(
      client,
      "token-reset-yang-panjang-sekali",
      "PasswordBaruKuat1",
    );

    const session = await client.execute(
      "SELECT revoked_at, revoked_reason FROM app_session WHERE session_id = 'sesi-uji';",
    );
    expect(session.rows[0]?.revoked_at).not.toBeNull();
    expect(session.rows[0]?.revoked_reason).toBe("password-reset");
  });
});
