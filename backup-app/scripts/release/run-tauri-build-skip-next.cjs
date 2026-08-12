const { spawnSync } = require("node:child_process");

const env = {
  ...process.env,
  HYBRID_STARTER_SKIP_NEXT_BUILD: "1",
};

const result = spawnSync("bun", ["tauri", "build"], {
  cwd: process.cwd(),
  stdio: "inherit",
  env,
});

process.exit(result.status ?? 1);
