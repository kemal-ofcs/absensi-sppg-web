import { type NextRequest, NextResponse } from "next/server";
import {
  clearLoginFailures,
  consumeLoginAttempt,
} from "@/lib/auth/login-rate-limit";
import { hashSessionToken } from "@/lib/auth/session-token";
import {
  completePasswordReset,
  confirmResetAccount,
  inspectResetToken,
  lookupResetAccount,
  PasswordResetError,
  recoverWithRecoveryCode,
  resolvePasswordResetRoute,
  swapResetChallenge,
  verifyResetLiveness,
} from "@/lib/server/auth/password-reset";
import {
  ensureServerDatabaseInitialized,
  getServerDatabase,
} from "@/lib/server/db";
import {
  JsonBodyError,
  readBoundedJsonBody,
} from "@/lib/server/http/json-body";
import {
  getClientAddress,
  isSameOriginMutation,
} from "@/lib/server/http/request-security";

export const runtime = "nodejs";

/**
 * Seluruh alur "Lupa Password" berbagi satu route handler.
 *
 * Endpoint ini terbuka tanpa sesi, jadi setiap langkah wajib melewati rate
 * limit yang sama dengan login. Menyebarnya ke lima berkas route hanya akan
 * memperbanyak tempat yang bisa lupa memasang penjaga itu.
 *
 * `POST` (bukan `GET`) untuk semua langkah, termasuk pembacaan token: build
 * Desktop/Mobile memakai `output: "export"` yang tidak bisa melayani route
 * handler `GET`.
 */
type ResetStep =
  | "lookup"
  | "confirm"
  | "verify"
  | "swap-challenge"
  | "inspect-token"
  | "complete"
  | "route"
  | "recover-with-code";

interface ResetBody {
  step?: unknown;
  identifier?: unknown;
  confirmation?: unknown;
  requestId?: unknown;
  challengeToken?: unknown;
  stepIndex?: unknown;
  frames?: unknown;
  photoBase64?: unknown;
  photoMime?: unknown;
  token?: unknown;
  password?: unknown;
  code?: unknown;
  newPassword?: unknown;
}

/** Payload verifikasi memuat frame piksel mentah, jadi batasnya lebih besar. */
const MAX_BODY_BYTES = 4_194_304;

