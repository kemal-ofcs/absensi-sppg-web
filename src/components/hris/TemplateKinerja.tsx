"use client";

// Template penilaian kinerja dan pengaturannya (HRIS v41, §21.3, §21.2).
// Web/Desktop saja (Q-72). Aturan bobot, nama unik, dan tipe aspek yang
// terkunci dinilai backend; penjumlah di sini hanya bantuan.

import { useCallback, useEffect, useState } from "react";
import {
  INPUT,
  LABEL,
  pesanGalat,
  TOMBOL_KEDUA,
  TOMBOL_UTAMA,
} from "@/components/inventory/gaya";
import { konfirmasiData } from "@/components/ui/KonfirmasiData";
import {
  ambilTemplateKinerja,
  type DaftarTemplateKinerja,
  simpanPengaturanKinerja,
  simpanTemplateKinerja,
  type TemplateKinerja as Template,
} from "@/lib/gateways/hr-kinerja";
import { SYNC_COMPLETED_EVENT } from "@/lib/gateways/sync-status";
import {
  KUNCI_AMBANG,
  KUNCI_PERIODE,
  KUNCI_PREDIKAT,
  MAKS_ASPEK_AKTIF,
  PERIODE_JENIS,
  TIPE_ASPEK,
  TIPE_DISIPLIN,
  TOTAL_BOBOT,
} from "@/lib/validations/hr-kinerja";

interface AspekIsian {
  id_aspek: string;
  nama: string;
  tipe: string;
  bobot: string;
  panduan: string;
  is_aktif: boolean;
}

interface TemplateIsian {
  id_template: string;
  nama: string;
  keterangan: string;
  is_bawaan: boolean;
  is_aktif: boolean;
  aspek: AspekIsian[];
  jabatan: string[];
}

const ASPEK_BARU: AspekIsian = {
  id_aspek: "",
  nama: "",
  tipe: "Manual",
  bobot: "",
  panduan: "",
  is_aktif: true,
};

const KOSONG: TemplateIsian = {
  id_template: "",
  nama: "",
  keterangan: "",
  is_bawaan: false,
  is_aktif: true,
  aspek: [{ ...ASPEK_BARU }],
  jabatan: [],
};

function dariTemplate(t: Template): TemplateIsian {
  return {
    id_template: t.id_template,
    nama: t.nama,
    keterangan: t.keterangan ?? "",
    is_bawaan: t.is_bawaan === 1,
    is_aktif: t.is_aktif === 1,
    aspek: t.aspek.map((a) => ({
      id_aspek: a.id_aspek,
      nama: a.nama,
      tipe: a.tipe,
      bobot: String(a.bobot),
      panduan: a.panduan ?? "",
      is_aktif: a.is_aktif === 1,
    })),
    jabatan: t.jabatan,
  };
}

