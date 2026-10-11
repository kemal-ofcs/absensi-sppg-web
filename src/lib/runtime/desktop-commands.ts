"use client";

import { invoke } from "@tauri-apps/api/core";

interface DesktopCommandError {
  code?: unknown;
  message?: unknown;
}

function commandErrorMessage(error: unknown) {
  if (typeof error === "string" && error.trim()) return error;
  if (error && typeof error === "object") {
    const value = error as DesktopCommandError;
    if (typeof value.message === "string" && value.message.trim()) {
      return value.message;
    }
  }
  return "Perintah keamanan Desktop tidak dapat diproses.";
}

export async function invokeDesktop<T>(
  command: string,
  args?: Record<string, unknown>,
) {
  try {
    return await invoke<T>(command, args);
  } catch (error) {
    throw new Error(commandErrorMessage(error));
  }
}
