"use client";

// Tab Pelatihan di /hris dan tab Pelatihan rincian karyawan (PRD HRIS §22.7,
// Web/Desktop). Khusus cloud. Sertifikat = dokumen karyawan berjenis
// Sertifikat, jadi ikut tampil di tab Dokumen. Biaya per peserta hanya
// pembagian tampilan; tidak disimpan dan tidak dijurnal (Q-98).

import { useCallback, useEffect, useRef, useState } from "react";
import {
  bukaBerkas,
  mimeBerkasSah,
  PESAN_MIME_BERKAS,
  siapkanBerkas,
} from "@/components/hris/berkas";
import { DaftarRincian } from "@/components/hris/DaftarRincian";
import type { BarisKaryawan } from "@/components/hris/HrisWorkspace";
import { konfirmasiData } from "@/components/ui/KonfirmasiData";
import { PilihCari } from "@/components/ui/PilihCari";
import {
  ambilBerkasSertifikat,
  ambilPelatihan,
  ambilRincianPelatihan,
  ambilRiwayatPelatihan,
  type Pelatihan,
  type Peserta,
  type RiwayatPelatihan,
  simpanPelatihan,
  simpanPeserta,
  simpanSertifikat,
} from "@/lib/gateways/hr-pelatihan";
import { formatRupiah } from "@/lib/validations/accounting";
import {
  HASIL_PESERTA,
  PESAN_SERTIFIKAT_NONAKTIF,
} from "@/lib/validations/hr-pelatihan";
import { MAKS_BERKAS_PER_DOKUMEN } from "@/lib/validations/hris";

const KELAS =
  "min-h-10 w-full rounded-xl border border-slate-800 bg-slate-950 px-3 text-white outline-none focus:border-sky-500";
const LABEL = "mb-1 block text-xs font-semibold text-slate-400";
const TOMBOL =
  "min-h-10 rounded-xl bg-sky-500 px-4 text-sm font-bold text-white disabled:opacity-50";
const TOMBOL_KEDUA =
  "min-h-9 rounded-xl border border-slate-700 px-3 text-xs font-bold text-slate-200 disabled:opacity-50";
const KARTU = "rounded-2xl border border-slate-800 bg-slate-900 p-4";

const WARNA_STATUS: Record<string, string> = {
  Dijadwalkan: "text-sky-200",
  Berlangsung: "text-amber-200",
  Selesai: "text-emerald-200",
  Dibatalkan: "text-slate-400",
};

type Isian = Record<string, string>;

const pesanGalat = (error: unknown, cadangan: string) =>
  error instanceof Error ? error.message : cadangan;
const bacaRupiah = (teks: string) => {
  const digit = teks.replace(/\D/g, "");
  return digit === "" ? 0 : Number(digit);
};

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

