"use client";

import { type FormEvent, useRef, useState } from "react";
import {
  hariIniWib,
  INPUT,
  LABEL,
  pesanGalat,
  TOMBOL_KEDUA,
  TOMBOL_UTAMA,
} from "@/components/inventory/gaya";
import { konfirmasiData } from "@/components/ui/KonfirmasiData";
import { Modal } from "@/components/ui/Modal";
import { PilihCari } from "@/components/ui/PilihCari";
import {
  type MasterPerjalanan,
  type RincianPerjalanan,
  simpanSuratJalan,
} from "@/lib/gateways/driver";
import { formatRupiah } from "@/lib/validations/accounting";
import {
  perjalananDraftSchema,
  upahSuratJalan,
  validatePerjalanan,
} from "@/lib/validations/driver";
import { bacaBerat, beratKg } from "./tampilan";

interface BarisIsian {
  tempat_muat: string;
  tempat_bongkar: string;
  nama_barang: string;
  jenis_barang: string;
  qty: string;
  satuan: string;
  berat: string;
}

const BARIS_KOSONG: BarisIsian = {
  tempat_muat: "",
  tempat_bongkar: "",
  nama_barang: "",
  jenis_barang: "",
  qty: "",
  satuan: "",
  berat: "",
};

const GALAT_KOTAK =
  "p-3 rounded-lg border border-rose-500/30 bg-rose-500/20 text-sm text-rose-100";

