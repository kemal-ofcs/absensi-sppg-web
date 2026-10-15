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
import { PilihAkunBayar } from "@/components/keuangan/PilihAkunBayar";
import { Modal } from "@/components/ui/Modal";
import { hasPermission } from "@/lib/auth/access";
import { useAuth } from "@/lib/context/AuthContext";
import {
  cabutTunda,
  type DetailPinjaman,
  daftarPeminjam,
  daftarPinjaman,
  getPinjaman,
  lunasiPinjaman,
  type OrangPeminjam,
  type PinjamanItem,
  putuskanPinjaman,
  simpanPinjaman,
  tundaCicilan,
} from "@/lib/gateways/loan";
import { subscribeSyncCompleted } from "@/lib/gateways/sync-status";
import { formatRupiah } from "@/lib/validations/accounting";
import { AKUN_KAS, type AksiKeputusan } from "@/lib/validations/loan";

/**
 * Seluruh UI kasbon karyawan, dipakai apa adanya oleh halaman Web/Desktop dan
 * Mobile (disalin lewat `filesToCopy`). Sisa pinjaman tidak pernah dihitung
 * di sini: angkanya datang dari backend, yang menjumlahkan mutasinya.
 */

type Feedback = { tone: "success" | "error"; message: string } | null;
type Filter = "" | "Diajukan" | "Berjalan" | "Lunas" | "Ditolak" | "Dibatalkan";

const LABEL_FILTER: Record<Exclude<Filter, "">, string> = {
  Diajukan: "Menunggu persetujuan",
  Berjalan: "Sedang dicicil",
  Lunas: "Lunas",
  Ditolak: "Ditolak",
  Dibatalkan: "Dibatalkan",
};

function statusTampil(item: PinjamanItem): Exclude<Filter, ""> {
  if (item.status === "Disetujui") return item.sisa > 0 ? "Berjalan" : "Lunas";
  return item.status;
}

function bulanIni(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jakarta",
    year: "numeric",
    month: "2-digit",
  }).format(new Date());
}

function bacaNominal(teks: string): number {
  const digit = teks.replace(/\D/g, "");
  return digit ? Number(digit) : 0;
}

const GALAT_KOTAK =
  "p-3 rounded-lg border border-rose-500/30 bg-rose-500/20 text-sm text-rose-100";

