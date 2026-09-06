"use client";

import { useEffect, useRef, useState } from "react";
import {
  type DataFolderInfo,
  type ExportReport,
  exportDatabase,
  getDataFolder,
  type ImportReport,
  importDatabaseFile,
} from "@/lib/gateways/database-portability";
import type { DatabaseProvider } from "@/lib/validations/database-endpoint";

/** Kata yang harus diketik ulang sebelum pemulihan dijalankan. */
const RESTORE_CONFIRMATION = "PULIHKAN";

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Layar Cadangan Database.
 *
 * Tanpa cloud tidak ada cadangan otomatis di mana pun, jadi inilah satu-satunya
 * cara customer memindahkan datanya sendiri: ganti laptop, pulihkan setelah
 * kerusakan, atau mengirimkannya saat meminta bantuan.
 *
 * Dua hal yang sengaja tampil menonjol: peringatan bahwa berkas tanpa frasa
 * sandi memuat hash password dan foto absensi, dan konfirmasi ketik-ulang
 * sebelum memulihkan — memulihkan berarti MENIMPA seluruh data, bukan
 * menggabungkannya.
 */
export function DatabaseBackupCard({
  provider,
}: {
  provider: DatabaseProvider;
}) {
  const [passphrase, setPassphrase] = useState("");
  const [restorePassphrase, setRestorePassphrase] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState<"export" | "restore" | null>(null);
  const [exported, setExported] = useState<ExportReport | null>(null);
  const [restored, setRestored] = useState<ImportReport | null>(null);
  const [folder, setFolder] = useState<DataFolderInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const isLocalMode = provider === "local_file";

  useEffect(() => {
    if (!isLocalMode) return;
    getDataFolder()
      .then(setFolder)
      .catch(() => setFolder(null));
  }, [isLocalMode]);

  if (!isLocalMode) {
    return (
      <section className="app-panel rounded-3xl p-5 sm:p-7">
        <h2 className="text-base font-black text-white">Cadangan database</h2>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-400">
          Perangkat ini memakai database di server, sehingga data induknya tidak
          berada di sini. Pencadangannya dilakukan dari penyedia database Anda.
          Menu ini aktif pada Mode Database Lokal.
        </p>
      </section>
    );
  }

  const handleExport = async () => {
    setBusy("export");
    setError(null);
    setExported(null);
    try {
      setExported(await exportDatabase(passphrase));
      setPassphrase("");
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Ekspor tidak berhasil.",
      );
    } finally {
      setBusy(null);
    }
  };

  const handleRestore = async () => {
    const file = fileRef.current?.files?.[0];
    if (!file) {
      setError("Pilih berkas cadangan terlebih dahulu.");
      return;
    }
    setBusy("restore");
    setError(null);
    setRestored(null);
    try {
      const report = await importDatabaseFile(file, restorePassphrase);
      setRestored(report);
      setRestorePassphrase("");
      setConfirmation("");
      if (fileRef.current) fileRef.current.value = "";
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Pemulihan tidak berhasil.",
      );
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="app-panel rounded-3xl p-5 sm:p-7">
      <h2 className="text-base font-black text-white">Cadangan database</h2>
      <p className="mt-1 max-w-2xl text-sm leading-6 text-slate-400">
        Seluruh data perusahaan tersimpan di perangkat ini. Buat cadangan secara
        berkala — tidak ada salinan lain di tempat mana pun.
      </p>

      {folder ? (
        <p className="mt-4 break-all rounded-xl border border-white/10 bg-slate-950/60 px-3 py-2 font-mono text-[11px] text-slate-400">
          {folder.hubPath}
        </p>
      ) : null}

      {/* ── Ekspor ─────────────────────────────────────────────────────── */}
      <div className="mt-6 space-y-3 border-t border-white/10 pt-5">
        <h3 className="text-xs font-black text-slate-200">Buat cadangan</h3>
        <label className="block space-y-1.5 text-xs font-bold text-slate-300">
          Frasa sandi (disarankan)
          <input
            type="password"
            value={passphrase}
            onChange={(event) => setPassphrase(event.target.value)}
            placeholder="Kosongkan untuk berkas tanpa enkripsi"
            autoComplete="new-password"
            className="min-h-11 w-full rounded-xl border border-white/10 bg-slate-950 px-3 font-mono text-xs text-white outline-none focus:border-cyan-400"
          />
        </label>

        {passphrase.trim().length === 0 ? (
          <p className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-[11px] font-bold leading-4 text-amber-200">
            Tanpa frasa sandi, berkasnya dapat dibuka siapa pun yang memilikinya
            — termasuk hash password, rahasia verifikasi dua langkah, dan foto
            absensi. Isi frasa sandi kecuali Anda memang sedang menyiapkannya
            untuk diagnosa.
          </p>
        ) : null}

        <button
          type="button"
          onClick={handleExport}
          disabled={busy !== null}
          className="inline-flex min-h-11 items-center rounded-xl bg-cyan-400 px-5 text-xs font-black text-slate-950 transition hover:bg-cyan-300 disabled:opacity-50"
        >
          {busy === "export" ? "Menyiapkan..." : "Buat berkas cadangan"}
        </button>

        {exported ? (
          <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-3 text-[11px] leading-5 text-emerald-200">
            <p className="font-black">
              {exported.fileName} · {formatSize(exported.sizeBytes)} ·{" "}
              {exported.encrypted ? "terenkripsi" : "TANPA enkripsi"}
            </p>
            {exported.publicPath ? (
              <p className="mt-1 break-all font-mono opacity-80">
                Tersimpan di: {exported.publicPath}
              </p>
            ) : (
              <p className="mt-1 leading-4">
                Berkas berhasil dibuat, tetapi perangkat ini tidak mengizinkan
                penulisan ke folder Unduhan, sehingga Anda belum dapat
                membukanya dari aplikasi berkas. Salin manual dari lokasi di
                bawah, atau gunakan perangkat dengan Android 11 ke atas.
              </p>
            )}
            <p className="mt-1 break-all font-mono opacity-60">
              {exported.path}
            </p>
          </div>
        ) : null}
      </div>

      {/* ── Pulihkan ───────────────────────────────────────────────────── */}
      <div className="mt-6 space-y-3 border-t border-white/10 pt-5">
        <h3 className="text-xs font-black text-slate-200">
          Pulihkan dari cadangan
        </h3>
        <p className="rounded-xl border border-rose-500/30 bg-rose-500/10 p-3 text-[11px] font-bold leading-4 text-rose-200">
          Pemulihan MENIMPA seluruh data di perangkat ini — absensi, payroll,
          operator, dan hak aksesnya — bukan menggabungkannya. Database yang
          sekarang disimpan berdampingan lebih dulu, sehingga salah pilih berkas
          masih bisa dibatalkan secara manual.
        </p>

        <input
          ref={fileRef}
          type="file"
          accept=".db,.sppgbak"
          className="block w-full text-[11px] text-slate-300 file:mr-3 file:min-h-9 file:rounded-lg file:border-0 file:bg-white/10 file:px-3 file:text-[11px] file:font-bold file:text-slate-200"
        />

        <label className="block space-y-1.5 text-xs font-bold text-slate-300">
          Frasa sandi berkas (bila terenkripsi)
          <input
            type="password"
            value={restorePassphrase}
            onChange={(event) => setRestorePassphrase(event.target.value)}
            autoComplete="off"
            className="min-h-11 w-full rounded-xl border border-white/10 bg-slate-950 px-3 font-mono text-xs text-white outline-none focus:border-cyan-400"
          />
        </label>

        <label className="block space-y-1.5 text-xs font-bold text-slate-300">
          Ketik {RESTORE_CONFIRMATION} untuk mengonfirmasi
          <input
            type="text"
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
            className="min-h-11 w-full rounded-xl border border-white/10 bg-slate-950 px-3 font-mono text-xs text-white outline-none focus:border-rose-400"
          />
        </label>

        <button
          type="button"
          onClick={handleRestore}
          disabled={
            busy !== null || confirmation.trim() !== RESTORE_CONFIRMATION
          }
          className="inline-flex min-h-11 items-center rounded-xl bg-rose-500 px-5 text-xs font-black text-white transition hover:bg-rose-400 disabled:opacity-40"
        >
          {busy === "restore" ? "Memulihkan..." : "Pulihkan database"}
        </button>

        {restored ? (
          <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-3 text-[11px] leading-5 text-emerald-200">
            <p className="font-black">
              Dipulihkan dari {restored.restoredFrom} · skema v
              {restored.schemaVersion} · {restored.tableCount} tabel
            </p>
            <p className="mt-1">
              Tutup dan buka kembali aplikasi agar seluruh layar membaca data
              yang baru.
            </p>
            {restored.previousBackup ? (
              <p className="mt-1 break-all font-mono opacity-80">
                Database lama: {restored.previousBackup}
              </p>
            ) : null}
          </div>
        ) : null}
      </div>

      {error ? (
        <p className="mt-4 rounded-xl border border-rose-500/30 bg-rose-500/10 p-3 text-[11px] font-bold leading-4 text-rose-200">
          {error}
        </p>
      ) : null}
    </section>
  );
}
