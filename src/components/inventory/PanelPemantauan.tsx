"use client";

import {
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Modal } from "@/components/ui/Modal";
import {
  type BarangInventaris,
  catatMutasiInventaris,
  catatOpnameInventaris,
  type DaftarInventaris,
  type DaftarPinjaman,
  getDokumenInventaris,
  getRekapPengadaan,
  getRiwayatOpname,
  type PinjamanAktif,
  type PosisiStok,
  type RekapPengadaan,
  type RiwayatOpname,
} from "@/lib/gateways/inventory";
import { isMobileRuntime } from "@/lib/runtime/app-runtime";
import {
  aksiPindaiOpname,
  asciiLower,
  bacaLabelInventaris,
  KONDISI_BARANG,
} from "@/lib/validations/inventory";
import { cetakBeritaAcara } from "./beritaAcara";
import { eksporPengadaan } from "./ekspor";
import {
  hariIniWib,
  INPUT,
  LABEL,
  pesanGalat,
  TOMBOL_BAHAYA,
  TOMBOL_KEDUA,
  TOMBOL_UTAMA,
} from "./gaya";
import { PemindaiLabel } from "./LabelQr";

/**
 * Tab Fase 2: Ringkasan, Kedaluwarsa, Dipinjam, dan Opname. Dipakai apa
 * adanya oleh Web/Desktop dan Mobile (`filesToCopy`). Semua angka di sini
 * diturunkan dari data backend (status kedaluwarsa, stok menipis, sisa
 * pinjaman), tidak dihitung ulang dengan jam perangkat.
 */

export type FilterBarang = "semua" | "menipis" | "minus";
export type FilterKedaluwarsa = "perhatian" | "kedaluwarsa" | "semua";
export type TujuanRingkasan =
  | { tab: "barang"; filter: FilterBarang }
  | { tab: "kedaluwarsa"; filter: FilterKedaluwarsa }
  | { tab: "dipinjam" };

type SubmitRef = { current: boolean };

/**
 * WebView Android tidak punya dialog cetak, jadi tombol cetak berita acara
 * hanya muncul di Web dan Desktop (keputusan User).
 */
export function bisaCetakBeritaAcara(): boolean {
  return !isMobileRuntime();
}

export async function cetakBeritaAcaraMutasi(
  idMutasi: string,
  onGalat: (message: string) => void,
): Promise<void> {
  try {
    cetakBeritaAcara(await getDokumenInventaris(idMutasi));
  } catch (error) {
    onGalat(pesanGalat(error, "Berita acara tidak bisa disiapkan."));
  }
}

function rupiah(nilai: number): string {
  return new Intl.NumberFormat("id-ID", {
    style: "currency",
    currency: "IDR",
    maximumFractionDigits: 0,
  }).format(nilai);
}

interface BatchBersaldo {
  barang: BarangInventaris;
  posisi: PosisiStok;
}

function batchBersaldo(data: DaftarInventaris): BatchBersaldo[] {
  return data.barang
    .flatMap((barang) =>
      barang.posisi
        .filter((posisi) => posisi.tanggal_expired && posisi.saldo > 0)
        .map((posisi) => ({ barang, posisi })),
    )
    .sort((a, b) => (a.posisi.sisa_hari ?? 0) - (b.posisi.sisa_hari ?? 0));
}

function keteranganSisa(sisaHari: number | null): string {
  if (sisaHari === null) return "";
  if (sisaHari < 0) return `kedaluwarsa ${-sisaHari} hari lalu`;
  if (sisaHari === 0) return "hari terakhir boleh dipakai";
  return `sisa ${sisaHari} hari`;
}

// ── Ringkasan ───────────────────────────────────────────────────────────────

export function PanelRingkasan({
  data,
  pinjaman,
  pinjamanGalat,
  onBuka,
  onInfo,
  onGalat,
}: {
  data: DaftarInventaris;
  pinjaman: DaftarPinjaman | null;
  pinjamanGalat: string | null;
  onBuka: (tujuan: TujuanRingkasan) => void;
  onInfo: (message: string) => void;
  onGalat: (message: string) => void;
}) {
  const batch = batchBersaldo(data);
  const kartu: {
    label: string;
    nilai: string;
    keterangan: string;
    gawat: boolean;
    tujuan: TujuanRingkasan;
  }[] = [
    {
      label: "Batch kedaluwarsa",
      nilai: String(
        batch.filter((b) => b.posisi.status_kedaluwarsa === "Kedaluwarsa")
          .length,
      ),
      keterangan: "Masih punya stok. Catat pemusnahannya.",
      gawat: batch.some((b) => b.posisi.status_kedaluwarsa === "Kedaluwarsa"),
      tujuan: { tab: "kedaluwarsa", filter: "kedaluwarsa" },
    },
    {
      label: "Batch waspada",
      nilai: String(
        batch.filter((b) => b.posisi.status_kedaluwarsa === "Waspada").length,
      ),
      keterangan: "Kedaluwarsa dalam 30 hari.",
      gawat: false,
      tujuan: { tab: "kedaluwarsa", filter: "perhatian" },
    },
    {
      label: "Stok menipis",
      nilai: String(
        data.barang.filter((b) => b.status_aktif && b.stok_menipis).length,
      ),
      keterangan: "Stok baik di bawah stok minimum.",
      gawat: false,
      tujuan: { tab: "barang", filter: "menipis" },
    },
    {
      label: "Stok minus",
      nilai: String(
        data.barang.filter((b) => b.posisi.some((p) => p.saldo < 0)).length,
      ),
      keterangan: "Catatan tidak cocok. Perlu opname.",
      gawat: data.barang.some((b) => b.posisi.some((p) => p.saldo < 0)),
      tujuan: { tab: "barang", filter: "minus" },
    },
    {
      label: "Belum kembali",
      nilai: pinjamanGalat
        ? "?"
        : pinjaman
          ? String(pinjaman.baris.length)
          : "...",
      keterangan: pinjamanGalat
        ? "Daftar peminjaman tidak bisa dimuat."
        : "Peminjaman yang belum kembali penuh.",
      gawat: false,
      tujuan: { tab: "dipinjam" },
    },
  ];

  if (data.barang.length === 0) {
    return (
      <p className="p-8 text-center text-sm text-slate-400 rounded-xl border border-dashed border-slate-800">
        Belum ada barang. Ringkasan muncul setelah barang pertama didaftarkan di
        bagian Barang.
      </p>
    );
  }

  return (
    <div className="space-y-6">
      <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
        {kartu.map((item) => (
          <li key={item.label}>
            <button
              type="button"
              onClick={() => onBuka(item.tujuan)}
              className={`w-full h-full min-h-11 p-4 rounded-xl border text-left transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 ${
                item.gawat && item.nilai !== "0"
                  ? "border-rose-500/30 bg-rose-500/20 hover:bg-rose-500/30"
                  : "border-slate-800 bg-slate-900/60 hover:bg-slate-800"
              }`}
            >
              <span
                className={`block text-3xl font-bold ${
                  item.gawat && item.nilai !== "0"
                    ? "text-rose-100"
                    : "text-slate-100"
                }`}
              >
                {item.nilai}
              </span>
              <span className="block mt-1 text-sm font-semibold text-slate-200">
                {item.label}
              </span>
              <span className="block mt-1 text-xs text-slate-400">
                {item.keterangan}
              </span>
            </button>
          </li>
        ))}
      </ul>
      <RekapPengadaanPanel
        hariIni={data.hari_ini}
        onInfo={onInfo}
        onGalat={onGalat}
      />
    </div>
  );
}

