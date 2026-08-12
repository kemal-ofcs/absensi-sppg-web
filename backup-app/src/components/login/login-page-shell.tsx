import { Suspense } from "react";
import { LoginForm } from "@/components/login/login-form";
import { PRODUCT_CONFIG } from "@/config/product";

export function LoginPageShell() {
  return (
    <main className="relative flex min-h-screen items-center justify-center overflow-hidden bg-zinc-950 px-4">
      <div className="absolute inset-0 bg-[linear-gradient(to_right,#80808012_1px,transparent_1px),linear-gradient(to_bottom,#80808012_1px,transparent_1px)] bg-[size:24px_24px]" />
      <div className="absolute inset-x-0 top-0 mx-auto h-80 w-80 rounded-full bg-cyan-500/15 blur-[110px]" />
      <div className="relative z-10 flex w-full flex-col items-center gap-7">
        <div className="space-y-2 text-center">
          <h1 className="text-4xl font-bold tracking-tight text-white">
            {PRODUCT_CONFIG.name}
          </h1>
          <p className="text-sm text-zinc-400">
            Local-first desktop and cloud starter
          </p>
        </div>
        <Suspense fallback={<div className="h-[26rem] w-full max-w-sm" />}>
          <LoginForm />
        </Suspense>
        <p className="font-mono text-xs text-zinc-600">
          v{PRODUCT_CONFIG.version} · Hybrid runtime foundation
        </p>
      </div>
    </main>
  );
}
