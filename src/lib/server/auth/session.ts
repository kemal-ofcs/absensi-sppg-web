import "server-only";

import type { OperatorUser } from "@/lib/auth/operator-user";
import {
  type CreatedWebSession,
  createSessionRecord,
  readSessionRecord,
  revokeSessionRecord,
} from "@/lib/auth/session-store";
import {
  ensureServerDatabaseInitialized,
  getServerDatabase,
} from "@/lib/server/db";

export type { CreatedWebSession } from "@/lib/auth/session-store";

export async function createWebSession(
  operator: OperatorUser,
  userAgent?: string | null,
): Promise<CreatedWebSession> {
  await ensureServerDatabaseInitialized();
  return createSessionRecord(getServerDatabase(), operator, userAgent);
}

export async function readWebSession(
  token: string,
): Promise<OperatorUser | null> {
  if (!token) return null;
  await ensureServerDatabaseInitialized();
  return readSessionRecord(getServerDatabase(), token);
}

export async function revokeWebSession(token: string, reason = "logout") {
  if (!token) return;
  await ensureServerDatabaseInitialized();
  await revokeSessionRecord(getServerDatabase(), token, reason);
}
