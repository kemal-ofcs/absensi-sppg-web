import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { verifyPassword } from "@/lib/auth/hash";
import {
  buildLoginEmailCandidates,
  normalizeLoginIdentifier,
} from "@/lib/auth/web/login-identifier";
import { getDb } from "@/lib/db";
import { type User, users } from "@/lib/db/schema";

export type AuthResult =
  | { success: true; user: Omit<User, "passwordHash"> }
  | { success: false; error: string };

export async function login(
  rawIdentifier: string,
  password: string,
): Promise<AuthResult> {
  const identifier = normalizeLoginIdentifier(rawIdentifier);
  const emailCandidates = buildLoginEmailCandidates(identifier);
  if (!identifier || !password || emailCandidates.length === 0) {
    return { success: false, error: "Email/username atau password salah" };
  }

  try {
    const db = await getDb();
    const result = await db
      .select()
      .from(users)
      .where(
        and(
          or(
            inArray(users.email, emailCandidates),
            eq(users.username, identifier),
          ),
          eq(users.isActive, true),
          isNull(users.deletedAt),
        ),
      )
      .limit(1);

    const user = result[0];
    if (!user?.passwordHash) {
      return { success: false, error: "Email/username atau password salah" };
    }

    const valid = user.passwordHash.startsWith("$argon2")
      ? await verifyPassword(password, user.passwordHash)
      : password === user.passwordHash;
    if (!valid) {
      return { success: false, error: "Email/username atau password salah" };
    }

    const loginAt = new Date();
    await db
      .update(users)
      .set({ lastLoginAt: loginAt, updatedAt: loginAt, syncStatus: "pending" })
      .where(eq(users.id, user.id));

    const { passwordHash: _passwordHash, ...safeUser } = user;
    return { success: true, user: { ...safeUser, lastLoginAt: loginAt } };
  } catch (error) {
    console.error("[DESKTOP_AUTH] Login failed", error);
    return { success: false, error: "Login lokal gagal diproses" };
  }
}
