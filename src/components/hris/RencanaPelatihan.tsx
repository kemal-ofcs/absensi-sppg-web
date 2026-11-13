"use client";

// Rencana dan anggaran pelatihan (PRD HRIS §26, fase 11). Khusus cloud.
// Pagu per divisi per tahun + Umum; realisasi = biaya yang dicatat di
// pelatihan (Terikat = Dijadwalkan, Terpakai = Berlangsung + Selesai).
// Melewati pagu hanya ditandai, tidak pernah ditolak (Q-143).

import { useCallback, useEffect, useRef, useState } from "react";
import { DaftarRincian } from "@/components/hris/DaftarRincian";
import { konfirmasiData } from "@/components/ui/KonfirmasiData";
import { PilihCari } from "@/components/ui/PilihCari";
import { saveFileWithPicker } from "@/lib/client/download";
import { AngkaExcel, buildXlsxWorkbook } from "@/lib/client/excel-export";
import {
  ambilRencanaPelatihan,
  type RencanaTahunan,
  simpanRencanaPelatihan,
} from "@/lib/gateways/hr-pelatihan";
import type { Divisi } from "@/lib/gateways/hris";
import { formatRupiah } from "@/lib/validations/accounting";
import type {
  KelompokAnggaran,
  TandaPagu,
  TandaRencana,
} from "@/lib/validations/hr-pelatihan";

const KELAS =
  "min-h-10 w-full rounded-xl border border-slate-800 bg-slate-950 px-3 text-white outline-none focus:border-sky-500";
const LABEL = "mb-1 block text-xs font-semibold text-slate-400";
const TOMBOL =
  "min-h-10 rounded-xl bg-sky-500 px-4 text-sm font-bold text-white disabled:opacity-50";
const TOMBOL_KEDUA =
  "min-h-9 rounded-xl border border-slate-700 px-3 text-xs font-bold text-slate-200 disabled:opacity-50";
const KARTU = "rounded-2xl border border-slate-800 bg-slate-900 p-4";
const MIME_XLSX =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export const LABEL_TANDA_ANGGARAN: Record<TandaPagu | TandaRencana, string> = {
  lewat_pagu: "Melewati pagu",
  rencana_lewat_pagu: "Rencana melewati pagu",
  tanpa_pagu: "Belum ada pagu",
  lewat_estimasi: "Melewati estimasi",
  beda_tahun: "Ada pelatihan di tahun lain",
};

const WARNA_STATUS: Record<string, string> = {
  Terlaksana: "text-emerald-200",
  Berlangsung: "text-amber-200",
  Dijadwalkan: "text-sky-200",
  Terlewat: "text-rose-200",
  "Belum dijadwalkan": "text-slate-300",
  Dibatalkan: "text-slate-400",
};

type Isian = Record<string, string>;
type Rencana = RencanaTahunan["rencana"][number];

export const namaBulan = (bulan: number) =>
  new Date(2000, bulan - 1, 1).toLocaleString("id-ID", { month: "long" });
export const bacaRupiah = (teks: string) => {
  const digit = teks.replace(/\D/g, "");
  return digit === "" ? 0 : Number(digit);
};
const isianRupiah = (teks: string) =>
  teks === "" ? "" : bacaRupiah(teks).toLocaleString("id-ID");
const rupiahAtauKosong = (nilai: number | null) =>
  nilai === null ? "-" : formatRupiah(nilai);
const pesanGalat = (error: unknown, cadangan: string) =>
  error instanceof Error ? error.message : cadangan;
const teksTanda = (tanda: readonly (TandaPagu | TandaRencana)[]) =>
  tanda.map((t) => LABEL_TANDA_ANGGARAN[t]).join(", ");

function Tanda({ tanda }: { tanda: readonly (TandaPagu | TandaRencana)[] }) {
  if (tanda.length === 0) return null;
  return (
    <span className="block text-xs font-normal text-amber-200">
      {teksTanda(tanda)}
    </span>
  );
}

