"use client";

// Tab SP di rincian karyawan (PRD HRIS §20.3). Khusus cloud: butuh koneksi ke
// database. Backend memeriksa ulang izin dan usulan tingkat. Cetak A4 hanya
// Web/Desktop (Q-131): WebView Android tidak punya dialog cetak.

import { useCallback, useEffect, useState } from "react";
import { cetakSuratPeringatan } from "@/components/hris/cetakSuratPeringatan";
import type { BarisKaryawan } from "@/components/hris/HrisWorkspace";
import { konfirmasiData } from "@/components/ui/KonfirmasiData";
import {
  ambilSp,
  cabutSp,
  type DaftarSp,
  type SuratPeringatan,
  simpanSp,
} from "@/lib/gateways/hr-keluar";
import { isMobileRuntime } from "@/lib/runtime/app-runtime";
import { TINGKAT_SP } from "@/lib/validations/hr-keluar";

const KELAS =
  "min-h-10 w-full rounded-xl border border-slate-800 bg-slate-950 px-3 text-white outline-none focus:border-sky-500";
const KELAS_AREA =
  "min-h-20 w-full rounded-xl border border-slate-800 bg-slate-950 px-3 py-2 text-white outline-none focus:border-sky-500";
const TOMBOL =
  "min-h-10 rounded-xl bg-sky-500 px-4 text-sm font-bold text-white disabled:opacity-50";
const TOMBOL_KEDUA =
  "min-h-9 rounded-xl border border-slate-700 px-3 text-xs font-bold text-slate-200 disabled:opacity-50";

type Isian = Record<string, string>;

const pesanGalat = (error: unknown, cadangan: string) =>
  error instanceof Error ? error.message : cadangan;

const WARNA_STATUS: Record<string, string> = {
  Berlaku: "text-amber-200",
  Berakhir: "text-slate-400",
  Dicabut: "text-rose-200",
};

