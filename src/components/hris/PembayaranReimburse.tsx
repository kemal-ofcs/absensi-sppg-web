"use client";

// Pembayaran terpisah reimbursement dan cuti diuangkan (HRIS v39,
// prd-hris.md §19.4). Hanya pemegang `reimburse.decide`; status bayar, total,
// dan pembatalan dinilai backend.

import { useCallback, useEffect, useMemo, useState } from "react";
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
import {
  ambilRingkasanReimburse,
  batalkanBayarReimburse,
  bayarReimburse,
  type RingkasanReimburse,
} from "@/lib/gateways/hr-pengajuan";
import { SYNC_COMPLETED_EVENT, syncNow } from "@/lib/gateways/sync-status";
import { formatRupiah } from "@/lib/validations/accounting";

type KlaimBaris = RingkasanReimburse["belum_dibayar"][number];

export function PembayaranReimburse({
  onPesan,
}: {
  onPesan: (pesan: string) => void;
}) {
  const hariIni = hariIniWib();
  const [dari, setDari] = useState(`${hariIni.slice(0, 7)}-01`);
  const [sampai, setSampai] = useState(hariIni);
  const [data, setData] = useState<RingkasanReimburse | null>(null);
  const [pilih, setPilih] = useState<Set<string>>(new Set());
  const [tanggal, setTanggal] = useState("");
  const [keterangan, setKeterangan] = useState("");
  const [alasanBatal, setAlasanBatal] = useState<Record<string, string>>({});
  const [sibuk, setSibuk] = useState(false);

  const muat = useCallback(() => {
    ambilRingkasanReimburse(dari, sampai)
      .then(setData)
      .catch((error: unknown) =>
        onPesan(pesanGalat(error, "Data pembayaran gagal dimuat.")),
      );
  }, [dari, sampai, onPesan]);

  useEffect(() => {
    muat();
    window.addEventListener(SYNC_COMPLETED_EVENT, muat);
    return () => window.removeEventListener(SYNC_COMPLETED_EVENT, muat);
  }, [muat]);

  // Satu pembayaran = satu karyawan (§19.4).
  const perKaryawan = useMemo(() => {
    const kelompok = new Map<string, KlaimBaris[]>();
    for (const b of data?.belum_dibayar ?? []) {
      const daftar = kelompok.get(b.klaim.id_karyawan) ?? [];
      daftar.push(b);
      kelompok.set(b.klaim.id_karyawan, daftar);
    }
    return [...kelompok];
  }, [data]);

  const jalankan = async (kerja: () => Promise<unknown>, berhasil: string) => {
    setSibuk(true);
    try {
      await kerja();
      onPesan(berhasil);
      setPilih(new Set());
      muat();
    } catch (error) {
      onPesan(pesanGalat(error, "Gagal."));
    } finally {
      setSibuk(false);
    }
  };

  const bayar = async (idKaryawan: string, klaim: KlaimBaris[]) => {
    const dipilih = klaim.filter((k) => pilih.has(k.klaim.id_klaim));
    if (dipilih.length === 0) {
      onPesan("Pilih klaim yang dibayar.");
      return;
    }
    const total = dipilih.reduce((n, k) => n + k.klaim.nominal, 0);
    const lanjut = await konfirmasiData([
      { label: "Karyawan", nilai: dipilih[0]?.nama ?? idKaryawan },
      { label: "Klaim", nilai: `${dipilih.length} klaim` },
      { label: "Total", nilai: formatRupiah(total) },
      { label: "Tanggal bayar", nilai: tanggal || "Hari ini" },
      ...(keterangan ? [{ label: "Keterangan", nilai: keterangan }] : []),
    ]);
    if (!lanjut) return;
    await jalankan(
      () =>
        bayarReimburse({
          id_karyawan: idKaryawan,
          id_klaim: dipilih.map((k) => k.klaim.id_klaim),
          ...(tanggal ? { tanggal } : {}),
          ...(keterangan ? { keterangan } : {}),
        }),
      `Pembayaran ${formatRupiah(total)} tercatat.`,
    );
  };

  if (!data) return null;
  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-300">
        Cara bayar reimbursement:{" "}
        <strong className="text-white">
          {data.mode === "gaji" ? "ikut proses gaji" : "terpisah"}
        </strong>
        . Pembayaran terpisah tetap tersedia untuk semua klaim dan cuti
        diuangkan. Pembukuannya dicatat lewat jurnal manual.
      </p>

      <section className="space-y-3 rounded-2xl border border-slate-800 bg-slate-900 p-4">
        <h3 className="text-sm font-bold text-white">Belum dibayar</h3>
        {perKaryawan.length === 0 ? (
          <p className="text-sm text-slate-400">Tidak ada.</p>
        ) : (
          <>
            <div className="grid gap-2 sm:max-w-xl sm:grid-cols-2">
              <div>
                <label className={LABEL} htmlFor="reimburse-tanggal-bayar">
                  Tanggal bayar (kosong = hari ini)
                </label>
                <input
                  id="reimburse-tanggal-bayar"
                  type="date"
                  className={INPUT}
                  max={hariIni}
                  value={tanggal}
                  onChange={(e) => setTanggal(e.target.value)}
                />
              </div>
              <div>
                <label className={LABEL} htmlFor="reimburse-keterangan">
                  Keterangan
                </label>
                <input
                  id="reimburse-keterangan"
                  className={INPUT}
                  maxLength={500}
                  value={keterangan}
                  onChange={(e) => setKeterangan(e.target.value)}
                />
              </div>
            </div>
            {perKaryawan.map(([idKaryawan, klaim]) => (
              <div
                key={idKaryawan}
                className="space-y-2 rounded-xl border border-slate-800 p-3"
              >
                <p className="font-semibold text-white">
                  {klaim[0]?.nama ?? idKaryawan}
                </p>
                <ul className="space-y-1 text-sm">
                  {klaim.map((k) => (
                    <li key={k.klaim.id_klaim}>
                      <label
                        className="flex items-start gap-2 text-slate-200"
                        htmlFor={`reimburse-pilih-${k.klaim.id_klaim}`}
                      >
                        <input
                          id={`reimburse-pilih-${k.klaim.id_klaim}`}
                          type="checkbox"
                          className="mt-1"
                          checked={pilih.has(k.klaim.id_klaim)}
                          onChange={(e) => {
                            const baru = new Set(pilih);
                            if (e.target.checked) baru.add(k.klaim.id_klaim);
                            else baru.delete(k.klaim.id_klaim);
                            setPilih(baru);
                          }}
                        />
                        <span className="min-w-0 flex-1">
                          {k.klaim.tanggal} • {k.klaim.keterangan}
                        </span>
                        <span className="font-semibold">
                          {formatRupiah(k.klaim.nominal)}
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
                <button
                  type="button"
                  id={`reimburse-bayar-${idKaryawan}`}
                  className={TOMBOL_UTAMA}
                  disabled={sibuk}
                  onClick={() => void bayar(idKaryawan, klaim)}
                >
                  Bayar yang dipilih
                </button>
              </div>
            ))}
          </>
        )}
      </section>

      <section className="space-y-2 rounded-2xl border border-slate-800 bg-slate-900 p-4">
        <h3 className="text-sm font-bold text-white">Dalam proses gaji</h3>
        {data.proses_gaji.length === 0 ? (
          <p className="text-sm text-slate-400">Tidak ada.</p>
        ) : (
          <ul className="space-y-1 text-sm text-slate-200">
            {data.proses_gaji.map((k) => (
              <li key={k.klaim.id_klaim}>
                {k.nama ?? k.klaim.id_karyawan} • {k.klaim.tanggal} •{" "}
                {k.klaim.keterangan} • {formatRupiah(k.klaim.nominal)}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-3 rounded-2xl border border-slate-800 bg-slate-900 p-4">
        <h3 className="text-sm font-bold text-white">Riwayat pembayaran</h3>
        <div className="grid grid-cols-2 gap-2 sm:max-w-md">
          <div>
            <label className={LABEL} htmlFor="reimburse-riwayat-dari">
              Dari
            </label>
            <input
              id="reimburse-riwayat-dari"
              type="date"
              className={INPUT}
              value={dari}
              onChange={(e) => setDari(e.target.value)}
            />
          </div>
          <div>
            <label className={LABEL} htmlFor="reimburse-riwayat-sampai">
              Sampai
            </label>
            <input
              id="reimburse-riwayat-sampai"
              type="date"
              className={INPUT}
              value={sampai}
              onChange={(e) => setSampai(e.target.value)}
            />
          </div>
        </div>
        {data.riwayat.length === 0 ? (
          <p className="text-sm text-slate-400">Tidak ada.</p>
        ) : (
          <ul className="space-y-2 text-sm">
            {data.riwayat.map((r) => (
              <li
                key={r.bayar.id_bayar}
                className="space-y-1 rounded-xl border border-slate-800 p-3"
              >
                <p className="text-slate-200">
                  <span className="font-semibold text-white">
                    {r.nama ?? r.bayar.id_karyawan}
                  </span>{" "}
                  • {r.bayar.tanggal} • {formatRupiah(r.bayar.total)} •{" "}
                  {r.bayar.dicatat_oleh}
                  {r.bayar.keterangan ? ` • ${r.bayar.keterangan}` : ""}
                </p>
                <ul className="text-xs text-slate-400">
                  {r.baris.map((b) => (
                    <li key={b.baris.id_baris}>
                      {b.keterangan ?? b.baris.id_klaim} •{" "}
                      {formatRupiah(b.baris.nominal)}
                    </li>
                  ))}
                </ul>
                {r.batal ? (
                  <p className="text-xs text-rose-200">
                    Dibatalkan {r.batal.tanggal} oleh {r.batal.dicatat_oleh}
                    {r.batal.keterangan ? ` • ${r.batal.keterangan}` : ""}
                  </p>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    <input
                      id={`reimburse-alasan-batal-${r.bayar.id_bayar}`}
                      aria-label="Alasan pembatalan"
                      placeholder="Alasan pembatalan"
                      className={`${INPUT} min-w-0 flex-1`}
                      maxLength={500}
                      value={alasanBatal[r.bayar.id_bayar] ?? ""}
                      onChange={(e) =>
                        setAlasanBatal({
                          ...alasanBatal,
                          [r.bayar.id_bayar]: e.target.value,
                        })
                      }
                    />
                    <button
                      type="button"
                      className={TOMBOL_BAHAYA}
                      disabled={
                        sibuk || !(alasanBatal[r.bayar.id_bayar] ?? "").trim()
                      }
                      onClick={() =>
                        void jalankan(
                          () =>
                            batalkanBayarReimburse({
                              id_bayar: r.bayar.id_bayar,
                              alasan: alasanBatal[r.bayar.id_bayar],
                            }),
                          "Pembayaran dibatalkan.",
                        )
                      }
                    >
                      Batalkan
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
        <button
          type="button"
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
      </section>
    </div>
  );
}
