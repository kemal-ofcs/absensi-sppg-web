"use client";

// Master organisasi (HRIS v36, `hr.org.manage`). Tidak ada hapus: nonaktif
// menyembunyikan dari pilihan baru. Ganti nama divisi mencadangkan nama lama
// dan memperbarui data kini karyawannya; riwayat tetap, tampil dengan nama
// baru lewat pemetaan.

import { useCallback, useEffect, useState } from "react";
import { konfirmasiData } from "@/components/ui/KonfirmasiData";
import {
  ambilJenisDokumen,
  type JenisDokumen,
  type Organisasi,
  simpanCabang,
  simpanDivisi,
  simpanJabatan,
  simpanJenisDokumen,
  simpanPengaturanKontrak,
} from "@/lib/gateways/hris";
import {
  BATAS_PENGATURAN,
  KUNCI_PELAMAR_RETENSI_BULAN,
  LABEL_TANDA_HRIS,
  type PengaturanKontrak,
  validasiPengaturan,
} from "@/lib/validations/hris";

// Angka pengingat HR (fase 9, §24.3) tampil sebagai kelompok sendiri, tetapi
// disimpan bersama angka kontrak: validatornya menuntut semua kunci sekaligus.
const ANGKA_KONTRAK = BATAS_PENGATURAN.filter(
  ([kunci]) => !kunci.startsWith("hr_ingat_"),
);
const ANGKA_PENGINGAT = BATAS_PENGATURAN.filter(([kunci]) =>
  kunci.startsWith("hr_ingat_"),
);

const KELAS =
  "min-h-10 w-full rounded-xl border border-slate-800 bg-slate-950 px-3 text-white outline-none focus:border-sky-500";
const TOMBOL =
  "min-h-10 rounded-xl bg-sky-500 px-4 text-sm font-bold text-white disabled:opacity-50";
const TOMBOL_KEDUA =
  "min-h-9 rounded-xl border border-slate-700 px-3 text-xs font-bold text-slate-200";

interface Baris {
  id: string;
  nama: string;
  aktif: boolean;
  keterangan?: string;
  ganda?: boolean;
}

type Simpan = (draft: Record<string, unknown>) => Promise<unknown>;

function DaftarMaster({
  judul,
  idKunci,
  baris,
  simpan,
  onBerubah,
  peringatanGantiNama,
}: {
  judul: string;
  idKunci: string;
  baris: Baris[];
  simpan: Simpan;
  onBerubah: () => void;
  peringatanGantiNama?: string;
}) {
  const [baru, setBaru] = useState("");
  const [ubah, setUbah] = useState<Record<string, string>>({});
  const [pesan, setPesan] = useState("");
  const [sibuk, setSibuk] = useState(false);
  const awalan = judul.toLowerCase().replace(/\s+/g, "-");

  const jalankan = async (
    draft: Record<string, unknown>,
    rincian: Array<{ label: string; nilai: string; peringatan?: boolean }>,
  ) => {
    if (!(await konfirmasiData(rincian))) return;
    setSibuk(true);
    try {
      await simpan(draft);
      setPesan("Tersimpan.");
      setBaru("");
      setUbah({});
      onBerubah();
    } catch (error) {
      setPesan(error instanceof Error ? error.message : "Gagal menyimpan.");
    } finally {
      setSibuk(false);
    }
  };

  return (
    <section className="space-y-3 rounded-2xl border border-slate-800 bg-slate-900 p-4">
      <h3 className="font-bold text-white">{judul}</h3>
      <ul className="space-y-2">
        {baris.map((b) => {
          const namaUbah = ubah[b.id];
          return (
            <li key={b.id} className="flex flex-wrap items-center gap-2">
              <input
                id={`${awalan}-${b.id}`}
                aria-label={`Nama ${judul}`}
                value={namaUbah ?? b.nama}
                onChange={(e) =>
                  setUbah((l) => ({ ...l, [b.id]: e.target.value }))
                }
                className={`${KELAS} min-w-0 flex-1`}
              />
              {namaUbah !== undefined && namaUbah !== b.nama ? (
                <button
                  type="button"
                  disabled={sibuk}
                  onClick={() =>
                    jalankan(
                      {
                        [idKunci]: b.id,
                        nama: namaUbah,
                        is_aktif: b.aktif ? 1 : 0,
                      },
                      [
                        { label: "Nama lama", nilai: b.nama },
                        { label: "Nama baru", nilai: namaUbah },
                        ...(peringatanGantiNama
                          ? [
                              {
                                label: "Catatan",
                                nilai: peringatanGantiNama,
                                peringatan: true,
                              },
                            ]
                          : []),
                      ],
                    )
                  }
                  className={TOMBOL_KEDUA}
                >
                  Simpan nama
                </button>
              ) : null}
              <button
                type="button"
                disabled={sibuk}
                onClick={() =>
                  jalankan(
                    {
                      [idKunci]: b.id,
                      nama: b.nama,
                      is_aktif: b.aktif ? 0 : 1,
                    },
                    [
                      { label: judul, nilai: b.nama },
                      {
                        label: "Menjadi",
                        nilai: b.aktif ? "Nonaktif" : "Aktif",
                      },
                    ],
                  )
                }
                className={TOMBOL_KEDUA}
              >
                {b.aktif ? "Nonaktifkan" : "Aktifkan"}
              </button>
              <span className="w-full text-xs text-slate-400">
                {b.aktif ? "" : "Nonaktif • "}
                {b.keterangan}
                {b.ganda ? (
                  <span className="text-amber-200">
                    {" "}
                    • {LABEL_TANDA_HRIS.nama_ganda}
                  </span>
                ) : null}
              </span>
            </li>
          );
        })}
      </ul>
      <div className="flex flex-wrap gap-2">
        <input
          id={`${awalan}-baru`}
          aria-label={`${judul} baru`}
          placeholder={`${judul} baru`}
          value={baru}
          onChange={(e) => setBaru(e.target.value)}
          className={`${KELAS} min-w-0 flex-1`}
        />
        <button
          type="button"
          disabled={sibuk || !baru.trim()}
          onClick={() =>
            jalankan({ nama: baru }, [{ label: judul, nilai: baru }])
          }
          className={TOMBOL}
        >
          Tambah
        </button>
      </div>
      {pesan ? <p className="text-sm text-slate-300">{pesan}</p> : null}
    </section>
  );
}

