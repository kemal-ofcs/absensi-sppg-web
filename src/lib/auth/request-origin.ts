export function isSameOriginRequest(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin) return false;

  try {
    const originUrl = new URL(origin);
    const requestUrl = new URL(request.url);
    const forwardedHost = request.headers
      .get("x-forwarded-host")
      ?.split(",")[0]
      ?.trim();
    const requestHost = forwardedHost || request.headers.get("host");

    if (requestHost && originUrl.host === requestHost) {
      const forwardedProtocol = request.headers
        .get("x-forwarded-proto")
        ?.split(",")[0]
        ?.trim();
      return (
        !forwardedProtocol || originUrl.protocol === `${forwardedProtocol}:`
      );
    }

    return originUrl.origin === requestUrl.origin;
  } catch {
    return false;
  }
}
