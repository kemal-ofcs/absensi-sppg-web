"use client";

import { useCallback, useEffect, useState } from "react";
import { bukaBerkas, siapkanBerkas } from "@/components/hris/berkas";
import type { BarisKaryawan } from "@/components/hris/HrisWorkspace";
import { JatahCutiPanel } from "@/components/hris/JatahCutiPanel";
import { RiwayatKinerjaKaryawan } from "@/components/hris/KinerjaWorkspace";
import { RiwayatPelatihanKaryawan } from "@/components/hris/PelatihanWorkspace";
import { SuratPeringatanPanel } from "@/components/hris/SuratPeringatanPanel";
import { konfirmasiData } from "@/components/ui/KonfirmasiData";
import { hasPermission } from "@/lib/auth/access";
import { useAuth } from "@/lib/context/AuthContext";
import {
  ambilBerkas,
  ambilDokumen,
  ambilKontrakKaryawan,
  ambilProfil,
  batalkanKontrak,
  catatKontrak,
  type Dokumen,
  hapusBerkas,
  hapusDokumen,
  type JenisDokumen,
  type KontrakKaryawan,
  type Profil,
  simpanDataKeuangan,
  simpanDataPribadi,
  simpanDokumen,
  tambahBerkas,
} from "@/lib/gateways/hris";
import {
  AGAMA,
  JENIS_KONTRAK,
  LABEL_TANDA_HRIS,
  MIME_BERKAS,
  PENDIDIKAN,
  STATUS_NIKAH,
} from "@/lib/validations/hris";
import type { TabRincian } from "@/lib/validations/telegram";

type Tab = TabRincian;
type Isian = Record<string, string>;

const KELAS =
  "min-h-10 w-full rounded-xl border border-slate-800 bg-slate-950 px-3 text-white outline-none focus:border-sky-500";
const TOMBOL =
  "min-h-10 rounded-xl bg-sky-500 px-4 text-sm font-bold text-white disabled:opacity-50";
const TOMBOL_KEDUA =
  "min-h-9 rounded-xl border border-slate-700 px-3 text-xs font-bold text-slate-200";

type Kolom = [
  kunci: string,
  label: string,
  jenis?: "tanggal" | readonly string[],
];

const KOLOM_PRIBADI: Kolom[] = [
  ["nik", "NIK"],
  ["no_kk", "Nomor KK"],
  ["tempat_lahir", "Tempat lahir"],
  ["tanggal_lahir", "Tanggal lahir", "tanggal"],
  ["agama", "Agama", AGAMA],
  ["status_nikah", "Status nikah", STATUS_NIKAH],
  ["pendidikan", "Pendidikan terakhir", PENDIDIKAN],
  ["alamat_ktp", "Alamat KTP"],
  ["alamat_domisili", "Alamat domisili"],
  ["darurat_nama", "Kontak darurat: nama"],
  ["darurat_hubungan", "Kontak darurat: hubungan"],
  ["darurat_hp", "Kontak darurat: nomor HP"],
];
const KOLOM_KEUANGAN: Kolom[] = [
  ["bank", "Bank"],
  ["no_rekening", "Nomor rekening"],
  ["nama_rekening", "Nama pemilik rekening"],
  ["npwp", "NPWP"],
  ["bpjs_kesehatan", "Nomor BPJS Kesehatan"],
  ["bpjs_ketenagakerjaan", "Nomor BPJS Ketenagakerjaan"],
];

const pesanGalat = (error: unknown, cadangan: string) =>
  error instanceof Error ? error.message : cadangan;

