"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  angka,
  hariIniWib,
  INPUT,
  LABEL,
  pesanGalat,
  TOMBOL_KEDUA,
  TOMBOL_UTAMA,
} from "@/components/inventory/gaya";
import { PengajuanKeuangan } from "@/components/inventory/Pengajuan";
import type { AkunItem } from "@/lib/gateways/accounting";
import {
  catatJurnalInventaris,
  getJurnalInventaris,
} from "@/lib/gateways/inventory";
import { subscribeSyncCompleted } from "@/lib/gateways/sync-status";
import { formatRupiah } from "@/lib/validations/accounting";
import {
  AKUN_JURNAL_INVENTARIS_BAWAAN,
  type DaftarJurnalInventaris,
  KELOMPOK_AKUN_JURNAL_INVENTARIS,
  MAKS_JURNAL_INVENTARIS,
} from "@/lib/validations/inventory";
import { tanggalTampil } from "@/lib/validations/tutup-buku";

type PeranAkun = keyof typeof AKUN_JURNAL_INVENTARIS_BAWAAN;

const LABEL_PERAN: Record<PeranAkun, string> = {
  akun_debit_aset: "Akun barang Aset",
  akun_debit_habis_pakai: "Akun barang Habis Pakai",
  akun_kredit_bayar: "Dibayar dari",
  akun_kredit_hibah: "Akun pendapatan hibah",
  akun_debit_servis: "Akun biaya servis",
};

function akunUntuk(akun: AkunItem[], peran: PeranAkun): AkunItem[] {
  const kelompok: readonly string[] = KELOMPOK_AKUN_JURNAL_INVENTARIS[peran];
  return akun.filter((a) => a.is_aktif && kelompok.includes(a.kelompok));
}

/**
 * Tab "Dari Inventaris": pengadaan, hibah, dan biaya servis yang belum
 * dijurnal; dicatat per baris oleh pemegang `accounting.manage`. Juga daftar jurnal yang
 * mutasinya sudah dibatalkan di perangkat lain tetapi jurnalnya belum dibalik.
 * Dipakai Web/Desktop dan Mobile (disalin lewat `filesToCopy`).
 */
