import { describe, expect, mock, test } from "bun:test";
import type { Client, ResultSet } from "@libsql/client";

mock.module("server-only", () => ({}));

function result(rows: Record<string, unknown>[] = []) {
  return { rows } as unknown as ResultSet;
}

describe("readOperationalSnapshot", () => {
  test("membaca seluruh tabel melalui satu batch read", async () => {
    const { readOperationalSnapshot } = await import("./snapshot");
    let receivedStatementCount = 0;
    let receivedMode: string | undefined;
    const client = {
      batch: async (statements: unknown[], mode?: string) => {
        receivedStatementCount = statements.length;
        receivedMode = mode;
        return [
          result([{ id_unik: "employee-1", nama: "Operator Uji" }]),
          result(),
          result(),
          result(),
          result(),
          result(),
          result(),
          result(),
          result(),
          result([{ revision: 12 }]),
        ];
      },
    } as unknown as Client;

    const snapshot = await readOperationalSnapshot(client);

    expect(receivedMode).toBe("read");
    expect(receivedStatementCount).toBe(10);
    expect(snapshot.revision).toBe(12);
    expect(snapshot.employees).toEqual([
      { id_unik: "employee-1", nama: "Operator Uji" },
    ]);
    expect(snapshot.scanLogs).toEqual([]);
  });
});
