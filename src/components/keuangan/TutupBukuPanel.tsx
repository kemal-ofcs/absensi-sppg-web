"use client";

import {
  type FormEvent,
  useCallback,
  useEffect,
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
import { Modal } from "@/components/ui/Modal";
import {
  bukaKembaliBuku,
  getStatusTutupBuku,
  getTinjauanTutupBuku,
  putuskanTutupBuku,
  type StatusTutupBuku,
  type TinjauanTutupBuku,
  type TutupBukuItem,
  tutupBuku,
  tutupUlangBuku,
} from "@/lib/gateways/accounting";
import { subscribeSyncCompleted } from "@/lib/gateways/sync-status";
import { formatRupiah } from "@/lib/validations/accounting";
import {
  MAKS_ALASAN_BUKA,
  MAKS_CATATAN_KEPUTUSAN,
  tanggalTampil,
  waktuTampil,
} from "@/lib/validations/tutup-buku";

/**
 * Tab Tutup Buku halaman Keuangan (Tahap 1): batas yang berlaku, menutup,
 * membuka kembali periode terakhir, dan riwayatnya. Dipakai Web/Desktop dan
 * Mobile (disalin lewat `filesToCopy`).
 */

const GALAT_KOTAK =
  "p-3 rounded-lg border border-rose-500/30 bg-rose-500/20 text-sm text-rose-100";

/** Tanggal `YYYY-MM-DD` digeser sejumlah hari, dihitung di UTC. */
function geser(tanggal: string, hari: number): string {
  const [tahun, bulan, tgl] = tanggal.split("-").map(Number);
  return new Date(Date.UTC(tahun ?? 2000, (bulan ?? 1) - 1, (tgl ?? 1) + hari))
    .toISOString()
    .slice(0, 10);
}

/**
 * Bawaan isian: hari terakhir bulan lalu, tanggal tutup buku yang paling
 * lazim, tetapi tidak sebelum hari sesudah batas dan tidak sesudah kemarin.
 */
function tanggalBawaan(hariIni: string, batas: string | null): string {
  const akhirBulanLalu = geser(`${hariIni.slice(0, 8)}01`, -1);
  const paling = batas ? geser(batas, 1) : akhirBulanLalu;
  const kemarin = geser(hariIni, -1);
  const pilihan = akhirBulanLalu > paling ? akhirBulanLalu : paling;
  return pilihan > kemarin ? kemarin : pilihan;
}

function kodePendek(kode: string): string {
  return kode.length > 8 ? kode.slice(0, 8).toUpperCase() : kode;
}

export function TutupBukuPanel({
  bolehTutup,
  onInfo,
  onBerubah,
}: {
  bolehTutup: boolean;
  onInfo: (pesan: string) => void;
  /** Dipanggil setelah data berubah, supaya tanda angka di tab ikut segar. */
  onBerubah?: () => void;
}) {
  const [data, setData] = useState<StatusTutupBuku | null>(null);
  const [galatMuat, setGalatMuat] = useState<string | null>(null);
  const [dialog, setDialog] = useState<"tutup" | "buka" | null>(null);
  const [ditinjau, setDitinjau] = useState<TutupBukuItem | null>(null);

  const muat = useCallback(async () => {
    setGalatMuat(null);
    try {
      setData(await getStatusTutupBuku());
    } catch (error) {
      setGalatMuat(pesanGalat(error, "Status tutup buku tidak bisa dimuat."));
    }
  }, []);

  useEffect(() => {
    void muat();
  }, [muat]);
  useEffect(() => subscribeSyncCompleted(() => void muat()), [muat]);

  if (galatMuat) {
    return (
      <div className={`${GALAT_KOTAK} space-y-3`}>
        <p>{galatMuat}</p>
        <button
          type="button"
          className={TOMBOL_KEDUA}
          onClick={() => void muat()}
        >
          Coba muat lagi
        </button>
      </div>
    );
  }
  if (!data) {
    return (
      <p className="p-6 text-center text-sm text-slate-400">
        Memuat status tutup buku...
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <div className="p-4 rounded-xl border border-slate-800 bg-slate-900/60 space-y-3">
        <p className="text-base font-semibold text-slate-100">
          {data.batas
            ? `Buku terkunci sampai ${tanggalTampil(data.batas)}`
            : "Buku belum pernah ditutup"}
        </p>
        <p className="text-sm text-slate-400">
          {data.batas
            ? "Pencatatan bertanggal sampai tanggal itu ditolak: jurnal, kuitansi, tagihan, kasbon, dan pembayaran gaji."
            : "Setelah ditutup, pencatatan bertanggal sampai tanggal tutup buku ditolak."}
        </p>
        {bolehTutup ? (
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={TOMBOL_UTAMA}
              onClick={() => setDialog("tutup")}
            >
              Tutup buku
            </button>
            {data.batas ? (
              <button
                type="button"
                className={TOMBOL_KEDUA}
                onClick={() => setDialog("buka")}
              >
                Buka kembali periode terakhir
              </button>
            ) : null}
          </div>
        ) : (
          <p className="text-xs text-slate-400">
            Menutup dan membuka kembali buku hanya bisa dilakukan pemegang izin
            Tutup Buku.
          </p>
        )}
      </div>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-slate-200">Riwayat</h2>
        {data.riwayat.length === 0 ? (
          <p className="p-6 text-center text-sm text-slate-400 rounded-xl border border-dashed border-slate-700">
            Belum ada tutup buku.
          </p>
        ) : (
          <ul className="divide-y divide-slate-800 rounded-xl border border-slate-800 bg-slate-900/60">
            {data.riwayat.map((item) => (
              <BarisRiwayat
                key={item.id_tutup}
                item={item}
                onTinjau={() => setDitinjau(item)}
              />
            ))}
          </ul>
        )}
      </section>

      {dialog === "tutup" ? (
        <DialogTutup
          batas={data.batas}
          onClose={() => setDialog(null)}
          onSelesai={async (sampai) => {
            setDialog(null);
            onInfo(`Buku ditutup sampai ${tanggalTampil(sampai)}.`);
            await muat();
            onBerubah?.();
          }}
        />
      ) : null}
      {dialog === "buka" && data.batas ? (
        <DialogBuka
          batas={data.batas}
          onClose={() => setDialog(null)}
          onSelesai={async () => {
            setDialog(null);
            onInfo(
              `Periode sampai ${tanggalTampil(data.batas ?? "")} dibuka kembali.`,
            );
            await muat();
            onBerubah?.();
          }}
        />
      ) : null}
      {ditinjau ? (
        <DialogTinjau
          item={ditinjau}
          bolehTutup={bolehTutup}
          onClose={() => setDitinjau(null)}
          onSelesai={async (pesan) => {
            setDitinjau(null);
            onInfo(pesan);
            await muat();
            onBerubah?.();
          }}
        />
      ) : null}
    </div>
  );
}

const LABEL_STATUS: Record<TutupBukuItem["status"], string> = {
  Aktif: "Berlaku",
  Dibuka: "Dibuka kembali",
  Digantikan: "Digantikan",
  Menunggu: "Menunggu keputusan",
};

function BarisRiwayat({
  item,
  onTinjau,
}: {
  item: TutupBukuItem;
  onTinjau: () => void;
}) {
  const perlu = item.status === "Menunggu" || item.perlu_ditinjau === true;
  return (
    <li className="px-4 py-3 space-y-1 text-sm">
      <p className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="font-semibold text-slate-100">
          Sampai {tanggalTampil(item.sampai_tanggal)}
        </span>
        <span className="flex flex-wrap gap-1">
          {item.perlu_ditinjau ? (
            <span className="rounded px-1.5 text-xs border border-amber-500/30 bg-amber-500/20 text-amber-100">
              Saldo berubah sejak ditutup
            </span>
          ) : null}
          <span
            className={`rounded px-1.5 text-xs border ${
              item.status === "Aktif"
                ? "border-emerald-500/30 bg-emerald-500/20 text-emerald-100"
                : item.status === "Menunggu"
                  ? "border-amber-500/30 bg-amber-500/20 text-amber-100"
                  : "border-slate-600 text-slate-300"
            }`}
          >
            {LABEL_STATUS[item.status]}
          </span>
        </span>
      </p>
      <p className="text-xs text-slate-400">
        Ditutup oleh {item.dibuat_oleh} di perangkat{" "}
        {kodePendek(item.kode_perangkat)} pada{" "}
        {waktuTampil(item.waktu_perangkat)} (menurut jam perangkat).
      </p>
      <p className="text-xs text-slate-400">
        {item.diterima_cloud
          ? `Diterima cloud ${waktuTampil(item.diterima_cloud)}.`
          : "Belum sampai ke cloud."}
      </p>
      {item.status === "Dibuka" ? (
        <p className="text-xs text-slate-300 break-words">
          Dibuka kembali oleh {item.dibuka_oleh} pada{" "}
          {waktuTampil(item.dibuka_pada ?? "")}: {item.alasan_buka}
        </p>
      ) : null}
      {item.diputuskan_oleh ? (
        <p className="text-xs text-slate-300 break-words">
          Diputuskan oleh {item.diputuskan_oleh} pada{" "}
          {waktuTampil(item.diputuskan_pada ?? "")}
          {item.catatan_keputusan ? `: ${item.catatan_keputusan}` : "."}
        </p>
      ) : null}
      {perlu ? (
        <button type="button" className={TOMBOL_KEDUA} onClick={onTinjau}>
          Tinjau
        </button>
      ) : null}
    </li>
  );
}

function RingkasVersi({
  judul,
  item,
}: {
  judul: string;
  item: TutupBukuItem | null;
}) {
  return (
    <div className="p-3 rounded-lg border border-slate-800 space-y-1 text-xs text-slate-300">
      <p className="text-sm font-semibold text-slate-100">{judul}</p>
      {item ? (
        <>
          <p>
            Oleh {item.dibuat_oleh} di perangkat{" "}
            {kodePendek(item.kode_perangkat)}
          </p>
          <p>
            Dibuat {waktuTampil(item.waktu_perangkat)} (menurut jam perangkat)
          </p>
          <p>
            {item.diterima_cloud
              ? `Diterima cloud ${waktuTampil(item.diterima_cloud)}`
              : "Belum sampai ke cloud"}
          </p>
        </>
      ) : (
        <p>Tidak ada versi lain yang berlaku untuk tanggal ini.</p>
      )}
    </div>
  );
}

/**
 * Tinjauan satu tutup buku. `Menunggu`: dua versi berdampingan beserta
 * selisih saldonya, lalu pakai atau tolak. Saldo berubah: selisih dan jurnal
 * yang masuk sesudah ditutup, lalu tutup ulang.
 */
function DialogTinjau({
  item,
  bolehTutup,
  onClose,
  onSelesai,
}: {
  item: TutupBukuItem;
  bolehTutup: boolean;
  onClose: () => void;
  onSelesai: (pesan: string) => Promise<void>;
}) {
  const [data, setData] = useState<TinjauanTutupBuku | null>(null);
  const [galatMuat, setGalatMuat] = useState<string | null>(null);
  const [catatan, setCatatan] = useState("");
  const [galat, setGalat] = useState<string | null>(null);
  const [sibuk, setSibuk] = useState(false);
  const isSubmittingRef = useRef(false);
  const menunggu = item.status === "Menunggu";

  useEffect(() => {
    getTinjauanTutupBuku(item.id_tutup)
      .then(setData)
      .catch((error) =>
        setGalatMuat(pesanGalat(error, "Bahan tinjauan tidak bisa dimuat.")),
      );
  }, [item.id_tutup]);

  async function jalankan(aksi: "pakai" | "tolak" | "ulang") {
    if (isSubmittingRef.current) return;
    isSubmittingRef.current = true;
    setSibuk(true);
    setGalat(null);
    try {
      if (aksi === "ulang") {
        await tutupUlangBuku(item.id_tutup, catatan);
        await onSelesai(
          `Buku sampai ${tanggalTampil(item.sampai_tanggal)} ditutup ulang dengan saldo sekarang.`,
        );
      } else {
        await putuskanTutupBuku(item.id_tutup, aksi, catatan);
        await onSelesai(
          aksi === "pakai"
            ? `Versi dari ${item.dibuat_oleh} dipakai untuk tutup buku sampai ${tanggalTampil(item.sampai_tanggal)}.`
            : `Versi dari ${item.dibuat_oleh} ditolak.`,
        );
      }
    } catch (error) {
      setGalat(pesanGalat(error, "Keputusan tidak bisa disimpan."));
    } finally {
      isSubmittingRef.current = false;
      setSibuk(false);
    }
  }

  return (
    <Modal
      isOpen
      onClose={onClose}
      title={`Tinjau tutup buku sampai ${tanggalTampil(item.sampai_tanggal)}`}
      hideFooter
    >
      <div className="space-y-4 text-sm text-slate-200">
        {galatMuat ? (
          <p role="alert" className={GALAT_KOTAK}>
            {galatMuat}
          </p>
        ) : !data ? (
          <p className="text-slate-400">Memuat bahan tinjauan...</p>
        ) : (
          <>
            <p>
              {!menunggu
                ? "Ada transaksi bertanggal di periode ini yang masuk setelah buku ditutup, biasanya dari perangkat yang saat itu tanpa jaringan. Transaksinya sudah tercatat; tutup ulang menjadikan saldo sekarang sebagai potret tutup buku yang resmi."
                : data.pembanding
                  ? "Dua perangkat menutup buku untuk tanggal yang sama dengan saldo yang berbeda. Biasanya salah satunya belum menerima sebagian transaksi saat menutup. Pilih versi yang sesuai dengan catatan kas dan bank."
                  : "Versi ini menunggu keputusan, tetapi versi yang dulu berlaku untuk tanggal ini sudah tidak berlaku lagi (dibuka kembali atau digantikan). Pakai versi ini bila saldonya sesuai catatan kas dan bank, atau tolak."}
            </p>
            {menunggu ? (
              <div className="grid gap-2 sm:grid-cols-2">
                <RingkasVersi judul="Versi berlaku" item={data.pembanding} />
                <RingkasVersi judul="Versi yang menunggu" item={data.tutup} />
              </div>
            ) : null}
            {data.selisih.length === 0 ? (
              <p className="text-slate-400">Tidak ada selisih saldo.</p>
            ) : (
              <div className="overflow-x-auto rounded-lg border border-slate-800">
                <table className="w-full text-left text-xs">
                  <thead className="text-slate-400">
                    <tr>
                      <th scope="col" className="px-2 py-1.5 font-medium">
                        Akun
                      </th>
                      <th
                        scope="col"
                        className="px-2 py-1.5 font-medium text-right"
                      >
                        {menunggu ? "Versi berlaku" : "Saat ditutup"}
                      </th>
                      <th
                        scope="col"
                        className="px-2 py-1.5 font-medium text-right"
                      >
                        {menunggu ? "Versi menunggu" : "Sekarang"}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.selisih.map((baris) => (
                      <tr
                        key={baris.id_akun}
                        className="border-t border-slate-800"
                      >
                        <td className="px-2 py-1.5">
                          {baris.kode ? `${baris.kode} ` : ""}
                          {baris.nama}
                        </td>
                        <td className="px-2 py-1.5 text-right tabular-nums whitespace-nowrap">
                          {formatRupiah(baris.sebelum)}
                        </td>
                        <td className="px-2 py-1.5 text-right tabular-nums whitespace-nowrap">
                          {formatRupiah(baris.sesudah)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="text-xs text-slate-400">
              Saldo ditulis debit dikurangi kredit, jadi akun pendapatan,
              kewajiban, dan aset neto bernilai minus.
            </p>
            {data.jurnal.length > 0 ? (
              <section className="space-y-1">
                <h3 className="text-xs font-semibold text-slate-300">
                  Jurnal yang dicatat sesudah ditutup (menurut jam pencatatnya)
                </h3>
                <ul className="divide-y divide-slate-800 rounded-lg border border-slate-800 text-xs">
                  {data.jurnal.map((j) => (
                    <li key={j.id_jurnal} className="px-2 py-1.5">
                      <span className="text-slate-100">
                        {tanggalTampil(j.tanggal)} {j.nomor}
                      </span>{" "}
                      {j.keterangan}, {formatRupiah(j.total)}, oleh{" "}
                      {j.dibuat_oleh}
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
            {bolehTutup ? (
              <>
                <div>
                  <label className={LABEL} htmlFor="tinjau-catatan">
                    Catatan keputusan (opsional)
                  </label>
                  <input
                    id="tinjau-catatan"
                    className={INPUT}
                    maxLength={MAKS_CATATAN_KEPUTUSAN}
                    value={catatan}
                    onChange={(e) => setCatatan(e.target.value)}
                  />
                </div>
                {galat ? (
                  <p role="alert" className={GALAT_KOTAK}>
                    {galat}
                  </p>
                ) : null}
                <div className="flex flex-wrap justify-end gap-2">
                  <button
                    type="button"
                    className={TOMBOL_KEDUA}
                    onClick={onClose}
                  >
                    Tutup
                  </button>
                  {menunggu ? (
                    <>
                      <button
                        type="button"
                        className={TOMBOL_BAHAYA}
                        disabled={sibuk}
                        onClick={() => void jalankan("tolak")}
                      >
                        Tolak versi ini
                      </button>
                      <button
                        type="button"
                        className={TOMBOL_UTAMA}
                        disabled={sibuk}
                        onClick={() => void jalankan("pakai")}
                      >
                        Pakai versi ini
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className={TOMBOL_UTAMA}
                      disabled={sibuk}
                      onClick={() => void jalankan("ulang")}
                    >
                      Tutup ulang dengan saldo sekarang
                    </button>
                  )}
                </div>
              </>
            ) : (
              <p className="text-xs text-slate-400">
                Keputusan hanya bisa diambil pemegang izin Tutup Buku.
              </p>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}

function DialogTutup({
  batas,
  onClose,
  onSelesai,
}: {
  batas: string | null;
  onClose: () => void;
  onSelesai: (sampai: string) => Promise<void>;
}) {
  const hariIni = hariIniWib();
  const [sampai, setSampai] = useState(tanggalBawaan(hariIni, batas));
  const [galat, setGalat] = useState<string | null>(null);
  const [sibuk, setSibuk] = useState(false);
  const isSubmittingRef = useRef(false);

  async function simpan(event: FormEvent) {
    event.preventDefault();
    if (isSubmittingRef.current) return;
    isSubmittingRef.current = true;
    setSibuk(true);
    setGalat(null);
    try {
      await tutupBuku(sampai);
      await onSelesai(sampai);
    } catch (error) {
      setGalat(pesanGalat(error, "Buku tidak bisa ditutup."));
    } finally {
      isSubmittingRef.current = false;
      setSibuk(false);
    }
  }

  return (
    <Modal isOpen onClose={onClose} title="Tutup buku" hideFooter>
      <form onSubmit={simpan} className="space-y-4 text-sm text-slate-200">
        <div>
          <label className={LABEL} htmlFor="tutup-sampai">
            Tutup sampai tanggal
          </label>
          <input
            id="tutup-sampai"
            type="date"
            required
            className={INPUT}
            value={sampai}
            min={batas ? geser(batas, 1) : undefined}
            max={geser(hariIni, -1)}
            onChange={(e) => setSampai(e.target.value)}
          />
        </div>
        <p>
          Saldo semua akun sampai tanggal itu dicatat sebagai potret tutup buku.
          Sesudahnya, pencatatan bertanggal sampai tanggal itu ditolak.
        </p>
        <p className="text-slate-400">
          Perangkat yang sedang tanpa jaringan baru ikut menolak setelah
          menerima tutup buku ini lewat sinkronisasi.
        </p>
        {galat ? (
          <p role="alert" className={GALAT_KOTAK}>
            {galat}
          </p>
        ) : null}
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" className={TOMBOL_KEDUA} onClick={onClose}>
            Batal
          </button>
          <button type="submit" className={TOMBOL_UTAMA} disabled={sibuk}>
            {sibuk ? "Menutup..." : "Tutup buku"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function DialogBuka({
  batas,
  onClose,
  onSelesai,
}: {
  batas: string;
  onClose: () => void;
  onSelesai: () => Promise<void>;
}) {
  const [alasan, setAlasan] = useState("");
  const [galat, setGalat] = useState<string | null>(null);
  const [sibuk, setSibuk] = useState(false);
  const isSubmittingRef = useRef(false);

  async function simpan(event: FormEvent) {
    event.preventDefault();
    if (isSubmittingRef.current) return;
    isSubmittingRef.current = true;
    setSibuk(true);
    setGalat(null);
    try {
      await bukaKembaliBuku(alasan);
      await onSelesai();
    } catch (error) {
      setGalat(pesanGalat(error, "Periode tidak bisa dibuka kembali."));
    } finally {
      isSubmittingRef.current = false;
      setSibuk(false);
    }
  }

  return (
    <Modal isOpen onClose={onClose} title="Buka kembali periode" hideFooter>
      <form onSubmit={simpan} className="space-y-4 text-sm text-slate-200">
        <p>
          Tutup buku sampai {tanggalTampil(batas)} dibuka kembali. Catatannya
          tidak dihapus: riwayat tetap menunjukkan siapa yang menutup, siapa
          yang membuka, dan alasannya.
        </p>
        <div>
          <label className={LABEL} htmlFor="buka-alasan">
            Alasan
          </label>
          <textarea
            id="buka-alasan"
            required
            maxLength={MAKS_ALASAN_BUKA}
            rows={3}
            className={INPUT}
            value={alasan}
            onChange={(e) => setAlasan(e.target.value)}
          />
        </div>
        {galat ? (
          <p role="alert" className={GALAT_KOTAK}>
            {galat}
          </p>
        ) : null}
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" className={TOMBOL_KEDUA} onClick={onClose}>
            Batal
          </button>
          <button type="submit" className={TOMBOL_BAHAYA} disabled={sibuk}>
            {sibuk ? "Membuka..." : "Buka kembali"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
