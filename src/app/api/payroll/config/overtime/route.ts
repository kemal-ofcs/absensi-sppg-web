import type { NextRequest } from "next/server";
import { requireWebPermission } from "@/lib/server/auth/authorize";
import {
  ensureServerDatabaseInitialized,
  getServerDatabase,
} from "@/lib/server/db";
import {
  noStoreJson,
  readJsonBody,
  toApiErrorResponse,
} from "@/lib/server/http/api-response";
import { assertSameOriginMutation } from "@/lib/server/http/request-security";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    await requireWebPermission(request, "payroll.view");
    await ensureServerDatabaseInitialized();
    const client = getServerDatabase();

    const result = await client.execute(
      "SELECT * FROM overtime_tier_rules ORDER BY rule_type, tier_order ASC;",
    );
    return noStoreJson({ data: result.rows });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}

export async function PUT(request: NextRequest) {
  try {
    await requireWebPermission(request, "payroll.config.manage");
    assertSameOriginMutation(request);
    await ensureServerDatabaseInitialized();
    const client = getServerDatabase();

    const body = await readJsonBody<{
      draft?: Record<string, unknown>;
      rules?: Array<Record<string, unknown>>;
    }>(request);

    const rules = body.rules || (body.draft ? [body.draft] : []);

    for (const rule of rules) {
      const ruleId =
        rule.id && String(rule.id).trim() !== ""
          ? String(rule.id)
          : `ot-${String(rule.rule_type).toLowerCase()}-${Date.now()}`;

      await client.execute({
        sql: `
          INSERT INTO overtime_tier_rules (
            id, rule_type, tier_order, hour_start, hour_end, multiplier, is_active
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            rule_type = excluded.rule_type,
            tier_order = excluded.tier_order,
            hour_start = excluded.hour_start,
            hour_end = excluded.hour_end,
            multiplier = excluded.multiplier,
            is_active = excluded.is_active;
        `,
        args: [
          ruleId,
          String(rule.rule_type),
          Number(rule.tier_order),
          Number(rule.hour_start),
          rule.hour_end !== null && rule.hour_end !== undefined
            ? Number(rule.hour_end)
            : null,
          Number(rule.multiplier),
          Number(rule.is_active ?? 1),
        ],
      });
    }

    return noStoreJson({ sukses: true });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}

export async function DELETE(request: NextRequest) {
  try {
    await requireWebPermission(request, "payroll.config.manage");
    assertSameOriginMutation(request);
    await ensureServerDatabaseInitialized();
    const client = getServerDatabase();

    const body = await readJsonBody<{ id: string }>(request);
    await client.execute({
      sql: "DELETE FROM overtime_tier_rules WHERE id = ?;",
      args: [body.id],
    });

    return noStoreJson({ sukses: true });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
