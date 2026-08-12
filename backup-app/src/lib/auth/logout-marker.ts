const LOGOUT_MARKER_KEY = "hybrid-starter-force-logout-v1";

export function hasForcedLogoutMarker(): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  return Boolean(window.sessionStorage.getItem(LOGOUT_MARKER_KEY));
}

export function setForcedLogoutMarker(): void {
  if (typeof window === "undefined") {
    return;
  }

  window.sessionStorage.setItem(LOGOUT_MARKER_KEY, new Date().toISOString());
}

export function clearForcedLogoutMarker(): void {
  if (typeof window === "undefined") {
    return;
  }

  window.sessionStorage.removeItem(LOGOUT_MARKER_KEY);
}
