import { type NextRequest, NextResponse } from "next/server";
import {
  clearLoginFailures,
  consumeLoginAttempt,
} from "@/lib/auth/login-rate-limit";
import {
  getWebSessionCookieOptions,
  WEB_SESSION_COOKIE,
} from "@/lib/auth/web-session";
import { authenticateWebOperator } from "@/lib/server/auth/authenticate";
import { createWebSession } from "@/lib/server/auth/session";
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

interface LoginBody {
  username?: unknown;
  password?: unknown;
}

function errorResponse(message: string, status: number) {
  return NextResponse.json(
    { sukses: false, pesan: message },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

export async function POST(request: NextRequest) {
  if (!isSameOriginMutation(request)) {
    return errorResponse("Origin permintaan tidak diizinkan.", 403);
  }
  let body: LoginBody;
  try {
    body = await readBoundedJsonBody<LoginBody>(request, 4_096);
  } catch (error) {
    if (error instanceof JsonBodyError) {
      const message =
        error.status === 413
          ? "Payload login terlalu besar."
          : error.status === 415
            ? "Content-Type harus application/json."
            : "Payload login tidak valid.";
      return errorResponse(message, error.status);
    }
    return errorResponse("Payload login tidak valid.", 400);
  }

  const username =
    typeof body.username === "string" ? body.username.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (username.length < 3 || username.length > 64 || password.length > 256) {
    return errorResponse("Username atau password tidak sesuai.", 401);
  }

  await ensureServerDatabaseInitialized();
  const database = getServerDatabase();
  const clientAddress = getClientAddress(request);
  const rateLimit = await consumeLoginAttempt(
    database,
    clientAddress,
    username,
  );
  if (!rateLimit.allowed) {
    const minutes = Math.floor(rateLimit.retryAfterSeconds / 60);
    const seconds = rateLimit.retryAfterSeconds % 60;
    const timeStr =
      minutes > 0
        ? `${minutes} menit${seconds > 0 ? ` ${seconds} detik` : ""}`
        : `${seconds} detik`;
    const response = errorResponse(
      `Terlalu banyak percobaan login. Akun dikunci sementara untuk keamanan. Silakan tunggu ${timeStr} lagi sebelum mencoba kembali.`,
      429,
    );
    response.headers.set("Retry-After", String(rateLimit.retryAfterSeconds));
    return response;
  }

  const operator = await authenticateWebOperator(username, password);
  if (!operator) {
    return errorResponse("Username atau password tidak sesuai.", 401);
  }
  await clearLoginFailures(database, clientAddress, username);

  const session = await createWebSession(
    operator,
    request.headers.get("user-agent"),
  );
  const response = NextResponse.json(
    { sukses: true, pesan: "Login berhasil.", operator },
    { headers: { "Cache-Control": "no-store" } },
  );
  response.cookies.set(
    WEB_SESSION_COOKIE,
    session.token,
    getWebSessionCookieOptions(process.env.NODE_ENV === "production"),
  );
  return response;
}