export function TemplateKinerja({ onPesan }: { onPesan: (p: string) => void }) {
  const [data, setData] = useState<DaftarTemplateKinerja | null>(null);
  const [isi, setIsi] = useState<TemplateIsian | null>(null);
  const [sibuk, setSibuk] = useState(false);

  const muat = useCallback(async () => {
    try {
      setData(await ambilTemplateKinerja());
    } catch (error) {
      onPesan(pesanGalat(error, "Template kinerja gagal dimuat."));
    }
  }, [onPesan]);

  useEffect(() => {
    void muat();
    const dengar = () => void muat();
    window.addEventListener(SYNC_COMPLETED_EVENT, dengar);
    return () => window.removeEventListener(SYNC_COMPLETED_EVENT, dengar);
  }, [muat]);

  if (!data) return null;
  const namaTemplate = new Map(
    data.template.map((t) => [t.id_template, t.nama]),
  );
  const namaJabatan = new Map(data.jabatan.map((j) => [j.id_jabatan, j.nama]));

  const simpan = async () => {
    if (!isi) return;
    const aktif = isi.aspek.filter((a) => a.is_aktif);
    const lanjut = await konfirmasiData([
      { label: "Template", nilai: isi.nama },
      {
        label: "Aspek aktif",
        nilai: aktif.map((a) => `${a.nama} (${a.bobot})`).join(", "),
      },
      {
        label: "Jabatan",
        nilai:
          isi.jabatan.map((j) => namaJabatan.get(j) ?? j).join(", ") || "-",
      },
      { label: "Bawaan", nilai: isi.is_bawaan ? "Ya" : "Tidak" },
    ]);
    if (!lanjut) return;
    setSibuk(true);
    try {
      await simpanTemplateKinerja({
        ...(isi.id_template ? { id_template: isi.id_template } : {}),
        nama: isi.nama,
        keterangan: isi.keterangan,
        is_bawaan: isi.is_bawaan,
        is_aktif: isi.is_aktif,
        aspek: isi.aspek.map((a) => ({
          ...(a.id_aspek ? { id_aspek: a.id_aspek } : {}),
          nama: a.nama,
          tipe: a.tipe,
          bobot: Number(a.bobot),
          panduan: a.panduan,
          is_aktif: a.is_aktif,
        })),
        jabatan: isi.jabatan,
      });
      onPesan("Template disimpan.");
      setIsi(null);
      await muat();
    } catch (error) {
      onPesan(pesanGalat(error, "Template gagal disimpan."));
    } finally {
      setSibuk(false);
    }
  };

  const ubahAspek = (i: number, ubah: Partial<AspekIsian>) =>
    isi &&
    setIsi({
      ...isi,
      aspek: isi.aspek.map((a, j) => (j === i ? { ...a, ...ubah } : a)),
    });
  const geser = (i: number, arah: -1 | 1) => {
    if (!isi) return;
    const aspek = [...isi.aspek];
    const j = i + arah;
    if (j < 0 || j >= aspek.length) return;
    [aspek[i], aspek[j]] = [aspek[j] as AspekIsian, aspek[i] as AspekIsian];
    setIsi({ ...isi, aspek });
  };
  const totalAktif = (isi?.aspek ?? [])
    .filter((a) => a.is_aktif)
    .reduce((n, a) => n + (Number(a.bobot) || 0), 0);

  return (
    <div className="space-y-4">
      <section className="space-y-3 rounded-2xl border border-slate-800 bg-slate-900 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-bold text-white">Template penilaian</h3>
          <button
            type="button"
            id="kinerja-template-baru"
            className={`${TOMBOL_KEDUA} ml-auto`}
            onClick={() => setIsi({ ...KOSONG, aspek: [{ ...ASPEK_BARU }] })}
          >
            Template baru
          </button>
        </div>
        {data.template.length === 0 ? (
          <p className="text-sm text-slate-400">
            Belum ada template. Karyawan baru bisa dinilai setelah jabatannya
            dipetakan ke template, atau ada template bawaan.
          </p>
        ) : (
          <ul className="space-y-1">
            {data.template.map((t) => (
              <li key={t.id_template}>
                <button
                  type="button"
                  onClick={() => setIsi(dariTemplate(t))}
                  className="w-full rounded-xl px-3 py-2 text-left hover:bg-slate-800"
                >
                  <span className="block font-semibold text-white">
                    {t.nama}
                    {t.is_bawaan === 1 ? " • bawaan" : ""}
                    {t.is_aktif === 1 ? "" : " • nonaktif"}
                  </span>
                  <span className="block truncate text-xs text-slate-400">
                    {t.aspek.filter((a) => a.is_aktif === 1).length} aspek •{" "}
                    {t.jabatan.map((j) => namaJabatan.get(j) ?? j).join(", ") ||
                      "Tanpa jabatan"}
                  </span>
                  {t.nama_ganda ? (
                    <span className="block text-xs text-amber-200">
                      Nama kembar dengan template lain
                    </span>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {isi ? (
        <section className="space-y-3 rounded-2xl border border-slate-800 bg-slate-900 p-4">
          <h3 className="text-sm font-bold text-white">
            {isi.id_template ? "Ubah template" : "Template baru"}
          </h3>
          <p className="text-xs text-slate-400">
            Perubahan hanya berlaku untuk penilaian yang dibuat sesudahnya; draf
            bisa memuat ulang template.
          </p>
          <div className="grid gap-2 sm:grid-cols-2">
            <div>
              <label className={LABEL} htmlFor="kinerja-template-nama">
                Nama
              </label>
              <input
                id="kinerja-template-nama"
                className={INPUT}
                maxLength={100}
                value={isi.nama}
                onChange={(e) => setIsi({ ...isi, nama: e.target.value })}
              />
            </div>
            <div>
              <label className={LABEL} htmlFor="kinerja-template-keterangan">
                Keterangan
              </label>
              <input
                id="kinerja-template-keterangan"
                className={INPUT}
                maxLength={1000}
                value={isi.keterangan}
                onChange={(e) => setIsi({ ...isi, keterangan: e.target.value })}
              />
            </div>
          </div>
          <div className="flex flex-wrap gap-4 text-sm text-slate-200">
            <label
              className="flex items-center gap-2"
              htmlFor="kinerja-template-aktif"
            >
              <input
                id="kinerja-template-aktif"
                type="checkbox"
                checked={isi.is_aktif}
                onChange={(e) => setIsi({ ...isi, is_aktif: e.target.checked })}
              />
              Aktif
            </label>
            <label
              className="flex items-center gap-2"
              htmlFor="kinerja-template-bawaan"
            >
              <input
                id="kinerja-template-bawaan"
                type="checkbox"
                checked={isi.is_bawaan}
                onChange={(e) =>
                  setIsi({ ...isi, is_bawaan: e.target.checked })
                }
              />
              Bawaan (untuk jabatan tanpa template)
            </label>
          </div>

          <div className="space-y-2">
            <p
              className={`text-xs font-bold ${totalAktif === TOTAL_BOBOT ? "text-emerald-200" : "text-amber-200"}`}
            >
              Total bobot aspek aktif: {totalAktif} dari {TOTAL_BOBOT} • paling
              banyak {MAKS_ASPEK_AKTIF} aspek aktif, satu Otomatis Disiplin
            </p>
            {isi.aspek.map((a, i) => (
              <div
                key={a.id_aspek || `baru-${i}`}
                className="grid gap-2 rounded-xl border border-slate-800 p-3 sm:grid-cols-[minmax(0,1fr)_10rem_6rem]"
              >
                <div className="min-w-0">
                  <label className={LABEL} htmlFor={`kinerja-aspek-nama-${i}`}>
                    Aspek
                  </label>
                  <input
                    id={`kinerja-aspek-nama-${i}`}
                    className={INPUT}
                    maxLength={100}
                    value={a.nama}
                    onChange={(e) => ubahAspek(i, { nama: e.target.value })}
                  />
                </div>
                <div>
                  <label className={LABEL} htmlFor={`kinerja-aspek-tipe-${i}`}>
                    Tipe
                  </label>
                  <select
                    id={`kinerja-aspek-tipe-${i}`}
                    className={INPUT}
                    disabled={a.id_aspek !== ""}
                    value={a.tipe}
                    onChange={(e) => ubahAspek(i, { tipe: e.target.value })}
                  >
                    {TIPE_ASPEK.map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className={LABEL} htmlFor={`kinerja-aspek-bobot-${i}`}>
                    Bobot
                  </label>
                  <input
                    id={`kinerja-aspek-bobot-${i}`}
                    className={INPUT}
                    inputMode="numeric"
                    value={a.bobot}
                    onChange={(e) =>
                      ubahAspek(i, { bobot: e.target.value.replace(/\D/g, "") })
                    }
                  />
                </div>
                <div className="min-w-0 sm:col-span-3">
                  <label
                    className={LABEL}
                    htmlFor={`kinerja-aspek-panduan-${i}`}
                  >
                    Panduan untuk penilai
                    {a.tipe === TIPE_DISIPLIN
                      ? " (skor dihitung dari absensi)"
                      : ""}
                  </label>
                  <input
                    id={`kinerja-aspek-panduan-${i}`}
                    className={INPUT}
                    maxLength={1000}
                    value={a.panduan}
                    onChange={(e) => ubahAspek(i, { panduan: e.target.value })}
                  />
                </div>
                <div className="flex flex-wrap items-center gap-2 sm:col-span-3">
                  <label
                    className="flex items-center gap-2 text-sm text-slate-200"
                    htmlFor={`kinerja-aspek-aktif-${i}`}
                  >
                    <input
                      id={`kinerja-aspek-aktif-${i}`}
                      type="checkbox"
                      checked={a.is_aktif}
                      onChange={(e) =>
                        ubahAspek(i, { is_aktif: e.target.checked })
                      }
                    />
                    Aktif
                  </label>
                  <button
                    type="button"
                    className={TOMBOL_KEDUA}
                    aria-label={`Naikkan ${a.nama || "aspek"}`}
                    disabled={i === 0}
                    onClick={() => geser(i, -1)}
                  >
                    Naik
                  </button>
                  <button
                    type="button"
                    className={TOMBOL_KEDUA}
                    aria-label={`Turunkan ${a.nama || "aspek"}`}
                    disabled={i === isi.aspek.length - 1}
                    onClick={() => geser(i, 1)}
                  >
                    Turun
                  </button>
                  {a.id_aspek === "" ? (
                    <button
                      type="button"
                      className={TOMBOL_KEDUA}
                      onClick={() =>
                        setIsi({
                          ...isi,
                          aspek: isi.aspek.filter((_, j) => j !== i),
                        })
                      }
                    >
                      Hapus baris
                    </button>
                  ) : null}
                </div>
              </div>
            ))}
            <button
              type="button"
              id="kinerja-aspek-tambah"
              className={TOMBOL_KEDUA}
              onClick={() =>
                setIsi({ ...isi, aspek: [...isi.aspek, { ...ASPEK_BARU }] })
              }
            >
              Tambah aspek
            </button>
          </div>

          <fieldset className="space-y-1">
            <legend className={LABEL}>Jabatan yang memakai template ini</legend>
            {data.jabatan.length === 0 ? (
              <p className="text-xs text-slate-400">
                Belum ada master jabatan.
              </p>
            ) : (
              <div className="grid gap-1 sm:grid-cols-2">
                {data.jabatan.map((j) => {
                  const lain =
                    j.id_template && j.id_template !== isi.id_template
                      ? namaTemplate.get(j.id_template)
                      : null;
                  return (
                    <label
                      key={j.id_jabatan}
                      className="flex items-center gap-2 text-sm text-slate-200"
                      htmlFor={`kinerja-jabatan-${j.id_jabatan}`}
                    >
                      <input
                        id={`kinerja-jabatan-${j.id_jabatan}`}
                        type="checkbox"
                        checked={isi.jabatan.includes(j.id_jabatan)}
                        onChange={(e) =>
                          setIsi({
                            ...isi,
                            jabatan: e.target.checked
                              ? [...isi.jabatan, j.id_jabatan]
                              : isi.jabatan.filter((x) => x !== j.id_jabatan),
                          })
                        }
                      />
                      <span className="min-w-0 truncate">
                        {j.nama}
                        {lain ? (
                          <span className="text-xs text-slate-400">
                            {" "}
                            (sekarang: {lain})
                          </span>
                        ) : null}
                      </span>
                    </label>
                  );
                })}
              </div>
            )}
          </fieldset>

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              id="kinerja-template-simpan"
              className={TOMBOL_UTAMA}
              disabled={sibuk}
              onClick={() => void simpan()}
            >
              Simpan template
            </button>
            <button
              type="button"
              className={TOMBOL_KEDUA}
              onClick={() => setIsi(null)}
            >
              Tutup
            </button>
          </div>
        </section>
      ) : null}

      <PengaturanKinerjaForm
        key={JSON.stringify(data.pengaturan)}
        data={data}
        onPesan={onPesan}
        onBerubah={muat}
      />
    </div>
  );
}

function PengaturanKinerjaForm({
  data,
  onPesan,
  onBerubah,
}: {
  data: DaftarTemplateKinerja;
  onPesan: (p: string) => void;
  onBerubah: () => Promise<void>;
}) {
  const awal = data.pengaturan;
  const [periode, setPeriode] = useState(awal.periode);
  const [ambang, setAmbang] = useState(awal.ambang.map(String));
  // Ambang predikat ditampilkan sebagai nilai 0–100 (disimpan ×100).
  const [predikat, setPredikat] = useState(
    awal.predikat.map((p) => ({ nama: p.nama, batas: String(p.ambang / 100) })),
  );
  const [sibuk, setSibuk] = useState(false);

  const simpan = async () => {
    const teksPredikat = predikat
      .map(
        (p) =>
          `${Math.round(Number(p.batas.replace(",", ".")) * 100)}:${p.nama}`,
      )
      .join("|");
    const lanjut = await konfirmasiData([
      { label: "Periode", nilai: periode },
      { label: "Ambang disiplin (permil)", nilai: ambang.join(" / ") },
      {
        label: "Predikat",
        nilai: predikat.map((p) => `${p.nama} ≥ ${p.batas}`).join(", "),
      },
    ]);
    if (!lanjut) return;
    setSibuk(true);
    try {
      await simpanPengaturanKinerja({
        [KUNCI_PERIODE]: periode,
        [KUNCI_AMBANG]: ambang.join(","),
        [KUNCI_PREDIKAT]: teksPredikat,
      });
      onPesan("Pengaturan kinerja disimpan.");
      await onBerubah();
    } catch (error) {
      onPesan(pesanGalat(error, "Pengaturan gagal disimpan."));
    } finally {
      setSibuk(false);
    }
  };

  return (
    <section className="space-y-3 rounded-2xl border border-slate-800 bg-slate-900 p-4">
      <h3 className="text-sm font-bold text-white">Pengaturan penilaian</h3>
      <div className="grid gap-2 sm:max-w-md">
        <div>
          <label className={LABEL} htmlFor="kinerja-pengaturan-periode">
            Periode penilaian baru
          </label>
          <select
            id="kinerja-pengaturan-periode"
            className={INPUT}
            value={periode}
            onChange={(e) => setPeriode(e.target.value)}
          >
            {PERIODE_JENIS.map((j) => (
              <option key={j} value={j}>
                {j}
              </option>
            ))}
          </select>
        </div>
      </div>
      <fieldset className="space-y-1">
        <legend className={LABEL}>
          Ambang disiplin: permil minimal untuk skor 5, 4, 3, 2
        </legend>
        <div className="grid grid-cols-4 gap-2 sm:max-w-md">
          {ambang.map((a, i) => (
            <input
              // biome-ignore lint/suspicious/noArrayIndexKey: empat posisi tetap.
              key={i}
              id={`kinerja-ambang-${5 - i}`}
              aria-label={`Ambang skor ${5 - i}`}
              className={INPUT}
              inputMode="numeric"
              value={a}
              onChange={(e) =>
                setAmbang(
                  ambang.map((x, j) =>
                    j === i ? e.target.value.replace(/\D/g, "") : x,
                  ),
                )
              }
            />
          ))}
        </div>
      </fieldset>
      <fieldset className="space-y-2">
        <legend className={LABEL}>
          Predikat: nilai akhir minimal (0–100), dari tertinggi; yang terakhir 0
        </legend>
        {predikat.map((p, i) => (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: urutan baris adalah datanya.
            key={i}
            className="grid grid-cols-[minmax(0,1fr)_6rem_auto] gap-2"
          >
            <input
              id={`kinerja-predikat-nama-${i}`}
              aria-label={`Nama predikat ${i + 1}`}
              className={INPUT}
              maxLength={50}
              value={p.nama}
              onChange={(e) =>
                setPredikat(
                  predikat.map((x, j) =>
                    j === i ? { ...x, nama: e.target.value } : x,
                  ),
                )
              }
            />
            <input
              id={`kinerja-predikat-batas-${i}`}
              aria-label={`Nilai minimal predikat ${i + 1}`}
              className={INPUT}
              inputMode="decimal"
              value={p.batas}
              onChange={(e) =>
                setPredikat(
                  predikat.map((x, j) =>
                    j === i ? { ...x, batas: e.target.value } : x,
                  ),
                )
              }
            />
            <button
              type="button"
              className={TOMBOL_KEDUA}
              aria-label={`Hapus predikat ${p.nama || i + 1}`}
              disabled={predikat.length <= 2}
              onClick={() => setPredikat(predikat.filter((_, j) => j !== i))}
            >
              Hapus
            </button>
          </div>
        ))}
        <button
          type="button"
          className={TOMBOL_KEDUA}
          disabled={predikat.length >= 7}
          onClick={() => setPredikat([...predikat, { nama: "", batas: "0" }])}
        >
          Tambah predikat
        </button>
      </fieldset>
      <button
        type="button"
        id="kinerja-pengaturan-simpan"
        className={TOMBOL_UTAMA}
        disabled={sibuk}
        onClick={() => void simpan()}
      >
        Simpan pengaturan
      </button>
    </section>
  );
}