export function PelatihanWorkspace({
  karyawan,
  bolehUbah,
}: {
  karyawan: BarisKaryawan[];
  bolehUbah: boolean;
}) {
  const [tahun, setTahun] = useState<number | null>(null);
  const [daftar, setDaftar] = useState<Pelatihan[]>([]);
  const [dipilih, setDipilih] = useState<string | null>(null);
  const [form, setForm] = useState<Isian | null>(null);
  const [hariIni, setHariIni] = useState("");
  const [pesan, setPesan] = useState("");

  const muat = useCallback(() => {
    ambilPelatihan(tahun ?? undefined)
      .then((d) => {
        setDaftar(d.pelatihan);
        setHariIni(d.hari_ini);
        setTahun(d.tahun);
      })
      .catch((error: unknown) =>
        setPesan(pesanGalat(error, "Pelatihan gagal dimuat.")),
      );
  }, [tahun]);
  useEffect(muat, [muat]);

  const tahunIni = Number(hariIni.slice(0, 4)) || new Date().getFullYear();
  const pilihanTahun = Array.from({ length: 6 }, (_, i) => tahunIni + 1 - i);

  return (
    <DaftarRincian
      adaPilihan={Boolean(form || dipilih)}
      onKembali={() => {
        setForm(null);
        setDipilih(null);
      }}
      daftar={
        <div className={`${KARTU} space-y-3`}>
          <div className="flex flex-wrap items-end justify-between gap-2">
            <div>
              <label htmlFor="pelatihan-tahun" className={LABEL}>
                Tahun
              </label>
              <select
                id="pelatihan-tahun"
                value={tahun ?? tahunIni}
                onChange={(e) => {
                  setDipilih(null);
                  setTahun(Number(e.target.value));
                }}
                className={KELAS}
              >
                {pilihanTahun.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </div>
            {bolehUbah ? (
              <button
                id="pelatihan-baru"
                type="button"
                className={TOMBOL_KEDUA}
                onClick={() => {
                  setDipilih(null);
                  setForm({
                    tanggal_mulai: hariIni,
                    tanggal_selesai: hariIni,
                    biaya: "",
                  });
                }}
              >
                Pelatihan baru
              </button>
            ) : null}
          </div>
          {pesan ? <p className="text-sm text-amber-200">{pesan}</p> : null}
          <ul className="max-h-[65vh] space-y-1 overflow-y-auto">
            {daftar.map((p) => (
              <li key={p.id_pelatihan}>
                <button
                  type="button"
                  onClick={() => {
                    setForm(null);
                    setDipilih(p.id_pelatihan);
                  }}
                  className={`w-full rounded-xl px-3 py-2 text-left ${dipilih === p.id_pelatihan ? "bg-sky-500/20" : "hover:bg-slate-800"}`}
                >
                  <span className="block truncate font-semibold text-white">
                    {p.nama}
                  </span>
                  <span className="block truncate text-xs text-slate-400">
                    <span className={WARNA_STATUS[p.status] ?? ""}>
                      {p.status}
                    </span>{" "}
                    • {p.tanggal_mulai}
                    {p.tanggal_selesai !== p.tanggal_mulai
                      ? ` s.d. ${p.tanggal_selesai}`
                      : ""}{" "}
                    • {p.jumlah_peserta ?? 0} peserta
                  </span>
                </button>
              </li>
            ))}
            {daftar.length === 0 ? (
              <li className="text-sm text-slate-400">
                Belum ada pelatihan di tahun ini.
              </li>
            ) : null}
          </ul>
        </div>
      }
    >
      <div className="min-w-0">
        {form ? (
          <FormPelatihan
            awal={form}
            onBatal={() => setForm(null)}
            onTersimpan={(id) => {
              setForm(null);
              setDipilih(id);
              muat();
            }}
          />
        ) : dipilih ? (
          <RincianPelatihan
            key={dipilih}
            idPelatihan={dipilih}
            karyawan={karyawan}
            bolehUbah={bolehUbah}
            onUbah={(p) =>
              setForm({
                id_pelatihan: p.id_pelatihan,
                nama: p.nama,
                penyelenggara: p.penyelenggara ?? "",
                lokasi: p.lokasi ?? "",
                tanggal_mulai: p.tanggal_mulai,
                tanggal_selesai: p.tanggal_selesai,
                biaya: p.biaya ? p.biaya.toLocaleString("id-ID") : "",
                keterangan: p.keterangan ?? "",
              })
            }
            onBerubah={muat}
          />
        ) : (
          <p className={`${KARTU} text-sm text-slate-400`}>
            Pilih pelatihan untuk melihat pesertanya.
          </p>
        )}
      </div>
    </DaftarRincian>
  );
}

function FormPelatihan({
  awal,
  onBatal,
  onTersimpan,
}: {
  awal: Isian;
  onBatal: () => void;
  onTersimpan: (id: string) => void;
}) {
  const [isi, setIsi] = useState<Isian>(awal);
  const [pesan, setPesan] = useState("");
  const { sibuk, jalankan } = useKirim(setPesan);
  const ubah = (kunci: string, nilai: string) =>
    setIsi((lama) => ({ ...lama, [kunci]: nilai }));

  const simpan = async () => {
    const lanjut = await konfirmasiData([
      { label: "Nama", nilai: isi.nama },
      { label: "Penyelenggara", nilai: isi.penyelenggara },
      { label: "Mulai", nilai: isi.tanggal_mulai },
      { label: "Selesai", nilai: isi.tanggal_selesai },
      {
        label: "Biaya total",
        nilai: formatRupiah(bacaRupiah(isi.biaya ?? "")),
      },
    ]);
    if (!lanjut) return;
    let id = "";
    const ok = await jalankan(async () => {
      id = (
        await simpanPelatihan({
          ...isi,
          biaya: bacaRupiah(isi.biaya ?? ""),
        })
      ).id_pelatihan;
      return "Pelatihan tersimpan.";
    }, "Pelatihan gagal disimpan.");
    if (ok) onTersimpan(id);
  };

  const teks = (
    kunci: string,
    label: string,
    jenis: "text" | "date" = "text",
    lebar = false,
  ) => (
    <div className={lebar ? "sm:col-span-2" : ""}>
      <label htmlFor={`pelatihan-${kunci}`} className={LABEL}>
        {label}
      </label>
      <input
        id={`pelatihan-${kunci}`}
        type={jenis}
        value={isi[kunci] ?? ""}
        maxLength={100}
        onChange={(e) => ubah(kunci, e.target.value)}
        className={KELAS}
      />
    </div>
  );

  return (
    <div className={`${KARTU} space-y-3`}>
      <h3 className="text-sm font-bold text-white">
        {awal.id_pelatihan ? "Ubah pelatihan" : "Pelatihan baru"}
      </h3>
      <div className="grid gap-3 sm:grid-cols-2">
        {teks("nama", "Nama pelatihan", "text", true)}
        {teks("penyelenggara", "Penyelenggara")}
        {teks("lokasi", "Lokasi")}
        {teks("tanggal_mulai", "Mulai", "date")}
        {teks("tanggal_selesai", "Selesai", "date")}
        <div>
          <label htmlFor="pelatihan-biaya" className={LABEL}>
            Biaya total (Rp)
          </label>
          <input
            id="pelatihan-biaya"
            inputMode="numeric"
            value={isi.biaya ?? ""}
            onChange={(e) =>
              ubah(
                "biaya",
                e.target.value === ""
                  ? ""
                  : bacaRupiah(e.target.value).toLocaleString("id-ID"),
              )
            }
            className={KELAS}
          />
        </div>
        <div className="sm:col-span-2">
          <label htmlFor="pelatihan-keterangan" className={LABEL}>
            Keterangan
          </label>
          <textarea
            id="pelatihan-keterangan"
            value={isi.keterangan ?? ""}
            maxLength={2000}
            onChange={(e) => ubah("keterangan", e.target.value)}
            className={`${KELAS} min-h-20 py-2`}
          />
        </div>
      </div>
      <p className="text-xs text-slate-400">
        Biaya hanya dicatat; pembukuannya lewat jurnal manual.
      </p>
      {pesan ? <p className="text-sm text-amber-200">{pesan}</p> : null}
      <div className="flex flex-wrap gap-2">
        <button
          id="pelatihan-simpan"
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

function RincianPelatihan({
  idPelatihan,
  karyawan,
  bolehUbah,
  onUbah,
  onBerubah,
}: {
  idPelatihan: string;
  karyawan: BarisKaryawan[];
  bolehUbah: boolean;
  onUbah: (p: Pelatihan) => void;
  onBerubah: () => void;
}) {
  const [data, setData] = useState<Pelatihan | null>(null);
  const [peserta, setPeserta] = useState<Peserta[]>([]);
  const [sertifikatAktif, setSertifikatAktif] = useState(true);
  const [tambah, setTambah] = useState("");
  const [alasanBatal, setAlasanBatal] = useState("");
  const [formSertifikat, setFormSertifikat] = useState<string | null>(null);
  const [pesan, setPesan] = useState("");
  const { sibuk, jalankan } = useKirim(setPesan);

  const muat = useCallback(() => {
    ambilRincianPelatihan(idPelatihan)
      .then((d) => {
        setData(d.pelatihan);
        setPeserta(d.peserta);
        setSertifikatAktif(d.sertifikat_aktif);
      })
      .catch((error: unknown) =>
        setPesan(pesanGalat(error, "Rincian pelatihan gagal dimuat.")),
      );
  }, [idPelatihan]);
  useEffect(muat, [muat]);

  if (!data) {
    return (
      <p className={`${KARTU} text-sm text-slate-400`}>
        {pesan || "Memuat pelatihan..."}
      </p>
    );
  }
  const dibatalkan = data.status === "Dibatalkan";
  const ubahBoleh = bolehUbah && !dibatalkan;
  const ikut = new Set(peserta.map((p) => p.id_karyawan));
  const calon = karyawan.filter(
    (k) => k.status_aktif === "Aktif" && !ikut.has(String(k.id_unik)),
  );

  const sesudah = (teks: string) => {
    muat();
    onBerubah();
    return teks;
  };

  const aksiPeserta = (isi: Record<string, unknown>, berhasil: string) =>
    jalankan(async () => {
      await simpanPeserta({ id_pelatihan: idPelatihan, ...isi });
      return sesudah(berhasil);
    }, "Peserta gagal diubah.");

  const batal = async () => {
    const lanjut = await konfirmasiData([
      { label: "Pelatihan", nilai: data.nama },
      { label: "Alasan pembatalan", nilai: alasanBatal },
      {
        label: "Sesudah ini",
        nilai:
          "Pelatihan tidak muncul di riwayat karyawan dan pesertanya terkunci.",
        peringatan: true,
      },
    ]);
    if (!lanjut) return;
    await jalankan(async () => {
      await simpanPelatihan({
        id_pelatihan: idPelatihan,
        aksi: "batal",
        alasan: alasanBatal,
      });
      setAlasanBatal("");
      return sesudah("Pelatihan dibatalkan.");
    }, "Pelatihan gagal dibatalkan.");
  };

  return (
    <div className={`${KARTU} space-y-4`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-lg font-bold text-white">{data.nama}</h2>
          <p className="text-xs text-slate-400">
            <span className={WARNA_STATUS[data.status] ?? ""}>
              {data.status}
            </span>{" "}
            • {data.tanggal_mulai}
            {data.tanggal_selesai !== data.tanggal_mulai
              ? ` s.d. ${data.tanggal_selesai}`
              : ""}
            {data.penyelenggara ? ` • ${data.penyelenggara}` : ""}
            {data.lokasi ? ` • ${data.lokasi}` : ""}
          </p>
          <p className="text-xs text-slate-400">
            Biaya {formatRupiah(data.biaya)}
            {peserta.length > 0 && data.biaya > 0
              ? ` • ±${formatRupiah(Math.round(data.biaya / peserta.length))} per peserta`
              : ""}
          </p>
          {dibatalkan ? (
            <p className="text-xs text-slate-400">
              Dibatalkan: {data.alasan_batal}
            </p>
          ) : null}
          {data.keterangan ? (
            <p className="whitespace-pre-wrap text-sm text-slate-300">
              {data.keterangan}
            </p>
          ) : null}
        </div>
        {ubahBoleh ? (
          <button
            type="button"
            className={TOMBOL_KEDUA}
            onClick={() => onUbah(data)}
          >
            Ubah
          </button>
        ) : null}
      </div>
      {pesan ? <p className="text-sm text-amber-200">{pesan}</p> : null}

      <section className="space-y-2">
        <h3 className="text-sm font-bold text-white">
          Peserta ({peserta.length})
        </h3>
        {ubahBoleh ? (
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-0 flex-1">
              <label htmlFor="pelatihan-tambah-peserta" className={LABEL}>
                Tambah peserta (karyawan aktif)
              </label>
              <PilihCari
                id="pelatihan-tambah-peserta"
                value={tambah}
                onChange={(e) => setTambah(e.target.value)}
                className={KELAS}
              >
                <option value="">Pilih karyawan</option>
                {calon.map((k) => (
                  <option key={String(k.id_unik)} value={String(k.id_unik)}>
                    {String(k.nama)} • {String(k.divisi || "-")}
                  </option>
                ))}
              </PilihCari>
            </div>
            <button
              id="pelatihan-tambah"
              type="button"
              className={TOMBOL}
              disabled={sibuk || !tambah}
              onClick={() =>
                void aksiPeserta(
                  { aksi: "tambah", id_karyawan: [tambah] },
                  "Peserta ditambahkan.",
                ).then(() => setTambah(""))
              }
            >
              Tambah
            </button>
          </div>
        ) : null}
        <ul className="space-y-2">
          {peserta.map((p) => (
            <li
              key={p.id_peserta}
              className="space-y-2 rounded-xl border border-slate-800 p-3"
            >
              <div className="flex flex-wrap items-end justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-semibold text-white">
                    {p.nama ?? p.id_karyawan}
                  </p>
                  <p className="text-xs text-slate-400">
                    {p.divisi ?? "-"} • {p.jabatan_status ?? "-"}
                    {p.status_aktif !== "Aktif" ? " • Nonaktif" : ""}
                  </p>
                </div>
                <div className="flex flex-wrap items-end gap-2">
                  <div>
                    <label
                      htmlFor={`peserta-hasil-${p.id_karyawan}`}
                      className={LABEL}
                    >
                      Hasil
                    </label>
                    <select
                      id={`peserta-hasil-${p.id_karyawan}`}
                      value={p.hasil ?? ""}
                      disabled={!ubahBoleh || sibuk}
                      onChange={(e) =>
                        void aksiPeserta(
                          {
                            aksi: "hasil",
                            id_karyawan: p.id_karyawan,
                            hasil: e.target.value || null,
                            catatan: p.catatan,
                          },
                          "Hasil tersimpan.",
                        )
                      }
                      className={KELAS}
                    >
                      <option value="">Belum diisi</option>
                      {HASIL_PESERTA.map((h) => (
                        <option key={h} value={h}>
                          {h}
                        </option>
                      ))}
                    </select>
                  </div>
                  {ubahBoleh && !p.id_dokumen ? (
                    <button
                      type="button"
                      className={TOMBOL_KEDUA}
                      disabled={sibuk}
                      onClick={() =>
                        void aksiPeserta(
                          { aksi: "lepas", id_karyawan: p.id_karyawan },
                          "Peserta dilepas.",
                        )
                      }
                    >
                      Lepas
                    </button>
                  ) : null}
                </div>
              </div>
              <Sertifikat
                peserta={p}
                idPelatihan={idPelatihan}
                namaPelatihan={data.nama}
                bolehUbah={ubahBoleh}
                sertifikatAktif={sertifikatAktif}
                terbuka={formSertifikat === p.id_karyawan}
                onBuka={(buka) =>
                  setFormSertifikat(buka ? p.id_karyawan : null)
                }
                onBerubah={() => {
                  setFormSertifikat(null);
                  muat();
                  onBerubah();
                }}
                setPesan={setPesan}
              />
            </li>
          ))}
          {peserta.length === 0 ? (
            <li className="text-sm text-slate-400">Belum ada peserta.</li>
          ) : null}
        </ul>
      </section>

      {ubahBoleh ? (
        <section className="flex flex-wrap items-end gap-2">
          <div className="min-w-0 flex-1">
            <label htmlFor="pelatihan-alasan-batal" className={LABEL}>
              Alasan membatalkan pelatihan
            </label>
            <input
              id="pelatihan-alasan-batal"
              value={alasanBatal}
              maxLength={2000}
              onChange={(e) => setAlasanBatal(e.target.value)}
              className={KELAS}
            />
          </div>
          <button
            id="pelatihan-batal"
            type="button"
            className={TOMBOL_KEDUA}
            disabled={sibuk || !alasanBatal.trim()}
            onClick={() => void batal()}
          >
            Batalkan pelatihan
          </button>
        </section>
      ) : null}
    </div>
  );
}

function Sertifikat({
  peserta,
  idPelatihan,
  namaPelatihan,
  bolehUbah,
  sertifikatAktif,
  terbuka,
  onBuka,
  onBerubah,
  setPesan,
}: {
  peserta: Peserta;
  idPelatihan: string;
  namaPelatihan: string;
  bolehUbah: boolean;
  sertifikatAktif: boolean;
  terbuka: boolean;
  onBuka: (buka: boolean) => void;
  onBerubah: () => void;
  setPesan: (pesan: string) => void;
}) {
  const [isi, setIsi] = useState<Isian>({
    nomor: peserta.nomor ?? "",
    tanggal_terbit: peserta.tanggal_terbit ?? "",
    tanggal_kedaluwarsa: peserta.tanggal_kedaluwarsa ?? "",
    catatan: peserta.catatan_sertifikat ?? namaPelatihan,
  });
  const [berkas, setBerkas] = useState<File[]>([]);
  const { sibuk, jalankan } = useKirim(setPesan);
  const dasar = { id_pelatihan: idPelatihan, id_karyawan: peserta.id_karyawan };
  const sisaSlot = MAKS_BERKAS_PER_DOKUMEN - peserta.berkas.length;

  const simpan = async () => {
    if (berkas.some((f) => !mimeBerkasSah(f))) {
      setPesan(PESAN_MIME_BERKAS);
      return;
    }
    const lanjut = await konfirmasiData([
      { label: "Peserta", nilai: peserta.nama },
      { label: "Nomor", nilai: isi.nomor },
      { label: "Terbit", nilai: isi.tanggal_terbit },
      {
        label: "Kedaluwarsa",
        nilai: isi.tanggal_kedaluwarsa || "Tanpa kedaluwarsa",
      },
      { label: "Berkas baru", nilai: berkas.map((f) => f.name).join(", ") },
    ]);
    if (!lanjut) return;
    const ok = await jalankan(async () => {
      await simpanSertifikat({
        ...dasar,
        ...Object.fromEntries(
          Object.entries(isi).map(([k, v]) => [k, v.trim() || null]),
        ),
        berkas: await Promise.all(berkas.map(siapkanBerkas)),
      });
      return "Sertifikat tersimpan dan tampil di tab Dokumen karyawan.";
    }, "Sertifikat gagal disimpan.");
    if (ok) {
      setBerkas([]);
      onBerubah();
    }
  };

  const hapus = (aksi: "hapus" | "hapus_berkas", idBerkas?: string) =>
    jalankan(async () => {
      await simpanSertifikat({ ...dasar, aksi, id_berkas: idBerkas });
      onBerubah();
      return aksi === "hapus" ? "Sertifikat dihapus." : "Berkas dihapus.";
    }, "Sertifikat gagal diubah.");

  return (
    <div className="space-y-2 text-xs">
      {peserta.id_dokumen ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-slate-300">
            Sertifikat {peserta.nomor ?? ""} •{" "}
            {peserta.tanggal_kedaluwarsa
              ? `berlaku sampai ${peserta.tanggal_kedaluwarsa}`
              : "tanpa kedaluwarsa"}
          </span>
          {peserta.berkas.map((b) => (
            <span key={b.id_berkas} className="flex items-center gap-1">
              <button
                type="button"
                className={TOMBOL_KEDUA}
                onClick={() =>
                  ambilBerkasSertifikat(b.id_berkas)
                    .then(bukaBerkas)
                    .then((pesanBuka) => {
                      if (pesanBuka) setPesan(pesanBuka);
                    })
                    .catch((error: unknown) =>
                      setPesan(pesanGalat(error, "Berkas gagal dibuka.")),
                    )
                }
              >
                {b.nama_berkas ?? `Berkas ${b.urutan}`}
              </button>
              {bolehUbah ? (
                <button
                  type="button"
                  aria-label={`Hapus ${b.nama_berkas ?? `berkas ${b.urutan}`}`}
                  className={TOMBOL_KEDUA}
                  disabled={sibuk}
                  onClick={() => void hapus("hapus_berkas", b.id_berkas)}
                >
                  Hapus
                </button>
              ) : null}
            </span>
          ))}
          {bolehUbah ? (
            <>
              <button
                type="button"
                className={TOMBOL_KEDUA}
                onClick={() => onBuka(!terbuka)}
              >
                Ubah sertifikat
              </button>
              <button
                type="button"
                className={TOMBOL_KEDUA}
                disabled={sibuk}
                onClick={() => void hapus("hapus")}
              >
                Hapus sertifikat
              </button>
            </>
          ) : null}
        </div>
      ) : bolehUbah ? (
        sertifikatAktif ? (
          <button
            type="button"
            className={TOMBOL_KEDUA}
            onClick={() => onBuka(!terbuka)}
          >
            Tambah sertifikat
          </button>
        ) : (
          <p className="text-amber-200">{PESAN_SERTIFIKAT_NONAKTIF}</p>
        )
      ) : null}
      {terbuka && bolehUbah ? (
        <div className="grid gap-2 rounded-xl border border-slate-800 p-3 sm:grid-cols-2">
          {(
            [
              ["nomor", "Nomor sertifikat", "text"],
              ["tanggal_terbit", "Tanggal terbit", "date"],
              ["tanggal_kedaluwarsa", "Berlaku sampai (boleh kosong)", "date"],
              ["catatan", "Catatan", "text"],
            ] as const
          ).map(([kunci, label, jenis]) => (
            <div key={kunci}>
              <label
                htmlFor={`sertifikat-${peserta.id_karyawan}-${kunci}`}
                className={LABEL}
              >
                {label}
              </label>
              <input
                id={`sertifikat-${peserta.id_karyawan}-${kunci}`}
                type={jenis}
                value={isi[kunci] ?? ""}
                onChange={(e) =>
                  setIsi((lama) => ({ ...lama, [kunci]: e.target.value }))
                }
                className={KELAS}
              />
            </div>
          ))}
          {sisaSlot > 0 ? (
            <div className="sm:col-span-2">
              <label
                htmlFor={`sertifikat-${peserta.id_karyawan}-berkas`}
                className={LABEL}
              >
                Berkas (maks {sisaSlot} lagi, JPEG/PNG/WEBP/PDF, 1 MB per
                berkas)
              </label>
              <input
                id={`sertifikat-${peserta.id_karyawan}-berkas`}
                type="file"
                multiple
                accept="image/jpeg,image/png,image/webp,application/pdf"
                onChange={(e) =>
                  setBerkas(Array.from(e.target.files ?? []).slice(0, sisaSlot))
                }
                className="text-xs text-slate-300"
              />
            </div>
          ) : null}
          <div className="flex flex-wrap gap-2 sm:col-span-2">
            <button
              type="button"
              className={TOMBOL}
              disabled={sibuk}
              onClick={() => void simpan()}
            >
              Simpan sertifikat
            </button>
            <button
              type="button"
              className={TOMBOL_KEDUA}
              onClick={() => onBuka(false)}
            >
              Batal
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** Tab Pelatihan di rincian karyawan: pelatihan yang tidak dibatalkan. */
export function RiwayatPelatihanKaryawan({
  idKaryawan,
}: {
  idKaryawan: string;
}) {
  const [riwayat, setRiwayat] = useState<RiwayatPelatihan[] | null>(null);
  const [pesan, setPesan] = useState("");
  useEffect(() => {
    ambilRiwayatPelatihan(idKaryawan)
      .then((d) => setRiwayat(d.riwayat))
      .catch((error: unknown) =>
        setPesan(pesanGalat(error, "Riwayat pelatihan gagal dimuat.")),
      );
  }, [idKaryawan]);
  if (pesan) return <p className="text-sm text-amber-200">{pesan}</p>;
  if (!riwayat)
    return <p className="text-sm text-slate-400">Memuat pelatihan...</p>;
  if (riwayat.length === 0)
    return <p className="text-sm text-slate-400">Belum ada pelatihan.</p>;
  return (
    <ul className="space-y-2">
      {riwayat.map((r) => (
        <li
          key={r.id_pelatihan}
          className="rounded-xl border border-slate-800 p-3 text-sm"
        >
          <p className="font-semibold text-white">{r.nama}</p>
          <p className="text-xs text-slate-400">
            <span className={WARNA_STATUS[r.status] ?? ""}>{r.status}</span> •{" "}
            {r.tanggal_mulai}
            {r.tanggal_selesai !== r.tanggal_mulai
              ? ` s.d. ${r.tanggal_selesai}`
              : ""}
            {r.penyelenggara ? ` • ${r.penyelenggara}` : ""} • hasil{" "}
            {r.hasil ?? "belum diisi"}
          </p>
          {r.id_dokumen ? (
            <p className="text-xs text-slate-300">
              Sertifikat {r.nomor ?? ""} •{" "}
              {r.tanggal_kedaluwarsa
                ? `berlaku sampai ${r.tanggal_kedaluwarsa}`
                : "tanpa kedaluwarsa"}
            </p>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
