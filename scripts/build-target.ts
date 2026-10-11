import { spawnSync } from "node:child_process";

const target = process.argv[2];

if (target !== "web" && target !== "desktop") {
  throw new Error("Target build harus 'web' atau 'desktop'.");
}

const executable = process.platform === "win32" ? "bunx.exe" : "bunx";
const result = spawnSync(executable, ["next", "build"], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    SPPG_BUILD_TARGET: target,
    NEXT_PUBLIC_SPPG_RUNTIME: target,
  },
  stdio: "inherit",
});

if (result.error) throw result.error;
process.exit(result.status ?? 1);
