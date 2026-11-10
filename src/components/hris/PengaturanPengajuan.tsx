"use client";

// Jenis pengajuan dan aturan cuti tahunan (HRIS v37, prd-hris.md §17.2,
// §17.7), di tab Organisasi `/hris` (Web/Desktop, `hr.org.manage`).

import { useCallback, useEffect, useState } from "react";
import {
  INPUT,
  LABEL,
  pesanGalat,
  TOMBOL_KEDUA,
  TOMBOL_UTAMA,
} from "@/components/inventory/gaya";
import { konfirmasiData } from "@/components/ui/KonfirmasiData";
import {
  ambilAkhirPeriode,
  ambilPengajuan,
  simpanAturanCuti,
  simpanJenisPengajuan,
} from "@/lib/gateways/hr-pengajuan";
import { SYNC_COMPLETED_EVENT } from "@/lib/gateways/sync-status";
import {
  type AturanCuti,
  DAMPAK_GAJI,
  type JenisPengajuan,
  KELOMPOK_AKTIF,
  SATUAN_MAKS,
} from "@/lib/validations/hr-pengajuan";

type IsianJenis = Omit<JenisPengajuan, "maks_hari"> & { maks_hari: string };

const JENIS_KOSONG: IsianJenis = {
  id_jenis: "",
  nama: "",
  kelompok: "Izin",
  izin_pemutus: "hr.request.decide",
  boleh_urgent: false,
  potong_jatah: false,
  dampak_gaji: "Dibayar",
  maks_hari: "",
  satuan_maks: "Hari Kerja",
  wajib_dokumen: false,
  is_aktif: true,
};

const LABEL_PERIODE: Record<string, string> = {
  kalender: "Tahun kalender",
  ulang_tahun_kerja: "Ulang tahun kerja",
};

