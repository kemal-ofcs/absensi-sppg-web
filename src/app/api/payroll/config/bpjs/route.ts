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
      "SELECT * FROM bpjs_rules ORDER BY component_code ASC;",
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
          : `bpjs-${String(rule.component_code).toLowerCase()}-${Date.now()}`;

      await client.execute({
        sql: `
          INSERT INTO bpjs_rules (
            id, component_code, component_name, rate_percentage, wage_cap, effective_date
          ) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(component_code) DO UPDATE SET
            component_name = excluded.component_name,
            rate_percentage = excluded.rate_percentage,
            wage_cap = excluded.wage_cap,
            effective_date = excluded.effective_date;
        `,
        args: [
          ruleId,
          String(rule.component_code),
          String(rule.component_name),
          Number(rule.rate_percentage),
          rule.wage_cap !== null && rule.wage_cap !== undefined
            ? Number(rule.wage_cap)
            : null,
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
      sql: "DELETE FROM bpjs_rules WHERE id = ? OR component_code = ?;",
      args: [body.id, body.id],
    });

    return noStoreJson({ sukses: true });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
