export const AUTH_ROLES = [
  "super_admin",
  "admin",
  "manager",
  "staff",
  "cashier",
  "viewer",
] as const;

export type AuthRole = (typeof AUTH_ROLES)[number];

export const AUTH_ROLE_DEFAULT: AuthRole = "staff";
