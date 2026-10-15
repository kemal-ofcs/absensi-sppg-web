"use client";

import { useCallback, useEffect, useState } from "react";
import {
  hariIniWib,
  INPUT,
  LABEL,
  pesanGalat,
  TOMBOL_KEDUA,
} from "@/components/inventory/gaya";
import {
  eksporTabelExcel,
  type TabelLaporan,
  tabelAktivitas,
  tabelArusKas,
  tabelPosisi,
} from "@/components/keuangan/eksporKeuangan";
import type { DownloadResult } from "@/lib/client/download";
import {
  type AkunItem,
  getLaporanAktivitas,
  getLaporanArusKas,
  getLaporanPosisi,
  getStatusTutupBuku,
  type StatusTutupBuku,
} from "@/lib/gateways/accounting";
import { subscribeSyncCompleted } from "@/lib/gateways/sync-status";
import { formatRupiah, MAKS_AKUN_KAS } from "@/lib/validations/accounting";
import { tanggalTampil, waktuTampil } from "@/lib/validations/tutup-buku";

type JenisLaporan = "posisi" | "aktivitas" | "arus";

/**
 * Keterangan untuk laporan yang tanggal akhirnya sudah masuk periode
 * tertutup: tutup buku berlaku terkecil yang mencakup tanggal itu.
 */
function keteranganTutup(
  status: StatusTutupBuku | null,
  sampai: string,
): string | undefined {
  const tutup = status?.riwayat
    .filter((t) => t.status === "Aktif" && t.sampai_tanggal >= sampai)
    .sort((a, b) => (a.sampai_tanggal < b.sampai_tanggal ? -1 : 1))[0];
  if (!tutup) return undefined;
  const dasar = `Periode ini sudah ditutup sampai ${tanggalTampil(tutup.sampai_tanggal)} oleh ${tutup.dibuat_oleh} pada ${waktuTampil(tutup.waktu_perangkat)} (menurut jam perangkat).`;
  return tutup.perlu_ditinjau
    ? `${dasar} Angkanya sudah berubah sejak ditutup karena ada transaksi yang masuk sesudahnya; tinjau di tab Tutup Buku.`
    : dasar;
}

const LABEL_JENIS: Record<JenisLaporan, string> = {
  posisi: "Neraca",
  aktivitas: "Laba Rugi",
  arus: "Arus Kas",
};

/** Akun kas bawaan bagan akun; dipilih otomatis bila ada dan aktif. */
const AKUN_KAS_BAWAAN = ["akun-kas", "akun-bank"];

interface AksiEkspor {
  label: string;
  jenis: "Excel" | "PDF";
  kerja: () => Promise<DownloadResult>;
}

