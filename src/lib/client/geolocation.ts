"use client";

export function getCurrentCoordinates(): Promise<{
  lat: number;
  lng: number;
} | null> {
  return new Promise((resolve) => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      resolve(null);
      return;
    }

    navigator.geolocation.getCurrentPosition(
      (position) => {
        resolve({
          lat: position.coords.latitude,
          lng: position.coords.longitude,
        });
      },
      () => resolve(null),
      {
        enableHighAccuracy: true,
        timeout: 5_000,
        maximumAge: 0,
      },
    );
  });
}
