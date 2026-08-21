"use client";

// Cached GPS state — accessible in-memory without blocking async calls
let _cached: { lat: number; lng: number } | null = null;
let _cachedAt = 0;
const CACHE_TTL_MS = 60_000; // 1 minute

function isCacheFresh(): boolean {
  return _cached !== null && Date.now() - _cachedAt < CACHE_TTL_MS;
}

/**
 * Gets current coordinates using a dual-tier strategy:
 * 1. Return from in-memory cache if fresh (< 1 minute old)
 * 2. Try high accuracy GPS (1500ms timeout)
 * 3. Fallback to network/WiFi location (2500ms timeout)
 */
export async function getCurrentCoordinates(): Promise<{
  lat: number;
  lng: number;
} | null> {
  if (isCacheFresh()) return _cached;

  if (typeof navigator === "undefined" || !navigator.geolocation) {
    return null;
  }

  const tryPosition = (highAccuracy: boolean, timeout: number) =>
    new Promise<{ lat: number; lng: number } | null>((resolve) => {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          const result = {
            lat: pos.coords.latitude,
            lng: pos.coords.longitude,
          };
          _cached = result;
          _cachedAt = Date.now();
          resolve(result);
        },
        () => resolve(null),
        { enableHighAccuracy: highAccuracy, timeout, maximumAge: 30_000 },
      );
    });

  // Tier 1: high accuracy (GPS chip) — short timeout for desktop/mobile
  const highAccResult = await tryPosition(true, 1500);
  if (highAccResult) return highAccResult;

  // Tier 2: network/WiFi location — still useful even without GPS chip
  const networkResult = await tryPosition(false, 2500);
  return networkResult;
}

/**
 * Starts a background GPS watcher that continuously refreshes the cache.
 * Returns a cleanup function to call on unmount.
 */
export function watchCoordinates(): () => void {
  if (typeof navigator === "undefined" || !navigator.geolocation) {
    return () => undefined;
  }

  const watchId = navigator.geolocation.watchPosition(
    (pos) => {
      const coords = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      _cached = coords;
      _cachedAt = Date.now();
    },
    () => undefined, // silently ignore desktop GPS failures
    { enableHighAccuracy: false, timeout: 5_000, maximumAge: 30_000 },
  );

  return () => navigator.geolocation.clearWatch(watchId);
}

/**
 * Returns cached coordinates synchronously (null if not yet available).
 * Use this inside hot paths like handleScanSubmit.
 */
export function getCachedCoordinates(): { lat: number; lng: number } | null {
  return isCacheFresh() ? _cached : null;
}
