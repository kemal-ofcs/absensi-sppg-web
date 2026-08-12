export type DesktopApiResponse = Response | null;

function jsonResponse(data: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
}

export function apiOk<T>(data: T, status = 200) {
  return jsonResponse({ success: true, data }, { status });
}

export function apiError(message: string, status: number, code?: string) {
  return jsonResponse(
    {
      success: false,
      error: message,
      code,
    },
    { status },
  );
}
