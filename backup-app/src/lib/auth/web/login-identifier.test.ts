import { describe, expect, it } from "vitest";
import {
  buildLoginEmailCandidates,
  normalizeLoginIdentifier,
} from "@/lib/auth/web/login-identifier";

describe("login identifier", () => {
  it("normalizes email input", () => {
    expect(normalizeLoginIdentifier(" Admin@Example.COM ")).toBe(
      "admin@example.com",
    );
  });

  it("supports a starter-local username without school aliases", () => {
    expect(buildLoginEmailCandidates("admin")).toEqual([
      "admin",
      "admin@starter.local",
    ]);
  });
});
