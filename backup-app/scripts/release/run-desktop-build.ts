import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";

type DesktopRuntimeConfig = {
  host: string;
  port: number;
  nodeBinary: string;
  serverEntrypoint: string;
  appDir: string;
  bundleArchive: string;
  bundleVersion: string;
  env: Record<string, string>;
};

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 3310;
const DESKTOP_RUNTIME_DIR = resolve(
  process.cwd(),
  "src-tauri",
  "desktop-runtime",
);
const DESKTOP_RUNTIME_STAGING_ROOT = resolve(
  process.cwd(),
  ".desktop-runtime-staging",
);
const tsconfigPath = resolve(process.cwd(), "tsconfig.json");
const nextEnvPath = resolve(process.cwd(), "next-env.d.ts");
const SHOULD_SKIP_NEXT_BUILD = (() => {
  const value =
    process.env.HYBRID_STARTER_SKIP_NEXT_BUILD?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
})();

function readText(relativePath: string) {
  return readFileSync(resolve(process.cwd(), relativePath), "utf8");
}

function getNodeMajorVersion(): number {
  const [major] = process.versions.node.split(".");
  const parsed = Number.parseInt(major ?? "0", 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function sanitizeNodeOptions(
  input: string | undefined,
  storageFile: string,
): string {
  const tokens = (input ?? "")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean);

  let hasLocalStorageOption = false;
  const sanitizedTokens: string[] = [];

  for (const token of tokens) {
    if (token === "--localstorage-file") {
      hasLocalStorageOption = true;
      continue;
    }

    if (token.startsWith("--localstorage-file=")) {
      hasLocalStorageOption = true;
      const value = token.slice("--localstorage-file=".length).trim();
      if (value.length > 0) {
        sanitizedTokens.push(token);
      }
      continue;
    }

    sanitizedTokens.push(token);
  }

  if (!hasLocalStorageOption) {
    sanitizedTokens.push(`--localstorage-file=${storageFile}`);
  } else if (
    !sanitizedTokens.some((token) => token.startsWith("--localstorage-file="))
  ) {
    sanitizedTokens.push(`--localstorage-file=${storageFile}`);
  }

  return sanitizedTokens.join(" ");
}

function failSecure(message: string): never {
  console.error(message);
  process.exit(1);
}

function resetNextBuildOutput() {
  rmSync(resolve(process.cwd(), ".next"), {
    recursive: true,
    force: true,
    maxRetries: 3,
  });
}

function formatTsconfigJson(tsconfig: unknown) {
  return `${JSON.stringify(tsconfig, null, 2)
    .replace(
      /"lib": \[\n\s+"dom",\n\s+"dom\.iterable",\n\s+"esnext"\n\s+\]/,
      '"lib": ["dom", "dom.iterable", "esnext"]',
    )
    .replace(/"@\/\*": \[\n\s+"\.\/src\/\*"\n\s+\]/, '"@/*": ["./src/*"]')
    .replace(
      /"exclude": \[\n\s+"node_modules",\n\s+"src-tauri",\n\s+"\.next\/dev\/types"\n\s+\]/,
      '"exclude": ["node_modules", "src-tauri", ".next/dev/types"]',
    )}\n`;
}

function normalizeNextTypegenConfig() {
  const tsconfig = JSON.parse(readFileSync(tsconfigPath, "utf8")) as {
    include?: string[];
    exclude?: string[];
  };

  tsconfig.include = (tsconfig.include ?? []).filter(
    (entry) => entry !== ".next/dev/types/**/*.ts",
  );

  const exclude = new Set(tsconfig.exclude ?? []);
  exclude.add(".next/dev/types");
  tsconfig.exclude = [...exclude];

  writeFileSync(tsconfigPath, formatTsconfigJson(tsconfig));

  const currentNextEnv = readFileSync(nextEnvPath, "utf8");
  const normalizedNextEnv = currentNextEnv.replace(
    /import\s+["']\.\/\.next\/dev\/types\/routes\.d\.ts["'];?/,
    'import "./.next/types/routes.d.ts";',
  );

  if (normalizedNextEnv !== currentNextEnv) {
    writeFileSync(nextEnvPath, normalizedNextEnv);
  }
}

function waitForPath(path: string, timeoutMs: number, stepMs = 1_000) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (existsSync(path)) {
      return true;
    }

    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, stepMs);
  }

  return existsSync(path);
}

