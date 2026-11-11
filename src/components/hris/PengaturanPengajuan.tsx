"use client";

// Jenis pengajuan, aturan cuti tahunan (HRIS v37, prd-hris.md §17.2, §17.7),
// aturan lembur (v38, §18.2), dan cara bayar reimbursement (v39, §19.2), di
// tab Organisasi `/hris` (Web/Desktop, `hr.org.manage`).

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
  ambilAkhirPeriode,
  ambilPengajuan,
  simpanAturanCuti,
  simpanJenisPengajuan,
} from "@/lib/gateways/hr-pengajuan";
import { SYNC_COMPLETED_EVENT } from "@/lib/gateways/sync-status";
import { formatRupiah } from "@/lib/validations/accounting";
import {
  type AturanCuti,
  type AturanLembur,
  DAMPAK_GAJI,
  IZIN_PEMUTUS,
  type JenisPengajuan,
  KELOMPOK_AKTIF,
  KELOMPOK_TANPA_GAJI,
  SATUAN_MAKS,
} from "@/lib/validations/hr-pengajuan";

type IsianJenis = Omit<JenisPengajuan, "maks_hari" | "batas_bulanan"> & {
  maks_hari: string;
  batas_bulanan: string;
};

const LABEL_PEMUTUS: Record<string, string> = {
  "hr.request.decide": "HRD (Putuskan Pengajuan)",
  "reimburse.decide": "Keuangan (Putuskan & Bayar Reimbursement)",
};

const JENIS_KOSONG: IsianJenis = {
  id_jenis: "",
  nama: "",
  kelompok: "Izin",
  izin_pemutus: "hr.request.decide",
  boleh_urgent: false,
  potong_jatah: false,
  dampak_gaji: "Dibayar",
  maks_hari: "",
  satuan_maks: "Hari Kerja",
  wajib_dokumen: false,
  is_aktif: true,
  batas_bulanan: "",
};

const LABEL_PERIODE: Record<string, string> = {
  kalender: "Tahun kalender",
  ulang_tahun_kerja: "Ulang tahun kerja",
};

