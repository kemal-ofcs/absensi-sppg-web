import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";

function collectTests(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return collectTests(path);
    return entry.isFile() &&
      (entry.name.endsWith(".test.ts") || entry.name.endsWith(".test.tsx"))
      ? [path]
      : [];
  });
}

const tests = collectTests(join(process.cwd(), "src"));

if (tests.length === 0) {
  throw new Error("Tidak ada file test aplikasi utama yang ditemukan.");
}

for (const test of tests) {
  const result = spawnSync(process.execPath, ["test", test], {
    cwd: process.cwd(),
    stdio: "inherit",
  });

  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
