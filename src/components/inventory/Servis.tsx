"use client";

import {
  type FormEvent,
  type ReactNode,
  useCallback,
  useMemo,
  useState,
} from "react";
import { Modal } from "@/components/ui/Modal";
import {
  type BarangInventaris,
  batalkanServis,
  type DaftarInventaris,
  getRiwayatServis,
  simpanServis,
  tutupServis,
} from "@/lib/gateways/inventory";
import {
  HARI_SERVIS_LAMA,
  HASIL_SERVIS,
  type HasilServis,
  MAKS_CATATAN_SERVIS,
  MAKS_KELUHAN_SERVIS,
  MAKS_PENYEDIA_SERVIS,
  type RiwayatServis,
  type ServisInventaris,
} from "@/lib/validations/inventory";
import { tanggalTampil } from "@/lib/validations/tutup-buku";
import { eksporServis } from "./ekspor";
import {
  angka,
  INPUT,
  LABEL,
  pesanGalat,
  TOMBOL_BAHAYA,
  TOMBOL_KEDUA,
  TOMBOL_UTAMA,
} from "./gaya";

/**
 * Servis aset (v29): tab Servis, bagian servis di rincian barang, dan satu
 * dialog untuk membuka, mengubah, menutup, atau membatalkan servis. Stok
 * tidak berubah selama servis; kondisi baru dicatat backend saat ditutup.
 * Dipakai Web/Desktop dan Mobile (disalin lewat `filesToCopy`).
 */

type SubmitRef = { current: boolean };

export type AksiServis =
  | { jenis: "buka"; idBarang: string | null }
  | { jenis: "ubah" | "tutup" | "batal"; servis: ServisInventaris };

/** Servis terbuka per unit, untuk tanda di rincian barang dan opname. */
export function servisPerUnit(
  data: DaftarInventaris,
): Map<string, ServisInventaris> {
  const peta = new Map<string, ServisInventaris>();
  for (const servis of data.servis) {
    if (servis.id_unit) peta.set(servis.id_unit, servis);
  }
  return peta;
}

/** Jumlah barang tanpa unit yang sedang diservis dari satu posisi stok. */
export function jumlahDiservis(
  data: DaftarInventaris,
  idBarang: string,
  tempat: string,
  kondisi: string,
): number {
  return data.servis
    .filter(
      (s) =>
        s.id_unit === null &&
        s.id_barang === idBarang &&
        s.tempat.toLowerCase() === tempat.toLowerCase() &&
        s.kondisi_awal === kondisi,
    )
    .reduce((sum, s) => sum + s.jumlah, 0);
}

/** "di Toko Jaya sejak 20/10/2026" */
export function keteranganServis(servis: ServisInventaris): string {
  const tempat = servis.penyedia ? ` di ${servis.penyedia}` : "";
  return `sedang diservis${tempat} sejak ${tanggalTampil(servis.tanggal_mulai)}`;
}

function rupiah(nilai: number): string {
  return `Rp${angka(nilai)}`;
}

function namaServis(servis: ServisInventaris): string {
  return servis.kode_unit
    ? `${servis.nama_barang} ${servis.kode_unit}`
    : `${angka(servis.jumlah)} ${servis.nama_barang}`;
}