function errorResponse(message: string, status: number) {
  return NextResponse.json(
    { sukses: false, pesan: message },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

function okResponse(payload: Record<string, unknown>) {
  return NextResponse.json(
    { sukses: true, ...payload },
    { headers: { "Cache-Control": "no-store" } },
  );
}

function text(value: unknown, max = 120) {
  return typeof value === "string" ? value.slice(0, max) : "";
}

export async function POST(request: NextRequest) {
  if (!isSameOriginMutation(request)) {
    return errorResponse("Origin permintaan tidak diizinkan.", 403);
  }

  let body: ResetBody;
  try {
    body = await readBoundedJsonBody<ResetBody>(request, MAX_BODY_BYTES);
  } catch (error) {
    if (error instanceof JsonBodyError) {
      return errorResponse(
        error.status === 413
          ? "Payload permintaan terlalu besar."
          : "Payload permintaan tidak valid.",
        error.status,
      );
    }
    return errorResponse("Payload permintaan tidak valid.", 400);
  }

  const step = text(body.step, 32) as ResetStep;
  await ensureServerDatabaseInitialized();
  const database = getServerDatabase();
  const clientAddress = getClientAddress(request);

  // Kunci rate limit dibedakan per langkah supaya percobaan tebak-token tidak
  // bersembunyi di balik kuota langkah pencarian akun.
  const rateIdentity = `reset:${step}:${text(
    body.identifier ?? body.requestId ?? body.token,
    64,
  )}`;
  const rateLimit = await consumeLoginAttempt(
    database,
    clientAddress,
    rateIdentity,
  );
  if (!rateLimit.allowed) {
    const response = errorResponse(
      `Terlalu banyak percobaan. Coba lagi dalam ${rateLimit.retryAfterSeconds} detik.`,
      429,
    );
    response.headers.set("Retry-After", String(rateLimit.retryAfterSeconds));
    return response;
  }

  try {
    switch (step) {
      case "lookup": {
        const account = await lookupResetAccount(
          database,
          text(body.identifier),
        );
        await clearLoginFailures(database, clientAddress, rateIdentity);
        return okResponse({ account });
      }
      case "confirm": {
        const issued = await confirmResetAccount(
          database,
          text(body.identifier),
          text(body.confirmation),
          {
            ipHash: await hashSessionToken(`reset-ip:${clientAddress}`),
            userAgentHash: await hashSessionToken(
              `reset-ua:${request.headers.get("user-agent") ?? ""}`,
            ),
          },
        );
        await clearLoginFailures(database, clientAddress, rateIdentity);
        return okResponse({ challenge: issued });
      }
      case "verify": {
        const result = await verifyResetLiveness(database, {
          requestId: text(body.requestId, 64),
          challengeToken: text(body.challengeToken, 256),
          frames: body.frames,
          photoBase64:
            typeof body.photoBase64 === "string" ? body.photoBase64 : "",
          photoMime: text(body.photoMime, 40) || "image/jpeg",
        });
        await clearLoginFailures(database, clientAddress, rateIdentity);
        return okResponse({ delivery: result });
      }
      case "swap-challenge": {
        const challenges = await swapResetChallenge(
          database,
          text(body.requestId, 64),
          text(body.challengeToken, 256),
          Number(body.stepIndex),
        );
        await clearLoginFailures(database, clientAddress, rateIdentity);
        return okResponse({ challenges });
      }
      case "inspect-token": {
        const info = await inspectResetToken(database, text(body.token, 256));
        await clearLoginFailures(database, clientAddress, rateIdentity);
        return okResponse({ token: info });
      }
      // Dibaca layar "Lupa Password" sebelum ia menjanjikan email apa pun.
      // Tidak menyentuh akun mana pun, jadi tidak ada yang bisa dipetakan
      // darinya — tetapi tetap melewati rate limit yang sama seperti langkah
      // lain di berkas ini.
      case "route": {
        const route = await resolvePasswordResetRoute(database);
        await clearLoginFailures(database, clientAddress, rateIdentity);
        return okResponse({ route });
      }
      // Jalur kode cetak: tanpa sesi, karena yang memakainya justru orang yang
      // sedang terkunci di luar. Yang menjaganya adalah kode sekali pakai itu
      // sendiri — disimpan sebagai hash, dihapus begitu dipakai — ditambah rate
      // limit di atas, supaya kode 8 karakter tidak bisa ditebak dengan
      // mencoba terus-menerus.
      case "recover-with-code": {
        const result = await recoverWithRecoveryCode(database, {
          identifier: text(body.identifier),
          code: text(body.code, 64),
          newPassword:
            typeof body.newPassword === "string" ? body.newPassword : "",
        });
        await clearLoginFailures(database, clientAddress, rateIdentity);
        return okResponse(result);
      }
      case "complete": {
        const result = await completePasswordReset(
          database,
          text(body.token, 256),
          typeof body.password === "string" ? body.password : "",
        );
        await clearLoginFailures(database, clientAddress, rateIdentity);
        return okResponse({
          username: result.username,
          pesan:
            "Password berhasil diganti. Silakan login dengan password baru.",
        });
      }
      default:
        return errorResponse("Langkah pemulihan password tidak dikenal.", 400);
    }
  } catch (error) {
    if (error instanceof PasswordResetError) {
      return errorResponse(error.message, error.status);
    }
    const message =
      error instanceof Error
        ? error.message
        : "Permintaan tidak dapat diproses.";
    return errorResponse(message, 400);
  }
}
