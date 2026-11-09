"use client";

import { useMemo, useRef, useState } from "react";
import {
  INPUT,
  LABEL,
  pesanGalat,
  TOMBOL_KEDUA,
  TOMBOL_UTAMA,
} from "@/components/inventory/gaya";
import { saveFileWithPicker } from "@/lib/client/download";
import { createZipArchive } from "@/lib/client/excel-export";
import {
  ambilFotoLaporan,
  type PerjalananItem,
  rincianPerjalanan,
} from "@/lib/gateways/driver";

/**
 * Unduh foto massal (PRD §6.3) sebagai satu ZIP, untuk backup sebelum foto
 * dihapus 90 hari. Foto yang belum ada di perangkat diambil dari cloud satu
 * per satu, jadi butuh internet. Nama berkas: `<nomor>_<urutan>_<jenis>.jpg`.
 */

const GALAT_KOTAK =
  "p-3 rounded-lg border border-rose-500/30 bg-rose-500/20 text-sm text-rose-100";

function namaBerkas(nomor: string, urutan: number, jenis: string): string {
  const aman = (teks: string) => teks.replace(/[^A-Za-z0-9-]+/g, "-");
  return `${aman(nomor)}_${String(urutan).padStart(2, "0")}_${aman(jenis)}.jpg`;
}

function dariBase64(isi: string): Uint8Array {
  const biner = atob(isi);
  const hasil = new Uint8Array(biner.length);
  for (let i = 0; i < biner.length; i++) hasil[i] = biner.charCodeAt(i);
  return hasil;
}

export function UnduhFotoPanel({
  items,
  dari,
  sampai,
}: {
  items: PerjalananItem[];
  dari: string;
  sampai: string;
}) {
  const [driver, setDriver] = useState("");
  const [dipilih, setDipilih] = useState<Set<string>>(new Set());
  const [kemajuan, setKemajuan] = useState<string | null>(null);
  const [galat, setGalat] = useState<string | null>(null);
  const isSubmittingRef = useRef(false);

  const daftarDriver = useMemo(
    () =>
      [
        ...new Map(
          items.map((i) => [i.id_karyawan, i.nama_karyawan ?? i.id_karyawan]),
        ),
      ].sort((a, b) => a[1].localeCompare(b[1])),
    [items],
  );
  const tampil = items.filter((i) => !driver || i.id_karyawan === driver);
  const semuaTerpilih =
    tampil.length > 0 && tampil.every((i) => dipilih.has(i.id_perjalanan));

  function pilih(id: string, ya: boolean) {
    setDipilih((lama) => {
      const baru = new Set(lama);
      if (ya) baru.add(id);
      else baru.delete(id);
      return baru;
    });
  }

  async function unduh() {
    if (isSubmittingRef.current) return;
    isSubmittingRef.current = true;
    setGalat(null);
    try {
      const target = items.filter((i) => dipilih.has(i.id_perjalanan));
      const berkas: { name: string; data: Uint8Array }[] = [];
      let tidakAda = 0;
      for (const [n, item] of target.entries()) {
        setKemajuan(`Membaca surat jalan ${n + 1} dari ${target.length}...`);
        const rincian = await rincianPerjalanan(item.id_perjalanan);
        const berfoto = rincian.laporan.filter((l) => l.foto_sha256);
        for (const [urutan, l] of berfoto.entries()) {
          setKemajuan(
            `Surat jalan ${n + 1}/${target.length}: foto ${urutan + 1} dari ${berfoto.length}...`,
          );
          const foto = await ambilFotoLaporan(l.id_laporan);
          if (!foto) {
            tidakAda++;
            continue;
          }
          berkas.push({
            name: namaBerkas(item.nomor, urutan + 1, l.jenis),
            data: dariBase64(foto.data_base64),
          });
        }
      }
      if (berkas.length === 0) {
        setGalat(
          "Tidak ada foto yang bisa diunduh. Foto mungkin belum terkirim, sudah dihapus, atau perangkat sedang offline.",
        );
        return;
      }
      setKemajuan("Menyusun berkas ZIP...");
      const zip = createZipArchive(berkas);
      const hasil = await saveFileWithPicker(
        new Blob([zip as BlobPart], { type: "application/zip" }),
        `foto-perjalanan_${dari}_${sampai}.zip`,
        { description: "Arsip ZIP", accept: { "application/zip": [".zip"] } },
      );
      if (hasil.cancelled) {
        setKemajuan(null);
        return;
      }
      setKemajuan(
        `${berkas.length} foto diunduh.${tidakAda ? ` ${tidakAda} foto tidak tersedia (belum terkirim atau sudah dihapus).` : ""}`,
      );
    } catch (error) {
      setKemajuan(null);
      setGalat(pesanGalat(error, "Foto tidak bisa diunduh."));
    } finally {
      isSubmittingRef.current = false;
    }
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-slate-400">
        Foto dihapus otomatis setelah 90 hari. Pilih surat jalan lalu unduh
        fotonya sebagai satu berkas ZIP untuk disimpan sendiri.
      </p>
      <div className="grid gap-3 sm:grid-cols-[16rem_auto] sm:items-end">
        <div>
          <label className={LABEL} htmlFor="foto-driver">
            Filter driver
          </label>
          <select
            id="foto-driver"
            className={INPUT}
            value={driver}
            onChange={(e) => setDriver(e.target.value)}
          >
            <option value="">Semua driver</option>
            {daftarDriver.map(([id, nama]) => (
              <option key={id} value={id}>
                {nama}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            id="foto-pilih-semua"
            className={TOMBOL_KEDUA}
            disabled={tampil.length === 0}
            onClick={() => {
              for (const i of tampil) pilih(i.id_perjalanan, !semuaTerpilih);
            }}
          >
            {semuaTerpilih ? "Batalkan pilihan" : "Pilih semua"}
          </button>
          <button
            type="button"
            id="foto-unduh"
            className={TOMBOL_UTAMA}
            disabled={dipilih.size === 0 || kemajuan?.endsWith("...") === true}
            onClick={() => void unduh()}
          >
            Unduh ZIP ({dipilih.size} surat jalan)
          </button>
        </div>
      </div>
      {kemajuan ? (
        <output className="block text-sm text-sky-100">{kemajuan}</output>
      ) : null}
      {galat ? (
        <div className={GALAT_KOTAK} role="alert">
          {galat}
        </div>
      ) : null}
      <ul className="divide-y divide-white/10 rounded-xl border border-white/10">
        {tampil.map((i) => (
          <li
            key={i.id_perjalanan}
            className="flex items-center gap-3 px-3 py-2 text-sm"
          >
            <input
              id={`foto-pilih-${i.id_perjalanan}`}
              type="checkbox"
              checked={dipilih.has(i.id_perjalanan)}
              onChange={(e) => pilih(i.id_perjalanan, e.target.checked)}
            />
            <label
              htmlFor={`foto-pilih-${i.id_perjalanan}`}
              className="text-slate-200"
            >
              {i.nomor} · {i.tanggal} · {i.nama_karyawan ?? i.id_karyawan}
            </label>
          </li>
        ))}
        {tampil.length === 0 ? (
          <li className="px-3 py-2 text-sm text-slate-400">
            Tidak ada surat jalan pada rentang tanggal ini.
          </li>
        ) : null}
      </ul>
    </div>
  );
}