/** Tombol ekspor beserta satu baris kabar hasilnya. */
export function BarisEkspor({ aksi }: { aksi: AksiEkspor[] }) {
  const [sibuk, setSibuk] = useState(false);
  const [kabar, setKabar] = useState<{ teks: string; galat: boolean } | null>(
    null,
  );

  async function jalankan(item: AksiEkspor) {
    setSibuk(true);
    setKabar(null);
    try {
      const hasil = await item.kerja();
      setKabar(
        hasil.sukses
          ? { teks: `Berkas ${item.jenis} tersimpan.`, galat: false }
          : hasil.cancelled
            ? null
            : {
                teks: `Berkas ${item.jenis} tidak bisa disimpan.`,
                galat: true,
              },
      );
    } catch (error) {
      setKabar({
        teks: pesanGalat(error, `Berkas ${item.jenis} tidak bisa dibuat.`),
        galat: true,
      });
    } finally {
      setSibuk(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {aksi.map((item) => (
        <button
          key={item.label}
          type="button"
          className={TOMBOL_KEDUA}
          disabled={sibuk}
          onClick={() => void jalankan(item)}
        >
          {item.label}
        </button>
      ))}
      <output
        aria-live="polite"
        className={`text-sm ${kabar?.galat ? "text-rose-300" : "text-emerald-300"}`}
      >
        {kabar?.teks}
      </output>
    </div>
  );
}

export function LaporanKeuangan({ akun }: { akun: AkunItem[] }) {
  const hariIni = hariIniWib();
  const akunAset = akun.filter((a) => a.kelompok === "Aset" && a.is_aktif);
  const [jenis, setJenis] = useState<JenisLaporan>("posisi");
  const [dari, setDari] = useState(`${hariIni.slice(0, 5)}01-01`);
  const [sampai, setSampai] = useState(hariIni);
  const [akunKas, setAkunKas] = useState<string[]>(() =>
    AKUN_KAS_BAWAAN.filter((id) => akunAset.some((a) => a.id_akun === id)),
  );
  const [tabel, setTabel] = useState<TabelLaporan | null>(null);
  const [galatMuat, setGalatMuat] = useState<string | null>(null);

  const kunciKas = akunKas.join(",");
  const muat = useCallback(async () => {
    setTabel(null);
    setGalatMuat(null);
    try {
      // Status tutup buku hanya keterangan; gagal membacanya tidak menahan laporan.
      const statusTutup = getStatusTutupBuku().catch(() => null);
      let hasil: TabelLaporan | null = null;
      if (jenis === "posisi") {
        hasil = tabelPosisi(await getLaporanPosisi(sampai));
      } else if (jenis === "aktivitas") {
        hasil = tabelAktivitas(await getLaporanAktivitas(dari, sampai));
      } else if (kunciKas) {
        hasil = tabelArusKas(
          await getLaporanArusKas(dari, sampai, kunciKas.split(",")),
        );
      }
      if (hasil) {
        setTabel({
          ...hasil,
          keterangan: keteranganTutup(await statusTutup, sampai),
        });
      }
    } catch (error) {
      setGalatMuat(pesanGalat(error, "Laporan tidak bisa dimuat."));
    }
  }, [jenis, dari, sampai, kunciKas]);

  useEffect(() => {
    void muat();
  }, [muat]);
  useEffect(() => subscribeSyncCompleted(() => void muat()), [muat]);

  function alihKas(id: string, pilih: boolean) {
    setAkunKas((lama) =>
      pilih ? [...lama, id] : lama.filter((item) => item !== id),
    );
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-[2fr_1fr_1fr]">
        <div>
          <label className={LABEL} htmlFor="laporan-jenis">
            Laporan
          </label>
          <select
            id="laporan-jenis"
            className={INPUT}
            value={jenis}
            onChange={(e) => setJenis(e.target.value as JenisLaporan)}
          >
            {(Object.keys(LABEL_JENIS) as JenisLaporan[]).map((id) => (
              <option key={id} value={id}>
                {LABEL_JENIS[id]}
              </option>
            ))}
          </select>
        </div>
        {jenis === "posisi" ? (
          <div>
            <label className={LABEL} htmlFor="laporan-sampai">
              Per tanggal
            </label>
            <input
              id="laporan-sampai"
              type="date"
              className={INPUT}
              value={sampai}
              onChange={(e) => setSampai(e.target.value)}
            />
          </div>
        ) : (
          <>
            <div>
              <label className={LABEL} htmlFor="laporan-dari">
                Dari tanggal
              </label>
              <input
                id="laporan-dari"
                type="date"
                className={INPUT}
                value={dari}
                max={sampai}
                onChange={(e) => setDari(e.target.value)}
              />
            </div>
            <div>
              <label className={LABEL} htmlFor="laporan-sampai">
                Sampai tanggal
              </label>
              <input
                id="laporan-sampai"
                type="date"
                className={INPUT}
                value={sampai}
                min={dari}
                onChange={(e) => setSampai(e.target.value)}
              />
            </div>
          </>
        )}
      </div>

      {jenis === "arus" ? (
        <fieldset className="rounded-xl border border-slate-800 p-3">
          <legend className="px-1 text-sm text-slate-300">
            Akun yang dihitung sebagai kas (paling banyak {MAKS_AKUN_KAS})
          </legend>
          <div className="flex flex-wrap gap-x-4 gap-y-2">
            {akunAset.map((a) => {
              const dipilih = akunKas.includes(a.id_akun);
              return (
                <label
                  key={a.id_akun}
                  className="flex min-h-11 items-center gap-2 text-sm text-slate-100"
                >
                  <input
                    type="checkbox"
                    checked={dipilih}
                    disabled={!dipilih && akunKas.length >= MAKS_AKUN_KAS}
                    onChange={(e) => alihKas(a.id_akun, e.target.checked)}
                  />
                  {a.kode} {a.nama}
                </label>
              );
            })}
          </div>
        </fieldset>
      ) : null}

      {jenis === "arus" && !kunciKas ? (
        <p className="p-6 text-center text-sm text-slate-400">
          Pilih minimal satu akun kas.
        </p>
      ) : galatMuat ? (
        <div className="p-4 rounded-xl border border-rose-500/30 bg-rose-500/20 text-sm text-rose-100 space-y-3">
          <p>{galatMuat}</p>
          <button
            type="button"
            className={TOMBOL_KEDUA}
            onClick={() => void muat()}
          >
            Coba muat lagi
          </button>
        </div>
      ) : !tabel ? (
        <p className="p-6 text-center text-sm text-slate-400">
          Menyusun laporan...
        </p>
      ) : (
        <div className="space-y-3">
          {tabel.peringatan ? (
            <p
              role="alert"
              className="p-3 rounded-lg border border-amber-500/30 bg-amber-500/20 text-sm text-amber-100"
            >
              {tabel.peringatan}
            </p>
          ) : null}
          <div className="rounded-xl border border-slate-800 bg-slate-900/60">
            <div className="px-3 py-3 border-b border-slate-800">
              <h2 className="text-base font-semibold text-slate-100">
                {tabel.judul}
              </h2>
              <p className="text-xs text-slate-400">{tabel.periode}</p>
              {tabel.keterangan ? (
                <p className="mt-1 text-xs text-slate-300">
                  {tabel.keterangan}
                </p>
              ) : null}
            </div>
            <table className="w-full text-left text-sm">
              <thead className="sr-only">
                <tr>
                  <th scope="col">Keterangan</th>
                  <th scope="col">Jumlah</th>
                </tr>
              </thead>
              <tbody>
                {tabel.baris.map((b, indeks) =>
                  b.jenis === "bagian" ? (
                    <tr
                      key={`${indeks}-${b.label}`}
                      className="border-t border-slate-800 first:border-t-0"
                    >
                      <th
                        colSpan={2}
                        scope="colgroup"
                        className="px-3 pt-4 pb-1 text-xs font-semibold uppercase tracking-wide text-slate-400"
                      >
                        {b.label}
                      </th>
                    </tr>
                  ) : (
                    <tr
                      key={`${indeks}-${b.label}`}
                      className={
                        b.jenis === "total" ? "border-t border-slate-700" : ""
                      }
                    >
                      <td
                        className={`px-3 py-1.5 ${
                          b.jenis === "total"
                            ? "font-semibold text-slate-100"
                            : "pl-6 text-slate-200"
                        }`}
                      >
                        {b.kode ? (
                          <span className="mr-2 text-xs text-slate-400">
                            {b.kode}
                          </span>
                        ) : null}
                        {b.label}
                      </td>
                      <td
                        className={`px-3 py-1.5 text-right tabular-nums whitespace-nowrap ${
                          b.jenis === "total"
                            ? "font-semibold text-slate-100"
                            : "text-slate-200"
                        }`}
                      >
                        {b.jumlah === undefined ? null : formatRupiah(b.jumlah)}
                      </td>
                    </tr>
                  ),
                )}
              </tbody>
            </table>
          </div>
          <BarisEkspor
            aksi={[
              {
                label: "Ekspor Excel",
                jenis: "Excel",
                kerja: () => eksporTabelExcel(tabel),
              },
            ]}
          />
        </div>
      )}
    </div>
  );
}
