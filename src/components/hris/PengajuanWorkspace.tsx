"use client";

// Pengajuan cuti, izin, sakit (HRIS v37, prd-hris.md §17). Satu komponen untuk
// Web/Desktop dan Mobile (Q-52). Tombol hanya disembunyikan bila jelas tidak
// berhak; aturan sebenarnya (tidak untuk diri sendiri, pemutus per jenis,
// periode gaji dibayar) dinilai backend (aturan 10).

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  INPUT,
  LABEL,
  pesanGalat,
  TOMBOL_BAHAYA,
  TOMBOL_KEDUA,
  TOMBOL_UTAMA,
} from "@/components/inventory/gaya";
import { konfirmasiData } from "@/components/ui/KonfirmasiData";
import { PilihCari } from "@/components/ui/PilihCari";
import { hasPermission } from "@/lib/auth/access";
import { useAuth } from "@/lib/context/AuthContext";
import { getDaftarKaryawan } from "@/lib/gateways/employee";
import {
  type AkhirPeriode,
  ambilAkhirPeriode,
  ambilIsiLampiran,
  ambilJatahCuti,
  ambilLampiran,
  ambilPengajuan,
  ambilRiwayatKeputusan,
  type BarisDaftarPengajuan,
  hapusLampiran,
  type KeputusanRiwayat,
  type LampiranRingkas,
  prosesAkhirPeriode,
  putuskanPengajuan,
  simpanPengajuan,
  tambahLampiran,
} from "@/lib/gateways/hr-pengajuan";
import { SYNC_COMPLETED_EVENT, syncNow } from "@/lib/gateways/sync-status";
import type { PermissionKey } from "@/lib/rbac/catalog";
import {
  type JenisPengajuan,
  KELOMPOK_AKTIF,
  LABEL_TANDA_PENGAJUAN,
} from "@/lib/validations/hr-pengajuan";

type Saring = "menunggu" | "diketahui" | "tinjau" | "semua" | "diuangkan";

const ISIAN_KOSONG = {
  id_pengajuan: "",
  id_karyawan: "",
  id_jenis: "",
  tanggal_mulai: "",
  tanggal_selesai: "",
  setengah_hari: false,
  alasan: "",
  urgent: false,
};

const WARNA_STATUS: Record<string, string> = {
  Menunggu: "bg-amber-500/15 text-amber-200",
  Disetujui: "bg-emerald-500/15 text-emerald-200",
  "Disetujui (urgent)": "bg-emerald-500/15 text-emerald-200",
  Ditolak: "bg-rose-500/15 text-rose-200",
  Dibatalkan: "bg-slate-700 text-slate-300",
};

function bacaBase64(berkas: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const pembaca = new FileReader();
    pembaca.onload = () => resolve(String(pembaca.result).split(",")[1] ?? "");
    pembaca.onerror = () => reject(new Error("Berkas tidak terbaca."));
    pembaca.readAsDataURL(berkas);
  });
}

