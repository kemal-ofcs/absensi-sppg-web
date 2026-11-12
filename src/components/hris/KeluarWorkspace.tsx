"use client";

// Tab Keluar di /hris (PRD HRIS §20.4, §20.5, Web/Desktop). Khusus cloud:
// butuh koneksi ke database. Usulan pesangon dan checklist dihitung backend;
// layar hanya menampilkan dan mengirim isian. Backend memeriksa ulang izin.

import { useCallback, useEffect, useMemo, useState } from "react";
import { DaftarRincian } from "@/components/hris/DaftarRincian";
import type { BarisKaryawan } from "@/components/hris/HrisWorkspace";
import { konfirmasiData } from "@/components/ui/KonfirmasiData";
import { PilihCari } from "@/components/ui/PilihCari";
import {
  type AlasanKeluar,
  ambilDaftarKeluar,
  ambilPratinjauKeluar,
  ambilRincianKeluar,
  batalkanKeluar,
  berlakukanKeluar,
  type DaftarKeluar,
  type PratinjauKeluar,
  type RincianKeluar,
  simpanAlasanKeluar,
  simpanKeluar,
} from "@/lib/gateways/hr-keluar";
import { formatRupiah } from "@/lib/validations/accounting";

const KELAS =
  "min-h-10 w-full rounded-xl border border-slate-800 bg-slate-950 px-3 text-white outline-none focus:border-sky-500";
const LABEL = "mb-1 block text-xs font-semibold text-slate-400";
const TOMBOL =
  "min-h-10 rounded-xl bg-sky-500 px-4 text-sm font-bold text-white disabled:opacity-50";
const TOMBOL_KEDUA =
  "min-h-9 rounded-xl border border-slate-700 px-3 text-xs font-bold text-slate-200 disabled:opacity-50";

const pesanGalat = (error: unknown, cadangan: string) =>
  error instanceof Error ? error.message : cadangan;
/** Teks isian rupiah → angka bulat; kosong = null. */
const bacaRupiah = (teks: string): number | null => {
  const digit = teks.replace(/\D/g, "");
  return digit === "" ? null : Number(digit);
};
const tampilRupiah = (n: number | null) =>
  n === null ? "" : n.toLocaleString("id-ID");

const WARNA_STATUS: Record<string, string> = {
  Dijadwalkan: "text-sky-200",
  "Jatuh tempo": "text-amber-200",
  Berlaku: "text-emerald-200",
  Dibatalkan: "text-slate-400",
};

interface Draf {
  id_keluar: string | null;
  id_karyawan: string;
  id_alasan: string;
  id_sp: string | null;
  tanggal_pemberitahuan: string;
  tanggal_terakhir: string;
  keterangan: string;
  upah_pokok: number | null;
  alasan_upah: string;
  tunjangan_tetap: number | null;
  kartu_ditarik: boolean;
  catatan_checklist: string;
  rincian: Record<string, { nominal: number | null; alasan_ubah: string }>;
}

const drafKosong = (idKaryawan = "", idSp: string | null = null): Draf => ({
  id_keluar: null,
  id_karyawan: idKaryawan,
  id_alasan: idSp ? "klr-pelanggaran" : "",
  id_sp: idSp,
  tanggal_pemberitahuan: "",
  tanggal_terakhir: "",
  keterangan: "",
  upah_pokok: null,
  alasan_upah: "",
  tunjangan_tetap: null,
  kartu_ditarik: false,
  catatan_checklist: "",
  rincian: {},
});

function drafDari(r: RincianKeluar): Draf {
  const k = r.keluar;
  return {
    id_keluar: k.id_keluar,
    id_karyawan: k.id_karyawan,
    id_alasan: k.id_alasan,
    id_sp: k.id_sp,
    tanggal_pemberitahuan: k.tanggal_pemberitahuan ?? "",
    tanggal_terakhir: k.tanggal_terakhir,
    keterangan: k.keterangan ?? "",
    upah_pokok: k.upah_pokok,
    alasan_upah: k.alasan_upah ?? "",
    tunjangan_tetap: k.tunjangan_tetap,
    kartu_ditarik: k.kartu_ditarik === 1,
    catatan_checklist: k.catatan_checklist ?? "",
    rincian: Object.fromEntries(
      r.rincian.map((b) => [
        b.komponen,
        { nominal: b.nominal, alasan_ubah: b.alasan_ubah ?? "" },
      ]),
    ),
  };
}

