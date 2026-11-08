"use client";

import { requestWebApi } from "@/lib/client/api-client";
import { isDesktopRuntime } from "@/lib/runtime/app-runtime";
import { invokeDesktop } from "@/lib/runtime/desktop-commands";
import type {
  BidangTelegram,
  GrupTelegram,
  TelegramConfig,
  TelegramConfigDraft,
  TelegramDrainResult,
} from "@/lib/validations/telegram";

/** Bentuk sama dari Rust (`telegram::get_config`) dan Web (`getTelegramConfig`). */
export async function getTelegramConfigGateway(): Promise<TelegramConfig> {
  if (isDesktopRuntime()) {
    return invokeDesktop<TelegramConfig>("desktop_get_telegram_config");
  }
  const respons = await requestWebApi<{ config: TelegramConfig }>(
    "/api/settings/telegram/query",
    "POST",
    {},
  );
  return respons.config;
}

export async function saveTelegramConfigGateway(
  draft: TelegramConfigDraft,
): Promise<TelegramConfig> {
  if (isDesktopRuntime()) {
    return invokeDesktop<TelegramConfig>("desktop_save_telegram_config", {
      draft,
    });
  }
  const respons = await requestWebApi<{ config: TelegramConfig }>(
    "/api/settings/telegram",
    "PUT",
    { draft },
  );
  return respons.config;
}

/** `botToken` kosong = token yang tersimpan. */
export async function findTelegramGroupsGateway(
  botToken: string,
): Promise<GrupTelegram[]> {
  const respons = isDesktopRuntime()
    ? await invokeDesktop<{ grup: GrupTelegram[] }>(
        "desktop_find_telegram_groups",
        { botToken },
      )
    : await requestWebApi<{ grup: GrupTelegram[] }>(
        "/api/settings/telegram/groups",
        "POST",
        { botToken },
      );
  return respons.grup;
}

export async function sendTelegramTestGateway(input: {
  bidang: BidangTelegram;
  chatId: string;
  botToken: string;
}): Promise<void> {
  if (isDesktopRuntime()) {
    await invokeDesktop("desktop_send_telegram_test", { input });
    return;
  }
  await requestWebApi("/api/settings/telegram/test", "POST", input);
}

export async function drainTelegramGateway(): Promise<TelegramDrainResult> {
  if (isDesktopRuntime()) {
    return invokeDesktop<TelegramDrainResult>("desktop_drain_telegram");
  }
  return requestWebApi<TelegramDrainResult>("/api/telegram/drain", "POST", {});
}
