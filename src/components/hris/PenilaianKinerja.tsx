"use client";

// Penilaian kinerja (HRIS v41, prd-hris.md §21.9): daftar satu periode,
// rincian dengan isian skor per aspek, rumus disiplin, dan aksi. Dipakai tab
// Kinerja `/hris` (Web/Desktop) dan tab Penilaian `/pengajuan` (Mobile,
// `modeHp`: tanpa Kembalikan, Final, dan Koreksi, Q-72). Aksi yang terbuka
// dinilai backend (`boleh`); tombol hanya cerminnya.

import { useCallback, useEffect, useMemo, useState } from "react";
import { DaftarRincian } from "@/components/hris/DaftarRincian";
import {
  hariIniWib,
  INPUT,
  LABEL,
  pesanGalat,
  TOMBOL_BAHAYA,
  TOMBOL_KEDUA,
  TOMBOL_UTAMA,
} from "@/components/inventory/gaya";
import { konfirmasiData } from "@/components/ui/KonfirmasiData";
import { hasPermission } from "@/lib/auth/access";
import { useAuth } from "@/lib/context/AuthContext";
import {
  ajukanPenilaianKinerja,
  ambilDaftarKinerja,
  ambilRincianKinerja,
  type BelumDinilai,
  type DaftarKinerja,
  type PenilaianKinerja as Penilaian,
  putuskanPenilaianKinerja,
  type RincianKinerja,
  simpanPenilaianKinerja,
} from "@/lib/gateways/hr-kinerja";
import { SYNC_COMPLETED_EVENT, syncNow } from "@/lib/gateways/sync-status";
import {
  awalPeriode,
  formatNilai,
  nilaiAkhir,
  PERIODE_JENIS,
  predikatNilai,
  TIPE_DISIPLIN,
} from "@/lib/validations/hr-kinerja";

export const LABEL_TANDA_KINERJA: Record<string, string> = {
  penilaian_ganda: "Penilaian ganda di periode ini",
  final_gugur: "Final versi lama gugur",
  final_dibatalkan: "Final dibatalkan perangkat lain",
  dinilai_dan_difinalkan_sama: "Dinilai dan difinalkan orang yang sama",
  bukan_atasan_langsung: "Bukan dinilai atasan langsung",
  disiplin_manual: "Skor disiplin diisi manual",
  periode_tidak_penuh: "Aktif tidak sepanjang periode",
};

export const WARNA_STATUS_KINERJA: Record<string, string> = {
  Draf: "bg-slate-700 text-slate-200",
  Diajukan: "bg-amber-500/15 text-amber-200",
  Final: "bg-emerald-500/15 text-emerald-200",
  Dibatalkan: "bg-rose-500/15 text-rose-200",
};

type Saring = "saya" | "belum" | "Draf" | "Diajukan" | "Final" | "Dibatalkan";
type Isian = { skor: string; catatan: string };

/** Uraian `rincian` disiplin untuk penilai dan HRD (§21.6). */
export function uraiDisiplin(rincian: string | null): string {
  if (!rincian) return "Belum dihitung.";
  const [d, tepat, telat, alfa, kosong, kecuali, p, ambang] =
    rincian.split("|");
  const dasar = `Tepat ${tepat}, terlambat ${telat} (dihitung ½), Alfa ${alfa}, tanpa catatan ${kosong}; dikecualikan ${kecuali} hari (cuti, izin, sakit, dinas luar berlaku).`;
  if (d === "0") {
    return `${dasar} Tidak ada hari yang dinilai, jadi skor diisi penilai dengan catatan.`;
  }
  return `${dasar} P = (2 × ${tepat} + ${telat}) × 1000 ÷ (2 × ${d}) = ${p} permil. Ambang skor 5/4/3/2: ${String(ambang).replaceAll(",", "/")}.`;
}

const terbuka = (p: Penilaian) =>
  p.status === "Draf" || p.status === "Diajukan";