/** Satu kiriman sekaligus; pesan berhasil atau galat ke `setPesan`. */
function useKirim(setPesan: (pesan: string) => void) {
  const kirimRef = useRef(false);
  const [sibuk, setSibuk] = useState(false);
  const jalankan = useCallback(
    async (kerja: () => Promise<string>, cadangan: string) => {
      if (kirimRef.current) return false;
      kirimRef.current = true;
      setSibuk(true);
      try {
        setPesan(await kerja());
        return true;
      } catch (error) {
        setPesan(pesanGalat(error, cadangan));
        return false;
      } finally {
        kirimRef.current = false;
        setSibuk(false);
      }
    },
    [setPesan],
  );
  return { sibuk, jalankan };
}

/** Ekspor Excel (Q-147): sheet Ringkasan dan Rencana, angka = sel Angka. */
function ekspor(data: RencanaTahunan) {
  const angka = (nilai: number | null) =>
    nilai === null ? "" : new AngkaExcel(nilai);
  const isi = buildXlsxWorkbook([
    {
      nama: "Ringkasan",
      headers: [
        "Kelompok",
        "Pagu",
        "Direncanakan",
        "Terikat",
        "Terpakai",
        "Sisa",
        "Tanda",
        "Catatan pagu",
      ],
      rows: [
        ...data.kelompok.map((k) => [
          k.nama,
          angka(k.pagu),
          angka(k.direncanakan),
          angka(k.terikat),
          angka(k.terpakai),
          angka(k.sisa),
          teksTanda(k.tanda),
          k.catatan ?? "",
        ]),
        [
          "Total",
          angka(data.total.pagu),
          angka(data.total.direncanakan),
          angka(data.total.terikat),
          angka(data.total.terpakai),
          angka(data.total.sisa),
          teksTanda(data.total.tanda),
          "",
        ],
      ],
      lebar: [28, 16, 16, 16, 16, 16, 30, 30],
      kolomBeku: 1,
    },
    {
      nama: "Rencana",
      headers: [
        "Nama",
        "Divisi",
        "Bulan",
        "Status",
        "Peserta rencana",
        "Peserta aktual",
        "Estimasi biaya",
        "Realisasi",
        "Jumlah pelatihan",
        "Penyelenggara",
        "Tanda",
        "Keterangan",
      ],
      rows: [
        ...data.rencana.map((r) => [
          r.nama,
          r.nama_divisi ?? (r.id_divisi ? r.id_divisi : "Umum"),
          r.bulan ? namaBulan(r.bulan) : "",
          r.status,
          angka(r.peserta_rencana),
          angka(r.peserta_aktual),
          angka(r.biaya_rencana),
          angka(r.realisasi),
          angka(r.jumlah_pelatihan),
          r.penyelenggara ?? "",
          teksTanda(r.tanda),
          r.keterangan ?? "",
        ]),
        [
          "Di luar rencana",
          "Umum",
          "",
          "",
          "",
          angka(data.di_luar_rencana.peserta_aktual),
          "",
          angka(data.di_luar_rencana.realisasi),
          angka(data.di_luar_rencana.jumlah_pelatihan),
          "",
          "",
          "",
        ],
      ],
      lebar: [32, 20, 12, 18, 14, 14, 16, 16, 14, 24, 30, 40],
      kolomBeku: 1,
    },
  ]);
  return saveFileWithPicker(
    new Blob([isi as unknown as BlobPart], { type: MIME_XLSX }),
    `Rencana_Pelatihan_${data.tahun}.xlsx`,
    {
      description: "Spreadsheet Excel (.xlsx)",
      accept: { [MIME_XLSX]: [".xlsx"] },
    },
  );
}

/** Opsi divisi: aktif, ditambah yang sedang tersimpan walau nonaktif. */
function OpsiDivisi({ divisi, tetap }: { divisi: Divisi[]; tetap: string }) {
  return (
    <>
      <option value="">Umum (tanpa divisi)</option>
      {divisi
        .filter((d) => d.is_aktif === 1 || d.id_divisi === tetap)
        .map((d) => (
          <option key={d.id_divisi} value={d.id_divisi}>
            {d.nama}
            {d.is_aktif === 1 ? "" : " (nonaktif)"}
          </option>
        ))}
    </>
  );
}

