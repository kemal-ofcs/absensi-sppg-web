import type { NextRequest } from "next/server";
import { z } from "zod";
import {
  DAILY_RATE_MAX,
  DAILY_RATE_MIN,
  SALARY_TYPES,
} from "@/lib/constants/payroll";
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

const PTKP_STATUSES = [
  "TK/0",
  "TK/1",
  "TK/2",
  "TK/3",
  "K/0",
  "K/1",
  "K/2",
  "K/3",
] as const;
// Format 4-2-2 DAN tanggal yang benar-benar ada, seperti `is_calendar_date`
// di time_policy.rs: `2026-02-30` ditolak di kedua sisi.
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Tanggal berlaku harus berformat YYYY-MM-DD.")
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00Z`);
    // Bulan 13 menghasilkan Invalid Date, dan toISOString() padanya melempar.
    return (
      !Number.isNaN(parsed.getTime()) &&
      parsed.toISOString().slice(0, 10) === value
    );
  }, "Tanggal berlaku tidak ada di kalender.");
const dailyRate = z
  .number()
  .int()
  .min(DAILY_RATE_MIN, `Tarif harian minimal Rp ${DAILY_RATE_MIN}.`)
  .max(DAILY_RATE_MAX, `Tarif harian maksimal Rp ${DAILY_RATE_MAX}.`);

/**
 * Cerminan `SalaryConfig::normalized` di payroll/models.rs. Nilai yang ditolak
 * CHECK constraint cloud wajib ditolak di sini lebih dulu. `created_by` dan
 * `created_at` boleh terbawa dari baris yang sedang disunting, tetapi diabaikan.
 */
const salaryDraftSchema = z
  .object({
    id: z.string().max(128).optional(),
    id_karyawan: z.string().trim().min(1, "Karyawan wajib dipilih.").max(128),
    salary_type: z.enum(SALARY_TYPES).default("HOURLY"),
    rate_per_hour: z.number().int().min(0).default(0),
    daily_rate: z.number().int().min(0).default(0),
    ptkp_status: z
      .string()
      .trim()
      .toUpperCase()
      .pipe(z.enum(PTKP_STATUSES))
      .default("TK/0"),
    effective_date: isoDate,
    created_by: z.string().optional(),
    created_at: z.string().optional(),
  })
  .strict()
  .superRefine((draft, ctx) => {
    if (
      draft.salary_type === "FLAT_DAILY" &&
      !dailyRate.safeParse(draft.daily_rate).success
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["daily_rate"],
        message: `Tarif harian harus antara Rp ${DAILY_RATE_MIN} dan Rp ${DAILY_RATE_MAX}.`,
      });
    }
  })
  .transform((draft) => ({
    ...draft,
    // Hanya satu tarif yang bermakna per tipe; yang lain selalu 0.
    rate_per_hour: draft.salary_type === "FLAT_DAILY" ? 0 : draft.rate_per_hour,
    daily_rate: draft.salary_type === "FLAT_DAILY" ? draft.daily_rate : 0,
  }));

const bulkFlatDailySchema = z
  .object({
    divisi: z.string().trim().max(128).nullable().optional(),
    daily_rate: dailyRate,
    effective_date: isoDate,
  })
  .strict();

function parseOrThrow<T>(result: z.ZodSafeParseResult<T>): T {
  if (!result.success) {
    throw new ApiRequestError(
      result.error.issues[0]?.message ?? "Data konfigurasi gaji tidak valid.",
      400,
    );
  }
  return result.data;
}

const UPSERT_SALARY_CONFIG_SQL = `
  INSERT INTO salary_configs (
    id, id_karyawan, rate_per_hour, ptkp_status, effective_date, created_by, created_at,
    salary_type, daily_rate
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id_karyawan, effective_date) DO UPDATE SET
    rate_per_hour = excluded.rate_per_hour,
    ptkp_status = excluded.ptkp_status,
    created_by = excluded.created_by,
    salary_type = excluded.salary_type,
    daily_rate = excluded.daily_rate;
