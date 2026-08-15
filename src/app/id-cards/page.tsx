"use client";

import { redirect } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { FeedbackBanner } from "@/components/ui/FeedbackBanner";
import { canAccessArea } from "@/lib/auth/access";
import { saveFileWithPicker } from "@/lib/client/download";
import { createIdCardPng } from "@/lib/client/id-card";
import { createQrPng, employeeQrPayload } from "@/lib/client/qr-code";
import { useAuth } from "@/lib/context/AuthContext";
import { getDaftarIdCard, updateStatusIdCard } from "@/lib/gateways/id-card";
import { useHydrated } from "@/lib/hooks/useHydrated";

export default function IdCardsPage() {
  const hydrated = useHydrated();
  const { user, isAuthenticated, isLoading: authLoading } = useAuth();
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [search, setSearch] = useState("");
  const [appliedSearch, setAppliedSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [workingId, setWorkingId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setRows(await getDaftarIdCard({ search: appliedSearch || undefined }));
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Gagal memuat daftar ID card.",
      );
    } finally {
      setLoading(false);
    }
  }, [appliedSearch]);

  useEffect(() => {
    if (hydrated && isAuthenticated && canAccessArea(user, "idcards")) {
      void load();
    }
  }, [hydrated, isAuthenticated, user, load]);

  const renderCard = async (row: Record<string, unknown>) => {
    const payload = employeeQrPayload(row);
    if (!payload) {
      throw new Error(
        "Data token QR belum tersedia. Generate token QR karyawan terlebih dahulu.",
      );
    }
    const qrPng = await createQrPng(payload);
    return await createIdCardPng(row, qrPng);
  };

  const saveCard = async (row: Record<string, unknown>) => {
    const id = String(row.id_unik);
    const nama = String(row.nama || id);
    setWorkingId(id);
    try {
      const png = await renderCard(row);
      const safeNama = nama.replace(/[/\\?%*:|"<>]/g, "-").trim();
      const res = await saveFileWithPicker(png, `id-card-${safeNama}.png`, {
        description: "Gambar ID Card (PNG)",
        accept: { "image/png": [".png"] },
      });
      if (res.cancelled) {
        return;
      }
      await updateStatusIdCard({
        id_unik: id,
        idcard_status: "Berhasil",
        idcard_catatan: "PNG dibuat dari aplikasi",
      });
      if (res.path) {
        setMessage(`ID card ${nama} berhasil disimpan di: ${res.path}`);
      } else {
        setMessage(`ID card ${nama} berhasil disimpan sebagai PNG.`);
      }
      await load();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "ID card gagal dibuat.",
      );
    } finally {
      setWorkingId(null);
    }
  };

  const printCard = async (row: Record<string, unknown>) => {
    const id = String(row.id_unik);
    setWorkingId(id);
    try {
      const png = await renderCard(row);
      let iframe = document.getElementById(
        "id-card-print-frame",
      ) as HTMLIFrameElement | null;
      if (!iframe) {
        iframe = document.createElement("iframe");
        iframe.id = "id-card-print-frame";
        iframe.style.position = "fixed";
        iframe.style.right = "0";
        iframe.style.bottom = "0";
        iframe.style.width = "0";
        iframe.style.height = "0";
        iframe.style.border = "0";
        document.body.appendChild(iframe);
      }

      const frameDoc = iframe.contentWindow?.document || iframe.contentDocument;
      if (!frameDoc) {
        throw new Error("Gagal menginisialisasi modul pencetakan.");
      }

      frameDoc.open();
      frameDoc.write(`
        <!DOCTYPE html>
        <html>
        <head>
          <title>ID Card - ${String(row.nama || id)}</title>
          <style>
            @page {
              size: 85.6mm 54mm;
              margin: 0;
            }
            @media print {
              body, html {
                margin: 0;
                padding: 0;
                width: 85.6mm;
                height: 54mm;
              }
            }
            body {
              margin: 0;
              padding: 0;
              display: flex;
              align-items: center;
              justify-content: center;
              background: white;
            }
            img {
              width: 85.6mm;
              height: 54mm;
              object-fit: cover;
              display: block;
            }
          </style>
        </head>
        <body>
          <img src="${png}" onload="window.focus(); window.print();" />
        </body>
        </html>
      `);
      frameDoc.close();

      await updateStatusIdCard({
        id_unik: id,
        idcard_status: "Berhasil",
        idcard_catatan: "Siap/cetak dari aplikasi",
      });
      setMessage(`ID card ${String(row.nama)} siap dicetak.`);
      await load();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "ID card gagal dicetak.",
      );
    } finally {
      setWorkingId(null);
    }
  };

  if (!hydrated || authLoading)
    return (
      <div className="min-h-screen bg-slate-950 p-10 text-slate-300">
        Memuat ID card...
      </div>
    );
  if (!isAuthenticated) redirect("/login");
  if (!canAccessArea(user, "idcards")) redirect("/forbidden");

  return (
    <AppShell contentClassName="mx-auto w-full max-w-7xl space-y-5 px-4 py-6 sm:px-6 lg:px-8">
      <div>
        <p className="text-xs font-bold uppercase tracking-widest text-sky-400">
          Kartu identitas
        </p>
        <h1 className="mt-1 text-2xl font-bold text-white">ID Card Karyawan</h1>
        <p className="text-xs text-slate-400">
          Buat PNG resolusi tinggi atau cetak langsung dalam ukuran kartu CR80
          (85,6 × 54 mm).
        </p>
      </div>
      {message ? (
        <FeedbackBanner tone="success" onDismiss={() => setMessage(null)}>
          {message}
        </FeedbackBanner>
      ) : null}
      {error ? (
        <FeedbackBanner tone="error" onDismiss={() => setError(null)}>
          {error}
        </FeedbackBanner>
      ) : null}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          setAppliedSearch(search.trim());
        }}
        className="flex gap-2 rounded-2xl border border-slate-800 bg-slate-900 p-4"
      >
        <input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Cari nama, ID, atau divisi..."
          className="min-h-11 flex-1 rounded-xl border border-slate-700 bg-slate-950 px-3 text-xs text-white"
        />
        <button
          className="rounded-xl bg-sky-400 px-5 text-xs font-bold text-slate-950"
          type="submit"
        >
          Cari
        </button>
      </form>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {!loading && rows.length === 0 ? (
          <p className="text-sm text-slate-500">Belum ada data ID card.</p>
        ) : null}
        {rows.map((row) => {
          const id = String(row.id_unik);
          const working = workingId === id;
          return (
            <article
              key={id}
              className="rounded-2xl border border-slate-800 bg-gradient-to-br from-slate-900 to-sky-950 p-5"
            >
              <p className="font-mono text-xs text-sky-300">{id}</p>
              <h2 className="mt-2 text-lg font-bold text-white">
                {String(row.nama)}
              </h2>
              <p className="text-sm text-slate-400">{String(row.divisi)}</p>
              <div className="mt-4 flex items-center justify-between text-xs">
                <span className="text-slate-500">Status</span>
                <span className="rounded-full bg-slate-800 px-2 py-1 text-amber-200">
                  {String(row.idcard_status || "Belum")}
                </span>
              </div>
              <div className="mt-5 flex gap-2">
                <button
                  disabled={working}
                  onClick={() => void saveCard(row)}
                  type="button"
                  className="flex-1 rounded-xl bg-sky-400 px-3 py-2 text-xs font-bold text-slate-950 disabled:opacity-50"
                >
                  {working ? "Membuat..." : "Simpan PNG"}
                </button>
                <button
                  disabled={working}
                  onClick={() => void printCard(row)}
                  type="button"
                  className="rounded-xl border border-slate-700 bg-slate-800 px-3 py-2 text-xs font-bold text-white disabled:opacity-50"
                >
                  Cetak
                </button>
              </div>
            </article>
          );
        })}
      </div>
    </AppShell>
  );
}
