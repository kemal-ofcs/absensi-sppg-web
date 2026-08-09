import { type NextRequest, NextResponse } from "next/server";
import {
  checkLoginRateLimit,
  clearLoginFailures,
  recordLoginFailure,
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
  acceptsJson,
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
  if (!acceptsJson(request)) {
    return errorResponse("Content-Type harus application/json.", 415);
  }
  if (Number(request.headers.get("content-length") ?? 0) > 4_096) {
    return errorResponse("Payload login terlalu besar.", 413);
  }

  let body: LoginBody;
  try {
    body = (await request.json()) as LoginBody;
  } catch {
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
  const rateLimit = await checkLoginRateLimit(
    database,
    clientAddress,
    username,
  );
  if (!rateLimit.allowed) {
    const response = errorResponse(
      "Terlalu banyak percobaan login. Coba kembali beberapa saat lagi.",
      429,
    );
    response.headers.set("Retry-After", String(rateLimit.retryAfterSeconds));
    return response;
  }

  const operator = await authenticateWebOperator(username, password);
  if (!operator) {
    await recordLoginFailure(database, clientAddress, username);
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
