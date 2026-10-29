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
import { DialogAlasan } from "@/components/inventory/Pengajuan";
import { PilihAkunBayar } from "@/components/keuangan/PilihAkunBayar";
import { Modal } from "@/components/ui/Modal";
import { exportToExcel } from "@/lib/client/excel-export";
import { useAuth } from "@/lib/context/AuthContext";
import type { AkunItem } from "@/lib/gateways/accounting";
import {
  accUlangCicilan,
  batalBayarCicilan,
  catatBayarCicilan,
  type DaftarCicilan,
  getCicilan,
  type KontrakCicilan,
  type StatusCicilan,
  tutupCicilan,
} from "@/lib/gateways/cicilan";
import { subscribeSyncCompleted } from "@/lib/gateways/sync-status";
import { formatRupiah } from "@/lib/validations/accounting";
import {
  bagiPokokBunga,
  besaranCicilan,
  MAKS_ALASAN_BAYAR,
  MAKS_REFERENSI,
  proyeksiKas,
  STATUS_CICILAN,
} from "@/lib/validations/cicilan";
import { validatePemutus } from "@/lib/validations/inventory-pengajuan";
import { AKUN_KAS } from "@/lib/validations/loan";
import { tanggalTampil } from "@/lib/validations/tutup-buku";

/**
 * Tab Cicilan di Keuangan (v31): kontrak pembelian cicilan yang lahir dari
 * pengajuan, jadwal dan pembayarannya, proyeksi kas, dan yang perlu ditinjau.
 * Semua angka (status, sisa, pemisahan pokok/bunga) dihitung backend; layar
 * hanya mempratinjau pembayaran dengan aturan yang sama. Dipakai Web/Desktop
 * dan Mobile (disalin lewat `filesToCopy`).
 */

type SubmitRef = { current: boolean };
type Saringan = "aktif" | "semua" | StatusCicilan;
type Aksi =
  | { jenis: "Bayar" | "Denda" | "tutup"; kontrak: KontrakCicilan }
  | { jenis: "batal"; kontrak: KontrakCicilan; idBayar: string };

const WARNA_STATUS: Record<StatusCicilan, string> = {
  Draf: "text-slate-300",
  "Menunggu barang": "text-sky-300",
  "Menunggu ACC ulang": "text-amber-300",
  Berjalan: "text-sky-300",
  Menunggak: "text-rose-300",
  Lunas: "text-emerald-300",
  Ditutup: "text-slate-400",
  Dibatalkan: "text-slate-400",
};

const STATUS_AKTIF: readonly StatusCicilan[] = [
  "Menunggu barang",
  "Menunggu ACC ulang",
  "Berjalan",
  "Menunggak",
];

type Sel = string | number | boolean | null | undefined;

/** Pola `saveWorkbook` di `eksporKeuangan.ts`: baris berkunci judul kolom. */
function saveWorkbook(spec: {
  headers: string[];
  rows: Record<string, unknown>[];
  filename: string;
  sheetName: string;
}) {
  return exportToExcel(
    spec.filename,
    spec.sheetName,
    spec.headers,
    spec.rows.map((row) => spec.headers.map((header) => row[header] as Sel)),
  );
}

/** Hanya digit yang dibaca; titik pemisah ribuan boleh diketik. */
function bacaNominal(teks: string): number {
  const digit = teks.replace(/\D/g, "");
  return digit ? Number(digit) : 0;
}

function Rp({ nilai }: { nilai: number }) {
  return <span className="tabular-nums">{formatRupiah(nilai)}</span>;
}

function angsuranBerikutnya(k: KontrakCicilan) {
  const baris = k.jadwal.find((b) => b.status !== "Lunas");
  return baris ? { ...baris, sisa: baris.nominal - baris.terbayar } : null;
}

function namaBulan(bulan: string): string {
  const nama = [
    "Januari",
    "Februari",
    "Maret",
    "April",
    "Mei",
    "Juni",
    "Juli",
    "Agustus",
    "September",
    "Oktober",
    "November",
    "Desember",
  ];
  return `${nama[Number(bulan.slice(5, 7)) - 1] ?? bulan} ${bulan.slice(0, 4)}`;
}

