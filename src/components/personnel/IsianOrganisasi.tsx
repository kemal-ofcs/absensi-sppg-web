"use client";

// Isian organisasi karyawan (HRIS v36): cabang, divisi, jabatan, atasan dari
// master. Dipakai form karyawan Web/Desktop dan Mobile (di `filesToCopy`).
// Teks `divisi`/`jabatan_status` ikut diisi nama master supaya validasi lama
// dan kartu ID tetap jalan; backend tetap memetakan ulang dari id-nya.

import { useEffect, useState } from "react";
import { PilihCari } from "@/components/ui/PilihCari";
import { ambilOrganisasi, type Organisasi } from "@/lib/gateways/hris";

export interface NilaiOrganisasi {
  id_cabang?: string;
  id_divisi?: string;
  id_jabatan?: string;
  id_atasan?: string;
  divisi?: string;
  jabatan_status?: string;
}

interface Props {
  nilai: NilaiOrganisasi;
  onUbah: (perubahan: NilaiOrganisasi) => void;
  /** Karyawan yang boleh jadi atasan (tanpa dirinya sendiri). */
  calonAtasan: ReadonlyArray<{ id_unik: string; nama: string }>;
  idDiri?: string;
  galatDivisi?: string;
}

const KELAS =
  "min-h-10 w-full rounded-xl border border-slate-800 bg-slate-950 px-3 text-white outline-none focus:border-sky-500";
const LABEL = "text-slate-400 block mb-1 font-semibold";

export function IsianOrganisasi({
  nilai,
  onUbah,
  calonAtasan,
  idDiri,
  galatDivisi,
}: Props) {
  const [org, setOrg] = useState<Organisasi | null>(null);
  const [galat, setGalat] = useState("");

  useEffect(() => {
    let hidup = true;
    ambilOrganisasi()
      .then((hasil) => hidup && setOrg(hasil))
      .catch(
        (error: unknown) =>
          hidup &&
          setGalat(
            error instanceof Error ? error.message : "Organisasi gagal dimuat.",
          ),
      );
    return () => {
      hidup = false;
    };
  }, []);

  // Master nonaktif tetap tampil bila sedang dipakai karyawan ini.
  const terpilih = <T extends { is_aktif: number }>(
    daftar: T[] | undefined,
    id: string | null | undefined,
    kunci: keyof T,
  ) => (daftar ?? []).filter((m) => m.is_aktif === 1 || m[kunci] === id);

  const divisiTanpaMaster = Boolean(nilai.divisi) && !nilai.id_divisi;

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <div className="min-w-0">
        <label htmlFor="employee-division" className={LABEL}>
          Divisi:
        </label>
        <PilihCari
          id="employee-division"
          value={nilai.id_divisi ?? ""}
          onChange={(e) => {
            const id = e.target.value;
            const pilihan = org?.divisi.find((d) => d.id_divisi === id);
            onUbah({ id_divisi: id, divisi: pilihan?.nama ?? "" });
          }}
          aria-invalid={Boolean(galatDivisi)}
          className={KELAS}
        >
          <option value="">
            {divisiTanpaMaster
              ? `${nilai.divisi} (belum terdaftar)`
              : "Pilih divisi..."}
          </option>
          {terpilih(org?.divisi, nilai.id_divisi, "id_divisi").map((d) => (
            <option key={d.id_divisi} value={d.id_divisi}>
              {d.is_aktif === 1 ? d.nama : `${d.nama} (nonaktif)`}
            </option>
          ))}
        </PilihCari>
        {org && org.divisi.length === 0 ? (
          <p className="mt-1 text-xs text-amber-200">
            Belum ada divisi. Tambahkan dulu di HRIS → Organisasi.
          </p>
        ) : null}
      </div>
      <div className="min-w-0">
        <label htmlFor="employee-position" className={LABEL}>
          Jabatan:
        </label>
        <PilihCari
          id="employee-position"
          value={nilai.id_jabatan ?? ""}
          onChange={(e) => {
            const id = e.target.value;
            const pilihan = org?.jabatan.find((j) => j.id_jabatan === id);
            onUbah({
              id_jabatan: id,
              ...(pilihan ? { jabatan_status: pilihan.nama } : {}),
            });
          }}
          className={KELAS}
        >
          <option value="">
            {nilai.jabatan_status &&
            !nilai.id_jabatan &&
            nilai.jabatan_status !== "-"
              ? `${nilai.jabatan_status} (belum terdaftar)`
              : "Tanpa jabatan"}
          </option>
          {terpilih(org?.jabatan, nilai.id_jabatan, "id_jabatan").map((j) => (
            <option key={j.id_jabatan} value={j.id_jabatan}>
              {j.is_aktif === 1 ? j.nama : `${j.nama} (nonaktif)`}
            </option>
          ))}
        </PilihCari>
      </div>
      <div className="min-w-0">
        <label htmlFor="employee-branch" className={LABEL}>
          Cabang:
        </label>
        <PilihCari
          id="employee-branch"
          value={nilai.id_cabang ?? ""}
          onChange={(e) => onUbah({ id_cabang: e.target.value })}
          className={KELAS}
        >
          <option value="">Tanpa cabang</option>
          {terpilih(org?.cabang, nilai.id_cabang, "id_cabang").map((c) => (
            <option key={c.id_cabang} value={c.id_cabang}>
              {c.is_aktif === 1 ? c.nama : `${c.nama} (nonaktif)`}
            </option>
          ))}
        </PilihCari>
      </div>
      <div className="min-w-0">
        <label htmlFor="employee-supervisor" className={LABEL}>
          Atasan langsung:
        </label>
        <PilihCari
          id="employee-supervisor"
          value={nilai.id_atasan ?? ""}
          onChange={(e) => onUbah({ id_atasan: e.target.value })}
          className={KELAS}
        >
          <option value="">Tanpa atasan</option>
          {calonAtasan
            .filter((k) => k.id_unik !== idDiri)
            .map((k) => (
              <option key={k.id_unik} value={k.id_unik}>
                {k.nama}
              </option>
            ))}
        </PilihCari>
      </div>
      {galat ? (
        <p className="text-xs text-rose-200 sm:col-span-2">{galat}</p>
      ) : null}
    </div>
  );
}
