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
  hariIniWib,
  INPUT,
  LABEL,
  pesanGalat,
  TOMBOL_BAHAYA,
  TOMBOL_KEDUA,
  TOMBOL_UTAMA,
} from "@/components/inventory/gaya";
import { jumlahMenunggu } from "@/components/inventory/Pengajuan";
import { CicilanWorkspace } from "@/components/keuangan/CicilanWorkspace";
import {
  eksporBukuBesar,
  eksporNeracaSaldo,
} from "@/components/keuangan/eksporKeuangan";
import { JurnalInventaris } from "@/components/keuangan/JurnalInventaris";
import {
  BarisEkspor,
  LaporanKeuangan,
} from "@/components/keuangan/LaporanKeuangan";
import { TutupBukuPanel } from "@/components/keuangan/TutupBukuPanel";
import { Modal } from "@/components/ui/Modal";
import { hasPermission } from "@/lib/auth/access";
import { useAuth } from "@/lib/context/AuthContext";
import {
  type AkunItem,
  type BukuBesar,
  batalkanJurnal,
  catatJurnal,
  daftarAkun,
  daftarJurnal,
  getBukuBesar,
  getJurnal,
  getNeracaSaldo,
  getStatusTutupBuku,
  type JurnalDetail,
  type JurnalItem,
  type NeracaSaldo,
  simpanAkun,
} from "@/lib/gateways/accounting";
import { getCicilan } from "@/lib/gateways/cicilan";
import { getJurnalInventaris } from "@/lib/gateways/inventory";
import { getPengajuan } from "@/lib/gateways/inventory-pengajuan";
import { subscribeSyncCompleted } from "@/lib/gateways/sync-status";
import {
  BATAS_DAFTAR_JURNAL,
  formatRupiah,
  KELOMPOK_AKUN,
  type KelompokAkun,
  SALDO_NORMAL,
  type SaldoNormal,
  SUMBER_JURNAL,
  saldoNormalBawaan,
} from "@/lib/validations/accounting";
import { jumlahPerhatianCicilan } from "@/lib/validations/cicilan";

/**
 * Seluruh UI pembukuan, dipakai apa adanya oleh halaman Web/Desktop dan
 * Mobile (disalin lewat `filesToCopy`). Hanya bergantung pada kontrak `Modal`
 * yang sama di kedua workspace; pesan sukses/galat ditulis di sini karena
 * `FeedbackBanner` kedua workspace punya props yang berbeda.
 */

type Tab =
  | "jurnal"
  | "inventaris"
  | "cicilan"
  | "buku"
  | "neraca"
  | "laporan"
  | "tutup"
  | "akun";
type Feedback = { tone: "success" | "error"; message: string } | null;

const LABEL_TAB: Record<Tab, string> = {
  jurnal: "Jurnal",
  inventaris: "Dari Inventaris",
  cicilan: "Cicilan",
  buku: "Buku Besar",
  neraca: "Neraca Saldo",
  laporan: "Laporan",
  tutup: "Tutup Buku",
  akun: "Bagan Akun",
};

function awalBulan(hari: string): string {
  return `${hari.slice(0, 8)}01`;
}

/** Isian nominal menerima titik pemisah ribuan; hanya digit yang dibaca. */
function bacaNominal(teks: string): number {
  const digit = teks.replace(/\D/g, "");
  return digit ? Number(digit) : 0;
}

function Rp({ nilai }: { nilai: number }) {
  return <span className="tabular-nums">{formatRupiah(nilai)}</span>;
}

