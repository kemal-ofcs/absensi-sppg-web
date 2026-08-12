import { describe, expect, test } from "bun:test";
import {
  JsonBodyError,
  readBoundedJsonBody,
} from "@/lib/server/http/json-body";

function jsonRequest(body: string, headers: HeadersInit = {}) {
  return new Request("https://sppg.example/api/test", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });
}

describe("bounded JSON body", () => {
  test("membaca JSON valid tanpa bergantung pada Content-Length", async () => {
    const value = await readBoundedJsonBody<{ name: string }>(
      jsonRequest('{"name":"SPPG"}'),
      64,
    );
    expect(value).toEqual({ name: "SPPG" });
  });

  test("menolak body aktual yang melampaui batas", async () => {
    const request = jsonRequest(JSON.stringify({ value: "x".repeat(64) }));
    await expect(readBoundedJsonBody(request, 32)).rejects.toMatchObject({
      status: 413,
    });
  });

  test("menolak deklarasi panjang, content type, dan JSON invalid", async () => {
    await expect(
      readBoundedJsonBody(jsonRequest("{}", { "content-length": "100" }), 8),
    ).rejects.toBeInstanceOf(JsonBodyError);

    await expect(
      readBoundedJsonBody(
        new Request("https://sppg.example/api/test", {
          method: "POST",
          body: "{}",
        }),
      ),
    ).rejects.toMatchObject({ status: 415 });

    await expect(readBoundedJsonBody(jsonRequest("{"))).rejects.toMatchObject({
      status: 400,
    });
  });
});
