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
import { hasPermission } from "@/lib/auth/access";
import { useAuth } from "@/lib/context/AuthContext";
import {
  type BarangInventaris,
  type BarisKartuStok,
  batalkanMutasiInventaris,
  catatMutasiInventaris,
  type DaftarInventaris,
  type DaftarPinjaman,
  getInventaris,
  getKartuStok,
  getPenerimaInventaris,
  getPinjamanInventaris,
  type KartuStok,
  type PenerimaInventaris,
  type PosisiStok,
  simpanAwalanKodeInventaris,
  simpanBarangInventaris,
} from "@/lib/gateways/inventory";
import { getPengajuan } from "@/lib/gateways/inventory-pengajuan";
import { subscribeSyncCompleted } from "@/lib/gateways/sync-status";
import {
  ALASAN_FORMULIR,
  alasanSahUntuk,
  angkaDariKetikan,
  formatAngka,
  izinUntukAlasan,
  JENIS_MUTASI,
  type JenisMutasi,
  jenisBeritaAcara,
  KONDISI_BARANG,
  MAKS_KODE_PREFIX,
  normalizeKodePrefix,
  PENERIMA_TIPE,
  type ServisInventaris,
  TIPE_BARANG,
} from "@/lib/validations/inventory";
import {
  describeImportReport,
  runImport,
} from "@/lib/validations/inventory-import";
import { DialogEkspor } from "./DialogEkspor";
import {
  bacaImporBarang,
  eksporKartuStok,
  unduhTemplateBarang,
} from "./ekspor";
import {
  angka,
  bacaJumlah,
  hariIniWib,
  INPUT,
  isianJumlah,
  LABEL,
  pesanGalat,
  SUMBER_DANA_UMUM,
  TOMBOL_BAHAYA,
  TOMBOL_KEDUA,
  TOMBOL_UTAMA,
} from "./gaya";
import { DialogKolomTambahan } from "./KolomTambahan";
import { DialogLabel } from "./LabelQr";
import {
  bisaCetakBeritaAcara,
  cetakBeritaAcaraMutasi,
  type FilterBarang,
  type FilterKedaluwarsa,
  PanelKedaluwarsa,
  PanelOpname,
  PanelPinjaman,
  PanelRingkasan,
  type TujuanRingkasan,
} from "./PanelPemantauan";
import { jumlahPerluDiterima, PanelPengajuan } from "./Pengajuan";
import {
  type AksiServis,
  DialogServis,
  jumlahDiservis,
  keteranganServis,
  PanelServis,
  ServisBarang,
  servisPerUnit,
} from "./Servis";
import {
  bisaDaftarkanUnit,
  DialogDaftarkanUnit,
  DialogUnit,
  stokBelumBernomor,
} from "./UnitAset";

/**
 * Seluruh UI inventaris, dipakai apa adanya oleh halaman Web/Desktop dan
 * Mobile (disalin lewat `filesToCopy`). Sengaja hanya bergantung pada kontrak
 * `Modal` yang sama di kedua workspace; pesan sukses/galat ditulis di sini
 * karena `FeedbackBanner` kedua workspace punya props yang berbeda.
 */

type Tab =
  | "ringkasan"
  | "barang"
  | "catat"
  | "kedaluwarsa"
  | "dipinjam"
  | "servis"
  | "pengajuan"
  | "opname"
  | "kartu";
type Feedback = { tone: "success" | "error"; message: string } | null;

const SATUAN_UMUM = [
  "pcs",
  "buah",
  "rim",
  "lembar",
  "botol",
  "strip",
  "tablet",
  "kotak",
  "set",
  "ml",
];
const ALASAN_BAWAAN: Record<JenisMutasi, string> = {
  Masuk: "Pengadaan",
  Keluar: "Pemakaian",
  Pindah: "Distribusi",
};

function awalBulan(tanggal: string): string {
  return `${tanggal.slice(0, 8)}01`;
}

function labelPosisi(
  posisi: PosisiStok,
  satuan: string,
  desimal: boolean,
): string {
  const bagian = [posisi.tempat, posisi.kondisi];
  if (posisi.tanggal_expired)
    bagian.push(`kedaluwarsa ${posisi.tanggal_expired}`);
  return `${bagian.join(" · ")} (sisa ${angka(posisi.saldo, desimal)} ${satuan})`;
}

/**
 * `utamakanCatat`: Mobile membuka tab Catat lebih dulu, karena petugas gudang
 * memakai HP untuk mencatat di lapangan, bukan untuk mengelola barang.
 */
