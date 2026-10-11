"use client";

import { requestWebApi } from "@/lib/client/api-client";
import {
  isMailProvider,
  type MailConfig,
  type MailConfigDraft,
} from "@/lib/mail/mail-config";
import { isDesktopRuntime } from "@/lib/runtime/app-runtime";
import { invokeDesktop } from "@/lib/runtime/desktop-commands";

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function text(value: unknown) {
  return value == null ? "" : String(value);
}

function normalizeConfig(value: unknown): MailConfig {
  const config = record(value);
  return {
    provider: isMailProvider(config.provider) ? config.provider : "resend",
    hasApiKey:
      config.hasApiKey === true ||
      config.has_api_key === true ||
      Number(config.has_api_key ?? 0) === 1,
    senderEmail: String(config.senderEmail ?? config.sender_email ?? ""),
    senderName: String(config.senderName ?? config.sender_name ?? ""),
    resetBaseUrl: String(config.resetBaseUrl ?? config.reset_base_url ?? ""),
    isActive:
      config.isActive === true ||
      config.is_active === true ||
      Number(config.is_active ?? 0) === 1,
    updatedAt: String(config.updatedAt ?? config.updated_at ?? ""),
    updatedBy: String(config.updatedBy ?? config.updated_by ?? ""),
  };
}

export async function getMailConfig() {
  if (isDesktopRuntime()) {
    const payload = await invokeDesktop<JsonRecord>("desktop_get_mail_config");
    return normalizeConfig(payload.config ?? payload);
  }
  const response = await requestWebApi<{ config: MailConfig }>(
    "/api/settings/mail/query",
    "POST",
  );
  return normalizeConfig(response.config);
}

export interface MailTestResult {
  delivered: boolean;
  message: string;
  detail: string;
  to: string;
}

export async function sendTestMail() {
  if (isDesktopRuntime()) {
    const payload = await invokeDesktop<JsonRecord>("desktop_send_test_mail");
    const test = record(payload.test ?? payload);
    return {
      delivered: test.delivered === true,
      message: text(test.message),
      detail: text(test.detail),
      to: text(test.to),
    } satisfies MailTestResult;
  }
  const response = await requestWebApi<{ test: MailTestResult }>(
    "/api/settings/mail",
    "POST",
  );
  return response.test;
}

export async function saveMailConfig(draft: MailConfigDraft) {
  if (isDesktopRuntime()) {
    const payload = await invokeDesktop<JsonRecord>(
      "desktop_save_mail_config",
      {
        draft: {
          provider: draft.provider,
          api_key: draft.apiKey,
          sender_email: draft.senderEmail,
          sender_name: draft.senderName,
          reset_base_url: draft.resetBaseUrl,
          is_active: draft.isActive,
        },
      },
    );
    return normalizeConfig(payload.config ?? payload);
  }
  const response = await requestWebApi<{ config: MailConfig }>(
    "/api/settings/mail",
    "PUT",
    { draft },
  );
  return normalizeConfig(response.config);
}
