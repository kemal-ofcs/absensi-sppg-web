"use client";

// Kartu "Perlu perhatian" di tab Karyawan /hris (fase 8, prd-hris.md §23.4).
// Selalu dibaca dari database (Desktop sekalipun), dengan SQL yang sama
// dengan pengingat Telegram grup HRD. Bagian yang tidak diizinkan tidak
// dikirim backend sama sekali; layar hanya merender yang ada.

import Link from "next/link";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import type { TabRincian } from "@/components/hris/RincianKaryawan";
import { ambilPerhatian } from "@/lib/gateways/hris";
import { syncNow } from "@/lib/gateways/sync-status";
import {
  HR_HARI_MENUNGGU,
  type PerhatianHr,
  sisaHari,
} from "@/lib/validations/telegram";
import { tanggalTampil } from "@/lib/validations/tutup-buku";

const TOMBOL_KEDUA =
  "min-h-9 rounded-xl border border-slate-700 px-3 text-xs font-bold text-slate-200 disabled:opacity-50";

function labelSisa(sisa: number) {
  return sisa < 0 ? `lewat ${-sisa} hari` : sisaHari(sisa);
}

function Bagian({ judul, children }: { judul: string; children: ReactNode }) {
  return (
    <section className="min-w-0 space-y-2 rounded-xl border border-slate-800 bg-slate-950 p-3">
      <h3 className="text-sm font-bold text-white">{judul}</h3>
      <ul className="max-h-60 space-y-1 overflow-y-auto">{children}</ul>
    </section>
  );
}

function Butir({
  nama,
  rincian,
  tanda,
  onPilih,
}: {
  nama: string;
  rincian: string;
  tanda?: string;
  onPilih?: () => void;
}) {
  const isi = (
    <>
      <span className="block truncate font-semibold text-white">{nama}</span>
      <span className="block truncate text-xs text-slate-400">{rincian}</span>
      {tanda ? (
        <span className="block truncate text-xs text-amber-200">{tanda}</span>
      ) : null}
    </>
  );
  return (
    <li>
      {onPilih ? (
        <button
          type="button"
          onClick={onPilih}
          className="w-full rounded-lg px-2 py-1.5 text-left hover:bg-slate-800"
        >
          {isi}
        </button>
      ) : (
        <div className="px-2 py-1.5">{isi}</div>
      )}
    </li>
  );
}

const denganJabatan = (nama: string, jabatan: string) =>
  jabatan ? `${nama} · ${jabatan}` : nama;

