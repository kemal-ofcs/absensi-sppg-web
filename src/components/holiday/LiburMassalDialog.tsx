"use client";

import { useId, useRef, useState } from "react";
import { Modal } from "@/components/ui/Modal";
import { formatTanggalOperasional } from "@/lib/attendance/time-policy";
import {
  type HasilLiburMassal,
  tambahHariLiburMassal,
} from "@/lib/gateways/holiday";
import {
  JENIS_LIBUR,
  MAKS_LIBUR_MASSAL,
  rentangTanggal,
} from "@/lib/validations/hari-kerja";

const LABEL_JENIS: Record<string, string> = {
  "Libur Nasional": "Libur Nasional",
  "Cuti Bersama": "Cuti Bersama",
  "Libur Khusus": "Libur Khusus Perusahaan",
};

const kelasInput =
  "min-h-11 w-full rounded-xl border border-slate-800 bg-slate-900 px-3.5 text-white outline-none focus:border-sky-500";
const kelasLabel = "mb-1 block text-xs font-bold tracking-wide text-slate-300";

/**
 * Menambah banyak hari libur sekaligus dari satu rentang tanggal, misalnya
 * cuti bersama. Hasilnya baris `tbl_hari_libur` biasa, jadi tetap bisa
 * disunting dan dihapus satu per satu. Libur mingguan TIDAK diisi di sini:
 * itu aturan hari kerja shift. Dipakai halaman Hari Libur Web/Desktop dan
 * Mobile (disalin lewat `filesToCopy`).
 */
export function LiburMassalDialog({
  tanggalTerdaftar,
  onClose,
  onSaved,
}: {
  tanggalTerdaftar: ReadonlySet<string>;
  onClose: () => void;
  onSaved: (hasil: HasilLiburMassal) => void;
}) {
  const idDasar = useId();
  const isSubmittingRef = useRef(false);
  const [saving, setSaving] = useState(false);
  const [galat, setGalat] = useState<string | null>(null);

  const hariIni = formatTanggalOperasional(Date.now());
  const [mulai, setMulai] = useState(hariIni);
  const [sampai, setSampai] = useState(hariIni);
  const [nama, setNama] = useState("");
  const [jenis, setJenis] = useState<string>("Cuti Bersama");
  const [keterangan, setKeterangan] = useState("");

  const tanggalRentang = rentangTanggal(mulai, sampai);
  const rentangBaru = tanggalRentang.filter((t) => !tanggalTerdaftar.has(t));

  const simpan = async () => {
    if (isSubmittingRef.current) return;
    if (!nama.trim()) {
      setGalat("Isi nama libur, misalnya Cuti Bersama Idul Fitri.");
      return;
    }
    if (tanggalRentang.length === 0) {
      setGalat("Tanggal akhir tidak boleh sebelum tanggal mulai.");
      return;
    }
    isSubmittingRef.current = true;
    setSaving(true);
    setGalat(null);
    try {
      onSaved(
        await tambahHariLiburMassal(
          tanggalRentang.map((tanggal) => ({
            tanggal,
            nama_libur: nama.trim(),
            jenis_libur: jenis,
            keterangan: keterangan.trim() || null,
          })),
        ),
      );
    } catch (err) {
      setGalat(
        err instanceof Error ? err.message : "Hari libur gagal disimpan.",
      );
    } finally {
      isSubmittingRef.current = false;
      setSaving(false);
    }
  };

  const jumlahSimpan = rentangBaru.length;

  return (
    <Modal
      isOpen
      titleId={`${idDasar}-judul`}
      title="Tambah Banyak Hari Libur"
      maxWidth="max-w-2xl"
      onClose={() => !saving && onClose()}
    >
      <div className="space-y-4">
        <div className="space-y-3">
          <p className="text-sm text-slate-400">
            Untuk libur yang berlangsung beberapa hari, misalnya cuti bersama.
            Setiap tanggal disimpan sebagai satu baris yang bisa disunting
            sendiri nanti. Sabtu dan Minggu cukup diatur sebagai hari kerja di
            halaman Shift.
          </p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor={`${idDasar}-mulai`} className={kelasLabel}>
                Dari tanggal
              </label>
              <input
                id={`${idDasar}-mulai`}
                type="date"
                value={mulai}
                onChange={(e) => {
                  setMulai(e.target.value);
                  if (sampai < e.target.value) setSampai(e.target.value);
                }}
                className={kelasInput}
              />
            </div>
            <div>
              <label htmlFor={`${idDasar}-sampai`} className={kelasLabel}>
                Sampai tanggal
              </label>
              <input
                id={`${idDasar}-sampai`}
                type="date"
                value={sampai}
                min={mulai}
                onChange={(e) => setSampai(e.target.value)}
                className={kelasInput}
              />
            </div>
          </div>
          <div>
            <label htmlFor={`${idDasar}-nama`} className={kelasLabel}>
              Nama libur
            </label>
            <input
              id={`${idDasar}-nama`}
              type="text"
              value={nama}
              maxLength={120}
              placeholder="Contoh: Cuti Bersama Idul Fitri"
              onChange={(e) => setNama(e.target.value)}
              className={kelasInput}
            />
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor={`${idDasar}-jenis`} className={kelasLabel}>
                Jenis
              </label>
              <select
                id={`${idDasar}-jenis`}
                value={jenis}
                onChange={(e) => setJenis(e.target.value)}
                className={kelasInput}
              >
                {JENIS_LIBUR.map((j) => (
                  <option key={j} value={j}>
                    {LABEL_JENIS[j]}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor={`${idDasar}-keterangan`} className={kelasLabel}>
                Keterangan (opsional)
              </label>
              <input
                id={`${idDasar}-keterangan`}
                type="text"
                value={keterangan}
                onChange={(e) => setKeterangan(e.target.value)}
                className={kelasInput}
              />
            </div>
          </div>
          <p aria-live="polite" className="text-sm text-slate-300">
            {tanggalRentang.length === 0
              ? "Tanggal akhir tidak boleh sebelum tanggal mulai."
              : tanggalRentang.length > MAKS_LIBUR_MASSAL
                ? `Rentang terlalu panjang. Paling banyak ${MAKS_LIBUR_MASSAL} hari sekali simpan.`
                : `${tanggalRentang.length} hari, ${rentangBaru.length} di antaranya belum terdaftar.`}
          </p>
        </div>

        {galat ? (
          <p
            role="alert"
            className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-200"
          >
            {galat}
          </p>
        ) : null}

        <div className="flex flex-wrap items-center justify-end gap-3 pt-1">
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="min-h-11 rounded-xl border border-slate-800 px-4 text-sm font-semibold text-slate-300 transition hover:bg-white/5"
          >
            Batal
          </button>
          <button
            type="button"
            onClick={simpan}
            disabled={saving || jumlahSimpan === 0}
            className="min-h-11 rounded-xl bg-sky-700 px-5 text-sm font-bold text-white transition hover:bg-sky-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300 disabled:opacity-50"
          >
            {saving
              ? "Menyimpan..."
              : jumlahSimpan === 0
                ? "Tidak ada tanggal baru"
                : `Simpan ${jumlahSimpan} tanggal`}
          </button>
        </div>
      </div>
    </Modal>
  );
}
