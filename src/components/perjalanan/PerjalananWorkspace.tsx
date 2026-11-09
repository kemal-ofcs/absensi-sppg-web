"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  INPUT,
  LABEL,
  pesanGalat,
  TOMBOL_UTAMA,
} from "@/components/inventory/gaya";
import { hasPermission } from "@/lib/auth/access";
import { useAuth } from "@/lib/context/AuthContext";
import {
  ambilMasterPerjalanan,
  daftarPerjalanan,
  type FotoSegeraDihapus,
  fotoSegeraDihapus,
  type MasterPerjalanan,
  type PerjalananItem,
  type RincianPerjalanan,
} from "@/lib/gateways/driver";
import { subscribeSyncCompleted } from "@/lib/gateways/sync-status";
import { STATUS_PERJALANAN } from "@/lib/validations/driver";
import { ArmadaPanel } from "./ArmadaPanel";
import { FormSuratJalan } from "./FormSuratJalan";
import { RincianSuratJalan } from "./RincianSuratJalan";
import { LABEL_TANDA, rentangBawaan, WARNA_STATUS, waktuWib } from "./tampilan";
import { UnduhFotoPanel } from "./UnduhFotoPanel";
import { UpahPanel } from "./UpahPanel";

/**
 * Layar dispatcher (Web/Desktop): surat jalan, Perlu ditinjau, armada, dan
 * unduh foto. Status, driver, dan kendaraan yang bertugas selalu datang dari
 * backend, yang menurunkannya dari laporan (tidak pernah dihitung di sini).
 */

type Tab = "surat" | "tinjau" | "upah" | "armada" | "foto";

const GALAT_KOTAK =
  "p-3 rounded-lg border border-rose-500/30 bg-rose-500/20 text-sm text-rose-100";