export function PerluPerhatian({
  onPilihKaryawan,
  onBukaRekrutmen,
}: {
  onPilihKaryawan: (idKaryawan: string, tab: TabRincian) => void;
  onBukaRekrutmen?: () => void;
}) {
  const [data, setData] = useState<PerhatianHr | null>(null);
  const [galat, setGalat] = useState("");
  const [sibuk, setSibuk] = useState(false);

  const muat = useCallback(async () => {
    setSibuk(true);
    try {
      setData(await ambilPerhatian());
      setGalat("");
    } catch (error) {
      setGalat(error instanceof Error ? error.message : String(error));
    } finally {
      setSibuk(false);
    }
  }, []);

  useEffect(() => {
    void muat();
  }, [muat]);

  const kontrak = data?.kontrak ?? [];
  const dokumen = data?.dokumen ?? [];
  const sp = data?.sp ?? [];
  const ultah = data?.ulang_tahun ?? [];
  const rekrutmen = data?.rekrutmen ?? [];
  const pengajuan = data?.pengajuan;
  const totalMenunggu = (pengajuan?.menunggu ?? []).reduce(
    (jumlah, baris) => jumlah + baris.jumlah,
    0,
  );
  const adaPengajuan = totalMenunggu > 0 || (pengajuan?.urgent ?? 0) > 0;
  const kosong =
    kontrak.length +
      dokumen.length +
      sp.length +
      ultah.length +
      rekrutmen.length ===
      0 && !adaPengajuan;

  return (
    <section
      id="hris-perlu-perhatian"
      aria-labelledby="hris-perlu-perhatian-judul"
      className="space-y-3 rounded-2xl border border-slate-800 bg-slate-900 p-4"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h2
          id="hris-perlu-perhatian-judul"
          className="text-base font-bold text-white"
        >
          Perlu perhatian
        </h2>
        <button
          type="button"
          id="hris-perlu-perhatian-muat-ulang"
          className={`${TOMBOL_KEDUA} ml-auto`}
          disabled={sibuk}
          onClick={() =>
            void syncNow()
              .catch(() => undefined)
              .then(muat)
          }
        >
          Muat ulang
        </button>
      </div>

      {galat ? (
        <div className="text-sm">
          <p className="font-semibold text-rose-200">
            Butuh koneksi ke database.
          </p>
          <p className="text-xs text-slate-400">{galat}</p>
        </div>
      ) : data === null ? (
        <p className="text-sm text-slate-400">Memuat...</p>
      ) : kosong ? (
        <p className="text-sm text-slate-400">
          Tidak ada yang perlu perhatian.
        </p>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {kontrak.length > 0 ? (
            <Bagian judul="Kontrak">
              {kontrak.map((k) => (
                <Butir
                  key={`${k.jenis}:${k.id_karyawan}:${k.tanggal}`}
                  nama={denganJabatan(k.nama, k.jabatan)}
                  rincian={`${k.jenis === "PKWT" ? "PKWT berakhir" : "Masa percobaan berakhir"} ${tanggalTampil(k.tanggal)}`}
                  tanda={labelSisa(k.sisa)}
                  onPilih={() => onPilihKaryawan(k.id_karyawan, "kontrak")}
                />
              ))}
            </Bagian>
          ) : null}
          {dokumen.length > 0 ? (
            <Bagian judul="Dokumen">
              {dokumen.map((d) => (
                <Butir
                  key={`${d.id_karyawan}:${d.jenis_dokumen}:${d.tanggal}`}
                  nama={denganJabatan(d.nama, d.jabatan)}
                  rincian={`${d.jenis_dokumen} kedaluwarsa ${tanggalTampil(d.tanggal)}`}
                  tanda={labelSisa(d.sisa)}
                  onPilih={() => onPilihKaryawan(d.id_karyawan, "dokumen")}
                />
              ))}
            </Bagian>
          ) : null}
          {sp.length > 0 ? (
            <Bagian judul="Surat peringatan">
              {sp.map((s) => (
                <Butir
                  key={`${s.id_karyawan}:${s.tingkat}:${s.tanggal}`}
                  nama={denganJabatan(s.nama, s.jabatan)}
                  rincian={`${s.tingkat} berakhir ${tanggalTampil(s.tanggal)}`}
                  tanda={labelSisa(s.sisa)}
                  onPilih={() => onPilihKaryawan(s.id_karyawan, "sp")}
                />
              ))}
            </Bagian>
          ) : null}
          {pengajuan && adaPengajuan ? (
            <Bagian judul="Pengajuan">
              {totalMenunggu > 0 ? (
                <Butir
                  nama={`${totalMenunggu} menunggu lebih dari ${HR_HARI_MENUNGGU} hari`}
                  rincian={pengajuan.menunggu
                    .map((m) => `${m.kelompok} ${m.jumlah}`)
                    .join(" · ")}
                  tanda={`Paling lama sejak ${tanggalTampil(pengajuan.menunggu_sejak)}`}
                />
              ) : null}
              {pengajuan.urgent > 0 ? (
                <Butir
                  nama={`${pengajuan.urgent} urgent belum diketahui HRD`}
                  rincian={`Paling lama sejak ${tanggalTampil(pengajuan.urgent_sejak)}`}
                />
              ) : null}
              <li className="px-2 pt-1">
                <Link
                  href="/pengajuan"
                  id="hris-perlu-perhatian-pengajuan"
                  className="text-xs font-bold text-sky-300 hover:underline"
                >
                  Buka Pengajuan
                </Link>
              </li>
            </Bagian>
          ) : null}
          {ultah.length > 0 ? (
            <Bagian judul="Ulang tahun kerja">
              {ultah.map((u) => (
                <Butir
                  key={`${u.id_karyawan}:${u.tanggal}`}
                  nama={denganJabatan(u.nama, u.jabatan)}
                  rincian={`${tanggalTampil(u.tanggal)}, tahun ke-${u.tahun}`}
                  onPilih={() => onPilihKaryawan(u.id_karyawan, "kerja")}
                />
              ))}
            </Bagian>
          ) : null}
          {rekrutmen.length > 0 ? (
            <Bagian judul="Rekrutmen">
              {rekrutmen.map((r) => (
                <Butir
                  key={r.id_lowongan}
                  nama={r.judul}
                  rincian={`Data ${r.jumlah} pelamar dihapus ${tanggalTampil(r.tanggal_hapus)}`}
                  onPilih={onBukaRekrutmen}
                />
              ))}
            </Bagian>
          ) : null}
        </div>
      )}
    </section>
  );
}
