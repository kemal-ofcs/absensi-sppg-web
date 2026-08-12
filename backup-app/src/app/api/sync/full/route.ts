import type { NextRequest } from "next/server";
import { handleSyncAction } from "@/lib/sync/route-handler";

export const dynamic = "force-dynamic";

export function POST(request: NextRequest) {
  return handleSyncAction(request, "full");
}
