import type { NextRequest } from "next/server";
import { z } from "zod";
import {
  clearLoginFailures,
  consumeLoginAttempt,
} from "@/lib/auth/login-rate-limit";
import { bootstrapSuperadmin } from "@/lib/operators/operator-admin";
import {
  matchesSetupToken,
  resolveSetupToken,
} from "@/lib/server/auth/setup-token";
import {
  DATABASE_NOT_CONFIGURED_MESSAGE,
  databaseConfigIssue,
} from "@/lib/server/database-config";
import {
  ensureServerDatabaseInitialized,
  getServerDatabase,
} from "@/lib/server/db";
import {
  noStoreJson,
  readJsonBody,
  toApiErrorResponse,
} from "@/lib/server/http/api-response";
import {
  assertSameOriginMutation,
  getClientAddress,
} from "@/lib/server/http/request-security";
import {
  checkInstallableLicense,
  isLicenseEnforced,
  resolveWebLicense,
  storeLicense,
} from "@/lib/server/license";

export const runtime = "nodejs";

/** Kunci pembatas percobaan; bukan username, jadi tidak bertabrakan dengan login. */
const RATE_IDENTIFIER = "setup-token";

const bodySchema = z
  .object({
    setupToken: z.string().min(1).max(512),
    namaOperator: z.string().max(200),
    username: z.string().max(100),
    email: z.string().max(200),
    noHp: z.string().max(40),
    password: z.string().max(512),
    /** Teks `LIS1.…`; wajib pada build terkunci yang belum berlisensi. */
    license: z.string().max(65_536).optional(),
  })
  .strict();

/**
 * Buat Superadmin pertama dari browser, dijaga token pemasangan.
 *
 * Endpoint ini dipanggil TANPA sesi login, jadi empat batas berikut wajib
 * dipertahankan:
 *
 * 1. TERTUTUP SECARA BAWAAN. Tanpa `KOS_SETUP_TOKEN` (atau dengan token yang
 *    terlalu pendek) jawabannya 404 sebelum database disentuh. Deployment yang
 *    tidak pernah mengisi variabel itu tidak punya pintu ini sama sekali.
 *
 * 2. PERCOBAAN TOKEN DIBATASI sebelum token dibandingkan, lewat tabel yang sama
 *    dengan pembatas login. Tanpa itu endpoint ini adalah alat menebak token.
 *
 * 3. TOKEN YANG SALAH DAN ISIAN YANG SALAH DIJAWAB BERBEDA hanya setelah token
 *    terbukti benar. Pesan validasi tidak pernah sampai ke orang tanpa token.
 *
 * 4. SATU KALI. `bootstrapSuperadmin` mengklaim `app_bootstrap_state` dalam
 *    batch yang sama dengan baris akunnya; setelah itu endpoint ini menolak
 *    selamanya, walau tokennya masih terpasang di `.env`.
 */
export async function POST(request: NextRequest) {
  try {
    assertSameOriginMutation(request);

    const setup = resolveSetupToken(process.env);
    if (setup.state !== "ready") {
      if (setup.state === "weak") {
        console.error(
          "[setup] KOS_SETUP_TOKEN lebih pendek dari 32 karakter, provisioning lewat browser tetap dimatikan.",
        );
      }
      return noStoreJson(
        {
          sukses: false,
          pesan: "Provisioning lewat browser dimatikan di server ini.",
        },
        404,
      );
    }

    const parsed = bodySchema.safeParse(await readJsonBody(request, 80_000));
    if (!parsed.success) {
      return noStoreJson(
        { sukses: false, pesan: "Isian provisioning tidak valid." },
        400,
      );
    }

    // Tanpa database tidak ada tabel pembatas percobaan untuk dipakai. Token
    // tetap dibandingkan lebih dulu, supaya jawaban "belum terhubung" hanya
    // sampai ke pemegang token, sama seperti pesan validasi di bawah.
    if (databaseConfigIssue(process.env) !== null) {
      if (!matchesSetupToken(setup.token, parsed.data.setupToken)) {
        return noStoreJson(
          { sukses: false, pesan: "Token pemasangan tidak cocok." },
          403,
        );
      }
      return noStoreJson(
        { sukses: false, pesan: DATABASE_NOT_CONFIGURED_MESSAGE },
        503,
      );
    }

    await ensureServerDatabaseInitialized();
    const database = getServerDatabase();
    const clientAddress = getClientAddress(request);
    const rateLimit = await consumeLoginAttempt(
      database,
      clientAddress,
      RATE_IDENTIFIER,
    );
    if (!rateLimit.allowed) {
      const response = noStoreJson(
        {
          sukses: false,
          pesan: `Terlalu banyak percobaan. Tunggu ${rateLimit.retryAfterSeconds} detik, lalu coba lagi.`,
        },
        429,
      );
      response.headers.set("Retry-After", String(rateLimit.retryAfterSeconds));
      return response;
    }
    // 403, bukan 401: klien Web menganggap 401 sebagai sesi yang berakhir.
    if (!matchesSetupToken(setup.token, parsed.data.setupToken)) {
      return noStoreJson(
        { sukses: false, pesan: "Token pemasangan tidak cocok." },
        403,
      );
    }
    // Pemegang token yang sah boleh salah mengisi form berkali-kali tanpa
    // terkunci oleh pembatas yang ditujukan untuk penebak token.
    await clearLoginFailures(database, clientAddress, RATE_IDENTIFIER);

    // Build terkunci tidak membuat Superadmin sebelum lisensinya terbukti sah
    // untuk server ini, sama seperti bootstrap Desktop. Diperiksa SETELAH token,
    // supaya pesan lisensi tidak sampai ke orang tanpa token.
    let licenseToStore: string | null = null;
    if (isLicenseEnforced()) {
      const current = await resolveWebLicense(database, request);
      if (current.evaluation.state !== "active") {
        const text = parsed.data.license?.trim() ?? "";
        if (!text) {
          return noStoreJson(
            {
              sukses: false,
              pesan:
                "Teks lisensi wajib diisi. Server ini belum memiliki lisensi yang aktif.",
            },
            400,
          );
        }
        try {
          await checkInstallableLicense(database, request, text);
        } catch (error) {
          return noStoreJson(
            {
              sukses: false,
              pesan:
                error instanceof Error ? error.message : "Lisensi tidak sah.",
            },
            400,
          );
        }
        licenseToStore = text;
      }
    }

    const result = await bootstrapSuperadmin(database, {
      kodeOperator: "SPD001",
      name: parsed.data.namaOperator,
      username: parsed.data.username,
      email: parsed.data.email,
      noHp: parsed.data.noHp,
      password: parsed.data.password,
      status: "Aktif",
    });
    if (licenseToStore) await storeLicense(database, licenseToStore);
    return noStoreJson(
      { sukses: true, recoveryCodes: result.recoveryCodes },
      201,
    );
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
