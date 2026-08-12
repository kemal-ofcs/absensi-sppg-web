import type { NextRequest } from "next/server";
import { handleSyncStatus } from "@/lib/sync/route-handler";

export const dynamic = "force-dynamic";

export function POST(request: NextRequest) {
  return handleSyncStatus(request);
}
