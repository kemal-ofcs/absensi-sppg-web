"use client";

import { useRef, useState } from "react";
import {
  jalankanBerurutan,
  ringkasHasil,
} from "@/components/operational/aturanPilihPersonil";
import { Modal } from "@/components/ui/Modal";
import { hasPermission } from "@/lib/auth/access";
import { exportToExcel } from "@/lib/client/excel-export";
import { readWorkbookTable } from "@/lib/client/xlsx";
import { useAuth } from "@/lib/context/AuthContext";
import {
  ambilProfil,
  simpanDataKeuangan,
  simpanDataPribadi,
} from "@/lib/gateways/hris";
import { KOLOM_KEUANGAN, KOLOM_PRIBADI } from "@/lib/validations/hris";
import {
  type BarisDataDiri,
  gabungIsian,
  type PegawaiRujukan,
  uraiDataDiri,
} from "@/lib/validations/impor-data-diri";

const TOMBOL =
  "min-h-10 rounded-xl border border-slate-700 px-4 text-sm font-semibold text-slate-200 hover:bg-slate-800 disabled:opacity-50";
const TOMBOL_UTAMA =
  "min-h-10 rounded-xl bg-sky-700 px-4 text-sm font-bold text-on-accent hover:bg-sky-600 disabled:opacity-50";

const pesanGalat = (error: unknown) =>
  error instanceof Error ? error.message : "Permintaan gagal.";

/**
 * Impor data diri (Pribadi dan Keuangan) banyak karyawan dari Excel. Tiap
 * baris disimpan lewat gateway yang sama dengan formulir, jadi izin dan aturan
 * isian diperiksa server per baris. Sel kosong mempertahankan nilai lama.
 */