function Bidang({
  id,
  label,
  jenis,
  nilai,
  onUbah,
  nonaktif,
}: {
  id: string;
  label: string;
  jenis?: "tanggal" | readonly string[];
  nilai: string;
  onUbah: (v: string) => void;
  nonaktif?: boolean;
}) {
  return (
    <div className="min-w-0">
      <label
        htmlFor={id}
        className="mb-1 block text-xs font-semibold text-slate-400"
      >
        {label}
      </label>
      {Array.isArray(jenis) ? (
        <select
          id={id}
          value={nilai}
          disabled={nonaktif}
          onChange={(e) => onUbah(e.target.value)}
          className={KELAS}
        >
          <option value="">-</option>
          {jenis.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
      ) : (
        <input
          id={id}
          type={jenis === "tanggal" ? "date" : "text"}
          value={nilai}
          disabled={nonaktif}
          onChange={(e) => onUbah(e.target.value)}
          className={KELAS}
        />
      )}
    </div>
  );
}

export function RincianKaryawan({
  karyawan,
  nama,
  onBerubah,
  onMulaiKeluar,
  tabAwal = "kerja",
}: {
  karyawan: BarisKaryawan;
  nama: Map<string, string>;
  onBerubah: () => void;
  onMulaiKeluar?: (idSp: string) => void;
  tabAwal?: Tab;
}) {
  const { user } = useAuth();
  const boleh = (izin: Parameters<typeof hasPermission>[1]) =>
    hasPermission(user, izin);
  const id = String(karyawan.id_unik);
  const [tab, setTab] = useState<Tab>(tabAwal);
  const tabs: Array<[Tab, string]> = [
    ["kerja", "Kerja"],
    ...(boleh("hr.personal.view")
      ? ([["pribadi", "Pribadi"]] as Array<[Tab, string]>)
      : []),
    ...(boleh("hr.finance.view")
      ? ([["keuangan", "Keuangan"]] as Array<[Tab, string]>)
      : []),
    ["kontrak", "Kontrak"],
    ...(boleh("hr.document.view")
      ? ([["dokumen", "Dokumen"]] as Array<[Tab, string]>)
      : []),
    ...(boleh("hr.request.view")
      ? ([["cuti", "Cuti"]] as Array<[Tab, string]>)
      : []),
    ...(boleh("hr.warning.view")
      ? ([["sp", "SP"]] as Array<[Tab, string]>)
      : []),
    ...(boleh("hr.performance.view")
      ? ([["kinerja", "Kinerja"]] as Array<[Tab, string]>)
      : []),
    ...(boleh("hr.training.view") || boleh("hr.training.manage")
      ? ([["pelatihan", "Pelatihan"]] as Array<[Tab, string]>)
      : []),
  ];
  return (
    <div className="space-y-3 rounded-2xl border border-slate-800 bg-slate-900 p-4">
      <div>
        <h2 className="text-lg font-bold text-white">
          {String(karyawan.nama)}
        </h2>
        <p className="text-xs text-slate-400">
          {String(karyawan.kode_karyawan || "-")} •{" "}
          {String(karyawan.divisi || "-")}
        </p>
      </div>
      <div
        className="flex flex-nowrap gap-2 overflow-x-auto pb-1 sm:flex-wrap sm:overflow-visible sm:pb-0"
        role="tablist"
        aria-label="Rincian karyawan"
      >
        {tabs.map(([t, label]) => (
          <button
            key={t}
            id={`hris-rincian-${t}`}
            type="button"
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className={`min-h-9 shrink-0 rounded-xl px-3 text-xs font-bold ${tab === t ? "bg-sky-500 text-white" : "bg-slate-950 text-slate-300"}`}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === "kerja" ? <Kerja karyawan={karyawan} nama={nama} /> : null}
      {tab === "pribadi" || tab === "keuangan" ? (
        <ProfilForm
          key={tab}
          id={id}
          kelompok={tab}
          bolehUbah={boleh(
            tab === "pribadi" ? "hr.personal.manage" : "hr.finance.manage",
          )}
        />
      ) : null}
      {tab === "kontrak" ? (
        <KontrakPanel
          id={id}
          bolehUbah={boleh("hr.contract.manage")}
          onBerubah={onBerubah}
        />
      ) : null}
      {tab === "dokumen" ? (
        <DokumenPanel id={id} bolehUbah={boleh("hr.document.manage")} />
      ) : null}
      {tab === "cuti" ? (
        <JatahCutiPanel idKaryawan={id} bolehUbah={boleh("hr.leave.adjust")} />
      ) : null}
      {tab === "sp" ? (
        <SuratPeringatanPanel
          karyawan={karyawan}
          bolehUbah={boleh("hr.warning.manage")}
          bolehCabut={boleh("hr.warning.cancel")}
          onMulaiKeluar={onMulaiKeluar}
        />
      ) : null}
      {tab === "kinerja" ? <RiwayatKinerjaKaryawan idKaryawan={id} /> : null}
      {tab === "pelatihan" ? (
        <RiwayatPelatihanKaryawan idKaryawan={id} />
      ) : null}
    </div>
  );
}

function Kerja({
  karyawan,
  nama,
}: {
  karyawan: BarisKaryawan;
  nama: Map<string, string>;
}) {
  const [kontrak, setKontrak] = useState<KontrakKaryawan | null>(null);
  useEffect(() => {
    ambilKontrakKaryawan(String(karyawan.id_unik))
      .then(setKontrak)
      .catch(() => setKontrak(null));
  }, [karyawan.id_unik]);
  const s = kontrak?.status;
  const baris: Array<[string, string]> = [
    ["Cabang", nama.get(`c:${String(karyawan.id_cabang ?? "")}`) ?? "-"],
    ["Divisi", String(karyawan.divisi || "-")],
    ["Jabatan", String(karyawan.jabatan_status || "-")],
    [
      "Atasan langsung",
      nama.get(`k:${String(karyawan.id_atasan ?? "")}`) ?? "-",
    ],
    ["Tanggal masuk", String(karyawan.tanggal_daftar || "-")],
    ["Jenis personil", String(karyawan.jenis_personil || "-")],
    [
      "Status kerja",
      !s
        ? "-"
        : s.keadaan === "Tanpa kontrak"
          ? "Tanpa kontrak"
          : `${s.jenis} ${s.keadaan === "Berakhir" ? "(berakhir" : "(berlaku"}${s.sampai ? ` s.d. ${s.sampai}` : ""})${s.percobaan_sampai ? `, masa percobaan s.d. ${s.percobaan_sampai}` : ""}`,
    ],
  ];
  return (
    <div className="space-y-2">
      <dl className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {baris.map(([label, nilai]) => (
          <div key={label} className="min-w-0">
            <dt className="text-xs text-slate-400">{label}</dt>
            <dd className="truncate text-sm text-white">{nilai}</dd>
          </div>
        ))}
      </dl>
      {kontrak?.tanda.length ? (
        <p className="text-xs text-amber-200">
          {kontrak.tanda.map((t) => LABEL_TANDA_HRIS[t] ?? t).join(", ")}
        </p>
      ) : null}
      <p className="text-xs text-slate-500">
        Cabang, divisi, jabatan, atasan, dan tanggal masuk diubah dari halaman
        Karyawan.
      </p>
    </div>
  );
}

function ProfilForm({
  id,
  kelompok,
  bolehUbah,
}: {
  id: string;
  kelompok: "pribadi" | "keuangan";
  bolehUbah: boolean;
}) {
  const kolom = kelompok === "pribadi" ? KOLOM_PRIBADI : KOLOM_KEUANGAN;
  const [isi, setIsi] = useState<Isian>({});
  const [jejak, setJejak] = useState("");
  const [pesan, setPesan] = useState("");
  const [sibuk, setSibuk] = useState(false);

  useEffect(() => {
    ambilProfil(id)
      .then((p: Profil) => {
        const data = p[kelompok] ?? {};
        setIsi(
          Object.fromEntries(kolom.map(([k]) => [k, String(data[k] ?? "")])),
        );
        const oleh = data[`${kelompok}_diubah_oleh`];
        setJejak(
          oleh
            ? `Terakhir diubah ${oleh}, ${data[`${kelompok}_diubah_pada`] ?? ""} UTC`
            : "",
        );
      })
      .catch((error: unknown) =>
        setPesan(pesanGalat(error, "Profil gagal dimuat.")),
      );
  }, [id, kelompok, kolom]);

  const simpan = async () => {
    const lanjut = await konfirmasiData(
      kolom.map(([k, label]) => ({ label, nilai: isi[k] })),
    );
    if (!lanjut) return;
    setSibuk(true);
    try {
      const draft = Object.fromEntries(kolom.map(([k]) => [k, isi[k] ?? ""]));
      await (kelompok === "pribadi"
        ? simpanDataPribadi(id, draft)
        : simpanDataKeuangan(id, draft));
      setPesan("Tersimpan.");
    } catch (error) {
      setPesan(pesanGalat(error, "Gagal menyimpan."));
    } finally {
      setSibuk(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {kolom.map(([k, label, jenis]) => (
          <Bidang
            key={k}
            id={`hris-${kelompok}-${k}`}
            label={label}
            jenis={jenis}
            nilai={isi[k] ?? ""}
            nonaktif={!bolehUbah}
            onUbah={(v) => setIsi((lama) => ({ ...lama, [k]: v }))}
          />
        ))}
      </div>
      {jejak ? <p className="text-xs text-slate-500">{jejak}</p> : null}
      {pesan ? <p className="text-sm text-slate-300">{pesan}</p> : null}
      {bolehUbah ? (
        <button
          type="button"
          disabled={sibuk}
          onClick={simpan}
          className={TOMBOL}
        >
          Simpan
        </button>
      ) : null}
    </div>
  );
}

const KONTRAK_KOSONG: Isian = {
  jenis: "PKWT",
  nomor: "",
  tanggal_mulai: "",
  tanggal_selesai: "",
  percobaan_selesai: "",
  catatan: "",
};

function KontrakPanel({
  id,
  bolehUbah,
  onBerubah,
}: {
  id: string;
  bolehUbah: boolean;
  onBerubah: () => void;
}) {
  const [data, setData] = useState<KontrakKaryawan | null>(null);
  const [isi, setIsi] = useState<Isian>(KONTRAK_KOSONG);
  const [alasan, setAlasan] = useState<Record<string, string>>({});
  const [pesan, setPesan] = useState("");
  const [sibuk, setSibuk] = useState(false);

  const muat = useCallback(() => {
    ambilKontrakKaryawan(id)
      .then(setData)
      .catch((error: unknown) =>
        setPesan(pesanGalat(error, "Kontrak gagal dimuat.")),
      );
  }, [id]);
  useEffect(muat, [muat]);

  const batal = new Set(
    (data?.kontrak ?? [])
      .filter((k) => k.jenis === "Pembatalan")
      .map((k) => k.id_ref),
  );

  const simpan = async () => {
    const lanjut = await konfirmasiData([
      { label: "Jenis", nilai: isi.jenis },
      { label: "Nomor", nilai: isi.nomor },
      { label: "Mulai", nilai: isi.tanggal_mulai },
      { label: "Selesai", nilai: isi.tanggal_selesai },
      { label: "Akhir masa percobaan", nilai: isi.percobaan_selesai },
    ]);
    if (!lanjut) return;
    setSibuk(true);
    try {
      await catatKontrak({ ...isi, id_karyawan: id });
      setIsi(KONTRAK_KOSONG);
      setPesan("Kontrak tercatat.");
      muat();
      onBerubah();
    } catch (error) {
      setPesan(pesanGalat(error, "Kontrak gagal dicatat."));
    } finally {
      setSibuk(false);
    }
  };

  const batalkan = async (idKontrak: string) => {
    setSibuk(true);
    try {
      await batalkanKontrak(idKontrak, alasan[idKontrak] ?? "");
      setPesan("Kontrak dibatalkan.");
      muat();
      onBerubah();
    } catch (error) {
      setPesan(pesanGalat(error, "Kontrak gagal dibatalkan."));
    } finally {
      setSibuk(false);
    }
  };

  return (
    <div className="space-y-4">
      <ul className="space-y-2">
        {(data?.kontrak ?? [])
          .filter((k) => k.jenis !== "Pembatalan")
          .map((k) => (
            <li
              key={k.id_kontrak}
              className="rounded-xl border border-slate-800 p-3"
            >
              <p className="text-sm font-semibold text-white">
                {k.jenis} {k.nomor ? `• ${k.nomor}` : ""}
                {batal.has(k.id_kontrak) ? (
                  <span className="ml-2 text-xs text-rose-200">Dibatalkan</span>
                ) : null}
              </p>
              <p className="text-xs text-slate-400">
                {k.tanggal_mulai} s.d. {k.tanggal_selesai ?? "tidak terbatas"}
                {k.percobaan_selesai
                  ? ` • percobaan s.d. ${k.percobaan_selesai}`
                  : ""}
              </p>
              {bolehUbah && !batal.has(k.id_kontrak) ? (
                <div className="mt-2 flex flex-wrap gap-2">
                  <input
                    id={`hris-batal-${k.id_kontrak}`}
                    aria-label="Alasan pembatalan"
                    placeholder="Alasan pembatalan"
                    value={alasan[k.id_kontrak] ?? ""}
                    onChange={(e) =>
                      setAlasan((l) => ({
                        ...l,
                        [k.id_kontrak]: e.target.value,
                      }))
                    }
                    className={`${KELAS} sm:max-w-xs`}
                  />
                  <button
                    type="button"
                    disabled={sibuk || !(alasan[k.id_kontrak] ?? "").trim()}
                    onClick={() => batalkan(k.id_kontrak)}
                    className={TOMBOL_KEDUA}
                  >
                    Batalkan
                  </button>
                </div>
              ) : null}
            </li>
          ))}
        {data && data.kontrak.length === 0 ? (
          <li className="text-sm text-slate-400">Belum ada kontrak.</li>
        ) : null}
      </ul>
      {bolehUbah ? (
        <div className="space-y-3 rounded-xl border border-slate-800 p-3">
          <p className="text-sm font-bold text-white">Tambah kontrak</p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Bidang
              id="hris-kontrak-jenis"
              label="Jenis"
              jenis={JENIS_KONTRAK}
              nilai={isi.jenis}
              onUbah={(v) => setIsi((l) => ({ ...l, jenis: v }))}
            />
            <Bidang
              id="hris-kontrak-nomor"
              label="Nomor kontrak"
              nilai={isi.nomor}
              onUbah={(v) => setIsi((l) => ({ ...l, nomor: v }))}
            />
            <Bidang
              id="hris-kontrak-mulai"
              label="Tanggal mulai"
              jenis="tanggal"
              nilai={isi.tanggal_mulai}
              onUbah={(v) => setIsi((l) => ({ ...l, tanggal_mulai: v }))}
            />
            <Bidang
              id="hris-kontrak-selesai"
              label="Tanggal selesai"
              jenis="tanggal"
              nilai={isi.tanggal_selesai}
              nonaktif={isi.jenis === "PKWTT"}
              onUbah={(v) => setIsi((l) => ({ ...l, tanggal_selesai: v }))}
            />
            <Bidang
              id="hris-kontrak-percobaan"
              label="Akhir masa percobaan (PKWTT)"
              jenis="tanggal"
              nilai={isi.percobaan_selesai}
              nonaktif={isi.jenis !== "PKWTT"}
              onUbah={(v) => setIsi((l) => ({ ...l, percobaan_selesai: v }))}
            />
            <Bidang
              id="hris-kontrak-catatan"
              label="Catatan"
              nilai={isi.catatan}
              onUbah={(v) => setIsi((l) => ({ ...l, catatan: v }))}
            />
          </div>
          <button
            type="button"
            disabled={sibuk}
            onClick={simpan}
            className={TOMBOL}
          >
            Catat kontrak
          </button>
        </div>
      ) : null}
      {pesan ? <p className="text-sm text-slate-300">{pesan}</p> : null}
    </div>
  );
}

const DOKUMEN_KOSONG: Isian = {
  id_dokumen: "",
  id_jenis: "",
  nomor: "",
  tanggal_terbit: "",
  tanggal_kedaluwarsa: "",
  catatan: "",
};

function DokumenPanel({ id, bolehUbah }: { id: string; bolehUbah: boolean }) {
  const [dokumen, setDokumen] = useState<Dokumen[]>([]);
  const [jenis, setJenis] = useState<JenisDokumen[]>([]);
  const [isi, setIsi] = useState<Isian>(DOKUMEN_KOSONG);
  const [pesan, setPesan] = useState("");
  const [sibuk, setSibuk] = useState(false);

  const muat = useCallback(() => {
    ambilDokumen(id)
      .then((d) => {
        setDokumen(d.dokumen);
        setJenis(d.jenis);
      })
      .catch((error: unknown) =>
        setPesan(pesanGalat(error, "Dokumen gagal dimuat.")),
      );
  }, [id]);
  useEffect(muat, [muat]);

  const jalankan = async (kerja: () => Promise<unknown>, berhasil: string) => {
    setSibuk(true);
    try {
      await kerja();
      setPesan(berhasil);
      muat();
    } catch (error) {
      setPesan(pesanGalat(error, "Gagal."));
    } finally {
      setSibuk(false);
    }
  };

  const simpan = async () => {
    const lanjut = await konfirmasiData([
      {
        label: "Jenis",
        nilai: jenis.find((j) => j.id_jenis === isi.id_jenis)?.nama,
      },
      { label: "Nomor", nilai: isi.nomor },
      { label: "Terbit", nilai: isi.tanggal_terbit },
      { label: "Kedaluwarsa", nilai: isi.tanggal_kedaluwarsa },
    ]);
    if (!lanjut) return;
    await jalankan(async () => {
      await simpanDokumen({ ...isi, id_karyawan: id });
      setIsi(DOKUMEN_KOSONG);
    }, "Dokumen tersimpan.");
  };

  const unggah = async (idDokumen: string, berkas: File | undefined) => {
    if (!berkas) return;
    if (!(MIME_BERKAS as readonly string[]).includes(berkas.type)) {
      setPesan("Jenis berkas harus JPEG, PNG, WEBP, atau PDF.");
      return;
    }
    await jalankan(
      async () =>
        tambahBerkas({
          id_dokumen: idDokumen,
          ...(await siapkanBerkas(berkas)),
        }),
      "Berkas terunggah.",
    );
  };

  const buka = async (idBerkas: string) => {
    try {
      const pesanBuka = await bukaBerkas(await ambilBerkas(idBerkas));
      if (pesanBuka) setPesan(pesanBuka);
    } catch (error) {
      setPesan(pesanGalat(error, "Berkas gagal dibuka."));
    }
  };

  return (
    <div className="space-y-4">
      <ul className="space-y-2">
        {dokumen.map((d) => (
          <li
            key={d.id_dokumen}
            className="space-y-2 rounded-xl border border-slate-800 p-3"
          >
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <p className="text-sm font-semibold text-white">
                {d.nama_jenis ?? d.id_jenis} {d.nomor ? `• ${d.nomor}` : ""}
              </p>
              <p className="text-xs text-slate-400">
                {d.tanggal_terbit ?? "-"} →{" "}
                {d.tanggal_kedaluwarsa ?? "tanpa kedaluwarsa"}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              {d.berkas.map((b) => (
                <span key={b.id_berkas} className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => buka(b.id_berkas)}
                    className={TOMBOL_KEDUA}
                  >
                    {b.nama_berkas ?? `Berkas ${b.urutan}`}
                  </button>
                  {bolehUbah ? (
                    <button
                      type="button"
                      aria-label="Hapus berkas"
                      disabled={sibuk}
                      onClick={async () => {
                        const lanjut = await konfirmasiData([
                          {
                            label: "Hapus berkas",
                            nilai: b.nama_berkas ?? `Berkas ${b.urutan}`,
                            peringatan: true,
                          },
                          {
                            label: "Dokumen",
                            nilai: `${d.nama_jenis ?? d.id_jenis}${d.nomor ? ` • ${d.nomor}` : ""}`,
                          },
                        ]);
                        if (lanjut) {
                          void jalankan(
                            () => hapusBerkas(b.id_berkas),
                            "Berkas dihapus.",
                          );
                        }
                      }}
                      className="min-h-9 px-2 text-xs text-rose-200"
                    >
                      ✕
                    </button>
                  ) : null}
                </span>
              ))}
            </div>
            {bolehUbah ? (
              <div className="flex flex-wrap gap-2">
                <label
                  className={`${TOMBOL_KEDUA} flex cursor-pointer items-center`}
                >
                  Unggah berkas (maks 1 MB)
                  <input
                    id={`hris-unggah-${d.id_dokumen}`}
                    type="file"
                    accept={MIME_BERKAS.join(",")}
                    className="sr-only"
                    disabled={sibuk || d.berkas.length >= 5}
                    onChange={(e) => {
                      void unggah(d.id_dokumen, e.target.files?.[0]);
                      e.target.value = "";
                    }}
                  />
                </label>
                <button
                  type="button"
                  onClick={() =>
                    setIsi({
                      id_dokumen: d.id_dokumen,
                      id_jenis: d.id_jenis,
                      nomor: d.nomor ?? "",
                      tanggal_terbit: d.tanggal_terbit ?? "",
                      tanggal_kedaluwarsa: d.tanggal_kedaluwarsa ?? "",
                      catatan: d.catatan ?? "",
                    })
                  }
                  className={TOMBOL_KEDUA}
                >
                  Ubah
                </button>
                <button
                  type="button"
                  disabled={sibuk}
                  onClick={async () => {
                    const lanjut = await konfirmasiData([
                      {
                        label: "Hapus dokumen",
                        nilai: `${d.nama_jenis ?? d.id_jenis}${d.nomor ? ` • ${d.nomor}` : ""}`,
                        peringatan: true,
                      },
                      {
                        label: "Berkas ikut terhapus",
                        nilai: d.berkas.length
                          ? `${d.berkas.length} berkas`
                          : null,
                        peringatan: true,
                      },
                    ]);
                    if (lanjut) {
                      void jalankan(
                        () => hapusDokumen(d.id_dokumen),
                        "Dokumen dihapus.",
                      );
                    }
                  }}
                  className={TOMBOL_KEDUA}
                >
                  Hapus
                </button>
              </div>
            ) : null}
          </li>
        ))}
        {dokumen.length === 0 ? (
          <li className="text-sm text-slate-400">Belum ada dokumen.</li>
        ) : null}
      </ul>
      {bolehUbah ? (
        <div className="space-y-3 rounded-xl border border-slate-800 p-3">
          <p className="text-sm font-bold text-white">
            {isi.id_dokumen ? "Ubah dokumen" : "Tambah dokumen"}
          </p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="min-w-0">
              <label
                htmlFor="hris-dokumen-jenis"
                className="mb-1 block text-xs font-semibold text-slate-400"
              >
                Jenis dokumen
              </label>
              <select
                id="hris-dokumen-jenis"
                value={isi.id_jenis}
                onChange={(e) =>
                  setIsi((l) => ({ ...l, id_jenis: e.target.value }))
                }
                className={KELAS}
              >
                <option value="">Pilih jenis...</option>
                {jenis
                  .filter(
                    (j) => j.is_aktif === 1 || j.id_jenis === isi.id_jenis,
                  )
                  .map((j) => (
                    <option key={j.id_jenis} value={j.id_jenis}>
                      {j.nama}
                    </option>
                  ))}
              </select>
            </div>
            <Bidang
              id="hris-dokumen-nomor"
              label="Nomor"
              nilai={isi.nomor}
              onUbah={(v) => setIsi((l) => ({ ...l, nomor: v }))}
            />
            <Bidang
              id="hris-dokumen-terbit"
              label="Tanggal terbit"
              jenis="tanggal"
              nilai={isi.tanggal_terbit}
              onUbah={(v) => setIsi((l) => ({ ...l, tanggal_terbit: v }))}
            />
            <Bidang
              id="hris-dokumen-kedaluwarsa"
              label="Tanggal kedaluwarsa (opsional)"
              jenis="tanggal"
              nilai={isi.tanggal_kedaluwarsa}
              onUbah={(v) => setIsi((l) => ({ ...l, tanggal_kedaluwarsa: v }))}
            />
            <Bidang
              id="hris-dokumen-catatan"
              label="Catatan"
              nilai={isi.catatan}
              onUbah={(v) => setIsi((l) => ({ ...l, catatan: v }))}
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={sibuk}
              onClick={simpan}
              className={TOMBOL}
            >
              Simpan dokumen
            </button>
            {isi.id_dokumen ? (
              <button
                type="button"
                onClick={() => setIsi(DOKUMEN_KOSONG)}
                className={TOMBOL_KEDUA}
              >
                Batal ubah
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
      {pesan ? <p className="text-sm text-slate-300">{pesan}</p> : null}
    </div>
  );
}
