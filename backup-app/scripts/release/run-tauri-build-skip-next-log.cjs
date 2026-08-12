const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const logPath = path.join(process.cwd(), "tauri-build-latest.log");
const logStream = fs.createWriteStream(logPath, { flags: "w" });

const env = {
  ...process.env,
  HYBRID_STARTER_SKIP_NEXT_BUILD: "1",
};

const child = spawn("bun", ["tauri", "build"], {
  cwd: process.cwd(),
  env,
  stdio: ["ignore", "pipe", "pipe"],
});

child.stdout.on("data", (chunk) => {
  process.stdout.write(chunk);
  logStream.write(chunk);
});

child.stderr.on("data", (chunk) => {
  process.stderr.write(chunk);
  logStream.write(chunk);
});

child.on("close", (code) => {
  logStream.end(() => {
    process.exit(code ?? 1);
  });
});

child.on("error", (error) => {
  const message = `[run-tauri-build-skip-next-log] ${error.stack ?? error.message}\n`;
  process.stderr.write(message);
  logStream.write(message);
  logStream.end(() => {
    process.exit(1);
  });
});
