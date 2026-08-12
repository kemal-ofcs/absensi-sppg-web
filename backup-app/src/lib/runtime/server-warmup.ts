import { getDatabase } from "@/core/db/connection";

let serverWarmupPromise: Promise<void> | null = null;

function isBuildPhase() {
  return (
    process.env.NEXT_PHASE === "phase-production-build" ||
    process.env.npm_lifecycle_event === "build"
  );
}

export function primeServerRuntimeWarmup() {
  if (typeof window !== "undefined") {
    return;
  }

  if (isBuildPhase()) {
    return;
  }

  if (serverWarmupPromise) {
    return;
  }

  serverWarmupPromise = getDatabase()
    .then(() => undefined)
    .catch((error) => {
      console.warn("[SERVER_WARMUP] Runtime warmup failed", error);
      serverWarmupPromise = null;
    });
}
