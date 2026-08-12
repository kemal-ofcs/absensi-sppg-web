const DESKTOP_RUNTIME_MARKER_KEY = "hybrid-starter.desktop.runtime";
const DESKTOP_RUNTIME_COOKIE_KEY = "hybrid-starter.desktop.runtime";
const DESKTOP_LOOPBACK_QUERY_TOKEN = "hybrid_starter_desktop_token";

function persistDesktopRuntimeMarker() {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.sessionStorage.setItem(DESKTOP_RUNTIME_MARKER_KEY, "1");
  } catch {
    // Ignore storage failures in restricted environments.
  }
}

function hasPersistedDesktopRuntimeMarker() {
  if (typeof window === "undefined") {
    return false;
  }

  try {
    return window.sessionStorage.getItem(DESKTOP_RUNTIME_MARKER_KEY) === "1";
  } catch {
    return false;
  }
}

function hasDesktopRuntimeCookieMarker() {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return false;
  }

  if (
    typeof window.location === "undefined" ||
    (window.location.hostname !== "127.0.0.1" &&
      window.location.hostname !== "localhost")
  ) {
    return false;
  }

  try {
    return document.cookie
      .split(";")
      .map((value) => value.trim())
      .some((value) => value === `${DESKTOP_RUNTIME_COOKIE_KEY}=1`);
  } catch {
    return false;
  }
}

export const isTauri = (): boolean => {
  if (typeof window === "undefined") {
    return false;
  }

  const hasTauriInternals = window.__TAURI_INTERNALS__ !== undefined;
  const hasTauriGlobal = window.__TAURI__ !== undefined;
  const isTauriProtocol =
    typeof window.location !== "undefined" &&
    window.location.protocol === "tauri:";
  const hasTauriUserAgent =
    typeof navigator !== "undefined" &&
    typeof navigator.userAgent === "string" &&
    navigator.userAgent.includes("Tauri");
  const hasDesktopLoopbackQueryToken =
    typeof window.location !== "undefined" &&
    new URLSearchParams(window.location.search).has(
      DESKTOP_LOOPBACK_QUERY_TOKEN,
    );
  const hasDesktopRuntimeCookie = hasDesktopRuntimeCookieMarker();
  const hasPersistedMarker = hasPersistedDesktopRuntimeMarker();

  const detectedDesktopRuntime =
    hasTauriInternals ||
    hasTauriGlobal ||
    isTauriProtocol ||
    hasTauriUserAgent ||
    hasDesktopLoopbackQueryToken ||
    hasDesktopRuntimeCookie ||
    hasPersistedMarker;

  if (detectedDesktopRuntime) {
    persistDesktopRuntimeMarker();
  }

  return detectedDesktopRuntime;
};

export const isWeb = (): boolean => {
  return !isTauri();
};

export const getPlatform = () => {
  if (isTauri()) return "desktop";
  return "web";
};