function periodeDari(jenis: string, tanggal: string): string {
  return awalPeriode(jenis, tanggal) ?? `${tanggal.slice(0, 7)}-01`;
}

export function PenilaianKinerja({ modeHp = false }: { modeHp?: boolean }) {
  const { user } = useAuth();
  const bolehNilai = hasPermission(user, "hr.performance.assess");
  const [jenis, setJenis] = useState("");
  const [tanggal, setTanggal] = useState(hariIniWib());
  const [data, setData] = useState<DaftarKinerja | null>(null);
  const [saring, setSaring] = useState<Saring>("saya");
  const [dipilih, setDipilih] = useState<string | null>(null);
  const [pesan, setPesan] = useState("");
  const [sibuk, setSibuk] = useState(false);

  const muat = useCallback(async () => {
    try {
      const filter = jenis
        ? { periode_jenis: jenis, periode_mulai: periodeDari(jenis, tanggal) }
        : {};
      const hasil = await ambilDaftarKinerja(filter);
      setData(hasil);
      if (!jenis) setJenis(hasil.periode.jenis);
    } catch (error) {
      setPesan(pesanGalat(error, "Penilaian gagal dimuat."));
    }
  }, [jenis, tanggal]);

  useEffect(() => {
    void muat();
    const dengar = () => void muat();
    window.addEventListener(SYNC_COMPLETED_EVENT, dengar);
    return () => window.removeEventListener(SYNC_COMPLETED_EVENT, dengar);
  }, [muat]);

  const penilaian = useMemo(() => {
    const semua = data?.penilaian ?? [];
    if (saring === "saya")
      return semua.filter((p) => p.atasan_saya && terbuka(p));
    if (saring === "belum") return [];
    return semua.filter((p) => p.status === saring);
  }, [data, saring]);
  const belum = useMemo(() => {
    const semua = data?.belum_dinilai ?? [];
    if (saring === "saya") return semua.filter((k) => k.atasan_saya);
    return saring === "belum" ? semua : [];
  }, [data, saring]);

  const mulaiNilai = async (k: BelumDinilai) => {
    if (!data) return;
    const lanjut = await konfirmasiData([
      { label: "Karyawan", nilai: k.nama },
      {
        label: "Periode",
        nilai: `${data.periode.jenis} ${data.periode.mulai} s.d. ${data.periode.selesai}`,
      },
      { label: "Template", nilai: k.template_nama ?? "-" },
    ]);
    if (!lanjut) return;
    setSibuk(true);
    try {
      const hasil = await simpanPenilaianKinerja({
        id_karyawan: k.id_karyawan,
        periode_jenis: data.periode.jenis,
        periode_mulai: data.periode.mulai,
        nilai: [],
      });
      setPesan("Draf penilaian dibuat.");
      setDipilih(hasil.id_penilaian);
      await muat();
    } catch (error) {
      setPesan(pesanGalat(error, "Penilaian gagal dibuat."));
    } finally {
      setSibuk(false);
    }
  };

  const saringan: Array<[Saring, string]> = [
    ["saya", "Perlu saya nilai"],
    ["belum", "Belum dinilai"],
    ["Draf", "Draf"],
    ["Diajukan", "Diajukan"],
    ["Final", "Final"],
    ["Dibatalkan", "Dibatalkan"],
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-0">
          <label className={LABEL} htmlFor="kinerja-periode-jenis">
            Jenis periode
          </label>
          <select
            id="kinerja-periode-jenis"
            className={INPUT}
            value={jenis}
            onChange={(e) => setJenis(e.target.value)}
          >
            {PERIODE_JENIS.map((j) => (
              <option key={j} value={j}>
                {j}
              </option>
            ))}
          </select>
        </div>
        <div className="min-w-0">
          <label className={LABEL} htmlFor="kinerja-periode-tanggal">
            Periode yang memuat tanggal
          </label>
          <input
            id="kinerja-periode-tanggal"
            type="date"
            className={INPUT}
            value={tanggal}
            onChange={(e) => e.target.value && setTanggal(e.target.value)}
          />
        </div>
        <button
          type="button"
          id="kinerja-muat-ulang"
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
      </div>
      {data ? (
        <p className="text-sm text-slate-300">
          Periode {data.periode.jenis.toLowerCase()} {data.periode.mulai} s.d.{" "}
          {data.periode.selesai}
          {data.periode.bisa_diajukan
            ? "."
            : ". Penilaian bisa diajukan sejak hari terakhir periode."}
        </p>
      ) : null}
      {pesan ? (
        <output className="block text-sm text-amber-200">{pesan}</output>
      ) : null}

      <DaftarRincian
        adaPilihan={Boolean(dipilih)}
        onKembali={() => setDipilih(null)}
        daftar={
          <div className="min-w-0 space-y-3 rounded-2xl border border-slate-800 bg-slate-900 p-3">
            <div
              className="flex flex-wrap gap-2"
              role="tablist"
              aria-label="Saring penilaian"
            >
              {saringan.map(([id, label]) => (
                <button
                  key={id}
                  id={`kinerja-saring-${id}`}
                  type="button"
                  role="tab"
                  aria-selected={saring === id}
                  onClick={() => setSaring(id)}
                  className={`min-h-9 rounded-xl px-3 text-xs font-bold ${saring === id ? "bg-sky-500 text-white" : "bg-slate-950 text-slate-300"}`}
                >
                  {label}
                </button>
              ))}
            </div>
            {penilaian.length === 0 && belum.length === 0 ? (
              <p className="text-sm text-slate-400">
                Tidak ada di saringan ini.
              </p>
            ) : null}
            <ul className="max-h-[60vh] space-y-1 overflow-y-auto">
              {penilaian.map((p) => (
                <li key={p.id_penilaian}>
                  <button
                    type="button"
                    onClick={() => setDipilih(p.id_penilaian)}
                    className={`w-full rounded-xl px-3 py-2 text-left ${dipilih === p.id_penilaian ? "bg-sky-500/20" : "hover:bg-slate-800"}`}
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="truncate font-semibold text-white">
                        {p.nama ?? p.id_karyawan}
                      </span>
                      <span
                        className={`shrink-0 rounded-lg px-2 py-0.5 text-xs font-bold ${WARNA_STATUS_KINERJA[p.status] ?? ""}`}
                      >
                        {p.status}
                      </span>
                    </span>
                    <span className="block truncate text-xs text-slate-400">
                      {p.divisi ?? "-"} • {p.template_nama}
                      {p.id_ref ? " • Koreksi" : ""}
                      {p.nilai_teks
                        ? ` • ${p.nilai_teks} ${p.predikat ?? ""}`
                        : ""}
                    </span>
                    {p.tanda.length ? (
                      <span className="block truncate text-xs text-amber-200">
                        {p.tanda
                          .map((t) => LABEL_TANDA_KINERJA[t] ?? t)
                          .join(", ")}
                      </span>
                    ) : null}
                  </button>
                </li>
              ))}
              {belum.map((k) => (
                <li
                  key={k.id_karyawan}
                  className="flex flex-wrap items-center gap-2 rounded-xl px-3 py-2"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-semibold text-white">
                      {k.nama}
                    </span>
                    <span className="block truncate text-xs text-slate-400">
                      {k.divisi || "-"} •{" "}
                      {k.template_nama ??
                        "Belum bisa dinilai: jabatan tanpa template"}
                    </span>
                  </span>
                  {bolehNilai && k.id_template ? (
                    <button
                      type="button"
                      id={`kinerja-mulai-${k.id_karyawan}`}
                      className={TOMBOL_KEDUA}
                      disabled={sibuk}
                      onClick={() => void mulaiNilai(k)}
                    >
                      Mulai nilai
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        }
      >
        <div className="min-w-0">
          {dipilih ? (
            <RincianPenilaian
              key={dipilih}
              id={dipilih}
              modeHp={modeHp}
              onPilih={setDipilih}
              onBerubah={muat}
              onPesan={setPesan}
            />
          ) : (
            <p className="rounded-2xl border border-slate-800 bg-slate-900 p-6 text-sm text-slate-400">
              Pilih penilaian untuk melihat rinciannya.
            </p>
          )}
        </div>
      </DaftarRincian>
    </div>
  );
}

function RincianPenilaian({
  id,
  modeHp,
  onPilih,
  onBerubah,
  onPesan,
}: {
  id: string;
  modeHp: boolean;
  onPilih: (id: string) => void;
  onBerubah: () => Promise<void>;
  onPesan: (pesan: string) => void;
}) {
  const [r, setR] = useState<RincianKinerja | null>(null);
  const [isian, setIsian] = useState<Record<string, Isian>>({});
  const [catatan, setCatatan] = useState("");
  const [alasan, setAlasan] = useState("");
  const [berubah, setBerubah] = useState<string | null>(null);
  const [sibuk, setSibuk] = useState(false);

  const muat = useCallback(async () => {
    try {
      const hasil = await ambilRincianKinerja(id);
      setR(hasil);
      setIsian(
        Object.fromEntries(
          hasil.nilai.map((b) => [
            b.id_aspek,
            {
              skor: b.skor === null ? "" : String(b.skor),
              catatan: b.catatan ?? "",
            },
          ]),
        ),
      );
      setCatatan(hasil.penilaian.catatan ?? "");
    } catch (error) {
      onPesan(pesanGalat(error, "Rincian penilaian gagal dimuat."));
    }
  }, [id, onPesan]);

  useEffect(() => {
    void muat();
  }, [muat]);

  if (!r) return null;
  const p = r.penilaian;
  const boleh = (aksi: string) =>
    r.boleh[aksi] === true &&
    !(modeHp && ["Kembalikan", "Final", "Koreksi"].includes(aksi));
  const bisaSunting = boleh("Simpan");
  const disiplin = r.nilai.find((b) => b.tipe === TIPE_DISIPLIN);
  const disiplinManual = r.disiplin?.skor === null;

  const draf = (tambahan: Record<string, unknown> = {}) => ({
    id_penilaian: p.id_penilaian,
    id_karyawan: p.id_karyawan,
    periode_jenis: p.periode_jenis,
    periode_mulai: p.periode_mulai,
    id_ref: p.id_ref,
    alasan_koreksi: p.alasan_koreksi,
    catatan,
    nilai: r.nilai.map((b) => ({
      id_aspek: b.id_aspek,
      skor: isian[b.id_aspek]?.skor ? Number(isian[b.id_aspek]?.skor) : null,
      catatan: isian[b.id_aspek]?.catatan ?? "",
    })),
    ...tambahan,
  });

  const jalankan = async (kerja: () => Promise<unknown>, berhasil: string) => {
    setSibuk(true);
    try {
      await kerja();
      onPesan(berhasil);
      setAlasan("");
      await Promise.all([muat(), onBerubah()]);
    } catch (error) {
      onPesan(pesanGalat(error, "Gagal."));
    } finally {
      setSibuk(false);
    }
  };

  const simpan = async (muatUlang = false) => {
    const lanjut = await konfirmasiData([
      { label: "Karyawan", nilai: p.nama ?? p.id_karyawan },
      ...r.nilai.map((b) => ({
        label: b.aspek_nama,
        nilai:
          b.tipe === TIPE_DISIPLIN && !disiplinManual
            ? "Otomatis"
            : isian[b.id_aspek]?.skor || "Belum diisi",
      })),
      ...(muatUlang ? [{ label: "Template", nilai: "Dimuat ulang" }] : []),
    ]);
    if (!lanjut) return;
    await jalankan(
      () => simpanPenilaianKinerja(draf(muatUlang ? { muat_ulang: true } : {})),
      muatUlang ? "Template dimuat ulang." : "Draf disimpan.",
    );
  };

  const ajukan = async () => {
    setSibuk(true);
    try {
      const hasil = await ajukanPenilaianKinerja(
        draf(),
        disiplin?.rincian ?? null,
      );
      if (hasil.disiplin_berubah) {
        setBerubah(
          `Angka disiplin berubah: ${uraiDisiplin(hasil.disiplin_berubah.lama)} → ${uraiDisiplin(hasil.disiplin_berubah.baru)} Periksa lalu tekan Ajukan sekali lagi.`,
        );
      } else {
        setBerubah(null);
        onPesan(
          hasil.peringatan
            ? `Diajukan. ${hasil.peringatan}`
            : "Penilaian diajukan.",
        );
      }
      await Promise.all([muat(), onBerubah()]);
    } catch (error) {
      onPesan(pesanGalat(error, "Penilaian gagal diajukan."));
    } finally {
      setSibuk(false);
    }
  };

  const putus = async (aksi: string) => {
    if (aksi === "Final") {
      const akhir = nilaiAkhir(r.nilai);
      const lanjut = await konfirmasiData([
        { label: "Karyawan", nilai: p.nama ?? p.id_karyawan },
        {
          label: "Nilai akhir",
          nilai:
            akhir === null
              ? "-"
              : `${formatNilai(akhir)} ${predikatNilai(akhir, r.pengaturan.predikat)}`,
        },
      ]);
      if (!lanjut) return;
    }
    await jalankan(
      () =>
        putuskanPenilaianKinerja({
          id_penilaian: p.id_penilaian,
          aksi,
          alasan,
        }),
      `Penilaian: ${aksi}.`,
    );
  };

  const koreksi = async () => {
    const lanjut = await konfirmasiData([
      { label: "Karyawan", nilai: p.nama ?? p.id_karyawan },
      { label: "Alasan koreksi", nilai: alasan },
    ]);
    if (!lanjut) return;
    setSibuk(true);
    try {
      const hasil = await simpanPenilaianKinerja({
        id_karyawan: p.id_karyawan,
        periode_jenis: p.periode_jenis,
        periode_mulai: p.periode_mulai,
        id_ref: r.id_akar,
        alasan_koreksi: alasan,
        nilai: [],
      });
      onPesan("Draf koreksi dibuat.");
      setAlasan("");
      await onBerubah();
      onPilih(hasil.id_penilaian);
    } catch (error) {
      onPesan(pesanGalat(error, "Koreksi gagal dibuat."));
    } finally {
      setSibuk(false);
    }
  };

  const ubahIsian = (aspek: string, kunci: keyof Isian, nilai: string) =>
    setIsian({
      ...isian,
      [aspek]: { ...isian[aspek], [kunci]: nilai } as Isian,
    });

  return (
    <div className="space-y-4 rounded-2xl border border-slate-800 bg-slate-900 p-4">
      <div className="space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-lg font-bold text-white">
            {p.nama ?? p.id_karyawan}
          </h2>
          <span
            className={`rounded-lg px-2 py-0.5 text-xs font-bold ${WARNA_STATUS_KINERJA[p.status] ?? ""}`}
          >
            {p.status}
          </span>
        </div>
        <p className="text-xs text-slate-400">
          {p.periode_jenis} {p.periode_mulai} s.d. {p.periode_selesai} •{" "}
          {p.template_nama} • {p.jabatan_nama ?? "Tanpa jabatan"} • penilai{" "}
          {p.penilai_oleh}
        </p>
        {p.id_ref ? (
          <p className="text-xs text-slate-300">Koreksi: {p.alasan_koreksi}</p>
        ) : null}
        {p.nilai_teks ? (
          <p className="text-sm font-bold text-emerald-200">
            Nilai akhir {p.nilai_teks} • {p.predikat}
          </p>
        ) : null}
        {p.tanda.length ? (
          <p className="text-xs text-amber-200">
            {p.tanda.map((t) => LABEL_TANDA_KINERJA[t] ?? t).join(", ")}
          </p>
        ) : null}
      </div>

      {r.disiplin_berubah &&
      (p.status === "Draf" || p.status === "Diajukan") ? (
        <p className="text-xs text-amber-200">
          Angka disiplin hitungan kini berbeda dari yang tersimpan:{" "}
          {uraiDisiplin(r.disiplin?.rincian ?? null)}
          {bisaSunting ? " Simpan ulang draf untuk memakainya." : ""}
        </p>
      ) : null}
      {berubah ? <p className="text-xs text-amber-200">{berubah}</p> : null}

      <ul className="space-y-3">
        {r.nilai.map((b) => {
          const otomatis = b.tipe === TIPE_DISIPLIN && !disiplinManual;
          return (
            <li
              key={b.id_aspek}
              className="space-y-2 rounded-xl border border-slate-800 p-3"
            >
              <p className="text-sm font-semibold text-white">
                {b.aspek_nama}{" "}
                <span className="text-xs font-normal text-slate-400">
                  bobot {b.bobot}
                </span>
              </p>
              {b.tipe === TIPE_DISIPLIN ? (
                <p className="text-xs text-slate-300">
                  {uraiDisiplin(b.rincian)}
                </p>
              ) : null}
              <div className="grid gap-2 sm:grid-cols-[8rem_minmax(0,1fr)]">
                <div>
                  <label
                    className={LABEL}
                    htmlFor={`kinerja-skor-${b.id_aspek}`}
                  >
                    Skor
                  </label>
                  {otomatis ? (
                    <p
                      id={`kinerja-skor-${b.id_aspek}`}
                      className="min-h-10 py-2 text-sm font-bold text-white"
                    >
                      {b.skor ?? "-"} (otomatis)
                    </p>
                  ) : (
                    <select
                      id={`kinerja-skor-${b.id_aspek}`}
                      className={INPUT}
                      disabled={!bisaSunting}
                      value={isian[b.id_aspek]?.skor ?? ""}
                      onChange={(e) =>
                        ubahIsian(b.id_aspek, "skor", e.target.value)
                      }
                    >
                      <option value="">Belum diisi</option>
                      {[5, 4, 3, 2, 1].map((s) => (
                        <option key={s} value={String(s)}>
                          {s}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
                <div className="min-w-0">
                  <label
                    className={LABEL}
                    htmlFor={`kinerja-catatan-${b.id_aspek}`}
                  >
                    Catatan
                    {b.tipe === TIPE_DISIPLIN && disiplinManual
                      ? " (wajib bila skor diisi)"
                      : ""}
                  </label>
                  <input
                    id={`kinerja-catatan-${b.id_aspek}`}
                    className={INPUT}
                    maxLength={1000}
                    disabled={!bisaSunting}
                    value={isian[b.id_aspek]?.catatan ?? ""}
                    onChange={(e) =>
                      ubahIsian(b.id_aspek, "catatan", e.target.value)
                    }
                  />
                </div>
              </div>
            </li>
          );
        })}
      </ul>

      <div>
        <label className={LABEL} htmlFor="kinerja-catatan-umum">
          Catatan penilaian
        </label>
        <textarea
          id="kinerja-catatan-umum"
          className={`${INPUT} min-h-20 py-2`}
          maxLength={2000}
          disabled={!bisaSunting}
          value={catatan}
          onChange={(e) => setCatatan(e.target.value)}
        />
      </div>

      <section className="space-y-1">
        <h3 className="text-sm font-bold text-white">
          SP berlaku di periode ini
        </h3>
        {r.sp === null ? (
          <p className="text-xs text-slate-400">{r.sp_pesan}</p>
        ) : r.sp.length === 0 ? (
          <p className="text-xs text-slate-400">Tidak ada.</p>
        ) : (
          <ul className="text-xs text-slate-300">
            {r.sp.map((sp) => (
              <li key={sp.id_sp}>
                {sp.tingkat} • {sp.tanggal} s.d. {sp.berlaku_sampai} •{" "}
                {sp.pelanggaran}
              </li>
            ))}
          </ul>
        )}
        <p className="text-xs text-slate-500">
          Hanya informasi; tidak mengubah angka disiplin.
        </p>
      </section>

      {boleh("Kembalikan") || boleh("Batal") || boleh("Koreksi") ? (
        <div>
          <label className={LABEL} htmlFor="kinerja-alasan">
            Alasan (kembalikan, batal, atau koreksi)
          </label>
          <input
            id="kinerja-alasan"
            className={INPUT}
            maxLength={1000}
            value={alasan}
            onChange={(e) => setAlasan(e.target.value)}
          />
        </div>
      ) : null}

      <div className="flex flex-wrap gap-2">
        {bisaSunting ? (
          <button
            type="button"
            id="kinerja-simpan"
            className={TOMBOL_KEDUA}
            disabled={sibuk}
            onClick={() => void simpan()}
          >
            Simpan draf
          </button>
        ) : null}
        {bisaSunting && !p.id_ref ? (
          <button
            type="button"
            id="kinerja-muat-ulang-template"
            className={TOMBOL_KEDUA}
            disabled={sibuk}
            onClick={() => void simpan(true)}
          >
            Muat ulang template
          </button>
        ) : null}
        {p.status === "Draf" && bisaSunting ? (
          <button
            type="button"
            id="kinerja-ajukan"
            className={TOMBOL_UTAMA}
            disabled={sibuk}
            onClick={() => void ajukan()}
          >
            Ajukan
          </button>
        ) : null}
        {boleh("Kembalikan") ? (
          <button
            type="button"
            id="kinerja-kembalikan"
            className={TOMBOL_KEDUA}
            disabled={sibuk || !alasan.trim()}
            onClick={() => void putus("Kembalikan")}
          >
            Kembalikan
          </button>
        ) : null}
        {boleh("Final") ? (
          <button
            type="button"
            id="kinerja-final"
            className={TOMBOL_UTAMA}
            disabled={sibuk}
            onClick={() => void putus("Final")}
          >
            Finalkan
          </button>
        ) : null}
        {boleh("Koreksi") ? (
          <button
            type="button"
            id="kinerja-koreksi"
            className={TOMBOL_KEDUA}
            disabled={sibuk || !alasan.trim()}
            onClick={() => void koreksi()}
          >
            Buat koreksi
          </button>
        ) : null}
        {boleh("Batal") ? (
          <button
            type="button"
            id="kinerja-batal"
            className={TOMBOL_BAHAYA}
            disabled={sibuk || !alasan.trim()}
            onClick={() => void putus("Batal")}
          >
            Batalkan
          </button>
        ) : null}
      </div>

      {r.riwayat.length > 1 ? (
        <section className="space-y-1">
          <h3 className="text-sm font-bold text-white">Riwayat koreksi</h3>
          <ul className="space-y-1 text-xs">
            {r.riwayat.map((x) => (
              <li key={x.id_penilaian}>
                <button
                  type="button"
                  className={`text-left ${x.id_penilaian === p.id_penilaian ? "font-bold text-white" : "text-sky-200 underline"}`}
                  onClick={() => onPilih(x.id_penilaian)}
                >
                  {x.id_ref ? "Koreksi" : "Penilaian awal"} • {x.status}
                  {x.nilai_teks ? ` • ${x.nilai_teks}` : ""}
                  {x.id_penilaian === r.id_berlaku ? " • berlaku" : ""}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {r.keputusan.length ? (
        <section className="space-y-1">
          <h3 className="text-sm font-bold text-white">Keputusan</h3>
          <ul className="text-xs text-slate-300">
            {r.keputusan.map((k) => (
              <li key={k.id_keputusan}>
                {k.jenis} • {k.oleh} • {k.waktu_perangkat.slice(0, 16)}
                {k.nilai_akhir !== null && k.nilai_akhir !== undefined
                  ? ` • ${formatNilai(k.nilai_akhir)} ${k.predikat ?? ""}`
                  : ""}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