export function PengajuanWorkspace() {
  const { user } = useAuth();
  const boleh = useCallback(
    (izin: string) => hasPermission(user, izin as PermissionKey),
    [user],
  );
  const [daftar, setDaftar] = useState<BarisDaftarPengajuan[]>([]);
  const [jenis, setJenis] = useState<JenisPengajuan[]>([]);
  const [karyawan, setKaryawan] = useState<Record<string, unknown>[]>([]);
  const [saring, setSaring] = useState<Saring>("menunggu");
  const [dari, setDari] = useState("");
  const [sampai, setSampai] = useState("");
  const [buka, setBuka] = useState<string | null>(null);
  const [isi, setIsi] = useState(ISIAN_KOSONG);
  const [formBuka, setFormBuka] = useState(false);
  const [sisaJatah, setSisaJatah] = useState<number | null>(null);
  const [pesan, setPesan] = useState("");
  const [sibuk, setSibuk] = useState(false);

  const muat = useCallback(async () => {
    try {
      const hasil = await ambilPengajuan({
        ...(dari ? { dari } : {}),
        ...(sampai ? { sampai } : {}),
      });
      setDaftar(hasil.pengajuan);
      setJenis(hasil.jenis);
    } catch (error) {
      setPesan(pesanGalat(error, "Pengajuan gagal dimuat."));
    }
  }, [dari, sampai]);

  useEffect(() => {
    void muat();
    const dengar = () => void muat();
    window.addEventListener(SYNC_COMPLETED_EVENT, dengar);
    return () => window.removeEventListener(SYNC_COMPLETED_EVENT, dengar);
  }, [muat]);

  useEffect(() => {
    if (!formBuka || karyawan.length > 0) return;
    getDaftarKaryawan({})
      .then((d) => setKaryawan(d.filter((k) => k.status_aktif !== "Nonaktif")))
      .catch(() => setKaryawan([]));
  }, [formBuka, karyawan.length]);

  const jenisDipilih = jenis.find((j) => j.id_jenis === isi.id_jenis) ?? null;

  // Sisa jatah periode berjalan, hanya untuk jenis yang memotong jatah.
  useEffect(() => {
    setSisaJatah(null);
    if (!isi.id_karyawan || !jenisDipilih?.potong_jatah) return;
    ambilJatahCuti(isi.id_karyawan)
      .then((j) => {
        const acuan =
          isi.tanggal_mulai || new Date().toISOString().slice(0, 10);
        const p = j.periode.find(
          (x) => !x.sebelum_berhak && x.mulai <= acuan && x.selesai >= acuan,
        );
        setSisaJatah(p ? p.sisa : null);
      })
      .catch(() => setSisaJatah(null));
  }, [isi.id_karyawan, isi.tanggal_mulai, jenisDipilih?.potong_jatah]);

  const tampil = useMemo(
    () =>
      daftar.filter((b) => {
        if (saring === "menunggu") return b.status === "Menunggu";
        if (saring === "diketahui") return b.tanda.includes("perlu_diketahui");
        if (saring === "tinjau") return b.tanda.length > 0;
        return true;
      }),
    [daftar, saring],
  );

  const jalankan = async (kerja: () => Promise<unknown>, berhasil: string) => {
    setSibuk(true);
    try {
      await kerja();
      setPesan(berhasil);
      await muat();
      return true;
    } catch (error) {
      setPesan(pesanGalat(error, "Gagal."));
      return false;
    } finally {
      setSibuk(false);
    }
  };

  const ajukan = async () => {
    const namaKaryawan = karyawan.find(
      (k) => String(k.id_unik) === isi.id_karyawan,
    )?.nama;
    const lanjut = await konfirmasiData([
      { label: "Karyawan", nilai: namaKaryawan ? String(namaKaryawan) : "" },
      { label: "Jenis", nilai: jenisDipilih?.nama },
      {
        label: "Tanggal",
        nilai:
          isi.tanggal_mulai === isi.tanggal_selesai
            ? isi.tanggal_mulai
            : `${isi.tanggal_mulai} s.d. ${isi.tanggal_selesai}`,
      },
      ...(isi.setengah_hari ? [{ label: "Setengah hari", nilai: "Ya" }] : []),
      { label: "Alasan", nilai: isi.alasan },
      ...(isi.urgent
        ? [{ label: "Urgent", nilai: "Ya, langsung berlaku" }]
        : []),
    ]);
    if (!lanjut) return;
    const { id_pengajuan, ...sisa } = isi;
    const ok = await jalankan(
      () =>
        simpanPengajuan({
          ...sisa,
          ...(id_pengajuan ? { id_pengajuan } : {}),
        }),
      "Pengajuan tersimpan.",
    );
    if (ok) {
      setIsi(ISIAN_KOSONG);
      setFormBuka(false);
    }
  };

  const sunting = (b: BarisDaftarPengajuan) => {
    const p = b.pengajuan;
    setIsi({
      id_pengajuan: p.id_pengajuan,
      id_karyawan: p.id_karyawan,
      id_jenis: p.id_jenis,
      tanggal_mulai: p.tanggal_mulai,
      tanggal_selesai: p.tanggal_selesai,
      setengah_hari: p.setengah_hari,
      alasan: p.alasan,
      urgent: false,
    });
    setFormBuka(true);
  };

  const pilihanSaring: Array<[Saring, string]> = [
    ["menunggu", "Menunggu"],
    ["diketahui", "Perlu diketahui"],
    ["tinjau", "Perlu ditinjau"],
    ["semua", "Semua"],
    ["diuangkan", "Cuti diuangkan"],
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-2">
        <div
          className="flex flex-wrap gap-2"
          role="tablist"
          aria-label="Saring pengajuan"
        >
          {pilihanSaring.map(([id, label]) => (
            <button
              key={id}
              id={`pengajuan-saring-${id}`}
              type="button"
              role="tab"
              aria-selected={saring === id}
              onClick={() => setSaring(id)}
              className={`min-h-10 rounded-xl px-3 text-sm font-bold ${saring === id ? "bg-sky-500 text-white" : "bg-slate-900 text-slate-300"}`}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="ml-auto flex flex-wrap gap-2">
          <button
            type="button"
            id="pengajuan-muat-ulang"
            className={TOMBOL_KEDUA}
            disabled={sibuk}
            onClick={() =>
              void syncNow()
                .catch(() => undefined)
                .then(muat)
            }
          >
            Muat ulang
          </button>
          {boleh("hr.request.submit") ? (
            <button
              type="button"
              id="pengajuan-baru"
              className={TOMBOL_UTAMA}
              onClick={() => {
                setIsi(ISIAN_KOSONG);
                setFormBuka((b) => !b);
              }}
            >
              {formBuka ? "Tutup form" : "Ajukan"}
            </button>
          ) : null}
        </div>
      </div>

      {saring !== "diuangkan" ? (
        <div className="grid grid-cols-2 gap-2 sm:max-w-md">
          <div>
            <label className={LABEL} htmlFor="pengajuan-dari">
              Dari
            </label>
            <input
              id="pengajuan-dari"
              type="date"
              className={INPUT}
              value={dari}
              onChange={(e) => setDari(e.target.value)}
            />
          </div>
          <div>
            <label className={LABEL} htmlFor="pengajuan-sampai">
              Sampai
            </label>
            <input
              id="pengajuan-sampai"
              type="date"
              className={INPUT}
              value={sampai}
              onChange={(e) => setSampai(e.target.value)}
            />
          </div>
        </div>
      ) : null}

      {pesan ? (
        <output className="block text-sm text-slate-300">{pesan}</output>
      ) : null}

      {formBuka ? (
        <div className="grid gap-3 rounded-2xl border border-slate-800 bg-slate-900 p-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <label className={LABEL} htmlFor="pengajuan-karyawan">
              Karyawan
            </label>
            <PilihCari
              id="pengajuan-karyawan"
              value={isi.id_karyawan}
              disabled={Boolean(isi.id_pengajuan)}
              onChange={(e) => setIsi({ ...isi, id_karyawan: e.target.value })}
            >
              <option value="">Pilih karyawan</option>
              {karyawan.map((k) => (
                <option key={String(k.id_unik)} value={String(k.id_unik)}>
                  {String(k.nama)} • {String(k.divisi || "-")}
                </option>
              ))}
            </PilihCari>
          </div>
          <div className="sm:col-span-2">
            <label className={LABEL} htmlFor="pengajuan-jenis">
              Jenis
            </label>
            <PilihCari
              id="pengajuan-jenis"
              value={isi.id_jenis}
              onChange={(e) =>
                setIsi({
                  ...isi,
                  id_jenis: e.target.value,
                  setengah_hari: false,
                  urgent: false,
                })
              }
            >
              <option value="">Pilih jenis</option>
              {jenis
                .filter(
                  (j) =>
                    j.is_aktif &&
                    (KELOMPOK_AKTIF as readonly string[]).includes(j.kelompok),
                )
                .map((j) => (
                  <option key={j.id_jenis} value={j.id_jenis}>
                    {j.nama} ({j.kelompok})
                  </option>
                ))}
            </PilihCari>
            {jenisDipilih ? (
              <p className="mt-1 text-xs text-slate-400">
                Gaji: {jenisDipilih.dampak_gaji}
                {jenisDipilih.maks_hari
                  ? ` • Paling lama ${jenisDipilih.maks_hari} ${jenisDipilih.satuan_maks.toLowerCase()}`
                  : ""}
                {jenisDipilih.potong_jatah ? " • Memotong jatah cuti" : ""}
                {jenisDipilih.wajib_dokumen
                  ? " • Lampirkan dokumen pendukung"
                  : ""}
              </p>
            ) : null}
          </div>
          <div>
            <label className={LABEL} htmlFor="pengajuan-mulai">
              Tanggal mulai
            </label>
            <input
              id="pengajuan-mulai"
              type="date"
              className={INPUT}
              value={isi.tanggal_mulai}
              onChange={(e) =>
                setIsi({
                  ...isi,
                  tanggal_mulai: e.target.value,
                  tanggal_selesai:
                    !isi.tanggal_selesai || isi.tanggal_selesai < e.target.value
                      ? e.target.value
                      : isi.tanggal_selesai,
                })
              }
            />
          </div>
          <div>
            <label className={LABEL} htmlFor="pengajuan-selesai">
              Tanggal selesai
            </label>
            <input
              id="pengajuan-selesai"
              type="date"
              className={INPUT}
              value={isi.tanggal_selesai}
              min={isi.tanggal_mulai || undefined}
              onChange={(e) =>
                setIsi({ ...isi, tanggal_selesai: e.target.value })
              }
            />
          </div>
          {jenisDipilih?.kelompok === "Izin" &&
          isi.tanggal_mulai &&
          isi.tanggal_mulai === isi.tanggal_selesai ? (
            <label
              className="flex items-center gap-2 text-sm text-slate-200"
              htmlFor="pengajuan-setengah"
            >
              <input
                id="pengajuan-setengah"
                type="checkbox"
                checked={isi.setengah_hari}
                onChange={(e) =>
                  setIsi({ ...isi, setengah_hari: e.target.checked })
                }
              />
              Setengah hari
            </label>
          ) : null}
          {jenisDipilih?.boleh_urgent &&
          boleh("hr.request.urgent") &&
          !isi.id_pengajuan ? (
            <label
              className="flex items-center gap-2 text-sm text-slate-200"
              htmlFor="pengajuan-urgent"
            >
              <input
                id="pengajuan-urgent"
                type="checkbox"
                checked={isi.urgent}
                onChange={(e) => setIsi({ ...isi, urgent: e.target.checked })}
              />
              Urgent: langsung berlaku, HRD menandai diketahui
            </label>
          ) : null}
          <div className="sm:col-span-2">
            <label className={LABEL} htmlFor="pengajuan-alasan">
              Alasan
            </label>
            <textarea
              id="pengajuan-alasan"
              className={`${INPUT} min-h-20`}
              maxLength={500}
              value={isi.alasan}
              onChange={(e) => setIsi({ ...isi, alasan: e.target.value })}
            />
          </div>
          {sisaJatah !== null ? (
            <p
              className={`text-sm sm:col-span-2 ${sisaJatah <= 0 ? "text-amber-200" : "text-slate-300"}`}
            >
              Sisa jatah cuti periode ini: {sisaJatah} hari
              {sisaJatah <= 0
                ? ". Disetujui tetap boleh, jatah menjadi minus."
                : "."}
            </p>
          ) : null}
          <div className="flex gap-2 sm:col-span-2">
            <button
              type="button"
              id="pengajuan-simpan"
              className={TOMBOL_UTAMA}
              disabled={sibuk}
              onClick={() => void ajukan()}
            >
              {isi.id_pengajuan ? "Simpan perubahan" : "Kirim pengajuan"}
            </button>
          </div>
        </div>
      ) : null}

      {saring === "diuangkan" ? (
        <AkhirPeriodePanel
          bolehProses={boleh("hr.leave.adjust")}
          onPesan={setPesan}
        />
      ) : tampil.length === 0 ? (
        <p className="rounded-2xl border border-slate-800 bg-slate-900 p-6 text-sm text-slate-400">
          Tidak ada pengajuan di saringan ini.
        </p>
      ) : (
        <ul className="space-y-2">
          {tampil.map((b) => (
            <BarisPengajuan
              key={b.pengajuan.id_pengajuan}
              baris={b}
              terbuka={buka === b.pengajuan.id_pengajuan}
              onBuka={() =>
                setBuka((x) =>
                  x === b.pengajuan.id_pengajuan
                    ? null
                    : b.pengajuan.id_pengajuan,
                )
              }
              boleh={boleh}
              username={user?.username ?? ""}
              superadmin={Boolean(user?.isSuperadmin)}
              sibuk={sibuk}
              jalankan={jalankan}
              onSunting={() => sunting(b)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function BarisPengajuan({
  baris,
  terbuka,
  onBuka,
  boleh,
  username,
  superadmin,
  sibuk,
  jalankan,
  onSunting,
}: {
  baris: BarisDaftarPengajuan;
  terbuka: boolean;
  onBuka: () => void;
  boleh: (izin: string) => boolean;
  username: string;
  superadmin: boolean;
  sibuk: boolean;
  jalankan: (
    kerja: () => Promise<unknown>,
    berhasil: string,
  ) => Promise<boolean>;
  onSunting: () => void;
}) {
  const p = baris.pengajuan;
  const [alasan, setAlasan] = useState("");
  const [riwayat, setRiwayat] = useState<KeputusanRiwayat[]>([]);
  const [berkas, setBerkas] = useState<LampiranRingkas[] | null>(null);
  const [galatBerkas, setGalatBerkas] = useState("");

  const muatRincian = useCallback(() => {
    ambilRiwayatKeputusan(p.id_pengajuan)
      .then((r) => setRiwayat(r.keputusan))
      .catch(() => setRiwayat([]));
    ambilLampiran(p.id_pengajuan)
      .then((r) => {
        setBerkas(r.berkas);
        setGalatBerkas("");
      })
      .catch((error: unknown) => {
        setBerkas(null);
        setGalatBerkas(
          pesanGalat(error, "Lampiran hanya terbuka saat online."),
        );
      });
  }, [p.id_pengajuan]);
  useEffect(() => {
    if (terbuka) muatRincian();
  }, [terbuka, muatRincian]);

  const pengaju =
    username.trim().toLowerCase() === p.diajukan_oleh.trim().toLowerCase();
  const pemutus = boleh(baris.izin_pemutus);
  const berlaku =
    baris.status === "Disetujui" || baris.status === "Disetujui (urgent)";
  const putus = (aksi: string, teks: string) =>
    jalankan(
      () => putuskanPengajuan({ id_pengajuan: p.id_pengajuan, aksi, alasan }),
      teks,
    ).then((ok) => {
      if (ok) setAlasan("");
      muatRincian();
    });
  const tanpaDokumen =
    baris.wajib_dokumen && baris.hari_kerja > 1 && berkas?.length === 0;

  const unggah = async (daftar: FileList | null) => {
    const berkasPilih = daftar?.[0];
    if (!berkasPilih) return;
    const data = await bacaBase64(berkasPilih);
    await jalankan(
      () =>
        tambahLampiran({
          id_pengajuan: p.id_pengajuan,
          nama_berkas: berkasPilih.name,
          mime_type: berkasPilih.type,
          data_base64: data,
        }),
      "Lampiran tersimpan.",
    );
    muatRincian();
  };

  const lihat = async (idBerkas: string) => {
    try {
      const b = await ambilIsiLampiran(idBerkas);
      const bita = Uint8Array.from(atob(b.data_base64), (c) => c.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bita], { type: b.mime_type }));
      window.open(url, "_blank", "noopener");
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (error) {
      setGalatBerkas(pesanGalat(error, "Berkas gagal dibuka."));
    }
  };

  return (
    <li className="rounded-2xl border border-slate-800 bg-slate-900">
      <button
        type="button"
        id={`pengajuan-${p.id_pengajuan}`}
        aria-expanded={terbuka}
        onClick={onBuka}
        className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 p-3 text-left"
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate font-semibold text-white">
            {baris.nama_karyawan ?? p.id_karyawan}
          </span>
          <span className="block truncate text-xs text-slate-400">
            {baris.nama_jenis ?? p.kelompok} •{" "}
            {p.tanggal_mulai === p.tanggal_selesai
              ? p.tanggal_mulai
              : `${p.tanggal_mulai} s.d. ${p.tanggal_selesai}`}
            {p.setengah_hari
              ? " (½ hari)"
              : ` • ${baris.hari_kerja} hari kerja`}
          </span>
          {baris.tanda.length > 0 ? (
            <span className="block truncate text-xs text-amber-200">
              {baris.tanda.map((t) => LABEL_TANDA_PENGAJUAN[t] ?? t).join(", ")}
            </span>
          ) : null}
        </span>
        <span
          className={`rounded-lg px-2 py-1 text-xs font-bold ${WARNA_STATUS[baris.status] ?? ""}`}
        >
          {baris.status}
        </span>
      </button>
      {terbuka ? (
        <div className="space-y-3 border-t border-slate-800 p-3 text-sm">
          <p className="text-slate-200">{p.alasan}</p>
          <p className="text-xs text-slate-400">
            Diajukan {p.diajukan_oleh} • Gaji: {p.dampak_gaji}
            {p.potong_jatah ? " • Memotong jatah cuti" : ""}
          </p>
          {riwayat.length > 0 ? (
            <ul className="space-y-1 text-xs text-slate-300">
              {riwayat.map((k) => (
                <li key={k.id_keputusan}>
                  {k.jenis} oleh {k.oleh} • {k.waktu_perangkat} UTC
                  {k.sidik !== p.sidik &&
                  k.jenis !== "Batal" &&
                  k.jenis !== "Diketahui"
                    ? " • isi sudah berubah"
                    : ""}
                  {k.alasan ? ` • ${k.alasan}` : ""}
                </li>
              ))}
            </ul>
          ) : null}

          <div className="space-y-1">
            <p className="text-xs font-semibold text-slate-300">Lampiran</p>
            {galatBerkas ? (
              <p className="text-xs text-slate-400">{galatBerkas}</p>
            ) : null}
            {tanpaDokumen ? (
              <p className="text-xs text-amber-200">
                {LABEL_TANDA_PENGAJUAN.tanpa_dokumen}
              </p>
            ) : null}
            {berkas?.map((f) => (
              <div key={f.id_berkas} className="flex flex-wrap gap-2 text-xs">
                <button
                  type="button"
                  className="text-sky-300 underline"
                  onClick={() => void lihat(f.id_berkas)}
                >
                  {f.nama_berkas ?? `Lampiran ${f.urutan}`}
                </button>
                {pengaju || boleh("hr.request.decide") ? (
                  <button
                    type="button"
                    className="text-rose-200 underline"
                    disabled={sibuk}
                    onClick={() =>
                      void jalankan(
                        () => hapusLampiran(f.id_berkas),
                        "Lampiran dihapus.",
                      ).then(muatRincian)
                    }
                  >
                    Hapus
                  </button>
                ) : null}
              </div>
            ))}
            {berkas !== null &&
            berkas.length < 5 &&
            (pengaju || boleh("hr.request.decide")) ? (
              <input
                id={`pengajuan-unggah-${p.id_pengajuan}`}
                type="file"
                accept="image/jpeg,image/png,image/webp,application/pdf"
                className="block text-xs text-slate-300"
                disabled={sibuk}
                onChange={(e) => void unggah(e.target.files)}
              />
            ) : null}
          </div>

          <div>
            <label
              className={LABEL}
              htmlFor={`pengajuan-alasan-${p.id_pengajuan}`}
            >
              Alasan (wajib untuk tolak dan batal)
            </label>
            <input
              id={`pengajuan-alasan-${p.id_pengajuan}`}
              className={INPUT}
              maxLength={500}
              value={alasan}
              onChange={(e) => setAlasan(e.target.value)}
            />
          </div>
          <div className="flex flex-wrap gap-2">
            {baris.status === "Menunggu" && pemutus ? (
              <>
                <button
                  type="button"
                  className={TOMBOL_UTAMA}
                  disabled={sibuk}
                  onClick={() => void putus("Setujui", "Pengajuan disetujui.")}
                >
                  Setujui
                </button>
                <button
                  type="button"
                  className={TOMBOL_BAHAYA}
                  disabled={sibuk || !alasan.trim()}
                  onClick={() => void putus("Tolak", "Pengajuan ditolak.")}
                >
                  Tolak
                </button>
              </>
            ) : null}
            {baris.status === "Disetujui (urgent)" &&
            !baris.sudah_diketahui &&
            boleh("hr.request.decide") ? (
              <button
                type="button"
                className={TOMBOL_UTAMA}
                disabled={sibuk}
                onClick={() => void putus("Diketahui", "Ditandai diketahui.")}
              >
                Tandai diketahui
              </button>
            ) : null}
            {baris.status === "Menunggu" && (pengaju || superadmin) ? (
              <button
                type="button"
                className={TOMBOL_KEDUA}
                onClick={onSunting}
              >
                Sunting
              </button>
            ) : null}
            {(baris.status === "Menunggu" && (pengaju || superadmin)) ||
            (berlaku && pemutus) ? (
              <button
                type="button"
                className={TOMBOL_BAHAYA}
                disabled={sibuk || !alasan.trim()}
                onClick={() => void putus("Batal", "Pengajuan dibatalkan.")}
              >
                Batalkan
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
    </li>
  );
}

function AkhirPeriodePanel({
  bolehProses,
  onPesan,
}: {
  bolehProses: boolean;
  onPesan: (pesan: string) => void;
}) {
  const [data, setData] = useState<AkhirPeriode | null>(null);
  const [sibuk, setSibuk] = useState(false);
  const muat = useCallback(() => {
    ambilAkhirPeriode()
      .then(setData)
      .catch((error: unknown) =>
        onPesan(pesanGalat(error, "Data akhir periode gagal dimuat.")),
      );
  }, [onPesan]);
  useEffect(muat, [muat]);

  if (!data) return null;
  if (data.aturan.sisa !== "diuangkan") {
    return (
      <p className="rounded-2xl border border-slate-800 bg-slate-900 p-6 text-sm text-slate-400">
        Sisa cuti tidak diatur untuk diuangkan (Pengaturan di HRIS, tab
        Organisasi).
      </p>
    );
  }
  const proses = async (idKaryawan: string, periode: string, nama: string) => {
    const lanjut = await konfirmasiData([
      { label: "Karyawan", nilai: nama },
      { label: "Periode", nilai: periode },
    ]);
    if (!lanjut) return;
    setSibuk(true);
    try {
      const hasil = await prosesAkhirPeriode({
        id_karyawan: idKaryawan,
        periode,
      });
      onPesan(
        `Dicatat ${hasil.hari} hari, Rp ${hasil.nominal.toLocaleString("id-ID")}.`,
      );
      muat();
    } catch (error) {
      onPesan(pesanGalat(error, "Gagal memproses."));
    } finally {
      setSibuk(false);
    }
  };
  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-slate-800 bg-slate-900 p-4">
        <h3 className="mb-2 text-sm font-bold text-white">
          Periode berakhir, belum diproses
        </h3>
        {data.belum_diproses.length === 0 ? (
          <p className="text-sm text-slate-400">Tidak ada.</p>
        ) : (
          <ul className="space-y-2 text-sm">
            {data.belum_diproses.map((b) => (
              <li
                key={`${b.id_karyawan}:${b.periode.mulai}`}
                className="flex flex-wrap items-center gap-2"
              >
                <span className="flex-1 text-slate-200">
                  {b.nama} • {b.periode.mulai} s.d. {b.periode.selesai} • sisa{" "}
                  {b.periode.sisa} hari
                </span>
                {bolehProses ? (
                  <button
                    type="button"
                    className={TOMBOL_KEDUA}
                    disabled={sibuk}
                    onClick={() =>
                      void proses(b.id_karyawan, b.periode.mulai, b.nama)
                    }
                  >
                    Uangkan
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="rounded-2xl border border-slate-800 bg-slate-900 p-4">
        <h3 className="mb-2 text-sm font-bold text-white">
          Perlu dibayar (manual sampai kait gaji fase 4)
        </h3>
        {data.diuangkan.length === 0 ? (
          <p className="text-sm text-slate-400">Tidak ada.</p>
        ) : (
          <ul className="space-y-1 text-sm text-slate-200">
            {data.diuangkan.map((d) => (
              <li key={d.baris.id_penyesuaian}>
                {d.nama} • {d.baris.periode} • {-d.baris.hari} hari • Rp{" "}
                {(d.baris.nominal ?? 0).toLocaleString("id-ID")}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