function waitForStandaloneArtifacts(timeoutMs = 180_000) {
  const standaloneDir = resolve(process.cwd(), ".next", "standalone");
  const standaloneServer = resolve(standaloneDir, "server.js");
  const requiredServerFiles = resolve(
    process.cwd(),
    ".next",
    "required-server-files.json",
  );
  const staticDir = resolve(process.cwd(), ".next", "static");

  const ready =
    waitForPath(requiredServerFiles, timeoutMs) &&
    waitForPath(staticDir, timeoutMs) &&
    waitForPath(standaloneDir, timeoutMs) &&
    waitForPath(standaloneServer, timeoutMs);

  if (!ready) {
    failSecure(
      [
        "[HYBRID_STARTER_DESKTOP_BUILD_BLOCKED]",
        "Artefak standalone Next.js tidak muncul tepat waktu setelah build selesai.",
        "Build web tampak selesai, tetapi file wajib desktop runtime belum stabil di .next.",
        "Coba ulangi build desktop setelah memastikan tidak ada proses lain yang mereset .next.",
      ].join("\n"),
    );
  }
}

function shouldUseWebpackBuild(env: NodeJS.ProcessEnv) {
  return env.HYBRID_STARTER_NEXT_BUILD_WEBPACK === "1";
}

function runNextBuild() {
  if (SHOULD_SKIP_NEXT_BUILD) {
    console.log(
      "[HYBRID_STARTER_DESKTOP_BUILD] Skipping Next build and using the existing .next artifact.",
    );
    return;
  }

  const env = { ...process.env };
  const nodeMajor = getNodeMajorVersion();
  resetNextBuildOutput();
  if (nodeMajor >= 22) {
    const localStorageDir = resolve(process.cwd(), ".next");
    mkdirSync(localStorageDir, { recursive: true });
    const localStorageFile = resolve(localStorageDir, "node-localstorage");
    env.NODE_OPTIONS = sanitizeNodeOptions(env.NODE_OPTIONS, localStorageFile);
  }

  const nextBin = resolve(
    process.cwd(),
    "node_modules",
    "next",
    "dist",
    "bin",
    "next",
  );
  const runtimeBinary = basename(process.execPath).toLowerCase().includes("bun")
    ? "node"
    : process.execPath;
  const args = [
    nextBin,
    "build",
    ...(shouldUseWebpackBuild(env) ? ["--webpack"] : []),
  ];
  const result = spawnSync(runtimeBinary, args, {
    cwd: process.cwd(),
    stdio: "inherit",
    env,
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }

  normalizeNextTypegenConfig();
  waitForStandaloneArtifacts();
}

function readPackageVersion() {
  const packageJson = JSON.parse(readText("package.json")) as {
    version?: string;
  };
  return packageJson.version?.trim() || "0.1.0";
}

function prepareDesktopRuntimeConfig(): DesktopRuntimeConfig {
  const version =
    process.env.NEXT_PUBLIC_APP_VERSION?.trim() || readPackageVersion();
  const nodeBinary = basename(process.execPath);
  const appOrigin = `http://${DEFAULT_HOST}:${DEFAULT_PORT}`;
  const bundleArchiveName = "runtime-bundle.tar";

  return {
    host: DEFAULT_HOST,
    port: DEFAULT_PORT,
    nodeBinary,
    serverEntrypoint: "app/server.js",
    appDir: "app",
    bundleArchive: bundleArchiveName,
    bundleVersion: `${version}-pending`,
    env: {
      NODE_ENV: "production",
      HOSTNAME: DEFAULT_HOST,
      PORT: String(DEFAULT_PORT),
      AUTH_TRUST_HOST: "true",
      AUTH_URL: appOrigin,
      NEXTAUTH_URL: appOrigin,
      NEXT_PUBLIC_APP_VERSION: version,
      HYBRID_STARTER_DESKTOP_RUNTIME: "embedded-local-web-server",
      HYBRID_STARTER_DESKTOP_RELEASE_CHANNEL:
        process.env.HYBRID_STARTER_DESKTOP_RELEASE_CHANNEL?.trim() ||
        "production-candidate",
    },
  };
}

function hashText(input: string) {
  return createHash("sha256").update(input).digest("hex");
}

function hashFile(path: string) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function buildDesktopBundleVersion(
  config: DesktopRuntimeConfig,
  archivePath: string,
) {
  const appVersion = config.env.NEXT_PUBLIC_APP_VERSION || readPackageVersion();
  const archiveHash = hashFile(archivePath).slice(0, 12);
  const configHash = hashText(
    JSON.stringify({
      host: config.host,
      port: config.port,
      nodeBinary: config.nodeBinary,
      serverEntrypoint: config.serverEntrypoint,
      appDir: config.appDir,
      bundleArchive: config.bundleArchive,
      env: config.env,
    }),
  ).slice(0, 12);

  return `${appVersion}-${archiveHash}-${configHash}`;
}

function ensureStandaloneArtifacts() {
  const standaloneDir = resolve(process.cwd(), ".next", "standalone");
  const standaloneServer = resolve(standaloneDir, "server.js");
  const staticDir = resolve(process.cwd(), ".next", "static");

  if (!existsSync(standaloneDir) || !existsSync(standaloneServer)) {
    failSecure(
      [
        "[HYBRID_STARTER_DESKTOP_BUILD_BLOCKED]",
        "Output standalone Next.js belum ditemukan di .next/standalone.",
        'Pastikan next.config.ts mengaktifkan `output: "standalone"` dan build web berhasil penuh.',
      ].join("\n"),
    );
  }

  if (!existsSync(staticDir)) {
    failSecure(
      [
        "[HYBRID_STARTER_DESKTOP_BUILD_BLOCKED]",
        "Asset .next/static tidak ditemukan setelah build.",
        "Desktop packaged runtime membutuhkan asset ini agar kontrak App Router tetap utuh.",
      ].join("\n"),
    );
  }
}

function ensureRuntimeHostExecutable() {
  if (!existsSync(process.execPath)) {
    failSecure(
      [
        "[HYBRID_STARTER_DESKTOP_BUILD_BLOCKED]",
        `Executable host runtime tidak ditemukan di ${process.execPath}.`,
        "Desktop packaged runtime tidak boleh dibangun tanpa executable untuk server embedded.",
      ].join("\n"),
    );
  }

  const stats = statSync(process.execPath);
  if (!stats.isFile()) {
    failSecure(
      [
        "[HYBRID_STARTER_DESKTOP_BUILD_BLOCKED]",
        `Host runtime executable tidak valid: ${process.execPath}.`,
      ].join("\n"),
    );
  }
}

function copyIfExists(source: string, target: string) {
  if (!existsSync(source)) {
    return;
  }

  cpSync(source, target, { recursive: true, dereference: true, force: true });
}

function pruneDesktopRuntimeBundles() {
  if (!existsSync(DESKTOP_RUNTIME_DIR)) {
    return;
  }

  for (const entry of readdirSync(DESKTOP_RUNTIME_DIR, {
    withFileTypes: true,
  })) {
    if (!entry.isFile()) {
      continue;
    }

    const shouldDelete =
      entry.name === "runtime-bundle.tar" ||
      /^runtime-bundle-\d+\.tar$/u.test(entry.name);

    if (!shouldDelete) {
      continue;
    }

    try {
      rmSync(join(DESKTOP_RUNTIME_DIR, entry.name), {
        force: true,
        maxRetries: 3,
      });
    } catch (error) {
      const errorCode =
        error instanceof Error && "code" in error
          ? String(error.code)
          : "UNKNOWN";

      if (errorCode === "EBUSY" || errorCode === "EPERM") {
        console.warn(
          `[HYBRID_STARTER_DESKTOP_BUILD] Skipping a locked previous bundle: ${entry.name}`,
        );
        continue;
      }

      throw error;
    }
  }
}

function resolveTarBinary() {
  const explicitPath = process.env.SystemRoot
    ? join(process.env.SystemRoot, "System32", "tar.exe")
    : null;

  if (explicitPath && existsSync(explicitPath)) {
    return explicitPath;
  }

  return "tar";
}

function runTarArchive(stagingDir: string, archivePath: string) {
  const tarBinary = resolveTarBinary();
  const result = spawnSync(
    tarBinary,
    ["-cf", archivePath, "-C", stagingDir, "."],
    {
      cwd: process.cwd(),
      stdio: "inherit",
      env: process.env,
    },
  );

  if (result.status !== 0) {
    failSecure(
      [
        "[HYBRID_STARTER_DESKTOP_BUILD_BLOCKED]",
        "Gagal membuat archive runtime desktop.",
        "Pastikan utilitas `tar` tersedia di environment Windows ini.",
      ].join("\n"),
    );
  }
}

function prepareDesktopRuntimeBundle(config: DesktopRuntimeConfig) {
  ensureStandaloneArtifacts();
  ensureRuntimeHostExecutable();

  const stagingDir = join(DESKTOP_RUNTIME_STAGING_ROOT, `bundle-${Date.now()}`);
  const runtimeAppDir = join(stagingDir, config.appDir);
  const standaloneDir = resolve(process.cwd(), ".next", "standalone");
  const staticDir = resolve(process.cwd(), ".next", "static");
  const publicDir = resolve(process.cwd(), "public");
  const archivePath = join(DESKTOP_RUNTIME_DIR, config.bundleArchive);
  const archiveTempPath = join(DESKTOP_RUNTIME_DIR, "runtime-bundle.next.tar");

  mkdirSync(runtimeAppDir, { recursive: true });
  mkdirSync(DESKTOP_RUNTIME_DIR, { recursive: true });
  pruneDesktopRuntimeBundles();

  cpSync(standaloneDir, runtimeAppDir, {
    recursive: true,
    dereference: true,
    force: true,
  });
  mkdirSync(join(runtimeAppDir, ".next"), { recursive: true });
  cpSync(staticDir, join(runtimeAppDir, ".next", "static"), {
    recursive: true,
    dereference: true,
    force: true,
  });
  copyIfExists(publicDir, join(runtimeAppDir, "public"));
  cpSync(process.execPath, join(stagingDir, config.nodeBinary));

  runTarArchive(stagingDir, archiveTempPath);
  replaceRuntimeArchive(archiveTempPath, archivePath);
  config.bundleVersion = buildDesktopBundleVersion(config, archivePath);
  try {
    rmSync(stagingDir, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    console.warn(
      `[HYBRID_STARTER_DESKTOP_BUILD] Unable to clean staging dir ${stagingDir}; it will be ignored on the next run.`,
    );
  }

  writeFileSync(
    join(DESKTOP_RUNTIME_DIR, "runtime-config.json"),
    `${JSON.stringify(config, null, 2)}\n`,
    "utf8",
  );
}

function stabilizeRuntimeBundle(delayMs = 1_500) {
  // Windows can briefly keep fresh native addon copies busy right after cpSync.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
}

function waitBriefly(delayMs = 1_000) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
}

function isWindowsLockError(error: unknown) {
  if (!(error instanceof Error) || !("code" in error)) {
    return false;
  }

  const code = String(error.code);
  return code === "EBUSY" || code === "EPERM";
}

function replaceRuntimeArchive(tempPath: string, targetPath: string) {
  const maxAttempts = 5;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      rmSync(targetPath, { force: true, maxRetries: 3 });
      renameSync(tempPath, targetPath);
      return;
    } catch (error) {
      if (!isWindowsLockError(error) || attempt === maxAttempts) {
        failSecure(
          [
            "[HYBRID_STARTER_DESKTOP_BUILD_BLOCKED]",
            `Gagal mengganti artefak runtime desktop stabil di ${targetPath}.`,
            "File kemungkinan masih dikunci oleh Explorer, antivirus, atau proses build/installer lain.",
            "Tutup proses yang memakai artefak runtime/MSI lama, lalu jalankan ulang `bun run build:desktop`.",
          ].join("\n"),
        );
      }

      console.warn(
        `[HYBRID_STARTER_DESKTOP_BUILD] Runtime artifact is locked; retry ${attempt}/${maxAttempts}...`,
      );
      waitBriefly(1_500);
    }
  }
}