export function InventarisWorkspace({
  utamakanCatat = false,
}: {
  utamakanCatat?: boolean;
}) {
  const { user } = useAuth();
  const canManage = hasPermission(user, "inventory.manage");
  const canRecord = hasPermission(user, "inventory.record");
  const canAdjust = hasPermission(user, "inventory.adjust");

  const [data, setData] = useState<DaftarInventaris | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const bisaCatat = canRecord || canAdjust;
  const [tab, setTab] = useState<Tab>(
    utamakanCatat && bisaCatat ? "catat" : "ringkasan",
  );
  const [pinjaman, setPinjaman] = useState<DaftarPinjaman | null>(null);
  const [pinjamanGalat, setPinjamanGalat] = useState<string | null>(null);
  const [filterBarang, setFilterBarang] = useState<FilterBarang>("semua");
  const [filterKedaluwarsa, setFilterKedaluwarsa] =
    useState<FilterKedaluwarsa>("perhatian");
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [formBarang, setFormBarang] = useState<
    BarangInventaris | "baru" | null
  >(null);
  const [barangCatat, setBarangCatat] = useState("");
  const [barangKartu, setBarangKartu] = useState("");
  const [aturAwalan, setAturAwalan] = useState(false);
  const [aturKolom, setAturKolom] = useState(false);
  const [ekspor, setEkspor] = useState<{
    barang: BarangInventaris[];
    tempat: string;
  } | null>(null);
  const [unitAksi, setUnitAksi] = useState<
    | { jenis: "daftar"; barang: BarangInventaris }
    | { jenis: "ubah"; barang: BarangInventaris; posisi: PosisiStok }
    | null
  >(null);
  const [aksiServis, setAksiServis] = useState<AksiServis | null>(null);
  const isSubmittingRef = useRef(false);
  const [mengimpor, setMengimpor] = useState(false);

  const muatPinjaman = useCallback(async () => {
    try {
      setPinjaman(await getPinjamanInventaris());
      setPinjamanGalat(null);
    } catch (error) {
      setPinjamanGalat(
        pesanGalat(error, "Daftar peminjaman tidak bisa dimuat."),
      );
    }
  }, []);

  const muat = useCallback(async () => {
    try {
      setData(await getInventaris());
      setLoadError(null);
    } catch (error) {
      setLoadError(pesanGalat(error, "Daftar inventaris tidak bisa dimuat."));
    } finally {
      setLoading(false);
    }
    await muatPinjaman();
  }, [muatPinjaman]);

  const bukaDariRingkasan = (tujuan: TujuanRingkasan) => {
    if (tujuan.tab === "barang") setFilterBarang(tujuan.filter);
    if (tujuan.tab === "kedaluwarsa") setFilterKedaluwarsa(tujuan.filter);
    setTab(tujuan.tab);
  };

  const selesai = async (message: string) => {
    setFeedback({ tone: "success", message });
    await muat();
  };
  const galat = (message: string) => setFeedback({ tone: "error", message });
  const info = (message: string) => setFeedback({ tone: "success", message });

  const unduhTemplate = async () => {
    if (!data) return;
    try {
      const hasil = await unduhTemplateBarang(data);
      if (hasil.sukses) info("Template barang tersimpan sebagai berkas Excel.");
    } catch (error) {
      galat(pesanGalat(error, "Berkas Excel tidak bisa disimpan."));
    }
  };

  const imporBarang = async (file: File) => {
    if (!data || isSubmittingRef.current) return;
    isSubmittingRef.current = true;
    setMengimpor(true);
    try {
      const { baris, judulAsing } = await bacaImporBarang(file, data);
      const report = await runImport(baris, async (draft) => {
        const tersimpan = await simpanBarangInventaris(draft.barang);
        if (!draft.saldo) return;
        try {
          await catatMutasiInventaris({
            ...draft.saldo,
            id_barang: tersimpan.id_barang,
          });
        } catch (error) {
          throw new Error(
            `${tersimpan.kode_barang} tersimpan, tetapi saldo awalnya gagal dicatat (${pesanGalat(error, "galat tidak dikenal")}). Catat lewat Catat Mutasi.`,
          );
        }
      });
      const kodeOtomatis = baris.filter(
        (item) => item.draft.baru && !item.draft.barang.kode_barang,
      ).length;
      const saldoDiabaikan = baris.filter(
        (item) => item.draft.saldoDiabaikan,
      ).length;
      const desimalDiabaikan = baris.filter(
        (item) => item.draft.desimalDiabaikan,
      ).length;
      const pesan = [describeImportReport(report)];
      if (judulAsing.length > 0) {
        pesan.push(
          `Kolom ${judulAsing.join(", ")} tidak dikenal dan isinya diabaikan.`,
        );
      }
      if (kodeOtomatis > 0) {
        pesan.push(
          `${kodeOtomatis} barang baru diberi kode otomatis; unduh ulang template sebelum impor berikutnya supaya barangnya tidak dobel.`,
        );
      }
      if (saldoDiabaikan > 0) {
        pesan.push(
          `Saldo awal ${saldoDiabaikan} barang yang sudah ada diabaikan; tambah stoknya lewat Catat Mutasi.`,
        );
      }
      if (desimalDiabaikan > 0) {
        pesan.push(
          `Kolom Desimal ${desimalDiabaikan} barang tidak diubah karena barangnya sudah punya riwayat mutasi.`,
        );
      }
      setFeedback({
        tone: report.gagal.length > 0 ? "error" : "success",
        message: pesan.join(" "),
      });
      await muat();
    } catch (error) {
      galat(pesanGalat(error, "Berkas Excel tidak bisa dibaca."));
    } finally {
      isSubmittingRef.current = false;
      setMengimpor(false);
    }
  };

  useEffect(() => {
    void muat();
  }, [muat]);

  useEffect(() => subscribeSyncCompleted(() => void muat()), [muat]);

  // Tanda angka tab Pengajuan: di-ACC, barangnya belum diterima penuh.
  const [perluDiterima, setPerluDiterima] = useState(0);
  const muatPengajuan = useCallback(async () => {
    try {
      const hari = hariIniWib();
      setPerluDiterima(jumlahPerluDiterima(await getPengajuan(hari, hari)));
    } catch {
      // Hanya tanda angka; tabnya sendiri menampilkan kegagalannya.
      setPerluDiterima(0);
    }
  }, []);
  useEffect(() => {
    void muatPengajuan();
  }, [muatPengajuan]);
  useEffect(
    () => subscribeSyncCompleted(() => void muatPengajuan()),
    [muatPengajuan],
  );

  const daftarTab: Record<Tab, string> = {
    ringkasan: "Ringkasan",
    barang: "Barang",
    catat: "Catat Mutasi",
    kedaluwarsa: "Kedaluwarsa",
    dipinjam: "Dipinjam",
    servis: "Servis",
    pengajuan: perluDiterima > 0 ? `Pengajuan (${perluDiterima})` : "Pengajuan",
    opname: "Opname",
    kartu: "Kartu Stok",
  };
  // Mobile mendahulukan pekerjaan lapangan; tab yang tidak boleh dipakai
  // pemakainya tidak ditampilkan sama sekali.
  const urutan: Tab[] = utamakanCatat
    ? [
        "catat",
        "kedaluwarsa",
        "dipinjam",
        "servis",
        "pengajuan",
        "barang",
        "ringkasan",
        "opname",
        "kartu",
      ]
    : [
        "ringkasan",
        "barang",
        "catat",
        "kedaluwarsa",
        "dipinjam",
        "servis",
        "pengajuan",
        "opname",
        "kartu",
      ];
  const tabs = urutan
    .filter((id) =>
      id === "catat" ? bisaCatat : id === "opname" ? canAdjust : true,
    )
    .map((id) => ({ id, label: daftarTab[id] }));

  return (
    <div className="space-y-4">
      <div
        role="tablist"
        aria-label="Bagian inventaris"
        className="flex gap-1 p-1 rounded-xl border border-slate-800 bg-slate-900/60 overflow-x-auto"
      >
        {tabs.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            id={`tab-inventaris-${item.id}`}
            aria-selected={tab === item.id}
            aria-controls={`panel-inventaris-${item.id}`}
            onClick={() => setTab(item.id)}
            className={`min-h-11 flex-1 whitespace-nowrap px-4 py-2 text-sm font-medium rounded-lg transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 ${
              tab === item.id
                ? "bg-sky-700 text-white"
                : "text-slate-300 hover:bg-slate-800"
            }`}
          >
            {item.label}
          </button>
        ))}
      </div>

      {feedback ? (
        <output
          className={`flex items-start justify-between gap-3 p-3 rounded-lg border text-sm ${
            feedback.tone === "success"
              ? "border-emerald-500/30 bg-emerald-500/20 text-emerald-100"
              : "border-rose-500/30 bg-rose-500/20 text-rose-100"
          }`}
        >
          <span>{feedback.message}</span>
          <button
            type="button"
            onClick={() => setFeedback(null)}
            className="shrink-0 px-2 text-xs font-semibold underline focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 rounded"
          >
            Tutup
          </button>
        </output>
      ) : null}

      <div
        role="tabpanel"
        id={`panel-inventaris-${tab}`}
        aria-labelledby={`tab-inventaris-${tab}`}
      >
        {loading ? (
          <p className="p-10 text-center text-sm text-slate-400">
            Memuat daftar barang dan stok...
          </p>
        ) : loadError || !data ? (
          <div className="p-6 rounded-xl border border-rose-500/30 bg-rose-500/20 text-sm text-rose-100 space-y-3">
            <p>{loadError ?? "Daftar inventaris tidak bisa dimuat."}</p>
            <button
              type="button"
              onClick={() => void muat()}
              className={TOMBOL_KEDUA}
            >
              Coba muat lagi
            </button>
          </div>
        ) : tab === "ringkasan" ? (
          <PanelRingkasan
            data={data}
            pinjaman={pinjaman}
            pinjamanGalat={pinjamanGalat}
            onBuka={bukaDariRingkasan}
            onInfo={info}
            onGalat={galat}
          />
        ) : tab === "kedaluwarsa" ? (
          <PanelKedaluwarsa
            key={filterKedaluwarsa}
            data={data}
            filterAwal={filterKedaluwarsa}
            canAdjust={canAdjust}
            isSubmittingRef={isSubmittingRef}
            onSelesai={selesai}
            onGalat={galat}
          />
        ) : tab === "dipinjam" ? (
          <PanelPinjaman
            data={data}
            pinjaman={pinjaman}
            galat={pinjamanGalat}
            canRecord={canRecord}
            isSubmittingRef={isSubmittingRef}
            onMuatUlang={() => void muatPinjaman()}
            onSelesai={selesai}
            onGalat={galat}
          />
        ) : tab === "servis" ? (
          <PanelServis
            data={data}
            canRecord={canRecord}
            canAdjust={canAdjust}
            onAksi={setAksiServis}
            onAfkir={(idBarang) => {
              setBarangCatat(idBarang);
              setTab("catat");
            }}
            onInfo={info}
            onGalat={galat}
          />
        ) : tab === "pengajuan" ? (
          <PanelPengajuan
            data={data}
            canRecord={canRecord}
            onInfo={info}
            onBerubah={() => {
              void muatPengajuan();
              // Penerimaan menambah stok dan bisa membuat barang baru.
              void muat();
            }}
          />
        ) : tab === "opname" ? (
          <PanelOpname
            data={data}
            isSubmittingRef={isSubmittingRef}
            onSelesai={selesai}
            onGalat={galat}
          />
        ) : tab === "barang" ? (
          <DaftarBarang
            key={filterBarang}
            filterAwal={filterBarang}
            data={data}
            canManage={canManage}
            canRecord={canRecord}
            onTambah={() => setFormBarang("baru")}
            onAturAwalan={() => setAturAwalan(true)}
            onAturKolom={() => setAturKolom(true)}
            onEkspor={(barang, tempat) => setEkspor({ barang, tempat })}
            onUnduhTemplate={() => void unduhTemplate()}
            onImpor={(file) => void imporBarang(file)}
            mengimpor={mengimpor}
            onUbah={(barang) => setFormBarang(barang)}
            onCatat={(barang) => {
              setBarangCatat(barang.id_barang);
              setTab("catat");
            }}
            onKartu={(barang) => {
              setBarangKartu(barang.id_barang);
              setTab("kartu");
            }}
            onDaftarkanUnit={(barang) =>
              setUnitAksi({ jenis: "daftar", barang })
            }
            onUbahUnit={(barang, posisi) =>
              setUnitAksi({ jenis: "ubah", barang, posisi })
            }
            onServis={setAksiServis}
          />
        ) : tab === "catat" ? (
          <FormMutasi
            data={data}
            idBarangAwal={barangCatat}
            canRecord={canRecord}
            canAdjust={canAdjust}
            isSubmittingRef={isSubmittingRef}
            onSelesai={selesai}
            onGalat={galat}
          />
        ) : (
          <PanelKartuStok
            data={data}
            idBarangAwal={barangKartu}
            canAdjust={canAdjust}
            isSubmittingRef={isSubmittingRef}
            onBatal={selesai}
            onInfo={info}
            onGalat={galat}
          />
        )}
      </div>

      {formBarang && data ? (
        <FormBarang
          barang={formBarang === "baru" ? null : formBarang}
          data={data}
          isSubmittingRef={isSubmittingRef}
          onClose={() => setFormBarang(null)}
          onSaved={async (message) => {
            setFormBarang(null);
            setFeedback({ tone: "success", message });
            await muat();
          }}
        />
      ) : null}

      {aksiServis && data ? (
        <DialogServis
          aksi={aksiServis}
          data={data}
          isSubmittingRef={isSubmittingRef}
          onClose={() => setAksiServis(null)}
          onSelesai={async (message) => {
            setAksiServis(null);
            await selesai(message);
          }}
        />
      ) : null}

      {unitAksi?.jenis === "daftar" ? (
        <DialogDaftarkanUnit
          barang={unitAksi.barang}
          isSubmittingRef={isSubmittingRef}
          onClose={() => setUnitAksi(null)}
          onSaved={async (message) => {
            setUnitAksi(null);
            await selesai(message);
          }}
        />
      ) : unitAksi?.jenis === "ubah" ? (
        <DialogUnit
          barang={unitAksi.barang}
          posisi={unitAksi.posisi}
          isSubmittingRef={isSubmittingRef}
          onClose={() => setUnitAksi(null)}
          onSaved={async (message) => {
            setUnitAksi(null);
            await selesai(message);
          }}
        />
      ) : null}

      {ekspor && data ? (
        <DialogEkspor
          data={data}
          barang={ekspor.barang}
          tempat={ekspor.tempat}
          onClose={() => setEkspor(null)}
          onTersimpan={() => {
            setEkspor(null);
            info("Data inventaris tersimpan sebagai berkas Excel.");
          }}
        />
      ) : null}
      {aturKolom && data ? (
        <DialogKolomTambahan
          kolom={data.kolom}
          barang={data.barang}
          bolehHapus={hasPermission(user, "inventory.column.delete")}
          isSubmittingRef={isSubmittingRef}
          onClose={() => setAturKolom(false)}
          onChanged={muat}
        />
      ) : null}
      {aturAwalan && data ? (
        <FormAwalanKode
          awalan={data.kode_prefix}
          isSubmittingRef={isSubmittingRef}
          onClose={() => setAturAwalan(false)}
          onSaved={async (message) => {
            setAturAwalan(false);
            setFeedback({ tone: "success", message });
            await muat();
          }}
        />
      ) : null}
    </div>
  );
}

// ── Daftar barang ───────────────────────────────────────────────────────────

