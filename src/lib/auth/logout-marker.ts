const FORCED_LOGOUT_KEY = "absensi-sppg-forced-logout-v1";

interface SessionStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function browserSessionStorage(): SessionStorageLike | null {
  return typeof window === "undefined" ? null : window.sessionStorage;
}

export function hasForcedLogoutMarker(
  storage: SessionStorageLike | null = browserSessionStorage(),
) {
  return Boolean(storage?.getItem(FORCED_LOGOUT_KEY));
}

export function setForcedLogoutMarker(
  storage: SessionStorageLike | null = browserSessionStorage(),
) {
  storage?.setItem(FORCED_LOGOUT_KEY, new Date().toISOString());
}

export function clearForcedLogoutMarker(
  storage: SessionStorageLike | null = browserSessionStorage(),
) {
  storage?.removeItem(FORCED_LOGOUT_KEY);
}
