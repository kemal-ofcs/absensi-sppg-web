"use client";

// Ikut disalin ke Mobile lewat `filesToCopy`. Tombolnya di badan dialog karena
// `Modal` Mobile tidak punya `footer`.

import { useRef, useState } from "react";
import {
  hariIniWib,
  INPUT,
  LABEL,
  TOMBOL_KEDUA,
  TOMBOL_UTAMA,
} from "@/components/inventory/gaya";
import { Modal } from "@/components/ui/Modal";
import {
  MAKS_HARI_LAPORAN,
  validateRentangLaporan,
} from "@/lib/validations/laporan-kehadiran";
import { eksporLaporanKehadiran } from "./laporanKehadiranExcel";

export function EksporLaporanKehadiran({
  onClose,
  onTersimpan,
}: {
  onClose: () => void;
  onTersimpan: (namaBerkas: string) => void;
}) {
  const [selesai, setSelesai] = useState(hariIniWib);
  const [mulai, setMulai] = useState(() => `${hariIniWib().slice(0, 8)}01`);
  const [galat, setGalat] = useState("");
  const [menyimpan, setMenyimpan] = useState(false);
  const menyimpanRef = useRef(false);

  const ekspor = async () => {
    if (menyimpanRef.current) return;
    const rentang = validateRentangLaporan(mulai, selesai);
    if (!rentang.ok) {
      setGalat(rentang.error);
      return;
    }
    menyimpanRef.current = true;
    setMenyimpan(true);
    setGalat("");
    try {
      const hasil = await eksporLaporanKehadiran(mulai, selesai);
      if (hasil.sukses) onTersimpan(hasil.filename || "Laporan kehadiran");
    } catch (error) {
      setGalat(
        error instanceof Error
          ? error.message
          : "Laporan kehadiran tidak bisa dibuat.",
      );
    } finally {
      menyimpanRef.current = false;
      setMenyimpan(false);
    }
  };

  return (
    <Modal
      isOpen={true}
      onClose={onClose}
      title="Ekspor Laporan Kehadiran"
      titleId="laporan-kehadiran-judul"
      hideFooter
    >
      <div className="space-y-4">
        <p className="text-sm text-slate-300">
          Satu baris per karyawan dan satu kolom per tanggal (H, T, S, I, D, A,
          atau alasan libur), lalu total hadir, sakit, izin, dan seterusnya.
          Paling panjang {MAKS_HARI_LAPORAN} hari.
        </p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor="laporan-mulai" className={LABEL}>
              Dari tanggal
            </label>
            <input
              id="laporan-mulai"
              type="date"
              value={mulai}
              max={selesai}
              onChange={(e) => setMulai(e.target.value)}
              className={INPUT}
            />
          </div>
          <div>
            <label htmlFor="laporan-selesai" className={LABEL}>
              Sampai tanggal
            </label>
            <input
              id="laporan-selesai"
              type="date"
              value={selesai}
              min={mulai}
              onChange={(e) => setSelesai(e.target.value)}
              className={INPUT}
            />
          </div>
        </div>
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
            {menyimpan ? "Menyusun..." : "Ekspor Excel"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
