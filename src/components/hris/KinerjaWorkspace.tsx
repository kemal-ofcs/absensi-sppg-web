"use client";

// Tab Kinerja `/hris` (HRIS v41, §21.9 butir 1–3): penilaian per periode dan,
// untuk pemegang `hr.performance.config`, template dan pengaturannya. Panel
// riwayat dipakai tab Kinerja rincian karyawan.

import { useCallback, useEffect, useState } from "react";
import {
  LABEL_TANDA_KINERJA,
  PenilaianKinerja,
  WARNA_STATUS_KINERJA,
} from "@/components/hris/PenilaianKinerja";
import { TemplateKinerja } from "@/components/hris/TemplateKinerja";
import { pesanGalat } from "@/components/inventory/gaya";
import { hasPermission } from "@/lib/auth/access";
import { useAuth } from "@/lib/context/AuthContext";
import {
  ambilDaftarKinerja,
  type PenilaianKinerja as Penilaian,
} from "@/lib/gateways/hr-kinerja";
import { SYNC_COMPLETED_EVENT } from "@/lib/gateways/sync-status";

type Bagian = "penilaian" | "template";

export function KinerjaWorkspace() {
  const { user } = useAuth();
  const bolehTemplate = hasPermission(user, "hr.performance.config");
  const bolehNilai =
    hasPermission(user, "hr.performance.view") ||
    hasPermission(user, "hr.performance.assess") ||
    hasPermission(user, "hr.performance.finalize");
  const [bagian, setBagian] = useState<Bagian>(
    bolehNilai ? "penilaian" : "template",
  );
  const [pesan, setPesan] = useState("");
  const pilihan: Array<[Bagian, string]> = [
    ...(bolehNilai
      ? ([["penilaian", "Penilaian"]] as Array<[Bagian, string]>)
      : []),
    ...(bolehTemplate
      ? ([["template", "Template"]] as Array<[Bagian, string]>)
      : []),
  ];
  return (
    <div className="space-y-4">
      {pilihan.length > 1 ? (
        <div
          className="flex flex-wrap gap-2"
          role="tablist"
          aria-label="Bagian kinerja"
        >
          {pilihan.map(([id, label]) => (
            <button
              key={id}
              id={`kinerja-bagian-${id}`}
              type="button"
              role="tab"
              aria-selected={bagian === id}
              onClick={() => setBagian(id)}
              className={`min-h-9 rounded-xl px-3 text-xs font-bold ${bagian === id ? "bg-sky-500 text-white" : "bg-slate-900 text-slate-300"}`}
            >
              {label}
            </button>
          ))}
        </div>
      ) : null}
      {bagian === "penilaian" && bolehNilai ? <PenilaianKinerja /> : null}
      {bagian === "template" && bolehTemplate ? (
        <>
          {pesan ? (
            <output className="block text-sm text-amber-200">{pesan}</output>
          ) : null}
          <TemplateKinerja onPesan={setPesan} />
        </>
      ) : null}
    </div>
  );
}

/** Tab Kinerja rincian karyawan (`view`): nilai berlaku per periode + koreksi. */
export function RiwayatKinerjaKaryawan({ idKaryawan }: { idKaryawan: string }) {
  const [daftar, setDaftar] = useState<Penilaian[] | null>(null);
  const [galat, setGalat] = useState("");

  const muat = useCallback(async () => {
    try {
      const hasil = await ambilDaftarKinerja({ id_karyawan: idKaryawan });
      setDaftar(hasil.penilaian);
      setGalat("");
    } catch (error) {
      setGalat(pesanGalat(error, "Riwayat kinerja gagal dimuat."));
    }
  }, [idKaryawan]);

  useEffect(() => {
    void muat();
    const dengar = () => void muat();
    window.addEventListener(SYNC_COMPLETED_EVENT, dengar);
    return () => window.removeEventListener(SYNC_COMPLETED_EVENT, dengar);
  }, [muat]);

  if (galat) return <p className="text-sm text-rose-200">{galat}</p>;
  if (!daftar) return null;
  if (daftar.length === 0) {
    return <p className="text-sm text-slate-400">Belum ada penilaian.</p>;
  }
  return (
    <ul className="space-y-2">
      {daftar.map((p) => (
        <li
          key={p.id_penilaian}
          className={`rounded-xl border p-3 ${p.berlaku ? "border-emerald-500/40" : "border-slate-800"} ${p.id_ref ? "ml-4" : ""}`}
        >
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold text-white">
              {p.periode_jenis} {p.periode_mulai} s.d. {p.periode_selesai}
            </span>
            <span
              className={`rounded-lg px-2 py-0.5 text-xs font-bold ${WARNA_STATUS_KINERJA[p.status] ?? ""}`}
            >
              {p.id_ref ? `Koreksi • ${p.status}` : p.status}
            </span>
            {p.berlaku ? (
              <span className="text-xs font-bold text-emerald-200">
                Berlaku
              </span>
            ) : null}
          </div>
          <p className="text-xs text-slate-400">
            {p.template_nama} • penilai {p.penilai_oleh}
            {p.nilai_teks ? ` • ${p.nilai_teks} ${p.predikat ?? ""}` : ""}
          </p>
          {p.id_ref && p.alasan_koreksi ? (
            <p className="text-xs text-slate-300">Alasan: {p.alasan_koreksi}</p>
          ) : null}
          {p.tanda.length ? (
            <p className="text-xs text-amber-200">
              {p.tanda.map((t) => LABEL_TANDA_KINERJA[t] ?? t).join(", ")}
            </p>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
