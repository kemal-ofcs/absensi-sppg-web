import { NextResponse } from "next/server";
import { auth } from "@/lib/auth/web/auth";
import {
  DESKTOP_LOOPBACK_ENV_TOKEN,
  DESKTOP_LOOPBACK_QUERY_TOKEN,
  DESKTOP_LOOPBACK_RUNTIME_COOKIE,
  DESKTOP_LOOPBACK_SESSION_COOKIE,
  hasDesktopLoopbackSessionToken,
  isLoopbackHostname,
} from "@/lib/runtime/desktop-loopback-request";

export default auth((request) => {
  const { nextUrl, auth: session } = request;
  const loopback = isLoopbackHostname(request.headers.get("host"));
  const expectedToken = process.env[DESKTOP_LOOPBACK_ENV_TOKEN]?.trim() || "";
  const queryToken = loopback
    ? nextUrl.searchParams.get(DESKTOP_LOOPBACK_QUERY_TOKEN)
    : null;
  const hasDesktopSession =
    loopback &&
    hasDesktopLoopbackSessionToken({
      cookieValue: request.cookies.get(DESKTOP_LOOPBACK_SESSION_COOKIE)?.value,
      queryValue: queryToken,
      expectedToken,
    });

  if (loopback && queryToken && hasDesktopSession) {
    const sanitized = nextUrl.clone();
    sanitized.searchParams.delete(DESKTOP_LOOPBACK_QUERY_TOKEN);
    const response = NextResponse.redirect(sanitized);
    response.cookies.set(DESKTOP_LOOPBACK_SESSION_COOKIE, expectedToken, {
      httpOnly: true,
      sameSite: "strict",
      secure: false,
      path: "/",
    });
    response.cookies.set(DESKTOP_LOOPBACK_RUNTIME_COOKIE, "1", {
      httpOnly: false,
      sameSite: "strict",
      secure: false,
      path: "/",
    });
    return response;
  }

  if (hasDesktopSession) return NextResponse.next();

  if (nextUrl.pathname.startsWith("/dashboard") && !session?.user) {
    const loginUrl = new URL("/login", nextUrl);
    loginUrl.searchParams.set("callbackUrl", nextUrl.pathname);
    return NextResponse.redirect(loginUrl);
  }

  if (
    (nextUrl.pathname === "/" || nextUrl.pathname === "/login") &&
    session?.user
  ) {
    return NextResponse.redirect(new URL("/dashboard", nextUrl));
  }

  return NextResponse.next();
});

export const config = { matcher: ["/", "/login", "/dashboard/:path*"] };
