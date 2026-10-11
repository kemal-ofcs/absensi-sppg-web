"use client";

export const DATABASE_NOT_CONFIGURED_TITLE =
  "Server belum terhubung ke database";
export const DATABASE_NOT_CONFIGURED_DESCRIPTION =
  "Aplikasi belum bisa dipakai karena alamat databasenya belum diatur di server.";

type Props = {
  /** Alasan dari server; hanya menyebut nama variabel, bukan nilainya. */
  issue: string | null;
  onRetry: () => void;
  checking: boolean;
};

/**
 * Isi pemberitahuan saat server Web belum diberi alamat database. Dipakai
 * halaman login dan `/setup`, masing-masing di dalam bingkai kartunya sendiri.
 *
 * Khusus Web: di Desktop dan Mobile database diatur dari layar provisioning,
 * bukan dari environment server.
 */
export function DatabaseNotConfiguredNotice({
  issue,
  onRetry,
  checking,
}: Props) {
  return (
    <div className="grid gap-4">
      {issue ? (
        <p className="bootstrap-alert-warning rounded-xl border border-amber-400/30 bg-amber-950/40 p-3 text-xs leading-5 text-amber-100">
          {issue}
        </p>
      ) : null}
      <ol className="bootstrap-hint-box grid list-decimal gap-2 rounded-2xl border border-white/10 bg-slate-950/60 py-4 pl-8 pr-4 text-xs leading-5 text-slate-400">
        <li>
          Isi{" "}
          <code className="break-all font-mono font-bold">
            KOS_DATABASE_URL
          </code>{" "}
          dan{" "}
          <code className="break-all font-mono font-bold">
            KOS_DATABASE_AUTH_TOKEN
          </code>{" "}
          di environment server.
        </li>
        <li>Deploy ulang atau jalankan ulang server.</li>
        <li>Muat ulang halaman ini, atau tekan Periksa lagi.</li>
      </ol>
      <button
        type="button"
        onClick={onRetry}
        disabled={checking}
        className="bootstrap-btn-submit min-h-11 w-full rounded-2xl bg-sky-400 px-4 text-sm font-black text-slate-950 disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400"
      >
        {checking ? "Memeriksa..." : "Periksa lagi"}
      </button>
    </div>
  );
}