function RekapPengadaanPanel({
  hariIni,
  onInfo,
  onGalat,
}: {
  hariIni: string;
  onInfo: (message: string) => void;
  onGalat: (message: string) => void;
}) {
  const [dari, setDari] = useState(`${hariIni.slice(0, 8)}01`);
  const [sampai, setSampai] = useState(hariIni);
  const [rekap, setRekap] = useState<RekapPengadaan | null>(null);
  const [memuat, setMemuat] = useState(false);
  const [galat, setGalat] = useState<string | null>(null);

  const tampilkan = async (event: FormEvent) => {
    event.preventDefault();
    setMemuat(true);
    setGalat(null);
    try {
      setRekap(await getRekapPengadaan(dari, sampai));
    } catch (error) {
      setRekap(null);
      setGalat(pesanGalat(error, "Rekap pengadaan tidak bisa dimuat."));
    } finally {
      setMemuat(false);
    }
  };

  const ekspor = async () => {
    if (!rekap) return;
    try {
      const hasil = await eksporPengadaan(rekap, dari, sampai);
      if (hasil.sukses)
        onInfo("Rekap pengadaan tersimpan sebagai berkas Excel.");
    } catch (error) {
      onGalat(pesanGalat(error, "Berkas Excel tidak bisa disimpan."));
    }
  };

  return (
    <section
      aria-labelledby="inv-pengadaan-judul"
      className="p-4 rounded-xl border border-slate-800 bg-slate-900/60 space-y-3"
    >
      <h2
        id="inv-pengadaan-judul"
        className="text-base font-semibold text-slate-100"
      >
        Rekap pengadaan per sumber dana
      </h2>
      <form onSubmit={tampilkan} className="flex flex-wrap items-end gap-3">
        <div>
          <label htmlFor="inv-pengadaan-dari" className={LABEL}>
            Dari tanggal
          </label>
          <input
            id="inv-pengadaan-dari"
            type="date"
            required
            max={sampai}
            value={dari}
            onChange={(e) => setDari(e.target.value)}
            className={INPUT}
          />
        </div>
        <div>
          <label htmlFor="inv-pengadaan-sampai" className={LABEL}>
            Sampai tanggal
          </label>
          <input
            id="inv-pengadaan-sampai"
            type="date"
            required
            min={dari}
            value={sampai}
            onChange={(e) => setSampai(e.target.value)}
            className={INPUT}
          />
        </div>
        <button type="submit" disabled={memuat} className={TOMBOL_KEDUA}>
          {memuat ? "Memuat..." : "Tampilkan rekap"}
        </button>
        {rekap && rekap.baris.length > 0 ? (
          <button
            type="button"
            onClick={() => void ekspor()}
            className={TOMBOL_KEDUA}
          >
            Ekspor Excel
          </button>
        ) : null}
      </form>
      {galat ? (
        <p role="alert" className="text-sm text-rose-200">
          {galat}
        </p>
      ) : null}
      {rekap ? (
        rekap.baris.length === 0 ? (
          <p className="text-sm text-slate-400">
            Tidak ada barang masuk dari pengadaan, hibah, atau saldo awal pada
            rentang ini.
          </p>
        ) : (
          <div className="space-y-2">
            <ul className="divide-y divide-slate-800 rounded-lg border border-slate-800 bg-slate-950/40">
              {rekap.rekap.map((item) => (
                <li
                  key={item.sumber_dana}
                  className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm"
                >
                  <span className="text-slate-200">
                    {item.sumber_dana}
                    <span className="text-slate-400">
                      {" "}
                      · {item.baris} baris
                    </span>
                    {item.tanpa_harga > 0 ? (
                      <span className="text-amber-300">
                        {" "}
                        · {item.tanpa_harga} tanpa harga
                      </span>
                    ) : null}
                  </span>
                  <span className="font-semibold text-slate-100">
                    {rupiah(item.nilai)}
                  </span>
                </li>
              ))}
            </ul>
            <p className="text-right text-sm font-semibold text-slate-100">
              Total {rupiah(rekap.total_nilai)}
            </p>
            {rekap.terpotong ? (
              <p className="text-xs text-amber-300">
                Hanya 5.000 baris pertama yang dihitung. Persempit rentang
                tanggal.
              </p>
            ) : null}
          </div>
        )
      ) : null}
    </section>
  );
}

// ── Kedaluwarsa ─────────────────────────────────────────────────────────────

