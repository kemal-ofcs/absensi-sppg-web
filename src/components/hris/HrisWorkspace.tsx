"use client";

// Layar HRIS fase 1 (Web/Desktop): daftar karyawan + rincian, struktur
// berjenjang, dan master organisasi. Setiap tab memeriksa izinnya sendiri;
// backend memeriksa ulang (aturan 10).

import { useCallback, useEffect, useMemo, useState } from "react";
import { OrganisasiPanel } from "@/components/hris/OrganisasiPanel";
import { PengaturanPengajuan } from "@/components/hris/PengaturanPengajuan";
import { RincianKaryawan } from "@/components/hris/RincianKaryawan";
import { hasPermission } from "@/lib/auth/access";
import { useAuth } from "@/lib/context/AuthContext";
import { getDaftarKaryawan } from "@/lib/gateways/employee";
import {
  ambilOrganisasi,
  ambilRingkasanKontrak,
  type Organisasi,
  type RingkasanKontrak,
} from "@/lib/gateways/hris";
import { SYNC_COMPLETED_EVENT } from "@/lib/gateways/sync-status";
import { LABEL_TANDA_HRIS } from "@/lib/validations/hris";

type Tab = "karyawan" | "struktur" | "organisasi";
export type BarisKaryawan = Record<string, unknown>;

const TOMBOL_TAB =
  "min-h-10 rounded-xl px-4 text-sm font-bold transition-colors";