function DaftarBarang({
  filterAwal,
  data,
  canManage,
  canRecord,
  onTambah,
  onAturAwalan,
  onAturKolom,
  onEkspor,
  onUnduhTemplate,
  onImpor,
  mengimpor,
  onUbah,
  onCatat,
  onKartu,
  onDaftarkanUnit,
  onUbahUnit,
  onServis,
}: {
  filterAwal: FilterBarang;
  data: DaftarInventaris;
  canManage: boolean;
  canRecord: boolean;
  onTambah: () => void;
  onAturAwalan: () => void;
  onAturKolom: () => void;
  /** Barang yang tampil di layar dan filter tempatnya, untuk ekspor. */
  onEkspor: (barang: BarangInventaris[], tempat: string) => void;
  onUnduhTemplate: () => void;
  onImpor: (file: File) => void;
  mengimpor: boolean;
  onUbah: (barang: BarangInventaris) => void;
  onCatat: (barang: BarangInventaris) => void;
  onKartu: (barang: BarangInventaris) => void;
  onDaftarkanUnit: (barang: BarangInventaris) => void;
  onUbahUnit: (barang: BarangInventaris, posisi: PosisiStok) => void;
  onServis: (aksi: AksiServis) => void;
}) {
  const [cari, setCari] = useState("");
  const [kategori, setKategori] = useState("");
  const [tempat, setTempat] = useState("");
  const [tampilkanNonaktif, setTampilkanNonaktif] = useState(false);
  const [filterStok, setFilterStok] = useState<FilterBarang>(filterAwal);
  const [terbuka, setTerbuka] = useState<string | null>(null);
  const [cetakLabel, setCetakLabel] = useState(false);
  const imporRef = useRef<HTMLInputElement>(null);
  // Cetak butuh dialog cetak, yang tidak ada di WebView Android.
  const bisaCetak = bisaCetakBeritaAcara();
  const kolomAktif = useMemo(
    () => data.kolom.filter((kolom) => kolom.is_aktif),
    [data.kolom],
  );
  const servisUnit = useMemo(() => servisPerUnit(data), [data]);

  const daftar = useMemo(() => {
    const kata = cari.trim().toLowerCase();
    return data.barang.filter(
      (barang) =>
        (tampilkanNonaktif || barang.status_aktif) &&
        (filterStok === "semua" ||
          (filterStok === "menipis" && barang.stok_menipis) ||
          (filterStok === "minus" && barang.posisi.some((p) => p.saldo < 0))) &&
        (!kategori || barang.kategori === kategori) &&
        (!tempat ||
          barang.posisi.some(
            (p) => p.tempat.toLowerCase() === tempat.toLowerCase(),
          )) &&
        (!kata ||
          barang.nama_barang.toLowerCase().includes(kata) ||
          barang.kode_barang.toLowerCase().includes(kata) ||
          kolomAktif.some((kolom) =>
            (barang.atribut[kolom.id_kolom] ?? "").toLowerCase().includes(kata),
          )),
    );
  }, [
    data.barang,
    kolomAktif,
    cari,
    kategori,
    tempat,
    tampilkanNonaktif,
    filterStok,
  ]);

  // Dipakai juga di tampilan kosong: impor Excel paling dibutuhkan justru
  // saat belum ada barang sama sekali.
  const tombolKelola = canManage ? (
    <>
      <input
        ref={imporRef}
        type="file"
        accept=".xlsx"
        className="hidden"
        aria-label="Pilih berkas Excel barang untuk diimpor"
        onChange={(e) => {
          const file = e.target.files?.[0];
          // Dikosongkan supaya berkas yang sama bisa dipilih lagi.
          e.target.value = "";
          if (file) onImpor(file);
        }}
      />
      <button type="button" onClick={onUnduhTemplate} className={TOMBOL_KEDUA}>
        Unduh template
      </button>
      <button
        type="button"
        disabled={mengimpor}
        onClick={() => imporRef.current?.click()}
        className={TOMBOL_KEDUA}
      >
        {mengimpor ? "Mengimpor..." : "Impor Excel"}
      </button>
      <button type="button" onClick={onAturKolom} className={TOMBOL_KEDUA}>
        Kolom tambahan
      </button>
    </>
  ) : null;

  if (data.barang.length === 0) {
    return (
      <div className="p-8 rounded-xl border border-dashed border-slate-800 bg-slate-900/60 text-center space-y-3">
        <p className="font-medium text-slate-200">
          Belum ada barang yang terdaftar.
        </p>
        <p className="text-sm text-slate-400">
          Daftarkan barang lebih dulu, lalu catat stok yang sudah ada di
          tempatnya sebagai mutasi Masuk dengan alasan Saldo Awal. Banyak barang
          sekaligus bisa diimpor dari Excel lewat template.
        </p>
        {canManage ? (
          <div className="flex flex-wrap justify-center gap-2">
            {tombolKelola}
            <button type="button" onClick={onTambah} className={TOMBOL_UTAMA}>
              Tambah barang pertama
            </button>
          </div>
        ) : (
          <p className="text-xs text-slate-500">
            Menambah barang butuh izin Kelola Master Barang.
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="p-3 rounded-xl border border-slate-800 bg-slate-900/60 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <div>
          <label htmlFor="inv-cari" className={LABEL}>
            {kolomAktif.length > 0
              ? "Cari nama, kode, atau kolom tambahan"
              : "Cari nama atau kode"}
          </label>
          <input
            id="inv-cari"
            type="search"
            value={cari}
            onChange={(e) => setCari(e.target.value)}
            className={INPUT}
          />
        </div>
        <div>
          <label htmlFor="inv-filter-kategori" className={LABEL}>
            Kategori
          </label>
          <select
            id="inv-filter-kategori"
            value={kategori}
            onChange={(e) => setKategori(e.target.value)}
            className={INPUT}
          >
            <option value="">Semua kategori</option>
            {data.kategori.map((nama) => (
              <option key={nama} value={nama}>
                {nama}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="inv-filter-tempat" className={LABEL}>
            Tempat
          </label>
          <select
            id="inv-filter-tempat"
            value={tempat}
            onChange={(e) => setTempat(e.target.value)}
            className={INPUT}
          >
            <option value="">Semua tempat</option>
            {data.tempat.map((nama) => (
              <option key={nama} value={nama}>
                {nama}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="inv-filter-stok" className={LABEL}>
            Kondisi stok
          </label>
          <select
            id="inv-filter-stok"
            value={filterStok}
            onChange={(e) => setFilterStok(e.target.value as FilterBarang)}
            className={INPUT}
          >
            <option value="semua">Semua barang</option>
            <option value="menipis">Stok menipis</option>
            <option value="minus">Stok minus (perlu opname)</option>
          </select>
        </div>
        <div className="flex items-end">
          <label className="flex min-h-11 items-center gap-2 text-sm text-slate-300">
            <input
              type="checkbox"
              checked={tampilkanNonaktif}
              onChange={(e) => setTampilkanNonaktif(e.target.checked)}
              className="h-4 w-4"
            />
            Tampilkan nonaktif
          </label>
        </div>
      </div>

      <div className="flex flex-wrap justify-end gap-2">
        <button
          type="button"
          onClick={() => onEkspor(daftar, tempat)}
          className={TOMBOL_KEDUA}
        >
          Ekspor Excel
        </button>
        {bisaCetak ? (
          <button
            type="button"
            onClick={() => setCetakLabel(true)}
            className={TOMBOL_KEDUA}
          >
            Cetak label QR
          </button>
        ) : null}
        {canManage ? (
          <>
            {tombolKelola}
            <button
              type="button"
              onClick={onAturAwalan}
              className={TOMBOL_KEDUA}
            >
              Awalan kode
            </button>
            <button type="button" onClick={onTambah} className={TOMBOL_UTAMA}>
              Tambah barang
            </button>
          </>
        ) : null}
      </div>

      {daftar.length === 0 ? (
        <p className="p-8 text-center text-sm text-slate-400 rounded-xl border border-dashed border-slate-800">
          Tidak ada barang yang cocok dengan pencarian atau filter ini.
        </p>
      ) : (
        <ul className="space-y-2">
          {daftar.map((barang) => {
            const rusak = barang.stok_total - barang.stok_baik;
            const buka = terbuka === barang.id_barang;
            return (
              <li
                key={barang.id_barang}
                className="p-4 rounded-xl border border-slate-800 bg-slate-900/60 space-y-3"
              >
                <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                  <div className="min-w-0">
                    <p className="font-semibold text-slate-100 break-words">
                      {barang.nama_barang}
                      {!barang.status_aktif ? (
                        <span className="ml-2 text-xs font-medium text-slate-400">
                          (nonaktif)
                        </span>
                      ) : null}
                    </p>
                    <p className="text-xs text-slate-400">
                      {barang.kode_barang} · {barang.tipe}
                      {barang.kategori ? ` · ${barang.kategori}` : ""}
                      {barang.bisa_expired ? " · berkedaluwarsa" : ""}
                    </p>
                    {barang.kode_ganda ? (
                      <p className="mt-1 text-xs font-medium text-amber-300">
                        Kode {barang.kode_barang} juga dipakai barang lain.
                        {canManage
                          ? " Ubah salah satunya supaya tidak tertukar."
                          : ""}
                      </p>
                    ) : null}
                  </div>
                  <div className="flex flex-wrap items-center gap-2 md:justify-end">
                    <p className="mr-2 text-right">
                      <span
                        className={`text-lg font-bold ${
                          barang.stok_total < 0
                            ? "text-rose-300"
                            : "text-slate-100"
                        }`}
                      >
                        {angka(barang.stok_baik, barang.desimal)}
                      </span>{" "}
                      <span className="text-sm text-slate-400">
                        {barang.satuan} baik
                      </span>
                      {rusak !== 0 ? (
                        <span className="block text-xs text-amber-300">
                          {angka(rusak, barang.desimal)} {barang.satuan} rusak
                        </span>
                      ) : null}
                      {barang.stok_menipis ? (
                        <span className="block text-xs font-medium text-amber-300">
                          di bawah minimum{" "}
                          {angka(barang.stok_minimum, barang.desimal)}
                        </span>
                      ) : null}
                    </p>
                    <button
                      type="button"
                      aria-expanded={buka}
                      onClick={() => setTerbuka(buka ? null : barang.id_barang)}
                      className={TOMBOL_KEDUA}
                    >
                      {buka ? "Tutup rincian" : "Rincian"}
                    </button>
                    <button
                      type="button"
                      onClick={() => onKartu(barang)}
                      className={TOMBOL_KEDUA}
                    >
                      Kartu stok
                    </button>
                    {canRecord && barang.status_aktif ? (
                      <button
                        type="button"
                        onClick={() => onCatat(barang)}
                        className={TOMBOL_KEDUA}
                      >
                        Catat
                      </button>
                    ) : null}
                    {canManage ? (
                      <button
                        type="button"
                        onClick={() => onUbah(barang)}
                        className={TOMBOL_KEDUA}
                      >
                        Ubah
                      </button>
                    ) : null}
                  </div>
                </div>
                {buka &&
                kolomAktif.some((kolom) => barang.atribut[kolom.id_kolom]) ? (
                  <dl className="grid grid-cols-1 gap-x-4 gap-y-1 text-sm sm:grid-cols-2">
                    {kolomAktif
                      .filter((kolom) => barang.atribut[kolom.id_kolom])
                      .map((kolom) => {
                        const isi = barang.atribut[kolom.id_kolom] ?? "";
                        return (
                          <div key={kolom.id_kolom} className="flex gap-2">
                            <dt className="text-slate-400">{kolom.nama}</dt>
                            <dd className="min-w-0 break-words text-slate-200">
                              {kolom.tipe === "Angka" ? formatAngka(isi) : isi}
                            </dd>
                          </div>
                        );
                      })}
                  </dl>
                ) : null}
                {buka && (barang.dilacak_unit || bisaDaftarkanUnit(barang)) ? (
                  <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                    <p className="text-slate-400">
                      {barang.dilacak_unit
                        ? "Dicatat per unit."
                        : "Dicatat per jumlah."}
                      {barang.dilacak_unit &&
                      stokBelumBernomor(barang).length > 0
                        ? ` ${stokBelumBernomor(barang).reduce((n, p) => n + p.saldo, 0)} ${barang.satuan} belum bernomor dan belum bisa dikeluarkan.`
                        : ""}
                    </p>
                    {canManage && bisaDaftarkanUnit(barang) ? (
                      <button
                        type="button"
                        onClick={() => onDaftarkanUnit(barang)}
                        className={TOMBOL_KEDUA}
                      >
                        Daftarkan unit
                      </button>
                    ) : null}
                  </div>
                ) : null}
                {buka ? (
                  barang.posisi.length === 0 ? (
                    <p className="text-sm text-slate-400">
                      Stok barang ini kosong di semua tempat.
                    </p>
                  ) : (
                    <ul className="divide-y divide-slate-800 rounded-lg border border-slate-800 bg-slate-950/40">
                      {barang.posisi.map((posisi) => (
                        <li
                          key={`${posisi.tempat}|${posisi.kondisi}|${posisi.id_batch ?? ""}`}
                          className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm"
                        >
                          <span className="text-slate-200">
                            {posisi.kode_unit ? (
                              <span className="font-medium text-slate-100">
                                {posisi.kode_unit}
                                {posisi.nomor_seri ? (
                                  <span className="font-normal text-slate-400">
                                    {" "}
                                    · SN {posisi.nomor_seri}
                                  </span>
                                ) : null}
                                {" · "}
                              </span>
                            ) : null}
                            {posisi.tempat}
                            <span className="text-slate-400">
                              {" "}
                              · {posisi.kondisi}
                            </span>
                            {posisi.tanggal_expired ? (
                              <span className="text-slate-400">
                                {" "}
                                · kedaluwarsa {posisi.tanggal_expired}
                              </span>
                            ) : null}
                            {posisi.id_batch &&
                            servisUnit.has(posisi.id_batch) ? (
                              <span className="block text-xs text-amber-300">
                                {keteranganServis(
                                  servisUnit.get(
                                    posisi.id_batch,
                                  ) as ServisInventaris,
                                )}
                              </span>
                            ) : !barang.dilacak_unit &&
                              jumlahDiservis(
                                data,
                                barang.id_barang,
                                posisi.tempat,
                                posisi.kondisi,
                              ) > 0 ? (
                              <span className="block text-xs text-amber-300">
                                {angka(
                                  jumlahDiservis(
                                    data,
                                    barang.id_barang,
                                    posisi.tempat,
                                    posisi.kondisi,
                                  ),
                                )}{" "}
                                {barang.satuan} sedang diservis
                              </span>
                            ) : null}
                          </span>
                          <span
                            className={`font-semibold ${
                              posisi.saldo < 0
                                ? "text-rose-300"
                                : "text-slate-100"
                            }`}
                          >
                            {angka(posisi.saldo, barang.desimal)}{" "}
                            {barang.satuan}
                            {posisi.saldo < 0 ? " (perlu opname)" : ""}
                          </span>
                          {canManage && posisi.kode_unit ? (
                            <button
                              type="button"
                              onClick={() => onUbahUnit(barang, posisi)}
                              aria-label={`Ubah unit ${posisi.kode_unit}`}
                              className={TOMBOL_KEDUA}
                            >
                              Ubah
                            </button>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  )
                ) : null}
                {buka && barang.tipe === "Aset" ? (
                  <ServisBarang
                    data={data}
                    barang={barang}
                    canRecord={canRecord}
                    onAksi={onServis}
                  />
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      {cetakLabel ? (
        <DialogLabel
          barang={daftar}
          namaPerusahaan={data.nama_perusahaan}
          onClose={() => setCetakLabel(false)}
        />
      ) : null}
    </div>
  );
}

// ── Form barang ─────────────────────────────────────────────────────────────

function FormBarang({
  barang,
  data,
  isSubmittingRef,
  onClose,
  onSaved,
}: {
  barang: BarangInventaris | null;
  data: DaftarInventaris;
  isSubmittingRef: { current: boolean };
  onClose: () => void;
  onSaved: (message: string) => Promise<void>;
}) {
  const [nama, setNama] = useState(barang?.nama_barang ?? "");
  const [kode, setKode] = useState(barang?.kode_barang ?? "");
  const [awalan, setAwalan] = useState(data.kode_prefix[0] ?? "BRG");
  const [tipe, setTipe] = useState<string>(barang?.tipe ?? "Habis Pakai");
  const [satuan, setSatuan] = useState(barang?.satuan ?? "");
  const [kategori, setKategori] = useState(barang?.kategori ?? "");
  const [tempatUtama, setTempatUtama] = useState(barang?.tempat_utama ?? "");
  const [stokMinimum, setStokMinimum] = useState(
    barang ? angka(barang.stok_minimum, barang.desimal) : "0",
  );
  const [bisaExpired, setBisaExpired] = useState(barang?.bisa_expired ?? false);
  const [desimal, setDesimal] = useState(barang?.desimal ?? false);
  // Mengubahnya setelah ada mutasi akan mengubah arti setiap jumlah tercatat.
  const desimalTerkunci = barang?.punya_mutasi ?? false;
  const pakaiDesimal = desimal && tipe === "Habis Pakai";
  const [catatan, setCatatan] = useState(barang?.catatan ?? "");
  const [aktif, setAktif] = useState(barang?.status_aktif ?? true);
  const kolomAktif = data.kolom.filter((kolom) => kolom.is_aktif);
  // Angka ditampilkan dan diketik berformat Indonesia: 1.250,5.
  const [isiKolom, setIsiKolom] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      kolomAktif.map((kolom) => {
        const isi = barang?.atribut[kolom.id_kolom] ?? "";
        return [
          kolom.id_kolom,
          kolom.tipe === "Angka" && isi ? formatAngka(isi) : isi,
        ];
      }),
    ),
  );
  const [galat, setGalat] = useState<string | null>(null);
  const [menyimpan, setMenyimpan] = useState(false);

  const simpan = async (event: FormEvent) => {
    event.preventDefault();
    if (isSubmittingRef.current) return;
    // Isi kolom nonaktif ikut dikirim apa adanya supaya tidak terhapus.
    const atribut: Record<string, string> = { ...(barang?.atribut ?? {}) };
    for (const kolom of kolomAktif) {
      const isi = (isiKolom[kolom.id_kolom] ?? "").trim();
      if (!isi) {
        delete atribut[kolom.id_kolom];
      } else if (kolom.tipe === "Angka") {
        const angka = angkaDariKetikan(isi);
        if (angka === null) {
          setGalat(
            `${kolom.nama} harus angka. Pakai koma untuk desimal, misalnya 2,5.`,
          );
          return;
        }
        atribut[kolom.id_kolom] = angka;
      } else {
        atribut[kolom.id_kolom] = isi;
      }
    }
    let minimum: number;
    try {
      minimum = bacaJumlah(stokMinimum || "0", pakaiDesimal, "Stok minimum");
    } catch (error) {
      setGalat(pesanGalat(error, "Stok minimum tidak valid."));
      return;
    }
    isSubmittingRef.current = true;
    setMenyimpan(true);
    setGalat(null);
    try {
      const hasil = await simpanBarangInventaris({
        id_barang: barang?.id_barang ?? null,
        kode_barang: kode,
        kode_prefix: kode.trim() === "" ? awalan : null,
        nama_barang: nama,
        kategori,
        tipe,
        satuan,
        bisa_expired: bisaExpired,
        desimal: pakaiDesimal,
        stok_minimum: minimum,
        tempat_utama: tempatUtama,
        catatan,
        status_aktif: aktif,
        atribut,
      });
      await onSaved(
        barang
          ? `Perubahan ${nama.trim()} tersimpan.`
          : `${nama.trim()} terdaftar dengan kode ${hasil.kode_barang}.`,
      );
    } catch (error) {
      setGalat(pesanGalat(error, "Barang tidak bisa disimpan."));
    } finally {
      isSubmittingRef.current = false;
      setMenyimpan(false);
    }
  };

  return (
    <Modal
      isOpen={true}
      onClose={onClose}
      title={barang ? "Ubah barang" : "Tambah barang"}
      titleId="inv-form-barang-judul"
    >
      <form onSubmit={simpan} className="space-y-4">
        <div>
          <label htmlFor="inv-nama" className={LABEL}>
            Nama barang
          </label>
          <input
            id="inv-nama"
            required
            value={nama}
            onChange={(e) => setNama(e.target.value)}
            className={INPUT}
          />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label htmlFor="inv-kode" className={LABEL}>
              Kode barang
            </label>
            <input
              id="inv-kode"
              value={kode}
              onChange={(e) => setKode(e.target.value)}
              className={INPUT}
              aria-describedby="inv-kode-bantuan"
            />
            <p id="inv-kode-bantuan" className="mt-1 text-xs text-slate-400">
              Kosongkan untuk nomor urut otomatis, misalnya {awalan}-0001.
            </p>
          </div>
          {kode.trim() === "" ? (
            <div>
              <label htmlFor="inv-awalan" className={LABEL}>
                Awalan kode
              </label>
              <select
                id="inv-awalan"
                value={awalan}
                onChange={(e) => setAwalan(e.target.value)}
                className={INPUT}
              >
                {data.kode_prefix.map((nilai) => (
                  <option key={nilai} value={nilai}>
                    {nilai}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
          <div>
            <label htmlFor="inv-tipe" className={LABEL}>
              Tipe
            </label>
            <select
              id="inv-tipe"
              value={tipe}
              onChange={(e) => setTipe(e.target.value)}
              className={INPUT}
            >
              {TIPE_BARANG.map((nilai) => (
                <option key={nilai} value={nilai}>
                  {nilai}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="inv-satuan" className={LABEL}>
              Satuan
            </label>
            <input
              id="inv-satuan"
              required
              list="inv-satuan-saran"
              value={satuan}
              onChange={(e) => setSatuan(e.target.value)}
              className={INPUT}
            />
            <datalist id="inv-satuan-saran">
              {SATUAN_UMUM.map((nilai) => (
                <option key={nilai} value={nilai} />
              ))}
            </datalist>
          </div>
          <div>
            <label htmlFor="inv-kategori" className={LABEL}>
              Kategori
            </label>
            <input
              id="inv-kategori"
              list="inv-kategori-saran"
              value={kategori}
              onChange={(e) => setKategori(e.target.value)}
              className={INPUT}
            />
            <datalist id="inv-kategori-saran">
              {data.kategori.map((nilai) => (
                <option key={nilai} value={nilai} />
              ))}
            </datalist>
          </div>
          <div>
            <label htmlFor="inv-tempat-utama" className={LABEL}>
              Tempat utama
            </label>
            <input
              id="inv-tempat-utama"
              list="inv-tempat-saran-barang"
              value={tempatUtama}
              onChange={(e) => setTempatUtama(e.target.value)}
              className={INPUT}
            />
            <datalist id="inv-tempat-saran-barang">
              {data.tempat.map((nilai) => (
                <option key={nilai} value={nilai} />
              ))}
            </datalist>
          </div>
          <div>
            <label htmlFor="inv-stok-minimum" className={LABEL}>
              Stok minimum
            </label>
            <input
              id="inv-stok-minimum"
              {...isianJumlah(pakaiDesimal)}
              value={stokMinimum}
              onChange={(e) => setStokMinimum(e.target.value)}
              className={INPUT}
            />
          </div>
        </div>
        <label className="flex min-h-11 items-start gap-2 text-sm text-slate-200">
          <input
            type="checkbox"
            checked={bisaExpired}
            onChange={(e) => setBisaExpired(e.target.checked)}
            className="mt-1 h-4 w-4"
          />
          <span>
            Punya tanggal kedaluwarsa
            <span className="block text-xs text-slate-400">
              Obat P3K dan bahan kimia. Setiap barang masuk dicatat per batch.
              Tidak bisa diubah lagi setelah barang punya riwayat mutasi.
            </span>
          </span>
        </label>
        {tipe === "Habis Pakai" ? (
          <label className="flex min-h-11 items-start gap-2 text-sm text-slate-200">
            <input
              type="checkbox"
              checked={desimal}
              disabled={desimalTerkunci}
              onChange={(e) => setDesimal(e.target.checked)}
              className="mt-1 h-4 w-4"
            />
            <span>
              Jumlah boleh berkoma
              <span className="block text-xs text-slate-400">
                Untuk barang yang ditimbang atau diukur, misalnya 2,5 kg atau
                0,75 liter. Paling banyak 2 angka di belakang koma.
                {desimalTerkunci
                  ? " Barang ini sudah punya riwayat mutasi, jadi pilihannya terkunci."
                  : " Tidak bisa diubah lagi setelah barang punya riwayat mutasi."}
              </span>
            </span>
          </label>
        ) : null}
        {kolomAktif.length > 0 ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {kolomAktif.map((kolom) => (
              <div key={kolom.id_kolom}>
                <label
                  htmlFor={`inv-atribut-${kolom.id_kolom}`}
                  className={LABEL}
                >
                  {kolom.nama}
                </label>
                <input
                  id={`inv-atribut-${kolom.id_kolom}`}
                  inputMode={kolom.tipe === "Angka" ? "decimal" : undefined}
                  maxLength={200}
                  value={isiKolom[kolom.id_kolom] ?? ""}
                  onChange={(e) =>
                    setIsiKolom({
                      ...isiKolom,
                      [kolom.id_kolom]: e.target.value,
                    })
                  }
                  className={INPUT}
                />
              </div>
            ))}
          </div>
        ) : null}
        <div>
          <label htmlFor="inv-catatan-barang" className={LABEL}>
            Catatan
          </label>
          <textarea
            id="inv-catatan-barang"
            rows={2}
            value={catatan}
            onChange={(e) => setCatatan(e.target.value)}
            className={INPUT}
          />
        </div>
        {barang ? (
          <label className="flex min-h-11 items-center gap-2 text-sm text-slate-200">
            <input
              type="checkbox"
              checked={aktif}
              onChange={(e) => setAktif(e.target.checked)}
              className="h-4 w-4"
            />
            Barang masih aktif
          </label>
        ) : null}
        {galat ? (
          <p
            role="alert"
            className="p-3 rounded-lg border border-rose-500/30 bg-rose-500/20 text-sm text-rose-100"
          >
            {galat}
          </p>
        ) : null}
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" onClick={onClose} className={TOMBOL_KEDUA}>
            Batal
          </button>
          <button type="submit" disabled={menyimpan} className={TOMBOL_UTAMA}>
            {menyimpan ? "Menyimpan..." : "Simpan barang"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ── Awalan kode ─────────────────────────────────────────────────────────────

function FormAwalanKode({
  awalan,
  isSubmittingRef,
  onClose,
  onSaved,
}: {
  awalan: string[];
  isSubmittingRef: { current: boolean };
  onClose: () => void;
  onSaved: (message: string) => Promise<void>;
}) {
  const [daftar, setDaftar] = useState<string[]>(awalan);
  const [baru, setBaru] = useState("");
  const [galat, setGalat] = useState<string | null>(null);
  const [menyimpan, setMenyimpan] = useState(false);

  const tambah = () => {
    const nilai = normalizeKodePrefix(baru);
    if (nilai === null) {
      setGalat("Gunakan 1 sampai 6 huruf atau angka, tanpa spasi.");
      return;
    }
    if (daftar.includes(nilai)) {
      setGalat(`Awalan ${nilai} sudah ada di daftar.`);
      return;
    }
    setDaftar([...daftar, nilai]);
    setBaru("");
    setGalat(null);
  };

  const geser = (index: number, arah: -1 | 1) => {
    const tujuan = index + arah;
    if (tujuan < 0 || tujuan >= daftar.length) return;
    const salinan = [...daftar];
    [salinan[index], salinan[tujuan]] = [
      salinan[tujuan] as string,
      salinan[index] as string,
    ];
    setDaftar(salinan);
  };

  const simpan = async () => {
    if (isSubmittingRef.current) return;
    isSubmittingRef.current = true;
    setMenyimpan(true);
    setGalat(null);
    try {
      await simpanAwalanKodeInventaris(daftar);
      await onSaved("Daftar awalan kode tersimpan.");
    } catch (error) {
      setGalat(pesanGalat(error, "Daftar awalan tidak bisa disimpan."));
    } finally {
      isSubmittingRef.current = false;
      setMenyimpan(false);
    }
  };

  return (
    <Modal
      isOpen={true}
      onClose={onClose}
      title="Awalan kode barang"
      titleId="inv-awalan-judul"
    >
      <div className="space-y-4">
        <p className="text-sm text-slate-300">
          Barang baru tanpa kode mendapat nomor urut dari awalan yang dipilih,
          misalnya UKS-0001. Awalan teratas menjadi pilihan bawaan. Menghapus
          awalan tidak mengubah kode barang yang sudah ada.
        </p>
        <ul className="divide-y divide-slate-800 rounded-lg border border-slate-800 bg-slate-950/40">
          {daftar.map((nilai, index) => (
            <li
              key={nilai}
              className="flex flex-wrap items-center justify-between gap-2 px-3 py-2"
            >
              <span className="font-semibold text-slate-100">
                {nilai}
                {index === 0 ? (
                  <span className="ml-2 text-xs font-medium text-slate-400">
                    (bawaan)
                  </span>
                ) : null}
              </span>
              <span className="flex gap-1">
                <button
                  type="button"
                  onClick={() => geser(index, -1)}
                  disabled={index === 0}
                  aria-label={`Naikkan awalan ${nilai}`}
                  className={TOMBOL_KEDUA}
                >
                  Naik
                </button>
                <button
                  type="button"
                  onClick={() => geser(index, 1)}
                  disabled={index === daftar.length - 1}
                  aria-label={`Turunkan awalan ${nilai}`}
                  className={TOMBOL_KEDUA}
                >
                  Turun
                </button>
                <button
                  type="button"
                  onClick={() =>
                    setDaftar(daftar.filter((item) => item !== nilai))
                  }
                  disabled={daftar.length === 1}
                  aria-label={`Hapus awalan ${nilai}`}
                  className={TOMBOL_KEDUA}
                >
                  Hapus
                </button>
              </span>
            </li>
          ))}
        </ul>
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-0 flex-1">
            <label htmlFor="inv-awalan-baru" className={LABEL}>
              Awalan baru
            </label>
            <input
              id="inv-awalan-baru"
              value={baru}
              maxLength={6}
              onChange={(e) => setBaru(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  tambah();
                }
              }}
              className={INPUT}
            />
          </div>
          <button
            type="button"
            onClick={tambah}
            disabled={daftar.length >= MAKS_KODE_PREFIX}
            className={TOMBOL_KEDUA}
          >
            Tambahkan
          </button>
        </div>
        {galat ? (
          <p
            role="alert"
            className="p-3 rounded-lg border border-rose-500/30 bg-rose-500/20 text-sm text-rose-100"
          >
            {galat}
          </p>
        ) : null}
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" onClick={onClose} className={TOMBOL_KEDUA}>
            Batal
          </button>
          <button
            type="button"
            onClick={() => void simpan()}
            disabled={menyimpan}
            className={TOMBOL_UTAMA}
          >
            {menyimpan ? "Menyimpan..." : "Simpan awalan"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ── Form mutasi ─────────────────────────────────────────────────────────────

function FormMutasi({
  data,
  idBarangAwal,
  canRecord,
  canAdjust,
  isSubmittingRef,
  onSelesai,
  onGalat,
}: {
  data: DaftarInventaris;
  idBarangAwal: string;
  canRecord: boolean;
  canAdjust: boolean;
  isSubmittingRef: { current: boolean };
  onSelesai: (message: string) => Promise<void>;
  onGalat: (message: string) => void;
}) {
  const hariIni = hariIniWib();
  const tempatUtama = (id: string) =>
    data.barang.find((item) => item.id_barang === id)?.tempat_utama ?? "";
  // Pengembalian dicatat dari tab Dipinjam karena butuh peminjaman asalnya.
  // Alasan yang menuntut izin yang tidak dimiliki pemakai tidak ditampilkan;
  // backend tetap memeriksa izinnya sendiri.
  const alasanBoleh = (nilai: JenisMutasi) =>
    ALASAN_FORMULIR.filter(
      (item) =>
        alasanSahUntuk(nilai).includes(item) &&
        item !== "Pengembalian" &&
        (izinUntukAlasan(item) === "inventory.adjust" ? canAdjust : canRecord),
    );
  const alasanAwal = (nilai: JenisMutasi): string => {
    const boleh = alasanBoleh(nilai) as readonly string[];
    return boleh.includes(ALASAN_BAWAAN[nilai])
      ? ALASAN_BAWAAN[nilai]
      : (boleh[0] ?? "");
  };
  const jenisTersedia = JENIS_MUTASI.filter(
    (nilai) => alasanBoleh(nilai).length > 0,
  );
  const [jenis, setJenis] = useState<JenisMutasi>(jenisTersedia[0] ?? "Masuk");
  const [idBarang, setIdBarang] = useState(idBarangAwal);
  const [alasan, setAlasan] = useState<string>(
    alasanAwal(jenisTersedia[0] ?? "Masuk"),
  );
  const [jumlah, setJumlah] = useState("");
  const [tanggal, setTanggal] = useState(hariIni);
  // Indeks pada daftar posisi bersaldo. Posisi pertama sudah urut batch
  // terdekat kedaluwarsa (FEFO) dari backend, jadi "0" adalah pilihan FEFO.
  const [posisiAsal, setPosisiAsal] = useState("0");
  const [tempatTujuan, setTempatTujuan] = useState(tempatUtama(idBarangAwal));
  const [kondisiTujuan, setKondisiTujuan] = useState("Baik");
  const [tanggalExpired, setTanggalExpired] = useState("");
  const [sumberDana, setSumberDana] = useState("");
  const [nomorDokumen, setNomorDokumen] = useState("");
  const [harga, setHarga] = useState("");
  const [penerimaTipe, setPenerimaTipe] = useState("");
  const [penerimaId, setPenerimaId] = useState("");
  const [penerimaNama, setPenerimaNama] = useState("");
  const [cariPenerima, setCariPenerima] = useState("");
  const [keperluan, setKeperluan] = useState("");
  const [catatan, setCatatan] = useState("");
  const [penerima, setPenerima] = useState<PenerimaInventaris | null>(null);
  const [penerimaGagal, setPenerimaGagal] = useState<string | null>(null);
  const [menyimpan, setMenyimpan] = useState(false);

  const barang =
    data.barang.find((item) => item.id_barang === idBarang) ?? null;
  const pilihanBarang = data.barang.filter((item) =>
    jenis === "Masuk"
      ? item.status_aktif
      : item.posisi.some((p) => p.saldo > 0),
  );
  const pilihanAlasan = alasanBoleh(jenis);
  const posisiTersedia = barang?.posisi.filter((p) => p.saldo > 0) ?? [];
  const asal = posisiTersedia[Number(posisiAsal)] ?? null;
  const butuhPenerima = alasan === "Pemakaian" || alasan === "Peminjaman";
  // Barang yang dicatat per unit: keluar dan pindah memilih unit dari satu
  // tempat × kondisi; jumlahnya = banyaknya unit yang dicentang.
  const dilacak = barang?.dilacak_unit ?? false;
  const pakaiUnit = dilacak && jenis !== "Masuk";
  const kelompokUnit = useMemo(() => {
    const grup = new Map<
      string,
      { tempat: string; kondisi: string; unit: PosisiStok[] }
    >();
    for (const p of barang?.posisi ?? []) {
      if (!p.kode_unit || p.saldo <= 0) continue;
      const kunci = `${p.tempat.toLowerCase()}|${p.kondisi}`;
      const isi = grup.get(kunci) ?? {
        tempat: p.tempat,
        kondisi: p.kondisi,
        unit: [],
      };
      isi.unit.push(p);
      grup.set(kunci, isi);
    }
    return [...grup.values()];
  }, [barang]);
  const [kelompokAsal, setKelompokAsal] = useState("0");
  const [unitDipilih, setUnitDipilih] = useState<string[]>([]);
  const [perUnit, setPerUnit] = useState(false);
  const grupAsal = kelompokUnit[Number(kelompokAsal)] ?? null;
  const bolehPerUnit =
    jenis === "Masuk" &&
    !dilacak &&
    barang?.tipe === "Aset" &&
    !barang.bisa_expired;

  const pilihJenis = (nilai: JenisMutasi) => {
    setJenis(nilai);
    setAlasan(alasanAwal(nilai));
    setPosisiAsal("0");
    setKelompokAsal("0");
    setUnitDipilih([]);
    setPerUnit(false);
    // Barang tanpa stok tidak bisa dikeluarkan atau dipindah.
    if (
      nilai !== "Masuk" &&
      barang &&
      !barang.posisi.some((p) => p.saldo > 0)
    ) {
      setIdBarang("");
    }
  };

  const pilihBarang = (id: string) => {
    setIdBarang(id);
    setPosisiAsal("0");
    setKelompokAsal("0");
    setUnitDipilih([]);
    setPerUnit(false);
    setTempatTujuan(tempatUtama(id));
  };

  useEffect(() => {
    if (!butuhPenerima || penerima) return;
    getPenerimaInventaris()
      .then(setPenerima)
      .catch((error) =>
        setPenerimaGagal(
          pesanGalat(error, "Daftar penerima tidak bisa dimuat."),
        ),
      );
  }, [butuhPenerima, penerima]);

  const personilTersaring = useMemo(() => {
    const kata = cariPenerima.trim().toLowerCase();
    return (penerima?.personil ?? [])
      .filter((orang) => !kata || orang.nama.toLowerCase().includes(kata))
      .slice(0, 100);
  }, [penerima, cariPenerima]);

  const reset = () => {
    setJumlah("");
    setUnitDipilih([]);
    setTanggalExpired("");
    setNomorDokumen("");
    setHarga("");
    setKeperluan("");
    setCatatan("");
    setPenerimaId("");
    setPenerimaNama("");
    setCariPenerima("");
  };

  const simpan = async (event: FormEvent) => {
    event.preventDefault();
    if (isSubmittingRef.current || !barang) return;
    isSubmittingRef.current = true;
    setMenyimpan(true);
    try {
      const aset = barang.tipe === "Aset";
      const jumlahCatat = pakaiUnit
        ? unitDipilih.length
        : bacaJumlah(jumlah, barang.desimal);
      await catatMutasiInventaris({
        id_barang: barang.id_barang,
        jenis,
        alasan,
        tanggal,
        jumlah: jumlahCatat,
        tempat_asal:
          jenis === "Masuk"
            ? null
            : pakaiUnit
              ? (grupAsal?.tempat ?? null)
              : (asal?.tempat ?? null),
        kondisi_asal:
          jenis === "Masuk"
            ? null
            : pakaiUnit
              ? (grupAsal?.kondisi ?? null)
              : (asal?.kondisi ?? null),
        id_batch:
          jenis === "Masuk" || pakaiUnit ? null : (asal?.id_batch ?? null),
        unit: pakaiUnit ? unitDipilih : [],
        per_unit: bolehPerUnit && perUnit,
        tempat_tujuan: jenis === "Keluar" ? null : tempatTujuan,
        kondisi_tujuan:
          jenis === "Keluar" ? null : aset ? kondisiTujuan : "Baik",
        tanggal_expired:
          jenis === "Masuk" && barang.bisa_expired ? tanggalExpired : null,
        sumber_dana: jenis === "Masuk" ? sumberDana : null,
        nomor_dokumen: nomorDokumen,
        harga_satuan: jenis === "Masuk" && harga !== "" ? Number(harga) : null,
        penerima_tipe: butuhPenerima ? penerimaTipe : null,
        penerima_id: butuhPenerima ? penerimaId : null,
        penerima_nama: butuhPenerima ? penerimaNama : null,
        keperluan,
        catatan,
      });
      reset();
      await onSelesai(
        `${jenis} ${angka(jumlahCatat, barang.desimal)} ${barang.satuan} ${barang.nama_barang} tercatat.`,
      );
    } catch (error) {
      onGalat(pesanGalat(error, "Mutasi tidak bisa disimpan."));
    } finally {
      isSubmittingRef.current = false;
      setMenyimpan(false);
    }
  };

  if (data.barang.length === 0) {
    return (
      <p className="p-8 text-center text-sm text-slate-400 rounded-xl border border-dashed border-slate-800">
        Belum ada barang. Daftarkan barang di bagian Barang sebelum mencatat
        mutasi.
      </p>
    );
  }

  return (
    <form
      onSubmit={simpan}
      className="p-4 rounded-xl border border-slate-800 bg-slate-900/60 space-y-4"
    >
      <fieldset>
        <legend className={LABEL}>Jenis mutasi</legend>
        <div className="flex gap-1 p-1 rounded-lg border border-slate-700 bg-slate-950/40">
          {jenisTersedia.map((nilai) => (
            <label
              key={nilai}
              className={`min-h-11 flex-1 flex items-center justify-center rounded-md text-sm font-medium cursor-pointer focus-within:ring-2 focus-within:ring-sky-500 ${
                jenis === nilai
                  ? "bg-sky-700 text-white"
                  : "text-slate-300 hover:bg-slate-800"
              }`}
            >
              <input
                type="radio"
                name="inv-jenis"
                value={nilai}
                checked={jenis === nilai}
                onChange={() => pilihJenis(nilai)}
                className="sr-only"
              />
              {nilai}
            </label>
          ))}
        </div>
      </fieldset>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="sm:col-span-2">
          <label htmlFor="inv-mutasi-barang" className={LABEL}>
            Barang
          </label>
          <select
            id="inv-mutasi-barang"
            required
            value={idBarang}
            onChange={(e) => pilihBarang(e.target.value)}
            className={INPUT}
          >
            <option value="">Pilih barang</option>
            {pilihanBarang.map((item) => (
              <option key={item.id_barang} value={item.id_barang}>
                {item.nama_barang} ({item.kode_barang})
              </option>
            ))}
          </select>
          {jenis !== "Masuk" && pilihanBarang.length === 0 ? (
            <p className="mt-1 text-xs text-amber-300">
              Belum ada barang yang punya stok. Catat barang Masuk lebih dulu.
            </p>
          ) : null}
        </div>

        <div>
          <label htmlFor="inv-alasan" className={LABEL}>
            Alasan
          </label>
          <select
            id="inv-alasan"
            required
            value={alasan}
            onChange={(e) => setAlasan(e.target.value)}
            className={INPUT}
          >
            {pilihanAlasan.map((nilai) => (
              <option key={nilai} value={nilai}>
                {nilai}
              </option>
            ))}
          </select>
        </div>
        {pakaiUnit ? (
          <div>
            <p className={LABEL}>Jumlah</p>
            <p className="min-h-11 flex items-center text-sm text-slate-200">
              {unitDipilih.length} unit dipilih
            </p>
          </div>
        ) : (
          <div>
            <label htmlFor="inv-jumlah" className={LABEL}>
              Jumlah{barang ? ` (${barang.satuan})` : ""}
            </label>
            <input
              id="inv-jumlah"
              {...isianJumlah(barang?.desimal ?? false)}
              required
              value={jumlah}
              onChange={(e) => setJumlah(e.target.value)}
              className={INPUT}
            />
            {jenis === "Masuk" && dilacak ? (
              <p className="mt-1 text-xs text-slate-400">
                Setiap {barang?.satuan} menjadi unit baru bernomor, paling
                banyak 200 sekali catat.
              </p>
            ) : null}
          </div>
        )}
        <div>
          <label htmlFor="inv-tanggal" className={LABEL}>
            Tanggal
          </label>
          <input
            id="inv-tanggal"
            type="date"
            required
            max={hariIni}
            value={tanggal}
            onChange={(e) => setTanggal(e.target.value)}
            className={INPUT}
          />
        </div>

        {bolehPerUnit ? (
          <div className="sm:col-span-2 flex items-start gap-2">
            <input
              id="inv-per-unit"
              type="checkbox"
              checked={perUnit}
              onChange={(e) => setPerUnit(e.target.checked)}
              className="mt-1 h-4 w-4"
              aria-describedby="inv-per-unit-bantuan"
            />
            <div>
              <label
                htmlFor="inv-per-unit"
                className="text-sm font-medium text-slate-200"
              >
                Catat per unit
              </label>
              <p id="inv-per-unit-bantuan" className="text-xs text-slate-400">
                Setiap {barang?.satuan} mendapat kode unit sendiri, bisa diberi
                nomor seri, dan dicetak labelnya satu per satu. Cocok untuk
                laptop atau proyektor; kursi cukup dicatat per jumlah.
              </p>
            </div>
          </div>
        ) : null}

        {pakaiUnit && barang ? (
          <div className="sm:col-span-2 space-y-2">
            <label htmlFor="inv-asal-unit" className={LABEL}>
              Ambil dari
            </label>
            {kelompokUnit.length === 0 ? (
              <p className="text-sm text-amber-300">
                Belum ada unit bernomor yang tersedia.
                {stokBelumBernomor(barang).length > 0
                  ? " Daftarkan stok tanpa nomor di bagian Barang lebih dulu."
                  : ""}
              </p>
            ) : (
              <>
                <select
                  id="inv-asal-unit"
                  value={kelompokAsal}
                  onChange={(e) => {
                    setKelompokAsal(e.target.value);
                    setUnitDipilih([]);
                  }}
                  className={INPUT}
                >
                  {kelompokUnit.map((grup, index) => (
                    <option
                      key={`${grup.tempat}|${grup.kondisi}`}
                      value={String(index)}
                    >
                      {grup.tempat} · {grup.kondisi} ({grup.unit.length} unit)
                    </option>
                  ))}
                </select>
                <fieldset className="max-h-60 overflow-y-auto rounded-lg border border-slate-800 divide-y divide-slate-800">
                  <legend className="sr-only">Unit yang dicatat</legend>
                  {(grupAsal?.unit ?? []).map((unit) => {
                    const id = unit.id_batch as string;
                    return (
                      <label
                        key={id}
                        className="flex min-h-11 items-center gap-2 px-3 py-2 text-sm text-slate-200"
                      >
                        <input
                          type="checkbox"
                          checked={unitDipilih.includes(id)}
                          onChange={(e) =>
                            setUnitDipilih(
                              e.target.checked
                                ? [...unitDipilih, id]
                                : unitDipilih.filter((item) => item !== id),
                            )
                          }
                          className="h-4 w-4"
                        />
                        {unit.kode_unit}
                        {unit.nomor_seri ? (
                          <span className="text-slate-400">
                            SN {unit.nomor_seri}
                          </span>
                        ) : null}
                        {servisPerUnit(data).has(id) ? (
                          <span className="text-amber-300">
                            {keteranganServis(
                              servisPerUnit(data).get(id) as ServisInventaris,
                            )}
                          </span>
                        ) : null}
                      </label>
                    );
                  })}
                </fieldset>
              </>
            )}
          </div>
        ) : null}

        {jenis !== "Masuk" && barang && !pakaiUnit ? (
          <div className="sm:col-span-2">
            <label htmlFor="inv-asal" className={LABEL}>
              Ambil dari
            </label>
            {posisiTersedia.length === 0 ? (
              <p className="text-sm text-amber-300">
                Stok barang ini kosong di semua tempat.
              </p>
            ) : (
              <select
                id="inv-asal"
                required
                value={posisiAsal}
                onChange={(e) => setPosisiAsal(e.target.value)}
                className={INPUT}
              >
                {posisiTersedia.map((posisi, index) => (
                  <option
                    key={`${posisi.tempat}|${posisi.kondisi}|${posisi.id_batch ?? ""}`}
                    value={String(index)}
                  >
                    {labelPosisi(posisi, barang.satuan, barang.desimal)}
                  </option>
                ))}
              </select>
            )}
          </div>
        ) : null}

        {jenis !== "Keluar" ? (
          <>
            <div>
              <label htmlFor="inv-tujuan" className={LABEL}>
                {jenis === "Masuk" ? "Disimpan di" : "Pindah ke"}
              </label>
              <input
                id="inv-tujuan"
                required
                list="inv-tempat-saran-mutasi"
                value={tempatTujuan}
                onChange={(e) => setTempatTujuan(e.target.value)}
                className={INPUT}
              />
              <datalist id="inv-tempat-saran-mutasi">
                {data.tempat.map((nilai) => (
                  <option key={nilai} value={nilai} />
                ))}
              </datalist>
            </div>
            {barang?.tipe === "Aset" ? (
              <div>
                <label htmlFor="inv-kondisi" className={LABEL}>
                  Kondisi
                </label>
                <select
                  id="inv-kondisi"
                  value={kondisiTujuan}
                  onChange={(e) => setKondisiTujuan(e.target.value)}
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
          </>
        ) : null}

        {jenis === "Masuk" ? (
          <>
            {barang?.bisa_expired ? (
              <div>
                <label htmlFor="inv-expired" className={LABEL}>
                  Tanggal kedaluwarsa
                </label>
                <input
                  id="inv-expired"
                  type="date"
                  required
                  value={tanggalExpired}
                  onChange={(e) => setTanggalExpired(e.target.value)}
                  className={INPUT}
                />
              </div>
            ) : null}
            <div>
              <label htmlFor="inv-sumber-dana" className={LABEL}>
                Sumber dana
              </label>
              <input
                id="inv-sumber-dana"
                list="inv-sumber-dana-saran"
                value={sumberDana}
                onChange={(e) => setSumberDana(e.target.value)}
                className={INPUT}
              />
              <datalist id="inv-sumber-dana-saran">
                {SUMBER_DANA_UMUM.map((nilai) => (
                  <option key={nilai} value={nilai} />
                ))}
              </datalist>
            </div>
            <div>
              <label htmlFor="inv-harga" className={LABEL}>
                Harga satuan (Rp{barang?.desimal ? ` per ${barang.satuan}` : ""}
                )
              </label>
              <input
                id="inv-harga"
                type="number"
                min={0}
                step={1}
                inputMode="numeric"
                value={harga}
                onChange={(e) => setHarga(e.target.value)}
                className={INPUT}
              />
            </div>
          </>
        ) : null}

        {butuhPenerima ? (
          <>
            <div>
              <label htmlFor="inv-penerima-tipe" className={LABEL}>
                Diberikan kepada
              </label>
              <select
                id="inv-penerima-tipe"
                required
                value={penerimaTipe}
                onChange={(e) => {
                  setPenerimaTipe(e.target.value);
                  setPenerimaId("");
                  setPenerimaNama("");
                }}
                className={INPUT}
              >
                <option value="">Pilih tipe penerima</option>
                {PENERIMA_TIPE.map((nilai) => (
                  <option key={nilai} value={nilai}>
                    {nilai}
                  </option>
                ))}
              </select>
            </div>
            {penerimaTipe === "Personil" ? (
              <div className="sm:col-span-2 grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label htmlFor="inv-cari-penerima" className={LABEL}>
                    Cari nama personil
                  </label>
                  <input
                    id="inv-cari-penerima"
                    type="search"
                    value={cariPenerima}
                    onChange={(e) => setCariPenerima(e.target.value)}
                    className={INPUT}
                  />
                </div>
                <div>
                  <label htmlFor="inv-penerima-personil" className={LABEL}>
                    Personil
                  </label>
                  <select
                    id="inv-penerima-personil"
                    required
                    value={penerimaId}
                    onChange={(e) => setPenerimaId(e.target.value)}
                    className={INPUT}
                  >
                    <option value="">
                      {penerima
                        ? "Pilih personil"
                        : "Memuat daftar personil..."}
                    </option>
                    {personilTersaring.map((orang) => (
                      <option key={orang.id} value={orang.id}>
                        {orang.nama}
                        {orang.divisi
                          ? ` · ${orang.divisi}`
                          : orang.jenis
                            ? ` · ${orang.jenis}`
                            : ""}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            ) : null}
            {penerimaTipe === "Divisi" ? (
              <div>
                <label htmlFor="inv-penerima-divisi" className={LABEL}>
                  Divisi
                </label>
                <select
                  id="inv-penerima-divisi"
                  required
                  value={penerimaNama}
                  onChange={(e) => setPenerimaNama(e.target.value)}
                  className={INPUT}
                >
                  <option value="">
                    {penerima ? "Pilih divisi" : "Memuat daftar divisi..."}
                  </option>
                  {(penerima?.divisi ?? []).map((nama) => (
                    <option key={nama} value={nama}>
                      {nama}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}
            {penerimaTipe === "Unit" ? (
              <div>
                <label htmlFor="inv-penerima-unit" className={LABEL}>
                  Nama unit
                </label>
                <input
                  id="inv-penerima-unit"
                  required
                  list="inv-tempat-saran-mutasi"
                  value={penerimaNama}
                  onChange={(e) => setPenerimaNama(e.target.value)}
                  className={INPUT}
                />
              </div>
            ) : null}
            {penerimaGagal ? (
              <p role="alert" className="sm:col-span-2 text-sm text-rose-200">
                {penerimaGagal}
              </p>
            ) : null}
          </>
        ) : null}

        <div className="sm:col-span-2">
          <label htmlFor="inv-keperluan" className={LABEL}>
            Keperluan{butuhPenerima ? "" : " (opsional)"}
          </label>
          <input
            id="inv-keperluan"
            required={butuhPenerima}
            maxLength={200}
            value={keperluan}
            onChange={(e) => setKeperluan(e.target.value)}
            className={INPUT}
            aria-describedby="inv-keperluan-bantuan"
          />
          <p id="inv-keperluan-bantuan" className="mt-1 text-xs text-slate-400">
            Contoh: rapat bulanan, kunjungan klien, pertolongan pertama. Jangan
            tulis keluhan atau diagnosis: catatan ini tersalin ke semua
            perangkat.
          </p>
        </div>
        <div>
          <label htmlFor="inv-nomor-dokumen" className={LABEL}>
            Nomor nota atau dokumen (opsional)
          </label>
          <input
            id="inv-nomor-dokumen"
            value={nomorDokumen}
            onChange={(e) => setNomorDokumen(e.target.value)}
            className={INPUT}
          />
        </div>
        <div>
          <label htmlFor="inv-catatan-mutasi" className={LABEL}>
            Catatan (opsional)
          </label>
          <input
            id="inv-catatan-mutasi"
            value={catatan}
            onChange={(e) => setCatatan(e.target.value)}
            className={INPUT}
          />
        </div>
      </div>

      <div className="flex justify-end">
        <button
          type="submit"
          disabled={
            menyimpan || !barang || (pakaiUnit && unitDipilih.length === 0)
          }
          className={TOMBOL_UTAMA}
        >
          {menyimpan ? "Menyimpan..." : `Simpan barang ${jenis.toLowerCase()}`}
        </button>
      </div>
    </form>
  );
}

// ── Kartu stok ──────────────────────────────────────────────────────────────

function keterangan(baris: BarisKartuStok): string {
  const arah =
    baris.jenis === "Pindah"
      ? `${baris.tempat_asal} (${baris.kondisi_asal}) ke ${baris.tempat_tujuan} (${baris.kondisi_tujuan})`
      : baris.jenis === "Masuk"
        ? `ke ${baris.tempat_tujuan}`
        : `dari ${baris.tempat_asal}`;
  const bagian = [`${baris.jenis} · ${baris.alasan}`, arah];
  if (baris.penerima_nama) bagian.push(`untuk ${baris.penerima_nama}`);
  if (baris.keperluan) bagian.push(baris.keperluan);
  if (baris.alasan === "Pembatalan" && baris.catatan)
    bagian.push(`alasan: ${baris.catatan}`);
  return bagian.join(" · ");
}

function PanelKartuStok({
  data,
  idBarangAwal,
  canAdjust,
  isSubmittingRef,
  onBatal,
  onInfo,
  onGalat,
}: {
  data: DaftarInventaris;
  idBarangAwal: string;
  canAdjust: boolean;
  isSubmittingRef: { current: boolean };
  onBatal: (message: string) => Promise<void>;
  onInfo: (message: string) => void;
  onGalat: (message: string) => void;
}) {
  const hariIni = hariIniWib();
  const bisaCetak = bisaCetakBeritaAcara();
  const [idBarang, setIdBarang] = useState(idBarangAwal);
  const [tempat, setTempat] = useState("");
  const [dari, setDari] = useState(awalBulan(hariIni));
  const [sampai, setSampai] = useState(hariIni);
  const [kartu, setKartu] = useState<KartuStok | null>(null);
  const [memuat, setMemuat] = useState(false);
  const [galat, setGalat] = useState<string | null>(null);
  const [target, setTarget] = useState<BarisKartuStok | null>(null);
  const [alasanBatal, setAlasanBatal] = useState("");
  const [membatalkan, setMembatalkan] = useState(false);

  const barang =
    data.barang.find((item) => item.id_barang === idBarang) ?? null;

  const muatKartu = useCallback(async () => {
    if (!idBarang) {
      setKartu(null);
      return;
    }
    setMemuat(true);
    setGalat(null);
    try {
      setKartu(await getKartuStok(idBarang, tempat || null, dari, sampai));
    } catch (error) {
      setKartu(null);
      setGalat(pesanGalat(error, "Kartu stok tidak bisa dimuat."));
    } finally {
      setMemuat(false);
    }
  }, [idBarang, tempat, dari, sampai]);

  useEffect(() => {
    void muatKartu();
  }, [muatKartu]);

  const batalkan = async (event: FormEvent) => {
    event.preventDefault();
    if (isSubmittingRef.current || !target) return;
    isSubmittingRef.current = true;
    setMembatalkan(true);
    try {
      await batalkanMutasiInventaris(target.id_mutasi, alasanBatal);
      setTarget(null);
      setAlasanBatal("");
      await onBatal(
        "Mutasi dibatalkan. Stok dikembalikan lewat baris Pembatalan.",
      );
      await muatKartu();
    } catch (error) {
      onGalat(pesanGalat(error, "Mutasi tidak bisa dibatalkan."));
    } finally {
      isSubmittingRef.current = false;
      setMembatalkan(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="p-3 rounded-xl border border-slate-800 bg-slate-900/60 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <div>
          <label htmlFor="inv-kartu-barang" className={LABEL}>
            Barang
          </label>
          <select
            id="inv-kartu-barang"
            value={idBarang}
            onChange={(e) => setIdBarang(e.target.value)}
            className={INPUT}
          >
            <option value="">Pilih barang</option>
            {data.barang.map((item) => (
              <option key={item.id_barang} value={item.id_barang}>
                {item.nama_barang} ({item.kode_barang})
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="inv-kartu-tempat" className={LABEL}>
            Tempat
          </label>
          <select
            id="inv-kartu-tempat"
            value={tempat}
            onChange={(e) => setTempat(e.target.value)}
            className={INPUT}
          >
            <option value="">Semua tempat</option>
            {data.tempat.map((nama) => (
              <option key={nama} value={nama}>
                {nama}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="inv-kartu-dari" className={LABEL}>
            Dari tanggal
          </label>
          <input
            id="inv-kartu-dari"
            type="date"
            value={dari}
            max={sampai}
            onChange={(e) => setDari(e.target.value)}
            className={INPUT}
          />
        </div>
        <div>
          <label htmlFor="inv-kartu-sampai" className={LABEL}>
            Sampai tanggal
          </label>
          <input
            id="inv-kartu-sampai"
            type="date"
            value={sampai}
            min={dari}
            onChange={(e) => setSampai(e.target.value)}
            className={INPUT}
          />
        </div>
      </div>

      {!idBarang ? (
        <p className="p-8 text-center text-sm text-slate-400 rounded-xl border border-dashed border-slate-800">
          Pilih barang untuk melihat riwayat masuk, keluar, dan saldonya.
        </p>
      ) : memuat ? (
        <p className="p-8 text-center text-sm text-slate-400">
          Memuat kartu stok...
        </p>
      ) : galat ? (
        <div className="p-4 rounded-xl border border-rose-500/30 bg-rose-500/20 text-sm text-rose-100 space-y-3">
          <p>{galat}</p>
          <button
            type="button"
            onClick={() => void muatKartu()}
            className={TOMBOL_KEDUA}
          >
            Coba muat lagi
          </button>
        </div>
      ) : kartu && barang ? (
        <div className="rounded-xl border border-slate-800 bg-slate-900/60">
          <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 border-b border-slate-800 text-sm">
            <span className="text-slate-300">Saldo sebelum {dari}</span>
            <span className="flex flex-wrap items-center gap-3">
              <span className="font-semibold text-slate-100">
                {angka(kartu.saldo_awal, barang.desimal)} {barang.satuan}
              </span>
              <button
                type="button"
                onClick={async () => {
                  try {
                    const hasil = await eksporKartuStok(
                      barang,
                      kartu,
                      dari,
                      sampai,
                    );
                    if (hasil.sukses)
                      onInfo("Kartu stok tersimpan sebagai berkas Excel.");
                  } catch (error) {
                    onGalat(
                      pesanGalat(error, "Berkas Excel tidak bisa disimpan."),
                    );
                  }
                }}
                className={TOMBOL_KEDUA}
              >
                Ekspor Excel
              </button>
            </span>
          </div>
          {kartu.baris.length === 0 ? (
            <p className="px-4 py-6 text-center text-sm text-slate-400">
              Tidak ada mutasi pada rentang tanggal ini.
            </p>
          ) : (
            <ul className="divide-y divide-slate-800">
              {kartu.baris.map((baris) => (
                <li
                  key={baris.id_mutasi}
                  className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-start sm:justify-between"
                >
                  <div className="min-w-0 space-y-1">
                    <p className="text-xs text-slate-400">
                      {baris.tanggal} · dicatat {baris.dicatat_oleh}
                      {baris.dibatalkan ? (
                        <span className="ml-2 font-semibold text-amber-300">
                          Sudah dibatalkan
                        </span>
                      ) : null}
                    </p>
                    <p className="text-sm text-slate-200 break-words">
                      {keterangan(baris)}
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-wrap items-center gap-3 sm:justify-end text-sm">
                    {baris.masuk > 0 ? (
                      <span className="text-emerald-300">
                        +{angka(baris.masuk, barang.desimal)}
                      </span>
                    ) : null}
                    {baris.keluar > 0 ? (
                      <span className="text-rose-300">
                        -{angka(baris.keluar, barang.desimal)}
                      </span>
                    ) : null}
                    <span className="min-w-16 text-right font-semibold text-slate-100">
                      {angka(baris.saldo, barang.desimal)} {barang.satuan}
                    </span>
                    {bisaCetak &&
                    !baris.dibatalkan &&
                    jenisBeritaAcara(baris.alasan) ? (
                      <button
                        type="button"
                        onClick={() =>
                          void cetakBeritaAcaraMutasi(baris.id_mutasi, onGalat)
                        }
                        className={TOMBOL_KEDUA}
                      >
                        Berita acara
                      </button>
                    ) : null}
                    {canAdjust &&
                    !baris.dibatalkan &&
                    baris.alasan !== "Pembatalan" ? (
                      <button
                        type="button"
                        onClick={() => setTarget(baris)}
                        className={TOMBOL_KEDUA}
                      >
                        Batalkan
                      </button>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
          {kartu.terpotong ? (
            <p className="px-4 py-3 border-t border-slate-800 text-xs text-amber-300">
              Hanya 1.000 mutasi pertama yang ditampilkan. Persempit rentang
              tanggal untuk melihat sisanya.
            </p>
          ) : null}
        </div>
      ) : null}

      {target ? (
        <Modal
          isOpen={true}
          onClose={() => setTarget(null)}
          title="Batalkan mutasi"
          titleId="inv-batal-judul"
        >
          <form onSubmit={batalkan} className="space-y-4">
            <p className="text-sm text-slate-300">
              {keterangan(target)}. Mutasi ini tidak dihapus: aplikasi mencatat
              baris Pembatalan yang membalik jumlahnya, jadi jejaknya tetap
              terlihat.
            </p>
            <div>
              <label htmlFor="inv-alasan-batal" className={LABEL}>
                Alasan pembatalan
              </label>
              <textarea
                id="inv-alasan-batal"
                required
                rows={2}
                maxLength={500}
                value={alasanBatal}
                onChange={(e) => setAlasanBatal(e.target.value)}
                className={INPUT}
              />
            </div>
            <div className="flex flex-wrap justify-end gap-2">
              <button
                type="button"
                onClick={() => setTarget(null)}
                className={TOMBOL_KEDUA}
              >
                Kembali
              </button>
              <button
                type="submit"
                disabled={membatalkan}
                className={TOMBOL_BAHAYA}
              >
                {membatalkan ? "Membatalkan..." : "Batalkan mutasi"}
              </button>
            </div>
          </form>
        </Modal>
      ) : null}
    </div>
  );
}