export function ImporDataDiri({
  karyawan,
  onClose,
  onSelesai,
}: {
  karyawan: readonly Record<string, unknown>[];
  onClose: () => void;
  onSelesai: () => void;
}) {
  const { user } = useAuth();
  const izin = {
    pribadi: hasPermission(user, "hr.personal.manage"),
    keuangan: hasPermission(user, "hr.finance.manage"),
  };
  const rujukan: PegawaiRujukan[] = karyawan.map((k) => ({
    id_unik: String(k.id_unik ?? ""),
    kode_karyawan: String(k.kode_karyawan ?? ""),
    nama: String(k.nama ?? ""),
  }));
  const [baris, setBaris] = useState<BarisDataDiri[]>([]);
  const [catatan, setCatatan] = useState<string[]>([]);
  const [galat, setGalat] = useState<string | null>(null);
  const [berhasil, setBerhasil] = useState<string | null>(null);
  const [progres, setProgres] = useState<number | null>(null);
  const isSubmittingRef = useRef(false);

  const siap = baris.filter((b) => !b.galat);

  const unduhTemplate = async () => {
    setGalat(null);
    try {
      await exportToExcel(
        "template-data-diri-karyawan.xlsx",
        "Data Diri",
        [
          "id_unik",
          "kode_karyawan",
          "nama",
          ...(izin.pribadi ? KOLOM_PRIBADI : []),
          ...(izin.keuangan ? KOLOM_KEUANGAN : []),
        ],
        karyawan
          .filter((k) => k.status_aktif === "Aktif" && !k.id_keluar)
          .map((k) => [
            String(k.id_unik ?? ""),
            String(k.kode_karyawan ?? ""),
            String(k.nama ?? ""),
          ]),
      );
    } catch (error) {
      setGalat(pesanGalat(error));
    }
  };

  const pilihBerkas = async (berkas: File | undefined) => {
    setGalat(null);
    setBerhasil(null);
    setBaris([]);
    setCatatan([]);
    if (!berkas) return;
    try {
      const hasil = uraiDataDiri(
        await readWorkbookTable(berkas),
        rujukan,
        izin,
      );
      setBaris(hasil.baris);
      setCatatan(hasil.catatan);
    } catch (error) {
      setGalat(pesanGalat(error));
    }
  };

  const simpanSatu = async (b: BarisDataDiri) => {
    const profil = await ambilProfil(b.id_karyawan);
    // `null` = kelompok tidak boleh dibaca (`hris::profil`). Tanpa nilai lama,
    // sel kosong akan menghapus isian yang ada, jadi baris ini ditolak.
    if (
      (b.pribadi && profil.pribadi === null) ||
      (b.keuangan && profil.keuangan === null)
    ) {
      throw new Error("Data lama tidak bisa dibaca dengan izin Anda.");
    }
    if (b.pribadi && profil.pribadi) {
      const hasil = await simpanDataPribadi(
        b.id_karyawan,
        gabungIsian(KOLOM_PRIBADI, profil.pribadi, b.pribadi),
      );
      if (!hasil.sukses) throw new Error("Data pribadi gagal disimpan.");
    }
    if (b.keuangan && profil.keuangan) {
      const hasil = await simpanDataKeuangan(
        b.id_karyawan,
        gabungIsian(KOLOM_KEUANGAN, profil.keuangan, b.keuangan),
      );
      if (!hasil.sukses) throw new Error("Data keuangan gagal disimpan.");
    }
    return { sukses: true, pesan: "" };
  };

  const impor = async () => {
    if (isSubmittingRef.current || siap.length === 0) return;
    isSubmittingRef.current = true;
    setGalat(null);
    setProgres(0);
    try {
      const perId = new Map(siap.map((b) => [b.id_karyawan, b]));
      const hasil = await jalankanBerurutan(
        [...perId.keys()],
        (id) => simpanSatu(perId.get(id) as BarisDataDiri),
        setProgres,
      );
      const ringkas = `Impor data diri: ${ringkasHasil(hasil, (id) => perId.get(id)?.nama || id)}`;
      if (hasil.berhasil.length > 0) onSelesai();
      // Sisakan yang gagal di pratinjau supaya bisa diperbaiki di berkas.
      const gagal = new Map(hasil.gagal.map((g) => [g.id, g.pesan]));
      setBaris(
        siap
          .filter((b) => gagal.has(b.id_karyawan))
          .map((b) => ({ ...b, galat: gagal.get(b.id_karyawan) ?? null })),
      );
      if (hasil.gagal.length === 0) setBerhasil(ringkas);
      else setGalat(ringkas);
    } finally {
      isSubmittingRef.current = false;
      setProgres(null);
    }
  };

  return (
    <Modal
      isOpen
      title="Impor data diri karyawan"
      subtitle="Isian Pribadi dan Keuangan dari Excel"
      maxWidth="max-w-3xl"
      onClose={progres === null ? onClose : () => undefined}
    >
      <div className="space-y-4 text-sm">
        <ol className="list-decimal space-y-1 pl-5 text-slate-300">
          <li>
            Unduh template. Isinya semua karyawan aktif; isi hanya kolom yang
            ingin diubah.
          </li>
          <li>
            Sel kosong tidak mengubah apa pun. Untuk menghapus satu isian, pakai
            formulir di rincian karyawan.
          </li>
          <li>
            NIK, nomor KK, rekening, NPWP, BPJS, dan HP harus berformat Teks:
            ketik dengan awalan tanda kutip ('), misalnya '3201234567890123.
          </li>
        </ol>

        <div className="flex flex-wrap items-end gap-3">
          <button type="button" className={TOMBOL} onClick={unduhTemplate}>
            Unduh template
          </button>
          <div>
            <label
              htmlFor="impor-data-diri-berkas"
              className="mb-1 block text-sm font-semibold text-slate-300"
            >
              Berkas Excel (.xlsx atau .csv)
            </label>
            <input
              id="impor-data-diri-berkas"
              type="file"
              accept=".xlsx,.csv"
              disabled={progres !== null}
              onChange={(e) => void pilihBerkas(e.target.files?.[0])}
              className="block text-sm text-slate-300"
            />
          </div>
        </div>

        {catatan.map((c) => (
          <p
            key={c}
            className="rounded-xl border border-amber-300/25 bg-amber-300/10 px-3 py-2 text-amber-100"
          >
            {c}
          </p>
        ))}
        {galat ? (
          <p role="alert" className="text-rose-300">
            {galat}
          </p>
        ) : null}
        {berhasil ? (
          <output className="block text-emerald-300">{berhasil}</output>
        ) : null}

        {baris.length > 0 ? (
          <>
            <p className="text-slate-400">
              {siap.length} siap diimpor, {baris.length - siap.length}{" "}
              bermasalah.
            </p>
            <div className="max-h-80 overflow-auto rounded-xl border border-slate-800">
              <table className="w-full text-left text-xs">
                <thead className="sticky top-0 bg-slate-900 text-slate-400">
                  <tr>
                    <th className="px-3 py-2">Baris</th>
                    <th className="px-3 py-2">Karyawan</th>
                    <th className="px-3 py-2">Isian</th>
                    <th className="px-3 py-2">Keadaan</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800">
                  {baris.map((b) => (
                    <tr key={b.baris}>
                      <td className="px-3 py-2 text-slate-400">{b.baris}</td>
                      <td className="px-3 py-2 text-white">
                        {b.nama || b.id_karyawan}
                      </td>
                      <td className="px-3 py-2 text-slate-300">
                        {[
                          b.pribadi
                            ? `Pribadi ${Object.keys(b.pribadi).length}`
                            : "",
                          b.keuangan
                            ? `Keuangan ${Object.keys(b.keuangan).length}`
                            : "",
                        ]
                          .filter(Boolean)
                          .join(" · ") || "-"}
                      </td>
                      <td
                        className={`px-3 py-2 ${b.galat ? "text-rose-300" : "text-emerald-300"}`}
                      >
                        {b.galat ?? "Siap"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        ) : null}

        <div className="flex justify-end gap-2">
          <button
            type="button"
            className={TOMBOL}
            onClick={onClose}
            disabled={progres !== null}
          >
            Tutup
          </button>
          <button
            type="button"
            className={TOMBOL_UTAMA}
            onClick={() => void impor()}
            disabled={progres !== null || siap.length === 0}
          >
            {progres !== null
              ? `Menyimpan ${progres}/${siap.length}...`
              : `Impor ${siap.length} karyawan`}
          </button>
        </div>
      </div>
    </Modal>
  );
}
