export class JsonBodyError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 413 | 415,
  ) {
    super(message);
    this.name = "JsonBodyError";
  }
}

async function readBoundedBody(request: Request, maxBytes: number) {
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new JsonBodyError("Payload terlalu besar.", 413);
  }

  if (!request.body) return new Uint8Array();

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      totalBytes += chunk.value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new JsonBodyError("Payload terlalu besar.", 413);
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export async function readBoundedJsonBody<T>(
  request: Request,
  maxBytes = 2_097_152,
): Promise<T> {
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("application/json")) {
    throw new JsonBodyError("Content-Type harus application/json.", 415);
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error("Batas payload JSON tidak valid.");
  }

  const bytes = await readBoundedBody(request, maxBytes);
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return JSON.parse(text) as T;
  } catch (error) {
    if (error instanceof JsonBodyError) throw error;
    throw new JsonBodyError("Payload JSON tidak valid.", 400);
  }
}