export function PerjalananWorkspace() {
  const { user } = useAuth();
  const bolehKelola = hasPermission(user, "trip.manage");
  const bolehArmada = hasPermission(user, "fleet.manage") || bolehKelola;

  const [tab, setTab] = useState<Tab>("surat");
  const [{ dari, sampai }, setRentang] = useState(rentangBawaan);
  const [status, setStatus] = useState("");
  const [cari, setCari] = useState("");
  const [master, setMaster] = useState<MasterPerjalanan | null>(null);
  const [items, setItems] = useState<PerjalananItem[] | null>(null);
  const [galat, setGalat] = useState<string | null>(null);
  const [pesan, setPesan] = useState<string | null>(null);
  const [rincianId, setRincianId] = useState<string | null>(null);
  const [form, setForm] = useState<RincianPerjalanan | "baru" | null>(null);
  const [segeraDihapus, setSegeraDihapus] = useState<FotoSegeraDihapus | null>(
    null,
  );

  const muatMaster = useCallback(async () => {
    setMaster(await ambilMasterPerjalanan());
  }, []);

  const muat = useCallback(async () => {
    setGalat(null);
    try {
      const [m, daftar] = await Promise.all([
        ambilMasterPerjalanan(),
        daftarPerjalanan(dari, sampai),
      ]);
      setMaster(m);
      setItems(daftar.items);
      // Peringatan 7 hari sebelum foto terhapus; gagal dibaca = tanpa peringatan.
      setSegeraDihapus(await fotoSegeraDihapus().catch(() => null));
    } catch (error) {
      setGalat(pesanGalat(error, "Data perjalanan tidak bisa dimuat."));
    }
  }, [dari, sampai]);

  useEffect(() => {
    void muat();
  }, [muat]);
  useEffect(() => subscribeSyncCompleted(() => void muat()), [muat]);

  const tampil = useMemo(() => {
    const kata = cari.trim().toLowerCase();
    return (items ?? []).filter(
      (i) =>
        (!status || i.status === status) &&
        (!kata ||
          [i.nomor, i.nama_karyawan, i.identitas_kendaraan, i.nama_kategori]
            .filter(Boolean)
            .some((t) => String(t).toLowerCase().includes(kata))),
    );
  }, [items, status, cari]);
  const perluDitinjau = useMemo(
    () => (items ?? []).filter((i) => i.tanda.length > 0),
    [items],
  );
  const siapBuat = Boolean(
    master?.kendaraan.some((k) => k.status_aktif === 1) &&
      master.kategori.some((k) => k.status_aktif === 1),
  );

  const tabs: { id: Tab; label: string; tampil: boolean }[] = [
    { id: "surat", label: "Surat jalan", tampil: true },
    {
      id: "tinjau",
      label: `Perlu ditinjau${perluDitinjau.length ? ` (${perluDitinjau.length})` : ""}`,
      tampil: true,
    },
    { id: "upah", label: "Upah", tampil: true },
    { id: "armada", label: "Armada & lokasi", tampil: bolehArmada },
    { id: "foto", label: "Unduh foto", tampil: true },
  ];

  return (
    <div className="space-y-4">
      <div
        role="tablist"
        aria-label="Bagian perjalanan"
        className="flex flex-wrap gap-2"
      >
        {tabs
          .filter((t) => t.tampil)
          .map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              id={`tab-perjalanan-${t.id}`}
              aria-selected={tab === t.id}
              className={`min-h-11 rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
                tab === t.id
                  ? "bg-sky-600 text-white"
                  : "border border-slate-700 text-slate-200 hover:bg-slate-800"
              }`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
      </div>

      {segeraDihapus && segeraDihapus.jumlah > 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-300/30 bg-amber-300/10 p-3 text-sm text-amber-100">
          <span>
            {segeraDihapus.jumlah} foto laporan akan dihapus dalam 7 hari (masa
            simpan 90 hari)
            {segeraDihapus.tanggal_tertua
              ? `, mulai laporan tanggal ${segeraDihapus.tanggal_tertua}`
              : ""}
            . Unduh dulu bila perlu disimpan.
          </span>
          <button
            type="button"
            id="perjalanan-unduh-foto-lama"
            className="min-h-11 rounded-lg border border-amber-300/40 px-3 py-2 text-sm font-medium hover:bg-amber-300/15"
            onClick={() => {
              const tertua = segeraDihapus.tanggal_tertua;
              if (tertua) setRentang((r) => ({ ...r, dari: tertua }));
              setTab("foto");
            }}
          >
            Buka Unduh foto
          </button>
        </div>
      ) : null}
      {galat ? (
        <div className={GALAT_KOTAK} role="alert">
          {galat}
        </div>
      ) : null}
      {pesan ? (
        <output className="block p-3 rounded-lg border border-emerald-500/30 bg-emerald-500/15 text-sm text-emerald-100">
          {pesan}
        </output>
      ) : null}

      {tab === "surat" || tab === "tinjau" || tab === "foto" ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <label className={LABEL} htmlFor="perjalanan-dari">
              Dari tanggal
            </label>
            <input
              id="perjalanan-dari"
              type="date"
              className={INPUT}
              value={dari}
              onChange={(e) =>
                setRentang((r) => ({ ...r, dari: e.target.value }))
              }
            />
          </div>
          <div>
            <label className={LABEL} htmlFor="perjalanan-sampai">
              Sampai tanggal
            </label>
            <input
              id="perjalanan-sampai"
              type="date"
              className={INPUT}
              value={sampai}
              onChange={(e) =>
                setRentang((r) => ({ ...r, sampai: e.target.value }))
              }
            />
          </div>
          {tab === "surat" ? (
            <>
              <div>
                <label className={LABEL} htmlFor="perjalanan-status">
                  Filter status
                </label>
                <select
                  id="perjalanan-status"
                  className={INPUT}
                  value={status}
                  onChange={(e) => setStatus(e.target.value)}
                >
                  <option value="">Semua status</option>
                  {STATUS_PERJALANAN.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className={LABEL} htmlFor="perjalanan-cari">
                  Cari nomor, driver, plat
                </label>
                <input
                  id="perjalanan-cari"
                  className={INPUT}
                  value={cari}
                  onChange={(e) => setCari(e.target.value)}
                />
              </div>
            </>
          ) : null}
        </div>
      ) : null}

      {tab === "surat" ? (
        <div className="space-y-3">
          {bolehKelola ? (
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                id="perjalanan-buat"
                className={TOMBOL_UTAMA}
                disabled={!siapBuat}
                onClick={() => setForm("baru")}
              >
                Buat surat jalan
              </button>
              {master && !siapBuat ? (
                <span className="text-sm text-amber-100">
                  Isi jenis kendaraan, kendaraan, dan kategori tujuan di tab
                  Armada &amp; lokasi lebih dulu.
                </span>
              ) : null}
            </div>
          ) : null}
          <DaftarSurat
            items={items === null ? null : tampil}
            onBuka={setRincianId}
          />
        </div>
      ) : null}

      {tab === "tinjau" ? (
        <div className="space-y-3">
          <p className="text-sm text-slate-400">
            Tidak ada yang ditolak otomatis: GPS di dalam gudang memang sering
            meleset. Buka surat jalannya untuk melihat laporan dan fotonya.
          </p>
          {perluDitinjau.length === 0 && items !== null ? (
            <p className="text-sm text-slate-300">
              Tidak ada yang perlu ditinjau pada rentang tanggal ini.
            </p>
          ) : null}
          <ul className="space-y-2">
            {perluDitinjau.map((i) => (
              <li key={i.id_perjalanan}>
                <button
                  type="button"
                  id={`tinjau-${i.id_perjalanan}`}
                  className="w-full rounded-xl border border-amber-300/25 bg-amber-300/10 p-3 text-left text-sm text-amber-100 hover:bg-amber-300/15"
                  onClick={() => setRincianId(i.id_perjalanan)}
                >
                  <strong>{i.nomor}</strong> ·{" "}
                  {i.nama_karyawan ?? i.id_karyawan}
                  <ul className="mt-1 list-disc pl-5">
                    {[...new Set(i.tanda.map((t) => t.kode))].map((kode) => (
                      <li key={kode}>
                        {LABEL_TANDA[kode]} (
                        {i.tanda.filter((t) => t.kode === kode).length})
                      </li>
                    ))}
                  </ul>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {tab === "upah" ? <UpahPanel /> : null}

      {tab === "armada" && master ? (
        <ArmadaPanel master={master} onBerubah={muatMaster} />
      ) : null}

      {tab === "foto" ? (
        <UnduhFotoPanel items={items ?? []} dari={dari} sampai={sampai} />
      ) : null}

      {rincianId && master ? (
        <RincianSuratJalan
          idPerjalanan={rincianId}
          master={master}
          onClose={() => setRincianId(null)}
          onUbah={(rincian) => {
            setRincianId(null);
            setForm(rincian);
          }}
          onBerubah={() => void muat()}
        />
      ) : null}

      {form && master ? (
        <FormSuratJalan
          master={master}
          awal={form === "baru" ? null : form}
          onClose={() => setForm(null)}
          onTersimpan={(teks) => {
            setForm(null);
            setPesan(teks);
            void muat();
          }}
        />
      ) : null}
    </div>
  );
}

function DaftarSurat({
  items,
  onBuka,
}: {
  items: PerjalananItem[] | null;
  onBuka: (id: string) => void;
}) {
  if (items === null) {
    return <p className="text-sm text-slate-400">Memuat...</p>;
  }
  if (items.length === 0) {
    return (
      <p className="text-sm text-slate-300">
        Tidak ada surat jalan pada rentang tanggal dan filter ini.
      </p>
    );
  }
  return (
    <ul className="space-y-2">
      {items.map((i) => (
        <li key={i.id_perjalanan}>
          <button
            type="button"
            id={`surat-${i.id_perjalanan}`}
            className="w-full rounded-xl border border-white/10 bg-slate-900/60 p-3 text-left hover:bg-slate-800/60"
            onClick={() => onBuka(i.id_perjalanan)}
          >
            <div className="flex flex-wrap items-center gap-2">
              <strong className="text-sm text-slate-100">{i.nomor}</strong>
              <span
                className={`rounded-full border px-2 py-0.5 text-xs font-semibold ${WARNA_STATUS[i.status]}`}
              >
                {i.status}
              </span>
              {i.tanda.length > 0 ? (
                <span className="rounded-full border border-amber-300/40 bg-amber-300/15 px-2 py-0.5 text-xs text-amber-100">
                  Perlu ditinjau {i.tanda.length}
                </span>
              ) : null}
              {i.dicetak_pada ? null : (
                <span className="text-xs text-slate-400">Belum dicetak</span>
              )}
            </div>
            <p className="mt-1 text-sm text-slate-300">
              {i.tanggal} · {i.nama_karyawan ?? i.id_karyawan} ·{" "}
              {i.identitas_kendaraan ?? i.id_kendaraan} ·{" "}
              {i.nama_kategori ?? i.id_kategori}
            </p>
            {i.laporan_terakhir ? (
              <p className="text-xs text-slate-400">
                Terakhir: {i.laporan_terakhir.jenis},{" "}
                {waktuWib(i.laporan_terakhir.waktu_perangkat)}
              </p>
            ) : null}
          </button>
        </li>
      ))}
    </ul>
  );
}