export function RencanaPelatihan({
  tahun,
  divisi,
  bolehUbah,
}: {
  tahun: number | null;
  divisi: Divisi[];
  bolehUbah: boolean;
}) {
  const [data, setData] = useState<RencanaTahunan | null>(null);
  const [dipilih, setDipilih] = useState<string | null>(null);
  const [form, setForm] = useState<Isian | null>(null);
  const [pagu, setPagu] = useState<Isian | null>(null);
  const [pesan, setPesan] = useState("");
  const { sibuk, jalankan } = useKirim(setPesan);

  const muat = useCallback(() => {
    ambilRencanaPelatihan(tahun ?? undefined)
      .then(setData)
      .catch((error: unknown) =>
        setPesan(pesanGalat(error, "Rencana pelatihan gagal dimuat.")),
      );
  }, [tahun]);
  useEffect(muat, [muat]);

  if (!data) {
    return (
      <p className={`${KARTU} text-sm text-slate-400`}>
        {pesan || "Memuat rencana dan anggaran..."}
      </p>
    );
  }
  const terpilih = data.rencana.find((r) => r.id_rencana === dipilih) ?? null;

  const simpanPagu = async () => {
    if (!pagu) return;
    const kelompok =
      divisi.find((d) => d.id_divisi === pagu.id_divisi)?.nama ?? "Umum";
    const lanjut = await konfirmasiData([
      { label: "Tahun", nilai: String(data.tahun) },
      { label: "Kelompok", nilai: kelompok },
      { label: "Pagu", nilai: formatRupiah(bacaRupiah(pagu.nominal ?? "")) },
      { label: "Catatan", nilai: pagu.catatan },
    ]);
    if (!lanjut) return;
    const ok = await jalankan(async () => {
      await simpanRencanaPelatihan({
        aksi: "pagu",
        tahun: data.tahun,
        id_divisi: pagu.id_divisi || null,
        nominal: bacaRupiah(pagu.nominal ?? ""),
        catatan: pagu.catatan || null,
      });
      return "Pagu tersimpan.";
    }, "Pagu gagal disimpan.");
    if (ok) {
      setPagu(null);
      muat();
    }
  };

  const hapusPagu = async (k: KelompokAnggaran) => {
    const lanjut = await konfirmasiData([
      { label: "Tahun", nilai: String(data.tahun) },
      { label: "Kelompok", nilai: k.nama },
      { label: "Pagu", nilai: rupiahAtauKosong(k.pagu) },
      {
        label: "Hapus pagu",
        nilai:
          "Pagu dihapus tanpa riwayat; kelompok ini menjadi belum ada pagu.",
        peringatan: true,
      },
    ]);
    if (!lanjut) return;
    const ok = await jalankan(async () => {
      await simpanRencanaPelatihan({
        aksi: "hapus_pagu",
        tahun: data.tahun,
        id_divisi: k.id_divisi,
      });
      return "Pagu dihapus.";
    }, "Pagu gagal dihapus.");
    if (ok) muat();
  };

  const kolom = [
    "Pagu",
    "Direncanakan",
    "Terikat",
    "Terpakai",
    "Sisa",
  ] as const;
  const angkaKolom = (
    k: Pick<
      KelompokAnggaran,
      "pagu" | "direncanakan" | "terikat" | "terpakai" | "sisa"
    >,
  ) => [k.pagu, k.direncanakan, k.terikat, k.terpakai, k.sisa];

  return (
    <div className="space-y-4">
      <div className={`${KARTU} space-y-3`}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-bold text-white">
            Anggaran pelatihan {data.tahun}
          </h3>
          <div className="flex flex-wrap gap-2">
            {bolehUbah ? (
              <button
                id="anggaran-atur-pagu"
                type="button"
                className={TOMBOL_KEDUA}
                onClick={() =>
                  setPagu({ id_divisi: "", nominal: "", catatan: "" })
                }
              >
                Atur pagu
              </button>
            ) : null}
            <button
              id="anggaran-ekspor"
              type="button"
              className={TOMBOL_KEDUA}
              onClick={() =>
                void ekspor(data)
                  .then((hasil) => {
                    if (!hasil.sukses && !hasil.cancelled)
                      setPesan("Berkas gagal disimpan.");
                  })
                  .catch((error: unknown) =>
                    setPesan(pesanGalat(error, "Berkas gagal disimpan.")),
                  )
              }
            >
              Ekspor Excel
            </button>
          </div>
        </div>
        {pesan ? <p className="text-sm text-amber-200">{pesan}</p> : null}
        <div className="overflow-x-auto">
          <table className="w-full min-w-[40rem] text-left text-sm">
            <thead className="text-xs text-slate-400">
              <tr>
                <th className="py-2 pr-3">Kelompok</th>
                {kolom.map((k) => (
                  <th key={k} className="py-2 pr-3 text-right">
                    {k}
                  </th>
                ))}
                {bolehUbah ? <th className="py-2" /> : null}
              </tr>
            </thead>
            <tbody>
              {data.kelompok.map((k) => (
                <tr key={k.kunci} className="border-t border-slate-800">
                  <td className="py-2 pr-3 text-slate-200">
                    {k.nama}
                    {k.divisi_aktif === false ? (
                      <span className="text-xs text-slate-400">
                        {" "}
                        (nonaktif)
                      </span>
                    ) : null}
                    <Tanda tanda={k.tanda} />
                  </td>
                  {angkaKolom(k).map((n, i) => (
                    <td
                      key={kolom[i]}
                      className={`py-2 pr-3 text-right ${i === 4 && n !== null && n < 0 ? "font-bold text-rose-200" : "text-slate-200"}`}
                    >
                      {rupiahAtauKosong(n)}
                    </td>
                  ))}
                  {bolehUbah ? (
                    <td className="py-2 text-right whitespace-nowrap">
                      <button
                        type="button"
                        className={TOMBOL_KEDUA}
                        onClick={() =>
                          setPagu({
                            id_divisi: k.id_divisi ?? "",
                            nominal:
                              k.pagu === null
                                ? ""
                                : k.pagu.toLocaleString("id-ID"),
                            catatan: k.catatan ?? "",
                          })
                        }
                      >
                        {k.pagu === null ? "Isi pagu" : "Ubah"}
                      </button>
                      {k.pagu !== null ? (
                        <button
                          type="button"
                          className={`${TOMBOL_KEDUA} ml-1`}
                          disabled={sibuk}
                          onClick={() => void hapusPagu(k)}
                        >
                          Hapus
                        </button>
                      ) : null}
                    </td>
                  ) : null}
                </tr>
              ))}
              <tr className="border-t border-slate-700 font-bold">
                <td className="py-2 pr-3 text-white">
                  Total
                  <Tanda tanda={data.total.tanda} />
                </td>
                {angkaKolom(data.total).map((n, i) => (
                  <td
                    key={kolom[i]}
                    className={`py-2 pr-3 text-right ${i === 4 && n !== null && n < 0 ? "text-rose-200" : "text-white"}`}
                  >
                    {rupiahAtauKosong(n)}
                  </td>
                ))}
                {bolehUbah ? <td /> : null}
              </tr>
            </tbody>
          </table>
        </div>
        <p className="text-xs text-slate-400">
          Di luar rencana: {data.di_luar_rencana.jumlah_pelatihan} pelatihan,{" "}
          {formatRupiah(data.di_luar_rencana.realisasi)}, dibebankan ke Umum.
          Realisasi adalah biaya yang dicatat di pelatihan, bukan jurnal.
        </p>
        {pagu ? (
          <div className="grid gap-3 rounded-xl border border-slate-800 p-3 sm:grid-cols-3">
            <div>
              <label htmlFor="anggaran-pagu-divisi" className={LABEL}>
                Kelompok
              </label>
              <PilihCari
                id="anggaran-pagu-divisi"
                value={pagu.id_divisi ?? ""}
                onChange={(e) =>
                  setPagu((lama) => ({ ...lama, id_divisi: e.target.value }))
                }
                className={KELAS}
              >
                <OpsiDivisi divisi={divisi} tetap={pagu.id_divisi ?? ""} />
              </PilihCari>
            </div>
            <div>
              <label htmlFor="anggaran-pagu-nominal" className={LABEL}>
                Pagu (Rp)
              </label>
              <input
                id="anggaran-pagu-nominal"
                inputMode="numeric"
                value={pagu.nominal ?? ""}
                onChange={(e) =>
                  setPagu((lama) => ({
                    ...lama,
                    nominal: isianRupiah(e.target.value),
                  }))
                }
                className={KELAS}
              />
            </div>
            <div>
              <label htmlFor="anggaran-pagu-catatan" className={LABEL}>
                Catatan
              </label>
              <input
                id="anggaran-pagu-catatan"
                value={pagu.catatan ?? ""}
                maxLength={1000}
                onChange={(e) =>
                  setPagu((lama) => ({ ...lama, catatan: e.target.value }))
                }
                className={KELAS}
              />
            </div>
            <p className="text-xs text-slate-400 sm:col-span-3">
              Pagu 0 berarti tidak dianggarkan. Melewati pagu tidak ditolak,
              hanya ditandai.
            </p>
            <div className="flex flex-wrap gap-2 sm:col-span-3">
              <button
                id="anggaran-pagu-simpan"
                type="button"
                className={TOMBOL}
                disabled={sibuk || pagu.nominal === ""}
                onClick={() => void simpanPagu()}
              >
                Simpan pagu
              </button>
              <button
                type="button"
                className={TOMBOL_KEDUA}
                onClick={() => setPagu(null)}
              >
                Batal
              </button>
            </div>
          </div>
        ) : null}
      </div>

      <DaftarRincian
        adaPilihan={Boolean(form || terpilih)}
        onKembali={() => {
          setForm(null);
          setDipilih(null);
        }}
        daftar={
          <div className={`${KARTU} space-y-3`}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-bold text-white">
                Rencana ({data.rencana.length})
              </h3>
              {bolehUbah ? (
                <button
                  id="rencana-baru"
                  type="button"
                  className={TOMBOL_KEDUA}
                  onClick={() => {
                    setDipilih(null);
                    setForm({ tahun: String(data.tahun) });
                  }}
                >
                  Rencana baru
                </button>
              ) : null}
            </div>
            <ul className="max-h-[65vh] space-y-1 overflow-y-auto">
              {data.rencana.map((r) => (
                <li key={r.id_rencana}>
                  <button
                    type="button"
                    onClick={() => {
                      setForm(null);
                      setDipilih(r.id_rencana);
                    }}
                    className={`w-full rounded-xl px-3 py-2 text-left ${dipilih === r.id_rencana ? "bg-sky-500/20" : "hover:bg-slate-800"}`}
                  >
                    <span className="block truncate font-semibold text-white">
                      {r.nama}
                    </span>
                    <span className="block truncate text-xs text-slate-400">
                      <span className={WARNA_STATUS[r.status] ?? ""}>
                        {r.status}
                      </span>{" "}
                      • {r.nama_divisi ?? "Umum"}
                      {r.bulan ? ` • ${namaBulan(r.bulan)}` : ""}
                    </span>
                    <span className="block truncate text-xs text-slate-400">
                      Estimasi {formatRupiah(r.biaya_rencana)} • realisasi{" "}
                      {formatRupiah(r.realisasi)}
                    </span>
                    <Tanda tanda={r.tanda} />
                  </button>
                </li>
              ))}
              {data.rencana.length === 0 ? (
                <li className="text-sm text-slate-400">
                  Belum ada rencana di tahun ini.
                </li>
              ) : null}
            </ul>
          </div>
        }
      >
        <div className="min-w-0">
          {form ? (
            <FormRencana
              awal={form}
              divisi={divisi}
              terkunciTahun={Boolean(terpilih && terpilih.jumlah_pelatihan > 0)}
              onBatal={() => setForm(null)}
              onTersimpan={(id) => {
                setForm(null);
                setDipilih(id);
                muat();
              }}
            />
          ) : terpilih ? (
            <RincianRencana
              key={terpilih.id_rencana}
              rencana={terpilih}
              bolehUbah={bolehUbah}
              onUbah={() =>
                setForm({
                  id_rencana: terpilih.id_rencana,
                  tahun: String(terpilih.tahun),
                  nama: terpilih.nama,
                  id_divisi: terpilih.id_divisi ?? "",
                  bulan: terpilih.bulan ? String(terpilih.bulan) : "",
                  peserta_rencana: String(terpilih.peserta_rencana),
                  biaya_rencana: terpilih.biaya_rencana
                    ? terpilih.biaya_rencana.toLocaleString("id-ID")
                    : "",
                  penyelenggara: terpilih.penyelenggara ?? "",
                  keterangan: terpilih.keterangan ?? "",
                })
              }
              onBerubah={muat}
            />
          ) : (
            <p className={`${KARTU} text-sm text-slate-400`}>
              Pilih rencana untuk melihat realisasinya.
            </p>
          )}
        </div>
      </DaftarRincian>
    </div>
  );
}

