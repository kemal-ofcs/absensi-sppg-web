export type SyncOrder = {
  id: string;
  version: number;
  hlc: string | null;
  updated_at: number;
};

function compareNumber(left: number, right: number) {
  return left === right ? 0 : left > right ? 1 : -1;
}

function compareString(left: string, right: string) {
  return left === right ? 0 : left > right ? 1 : -1;
}

export function compareSyncOrder(left: SyncOrder, right: SyncOrder) {
  const version = compareNumber(left.version, right.version);
  if (version !== 0) return version;

  const hlc = compareString(left.hlc ?? "", right.hlc ?? "");
  if (hlc !== 0) return hlc;

  const updatedAt = compareNumber(left.updated_at, right.updated_at);
  if (updatedAt !== 0) return updatedAt;

  return compareString(left.id, right.id);
}

function sanitizeNodeId(nodeId: string) {
  const normalized = nodeId.toLowerCase().replace(/[^a-z0-9-]/g, "");
  return (normalized || "device").slice(0, 24);
}

export function nextHlc(params: {
  last?: string | null;
  nodeId: string;
  now?: number;
}) {
  const now = Math.max(0, Math.floor(params.now ?? Date.now()));
  const lastMatch = params.last?.match(/^(\d{13})-(\d{6})-/);
  const lastTime = lastMatch ? Number(lastMatch[1]) : 0;
  const lastCounter = lastMatch ? Number(lastMatch[2]) : 0;
  const timestamp = Math.max(now, lastTime);
  const counter = timestamp === lastTime ? lastCounter + 1 : 0;

  return `${String(timestamp).padStart(13, "0")}-${String(counter).padStart(6, "0")}-${sanitizeNodeId(params.nodeId)}`;
}
