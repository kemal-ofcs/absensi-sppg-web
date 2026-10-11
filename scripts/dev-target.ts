import { spawn } from "node:child_process";

export function createDesktopDevEnvironment(
  baseEnvironment: NodeJS.ProcessEnv = process.env,
) {
  return {
    ...baseEnvironment,
    NEXT_PUBLIC_SPPG_RUNTIME: "desktop",
    // WebView2 already forwards browser errors to the Tauri terminal. The
    // Next.js development overlay itself can crash inside the webview before
    // it finishes initializing ("Cannot access 'eW' before initialization").
    NEXT_PRIVATE_DISABLE_DEV_OVERLAY_UX: "1",
  };
}

if (import.meta.main) {
  const executable = process.platform === "win32" ? "bunx.exe" : "bunx";
  const child = spawn(
    executable,
    ["next", "dev", "--webpack", ...process.argv.slice(2)],
    {
      cwd: process.cwd(),
      env: createDesktopDevEnvironment(),
      stdio: "inherit",
    },
  );

  const forwardSignal = (signal: NodeJS.Signals) => {
    if (!child.killed) child.kill(signal);
  };
  const forwardInterrupt = () => forwardSignal("SIGINT");
  const forwardTermination = () => forwardSignal("SIGTERM");

  process.once("SIGINT", forwardInterrupt);
  process.once("SIGTERM", forwardTermination);

  child.once("error", (error) => {
    console.error("Development Desktop tidak dapat dijalankan:", error.message);
    process.exitCode = 1;
  });

  child.once("exit", (code) => {
    process.off("SIGINT", forwardInterrupt);
    process.off("SIGTERM", forwardTermination);
    process.exitCode = code ?? 1;
  });
}
