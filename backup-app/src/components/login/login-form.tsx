"use client";

import { AlertCircle, Loader2 } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/hooks/use-auth";

function safeCallbackUrl(value: string | null) {
  if (!value?.startsWith("/") || value.startsWith("//")) return "/dashboard";
  return value;
}

export function LoginForm() {
  const searchParams = useSearchParams();
  const { login } = useAuth();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError("");
    const data = new FormData(event.currentTarget);

    try {
      const result = await login(
        String(data.get("identifier") || ""),
        String(data.get("password") || ""),
      );
      if (!result.success) {
        setError(result.error);
        return;
      }
      const destination = safeCallbackUrl(searchParams.get("callbackUrl"));
      window.location.replace(destination);
    } catch (submitError) {
      console.error("[LOGIN] Unexpected failure", submitError);
      setError("Login gagal diproses. Silakan coba lagi.");
    } finally {
      setPending(false);
    }
  }

  return (
    <Card className="w-full max-w-sm border-zinc-800 bg-zinc-900/90 text-zinc-100 shadow-2xl backdrop-blur-xl">
      <CardHeader>
        <CardTitle className="text-center text-2xl">Sign in</CardTitle>
        <CardDescription className="text-center text-zinc-400">
          Use your email address or username
        </CardDescription>
      </CardHeader>
      <form onSubmit={onSubmit}>
        <CardContent className="grid gap-4">
          {error ? (
            <div className="flex gap-2 rounded-md border border-red-800 bg-red-950/40 p-3 text-sm text-red-200">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{error}</span>
            </div>
          ) : null}
          <div className="grid gap-2">
            <Label htmlFor="identifier">Email or username</Label>
            <Input
              id="identifier"
              name="identifier"
              placeholder="admin or admin@starter.local"
              autoComplete="username"
              disabled={pending}
              required
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              disabled={pending}
              required
            />
          </div>
        </CardContent>
        <CardFooter className="pt-6">
          <Button type="submit" className="w-full" disabled={pending}>
            {pending ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Signing in...
              </>
            ) : (
              "Sign in"
            )}
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
}
