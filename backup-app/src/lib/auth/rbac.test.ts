import { describe, expect, it } from "vitest";
import { checkPermission, getUserRole } from "@/lib/auth/rbac";

describe("generic RBAC", () => {
  it("reads roles from web and desktop session shapes", () => {
    expect(getUserRole({ role: "cashier" })).toBe("cashier");
    expect(getUserRole({ user: { role: "admin" } })).toBe("admin");
  });

  it("denies unknown roles and grants configured permissions", () => {
    expect(getUserRole({ role: "legacy_role" })).toBeNull();
    expect(checkPermission({ role: "admin" }, "sync:run")).toBe(true);
    expect(checkPermission({ role: "viewer" }, "sync:run")).toBe(false);
  });
});
