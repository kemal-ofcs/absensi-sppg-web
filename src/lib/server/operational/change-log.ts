import "server-only";

import type { Client } from "@libsql/client";

export async function recordOperationalChange(
  client: Client,
  input: {
    domain: string;
    entityKey: string;
    operation: string;
    payload: unknown;
    actorOperatorId: number;
  },
) {
  const result = await client.execute({
    sql: `
      INSERT INTO sync_change_log (
        domain, entity_key, operation, payload_json, changed_at,
        actor_operator_id
      ) VALUES (?, ?, ?, ?, ?, ?);
    `,
    args: [
      input.domain,
      input.entityKey,
      input.operation,
      JSON.stringify(input.payload),
      new Date().toISOString(),
      input.actorOperatorId,
    ],
  });
  return Number(result.lastInsertRowid);
}
