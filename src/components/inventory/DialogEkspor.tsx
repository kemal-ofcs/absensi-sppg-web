"use client";

import { type FormEvent, useState } from "react";
import { Modal } from "@/components/ui/Modal";
import type {
  BarangInventaris,
  DaftarInventaris,
} from "@/lib/validations/inventory";
import {
  daftarKolomEkspor,
  eksporInventaris,
  MAKS_JUDUL_MANUAL,
  type PilihanEkspor,
  PRESET_LEMBAR_VALIDASI,
  presetRekapStok,
} from "./ekspor";
import { INPUT, LABEL, pesanGalat, TOMBOL_KEDUA, TOMBOL_UTAMA } from "./gaya";

const KUNCI_PILIHAN = "kos.inventaris.ekspor";

/** Pilihan terakhir di perangkat ini; kunci kolom yang sudah tidak ada dibuang. */
function bacaPilihan(kunciSah: string[]): PilihanEkspor | null {
  try {
    const tersimpan = JSON.parse(localStorage.getItem(KUNCI_PILIHAN) ?? "null");
    if (
      tersimpan &&
      Array.isArray(tersimpan.kolom) &&
      Array.isArray(tersimpan.manual)
    ) {
      return {
        kolom: tersimpan.kolom.filter(
          (kunci: unknown) =>
            typeof kunci === "string" && kunciSah.includes(kunci),
        ),
        manual: tersimpan.manual.filter(
          (judul: unknown): judul is string =>
            typeof judul === "string" && judul.trim() !== "",
        ),
      };
    }
  } catch {
    // Isi rusak atau penyimpanan diblokir: jatuh ke preset rekap stok.
  }
  return null;
}

function simpanPilihan(pilihan: PilihanEkspor) {
  try {
    localStorage.setItem(KUNCI_PILIHAN, JSON.stringify(pilihan));
  } catch {
    // Hanya kenyamanan per perangkat; ekspor tetap memakai pilihan di layar.
  }
}

/**
 * Ekspor Excel daftar barang dengan kolom pilihan dan kolom isian manual,
 * misalnya lembar validasi stok. Mengikuti filter yang sedang aktif di layar.
 */
export function DialogEkspor({
  data,
  barang,
  tempat,
  onClose,
  onTersimpan,
}: {
  data: DaftarInventaris;
  barang: BarangInventaris[];
  tempat: string;
  onClose: () => void;
  onTersimpan: () => void;
}) {
  const semuaKolom = daftarKolomEkspor(data);
  const [pilihan, setPilihan] = useState<PilihanEkspor>(
    () =>
      bacaPilihan(semuaKolom.map((kolom) => kolom.kunci)) ??
      presetRekapStok(data),
  );
  const [judulBaru, setJudulBaru] = useState("");
  const [galat, setGalat] = useState("");
  const [menyimpan, setMenyimpan] = useState(false);

  const perPosisi = semuaKolom.some(
    (kolom) => kolom.perPosisi && pilihan.kolom.includes(kolom.kunci),
  );

  const ubahKolom = (kunci: string, dipilih: boolean) =>
    setPilihan((lama) => ({
      ...lama,
      kolom: dipilih
        ? [...lama.kolom, kunci]
        : lama.kolom.filter((item) => item !== kunci),
    }));

  const tambahManual = (event: FormEvent) => {
    event.preventDefault();
    const judul = judulBaru.trim();
    if (!judul) return;
    setPilihan((lama) => ({ ...lama, manual: [...lama.manual, judul] }));
    setJudulBaru("");
  };

  const ekspor = async () => {
    if (menyimpan) return;
    setMenyimpan(true);
    setGalat("");
    try {
      const hasil = await eksporInventaris(data, barang, tempat, pilihan);
      simpanPilihan(pilihan);
      if (hasil.sukses) onTersimpan();
    } catch (error) {
      setGalat(pesanGalat(error, "Berkas Excel tidak bisa disimpan."));
    } finally {
      setMenyimpan(false);
    }
  };

  return (
    <Modal
      isOpen={true}
      onClose={onClose}
      title="Ekspor Excel"
      titleId="inv-ekspor-judul"
    >
      <div className="space-y-4">
        <p className="text-sm text-slate-300">
          {barang.length} barang sesuai filter di layar
          {tempat ? `, hanya stok di ${tempat}` : ""}.{" "}
          {perPosisi
            ? "Satu baris per tempat, kondisi, dan batch."
            : "Satu baris per barang, kuantitas semua tempat dijumlahkan."}
        </p>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setPilihan(presetRekapStok(data))}
            className={TOMBOL_KEDUA}
          >
            Rekap stok
          </button>
          <button
            type="button"
            onClick={() => setPilihan(PRESET_LEMBAR_VALIDASI)}
            className={TOMBOL_KEDUA}
          >
            Lembar validasi
          </button>
        </div>
        <fieldset>
          <legend className={LABEL}>Kolom data</legend>
          <div className="grid grid-cols-1 gap-x-4 sm:grid-cols-2">
            {semuaKolom.map((kolom) => (
              <label
                key={kolom.kunci}
                className="flex min-h-11 items-center gap-2 text-sm text-slate-200"
              >
                <input
                  type="checkbox"
                  checked={pilihan.kolom.includes(kolom.kunci)}
                  onChange={(e) => ubahKolom(kolom.kunci, e.target.checked)}
                  className="h-4 w-4"
                />
                {kolom.judul}
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset className="space-y-2">
          <legend className={LABEL}>Kolom isian manual</legend>
          <p className="text-xs text-slate-400">
            Dikosongkan di berkas, untuk dicentang atau ditulis saat pengecekan.
          </p>
          {pilihan.manual.length > 0 ? (
            <ul className="divide-y divide-slate-800 rounded-lg border border-slate-800 bg-slate-950/40">
              {pilihan.manual.map((judul, index) => (
                <li
                  // Judul boleh kembar sementara; ditolak saat ekspor.
                  key={`${index}:${judul}`}
                  className="flex items-center justify-between gap-2 px-3 py-1"
                >
                  <span className="min-w-0 truncate text-sm text-slate-200">
                    {judul}
                  </span>
                  <button
                    type="button"
                    onClick={() =>
                      setPilihan((lama) => ({
                        ...lama,
                        manual: lama.manual.filter((_, i) => i !== index),
                      }))
                    }
                    aria-label={`Hapus kolom ${judul}`}
                    className={TOMBOL_KEDUA}
                  >
                    Hapus
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          <form onSubmit={tambahManual} className="flex items-end gap-2">
            <div className="min-w-0 flex-1">
              <label htmlFor="inv-ekspor-manual" className={LABEL}>
                Judul kolom baru
              </label>
              <input
                id="inv-ekspor-manual"
                maxLength={MAKS_JUDUL_MANUAL}
                value={judulBaru}
                onChange={(e) => setJudulBaru(e.target.value)}
                className={INPUT}
              />
            </div>
            <button
              type="submit"
              disabled={!judulBaru.trim()}
              className={TOMBOL_KEDUA}
            >
              Tambah
            </button>
          </form>
        </fieldset>
        {galat ? (
          <p
            role="alert"
            className="p-3 rounded-lg border border-rose-500/30 bg-rose-500/20 text-sm text-rose-100"
          >
            {galat}
          </p>
        ) : null}
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" onClick={onClose} className={TOMBOL_KEDUA}>
            Batal
          </button>
          <button
            type="button"
            disabled={menyimpan}
            onClick={() => void ekspor()}
            className={TOMBOL_UTAMA}
          >
            {menyimpan ? "Menyimpan..." : "Ekspor"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
