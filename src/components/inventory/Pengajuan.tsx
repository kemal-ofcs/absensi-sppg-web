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
import { optimizeImageFile } from "@/lib/client/image-optimizer";
import { useAuth } from "@/lib/context/AuthContext";
import type { DaftarInventaris } from "@/lib/gateways/inventory";
import {
  ambilFotoPenerimaan,
  batalkanPengajuan,
  catatPenerimaan,
  type DaftarPengajuan,
  type FotoPenerimaan,
  getPengajuan,
  type HasilPenerimaan,
  type PenerimaanPengajuan,
  type Pengajuan,
  type PengajuanDraft,
  putuskanPengajuan,
  type StatusPengajuan,
  simpanPengajuan,
  tutupPengajuan,
} from "@/lib/gateways/inventory-pengajuan";
import { subscribeSyncCompleted } from "@/lib/gateways/sync-status";
import { formatRupiah } from "@/lib/validations/accounting";
import {
  jumlahDariKetikan,
  KONDISI_BARANG,
  type KondisiBarang,
  TIPE_BARANG,
  type TipeBarang,
} from "@/lib/validations/inventory";
import {
  MAKS_BARIS_PENGAJUAN,
  MAKS_CATATAN_PENGAJUAN,
  MAKS_FOTO_BASE64,
  MAKS_FOTO_PENERIMAAN,
  MAKS_KEPERLUAN,
  MAKS_NAMA_BARANG,
  MAKS_SATUAN,
  MAKS_SUMBER_DANA,
  nilaiBaris,
  STATUS_PENGAJUAN,
  validatePemutus,
} from "@/lib/validations/inventory-pengajuan";
import { tanggalTampil } from "@/lib/validations/tutup-buku";
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
import { DialogLabel, MAKS_LABEL_PER_BARANG } from "./LabelQr";
import { bisaCetakBeritaAcara } from "./PanelPemantauan";

/**
 * Pengajuan pembelian (v30): tab Pengajuan di Inventaris (ajukan, terima
 * barang berfoto, cetak label), dan bagian persetujuan serta laporan
 * penerimaan di Keuangan (tab Dari Inventaris). Status, total, dan jumlah
 * diterima dihitung backend. Dipakai Web/Desktop dan Mobile (disalin lewat
 * `filesToCopy`).
 */

type SubmitRef = { current: boolean };

const WARNA_STATUS: Record<StatusPengajuan, string> = {
  Menunggu: "text-amber-300",
  Disetujui: "text-sky-300",
  "Diterima sebagian": "text-sky-300",
  Selesai: "text-emerald-300",
  Ditolak: "text-rose-300",
  Dibatalkan: "text-slate-400",
};

/** Tanda angka tab Pengajuan: di-ACC, barangnya belum diterima penuh. */
export function jumlahPerluDiterima(daftar: DaftarPengajuan): number {
  return daftar.pengajuan.filter(
    (p) => p.status === "Disetujui" || p.status === "Diterima sebagian",
  ).length;
}

/** Tanda angka tab Dari Inventaris di Keuangan. */
export function jumlahMenunggu(daftar: DaftarPengajuan): number {
  return daftar.pengajuan.filter((p) => p.status === "Menunggu").length;
}

function keteranganStatus(p: Pengajuan): string {
  switch (p.status) {
    case "Menunggu":
      return ` · diajukan ${p.diajukan_oleh}`;
    case "Disetujui":
    case "Diterima sebagian":
      return ` · ACC ${p.disetujui_oleh ?? ""}`;
    case "Selesai":
      return p.ditutup_pada ? ` · ditutup: ${p.alasan_tutup ?? ""}` : "";
    case "Ditolak":
      return ` · ${p.ditolak_oleh ?? ""}: ${p.alasan_tolak ?? ""}`;
    case "Dibatalkan":
      return `: ${p.alasan_batal ?? ""}`;
  }
}

