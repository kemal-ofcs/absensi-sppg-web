export const WEB_SESSION_COOKIE = "sppg_session";
export const WEB_SESSION_TTL_SECONDS = 8 * 60 * 60;

export function getWebSessionCookieOptions(isProduction: boolean) {
  return {
    httpOnly: true,
    secure: isProduction,
    sameSite: "lax" as const,
    path: "/",
    maxAge: WEB_SESSION_TTL_SECONDS,
  };
}
