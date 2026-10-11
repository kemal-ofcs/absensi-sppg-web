"use client";

import { useSyncExternalStore } from "react";

const SERVER_SNAPSHOT = 0;

function subscribeToClock(onStoreChange: () => void) {
  const intervalId = window.setInterval(onStoreChange, 1000);
  return () => window.clearInterval(intervalId);
}

function getClockSnapshot() {
  return Math.floor(Date.now() / 1000);
}

export function useClock(): Date | null {
  const timestamp = useSyncExternalStore(
    subscribeToClock,
    getClockSnapshot,
    () => SERVER_SNAPSHOT,
  );

  return timestamp === SERVER_SNAPSHOT ? null : new Date(timestamp * 1000);
}
