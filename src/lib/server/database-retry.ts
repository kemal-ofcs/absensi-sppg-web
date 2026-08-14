const TRANSIENT_DATABASE_ERROR_CODES = new Set([
  "EAI_AGAIN",
  "ECONNRESET",
  "ENETUNREACH",
  "ETIMEDOUT",
  "UND_ERR_CONNECT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
]);

function errorChain(error: unknown) {
  const chain: unknown[] = [];
  const visited = new Set<unknown>();
  let current = error;

  while (current && !visited.has(current) && chain.length < 8) {
    chain.push(current);
    visited.add(current);
    current =
      typeof current === "object" && "cause" in current
        ? Reflect.get(current, "cause")
        : null;
  }

  return chain;
}

export function isTransientDatabaseError(error: unknown) {
  return errorChain(error).some((candidate) => {
    const message =
      candidate instanceof Error
        ? candidate.message.toLowerCase()
        : String(candidate).toLowerCase();
    const code =
      typeof candidate === "object" && candidate && "code" in candidate
        ? String(Reflect.get(candidate, "code"))
        : "";

    return (
      message.includes("fetch failed") ||
      message.includes("connect timeout") ||
      TRANSIENT_DATABASE_ERROR_CODES.has(code)
    );
  });
}

export async function withTransientDatabaseRetry<T>(
  operation: () => Promise<T>,
  options: { retries?: number; delayMs?: number } = {},
) {
  const retries = Math.max(0, options.retries ?? 1);
  const delayMs = Math.max(0, options.delayMs ?? 400);

  for (let attempt = 0; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= retries || !isTransientDatabaseError(error)) throw error;
      if (delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }
}
