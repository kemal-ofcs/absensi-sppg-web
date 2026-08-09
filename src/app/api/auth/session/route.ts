import { type NextRequest, NextResponse } from "next/server";
import {
  getWebSessionCookieOptions,
  WEB_SESSION_COOKIE,
} from "@/lib/auth/web-session";
import { readWebSession, revokeWebSession } from "@/lib/server/auth/session";
import { isSameOriginMutation } from "@/lib/server/http/request-security";

export const runtime = "nodejs";

function noStoreJson(body: unknown, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

export async function POST(request: NextRequest) {
  if (!isSameOriginMutation(request)) {
    return noStoreJson(
      { sukses: false, pesan: "Origin tidak diizinkan." },
      403,
    );
  }

  const token = request.cookies.get(WEB_SESSION_COOKIE)?.value ?? "";
  const operator = await readWebSession(token);
  if (!operator) {
    return noStoreJson({ sukses: false, operator: null }, 401);
  }

  return noStoreJson({ sukses: true, operator });
}

export async function DELETE(request: NextRequest) {
  if (!isSameOriginMutation(request)) {
    return noStoreJson(
      { sukses: false, pesan: "Origin tidak diizinkan." },
      403,
    );
  }

  const token = request.cookies.get(WEB_SESSION_COOKIE)?.value ?? "";
  await revokeWebSession(token);
  const response = noStoreJson({ sukses: true });
  response.cookies.set(WEB_SESSION_COOKIE, "", {
    ...getWebSessionCookieOptions(process.env.NODE_ENV === "production"),
    maxAge: 0,
  });
  return response;
}