export function HrisWorkspace() {
  const { user } = useAuth();
  const bolehOrg = hasPermission(user, "hr.org.manage");
  const [tab, setTab] = useState<Tab>("karyawan");
  const [karyawan, setKaryawan] = useState<BarisKaryawan[]>([]);
  const [org, setOrg] = useState<Organisasi | null>(null);
  const [kontrak, setKontrak] = useState<Map<string, RingkasanKontrak>>(
    new Map(),
  );
  const [cari, setCari] = useState("");
  const [dipilih, setDipilih] = useState<string | null>(null);
  const [galat, setGalat] = useState("");

  const muat = useCallback(async () => {
    try {
      const [daftar, organisasi, ringkas] = await Promise.all([
        getDaftarKaryawan({}),
        ambilOrganisasi(),
        ambilRingkasanKontrak(),
      ]);
      setKaryawan(daftar);
      setOrg(organisasi);
      setKontrak(new Map(ringkas.karyawan.map((k) => [k.id_karyawan, k])));
      setGalat("");
    } catch (error) {
      setGalat(
        error instanceof Error ? error.message : "Data HRIS gagal dimuat.",
      );
    }
  }, []);

  useEffect(() => {
    void muat();
    const dengar = () => void muat();
    window.addEventListener(SYNC_COMPLETED_EVENT, dengar);
    return () => window.removeEventListener(SYNC_COMPLETED_EVENT, dengar);
  }, [muat]);

  const nama = useMemo(() => {
    const peta = new Map<string, string>();
    for (const c of org?.cabang ?? []) peta.set(`c:${c.id_cabang}`, c.nama);
    for (const j of org?.jabatan ?? []) peta.set(`j:${j.id_jabatan}`, j.nama);
    for (const k of karyawan)
      peta.set(`k:${String(k.id_unik)}`, String(k.nama));
    return peta;
  }, [org, karyawan]);

  const tampil = useMemo(() => {
    const kata = cari.trim().toLowerCase();
    return karyawan.filter(
      (k) =>
        !kata ||
        [k.nama, k.kode_karyawan, k.divisi, k.jabatan_status]
          .map((v) => String(v ?? "").toLowerCase())
          .some((v) => v.includes(kata)),
    );
  }, [karyawan, cari]);

  const pilihan = karyawan.find((k) => String(k.id_unik) === dipilih) ?? null;

  return (
    <div className="space-y-4">
      <div
        className="flex flex-wrap gap-2"
        role="tablist"
        aria-label="Bagian HRIS"
      >
        {(
          [
            ["karyawan", "Karyawan"],
            ["struktur", "Struktur"],
            ...(bolehOrg ? [["organisasi", "Organisasi"]] : []),
          ] as Array<[Tab, string]>
        ).map(([id, label]) => (
          <button
            key={id}
            id={`hris-tab-${id}`}
            type="button"
            role="tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
            className={`${TOMBOL_TAB} ${tab === id ? "bg-sky-500 text-white" : "bg-slate-900 text-slate-300"}`}
          >
            {label}
          </button>
        ))}
      </div>

      {galat ? <p className="text-sm text-rose-200">{galat}</p> : null}

      {tab === "karyawan" ? (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
          <div className="space-y-3 rounded-2xl border border-slate-800 bg-slate-900 p-3">
            <input
              id="hris-cari"
              type="search"
              value={cari}
              onChange={(e) => setCari(e.target.value)}
              placeholder="Cari nama, kode, divisi, jabatan..."
              className="min-h-10 w-full rounded-xl border border-slate-800 bg-slate-950 px-3 text-white outline-none focus:border-sky-500"
            />
            <ul className="max-h-[65vh] space-y-1 overflow-y-auto">
              {tampil.map((k) => {
                const id = String(k.id_unik);
                const ringkas = kontrak.get(id);
                return (
                  <li key={id}>
                    <button
                      type="button"
                      onClick={() => setDipilih(id)}
                      className={`w-full rounded-xl px-3 py-2 text-left ${dipilih === id ? "bg-sky-500/20" : "hover:bg-slate-800"}`}
                    >
                      <span className="block truncate font-semibold text-white">
                        {String(k.nama)}
                      </span>
                      <span className="block truncate text-xs text-slate-400">
                        {String(k.divisi || "-")} •{" "}
                        {String(k.jabatan_status || "-")}
                        {k.status_aktif === "Nonaktif" ? " • Nonaktif" : ""}
                      </span>
                      {ringkas?.tanda.length ? (
                        <span className="block truncate text-xs text-amber-200">
                          {ringkas.tanda
                            .map((t) => LABEL_TANDA_HRIS[t] ?? t)
                            .join(", ")}
                        </span>
                      ) : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
          <div className="min-w-0">
            {pilihan ? (
              <RincianKaryawan
                key={String(pilihan.id_unik)}
                karyawan={pilihan}
                nama={nama}
                onBerubah={muat}
              />
            ) : (
              <p className="rounded-2xl border border-slate-800 bg-slate-900 p-6 text-sm text-slate-400">
                Pilih karyawan untuk melihat rinciannya.
              </p>
            )}
          </div>
        </div>
      ) : null}

      {tab === "struktur" ? <Struktur karyawan={karyawan} org={org} /> : null}

      {tab === "organisasi" && bolehOrg ? (
        <>
          <OrganisasiPanel org={org} onBerubah={muat} />
          <PengaturanPengajuan />
        </>
      ) : null}
    </div>
  );
}

/** Daftar berjenjang menurut atasan langsung, dikelompokkan per cabang. */
function Struktur({
  karyawan,
  org,
}: {
  karyawan: BarisKaryawan[];
  org: Organisasi | null;
}) {
  const aktif = karyawan.filter((k) => k.status_aktif !== "Nonaktif");
  const ada = new Set(aktif.map((k) => String(k.id_unik)));
  const siklus = new Set(org?.atasan_siklus ?? []);
  const bawahan = new Map<string, BarisKaryawan[]>();
  const puncak: BarisKaryawan[] = [];
  for (const k of aktif) {
    const atasan = String(k.id_atasan ?? "");
    if (atasan && ada.has(atasan) && !siklus.has(String(k.id_unik))) {
      bawahan.set(atasan, [...(bawahan.get(atasan) ?? []), k]);
    } else {
      puncak.push(k);
    }
  }
  const cabang = new Map((org?.cabang ?? []).map((c) => [c.id_cabang, c.nama]));
  const simpul = (k: BarisKaryawan, dalam: number) => {
    const id = String(k.id_unik);
    return (
      <li key={id}>
        <div
          className="flex flex-wrap items-baseline gap-x-2 py-1"
          style={{ paddingLeft: `${dalam * 1.25}rem` }}
        >
          <span className="font-semibold text-white">{String(k.nama)}</span>
          <span className="text-xs text-slate-400">
            {String(k.jabatan_status || "-")} • {String(k.divisi || "-")} •{" "}
            {cabang.get(String(k.id_cabang ?? "")) ?? "Tanpa cabang"}
          </span>
          {siklus.has(id) ? (
            <span className="text-xs text-amber-200">
              {LABEL_TANDA_HRIS.atasan_siklus}
            </span>
          ) : null}
        </div>
        {dalam < 12 ? (
          <ul>{(bawahan.get(id) ?? []).map((b) => simpul(b, dalam + 1))}</ul>
        ) : null}
      </li>
    );
  };
  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900 p-4">
      {puncak.length === 0 ? (
        <p className="text-sm text-slate-400">Belum ada karyawan aktif.</p>
      ) : (
        <ul>{puncak.map((k) => simpul(k, 0))}</ul>
      )}
    </div>
  );
}
