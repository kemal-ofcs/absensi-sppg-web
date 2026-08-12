import { isTauri } from "@/core/env";
import { STARTUP_HEALTH_ENDPOINT } from "@/lib/runtime/app-bootstrap";

export type DesktopRuntimeBootstrapConfig = {
  strategy: string;
  loopbackHost: string;
  preferredPort: number;
  healthPath: string;
  warmupPath: string;
  expectedRuntime: string;
  releaseReady: boolean;
};

export type DesktopRuntimeBootstrapHealth = {
  ok: boolean;
  statusCode: number | null;
  url: string;
  message: string;
};

export type DesktopRuntimeBootstrapEnsureResult = {
  ok: boolean;
  phase: string;
  action: string;
  message: string;
  config: DesktopRuntimeBootstrapConfig;
  health: DesktopRuntimeBootstrapHealth;
};

export async function getDesktopRuntimeBootstrapConfig(): Promise<DesktopRuntimeBootstrapConfig | null> {
  if (!isTauri()) {
    return null;
  }

  const { invoke } = await import("@tauri-apps/api/core");
  const result = await invoke<{
    strategy: string;
    loopback_host: string;
    preferred_port: number;
    health_path: string;
    warmup_path: string;
    expected_runtime: string;
    release_ready: boolean;
  }>("get_runtime_bootstrap_config");

  return {
    strategy: result.strategy,
    loopbackHost: result.loopback_host,
    preferredPort: result.preferred_port,
    healthPath: result.health_path || STARTUP_HEALTH_ENDPOINT,
    warmupPath: result.warmup_path,
    expectedRuntime: result.expected_runtime,
    releaseReady: result.release_ready,
  };
}

export async function probeDesktopRuntimeBootstrapHealth(): Promise<DesktopRuntimeBootstrapHealth | null> {
  if (!isTauri()) {
    return null;
  }

  const { invoke } = await import("@tauri-apps/api/core");
  const result = await invoke<{
    ok: boolean;
    status_code?: number | null;
    url: string;
    message: string;
  }>("probe_runtime_bootstrap_health");

  return {
    ok: result.ok,
    statusCode: result.status_code ?? null,
    url: result.url,
    message: result.message,
  };
}

export async function ensureDesktopRuntimeBootstrapReady(): Promise<DesktopRuntimeBootstrapEnsureResult | null> {
  if (!isTauri()) {
    return null;
  }

  const { invoke } = await import("@tauri-apps/api/core");
  const result = await invoke<{
    ok: boolean;
    phase: string;
    action: string;
    message: string;
    config: {
      strategy: string;
      loopback_host: string;
      preferred_port: number;
      health_path: string;
      warmup_path: string;
      expected_runtime: string;
      release_ready: boolean;
    };
    health: {
      ok: boolean;
      status_code?: number | null;
      url: string;
      message: string;
    };
  }>("ensure_runtime_bootstrap_ready");

  return {
    ok: result.ok,
    phase: result.phase,
    action: result.action,
    message: result.message,
    config: {
      strategy: result.config.strategy,
      loopbackHost: result.config.loopback_host,
      preferredPort: result.config.preferred_port,
      healthPath: result.config.health_path || STARTUP_HEALTH_ENDPOINT,
      warmupPath: result.config.warmup_path,
      expectedRuntime: result.config.expected_runtime,
      releaseReady: result.config.release_ready,
    },
    health: {
      ok: result.health.ok,
      statusCode: result.health.status_code ?? null,
      url: result.health.url,
      message: result.health.message,
    },
  };
}
