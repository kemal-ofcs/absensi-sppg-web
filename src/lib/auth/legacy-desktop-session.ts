import type { OperatorUser } from "@/lib/auth/operator-user";

const STORAGE_KEY = "absensi_sppg_operator_session";
const SESSION_CHANGE_EVENT = "absensi-sppg:session-change";

// Rollback B2/B3 sementara. Jalur ini tidak lagi menjadi sumber autentikasi aktif.
export function subscribeLegacyDesktopSession(onStoreChange: () => void) {
  const handleStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === STORAGE_KEY) onStoreChange();
  };
  window.addEventListener("storage", handleStorage);
  window.addEventListener(SESSION_CHANGE_EVENT, onStoreChange);
  return () => {
    window.removeEventListener("storage", handleStorage);
    window.removeEventListener(SESSION_CHANGE_EVENT, onStoreChange);
  };
}

export function getLegacyDesktopSession() {
  return localStorage.getItem(STORAGE_KEY);
}

export function parseLegacyDesktopSession(snapshot: string | null) {
  if (!snapshot) return null;
  try {
    const parsed = JSON.parse(snapshot) as Partial<OperatorUser>;
    if (
      !Number.isSafeInteger(parsed.id) ||
      typeof parsed.roleId !== "number" ||
      typeof parsed.roleKey !== "string" ||
      typeof parsed.isSuperadmin !== "boolean" ||
      !Array.isArray(parsed.permissions)
    ) {
      return null;
    }
    return parsed as OperatorUser;
  } catch {
    return null;
  }
}
