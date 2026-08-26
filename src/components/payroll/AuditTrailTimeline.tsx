"use client";

import type { PayrollAuditLogRow } from "@/lib/gateways/payroll";

interface AuditTrailTimelineProps {
  logs: PayrollAuditLogRow[];
}

export function AuditTrailTimeline({ logs }: AuditTrailTimelineProps) {
  if (logs.length === 0) {
    return (
      <div className="py-4 text-center text-sm text-slate-500">
        Belum ada riwayat audit.
      </div>
    );
  }

  return (
    <div className="flow-root">
      <ul className="-mb-8">
        {logs.map((log, idx) => {
          const isLast = idx === logs.length - 1;
          const dateFormatted = new Date(log.created_at).toLocaleString(
            "id-ID",
            {
              day: "numeric",
              month: "short",
              year: "numeric",
              hour: "2-digit",
              minute: "2-digit",
            },
          );

          return (
            <li key={log.id}>
              <div className="relative pb-8">
                {!isLast && (
                  <span
                    className="absolute top-4 left-4 -ml-px h-full w-0.5 bg-slate-700"
                    aria-hidden="true"
                  />
                )}
                <div className="relative flex space-x-3">
                  <div>
                    <span className="h-8 w-8 rounded-full bg-slate-800 border border-slate-700 flex items-center justify-center ring-8 ring-slate-900 text-xs font-bold text-sky-400">
                      {log.new_status ? log.new_status[0] : "A"}
                    </span>
                  </div>
                  <div className="flex min-w-0 flex-1 justify-between space-x-4 pt-1.5">
                    <div>
                      <p className="text-sm font-medium text-slate-200">
                        {log.action === "CREATE_RUN"
                          ? "Batch dibuat"
                          : `Status diubah menjadi ${log.new_status}`}
                        <span className="font-normal text-slate-400 ml-1">
                          oleh{" "}
                          <strong className="text-slate-300">
                            {log.performed_by}
                          </strong>
                        </span>
                      </p>
                      {log.notes && (
                        <p className="mt-1 text-xs text-slate-400 italic bg-slate-800/60 p-2 rounded border border-slate-700/50">
                          {log.notes}
                        </p>
                      )}
                    </div>
                    <div className="whitespace-nowrap text-right text-xs text-slate-500">
                      {dateFormatted}
                    </div>
                  </div>
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