function FormRencana({
  awal,
  divisi,
  terkunciTahun,
  onBatal,
  onTersimpan,
}: {
  awal: Isian;
  divisi: Divisi[];
  terkunciTahun: boolean;
  onBatal: () => void;
  onTersimpan: (id: string) => void;
}) {
  const [isi, setIsi] = useState<Isian>(awal);
  const [pesan, setPesan] = useState("");
  const { sibuk, jalankan } = useKirim(setPesan);
  const ubah = (kunci: string, nilai: string) =>
    setIsi((lama) => ({ ...lama, [kunci]: nilai }));

  const simpan = async () => {
    const bulan = Number(isi.bulan) || null;
    const lanjut = await konfirmasiData([
      { label: "Tahun", nilai: isi.tahun },
      { label: "Nama", nilai: isi.nama },
      {
        label: "Divisi",
        nilai:
          divisi.find((d) => d.id_divisi === isi.id_divisi)?.nama ?? "Umum",
      },
      { label: "Bulan", nilai: bulan ? namaBulan(bulan) : "Tanpa bulan" },
      { label: "Peserta rencana", nilai: isi.peserta_rencana || "0" },
      {
        label: "Estimasi biaya",
        nilai: formatRupiah(bacaRupiah(isi.biaya_rencana ?? "")),
      },
      { label: "Penyelenggara", nilai: isi.penyelenggara },
    ]);
    if (!lanjut) return;
    let id = "";
    const ok = await jalankan(async () => {
      id =
        (
          await simpanRencanaPelatihan({
            id_rencana: isi.id_rencana || null,
            tahun: Number(isi.tahun),
            nama: isi.nama ?? "",
            id_divisi: isi.id_divisi || null,
            bulan,
            peserta_rencana: Number(isi.peserta_rencana || 0),
            biaya_rencana: bacaRupiah(isi.biaya_rencana ?? ""),
            penyelenggara: isi.penyelenggara || null,
            keterangan: isi.keterangan || null,
          })
        ).id_rencana ?? "";
      return "Rencana tersimpan.";
    }, "Rencana gagal disimpan.");
    if (ok) onTersimpan(id);
  };

  return (
    <div className={`${KARTU} space-y-3`}>
      <h3 className="text-sm font-bold text-white">
        {awal.id_rencana ? "Ubah rencana" : "Rencana baru"}
      </h3>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <label htmlFor="rencana-nama" className={LABEL}>
            Nama rencana
          </label>
          <input
            id="rencana-nama"
            value={isi.nama ?? ""}
            maxLength={100}
            onChange={(e) => ubah("nama", e.target.value)}
            className={KELAS}
          />
        </div>
        <div>
          <label htmlFor="rencana-tahun" className={LABEL}>
            Tahun
          </label>
          <input
            id="rencana-tahun"
            type="number"
            min={2000}
            max={2100}
            value={isi.tahun ?? ""}
            disabled={terkunciTahun}
            onChange={(e) => ubah("tahun", e.target.value)}
            className={KELAS}
          />
          {terkunciTahun ? (
            <p className="mt-1 text-xs text-slate-400">
              Terkunci selama ada pelatihan yang tertaut.
            </p>
          ) : null}
        </div>
        <div>
          <label htmlFor="rencana-bulan" className={LABEL}>
            Bulan (boleh kosong)
          </label>
          <select
            id="rencana-bulan"
            value={isi.bulan ?? ""}
            onChange={(e) => ubah("bulan", e.target.value)}
            className={KELAS}
          >
            <option value="">Tanpa bulan</option>
            {Array.from({ length: 12 }, (_, i) => i + 1).map((b) => (
              <option key={b} value={b}>
                {namaBulan(b)}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="rencana-divisi" className={LABEL}>
            Divisi
          </label>
          <PilihCari
            id="rencana-divisi"
            value={isi.id_divisi ?? ""}
            onChange={(e) => ubah("id_divisi", e.target.value)}
            className={KELAS}
          >
            <OpsiDivisi divisi={divisi} tetap={awal.id_divisi ?? ""} />
          </PilihCari>
        </div>
        <div>
          <label htmlFor="rencana-peserta" className={LABEL}>
            Jumlah peserta rencana
          </label>
          <input
            id="rencana-peserta"
            inputMode="numeric"
            value={isi.peserta_rencana ?? ""}
            onChange={(e) =>
              ubah("peserta_rencana", e.target.value.replace(/\D/g, ""))
            }
            className={KELAS}
          />
        </div>
        <div>
          <label htmlFor="rencana-biaya" className={LABEL}>
            Estimasi biaya (Rp)
          </label>
          <input
            id="rencana-biaya"
            inputMode="numeric"
            value={isi.biaya_rencana ?? ""}
            onChange={(e) => ubah("biaya_rencana", isianRupiah(e.target.value))}
            className={KELAS}
          />
        </div>
        <div>
          <label htmlFor="rencana-penyelenggara" className={LABEL}>
            Penyelenggara
          </label>
          <input
            id="rencana-penyelenggara"
            value={isi.penyelenggara ?? ""}
            maxLength={100}
            onChange={(e) => ubah("penyelenggara", e.target.value)}
            className={KELAS}
          />
        </div>
        <div className="sm:col-span-2">
          <label htmlFor="rencana-keterangan" className={LABEL}>
            Keterangan
          </label>
          <textarea
            id="rencana-keterangan"
            value={isi.keterangan ?? ""}
            maxLength={2000}
            onChange={(e) => ubah("keterangan", e.target.value)}
            className={`${KELAS} min-h-20 py-2`}
          />
        </div>
      </div>
      {pesan ? <p className="text-sm text-amber-200">{pesan}</p> : null}
      <div className="flex flex-wrap gap-2">
        <button
          id="rencana-simpan"
          type="button"
          className={TOMBOL}
          disabled={sibuk}
          onClick={() => void simpan()}
        >
          Simpan
        </button>
        <button type="button" className={TOMBOL_KEDUA} onClick={onBatal}>
          Batal
        </button>
      </div>
    </div>
  );
}

function RincianRencana({
  rencana: r,
  bolehUbah,
  onUbah,
  onBerubah,
}: {
  rencana: Rencana;
  bolehUbah: boolean;
  onUbah: () => void;
  onBerubah: () => void;
}) {
  const [alasan, setAlasan] = useState("");
  const [pesan, setPesan] = useState("");
  const { sibuk, jalankan } = useKirim(setPesan);
  const dibatalkan = r.status === "Dibatalkan";
  const ubahBoleh = bolehUbah && !dibatalkan;

  const batal = async () => {
    const lanjut = await konfirmasiData([
      { label: "Rencana", nilai: r.nama },
      { label: "Alasan pembatalan", nilai: alasan },
      {
        label: "Sesudah ini",
        nilai: "Rencana tidak bisa diubah lagi dan keluar dari Direncanakan.",
        peringatan: true,
      },
    ]);
    if (!lanjut) return;
    const ok = await jalankan(async () => {
      await simpanRencanaPelatihan({
        aksi: "batal",
        id_rencana: r.id_rencana,
        alasan,
      });
      return "Rencana dibatalkan.";
    }, "Rencana gagal dibatalkan.");
    if (ok) {
      setAlasan("");
      onBerubah();
    }
  };

  const selisih = r.biaya_rencana - r.realisasi;
  return (
    <div className={`${KARTU} space-y-4`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-lg font-bold text-white">{r.nama}</h2>
          <p className="text-xs text-slate-400">
            <span className={WARNA_STATUS[r.status] ?? ""}>{r.status}</span> •{" "}
            {r.tahun}
            {r.bulan ? ` ${namaBulan(r.bulan)}` : ""} •{" "}
            {r.nama_divisi ?? "Umum"}
            {r.divisi_aktif === 0 ? " (nonaktif)" : ""}
            {r.penyelenggara ? ` • ${r.penyelenggara}` : ""}
          </p>
          <Tanda tanda={r.tanda} />
          {dibatalkan ? (
            <p className="text-xs text-slate-400">
              Dibatalkan: {r.alasan_batal}
            </p>
          ) : null}
          {r.keterangan ? (
            <p className="whitespace-pre-wrap text-sm text-slate-300">
              {r.keterangan}
            </p>
          ) : null}
        </div>
        {ubahBoleh ? (
          <button type="button" className={TOMBOL_KEDUA} onClick={onUbah}>
            Ubah
          </button>
        ) : null}
      </div>
      <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
        {(
          [
            ["Estimasi", formatRupiah(r.biaya_rencana)],
            ["Realisasi", formatRupiah(r.realisasi)],
            [
              selisih < 0 ? "Lebih" : "Selisih",
              formatRupiah(Math.abs(selisih)),
            ],
            ["Peserta", `${r.peserta_aktual} dari ${r.peserta_rencana}`],
          ] as const
        ).map(([label, nilai]) => (
          <div key={label} className="min-w-0">
            <dt className="text-xs text-slate-400">{label}</dt>
            <dd className="truncate font-semibold text-white">{nilai}</dd>
          </div>
        ))}
      </dl>
      {pesan ? <p className="text-sm text-amber-200">{pesan}</p> : null}
      <section className="space-y-2">
        <h3 className="text-sm font-bold text-white">
          Pelatihan tertaut ({r.jumlah_pelatihan})
        </h3>
        <ul className="space-y-1 text-sm">
          {r.pelatihan.map((l) => (
            <li
              key={l.id_pelatihan ?? l.nama}
              className="rounded-xl border border-slate-800 px-3 py-2"
            >
              <span className="block truncate font-semibold text-white">
                {l.nama}
              </span>
              <span className="block truncate text-xs text-slate-400">
                {l.status} • {l.tanggal_mulai} • {l.jumlah_peserta} peserta •{" "}
                {formatRupiah(l.biaya)}
              </span>
            </li>
          ))}
          {r.pelatihan.length === 0 ? (
            <li className="text-slate-400">
              Belum ada. Tautkan dari form pelatihan.
            </li>
          ) : null}
        </ul>
      </section>
      {ubahBoleh ? (
        <section className="flex flex-wrap items-end gap-2">
          <div className="min-w-0 flex-1">
            <label htmlFor="rencana-alasan-batal" className={LABEL}>
              Alasan membatalkan rencana
            </label>
            <input
              id="rencana-alasan-batal"
              value={alasan}
              maxLength={2000}
              onChange={(e) => setAlasan(e.target.value)}
              className={KELAS}
            />
            {r.jumlah_pelatihan > 0 ? (
              <p className="mt-1 text-xs text-slate-400">
                Lepas tautan atau batalkan pelatihannya dulu.
              </p>
            ) : null}
          </div>
          <button
            id="rencana-batal"
            type="button"
            className={TOMBOL_KEDUA}
            disabled={sibuk || !alasan.trim() || r.jumlah_pelatihan > 0}
            onClick={() => void batal()}
          >
            Batalkan rencana
          </button>
        </section>
      ) : null}
    </div>
  );
}