export function KeuanganWorkspace() {
  const { user } = useAuth();
  const bolehKelola = hasPermission(user, "accounting.manage");
  const bolehBatal = hasPermission(user, "accounting.reverse");
  const bolehTutup = hasPermission(user, "accounting.close");
  const bolehBatalCicilan = hasPermission(user, "installment.cancel");

  const [tab, setTab] = useState<Tab>("jurnal");
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [akun, setAkun] = useState<AkunItem[]>([]);
  const [akunGalat, setAkunGalat] = useState<string | null>(null);
  const [akunMemuat, setAkunMemuat] = useState(true);

  const muatAkun = useCallback(async () => {
    setAkunMemuat(true);
    try {
      setAkun((await daftarAkun()).items);
      setAkunGalat(null);
    } catch (error) {
      setAkunGalat(pesanGalat(error, "Bagan akun tidak bisa dimuat."));
    } finally {
      setAkunMemuat(false);
    }
  }, []);

  useEffect(() => {
    void muatAkun();
  }, [muatAkun]);
  useEffect(() => subscribeSyncCompleted(() => void muatAkun()), [muatAkun]);

  // Tanda angka di tab Tutup Buku: versi yang menunggu keputusan ditambah
  // tutup buku yang saldonya berubah.
  const [perhatian, setPerhatian] = useState(0);
  const muatPerhatian = useCallback(async () => {
    try {
      setPerhatian((await getStatusTutupBuku()).perlu_perhatian);
    } catch {
      // Hanya tanda angka; tab Tutup Buku sendiri menampilkan kegagalannya
      // beserta tombol muat ulang saat dibuka.
      setPerhatian(0);
    }
  }, []);
  useEffect(() => {
    void muatPerhatian();
  }, [muatPerhatian]);
  useEffect(
    () => subscribeSyncCompleted(() => void muatPerhatian()),
    [muatPerhatian],
  );

  // Tanda angka di tab Dari Inventaris: semua yang belum dijurnal sepanjang
  // masa, jurnal yang perlu dibalik, dan pengajuan pembelian yang menunggu.
  const [belumDijurnal, setBelumDijurnal] = useState(0);
  const muatBelumDijurnal = useCallback(async () => {
    try {
      const hari = hariIniWib();
      const menunggu = await getPengajuan(hari, hari).then(
        jumlahMenunggu,
        () => 0,
      );
      const hasil = await getJurnalInventaris("2000-01-01", hari);
      setBelumDijurnal(
        hasil.baris.length +
          hasil.perlu_dibalik.length +
          hasil.servis.length +
          menunggu,
      );
    } catch {
      // Hanya tanda angka; tabnya sendiri menampilkan kegagalannya.
      setBelumDijurnal(0);
    }
  }, []);
  useEffect(() => {
    void muatBelumDijurnal();
  }, [muatBelumDijurnal]);
  useEffect(
    () => subscribeSyncCompleted(() => void muatBelumDijurnal()),
    [muatBelumDijurnal],
  );

  // Tanda angka di tab Cicilan: kontrak Menunggak, Menunggu ACC ulang, lebih
  // bayar, dan angsuran yang jatuh tempo dalam 7 hari.
  const [perhatianCicilan, setPerhatianCicilan] = useState(0);
  const muatPerhatianCicilan = useCallback(async () => {
    try {
      setPerhatianCicilan(jumlahPerhatianCicilan(await getCicilan()));
    } catch {
      // Hanya tanda angka; tabnya sendiri menampilkan kegagalannya.
      setPerhatianCicilan(0);
    }
  }, []);
  useEffect(() => {
    void muatPerhatianCicilan();
  }, [muatPerhatianCicilan]);
  useEffect(
    () => subscribeSyncCompleted(() => void muatPerhatianCicilan()),
    [muatPerhatianCicilan],
  );

  const info = (message: string) => setFeedback({ tone: "success", message });

  return (
    <div className="space-y-4">
      <div
        role="tablist"
        aria-label="Bagian pembukuan"
        className="flex gap-1 p-1 rounded-xl border border-slate-800 bg-slate-900/60 overflow-x-auto"
      >
        {(Object.keys(LABEL_TAB) as Tab[]).map((id) => (
          <button
            key={id}
            type="button"
            role="tab"
            id={`tab-keuangan-${id}`}
            aria-selected={tab === id}
            aria-controls={`panel-keuangan-${id}`}
            onClick={() => setTab(id)}
            className={`min-h-11 flex-1 whitespace-nowrap px-4 py-2 text-sm font-medium rounded-lg transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 ${
              tab === id
                ? "bg-sky-700 text-white"
                : "text-slate-300 hover:bg-slate-800"
            }`}
          >
            {LABEL_TAB[id]}
            {id === "tutup" && perhatian > 0 ? (
              <span className="ml-2 rounded-full bg-amber-500 px-1.5 text-xs font-semibold text-slate-950">
                {perhatian}
                <span className="sr-only"> perlu ditinjau</span>
              </span>
            ) : null}
            {id === "cicilan" && perhatianCicilan > 0 ? (
              <span className="ml-2 rounded-full bg-amber-500 px-1.5 text-xs font-semibold text-slate-950">
                {perhatianCicilan}
                <span className="sr-only"> perlu perhatian</span>
              </span>
            ) : null}
            {id === "inventaris" && belumDijurnal > 0 ? (
              <span className="ml-2 rounded-full bg-amber-500 px-1.5 text-xs font-semibold text-slate-950">
                {belumDijurnal}
                <span className="sr-only"> belum dijurnal</span>
              </span>
            ) : null}
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
        id={`panel-keuangan-${tab}`}
        aria-labelledby={`tab-keuangan-${tab}`}
      >
        {akunMemuat ? (
          <p className="p-10 text-center text-sm text-slate-400">
            Memuat bagan akun...
          </p>
        ) : akunGalat ? (
          <div className="p-6 rounded-xl border border-rose-500/30 bg-rose-500/20 text-sm text-rose-100 space-y-3">
            <p>{akunGalat}</p>
            <button
              type="button"
              onClick={() => void muatAkun()}
              className={TOMBOL_KEDUA}
            >
              Coba muat lagi
            </button>
          </div>
        ) : tab === "jurnal" ? (
          <PanelJurnal
            akun={akun}
            bolehKelola={bolehKelola}
            bolehBatal={bolehBatal}
            onInfo={info}
          />
        ) : tab === "inventaris" ? (
          <JurnalInventaris
            akun={akun}
            bolehKelola={bolehKelola}
            onInfo={info}
            onBerubah={() => {
              void muatBelumDijurnal();
              void muatPerhatianCicilan();
            }}
          />
        ) : tab === "cicilan" ? (
          <CicilanWorkspace
            akun={akun}
            bolehKelola={bolehKelola}
            bolehBatal={bolehBatalCicilan}
            onInfo={info}
            onBerubah={() => void muatPerhatianCicilan()}
          />
        ) : tab === "buku" ? (
          <PanelBukuBesar akun={akun} />
        ) : tab === "neraca" ? (
          <PanelNeracaSaldo />
        ) : tab === "laporan" ? (
          <LaporanKeuangan akun={akun} />
        ) : tab === "tutup" ? (
          <TutupBukuPanel
            bolehTutup={bolehTutup}
            onInfo={info}
            onBerubah={() => void muatPerhatian()}
          />
        ) : (
          <PanelAkun
            akun={akun}
            bolehKelola={bolehKelola}
            onTersimpan={async (pesan) => {
              info(pesan);
              await muatAkun();
            }}
          />
        )}
      </div>
    </div>
  );
}

// ── Jurnal ──────────────────────────────────────────────────────────────────

function PanelJurnal({
  akun,
  bolehKelola,
  bolehBatal,
  onInfo,
}: {
  akun: AkunItem[];
  bolehKelola: boolean;
  bolehBatal: boolean;
  onInfo: (pesan: string) => void;
}) {
  const hariIni = hariIniWib();
  const [dari, setDari] = useState(awalBulan(hariIni));
  const [sampai, setSampai] = useState(hariIni);
  const [sumber, setSumber] = useState("");
  const [items, setItems] = useState<JurnalItem[] | null>(null);
  const [galatMuat, setGalatMuat] = useState<string | null>(null);
  const [formBuka, setFormBuka] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);

  const muat = useCallback(async () => {
    setGalatMuat(null);
    try {
      setItems((await daftarJurnal(dari, sampai, sumber || null)).items);
    } catch (error) {
      setItems(null);
      setGalatMuat(pesanGalat(error, "Daftar jurnal tidak bisa dimuat."));
    }
  }, [dari, sampai, sumber]);

  useEffect(() => {
    void muat();
  }, [muat]);
  useEffect(() => subscribeSyncCompleted(() => void muat()), [muat]);

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-[1fr_1fr_1fr_auto] sm:items-end">
        <div>
          <label className={LABEL} htmlFor="jurnal-dari">
            Dari tanggal
          </label>
          <input
            id="jurnal-dari"
            type="date"
            className={INPUT}
            value={dari}
            max={sampai}
            onChange={(e) => setDari(e.target.value)}
          />
        </div>
        <div>
          <label className={LABEL} htmlFor="jurnal-sampai">
            Sampai tanggal
          </label>
          <input
            id="jurnal-sampai"
            type="date"
            className={INPUT}
            value={sampai}
            min={dari}
            onChange={(e) => setSampai(e.target.value)}
          />
        </div>
        <div>
          <label className={LABEL} htmlFor="jurnal-sumber">
            Sumber jurnal
          </label>
          <select
            id="jurnal-sumber"
            className={INPUT}
            value={sumber}
            onChange={(e) => setSumber(e.target.value)}
          >
            <option value="">Semua sumber</option>
            {SUMBER_JURNAL.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        </div>
        {bolehKelola ? (
          <button
            type="button"
            className={TOMBOL_UTAMA}
            onClick={() => setFormBuka(true)}
          >
            Catat jurnal
          </button>
        ) : null}
      </div>

      {galatMuat ? (
        <div className="p-4 rounded-xl border border-rose-500/30 bg-rose-500/20 text-sm text-rose-100 space-y-3">
          <p>{galatMuat}</p>
          <button
            type="button"
            className={TOMBOL_KEDUA}
            onClick={() => void muat()}
          >
            Coba muat lagi
          </button>
        </div>
      ) : items === null ? (
        <p className="p-6 text-center text-sm text-slate-400">
          Memuat jurnal...
        </p>
      ) : items.length === 0 ? (
        <p className="p-6 text-center text-sm text-slate-400 rounded-xl border border-dashed border-slate-700">
          Belum ada jurnal pada rentang tanggal ini.
        </p>
      ) : (
        <ul className="divide-y divide-slate-800 rounded-xl border border-slate-800 bg-slate-900/60">
          {items.map((item) => (
            <li key={item.id_jurnal}>
              <button
                type="button"
                onClick={() => setDetailId(item.id_jurnal)}
                className="w-full min-h-11 px-4 py-3 text-left hover:bg-slate-800/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500"
              >
                <span className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                  <span className="text-sm font-semibold text-slate-100">
                    {item.nomor}
                  </span>
                  <span className="text-sm font-semibold text-slate-100">
                    <Rp nilai={item.total} />
                  </span>
                </span>
                <span className="mt-1 block text-sm text-slate-300 break-words">
                  {item.keterangan}
                </span>
                <span className="mt-1 flex flex-wrap gap-2 text-xs text-slate-400">
                  <span>{item.tanggal}</span>
                  <span>{item.sumber}</span>
                  <span>oleh {item.dibuat_oleh}</span>
                  {item.dibatalkan ? (
                    <span className="rounded px-1.5 border border-rose-500/30 bg-rose-500/20 text-rose-100">
                      Dibatalkan
                    </span>
                  ) : null}
                  {item.nomor_ganda ? (
                    <span className="rounded px-1.5 border border-amber-500/30 bg-amber-500/20 text-amber-100">
                      Nomor ganda
                    </span>
                  ) : null}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {items && items.length >= BATAS_DAFTAR_JURNAL ? (
        <p className="text-xs text-slate-400">
          Hanya {BATAS_DAFTAR_JURNAL} jurnal terbaru yang ditampilkan. Persempit
          rentang tanggal atau pilih sumber jurnal.
        </p>
      ) : null}

      {formBuka ? (
        <DialogCatatJurnal
          akun={akun}
          onClose={() => setFormBuka(false)}
          onTersimpan={async (nomor) => {
            setFormBuka(false);
            onInfo(`Jurnal ${nomor} tercatat.`);
            await muat();
          }}
        />
      ) : null}
      {detailId ? (
        <DialogDetailJurnal
          idJurnal={detailId}
          bolehBatal={bolehBatal}
          onClose={() => setDetailId(null)}
          onDibatalkan={async (nomor) => {
            setDetailId(null);
            onInfo(`Jurnal dibatalkan dengan jurnal pembalik ${nomor}.`);
            await muat();
          }}
        />
      ) : null}
    </div>
  );
}

interface BarisForm {
  kunci: number;
  id_akun: string;
  debit: string;
  kredit: string;
  keterangan: string;
}

function barisKosong(kunci: number): BarisForm {
  return { kunci, id_akun: "", debit: "", kredit: "", keterangan: "" };
}

function DialogCatatJurnal({
  akun,
  onClose,
  onTersimpan,
}: {
  akun: AkunItem[];
  onClose: () => void;
  onTersimpan: (nomor: string) => Promise<void>;
}) {
  const akunAktif = useMemo(() => akun.filter((item) => item.is_aktif), [akun]);
  const [tanggal, setTanggal] = useState(hariIniWib());
  const [keterangan, setKeterangan] = useState("");
  const [baris, setBaris] = useState<BarisForm[]>([
    barisKosong(1),
    barisKosong(2),
  ]);
  const [galat, setGalat] = useState<string | null>(null);
  const [menyimpan, setMenyimpan] = useState(false);
  const isSubmittingRef = useRef(false);
  const kunciBerikut = useRef(3);

  const totalDebit = baris.reduce(
    (sum, item) => sum + bacaNominal(item.debit),
    0,
  );
  const totalKredit = baris.reduce(
    (sum, item) => sum + bacaNominal(item.kredit),
    0,
  );
  const selisih = totalDebit - totalKredit;

  const ubah = (kunci: number, data: Partial<BarisForm>) =>
    setBaris((daftar) =>
      daftar.map((item) =>
        item.kunci === kunci ? { ...item, ...data } : item,
      ),
    );

  async function simpan(event: FormEvent) {
    event.preventDefault();
    if (isSubmittingRef.current) return;
    isSubmittingRef.current = true;
    setMenyimpan(true);
    setGalat(null);
    try {
      const hasil = await catatJurnal({
        tanggal,
        keterangan,
        baris: baris.map((item) => ({
          id_akun: item.id_akun,
          debit: bacaNominal(item.debit),
          kredit: bacaNominal(item.kredit),
          keterangan: item.keterangan.trim() || null,
        })),
      });
      await onTersimpan(hasil.nomor);
    } catch (error) {
      setGalat(pesanGalat(error, "Jurnal tidak bisa dicatat."));
    } finally {
      isSubmittingRef.current = false;
      setMenyimpan(false);
    }
  }

  return (
    <Modal
      isOpen
      onClose={onClose}
      title="Catat jurnal umum"
      maxWidth="max-w-3xl"
      hideFooter
    >
      <form onSubmit={simpan} className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-[10rem_1fr]">
          <div>
            <label className={LABEL} htmlFor="catat-tanggal">
              Tanggal
            </label>
            <input
              id="catat-tanggal"
              type="date"
              required
              className={INPUT}
              value={tanggal}
              onChange={(e) => setTanggal(e.target.value)}
            />
          </div>
          <div>
            <label className={LABEL} htmlFor="catat-keterangan">
              Keterangan
            </label>
            <input
              id="catat-keterangan"
              type="text"
              required
              maxLength={200}
              className={INPUT}
              placeholder="Bayar listrik bulan Oktober"
              value={keterangan}
              onChange={(e) => setKeterangan(e.target.value)}
            />
          </div>
        </div>

        <fieldset className="space-y-3">
          <legend className="text-sm font-semibold text-slate-200">
            Baris jurnal
          </legend>
          {baris.map((item, indeks) => (
            <div
              key={item.kunci}
              className="grid gap-2 p-3 rounded-lg border border-slate-800 sm:grid-cols-[2fr_1fr_1fr_auto] sm:items-end"
            >
              <div>
                <label className={LABEL} htmlFor={`baris-akun-${item.kunci}`}>
                  Akun baris {indeks + 1}
                </label>
                <select
                  id={`baris-akun-${item.kunci}`}
                  className={INPUT}
                  value={item.id_akun}
                  onChange={(e) =>
                    ubah(item.kunci, { id_akun: e.target.value })
                  }
                >
                  <option value="">Pilih akun</option>
                  {akunAktif.map((pilihan) => (
                    <option key={pilihan.id_akun} value={pilihan.id_akun}>
                      {pilihan.kode} {pilihan.nama}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className={LABEL} htmlFor={`baris-debit-${item.kunci}`}>
                  Debit
                </label>
                <input
                  id={`baris-debit-${item.kunci}`}
                  inputMode="numeric"
                  className={`${INPUT} text-right tabular-nums`}
                  value={item.debit}
                  placeholder="0"
                  onChange={(e) =>
                    ubah(item.kunci, {
                      debit: e.target.value,
                      kredit: e.target.value ? "" : item.kredit,
                    })
                  }
                />
              </div>
              <div>
                <label className={LABEL} htmlFor={`baris-kredit-${item.kunci}`}>
                  Kredit
                </label>
                <input
                  id={`baris-kredit-${item.kunci}`}
                  inputMode="numeric"
                  className={`${INPUT} text-right tabular-nums`}
                  value={item.kredit}
                  placeholder="0"
                  onChange={(e) =>
                    ubah(item.kunci, {
                      kredit: e.target.value,
                      debit: e.target.value ? "" : item.debit,
                    })
                  }
                />
              </div>
              <button
                type="button"
                className={TOMBOL_KEDUA}
                disabled={baris.length <= 2}
                aria-label={`Hapus baris ${indeks + 1}`}
                onClick={() =>
                  setBaris((daftar) =>
                    daftar.filter((lain) => lain.kunci !== item.kunci),
                  )
                }
              >
                Hapus
              </button>
              <div className="sm:col-span-4">
                <label
                  className={LABEL}
                  htmlFor={`baris-keterangan-${item.kunci}`}
                >
                  Keterangan baris {indeks + 1} (opsional)
                </label>
                <input
                  id={`baris-keterangan-${item.kunci}`}
                  type="text"
                  maxLength={200}
                  className={INPUT}
                  value={item.keterangan}
                  onChange={(e) =>
                    ubah(item.kunci, { keterangan: e.target.value })
                  }
                />
              </div>
            </div>
          ))}
          <button
            type="button"
            className={TOMBOL_KEDUA}
            disabled={baris.length >= 100}
            onClick={() =>
              setBaris((daftar) => [
                ...daftar,
                barisKosong(kunciBerikut.current++),
              ])
            }
          >
            Tambah baris
          </button>
        </fieldset>

        <dl
          aria-live="polite"
          className="grid grid-cols-3 gap-2 p-3 rounded-lg border border-slate-800 text-sm"
        >
          <div>
            <dt className="text-xs text-slate-400">Total debit</dt>
            <dd className="min-w-0 font-semibold [overflow-wrap:anywhere] text-slate-100">
              <Rp nilai={totalDebit} />
            </dd>
          </div>
          <div>
            <dt className="text-xs text-slate-400">Total kredit</dt>
            <dd className="min-w-0 font-semibold [overflow-wrap:anywhere] text-slate-100">
              <Rp nilai={totalKredit} />
            </dd>
          </div>
          <div>
            <dt className="text-xs text-slate-400">Selisih</dt>
            <dd
              className={`min-w-0 font-semibold [overflow-wrap:anywhere] ${selisih === 0 ? "text-emerald-100" : "text-rose-100"}`}
            >
              {selisih === 0 ? "Seimbang" : <Rp nilai={Math.abs(selisih)} />}
            </dd>
          </div>
        </dl>

        {galat ? (
          <p
            role="alert"
            className="p-3 rounded-lg border border-rose-500/30 bg-rose-500/20 text-sm text-rose-100"
          >
            {galat}
          </p>
        ) : null}

        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" className={TOMBOL_KEDUA} onClick={onClose}>
            Batal
          </button>
          <button
            type="submit"
            className={TOMBOL_UTAMA}
            disabled={menyimpan || selisih !== 0 || totalDebit === 0}
          >
            {menyimpan ? "Menyimpan..." : "Simpan jurnal"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function DialogDetailJurnal({
  idJurnal,
  bolehBatal,
  onClose,
  onDibatalkan,
}: {
  idJurnal: string;
  bolehBatal: boolean;
  onClose: () => void;
  onDibatalkan: (nomor: string) => Promise<void>;
}) {
  const [detail, setDetail] = useState<JurnalDetail | null>(null);
  const [galatMuat, setGalatMuat] = useState<string | null>(null);
  const [alasan, setAlasan] = useState("");
  const [membatalkan, setMembatalkan] = useState(false);
  const [galatBatal, setGalatBatal] = useState<string | null>(null);
  const isSubmittingRef = useRef(false);

  useEffect(() => {
    let aktif = true;
    getJurnal(idJurnal)
      .then((hasil) => aktif && setDetail(hasil))
      .catch(
        (error) =>
          aktif && setGalatMuat(pesanGalat(error, "Jurnal tidak bisa dimuat.")),
      );
    return () => {
      aktif = false;
    };
  }, [idJurnal]);

  async function batalkan(event: FormEvent) {
    event.preventDefault();
    if (isSubmittingRef.current) return;
    isSubmittingRef.current = true;
    setMembatalkan(true);
    setGalatBatal(null);
    try {
      const hasil = await batalkanJurnal(idJurnal, alasan);
      await onDibatalkan(hasil.nomor);
    } catch (error) {
      setGalatBatal(pesanGalat(error, "Jurnal tidak bisa dibatalkan."));
    } finally {
      isSubmittingRef.current = false;
      setMembatalkan(false);
    }
  }

  const jurnal = detail?.jurnal;
  const bisaDibatalkan =
    bolehBatal && jurnal?.sumber === "Manual" && jurnal.nomor_pembalik === null;

  return (
    <Modal
      isOpen
      onClose={onClose}
      title={jurnal ? `Jurnal ${jurnal.nomor}` : "Detail jurnal"}
      maxWidth="max-w-3xl"
      hideFooter
    >
      {galatMuat ? (
        <p className="p-3 rounded-lg border border-rose-500/30 bg-rose-500/20 text-sm text-rose-100">
          {galatMuat}
        </p>
      ) : !detail || !jurnal ? (
        <p className="text-sm text-slate-400">Memuat jurnal...</p>
      ) : (
        <div className="space-y-4 text-sm">
          <dl className="grid gap-2 sm:grid-cols-2">
            <div>
              <dt className="text-xs text-slate-400">Tanggal</dt>
              <dd className="text-slate-100">{jurnal.tanggal}</dd>
            </div>
            <div>
              <dt className="text-xs text-slate-400">Sumber</dt>
              <dd className="text-slate-100">{jurnal.sumber}</dd>
            </div>
            <div className="sm:col-span-2">
              <dt className="text-xs text-slate-400">Keterangan</dt>
              <dd className="text-slate-100 break-words">
                {jurnal.keterangan}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-slate-400">Dicatat oleh</dt>
              <dd className="text-slate-100">{jurnal.dibuat_oleh}</dd>
            </div>
            {jurnal.nomor_pembalik ? (
              <div>
                <dt className="text-xs text-slate-400">Status</dt>
                <dd className="text-rose-100">
                  Dibatalkan oleh {jurnal.nomor_pembalik}
                </dd>
              </div>
            ) : null}
          </dl>

          <div className="overflow-x-auto rounded-lg border border-slate-800">
            <table className="w-full text-left">
              <thead className="text-xs text-slate-400">
                <tr>
                  <th className="px-3 py-2 font-medium">Akun</th>
                  <th className="px-3 py-2 font-medium text-right">Debit</th>
                  <th className="px-3 py-2 font-medium text-right">Kredit</th>
                </tr>
              </thead>
              <tbody>
                {detail.baris.map((item) => (
                  <tr key={item.id_baris} className="border-t border-slate-800">
                    <td className="px-3 py-2 text-slate-100">
                      <span className="block">
                        {item.kode_akun} {item.nama_akun}
                      </span>
                      {item.keterangan ? (
                        <span className="block text-xs text-slate-400">
                          {item.keterangan}
                        </span>
                      ) : null}
                    </td>
                    <td className="px-3 py-2 text-right text-slate-100">
                      {item.debit ? <Rp nilai={item.debit} /> : null}
                    </td>
                    <td className="px-3 py-2 text-right text-slate-100">
                      {item.kredit ? <Rp nilai={item.kredit} /> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {bisaDibatalkan ? (
            <form
              onSubmit={batalkan}
              className="space-y-2 p-3 rounded-lg border border-rose-500/30"
            >
              <label className={LABEL} htmlFor="batal-alasan">
                Alasan pembatalan
              </label>
              <input
                id="batal-alasan"
                type="text"
                required
                maxLength={150}
                className={INPUT}
                value={alasan}
                onChange={(e) => setAlasan(e.target.value)}
              />
              <p className="text-xs text-slate-400">
                Jurnal ini tidak dihapus. Jurnal pembalik bertanggal hari ini
                dicatat untuk menihilkannya, dan keduanya tetap tampil di
                daftar.
              </p>
              {galatBatal ? (
                <p
                  role="alert"
                  className="p-3 rounded-lg border border-rose-500/30 bg-rose-500/20 text-sm text-rose-100"
                >
                  {galatBatal}
                </p>
              ) : null}
              <button
                type="submit"
                className={TOMBOL_BAHAYA}
                disabled={membatalkan}
              >
                {membatalkan ? "Membatalkan..." : "Batalkan jurnal"}
              </button>
            </form>
          ) : null}
        </div>
      )}
    </Modal>
  );
}

// ── Buku besar ──────────────────────────────────────────────────────────────

function PanelBukuBesar({ akun }: { akun: AkunItem[] }) {
  const hariIni = hariIniWib();
  const [idAkun, setIdAkun] = useState(akun[0]?.id_akun ?? "");
  const [dari, setDari] = useState(awalBulan(hariIni));
  const [sampai, setSampai] = useState(hariIni);
  const [data, setData] = useState<BukuBesar | null>(null);
  const [galatMuat, setGalatMuat] = useState<string | null>(null);

  const muat = useCallback(async () => {
    if (!idAkun) return;
    setData(null);
    setGalatMuat(null);
    try {
      setData(await getBukuBesar(idAkun, dari, sampai));
    } catch (error) {
      setGalatMuat(pesanGalat(error, "Buku besar tidak bisa dimuat."));
    }
  }, [idAkun, dari, sampai]);

  useEffect(() => {
    void muat();
  }, [muat]);
  useEffect(() => subscribeSyncCompleted(() => void muat()), [muat]);

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-[2fr_1fr_1fr]">
        <div>
          <label className={LABEL} htmlFor="buku-akun">
            Akun
          </label>
          <select
            id="buku-akun"
            className={INPUT}
            value={idAkun}
            onChange={(e) => setIdAkun(e.target.value)}
          >
            {akun.map((item) => (
              <option key={item.id_akun} value={item.id_akun}>
                {item.kode} {item.nama}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className={LABEL} htmlFor="buku-dari">
            Dari tanggal
          </label>
          <input
            id="buku-dari"
            type="date"
            className={INPUT}
            value={dari}
            max={sampai}
            onChange={(e) => setDari(e.target.value)}
          />
        </div>
        <div>
          <label className={LABEL} htmlFor="buku-sampai">
            Sampai tanggal
          </label>
          <input
            id="buku-sampai"
            type="date"
            className={INPUT}
            value={sampai}
            min={dari}
            onChange={(e) => setSampai(e.target.value)}
          />
        </div>
      </div>

      {!idAkun ? (
        <p className="p-6 text-center text-sm text-slate-400">
          Belum ada akun. Tambahkan akun di tab Bagan Akun.
        </p>
      ) : galatMuat ? (
        <div className="p-4 rounded-xl border border-rose-500/30 bg-rose-500/20 text-sm text-rose-100 space-y-3">
          <p>{galatMuat}</p>
          <button
            type="button"
            className={TOMBOL_KEDUA}
            onClick={() => void muat()}
          >
            Coba muat lagi
          </button>
        </div>
      ) : !data ? (
        <p className="p-6 text-center text-sm text-slate-400">
          Memuat buku besar...
        </p>
      ) : (
        <div className="space-y-3">
          <div className="overflow-x-auto rounded-xl border border-slate-800 bg-slate-900/60">
            <table className="w-full text-left text-sm">
              <thead className="text-xs text-slate-400">
                <tr>
                  <th className="px-3 py-2 font-medium">Tanggal</th>
                  <th className="px-3 py-2 font-medium">
                    Nomor dan keterangan
                  </th>
                  <th className="px-3 py-2 font-medium text-right">Debit</th>
                  <th className="px-3 py-2 font-medium text-right">Kredit</th>
                  <th className="px-3 py-2 font-medium text-right">Saldo</th>
                </tr>
              </thead>
              <tbody>
                <tr className="border-t border-slate-800">
                  <td className="px-3 py-2 text-slate-400">{dari}</td>
                  <td className="px-3 py-2 text-slate-300">Saldo awal</td>
                  <td />
                  <td />
                  <td className="px-3 py-2 text-right font-semibold text-slate-100">
                    <Rp nilai={data.saldo_awal} />
                  </td>
                </tr>
                {data.baris.map((item, indeks) => (
                  <tr
                    key={`${item.id_jurnal}-${indeks}`}
                    className="border-t border-slate-800"
                  >
                    <td className="px-3 py-2 text-slate-400 whitespace-nowrap">
                      {item.tanggal}
                    </td>
                    <td className="px-3 py-2 text-slate-100">
                      <span className="block text-xs text-slate-400">
                        {item.nomor}
                      </span>
                      {item.keterangan}
                    </td>
                    <td className="px-3 py-2 text-right text-slate-100">
                      {item.debit ? <Rp nilai={item.debit} /> : null}
                    </td>
                    <td className="px-3 py-2 text-right text-slate-100">
                      {item.kredit ? <Rp nilai={item.kredit} /> : null}
                    </td>
                    <td className="px-3 py-2 text-right text-slate-100">
                      <Rp nilai={item.saldo} />
                    </td>
                  </tr>
                ))}
                <tr className="border-t border-slate-700">
                  <td />
                  <td className="px-3 py-2 font-semibold text-slate-100">
                    Total periode dan saldo akhir
                  </td>
                  <td className="px-3 py-2 text-right font-semibold text-slate-100">
                    <Rp nilai={data.total_debit} />
                  </td>
                  <td className="px-3 py-2 text-right font-semibold text-slate-100">
                    <Rp nilai={data.total_kredit} />
                  </td>
                  <td className="px-3 py-2 text-right font-semibold text-slate-100">
                    <Rp nilai={data.saldo_akhir} />
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          {data.baris.length === 0 ? (
            <p className="text-sm text-slate-400">
              Tidak ada mutasi akun ini pada rentang tanggal tersebut.
            </p>
          ) : null}
          {data.terpotong ? (
            <p className="text-xs text-slate-400">
              Baris terlalu banyak untuk ditampilkan semua. Total dan saldo
              akhir tetap dihitung dari seluruh mutasi; persempit rentang
              tanggal untuk melihat rinciannya.
            </p>
          ) : null}
          <BarisEkspor
            aksi={[
              {
                label: "Ekspor Excel",
                jenis: "Excel",
                kerja: () => eksporBukuBesar(data, dari, sampai),
              },
            ]}
          />
        </div>
      )}
    </div>
  );
}

// ── Neraca saldo ────────────────────────────────────────────────────────────

function PanelNeracaSaldo() {
  const [sampai, setSampai] = useState(hariIniWib());
  const [data, setData] = useState<NeracaSaldo | null>(null);
  const [galatMuat, setGalatMuat] = useState<string | null>(null);

  const muat = useCallback(async () => {
    setData(null);
    setGalatMuat(null);
    try {
      setData(await getNeracaSaldo(sampai));
    } catch (error) {
      setGalatMuat(pesanGalat(error, "Neraca saldo tidak bisa dimuat."));
    }
  }, [sampai]);

  useEffect(() => {
    void muat();
  }, [muat]);
  useEffect(() => subscribeSyncCompleted(() => void muat()), [muat]);

  const seimbang = data !== null && data.total_debit === data.total_kredit;

  return (
    <div className="space-y-4">
      <div className="max-w-xs">
        <label className={LABEL} htmlFor="neraca-sampai">
          Per tanggal
        </label>
        <input
          id="neraca-sampai"
          type="date"
          className={INPUT}
          value={sampai}
          onChange={(e) => setSampai(e.target.value)}
        />
      </div>

      {galatMuat ? (
        <div className="p-4 rounded-xl border border-rose-500/30 bg-rose-500/20 text-sm text-rose-100 space-y-3">
          <p>{galatMuat}</p>
          <button
            type="button"
            className={TOMBOL_KEDUA}
            onClick={() => void muat()}
          >
            Coba muat lagi
          </button>
        </div>
      ) : !data ? (
        <p className="p-6 text-center text-sm text-slate-400">
          Memuat neraca saldo...
        </p>
      ) : (
        <div className="space-y-3">
          {!seimbang ? (
            <p
              role="alert"
              className="p-3 rounded-lg border border-amber-500/30 bg-amber-500/20 text-sm text-amber-100"
            >
              Total debit dan kredit belum sama. Biasanya ini berarti sebagian
              baris jurnal belum selesai tersinkron ke perangkat ini. Jalankan
              sinkronisasi lalu buka lagi.
            </p>
          ) : null}
          <div className="overflow-x-auto rounded-xl border border-slate-800 bg-slate-900/60">
            <table className="w-full text-left text-sm">
              <thead className="text-xs text-slate-400">
                <tr>
                  <th className="px-3 py-2 font-medium">Kode</th>
                  <th className="px-3 py-2 font-medium">Akun</th>
                  <th className="px-3 py-2 font-medium text-right">Debit</th>
                  <th className="px-3 py-2 font-medium text-right">Kredit</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((item) => (
                  <tr key={item.id_akun} className="border-t border-slate-800">
                    <td className="px-3 py-2 text-slate-400 whitespace-nowrap">
                      {item.kode}
                    </td>
                    <td className="px-3 py-2 text-slate-100">{item.nama}</td>
                    <td className="px-3 py-2 text-right text-slate-100">
                      {item.debit ? <Rp nilai={item.debit} /> : null}
                    </td>
                    <td className="px-3 py-2 text-right text-slate-100">
                      {item.kredit ? <Rp nilai={item.kredit} /> : null}
                    </td>
                  </tr>
                ))}
                <tr className="border-t border-slate-700">
                  <td />
                  <td className="px-3 py-2 font-semibold text-slate-100">
                    Jumlah
                  </td>
                  <td className="px-3 py-2 text-right font-semibold text-slate-100">
                    <Rp nilai={data.total_debit} />
                  </td>
                  <td className="px-3 py-2 text-right font-semibold text-slate-100">
                    <Rp nilai={data.total_kredit} />
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <BarisEkspor
            aksi={[
              {
                label: "Ekspor Excel",
                jenis: "Excel",
                kerja: () => eksporNeracaSaldo(data, sampai),
              },
            ]}
          />
        </div>
      )}
    </div>
  );
}

// ── Bagan akun ──────────────────────────────────────────────────────────────

interface DraftAkun {
  id_akun: string | null;
  kode: string;
  nama: string;
  kelompok: KelompokAkun;
  saldo_normal: SaldoNormal;
  is_aktif: boolean;
}

function PanelAkun({
  akun,
  bolehKelola,
  onTersimpan,
}: {
  akun: AkunItem[];
  bolehKelola: boolean;
  onTersimpan: (pesan: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState<DraftAkun | null>(null);
  const [asal, setAsal] = useState<AkunItem | null>(null);
  const [menyimpan, setMenyimpan] = useState(false);
  const [galatSimpan, setGalatSimpan] = useState<string | null>(null);
  const isSubmittingRef = useRef(false);

  function bukaBaru() {
    setGalatSimpan(null);
    setAsal(null);
    setDraft({
      id_akun: null,
      kode: "",
      nama: "",
      kelompok: "Beban",
      saldo_normal: "Debit",
      is_aktif: true,
    });
  }

  function bukaUbah(item: AkunItem) {
    setGalatSimpan(null);
    setAsal(item);
    setDraft({
      id_akun: item.id_akun,
      kode: item.kode,
      nama: item.nama,
      kelompok: item.kelompok,
      saldo_normal: item.saldo_normal,
      is_aktif: item.is_aktif,
    });
  }

  async function simpan(event: FormEvent) {
    event.preventDefault();
    if (!draft || isSubmittingRef.current) return;
    isSubmittingRef.current = true;
    setMenyimpan(true);
    try {
      await simpanAkun(draft);
      setDraft(null);
      await onTersimpan(`Akun ${draft.kode} ${draft.nama.trim()} tersimpan.`);
    } catch (error) {
      setGalatSimpan(pesanGalat(error, "Akun tidak bisa disimpan."));
    } finally {
      isSubmittingRef.current = false;
      setMenyimpan(false);
    }
  }

  const strukturTerkunci = asal !== null && (asal.sistem || asal.punya_jurnal);

  return (
    <div className="space-y-4">
      {bolehKelola ? (
        <button type="button" className={TOMBOL_UTAMA} onClick={bukaBaru}>
          Tambah akun
        </button>
      ) : null}

      {KELOMPOK_AKUN.map((kelompok) => {
        const anggota = akun.filter((item) => item.kelompok === kelompok);
        if (anggota.length === 0) return null;
        return (
          <section key={kelompok} className="space-y-2">
            <h3 className="text-sm font-semibold text-slate-200">{kelompok}</h3>
            <ul className="divide-y divide-slate-800 rounded-xl border border-slate-800 bg-slate-900/60">
              {anggota.map((item) => (
                <li
                  key={item.id_akun}
                  className="flex flex-wrap items-center justify-between gap-2 px-4 py-2"
                >
                  <span className="min-w-0 text-sm">
                    <span className="text-slate-400 tabular-nums">
                      {item.kode}
                    </span>{" "}
                    <span
                      className={
                        item.is_aktif
                          ? "text-slate-100"
                          : "text-slate-400 line-through"
                      }
                    >
                      {item.nama}
                    </span>
                    <span className="block text-xs text-slate-400">
                      Saldo normal {item.saldo_normal}
                      {item.sistem ? ", dipakai jurnal otomatis" : ""}
                      {item.is_aktif ? "" : ", nonaktif"}
                    </span>
                  </span>
                  {bolehKelola ? (
                    <button
                      type="button"
                      className={TOMBOL_KEDUA}
                      aria-label={`Ubah akun ${item.kode} ${item.nama}`}
                      onClick={() => bukaUbah(item)}
                    >
                      Ubah
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
        );
      })}

      {draft ? (
        <Modal
          isOpen
          onClose={() => setDraft(null)}
          title={draft.id_akun ? "Ubah akun" : "Tambah akun"}
          hideFooter
        >
          <form onSubmit={simpan} className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-[8rem_1fr]">
              <div>
                <label className={LABEL} htmlFor="akun-kode">
                  Kode
                </label>
                <input
                  id="akun-kode"
                  required
                  maxLength={20}
                  className={INPUT}
                  value={draft.kode}
                  onChange={(e) => setDraft({ ...draft, kode: e.target.value })}
                />
              </div>
              <div>
                <label className={LABEL} htmlFor="akun-nama">
                  Nama akun
                </label>
                <input
                  id="akun-nama"
                  required
                  maxLength={80}
                  className={INPUT}
                  value={draft.nama}
                  onChange={(e) => setDraft({ ...draft, nama: e.target.value })}
                />
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className={LABEL} htmlFor="akun-kelompok">
                  Kelompok
                </label>
                <select
                  id="akun-kelompok"
                  className={INPUT}
                  disabled={strukturTerkunci}
                  value={draft.kelompok}
                  onChange={(e) => {
                    const kelompok = e.target.value as KelompokAkun;
                    setDraft({
                      ...draft,
                      kelompok,
                      saldo_normal: saldoNormalBawaan(kelompok),
                    });
                  }}
                >
                  {KELOMPOK_AKUN.map((item) => (
                    <option key={item} value={item}>
                      {item}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className={LABEL} htmlFor="akun-saldo-normal">
                  Saldo normal
                </label>
                <select
                  id="akun-saldo-normal"
                  className={INPUT}
                  disabled={strukturTerkunci}
                  value={draft.saldo_normal}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      saldo_normal: e.target.value as SaldoNormal,
                    })
                  }
                >
                  {SALDO_NORMAL.map((item) => (
                    <option key={item} value={item}>
                      {item}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            {strukturTerkunci ? (
              <p className="text-xs text-slate-400">
                {asal?.sistem
                  ? "Akun ini dipakai jurnal otomatis, jadi hanya kode dan namanya yang bisa diubah."
                  : "Akun ini sudah dipakai jurnal, jadi kelompok dan saldo normalnya terkunci."}
              </p>
            ) : null}
            {asal?.sistem ? null : (
              <label className="flex min-h-11 items-center gap-2 text-sm text-slate-200">
                <input
                  type="checkbox"
                  checked={draft.is_aktif}
                  onChange={(e) =>
                    setDraft({ ...draft, is_aktif: e.target.checked })
                  }
                  className="h-4 w-4"
                />
                Akun aktif dan bisa dipilih di jurnal baru
              </label>
            )}
            {galatSimpan ? (
              <p
                role="alert"
                className="p-3 rounded-lg border border-rose-500/30 bg-rose-500/20 text-sm text-rose-100"
              >
                {galatSimpan}
              </p>
            ) : null}
            <div className="flex flex-wrap justify-end gap-2">
              <button
                type="button"
                className={TOMBOL_KEDUA}
                onClick={() => setDraft(null)}
              >
                Batal
              </button>
              <button
                type="submit"
                className={TOMBOL_UTAMA}
                disabled={menyimpan}
              >
                {menyimpan ? "Menyimpan..." : "Simpan akun"}
              </button>
            </div>
          </form>
        </Modal>
      ) : null}
    </div>
  );
}