export function KasbonWorkspace() {
  const { user } = useAuth();
  const bolehKelola = hasPermission(user, "loan.manage");
  const bolehPutus = hasPermission(user, "loan.approve");

  const [items, setItems] = useState<PinjamanItem[] | null>(null);
  const [galatMuat, setGalatMuat] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("");
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [formBuka, setFormBuka] = useState<PinjamanItem | "baru" | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);

  const muat = useCallback(async () => {
    setGalatMuat(null);
    try {
      setItems((await daftarPinjaman()).items);
    } catch (error) {
      setGalatMuat(pesanGalat(error, "Daftar kasbon tidak bisa dimuat."));
    }
  }, []);

  useEffect(() => {
    void muat();
  }, [muat]);
  useEffect(() => subscribeSyncCompleted(() => void muat()), [muat]);

  const tampil = useMemo(
    () =>
      (items ?? []).filter((item) => !filter || statusTampil(item) === filter),
    [items, filter],
  );

  async function selesai(pesan: string) {
    setFeedback({ tone: "success", message: pesan });
    await muat();
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-[16rem_auto] sm:items-end sm:justify-between">
        <div>
          <label className={LABEL} htmlFor="kasbon-filter">
            Status kasbon
          </label>
          <select
            id="kasbon-filter"
            className={INPUT}
            value={filter}
            onChange={(e) => setFilter(e.target.value as Filter)}
          >
            <option value="">Semua status</option>
            {(Object.keys(LABEL_FILTER) as Exclude<Filter, "">[]).map((id) => (
              <option key={id} value={id}>
                {LABEL_FILTER[id]}
              </option>
            ))}
          </select>
        </div>
        {bolehKelola ? (
          <button
            type="button"
            className={TOMBOL_UTAMA}
            onClick={() => setFormBuka("baru")}
          >
            Ajukan kasbon
          </button>
        ) : null}
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

      {galatMuat ? (
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
      ) : items === null ? (
        <p className="p-6 text-center text-sm text-slate-400">
          Memuat kasbon...
        </p>
      ) : tampil.length === 0 ? (
        <p className="p-6 text-center text-sm text-slate-400 rounded-xl border border-dashed border-slate-700">
          {items.length === 0
            ? "Belum ada kasbon yang diajukan."
            : "Tidak ada kasbon dengan status ini."}
        </p>
      ) : (
        <ul className="divide-y divide-slate-800 rounded-xl border border-slate-800 bg-slate-900/60">
          {tampil.map((item) => (
            <li key={item.id_pinjaman}>
              <button
                type="button"
                onClick={() => setDetailId(item.id_pinjaman)}
                className="w-full min-h-11 px-4 py-3 text-left hover:bg-slate-800/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500"
              >
                <span className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                  <span className="text-sm font-semibold text-slate-100">
                    {item.nama_karyawan}
                  </span>
                  <span className="text-sm text-slate-100 tabular-nums">
                    {item.status === "Disetujui"
                      ? `Sisa ${formatRupiah(Math.max(0, item.sisa))}`
                      : `Diajukan ${formatRupiah(item.pokok)}`}
                  </span>
                </span>
                <span className="mt-1 flex flex-wrap gap-2 text-xs text-slate-400">
                  <span className="text-slate-300">
                    {LABEL_FILTER[statusTampil(item)]}
                  </span>
                  {item.status === "Disetujui" ? (
                    <span>Pokok {formatRupiah(item.pokok)}</span>
                  ) : null}
                  <span>Cicilan {formatRupiah(item.cicilan)}</span>
                  <span>Mulai {item.mulai_potong}</span>
                  {item.potongan_tertunda > 0 ? (
                    <span>
                      {formatRupiah(item.potongan_tertunda)} menunggu gaji
                      dibayar
                    </span>
                  ) : null}
                  {item.tunda.length > 0 ? (
                    <span>Ditunda: {item.tunda.join(", ")}</span>
                  ) : null}
                  {item.lebih_potong ? (
                    <span className="rounded px-1.5 border border-amber-500/30 bg-amber-500/20 text-amber-100">
                      Lebih potong {formatRupiah(-item.sisa)}
                    </span>
                  ) : null}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {formBuka ? (
        <DialogPengajuan
          awal={formBuka === "baru" ? null : formBuka}
          onClose={() => setFormBuka(null)}
          onTersimpan={async () => {
            setFormBuka(null);
            await selesai("Pengajuan kasbon tersimpan.");
          }}
        />
      ) : null}
      {detailId ? (
        <DialogDetail
          idPinjaman={detailId}
          bolehKelola={bolehKelola}
          bolehPutus={bolehPutus}
          onClose={() => setDetailId(null)}
          onUbah={(item) => {
            setDetailId(null);
            setFormBuka(item);
          }}
          onSelesai={async (pesan) => {
            setDetailId(null);
            await selesai(pesan);
          }}
        />
      ) : null}
    </div>
  );
}

function DialogPengajuan({
  awal,
  onClose,
  onTersimpan,
}: {
  awal: PinjamanItem | null;
  onClose: () => void;
  onTersimpan: () => Promise<void>;
}) {
  const [orang, setOrang] = useState<OrangPeminjam[] | null>(null);
  const [idKaryawan, setIdKaryawan] = useState(awal?.id_karyawan ?? "");
  const [pokok, setPokok] = useState(awal ? String(awal.pokok) : "");
  const [cicilan, setCicilan] = useState(awal ? String(awal.cicilan) : "");
  const [mulai, setMulai] = useState(awal?.mulai_potong ?? bulanIni());
  const [keterangan, setKeterangan] = useState(awal?.keterangan ?? "");
  const [galat, setGalat] = useState<string | null>(null);
  const [menyimpan, setMenyimpan] = useState(false);
  const isSubmittingRef = useRef(false);

  useEffect(() => {
    let aktif = true;
    daftarPeminjam()
      .then((hasil) => aktif && setOrang(hasil.items))
      .catch(
        (error) =>
          aktif &&
          setGalat(pesanGalat(error, "Daftar personil tidak bisa dimuat.")),
      );
    return () => {
      aktif = false;
    };
  }, []);

  const jumlahBulan =
    bacaNominal(cicilan) > 0
      ? Math.ceil(bacaNominal(pokok) / bacaNominal(cicilan))
      : 0;

  async function simpan(event: FormEvent) {
    event.preventDefault();
    if (isSubmittingRef.current) return;
    isSubmittingRef.current = true;
    setMenyimpan(true);
    setGalat(null);
    try {
      await simpanPinjaman({
        id_pinjaman: awal?.id_pinjaman ?? null,
        id_karyawan: idKaryawan,
        pokok: bacaNominal(pokok),
        cicilan: bacaNominal(cicilan),
        mulai_potong: mulai,
        keterangan: keterangan.trim() || null,
      });
      await onTersimpan();
    } catch (error) {
      setGalat(pesanGalat(error, "Pengajuan tidak bisa disimpan."));
    } finally {
      isSubmittingRef.current = false;
      setMenyimpan(false);
    }
  }

  return (
    <Modal
      isOpen
      onClose={onClose}
      title={awal ? "Ubah pengajuan kasbon" : "Ajukan kasbon"}
      hideFooter
    >
      <form onSubmit={simpan} className="space-y-3">
        <div>
          <label className={LABEL} htmlFor="kasbon-orang">
            Peminjam
          </label>
          <select
            id="kasbon-orang"
            required
            className={INPUT}
            value={idKaryawan}
            disabled={orang === null}
            onChange={(e) => setIdKaryawan(e.target.value)}
          >
            <option value="">
              {orang === null ? "Memuat personil..." : "Pilih personil"}
            </option>
            {(orang ?? []).map((item) => (
              <option key={item.id_karyawan} value={item.id_karyawan}>
                {item.nama} ({item.divisi})
              </option>
            ))}
          </select>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className={LABEL} htmlFor="kasbon-pokok">
              Jumlah pinjaman
            </label>
            <input
              id="kasbon-pokok"
              required
              inputMode="numeric"
              className={`${INPUT} text-right tabular-nums`}
              value={pokok}
              onChange={(e) => setPokok(e.target.value)}
            />
          </div>
          <div>
            <label className={LABEL} htmlFor="kasbon-cicilan">
              Cicilan per proses gaji
            </label>
            <input
              id="kasbon-cicilan"
              required
              inputMode="numeric"
              className={`${INPUT} text-right tabular-nums`}
              value={cicilan}
              onChange={(e) => setCicilan(e.target.value)}
            />
          </div>
        </div>
        <div>
          <label className={LABEL} htmlFor="kasbon-mulai">
            Mulai dipotong dari gaji bulan
          </label>
          <input
            id="kasbon-mulai"
            type="month"
            required
            className={INPUT}
            value={mulai}
            onChange={(e) => setMulai(e.target.value)}
          />
        </div>
        <div>
          <label className={LABEL} htmlFor="kasbon-keterangan">
            Keterangan singkat (opsional)
          </label>
          <input
            id="kasbon-keterangan"
            maxLength={100}
            className={INPUT}
            value={keterangan}
            onChange={(e) => setKeterangan(e.target.value)}
          />
          <p className="mt-1 text-xs text-slate-400">
            Data kasbon tersalin ke semua perangkat perusahaan. Tulis
            seperlunya.
          </p>
        </div>
        {jumlahBulan > 0 ? (
          <p className="text-xs text-slate-400" aria-live="polite">
            Lunas dalam {jumlahBulan} kali potong gaji bila tidak ada penundaan.
          </p>
        ) : null}
        {galat ? (
          <p role="alert" className={GALAT_KOTAK}>
            {galat}
          </p>
        ) : null}
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" className={TOMBOL_KEDUA} onClick={onClose}>
            Batal
          </button>
          <button type="submit" className={TOMBOL_UTAMA} disabled={menyimpan}>
            {menyimpan ? "Menyimpan..." : "Simpan pengajuan"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function DialogDetail({
  idPinjaman,
  bolehKelola,
  bolehPutus,
  onClose,
  onUbah,
  onSelesai,
}: {
  idPinjaman: string;
  bolehKelola: boolean;
  bolehPutus: boolean;
  onClose: () => void;
  onUbah: (item: PinjamanItem) => void;
  onSelesai: (pesan: string) => Promise<void>;
}) {
  const [detail, setDetail] = useState<DetailPinjaman | null>(null);
  const [ringkas, setRingkas] = useState<PinjamanItem | null>(null);
  const [galatMuat, setGalatMuat] = useState<string | null>(null);
  const [galat, setGalat] = useState<string | null>(null);
  const [akunKas, setAkunKas] = useState(AKUN_KAS);
  const [jumlahLunas, setJumlahLunas] = useState("");
  const [bulanTunda, setBulanTunda] = useState(bulanIni());
  const [alasanTunda, setAlasanTunda] = useState("");
  const [konfirmasi, setKonfirmasi] = useState<AksiKeputusan | null>(null);
  const [sibuk, setSibuk] = useState(false);
  const isSubmittingRef = useRef(false);

  const muat = useCallback(async () => {
    try {
      const [hasil, daftar] = await Promise.all([
        getPinjaman(idPinjaman),
        daftarPinjaman(),
      ]);
      setDetail(hasil);
      setRingkas(
        daftar.items.find((item) => item.id_pinjaman === idPinjaman) ?? null,
      );
    } catch (error) {
      setGalatMuat(pesanGalat(error, "Kasbon tidak bisa dimuat."));
    }
  }, [idPinjaman]);

  useEffect(() => {
    void muat();
  }, [muat]);

  async function jalankan(kerja: () => Promise<string>, cadangan: string) {
    if (isSubmittingRef.current) return;
    isSubmittingRef.current = true;
    setSibuk(true);
    setGalat(null);
    try {
      await onSelesai(await kerja());
    } catch (error) {
      setGalat(pesanGalat(error, cadangan));
      setKonfirmasi(null);
    } finally {
      isSubmittingRef.current = false;
      setSibuk(false);
    }
  }

  const pinjaman = detail?.pinjaman;
  const adaAngsuran = (detail?.mutasi ?? []).some(
    (item) =>
      item.jenis === "Angsuran Gaji" || item.jenis === "Pelunasan Tunai",
  );
  const sisaBisaDilunasi = ringkas
    ? Math.max(0, ringkas.sisa - ringkas.potongan_tertunda)
    : 0;

  return (
    <Modal
      isOpen
      onClose={onClose}
      title={pinjaman ? `Kasbon ${pinjaman.nama_karyawan}` : "Detail kasbon"}
      maxWidth="max-w-2xl"
      hideFooter
    >
      {galatMuat ? (
        <p className={GALAT_KOTAK}>{galatMuat}</p>
      ) : !pinjaman || !detail ? (
        <p className="text-sm text-slate-400">Memuat kasbon...</p>
      ) : (
        <div className="space-y-4 text-sm">
          <dl className="grid gap-2 grid-cols-2">
            <div>
              <dt className="text-xs text-slate-400">Status</dt>
              <dd className="text-slate-100">
                {ringkas
                  ? LABEL_FILTER[statusTampil(ringkas)]
                  : pinjaman.status}
              </dd>
            </div>
            {pinjaman.status === "Disetujui" ? (
              <div>
                <dt className="text-xs text-slate-400">Sisa</dt>
                <dd className="text-slate-100 tabular-nums">
                  {formatRupiah(Math.max(0, ringkas?.sisa ?? 0))}
                </dd>
              </div>
            ) : null}
            <div>
              <dt className="text-xs text-slate-400">Pokok</dt>
              <dd className="text-slate-100 tabular-nums">
                {formatRupiah(pinjaman.pokok)}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-slate-400">
                Cicilan per proses gaji
              </dt>
              <dd className="text-slate-100 tabular-nums">
                {formatRupiah(pinjaman.cicilan)}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-slate-400">Mulai dipotong</dt>
              <dd className="text-slate-100">{pinjaman.mulai_potong}</dd>
            </div>
            <div>
              <dt className="text-xs text-slate-400">Diajukan oleh</dt>
              <dd className="text-slate-100">
                {pinjaman.diajukan_oleh}, {pinjaman.tanggal_pengajuan}
              </dd>
            </div>
            {pinjaman.keterangan ? (
              <div className="col-span-2">
                <dt className="text-xs text-slate-400">Keterangan</dt>
                <dd className="text-slate-100 break-words">
                  {pinjaman.keterangan}
                </dd>
              </div>
            ) : null}
          </dl>

          <section className="space-y-2">
            <h3 className="text-sm font-semibold text-slate-200">Riwayat</h3>
            {detail.mutasi.length === 0 ? (
              <p className="text-xs text-slate-400">
                Belum ada uang yang berpindah untuk kasbon ini.
              </p>
            ) : (
              <ul className="divide-y divide-slate-800 rounded-lg border border-slate-800">
                {detail.mutasi.map((item) => (
                  <li
                    key={item.id_mutasi}
                    className="flex flex-wrap justify-between gap-2 px-3 py-2"
                  >
                    <span className="text-slate-100">
                      {item.jenis}
                      <span className="block text-xs text-slate-400">
                        {item.tanggal}, oleh {item.dicatat_oleh}
                      </span>
                    </span>
                    <span className="text-slate-100 tabular-nums">
                      {formatRupiah(item.jumlah)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {detail.tunda.length > 0 ? (
            <section className="space-y-2">
              <h3 className="text-sm font-semibold text-slate-200">
                Cicilan ditunda
              </h3>
              <ul className="divide-y divide-slate-800 rounded-lg border border-slate-800">
                {detail.tunda.map((item) => (
                  <li
                    key={item.id_tunda}
                    className="flex flex-wrap items-center justify-between gap-2 px-3 py-2"
                  >
                    <span className="text-slate-100">
                      {item.periode}
                      {item.alasan ? (
                        <span className="block text-xs text-slate-400">
                          {item.alasan}
                        </span>
                      ) : null}
                    </span>
                    {bolehKelola ? (
                      <button
                        type="button"
                        className={TOMBOL_KEDUA}
                        disabled={sibuk}
                        aria-label={`Cabut penundaan ${item.periode}`}
                        onClick={() =>
                          void jalankan(async () => {
                            await cabutTunda(item.id_tunda);
                            return `Penundaan ${item.periode} dicabut.`;
                          }, "Penundaan tidak bisa dicabut.")
                        }
                      >
                        Cabut
                      </button>
                    ) : null}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {galat ? (
            <p role="alert" className={GALAT_KOTAK}>
              {galat}
            </p>
          ) : null}

          {pinjaman.status === "Diajukan" && (bolehKelola || bolehPutus) ? (
            <section className="space-y-3 p-3 rounded-lg border border-slate-800">
              {bolehPutus ? (
                <PilihAkunBayar
                  id="kasbon-akun-cair"
                  label="Dicairkan dari akun"
                  value={akunKas}
                  onChange={setAkunKas}
                />
              ) : null}
              <div className="flex flex-wrap gap-2">
                {bolehPutus ? (
                  <button
                    type="button"
                    className={TOMBOL_UTAMA}
                    disabled={sibuk}
                    onClick={() =>
                      void jalankan(async () => {
                        await putuskanPinjaman(idPinjaman, "setujui", akunKas);
                        return `Kasbon ${pinjaman.nama_karyawan} disetujui dan dicairkan.`;
                      }, "Kasbon tidak bisa disetujui.")
                    }
                  >
                    Setujui dan cairkan
                  </button>
                ) : null}
                {bolehPutus ? (
                  konfirmasi === "tolak" ? (
                    <button
                      type="button"
                      className={TOMBOL_BAHAYA}
                      disabled={sibuk}
                      onClick={() =>
                        void jalankan(async () => {
                          await putuskanPinjaman(idPinjaman, "tolak", null);
                          return `Pengajuan ${pinjaman.nama_karyawan} ditolak.`;
                        }, "Pengajuan tidak bisa ditolak.")
                      }
                    >
                      Ya, tolak pengajuan
                    </button>
                  ) : (
                    <button
                      type="button"
                      className={TOMBOL_KEDUA}
                      onClick={() => setKonfirmasi("tolak")}
                    >
                      Tolak
                    </button>
                  )
                ) : null}
                {bolehKelola && ringkas ? (
                  <button
                    type="button"
                    className={TOMBOL_KEDUA}
                    onClick={() => onUbah(ringkas)}
                  >
                    Ubah pengajuan
                  </button>
                ) : null}
              </div>
            </section>
          ) : null}

          {pinjaman.status === "Disetujui" &&
          bolehKelola &&
          sisaBisaDilunasi > 0 ? (
            <form
              className="space-y-3 p-3 rounded-lg border border-slate-800"
              onSubmit={(event) => {
                event.preventDefault();
                void jalankan(async () => {
                  const jumlah = bacaNominal(jumlahLunas);
                  await lunasiPinjaman(idPinjaman, jumlah, akunKas);
                  return `Pelunasan ${formatRupiah(jumlah)} tercatat.`;
                }, "Pelunasan tidak bisa dicatat.");
              }}
            >
              <h3 className="text-sm font-semibold text-slate-200">
                Pelunasan tunai
              </h3>
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label className={LABEL} htmlFor="kasbon-jumlah-lunas">
                    Jumlah dibayar
                  </label>
                  <input
                    id="kasbon-jumlah-lunas"
                    required
                    inputMode="numeric"
                    className={`${INPUT} text-right tabular-nums`}
                    value={jumlahLunas}
                    onChange={(e) => setJumlahLunas(e.target.value)}
                  />
                </div>
                <PilihAkunBayar
                  id="kasbon-akun-lunas"
                  label="Diterima ke akun"
                  value={akunKas}
                  onChange={setAkunKas}
                />
              </div>
              <p className="text-xs text-slate-400">
                Paling banyak {formatRupiah(sisaBisaDilunasi)}
                {ringkas && ringkas.potongan_tertunda > 0
                  ? `, karena ${formatRupiah(ringkas.potongan_tertunda)} sudah masuk proses gaji yang belum dibayar`
                  : ""}
                .
              </p>
              <button type="submit" className={TOMBOL_UTAMA} disabled={sibuk}>
                Catat pelunasan
              </button>
            </form>
          ) : null}

          {pinjaman.status === "Disetujui" &&
          bolehKelola &&
          sisaBisaDilunasi > 0 ? (
            <form
              className="space-y-3 p-3 rounded-lg border border-slate-800"
              onSubmit={(event) => {
                event.preventDefault();
                void jalankan(async () => {
                  await tundaCicilan(
                    idPinjaman,
                    bulanTunda,
                    alasanTunda.trim() || null,
                  );
                  return `Cicilan bulan ${bulanTunda} ditunda.`;
                }, "Cicilan tidak bisa ditunda.");
              }}
            >
              <h3 className="text-sm font-semibold text-slate-200">
                Tunda cicilan satu bulan
              </h3>
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label className={LABEL} htmlFor="kasbon-bulan-tunda">
                    Bulan gaji yang tidak dipotong
                  </label>
                  <input
                    id="kasbon-bulan-tunda"
                    type="month"
                    required
                    className={INPUT}
                    value={bulanTunda}
                    onChange={(e) => setBulanTunda(e.target.value)}
                  />
                </div>
                <div>
                  <label className={LABEL} htmlFor="kasbon-alasan-tunda">
                    Alasan (opsional)
                  </label>
                  <input
                    id="kasbon-alasan-tunda"
                    maxLength={100}
                    className={INPUT}
                    value={alasanTunda}
                    onChange={(e) => setAlasanTunda(e.target.value)}
                  />
                </div>
              </div>
              <button type="submit" className={TOMBOL_KEDUA} disabled={sibuk}>
                Tunda cicilan
              </button>
            </form>
          ) : null}

          {pinjaman.status === "Disetujui" && bolehPutus && !adaAngsuran ? (
            <div className="flex flex-wrap items-center gap-2">
              {konfirmasi === "batalkan" ? (
                <button
                  type="button"
                  className={TOMBOL_BAHAYA}
                  disabled={sibuk}
                  onClick={() =>
                    void jalankan(async () => {
                      await putuskanPinjaman(idPinjaman, "batalkan", null);
                      return `Pencairan kasbon ${pinjaman.nama_karyawan} dibatalkan.`;
                    }, "Kasbon tidak bisa dibatalkan.")
                  }
                >
                  Ya, batalkan pencairan
                </button>
              ) : (
                <button
                  type="button"
                  className={TOMBOL_KEDUA}
                  onClick={() => setKonfirmasi("batalkan")}
                >
                  Batalkan pencairan
                </button>
              )}
              <p className="text-xs text-slate-400">
                Hanya bila uangnya belum diterima. Jurnal pencairannya dibalik,
                tidak dihapus.
              </p>
            </div>
          ) : null}
        </div>
      )}
    </Modal>
  );
}
