import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

function collectRouteFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) return collectRouteFiles(fullPath);
    return entry.isFile() && entry.name === "route.ts" ? [fullPath] : [];
  });
}

describe("Next.js Static Export Compatibility Guard (Tauri v2)", () => {
  test("seluruh route handler di src/app/api TIDAK boleh mengekspor method GET (wajib POST/PUT/PATCH/DELETE)", () => {
    const apiDir = join(process.cwd(), "src", "app", "api");
    const routeFiles = collectRouteFiles(apiDir);
    expect(routeFiles.length).toBeGreaterThan(0);

    const violatingFiles: string[] = [];

    for (const file of routeFiles) {
      const content = readFileSync(file, "utf-8");
      // Cek apakah ada export async function GET atau export function GET atau export const GET
      if (
        /export\s+(async\s+)?function\s+GET\b/.test(content) ||
        /export\s+const\s+GET\b/.test(content)
      ) {
        violatingFiles.push(file);
      }
    }

    expect(violatingFiles).toEqual([]);
  });
});