export function OrganisasiPanel({
  org,
  onBerubah,
}: {
  org: Organisasi | null;
  onBerubah: () => void;
}) {
  const [jenis, setJenis] = useState<JenisDokumen[]>([]);
  const [galatJenis, setGalatJenis] = useState("");
  const [aturan, setAturan] = useState<PengaturanKontrak | null>(null);
  const [pesanAturan, setPesanAturan] = useState("");

  const muatJenis = useCallback(
    () =>
      ambilJenisDokumen()
        .then((j) => {
          setJenis(j);
          setGalatJenis("");
        })
        .catch((error: unknown) =>
          setGalatJenis(
            error instanceof Error
              ? error.message
              : "Jenis dokumen gagal dimuat.",
          ),
        ),
    [],
  );
  useEffect(() => {
    void muatJenis();
  }, [muatJenis]);
  useEffect(() => {
    if (org) setAturan(org.pengaturan);
  }, [org]);

  if (!org)
    return <p className="text-sm text-slate-400">Memuat organisasi...</p>;

  const simpanAturan = async () => {
    if (!aturan) return;
    const cek = validasiPengaturan({ ...aturan } as Record<string, unknown>);
    if (!cek.ok) {
      setPesanAturan(cek.pesan);
      return;
    }
    // Masa simpan pelamar berlaku surut (§22.6): memendekkannya bisa
    // menghapus data lowongan lama pada pembersihan berikutnya.
    const retensiLama = org.pengaturan[KUNCI_PELAMAR_RETENSI_BULAN];
    const lanjut = await konfirmasiData(
      BATAS_PENGATURAN.map(([kunci, label]) => {
        const lebihPendek =
          kunci === KUNCI_PELAMAR_RETENSI_BULAN && aturan[kunci] < retensiLama;
        return {
          label,
          nilai: lebihPendek
            ? `${aturan[kunci]} (sebelumnya ${retensiLama}). Berlaku untuk semua lowongan yang sudah tutup: data pelamar yang masa simpannya kini habis ikut terhapus pada pembersihan berikutnya.`
            : String(aturan[kunci]),
          peringatan: lebihPendek,
        };
      }),
    );
    if (!lanjut) return;
    try {
      await simpanPengaturanKontrak(aturan);
      setPesanAturan("Tersimpan.");
      onBerubah();
    } catch (error) {
      setPesanAturan(
        error instanceof Error ? error.message : "Gagal menyimpan.",
      );
    }
  };

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <DaftarMaster
        judul="Divisi"
        idKunci="id_divisi"
        baris={org.divisi.map((d) => ({
          id: d.id_divisi,
          nama: d.nama,
          aktif: d.is_aktif === 1,
          ganda: d.nama_ganda,
          keterangan: `${d.jumlah} karyawan aktif${d.nama_lama.length ? ` • nama lama: ${d.nama_lama.join(", ")}` : ""}`,
        }))}
        simpan={simpanDivisi}
        onBerubah={onBerubah}
        peringatanGantiNama="Nama lama dicadangkan dan tidak bisa dipakai divisi lain. Riwayat tampil dengan nama baru."
      />
      <DaftarMaster
        judul="Jabatan"
        idKunci="id_jabatan"
        baris={org.jabatan.map((j) => ({
          id: j.id_jabatan,
          nama: j.nama,
          aktif: j.is_aktif === 1,
          ganda: j.nama_ganda,
          keterangan: `${j.jumlah} karyawan aktif`,
        }))}
        simpan={simpanJabatan}
        onBerubah={onBerubah}
      />
      <DaftarMaster
        judul="Cabang"
        idKunci="id_cabang"
        baris={org.cabang.map((c) => ({
          id: c.id_cabang,
          nama: c.nama,
          aktif: c.is_aktif === 1,
          ganda: c.nama_ganda,
          keterangan: `${c.jumlah} karyawan aktif`,
        }))}
        simpan={simpanCabang}
        onBerubah={onBerubah}
      />
      {galatJenis ? (
        <p className="rounded-2xl border border-slate-800 bg-slate-900 p-4 text-sm text-slate-400">
          Jenis dokumen: {galatJenis}
        </p>
      ) : (
        <DaftarMaster
          judul="Jenis dokumen"
          idKunci="id_jenis"
          baris={jenis.map((j) => ({
            id: j.id_jenis,
            nama: j.nama,
            aktif: j.is_aktif === 1,
          }))}
          simpan={async (draft) => {
            await simpanJenisDokumen(draft);
            await muatJenis();
          }}
          onBerubah={() => undefined}
        />
      )}
      {org.tanpa_master.length ? (
        <section className="space-y-2 rounded-2xl border border-amber-500/30 bg-slate-900 p-4">
          <h3 className="font-bold text-white">Teks divisi tanpa master</h3>
          <p className="text-xs text-slate-400">
            Divisi yang hanya ada sebagai teks di data karyawan (misalnya dari
            perangkat lama). Menjadikannya divisi menautkan semua karyawan
            bertekas sama.
          </p>
          <ul className="space-y-1">
            {org.tanpa_master.map((t) => (
              <li
                key={t.teks}
                className="flex flex-wrap items-center justify-between gap-2"
              >
                <span className="text-sm text-white">
                  {t.teks}{" "}
                  <span className="text-xs text-slate-400">
                    ({t.jumlah} karyawan)
                  </span>
                </span>
                <button
                  type="button"
                  onClick={async () => {
                    if (
                      !(await konfirmasiData([
                        { label: "Divisi baru", nilai: t.teks },
                      ]))
                    )
                      return;
                    try {
                      await simpanDivisi({ nama: t.teks });
                      onBerubah();
                    } catch (error) {
                      window.alert(
                        error instanceof Error
                          ? error.message
                          : "Gagal menyimpan.",
                      );
                    }
                  }}
                  className={TOMBOL_KEDUA}
                >
                  Jadikan divisi
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <section className="space-y-3 rounded-2xl border border-slate-800 bg-slate-900 p-4">
        <h3 className="font-bold text-white">Angka bawaan kontrak</h3>
        <p className="text-xs text-slate-400">
          Hanya memunculkan tanda, tidak menolak. Bawaan dari PP 35/2021; cek
          ulang dengan konsultan HR atau hukum perusahaan.
        </p>
        {aturan ? (
          <>
            <IsianAngka
              daftar={ANGKA_KONTRAK}
              aturan={aturan}
              setAturan={setAturan}
            />
            <h4 className="pt-2 text-sm font-bold text-white">
              Angka pengingat HR
            </h4>
            <p className="text-xs text-slate-400">
              Dipakai pengingat grup Telegram HRD dan kartu Perlu perhatian,
              setelah tersimpan di database pusat. Memperkecil angka tidak
              membatalkan pengingat yang sudah tercatat; memperbesarnya bisa
              langsung memunculkan pengingat untuk yang kini masuk jendela.
              Pengingat kedua PKWT harus lebih kecil dari yang pertama.
            </p>
            <IsianAngka
              daftar={ANGKA_PENGINGAT}
              aturan={aturan}
              setAturan={setAturan}
            />
          </>
        ) : null}
        <button
          type="button"
          id="hris-simpan-angka"
          onClick={simpanAturan}
          className={TOMBOL}
        >
          Simpan angka bawaan
        </button>
        {pesanAturan ? (
          <p className="text-sm text-slate-300">{pesanAturan}</p>
        ) : null}
      </section>
    </div>
  );
}

function IsianAngka({
  daftar,
  aturan,
  setAturan,
}: {
  daftar: readonly (typeof BATAS_PENGATURAN)[number][];
  aturan: PengaturanKontrak;
  setAturan: (
    ubah: (lama: PengaturanKontrak | null) => PengaturanKontrak | null,
  ) => void;
}) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      {daftar.map(([kunci, label, min, maks]) => (
        <div key={kunci} className="min-w-0">
          <label
            htmlFor={`hris-${kunci}`}
            className="mb-1 block text-xs font-semibold text-slate-400"
          >
            {label} ({min}–{maks})
          </label>
          <input
            id={`hris-${kunci}`}
            type="number"
            min={min}
            max={maks}
            value={aturan[kunci]}
            onChange={(e) =>
              setAturan((l) =>
                l ? { ...l, [kunci]: Number(e.target.value) } : l,
              )
            }
            className={KELAS}
          />
        </div>
      ))}
    </div>
  );
}