export function FormSuratJalan({
  master,
  awal,
  onClose,
  onTersimpan,
}: {
  master: MasterPerjalanan;
  /** Surat jalan yang disunting (hanya selama Direncanakan); kosong = baru. */
  awal: RincianPerjalanan | null;
  onClose: () => void;
  onTersimpan: (pesan: string) => void;
}) {
  const [tanggal, setTanggal] = useState(awal?.item.tanggal ?? hariIniWib());
  const [driver, setDriver] = useState(awal?.item.id_karyawan_awal ?? "");
  const [kendaraan, setKendaraan] = useState(
    awal?.item.id_kendaraan_awal ?? "",
  );
  const [kategori, setKategori] = useState(awal?.item.id_kategori ?? "");
  const [catatan, setCatatan] = useState(awal?.item.catatan ?? "");
  const [baris, setBaris] = useState<BarisIsian[]>(
    awal?.muatan.length
      ? awal.muatan.map((m) => ({
          tempat_muat: m.tempat_muat,
          tempat_bongkar: m.tempat_bongkar ?? "",
          nama_barang: m.nama_barang,
          jenis_barang: m.jenis_barang ?? "",
          qty: String(m.qty),
          satuan: m.satuan,
          berat:
            m.berat_kg_x100 == null
              ? ""
              : beratKg(m.berat_kg_x100).replace(" kg", ""),
        }))
      : [{ ...BARIS_KOSONG }],
  );
  const [galat, setGalat] = useState<string | null>(null);
  const [menyimpan, setMenyimpan] = useState(false);
  const isSubmittingRef = useRef(false);

  const kendaraanAktif = master.kendaraan.filter(
    (k) => k.status_aktif === 1 || k.id_kendaraan === kendaraan,
  );
  const kategoriAktif = master.kategori.filter(
    (k) => k.status_aktif === 1 || k.id_kategori === kategori,
  );
  const jenisTerpilih = master.jenis.find(
    (j) =>
      j.id_jenis ===
      master.kendaraan.find((k) => k.id_kendaraan === kendaraan)?.id_jenis,
  );
  // Tempat muatan dipilih dari lokasi terdaftar supaya ejaannya sama dengan
  // `nama_lokasi` laporan Tiba: layar driver mencentang barang dengan
  // mencocokkan keduanya. Nilai lama di luar daftar tetap bisa dipertahankan.
  const namaLokasi = (jenis: "Muat" | "Bongkar") => [
    ...new Set(
      master.lokasi
        .filter((l) => l.jenis === jenis && l.status_aktif === 1)
        .map((l) => l.nama),
    ),
  ];
  const lokasiMuat = namaLokasi("Muat");
  const lokasiBongkar = namaLokasi("Bongkar");
  const kategoriTerpilih = master.kategori.find(
    (k) => k.id_kategori === kategori,
  );
  // Surat jalan lama mempertahankan tarif yang dikunci saat dibuat.
  const perkiraanUpah =
    awal &&
    awal.item.id_jenis === jenisTerpilih?.id_jenis &&
    awal.item.id_kategori === kategori
      ? awal.item.upah
      : upahSuratJalan(jenisTerpilih?.tarif ?? 0, kategoriTerpilih?.tarif ?? 0);

  function ubahBaris(indeks: number, kunci: keyof BarisIsian, nilai: string) {
    setBaris((lama) =>
      lama.map((b, i) => (i === indeks ? { ...b, [kunci]: nilai } : b)),
    );
  }

  async function kirim(event: FormEvent) {
    event.preventDefault();
    if (isSubmittingRef.current) return;
    setGalat(null);
    const beratGalat = baris.findIndex((b) => Number.isNaN(bacaBerat(b.berat)));
    if (beratGalat >= 0) {
      setGalat(
        `Baris ${beratGalat + 1}: berat ditulis seperti 1.250,5 (kg, paling banyak 2 desimal).`,
      );
      return;
    }
    const draft = perjalananDraftSchema.parse({
      id_perjalanan: awal?.item.id_perjalanan ?? null,
      tanggal,
      id_karyawan: driver,
      id_kendaraan: kendaraan,
      id_kategori: kategori,
      catatan: catatan || null,
      muatan: baris.map((b) => ({
        tempat_muat: b.tempat_muat,
        tempat_bongkar: b.tempat_bongkar || null,
        nama_barang: b.nama_barang,
        jenis_barang: b.jenis_barang || null,
        qty: Number(b.qty.replace(/\D/g, "") || 0),
        satuan: b.satuan,
        berat_kg_x100: bacaBerat(b.berat),
      })),
    });
    const lokal = validatePerjalanan(draft);
    if (!lokal.ok) {
      setGalat(lokal.error);
      return;
    }
    const nama = master.personil.find((p) => p.id_unik === driver)?.nama;
    const plat = master.kendaraan.find(
      (k) => k.id_kendaraan === kendaraan,
    )?.identitas;
    const setuju = await konfirmasiData([
      { label: "Tanggal", nilai: tanggal },
      { label: "Driver", nilai: nama ?? driver },
      {
        label: "Kendaraan",
        nilai: [jenisTerpilih?.nama, plat].filter(Boolean).join(" · "),
      },
      { label: "Tujuan", nilai: kategoriTerpilih?.nama },
      { label: "Barang muatan", nilai: `${lokal.value.muatan.length} baris` },
      { label: "Upah surat jalan", nilai: formatRupiah(perkiraanUpah) },
      {
        label: "Perlu dicetak ulang",
        nilai: awal?.item.dicetak_pada ? "Ya, surat jalan diubah" : null,
        peringatan: true,
      },
    ]);
    if (!setuju) return;
    isSubmittingRef.current = true;
    setMenyimpan(true);
    try {
      await simpanSuratJalan(draft);
      onTersimpan(awal ? "Surat jalan diperbarui." : "Surat jalan dibuat.");
    } catch (error) {
      setGalat(pesanGalat(error, "Surat jalan tidak bisa disimpan."));
    } finally {
      isSubmittingRef.current = false;
      setMenyimpan(false);
    }
  }

  return (
    <Modal
      isOpen
      title={awal ? `Ubah ${awal.item.nomor}` : "Buat surat jalan"}
      subtitle="Nomor dibuat otomatis. Tarif dikunci dari daftar saat surat jalan dibuat."
      onClose={onClose}
      maxWidth="max-w-4xl"
    >
      <form id="form-surat-jalan" onSubmit={kirim} className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className={LABEL} htmlFor="sj-tanggal">
              Tanggal
            </label>
            <input
              id="sj-tanggal"
              type="date"
              className={INPUT}
              value={tanggal}
              onChange={(e) => setTanggal(e.target.value)}
              required
            />
          </div>
          <div>
            <label className={LABEL} htmlFor="sj-driver">
              Driver
            </label>
            <PilihCari
              id="sj-driver"
              className={INPUT}
              value={driver}
              onChange={(e) => setDriver(e.target.value)}
            >
              <option value="">Pilih driver</option>
              {master.personil.map((p) => (
                <option key={p.id_unik} value={p.id_unik}>
                  {p.nama} · {p.divisi}
                </option>
              ))}
            </PilihCari>
          </div>
          <div>
            <label className={LABEL} htmlFor="sj-kendaraan">
              Kendaraan
            </label>
            <PilihCari
              id="sj-kendaraan"
              className={INPUT}
              value={kendaraan}
              onChange={(e) => setKendaraan(e.target.value)}
            >
              <option value="">Pilih kendaraan</option>
              {kendaraanAktif.map((k) => (
                <option key={k.id_kendaraan} value={k.id_kendaraan}>
                  {k.identitas}
                  {k.nama ? ` · ${k.nama}` : ""}
                </option>
              ))}
            </PilihCari>
          </div>
          <div>
            <label className={LABEL} htmlFor="sj-kategori">
              Kategori tujuan
            </label>
            <PilihCari
              id="sj-kategori"
              className={INPUT}
              value={kategori}
              onChange={(e) => setKategori(e.target.value)}
            >
              <option value="">Pilih kategori tujuan</option>
              {kategoriAktif.map((k) => (
                <option key={k.id_kategori} value={k.id_kategori}>
                  {k.nama} · {formatRupiah(k.tarif)}
                </option>
              ))}
            </PilihCari>
          </div>
          <div className="sm:col-span-2">
            <label className={LABEL} htmlFor="sj-catatan">
              Catatan (opsional)
            </label>
            <input
              id="sj-catatan"
              className={INPUT}
              value={catatan}
              maxLength={500}
              onChange={(e) => setCatatan(e.target.value)}
            />
          </div>
        </div>

        <p className="text-sm text-slate-300" id="sj-perkiraan-upah">
          Upah surat jalan: <strong>{formatRupiah(perkiraanUpah)}</strong>
          {jenisTerpilih ? ` (${jenisTerpilih.nama}` : ""}
          {jenisTerpilih && kategoriTerpilih
            ? ` + ${kategoriTerpilih.nama})`
            : jenisTerpilih
              ? ")"
              : ""}
        </p>

        <fieldset className="space-y-3">
          <legend className="text-sm font-semibold text-slate-100">
            Muatan
          </legend>
          {lokasiMuat.length === 0 || lokasiBongkar.length === 0 ? (
            <p
              id="muatan-lokasi-kosong"
              className="rounded-lg border border-amber-300/25 bg-amber-300/10 p-3 text-sm text-amber-100"
            >
              Tempat muat dan bongkar dipilih dari lokasi terdaftar. Belum ada
              lokasi aktif berjenis{" "}
              {lokasiMuat.length === 0 && lokasiBongkar.length === 0
                ? "Muat maupun Bongkar"
                : lokasiMuat.length === 0
                  ? "Muat"
                  : "Bongkar"}
              ; tambahkan di tab Armada &amp; lokasi.
            </p>
          ) : null}
          {baris.map((b, i) => (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: baris isian tanpa id sampai disimpan
              key={i}
              className="grid gap-2 rounded-lg border border-white/10 p-3 sm:grid-cols-4"
            >
              {(
                [
                  ["tempat_muat", "Tempat muat", lokasiMuat],
                  ["tempat_bongkar", "Tempat bongkar", lokasiBongkar],
                ] as const
              ).map(([kunci, label, pilihan]) => (
                <div key={kunci}>
                  <label className={LABEL} htmlFor={`muatan-${i}-${kunci}`}>
                    {label}
                  </label>
                  <PilihCari
                    id={`muatan-${i}-${kunci}`}
                    className={INPUT}
                    value={b[kunci]}
                    onChange={(e) => ubahBaris(i, kunci, e.target.value)}
                  >
                    <option value="">
                      {kunci === "tempat_muat"
                        ? "Pilih tempat muat"
                        : "Belum ditentukan"}
                    </option>
                    {pilihan.map((nama) => (
                      <option key={nama} value={nama}>
                        {nama}
                      </option>
                    ))}
                    {b[kunci] && !pilihan.includes(b[kunci]) ? (
                      <option value={b[kunci]}>
                        {b[kunci]} (tidak terdaftar)
                      </option>
                    ) : null}
                  </PilihCari>
                </div>
              ))}
              {(
                [
                  ["nama_barang", "Nama barang", 120],
                  ["jenis_barang", "Jenis barang", 60],
                  ["qty", "Jumlah", 12],
                  ["satuan", "Satuan (dus, karung, ...)", 20],
                  ["berat", "Berat kg (opsional)", 16],
                ] as const
              ).map(([kunci, label, maks]) => (
                <div key={kunci}>
                  <label className={LABEL} htmlFor={`muatan-${i}-${kunci}`}>
                    {label}
                  </label>
                  <input
                    id={`muatan-${i}-${kunci}`}
                    className={INPUT}
                    value={b[kunci]}
                    maxLength={maks}
                    inputMode={
                      kunci === "qty"
                        ? "numeric"
                        : kunci === "berat"
                          ? "decimal"
                          : undefined
                    }
                    onChange={(e) => ubahBaris(i, kunci, e.target.value)}
                  />
                </div>
              ))}
              <div className="flex items-end">
                <button
                  type="button"
                  id={`muatan-${i}-hapus`}
                  className={TOMBOL_KEDUA}
                  disabled={baris.length === 1}
                  onClick={() =>
                    setBaris((lama) => lama.filter((_, j) => j !== i))
                  }
                >
                  Hapus baris
                </button>
              </div>
            </div>
          ))}
          <button
            type="button"
            id="muatan-tambah"
            className={TOMBOL_KEDUA}
            disabled={baris.length >= 100}
            onClick={() =>
              setBaris((lama) => [
                ...lama,
                // Tempat muat baris sebelumnya ikut, karena biasanya sama.
                {
                  ...BARIS_KOSONG,
                  tempat_muat: lama.at(-1)?.tempat_muat ?? "",
                },
              ])
            }
          >
            Tambah barang
          </button>
        </fieldset>

        {galat ? (
          <div className={GALAT_KOTAK} role="alert">
            {galat}
          </div>
        ) : null}

        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" className={TOMBOL_KEDUA} onClick={onClose}>
            Batal
          </button>
          <button
            type="submit"
            id="sj-simpan"
            className={TOMBOL_UTAMA}
            disabled={menyimpan}
          >
            {menyimpan ? "Menyimpan..." : "Simpan surat jalan"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
