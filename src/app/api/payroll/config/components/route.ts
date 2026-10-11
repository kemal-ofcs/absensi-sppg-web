import type { NextRequest } from "next/server";
import { requireWebPermission } from "@/lib/server/auth/authorize";
import {
  ensureServerDatabaseInitialized,
  getServerDatabase,
} from "@/lib/server/db";
import {
  ApiRequestError,
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
      "SELECT * FROM payroll_components ORDER BY category, name ASC;",
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

    const body = await readJsonBody<{ draft?: Record<string, unknown> }>(
      request,
    );
    const draft = body.draft;
    if (!draft || !draft.name || !draft.category || !draft.calc_type) {
      throw new ApiRequestError(
        "name, category, dan calc_type wajib diisi.",
        400,
      );
    }

    const compId =
      typeof draft.id === "string" && draft.id.trim()
        ? draft.id.trim()
        : `comp-${Date.now()}`;

    await client.execute({
      sql: `
        INSERT INTO payroll_components (
          id, name, category, calc_type, default_value, applies_to, is_active
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          category = excluded.category,
          calc_type = excluded.calc_type,
          default_value = excluded.default_value,
          applies_to = excluded.applies_to,
          is_active = excluded.is_active;
      `,
      args: [
        compId,
        String(draft.name),
        String(draft.category),
        String(draft.calc_type),
        Number(draft.default_value || 0),
        String(draft.applies_to || "ALL"),
        Number(draft.is_active ?? 1),
      ],
    });

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

    const body = await readJsonBody<{ id?: string }>(request);
    if (!body.id) {
      throw new ApiRequestError("id wajib diisi.", 400);
    }

    await client.execute({
      sql: "DELETE FROM payroll_components WHERE id = ?;",
      args: [body.id],
    });

    return noStoreJson({ sukses: true });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
