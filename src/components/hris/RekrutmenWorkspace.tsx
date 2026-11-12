"use client";

// Tab Rekrutmen di /hris (PRD HRIS §22.3–§22.6, Web/Desktop). Khusus cloud:
// butuh koneksi ke database. Status lowongan dan pelamar, tanggal hapus data,
// dan tanda dihitung backend; layar hanya menampilkan dan mengirim isian.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  bacaBase64,
  bukaBerkas,
  mimeBerkasSah,
  PESAN_MIME_BERKAS,
} from "@/components/hris/berkas";
import type { BarisKaryawan } from "@/components/hris/HrisWorkspace";
import { konfirmasiData } from "@/components/ui/KonfirmasiData";
import { PilihCari } from "@/components/ui/PilihCari";
import {
  ambilBerkasPelamar,
  ambilLowongan,
  ambilPelamar,
  ambilRincianPelamar,
  type BerkasRingkas,
  bersihkanPelamar,
  catatTahap,
  hapusPelamar,
  jadikanKaryawan,
  type Lowongan,
  type Pelamar,
  simpanBerkasPelamar,
  simpanLowongan,
  simpanPelamar,
  type TahapPelamar,
} from "@/lib/gateways/hr-rekrutmen";
import type { Organisasi } from "@/lib/gateways/hris";
import { getDaftarShift } from "@/lib/gateways/shift";
import {
  idDariPelamar,
  MAKS_BERKAS_PER_PELAMAR,
  SARAN_SUMBER,
  TAHAP,
  TAHAP_AKHIR,
} from "@/lib/validations/hr-rekrutmen";
import { JENIS_KONTRAK, PENDIDIKAN } from "@/lib/validations/hris";
import { KONFIRMASI_HAPUS_PERMANEN } from "@/lib/validations/inventory";

const KELAS =
  "min-h-10 w-full rounded-xl border border-slate-800 bg-slate-950 px-3 text-white outline-none focus:border-sky-500";
const LABEL = "mb-1 block text-xs font-semibold text-slate-400";
const TOMBOL =
  "min-h-10 rounded-xl bg-sky-500 px-4 text-sm font-bold text-white disabled:opacity-50";
const TOMBOL_KEDUA =
  "min-h-9 rounded-xl border border-slate-700 px-3 text-xs font-bold text-slate-200 disabled:opacity-50";
const KARTU = "rounded-2xl border border-slate-800 bg-slate-900 p-4";

const WARNA_LOWONGAN: Record<string, string> = {
  Dibuka: "text-emerald-200",
  Dijadwalkan: "text-sky-200",
  Ditutup: "text-slate-400",
};
const WARNA_TAHAP: Record<string, string> = {
  Diterima: "text-emerald-200",
  Ditolak: "text-rose-200",
  Mundur: "text-slate-400",
};

type Isian = Record<string, string>;

const pesanGalat = (error: unknown, cadangan: string) =>
  error instanceof Error ? error.message : cadangan;
/** Tanggal + n hari (tampilan saja, untuk sorotan 30 hari sebelum hapus). */
const tambahHari = (tanggal: string, n: number) =>
  new Date(Date.parse(`${tanggal}T00:00:00Z`) + n * 86_400_000)
    .toISOString()
    .slice(0, 10);
const kosongKeNull = (isi: Isian) =>
  Object.fromEntries(
    Object.entries(isi).map(([k, v]) => [k, v.trim() === "" ? null : v]),
  );

/** Satu tombol kirim aktif dalam satu waktu (cegah tekan ganda). */
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

export function RekrutmenWorkspace({
  karyawan,
  org,
  bolehUbah,
  bolehHapus,
  bolehJadikan,
  onBerubah,
}: {
  karyawan: BarisKaryawan[];
  org: Organisasi | null;
  bolehUbah: boolean;
  bolehHapus: boolean;
  /** `hr.recruit.manage` + `employees.manage` + `hr.contract.manage`. */
  bolehJadikan: boolean;
  onBerubah: () => void;
}) {
  const [daftar, setDaftar] = useState<Lowongan[]>([]);
  const [hariIni, setHariIni] = useState("");
  const [dipilih, setDipilih] = useState<string | null>(null);
  const [formLowongan, setFormLowongan] = useState<Isian | null>(null);
  const [pesan, setPesan] = useState("");

  const muat = useCallback(() => {
    ambilLowongan()
      .then((d) => {
        setDaftar(d.lowongan);
        setHariIni(d.hari_ini);
      })
      .catch((error: unknown) =>
        setPesan(pesanGalat(error, "Lowongan gagal dimuat.")),
      );
  }, []);
  useEffect(muat, [muat]);

  const lowongan = daftar.find((l) => l.id_lowongan === dipilih) ?? null;

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
      <div className={`${KARTU} space-y-3`}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-bold text-white">Lowongan</h2>
          {bolehUbah ? (
            <button
              id="rekrutmen-lowongan-baru"
              type="button"
              className={TOMBOL_KEDUA}
              onClick={() => {
                setDipilih(null);
                setFormLowongan({ jumlah: "1", tanggal_buka: hariIni });
              }}
            >
              Lowongan baru
            </button>
          ) : null}
        </div>
        {pesan ? <p className="text-sm text-amber-200">{pesan}</p> : null}
        <ul className="max-h-[65vh] space-y-1 overflow-y-auto">
          {daftar.map((l) => {
            const segera =
              l.tanggal_hapus !== null &&
              l.tanggal_hapus <= tambahHari(hariIni, 30);
            return (
              <li key={l.id_lowongan}>
                <button
                  type="button"
                  onClick={() => {
                    setFormLowongan(null);
                    setDipilih(l.id_lowongan);
                  }}
                  className={`w-full rounded-xl px-3 py-2 text-left ${dipilih === l.id_lowongan ? "bg-sky-500/20" : "hover:bg-slate-800"}`}
                >
                  <span className="block truncate font-semibold text-white">
                    {l.judul}
                  </span>
                  <span className="block truncate text-xs text-slate-400">
                    <span className={WARNA_LOWONGAN[l.status] ?? ""}>
                      {l.status}
                    </span>{" "}
                    • {l.jumlah_pelamar} pelamar • diterima{" "}
                    {l.hitungan.Diterima ?? 0}/{l.jumlah}
                  </span>
                  {l.tanggal_hapus ? (
                    <span
                      className={`block truncate text-xs ${segera ? "text-amber-200" : "text-slate-400"}`}
                    >
                      Data pelamar dihapus pada {l.tanggal_hapus}
                    </span>
                  ) : null}
                </button>
              </li>
            );
          })}
          {daftar.length === 0 ? (
            <li className="text-sm text-slate-400">Belum ada lowongan.</li>
          ) : null}
        </ul>
      </div>
      <div className="min-w-0 space-y-4">
        {formLowongan ? (
          <FormLowongan
            awal={formLowongan}
            org={org}
            onBatal={() => setFormLowongan(null)}
            onTersimpan={(id) => {
              setFormLowongan(null);
              setDipilih(id);
              muat();
            }}
          />
        ) : lowongan ? (
          <PanelLowongan
            key={lowongan.id_lowongan}
            lowongan={lowongan}
            hariIni={hariIni}
            karyawan={karyawan}
            org={org}
            bolehUbah={bolehUbah}
            bolehHapus={bolehHapus}
            bolehJadikan={bolehJadikan}
            onUbah={() =>
              setFormLowongan({
                id_lowongan: lowongan.id_lowongan,
                judul: lowongan.judul,
                jumlah: String(lowongan.jumlah),
                tanggal_buka: lowongan.tanggal_buka,
                tanggal_tutup: lowongan.tanggal_tutup ?? "",
                id_jabatan: lowongan.id_jabatan ?? "",
                id_divisi: lowongan.id_divisi ?? "",
                id_cabang: lowongan.id_cabang ?? "",
                keterangan: lowongan.keterangan ?? "",
              })
            }
            onBerubah={() => {
              muat();
              onBerubah();
            }}
          />
        ) : (
          <p className={`${KARTU} text-sm text-slate-400`}>
            Pilih lowongan untuk melihat pelamarnya.
          </p>
        )}
        {bolehHapus ? <Retensi onSelesai={muat} /> : null}
      </div>
    </div>
  );
}

