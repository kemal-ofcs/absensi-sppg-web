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

// Tes WAJIB terisolasi dari `.env` pengembang. Bun memuat `.env` otomatis, dan
// `KOS_DATABASE_URL` di sana mengalahkan `TURSO_DATABASE_URL` yang disetel tes
// ke berkas sementara — tes lalu menulis data uji ke database SUNGGUHAN.
// Proses ini sendiri sudah memuat `.env`, jadi kuncinya juga dibuang dari env
// anak, bukan hanya `--no-env-file`.
const isolatedEnv = { ...process.env };
for (const key of Object.keys(isolatedEnv)) {
  if (/^(KOS_DATABASE_|TURSO_|SPPG_DATABASE_PROVIDER$)/.test(key)) {
    delete isolatedEnv[key];
  }
}

for (const test of tests) {
  const result = spawnSync(
    process.execPath,
    ["test", "--no-env-file", "--timeout", "30000", test],
    {
      cwd: process.cwd(),
      env: isolatedEnv,
      stdio: "inherit",
    },
  );

  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