`;

export async function POST(request: NextRequest) {
  try {
    await requireWebPermission(request, "payroll.view");
    await ensureServerDatabaseInitialized();
    const client = getServerDatabase();

    const body = await readJsonBody<{ search?: string }>(request);
    const searchPattern = body.search ? `%${body.search.trim()}%` : "%";

    const result = await client.execute({
      sql: `
        SELECT sc.id, sc.id_karyawan, sc.rate_per_hour, sc.ptkp_status,
               sc.effective_date, sc.created_by, sc.created_at,
               sc.salary_type, sc.daily_rate
        FROM salary_configs sc
        LEFT JOIN master_data md ON md.id_unik = sc.id_karyawan
        WHERE ? = '%' OR COALESCE(md.nama, '') LIKE ? OR COALESCE(md.kode_karyawan, '') LIKE ? OR sc.id_karyawan LIKE ?
        ORDER BY sc.effective_date DESC;
      `,
      args: [searchPattern, searchPattern, searchPattern, searchPattern],
    });

    return noStoreJson({ data: result.rows });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}

export async function PUT(request: NextRequest) {
  try {
    const actor = await requireWebPermission(request, "payroll.config.manage");
    assertSameOriginMutation(request);
    await ensureServerDatabaseInitialized();
    const client = getServerDatabase();

    const body = await readJsonBody<{ draft?: unknown }>(request);
    const draft = parseOrThrow(salaryDraftSchema.safeParse(body.draft));

    const configId = draft.id?.trim() || `sc-${Date.now()}`;
    const now = new Date().toISOString();

    await client.execute({
      sql: UPSERT_SALARY_CONFIG_SQL,
      args: [
        configId,
        draft.id_karyawan,
        draft.rate_per_hour,
        draft.ptkp_status,
        draft.effective_date,
        actor.username,
        now,
        draft.salary_type,
        draft.daily_rate,
      ],
    });

    return noStoreJson({ sukses: true });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}

/**
 * Penerapan massal tarif harian tetap ke seluruh karyawan aktif, atau satu
 * divisi. Cerminan `desktop_bulk_apply_flat_daily`: satu batch, status PTKP
 * setiap karyawan dipertahankan dari konfigurasi terakhirnya.
 */
export async function PATCH(request: NextRequest) {
  try {
    const actor = await requireWebPermission(request, "payroll.config.manage");
    assertSameOriginMutation(request);
    await ensureServerDatabaseInitialized();
    const client = getServerDatabase();

    const input = parseOrThrow(
      bulkFlatDailySchema.safeParse(await readJsonBody(request)),
    );
    const divisi = input.divisi || null;

    const targets = await client.execute({
      sql: `
        SELECT md.id_unik,
               COALESCE((
                 SELECT sc.ptkp_status FROM salary_configs sc
                 WHERE sc.id_karyawan = md.id_unik
                 ORDER BY sc.effective_date DESC LIMIT 1
               ), 'TK/0') AS ptkp_status,
               (
                 SELECT sc.id FROM salary_configs sc
                 WHERE sc.id_karyawan = md.id_unik AND sc.effective_date = ?
               ) AS existing_id
        FROM master_data md
        WHERE md.status_aktif = 'Aktif' AND (? IS NULL OR md.divisi = ?)
        ORDER BY md.id_unik;
      `,
      args: [input.effective_date, divisi, divisi],
    });
    if (targets.rows.length === 0) {
      throw new ApiRequestError(
        "Tidak ada karyawan aktif pada cakupan yang dipilih.",
        400,
      );
    }

    const now = new Date().toISOString();
    const stamp = Date.now();
    await client.batch(
      targets.rows.map((row, index) => ({
        sql: UPSERT_SALARY_CONFIG_SQL,
        args: [
          row.existing_id ? String(row.existing_id) : `sc-${stamp}-${index}`,
          String(row.id_unik),
          0,
          String(row.ptkp_status),
          input.effective_date,
          actor.username,
          now,
          "FLAT_DAILY",
          input.daily_rate,
        ],
      })),
      "write",
    );

    return noStoreJson({ sukses: true, jumlah: targets.rows.length });
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
      sql: "DELETE FROM salary_configs WHERE id = ?;",
      args: [body.id],
    });

    return noStoreJson({ sukses: true });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
