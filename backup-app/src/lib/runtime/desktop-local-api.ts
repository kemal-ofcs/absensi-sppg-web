import { z } from "zod";
import { login } from "@/lib/auth/service";
import {
  apiError,
  apiOk,
  type DesktopApiResponse,
} from "@/lib/runtime/desktop-route-response";
import { useStore } from "@/lib/store/use-store";

const loginSchema = z.object({
  identifier: z.string().trim().min(1).max(254),
  password: z.string().min(1).max(256),
});

export async function handleDesktopLocalApiRequest(
  input: string,
  init?: { method?: string; body?: unknown },
): Promise<DesktopApiResponse> {
  const url = new URL(input, "http://desktop.local");
  const method = init?.method?.toUpperCase() || "GET";

  if (url.pathname === "/api/auth/login" && method === "POST") {
    const parsed = loginSchema.safeParse(init?.body);
    if (!parsed.success)
      return apiError("Invalid login payload", 400, "VALIDATION_ERROR");
    const result = await login(parsed.data.identifier, parsed.data.password);
    if (!result.success) {
      return apiOk({ success: false, error: "INVALID_CREDENTIALS" });
    }
    useStore.getState().login(result.user);
    return apiOk({ success: true, user: result.user });
  }

  if (url.pathname === "/api/auth/logout" && method === "POST") {
    useStore.getState().logout();
    return apiOk({ success: true });
  }

  return null;
}