export function DialogServis({
  aksi,
  data,
  isSubmittingRef,
  onClose,
  onSelesai,
}: {
  aksi: AksiServis;
  data: DaftarInventaris;
  isSubmittingRef: SubmitRef;
  onClose: () => void;
  onSelesai: (message: string) => Promise<void>;
}) {
  const servis = aksi.jenis === "buka" ? null : aksi.servis;
  const hariIni = data.hari_ini;
  const asetAktif = useMemo(
    () => data.barang.filter((b) => b.tipe === "Aset" && b.status_aktif),
    [data.barang],
  );
  const [idBarang, setIdBarang] = useState(
    aksi.jenis === "buka" ? (aksi.idBarang ?? "") : "",
  );
  const [pilihanPosisi, setPilihanPosisi] = useState("");
  const [jumlah, setJumlah] = useState("1");
  const [tanggalMulai, setTanggalMulai] = useState(
    servis?.tanggal_mulai ?? hariIni,
  );
  const [penyedia, setPenyedia] = useState(servis?.penyedia ?? "");
  const [keluhan, setKeluhan] = useState(servis?.keluhan ?? "");
  const [tanggalSelesai, setTanggalSelesai] = useState(hariIni);
  const [hasil, setHasil] = useState<HasilServis>("Baik");
  const [biaya, setBiaya] = useState("");
  const [catatan, setCatatan] = useState("");
  const [alasan, setAlasan] = useState("");
  const [menyimpan, setMenyimpan] = useState(false);
  const [galat, setGalat] = useState<string | null>(null);

  const barang = asetAktif.find((b) => b.id_barang === idBarang) ?? null;
  const unitTerservis = servisPerUnit(data);
  // Unit: satu baris per unit yang masih punya stok dan belum diservis.
  // Tanpa unit: satu baris per tempat × kondisi.
  const posisi = (barang?.posisi ?? [])
    .filter((p) => p.saldo > 0)
    .filter((p) =>
      barang?.dilacak_unit
        ? p.id_batch !== null && !unitTerservis.has(p.id_batch)
        : true,
    )
    .map((p) => {
      const sisa = barang?.dilacak_unit
        ? 1
        : p.saldo -
          jumlahDiservis(data, barang?.id_barang ?? "", p.tempat, p.kondisi);
      return {
        kunci: barang?.dilacak_unit
          ? (p.id_batch ?? "")
          : `${p.tempat}|${p.kondisi}`,
        label: barang?.dilacak_unit
          ? `${p.kode_unit ?? "Unit"} · ${p.tempat} · ${p.kondisi}`
          : `${p.tempat} · ${p.kondisi} · ${angka(p.saldo)} ${barang?.satuan ?? ""}`,
        posisi: p,
        sisa,
      };
    })
    .filter((p) => p.sisa > 0);
  const dipilih = posisi.find((p) => p.kunci === pilihanPosisi) ?? null;

  const judul =
    aksi.jenis === "buka"
      ? "Catat servis"
      : aksi.jenis === "ubah"
        ? "Ubah servis"
        : aksi.jenis === "tutup"
          ? "Barang kembali dari servis"
          : "Batalkan servis";

  const kirim = async (event: FormEvent) => {
    event.preventDefault();
    if (isSubmittingRef.current) return;
    isSubmittingRef.current = true;
    setMenyimpan(true);
    setGalat(null);
    try {
      let pesan: string;
      if (aksi.jenis === "buka") {
        if (!barang || !dipilih) throw new Error("Pilih barang dan posisinya.");
        await simpanServis({
          id_barang: barang.id_barang,
          id_unit: barang.dilacak_unit ? dipilih.posisi.id_batch : null,
          jumlah: barang.dilacak_unit ? 1 : Number(jumlah.replace(/\D/g, "")),
          tempat: dipilih.posisi.tempat,
          kondisi_awal: dipilih.posisi.kondisi,
          tanggal_mulai: tanggalMulai,
          penyedia,
          keluhan,
        });
        pesan = `Servis ${barang.nama_barang} tercatat. Stok tidak berubah sampai barangnya kembali.`;
      } else if (aksi.jenis === "ubah") {
        await simpanServis({
          id_servis: aksi.servis.id_servis,
          id_barang: aksi.servis.id_barang,
          tanggal_mulai: tanggalMulai,
          penyedia,
          keluhan,
        });
        pesan = "Servis diperbarui.";
      } else if (aksi.jenis === "tutup") {
        await tutupServis({
          id_servis: aksi.servis.id_servis,
          tanggal_selesai: tanggalSelesai,
          hasil,
          biaya: Number(biaya.replace(/\D/g, "") || "0"),
          catatan_selesai: catatan,
        });
        pesan =
          hasil === "Tidak Bisa Diperbaiki"
            ? `${namaServis(aksi.servis)} tidak bisa diperbaiki. Stok tidak berubah; catat Rusak/Afkir bila barangnya dibuang.`
            : `${namaServis(aksi.servis)} kembali dari servis.`;
      } else {
        await batalkanServis(aksi.servis.id_servis, alasan);
        pesan = "Servis dibatalkan.";
      }
      await onSelesai(pesan);
    } catch (error) {
      setGalat(pesanGalat(error, "Servis tidak bisa disimpan."));
    } finally {
      isSubmittingRef.current = false;
      setMenyimpan(false);
    }
  };

  return (
    <Modal
      isOpen={true}
      onClose={onClose}
      title={judul}
      titleId="inv-servis-judul"
    >
      <form onSubmit={kirim} className="space-y-4">
        {servis ? (
          <p className="text-sm text-slate-300">
            {namaServis(servis)} dari {servis.tempat} ({servis.kondisi_awal}),
            dibawa {tanggalTampil(servis.tanggal_mulai)}
            {servis.penyedia ? ` ke ${servis.penyedia}` : ""}.
          </p>
        ) : (
          <>
            <div>
              <label htmlFor="inv-servis-barang" className={LABEL}>
                Barang
              </label>
              <select
                id="inv-servis-barang"
                required
                value={idBarang}
                onChange={(e) => {
                  setIdBarang(e.target.value);
                  setPilihanPosisi("");
                }}
                className={INPUT}
              >
                <option value="">Pilih barang aset</option>
                {asetAktif.map((b) => (
                  <option key={b.id_barang} value={b.id_barang}>
                    {b.nama_barang} ({b.kode_barang})
                  </option>
                ))}
              </select>
            </div>
            {barang ? (
              <div>
                <label htmlFor="inv-servis-posisi" className={LABEL}>
                  {barang.dilacak_unit ? "Unit" : "Diambil dari"}
                </label>
                <select
                  id="inv-servis-posisi"
                  required
                  value={pilihanPosisi}
                  onChange={(e) => setPilihanPosisi(e.target.value)}
                  className={INPUT}
                >
                  <option value="">
                    {posisi.length === 0
                      ? "Tidak ada stok yang bisa diservis"
                      : "Pilih"}
                  </option>
                  {posisi.map((p) => (
                    <option key={p.kunci} value={p.kunci}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}
            {barang && !barang.dilacak_unit ? (
              <div>
                <label htmlFor="inv-servis-jumlah" className={LABEL}>
                  Jumlah ({barang.satuan})
                </label>
                <input
                  id="inv-servis-jumlah"
                  inputMode="numeric"
                  required
                  value={jumlah}
                  onChange={(e) => setJumlah(e.target.value)}
                  className={INPUT}
                />
                {dipilih ? (
                  <p className="mt-1 text-xs text-slate-400">
                    Paling banyak {angka(dipilih.sisa)} {barang.satuan} (yang
                    belum sedang diservis).
                  </p>
                ) : null}
              </div>
            ) : null}
          </>
        )}

        {aksi.jenis === "buka" || aksi.jenis === "ubah" ? (
          <>
            <div>
              <label htmlFor="inv-servis-mulai" className={LABEL}>
                Tanggal dibawa
              </label>
              <input
                id="inv-servis-mulai"
                type="date"
                required
                max={hariIni}
                value={tanggalMulai}
                onChange={(e) => setTanggalMulai(e.target.value)}
                className={INPUT}
              />
            </div>
            <div>
              <label htmlFor="inv-servis-penyedia" className={LABEL}>
                Diservis oleh (toko atau teknisi)
              </label>
              <input
                id="inv-servis-penyedia"
                maxLength={MAKS_PENYEDIA_SERVIS}
                value={penyedia}
                onChange={(e) => setPenyedia(e.target.value)}
                className={INPUT}
              />
            </div>
            <div>
              <label htmlFor="inv-servis-keluhan" className={LABEL}>
                Keluhan
              </label>
              <textarea
                id="inv-servis-keluhan"
                required
                rows={3}
                maxLength={MAKS_KELUHAN_SERVIS}
                value={keluhan}
                onChange={(e) => setKeluhan(e.target.value)}
                className={INPUT}
              />
            </div>
          </>
        ) : null}

        {aksi.jenis === "tutup" ? (
          <>
            <div>
              <label htmlFor="inv-servis-selesai" className={LABEL}>
                Tanggal kembali
              </label>
              <input
                id="inv-servis-selesai"
                type="date"
                required
                min={aksi.servis.tanggal_mulai}
                max={hariIni}
                value={tanggalSelesai}
                onChange={(e) => setTanggalSelesai(e.target.value)}
                className={INPUT}
              />
            </div>
            <div>
              <label htmlFor="inv-servis-hasil" className={LABEL}>
                Kondisi setelah servis
              </label>
              <select
                id="inv-servis-hasil"
                value={hasil}
                onChange={(e) => setHasil(e.target.value as HasilServis)}
                className={INPUT}
              >
                {HASIL_SERVIS.map((item) => (
                  <option key={item} value={item}>
                    {item}
                  </option>
                ))}
              </select>
              <p className="mt-1 text-xs text-slate-400">
                {hasil === "Tidak Bisa Diperbaiki"
                  ? "Stok tidak berubah. Bila barangnya dibuang, catat Rusak/Afkir di Catat Mutasi."
                  : hasil === aksi.servis.kondisi_awal
                    ? "Kondisi stok tetap."
                    : `Kondisi stok berubah dari ${aksi.servis.kondisi_awal} menjadi ${hasil}.`}
              </p>
            </div>
            <div>
              <label htmlFor="inv-servis-biaya" className={LABEL}>
                Biaya servis (Rp)
              </label>
              <input
                id="inv-servis-biaya"
                inputMode="numeric"
                placeholder="0"
                value={biaya}
                onChange={(e) => setBiaya(e.target.value)}
                className={INPUT}
              />
              <p className="mt-1 text-xs text-slate-400">
                Biaya di atas 0 bisa dicatat bendahara ke pembukuan dari halaman
                Keuangan, tab Dari Inventaris.
              </p>
            </div>
            <div>
              <label htmlFor="inv-servis-catatan" className={LABEL}>
                Catatan
              </label>
              <textarea
                id="inv-servis-catatan"
                rows={2}
                maxLength={MAKS_CATATAN_SERVIS}
                value={catatan}
                onChange={(e) => setCatatan(e.target.value)}
                className={INPUT}
              />
            </div>
            <p className="text-xs text-amber-300">
              Servis yang sudah ditutup tidak bisa diubah lagi.
            </p>
          </>
        ) : null}

        {aksi.jenis === "batal" ? (
          <div>
            <label htmlFor="inv-servis-alasan" className={LABEL}>
              Alasan pembatalan
            </label>
            <textarea
              id="inv-servis-alasan"
              required
              rows={2}
              maxLength={MAKS_CATATAN_SERVIS}
              value={alasan}
              onChange={(e) => setAlasan(e.target.value)}
              className={INPUT}
            />
          </div>
        ) : null}

        {galat ? (
          <p role="alert" className="text-sm text-rose-300">
            {galat}
          </p>
        ) : null}
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" onClick={onClose} className={TOMBOL_KEDUA}>
            Kembali
          </button>
          <button
            type="submit"
            disabled={menyimpan}
            className={aksi.jenis === "batal" ? TOMBOL_BAHAYA : TOMBOL_UTAMA}
          >
            {menyimpan
              ? "Menyimpan..."
              : aksi.jenis === "batal"
                ? "Batalkan servis"
                : "Simpan"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function BarisServis({
  servis,
  canRecord,
  onAksi,
  aksiLain,
}: {
  servis: ServisInventaris;
  canRecord: boolean;
  onAksi: (aksi: AksiServis) => void;
  aksiLain?: ReactNode;
}) {
  const terbuka = servis.status === "Sedang diservis";
  const lama = terbuka && servis.lama_hari >= HARI_SERVIS_LAMA;
  return (
    <li className="flex flex-col gap-2 px-4 py-3 text-sm sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0 space-y-1">
        <p className="font-medium text-slate-100 wrap-break-word">
          {namaServis(servis)}{" "}
          <span className="font-normal text-slate-400">
            ({servis.kode_barang})
          </span>
        </p>
        <p className="text-slate-400">
          {servis.tempat} · {servis.kondisi_awal} · dibawa{" "}
          {tanggalTampil(servis.tanggal_mulai)}
          {servis.penyedia ? ` ke ${servis.penyedia}` : ""}
        </p>
        <p className="text-slate-300 wrap-break-word">{servis.keluhan}</p>
        {terbuka ? (
          <p className={lama ? "text-amber-300" : "text-slate-400"}>
            Sudah {servis.lama_hari} hari
          </p>
        ) : servis.status === "Selesai" ? (
          <p className="text-slate-400">
            Kembali {tanggalTampil(servis.tanggal_selesai ?? "")} ·{" "}
            {servis.hasil}
            {servis.biaya ? ` · ${rupiah(servis.biaya)}` : ""}
            {servis.catatan_selesai ? ` · ${servis.catatan_selesai}` : ""}
          </p>
        ) : (
          <p className="text-slate-400">
            Dibatalkan
            {servis.alasan_batal ? `: ${servis.alasan_batal}` : ""}
          </p>
        )}
      </div>
      <div className="flex shrink-0 flex-wrap gap-2">
        {terbuka && canRecord ? (
          <>
            <button
              type="button"
              onClick={() => onAksi({ jenis: "tutup", servis })}
              className={TOMBOL_UTAMA}
            >
              Sudah kembali
            </button>
            <button
              type="button"
              onClick={() => onAksi({ jenis: "ubah", servis })}
              className={TOMBOL_KEDUA}
            >
              Ubah
            </button>
            <button
              type="button"
              onClick={() => onAksi({ jenis: "batal", servis })}
              className={TOMBOL_KEDUA}
            >
              Batalkan
            </button>
          </>
        ) : null}
        {aksiLain}
      </div>
    </li>
  );
}

export function PanelServis({
  data,
  canRecord,
  canAdjust,
  onAksi,
  onAfkir,
  onInfo,
  onGalat,
}: {
  data: DaftarInventaris;
  canRecord: boolean;
  canAdjust: boolean;
  onAksi: (aksi: AksiServis) => void;
  /** Membuka Catat Mutasi untuk barang yang tidak bisa diperbaiki. */
  onAfkir: (idBarang: string) => void;
  onInfo: (message: string) => void;
  onGalat: (message: string) => void;
}) {
  const [dari, setDari] = useState(`${data.hari_ini.slice(0, 5)}01-01`);
  const [sampai, setSampai] = useState(data.hari_ini);
  const [riwayat, setRiwayat] = useState<RiwayatServis | null>(null);
  const [memuat, setMemuat] = useState(false);
  const [galat, setGalat] = useState<string | null>(null);

  const tampilkan = async (event: FormEvent) => {
    event.preventDefault();
    setMemuat(true);
    setGalat(null);
    try {
      setRiwayat(await getRiwayatServis(dari, sampai));
    } catch (error) {
      setRiwayat(null);
      setGalat(pesanGalat(error, "Riwayat servis tidak bisa dimuat."));
    } finally {
      setMemuat(false);
    }
  };

  const ekspor = async () => {
    if (!riwayat) return;
    try {
      const hasil = await eksporServis(riwayat.baris, dari, sampai);
      if (hasil.sukses)
        onInfo("Riwayat servis tersimpan sebagai berkas Excel.");
    } catch (error) {
      onGalat(pesanGalat(error, "Berkas Excel tidak bisa disimpan."));
    }
  };

  return (
    <div className="space-y-6">
      <section
        aria-labelledby="inv-servis-terbuka"
        className="p-4 rounded-xl border border-slate-800 bg-slate-900/60 space-y-3"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2
            id="inv-servis-terbuka"
            className="text-base font-semibold text-slate-100"
          >
            Sedang diservis ({data.servis.length})
          </h2>
          {canRecord ? (
            <button
              type="button"
              onClick={() => onAksi({ jenis: "buka", idBarang: null })}
              className={TOMBOL_UTAMA}
            >
              Catat servis
            </button>
          ) : null}
        </div>
        {data.servis.length === 0 ? (
          <p className="text-sm text-slate-400">
            Tidak ada barang yang sedang diservis.
          </p>
        ) : (
          <ul className="divide-y divide-slate-800 rounded-lg border border-slate-800 bg-slate-950/40">
            {data.servis.map((servis) => (
              <BarisServis
                key={servis.id_servis}
                servis={servis}
                canRecord={canRecord}
                onAksi={onAksi}
              />
            ))}
          </ul>
        )}
      </section>

      <section
        aria-labelledby="inv-servis-riwayat"
        className="p-4 rounded-xl border border-slate-800 bg-slate-900/60 space-y-3"
      >
        <h2
          id="inv-servis-riwayat"
          className="text-base font-semibold text-slate-100"
        >
          Riwayat servis
        </h2>
        <form onSubmit={tampilkan} className="flex flex-wrap items-end gap-3">
          <div>
            <label htmlFor="inv-servis-dari" className={LABEL}>
              Dibawa dari tanggal
            </label>
            <input
              id="inv-servis-dari"
              type="date"
              required
              max={sampai}
              value={dari}
              onChange={(e) => setDari(e.target.value)}
              className={INPUT}
            />
          </div>
          <div>
            <label htmlFor="inv-servis-sampai" className={LABEL}>
              Sampai tanggal
            </label>
            <input
              id="inv-servis-sampai"
              type="date"
              required
              min={dari}
              value={sampai}
              onChange={(e) => setSampai(e.target.value)}
              className={INPUT}
            />
          </div>
          <button type="submit" disabled={memuat} className={TOMBOL_KEDUA}>
            {memuat ? "Memuat..." : "Tampilkan"}
          </button>
          {riwayat && riwayat.baris.length > 0 ? (
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
        {riwayat ? (
          riwayat.baris.length === 0 ? (
            <p className="text-sm text-slate-400">
              Tidak ada servis yang dibawa pada rentang ini.
            </p>
          ) : (
            <>
              {riwayat.terpotong ? (
                <p className="text-xs text-amber-300">
                  Hanya {riwayat.baris.length} servis terbaru yang tampil.
                  Persempit rentang tanggal.
                </p>
              ) : null}
              <ul className="divide-y divide-slate-800 rounded-lg border border-slate-800 bg-slate-950/40">
                {riwayat.baris.map((servis) => (
                  <BarisServis
                    key={servis.id_servis}
                    servis={servis}
                    canRecord={canRecord}
                    onAksi={onAksi}
                    aksiLain={
                      canAdjust && servis.hasil === "Tidak Bisa Diperbaiki" ? (
                        <button
                          type="button"
                          onClick={() => onAfkir(servis.id_barang)}
                          className={TOMBOL_KEDUA}
                        >
                          Catat Rusak/Afkir
                        </button>
                      ) : undefined
                    }
                  />
                ))}
              </ul>
            </>
          )
        ) : null}
      </section>
    </div>
  );
}

/** Servis satu barang di rincian tab Barang: yang terbuka, lalu riwayatnya bila diminta. */
export function ServisBarang({
  data,
  barang,
  canRecord,
  onAksi,
}: {
  data: DaftarInventaris;
  barang: BarangInventaris;
  canRecord: boolean;
  onAksi: (aksi: AksiServis) => void;
}) {
  const terbuka = data.servis.filter((s) => s.id_barang === barang.id_barang);
  const [riwayat, setRiwayat] = useState<RiwayatServis | null>(null);
  const [galat, setGalat] = useState<string | null>(null);
  const muatRiwayat = useCallback(async () => {
    setGalat(null);
    try {
      setRiwayat(
        await getRiwayatServis("2000-01-01", data.hari_ini, barang.id_barang),
      );
    } catch (error) {
      setGalat(pesanGalat(error, "Riwayat servis tidak bisa dimuat."));
    }
  }, [barang.id_barang, data.hari_ini]);

  return (
    <div className="space-y-2 border-t border-slate-800 pt-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-slate-400">
          {terbuka.length === 0
            ? "Tidak sedang diservis."
            : `${terbuka.length} servis masih berjalan.`}
        </p>
        <div className="flex flex-wrap gap-2">
          {riwayat === null ? (
            <button
              type="button"
              onClick={() => void muatRiwayat()}
              className={TOMBOL_KEDUA}
            >
              Riwayat servis
            </button>
          ) : null}
          {canRecord && barang.status_aktif ? (
            <button
              type="button"
              onClick={() =>
                onAksi({ jenis: "buka", idBarang: barang.id_barang })
              }
              className={TOMBOL_KEDUA}
            >
              Catat servis
            </button>
          ) : null}
        </div>
      </div>
      {galat ? (
        <p role="alert" className="text-rose-300">
          {galat}
        </p>
      ) : null}
      {(riwayat?.baris ?? terbuka).length > 0 ? (
        <ul className="divide-y divide-slate-800 rounded-lg border border-slate-800 bg-slate-950/40">
          {(riwayat?.baris ?? terbuka).map((servis) => (
            <BarisServis
              key={servis.id_servis}
              servis={servis}
              canRecord={canRecord}
              onAksi={onAksi}
            />
          ))}
        </ul>
      ) : riwayat ? (
        <p className="text-slate-400">Barang ini belum pernah diservis.</p>
      ) : null}
    </div>
  );
}
