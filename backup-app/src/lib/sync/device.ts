import { isTauri } from "@/core/env";

export async function getSyncDeviceId() {
  if (!isTauri()) {
    throw new Error("Sync device ID is only available in desktop runtime.");
  }
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<string>("get_sync_device_id");
}
