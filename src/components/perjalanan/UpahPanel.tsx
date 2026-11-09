"use client";

import {
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  INPUT,
  LABEL,
  pesanGalat,
  TOMBOL_BAHAYA,
  TOMBOL_KEDUA,
  TOMBOL_UTAMA,
} from "@/components/inventory/gaya";
import { konfirmasiData } from "@/components/ui/KonfirmasiData";
import { Modal } from "@/components/ui/Modal";
import { hasPermission } from "@/lib/auth/access";
import { saveFileWithPicker } from "@/lib/client/download";
import { useAuth } from "@/lib/context/AuthContext";
import { getCompanyBranding } from "@/lib/gateways/company-profile";
import {
  batalBayarUpah,
  catatBayarUpah,
  daftarBayarUpah,
  type PerjalananItem,
  rekapUpah,
} from "@/lib/gateways/driver";
import { subscribeSyncCompleted } from "@/lib/gateways/sync-status";
import { isMobileRuntime } from "@/lib/runtime/app-runtime";
import { formatRupiah } from "@/lib/validations/accounting";
import type { PembayaranUpahItem } from "@/lib/validations/driver";
import { cetakTandaTerimaUpah } from "./cetakTandaTerimaUpah";
import {
  belumDibayarPerDriver,
  bukuRekapUpah,
  type DasarRekap,
  JUDUL_DASAR,
  kelompokRekap,
  type TagihanDriver,
} from "./rekapUpah";

/**
 * Tab Upah (PRD §4.1c): rekap upah surat jalan, tandai dibayar per driver,
 * riwayat + pembatalan, tanda terima A4, dan ekspor Excel. Upah, penerima,
 * dan status bayar selalu dari backend. Pembukuannya dicatat manual lewat
 * jurnal di Keuangan (Q-28). Mencatat dan membatalkan butuh `trip.pay`.
 */

const GALAT_KOTAK =
  "p-3 rounded-lg border border-rose-500/30 bg-rose-500/20 text-sm text-rose-100";
const MIME_XLSX =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

function hariIniWib(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta" }).format(
    new Date(),
  );
}

function bulanIni(): { dari: string; sampai: string } {
  const hari = hariIniWib();
  return { dari: `${hari.slice(0, 8)}01`, sampai: hari };
}

async function cetak(bayar: PembayaranUpahItem) {
  const kop = await getCompanyBranding().catch(() => ({
    company_name: null,
    logo_url: null,
  }));
  cetakTandaTerimaUpah(bayar, kop);
}