/** Jalankan retensi sekarang; biasanya dijalankan otomatis setiap sesi. */
function Retensi({ onSelesai }: { onSelesai: () => void }) {
  const [pesan, setPesan] = useState("");
  const { sibuk, jalankan } = useKirim(setPesan);
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
      <span>
        Data pelamar yang masa simpannya habis dihapus otomatis saat ada yang
        login.
      </span>
      <button
        id="rekrutmen-retensi"
        type="button"
        className={TOMBOL_KEDUA}
        disabled={sibuk}
        onClick={() =>
          void jalankan(async () => {
            const hasil = await bersihkanPelamar();
            onSelesai();
            return `${hasil.dihapus} pelamar dihapus.`;
          }, "Pembersihan gagal.")
        }
      >
        Bersihkan sekarang
      </button>
      {pesan ? <span className="text-amber-200">{pesan}</span> : null}
    </div>
  );
}

function PilihanOrg({
  id,
  label,
  value,
  pilihan,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  pilihan: Array<{ id: string; nama: string; aktif: boolean }>;
  onChange: (nilai: string) => void;
}) {
  return (
    <div>
      <label htmlFor={id} className={LABEL}>
        {label}
      </label>
      <PilihCari
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={KELAS}
      >
        <option value="">Tidak ditentukan</option>
        {pilihan
          .filter((p) => p.aktif || p.id === value)
          .map((p) => (
            <option key={p.id} value={p.id}>
              {p.nama}
              {p.aktif ? "" : " (nonaktif)"}
            </option>
          ))}
      </PilihCari>
    </div>
  );
}

