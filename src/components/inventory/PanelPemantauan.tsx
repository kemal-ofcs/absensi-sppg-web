"use client";

import {
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { konfirmasiData } from "@/components/ui/KonfirmasiData";
import { Modal } from "@/components/ui/Modal";
import { PilihCari } from "@/components/ui/PilihCari";
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
import { audioSynth } from "@/lib/utils/audio";
import {
  aksiPindaiOpname,
  asciiLower,
  bacaDrafOpname,
  bacaLabelInventaris,
  type DrafOpname,
  gabungDrafOpname,
  HARI_SERVIS_LAMA,
  jumlahDariKetikan,
  KONDISI_BARANG,
  kunciBarisOpname,
  perluDijurnal,
  type ServisInventaris,
} from "@/lib/validations/inventory";
import { tanggalTampil } from "@/lib/validations/tutup-buku";
import { cetakBeritaAcara } from "./beritaAcara";
import { eksporPengadaan } from "./ekspor";
import {
  angka,
  bacaJumlah,
  hariIniWib,
  INPUT,
  isianJumlah,
  LABEL,
  pesanGalat,
  TOMBOL_BAHAYA,
  TOMBOL_KEDUA,
  TOMBOL_UTAMA,
} from "./gaya";
import { fokusKolomPindai, PemindaiLabel } from "./LabelQr";
import { keteranganServis, servisPerUnit } from "./Servis";

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
  | { tab: "dipinjam" }
  | { tab: "servis" };

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
    {
      label: "Sedang diservis",
      nilai: String(data.servis.length),
      keterangan: (() => {
        const lama = data.servis.filter(
          (s) => s.lama_hari >= HARI_SERVIS_LAMA,
        ).length;
        return lama > 0
          ? `${lama} sudah ${HARI_SERVIS_LAMA} hari atau lebih.`
          : "Barang yang dibawa ke tukang servis.";
      })(),
      gawat: data.servis.some((s) => s.lama_hari >= HARI_SERVIS_LAMA),
      tujuan: { tab: "servis" },
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
      <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
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
            <BelumDijurnal rekap={rekap} />
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

/** Ringkasan kolom "Jurnal" di Excel; penjurnalannya di Keuangan, tab Dari Inventaris. */
function BelumDijurnal({ rekap }: { rekap: RekapPengadaan }) {
  const belum = rekap.baris.filter(perluDijurnal);
  if (belum.length === 0) return null;
  const nilai = belum.reduce((sum, baris) => sum + baris.nilai, 0);
  return (
    <p className="text-sm text-amber-300">
      {belum.length} baris ({rupiah(nilai)}) belum dicatat di pembukuan.
      Bendahara mencatatnya dari halaman Keuangan, tab Dari Inventaris.
    </p>
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
    setJumlah(angka(batch.posisi.saldo, batch.barang.desimal));
    setCatatan("");
  };

  const musnahkan = async (event: FormEvent) => {
    event.preventDefault();
    if (isSubmittingRef.current || !target) return;
    const lanjut = await konfirmasiData([
      { label: "Barang", nilai: target.barang.nama_barang },
      { label: "Tempat", nilai: target.posisi.tempat },
      { label: "Dimusnahkan", nilai: `${jumlah} ${target.barang.satuan}` },
      { label: "Nomor berita acara", nilai: nomorBa },
      { label: "Catatan", nilai: catatan },
    ]);
    if (!lanjut) return;
    isSubmittingRef.current = true;
    setMenyimpan(true);
    try {
      const nilai = bacaJumlah(jumlah, target.barang.desimal);
      await catatMutasiInventaris({
        id_barang: target.barang.id_barang,
        jenis: "Keluar",
        alasan: "Kedaluwarsa",
        jumlah: nilai,
        tempat_asal: target.posisi.tempat,
        kondisi_asal: target.posisi.kondisi,
        id_batch: target.posisi.id_batch,
        nomor_dokumen: nomorBa,
        catatan,
      });
      setTarget(null);
      await onSelesai(
        `Pemusnahan ${angka(nilai, target.barang.desimal)} ${target.barang.satuan} ${target.barang.nama_barang} tercatat.`,
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
                    {angka(posisi.saldo, barang.desimal)} {barang.satuan}
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
                {...isianJumlah(target.barang.desimal)}
                required
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
    setJumlah(angka(baris.sisa, baris.desimal));
    setTempat(baris.tempat_asal ?? "");
    setKondisi(baris.kondisi_asal ?? "Baik");
    setTanggal(hariIni);
    setCatatan("");
  };

  const kembalikan = async (event: FormEvent) => {
    event.preventDefault();
    if (isSubmittingRef.current || !target) return;
    const lanjut = await konfirmasiData([
      { label: "Barang", nilai: target.nama_barang },
      { label: "Dikembalikan", nilai: `${jumlah} ${target.satuan}` },
      { label: "Tanggal", nilai: tanggalTampil(tanggal) },
      { label: "Disimpan di", nilai: tempat },
      { label: "Kondisi", nilai: target.tipe === "Aset" ? kondisi : null },
      { label: "Catatan", nilai: catatan },
    ]);
    if (!lanjut) return;
    isSubmittingRef.current = true;
    setMenyimpan(true);
    try {
      const nilai = bacaJumlah(jumlah, target.desimal);
      await catatMutasiInventaris({
        id_barang: target.id_barang,
        jenis: "Masuk",
        alasan: "Pengembalian",
        id_ref: target.id_mutasi,
        jumlah: nilai,
        tanggal,
        tempat_tujuan: tempat,
        kondisi_tujuan: target.tipe === "Aset" ? kondisi : "Baik",
        catatan,
      });
      setTarget(null);
      await onSelesai(
        `Pengembalian ${angka(nilai, target.desimal)} ${target.satuan} ${target.nama_barang} tercatat.`,
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
                  {angka(baris.sisa, baris.desimal)} dari{" "}
                  {angka(baris.jumlah, baris.desimal)} {baris.satuan}
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
              Belum kembali {angka(target.sisa, target.desimal)} {target.satuan}
              .
            </p>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <label htmlFor="inv-kembali-jumlah" className={LABEL}>
                  Jumlah kembali ({target.satuan})
                </label>
                <input
                  id="inv-kembali-jumlah"
                  {...isianJumlah(target.desimal)}
                  required
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
  /** Isi awal `fisik`. Kosong = baris ini tidak tercatat di tempat tersebut. */
  fisik_awal: string;
  /** Sudah dihitung lewat pindaian; pindaian berikutnya menambah, bukan mulai lagi. */
  dipindai: boolean;
  /** Terisi bila baris ini satu unit aset. */
  kode_unit: string | null;
}

function barisDisentuh(b: BarisHitung): boolean {
  return b.dipindai || b.fisik !== b.fisik_awal;
}

function diLuarCatatan(b: BarisHitung): boolean {
  return b.fisik_awal === "";
}

/** Jumlah fisik ketikan; kosong = 0, ketikan yang bukan angka = null (selisih). */
function fisikDari(b: BarisHitung): number | null {
  return b.fisik.trim() === ""
    ? 0
    : jumlahDariKetikan(b.fisik, b.barang.desimal);
}

const AWALAN_DRAF_OPNAME = "kos.inventaris.opname-draf:";

function kunciDrafOpname(idPengguna: number, tempat: string): string {
  return `${AWALAN_DRAF_OPNAME}${idPengguna}:${asciiLower(tempat)}`;
}

function bacaDrafTempat(idPengguna: number, tempat: string): DrafOpname | null {
  try {
    return bacaDrafOpname(
      localStorage.getItem(kunciDrafOpname(idPengguna, tempat)),
    );
  } catch {
    return null;
  }
}

function semuaDrafOpname(idPengguna: number): DrafOpname[] {
  const awalan = `${AWALAN_DRAF_OPNAME}${idPengguna}:`;
  const hasil: DrafOpname[] = [];
  try {
    for (let i = 0; i < localStorage.length; i += 1) {
      const kunci = localStorage.key(i);
      if (!kunci?.startsWith(awalan)) continue;
      const draf = bacaDrafOpname(localStorage.getItem(kunci));
      if (draf) hasil.push(draf);
    }
  } catch {
    return [];
  }
  return hasil;
}

/** `false` = penyimpanan perangkat penuh atau diblokir; petugas diberi tahu. */
function tulisDrafOpname(idPengguna: number, draf: DrafOpname): boolean {
  try {
    localStorage.setItem(
      kunciDrafOpname(idPengguna, draf.tempat),
      JSON.stringify(draf),
    );
    return true;
  } catch {
    return false;
  }
}

function hapusDrafOpname(idPengguna: number, tempat: string) {
  try {
    localStorage.removeItem(kunciDrafOpname(idPengguna, tempat));
  } catch {
    // Draf yang tertinggal tetap ditawarkan dan bisa dibuang petugas.
  }
}

let waktuBunyiPeringatan = 0;

function bunyiPindai(hasil: "ok" | "awas" | "galat") {
  if (hasil === "ok") {
    navigator.vibrate?.(40);
    audioSynth.playSuccessBeep();
    return;
  }
  // Dua label yang sudah terhitung di satu bingkai terbaca bergantian tanpa henti.
  const sekarang = Date.now();
  if (sekarang - waktuBunyiPeringatan < 1000) return;
  waktuBunyiPeringatan = sekarang;
  if (hasil === "awas") audioSynth.playWarningBeep();
  else audioSynth.playErrorBeep();
}

function barisDariTempat(
  data: DaftarInventaris,
  tempat: string,
): BarisHitung[] {
  const kunciTempat = asciiLower(tempat);
  return data.barang.flatMap((barang) =>
    barang.posisi
      .filter((posisi) => asciiLower(posisi.tempat) === kunciTempat)
      .map((posisi) => {
        const fisik = angka(Math.max(posisi.saldo, 0), barang.desimal);
        return {
          kunci: kunciBarisOpname(
            barang.id_barang,
            posisi.kondisi,
            posisi.id_batch,
          ),
          barang,
          kondisi: posisi.kondisi,
          id_batch: posisi.id_batch,
          tanggal_expired: posisi.tanggal_expired,
          sistem: posisi.saldo,
          fisik,
          fisik_awal: fisik,
          dipindai: false,
          kode_unit: posisi.kode_unit,
        };
      }),
  );
}

function barisDariDraf(data: DaftarInventaris, draf: DrafOpname) {
  return gabungDrafOpname(
    barisDariTempat(data, draf.tempat),
    draf.baris,
    (entri) => {
      const barang = data.barang.find((b) => b.id_barang === entri.id_barang);
      if (!barang || (barang.dilacak_unit && entri.id_batch !== null)) {
        return null;
      }
      return {
        kunci: kunciBarisOpname(entri.id_barang, entri.kondisi, entri.id_batch),
        barang,
        kondisi: entri.kondisi,
        id_batch: entri.id_batch,
        tanggal_expired:
          batchBarang(barang).find((batch) => batch.id === entri.id_batch)
            ?.tanggal ?? null,
        sistem: 0,
        fisik: entri.fisik,
        fisik_awal: "",
        dipindai: entri.dipindai,
        kode_unit: null,
      };
    },
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

/**
 * Isian jumlah di dalam dialog pindai, sehingga kamera tidak perlu ditutup.
 * Barang berkedaluwarsa menampilkan satu isian per batch. Pemindai USB bisa
 * mengetik ke kolom yang sedang fokus, jadi teks label tidak diterima sebagai
 * jumlah.
 */
function IsianPindai({
  baris,
  onTerapkan,
}: {
  baris: BarisHitung[];
  onTerapkan: (teks: Record<string, string>) => void;
}) {
  const [teks, setTeks] = useState<Record<string, string>>(() =>
    Object.fromEntries(baris.map((b) => [b.kunci, b.fisik])),
  );
  const [galat, setGalat] = useState<string | null>(null);
  const pertamaRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    pertamaRef.current?.focus();
    pertamaRef.current?.select();
  }, []);

  const terapkan = () => {
    for (const b of baris) {
      const nilai = (teks[b.kunci] ?? "").trim();
      if (!nilai || jumlahDariKetikan(nilai, b.barang.desimal) !== null) {
        continue;
      }
      if (asciiLower(nilai).startsWith("inv:")) {
        setTeks({ ...teks, [b.kunci]: b.fisik });
        setGalat("Itu isi label. Ketik jumlahnya dulu, lalu pindai lagi.");
      } else {
        setGalat(`Jumlah ${b.barang.nama_barang} tidak bisa dibaca.`);
      }
      return;
    }
    onTerapkan(teks);
  };

  return (
    <div className="space-y-2 rounded-lg border border-slate-700 p-3">
      <p className="text-sm font-semibold text-slate-100 wrap-break-word">
        Jumlah fisik {baris[0]?.barang.nama_barang}
      </p>
      {baris.map((b, index) => (
        <div key={b.kunci}>
          <label htmlFor={`inv-isian-pindai-${index}`} className={LABEL}>
            {b.kondisi}
            {b.tanggal_expired ? ` · kedaluwarsa ${b.tanggal_expired}` : ""} ·
            sistem {angka(b.sistem, b.barang.desimal)} {b.barang.satuan}
          </label>
          <input
            id={`inv-isian-pindai-${index}`}
            ref={index === 0 ? pertamaRef : undefined}
            {...isianJumlah(b.barang.desimal)}
            value={teks[b.kunci] ?? ""}
            onChange={(e) => setTeks({ ...teks, [b.kunci]: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                terapkan();
              }
            }}
            className={INPUT}
          />
        </div>
      ))}
      {galat ? (
        <p role="alert" className="text-sm text-rose-200">
          {galat}
        </p>
      ) : null}
      <button type="button" onClick={terapkan} className={TOMBOL_UTAMA}>
        Terapkan jumlah
      </button>
    </div>
  );
}

export function PanelOpname({
  data,
  idPengguna,
  isSubmittingRef,
  onSelesai,
  onGalat,
}: {
  data: DaftarInventaris;
  idPengguna: number;
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
  const [fokusTambah, setFokusTambah] = useState(false);
  // Barang yang isian jumlahnya sedang terbuka di dialog pindai.
  const [isianPindai, setIsianPindai] = useState<string | null>(null);
  const [cekUlang, setCekUlang] = useState(false);
  const [drafTersedia, setDrafTersedia] = useState<DrafOpname[]>([]);
  const [drafDilanjutkan, setDrafDilanjutkan] = useState<{
    tanggal: string;
    dibuang: number;
  } | null>(null);
  const [drafGagal, setDrafGagal] = useState(false);
  const [yakinBuang, setYakinBuang] = useState(false);
  // Pindaian bisa datang lebih cepat dari render ulang, jadi daftar terbaru
  // dan riwayat batal dibaca dari ref, bukan dari closure.
  const barisRef = useRef(baris);
  barisRef.current = baris;
  const riwayatPindaiRef = useRef<
    {
      kunci: string;
      fisik: string;
      dipindai: boolean;
      dus?: string;
      baru?: boolean;
    }[]
  >([]);
  const [jumlahPindai, setJumlahPindai] = useState(0);
  // Dus yang sudah terhitung di hitungan ini.
  const dusRef = useRef<Set<string>>(new Set());
  const [jumlahDus, setJumlahDus] = useState(0);
  const tanggalDrafRef = useRef<string | null>(null);

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

  const gantiBaris = (berikut: BarisHitung[]) => {
    barisRef.current = berikut;
    setBaris(berikut);
  };

  const siapkanHitungan = (nilai: string, draf: DrafOpname | null) => {
    const hasil = draf
      ? barisDariDraf(data, draf)
      : { baris: nilai ? barisDariTempat(data, nilai) : [], dibuang: 0 };
    setTempat(nilai);
    gantiBaris(hasil.baris);
    setCatatan(draf?.catatan ?? "");
    dusRef.current = new Set(draf?.dus);
    setJumlahDus(dusRef.current.size);
    tanggalDrafRef.current = draf?.tanggal ?? null;
    setDrafDilanjutkan(
      draf ? { tanggal: draf.tanggal, dibuang: hasil.dibuang } : null,
    );
    setYakinBuang(false);
    setIsianPindai(null);
    setCekUlang(false);
    setTambahGalat(null);
    setPesanPindai(null);
    setTawaranPindai(null);
    riwayatPindaiRef.current = [];
    setJumlahPindai(0);
  };

  const pilihTempat = (nilai: string) => {
    siapkanHitungan(nilai, nilai ? bacaDrafTempat(idPengguna, nilai) : null);
  };

  const buangDraf = () => {
    hapusDrafOpname(idPengguna, tempat);
    siapkanHitungan(tempat, null);
  };

  // Hitungan hidup di state layar, yang lenyap saat pindah tab atau aplikasi
  // ditutup. Draf tidak pernah menyentuh stok atau outbox.
  useEffect(() => {
    if (!tempat) {
      setDrafTersedia(semuaDrafOpname(idPengguna));
      return;
    }
    const disentuh = baris.filter(barisDisentuh);
    if (disentuh.length === 0 && jumlahDus === 0 && !catatan.trim()) {
      hapusDrafOpname(idPengguna, tempat);
      tanggalDrafRef.current = null;
      setDrafGagal(false);
      return;
    }
    tanggalDrafRef.current ??= hariIniWib();
    setDrafGagal(
      !tulisDrafOpname(idPengguna, {
        versi: 1,
        tempat,
        tanggal: tanggalDrafRef.current,
        catatan,
        dus: [...dusRef.current],
        baris: disentuh.map((b) => ({
          id_barang: b.barang.id_barang,
          kondisi: b.kondisi,
          id_batch: b.id_batch,
          fisik: b.fisik,
          dipindai: b.dipindai,
        })),
      }),
    );
  }, [baris, catatan, idPengguna, jumlahDus, tempat]);

  useEffect(() => {
    if (!fokusTambah) return;
    const elemen = document.getElementById("inv-tambah-barang");
    elemen?.scrollIntoView({ block: "center" });
    elemen?.focus();
    setFokusTambah(false);
  }, [fokusTambah]);

  const catatPindaiDus = (kunci: string) => {
    dusRef.current.add(kunci);
    setJumlahDus(dusRef.current.size);
  };

  const terapkanIsian = (teks: Record<string, string>) => {
    gantiBaris(
      barisRef.current.map((b) => {
        const nilai = teks[b.kunci];
        return nilai === undefined || nilai === b.fisik
          ? b
          : { ...b, fisik: nilai, dipindai: true };
      }),
    );
    setIsianPindai(null);
    setPesanPindai({ teks: "Jumlah diterapkan.", galat: false });
    bunyiPindai("ok");
    fokusKolomPindai();
  };

  const tutupPindai = () => {
    setIsianPindai(null);
    setBukaPindai(false);
  };

  const pindai = (teks: string) => {
    // Pindaian lain tidak boleh membuang jumlah yang sedang diketik.
    if (isianPindai) {
      setPesanPindai({
        teks: "Terapkan dulu jumlah yang sedang terbuka.",
        galat: true,
      });
      bunyiPindai("awas");
      return;
    }
    const hasil = bacaLabelInventaris(teks, data.barang);
    if (!hasil.ok) {
      setPesanPindai({ teks: hasil.error, galat: true });
      bunyiPindai("galat");
      return;
    }
    const { barang, id_unit, dus } = hasil.value;
    const sekarang = barisRef.current;
    // Jumlah yang sudah diketik (dus terbuka) ikut ditambah, tidak ditimpa.
    const aksi = aksiPindaiOpname(
      dus
        ? sekarang.map((b) => ({ ...b, dipindai: barisDisentuh(b) }))
        : sekarang,
      barang,
      id_unit,
      dus ?? null,
      dusRef.current,
    );
    if (aksi.jenis === "dus-ganda" && dus) {
      setPesanPindai({
        teks: `Box ${dus.nomor} (${dus.kode}) ${barang.nama_barang} sudah terhitung. Jumlahnya tidak berubah.`,
        galat: true,
      });
      bunyiPindai("awas");
      return;
    }
    if (aksi.jenis === "dus-baru" && dus) {
      const kunci = kunciBarisOpname(barang.id_barang, "Baik", null);
      riwayatPindaiRef.current.push({
        kunci,
        fisik: "",
        dipindai: false,
        dus: dus.kunci,
        baru: true,
      });
      setJumlahPindai(riwayatPindaiRef.current.length);
      catatPindaiDus(dus.kunci);
      gantiBaris([
        ...sekarang,
        {
          kunci,
          barang,
          kondisi: "Baik",
          id_batch: null,
          tanggal_expired: null,
          sistem: 0,
          fisik: angka(aksi.fisik, barang.desimal),
          fisik_awal: "",
          dipindai: true,
          kode_unit: null,
        },
      ]);
      setPesanPindai({
        teks: `${barang.nama_barang} tidak tercatat di ${tempat}. Box ini tetap dihitung dan ditandai di luar catatan.`,
        galat: true,
      });
      bunyiPindai("awas");
      return;
    }
    if (aksi.jenis === "pakai-label-unit") {
      bunyiPindai("galat");
      setPesanPindai({
        teks: `${barang.nama_barang} dicatat per unit. Pindai label unitnya.`,
        galat: true,
      });
      return;
    }
    if (aksi.jenis === "unit-lain") {
      const di = barang.posisi.find((p) => p.id_batch === id_unit);
      bunyiPindai("galat");
      setPesanPindai({
        teks: `Unit ${di?.kode_unit ?? ""} tercatat di ${di?.tempat ?? "tempat lain"}. Bila unitnya memang ada di sini, catat Pindah lebih dulu.`,
        galat: true,
      });
      return;
    }
    if (aksi.jenis === "unit") {
      const lama = sekarang.find((b) => b.kunci === aksi.kunci);
      if (aksi.sudah || !lama) {
        bunyiPindai("awas");
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
      bunyiPindai("ok");
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
          dus: dus?.kunci,
        });
        setJumlahPindai(riwayatPindaiRef.current.length);
      }
      if (dus) catatPindaiDus(dus.kunci);
      gantiBaris(
        sekarang.map((b) =>
          b.kunci === aksi.kunci
            ? {
                ...b,
                fisik: angka(aksi.fisik, barang.desimal),
                dipindai: true,
              }
            : b,
        ),
      );
      bunyiPindai("ok");
      const total = `${angka(aksi.fisik, barang.desimal)} ${barang.satuan}`;
      setPesanPindai({
        teks: dus
          ? `${barang.nama_barang}: box ${dus.nomor} (${dus.kode}) +${angka(dus.isi, barang.desimal)}, total ${total}.`
          : `${barang.nama_barang}: ${total} terhitung.`,
        galat: false,
      });
      return;
    }
    if (aksi.jenis === "fokus") {
      bunyiPindai("ok");
      setPesanPindai({
        teks: `Isi jumlah fisik ${barang.nama_barang}.`,
        galat: false,
      });
      setIsianPindai(barang.id_barang);
      return;
    }
    setBukaPindai(false);
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
    setFokusTambah(true);
  };

  const batalPindai = () => {
    const terakhir = riwayatPindaiRef.current.pop();
    setJumlahPindai(riwayatPindaiRef.current.length);
    if (!terakhir) return;
    if (terakhir.dus) {
      dusRef.current.delete(terakhir.dus);
      setJumlahDus(dusRef.current.size);
    }
    gantiBaris(
      terakhir.baru
        ? barisRef.current.filter((b) => b.kunci !== terakhir.kunci)
        : barisRef.current.map((b) =>
            b.kunci === terakhir.kunci
              ? { ...b, fisik: terakhir.fisik, dipindai: terakhir.dipindai }
              : b,
          ),
    );
    setPesanPindai({ teks: "Pindaian terakhir dibatalkan.", galat: false });
  };

  const adaPindaian = baris.some((b) => b.dipindai);
  const tidakDisentuh = (b: BarisHitung) =>
    !b.dipindai && fisikDari(b) === Math.max(b.sistem, 0);
  const belumDipindai = adaPindaian
    ? baris.filter(
        (b) =>
          b.barang.tipe === "Aset" && b.kode_unit === null && tidakDisentuh(b),
      ).length
    : 0;
  // Unit yang belum dipindai tetap dianggap ada sampai petugas memutuskan
  // sendiri bahwa unit itu tidak ditemukan. Unit yang sedang diservis tidak
  // pernah ikut: barangnya memang sedang di luar.
  const servisUnit = servisPerUnit(data);
  const unitBelumDipindai = adaPindaian
    ? baris.filter(
        (b) =>
          b.kode_unit !== null &&
          tidakDisentuh(b) &&
          !(b.id_batch !== null && servisUnit.has(b.id_batch)),
      )
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
  const barisSelisih = baris.filter((b) => fisikDari(b) !== b.sistem);
  const jumlahSelisih = barisSelisih.length;
  const ketikanSalah = baris.filter((b) => fisikDari(b) === null);
  const barisIsian = isianPindai
    ? baris.filter((b) => b.barang.id_barang === isianPindai)
    : [];
  const adaDraf =
    baris.some(barisDisentuh) || jumlahDus > 0 || catatan.trim() !== "";
  const drafDitawarkan = tempat
    ? []
    : drafTersedia.flatMap((draf) => {
        const ejaan = data.tempat.find(
          (nilai) => asciiLower(nilai) === asciiLower(draf.tempat),
        );
        return ejaan ? [{ ...draf, tempat: ejaan }] : [];
      });

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
    const kunci = kunciBarisOpname(barangTambah.id_barang, kondisi, idBatch);
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
        fisik_awal: "",
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

  const bukaCekUlang = (event: FormEvent) => {
    event.preventDefault();
    if (baris.length > 0) setCekUlang(true);
  };

  const simpan = async () => {
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
          fisik: bacaJumlah(
            b.fisik || "0",
            b.barang.desimal,
            `Jumlah fisik ${b.barang.nama_barang}`,
          ),
        })),
        catatan,
      });
      // Draf baru dibuang setelah tersimpan: gagal simpan tidak menghilangkan hitungan.
      hapusDrafOpname(idPengguna, tempat);
      siapkanHitungan("", null);
      void muatRiwayat();
      await onSelesai(
        hasil.jumlah_selisih === 0
          ? `Opname ${hasil.nomor_dokumen} tersimpan. Tidak ada selisih.`
          : `Opname ${hasil.nomor_dokumen} tersimpan dengan ${hasil.jumlah_selisih} selisih.`,
      );
    } catch (error) {
      setCekUlang(false);
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
      {/* Layar cek ulang menggantikan `konfirmasiData` untuk opname. */}
      <form onSubmit={bukaCekUlang} className="space-y-3">
        <div className="p-3 rounded-xl border border-slate-800 bg-slate-900/60 space-y-2 sm:max-w-md">
          <label htmlFor="inv-opname-tempat" className={LABEL}>
            Tempat yang dihitung
          </label>
          <PilihCari
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
          </PilihCari>
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

        {drafDitawarkan.length > 0 ? (
          <section
            aria-labelledby="inv-draf-opname-judul"
            className="p-3 rounded-xl border border-amber-500/30 bg-amber-500/10 space-y-2"
          >
            <h2
              id="inv-draf-opname-judul"
              className="text-sm font-semibold text-amber-100"
            >
              Draf opname yang belum disimpan
            </h2>
            <ul className="space-y-2">
              {drafDitawarkan.map((draf) => (
                <li
                  key={draf.tempat}
                  className="flex flex-wrap items-center justify-between gap-2 text-sm text-amber-100"
                >
                  <span className="min-w-0 wrap-break-word">
                    {draf.tempat} · {tanggalTampil(draf.tanggal)} ·{" "}
                    {draf.baris.length} baris dihitung
                  </span>
                  <button
                    type="button"
                    onClick={() => pilihTempat(draf.tempat)}
                    className={TOMBOL_KEDUA}
                  >
                    Lanjutkan
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {tempat &&
        drafDilanjutkan &&
        drafDilanjutkan.tanggal !== hariIniWib() ? (
          <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-100">
            Hitungan ini dari tanggal {tanggalTampil(drafDilanjutkan.tanggal)}.
            Cek lagi barang yang sudah keluar atau masuk sejak itu.
          </p>
        ) : null}
        {tempat && drafDilanjutkan && drafDilanjutkan.dibuang > 0 ? (
          <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-100">
            {drafDilanjutkan.dibuang} baris draf tidak dipakai karena barang
            atau unitnya sudah tidak ada.
          </p>
        ) : null}
        {drafGagal ? (
          <p role="alert" className="text-sm text-rose-200">
            Draf tidak bisa disimpan di perangkat ini. Hitungan akan hilang
            kalau halaman ditutup.
          </p>
        ) : null}
        {tempat && adaDraf && !drafGagal ? (
          <div className="flex flex-wrap items-center gap-2 text-sm text-slate-300">
            <span>
              Draf tersimpan di perangkat ini. Stok belum berubah sampai
              hasilnya disimpan.
            </span>
            {yakinBuang ? (
              <>
                <button
                  type="button"
                  onClick={buangDraf}
                  className={TOMBOL_BAHAYA}
                >
                  Ya, buang draf
                </button>
                <button
                  type="button"
                  onClick={() => setYakinBuang(false)}
                  className={TOMBOL_KEDUA}
                >
                  Batal
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={() => setYakinBuang(true)}
                className={TOMBOL_KEDUA}
              >
                Hitung dari awal
              </button>
            )}
          </div>
        ) : null}

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
                  const fisik = fisikDari(item);
                  const beda = fisik !== item.sistem;
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
                          · sistem {angka(item.sistem, item.barang.desimal)}{" "}
                          {item.barang.satuan}
                          {item.kode_unit ? ` · unit ${item.kode_unit}` : ""}
                          {item.dipindai ? " · dihitung dengan pindai" : ""}
                          {diLuarCatatan(item) ? " · di luar catatan" : ""}
                        </p>
                        {item.id_batch !== null &&
                        servisUnit.has(item.id_batch) ? (
                          <p className="text-xs text-amber-300">
                            {keteranganServis(
                              servisUnit.get(item.id_batch) as ServisInventaris,
                            )}
                            ; tidak ikut dicatat tidak ditemukan.
                          </p>
                        ) : null}
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
                          {...isianJumlah(item.barang.desimal)}
                          required
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
                            {fisik === null
                              ? "?"
                              : `${fisik > item.sistem ? "+" : ""}${angka(
                                  fisik - item.sistem,
                                  item.barang.desimal,
                                )}`}
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
                  <PilihCari
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
                  </PilihCari>
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
                      <PilihCari
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
                      </PilihCari>
                    )}
                  </div>
                ) : null}
                <div>
                  <label htmlFor="inv-tambah-fisik" className={LABEL}>
                    Jumlah fisik
                  </label>
                  <input
                    id="inv-tambah-fisik"
                    {...isianJumlah(barangTambah?.desimal ?? false)}
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
                Periksa hasil
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
          onClose={tutupPindai}
          title={`Pindai label di ${tempat}`}
          titleId="inv-pindai-judul"
        >
          <div className="space-y-3">
            <p className="text-sm text-slate-400">
              Label box langsung menambah sesuai isinya, dan box yang sama tidak
              terhitung dua kali. Aset dihitung satu per pindaian. Arahkan
              kamera ke label berikutnya setelah yang sebelumnya lepas dari
              bingkai. Label rak barang habis pakai membuka isian jumlahnya.
            </p>
            <PemindaiLabel onPindai={pindai} />
            {barisIsian.length > 0 ? (
              <IsianPindai
                key={isianPindai}
                baris={barisIsian}
                onTerapkan={terapkanIsian}
              />
            ) : null}
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
                onClick={tutupPindai}
                className={TOMBOL_UTAMA}
              >
                Selesai memindai
              </button>
            </div>
          </div>
        </Modal>
      ) : null}
      {cekUlang ? (
        <Modal
          isOpen={true}
          onClose={() => setCekUlang(false)}
          title={`Cek ulang opname ${tempat}`}
          titleId="inv-cek-ulang-judul"
        >
          <div className="space-y-3">
            <p className="text-sm text-slate-300">
              {baris.length} baris dihitung · {jumlahDus} box dipindai ·{" "}
              {jumlahSelisih === 0 ? "semua cocok" : `${jumlahSelisih} selisih`}
              . Stok baru berubah setelah hasil ini disimpan.
            </p>
            {barisSelisih.length > 0 ? (
              <ul className="max-h-[40vh] overflow-y-auto divide-y divide-slate-800 rounded-xl border border-slate-800">
                {barisSelisih.map((b) => {
                  const fisik = fisikDari(b);
                  return (
                    <li
                      key={b.kunci}
                      className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm"
                    >
                      <span className="min-w-0 wrap-break-word text-slate-200">
                        {b.barang.nama_barang}
                        <span className="block text-xs text-slate-400">
                          {b.kondisi}
                          {b.kode_unit ? ` · unit ${b.kode_unit}` : ""} · sistem{" "}
                          {angka(b.sistem, b.barang.desimal)} {b.barang.satuan}
                          {diLuarCatatan(b) ? " · di luar catatan" : ""}
                        </span>
                      </span>
                      <span className="font-semibold text-amber-300">
                        {fisik === null
                          ? "?"
                          : `${fisik > b.sistem ? "+" : ""}${angka(
                              fisik - b.sistem,
                              b.barang.desimal,
                            )}`}
                      </span>
                    </li>
                  );
                })}
              </ul>
            ) : null}
            {belumDipindai > 0 || unitBelumDipindai.length > 0 ? (
              <p className="text-sm text-amber-300">
                {belumDipindai + unitBelumDipindai.length} baris belum dipindai
                dan dianggap sesuai sistem.
              </p>
            ) : null}
            {ketikanSalah.length > 0 ? (
              <p role="alert" className="text-sm text-rose-200">
                Jumlah {ketikanSalah[0]?.barang.nama_barang} tidak bisa dibaca.
                Perbaiki dulu sebelum menyimpan.
              </p>
            ) : null}
            <div className="flex flex-wrap justify-end gap-2">
              <button
                type="button"
                onClick={() => setCekUlang(false)}
                className={TOMBOL_KEDUA}
              >
                Kembali
              </button>
              <button
                type="button"
                onClick={() => void simpan()}
                disabled={menyimpan || ketikanSalah.length > 0}
                className={TOMBOL_UTAMA}
              >
                {menyimpan ? "Menyimpan..." : "Simpan hasil opname"}
              </button>
            </div>
          </div>
        </Modal>
      ) : null}
    </>
  );
}
