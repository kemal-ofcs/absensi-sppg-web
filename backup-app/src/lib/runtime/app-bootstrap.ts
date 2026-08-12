const DEFAULT_API_TIMEOUT_MS = 10_000;
const STARTUP_API_TIMEOUT_MS = 20_000;
const STARTUP_STABILIZATION_TIMEOUT_MS = 30_000;
const STARTUP_STABILIZATION_WINDOW_MS = 45_000;
const MUTATION_API_TIMEOUT_MS = 30_000;
const STARTUP_WARMUP_ENDPOINT = "/api/runtime/warmup";
export const STARTUP_HEALTH_ENDPOINT = "/api/runtime/health";

type WarmupState = "idle" | "pending" | "ready" | "failed";

let warmupState: WarmupState = "idle";
let warmupPromise: Promise<void> | null = null;
let warmupSettledAt = 0;

function isClientRuntime() {
  return typeof window !== "undefined";
}

function isDesktopTauriRuntime() {
  return (
    typeof window !== "undefined" &&
    typeof window.__TAURI_INTERNALS__ !== "undefined"
  );
}

function isApiRoute(input: string) {
  return input.startsWith("/api/");
}

export function getApiTimeoutMs(
  input: string,
  explicitTimeoutMs?: number,
  method?: string,
): number {
  if (explicitTimeoutMs !== undefined) {
    return explicitTimeoutMs;
  }

  if (isApiRoute(input) && method && method !== "GET") {
    return MUTATION_API_TIMEOUT_MS;
  }

  if (isApiRoute(input) && warmupState === "pending") {
    return STARTUP_API_TIMEOUT_MS;
  }

  if (
    isApiRoute(input) &&
    method === "GET" &&
    warmupSettledAt > 0 &&
    Date.now() - warmupSettledAt <= STARTUP_STABILIZATION_WINDOW_MS
  ) {
    return STARTUP_STABILIZATION_TIMEOUT_MS;
  }

  return DEFAULT_API_TIMEOUT_MS;
}

export async function ensureAppWarmup(): Promise<void> {
  if (
    !isClientRuntime() ||
    isDesktopTauriRuntime() ||
    warmupState === "ready"
  ) {
    return;
  }

  if (warmupPromise) {
    return warmupPromise;
  }

  warmupState = "pending";
  warmupPromise = fetch(STARTUP_WARMUP_ENDPOINT, {
    method: "GET",
    credentials: "include",
    cache: "no-store",
    headers: {
      "x-hybrid-starter-warmup": "1",
    },
  })
    .then((response) => {
      if (!response.ok) {
        throw new Error(`Warmup failed with ${response.status}`);
      }
      warmupState = "ready";
    })
    .catch((error) => {
      warmupState = "failed";
      console.warn("[BOOTSTRAP] App warmup failed", error);
    })
    .finally(() => {
      warmupSettledAt = Date.now();
      warmupPromise = null;
    });

  return warmupPromise;
}

export function scheduleIdleTask(task: () => void, delayMs = 0) {
  if (!isClientRuntime()) {
    return () => undefined;
  }

  type IdleWindow = Window &
    typeof globalThis & {
      requestIdleCallback?: (
        callback: () => void,
        options?: { timeout: number },
      ) => number;
      cancelIdleCallback?: (handle: number) => void;
    };

  const idleWindow = window as IdleWindow;

  if (typeof idleWindow.requestIdleCallback === "function") {
    const handle = idleWindow.requestIdleCallback(task, {
      timeout: Math.max(1_500, delayMs),
    });
    return () => {
      if (typeof idleWindow.cancelIdleCallback === "function") {
        idleWindow.cancelIdleCallback(handle);
      }
    };
  }

  const timeoutId = window.setTimeout(task, delayMs);
  return () => window.clearTimeout(timeoutId);
}
