"use client";

import { Cloud, RefreshCw, Save, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { isTauri } from "@/core/env";
import { useAuth } from "@/hooks/use-auth";
import { getSyncStatus, runFullSync } from "@/lib/sync/actions";
import type { SyncResult, SyncStatusResult } from "@/lib/sync/types";

type NativeSyncConfigStatus = {
  configured: boolean;
  url: string;
  tokenHint: string | null;
};

export function SyncPanel() {
  const { user } = useAuth();
  const [nativeConfig, setNativeConfig] =
    useState<NativeSyncConfigStatus | null>(null);
  const [runtimeStatus, setRuntimeStatus] = useState<SyncStatusResult | null>(
    null,
  );
  const [lastResult, setLastResult] = useState<SyncResult | null>(null);
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);

  const loadNativeConfig = useCallback(async () => {
    if (!isTauri()) return;
    const { invoke } = await import("@tauri-apps/api/core");
    const config = await invoke<NativeSyncConfigStatus>("get_sync_config");
    setNativeConfig(config);
    if (config.url) setUrl(config.url);
  }, []);

  const loadRuntimeStatus = useCallback(async () => {
    try {
      setRuntimeStatus(await getSyncStatus());
    } catch (error) {
      console.warn("[SYNC_STATUS] Embedded sync runtime is not ready.", error);
      setRuntimeStatus(null);
    }
  }, []);

  useEffect(() => {
    if (!isTauri()) return;
    void loadNativeConfig();
    void loadRuntimeStatus();
  }, [loadNativeConfig, loadRuntimeStatus]);

  async function saveConfig() {
    setSaving(true);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("set_sync_config", {
        request: {
          url: url.trim(),
          authToken: token.trim(),
          userId: user?.id ?? "",
          currentPassword,
        },
      });
      setToken("");
      setCurrentPassword("");
      await loadNativeConfig();
      toast.success(
        "Konfigurasi Turso disimpan aman. Restart aplikasi untuk mengaktifkan sync.",
      );
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : String(error || "Save failed"),
      );
    } finally {
      setSaving(false);
    }
  }

  async function syncNow() {
    setSyncing(true);
    try {
      const result = await runFullSync();
      setLastResult(result);
      toast.success(result.message);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Sync failed");
    } finally {
      await loadRuntimeStatus();
      setSyncing(false);
    }
  }

  if (!isTauri()) return null;

  return (
    <Card className="border-zinc-800 bg-zinc-900 text-zinc-100">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ShieldCheck className="h-5 w-5 text-cyan-400" />
          Secure cloud sync
        </CardTitle>
        <CardDescription className="text-zinc-400">
          SQLite remains the desktop source of truth. Turso credentials stay in
          the OS keyring and are only used by the embedded local server.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="grid gap-4 md:grid-cols-2">
          <div className="grid gap-2">
            <Label htmlFor="sync-url">Turso database URL</Label>
            <Input
              id="sync-url"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="libsql://your-database.turso.io"
              autoComplete="off"
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="sync-token">
              Database token {nativeConfig?.tokenHint ?? ""}
            </Label>
            <Input
              id="sync-token"
              value={token}
              onChange={(event) => setToken(event.target.value)}
              placeholder="Paste a new token"
              type="password"
              autoComplete="new-password"
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="sync-admin-password">Current admin password</Label>
            <Input
              id="sync-admin-password"
              value={currentPassword}
              onChange={(event) => setCurrentPassword(event.target.value)}
              type="password"
              autoComplete="current-password"
            />
          </div>
          <div className="flex items-end">
            <Button
              onClick={() => void saveConfig()}
              disabled={
                saving ||
                !url.trim() ||
                token.trim().length < 32 ||
                !currentPassword ||
                !user?.id ||
                !["super_admin", "admin"].includes(user.role)
              }
            >
              {saving ? (
                <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Save className="mr-2 h-4 w-4" />
              )}
              Save securely
            </Button>
          </div>
        </div>

        <div className="flex flex-col gap-3 rounded-lg border border-zinc-800 bg-zinc-950/60 p-4 text-sm md:flex-row md:items-center md:justify-between">
          <div>
            <p className="font-medium">
              {runtimeStatus?.configured
                ? "Runtime sync ready"
                : nativeConfig?.configured
                  ? "Saved — restart required"
                  : "Not configured"}
            </p>
            <p className="text-zinc-400">
              {runtimeStatus?.message ??
                "Packaged desktop runtime will report pending and failed rows here."}
            </p>
            {runtimeStatus ? (
              <div className="mt-2 space-y-2 text-xs text-zinc-500">
                <p>
                  Pending: {runtimeStatus.pending} · Failed:{" "}
                  {runtimeStatus.failed}
                </p>
                <div className="flex flex-wrap gap-2">
                  {(runtimeStatus.tables ?? []).map((table) => (
                    <span
                      key={table.table}
                      className="rounded border border-zinc-800 px-2 py-1"
                    >
                      {table.table}: {table.pending} pending / {table.failed}{" "}
                      failed
                    </span>
                  ))}
                </div>
                {runtimeStatus.lastRun ? (
                  <p>
                    Last run: {runtimeStatus.lastRun.status} · upload{" "}
                    {runtimeStatus.lastRun.uploaded} · download{" "}
                    {runtimeStatus.lastRun.downloaded} · conflict{" "}
                    {runtimeStatus.lastRun.conflicts}
                  </p>
                ) : null}
                {lastResult ? (
                  <div>
                    <p className="mb-1 font-medium text-zinc-400">
                      Last sync by table
                    </p>
                    <div className="flex flex-wrap gap-2">
                      {lastResult.tables.map((table) => (
                        <span
                          key={table.table}
                          className="rounded border border-zinc-800 px-2 py-1"
                        >
                          {table.table}: ↑{table.uploaded} ↓{table.downloaded}{" "}
                          conflict {table.conflicts} / failed {table.failed}
                        </span>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
          <Button
            onClick={() => void syncNow()}
            disabled={syncing || !runtimeStatus?.configured}
          >
            {syncing ? (
              <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Cloud className="mr-2 h-4 w-4" />
            )}
            Sync now
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
