import { nextHlc } from "@/lib/sync/order";

export type CurrentSyncMetadata = {
  version: number;
  hlc?: string | null;
};

export function pendingSyncMetadata(params: {
  current?: CurrentSyncMetadata | null;
  nodeId: string;
  now?: number;
}) {
  const now = Math.max(0, Math.floor(params.now ?? Date.now()));
  return {
    version: (params.current?.version ?? 0) + 1,
    hlc: nextHlc({
      last: params.current?.hlc,
      nodeId: params.nodeId,
      now,
    }),
    updatedAt: new Date(now),
    syncStatus: "pending" as const,
  };
}

export function pendingSoftDeleteMetadata(params: {
  current: CurrentSyncMetadata;
  nodeId: string;
  now?: number;
}) {
  const metadata = pendingSyncMetadata(params);
  return { ...metadata, deletedAt: metadata.updatedAt };
}
