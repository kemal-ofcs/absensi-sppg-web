import type { NextRequest } from "next/server";
import { z } from "zod";
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

/**
 * Cermin validasi `desktop_save_payroll_component` (CHECK cloud). `created_at`
 * boleh terbawa dari baris yang sedang disunting, tetapi diabaikan. Potongan
 * tidak pernah menjadi dasar BPJS (v45, Q-181 (a)).
 */
const componentDraftSchema = z
  .object({
    id: z.string().max(128).optional(),
    name: z.string().trim().min(1, "Nama komponen wajib diisi.").max(255),
    category: z.enum(["ALLOWANCE", "DEDUCTION"]),
    calc_type: z.enum(["FIXED", "PERCENTAGE"]),
    default_value: z.number().min(0).default(0),
    applies_to: z.string().trim().min(1).max(128).default("ALL"),
    is_active: z.union([z.literal(0), z.literal(1)]).default(1),
    dasar_bpjs: z.union([z.literal(0), z.literal(1)]).default(0),
    created_at: z.string().optional(),
  })
  .strict()
  .transform((draft) => ({
    ...draft,
    dasar_bpjs: draft.category === "ALLOWANCE" ? draft.dasar_bpjs : 0,
  }));

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

    const body = await readJsonBody<{ draft?: unknown }>(request);
    const parsed = componentDraftSchema.safeParse(body.draft);
    if (!parsed.success) {
      throw new ApiRequestError(
        parsed.error.issues[0]?.message ?? "Data komponen payroll tidak valid.",
        400,
      );
    }
    const draft = parsed.data;

    const compId = draft.id?.trim() ? draft.id.trim() : `comp-${Date.now()}`;

    await client.execute({
      sql: `
        INSERT INTO payroll_components (
          id, name, category, calc_type, default_value, applies_to, is_active, dasar_bpjs
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          category = excluded.category,
          calc_type = excluded.calc_type,
          default_value = excluded.default_value,
          applies_to = excluded.applies_to,
          is_active = excluded.is_active,
          dasar_bpjs = excluded.dasar_bpjs;
      `,
      args: [
        compId,
        draft.name,
        draft.category,
        draft.calc_type,
        draft.default_value,
        draft.applies_to,
        draft.is_active,
        draft.dasar_bpjs,
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