export function PanelKedaluwarsa({
  data,
  filterAwal,
  canAdjust,
  isSubmittingRef,
  onSelesai,
  onGalat,
}: {
  data: DaftarInventaris;
  filterAwal: FilterKedaluwarsa;
  canAdjust: boolean;
  isSubmittingRef: SubmitRef;
  onSelesai: (message: string) => Promise<void>;
  onGalat: (message: string) => void;
}) {
  const [filter, setFilter] = useState<FilterKedaluwarsa>(filterAwal);
  const [target, setTarget] = useState<BatchBersaldo | null>(null);
  const [jumlah, setJumlah] = useState("");
  const [catatan, setCatatan] = useState("");
  const [nomorBa, setNomorBa] = useState("");
  const [menyimpan, setMenyimpan] = useState(false);

  const semua = batchBersaldo(data);
  const daftar = semua.filter((b) =>
    filter === "semua"
      ? true
      : filter === "kedaluwarsa"
        ? b.posisi.status_kedaluwarsa === "Kedaluwarsa"
        : b.posisi.status_kedaluwarsa !== "Aman",
  );

  const buka = (batch: BatchBersaldo) => {
    setTarget(batch);
    setJumlah(String(batch.posisi.saldo));
    setCatatan("");
  };

  const musnahkan = async (event: FormEvent) => {
    event.preventDefault();
    if (isSubmittingRef.current || !target) return;
    isSubmittingRef.current = true;
    setMenyimpan(true);
    try {
      await catatMutasiInventaris({
        id_barang: target.barang.id_barang,
        jenis: "Keluar",
        alasan: "Kedaluwarsa",
        jumlah: Number(jumlah),
        tempat_asal: target.posisi.tempat,
        kondisi_asal: target.posisi.kondisi,
        id_batch: target.posisi.id_batch,
        nomor_dokumen: nomorBa,
        catatan,
      });
      setTarget(null);
      await onSelesai(
        `Pemusnahan ${jumlah} ${target.barang.satuan} ${target.barang.nama_barang} tercatat.`,
      );
    } catch (error) {
      onGalat(pesanGalat(error, "Pemusnahan tidak bisa dicatat."));
    } finally {
      isSubmittingRef.current = false;
      setMenyimpan(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="p-3 rounded-xl border border-slate-800 bg-slate-900/60 sm:max-w-sm">
        <label htmlFor="inv-filter-kedaluwarsa" className={LABEL}>
          Tampilkan
        </label>
        <select
          id="inv-filter-kedaluwarsa"
          value={filter}
          onChange={(e) => setFilter(e.target.value as FilterKedaluwarsa)}
          className={INPUT}
        >
          <option value="perhatian">Waspada dan kedaluwarsa</option>
          <option value="kedaluwarsa">Kedaluwarsa saja</option>
          <option value="semua">Semua batch</option>
        </select>
      </div>

      {semua.length === 0 ? (
        <p className="p-8 text-center text-sm text-slate-400 rounded-xl border border-dashed border-slate-800">
          Belum ada barang berkedaluwarsa yang punya stok. Tandai barang dengan
          "Punya tanggal kedaluwarsa" saat mendaftarkannya.
        </p>
      ) : daftar.length === 0 ? (
        <p className="p-8 text-center text-sm text-slate-400 rounded-xl border border-dashed border-slate-800">
          Tidak ada batch yang perlu diperhatikan dalam 30 hari ke depan.
        </p>
      ) : (
        <ul className="space-y-2">
          {daftar.map(({ barang, posisi }) => {
            const kedaluwarsa = posisi.status_kedaluwarsa === "Kedaluwarsa";
            const waspada = posisi.status_kedaluwarsa === "Waspada";
            return (
              <li
                key={`${barang.id_barang}|${posisi.tempat}|${posisi.kondisi}|${posisi.id_batch ?? ""}`}
                className="flex flex-col gap-3 p-4 rounded-xl border border-slate-800 bg-slate-900/60 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0">
                  <p className="font-semibold text-slate-100 wrap-break-word">
                    {barang.nama_barang}
                  </p>
                  <p className="text-xs text-slate-400">
                    {posisi.tempat} · kedaluwarsa {posisi.tanggal_expired} ·{" "}
                    {posisi.saldo} {barang.satuan}
                  </p>
                  <p
                    className={`mt-1 text-sm font-medium ${
                      kedaluwarsa
                        ? "text-rose-300"
                        : waspada
                          ? "text-amber-300"
                          : "text-emerald-300"
                    }`}
                  >
                    {posisi.status_kedaluwarsa},{" "}
                    {keteranganSisa(posisi.sisa_hari)}
                  </p>
                </div>
                {canAdjust ? (
                  <button
                    type="button"
                    onClick={() => buka({ barang, posisi })}
                    className={kedaluwarsa ? TOMBOL_BAHAYA : TOMBOL_KEDUA}
                  >
                    Catat pemusnahan
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      {target ? (
        <Modal
          isOpen={true}
          onClose={() => setTarget(null)}
          title="Catat pemusnahan"
          titleId="inv-musnah-judul"
        >
          <form onSubmit={musnahkan} className="space-y-4">
            <p className="text-sm text-slate-300">
              {target.barang.nama_barang} di {target.posisi.tempat}, kedaluwarsa{" "}
              {target.posisi.tanggal_expired}. Stok berkurang dan tercatat
              sebagai barang keluar beralasan Kedaluwarsa.
            </p>
            <div>
              <label htmlFor="inv-musnah-jumlah" className={LABEL}>
                Jumlah dimusnahkan ({target.barang.satuan})
              </label>
              <input
                id="inv-musnah-jumlah"
                type="number"
                required
                min={1}
                max={target.posisi.saldo}
                step={1}
                inputMode="numeric"
                value={jumlah}
                onChange={(e) => setJumlah(e.target.value)}
                className={INPUT}
              />
            </div>
            <div>
              <label htmlFor="inv-musnah-nomor" className={LABEL}>
                Nomor berita acara (opsional)
              </label>
              <input
                id="inv-musnah-nomor"
                maxLength={60}
                value={nomorBa}
                onChange={(e) => setNomorBa(e.target.value)}
                className={INPUT}
                aria-describedby="inv-musnah-nomor-bantuan"
              />
              <p
                id="inv-musnah-nomor-bantuan"
                className="mt-1 text-xs text-slate-400"
              >
                Batch yang dimusnahkan bersama dengan nomor yang sama masuk satu
                berita acara.
              </p>
            </div>
            <div>
              <label htmlFor="inv-musnah-catatan" className={LABEL}>
                Catatan (opsional)
              </label>
              <input
                id="inv-musnah-catatan"
                maxLength={500}
                value={catatan}
                onChange={(e) => setCatatan(e.target.value)}
                className={INPUT}
              />
            </div>
            <div className="flex flex-wrap justify-end gap-2">
              <button
                type="button"
                onClick={() => setTarget(null)}
                className={TOMBOL_KEDUA}
              >
                Batal
              </button>
              <button
                type="submit"
                disabled={menyimpan}
                className={TOMBOL_BAHAYA}
              >
                {menyimpan ? "Menyimpan..." : "Catat pemusnahan"}
              </button>
            </div>
          </form>
        </Modal>
      ) : null}
    </div>
  );
}

// ── Dipinjam ────────────────────────────────────────────────────────────────

export function PanelPinjaman({
  data,
  pinjaman,
  galat,
  canRecord,
  isSubmittingRef,
  onMuatUlang,
  onSelesai,
  onGalat,
}: {
  data: DaftarInventaris;
  pinjaman: DaftarPinjaman | null;
  galat: string | null;
  canRecord: boolean;
  isSubmittingRef: SubmitRef;
  onMuatUlang: () => void;
  onSelesai: (message: string) => Promise<void>;
  onGalat: (message: string) => void;
}) {
  const hariIni = hariIniWib();
  const [target, setTarget] = useState<PinjamanAktif | null>(null);
  const [jumlah, setJumlah] = useState("");
  const [tempat, setTempat] = useState("");
  const [kondisi, setKondisi] = useState("Baik");
  const [tanggal, setTanggal] = useState(hariIni);
  const [catatan, setCatatan] = useState("");
  const [menyimpan, setMenyimpan] = useState(false);

  const buka = (baris: PinjamanAktif) => {
    setTarget(baris);
    setJumlah(String(baris.sisa));
    setTempat(baris.tempat_asal ?? "");
    setKondisi(baris.kondisi_asal ?? "Baik");
    setTanggal(hariIni);
    setCatatan("");
  };

  const kembalikan = async (event: FormEvent) => {
    event.preventDefault();
    if (isSubmittingRef.current || !target) return;
    isSubmittingRef.current = true;
    setMenyimpan(true);
    try {
      await catatMutasiInventaris({
        id_barang: target.id_barang,
        jenis: "Masuk",
        alasan: "Pengembalian",
        id_ref: target.id_mutasi,
        jumlah: Number(jumlah),
        tanggal,
        tempat_tujuan: tempat,
        kondisi_tujuan: target.tipe === "Aset" ? kondisi : "Baik",
        catatan,
      });
      setTarget(null);
      await onSelesai(
        `Pengembalian ${jumlah} ${target.satuan} ${target.nama_barang} tercatat.`,
      );
    } catch (error) {
      onGalat(pesanGalat(error, "Pengembalian tidak bisa dicatat."));
    } finally {
      isSubmittingRef.current = false;
      setMenyimpan(false);
    }
  };

  if (galat) {
    return (
      <div className="p-4 rounded-xl border border-rose-500/30 bg-rose-500/20 text-sm text-rose-100 space-y-3">
        <p>{galat}</p>
        <button type="button" onClick={onMuatUlang} className={TOMBOL_KEDUA}>
          Coba muat lagi
        </button>
      </div>
    );
  }
  if (!pinjaman) {
    return (
      <p className="p-8 text-center text-sm text-slate-400">
        Memuat daftar peminjaman...
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {pinjaman.baris.length === 0 ? (
        <p className="p-8 text-center text-sm text-slate-400 rounded-xl border border-dashed border-slate-800">
          Tidak ada barang yang sedang dipinjam. Peminjaman dicatat dari bagian
          Catat Mutasi sebagai barang Keluar beralasan Peminjaman.
        </p>
      ) : (
        <ul className="space-y-2">
          {pinjaman.baris.map((baris) => (
            <li
              key={baris.id_mutasi}
              className="flex flex-col gap-3 p-4 rounded-xl border border-slate-800 bg-slate-900/60 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="min-w-0 space-y-1">
                <p className="font-semibold text-slate-100 wrap-break-word">
                  {baris.nama_barang}{" "}
                  <span className="text-xs font-normal text-slate-400">
                    {baris.kode_barang}
                  </span>
                </p>
                <p className="text-sm text-slate-200">
                  {baris.penerima_nama ?? "Tanpa nama"}: belum kembali{" "}
                  {baris.sisa} dari {baris.jumlah} {baris.satuan}
                </p>
                <p className="text-xs text-slate-400">
                  Dipinjam {baris.tanggal}, sudah {baris.lama_hari} hari
                  {baris.keperluan ? ` · ${baris.keperluan}` : ""}
                </p>
              </div>
              {canRecord ? (
                <button
                  type="button"
                  onClick={() => buka(baris)}
                  className={TOMBOL_KEDUA}
                >
                  Kembalikan
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {pinjaman.terpotong ? (
        <p className="text-xs text-amber-300">
          Hanya 500 peminjaman tertua yang ditampilkan.
        </p>
      ) : null}

      {target ? (
        <Modal
          isOpen={true}
          onClose={() => setTarget(null)}
          title="Catat pengembalian"
          titleId="inv-kembali-judul"
        >
          <form onSubmit={kembalikan} className="space-y-4">
            <p className="text-sm text-slate-300">
              {target.nama_barang} dipinjam{" "}
              {target.penerima_nama ?? "tanpa nama"} sejak {target.tanggal}.
              Belum kembali {target.sisa} {target.satuan}.
            </p>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <label htmlFor="inv-kembali-jumlah" className={LABEL}>
                  Jumlah kembali ({target.satuan})
                </label>
                <input
                  id="inv-kembali-jumlah"
                  type="number"
                  required
                  min={1}
                  max={target.sisa}
                  step={1}
                  inputMode="numeric"
                  value={jumlah}
                  onChange={(e) => setJumlah(e.target.value)}
                  className={INPUT}
                />
              </div>
              <div>
                <label htmlFor="inv-kembali-tanggal" className={LABEL}>
                  Tanggal kembali
                </label>
                <input
                  id="inv-kembali-tanggal"
                  type="date"
                  required
                  max={hariIni}
                  value={tanggal}
                  onChange={(e) => setTanggal(e.target.value)}
                  className={INPUT}
                />
              </div>
              <div>
                <label htmlFor="inv-kembali-tempat" className={LABEL}>
                  Disimpan di
                </label>
                <input
                  id="inv-kembali-tempat"
                  required
                  list="inv-kembali-tempat-saran"
                  value={tempat}
                  onChange={(e) => setTempat(e.target.value)}
                  className={INPUT}
                />
                <datalist id="inv-kembali-tempat-saran">
                  {data.tempat.map((nilai) => (
                    <option key={nilai} value={nilai} />
                  ))}
                </datalist>
              </div>
              {target.tipe === "Aset" ? (
                <div>
                  <label htmlFor="inv-kembali-kondisi" className={LABEL}>
                    Kondisi saat kembali
                  </label>
                  <select
                    id="inv-kembali-kondisi"
                    value={kondisi}
                    onChange={(e) => setKondisi(e.target.value)}
                    className={INPUT}
                  >
                    {KONDISI_BARANG.map((nilai) => (
                      <option key={nilai} value={nilai}>
                        {nilai}
                      </option>
                    ))}
                  </select>
                </div>
              ) : null}
            </div>
            <div>
              <label htmlFor="inv-kembali-catatan" className={LABEL}>
                Catatan (opsional)
              </label>
              <input
                id="inv-kembali-catatan"
                maxLength={500}
                value={catatan}
                onChange={(e) => setCatatan(e.target.value)}
                className={INPUT}
              />
            </div>
            <div className="flex flex-wrap justify-end gap-2">
              <button
                type="button"
                onClick={() => setTarget(null)}
                className={TOMBOL_KEDUA}
              >
                Batal
              </button>
              <button
                type="submit"
                disabled={menyimpan}
                className={TOMBOL_UTAMA}
              >
                {menyimpan ? "Menyimpan..." : "Simpan pengembalian"}
              </button>
            </div>
          </form>
        </Modal>
      ) : null}
    </div>
  );
}

// ── Opname ──────────────────────────────────────────────────────────────────

interface BarisHitung {
  kunci: string;
  barang: BarangInventaris;
  kondisi: string;
  id_batch: string | null;
  tanggal_expired: string | null;
  sistem: number;
  fisik: string;
  /** Sudah dihitung dengan memindai label; pindaian berikutnya menambah 1. */
  dipindai: boolean;
  /** Terisi bila baris ini satu unit aset. */
  kode_unit: string | null;
}

function kunciHitung(
  idBarang: string,
  kondisi: string,
  idBatch: string | null,
) {
  return `${idBarang}|${kondisi}|${idBatch ?? ""}`;
}

function barisDariTempat(
  data: DaftarInventaris,
  tempat: string,
): BarisHitung[] {
  const kunciTempat = asciiLower(tempat);
  return data.barang.flatMap((barang) =>
    barang.posisi
      .filter((posisi) => asciiLower(posisi.tempat) === kunciTempat)
      .map((posisi) => ({
        kunci: kunciHitung(barang.id_barang, posisi.kondisi, posisi.id_batch),
        barang,
        kondisi: posisi.kondisi,
        id_batch: posisi.id_batch,
        tanggal_expired: posisi.tanggal_expired,
        sistem: posisi.saldo,
        fisik: String(Math.max(posisi.saldo, 0)),
        dipindai: false,
        kode_unit: posisi.kode_unit,
      })),
  );
}

/** Batch yang pernah tercatat untuk sebuah barang, di tempat mana pun. */
function batchBarang(barang: BarangInventaris) {
  const terlihat = new Map<string, string | null>();
  for (const posisi of barang.posisi) {
    if (posisi.id_batch) terlihat.set(posisi.id_batch, posisi.tanggal_expired);
  }
  return [...terlihat.entries()].map(([id, tanggal]) => ({ id, tanggal }));
}

export function PanelOpname({
  data,
  isSubmittingRef,
  onSelesai,
  onGalat,
}: {
  data: DaftarInventaris;
  isSubmittingRef: SubmitRef;
  onSelesai: (message: string) => Promise<void>;
  onGalat: (message: string) => void;
}) {
  const [tempat, setTempat] = useState("");
  const [baris, setBaris] = useState<BarisHitung[]>([]);
  const [catatan, setCatatan] = useState("");
  const [menyimpan, setMenyimpan] = useState(false);
  const [tambahBarang, setTambahBarang] = useState("");
  const [tambahKondisi, setTambahKondisi] = useState("Baik");
  const [tambahBatch, setTambahBatch] = useState("");
  const [tambahFisik, setTambahFisik] = useState("");
  const [tambahGalat, setTambahGalat] = useState<string | null>(null);
  const [riwayat, setRiwayat] = useState<RiwayatOpname[] | null>(null);
  const [riwayatGalat, setRiwayatGalat] = useState<string | null>(null);
  const bisaCetak = bisaCetakBeritaAcara();
  const [bukaPindai, setBukaPindai] = useState(false);
  const [pesanPindai, setPesanPindai] = useState<{
    teks: string;
    galat: boolean;
  } | null>(null);
  // Barang yang ditawarkan ke "Tambah barang yang ditemukan" dari pindaian.
  const [tawaranPindai, setTawaranPindai] = useState<string | null>(null);
  const [fokusKunci, setFokusKunci] = useState<string | null>(null);
  // Pindaian bisa datang lebih cepat dari render ulang, jadi daftar terbaru
  // dan riwayat batal dibaca dari ref, bukan dari closure.
  const barisRef = useRef(baris);
  barisRef.current = baris;
  const riwayatPindaiRef = useRef<
    { kunci: string; fisik: string; dipindai: boolean }[]
  >([]);
  const [jumlahPindai, setJumlahPindai] = useState(0);

  const muatRiwayat = useCallback(async () => {
    try {
      setRiwayat((await getRiwayatOpname()).riwayat);
      setRiwayatGalat(null);
    } catch (error) {
      setRiwayatGalat(pesanGalat(error, "Riwayat opname tidak bisa dimuat."));
    }
  }, []);

  useEffect(() => {
    void muatRiwayat();
  }, [muatRiwayat]);

  const pilihTempat = (nilai: string) => {
    setTempat(nilai);
    setBaris(nilai ? barisDariTempat(data, nilai) : []);
    setTambahGalat(null);
    setPesanPindai(null);
    setTawaranPindai(null);
    riwayatPindaiRef.current = [];
    setJumlahPindai(0);
  };

  const gantiBaris = (berikut: BarisHitung[]) => {
    barisRef.current = berikut;
    setBaris(berikut);
  };

  useEffect(() => {
    if (!fokusKunci) return;
    const id =
      fokusKunci === "tambah"
        ? "inv-tambah-barang"
        : `inv-fisik-${baris.findIndex((b) => b.kunci === fokusKunci)}`;
    const elemen = document.getElementById(id);
    elemen?.scrollIntoView({ block: "center" });
    elemen?.focus();
    setFokusKunci(null);
  }, [fokusKunci, baris]);

  const pindai = (teks: string) => {
    const hasil = bacaLabelInventaris(teks, data.barang);
    if (!hasil.ok) {
      setPesanPindai({ teks: hasil.error, galat: true });
      return;
    }
    const { barang, id_unit } = hasil.value;
    const sekarang = barisRef.current;
    const aksi = aksiPindaiOpname(sekarang, barang, id_unit);
    if (aksi.jenis === "pakai-label-unit") {
      setPesanPindai({
        teks: `${barang.nama_barang} dicatat per unit. Pindai label unitnya.`,
        galat: true,
      });
      return;
    }
    if (aksi.jenis === "unit-lain") {
      const di = barang.posisi.find((p) => p.id_batch === id_unit);
      setPesanPindai({
        teks: `Unit ${di?.kode_unit ?? ""} tercatat di ${di?.tempat ?? "tempat lain"}. Bila unitnya memang ada di sini, catat Pindah lebih dulu.`,
        galat: true,
      });
      return;
    }
    if (aksi.jenis === "unit") {
      const lama = sekarang.find((b) => b.kunci === aksi.kunci);
      if (aksi.sudah || !lama) {
        setPesanPindai({
          teks: `Unit ${lama?.kode_unit ?? ""} sudah terhitung.`,
          galat: false,
        });
        return;
      }
      riwayatPindaiRef.current.push({
        kunci: lama.kunci,
        fisik: lama.fisik,
        dipindai: lama.dipindai,
      });
      setJumlahPindai(riwayatPindaiRef.current.length);
      gantiBaris(
        sekarang.map((b) =>
          b.kunci === aksi.kunci ? { ...b, fisik: "1", dipindai: true } : b,
        ),
      );
      navigator.vibrate?.(40);
      setPesanPindai({
        teks: `Unit ${lama.kode_unit} ditemukan.`,
        galat: false,
      });
      return;
    }
    if (aksi.jenis === "hitung") {
      const lama = sekarang.find((b) => b.kunci === aksi.kunci);
      if (lama) {
        riwayatPindaiRef.current.push({
          kunci: lama.kunci,
          fisik: lama.fisik,
          dipindai: lama.dipindai,
        });
        setJumlahPindai(riwayatPindaiRef.current.length);
      }
      gantiBaris(
        sekarang.map((b) =>
          b.kunci === aksi.kunci
            ? { ...b, fisik: String(aksi.fisik), dipindai: true }
            : b,
        ),
      );
      navigator.vibrate?.(40);
      setPesanPindai({
        teks: `${barang.nama_barang}: ${aksi.fisik} ${barang.satuan} terhitung.`,
        galat: false,
      });
      return;
    }
    setBukaPindai(false);
    if (aksi.jenis === "fokus") {
      setPesanPindai({
        teks: `Isi jumlah fisik ${barang.nama_barang}.`,
        galat: false,
      });
      setFokusKunci(aksi.kunci);
      return;
    }
    setTambahBarang(barang.id_barang);
    setTambahKondisi("Baik");
    setTambahBatch("");
    setTambahFisik(barang.tipe === "Aset" && !barang.bisa_expired ? "1" : "");
    setTambahGalat(null);
    setTawaranPindai(barang.id_barang);
    setPesanPindai({
      teks: `${barang.nama_barang} tidak tercatat di ${tempat}. Periksa isiannya, lalu tekan "Tambahkan ke daftar hitung".`,
      galat: false,
    });
    setFokusKunci("tambah");
  };

  const batalPindai = () => {
    const terakhir = riwayatPindaiRef.current.pop();
    setJumlahPindai(riwayatPindaiRef.current.length);
    if (!terakhir) return;
    gantiBaris(
      barisRef.current.map((b) =>
        b.kunci === terakhir.kunci
          ? { ...b, fisik: terakhir.fisik, dipindai: terakhir.dipindai }
          : b,
      ),
    );
    setPesanPindai({ teks: "Pindaian terakhir dibatalkan.", galat: false });
  };

  const adaPindaian = baris.some((b) => b.dipindai);
  const tidakDisentuh = (b: BarisHitung) =>
    !b.dipindai && b.fisik === String(Math.max(b.sistem, 0));
  const belumDipindai = adaPindaian
    ? baris.filter(
        (b) =>
          b.barang.tipe === "Aset" && b.kode_unit === null && tidakDisentuh(b),
      ).length
    : 0;
  // Unit yang belum dipindai tetap dianggap ada sampai petugas memutuskan
  // sendiri bahwa unit itu tidak ditemukan.
  const unitBelumDipindai = adaPindaian
    ? baris.filter((b) => b.kode_unit !== null && tidakDisentuh(b))
    : [];
  const catatTidakDitemukan = () => {
    const kunci = new Set(unitBelumDipindai.map((b) => b.kunci));
    gantiBaris(
      barisRef.current.map((b) =>
        kunci.has(b.kunci) ? { ...b, fisik: "0" } : b,
      ),
    );
    setPesanPindai({
      teks: `${kunci.size} unit dicatat tidak ditemukan. Periksa daftar sebelum menyimpan.`,
      galat: false,
    });
  };

  const barangTambah =
    data.barang.find((b) => b.id_barang === tambahBarang) ?? null;
  const pilihanBatch = useMemo(
    () => (barangTambah ? batchBarang(barangTambah) : []),
    [barangTambah],
  );
  const jumlahSelisih = baris.filter(
    (b) => Number(b.fisik) !== b.sistem,
  ).length;

  const tambah = () => {
    if (!barangTambah) {
      setTambahGalat("Pilih barang yang ditemukan.");
      return;
    }
    const kondisi = barangTambah.tipe === "Aset" ? tambahKondisi : "Baik";
    const idBatch = barangTambah.bisa_expired ? tambahBatch || null : null;
    if (barangTambah.bisa_expired && !idBatch) {
      setTambahGalat("Pilih batch barang ini.");
      return;
    }
    const kunci = kunciHitung(barangTambah.id_barang, kondisi, idBatch);
    if (baris.some((b) => b.kunci === kunci)) {
      setTambahGalat("Barang ini sudah ada di daftar hitung.");
      return;
    }
    setBaris([
      ...baris,
      {
        kunci,
        barang: barangTambah,
        kondisi,
        id_batch: idBatch,
        tanggal_expired:
          pilihanBatch.find((batch) => batch.id === idBatch)?.tanggal ?? null,
        sistem: 0,
        fisik: tambahFisik || "0",
        // Ditemukan lewat pindaian: pindaian berikutnya langsung menambah.
        dipindai:
          tawaranPindai === barangTambah.id_barang &&
          barangTambah.tipe === "Aset" &&
          kondisi === "Baik",
        kode_unit: null,
      },
    ]);
    setTawaranPindai(null);
    setTambahBarang("");
    setTambahBatch("");
    setTambahFisik("");
    setTambahGalat(null);
  };

  const simpan = async (event: FormEvent) => {
    event.preventDefault();
    if (isSubmittingRef.current || baris.length === 0) return;
    isSubmittingRef.current = true;
    setMenyimpan(true);
    try {
      const hasil = await catatOpnameInventaris({
        tempat,
        baris: baris.map((b) => ({
          id_barang: b.barang.id_barang,
          kondisi: b.kondisi,
          id_batch: b.id_batch,
          fisik: Number(b.fisik),
        })),
        catatan,
      });
      setTempat("");
      setBaris([]);
      setCatatan("");
      void muatRiwayat();
      await onSelesai(
        hasil.jumlah_selisih === 0
          ? `Opname ${hasil.nomor_dokumen} tersimpan. Tidak ada selisih.`
          : `Opname ${hasil.nomor_dokumen} tersimpan dengan ${hasil.jumlah_selisih} selisih.`,
      );
    } catch (error) {
      onGalat(pesanGalat(error, "Opname tidak bisa disimpan."));
    } finally {
      isSubmittingRef.current = false;
      setMenyimpan(false);
    }
  };

  if (data.tempat.length === 0) {
    return (
      <p className="p-8 text-center text-sm text-slate-400 rounded-xl border border-dashed border-slate-800">
        Belum ada tempat penyimpanan. Opname bisa dilakukan setelah ada barang
        yang dicatat masuk.
      </p>
    );
  }

  return (
    <>
      <form onSubmit={simpan} className="space-y-3">
        <div className="p-3 rounded-xl border border-slate-800 bg-slate-900/60 space-y-2 sm:max-w-md">
          <label htmlFor="inv-opname-tempat" className={LABEL}>
            Tempat yang dihitung
          </label>
          <select
            id="inv-opname-tempat"
            value={tempat}
            onChange={(e) => pilihTempat(e.target.value)}
            className={INPUT}
          >
            <option value="">Pilih tempat</option>
            {data.tempat.map((nilai) => (
              <option key={nilai} value={nilai}>
                {nilai}
              </option>
            ))}
          </select>
          <p className="text-xs text-slate-400">
            Satu tempat sebaiknya dihitung satu orang. Saldo sistem dihitung
            ulang saat disimpan, jadi mutasi yang terjadi sementara tetap
            terhitung.
          </p>
          {tempat ? (
            <button
              type="button"
              onClick={() => {
                setPesanPindai(null);
                setBukaPindai(true);
              }}
              className={TOMBOL_KEDUA}
            >
              Pindai label
            </button>
          ) : null}
        </div>

        <p
          aria-live="polite"
          className={`text-sm ${pesanPindai?.galat ? "text-rose-200" : "text-slate-300"}`}
        >
          {bukaPindai ? "" : (pesanPindai?.teks ?? "")}
        </p>

        {tempat ? (
          <>
            {baris.length === 0 ? (
              <p className="p-6 text-center text-sm text-slate-400 rounded-xl border border-dashed border-slate-800">
                Tidak ada stok tercatat di {tempat}. Tambahkan barang yang
                ditemukan di bawah.
              </p>
            ) : (
              <ul className="divide-y divide-slate-800 rounded-xl border border-slate-800 bg-slate-900/60">
                {baris.map((item, index) => {
                  const beda = Number(item.fisik) !== item.sistem;
                  return (
                    <li
                      key={item.kunci}
                      className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
                    >
                      <div className="min-w-0">
                        <p className="font-medium text-slate-100 wrap-break-word">
                          {item.barang.nama_barang}
                        </p>
                        <p className="text-xs text-slate-400">
                          {item.kondisi}
                          {item.tanggal_expired
                            ? ` · kedaluwarsa ${item.tanggal_expired}`
                            : ""}{" "}
                          · sistem {item.sistem} {item.barang.satuan}
                          {item.kode_unit ? ` · unit ${item.kode_unit}` : ""}
                          {item.dipindai ? " · dihitung dengan pindai" : ""}
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        <label
                          htmlFor={`inv-fisik-${index}`}
                          className="text-xs text-slate-300"
                        >
                          Fisik
                        </label>
                        <input
                          id={`inv-fisik-${index}`}
                          type="number"
                          required
                          min={0}
                          step={1}
                          inputMode="numeric"
                          value={item.fisik}
                          onChange={(e) =>
                            setBaris(
                              baris.map((b) =>
                                b.kunci === item.kunci
                                  ? { ...b, fisik: e.target.value }
                                  : b,
                              ),
                            )
                          }
                          className={`${INPUT} w-28`}
                        />
                        {beda ? (
                          <span className="w-16 text-sm font-semibold text-amber-300">
                            {Number(item.fisik) - item.sistem > 0 ? "+" : ""}
                            {Number(item.fisik) - item.sistem}
                          </span>
                        ) : (
                          <span className="w-16 text-sm text-slate-500">
                            cocok
                          </span>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}

            <fieldset className="p-3 rounded-xl border border-slate-800 bg-slate-900/60 space-y-3">
              <legend className="px-1 text-sm font-semibold text-slate-200">
                Tambah barang yang ditemukan
              </legend>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <div>
                  <label htmlFor="inv-tambah-barang" className={LABEL}>
                    Barang
                  </label>
                  <select
                    id="inv-tambah-barang"
                    value={tambahBarang}
                    onChange={(e) => {
                      setTambahBarang(e.target.value);
                      setTambahBatch("");
                    }}
                    className={INPUT}
                  >
                    <option value="">Pilih barang</option>
                    {data.barang
                      .filter((b) => b.status_aktif)
                      .map((b) => (
                        <option key={b.id_barang} value={b.id_barang}>
                          {b.nama_barang} ({b.kode_barang})
                        </option>
                      ))}
                  </select>
                </div>
                {barangTambah?.tipe === "Aset" ? (
                  <div>
                    <label htmlFor="inv-tambah-kondisi" className={LABEL}>
                      Kondisi
                    </label>
                    <select
                      id="inv-tambah-kondisi"
                      value={tambahKondisi}
                      onChange={(e) => setTambahKondisi(e.target.value)}
                      className={INPUT}
                    >
                      {KONDISI_BARANG.map((nilai) => (
                        <option key={nilai} value={nilai}>
                          {nilai}
                        </option>
                      ))}
                    </select>
                  </div>
                ) : null}
                {barangTambah?.bisa_expired ? (
                  <div>
                    <label htmlFor="inv-tambah-batch" className={LABEL}>
                      Batch
                    </label>
                    {pilihanBatch.length === 0 ? (
                      <p className="text-xs text-amber-300">
                        Barang ini belum punya batch. Catat sebagai barang Masuk
                        dengan tanggal kedaluwarsanya.
                      </p>
                    ) : (
                      <select
                        id="inv-tambah-batch"
                        value={tambahBatch}
                        onChange={(e) => setTambahBatch(e.target.value)}
                        className={INPUT}
                      >
                        <option value="">Pilih batch</option>
                        {pilihanBatch.map((batch) => (
                          <option key={batch.id} value={batch.id}>
                            Kedaluwarsa {batch.tanggal ?? "tanpa tanggal"}
                          </option>
                        ))}
                      </select>
                    )}
                  </div>
                ) : null}
                <div>
                  <label htmlFor="inv-tambah-fisik" className={LABEL}>
                    Jumlah fisik
                  </label>
                  <input
                    id="inv-tambah-fisik"
                    type="number"
                    min={0}
                    step={1}
                    inputMode="numeric"
                    value={tambahFisik}
                    onChange={(e) => setTambahFisik(e.target.value)}
                    className={INPUT}
                  />
                </div>
              </div>
              {tambahGalat ? (
                <p role="alert" className="text-sm text-rose-200">
                  {tambahGalat}
                </p>
              ) : null}
              <button type="button" onClick={tambah} className={TOMBOL_KEDUA}>
                Tambahkan ke daftar hitung
              </button>
            </fieldset>

            <div>
              <label htmlFor="inv-opname-catatan" className={LABEL}>
                Catatan (opsional)
              </label>
              <input
                id="inv-opname-catatan"
                maxLength={500}
                value={catatan}
                onChange={(e) => setCatatan(e.target.value)}
                className={INPUT}
              />
            </div>
            <div className="flex flex-wrap items-center justify-end gap-3">
              {unitBelumDipindai.length > 0 ? (
                <div className="w-full rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-100 space-y-2">
                  <p>
                    {unitBelumDipindai.length} unit belum dipindai dan masih
                    dianggap ada:{" "}
                    {unitBelumDipindai
                      .slice(0, 20)
                      .map((b) => b.kode_unit)
                      .join(", ")}
                    {unitBelumDipindai.length > 20
                      ? `, dan ${unitBelumDipindai.length - 20} lainnya`
                      : ""}
                    .
                  </p>
                  <button
                    type="button"
                    onClick={catatTidakDitemukan}
                    className={TOMBOL_KEDUA}
                  >
                    Catat yang belum dipindai sebagai tidak ditemukan
                  </button>
                </div>
              ) : null}
              {belumDipindai > 0 ? (
                <span className="text-sm text-amber-300">
                  {belumDipindai} baris aset belum dipindai dan dianggap sesuai
                  sistem.
                </span>
              ) : null}
              <span className="text-sm text-slate-300">
                {jumlahSelisih === 0
                  ? "Semua cocok"
                  : `${jumlahSelisih} selisih`}
              </span>
              <button
                type="submit"
                disabled={menyimpan || baris.length === 0}
                className={TOMBOL_UTAMA}
              >
                {menyimpan ? "Menyimpan..." : "Simpan hasil opname"}
              </button>
            </div>
          </>
        ) : null}

        <section
          aria-labelledby="inv-riwayat-opname-judul"
          className="p-4 rounded-xl border border-slate-800 bg-slate-900/60 space-y-2"
        >
          <h2
            id="inv-riwayat-opname-judul"
            className="text-base font-semibold text-slate-100"
          >
            Riwayat opname
          </h2>
          {!bisaCetak ? (
            <p className="text-xs text-slate-400">
              Berita acara dicetak dari laptop atau browser.
            </p>
          ) : null}
          {riwayatGalat ? (
            <p role="alert" className="text-sm text-rose-200">
              {riwayatGalat}
            </p>
          ) : riwayat === null ? (
            <p className="text-sm text-slate-400">Memuat riwayat opname...</p>
          ) : riwayat.length === 0 ? (
            <p className="text-sm text-slate-400">
              Belum ada opname yang menghasilkan selisih.
            </p>
          ) : (
            <ul className="divide-y divide-slate-800">
              {riwayat.map((item) => (
                <li
                  key={item.nomor_dokumen}
                  className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm"
                >
                  <span className="text-slate-200">
                    {item.nomor_dokumen}
                    <span className="text-slate-400">
                      {" "}
                      · {item.tanggal} · {item.tempat ?? "-"} ·{" "}
                      {item.jumlah_selisih} selisih
                    </span>
                  </span>
                  {bisaCetak ? (
                    <button
                      type="button"
                      onClick={() =>
                        void cetakBeritaAcaraMutasi(item.id_mutasi, onGalat)
                      }
                      className={TOMBOL_KEDUA}
                    >
                      Cetak berita acara
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </section>
      </form>
      {bukaPindai ? (
        <Modal
          isOpen={true}
          onClose={() => setBukaPindai(false)}
          title={`Pindai label di ${tempat}`}
          titleId="inv-pindai-judul"
        >
          <div className="space-y-3">
            <p className="text-sm text-slate-400">
              Aset dihitung satu per pindaian. Arahkan kamera ke label
              berikutnya setelah yang sebelumnya lepas dari bingkai. Barang
              habis pakai membuka isian jumlahnya untuk diketik.
            </p>
            <PemindaiLabel onPindai={pindai} />
            <p
              aria-live="polite"
              className={`min-h-5 text-sm ${pesanPindai?.galat ? "text-rose-200" : "text-emerald-200"}`}
            >
              {pesanPindai?.teks ?? ""}
            </p>
            <div className="flex flex-wrap justify-end gap-2">
              <button
                type="button"
                onClick={batalPindai}
                disabled={jumlahPindai === 0}
                className={TOMBOL_KEDUA}
              >
                Batalkan pindaian terakhir
              </button>
              <button
                type="button"
                onClick={() => setBukaPindai(false)}
                className={TOMBOL_UTAMA}
              >
                Selesai memindai
              </button>
            </div>
          </div>
        </Modal>
      ) : null}
    </>
  );
}