function eksporDaftar(daftar: DaftarCicilan, kontrak: KontrakCicilan[]) {
  const headers = [
    "Nomor pengajuan",
    "Kreditur",
    "Nomor kontrak",
    "Barang",
    "Status",
    "Harga tunai",
    "Total bayar",
    "Bunga",
    "Tertutup",
    "Sisa pokok",
    "Sisa bunga",
    "Lebih bayar",
    "Denda dibayar",
    "Angsuran berikutnya",
  ];
  return saveWorkbook({
    headers,
    rows: kontrak.map((k) => {
      const berikut = angsuranBerikutnya(k);
      return {
        "Nomor pengajuan": k.nomor_pengajuan,
        Kreditur: k.kreditur,
        "Nomor kontrak": k.nomor_kontrak ?? "",
        Barang: k.barang,
        Status: k.status,
        "Harga tunai": k.harga_tunai,
        "Total bayar": k.total_bayar,
        Bunga: k.bunga,
        Tertutup: k.tertutup,
        "Sisa pokok": k.sisa_pokok,
        "Sisa bunga": k.sisa_bunga,
        "Lebih bayar": k.lebih_bayar,
        "Denda dibayar": k.total_denda,
        "Angsuran berikutnya": berikut
          ? `${berikut.jatuh_tempo} ${berikut.sisa}`
          : "",
      };
    }),
    filename: `kontrak-cicilan-${daftar.hari_ini}.xlsx`,
    sheetName: "Kontrak Cicilan",
  });
}

function eksporKartu(k: KontrakCicilan) {
  const headers = ["Tanggal", "Keterangan", "Nominal", "Potongan", "Status"];
  const rows: Record<string, unknown>[] = [
    { Tanggal: `Kartu kontrak ${k.kreditur} · ${k.nomor_pengajuan}` },
    {
      Tanggal: `Harga tunai ${k.harga_tunai} · total bayar ${k.total_bayar} · bunga ${k.bunga}`,
    },
    {},
    { Tanggal: "Jadwal" },
    ...k.jadwal.map((b) => ({
      Tanggal: b.jatuh_tempo,
      Keterangan: b.ke === 0 ? "Uang muka" : `Angsuran ${b.ke}`,
      Nominal: b.nominal,
      Status: `${b.status} (terbayar ${b.terbayar})`,
    })),
    {},
    { Tanggal: "Pembayaran" },
    ...k.bayar.map((y) => ({
      Tanggal: y.tanggal,
      Keterangan:
        y.jenis === "Denda"
          ? `Denda: ${y.keterangan ?? ""}`
          : `Bayar${y.alasan_potongan ? ` (potongan: ${y.alasan_potongan})` : ""}`,
      Nominal: y.nominal,
      Potongan: y.potongan,
      Status: y.batal
        ? `Dibatalkan: ${y.batal.alasan}`
        : (y.nomor_jurnal ?? ""),
    })),
  ];
  return saveWorkbook({
    headers,
    rows,
    filename: `kartu-cicilan-${k.nomor_pengajuan.replace(/[^A-Za-z0-9]+/g, "-")}.xlsx`,
    sheetName: "Kartu Kontrak",
  });
}

