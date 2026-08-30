import type { NextRequest } from "next/server";
import { isMailProvider, type MailConfigDraft } from "@/lib/mail/mail-config";
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
import { saveMailConfig, sendTestMail } from "@/lib/server/mail/mail-store";

export const runtime = "nodejs";

interface MailMutationBody {
  draft?: unknown;
}

function parseDraft(value: unknown): MailConfigDraft {
  const draft = (value ?? {}) as Record<string, unknown>;
  return {
    provider: isMailProvider(draft.provider) ? draft.provider : "resend",
    apiKey: typeof draft.apiKey === "string" ? draft.apiKey : "",
    senderEmail: typeof draft.senderEmail === "string" ? draft.senderEmail : "",
    senderName: typeof draft.senderName === "string" ? draft.senderName : "",
    resetBaseUrl:
      typeof draft.resetBaseUrl === "string" ? draft.resetBaseUrl : "",
    isActive: draft.isActive === true,
  };
}

/**
 * Uji kirim. Balasannya memuat penjelasan apa adanya dari penyedia email —
 * aman karena endpoint ini butuh izin `settings.manage`.
 */
export async function POST(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    await ensureServerDatabaseInitialized();
    const actor = await requireWebPermission(request, "settings.manage", true);
    const result = await sendTestMail(getServerDatabase(), actor.id);
    return noStoreJson({ sukses: true, test: result });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}

export async function PUT(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    await ensureServerDatabaseInitialized();
    const actor = await requireWebPermission(request, "settings.manage", true);
    const body = await readJsonBody<MailMutationBody>(request);
    const config = await saveMailConfig(
      getServerDatabase(),
      parseDraft(body.draft),
      actor.kode_operator,
    );
    return noStoreJson({ sukses: true, config });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