export function KeluarWorkspace({
  karyawan,
  bolehUbah,
  mulai,
  onBerubah,
}: {
  karyawan: BarisKaryawan[];
  bolehUbah: boolean;
  /** Dibuka dari tab SP: karyawan dan SP3 yang mendasari. */
  mulai: { idKaryawan: string; idSp: string | null } | null;
  onBerubah: () => void;
}) {
  const [daftar, setDaftar] = useState<DaftarKeluar | null>(null);
  const [dipilih, setDipilih] = useState<string | null>(null);
  const [rincian, setRincian] = useState<RincianKeluar | null>(null);
  const [draf, setDraf] = useState<Draf | null>(
    mulai ? drafKosong(mulai.idKaryawan, mulai.idSp) : null,
  );
  const [pratinjau, setPratinjau] = useState<PratinjauKeluar | null>(null);
  const [alasanBatal, setAlasanBatal] = useState("");
  const [pesan, setPesan] = useState("");
  const [sibuk, setSibuk] = useState(false);

  const muatDaftar = useCallback(() => {
    ambilDaftarKeluar()
      .then(setDaftar)
      .catch((error: unknown) =>
        setPesan(pesanGalat(error, "Daftar karyawan keluar gagal dimuat.")),
      );
  }, []);
  useEffect(muatDaftar, [muatDaftar]);

  const muatRincian = useCallback((id: string) => {
    ambilRincianKeluar(id)
      .then(setRincian)
      .catch((error: unknown) =>
        setPesan(pesanGalat(error, "Rincian gagal dimuat.")),
      );
  }, []);
  useEffect(() => {
    setRincian(null);
    if (dipilih) muatRincian(dipilih);
  }, [dipilih, muatRincian]);

  // Pratinjau usulan saat karyawan, alasan, atau tanggal di draf berubah.
  const pKaryawan = draf?.id_karyawan ?? "";
  const pAlasan = draf?.id_alasan ?? "";
  const pTanggal = draf?.tanggal_terakhir ?? "";
  useEffect(() => {
    if (!pKaryawan || !pAlasan || !pTanggal) {
      setPratinjau(null);
      return;
    }
    let batal = false;
    ambilPratinjauKeluar(pKaryawan, pAlasan, pTanggal)
      .then((p) => {
        if (!batal) setPratinjau(p);
      })
      .catch((error: unknown) => {
        if (!batal) setPesan(pesanGalat(error, "Usulan gagal dihitung."));
      });
    return () => {
      batal = true;
    };
  }, [pKaryawan, pAlasan, pTanggal]);

  const alasanAktif = (daftar?.alasan ?? []).filter(
    (a) => a.is_aktif === 1 || a.id_alasan === draf?.id_alasan,
  );
  const aktif = karyawan.filter((k) => k.status_aktif !== "Nonaktif");

  const usulanUpah = pratinjau?.data.usulan_upah_pokok ?? 0;
  const upahPokok = draf?.upah_pokok ?? usulanUpah;

  const simpan = async () => {
    if (!draf) return;
    const rincianIsian = Object.entries(draf.rincian)
      .filter(([, v]) => v.nominal !== null)
      .map(([komponen, v]) => ({
        komponen,
        nominal: v.nominal,
        alasan_ubah: v.alasan_ubah,
      }));
    const lanjut = await konfirmasiData([
      {
        label: "Karyawan",
        nilai: String(
          karyawan.find((k) => k.id_unik === draf.id_karyawan)?.nama ?? "",
        ),
      },
      {
        label: "Alasan",
        nilai:
          daftar?.alasan.find((a) => a.id_alasan === draf.id_alasan)?.nama ??
          "",
      },
      { label: "Hari kerja terakhir", nilai: draf.tanggal_terakhir },
      { label: "Upah pokok", nilai: formatRupiah(upahPokok) },
      {
        label: "Tunjangan tetap",
        nilai: formatRupiah(draf.tunjangan_tetap ?? 0),
      },
    ]);
    if (!lanjut) return;
    setSibuk(true);
    try {
      const hasil = await simpanKeluar({
        ...draf,
        upah_pokok: draf.upah_pokok,
        tunjangan_tetap: draf.tunjangan_tetap ?? 0,
        rincian: rincianIsian,
      });
      setDraf(null);
      setPesan("Proses keluar tersimpan.");
      muatDaftar();
      setDipilih(hasil.id_keluar);
      muatRincian(hasil.id_keluar);
    } catch (error) {
      setPesan(pesanGalat(error, "Proses keluar gagal disimpan."));
    } finally {
      setSibuk(false);
    }
  };

  const berlakukan = async () => {
    if (!rincian) return;
    const k = rincian.keluar;
    const lanjut = await konfirmasiData([
      { label: "Karyawan", nilai: String(rincian.karyawan.nama) },
      { label: "Hari kerja terakhir", nilai: k.tanggal_terakhir },
      {
        label: "Sesudah ini",
        nilai:
          "Karyawan nonaktif (scan ditolak), akun operator tertaut dinonaktifkan, rincian pesangon terkunci.",
      },
    ]);
    if (!lanjut) return;
    setSibuk(true);
    try {
      await berlakukanKeluar(k.id_keluar);
      setPesan("Proses keluar berlaku.");
      muatDaftar();
      muatRincian(k.id_keluar);
      onBerubah();
    } catch (error) {
      setPesan(pesanGalat(error, "Proses keluar gagal diberlakukan."));
    } finally {
      setSibuk(false);
    }
  };

  const batalkan = async () => {
    if (!rincian) return;
    setSibuk(true);
    try {
      await batalkanKeluar({
        id_keluar: rincian.keluar.id_keluar,
        alasan: alasanBatal,
      });
      setAlasanBatal("");
      setPesan(
        "Proses keluar dibatalkan. Akun operator tidak diaktifkan otomatis.",
      );
      muatDaftar();
      muatRincian(rincian.keluar.id_keluar);
      onBerubah();
    } catch (error) {
      setPesan(pesanGalat(error, "Proses keluar gagal dibatalkan."));
    } finally {
      setSibuk(false);
    }
  };

  return (
    <div className="space-y-4">
      {pesan ? <p className="text-sm text-slate-300">{pesan}</p> : null}
      <DaftarRincian
        adaPilihan={Boolean(draf || dipilih)}
        onKembali={() => {
          setDraf(null);
          setDipilih(null);
        }}
        daftar={
          <div className="space-y-3 rounded-2xl border border-slate-800 bg-slate-900 p-3">
            {bolehUbah ? (
              <button
                id="hris-keluar-baru"
                type="button"
                className={TOMBOL}
                onClick={() => {
                  setDipilih(null);
                  setDraf(drafKosong());
                }}
              >
                Catat karyawan keluar
              </button>
            ) : null}
            {daftar && daftar.keluar.length === 0 ? (
              <p className="text-sm text-slate-400">Belum ada proses keluar.</p>
            ) : null}
            <ul className="max-h-[65vh] space-y-1 overflow-y-auto">
              {(daftar?.keluar ?? []).map((k) => (
                <li key={k.id_keluar}>
                  <button
                    type="button"
                    onClick={() => {
                      setDraf(null);
                      setDipilih(k.id_keluar);
                    }}
                    className={`w-full rounded-xl px-3 py-2 text-left ${dipilih === k.id_keluar ? "bg-sky-500/20" : "hover:bg-slate-800"}`}
                  >
                    <span className="block truncate font-semibold text-white">
                      {k.nama ?? k.id_karyawan}
                    </span>
                    <span className="block truncate text-xs text-slate-400">
                      {k.alasan_nama} • terakhir {k.tanggal_terakhir}
                    </span>
                    <span
                      className={`block text-xs font-bold ${WARNA_STATUS[k.status] ?? ""}`}
                    >
                      {k.status} • {formatRupiah(k.total)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        }
      >
        <div className="min-w-0 space-y-4">
          {draf ? (
            <FormKeluar
              draf={draf}
              setDraf={setDraf}
              karyawan={aktif}
              alasan={alasanAktif}
              pratinjau={pratinjau}
              rincianLama={rincian?.rincian ?? null}
              sibuk={sibuk}
              onSimpan={simpan}
              onBatal={() => setDraf(null)}
            />
          ) : rincian ? (
            <RincianPanel
              rincian={rincian}
              bolehUbah={bolehUbah}
              sibuk={sibuk}
              alasanBatal={alasanBatal}
              setAlasanBatal={setAlasanBatal}
              onUbah={() => setDraf(drafDari(rincian))}
              onBerlakukan={berlakukan}
              onBatalkan={batalkan}
            />
          ) : (
            <p className="rounded-2xl border border-slate-800 bg-slate-900 p-6 text-sm text-slate-400">
              Pilih proses keluar untuk melihat rinciannya.
            </p>
          )}
          {bolehUbah && daftar ? (
            <AlasanPanel alasan={daftar.alasan} onBerubah={muatDaftar} />
          ) : null}
        </div>
      </DaftarRincian>
    </div>
  );
}

function FormKeluar({
  draf,
  setDraf,
  karyawan,
  alasan,
  pratinjau,
  rincianLama,
  sibuk,
  onSimpan,
  onBatal,
}: {
  draf: Draf;
  setDraf: (d: Draf) => void;
  karyawan: BarisKaryawan[];
  alasan: AlasanKeluar[];
  pratinjau: PratinjauKeluar | null;
  rincianLama: RincianKeluar["rincian"] | null;
  sibuk: boolean;
  onSimpan: () => void;
  onBatal: () => void;
}) {
  const ubah = (sebagian: Partial<Draf>) => setDraf({ ...draf, ...sebagian });
  const usulanUpah = pratinjau?.data.usulan_upah_pokok ?? 0;
  const upahPokok = draf.upah_pokok ?? usulanUpah;
  // Usulan pratinjau memakai upah usulan; nominal baris tersimpan dipakai
  // sebagai bawaan isian bila komponennya masih berlaku.
  const lama = new Map((rincianLama ?? []).map((r) => [r.komponen, r]));
  return (
    <div className="space-y-3 rounded-2xl border border-slate-800 bg-slate-900 p-4">
      <h2 className="text-lg font-bold text-white">
        {draf.id_keluar ? "Ubah proses keluar" : "Catat karyawan keluar"}
      </h2>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="min-w-0 sm:col-span-2">
          <label htmlFor="hris-keluar-karyawan" className={LABEL}>
            Karyawan
          </label>
          <PilihCari
            id="hris-keluar-karyawan"
            value={draf.id_karyawan}
            disabled={Boolean(draf.id_keluar)}
            onChange={(e) => ubah({ id_karyawan: e.target.value })}
          >
            <option value="">Pilih karyawan</option>
            {karyawan.map((k) => (
              <option key={String(k.id_unik)} value={String(k.id_unik)}>
                {String(k.nama)} • {String(k.divisi || "-")}
              </option>
            ))}
          </PilihCari>
        </div>
        <div className="min-w-0">
          <label htmlFor="hris-keluar-alasan" className={LABEL}>
            Alasan
          </label>
          <select
            id="hris-keluar-alasan"
            value={draf.id_alasan}
            onChange={(e) => ubah({ id_alasan: e.target.value, rincian: {} })}
            className={KELAS}
          >
            <option value="">Pilih alasan</option>
            {alasan.map((a) => (
              <option key={a.id_alasan} value={a.id_alasan}>
                {a.nama}
              </option>
            ))}
          </select>
        </div>
        <div className="min-w-0">
          <label htmlFor="hris-keluar-terakhir" className={LABEL}>
            Hari kerja terakhir
          </label>
          <input
            id="hris-keluar-terakhir"
            type="date"
            value={draf.tanggal_terakhir}
            onChange={(e) => ubah({ tanggal_terakhir: e.target.value })}
            className={KELAS}
          />
        </div>
        <div className="min-w-0">
          <label htmlFor="hris-keluar-pemberitahuan" className={LABEL}>
            Tanggal pemberitahuan (opsional)
          </label>
          <input
            id="hris-keluar-pemberitahuan"
            type="date"
            value={draf.tanggal_pemberitahuan}
            onChange={(e) => ubah({ tanggal_pemberitahuan: e.target.value })}
            className={KELAS}
          />
        </div>
        <div className="min-w-0">
          <label htmlFor="hris-keluar-keterangan" className={LABEL}>
            Keterangan (opsional)
          </label>
          <input
            id="hris-keluar-keterangan"
            value={draf.keterangan}
            onChange={(e) => ubah({ keterangan: e.target.value })}
            className={KELAS}
          />
        </div>
        <div className="min-w-0">
          <label htmlFor="hris-keluar-upah" className={LABEL}>
            Upah pokok sebulan (usulan {formatRupiah(usulanUpah)})
          </label>
          <input
            id="hris-keluar-upah"
            inputMode="numeric"
            value={tampilRupiah(upahPokok)}
            onChange={(e) => ubah({ upah_pokok: bacaRupiah(e.target.value) })}
            className={KELAS}
          />
        </div>
        <div className="min-w-0">
          <label htmlFor="hris-keluar-tunjangan" className={LABEL}>
            Tunjangan tetap sebulan
          </label>
          <input
            id="hris-keluar-tunjangan"
            inputMode="numeric"
            value={tampilRupiah(draf.tunjangan_tetap)}
            onChange={(e) =>
              ubah({ tunjangan_tetap: bacaRupiah(e.target.value) })
            }
            className={KELAS}
          />
        </div>
        {upahPokok !== usulanUpah ? (
          <div className="min-w-0 sm:col-span-2">
            <label htmlFor="hris-keluar-alasan-upah" className={LABEL}>
              Alasan upah pokok berbeda dari usulan
            </label>
            <input
              id="hris-keluar-alasan-upah"
              value={draf.alasan_upah}
              onChange={(e) => ubah({ alasan_upah: e.target.value })}
              className={KELAS}
            />
          </div>
        ) : null}
        {pratinjau?.data.tunjangan_acuan.length ? (
          <p className="text-xs text-slate-400 sm:col-span-2">
            Acuan komponen tunjangan:{" "}
            {pratinjau.data.tunjangan_acuan
              .map(
                (t) =>
                  `${t.name} (${t.calc_type === "PERCENTAGE" ? `${t.default_value}%` : formatRupiah(Number(t.default_value))} per proses gaji)`,
              )
              .join(", ")}
          </p>
        ) : null}
      </div>

      {pratinjau ? (
        <div className="space-y-2">
          <h3 className="text-sm font-bold text-white">Rincian pesangon</h3>
          <p className="text-xs text-slate-400">
            Usulan dihitung ulang saat disimpan dari upah di atas. Nominal yang
            berbeda dari usulan wajib diberi alasan.
          </p>
          {pratinjau.usulan.map((u) => {
            const isi = draf.rincian[u.komponen];
            const nominal =
              isi?.nominal ?? lama.get(u.komponen)?.nominal ?? null;
            return (
              <div
                key={u.komponen}
                className="grid grid-cols-1 gap-2 rounded-xl border border-slate-800 p-2 sm:grid-cols-[minmax(0,12rem)_minmax(0,1fr)_minmax(0,1fr)]"
              >
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-white">
                    {u.komponen}
                  </p>
                  <p className="truncate text-xs text-slate-400">
                    {u.dasar ?? "Diisi HRD"}
                  </p>
                </div>
                <input
                  id={`hris-keluar-nominal-${u.komponen.replaceAll(" ", "-")}`}
                  aria-label={`Nominal ${u.komponen}`}
                  inputMode="numeric"
                  placeholder={`Usulan ${formatRupiah(u.usulan)}`}
                  value={tampilRupiah(nominal)}
                  onChange={(e) =>
                    ubah({
                      rincian: {
                        ...draf.rincian,
                        [u.komponen]: {
                          nominal: bacaRupiah(e.target.value),
                          alasan_ubah: isi?.alasan_ubah ?? "",
                        },
                      },
                    })
                  }
                  className={KELAS}
                />
                <input
                  aria-label={`Alasan perubahan ${u.komponen}`}
                  placeholder="Alasan bila berbeda"
                  value={
                    isi?.alasan_ubah ?? lama.get(u.komponen)?.alasan_ubah ?? ""
                  }
                  onChange={(e) =>
                    ubah({
                      rincian: {
                        ...draf.rincian,
                        [u.komponen]: {
                          nominal,
                          alasan_ubah: e.target.value,
                        },
                      },
                    })
                  }
                  className={KELAS}
                />
              </div>
            );
          })}
          <Checklist data={pratinjau} />
        </div>
      ) : null}

      <label className="flex items-center gap-2 text-sm text-slate-200">
        <input
          id="hris-keluar-kartu"
          type="checkbox"
          checked={draf.kartu_ditarik}
          onChange={(e) => ubah({ kartu_ditarik: e.target.checked })}
        />
        Kartu ID sudah ditarik
      </label>
      <div className="min-w-0">
        <label htmlFor="hris-keluar-catatan" className={LABEL}>
          Catatan checklist (opsional)
        </label>
        <input
          id="hris-keluar-catatan"
          value={draf.catatan_checklist}
          onChange={(e) => ubah({ catatan_checklist: e.target.value })}
          className={KELAS}
        />
      </div>
      <div className="flex flex-wrap gap-2">
        <button
          id="hris-keluar-simpan"
          type="button"
          className={TOMBOL}
          disabled={sibuk || !pratinjau}
          onClick={onSimpan}
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

function Checklist({ data }: { data: PratinjauKeluar }) {
  const c = data.checklist;
  const total = (
    "rincian" in data ? (data as RincianKeluar).rincian : []
  ).reduce((n, r) => n + r.nominal, 0);
  const butir: Array<[string, string, boolean]> = [
    [
      "Barang inventaris dipinjam",
      c.barang.length === 0
        ? "Tidak ada"
        : c.barang
            .map(
              (b) =>
                `${b.nama_barang} (${(b.jumlah - b.kembali) / (b.desimal === 1 ? 100 : 1)} ${b.satuan})`,
            )
            .join(", "),
      c.barang.length > 0,
    ],
    [
      "Sisa kasbon",
      c.sisa_kasbon > 0
        ? `${formatRupiah(c.sisa_kasbon)} (lunasi lewat Pelunasan Tunai kasbon)`
        : "Tidak ada",
      c.sisa_kasbon > 0,
    ],
    [
      "Reimburse dan cuti diuangkan belum dibayar",
      c.klaim.length === 0
        ? "Tidak ada"
        : c.klaim
            .map(
              (k) =>
                `${k.keterangan} ${formatRupiah(k.nominal)} (${k.status_bayar})`,
            )
            .join(", "),
      c.klaim.length > 0,
    ],
    [
      "Pengajuan sesudah hari terakhir",
      c.pengajuan.length === 0
        ? "Tidak ada"
        : c.pengajuan
            .map((p) => `${p.jenis} ${p.tanggal_mulai}–${p.tanggal_selesai}`)
            .join(", "),
      c.pengajuan.length > 0,
    ],
    [
      "Akun operator tertaut",
      data.akun.length === 0
        ? "Tidak ada"
        : data.akun.map((a) => `${a.username} (${a.status})`).join(", "),
      data.akun.some((a) => a.status === "Aktif"),
    ],
  ];
  return (
    <div className="space-y-2">
      <h3 className="text-sm font-bold text-white">Checklist</h3>
      <dl className="space-y-1">
        {butir.map(([label, nilai, perlu]) => (
          <div key={label} className="min-w-0">
            <dt className="text-xs text-slate-400">{label}</dt>
            <dd
              className={`text-sm ${perlu ? "text-amber-200" : "text-slate-200"}`}
            >
              {nilai}
            </dd>
          </div>
        ))}
      </dl>
      {total > 0 ? (
        <p className="text-sm text-slate-200">
          Total rincian {formatRupiah(total)}
          {c.sisa_kasbon > 0
            ? `, dikurangi sisa kasbon ${formatRupiah(c.sisa_kasbon)}: perkiraan diterima ${formatRupiah(Math.max(total - c.sisa_kasbon, 0))}`
            : ""}
          .
        </p>
      ) : null}
    </div>
  );
}

function RincianPanel({
  rincian,
  bolehUbah,
  sibuk,
  alasanBatal,
  setAlasanBatal,
  onUbah,
  onBerlakukan,
  onBatalkan,
}: {
  rincian: RincianKeluar;
  bolehUbah: boolean;
  sibuk: boolean;
  alasanBatal: string;
  setAlasanBatal: (v: string) => void;
  onUbah: () => void;
  onBerlakukan: () => void;
  onBatalkan: () => void;
}) {
  const k = rincian.keluar;
  const terbuka = k.status === "Dijadwalkan" || k.status === "Jatuh tempo";
  const total = rincian.rincian.reduce((n, r) => n + r.nominal, 0);
  return (
    <div className="space-y-3 rounded-2xl border border-slate-800 bg-slate-900 p-4">
      <div>
        <h2 className="text-lg font-bold text-white">
          {String(rincian.karyawan.nama)}
        </h2>
        <p className="text-xs text-slate-400">
          {k.alasan_nama} • hari kerja terakhir {k.tanggal_terakhir}
          {k.tanggal_pemberitahuan
            ? ` • pemberitahuan ${k.tanggal_pemberitahuan}`
            : ""}
        </p>
        <p
          className={`text-sm font-bold ${WARNA_STATUS[k.status] ?? "text-slate-200"}`}
        >
          {k.status}
          {k.berlaku_pada
            ? ` oleh ${k.berlaku_oleh}, ${k.berlaku_pada} UTC`
            : ""}
          {k.dibatalkan_pada
            ? ` oleh ${k.dibatalkan_oleh}: ${k.alasan_batal}`
            : ""}
        </p>
      </div>
      <p className="text-sm text-slate-300">
        Upah {formatRupiah(k.upah_pokok)} + tunjangan tetap{" "}
        {formatRupiah(k.tunjangan_tetap)}
        {k.alasan_upah ? ` (alasan: ${k.alasan_upah})` : ""}
      </p>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-slate-400">
            <th className="py-1">Komponen</th>
            <th className="py-1">Dasar</th>
            <th className="py-1 text-right">Usulan</th>
            <th className="py-1 text-right">Nominal</th>
          </tr>
        </thead>
        <tbody>
          {rincian.rincian.map((r) => (
            <tr key={r.id_rincian} className="border-t border-slate-800">
              <td className="py-1 text-white">{r.komponen}</td>
              <td className="py-1 text-xs text-slate-400">
                {r.dasar ?? "-"}
                {r.alasan_ubah ? ` • diubah: ${r.alasan_ubah}` : ""}
              </td>
              <td className="py-1 text-right text-slate-300">
                {formatRupiah(r.usulan)}
              </td>
              <td className="py-1 text-right text-white">
                {formatRupiah(r.nominal)}
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t border-slate-700">
            <td colSpan={3} className="py-1 font-bold text-white">
              Total
            </td>
            <td className="py-1 text-right font-bold text-white">
              {formatRupiah(total)}
            </td>
          </tr>
        </tfoot>
      </table>
      <p className="text-xs text-slate-500">
        Pembayaran pesangon dicatat lewat jurnal manual di Keuangan. PPh 21 atas
        pesangon dihitung manual.
      </p>
      <Checklist data={rincian} />
      {k.kartu_ditarik === 1 ? (
        <p className="text-sm text-slate-200">Kartu ID sudah ditarik.</p>
      ) : (
        <p className="text-sm text-amber-200">Kartu ID belum ditarik.</p>
      )}

      {bolehUbah && terbuka ? (
        <div className="flex flex-wrap gap-2">
          <button type="button" className={TOMBOL_KEDUA} onClick={onUbah}>
            Ubah
          </button>
          <button
            id="hris-keluar-berlakukan"
            type="button"
            className={TOMBOL}
            disabled={sibuk || k.status !== "Jatuh tempo"}
            onClick={onBerlakukan}
          >
            Berlakukan
          </button>
        </div>
      ) : null}
      {bolehUbah && k.status === "Dijadwalkan" ? (
        <p className="text-xs text-slate-400">
          Berlakukan terbuka sejak hari kerja terakhir. Karyawan tidak bisa scan
          lagi sejak ditekan, jadi tekan setelah jam pulang hari terakhir.
        </p>
      ) : null}
      {bolehUbah && k.status !== "Dibatalkan" ? (
        <div className="flex flex-wrap gap-2">
          <input
            id="hris-keluar-alasan-batal"
            aria-label="Alasan pembatalan"
            placeholder="Alasan pembatalan"
            value={alasanBatal}
            onChange={(e) => setAlasanBatal(e.target.value)}
            className={`${KELAS} sm:flex-1`}
          />
          <button
            type="button"
            className={TOMBOL_KEDUA}
            disabled={sibuk || !alasanBatal.trim()}
            onClick={onBatalkan}
          >
            Batalkan proses keluar
          </button>
        </div>
      ) : null}
    </div>
  );
}

function AlasanPanel({
  alasan,
  onBerubah,
}: {
  alasan: AlasanKeluar[];
  onBerubah: () => void;
}) {
  const kosong = {
    id_alasan: "",
    nama: "",
    pengali_up: 0,
    pengali_upmk: 0,
    uph: true,
    kompensasi_pkwt: false,
    uang_pisah: false,
    dasar_hukum: "",
    is_aktif: true,
  };
  const [isi, setIsi] = useState<typeof kosong | null>(null);
  const [pesan, setPesan] = useState("");
  const urut = useMemo(
    () => [...alasan].sort((a, b) => b.is_aktif - a.is_aktif),
    [alasan],
  );
  const simpan = async () => {
    if (!isi) return;
    const lanjut = await konfirmasiData([
      { label: "Nama", nilai: isi.nama },
      { label: "Pengali UP", nilai: `${isi.pengali_up}%` },
      { label: "Pengali UPMK", nilai: `${isi.pengali_upmk}%` },
    ]);
    if (!lanjut) return;
    try {
      await simpanAlasanKeluar({ ...isi, id_alasan: isi.id_alasan || null });
      setIsi(null);
      setPesan("Alasan tersimpan.");
      onBerubah();
    } catch (error) {
      setPesan(pesanGalat(error, "Alasan gagal disimpan."));
    }
  };
  return (
    <div className="space-y-3 rounded-2xl border border-slate-800 bg-slate-900 p-4">
      <h3 className="text-sm font-bold text-white">
        Alasan keluar dan pengali pesangon
      </h3>
      <p className="text-xs text-slate-400">
        Bawaan dari PP 35/2021, wajib dicek ulang dengan PK/PP/PKB perusahaan.
        Pengali dalam persen dari kelipatan UP dan UPMK.
      </p>
      {pesan ? <p className="text-sm text-slate-300">{pesan}</p> : null}
      <ul className="space-y-1">
        {urut.map((a) => (
          <li
            key={a.id_alasan}
            className="flex flex-wrap items-center justify-between gap-2"
          >
            <span
              className={`text-sm ${a.is_aktif ? "text-white" : "text-slate-500"}`}
            >
              {a.nama}: UP {a.pengali_up}%, UPMK {a.pengali_upmk}%
              {a.uph ? ", UPH" : ""}
              {a.kompensasi_pkwt ? ", kompensasi PKWT" : ""}
              {a.uang_pisah ? ", uang pisah" : ""}
              {a.is_aktif ? "" : " (nonaktif)"}
            </span>
            <button
              type="button"
              className={TOMBOL_KEDUA}
              onClick={() =>
                setIsi({
                  id_alasan: a.id_alasan,
                  nama: a.nama,
                  pengali_up: a.pengali_up,
                  pengali_upmk: a.pengali_upmk,
                  uph: a.uph === 1,
                  kompensasi_pkwt: a.kompensasi_pkwt === 1,
                  uang_pisah: a.uang_pisah === 1,
                  dasar_hukum: a.dasar_hukum ?? "",
                  is_aktif: a.is_aktif === 1,
                })
              }
            >
              Ubah
            </button>
          </li>
        ))}
      </ul>
      {isi ? (
        <div className="grid grid-cols-1 gap-3 rounded-xl border border-slate-800 p-3 sm:grid-cols-2">
          <div className="min-w-0 sm:col-span-2">
            <label htmlFor="hris-alasan-nama" className={LABEL}>
              Nama
            </label>
            <input
              id="hris-alasan-nama"
              value={isi.nama}
              onChange={(e) => setIsi({ ...isi, nama: e.target.value })}
              className={KELAS}
            />
          </div>
          {(["pengali_up", "pengali_upmk"] as const).map((kunci) => (
            <div key={kunci} className="min-w-0">
              <label htmlFor={`hris-alasan-${kunci}`} className={LABEL}>
                {kunci === "pengali_up" ? "Pengali UP (%)" : "Pengali UPMK (%)"}
              </label>
              <input
                id={`hris-alasan-${kunci}`}
                inputMode="numeric"
                value={String(isi[kunci])}
                onChange={(e) =>
                  setIsi({ ...isi, [kunci]: bacaRupiah(e.target.value) ?? 0 })
                }
                className={KELAS}
              />
            </div>
          ))}
          <div className="min-w-0 sm:col-span-2">
            <label htmlFor="hris-alasan-dasar" className={LABEL}>
              Dasar hukum (opsional)
            </label>
            <input
              id="hris-alasan-dasar"
              value={isi.dasar_hukum}
              onChange={(e) => setIsi({ ...isi, dasar_hukum: e.target.value })}
              className={KELAS}
            />
          </div>
          {(
            [
              ["uph", "Uang penggantian hak (UPH)"],
              ["kompensasi_pkwt", "Kompensasi PKWT"],
              ["uang_pisah", "Uang pisah"],
              ["is_aktif", "Aktif"],
            ] as const
          ).map(([kunci, label]) => (
            <label
              key={kunci}
              className="flex items-center gap-2 text-sm text-slate-200"
            >
              <input
                id={`hris-alasan-${kunci}`}
                type="checkbox"
                checked={isi[kunci]}
                onChange={(e) => setIsi({ ...isi, [kunci]: e.target.checked })}
              />
              {label}
            </label>
          ))}
          <div className="flex flex-wrap gap-2 sm:col-span-2">
            <button type="button" className={TOMBOL} onClick={simpan}>
              Simpan alasan
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
      ) : (
        <button
          type="button"
          className={TOMBOL_KEDUA}
          onClick={() => setIsi(kosong)}
        >
          Tambah alasan
        </button>
      )}
    </div>
  );
}