export function UpahPanel() {
  const { user } = useAuth();
  const bolehBayar = hasPermission(user, "trip.pay");
  const bolehCetak = !isMobileRuntime();

  const [{ dari, sampai }, setRentang] = useState(bulanIni);
  const [dasar, setDasar] = useState<DasarRekap>("driver");
  const [items, setItems] = useState<PerjalananItem[] | null>(null);
  const [pembayaran, setPembayaran] = useState<PembayaranUpahItem[]>([]);
  const [galat, setGalat] = useState<string | null>(null);
  const [pesan, setPesan] = useState<string | null>(null);
  const [bayarUntuk, setBayarUntuk] = useState<TagihanDriver | null>(null);
  const [dibatalkan, setDibatalkan] = useState<PembayaranUpahItem | null>(null);

  const muat = useCallback(async () => {
    setGalat(null);
    try {
      const [rekap, riwayat] = await Promise.all([
        rekapUpah(dari, sampai),
        daftarBayarUpah(dari, sampai),
      ]);
      setItems(rekap.items);
      setPembayaran(riwayat.items);
    } catch (error) {
      setGalat(pesanGalat(error, "Rekap upah tidak bisa dimuat."));
    }
  }, [dari, sampai]);

  useEffect(() => {
    void muat();
  }, [muat]);
  useEffect(() => subscribeSyncCompleted(() => void muat()), [muat]);

  const tagihan = useMemo(() => belumDibayarPerDriver(items ?? []), [items]);
  const rekap = useMemo(
    () => kelompokRekap(items ?? [], dasar),
    [items, dasar],
  );
  const total = rekap.reduce(
    (s, b) => ({
      upah: s.upah + b.upah,
      dibayar: s.dibayar + b.dibayar,
      belum: s.belum + b.belumDibayar,
    }),
    { upah: 0, dibayar: 0, belum: 0 },
  );

  async function ekspor() {
    if (!items) return;
    setGalat(null);
    try {
      const isi = bukuRekapUpah(items, pembayaran);
      const hasil = await saveFileWithPicker(
        new Blob([isi as unknown as BlobPart], { type: MIME_XLSX }),
        `Rekap_Upah_Surat_Jalan_${dari}_sd_${sampai}.xlsx`,
        {
          description: "Spreadsheet Excel (.xlsx)",
          accept: { [MIME_XLSX]: [".xlsx"] },
        },
      );
      if (!hasil.cancelled) setPesan("Rekap upah diekspor.");
    } catch (error) {
      setGalat(pesanGalat(error, "Rekap upah tidak bisa diekspor."));
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-400">
        Upah surat jalan dibayar terpisah dari gaji. Setelah dibayar, catat
        pengeluarannya lewat jurnal manual di Keuangan.
      </p>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 lg:items-end">
        <div>
          <label className={LABEL} htmlFor="upah-dari">
            Surat jalan dari tanggal
          </label>
          <input
            id="upah-dari"
            type="date"
            className={INPUT}
            value={dari}
            onChange={(e) =>
              setRentang((r) => ({ ...r, dari: e.target.value }))
            }
          />
        </div>
        <div>
          <label className={LABEL} htmlFor="upah-sampai">
            Sampai tanggal
          </label>
          <input
            id="upah-sampai"
            type="date"
            className={INPUT}
            value={sampai}
            onChange={(e) =>
              setRentang((r) => ({ ...r, sampai: e.target.value }))
            }
          />
        </div>
        <div>
          <button
            type="button"
            id="upah-ekspor"
            className={TOMBOL_KEDUA}
            disabled={!items || items.length === 0}
            onClick={() => void ekspor()}
          >
            Ekspor Excel
          </button>
        </div>
      </div>

      {galat ? (
        <div className={GALAT_KOTAK} role="alert">
          {galat}
        </div>
      ) : null}
      {pesan ? (
        <output className="block p-3 rounded-lg border border-emerald-500/30 bg-emerald-500/15 text-sm text-emerald-100">
          {pesan}
        </output>
      ) : null}

      <section aria-labelledby="upah-belum-judul" className="space-y-2">
        <h2
          id="upah-belum-judul"
          className="text-sm font-semibold text-slate-100"
        >
          Belum dibayar
        </h2>
        {items === null ? (
          <p className="text-sm text-slate-400">Memuat...</p>
        ) : tagihan.length === 0 ? (
          <p className="text-sm text-slate-300">
            Semua surat jalan Selesai pada rentang ini sudah dibayar.
          </p>
        ) : (
          <ul className="grid gap-2 sm:grid-cols-2">
            {tagihan.map((t) => (
              <li
                key={t.id_karyawan}
                className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-white/10 bg-slate-900/60 p-3"
              >
                <div className="text-sm">
                  <p className="font-medium text-slate-100">{t.nama}</p>
                  <p className="text-slate-300">
                    {t.items.length} surat jalan · {formatRupiah(t.total)}
                  </p>
                </div>
                {bolehBayar ? (
                  <button
                    type="button"
                    id={`upah-bayar-${t.id_karyawan}`}
                    className={TOMBOL_UTAMA}
                    onClick={() => setBayarUntuk(t)}
                  >
                    Tandai dibayar
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="upah-rekap-judul" className="space-y-2">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <h2
            id="upah-rekap-judul"
            className="text-sm font-semibold text-slate-100"
          >
            Rekap per {JUDUL_DASAR[dasar].toLowerCase()}
          </h2>
          <div>
            <label className={LABEL} htmlFor="upah-dasar">
              Kelompokkan menurut
            </label>
            <select
              id="upah-dasar"
              className={INPUT}
              value={dasar}
              onChange={(e) => setDasar(e.target.value as DasarRekap)}
            >
              <option value="driver">Driver (penerima upah)</option>
              <option value="kendaraan">Kendaraan awal</option>
              <option value="tanggal">Tanggal surat jalan</option>
            </select>
          </div>
        </div>
        <div className="overflow-x-auto rounded-xl border border-white/10">
          <table className="w-full min-w-[40rem] text-left text-sm text-slate-200">
            <thead className="bg-slate-900/80 text-xs text-slate-400">
              <tr>
                <th scope="col" className="px-3 py-2">
                  {JUDUL_DASAR[dasar]}
                </th>
                <th scope="col" className="px-3 py-2 text-right">
                  Selesai
                </th>
                <th scope="col" className="px-3 py-2 text-right">
                  Belum selesai
                </th>
                <th scope="col" className="px-3 py-2 text-right">
                  Tidak Jalan
                </th>
                <th scope="col" className="px-3 py-2 text-right">
                  Dibatalkan
                </th>
                <th scope="col" className="px-3 py-2 text-right">
                  Upah
                </th>
                <th scope="col" className="px-3 py-2 text-right">
                  Dibayar
                </th>
                <th scope="col" className="px-3 py-2 text-right">
                  Belum dibayar
                </th>
              </tr>
            </thead>
            <tbody>
              {rekap.map((b) => (
                <tr key={b.kunci} className="border-t border-white/5">
                  <td className="px-3 py-2">{b.label}</td>
                  <td className="px-3 py-2 text-right">{b.selesai}</td>
                  <td className="px-3 py-2 text-right">{b.belumSelesai}</td>
                  <td className="px-3 py-2 text-right">{b.tidakJalan}</td>
                  <td className="px-3 py-2 text-right">{b.dibatalkan}</td>
                  <td className="px-3 py-2 text-right">
                    {formatRupiah(b.upah)}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {formatRupiah(b.dibayar)}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {formatRupiah(b.belumDibayar)}
                  </td>
                </tr>
              ))}
              {rekap.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-3 py-3 text-slate-400">
                    Tidak ada surat jalan pada rentang tanggal ini.
                  </td>
                </tr>
              ) : null}
            </tbody>
            {rekap.length > 0 ? (
              <tfoot className="border-t border-white/10 font-semibold">
                <tr>
                  <td colSpan={5} className="px-3 py-2">
                    Total
                  </td>
                  <td className="px-3 py-2 text-right">
                    {formatRupiah(total.upah)}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {formatRupiah(total.dibayar)}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {formatRupiah(total.belum)}
                  </td>
                </tr>
              </tfoot>
            ) : null}
          </table>
        </div>
      </section>

      <section aria-labelledby="upah-riwayat-judul" className="space-y-2">
        <h2
          id="upah-riwayat-judul"
          className="text-sm font-semibold text-slate-100"
        >
          Riwayat pembayaran (tanggal bayar dalam rentang)
        </h2>
        {pembayaran.length === 0 ? (
          <p className="text-sm text-slate-300">Belum ada pembayaran.</p>
        ) : (
          <ul className="space-y-2">
            {pembayaran.map((p) => (
              <li
                key={p.id_bayar}
                className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-white/10 bg-slate-900/60 p-3 text-sm"
              >
                <div>
                  <p className="font-medium text-slate-100">
                    {p.nama_karyawan ?? p.id_karyawan} · {formatRupiah(p.total)}
                    {p.alasan_batal !== null ? (
                      <span className="ml-2 rounded-full border border-rose-400/40 bg-rose-400/15 px-2 py-0.5 text-xs text-rose-100">
                        Dibatalkan
                      </span>
                    ) : null}
                  </p>
                  <p className="text-slate-300">
                    {p.tanggal} · {p.surat_jalan.length} surat jalan · dicatat{" "}
                    {p.dicatat_oleh}
                  </p>
                  {p.alasan_batal !== null ? (
                    <p className="text-rose-100">
                      Dibatalkan {p.tanggal_batal}: {p.alasan_batal}
                    </p>
                  ) : null}
                </div>
                <div className="flex flex-wrap gap-2">
                  {bolehCetak ? (
                    <button
                      type="button"
                      id={`upah-cetak-${p.id_bayar}`}
                      className={TOMBOL_KEDUA}
                      onClick={() =>
                        void cetak(p).catch((error) =>
                          setGalat(
                            pesanGalat(
                              error,
                              "Tanda terima tidak bisa dicetak.",
                            ),
                          ),
                        )
                      }
                    >
                      Cetak tanda terima
                    </button>
                  ) : null}
                  {bolehBayar && p.alasan_batal === null ? (
                    <button
                      type="button"
                      id={`upah-batal-${p.id_bayar}`}
                      className={TOMBOL_BAHAYA}
                      onClick={() => setDibatalkan(p)}
                    >
                      Batalkan
                    </button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {bayarUntuk ? (
        <DialogBayar
          tagihan={bayarUntuk}
          onClose={() => setBayarUntuk(null)}
          onTersimpan={(teks) => {
            setBayarUntuk(null);
            setPesan(teks);
            void muat();
          }}
        />
      ) : null}
      {dibatalkan ? (
        <DialogBatal
          bayar={dibatalkan}
          onClose={() => setDibatalkan(null)}
          onTersimpan={() => {
            setDibatalkan(null);
            setPesan(
              "Pembayaran dibatalkan. Surat jalannya bisa dibayar lagi.",
            );
            void muat();
          }}
        />
      ) : null}
    </div>
  );
}

function DialogBayar({
  tagihan,
  onClose,
  onTersimpan,
}: {
  tagihan: TagihanDriver;
  onClose: () => void;
  onTersimpan: (pesan: string) => void;
}) {
  const [dipilih, setDipilih] = useState(
    () => new Set(tagihan.items.map((i) => i.id_perjalanan)),
  );
  const [tanggal, setTanggal] = useState(hariIniWib);
  const [keterangan, setKeterangan] = useState("");
  const [galat, setGalat] = useState<string | null>(null);
  const [menyimpan, setMenyimpan] = useState(false);
  const isSubmittingRef = useRef(false);

  const terpilih = tagihan.items.filter((i) => dipilih.has(i.id_perjalanan));
  const total = terpilih.reduce((s, i) => s + i.upah, 0);

  function pilih(id: string, ya: boolean) {
    setDipilih((lama) => {
      const baru = new Set(lama);
      if (ya) baru.add(id);
      else baru.delete(id);
      return baru;
    });
  }

  async function kirim(event: FormEvent) {
    event.preventDefault();
    if (isSubmittingRef.current) return;
    setGalat(null);
    if (terpilih.length === 0) {
      setGalat("Pilih minimal satu surat jalan.");
      return;
    }
    if (!tanggal) {
      setGalat("Tanggal bayar tidak valid.");
      return;
    }
    const setuju = await konfirmasiData([
      { label: "Driver", nilai: tagihan.nama },
      { label: "Tanggal bayar", nilai: tanggal },
      { label: "Surat jalan", nilai: `${terpilih.length} surat jalan` },
      { label: "Total upah", nilai: formatRupiah(total) },
      { label: "Keterangan", nilai: keterangan },
    ]);
    if (!setuju) return;
    isSubmittingRef.current = true;
    setMenyimpan(true);
    try {
      const hasil = await catatBayarUpah({
        id_karyawan: tagihan.id_karyawan,
        tanggal,
        id_perjalanan: terpilih.map((i) => i.id_perjalanan),
        keterangan: keterangan || null,
      });
      onTersimpan(
        `Upah ${tagihan.nama} ${formatRupiah(hasil.total)} ditandai dibayar. Cetak tanda terimanya dari Riwayat pembayaran.`,
      );
    } catch (error) {
      setGalat(pesanGalat(error, "Pembayaran tidak bisa dicatat."));
    } finally {
      isSubmittingRef.current = false;
      setMenyimpan(false);
    }
  }

  return (
    <Modal
      isOpen
      title="Tandai upah dibayar"
      titleId="upah-bayar-title"
      subtitle={tagihan.nama}
      onClose={onClose}
      maxWidth="max-w-2xl"
    >
      <form id="form-upah-bayar" onSubmit={kirim} className="space-y-4">
        <fieldset className="space-y-1">
          <legend className={LABEL}>Surat jalan yang dibayar</legend>
          <ul className="max-h-72 space-y-1 overflow-y-auto">
            {tagihan.items.map((i) => (
              <li key={i.id_perjalanan}>
                <label className="flex min-h-11 items-center gap-3 rounded-lg px-2 text-sm text-slate-200 hover:bg-slate-800/60">
                  <input
                    type="checkbox"
                    id={`upah-pilih-${i.id_perjalanan}`}
                    className="h-4 w-4"
                    checked={dipilih.has(i.id_perjalanan)}
                    onChange={(e) => pilih(i.id_perjalanan, e.target.checked)}
                  />
                  <span className="flex-1">
                    {i.tanggal} · {i.nomor}
                  </span>
                  <span>{formatRupiah(i.upah)}</span>
                </label>
              </li>
            ))}
          </ul>
        </fieldset>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className={LABEL} htmlFor="upah-tanggal">
              Tanggal bayar
            </label>
            <input
              id="upah-tanggal"
              type="date"
              className={INPUT}
              value={tanggal}
              onChange={(e) => setTanggal(e.target.value)}
            />
          </div>
          <div>
            <label className={LABEL} htmlFor="upah-keterangan">
              Keterangan (opsional)
            </label>
            <input
              id="upah-keterangan"
              className={INPUT}
              maxLength={500}
              value={keterangan}
              onChange={(e) => setKeterangan(e.target.value)}
            />
          </div>
        </div>
        <p className="text-sm font-medium text-slate-100">
          Total: {formatRupiah(total)} ({terpilih.length} surat jalan)
        </p>
        {galat ? (
          <div className={GALAT_KOTAK} role="alert">
            {galat}
          </div>
        ) : null}
        <div className="flex justify-end gap-2">
          <button type="button" className={TOMBOL_KEDUA} onClick={onClose}>
            Batal
          </button>
          <button
            type="submit"
            id="upah-bayar-simpan"
            className={TOMBOL_UTAMA}
            disabled={menyimpan}
          >
            {menyimpan ? "Menyimpan..." : "Tandai dibayar"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function DialogBatal({
  bayar,
  onClose,
  onTersimpan,
}: {
  bayar: PembayaranUpahItem;
  onClose: () => void;
  onTersimpan: () => void;
}) {
  const [alasan, setAlasan] = useState("");
  const [galat, setGalat] = useState<string | null>(null);
  const [menyimpan, setMenyimpan] = useState(false);
  const isSubmittingRef = useRef(false);

  async function kirim(event: FormEvent) {
    event.preventDefault();
    if (isSubmittingRef.current) return;
    setGalat(null);
    isSubmittingRef.current = true;
    setMenyimpan(true);
    try {
      await batalBayarUpah({ id_bayar: bayar.id_bayar, alasan });
      onTersimpan();
    } catch (error) {
      setGalat(pesanGalat(error, "Pembayaran tidak bisa dibatalkan."));
    } finally {
      isSubmittingRef.current = false;
      setMenyimpan(false);
    }
  }

  return (
    <Modal
      isOpen
      title="Batalkan pembayaran upah"
      titleId="upah-batal-title"
      subtitle={`${bayar.nama_karyawan ?? bayar.id_karyawan} · ${formatRupiah(bayar.total)}`}
      onClose={onClose}
    >
      <form id="form-upah-batal" onSubmit={kirim} className="space-y-4">
        <p className="text-sm text-amber-100">
          {bayar.surat_jalan.length} surat jalan kembali menjadi belum dibayar.
          Bila jurnalnya sudah dicatat di Keuangan, batalkan jurnal itu juga.
        </p>
        <div>
          <label className={LABEL} htmlFor="upah-batal-alasan">
            Alasan
          </label>
          <textarea
            id="upah-batal-alasan"
            className={INPUT}
            rows={3}
            maxLength={500}
            value={alasan}
            onChange={(e) => setAlasan(e.target.value)}
          />
        </div>
        {galat ? (
          <div className={GALAT_KOTAK} role="alert">
            {galat}
          </div>
        ) : null}
        <div className="flex justify-end gap-2">
          <button type="button" className={TOMBOL_KEDUA} onClick={onClose}>
            Kembali
          </button>
          <button
            type="submit"
            id="upah-batal-simpan"
            className={TOMBOL_BAHAYA}
            disabled={menyimpan}
          >
            {menyimpan ? "Menyimpan..." : "Batalkan pembayaran"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