function DialogBayar({
  kontrak,
  jenis,
  hariIni,
  isSubmittingRef,
  onClose,
  onSelesai,
}: {
  kontrak: KontrakCicilan;
  jenis: "Bayar" | "Denda";
  hariIni: string;
  isSubmittingRef: SubmitRef;
  onClose: () => void;
  onSelesai: (message: string) => Promise<void>;
}) {
  const berikut = angsuranBerikutnya(kontrak);
  const sisa = Math.max(kontrak.total_bayar - kontrak.tertutup, 0);
  const [tanggal, setTanggal] = useState(hariIni);
  const [nominal, setNominal] = useState(
    jenis === "Bayar" && berikut ? String(berikut.sisa) : "",
  );
  const [potongan, setPotongan] = useState("");
  const [alasan, setAlasan] = useState("");
  const [keterangan, setKeterangan] = useState("");
  const [referensi, setReferensi] = useState("");
  const [idAkunBayar, setIdAkunBayar] = useState(AKUN_KAS);
  const [menyimpan, setMenyimpan] = useState(false);
  const [galat, setGalat] = useState<string | null>(null);

  const nilai = bacaNominal(nominal);
  const nilaiPotongan = jenis === "Bayar" ? bacaNominal(potongan) : 0;
  const [pokok, bunga] = bagiPokokBunga(
    besaranCicilan(kontrak.harga_tunai, kontrak.jadwal),
    kontrak.tertutup,
    kontrak.tertutup + nilai + nilaiPotongan,
  );

  const kirim = async (event: FormEvent) => {
    event.preventDefault();
    if (isSubmittingRef.current) return;
    isSubmittingRef.current = true;
    setMenyimpan(true);
    setGalat(null);
    try {
      await catatBayarCicilan({
        id_cicilan: kontrak.id_cicilan,
        jenis,
        tanggal,
        nominal: nilai,
        potongan: nilaiPotongan,
        alasan_potongan: alasan,
        keterangan,
        referensi,
        id_akun_bayar: idAkunBayar,
      });
      await onSelesai(
        jenis === "Bayar"
          ? "Pembayaran tercatat beserta jurnalnya."
          : "Denda tercatat beserta jurnalnya.",
      );
    } catch (error) {
      setGalat(pesanGalat(error, "Pembayaran tidak bisa disimpan."));
    } finally {
      isSubmittingRef.current = false;
      setMenyimpan(false);
    }
  };

  return (
    <Modal
      isOpen={true}
      onClose={onClose}
      title={`${jenis === "Bayar" ? "Catat pembayaran" : "Catat denda"} · ${kontrak.kreditur}`}
      titleId="keu-cil-bayar-judul"
      maxWidth="max-w-xl"
    >
      <form onSubmit={kirim} className="space-y-4 text-sm">
        {jenis === "Bayar" ? (
          <p className="text-slate-300">
            Sisa jadwal <Rp nilai={sisa} />
            {berikut
              ? ` · berikutnya ${berikut.ke === 0 ? "uang muka" : `angsuran ${berikut.ke}`} ${tanggalTampil(berikut.jatuh_tempo)}`
              : ""}
            . Uang dialokasikan ke jadwal mulai dari jatuh tempo terlama.
          </p>
        ) : (
          <p className="text-slate-300">
            Denda dicatat saat dibayar dan tidak mengurangi jadwal.
          </p>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor="keu-cil-tanggal" className={LABEL}>
              Tanggal bayar
            </label>
            <input
              id="keu-cil-tanggal"
              type="date"
              required
              min={kontrak.tanggal_pengajuan}
              max={hariIni}
              value={tanggal}
              onChange={(e) => setTanggal(e.target.value)}
              className={INPUT}
            />
          </div>
          <div>
            <label htmlFor="keu-cil-nominal" className={LABEL}>
              {jenis === "Bayar"
                ? "Nominal dibayar (Rp)"
                : "Nominal denda (Rp)"}
            </label>
            <input
              id="keu-cil-nominal"
              inputMode="numeric"
              autoComplete="off"
              required
              value={nominal}
              onChange={(e) => setNominal(e.target.value)}
              className={INPUT}
            />
          </div>
          {jenis === "Bayar" ? (
            <>
              <div>
                <label htmlFor="keu-cil-potongan" className={LABEL}>
                  Potongan dari kreditur (Rp, opsional)
                </label>
                <input
                  id="keu-cil-potongan"
                  inputMode="numeric"
                  autoComplete="off"
                  placeholder="0"
                  value={potongan}
                  onChange={(e) => setPotongan(e.target.value)}
                  className={INPUT}
                />
              </div>
              <div>
                <label htmlFor="keu-cil-alasan" className={LABEL}>
                  Alasan potongan
                </label>
                <input
                  id="keu-cil-alasan"
                  maxLength={MAKS_ALASAN_BAYAR}
                  required={nilaiPotongan > 0}
                  disabled={nilaiPotongan === 0}
                  placeholder="Misalnya pelunasan dipercepat"
                  value={alasan}
                  onChange={(e) => setAlasan(e.target.value)}
                  className={INPUT}
                />
              </div>
            </>
          ) : (
            <div className="sm:col-span-2">
              <label htmlFor="keu-cil-keterangan" className={LABEL}>
                Keterangan denda
              </label>
              <input
                id="keu-cil-keterangan"
                required
                maxLength={MAKS_ALASAN_BAYAR}
                placeholder="Misalnya telat angsuran ke-4, 5 hari"
                value={keterangan}
                onChange={(e) => setKeterangan(e.target.value)}
                className={INPUT}
              />
            </div>
          )}
          <PilihAkunBayar
            id="keu-cil-akun"
            label="Dibayar dari"
            value={idAkunBayar}
            onChange={setIdAkunBayar}
          />
          <div>
            <label htmlFor="keu-cil-referensi" className={LABEL}>
              Nomor referensi (opsional)
            </label>
            <input
              id="keu-cil-referensi"
              maxLength={MAKS_REFERENSI}
              placeholder="Nomor transfer atau kuitansi"
              value={referensi}
              onChange={(e) => setReferensi(e.target.value)}
              className={INPUT}
            />
          </div>
        </div>
        {jenis === "Bayar" ? (
          <div className="flex flex-wrap gap-2">
            {berikut ? (
              <button
                type="button"
                onClick={() => setNominal(String(berikut.sisa))}
                className={TOMBOL_KEDUA}
              >
                Isi angsuran berikutnya
              </button>
            ) : null}
            <button
              type="button"
              onClick={() =>
                setNominal(String(Math.max(sisa - nilaiPotongan, 0)))
              }
              className={TOMBOL_KEDUA}
            >
              Isi pelunasan
            </button>
          </div>
        ) : null}
        {jenis === "Bayar" && nilai + nilaiPotongan > 0 ? (
          <dl className="grid gap-1 rounded-lg border border-slate-800 bg-slate-950/40 p-3 sm:grid-cols-2">
            <div className="flex justify-between gap-3">
              <dt className="text-slate-400">Mengurangi utang</dt>
              <dd>
                <Rp nilai={pokok} />
              </dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-slate-400">Beban bunga</dt>
              <dd>
                <Rp nilai={Math.max(bunga - nilaiPotongan, 0)} />
              </dd>
            </div>
            {nilaiPotongan > bunga ? (
              <div className="flex justify-between gap-3">
                <dt className="text-slate-400">Pendapatan lain-lain</dt>
                <dd>
                  <Rp nilai={nilaiPotongan - bunga} />
                </dd>
              </div>
            ) : null}
          </dl>
        ) : null}
        {galat ? (
          <p role="alert" className="text-rose-300">
            {galat}
          </p>
        ) : null}
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" onClick={onClose} className={TOMBOL_KEDUA}>
            Kembali
          </button>
          <button type="submit" disabled={menyimpan} className={TOMBOL_UTAMA}>
            {menyimpan ? "Menyimpan..." : "Simpan"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function KartuKontrak({
  kontrak: k,
  akun,
  bolehKelola,
  bolehBatal,
  milikSendiri,
  galat,
  onAksi,
  onAccUlang,
  onClose,
}: {
  kontrak: KontrakCicilan;
  akun: AkunItem[];
  bolehKelola: boolean;
  bolehBatal: boolean;
  milikSendiri: boolean;
  galat: string | null;
  onAksi: (aksi: Aksi) => void;
  onAccUlang: () => void;
  onClose: () => void;
}) {
  const namaAkun = (id: string) => {
    const a = akun.find((x) => x.id_akun === id);
    return a ? `${a.kode} ${a.nama}` : id;
  };
  const aktif = k.status === "Berjalan" || k.status === "Menunggak";
  const bayarTerakhir = [...k.bayar]
    .reverse()
    .find((y) => y.jenis === "Bayar" && y.batal === null)?.id_bayar;

  return (
    <Modal
      isOpen={true}
      onClose={onClose}
      title={`Kontrak ${k.kreditur}`}
      titleId="keu-cil-kartu-judul"
      maxWidth="max-w-3xl"
    >
      <div className="space-y-4 text-sm">
        <div className="space-y-1">
          <p className="text-slate-300 wrap-break-word">
            {k.barang} · {k.nomor_pengajuan}
            {k.nomor_kontrak ? ` · kontrak ${k.nomor_kontrak}` : ""}
          </p>
          <p className={WARNA_STATUS[k.status]}>
            {k.status}
            {k.status === "Ditutup" && k.alasan_tutup
              ? `: ${k.alasan_tutup} (${k.ditutup_oleh ?? ""})`
              : ""}
          </p>
        </div>
        <dl className="grid gap-x-4 gap-y-1 sm:grid-cols-2">
          {(
            [
              ["Harga tunai", k.harga_tunai],
              ["Total bayar", k.total_bayar],
              ["Bunga", k.bunga],
              ["Sudah tertutup", k.tertutup],
              ["Sisa pokok", k.sisa_pokok],
              ["Sisa bunga", k.sisa_bunga],
              ["Denda dibayar", k.total_denda],
            ] as const
          ).map(([label, nilai]) => (
            <div key={label} className="flex justify-between gap-3">
              <dt className="text-slate-400">{label}</dt>
              <dd className="text-slate-100">
                <Rp nilai={nilai} />
              </dd>
            </div>
          ))}
        </dl>
        {k.lebih_bayar > 0 ? (
          <p className="text-amber-300">
            Lebih bayar <Rp nilai={k.lebih_bayar} />. Kemungkinan pembayaran
            tercatat dua kali dari dua perangkat; batalkan yang kembar.
          </p>
        ) : null}
        {!k.penerimaan_dijurnal && aktif ? (
          <p className="text-amber-300">
            Jurnal penerimaan barangnya belum dicatat. Catat dulu di tab Dari
            Inventaris sebelum mencatat pembayaran.
          </p>
        ) : null}
        <p className="text-xs text-slate-400">
          Utang: {namaAkun(k.id_akun_utang)} · Bunga:{" "}
          {namaAkun(k.id_akun_bunga)} · Denda: {namaAkun(k.id_akun_denda)}
        </p>

        <div className="flex flex-wrap gap-2">
          {bolehKelola && aktif ? (
            <button
              type="button"
              onClick={() => onAksi({ jenis: "Bayar", kontrak: k })}
              className={TOMBOL_UTAMA}
            >
              Catat pembayaran
            </button>
          ) : null}
          {bolehKelola && (aktif || k.status === "Lunas") ? (
            <button
              type="button"
              onClick={() => onAksi({ jenis: "Denda", kontrak: k })}
              className={TOMBOL_KEDUA}
            >
              Catat denda
            </button>
          ) : null}
          {bolehKelola && k.status === "Menunggu ACC ulang" && !milikSendiri ? (
            <button type="button" onClick={onAccUlang} className={TOMBOL_UTAMA}>
              ACC ulang syarat final
            </button>
          ) : null}
          {bolehBatal && STATUS_AKTIF.includes(k.status) ? (
            <button
              type="button"
              onClick={() => onAksi({ jenis: "tutup", kontrak: k })}
              className={TOMBOL_BAHAYA}
            >
              Tutup kontrak
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => void eksporKartu(k)}
            className={TOMBOL_KEDUA}
          >
            Ekspor Excel
          </button>
        </div>
        {galat ? (
          <p role="alert" className="text-rose-300">
            {galat}
          </p>
        ) : null}
        {k.status === "Menunggu ACC ulang" && milikSendiri ? (
          <p className="text-xs text-slate-400">
            Kamu yang mengajukan. Pemegang Keuangan lain yang meng-ACC ulang.
          </p>
        ) : null}

        <section aria-labelledby="keu-cil-jadwal" className="space-y-2">
          <h3
            id="keu-cil-jadwal"
            className="text-sm font-semibold text-slate-100"
          >
            Jadwal
          </h3>
          <ul className="divide-y divide-slate-800 rounded-lg border border-slate-800 bg-slate-950/40">
            {k.jadwal.map((b) => (
              <li
                key={b.ke}
                className="flex flex-col gap-1 px-3 py-2 sm:flex-row sm:justify-between"
              >
                <span className="text-slate-200">
                  {b.ke === 0 ? "Uang muka" : `Angsuran ${b.ke}`} ·{" "}
                  {tanggalTampil(b.jatuh_tempo)}
                </span>
                <span className="text-slate-400">
                  <Rp nilai={b.nominal} /> ·{" "}
                  <span
                    className={
                      b.status === "Terlambat"
                        ? "text-rose-300"
                        : b.status === "Lunas"
                          ? "text-emerald-300"
                          : "text-slate-300"
                    }
                  >
                    {b.status}
                  </span>
                  {b.status === "Sebagian" || b.status === "Terlambat"
                    ? ` (terbayar ${formatRupiah(b.terbayar)})`
                    : ""}
                </span>
              </li>
            ))}
          </ul>
        </section>

        <section aria-labelledby="keu-cil-riwayat" className="space-y-2">
          <h3
            id="keu-cil-riwayat"
            className="text-sm font-semibold text-slate-100"
          >
            Pembayaran dan denda
          </h3>
          {k.bayar.length === 0 ? (
            <p className="text-slate-400">Belum ada pembayaran.</p>
          ) : (
            <ul className="divide-y divide-slate-800 rounded-lg border border-slate-800 bg-slate-950/40">
              {k.bayar.map((y) => {
                const bolehBatalIni =
                  bolehBatal &&
                  y.batal === null &&
                  (y.jenis === "Denda" || y.id_bayar === bayarTerakhir);
                return (
                  <li
                    key={y.id_bayar}
                    className="flex flex-col gap-2 px-3 py-2 sm:flex-row sm:items-start sm:justify-between"
                  >
                    <div className="min-w-0 space-y-0.5">
                      <p
                        className={
                          y.batal
                            ? "text-slate-500 line-through"
                            : "text-slate-200"
                        }
                      >
                        {y.jenis} {tanggalTampil(y.tanggal)} ·{" "}
                        <Rp nilai={y.nominal} />
                        {y.potongan > 0 ? (
                          <>
                            {" "}
                            + potongan <Rp nilai={y.potongan} />
                          </>
                        ) : null}
                      </p>
                      <p className="text-xs text-slate-400 wrap-break-word">
                        {[
                          y.keterangan,
                          y.alasan_potongan
                            ? `Potongan: ${y.alasan_potongan}`
                            : null,
                          y.referensi ? `Ref. ${y.referensi}` : null,
                          y.nomor_jurnal,
                          `oleh ${y.dicatat_oleh}`,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </p>
                      {y.batal ? (
                        <p className="text-xs text-rose-300 wrap-break-word">
                          Dibatalkan {y.batal.oleh}: {y.batal.alasan}
                        </p>
                      ) : null}
                    </div>
                    {bolehBatalIni ? (
                      <button
                        type="button"
                        onClick={() =>
                          onAksi({
                            jenis: "batal",
                            kontrak: k,
                            idBayar: y.id_bayar,
                          })
                        }
                        className={TOMBOL_KEDUA}
                      >
                        Batalkan
                      </button>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
          {bolehBatal ? (
            <p className="text-xs text-slate-400">
              Pembayaran hanya bisa dibatalkan dari yang terakhir, karena
              pemisahan pokok dan bunganya bergantung pada urutan.
            </p>
          ) : null}
        </section>
      </div>
    </Modal>
  );
}

export function CicilanWorkspace({
  akun,
  bolehKelola,
  bolehBatal,
  onInfo,
  onBerubah,
}: {
  akun: AkunItem[];
  bolehKelola: boolean;
  bolehBatal: boolean;
  onInfo: (message: string) => void;
  /** Dipanggil setelah perubahan supaya tanda angka tab ikut diperbarui. */
  onBerubah: () => void;
}) {
  const { user } = useAuth();
  const [daftar, setDaftar] = useState<DaftarCicilan | null>(null);
  const [galat, setGalat] = useState<string | null>(null);
  const [saringan, setSaringan] = useState<Saringan>("aktif");
  const [dibuka, setDibuka] = useState<string | null>(null);
  const [aksi, setAksi] = useState<Aksi | null>(null);
  const [galatKartu, setGalatKartu] = useState<string | null>(null);
  const isSubmittingRef = useRef(false);

  const muat = useCallback(async () => {
    setGalat(null);
    try {
      setDaftar(await getCicilan());
    } catch (error) {
      setDaftar(null);
      setGalat(pesanGalat(error, "Daftar kontrak cicilan tidak bisa dimuat."));
    }
  }, []);
  useEffect(() => {
    void muat();
  }, [muat]);
  useEffect(() => subscribeSyncCompleted(() => void muat()), [muat]);

  const semua = daftar?.kontrak ?? [];
  const tampil = semua.filter((k) =>
    saringan === "semua"
      ? true
      : saringan === "aktif"
        ? STATUS_AKTIF.includes(k.status) || k.status === "Draf"
        : k.status === saringan,
  );
  const ditinjau = semua.filter(
    (k) =>
      k.lebih_bayar > 0 ||
      k.status === "Menunggak" ||
      k.status === "Menunggu ACC ulang",
  );
  const proyeksi = useMemo(() => (daftar ? proyeksiKas(daftar) : []), [daftar]);
  const kontrakDibuka = dibuka
    ? (semua.find((k) => k.id_cicilan === dibuka) ?? null)
    : null;
  const milikSendiri = (k: KontrakCicilan) =>
    !validatePemutus(
      k.diajukan_oleh,
      user?.username ?? "",
      user?.isSuperadmin ?? false,
    ).ok;

  const selesai = async (message: string) => {
    setAksi(null);
    onInfo(message);
    await muat();
    onBerubah();
  };

  const accUlang = async (k: KontrakCicilan) => {
    if (isSubmittingRef.current) return;
    isSubmittingRef.current = true;
    try {
      await accUlangCicilan(k.id_cicilan, k.sidik_syarat);
      await selesai(
        "Syarat final di-ACC ulang. Pembayaran sudah bisa dicatat.",
      );
    } catch (error) {
      setGalatKartu(pesanGalat(error, "ACC ulang tidak bisa disimpan."));
    } finally {
      isSubmittingRef.current = false;
    }
  };

  const baris = (k: KontrakCicilan) => {
    const berikut = angsuranBerikutnya(k);
    return (
      <li
        key={k.id_cicilan}
        className="flex flex-col gap-2 px-4 py-3 text-sm sm:flex-row sm:items-start sm:justify-between"
      >
        <div className="min-w-0 space-y-1">
          <p className="font-medium text-slate-100 wrap-break-word">
            {k.kreditur} · {k.barang}
          </p>
          <p className="text-slate-400">
            {k.nomor_pengajuan} · sisa pokok <Rp nilai={k.sisa_pokok} /> · sisa
            bunga <Rp nilai={k.sisa_bunga} />
            {berikut && STATUS_AKTIF.includes(k.status)
              ? ` · berikutnya ${tanggalTampil(berikut.jatuh_tempo)} ${formatRupiah(berikut.sisa)}`
              : ""}
          </p>
          <p className={WARNA_STATUS[k.status]}>
            {k.status}
            {k.lebih_bayar > 0
              ? ` · lebih bayar ${formatRupiah(k.lebih_bayar)}`
              : ""}
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            setGalatKartu(null);
            setDibuka(k.id_cicilan);
          }}
          className={TOMBOL_KEDUA}
        >
          Kartu kontrak
        </button>
      </li>
    );
  };

  if (galat) {
    return (
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
    );
  }
  if (!daftar) {
    return <p className="p-10 text-center text-sm text-slate-400">Memuat...</p>;
  }

  return (
    <div className="space-y-4">
      {ditinjau.length > 0 ? (
        <section
          aria-labelledby="keu-cil-tinjau"
          className="p-4 rounded-xl border border-amber-500/30 bg-slate-900/60 space-y-3"
        >
          <h2
            id="keu-cil-tinjau"
            className="text-base font-semibold text-slate-100"
          >
            Perlu ditinjau ({ditinjau.length})
          </h2>
          <ul className="divide-y divide-slate-800 rounded-lg border border-slate-800 bg-slate-950/40">
            {ditinjau.map(baris)}
          </ul>
        </section>
      ) : null}

      <section
        aria-labelledby="keu-cil-proyeksi"
        className="p-4 rounded-xl border border-slate-800 bg-slate-900/60 space-y-2"
      >
        <h2
          id="keu-cil-proyeksi"
          className="text-base font-semibold text-slate-100"
        >
          Proyeksi kas keluar
        </h2>
        <dl className="grid gap-2 sm:grid-cols-3">
          {proyeksi.map((p) => (
            <div
              key={p.bulan}
              className="rounded-lg border border-slate-800 bg-slate-950/40 p-3"
            >
              <dt className="text-xs text-slate-400">{namaBulan(p.bulan)}</dt>
              <dd className="text-lg font-semibold text-slate-100">
                <Rp nilai={p.jumlah} />
              </dd>
            </div>
          ))}
        </dl>
        <p className="text-xs text-slate-400">
          Dari sisa jadwal kontrak Berjalan dan Menunggak. Tunggakan masuk bulan
          ini.
        </p>
      </section>

      <section
        aria-labelledby="keu-cil-daftar"
        className="p-4 rounded-xl border border-slate-800 bg-slate-900/60 space-y-3"
      >
        <div className="flex flex-wrap items-end justify-between gap-3">
          <h2
            id="keu-cil-daftar"
            className="text-base font-semibold text-slate-100"
          >
            Kontrak cicilan
          </h2>
          <div className="flex flex-wrap items-end gap-2">
            <div>
              <label htmlFor="keu-cil-saring" className={LABEL}>
                Tampilkan
              </label>
              <select
                id="keu-cil-saring"
                value={saringan}
                onChange={(e) => setSaringan(e.target.value as Saringan)}
                className={INPUT}
              >
                <option value="aktif">Belum selesai</option>
                <option value="semua">Semua</option>
                {STATUS_CICILAN.map((status) => (
                  <option key={status} value={status}>
                    {status}
                  </option>
                ))}
              </select>
            </div>
            <button
              type="button"
              disabled={tampil.length === 0}
              onClick={() => void eksporDaftar(daftar, tampil)}
              className={TOMBOL_KEDUA}
            >
              Ekspor Excel
            </button>
          </div>
        </div>
        {daftar.terpotong ? (
          <p className="text-xs text-amber-300">
            Hanya {semua.length} kontrak terbaru yang tampil.
          </p>
        ) : null}
        {tampil.length === 0 ? (
          <p className="text-sm text-slate-400">
            Belum ada kontrak untuk pilihan ini. Kontrak lahir dari pengajuan
            pembelian bercara bayar Cicilan di halaman Inventaris.
          </p>
        ) : (
          <ul className="divide-y divide-slate-800 rounded-lg border border-slate-800 bg-slate-950/40">
            {tampil.map(baris)}
          </ul>
        )}
      </section>

      {kontrakDibuka && !aksi ? (
        <KartuKontrak
          kontrak={kontrakDibuka}
          akun={akun}
          bolehKelola={bolehKelola}
          bolehBatal={bolehBatal}
          milikSendiri={milikSendiri(kontrakDibuka)}
          galat={galatKartu}
          onAksi={setAksi}
          onAccUlang={() => void accUlang(kontrakDibuka)}
          onClose={() => setDibuka(null)}
        />
      ) : null}
      {aksi?.jenis === "Bayar" || aksi?.jenis === "Denda" ? (
        <DialogBayar
          kontrak={aksi.kontrak}
          jenis={aksi.jenis}
          hariIni={daftar.hari_ini}
          isSubmittingRef={isSubmittingRef}
          onClose={() => setAksi(null)}
          onSelesai={selesai}
        />
      ) : aksi?.jenis === "tutup" ? (
        <DialogAlasan
          judul={`Tutup kontrak ${aksi.kontrak.kreditur}`}
          label="Alasan penutupan (barang ditarik, retur, putus kontrak)"
          tombol="Tutup kontrak"
          isSubmittingRef={isSubmittingRef}
          onClose={() => setAksi(null)}
          onKirim={async (alasan) => {
            await tutupCicilan(aksi.kontrak.id_cicilan, alasan);
            await selesai(
              "Kontrak ditutup. Bereskan sisa utangnya dengan jurnal manual.",
            );
          }}
        />
      ) : aksi?.jenis === "batal" ? (
        <DialogAlasan
          judul="Batalkan pembayaran"
          label="Alasan pembatalan"
          tombol="Batalkan pembayaran"
          isSubmittingRef={isSubmittingRef}
          onClose={() => setAksi(null)}
          onKirim={async (alasan) => {
            await batalBayarCicilan(aksi.idBayar, alasan);
            await selesai("Pembayaran dibatalkan dan jurnalnya dibalik.");
          }}
        />
      ) : null}
    </div>
  );
}
