import { NextResponse } from "next/server";
import { getDatabase } from "@/core/db/connection";

export const dynamic = "force-dynamic";

function isEmbeddedDesktop() {
  return (
    process.env.HYBRID_STARTER_DESKTOP_RUNTIME === "embedded-local-web-server"
  );
}

export async function GET() {
  try {
    if (!isEmbeddedDesktop()) await getDatabase();
    return NextResponse.json({
      success: true,
      data: {
        ok: true,
        runtime: isEmbeddedDesktop()
          ? "desktop-production-server"
          : "next-app-server",
        version: process.env.NEXT_PUBLIC_APP_VERSION || "0.1.0",
        db: isEmbeddedDesktop() ? "deferred-local-runtime" : "ready",
      },
    });
  } catch (error) {
    console.error("[RUNTIME_HEALTH]", error);
    return NextResponse.json(
      { success: false, error: "APP_RUNTIME_HEALTH_FAILED" },
      { status: 500 },
    );
  }
}
