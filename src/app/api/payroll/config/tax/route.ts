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
      "SELECT * FROM tax_rules ORDER BY category, bracket_min ASC;",
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
          : `tax-${String(rule.category).toLowerCase()}-${Date.now()}`;

      await client.execute({
        sql: `
          INSERT INTO tax_rules (
            id, category, bracket_min, bracket_max, rate_percentage, effective_date
          ) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            category = excluded.category,
            bracket_min = excluded.bracket_min,
            bracket_max = excluded.bracket_max,
            rate_percentage = excluded.rate_percentage,
            effective_date = excluded.effective_date;
        `,
        args: [
          ruleId,
          String(rule.category),
          Number(rule.bracket_min),
          rule.bracket_max !== null && rule.bracket_max !== undefined
            ? Number(rule.bracket_max)
            : null,
          Number(rule.rate_percentage),
          String(rule.effective_date || new Date().toISOString().slice(0, 10)),
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
      sql: "DELETE FROM tax_rules WHERE id = ?;",
      args: [body.id],
    });

    return noStoreJson({ sukses: true });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