function FormLowongan({
  awal,
  org,
  onBatal,
  onTersimpan,
}: {
  awal: Isian;
  org: Organisasi | null;
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
      { label: "Judul", nilai: isi.judul },
      { label: "Jumlah dibutuhkan", nilai: isi.jumlah },
      { label: "Dibuka", nilai: isi.tanggal_buka },
      { label: "Rencana tutup", nilai: isi.tanggal_tutup || "Tanpa tanggal" },
    ]);
    if (!lanjut) return;
    let id = "";
    const ok = await jalankan(async () => {
      id = (
        await simpanLowongan({
          ...kosongKeNull(isi),
          jumlah: Number(isi.jumlah),
        })
      ).id_lowongan;
      return "Lowongan tersimpan.";
    }, "Lowongan gagal disimpan.");
    if (ok) onTersimpan(id);
  };

  return (
    <div className={`${KARTU} space-y-3`}>
      <h3 className="text-sm font-bold text-white">
        {awal.id_lowongan ? "Ubah lowongan" : "Lowongan baru"}
      </h3>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <label htmlFor="lowongan-judul" className={LABEL}>
            Judul
          </label>
          <input
            id="lowongan-judul"
            value={isi.judul ?? ""}
            maxLength={100}
            onChange={(e) => ubah("judul", e.target.value)}
            className={KELAS}
          />
        </div>
        <div>
          <label htmlFor="lowongan-jumlah" className={LABEL}>
            Jumlah dibutuhkan
          </label>
          <input
            id="lowongan-jumlah"
            type="number"
            min={1}
            max={999}
            value={isi.jumlah ?? ""}
            onChange={(e) => ubah("jumlah", e.target.value)}
            className={KELAS}
          />
        </div>
        <div>
          <label htmlFor="lowongan-buka" className={LABEL}>
            Tanggal buka
          </label>
          <input
            id="lowongan-buka"
            type="date"
            value={isi.tanggal_buka ?? ""}
            onChange={(e) => ubah("tanggal_buka", e.target.value)}
            className={KELAS}
          />
        </div>
        <div>
          <label htmlFor="lowongan-tutup" className={LABEL}>
            Rencana tutup (boleh kosong)
          </label>
          <input
            id="lowongan-tutup"
            type="date"
            value={isi.tanggal_tutup ?? ""}
            onChange={(e) => ubah("tanggal_tutup", e.target.value)}
            className={KELAS}
          />
        </div>
        <PilihanOrg
          id="lowongan-jabatan"
          label="Jabatan"
          value={isi.id_jabatan ?? ""}
          pilihan={(org?.jabatan ?? []).map((j) => ({
            id: j.id_jabatan,
            nama: j.nama,
            aktif: j.is_aktif === 1,
          }))}
          onChange={(v) => ubah("id_jabatan", v)}
        />
        <PilihanOrg
          id="lowongan-divisi"
          label="Divisi"
          value={isi.id_divisi ?? ""}
          pilihan={(org?.divisi ?? []).map((d) => ({
            id: d.id_divisi,
            nama: d.nama,
            aktif: d.is_aktif === 1,
          }))}
          onChange={(v) => ubah("id_divisi", v)}
        />
        <PilihanOrg
          id="lowongan-cabang"
          label="Cabang"
          value={isi.id_cabang ?? ""}
          pilihan={(org?.cabang ?? []).map((c) => ({
            id: c.id_cabang,
            nama: c.nama,
            aktif: c.is_aktif === 1,
          }))}
          onChange={(v) => ubah("id_cabang", v)}
        />
        <div className="sm:col-span-2">
          <label htmlFor="lowongan-keterangan" className={LABEL}>
            Keterangan
          </label>
          <textarea
            id="lowongan-keterangan"
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
          id="lowongan-simpan"
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

function PanelLowongan({
  lowongan,
  hariIni,
  karyawan,
  org,
  bolehUbah,
  bolehHapus,
  bolehJadikan,
  onUbah,
  onBerubah,
}: {
  lowongan: Lowongan;
  hariIni: string;
  karyawan: BarisKaryawan[];
  org: Organisasi | null;
  bolehUbah: boolean;
  bolehHapus: boolean;
  bolehJadikan: boolean;
  onUbah: () => void;
  onBerubah: () => void;
}) {
  const [pelamar, setPelamar] = useState<Pelamar[]>([]);
  const [dipilih, setDipilih] = useState<string | null>(null);
  const [formPelamar, setFormPelamar] = useState<Isian | null>(null);
  const [tutupBaru, setTutupBaru] = useState("");
  const [pesan, setPesan] = useState("");
  const { sibuk, jalankan } = useKirim(setPesan);

  const muat = useCallback(() => {
    ambilPelamar(lowongan.id_lowongan)
      .then((d) => setPelamar(d.pelamar))
      .catch((error: unknown) =>
        setPesan(pesanGalat(error, "Pelamar gagal dimuat.")),
      );
  }, [lowongan.id_lowongan]);
  useEffect(muat, [muat]);

  const ditutup = lowongan.status === "Ditutup";
  const saranSumber = useMemo(
    () =>
      [
        ...new Set([
          ...SARAN_SUMBER,
          ...pelamar.map((p) => p.sumber ?? "").filter(Boolean),
        ]),
      ].sort(),
    [pelamar],
  );

  const ubahStatus = async (aksi: "tutup" | "buka") => {
    const lanjut = await konfirmasiData([
      { label: "Lowongan", nilai: lowongan.judul },
      {
        label: "Tindakan",
        nilai:
          aksi === "tutup"
            ? "Tutup lowongan; masa simpan data pelamar mulai berjalan."
            : "Buka lagi; masa simpan data pelamar diulang dari nol.",
      },
      {
        label: "Rencana tutup baru",
        nilai: aksi === "buka" ? tutupBaru || "Tanpa tanggal" : null,
      },
    ]);
    if (!lanjut) return;
    const ok = await jalankan(async () => {
      await simpanLowongan({
        id_lowongan: lowongan.id_lowongan,
        aksi,
        tanggal_tutup: tutupBaru || null,
      });
      return aksi === "tutup" ? "Lowongan ditutup." : "Lowongan dibuka lagi.";
    }, "Status lowongan gagal diubah.");
    if (ok) {
      setTutupBaru("");
      onBerubah();
    }
  };

  const terpilih = pelamar.find((p) => p.id_pelamar === dipilih) ?? null;

  return (
    <>
      <div className={`${KARTU} space-y-3`}>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <h2 className="text-lg font-bold text-white">{lowongan.judul}</h2>
            <p className="text-xs text-slate-400">
              <span className={WARNA_LOWONGAN[lowongan.status] ?? ""}>
                {lowongan.status}
              </span>{" "}
              • dibuka {lowongan.tanggal_buka}
              {lowongan.tanggal_tutup
                ? ` • rencana tutup ${lowongan.tanggal_tutup}`
                : ""}
              {lowongan.jabatan_nama ? ` • ${lowongan.jabatan_nama}` : ""}
              {lowongan.divisi_nama ? ` • ${lowongan.divisi_nama}` : ""}
              {lowongan.cabang_nama ? ` • ${lowongan.cabang_nama}` : ""}
            </p>
            <p className="text-xs text-slate-400">
              Diterima {lowongan.hitungan.Diterima ?? 0} dari {lowongan.jumlah}{" "}
              dibutuhkan • {lowongan.jadi_karyawan} sudah menjadi karyawan
              {lowongan.pelamar_dihapus > 0
                ? ` • ${lowongan.pelamar_dihapus} data pelamar sudah dihapus`
                : ""}
            </p>
            {lowongan.lewat_kuota ? (
              <p className="text-xs text-amber-200">
                Pelamar diterima melebihi jumlah yang dibutuhkan.
              </p>
            ) : null}
            {lowongan.menggantung > 0 ? (
              <p className="text-xs text-amber-200">
                {lowongan.menggantung} pelamar masih di tahap proses; datanya
                tetap ikut dihapus saat masa simpan habis.
              </p>
            ) : null}
            {lowongan.tanggal_hapus ? (
              <p
                className={`text-xs ${lowongan.tanggal_hapus <= tambahHari(hariIni, 30) ? "text-amber-200" : "text-slate-400"}`}
              >
                Data pelamar yang belum menjadi karyawan dihapus pada{" "}
                {lowongan.tanggal_hapus}.
              </p>
            ) : null}
          </div>
          {bolehUbah ? (
            <div className="flex flex-wrap items-end gap-2">
              {!ditutup ? (
                <>
                  <button
                    type="button"
                    className={TOMBOL_KEDUA}
                    onClick={onUbah}
                  >
                    Ubah
                  </button>
                  <button
                    id="lowongan-tutup-tombol"
                    type="button"
                    className={TOMBOL_KEDUA}
                    disabled={sibuk}
                    onClick={() => void ubahStatus("tutup")}
                  >
                    Tutup
                  </button>
                </>
              ) : (
                <>
                  <div>
                    <label htmlFor="lowongan-tutup-baru" className={LABEL}>
                      Rencana tutup baru
                    </label>
                    <input
                      id="lowongan-tutup-baru"
                      type="date"
                      value={tutupBaru}
                      min={hariIni}
                      onChange={(e) => setTutupBaru(e.target.value)}
                      className={KELAS}
                    />
                  </div>
                  <button
                    id="lowongan-buka-tombol"
                    type="button"
                    className={TOMBOL_KEDUA}
                    disabled={sibuk}
                    onClick={() => void ubahStatus("buka")}
                  >
                    Buka lagi
                  </button>
                </>
              )}
            </div>
          ) : null}
        </div>
        {lowongan.keterangan ? (
          <p className="whitespace-pre-wrap text-sm text-slate-300">
            {lowongan.keterangan}
          </p>
        ) : null}
        {pesan ? <p className="text-sm text-amber-200">{pesan}</p> : null}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-bold text-white">Pelamar</h3>
          {bolehUbah && lowongan.status !== "Dijadwalkan" ? (
            <button
              id="pelamar-baru"
              type="button"
              className={TOMBOL_KEDUA}
              onClick={() => {
                setDipilih(null);
                setFormPelamar({
                  id_lowongan: lowongan.id_lowongan,
                  tanggal_lamaran: hariIni,
                });
              }}
            >
              Pelamar baru
            </button>
          ) : null}
        </div>
        <ul className="space-y-1">
          {pelamar.map((p) => (
            <li key={p.id_pelamar}>
              <button
                type="button"
                onClick={() => {
                  setFormPelamar(null);
                  setDipilih(p.id_pelamar);
                }}
                className={`w-full rounded-xl px-3 py-2 text-left ${dipilih === p.id_pelamar ? "bg-sky-500/20" : "hover:bg-slate-800"}`}
              >
                <span className="flex flex-wrap items-baseline gap-x-2">
                  <span className="font-semibold text-white">{p.nama}</span>
                  <span
                    className={`text-xs ${WARNA_TAHAP[p.status ?? ""] ?? "text-sky-200"}`}
                  >
                    {p.status ?? "-"}
                  </span>
                  <span className="text-xs text-slate-400">
                    melamar {p.tanggal_lamaran}
                    {p.sumber ? ` • ${p.sumber}` : ""}
                  </span>
                </span>
                {p.id_karyawan ? (
                  <span
                    className={`block text-xs ${p.karyawan_ada ? "text-emerald-200" : "text-amber-200"}`}
                  >
                    {p.karyawan_ada
                      ? "Sudah menjadi karyawan"
                      : "Diterima, data karyawan belum lengkap"}
                  </span>
                ) : null}
                {p.mungkin_ganda ? (
                  <span className="block text-xs text-amber-200">
                    Mungkin tercatat ganda (nama dan nomor HP sama)
                  </span>
                ) : null}
              </button>
            </li>
          ))}
          {pelamar.length === 0 ? (
            <li className="text-sm text-slate-400">Belum ada pelamar.</li>
          ) : null}
        </ul>
      </div>
      {formPelamar ? (
        <FormPelamar
          awal={formPelamar}
          saranSumber={saranSumber}
          onBatal={() => setFormPelamar(null)}
          onTersimpan={(id) => {
            setFormPelamar(null);
            setDipilih(id);
            muat();
            onBerubah();
          }}
        />
      ) : terpilih ? (
        <RincianPelamar
          key={terpilih.id_pelamar}
          ringkas={terpilih}
          lowongan={lowongan}
          hariIni={hariIni}
          karyawan={karyawan}
          org={org}
          bolehUbah={bolehUbah}
          bolehHapus={bolehHapus}
          bolehJadikan={bolehJadikan}
          onUbah={(p) =>
            setFormPelamar({
              id_pelamar: p.id_pelamar,
              id_lowongan: p.id_lowongan,
              nama: p.nama,
              no_hp: p.no_hp ?? "",
              email: p.email ?? "",
              lp: p.lp ?? "",
              tanggal_lahir: p.tanggal_lahir ?? "",
              alamat: p.alamat ?? "",
              pendidikan: p.pendidikan ?? "",
              sumber: p.sumber ?? "",
              tanggal_lamaran: p.tanggal_lamaran,
              catatan: p.catatan ?? "",
            })
          }
          onBerubah={() => {
            muat();
            onBerubah();
          }}
          onTerhapus={() => {
            setDipilih(null);
            muat();
            onBerubah();
          }}
        />
      ) : null}
    </>
  );
}

function FormPelamar({
  awal,
  saranSumber,
  onBatal,
  onTersimpan,
}: {
  awal: Isian;
  saranSumber: string[];
  onBatal: () => void;
  onTersimpan: (id: string) => void;
}) {
  const [isi, setIsi] = useState<Isian>(awal);
  const [pesan, setPesan] = useState("");
  const { sibuk, jalankan } = useKirim(setPesan);
  const ubah = (kunci: string, nilai: string) =>
    setIsi((lama) => ({ ...lama, [kunci]: nilai }));
  const teks = (
    kunci: string,
    label: string,
    jenis: "text" | "date" | "email" | "tel" = "text",
    lebar = false,
  ) => (
    <div className={lebar ? "sm:col-span-2" : ""}>
      <label htmlFor={`pelamar-${kunci}`} className={LABEL}>
        {label}
      </label>
      <input
        id={`pelamar-${kunci}`}
        type={jenis}
        value={isi[kunci] ?? ""}
        list={kunci === "sumber" ? "pelamar-sumber-saran" : undefined}
        onChange={(e) => ubah(kunci, e.target.value)}
        className={KELAS}
      />
    </div>
  );

  const simpan = async () => {
    const lanjut = await konfirmasiData([
      { label: "Nama", nilai: isi.nama },
      { label: "Nomor HP", nilai: isi.no_hp },
      { label: "Email", nilai: isi.email },
      { label: "Tanggal lamaran", nilai: isi.tanggal_lamaran },
      { label: "Sumber", nilai: isi.sumber },
    ]);
    if (!lanjut) return;
    let id = "";
    const ok = await jalankan(async () => {
      id = (await simpanPelamar(kosongKeNull(isi))).id_pelamar;
      return "Pelamar tersimpan.";
    }, "Pelamar gagal disimpan.");
    if (ok) onTersimpan(id);
  };

  return (
    <div className={`${KARTU} space-y-3`}>
      <h3 className="text-sm font-bold text-white">
        {awal.id_pelamar ? "Ubah pelamar" : "Pelamar baru"}
      </h3>
      <div className="grid gap-3 sm:grid-cols-2">
        {teks("nama", "Nama", "text", true)}
        {teks("no_hp", "Nomor HP", "tel")}
        {teks("email", "Email", "email")}
        <div>
          <label htmlFor="pelamar-lp" className={LABEL}>
            Jenis kelamin
          </label>
          <select
            id="pelamar-lp"
            value={isi.lp ?? ""}
            onChange={(e) => ubah("lp", e.target.value)}
            className={KELAS}
          >
            <option value="">-</option>
            <option value="L">Laki-laki</option>
            <option value="P">Perempuan</option>
          </select>
        </div>
        {teks("tanggal_lahir", "Tanggal lahir", "date")}
        <div>
          <label htmlFor="pelamar-pendidikan" className={LABEL}>
            Pendidikan
          </label>
          <select
            id="pelamar-pendidikan"
            value={isi.pendidikan ?? ""}
            onChange={(e) => ubah("pendidikan", e.target.value)}
            className={KELAS}
          >
            <option value="">-</option>
            {PENDIDIKAN.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </div>
        {teks("tanggal_lamaran", "Tanggal lamaran", "date")}
        {teks("sumber", "Sumber")}
        <datalist id="pelamar-sumber-saran">
          {saranSumber.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
        {teks("alamat", "Alamat", "text", true)}
        <div className="sm:col-span-2">
          <label htmlFor="pelamar-catatan" className={LABEL}>
            Catatan
          </label>
          <textarea
            id="pelamar-catatan"
            value={isi.catatan ?? ""}
            maxLength={2000}
            onChange={(e) => ubah("catatan", e.target.value)}
            className={`${KELAS} min-h-20 py-2`}
          />
        </div>
      </div>
      <p className="text-xs text-slate-400">
        NIK, KK, dan rekening baru diisi di data pribadi setelah pelamar menjadi
        karyawan.
      </p>
      {pesan ? <p className="text-sm text-amber-200">{pesan}</p> : null}
      <div className="flex flex-wrap gap-2">
        <button
          id="pelamar-simpan"
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

function RincianPelamar({
  ringkas,
  lowongan,
  hariIni,
  karyawan,
  org,
  bolehUbah,
  bolehHapus,
  bolehJadikan,
  onUbah,
  onBerubah,
  onTerhapus,
}: {
  ringkas: Pelamar;
  lowongan: Lowongan;
  hariIni: string;
  karyawan: BarisKaryawan[];
  org: Organisasi | null;
  bolehUbah: boolean;
  bolehHapus: boolean;
  bolehJadikan: boolean;
  onUbah: (p: Pelamar) => void;
  onBerubah: () => void;
  onTerhapus: () => void;
}) {
  const [pelamar, setPelamar] = useState<Pelamar>(ringkas);
  const [tahap, setTahap] = useState<TahapPelamar[]>([]);
  const [berkas, setBerkas] = useState<BerkasRingkas[]>([]);
  const [isiTahap, setIsiTahap] = useState<Isian>({
    tahap: "Wawancara",
    tanggal: hariIni,
    catatan: "",
  });
  const [alasanBatal, setAlasanBatal] = useState("");
  const [ketikHapus, setKetikHapus] = useState("");
  const [jadikan, setJadikan] = useState(false);
  const [pesan, setPesan] = useState("");
  const { sibuk, jalankan } = useKirim(setPesan);

  const muat = useCallback(() => {
    ambilRincianPelamar(ringkas.id_pelamar)
      .then((d) => {
        setPelamar(d.pelamar);
        setTahap(d.tahap);
        setBerkas(d.berkas);
      })
      .catch((error: unknown) =>
        setPesan(pesanGalat(error, "Rincian pelamar gagal dimuat.")),
      );
  }, [ringkas.id_pelamar]);
  useEffect(muat, [muat]);

  const terkunci = pelamar.id_karyawan !== null;
  const akhir = (TAHAP_AKHIR as readonly string[]).includes(
    pelamar.status ?? "",
  );
  const lanjutkan = terkunci && !pelamar.karyawan_ada;
  const berlaku = tahap.filter((t) => !t.dibatalkan_pada);
  const terakhir = berlaku[berlaku.length - 1];

  const sesudah = (pesanBerhasil: string) => async () => {
    muat();
    onBerubah();
    return pesanBerhasil;
  };

  const catat = async () => {
    const lanjut = await konfirmasiData([
      { label: "Pelamar", nilai: pelamar.nama },
      { label: "Tahap", nilai: isiTahap.tahap },
      { label: "Tanggal", nilai: isiTahap.tanggal },
      { label: "Catatan", nilai: isiTahap.catatan },
    ]);
    if (!lanjut) return;
    const ok = await jalankan(async () => {
      await catatTahap({ id_pelamar: pelamar.id_pelamar, ...isiTahap });
      return sesudah("Tahap tercatat.")();
    }, "Tahap gagal dicatat.");
    if (ok) setIsiTahap((lama) => ({ ...lama, catatan: "" }));
  };

  const batalTahap = () =>
    jalankan(async () => {
      await catatTahap({
        id_pelamar: pelamar.id_pelamar,
        aksi: "batal",
        alasan: alasanBatal,
      });
      setAlasanBatal("");
      return sesudah("Tahap terakhir dibatalkan.")();
    }, "Tahap gagal dibatalkan.");

  const unggah = async (file: File | undefined) => {
    if (!file) return;
    if (!mimeBerkasSah(file)) {
      setPesan(PESAN_MIME_BERKAS);
      return;
    }
    await jalankan(async () => {
      await simpanBerkasPelamar({
        id_pelamar: pelamar.id_pelamar,
        nama_berkas: file.name,
        mime_type: file.type,
        data_base64: await bacaBase64(file),
      });
      return sesudah("Berkas terunggah.")();
    }, "Berkas gagal diunggah.");
  };

  const hapus = () =>
    jalankan(async () => {
      await hapusPelamar(pelamar.id_pelamar);
      onTerhapus();
      return "Data pelamar dihapus.";
    }, "Pelamar gagal dihapus.");

  return (
    <div className={`${KARTU} space-y-4`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-lg font-bold text-white">{pelamar.nama}</h3>
          <p className="text-xs text-slate-400">
            {[
              pelamar.no_hp,
              pelamar.email,
              pelamar.lp === "L"
                ? "Laki-laki"
                : pelamar.lp === "P"
                  ? "Perempuan"
                  : null,
              pelamar.tanggal_lahir ? `lahir ${pelamar.tanggal_lahir}` : null,
              pelamar.pendidikan,
            ]
              .filter(Boolean)
              .join(" • ") || "Tanpa kontak"}
          </p>
          {pelamar.alamat ? (
            <p className="text-xs text-slate-400">{pelamar.alamat}</p>
          ) : null}
          {pelamar.catatan ? (
            <p className="whitespace-pre-wrap text-sm text-slate-300">
              {pelamar.catatan}
            </p>
          ) : null}
        </div>
        {bolehUbah && !terkunci ? (
          <button
            type="button"
            className={TOMBOL_KEDUA}
            onClick={() => onUbah(pelamar)}
          >
            Ubah data
          </button>
        ) : null}
      </div>
      {terkunci ? (
        <p
          className={`text-sm ${pelamar.karyawan_ada ? "text-emerald-200" : "text-amber-200"}`}
        >
          {pelamar.karyawan_ada
            ? `Sudah menjadi karyawan (${pelamar.id_karyawan}) sejak ${pelamar.dijadikan_pada ?? "-"}. Data pelamar terkunci dan tidak ikut dihapus.`
            : "Diterima, data karyawan belum lengkap. Tekan Lanjutkan untuk menyelesaikannya dengan id yang sama."}
        </p>
      ) : null}
      {pesan ? <p className="text-sm text-amber-200">{pesan}</p> : null}

      <section className="space-y-2">
        <h4 className="text-sm font-bold text-white">Riwayat tahap</h4>
        <ol className="space-y-1">
          {tahap.map((t) => (
            <li
              key={t.id_tahap}
              className={`rounded-xl border border-slate-800 px-3 py-2 text-sm ${t.dibatalkan_pada ? "opacity-60" : ""}`}
            >
              <span className="flex flex-wrap items-baseline gap-x-2">
                <span
                  className={`font-semibold ${t.dibatalkan_pada ? "text-slate-400 line-through" : (WARNA_TAHAP[t.tahap] ?? "text-white")}`}
                >
                  {t.urutan}. {t.tahap}
                </span>
                <span className="text-xs text-slate-400">
                  {t.tanggal} • {t.oleh}
                </span>
              </span>
              {t.catatan ? (
                <span className="block text-xs text-slate-300">
                  {t.catatan}
                </span>
              ) : null}
              {t.dibatalkan_pada ? (
                <span className="block text-xs text-slate-400">
                  Dibatalkan {t.dibatalkan_oleh}: {t.alasan_batal}
                </span>
              ) : null}
            </li>
          ))}
        </ol>
        {bolehUbah && !terkunci && !akhir ? (
          <div className="grid gap-2 sm:grid-cols-[10rem_10rem_minmax(0,1fr)_auto] sm:items-end">
            <div>
              <label htmlFor="tahap-pilih" className={LABEL}>
                Tahap
              </label>
              <select
                id="tahap-pilih"
                value={isiTahap.tahap}
                onChange={(e) =>
                  setIsiTahap((l) => ({ ...l, tahap: e.target.value }))
                }
                className={KELAS}
              >
                {TAHAP.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="tahap-tanggal" className={LABEL}>
                Tanggal
              </label>
              <input
                id="tahap-tanggal"
                type="date"
                max={hariIni}
                value={isiTahap.tanggal}
                onChange={(e) =>
                  setIsiTahap((l) => ({ ...l, tanggal: e.target.value }))
                }
                className={KELAS}
              />
            </div>
            <div className="min-w-0">
              <label htmlFor="tahap-catatan" className={LABEL}>
                Catatan
                {isiTahap.tahap === "Ditolak" || isiTahap.tahap === "Mundur"
                  ? " (wajib)"
                  : ""}
              </label>
              <input
                id="tahap-catatan"
                value={isiTahap.catatan}
                maxLength={1000}
                onChange={(e) =>
                  setIsiTahap((l) => ({ ...l, catatan: e.target.value }))
                }
                className={KELAS}
              />
            </div>
            <button
              id="tahap-catat"
              type="button"
              className={TOMBOL}
              disabled={sibuk}
              onClick={() => void catat()}
            >
              Catat
            </button>
          </div>
        ) : null}
        {bolehUbah && !terkunci && terakhir && terakhir.urutan > 1 ? (
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-0 flex-1">
              <label htmlFor="tahap-alasan-batal" className={LABEL}>
                Alasan membatalkan tahap {terakhir.tahap}
              </label>
              <input
                id="tahap-alasan-batal"
                value={alasanBatal}
                maxLength={1000}
                onChange={(e) => setAlasanBatal(e.target.value)}
                className={KELAS}
              />
            </div>
            <button
              id="tahap-batal"
              type="button"
              className={TOMBOL_KEDUA}
              disabled={sibuk || !alasanBatal.trim()}
              onClick={() => void batalTahap()}
            >
              Batalkan tahap terakhir
            </button>
          </div>
        ) : null}
      </section>

      <section className="space-y-2">
        <h4 className="text-sm font-bold text-white">
          Berkas lamaran ({berkas.length}/{MAKS_BERKAS_PER_PELAMAR})
        </h4>
        <div className="flex flex-wrap gap-2">
          {berkas.map((b) => (
            <span key={b.id_berkas} className="flex items-center gap-1">
              <button
                type="button"
                className={TOMBOL_KEDUA}
                onClick={() =>
                  ambilBerkasPelamar(b.id_berkas)
                    .then(bukaBerkas)
                    .catch((error: unknown) =>
                      setPesan(pesanGalat(error, "Berkas gagal dibuka.")),
                    )
                }
              >
                {b.nama_berkas ?? `Berkas ${b.urutan}`}
              </button>
              {bolehUbah && !terkunci ? (
                <button
                  type="button"
                  aria-label={`Hapus ${b.nama_berkas ?? `berkas ${b.urutan}`}`}
                  className={TOMBOL_KEDUA}
                  disabled={sibuk}
                  onClick={() =>
                    void jalankan(async () => {
                      await simpanBerkasPelamar({
                        aksi: "hapus",
                        id_berkas: b.id_berkas,
                      });
                      return sesudah("Berkas dihapus.")();
                    }, "Berkas gagal dihapus.")
                  }
                >
                  Hapus
                </button>
              ) : null}
            </span>
          ))}
          {berkas.length === 0 ? (
            <span className="text-xs text-slate-400">Tanpa berkas.</span>
          ) : null}
        </div>
        {bolehUbah && !terkunci && berkas.length < MAKS_BERKAS_PER_PELAMAR ? (
          <div>
            <label htmlFor="pelamar-unggah" className={LABEL}>
              Unggah CV atau berkas lain (JPEG, PNG, WEBP, PDF, maks 1 MB)
            </label>
            <input
              id="pelamar-unggah"
              type="file"
              accept="image/jpeg,image/png,image/webp,application/pdf"
              disabled={sibuk}
              onChange={(e) => {
                void unggah(e.target.files?.[0]);
                e.target.value = "";
              }}
              className="text-xs text-slate-300"
            />
          </div>
        ) : null}
      </section>

      {bolehJadikan &&
      ((pelamar.status === "Diterima" && !terkunci) || lanjutkan) ? (
        jadikan ? (
          <FormJadikan
            pelamar={pelamar}
            lowongan={lowongan}
            hariIni={hariIni}
            karyawan={karyawan}
            org={org}
            onBatal={() => setJadikan(false)}
            onSelesai={(pesanSelesai) => {
              setJadikan(false);
              setPesan(pesanSelesai);
              muat();
              onBerubah();
            }}
          />
        ) : (
          <button
            id="pelamar-jadikan"
            type="button"
            className={TOMBOL}
            onClick={() => setJadikan(true)}
          >
            {lanjutkan ? "Lanjutkan" : "Jadikan karyawan"}
          </button>
        )
      ) : null}

      {bolehHapus && !terkunci ? (
        <section className="space-y-2 rounded-xl border border-rose-900/60 p-3">
          <h4 className="text-sm font-bold text-rose-200">Hapus permanen</h4>
          <p className="text-xs text-slate-400">
            Data, tahap, dan berkas pelamar ini dihapus sekarang dan tidak bisa
            dikembalikan. Lowongan hanya menyimpan jumlah pelamar yang dihapus.
          </p>
          <label htmlFor="pelamar-ketik-hapus" className={LABEL}>
            Ketik {KONFIRMASI_HAPUS_PERMANEN} untuk melanjutkan
          </label>
          <div className="flex flex-wrap gap-2">
            <input
              id="pelamar-ketik-hapus"
              value={ketikHapus}
              onChange={(e) => setKetikHapus(e.target.value)}
              className={`${KELAS} max-w-xs`}
            />
            <button
              id="pelamar-hapus"
              type="button"
              className={TOMBOL_KEDUA}
              disabled={
                sibuk || ketikHapus.trim() !== KONFIRMASI_HAPUS_PERMANEN
              }
              onClick={() => void hapus()}
            >
              Hapus pelamar
            </button>
          </div>
        </section>
      ) : null}
    </div>
  );
}

function FormJadikan({
  pelamar,
  lowongan,
  hariIni,
  karyawan,
  org,
  onBatal,
  onSelesai,
}: {
  pelamar: Pelamar;
  lowongan: Lowongan;
  hariIni: string;
  karyawan: BarisKaryawan[];
  org: Organisasi | null;
  onBatal: () => void;
  onSelesai: (pesan: string) => void;
}) {
  const usulan = idDariPelamar(pelamar.id_pelamar);
  const [shift, setShift] = useState<Record<string, unknown>[]>([]);
  const [isi, setIsi] = useState<Isian>({
    nama: pelamar.nama,
    kode_karyawan: usulan.ok ? usulan.nilai.kode_karyawan : "",
    lp: pelamar.lp ?? "",
    no_hp: pelamar.no_hp ?? "",
    id_shift: "",
    tanggal_daftar: hariIni,
    id_divisi: lowongan.id_divisi ?? "",
    id_jabatan: lowongan.id_jabatan ?? "",
    id_cabang: lowongan.id_cabang ?? "",
    id_atasan: "",
    jenis: "PKWT",
    nomor: "",
    tanggal_mulai: hariIni,
    tanggal_selesai: "",
    percobaan_selesai: "",
  });
  const [pesan, setPesan] = useState("");
  const { sibuk, jalankan } = useKirim(setPesan);
  useEffect(() => {
    getDaftarShift()
      .then((d) => setShift(d as Record<string, unknown>[]))
      .catch(() => setShift([]));
  }, []);
  const ubah = (kunci: string, nilai: string) =>
    setIsi((lama) => ({ ...lama, [kunci]: nilai }));
  const kosong = (v: string) => (v.trim() === "" ? null : v);

  const kirim = async () => {
    if (isi.lp !== "L" && isi.lp !== "P") {
      setPesan("Jenis kelamin wajib dipilih.");
      return;
    }
    const lanjut = await konfirmasiData([
      { label: "Nama", nilai: isi.nama },
      { label: "Kode karyawan", nilai: isi.kode_karyawan },
      {
        label: "Divisi",
        nilai: org?.divisi.find((d) => d.id_divisi === isi.id_divisi)?.nama,
      },
      {
        label: "Shift",
        nilai: String(
          shift.find((s) => String(s.id_shift) === isi.id_shift)?.nama_shift ??
            "",
        ),
      },
      { label: "Tanggal masuk", nilai: isi.tanggal_daftar },
      { label: "Kontrak", nilai: isi.jenis },
      { label: "Kontrak mulai", nilai: isi.tanggal_mulai },
      { label: "Kontrak selesai", nilai: isi.tanggal_selesai },
    ]);
    if (!lanjut) return;
    await jalankan(async () => {
      const hasil = await jadikanKaryawan({
        id_pelamar: pelamar.id_pelamar,
        karyawan: {
          nama: isi.nama,
          kode_karyawan: isi.kode_karyawan,
          lp: isi.lp,
          no_hp: isi.no_hp,
          id_shift: Number(isi.id_shift),
          tanggal_daftar: isi.tanggal_daftar,
          tanggal_mulai_aktif: isi.tanggal_daftar,
          id_divisi: isi.id_divisi,
          id_jabatan: isi.id_jabatan,
          id_cabang: isi.id_cabang,
          id_atasan: isi.id_atasan,
        },
        kontrak: {
          jenis: isi.jenis,
          nomor: kosong(isi.nomor),
          tanggal_mulai: isi.tanggal_mulai,
          tanggal_selesai: kosong(isi.tanggal_selesai),
          percobaan_selesai: kosong(isi.percobaan_selesai),
        },
      });
      onSelesai(
        hasil.sudah_ada
          ? "Data karyawan sudah ada; tidak ada yang ditulis ulang."
          : `Pelamar menjadi karyawan ${hasil.id_unik}. Kartu ID dibuat dari menu Kartu ID.`,
      );
      return "";
    }, "Pelamar gagal dijadikan karyawan.");
  };

  const pilihOrg = (
    kunci: "id_divisi" | "id_jabatan" | "id_cabang",
    label: string,
    daftar: Array<{ id: string; nama: string; aktif: boolean }>,
  ) => (
    <PilihanOrg
      id={`jadikan-${kunci}`}
      label={label}
      value={isi[kunci] ?? ""}
      pilihan={daftar}
      onChange={(v) => ubah(kunci, v)}
    />
  );

  return (
    <section className="space-y-3 rounded-xl border border-sky-900/60 p-3">
      <h4 className="text-sm font-bold text-white">Jadikan karyawan</h4>
      <p className="text-xs text-slate-400">
        Id karyawan diturunkan dari id pelamar (
        {usulan.ok ? usulan.nilai.id_unik : "-"}), jadi pelamar ini tidak pernah
        menjadi dua karyawan. Kartu ID, akun operator, dan data keuangan diisi
        terpisah.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        {(
          [
            ["nama", "Nama", "text"],
            ["kode_karyawan", "Kode karyawan", "text"],
            ["no_hp", "Nomor HP", "tel"],
            ["tanggal_daftar", "Tanggal masuk", "date"],
          ] as const
        ).map(([kunci, label, jenis]) => (
          <div key={kunci}>
            <label htmlFor={`jadikan-${kunci}`} className={LABEL}>
              {label}
            </label>
            <input
              id={`jadikan-${kunci}`}
              type={jenis}
              value={isi[kunci] ?? ""}
              onChange={(e) => ubah(kunci, e.target.value)}
              className={KELAS}
            />
          </div>
        ))}
        <div>
          <label htmlFor="jadikan-lp" className={LABEL}>
            Jenis kelamin
          </label>
          <select
            id="jadikan-lp"
            value={isi.lp}
            onChange={(e) => ubah("lp", e.target.value)}
            className={KELAS}
          >
            <option value="">Pilih</option>
            <option value="L">Laki-laki</option>
            <option value="P">Perempuan</option>
          </select>
        </div>
        <div>
          <label htmlFor="jadikan-shift" className={LABEL}>
            Shift
          </label>
          <PilihCari
            id="jadikan-shift"
            value={isi.id_shift}
            onChange={(e) => ubah("id_shift", e.target.value)}
            className={KELAS}
          >
            <option value="">Pilih shift</option>
            {shift.map((s) => (
              <option key={String(s.id_shift)} value={String(s.id_shift)}>
                {String(s.nama_shift ?? s.id_shift)}
              </option>
            ))}
          </PilihCari>
        </div>
        {pilihOrg(
          "id_divisi",
          "Divisi",
          (org?.divisi ?? []).map((d) => ({
            id: d.id_divisi,
            nama: d.nama,
            aktif: d.is_aktif === 1,
          })),
        )}
        {pilihOrg(
          "id_jabatan",
          "Jabatan",
          (org?.jabatan ?? []).map((j) => ({
            id: j.id_jabatan,
            nama: j.nama,
            aktif: j.is_aktif === 1,
          })),
        )}
        {pilihOrg(
          "id_cabang",
          "Cabang",
          (org?.cabang ?? []).map((c) => ({
            id: c.id_cabang,
            nama: c.nama,
            aktif: c.is_aktif === 1,
          })),
        )}
        <div>
          <label htmlFor="jadikan-atasan" className={LABEL}>
            Atasan langsung
          </label>
          <PilihCari
            id="jadikan-atasan"
            value={isi.id_atasan}
            onChange={(e) => ubah("id_atasan", e.target.value)}
            className={KELAS}
          >
            <option value="">Tanpa atasan</option>
            {karyawan
              .filter((k) => k.status_aktif !== "Nonaktif")
              .map((k) => (
                <option key={String(k.id_unik)} value={String(k.id_unik)}>
                  {String(k.nama)}
                </option>
              ))}
          </PilihCari>
        </div>
      </div>
      <h5 className="text-xs font-bold text-slate-300">Kontrak pertama</h5>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor="jadikan-jenis" className={LABEL}>
            Jenis kontrak
          </label>
          <select
            id="jadikan-jenis"
            value={isi.jenis}
            onChange={(e) => ubah("jenis", e.target.value)}
            className={KELAS}
          >
            {JENIS_KONTRAK.map((j) => (
              <option key={j} value={j}>
                {j}
              </option>
            ))}
          </select>
        </div>
        {(
          [
            ["nomor", "Nomor kontrak", "text"],
            ["tanggal_mulai", "Mulai", "date"],
            ["tanggal_selesai", "Selesai (PKWT dan Magang)", "date"],
            ["percobaan_selesai", "Akhir masa percobaan (PKWTT)", "date"],
          ] as const
        ).map(([kunci, label, jenis]) => (
          <div key={kunci}>
            <label htmlFor={`jadikan-${kunci}`} className={LABEL}>
              {label}
            </label>
            <input
              id={`jadikan-${kunci}`}
              type={jenis}
              value={isi[kunci] ?? ""}
              onChange={(e) => ubah(kunci, e.target.value)}
              className={KELAS}
            />
          </div>
        ))}
      </div>
      {pesan ? <p className="text-sm text-amber-200">{pesan}</p> : null}
      <div className="flex flex-wrap gap-2">
        <button
          id="jadikan-kirim"
          type="button"
          className={TOMBOL}
          disabled={sibuk}
          onClick={() => void kirim()}
        >
          Jadikan karyawan
        </button>
        <button type="button" className={TOMBOL_KEDUA} onClick={onBatal}>
          Batal
        </button>
      </div>
    </section>
  );
}
