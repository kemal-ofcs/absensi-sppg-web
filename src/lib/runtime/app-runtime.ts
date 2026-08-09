export function isDesktopRuntime() {
  if (process.env.NEXT_PUBLIC_SPPG_RUNTIME === "desktop") return true;
  return (
    typeof window !== "undefined" &&
    "__TAURI_INTERNALS__" in (window as unknown as Record<string, unknown>)
  );
}