export function SuratPeringatanPanel({
  karyawan,
  bolehUbah,
  bolehCabut,
  onMulaiKeluar,
}: {
  karyawan: BarisKaryawan;
  bolehUbah: boolean;
  bolehCabut: boolean;
  onMulaiKeluar?: (idSp: string) => void;
}) {
  const id = String(karyawan.id_unik);
  const [data, setData] = useState<DaftarSp | null>(null);
  const [isi, setIsi] = useState<Isian | null>(null);
  const [cabut, setCabut] = useState<Record<string, string>>({});
  const [pesan, setPesan] = useState("");
  const [sibuk, setSibuk] = useState(false);

  const muat = useCallback(() => {
    ambilSp(id)
      .then((d) => {
        setData(d);
        setPesan("");
      })
      .catch((error: unknown) =>
        setPesan(pesanGalat(error, "Surat peringatan gagal dimuat.")),
      );
  }, [id]);
  useEffect(muat, [muat]);

  const usulan = data?.usulan;
  const sp3 = data?.sp.find(
    (s) => s.tingkat === "SP3" && s.status === "Berlaku",
  );

  const formBaru = (): Isian => ({
    tingkat: usulan?.tingkat ?? "SP1",
    tanggal: data?.hari_ini ?? "",
    nomor: "",
    pelanggaran: "",
    harapan: "",
    alasan_tingkat: "",
    penanda_nama: String(data?.penanda_terakhir?.nama ?? ""),
    penanda_jabatan: String(data?.penanda_terakhir?.jabatan ?? ""),
  });
  const formUbah = (s: SuratPeringatan): Isian => ({
    id_sp: s.id_sp,
    tingkat: s.tingkat,
    tanggal: s.tanggal,
    nomor: s.nomor ?? "",
    pelanggaran: s.pelanggaran,
    harapan: s.harapan ?? "",
    alasan_tingkat: s.alasan_tingkat ?? "",
    penanda_nama: s.penanda_nama,
    penanda_jabatan: s.penanda_jabatan,
  });

  const simpan = async () => {
    if (!isi) return;
    const lanjut = await konfirmasiData([
      { label: "Tingkat", nilai: isi.tingkat },
      { label: "Tanggal", nilai: isi.tanggal },
      { label: "Nomor", nilai: isi.nomor },
      { label: "Pelanggaran", nilai: isi.pelanggaran },
      {
        label: "Penanda tangan",
        nilai: `${isi.penanda_nama}, ${isi.penanda_jabatan}`,
      },
    ]);
    if (!lanjut) return;
    setSibuk(true);
    try {
      await simpanSp({ ...isi, id_karyawan: id });
      setIsi(null);
      setPesan("Surat peringatan tersimpan.");
      muat();
    } catch (error) {
      setPesan(pesanGalat(error, "Surat peringatan gagal disimpan."));
    } finally {
      setSibuk(false);
    }
  };

  const jalankanCabut = async (idSp: string) => {
    setSibuk(true);
    try {
      await cabutSp({ id_sp: idSp, alasan: cabut[idSp] ?? "" });
      setCabut((lama) => ({ ...lama, [idSp]: "" }));
      setPesan("Surat peringatan dicabut.");
      muat();
    } catch (error) {
      setPesan(pesanGalat(error, "Surat peringatan gagal dicabut."));
    } finally {
      setSibuk(false);
    }
  };

  const ubahIsi = (k: string, v: string) =>
    setIsi((lama) => (lama ? { ...lama, [k]: v } : lama));
  const baru = isi !== null && !isi.id_sp;

  return (
    <div className="space-y-3">
      {usulan ? (
        <p className="text-sm text-slate-300">
          Usulan SP berikutnya: <strong>{usulan.tingkat}</strong>. Masa berlaku{" "}
          {data?.masa_bulan} bulan.
        </p>
      ) : null}
      {sp3 && onMulaiKeluar ? (
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-amber-500/40 bg-amber-500/10 p-3">
          <p className="text-sm text-amber-100">
            SP3 masih berlaku sampai {sp3.berlaku_sampai}.
          </p>
          <button
            id="hris-sp-mulai-keluar"
            type="button"
            className={TOMBOL_KEDUA}
            onClick={() => onMulaiKeluar(sp3.id_sp)}
          >
            Mulai proses keluar
          </button>
        </div>
      ) : null}
      {pesan ? <p className="text-sm text-slate-300">{pesan}</p> : null}

      {bolehUbah && !isi ? (
        <button
          id="hris-sp-baru"
          type="button"
          className={TOMBOL}
          disabled={!data || karyawan.status_aktif === "Nonaktif"}
          onClick={() => setIsi(formBaru())}
        >
          Buat SP
        </button>
      ) : null}

      {isi ? (
        <div className="space-y-3 rounded-xl border border-slate-800 bg-slate-950/60 p-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="min-w-0">
              <label
                htmlFor="hris-sp-tingkat"
                className="mb-1 block text-xs font-semibold text-slate-400"
              >
                Tingkat
              </label>
              <select
                id="hris-sp-tingkat"
                value={isi.tingkat}
                disabled={!baru}
                onChange={(e) => ubahIsi("tingkat", e.target.value)}
                className={KELAS}
              >
                {TINGKAT_SP.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </div>
            <div className="min-w-0">
              <label
                htmlFor="hris-sp-tanggal"
                className="mb-1 block text-xs font-semibold text-slate-400"
              >
                Tanggal surat
              </label>
              <input
                id="hris-sp-tanggal"
                type="date"
                value={isi.tanggal}
                disabled={!baru}
                max={data?.hari_ini}
                onChange={(e) => ubahIsi("tanggal", e.target.value)}
                className={KELAS}
              />
            </div>
            {baru && isi.tingkat !== usulan?.tingkat ? (
              <div className="min-w-0 sm:col-span-2">
                <label
                  htmlFor="hris-sp-alasan-tingkat"
                  className="mb-1 block text-xs font-semibold text-slate-400"
                >
                  Alasan memilih tingkat selain {usulan?.tingkat}
                </label>
                <input
                  id="hris-sp-alasan-tingkat"
                  value={isi.alasan_tingkat}
                  onChange={(e) => ubahIsi("alasan_tingkat", e.target.value)}
                  className={KELAS}
                />
              </div>
            ) : null}
            <div className="min-w-0">
              <label
                htmlFor="hris-sp-nomor"
                className="mb-1 block text-xs font-semibold text-slate-400"
              >
                Nomor surat (opsional)
              </label>
              <input
                id="hris-sp-nomor"
                value={isi.nomor}
                onChange={(e) => ubahIsi("nomor", e.target.value)}
                className={KELAS}
              />
            </div>
            <div className="min-w-0 sm:col-span-2">
              <label
                htmlFor="hris-sp-pelanggaran"
                className="mb-1 block text-xs font-semibold text-slate-400"
              >
                Pelanggaran
              </label>
              <textarea
                id="hris-sp-pelanggaran"
                value={isi.pelanggaran}
                onChange={(e) => ubahIsi("pelanggaran", e.target.value)}
                className={KELAS_AREA}
              />
            </div>
            <div className="min-w-0 sm:col-span-2">
              <label
                htmlFor="hris-sp-harapan"
                className="mb-1 block text-xs font-semibold text-slate-400"
              >
                Perbaikan yang diminta (opsional)
              </label>
              <textarea
                id="hris-sp-harapan"
                value={isi.harapan}
                onChange={(e) => ubahIsi("harapan", e.target.value)}
                className={KELAS_AREA}
              />
            </div>
            <div className="min-w-0">
              <label
                htmlFor="hris-sp-penanda-nama"
                className="mb-1 block text-xs font-semibold text-slate-400"
              >
                Nama penanda tangan
              </label>
              <input
                id="hris-sp-penanda-nama"
                value={isi.penanda_nama}
                onChange={(e) => ubahIsi("penanda_nama", e.target.value)}
                className={KELAS}
              />
            </div>
            <div className="min-w-0">
              <label
                htmlFor="hris-sp-penanda-jabatan"
                className="mb-1 block text-xs font-semibold text-slate-400"
              >
                Jabatan penanda tangan
              </label>
              <input
                id="hris-sp-penanda-jabatan"
                value={isi.penanda_jabatan}
                onChange={(e) => ubahIsi("penanda_jabatan", e.target.value)}
                className={KELAS}
              />
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              id="hris-sp-simpan"
              type="button"
              className={TOMBOL}
              disabled={sibuk}
              onClick={simpan}
            >
              Simpan
            </button>
            <button
              type="button"
              className={TOMBOL_KEDUA}
              onClick={() => setIsi(null)}
            >
              Batal
            </button>
          </div>
        </div>
      ) : null}

      {data && data.sp.length === 0 ? (
        <p className="text-sm text-slate-400">Belum ada surat peringatan.</p>
      ) : null}
      <ul className="space-y-2">
        {(data?.sp ?? []).map((s) => (
          <li
            key={s.id_sp}
            className="space-y-2 rounded-xl border border-slate-800 p-3"
          >
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="font-bold text-white">
                {s.tingkat} • {s.tanggal}
                {s.nomor ? ` • ${s.nomor}` : ""}
              </span>
              <span
                className={`text-xs font-bold ${WARNA_STATUS[s.status] ?? ""}`}
              >
                {s.status === "Berlaku"
                  ? `Berlaku s.d. ${s.berlaku_sampai}`
                  : s.status}
              </span>
            </div>
            <p className="whitespace-pre-wrap text-sm text-slate-200">
              {s.pelanggaran}
            </p>
            {s.alasan_tingkat ? (
              <p className="text-xs text-slate-400">
                Usulan {s.usulan_tingkat}; alasan: {s.alasan_tingkat}
              </p>
            ) : null}
            {s.dicabut_pada ? (
              <p className="text-xs text-rose-200">
                Dicabut {s.dicabut_oleh}: {s.alasan_cabut}
              </p>
            ) : null}
            <div className="flex flex-wrap gap-2">
              {isMobileRuntime() ? null : (
                <button
                  type="button"
                  className={TOMBOL_KEDUA}
                  onClick={() =>
                    cetakSuratPeringatan(
                      s,
                      {
                        nama: String(karyawan.nama),
                        jabatan: (karyawan.jabatan_status as string) ?? null,
                        divisi: (karyawan.divisi as string) ?? null,
                      },
                      data?.kop ?? null,
                    )
                  }
                >
                  Cetak
                </button>
              )}
              {bolehUbah && !s.dicabut_pada ? (
                <button
                  type="button"
                  className={TOMBOL_KEDUA}
                  onClick={() => setIsi(formUbah(s))}
                >
                  Ubah teks
                </button>
              ) : null}
            </div>
            {bolehCabut && !s.dicabut_pada ? (
              <div className="flex flex-wrap gap-2">
                <input
                  id={`hris-sp-cabut-${s.id_sp}`}
                  aria-label="Alasan pencabutan"
                  placeholder="Alasan pencabutan"
                  value={cabut[s.id_sp] ?? ""}
                  onChange={(e) =>
                    setCabut((lama) => ({ ...lama, [s.id_sp]: e.target.value }))
                  }
                  className={`${KELAS} sm:flex-1`}
                />
                <button
                  type="button"
                  className={TOMBOL_KEDUA}
                  disabled={sibuk || !(cabut[s.id_sp] ?? "").trim()}
                  onClick={() => jalankanCabut(s.id_sp)}
                >
                  Cabut
                </button>
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