/** Baris barang satu pengajuan, dipakai Inventaris dan Keuangan. */
export function RincianPengajuan({ pengajuan }: { pengajuan: Pengajuan }) {
  const disetujui = pengajuan.disetujui_pada !== null;
  const sudahDiterima = pengajuan.penerimaan.length > 0;
  return (
    <div className="space-y-2">
      {pengajuan.sumber_dana || pengajuan.catatan ? (
        <p className="text-slate-400 wrap-break-word">
          {pengajuan.sumber_dana ? `Sumber dana: ${pengajuan.sumber_dana}` : ""}
          {pengajuan.sumber_dana && pengajuan.catatan ? " · " : ""}
          {pengajuan.catatan ?? ""}
        </p>
      ) : null}
      {pengajuan.catatan_persetujuan ? (
        <p className="text-slate-400 wrap-break-word">
          Catatan akuntansi: {pengajuan.catatan_persetujuan}
        </p>
      ) : null}
      <ul className="divide-y divide-slate-800 rounded-lg border border-slate-800 bg-slate-950/40">
        {pengajuan.baris.map((b) => (
          <li
            key={b.id_baris}
            className="flex flex-col gap-1 px-3 py-2 sm:flex-row sm:justify-between sm:gap-4"
          >
            <span className="min-w-0 text-slate-200 wrap-break-word">
              {b.nama_barang}
              <span className="text-slate-400">
                {b.kode_barang
                  ? ` (${b.kode_barang})`
                  : b.id_barang === null
                    ? " · barang baru"
                    : ""}
              </span>
            </span>
            <span className="shrink-0 text-slate-400">
              {angka(b.jumlah, b.desimal)} {b.satuan} ×{" "}
              {formatRupiah(b.harga_satuan)} = {formatRupiah(b.nilai)}
              {disetujui ? ` · diterima ${angka(b.diterima, b.desimal)}` : ""}
              {b.diterima > b.jumlah ? (
                <span className="text-amber-300"> · melebihi ACC</span>
              ) : null}
              {sudahDiterima && b.diterima < b.jumlah ? (
                <span className="text-amber-300">
                  {" "}
                  · kurang {angka(b.jumlah - b.diterima, b.desimal)}
                </span>
              ) : null}
              {b.harga_diterima.some(
                (h) => h.harga_satuan !== b.harga_satuan,
              ) ? (
                <span className="text-amber-300">
                  {" "}
                  · harga sebenarnya{" "}
                  {b.harga_diterima
                    .map((h) => formatRupiah(h.harga_satuan))
                    .join(", ")}
                </span>
              ) : null}
            </span>
          </li>
        ))}
      </ul>
      {pengajuan.penerimaan.length > 0 ? (
        <ul className="space-y-2">
          {pengajuan.penerimaan.map((t) => (
            <li key={t.id_penerimaan} className="space-y-1">
              <p className="text-slate-400 wrap-break-word">
                Diterima {tanggalTampil(t.tanggal)} oleh {t.dicatat_oleh}
                {t.catatan ? ` · ${t.catatan}` : ""}
              </p>
              <TombolFoto penerimaan={t} />
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function DialogFoto({
  idFoto,
  judul,
  onClose,
}: {
  idFoto: string;
  judul: string;
  onClose: () => void;
}) {
  // undefined = memuat, null = belum ada salinannya.
  const [foto, setFoto] = useState<FotoPenerimaan | null | undefined>(
    undefined,
  );
  const [galat, setGalat] = useState<string | null>(null);
  useEffect(() => {
    let aktif = true;
    ambilFotoPenerimaan(idFoto).then(
      (hasil) => {
        if (aktif) setFoto(hasil);
      },
      (error) => {
        if (aktif) setGalat(pesanGalat(error, "Foto tidak bisa dimuat."));
      },
    );
    return () => {
      aktif = false;
    };
  }, [idFoto]);

  return (
    <Modal
      isOpen={true}
      onClose={onClose}
      title={judul}
      titleId="inv-pgj-foto-judul"
      maxWidth="max-w-3xl"
    >
      {galat ? (
        <p role="alert" className="text-sm text-rose-300">
          {galat}
        </p>
      ) : foto === undefined ? (
        <p className="text-sm text-slate-400">Memuat foto...</p>
      ) : foto === null ? (
        <p className="text-sm text-amber-300">
          Foto belum terkirim dari perangkat pencatat, atau perangkat ini sedang
          offline.
        </p>
      ) : (
        // biome-ignore lint/performance/noImgElement: sumbernya data URI dari database, bukan aset statis
        <img
          src={`data:${foto.mime_type};base64,${foto.data_base64}`}
          alt={judul}
          className="mx-auto max-h-[70vh] w-auto rounded-lg"
        />
      )}
    </Modal>
  );
}

/** Satu tombol per foto; fotonya ditarik saat diketuk, tidak ikut daftar. */
function TombolFoto({ penerimaan }: { penerimaan: PenerimaanPengajuan }) {
  const [buka, setBuka] = useState<number | null>(null);
  return (
    <div className="flex flex-wrap gap-2">
      {Array.from({ length: penerimaan.jumlah_foto }, (_, indeks) => (
        <button
          // biome-ignore lint/suspicious/noArrayIndexKey: foto berurutan tetap 1..jumlah_foto
          key={indeks}
          type="button"
          onClick={() => setBuka(indeks + 1)}
          className={TOMBOL_KEDUA}
        >
          Foto {indeks + 1}
        </button>
      ))}
      {buka ? (
        <DialogFoto
          idFoto={`${penerimaan.id_penerimaan}-${buka}`}
          judul={`Foto ${buka}, diterima ${tanggalTampil(penerimaan.tanggal)}`}
          onClose={() => setBuka(null)}
        />
      ) : null}
    </div>
  );
}

type IsianTerima = {
  jumlah: string;
  harga: string;
  tempat: string;
  kondisi: KondisiBarang;
  expired: string;
  perUnit: boolean;
  // Hanya barang baru.
  tipe: TipeBarang;
  kategori: string;
  bisaExpired: boolean;
};

type FotoTerpilih = { kunci: number; nama: string; base64: string };

function DialogPenerimaan({
  data,
  pengajuan,
  isSubmittingRef,
  onClose,
  onSelesai,
}: {
  data: DaftarInventaris;
  pengajuan: Pengajuan;
  isSubmittingRef: SubmitRef;
  onClose: () => void;
  onSelesai: (hasil: HasilPenerimaan) => Promise<void>;
}) {
  const sisa = pengajuan.baris.filter((b) => b.diterima < b.jumlah);
  const barangDari = (idBarang: string | null) =>
    idBarang
      ? (data.barang.find((x) => x.id_barang === idBarang) ?? null)
      : null;
  const tanggalAcc = (pengajuan.disetujui_pada ?? "").slice(0, 10);
  const [tanggal, setTanggal] = useState(data.hari_ini);
  const [catatan, setCatatan] = useState("");
  const [isian, setIsian] = useState<Record<string, IsianTerima>>(() =>
    Object.fromEntries(
      sisa.map((b) => [
        b.id_baris,
        {
          jumlah: "",
          harga: angka(b.harga_satuan),
          tempat: barangDari(b.barang_terdaftar)?.tempat_utama ?? "",
          kondisi: "Baik",
          expired: "",
          perUnit: false,
          tipe: "Habis Pakai",
          kategori: "",
          bisaExpired: false,
        },
      ]),
    ),
  );
  const [foto, setFoto] = useState<FotoTerpilih[]>([]);
  const kunciFoto = useRef(0);
  const [mengompres, setMengompres] = useState(false);
  const [menyimpan, setMenyimpan] = useState(false);
  const [galat, setGalat] = useState<string | null>(null);

  const ubah = (idBaris: string, isi: Partial<IsianTerima>) =>
    setIsian((lama) => ({
      ...lama,
      [idBaris]: { ...(lama[idBaris] as IsianTerima), ...isi },
    }));

  /** Kedaluwarsa dan pilihan per unit menurut barang terdaftar atau isian barang baru. */
  const aturan = (idBarangTerdaftar: string | null, i: IsianTerima) => {
    const barang = barangDari(idBarangTerdaftar);
    const bisaExpired = barang ? barang.bisa_expired : i.bisaExpired;
    const bolehPerUnit = barang
      ? barang.tipe === "Aset" && !barang.dilacak_unit && !bisaExpired
      : i.tipe === "Aset" && !bisaExpired;
    return { barang, bisaExpired, bolehPerUnit };
  };

  const tambahFoto = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setMengompres(true);
    setGalat(null);
    try {
      const baru: FotoTerpilih[] = [];
      for (const file of Array.from(files)) {
        if (foto.length + baru.length >= MAKS_FOTO_PENERIMAAN) break;
        const hasil = await optimizeImageFile(file, {
          maxWidth: 1280,
          maxHeight: 1280,
          quality: 0.72,
          mimeType: "image/jpeg",
          fit: "shrink",
        });
        const base64 = hasil.dataUrl.slice(hasil.dataUrl.indexOf(",") + 1);
        if (base64.length > MAKS_FOTO_BASE64) {
          throw new Error(
            `${file.name} masih terlalu besar setelah dikompres. Pilih foto lain.`,
          );
        }
        kunciFoto.current += 1;
        baru.push({ kunci: kunciFoto.current, nama: file.name, base64 });
      }
      setFoto((lama) => [...lama, ...baru].slice(0, MAKS_FOTO_PENERIMAAN));
    } catch (error) {
      setGalat(pesanGalat(error, "Foto tidak bisa dibaca."));
    } finally {
      setMengompres(false);
    }
  };

  const kirim = async (event: FormEvent) => {
    event.preventDefault();
    if (isSubmittingRef.current) return;
    isSubmittingRef.current = true;
    setMenyimpan(true);
    setGalat(null);
    try {
      const baris = sisa.flatMap((b) => {
        const i = isian[b.id_baris];
        if (!i || i.jumlah.trim() === "") return [];
        const jumlah = bacaJumlah(
          i.jumlah,
          b.desimal,
          `Jumlah diterima ${b.nama_barang}`,
        );
        if (jumlah === 0) return [];
        const { barang, bisaExpired, bolehPerUnit } = aturan(
          b.barang_terdaftar,
          i,
        );
        return [
          {
            id_baris: b.id_baris,
            jumlah,
            harga_satuan: bacaHarga(i.harga, b.urutan),
            tempat: i.tempat,
            kondisi: i.kondisi,
            tanggal_expired: bisaExpired ? i.expired : null,
            per_unit: bolehPerUnit && i.perUnit,
            tipe: barang ? null : i.tipe,
            kategori: barang ? null : i.kategori,
            bisa_expired: barang ? false : i.bisaExpired,
          },
        ];
      });
      const hasil = await catatPenerimaan({
        id_pengajuan: pengajuan.id_pengajuan,
        tanggal,
        catatan,
        baris,
        foto: foto.map((f) => ({
          mime_type: "image/jpeg",
          data_base64: f.base64,
        })),
      });
      await onSelesai(hasil);
    } catch (error) {
      setGalat(pesanGalat(error, "Penerimaan tidak bisa disimpan."));
    } finally {
      isSubmittingRef.current = false;
      setMenyimpan(false);
    }
  };

  return (
    <Modal
      isOpen={true}
      onClose={onClose}
      title={`Penerimaan ${pengajuan.nomor}`}
      titleId="inv-pgj-terima-judul"
      maxWidth="max-w-3xl"
    >
      <form onSubmit={kirim} className="space-y-4 text-sm">
        <p className="text-slate-300 wrap-break-word">
          {pengajuan.keperluan}. Isi hanya barang yang sudah datang; sisanya
          bisa dicatat di penerimaan berikutnya.
        </p>
        <div>
          <label htmlFor="inv-pgj-terima-tanggal" className={LABEL}>
            Tanggal terima
          </label>
          <input
            id="inv-pgj-terima-tanggal"
            type="date"
            required
            min={tanggalAcc}
            max={data.hari_ini}
            value={tanggal}
            onChange={(e) => setTanggal(e.target.value)}
            className={INPUT}
          />
        </div>

        {sisa.map((b) => {
          const i = isian[b.id_baris] as IsianTerima;
          const { barang, bisaExpired, bolehPerUnit } = aturan(
            b.barang_terdaftar,
            i,
          );
          const id = `inv-pgj-terima-${b.urutan}`;
          return (
            <fieldset
              key={b.id_baris}
              className="space-y-3 rounded-lg border border-slate-800 bg-slate-950/40 p-3"
            >
              <legend className="px-1 font-medium text-slate-100 wrap-break-word">
                {b.nama_barang}
                {barang ? ` (${barang.kode_barang})` : " · barang baru"}
              </legend>
              <p className="text-xs text-slate-400">
                Di-ACC {angka(b.jumlah, b.desimal)} {b.satuan} ×{" "}
                {formatRupiah(b.harga_satuan)}, sudah diterima{" "}
                {angka(b.diterima, b.desimal)}, sisa{" "}
                {angka(b.jumlah - b.diterima, b.desimal)}.
                {barang?.dilacak_unit
                  ? " Dicatat per unit; setiap unit mendapat kode sendiri."
                  : ""}
              </p>
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label htmlFor={`${id}-jumlah`} className={LABEL}>
                    Jumlah diterima ({b.satuan})
                  </label>
                  <input
                    id={`${id}-jumlah`}
                    {...isianJumlah(b.desimal)}
                    placeholder="0"
                    value={i.jumlah}
                    onChange={(e) =>
                      ubah(b.id_baris, { jumlah: e.target.value })
                    }
                    className={INPUT}
                  />
                </div>
                <div>
                  <label htmlFor={`${id}-harga`} className={LABEL}>
                    Harga satuan sebenarnya (Rp)
                  </label>
                  <input
                    id={`${id}-harga`}
                    inputMode="numeric"
                    autoComplete="off"
                    value={i.harga}
                    onChange={(e) =>
                      ubah(b.id_baris, { harga: e.target.value })
                    }
                    className={INPUT}
                  />
                </div>
                <div>
                  <label htmlFor={`${id}-tempat`} className={LABEL}>
                    Disimpan di
                  </label>
                  <input
                    id={`${id}-tempat`}
                    placeholder="Gudang"
                    value={i.tempat}
                    onChange={(e) =>
                      ubah(b.id_baris, { tempat: e.target.value })
                    }
                    className={INPUT}
                  />
                </div>
                <div>
                  <label htmlFor={`${id}-kondisi`} className={LABEL}>
                    Kondisi
                  </label>
                  <select
                    id={`${id}-kondisi`}
                    value={i.kondisi}
                    onChange={(e) =>
                      ubah(b.id_baris, {
                        kondisi: e.target.value as KondisiBarang,
                      })
                    }
                    className={INPUT}
                  >
                    {KONDISI_BARANG.map((k) => (
                      <option key={k} value={k}>
                        {k}
                      </option>
                    ))}
                  </select>
                </div>
                {barang ? null : (
                  <>
                    <div>
                      <label htmlFor={`${id}-tipe`} className={LABEL}>
                        Tipe barang
                      </label>
                      <select
                        id={`${id}-tipe`}
                        value={i.tipe}
                        disabled={b.desimal}
                        onChange={(e) =>
                          ubah(b.id_baris, {
                            tipe: e.target.value as TipeBarang,
                          })
                        }
                        className={INPUT}
                      >
                        {TIPE_BARANG.map((t) => (
                          <option key={t} value={t}>
                            {t}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label htmlFor={`${id}-kategori`} className={LABEL}>
                        Kategori
                      </label>
                      <input
                        id={`${id}-kategori`}
                        value={i.kategori}
                        onChange={(e) =>
                          ubah(b.id_baris, { kategori: e.target.value })
                        }
                        className={INPUT}
                      />
                    </div>
                    <label className="flex min-h-11 items-center gap-2 text-slate-300 sm:col-span-2">
                      <input
                        type="checkbox"
                        checked={i.bisaExpired}
                        onChange={(e) =>
                          ubah(b.id_baris, { bisaExpired: e.target.checked })
                        }
                        className="h-4 w-4"
                      />
                      Punya tanggal kedaluwarsa
                    </label>
                  </>
                )}
                {bisaExpired ? (
                  <div>
                    <label htmlFor={`${id}-expired`} className={LABEL}>
                      Tanggal kedaluwarsa
                    </label>
                    <input
                      id={`${id}-expired`}
                      type="date"
                      value={i.expired}
                      onChange={(e) =>
                        ubah(b.id_baris, { expired: e.target.value })
                      }
                      className={INPUT}
                    />
                  </div>
                ) : null}
                {bolehPerUnit ? (
                  <label className="flex min-h-11 items-center gap-2 text-slate-300 sm:col-span-2">
                    <input
                      type="checkbox"
                      checked={i.perUnit}
                      onChange={(e) =>
                        ubah(b.id_baris, { perUnit: e.target.checked })
                      }
                      className="h-4 w-4"
                    />
                    Catat per unit (setiap unit mendapat kode dan label QR
                    sendiri)
                  </label>
                ) : null}
              </div>
            </fieldset>
          );
        })}

        <div className="space-y-2">
          <label htmlFor="inv-pgj-terima-foto" className={LABEL}>
            Foto barang yang diterima (wajib, paling banyak{" "}
            {MAKS_FOTO_PENERIMAAN})
          </label>
          <input
            id="inv-pgj-terima-foto"
            type="file"
            accept="image/jpeg,image/png,image/webp"
            multiple
            disabled={mengompres || foto.length >= MAKS_FOTO_PENERIMAAN}
            onChange={(e) => {
              void tambahFoto(e.target.files);
              e.target.value = "";
            }}
            className="w-full text-sm text-slate-400 file:mr-3 file:min-h-11 file:rounded-lg file:border-0 file:bg-slate-800 file:px-3 file:text-sm file:font-medium file:text-slate-200"
          />
          {mengompres ? (
            <p className="text-xs text-slate-400">Mengompres foto...</p>
          ) : null}
          {foto.length > 0 ? (
            <ul className="flex flex-wrap gap-2">
              {foto.map((f) => (
                <li
                  key={f.kunci}
                  className="flex items-center gap-2 rounded-lg border border-slate-800 px-2 py-1"
                >
                  <span className="max-w-40 truncate text-slate-300">
                    {f.nama}
                  </span>
                  <button
                    type="button"
                    onClick={() =>
                      setFoto((lama) => lama.filter((x) => x.kunci !== f.kunci))
                    }
                    aria-label={`Hapus foto ${f.nama}`}
                    className="min-h-11 px-2 text-rose-300 underline"
                  >
                    Hapus
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
        <div>
          <label htmlFor="inv-pgj-terima-catatan" className={LABEL}>
            Catatan
          </label>
          <textarea
            id="inv-pgj-terima-catatan"
            rows={2}
            maxLength={MAKS_CATATAN_PENGAJUAN}
            value={catatan}
            onChange={(e) => setCatatan(e.target.value)}
            className={INPUT}
          />
        </div>
        <p className="text-xs text-slate-400">
          Barang langsung masuk stok sebagai Masuk Pengadaan. Bila salah,
          batalkan mutasinya dari Kartu Stok.
        </p>
        {galat ? (
          <p role="alert" className="text-rose-300">
            {galat}
          </p>
        ) : null}
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" onClick={onClose} className={TOMBOL_KEDUA}>
            Kembali
          </button>
          <button
            type="submit"
            disabled={menyimpan || mengompres}
            className={TOMBOL_UTAMA}
          >
            {menyimpan ? "Menyimpan..." : "Simpan penerimaan"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/**
 * Label QR untuk barang dan unit dari satu penerimaan. Barang per unit hanya
 * mencetak unit barunya; barang lain bawaannya satu label per barang diterima.
 */
function LabelPenerimaan({
  data,
  label,
  onClose,
}: {
  data: DaftarInventaris;
  label: HasilPenerimaan["label"];
  onClose: () => void;
}) {
  const ids = new Set(label.map((l) => l.id_barang));
  const [awal] = useState(() =>
    Object.fromEntries(
      label.map((l) => {
        const barang = data.barang.find((b) => b.id_barang === l.id_barang);
        const perUnit = l.mutasi.length > 1 || barang?.dilacak_unit === true;
        const jumlah = perUnit
          ? l.mutasi.length
          : barang?.desimal
            ? 1
            : Math.min(Math.max(l.jumlah, 1), MAKS_LABEL_PER_BARANG);
        return [l.id_barang, String(jumlah)];
      }),
    ),
  );
  return (
    <DialogLabel
      barang={data.barang.filter((b) => ids.has(b.id_barang))}
      namaPerusahaan={data.nama_perusahaan}
      onClose={onClose}
      awal={awal}
      unitTerpilih={Object.fromEntries(
        label.map((l) => [l.id_barang, l.mutasi]),
      )}
    />
  );
}

type IsianBaris = {
  kunci: number;
  idBarang: string;
  nama: string;
  satuan: string;
  desimal: boolean;
  jumlah: string;
  harga: string;
};

function bacaHarga(teks: string, nomor: number): number {
  const bersih = teks.replace(/[.\s]/g, "");
  if (!/^\d+$/.test(bersih)) {
    throw new Error(
      `Harga satuan baris ${nomor} harus angka rupiah bulat, misalnya 55.000.`,
    );
  }
  return Number(bersih);
}

function DialogPengajuan({
  data,
  awal,
  ubah,
  isSubmittingRef,
  onClose,
  onSelesai,
}: {
  data: DaftarInventaris;
  /** Isi awal: pengajuan yang diubah atau disalin. */
  awal: Pengajuan | null;
  ubah: boolean;
  isSubmittingRef: SubmitRef;
  onClose: () => void;
  onSelesai: (message: string) => Promise<void>;
}) {
  const hariIni = data.hari_ini;
  const aktif = useMemo(
    () => data.barang.filter((b) => b.status_aktif),
    [data.barang],
  );
  const kunciRef = useRef(0);
  const barisBaru = (isi: Partial<IsianBaris> = {}): IsianBaris => {
    kunciRef.current += 1;
    return {
      kunci: kunciRef.current,
      idBarang: "",
      nama: "",
      satuan: "",
      desimal: false,
      jumlah: "",
      harga: "",
      ...isi,
    };
  };
  const [tanggal, setTanggal] = useState(ubah && awal ? awal.tanggal : hariIni);
  const [keperluan, setKeperluan] = useState(awal?.keperluan ?? "");
  const [sumberDana, setSumberDana] = useState(awal?.sumber_dana ?? "");
  const [catatan, setCatatan] = useState(awal?.catatan ?? "");
  const [baris, setBaris] = useState<IsianBaris[]>(() =>
    awal
      ? awal.baris.map((b) =>
          barisBaru({
            idBarang: b.id_barang ?? "",
            nama: b.nama_barang,
            satuan: b.satuan,
            desimal: b.desimal,
            jumlah: angka(b.jumlah, b.desimal),
            harga: angka(b.harga_satuan),
          }),
        )
      : [barisBaru()],
  );
  const [menyimpan, setMenyimpan] = useState(false);
  const [galat, setGalat] = useState<string | null>(null);

  const barangDari = (isian: IsianBaris) =>
    isian.idBarang
      ? (data.barang.find((b) => b.id_barang === isian.idBarang) ?? null)
      : null;
  const desimalDari = (isian: IsianBaris) =>
    barangDari(isian)?.desimal ?? isian.desimal;
  const nilaiIsian = (isian: IsianBaris): number | null => {
    const desimal = desimalDari(isian);
    const jumlah = jumlahDariKetikan(isian.jumlah, desimal);
    const harga = isian.harga.replace(/[.\s]/g, "");
    if (jumlah === null || !/^\d+$/.test(harga)) return null;
    return nilaiBaris(jumlah, Number(harga), desimal);
  };
  const total = baris.reduce((sum, b) => sum + (nilaiIsian(b) ?? 0), 0);

  const ubahBaris = (kunci: number, isi: Partial<IsianBaris>) =>
    setBaris((daftar) =>
      daftar.map((b) => (b.kunci === kunci ? { ...b, ...isi } : b)),
    );

  const kirim = async (event: FormEvent) => {
    event.preventDefault();
    if (isSubmittingRef.current) return;
    isSubmittingRef.current = true;
    setMenyimpan(true);
    setGalat(null);
    try {
      const draft: PengajuanDraft = {
        id_pengajuan: ubah && awal ? awal.id_pengajuan : null,
        tanggal,
        keperluan,
        sumber_dana: sumberDana,
        catatan,
        baris: baris.map((b, indeks) => {
          const terdaftar = b.idBarang !== "";
          const desimal = desimalDari(b);
          return {
            id_barang: terdaftar ? b.idBarang : null,
            nama_barang: terdaftar ? null : b.nama,
            satuan: terdaftar ? null : b.satuan,
            desimal: terdaftar ? false : b.desimal,
            jumlah: bacaJumlah(b.jumlah, desimal, `Jumlah baris ${indeks + 1}`),
            harga_satuan: bacaHarga(b.harga, indeks + 1),
          };
        }),
      };
      await simpanPengajuan(draft);
      await onSelesai(
        ubah
          ? "Pengajuan diperbarui."
          : "Pengajuan terkirim. Akuntansi memutuskannya dari halaman Keuangan, tab Dari Inventaris.",
      );
    } catch (error) {
      setGalat(pesanGalat(error, "Pengajuan tidak bisa disimpan."));
    } finally {
      isSubmittingRef.current = false;
      setMenyimpan(false);
    }
  };

  return (
    <Modal
      isOpen={true}
      onClose={onClose}
      title={ubah ? "Ubah pengajuan" : "Pengajuan pembelian"}
      titleId="inv-pgj-judul"
      maxWidth="max-w-3xl"
    >
      <form onSubmit={kirim} className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor="inv-pgj-tanggal" className={LABEL}>
              Tanggal pengajuan
            </label>
            <input
              id="inv-pgj-tanggal"
              type="date"
              required
              max={hariIni}
              value={tanggal}
              onChange={(e) => setTanggal(e.target.value)}
              className={INPUT}
            />
          </div>
          <div>
            <label htmlFor="inv-pgj-sumber" className={LABEL}>
              Sumber dana
            </label>
            <input
              id="inv-pgj-sumber"
              list="inv-pgj-sumber-saran"
              maxLength={MAKS_SUMBER_DANA}
              value={sumberDana}
              onChange={(e) => setSumberDana(e.target.value)}
              className={INPUT}
            />
            <datalist id="inv-pgj-sumber-saran">
              {SUMBER_DANA_UMUM.map((nilai) => (
                <option key={nilai} value={nilai} />
              ))}
            </datalist>
          </div>
        </div>
        <div>
          <label htmlFor="inv-pgj-keperluan" className={LABEL}>
            Keperluan
          </label>
          <input
            id="inv-pgj-keperluan"
            required
            maxLength={MAKS_KEPERLUAN}
            placeholder="Misalnya ATK semester ganjil"
            value={keperluan}
            onChange={(e) => setKeperluan(e.target.value)}
            className={INPUT}
          />
        </div>

        <fieldset className="space-y-3">
          <legend className="text-sm font-semibold text-slate-100">
            Barang yang dibeli
          </legend>
          {baris.map((b, indeks) => {
            const barang = barangDari(b);
            const desimal = desimalDari(b);
            const nilai = nilaiIsian(b);
            return (
              <div
                key={b.kunci}
                className="space-y-3 rounded-lg border border-slate-800 bg-slate-950/40 p-3"
              >
                <div className="flex items-end gap-2">
                  <div className="min-w-0 flex-1">
                    <label
                      htmlFor={`inv-pgj-barang-${b.kunci}`}
                      className={LABEL}
                    >
                      Barang {indeks + 1}
                    </label>
                    <select
                      id={`inv-pgj-barang-${b.kunci}`}
                      value={b.idBarang}
                      onChange={(e) =>
                        ubahBaris(b.kunci, { idBarang: e.target.value })
                      }
                      className={INPUT}
                    >
                      <option value="">Barang baru (belum terdaftar)</option>
                      {aktif.map((item) => (
                        <option key={item.id_barang} value={item.id_barang}>
                          {item.nama_barang} ({item.kode_barang})
                        </option>
                      ))}
                    </select>
                  </div>
                  {baris.length > 1 ? (
                    <button
                      type="button"
                      onClick={() =>
                        setBaris((daftar) =>
                          daftar.filter((x) => x.kunci !== b.kunci),
                        )
                      }
                      aria-label={`Hapus barang ${indeks + 1}`}
                      className={TOMBOL_KEDUA}
                    >
                      Hapus
                    </button>
                  ) : null}
                </div>
                {b.idBarang === "" ? (
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div>
                      <label
                        htmlFor={`inv-pgj-nama-${b.kunci}`}
                        className={LABEL}
                      >
                        Nama barang
                      </label>
                      <input
                        id={`inv-pgj-nama-${b.kunci}`}
                        required
                        maxLength={MAKS_NAMA_BARANG}
                        value={b.nama}
                        onChange={(e) =>
                          ubahBaris(b.kunci, { nama: e.target.value })
                        }
                        className={INPUT}
                      />
                    </div>
                    <div>
                      <label
                        htmlFor={`inv-pgj-satuan-${b.kunci}`}
                        className={LABEL}
                      >
                        Satuan
                      </label>
                      <input
                        id={`inv-pgj-satuan-${b.kunci}`}
                        required
                        maxLength={MAKS_SATUAN}
                        placeholder="pcs, rim, kg"
                        value={b.satuan}
                        onChange={(e) =>
                          ubahBaris(b.kunci, { satuan: e.target.value })
                        }
                        className={INPUT}
                      />
                    </div>
                    <label className="flex items-center gap-2 text-sm text-slate-300 sm:col-span-2">
                      <input
                        type="checkbox"
                        checked={b.desimal}
                        onChange={(e) =>
                          ubahBaris(b.kunci, { desimal: e.target.checked })
                        }
                        className="h-4 w-4"
                      />
                      Jumlah boleh pecahan, misalnya 2,5 kg (hanya barang Habis
                      Pakai)
                    </label>
                  </div>
                ) : null}
                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <label
                      htmlFor={`inv-pgj-jumlah-${b.kunci}`}
                      className={LABEL}
                    >
                      Jumlah ({barang?.satuan ?? (b.satuan || "satuan")})
                    </label>
                    <input
                      id={`inv-pgj-jumlah-${b.kunci}`}
                      {...isianJumlah(desimal)}
                      required
                      value={b.jumlah}
                      onChange={(e) =>
                        ubahBaris(b.kunci, { jumlah: e.target.value })
                      }
                      className={INPUT}
                    />
                  </div>
                  <div>
                    <label
                      htmlFor={`inv-pgj-harga-${b.kunci}`}
                      className={LABEL}
                    >
                      Perkiraan harga satuan (Rp)
                    </label>
                    <input
                      id={`inv-pgj-harga-${b.kunci}`}
                      inputMode="numeric"
                      autoComplete="off"
                      required
                      value={b.harga}
                      onChange={(e) =>
                        ubahBaris(b.kunci, { harga: e.target.value })
                      }
                      className={INPUT}
                    />
                  </div>
                </div>
                <p className="text-xs text-slate-400">
                  Subtotal {nilai === null ? "-" : formatRupiah(nilai)}
                </p>
              </div>
            );
          })}
          {baris.length < MAKS_BARIS_PENGAJUAN ? (
            <button
              type="button"
              onClick={() => setBaris((daftar) => [...daftar, barisBaru()])}
              className={TOMBOL_KEDUA}
            >
              Tambah barang
            </button>
          ) : null}
        </fieldset>

        <div>
          <label htmlFor="inv-pgj-catatan" className={LABEL}>
            Catatan
          </label>
          <textarea
            id="inv-pgj-catatan"
            rows={2}
            maxLength={MAKS_CATATAN_PENGAJUAN}
            value={catatan}
            onChange={(e) => setCatatan(e.target.value)}
            className={INPUT}
          />
        </div>
        <p className="text-sm font-semibold text-slate-100">
          Total perkiraan {formatRupiah(total)}
        </p>
        <p className="text-xs text-slate-400">
          Barang baru dibuat saat barangnya diterima. Setelah akuntansi
          memutuskan, pengajuan tidak bisa diubah lagi.
        </p>
        {galat ? (
          <p role="alert" className="text-sm text-rose-300">
            {galat}
          </p>
        ) : null}
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" onClick={onClose} className={TOMBOL_KEDUA}>
            Kembali
          </button>
          <button type="submit" disabled={menyimpan} className={TOMBOL_UTAMA}>
            {menyimpan ? "Menyimpan..." : ubah ? "Simpan" : "Ajukan"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function DialogAlasan({
  judul,
  label,
  tombol,
  isSubmittingRef,
  onKirim,
  onClose,
}: {
  judul: string;
  label: string;
  tombol: string;
  isSubmittingRef: SubmitRef;
  onKirim: (alasan: string) => Promise<void>;
  onClose: () => void;
}) {
  const [alasan, setAlasan] = useState("");
  const [menyimpan, setMenyimpan] = useState(false);
  const [galat, setGalat] = useState<string | null>(null);

  const kirim = async (event: FormEvent) => {
    event.preventDefault();
    if (isSubmittingRef.current) return;
    isSubmittingRef.current = true;
    setMenyimpan(true);
    setGalat(null);
    try {
      await onKirim(alasan);
    } catch (error) {
      setGalat(pesanGalat(error, "Perubahan tidak bisa disimpan."));
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
      titleId="inv-pgj-alasan-judul"
    >
      <form onSubmit={kirim} className="space-y-4">
        <div>
          <label htmlFor="inv-pgj-alasan" className={LABEL}>
            {label}
          </label>
          <textarea
            id="inv-pgj-alasan"
            required
            rows={3}
            maxLength={MAKS_CATATAN_PENGAJUAN}
            value={alasan}
            onChange={(e) => setAlasan(e.target.value)}
            className={INPUT}
          />
        </div>
        {galat ? (
          <p role="alert" className="text-sm text-rose-300">
            {galat}
          </p>
        ) : null}
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" onClick={onClose} className={TOMBOL_KEDUA}>
            Kembali
          </button>
          <button type="submit" disabled={menyimpan} className={TOMBOL_BAHAYA}>
            {menyimpan ? "Menyimpan..." : tombol}
          </button>
        </div>
      </form>
    </Modal>
  );
}

type Saringan = "perlu" | "semua" | StatusPengajuan;
type Aksi =
  | { jenis: "baru" }
  | {
      jenis: "ubah" | "salin" | "batal" | "tutup" | "terima";
      pengajuan: Pengajuan;
    };

function useDaftarPengajuan(dari: string, sampai: string) {
  const [daftar, setDaftar] = useState<DaftarPengajuan | null>(null);
  const [galat, setGalat] = useState<string | null>(null);
  const muat = useCallback(async () => {
    setGalat(null);
    try {
      setDaftar(await getPengajuan(dari, sampai));
    } catch (error) {
      setDaftar(null);
      setGalat(pesanGalat(error, "Daftar pengajuan tidak bisa dimuat."));
    }
  }, [dari, sampai]);
  useEffect(() => {
    void muat();
  }, [muat]);
  useEffect(() => subscribeSyncCompleted(() => void muat()), [muat]);
  return { daftar, galat, muat };
}

export function PanelPengajuan({
  data,
  canRecord,
  onInfo,
  onBerubah,
}: {
  data: DaftarInventaris;
  canRecord: boolean;
  onInfo: (message: string) => void;
  /** Dipanggil setelah perubahan supaya tanda angka tab ikut diperbarui. */
  onBerubah: () => void;
}) {
  const [dari, setDari] = useState(`${data.hari_ini.slice(0, 5)}01-01`);
  const [sampai, setSampai] = useState(data.hari_ini);
  const { daftar, galat, muat } = useDaftarPengajuan(dari, sampai);
  const [saringan, setSaringan] = useState<Saringan>("perlu");
  const [terbuka, setTerbuka] = useState<Set<string>>(new Set());
  const [aksi, setAksi] = useState<Aksi | null>(null);
  const [label, setLabel] = useState<HasilPenerimaan["label"] | null>(null);
  const isSubmittingRef = useRef(false);

  const tampil = (daftar?.pengajuan ?? []).filter((p) =>
    saringan === "semua"
      ? true
      : saringan === "perlu"
        ? p.status === "Menunggu" ||
          p.status === "Disetujui" ||
          p.status === "Diterima sebagian"
        : p.status === saringan,
  );

  const selesai = async (message: string) => {
    setAksi(null);
    onInfo(message);
    await muat();
    onBerubah();
  };

  const bukaTutup = (id: string) =>
    setTerbuka((lama) => {
      const baru = new Set(lama);
      if (baru.has(id)) baru.delete(id);
      else baru.add(id);
      return baru;
    });

  return (
    <section
      aria-labelledby="inv-pgj-daftar"
      className="p-4 rounded-xl border border-slate-800 bg-slate-900/60 space-y-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2
          id="inv-pgj-daftar"
          className="text-base font-semibold text-slate-100"
        >
          Pengajuan pembelian
        </h2>
        {canRecord ? (
          <button
            type="button"
            onClick={() => setAksi({ jenis: "baru" })}
            className={TOMBOL_UTAMA}
          >
            Pengajuan baru
          </button>
        ) : null}
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label htmlFor="inv-pgj-saring" className={LABEL}>
            Tampilkan
          </label>
          <select
            id="inv-pgj-saring"
            value={saringan}
            onChange={(e) => setSaringan(e.target.value as Saringan)}
            className={INPUT}
          >
            <option value="perlu">Belum selesai</option>
            <option value="semua">Semua</option>
            {STATUS_PENGAJUAN.map((status) => (
              <option key={status} value={status}>
                {status}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="inv-pgj-dari" className={LABEL}>
            Selesai dari tanggal
          </label>
          <input
            id="inv-pgj-dari"
            type="date"
            max={sampai}
            value={dari}
            onChange={(e) => setDari(e.target.value)}
            className={INPUT}
          />
        </div>
        <div>
          <label htmlFor="inv-pgj-sampai" className={LABEL}>
            Sampai tanggal
          </label>
          <input
            id="inv-pgj-sampai"
            type="date"
            min={dari}
            value={sampai}
            onChange={(e) => setSampai(e.target.value)}
            className={INPUT}
          />
        </div>
      </div>
      <p className="text-xs text-slate-400">
        Pengajuan yang belum selesai selalu tampil. Rentang tanggal hanya
        menyaring yang sudah selesai, ditolak, atau dibatalkan.
      </p>

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
      ) : !daftar ? (
        <p className="p-6 text-center text-sm text-slate-400">Memuat...</p>
      ) : tampil.length === 0 ? (
        <p className="text-sm text-slate-400">
          Tidak ada pengajuan untuk pilihan ini.
        </p>
      ) : (
        <>
          {daftar.terpotong ? (
            <p className="text-xs text-amber-300">
              Hanya {daftar.pengajuan.length} pengajuan terbaru yang tampil.
              Persempit rentang tanggal.
            </p>
          ) : null}
          <ul className="divide-y divide-slate-800 rounded-lg border border-slate-800 bg-slate-950/40">
            {tampil.map((p) => (
              <li key={p.id_pengajuan} className="space-y-3 px-4 py-3 text-sm">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0 space-y-1">
                    <p className="font-medium text-slate-100 wrap-break-word">
                      {p.keperluan}
                    </p>
                    <p className="text-slate-400">
                      {p.nomor}
                      {p.nomor_ganda ? " (nomor ganda)" : ""} ·{" "}
                      {tanggalTampil(p.tanggal)} · {p.baris.length} barang ·{" "}
                      {formatRupiah(p.total)}
                    </p>
                    <p className={`wrap-break-word ${WARNA_STATUS[p.status]}`}>
                      {p.status}
                      {keteranganStatus(p)}
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => bukaTutup(p.id_pengajuan)}
                      aria-expanded={terbuka.has(p.id_pengajuan)}
                      className={TOMBOL_KEDUA}
                    >
                      {terbuka.has(p.id_pengajuan) ? "Sembunyikan" : "Rincian"}
                    </button>
                    {canRecord && p.status === "Menunggu" ? (
                      <>
                        <button
                          type="button"
                          onClick={() =>
                            setAksi({ jenis: "ubah", pengajuan: p })
                          }
                          className={TOMBOL_KEDUA}
                        >
                          Ubah
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            setAksi({ jenis: "batal", pengajuan: p })
                          }
                          className={TOMBOL_KEDUA}
                        >
                          Batalkan
                        </button>
                      </>
                    ) : null}
                    {canRecord &&
                    (p.status === "Disetujui" ||
                      p.status === "Diterima sebagian") ? (
                      <>
                        <button
                          type="button"
                          onClick={() =>
                            setAksi({ jenis: "terima", pengajuan: p })
                          }
                          className={TOMBOL_UTAMA}
                        >
                          Catat penerimaan
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            setAksi({ jenis: "tutup", pengajuan: p })
                          }
                          className={TOMBOL_KEDUA}
                        >
                          Tutup
                        </button>
                      </>
                    ) : null}
                    {canRecord &&
                    (p.status === "Ditolak" || p.status === "Dibatalkan") ? (
                      <button
                        type="button"
                        onClick={() =>
                          setAksi({ jenis: "salin", pengajuan: p })
                        }
                        className={TOMBOL_KEDUA}
                      >
                        Salin jadi pengajuan baru
                      </button>
                    ) : null}
                  </div>
                </div>
                {terbuka.has(p.id_pengajuan) ? (
                  <RincianPengajuan pengajuan={p} />
                ) : null}
              </li>
            ))}
          </ul>
        </>
      )}

      {aksi?.jenis === "baru" ||
      aksi?.jenis === "ubah" ||
      aksi?.jenis === "salin" ? (
        <DialogPengajuan
          data={data}
          awal={aksi.jenis === "baru" ? null : aksi.pengajuan}
          ubah={aksi.jenis === "ubah"}
          isSubmittingRef={isSubmittingRef}
          onClose={() => setAksi(null)}
          onSelesai={selesai}
        />
      ) : aksi?.jenis === "terima" ? (
        <DialogPenerimaan
          data={data}
          pengajuan={aksi.pengajuan}
          isSubmittingRef={isSubmittingRef}
          onClose={() => setAksi(null)}
          onSelesai={async (hasil) => {
            setAksi(null);
            onInfo(
              "Penerimaan tercatat. Stok bertambah, dan bendahara melihatnya di Keuangan, tab Dari Inventaris.",
            );
            await muat();
            onBerubah();
            // Cetak hanya Web/Desktop, seperti label dan berita acara lain.
            if (bisaCetakBeritaAcara()) setLabel(hasil.label);
          }}
        />
      ) : aksi?.jenis === "batal" ? (
        <DialogAlasan
          judul={`Batalkan ${aksi.pengajuan.nomor}`}
          label="Alasan pembatalan"
          tombol="Batalkan pengajuan"
          isSubmittingRef={isSubmittingRef}
          onClose={() => setAksi(null)}
          onKirim={async (alasan) => {
            await batalkanPengajuan(aksi.pengajuan.id_pengajuan, alasan);
            await selesai("Pengajuan dibatalkan.");
          }}
        />
      ) : aksi?.jenis === "tutup" ? (
        <DialogAlasan
          judul={`Tutup ${aksi.pengajuan.nomor}`}
          label="Kenapa sisa barangnya tidak akan datang?"
          tombol="Tutup pengajuan"
          isSubmittingRef={isSubmittingRef}
          onClose={() => setAksi(null)}
          onKirim={async (alasan) => {
            await tutupPengajuan(aksi.pengajuan.id_pengajuan, alasan);
            await selesai(
              "Pengajuan ditutup. Barang yang sudah diterima tidak berubah.",
            );
          }}
        />
      ) : null}
      {label ? (
        <LabelPenerimaan
          data={data}
          label={label}
          onClose={() => setLabel(null)}
        />
      ) : null}
    </section>
  );
}

function DialogKeputusan({
  pengajuan,
  isSubmittingRef,
  onClose,
  onSelesai,
}: {
  pengajuan: Pengajuan;
  isSubmittingRef: SubmitRef;
  onClose: () => void;
  onSelesai: (message: string) => Promise<void>;
}) {
  const [catatan, setCatatan] = useState("");
  const [menyimpan, setMenyimpan] = useState(false);
  const [galat, setGalat] = useState<string | null>(null);

  const putuskan = async (keputusan: "ACC" | "Tolak") => {
    if (isSubmittingRef.current) return;
    isSubmittingRef.current = true;
    setMenyimpan(true);
    setGalat(null);
    try {
      await putuskanPengajuan({
        id_pengajuan: pengajuan.id_pengajuan,
        keputusan,
        sidik_baris: pengajuan.sidik_baris,
        catatan,
      });
      await onSelesai(
        keputusan === "ACC"
          ? `${pengajuan.nomor} disetujui. Pengaju bisa membeli barangnya.`
          : `${pengajuan.nomor} ditolak.`,
      );
    } catch (error) {
      setGalat(pesanGalat(error, "Keputusan tidak bisa disimpan."));
    } finally {
      isSubmittingRef.current = false;
      setMenyimpan(false);
    }
  };

  return (
    <Modal
      isOpen={true}
      onClose={onClose}
      title={`Putuskan ${pengajuan.nomor}`}
      titleId="keu-pgj-judul"
      maxWidth="max-w-3xl"
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void putuskan("ACC");
        }}
        className="space-y-4 text-sm"
      >
        <p className="text-slate-300 wrap-break-word">
          {pengajuan.keperluan} · diajukan {pengajuan.diajukan_oleh},{" "}
          {tanggalTampil(pengajuan.tanggal)}
        </p>
        <RincianPengajuan pengajuan={pengajuan} />
        <p className="font-semibold text-slate-100">
          Total {formatRupiah(pengajuan.total)}
        </p>
        <div>
          <label htmlFor="keu-pgj-catatan" className={LABEL}>
            Catatan (wajib bila ditolak)
          </label>
          <textarea
            id="keu-pgj-catatan"
            rows={2}
            maxLength={MAKS_CATATAN_PENGAJUAN}
            value={catatan}
            onChange={(e) => setCatatan(e.target.value)}
            className={INPUT}
          />
        </div>
        <p className="text-xs text-slate-400">
          ACC berlaku untuk seluruh isi di atas dan tidak bisa dicabut. Bila
          sebagian saja yang disetujui, tolak dengan alasannya; pengaju bisa
          menyalinnya menjadi pengajuan baru.
        </p>
        {galat ? (
          <p role="alert" className="text-rose-300">
            {galat}
          </p>
        ) : null}
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" onClick={onClose} className={TOMBOL_KEDUA}>
            Kembali
          </button>
          <button
            type="button"
            disabled={menyimpan}
            onClick={() => void putuskan("Tolak")}
            className={TOMBOL_BAHAYA}
          >
            Tolak
          </button>
          <button type="submit" disabled={menyimpan} className={TOMBOL_UTAMA}>
            {menyimpan ? "Menyimpan..." : "ACC"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/**
 * Bagian pengajuan di tab Dari Inventaris (Keuangan): yang menunggu
 * persetujuan, laporan penerimaan dalam rentang tanggal tab, dan laporan satu
 * pengajuan yang dibuka dari baris Belum dijurnal.
 */
export function PengajuanKeuangan({
  bolehKelola,
  dari,
  sampai,
  lihat,
  onTutupLihat,
  onInfo,
  onBerubah,
}: {
  bolehKelola: boolean;
  dari: string;
  sampai: string;
  /** id pengajuan yang laporannya dibuka; null = tertutup. */
  lihat: string | null;
  onTutupLihat: () => void;
  onInfo: (message: string) => void;
  onBerubah: () => void;
}) {
  // Yang terbuka selalu ikut; yang sudah selesai sejak 2000, 500 terbaru.
  const [hariIni] = useState(hariIniWib);
  const { daftar, galat, muat } = useDaftarPengajuan("2000-01-01", hariIni);
  const [dipilih, setDipilih] = useState<Pengajuan | null>(null);
  const { user } = useAuth();
  // Pemisahan tugas; backend tetap menolaknya bila layar ini dilewati.
  const milikSendiri = (p: Pengajuan) =>
    !validatePemutus(
      p.diajukan_oleh,
      user?.username ?? "",
      user?.isSuperadmin ?? false,
    ).ok;
  const isSubmittingRef = useRef(false);
  const semua = daftar?.pengajuan ?? [];
  const menunggu = semua.filter((p) => p.status === "Menunggu");
  const diterima = semua.filter((p) => {
    const akhir = p.penerimaan[p.penerimaan.length - 1]?.tanggal;
    return akhir !== undefined && akhir >= dari && akhir <= sampai;
  });
  const dilihat = lihat
    ? (semua.find((p) => p.id_pengajuan === lihat) ?? null)
    : null;

  const kepala = (p: Pengajuan) => (
    <div className="min-w-0 space-y-1">
      <p className="font-medium text-slate-100 wrap-break-word">
        {p.keperluan}
      </p>
      <p className="text-slate-400">
        {p.nomor} · {tanggalTampil(p.tanggal)} · {p.diajukan_oleh} ·{" "}
        {formatRupiah(p.total)}
        {p.disetujui_pada
          ? ` · ACC ${tanggalTampil(p.disetujui_pada.slice(0, 10))}`
          : ""}
      </p>
      <p className={WARNA_STATUS[p.status]}>{p.status}</p>
    </div>
  );

  return (
    <div className="space-y-4">
      <section
        aria-labelledby="keu-pgj-menunggu"
        className="p-4 rounded-xl border border-slate-800 bg-slate-900/60 space-y-3"
      >
        <h3
          id="keu-pgj-menunggu"
          className="text-sm font-semibold text-slate-100"
        >
          Pengajuan pembelian menunggu persetujuan ({menunggu.length})
        </h3>
        {galat ? (
          <div className="space-y-2 text-sm text-rose-200">
            <p>{galat}</p>
            <button
              type="button"
              onClick={() => void muat()}
              className={TOMBOL_KEDUA}
            >
              Coba muat lagi
            </button>
          </div>
        ) : !daftar ? (
          <p className="text-sm text-slate-400">Memuat...</p>
        ) : menunggu.length === 0 ? (
          <p className="text-sm text-slate-400">
            Tidak ada pengajuan yang menunggu.
          </p>
        ) : (
          <ul className="divide-y divide-slate-800 rounded-lg border border-slate-800 bg-slate-950/40">
            {menunggu.map((p) => (
              <li key={p.id_pengajuan} className="space-y-3 px-4 py-3 text-sm">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                  {kepala(p)}
                  {bolehKelola && milikSendiri(p) ? (
                    <p className="text-xs text-slate-400 sm:max-w-56">
                      Kamu yang mengajukan. Pemegang Keuangan lain yang
                      memutuskannya.
                    </p>
                  ) : bolehKelola ? (
                    <button
                      type="button"
                      onClick={() => setDipilih(p)}
                      className={TOMBOL_UTAMA}
                    >
                      Periksa dan putuskan
                    </button>
                  ) : null}
                </div>
                <RincianPengajuan pengajuan={p} />
              </li>
            ))}
          </ul>
        )}
      </section>

      {diterima.length > 0 ? (
        <section
          aria-labelledby="keu-pgj-diterima"
          className="p-4 rounded-xl border border-slate-800 bg-slate-900/60 space-y-3"
        >
          <h3
            id="keu-pgj-diterima"
            className="text-sm font-semibold text-slate-100"
          >
            Penerimaan barang di rentang ini ({diterima.length})
          </h3>
          <p className="text-sm text-slate-400">
            Periksa foto dan selisihnya sebelum menjurnal baris Masuk-nya di
            bawah.
          </p>
          <ul className="divide-y divide-slate-800 rounded-lg border border-slate-800 bg-slate-950/40">
            {diterima.map((p) => (
              <li key={p.id_pengajuan} className="space-y-3 px-4 py-3 text-sm">
                {kepala(p)}
                <RincianPengajuan pengajuan={p} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {dipilih ? (
        <DialogKeputusan
          pengajuan={dipilih}
          isSubmittingRef={isSubmittingRef}
          onClose={() => setDipilih(null)}
          onSelesai={async (message) => {
            setDipilih(null);
            onInfo(message);
            await muat();
            onBerubah();
          }}
        />
      ) : null}
      {lihat ? (
        <Modal
          isOpen={true}
          onClose={onTutupLihat}
          title={dilihat ? `Penerimaan ${dilihat.nomor}` : "Penerimaan"}
          titleId="keu-pgj-lihat-judul"
          maxWidth="max-w-3xl"
        >
          {dilihat ? (
            <div className="space-y-3 text-sm">
              {kepala(dilihat)}
              <RincianPengajuan pengajuan={dilihat} />
            </div>
          ) : (
            <p className="text-sm text-slate-400">
              {daftar
                ? "Pengajuannya belum ada di perangkat ini. Sinkronkan lalu coba lagi."
                : "Memuat..."}
            </p>
          )}
        </Modal>
      ) : null}
    </div>
  );
}
