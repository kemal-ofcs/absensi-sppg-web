import { Suspense } from "react";
import RunDetailClient from "./RunDetailClient";

export default function PayrollRunDetailPage() {
  return (
    <Suspense
      fallback={
        <div className="flex h-screen items-center justify-center bg-slate-950 text-slate-400">
          Memuat...
        </div>
      }
    >
      <RunDetailClient />
    </Suspense>
  );
}