function assertBootstrapShellExists() {
  const bootstrapIndex = resolve(
    process.cwd(),
    "src-tauri",
    "bootstrap",
    "index.html",
  );
  if (!existsSync(bootstrapIndex)) {
    failSecure(
      [
        "[HYBRID_STARTER_DESKTOP_BUILD_BLOCKED]",
        "Bootstrap shell src-tauri/bootstrap/index.html tidak ditemukan.",
        "Window Tauri production harus punya startup shell yang jujur sebelum loopback siap.",
      ].join("\n"),
    );
  }
}

function validateTauriConfig() {
  const tauriConfigText = readText("src-tauri/tauri.conf.json");
  const usesBootstrapShell = tauriConfigText.includes(
    '"frontendDist": "bootstrap"',
  );
  const bundlesStableRuntimeArtifacts =
    tauriConfigText.includes("desktop-runtime/runtime-bundle.tar") &&
    tauriConfigText.includes("desktop-runtime/runtime-config.json");

  if (!usesBootstrapShell || !bundlesStableRuntimeArtifacts) {
    failSecure(
      [
        "[HYBRID_STARTER_DESKTOP_BUILD_BLOCKED]",
        "src-tauri/tauri.conf.json belum menunjuk bootstrap shell dan resource desktop-runtime yang benar.",
        'Expected frontendDist "bootstrap" and stable bundle.resources entries for "desktop-runtime/runtime-bundle.tar" and "desktop-runtime/runtime-config.json".',
      ].join("\n"),
    );
  }
}

function main() {
  runNextBuild();
  assertBootstrapShellExists();
  validateTauriConfig();

  const config = prepareDesktopRuntimeConfig();
  prepareDesktopRuntimeBundle(config);
  stabilizeRuntimeBundle();

  console.log(
    [
      "[HYBRID_STARTER_DESKTOP_BUILD_READY]",
      `Desktop runtime bundle siap di ${DESKTOP_RUNTIME_DIR}.`,
      `Loopback origin: http://${config.host}:${config.port}`,
      "Status saat ini: desktop packaged production candidate, belum otomatis release-final sampai smoke artifact nyata lulus.",
    ].join("\n"),
  );
}

main();
