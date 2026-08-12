import { NextResponse } from "next/server";
import { getDatabase } from "@/core/db/connection";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    if (
      process.env.HYBRID_STARTER_DESKTOP_RUNTIME !== "embedded-local-web-server"
    ) {
      await getDatabase();
    }
    return NextResponse.json({ success: true, data: { ready: true } });
  } catch (error) {
    console.error("[RUNTIME_WARMUP]", error);
    return NextResponse.json(
      { success: false, error: "APP_WARMUP_FAILED" },
      { status: 500 },
    );
  }
}