export function PengaturanPengajuan() {
  const [jenis, setJenis] = useState<JenisPengajuan[]>([]);
  const [isi, setIsi] = useState<IsianJenis>(JENIS_KOSONG);
  const [aturan, setAturan] = useState<AturanCuti | null>(null);
  const [aturanLama, setAturanLama] = useState<AturanCuti | null>(null);
  const [lembur, setLembur] = useState<AturanLembur | null>(null);
  const [lemburLama, setLemburLama] = useState<AturanLembur | null>(null);
  const [modeReimburse, setModeReimburse] = useState("terpisah");
  const [modeReimburseLama, setModeReimburseLama] = useState("terpisah");
  const [pesan, setPesan] = useState("");
  const [sibuk, setSibuk] = useState(false);

  const muat = useCallback(() => {
    // Rentang tanpa pengajuan: yang dibutuhkan hanya daftar jenisnya.
    ambilPengajuan({ dari: "9999-12-31", sampai: "9999-12-31" })
      .then((d) => setJenis(d.jenis))
      .catch((error: unknown) => setPesan(pesanGalat(error, "Gagal memuat.")));
    ambilAkhirPeriode()
      .then((d) => {
        setAturan(d.aturan);
        setAturanLama(d.aturan);
        setLembur(d.aturan_lembur);
        setLemburLama(d.aturan_lembur);
        setModeReimburse(d.mode_reimburse);
        setModeReimburseLama(d.mode_reimburse);
      })
      .catch((error: unknown) => setPesan(pesanGalat(error, "Gagal memuat.")));
  }, []);
  useEffect(() => {
    muat();
    window.addEventListener(SYNC_COMPLETED_EVENT, muat);
    return () => window.removeEventListener(SYNC_COMPLETED_EVENT, muat);
  }, [muat]);

  const simpanJenis = async () => {
    const lanjut = await konfirmasiData([
      { label: "Nama", nilai: isi.nama },
      { label: "Kelompok", nilai: isi.kelompok },
      { label: "Gaji", nilai: isi.dampak_gaji },
      {
        label: "Batas",
        nilai: isi.maks_hari
          ? `${isi.maks_hari} ${isi.satuan_maks}`
          : "Tanpa batas",
      },
      { label: "Urgent", nilai: isi.boleh_urgent ? "Boleh" : "Tidak" },
      { label: "Pemutus", nilai: LABEL_PEMUTUS[isi.izin_pemutus] },
      ...(isi.kelompok === "Reimburse"
        ? [
            {
              label: "Batas bulanan",
              nilai: batasBulanan ? formatRupiah(batasBulanan) : "Tanpa batas",
            },
          ]
        : []),
      { label: "Status", nilai: isi.is_aktif ? "Aktif" : "Nonaktif" },
    ]);
    if (!lanjut) return;
    setSibuk(true);
    try {
      const { id_jenis, maks_hari, batas_bulanan: _batas, ...sisa } = isi;
      await simpanJenisPengajuan({
        ...sisa,
        ...(id_jenis ? { id_jenis } : {}),
        maks_hari: maks_hari === "" ? null : Number(maks_hari),
        batas_bulanan: isi.kelompok === "Reimburse" ? batasBulanan : null,
      });
      setPesan("Jenis pengajuan tersimpan.");
      setIsi(JENIS_KOSONG);
      muat();
    } catch (error) {
      setPesan(pesanGalat(error, "Gagal menyimpan."));
    } finally {
      setSibuk(false);
    }
  };

  const simpanAturan = async () => {
    if (!aturan || !lembur) return;
    const gantiPeriode = aturanLama && aturanLama.periode !== aturan.periode;
    const gantiMode = lemburLama && lemburLama.mode !== lembur.mode;
    const gantiReimburse = modeReimburseLama !== modeReimburse;
    const lanjut = await konfirmasiData([
      { label: "Periode", nilai: LABEL_PERIODE[aturan.periode] },
      { label: "Hak per periode", nilai: `${aturan.hak} hari` },
      { label: "Masa kerja minimum", nilai: `${aturan.syarat_bulan} bulan` },
      { label: "Prorata", nilai: aturan.prorata ? "Ya" : "Tidak" },
      { label: "Sisa cuti", nilai: aturan.sisa },
      ...(aturan.sisa === "dibawa"
        ? [
            { label: "Maks dibawa", nilai: `${aturan.bawa_maks} hari` },
            { label: "Dipakai dalam", nilai: `${aturan.bawa_bulan} bulan` },
          ]
        : []),
      {
        label: "Lembur dibayar",
        nilai:
          lembur.mode === "spl"
            ? "Hanya dengan SPL disetujui"
            : "Otomatis dari absensi",
      },
      {
        label: "Batas lembur",
        nilai: `${lembur.maks_harian} jam/hari, ${lembur.maks_mingguan} jam/minggu`,
      },
      ...(gantiPeriode
        ? [
            {
              label: "Perhatian",
              nilai:
                "Periode berubah: jatah dan sisa cuti semua karyawan dihitung ulang dengan aturan baru.",
            },
          ]
        : []),
      {
        label: "Reimbursement dibayar",
        nilai:
          modeReimburse === "gaji"
            ? "Ikut proses gaji"
            : "Terpisah (Pembayaran)",
      },
      ...(gantiMode
        ? [
            {
              label: "Perhatian",
              nilai:
                "Mode lembur berubah: rekap gaji yang belum dibekukan ikut dihitung ulang untuk seluruh periodenya.",
            },
          ]
        : []),
      ...(gantiReimburse
        ? [
            {
              label: "Perhatian",
              nilai:
                modeReimburse === "gaji"
                  ? "Klaim disetujui yang belum dibayar ikut proses gaji berikutnya."
                  : "Klaim yang sudah ada di proses gaji tetap ikut proses itu; sisanya menunggu dibayar terpisah.",
            },
          ]
        : []),
    ]);
    if (!lanjut) return;
    setSibuk(true);
    try {
      await simpanAturanCuti({
        hr_cuti_periode: aturan.periode,
        hr_cuti_hak: aturan.hak,
        hr_cuti_syarat_bulan: aturan.syarat_bulan,
        hr_cuti_prorata: aturan.prorata ? 1 : 0,
        hr_cuti_sisa: aturan.sisa,
        hr_cuti_bawa_maks: aturan.bawa_maks,
        hr_cuti_bawa_bulan: aturan.bawa_bulan,
        hr_lembur_mode: lembur.mode,
        hr_lembur_maks_harian: lembur.maks_harian,
        hr_lembur_maks_mingguan: lembur.maks_mingguan,
        hr_reimburse_bayar: modeReimburse,
      });
      setPesan("Aturan cuti, lembur, dan reimbursement tersimpan.");
      setAturanLama(aturan);
      setLemburLama(lembur);
      setModeReimburseLama(modeReimburse);
    } catch (error) {
      setPesan(pesanGalat(error, "Gagal menyimpan."));
    } finally {
      setSibuk(false);
    }
  };

  const tanpaGajiDipilih = (KELOMPOK_TANPA_GAJI as readonly string[]).includes(
    isi.kelompok,
  );
  const digit = isi.batas_bulanan.replace(/\D/g, "");
  const batasBulanan = digit ? Number(digit) : null;

  const angka = (kunci: keyof AturanCuti, label: string) =>
    aturan ? (
      <div>
        <label className={LABEL} htmlFor={`cuti-aturan-${kunci}`}>
          {label}
        </label>
        <input
          id={`cuti-aturan-${kunci}`}
          type="number"
          className={INPUT}
          value={String(aturan[kunci])}
          onChange={(e) =>
            setAturan({ ...aturan, [kunci]: Number(e.target.value) })
          }
        />
      </div>
    ) : null;

  return (
    <div className="space-y-4">
      <section className="space-y-3 rounded-2xl border border-slate-800 bg-slate-900 p-4">
        <h3 className="text-sm font-bold text-white">Jenis pengajuan</h3>
        <ul className="space-y-1 text-sm">
          {jenis.map((j) => (
            <li key={j.id_jenis} className="flex flex-wrap items-center gap-2">
              <span
                className={`flex-1 ${j.is_aktif ? "text-slate-200" : "text-slate-500"}`}
              >
                {j.nama} • {j.kelompok} • {j.dampak_gaji}
                {j.maks_hari
                  ? ` • maks ${j.maks_hari} ${j.satuan_maks.toLowerCase()}`
                  : ""}
                {j.potong_jatah ? " • potong jatah" : ""}
                {j.boleh_urgent ? " • urgent" : ""}
                {j.izin_pemutus === "reimburse.decide" ? " • Keuangan" : ""}
                {j.batas_bulanan
                  ? ` • batas ${formatRupiah(j.batas_bulanan)}/bulan`
                  : ""}
                {j.is_aktif ? "" : " • nonaktif"}
              </span>
              {(KELOMPOK_AKTIF as readonly string[]).includes(j.kelompok) ? (
                <button
                  type="button"
                  className="text-xs text-sky-300 underline"
                  onClick={() =>
                    setIsi({
                      ...j,
                      maks_hari:
                        j.maks_hari === null ? "" : String(j.maks_hari),
                      batas_bulanan:
                        j.batas_bulanan === null ? "" : String(j.batas_bulanan),
                    })
                  }
                >
                  Ubah
                </button>
              ) : null}
            </li>
          ))}
        </ul>
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="sm:col-span-3">
            <label className={LABEL} htmlFor="jenis-nama">
              Nama
            </label>
            <input
              id="jenis-nama"
              className={INPUT}
              maxLength={100}
              value={isi.nama}
              onChange={(e) => setIsi({ ...isi, nama: e.target.value })}
            />
          </div>
          <div>
            <label className={LABEL} htmlFor="jenis-kelompok">
              Kelompok
            </label>
            <select
              id="jenis-kelompok"
              className={INPUT}
              value={isi.kelompok}
              onChange={(e) => {
                const tanpaGaji = (
                  KELOMPOK_TANPA_GAJI as readonly string[]
                ).includes(e.target.value);
                const reimburse = e.target.value === "Reimburse";
                setIsi({
                  ...isi,
                  kelompok: e.target.value,
                  potong_jatah: e.target.value === "Cuti" && isi.potong_jatah,
                  ...(tanpaGaji
                    ? { dampak_gaji: "Tidak Berpengaruh", maks_hari: "" }
                    : {}),
                  ...(reimburse
                    ? {
                        boleh_urgent: false,
                        izin_pemutus: "reimburse.decide",
                        wajib_dokumen: true,
                      }
                    : { batas_bulanan: "" }),
                });
              }}
            >
              {KELOMPOK_AKTIF.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className={LABEL} htmlFor="jenis-dampak">
              Dampak gaji
            </label>
            <select
              id="jenis-dampak"
              className={INPUT}
              disabled={tanpaGajiDipilih}
              value={isi.dampak_gaji}
              onChange={(e) => setIsi({ ...isi, dampak_gaji: e.target.value })}
            >
              {DAMPAK_GAJI.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className={LABEL} htmlFor="jenis-maks">
                Maks hari
              </label>
              <input
                id="jenis-maks"
                type="number"
                min={1}
                disabled={tanpaGajiDipilih}
                className={INPUT}
                value={isi.maks_hari}
                onChange={(e) => setIsi({ ...isi, maks_hari: e.target.value })}
              />
            </div>
            <div>
              <label className={LABEL} htmlFor="jenis-satuan">
                Satuan
              </label>
              <select
                id="jenis-satuan"
                className={INPUT}
                value={isi.satuan_maks}
                onChange={(e) =>
                  setIsi({ ...isi, satuan_maks: e.target.value })
                }
              >
                {SATUAN_MAKS.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div>
            <label className={LABEL} htmlFor="jenis-pemutus">
              Pemutus
            </label>
            <select
              id="jenis-pemutus"
              className={INPUT}
              value={isi.izin_pemutus}
              onChange={(e) => setIsi({ ...isi, izin_pemutus: e.target.value })}
            >
              {IZIN_PEMUTUS.map((izin) => (
                <option key={izin} value={izin}>
                  {LABEL_PEMUTUS[izin]}
                </option>
              ))}
            </select>
          </div>
          {isi.kelompok === "Reimburse" ? (
            <div>
              <label className={LABEL} htmlFor="jenis-batas-bulanan">
                Batas per karyawan per bulan (rupiah, kosong = tanpa batas)
              </label>
              <input
                id="jenis-batas-bulanan"
                inputMode="numeric"
                className={INPUT}
                value={
                  batasBulanan === null
                    ? ""
                    : batasBulanan.toLocaleString("id-ID")
                }
                onChange={(e) =>
                  setIsi({ ...isi, batas_bulanan: e.target.value })
                }
              />
            </div>
          ) : null}
          {(
            [
              ["boleh_urgent", "Boleh urgent"],
              ["potong_jatah", "Memotong jatah cuti"],
              ["wajib_dokumen", "Wajib dokumen pendukung"],
              ["is_aktif", "Aktif"],
            ] as const
          ).map(([kunci, label]) =>
            (kunci === "potong_jatah" && isi.kelompok !== "Cuti") ||
            (kunci === "boleh_urgent" &&
              isi.kelompok === "Reimburse") ? null : (
              <label
                key={kunci}
                className="flex items-center gap-2 text-sm text-slate-200"
                htmlFor={`jenis-${kunci}`}
              >
                <input
                  id={`jenis-${kunci}`}
                  type="checkbox"
                  checked={isi[kunci]}
                  onChange={(e) =>
                    setIsi({ ...isi, [kunci]: e.target.checked })
                  }
                />
                {label}
              </label>
            ),
          )}
          <div className="flex gap-2 sm:col-span-3">
            <button
              type="button"
              id="jenis-simpan"
              className={TOMBOL_UTAMA}
              disabled={sibuk}
              onClick={() => void simpanJenis()}
            >
              {isi.id_jenis ? "Simpan perubahan" : "Tambah jenis"}
            </button>
            {isi.id_jenis ? (
              <button
                type="button"
                className={TOMBOL_KEDUA}
                onClick={() => setIsi(JENIS_KOSONG)}
              >
                Batal ubah
              </button>
            ) : null}
          </div>
        </div>
      </section>

      {aturan ? (
        <section className="grid gap-3 rounded-2xl border border-slate-800 bg-slate-900 p-4 sm:grid-cols-3">
          <h3 className="text-sm font-bold text-white sm:col-span-3">
            Aturan cuti tahunan
          </h3>
          <div>
            <label className={LABEL} htmlFor="cuti-aturan-periode">
              Periode
            </label>
            <select
              id="cuti-aturan-periode"
              className={INPUT}
              value={aturan.periode}
              onChange={(e) =>
                setAturan({ ...aturan, periode: e.target.value })
              }
            >
              <option value="ulang_tahun_kerja">Ulang tahun kerja</option>
              <option value="kalender">Tahun kalender</option>
            </select>
          </div>
          {angka("hak", "Hak per periode (hari)")}
          {angka("syarat_bulan", "Masa kerja minimum (bulan)")}
          <div>
            <label className={LABEL} htmlFor="cuti-aturan-sisa">
              Sisa cuti di akhir periode
            </label>
            <select
              id="cuti-aturan-sisa"
              className={INPUT}
              value={aturan.sisa}
              onChange={(e) => setAturan({ ...aturan, sisa: e.target.value })}
            >
              <option value="hangus">Hangus</option>
              <option value="dibawa">Dibawa ke periode berikutnya</option>
              <option value="diuangkan">Diuangkan</option>
            </select>
          </div>
          {aturan.sisa === "dibawa"
            ? angka("bawa_maks", "Maks dibawa (hari)")
            : null}
          {aturan.sisa === "dibawa"
            ? angka("bawa_bulan", "Dipakai dalam (bulan)")
            : null}
          {aturan.periode === "kalender" ? (
            <label
              className="flex items-center gap-2 text-sm text-slate-200"
              htmlFor="cuti-aturan-prorata"
            >
              <input
                id="cuti-aturan-prorata"
                type="checkbox"
                checked={aturan.prorata}
                onChange={(e) =>
                  setAturan({ ...aturan, prorata: e.target.checked })
                }
              />
              Prorata di tahun pertama berhak
            </label>
          ) : null}
          {lembur ? (
            <>
              <h3 className="text-sm font-bold text-white sm:col-span-3">
                Aturan lembur
              </h3>
              <div>
                <label className={LABEL} htmlFor="lembur-aturan-mode">
                  Lembur dibayar
                </label>
                <select
                  id="lembur-aturan-mode"
                  className={INPUT}
                  value={lembur.mode}
                  onChange={(e) =>
                    setLembur({ ...lembur, mode: e.target.value })
                  }
                >
                  <option value="otomatis">Otomatis dari absensi</option>
                  <option value="spl">Hanya dengan SPL disetujui</option>
                </select>
              </div>
              <div>
                <label className={LABEL} htmlFor="lembur-aturan-harian">
                  Batas per hari (jam)
                </label>
                <input
                  id="lembur-aturan-harian"
                  type="number"
                  min={1}
                  max={12}
                  className={INPUT}
                  value={String(lembur.maks_harian)}
                  onChange={(e) =>
                    setLembur({
                      ...lembur,
                      maks_harian: Number(e.target.value),
                    })
                  }
                />
              </div>
              <div>
                <label className={LABEL} htmlFor="lembur-aturan-mingguan">
                  Batas per minggu (jam)
                </label>
                <input
                  id="lembur-aturan-mingguan"
                  type="number"
                  min={1}
                  max={72}
                  className={INPUT}
                  value={String(lembur.maks_mingguan)}
                  onChange={(e) =>
                    setLembur({
                      ...lembur,
                      maks_mingguan: Number(e.target.value),
                    })
                  }
                />
              </div>
              <p className="text-xs text-slate-400 sm:col-span-3">
                Mode SPL: per tanggal, lembur dibayar paling banyak sebesar jam
                SPL yang disetujui, termasuk kerja di hari libur. Batas jam
                hanya peringatan. Gaji harian tidak membayar lembur di kedua
                mode.
              </p>
            </>
          ) : null}
          <h3 className="text-sm font-bold text-white sm:col-span-3">
            Reimbursement
          </h3>
          <div>
            <label className={LABEL} htmlFor="reimburse-aturan-mode">
              Klaim disetujui dibayar
            </label>
            <select
              id="reimburse-aturan-mode"
              className={INPUT}
              value={modeReimburse}
              onChange={(e) => setModeReimburse(e.target.value)}
            >
              <option value="terpisah">Terpisah (tab Pembayaran)</option>
              <option value="gaji">Ikut proses gaji</option>
            </select>
          </div>
          <p className="text-xs text-slate-400 sm:col-span-2">
            Ikut gaji: ditambahkan ke gaji bersih sesudah kasbon, tidak kena
            pajak dan BPJS. Pembayaran terpisah tetap tersedia di kedua mode,
            dan cuti diuangkan selalu dibayar terpisah.
          </p>
          <div className="sm:col-span-3">
            <button
              type="button"
              id="cuti-aturan-simpan"
              className={TOMBOL_UTAMA}
              disabled={sibuk}
              onClick={() => void simpanAturan()}
            >
              Simpan aturan cuti, lembur, dan reimbursement
            </button>
          </div>
        </section>
      ) : null}
      {pesan ? (
        <output className="block text-sm text-slate-300">{pesan}</output>
      ) : null}
    </div>
  );
}