export function PengaturanPengajuan() {
  const [jenis, setJenis] = useState<JenisPengajuan[]>([]);
  const [isi, setIsi] = useState<IsianJenis>(JENIS_KOSONG);
  const [aturan, setAturan] = useState<AturanCuti | null>(null);
  const [aturanLama, setAturanLama] = useState<AturanCuti | null>(null);
  const [pesan, setPesan] = useState("");
  const [sibuk, setSibuk] = useState(false);

  const muat = useCallback(() => {
    // Rentang tanpa pengajuan: yang dibutuhkan hanya daftar jenisnya.
    ambilPengajuan({ dari: "9999-12-31", sampai: "9999-12-31" })
      .then((d) => setJenis(d.jenis))
      .catch((error: unknown) => setPesan(pesanGalat(error, "Gagal memuat.")));
    ambilAkhirPeriode()
      .then((d) => {
        setAturan(d.aturan);
        setAturanLama(d.aturan);
      })
      .catch((error: unknown) => setPesan(pesanGalat(error, "Gagal memuat.")));
  }, []);
  useEffect(() => {
    muat();
    window.addEventListener(SYNC_COMPLETED_EVENT, muat);
    return () => window.removeEventListener(SYNC_COMPLETED_EVENT, muat);
  }, [muat]);

  const simpanJenis = async () => {
    const lanjut = await konfirmasiData([
      { label: "Nama", nilai: isi.nama },
      { label: "Kelompok", nilai: isi.kelompok },
      { label: "Gaji", nilai: isi.dampak_gaji },
      {
        label: "Batas",
        nilai: isi.maks_hari
          ? `${isi.maks_hari} ${isi.satuan_maks}`
          : "Tanpa batas",
      },
      { label: "Urgent", nilai: isi.boleh_urgent ? "Boleh" : "Tidak" },
      { label: "Status", nilai: isi.is_aktif ? "Aktif" : "Nonaktif" },
    ]);
    if (!lanjut) return;
    setSibuk(true);
    try {
      const { id_jenis, maks_hari, ...sisa } = isi;
      await simpanJenisPengajuan({
        ...sisa,
        ...(id_jenis ? { id_jenis } : {}),
        maks_hari: maks_hari === "" ? null : Number(maks_hari),
      });
      setPesan("Jenis pengajuan tersimpan.");
      setIsi(JENIS_KOSONG);
      muat();
    } catch (error) {
      setPesan(pesanGalat(error, "Gagal menyimpan."));
    } finally {
      setSibuk(false);
    }
  };

  const simpanAturan = async () => {
    if (!aturan) return;
    const gantiPeriode = aturanLama && aturanLama.periode !== aturan.periode;
    const lanjut = await konfirmasiData([
      { label: "Periode", nilai: LABEL_PERIODE[aturan.periode] },
      { label: "Hak per periode", nilai: `${aturan.hak} hari` },
      { label: "Masa kerja minimum", nilai: `${aturan.syarat_bulan} bulan` },
      { label: "Prorata", nilai: aturan.prorata ? "Ya" : "Tidak" },
      { label: "Sisa cuti", nilai: aturan.sisa },
      ...(aturan.sisa === "dibawa"
        ? [
            { label: "Maks dibawa", nilai: `${aturan.bawa_maks} hari` },
            { label: "Dipakai dalam", nilai: `${aturan.bawa_bulan} bulan` },
          ]
        : []),
      ...(gantiPeriode
        ? [
            {
              label: "Perhatian",
              nilai:
                "Periode berubah: jatah dan sisa cuti semua karyawan dihitung ulang dengan aturan baru.",
            },
          ]
        : []),
    ]);
    if (!lanjut) return;
    setSibuk(true);
    try {
      await simpanAturanCuti({
        hr_cuti_periode: aturan.periode,
        hr_cuti_hak: aturan.hak,
        hr_cuti_syarat_bulan: aturan.syarat_bulan,
        hr_cuti_prorata: aturan.prorata ? 1 : 0,
        hr_cuti_sisa: aturan.sisa,
        hr_cuti_bawa_maks: aturan.bawa_maks,
        hr_cuti_bawa_bulan: aturan.bawa_bulan,
      });
      setPesan("Aturan cuti tersimpan.");
      setAturanLama(aturan);
    } catch (error) {
      setPesan(pesanGalat(error, "Gagal menyimpan."));
    } finally {
      setSibuk(false);
    }
  };

  const angka = (kunci: keyof AturanCuti, label: string) =>
    aturan ? (
      <div>
        <label className={LABEL} htmlFor={`cuti-aturan-${kunci}`}>
          {label}
        </label>
        <input
          id={`cuti-aturan-${kunci}`}
          type="number"
          className={INPUT}
          value={String(aturan[kunci])}
          onChange={(e) =>
            setAturan({ ...aturan, [kunci]: Number(e.target.value) })
          }
        />
      </div>
    ) : null;

  return (
    <div className="space-y-4">
      <section className="space-y-3 rounded-2xl border border-slate-800 bg-slate-900 p-4">
        <h3 className="text-sm font-bold text-white">Jenis pengajuan</h3>
        <ul className="space-y-1 text-sm">
          {jenis.map((j) => (
            <li key={j.id_jenis} className="flex flex-wrap items-center gap-2">
              <span
                className={`flex-1 ${j.is_aktif ? "text-slate-200" : "text-slate-500"}`}
              >
                {j.nama} • {j.kelompok} • {j.dampak_gaji}
                {j.maks_hari
                  ? ` • maks ${j.maks_hari} ${j.satuan_maks.toLowerCase()}`
                  : ""}
                {j.potong_jatah ? " • potong jatah" : ""}
                {j.boleh_urgent ? " • urgent" : ""}
                {j.is_aktif ? "" : " • nonaktif"}
              </span>
              {(KELOMPOK_AKTIF as readonly string[]).includes(j.kelompok) ? (
                <button
                  type="button"
                  className="text-xs text-sky-300 underline"
                  onClick={() =>
                    setIsi({
                      ...j,
                      maks_hari:
                        j.maks_hari === null ? "" : String(j.maks_hari),
                    })
                  }
                >
                  Ubah
                </button>
              ) : null}
            </li>
          ))}
        </ul>
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="sm:col-span-3">
            <label className={LABEL} htmlFor="jenis-nama">
              Nama
            </label>
            <input
              id="jenis-nama"
              className={INPUT}
              maxLength={100}
              value={isi.nama}
              onChange={(e) => setIsi({ ...isi, nama: e.target.value })}
            />
          </div>
          <div>
            <label className={LABEL} htmlFor="jenis-kelompok">
              Kelompok
            </label>
            <select
              id="jenis-kelompok"
              className={INPUT}
              value={isi.kelompok}
              onChange={(e) =>
                setIsi({
                  ...isi,
                  kelompok: e.target.value,
                  potong_jatah: e.target.value === "Cuti" && isi.potong_jatah,
                })
              }
            >
              {KELOMPOK_AKTIF.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className={LABEL} htmlFor="jenis-dampak">
              Dampak gaji
            </label>
            <select
              id="jenis-dampak"
              className={INPUT}
              value={isi.dampak_gaji}
              onChange={(e) => setIsi({ ...isi, dampak_gaji: e.target.value })}
            >
              {DAMPAK_GAJI.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className={LABEL} htmlFor="jenis-maks">
                Maks hari
              </label>
              <input
                id="jenis-maks"
                type="number"
                min={1}
                className={INPUT}
                value={isi.maks_hari}
                onChange={(e) => setIsi({ ...isi, maks_hari: e.target.value })}
              />
            </div>
            <div>
              <label className={LABEL} htmlFor="jenis-satuan">
                Satuan
              </label>
              <select
                id="jenis-satuan"
                className={INPUT}
                value={isi.satuan_maks}
                onChange={(e) =>
                  setIsi({ ...isi, satuan_maks: e.target.value })
                }
              >
                {SATUAN_MAKS.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </div>
          </div>
          {(
            [
              ["boleh_urgent", "Boleh urgent"],
              ["potong_jatah", "Memotong jatah cuti"],
              ["wajib_dokumen", "Wajib dokumen pendukung"],
              ["is_aktif", "Aktif"],
            ] as const
          ).map(([kunci, label]) =>
            kunci === "potong_jatah" && isi.kelompok !== "Cuti" ? null : (
              <label
                key={kunci}
                className="flex items-center gap-2 text-sm text-slate-200"
                htmlFor={`jenis-${kunci}`}
              >
                <input
                  id={`jenis-${kunci}`}
                  type="checkbox"
                  checked={isi[kunci]}
                  onChange={(e) =>
                    setIsi({ ...isi, [kunci]: e.target.checked })
                  }
                />
                {label}
              </label>
            ),
          )}
          <div className="flex gap-2 sm:col-span-3">
            <button
              type="button"
              id="jenis-simpan"
              className={TOMBOL_UTAMA}
              disabled={sibuk}
              onClick={() => void simpanJenis()}
            >
              {isi.id_jenis ? "Simpan perubahan" : "Tambah jenis"}
            </button>
            {isi.id_jenis ? (
              <button
                type="button"
                className={TOMBOL_KEDUA}
                onClick={() => setIsi(JENIS_KOSONG)}
              >
                Batal ubah
              </button>
            ) : null}
          </div>
        </div>
      </section>

      {aturan ? (
        <section className="grid gap-3 rounded-2xl border border-slate-800 bg-slate-900 p-4 sm:grid-cols-3">
          <h3 className="text-sm font-bold text-white sm:col-span-3">
            Aturan cuti tahunan
          </h3>
          <div>
            <label className={LABEL} htmlFor="cuti-aturan-periode">
              Periode
            </label>
            <select
              id="cuti-aturan-periode"
              className={INPUT}
              value={aturan.periode}
              onChange={(e) =>
                setAturan({ ...aturan, periode: e.target.value })
              }
            >
              <option value="ulang_tahun_kerja">Ulang tahun kerja</option>
              <option value="kalender">Tahun kalender</option>
            </select>
          </div>
          {angka("hak", "Hak per periode (hari)")}
          {angka("syarat_bulan", "Masa kerja minimum (bulan)")}
          <div>
            <label className={LABEL} htmlFor="cuti-aturan-sisa">
              Sisa cuti di akhir periode
            </label>
            <select
              id="cuti-aturan-sisa"
              className={INPUT}
              value={aturan.sisa}
              onChange={(e) => setAturan({ ...aturan, sisa: e.target.value })}
            >
              <option value="hangus">Hangus</option>
              <option value="dibawa">Dibawa ke periode berikutnya</option>
              <option value="diuangkan">Diuangkan</option>
            </select>
          </div>
          {aturan.sisa === "dibawa"
            ? angka("bawa_maks", "Maks dibawa (hari)")
            : null}
          {aturan.sisa === "dibawa"
            ? angka("bawa_bulan", "Dipakai dalam (bulan)")
            : null}
          {aturan.periode === "kalender" ? (
            <label
              className="flex items-center gap-2 text-sm text-slate-200"
              htmlFor="cuti-aturan-prorata"
            >
              <input
                id="cuti-aturan-prorata"
                type="checkbox"
                checked={aturan.prorata}
                onChange={(e) =>
                  setAturan({ ...aturan, prorata: e.target.checked })
                }
              />
              Prorata di tahun pertama berhak
            </label>
          ) : null}
          <div className="sm:col-span-3">
            <button
              type="button"
              id="cuti-aturan-simpan"
              className={TOMBOL_UTAMA}
              disabled={sibuk}
              onClick={() => void simpanAturan()}
            >
              Simpan aturan cuti
            </button>
          </div>
        </section>
      ) : null}
      {pesan ? (
        <output className="block text-sm text-slate-300">{pesan}</output>
      ) : null}
    </div>
  );
}