export function JurnalInventaris({
  akun,
  bolehKelola,
  onInfo,
  onBerubah,
}: {
  akun: AkunItem[];
  bolehKelola: boolean;
  onInfo: (pesan: string) => void;
  onBerubah: () => void;
}) {
  const hariIni = hariIniWib();
  const [dari, setDari] = useState(`${hariIni.slice(0, 5)}01-01`);
  const [sampai, setSampai] = useState(hariIni);
  const [data, setData] = useState<DaftarJurnalInventaris | null>(null);
  const [galat, setGalat] = useState<string | null>(null);
  const [dipilih, setDipilih] = useState<Set<string>>(new Set());
  const [pilihanAkun, setPilihanAkun] = useState<Record<PeranAkun, string>>(
    () => {
      const awal = {} as Record<PeranAkun, string>;
      for (const peran of Object.keys(LABEL_PERAN) as PeranAkun[]) {
        const bawaan = AKUN_JURNAL_INVENTARIS_BAWAAN[peran];
        awal[peran] = akunUntuk(akun, peran).some((a) => a.id_akun === bawaan)
          ? bawaan
          : "";
      }
      return awal;
    },
  );
  const [sibuk, setSibuk] = useState(false);
  const [galatSimpan, setGalatSimpan] = useState<string | null>(null);
  const isSubmittingRef = useRef(false);
  // Pengajuan yang laporan penerimaannya dibuka dari baris Belum dijurnal.
  const [lihatPengajuan, setLihatPengajuan] = useState<string | null>(null);

  const muat = useCallback(async () => {
    setGalat(null);
    try {
      setData(await getJurnalInventaris(dari, sampai));
      setDipilih(new Set());
    } catch (error) {
      setData(null);
      setGalat(pesanGalat(error, "Daftar dari inventaris tidak bisa dimuat."));
    }
  }, [dari, sampai]);

  useEffect(() => {
    void muat();
  }, [muat]);
  useEffect(() => subscribeSyncCompleted(() => void muat()), [muat]);

  const bisaDipilih = useMemo(
    () => (data?.baris ?? []).filter((b) => !b.periode_tertutup),
    [data],
  );
  const servisBisaDipilih = useMemo(
    () => (data?.servis ?? []).filter((s) => !s.periode_tertutup),
    [data],
  );
  const terpilih = bisaDipilih.filter((b) => dipilih.has(b.id_mutasi));
  const servisTerpilih = servisBisaDipilih.filter((s) =>
    dipilih.has(s.id_servis),
  );
  const jumlahTerpilih = terpilih.length + servisTerpilih.length;
  const totalTerpilih =
    terpilih.reduce((sum, b) => sum + b.nilai, 0) +
    servisTerpilih.reduce((sum, s) => sum + s.nilai, 0);
  const peranDibutuhkan = new Set<PeranAkun>();
  for (const b of terpilih) {
    peranDibutuhkan.add(
      b.tipe === "Aset" ? "akun_debit_aset" : "akun_debit_habis_pakai",
    );
    peranDibutuhkan.add(
      b.alasan === "Hibah" ? "akun_kredit_hibah" : "akun_kredit_bayar",
    );
  }
  if (servisTerpilih.length > 0) {
    peranDibutuhkan.add("akun_debit_servis");
    peranDibutuhkan.add("akun_kredit_bayar");
  }
  const semuaBisaDipilih = [
    ...bisaDipilih.map((b) => b.id_mutasi),
    ...servisBisaDipilih.map((s) => s.id_servis),
  ];
  const semuaDipilih =
    semuaBisaDipilih.length > 0 && jumlahTerpilih === semuaBisaDipilih.length;

  function ubahPilihan(id: string, aktif: boolean) {
    setDipilih((lama) => {
      const baru = new Set(lama);
      if (aktif) baru.add(id);
      else baru.delete(id);
      return baru;
    });
  }

  async function kirim(draft: Parameters<typeof catatJurnalInventaris>[0]) {
    if (isSubmittingRef.current) return;
    isSubmittingRef.current = true;
    setSibuk(true);
    setGalatSimpan(null);
    try {
      const hasil = await catatJurnalInventaris(draft);
      onInfo(
        hasil.dibalik > 0
          ? `${hasil.dibalik} jurnal dibalik.`
          : `${hasil.dijurnal} baris dicatat ke jurnal.`,
      );
      onBerubah();
      await muat();
    } catch (error) {
      setGalatSimpan(pesanGalat(error, "Jurnal tidak bisa dicatat."));
    } finally {
      isSubmittingRef.current = false;
      setSibuk(false);
    }
  }

  function catat() {
    const akunDraft: Partial<Record<PeranAkun, string>> = {};
    for (const peran of peranDibutuhkan) akunDraft[peran] = pilihanAkun[peran];
    void kirim({
      id_mutasi: terpilih.map((b) => b.id_mutasi),
      id_servis: servisTerpilih.map((s) => s.id_servis),
      ...akunDraft,
    });
  }

  return (
    <div className="space-y-4">
      <PengajuanKeuangan
        bolehKelola={bolehKelola}
        dari={dari}
        sampai={sampai}
        lihat={lihatPengajuan}
        onTutupLihat={() => setLihatPengajuan(null)}
        onInfo={onInfo}
        onBerubah={onBerubah}
      />
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label htmlFor="jinv-dari" className={LABEL}>
            Dari tanggal
          </label>
          <input
            id="jinv-dari"
            type="date"
            value={dari}
            onChange={(e) => setDari(e.target.value)}
            className={INPUT}
          />
        </div>
        <div>
          <label htmlFor="jinv-sampai" className={LABEL}>
            Sampai tanggal
          </label>
          <input
            id="jinv-sampai"
            type="date"
            value={sampai}
            onChange={(e) => setSampai(e.target.value)}
            className={INPUT}
          />
        </div>
      </div>

      {galat ? (
        <div className="p-4 rounded-xl border border-rose-500/30 bg-rose-500/20 text-sm text-rose-100 space-y-3">
          <p>{galat}</p>
          <button
            type="button"
            onClick={() => void muat()}
            className={TOMBOL_KEDUA}
          >
            Coba muat lagi
          </button>
        </div>
      ) : !data ? (
        <p className="p-10 text-center text-sm text-slate-400">Memuat...</p>
      ) : (
        <>
          {data.perlu_dibalik.length > 0 ? (
            <section className="p-4 rounded-xl border border-amber-500/30 bg-amber-500/10 space-y-3">
              <h3 className="text-sm font-semibold text-amber-200">
                Mutasinya sudah dibatalkan, jurnalnya belum dibalik
              </h3>
              <p className="text-sm text-slate-300">
                Pembatalan dan penjurnalan tercatat di dua perangkat yang belum
                saling sinkron.
              </p>
              <ul className="space-y-1 text-sm text-slate-200">
                {data.perlu_dibalik.map((j) => (
                  <li key={j.id_jurnal}>
                    {j.nomor} · {tanggalTampil(j.tanggal)} · {j.keterangan}
                  </li>
                ))}
              </ul>
              {bolehKelola ? (
                <button
                  type="button"
                  className={TOMBOL_KEDUA}
                  disabled={sibuk}
                  onClick={() =>
                    void kirim({
                      balik: data.perlu_dibalik.map((j) => j.id_jurnal),
                    })
                  }
                >
                  Balik {data.perlu_dibalik.length} jurnal
                </button>
              ) : null}
            </section>
          ) : null}

          {data.baris.length === 0 && data.servis.length === 0 ? (
            <p className="p-10 text-center text-sm text-slate-400">
              Semua pengadaan, hibah, dan biaya servis di rentang ini sudah
              dijurnal.
            </p>
          ) : (
            <section className="space-y-3">
              {data.batas_tutup ? (
                <p className="text-sm text-slate-400">
                  Baris sampai {tanggalTampil(data.batas_tutup)} masuk periode
                  yang sudah ditutup dan tidak bisa dijurnal.
                </p>
              ) : null}
              {data.terpotong ? (
                <p className="text-sm text-amber-300">
                  Hanya {data.baris.length} baris pertama yang tampil. Persempit
                  rentang tanggalnya.
                </p>
              ) : null}
              {bolehKelola ? (
                <label className="flex items-center gap-2 text-sm text-slate-200">
                  <input
                    type="checkbox"
                    className="h-4 w-4"
                    checked={semuaDipilih}
                    disabled={semuaBisaDipilih.length === 0}
                    onChange={(e) =>
                      setDipilih(
                        e.target.checked
                          ? new Set(
                              semuaBisaDipilih.slice(0, MAKS_JURNAL_INVENTARIS),
                            )
                          : new Set(),
                      )
                    }
                  />
                  Pilih semua yang bisa dijurnal
                </label>
              ) : null}
              <ul className="divide-y divide-slate-800 rounded-xl border border-slate-800">
                {data.baris.map((b) => (
                  <li key={b.id_mutasi} className="flex items-start gap-3 p-3">
                    {bolehKelola ? (
                      <input
                        type="checkbox"
                        className="mt-1 h-4 w-4"
                        aria-label={`Pilih ${b.nama_barang} ${tanggalTampil(b.tanggal)}`}
                        checked={dipilih.has(b.id_mutasi)}
                        disabled={b.periode_tertutup}
                        onChange={(e) =>
                          ubahPilihan(b.id_mutasi, e.target.checked)
                        }
                      />
                    ) : null}
                    <div className="min-w-0 flex-1 text-sm">
                      <p className="font-medium text-slate-100">
                        {b.nama_barang}{" "}
                        <span className="text-slate-400">
                          ({b.kode_barang})
                        </span>
                      </p>
                      <p className="text-slate-400">
                        {b.alasan} · {tanggalTampil(b.tanggal)} ·{" "}
                        {angka(b.jumlah, b.desimal)} {b.satuan} ×{" "}
                        {formatRupiah(b.harga_satuan)}
                        {b.sumber_dana ? ` · ${b.sumber_dana}` : ""}
                        {b.nomor_dokumen ? ` · ${b.nomor_dokumen}` : ""}
                        {b.periode_tertutup ? " · periode sudah ditutup" : ""}
                      </p>
                      {b.id_pengajuan ? (
                        <button
                          type="button"
                          onClick={() => setLihatPengajuan(b.id_pengajuan)}
                          className="mt-1 text-sm font-medium text-sky-300 underline underline-offset-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 rounded"
                        >
                          Lihat penerimaan
                        </button>
                      ) : null}
                    </div>
                    <span className="shrink-0 text-sm font-semibold tabular-nums text-slate-100">
                      {formatRupiah(b.nilai)}
                    </span>
                  </li>
                ))}
              </ul>
              {data.servis.length > 0 ? (
                <>
                  <h3 className="pt-2 text-sm font-semibold text-slate-200">
                    Biaya servis
                  </h3>
                  <ul className="divide-y divide-slate-800 rounded-xl border border-slate-800">
                    {data.servis.map((s) => (
                      <li
                        key={s.id_servis}
                        className="flex items-start gap-3 p-3"
                      >
                        {bolehKelola ? (
                          <input
                            type="checkbox"
                            className="mt-1 h-4 w-4"
                            aria-label={`Pilih servis ${s.nama_barang} ${tanggalTampil(s.tanggal)}`}
                            checked={dipilih.has(s.id_servis)}
                            disabled={s.periode_tertutup}
                            onChange={(e) =>
                              ubahPilihan(s.id_servis, e.target.checked)
                            }
                          />
                        ) : null}
                        <div className="min-w-0 flex-1 text-sm">
                          <p className="font-medium text-slate-100">
                            Servis {s.nama_barang}{" "}
                            <span className="text-slate-400">
                              ({s.kode_unit ?? s.kode_barang})
                            </span>
                          </p>
                          <p className="text-slate-400">
                            Selesai {tanggalTampil(s.tanggal)}
                            {s.penyedia ? ` · ${s.penyedia}` : ""}
                            {s.periode_tertutup
                              ? " · periode sudah ditutup"
                              : ""}
                          </p>
                        </div>
                        <span className="shrink-0 text-sm font-semibold tabular-nums text-slate-100">
                          {formatRupiah(s.nilai)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}
            </section>
          )}

          {bolehKelola && jumlahTerpilih > 0 ? (
            <section className="p-4 rounded-xl border border-slate-800 bg-slate-900/60 space-y-3">
              <p className="text-sm text-slate-200">
                {jumlahTerpilih} baris dipilih, total{" "}
                <span className="font-semibold tabular-nums">
                  {formatRupiah(totalTerpilih)}
                </span>
                . Satu baris menjadi satu jurnal, bertanggal penerimaan barang
                atau tanggal servis selesai.
              </p>
              <div className="grid gap-3 sm:grid-cols-2">
                {(Object.keys(LABEL_PERAN) as PeranAkun[])
                  .filter((peran) => peranDibutuhkan.has(peran))
                  .map((peran) => (
                    <div key={peran}>
                      <label htmlFor={`jinv-${peran}`} className={LABEL}>
                        {LABEL_PERAN[peran]}
                      </label>
                      <select
                        id={`jinv-${peran}`}
                        className={INPUT}
                        value={pilihanAkun[peran]}
                        onChange={(e) =>
                          setPilihanAkun((lama) => ({
                            ...lama,
                            [peran]: e.target.value,
                          }))
                        }
                      >
                        <option value="">Pilih akun</option>
                        {akunUntuk(akun, peran).map((a) => (
                          <option key={a.id_akun} value={a.id_akun}>
                            {a.kode} {a.nama}
                          </option>
                        ))}
                      </select>
                    </div>
                  ))}
              </div>
              {galatSimpan ? (
                <p role="alert" className="text-sm text-rose-300">
                  {galatSimpan}
                </p>
              ) : null}
              <button
                type="button"
                className={TOMBOL_UTAMA}
                disabled={
                  sibuk ||
                  [...peranDibutuhkan].some((peran) => !pilihanAkun[peran])
                }
                onClick={catat}
              >
                {sibuk ? "Mencatat..." : "Catat ke jurnal"}
              </button>
            </section>
          ) : galatSimpan ? (
            <p role="alert" className="text-sm text-rose-300">
              {galatSimpan}
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}
