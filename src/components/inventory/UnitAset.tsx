"use client";

import { type FormEvent, useState } from "react";
import { Modal } from "@/components/ui/Modal";
import {
  type BarangInventaris,
  daftarkanUnitInventaris,
  type PosisiStok,
  simpanUnitInventaris,
} from "@/lib/gateways/inventory";
import { INPUT, LABEL, pesanGalat, TOMBOL_KEDUA, TOMBOL_UTAMA } from "./gaya";

type SubmitRef = { current: boolean };

/** Stok tanpa nomor: posisi yang belum menjadi unit. */
export function stokBelumBernomor(barang: BarangInventaris): PosisiStok[] {
  return barang.posisi.filter((p) => p.id_batch === null && p.saldo > 0);
}

/** Aset yang boleh didaftarkan per unit, dan masih punya stok tanpa nomor. */
export function bisaDaftarkanUnit(barang: BarangInventaris): boolean {
  return (
    barang.tipe === "Aset" &&
    !barang.bisa_expired &&
    barang.status_aktif &&
    stokBelumBernomor(barang).length > 0
  );
}

export function DialogDaftarkanUnit({
  barang,
  isSubmittingRef,
  onClose,
  onSaved,
}: {
  barang: BarangInventaris;
  isSubmittingRef: SubmitRef;
  onClose: () => void;
  onSaved: (message: string) => Promise<void>;
}) {
  const belum = stokBelumBernomor(barang);
  const total = belum.reduce((sum, p) => sum + p.saldo, 0);
  const [galat, setGalat] = useState<string | null>(null);
  const [menyimpan, setMenyimpan] = useState(false);

  const kirim = async () => {
    if (isSubmittingRef.current) return;
    isSubmittingRef.current = true;
    setMenyimpan(true);
    setGalat(null);
    try {
      const hasil = await daftarkanUnitInventaris(barang.id_barang);
      await onSaved(
        `${hasil.jumlah} unit ${barang.nama_barang} terdaftar (${hasil.nomor_dokumen}). Label per unit bisa dicetak dari tombol Cetak label QR.`,
      );
    } catch (error) {
      setGalat(pesanGalat(error, "Unit tidak bisa didaftarkan."));
    } finally {
      isSubmittingRef.current = false;
      setMenyimpan(false);
    }
  };

  return (
    <Modal
      isOpen={true}
      onClose={onClose}
      title="Daftarkan unit"
      titleId="inv-daftar-unit-judul"
    >
      <div className="space-y-4 text-sm text-slate-300">
        <p>
          {total} {barang.satuan} {barang.nama_barang} yang belum bernomor akan
          menjadi {total} unit dengan kode {barang.kode_barang}-01 dan
          seterusnya. Jumlah stoknya tidak berubah.
        </p>
        <ul className="divide-y divide-slate-800 rounded-lg border border-slate-800">
          {belum.map((p) => (
            <li
              key={`${p.tempat}|${p.kondisi}`}
              className="flex justify-between gap-2 px-3 py-2"
            >
              <span>
                {p.tempat}
                <span className="text-slate-400"> · {p.kondisi}</span>
              </span>
              <span className="font-semibold text-slate-100">{p.saldo}</span>
            </li>
          ))}
        </ul>
        <p className="text-slate-400">
          Setelah ini, barang keluar, pindah, dan dipinjam wajib memilih
          unitnya, dan setiap unit bisa diberi nomor seri. Pendaftaran tidak
          bisa dibatalkan.
        </p>
        {galat ? (
          <p role="alert" className="text-rose-200">
            {galat}
          </p>
        ) : null}
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" onClick={onClose} className={TOMBOL_KEDUA}>
            Batal
          </button>
          <button
            type="button"
            onClick={() => void kirim()}
            disabled={menyimpan}
            className={TOMBOL_UTAMA}
          >
            {menyimpan ? "Mendaftarkan..." : `Daftarkan ${total} unit`}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** Nomor seri dan catatan satu unit. Kode unit tetap: sudah tercetak di label. */
export function DialogUnit({
  barang,
  posisi,
  isSubmittingRef,
  onClose,
  onSaved,
}: {
  barang: BarangInventaris;
  posisi: PosisiStok;
  isSubmittingRef: SubmitRef;
  onClose: () => void;
  onSaved: (message: string) => Promise<void>;
}) {
  const [nomorSeri, setNomorSeri] = useState(posisi.nomor_seri ?? "");
  const [catatan, setCatatan] = useState(posisi.catatan_unit ?? "");
  const [galat, setGalat] = useState<string | null>(null);
  const [menyimpan, setMenyimpan] = useState(false);

  const kirim = async (event: FormEvent) => {
    event.preventDefault();
    if (isSubmittingRef.current || !posisi.id_batch) return;
    isSubmittingRef.current = true;
    setMenyimpan(true);
    setGalat(null);
    try {
      await simpanUnitInventaris({
        id_unit: posisi.id_batch,
        nomor_seri: nomorSeri,
        catatan,
      });
      await onSaved(`Unit ${posisi.kode_unit} tersimpan.`);
    } catch (error) {
      setGalat(pesanGalat(error, "Unit tidak bisa disimpan."));
    } finally {
      isSubmittingRef.current = false;
      setMenyimpan(false);
    }
  };

  return (
    <Modal
      isOpen={true}
      onClose={onClose}
      title={`Unit ${posisi.kode_unit ?? ""}`}
      titleId="inv-unit-judul"
    >
      <form onSubmit={kirim} className="space-y-4">
        <p className="text-sm text-slate-400">
          {barang.nama_barang} · {posisi.tempat} · {posisi.kondisi}
        </p>
        <div>
          <label htmlFor="inv-unit-seri" className={LABEL}>
            Nomor seri (opsional)
          </label>
          <input
            id="inv-unit-seri"
            maxLength={60}
            value={nomorSeri}
            onChange={(e) => setNomorSeri(e.target.value)}
            className={INPUT}
          />
        </div>
        <div>
          <label htmlFor="inv-unit-catatan" className={LABEL}>
            Catatan (opsional)
          </label>
          <input
            id="inv-unit-catatan"
            maxLength={200}
            value={catatan}
            onChange={(e) => setCatatan(e.target.value)}
            className={INPUT}
          />
        </div>
        {galat ? (
          <p role="alert" className="text-sm text-rose-200">
            {galat}
          </p>
        ) : null}
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" onClick={onClose} className={TOMBOL_KEDUA}>
            Batal
          </button>
          <button type="submit" disabled={menyimpan} className={TOMBOL_UTAMA}>
            {menyimpan ? "Menyimpan..." : "Simpan"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
