"use client";

// Jatah cuti per periode satu karyawan (HRIS v37, prd-hris.md §17.7). Jatah
// tidak disimpan: dihitung backend dari pengajuan berlaku dan penyesuaian.
// Dipakai tab Cuti di rincian karyawan dan ringkasan form pengajuan.

import { useCallback, useEffect, useState } from "react";
import {
  INPUT,
  LABEL,
  pesanGalat,
  TOMBOL_UTAMA,
} from "@/components/inventory/gaya";
import { konfirmasiData } from "@/components/ui/KonfirmasiData";
import {
  ambilJatahCuti,
  batalkanPenyesuaianCuti,
  type JatahCuti,
  simpanPenyesuaianCuti,
} from "@/lib/gateways/hr-pengajuan";
import { SYNC_COMPLETED_EVENT } from "@/lib/gateways/sync-status";

export function JatahCutiPanel({
  idKaryawan,
  bolehUbah,
}: {
  idKaryawan: string;
  bolehUbah: boolean;
}) {
  const [data, setData] = useState<JatahCuti | null>(null);
  const [pesan, setPesan] = useState("");
  const [sibuk, setSibuk] = useState(false);
  const [isi, setIsi] = useState({
    periode: "",
    jenis: "Saldo Awal",
    hari: "",
    alasan: "",
  });

  const muat = useCallback(() => {
    ambilJatahCuti(idKaryawan)
      .then(setData)
      .catch((error: unknown) =>
        setPesan(pesanGalat(error, "Jatah cuti gagal dimuat.")),
      );
  }, [idKaryawan]);
  useEffect(() => {
    muat();
    window.addEventListener(SYNC_COMPLETED_EVENT, muat);
    return () => window.removeEventListener(SYNC_COMPLETED_EVENT, muat);
  }, [muat]);

  const jalankan = async (kerja: () => Promise<unknown>, berhasil: string) => {
    setSibuk(true);
    try {
      await kerja();
      setPesan(berhasil);
      muat();
    } catch (error) {
      setPesan(pesanGalat(error, "Gagal."));
    } finally {
      setSibuk(false);
    }
  };

  const simpan = async () => {
    const hari = Number(isi.hari);
    const lanjut = await konfirmasiData([
      { label: "Periode", nilai: isi.periode },
      { label: "Jenis", nilai: isi.jenis },
      { label: "Hari", nilai: isi.hari },
      { label: "Alasan", nilai: isi.alasan },
    ]);
    if (!lanjut) return;
    await jalankan(
      () => simpanPenyesuaianCuti({ id_karyawan: idKaryawan, ...isi, hari }),
      "Penyesuaian tersimpan.",
    );
    setIsi((lama) => ({ ...lama, hari: "", alasan: "" }));
  };

  const batalkan = async (idPenyesuaian: string) => {
    const alasan = window.prompt("Alasan membatalkan penyesuaian ini?") ?? "";
    if (!alasan.trim()) return;
    await jalankan(
      () => batalkanPenyesuaianCuti({ id_penyesuaian: idPenyesuaian, alasan }),
      "Penyesuaian dibatalkan.",
    );
  };

  if (!data) {
    return <p className="text-sm text-slate-400">{pesan || "Memuat..."}</p>;
  }
  const periode = [...data.periode].reverse();
  return (
    <div className="space-y-4">
      {data.tanggal_masuk ? null : (
        <p className="text-sm text-amber-200">
          Tanggal masuk belum diisi, jadi jatah cuti belum bisa dihitung.
        </p>
      )}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[34rem] text-left text-sm">
          <thead className="text-xs text-slate-400">
            <tr>
              <th className="py-2 pr-3">Periode</th>
              <th className="py-2 pr-3 text-right">Hak</th>
              <th className="py-2 pr-3 text-right">Bawaan</th>
              <th className="py-2 pr-3 text-right">Penyesuaian</th>
              <th className="py-2 pr-3 text-right">Terpakai</th>
              <th className="py-2 text-right">Sisa</th>
            </tr>
          </thead>
          <tbody>
            {periode.map((p) => (
              <tr key={p.mulai} className="border-t border-slate-800">
                <td className="py-2 pr-3 text-slate-200">
                  {p.mulai} s.d. {p.selesai}
                  {p.sebelum_berhak ? (
                    <span className="block text-xs text-amber-200">
                      Sebelum berhak cuti
                    </span>
                  ) : null}
                </td>
                <td className="py-2 pr-3 text-right">{p.hak}</td>
                <td className="py-2 pr-3 text-right">
                  {p.bawaan}
                  {p.bawaan_sampai ? (
                    <span className="block text-xs text-slate-400">
                      {p.bawaan_hangus > 0
                        ? `${p.bawaan_hangus} hangus`
                        : `s.d. ${p.bawaan_sampai}`}
                    </span>
                  ) : null}
                </td>
                <td className="py-2 pr-3 text-right">{p.penyesuaian}</td>
                <td className="py-2 pr-3 text-right">{p.terpakai}</td>
                <td
                  className={`py-2 text-right font-bold ${p.sisa < 0 ? "text-rose-200" : "text-white"}`}
                >
                  {p.sisa}
                  {p.sisa < 0 ? (
                    <span className="block text-xs font-normal">
                      Jatah minus
                    </span>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {data.penyesuaian.length > 0 ? (
        <ul className="space-y-1 text-sm">
          {data.penyesuaian.map(({ baris, dibatalkan }) => (
            <li
              key={baris.id_penyesuaian}
              className={`flex flex-wrap items-center gap-2 ${dibatalkan ? "text-slate-500 line-through" : "text-slate-200"}`}
            >
              <span>
                {baris.periode} • {baris.jenis} {baris.hari > 0 ? "+" : ""}
                {baris.hari} hari
                {baris.nominal !== null
                  ? ` • Rp ${baris.nominal.toLocaleString("id-ID")}`
                  : ""}{" "}
                • {baris.alasan}
              </span>
              {bolehUbah && !dibatalkan ? (
                <button
                  type="button"
                  id={`cuti-batal-${baris.id_penyesuaian}`}
                  className="text-xs text-rose-200 underline"
                  disabled={sibuk}
                  onClick={() => void batalkan(baris.id_penyesuaian)}
                >
                  Batalkan
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      {bolehUbah && periode.length > 0 ? (
        <div className="grid gap-3 rounded-xl border border-slate-800 p-3 sm:grid-cols-2">
          <div>
            <label className={LABEL} htmlFor="cuti-adj-periode">
              Periode
            </label>
            <select
              id="cuti-adj-periode"
              className={INPUT}
              value={isi.periode}
              onChange={(e) => setIsi({ ...isi, periode: e.target.value })}
            >
              <option value="">Pilih periode</option>
              {periode.map((p) => (
                <option key={p.mulai} value={p.mulai}>
                  {p.mulai} s.d. {p.selesai}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className={LABEL} htmlFor="cuti-adj-jenis">
              Jenis
            </label>
            <select
              id="cuti-adj-jenis"
              className={INPUT}
              value={isi.jenis}
              onChange={(e) => setIsi({ ...isi, jenis: e.target.value })}
            >
              <option value="Saldo Awal">Saldo Awal</option>
              <option value="Koreksi">Koreksi</option>
            </select>
          </div>
          <div>
            <label className={LABEL} htmlFor="cuti-adj-hari">
              Hari (minus = mengurangi)
            </label>
            <input
              id="cuti-adj-hari"
              type="number"
              step={1}
              className={INPUT}
              value={isi.hari}
              onChange={(e) => setIsi({ ...isi, hari: e.target.value })}
            />
          </div>
          <div>
            <label className={LABEL} htmlFor="cuti-adj-alasan">
              Alasan
            </label>
            <input
              id="cuti-adj-alasan"
              className={INPUT}
              value={isi.alasan}
              maxLength={500}
              onChange={(e) => setIsi({ ...isi, alasan: e.target.value })}
            />
          </div>
          <div className="flex gap-2 sm:col-span-2">
            <button
              type="button"
              id="cuti-adj-simpan"
              className={TOMBOL_UTAMA}
              disabled={sibuk}
              onClick={() => void simpan()}
            >
              Simpan penyesuaian
            </button>
          </div>
        </div>
      ) : null}
      {pesan ? <p className="text-sm text-slate-300">{pesan}</p> : null}
    </div>
  );
}
