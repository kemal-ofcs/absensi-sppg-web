"use client";

import {
  type FormEvent,
  useCallback,
  useEffect,
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
import { Modal } from "@/components/ui/Modal";
import { PilihCari } from "@/components/ui/PilihCari";
import { hasPermission } from "@/lib/auth/access";
import { useAuth } from "@/lib/context/AuthContext";
import { getCompanyBranding } from "@/lib/gateways/company-profile";
import {
  ambilFotoLaporan,
  aturPenerimaUpah,
  catatLaporanDispatcher,
  type FotoLaporan,
  type LaporanBaris,
  type MasterPerjalanan,
  type RincianPerjalanan,
  rincianPerjalanan,
  tandaiSuratJalanDicetak,
} from "@/lib/gateways/driver";
import { isMobileRuntime } from "@/lib/runtime/app-runtime";
import { formatRupiah } from "@/lib/validations/accounting";
import { cetakSuratJalan } from "./cetakSuratJalan";
import {
  beratKg,
  LABEL_TANDA,
  sekarangUtc,
  tautanMaps,
  WARNA_STATUS,
  waktuWib,
} from "./tampilan";

type Aksi =
  | { jenis: "Ganti Kendaraan" | "Ganti Driver" }
  | { jenis: "Disetujui" | "Ditolak"; idRef: string }
  | { jenis: "Tidak Jalan" | "Dibatalkan" | "Selesai" }
  | { jenis: "upah" };

const JUDUL_AKSI: Record<Aksi["jenis"], string> = {
  "Ganti Kendaraan": "Ganti kendaraan",
  "Ganti Driver": "Ganti driver",
  Disetujui: "Setujui ganti",
  Ditolak: "Tolak ganti",
  "Tidak Jalan": "Tandai Tidak Jalan",
  Dibatalkan: "Batalkan perjalanan",
  Selesai: "Tutup sebagai Selesai",
  upah: "Pindahkan upah",
};

const GALAT_KOTAK =
  "p-3 rounded-lg border border-rose-500/30 bg-rose-500/20 text-sm text-rose-100";

export function RincianSuratJalan({
  idPerjalanan,
  master,
  onClose,
  onUbah,
  onBerubah,
}: {
  idPerjalanan: string;
  master: MasterPerjalanan;
  onClose: () => void;
  onUbah: (rincian: RincianPerjalanan) => void;
  onBerubah: () => void;
}) {
  const { user } = useAuth();
  const bolehKelola = hasPermission(user, "trip.manage");
  const bolehBatal = hasPermission(user, "trip.cancel");
  const bolehTarif = hasPermission(user, "trip.tariff");

  const [rincian, setRincian] = useState<RincianPerjalanan | null>(null);
  const [galat, setGalat] = useState<string | null>(null);
  const [aksi, setAksi] = useState<Aksi | null>(null);
  const [foto, setFoto] = useState<Record<string, FotoLaporan | "kosong">>({});

  const muat = useCallback(async () => {
    setGalat(null);
    try {
      setRincian(await rincianPerjalanan(idPerjalanan));
    } catch (error) {
      setGalat(pesanGalat(error, "Rincian surat jalan tidak bisa dimuat."));
    }
  }, [idPerjalanan]);

  useEffect(() => {
    void muat();
  }, [muat]);

  const namaPersonil = (id: string | null | undefined) =>
    master.personil.find((p) => p.id_unik === id)?.nama ?? id ?? "-";
  const platKendaraan = (id: string | null | undefined) =>
    master.kendaraan.find((k) => k.id_kendaraan === id)?.identitas ?? id ?? "-";

  async function lihatFoto(idLaporan: string) {
    try {
      const hasil = await ambilFotoLaporan(idLaporan);
      setFoto((lama) => ({ ...lama, [idLaporan]: hasil ?? "kosong" }));
    } catch {
      setFoto((lama) => ({ ...lama, [idLaporan]: "kosong" }));
    }
  }

  async function cetak() {
    if (!rincian) return;
    try {
      const kop = await getCompanyBranding().catch(() => ({
        company_name: null,
        logo_url: null,
      }));
      cetakSuratJalan(rincian, master, kop);
      await tandaiSuratJalanDicetak(rincian.item.id_perjalanan);
      await muat();
      onBerubah();
    } catch (error) {
      setGalat(pesanGalat(error, "Surat jalan tidak bisa dicetak."));
    }
  }

  async function selesaiAksi() {
    setAksi(null);
    await muat();
    onBerubah();
  }

  if (!rincian) {
    return (
      <Modal
        isOpen
        title="Rincian surat jalan"
        onClose={onClose}
        maxWidth="max-w-4xl"
      >
        {galat ? (
          <div className={GALAT_KOTAK} role="alert">
            {galat}
          </div>
        ) : (
          <p className="text-sm text-slate-400">Memuat...</p>
        )}
      </Modal>
    );
  }

  const { item, muatan, laporan } = rincian;
  const terbuka = item.status === "Direncanakan" || item.status === "Berjalan";
  const jumlahPer = (jenis: string, idMuatan: string) =>
    laporan
      .filter((l) => l.jenis === jenis)
      .flatMap((l) => l.muatan)
      .filter((m) => m.id_muatan === idMuatan)
      .reduce((s, m) => s + m.qty, 0);
  const adaKonfirmasi = (jenis: string, idMuatan: string) =>
    laporan.some(
      (l) =>
        l.jenis === jenis && l.muatan.some((m) => m.id_muatan === idMuatan),
    );

  return (
    <Modal
      isOpen
      title={`Surat jalan ${item.nomor}`}
      subtitle={`${item.tanggal} · ${item.nama_kategori ?? item.id_kategori}`}
      onClose={onClose}
      maxWidth="max-w-5xl"
    >
      <div className="space-y-5">
        {galat ? (
          <div className={GALAT_KOTAK} role="alert">
            {galat}
          </div>
        ) : null}

        <div className="flex flex-wrap items-center gap-2">
          <span
            className={`rounded-full border px-3 py-1 text-xs font-semibold ${WARNA_STATUS[item.status]}`}
          >
            {item.status}
          </span>
          <span className="text-sm text-slate-300">
            {item.dicetak_pada
              ? `Dicetak ${waktuWib(item.dicetak_pada)}`
              : "Belum dicetak"}
          </span>
        </div>

        <dl className="grid gap-3 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-slate-400">Driver bertugas</dt>
            <dd className="text-slate-100">
              {item.nama_karyawan ?? item.id_karyawan}
            </dd>
          </div>
          <div>
            <dt className="text-slate-400">Kendaraan bertugas</dt>
            <dd className="text-slate-100">
              {item.identitas_kendaraan ?? item.id_kendaraan}
            </dd>
          </div>
          <div>
            <dt className="text-slate-400">Upah surat jalan</dt>
            <dd className="text-slate-100">
              {formatRupiah(item.upah)}
              {item.status === "Selesai"
                ? ` · untuk ${item.nama_penerima_upah ?? item.penerima_upah ?? "-"}`
                : item.status === "Dibatalkan" || item.status === "Tidak Jalan"
                  ? " · tidak dibayar"
                  : ""}
            </dd>
          </div>
          {item.catatan ? (
            <div className="sm:col-span-3">
              <dt className="text-slate-400">Catatan</dt>
              <dd className="text-slate-100">{item.catatan}</dd>
            </div>
          ) : null}
        </dl>

        <div className="flex flex-wrap gap-2">
          {bolehKelola && !isMobileRuntime() ? (
            <button
              type="button"
              id="sj-cetak"
              className={TOMBOL_UTAMA}
              onClick={() => void cetak()}
            >
              {item.dicetak_pada ? "Cetak ulang" : "Cetak surat jalan"}
            </button>
          ) : null}
          {bolehKelola && item.status === "Direncanakan" ? (
            <button
              type="button"
              id="sj-ubah"
              className={TOMBOL_KEDUA}
              onClick={() => onUbah(rincian)}
            >
              Ubah
            </button>
          ) : null}
          {bolehKelola && terbuka ? (
            <>
              <button
                type="button"
                id="sj-ganti-kendaraan"
                className={TOMBOL_KEDUA}
                onClick={() => setAksi({ jenis: "Ganti Kendaraan" })}
              >
                Ganti kendaraan
              </button>
              <button
                type="button"
                id="sj-ganti-driver"
                className={TOMBOL_KEDUA}
                onClick={() => setAksi({ jenis: "Ganti Driver" })}
              >
                Ganti driver
              </button>
            </>
          ) : null}
          {bolehKelola && item.status === "Direncanakan" ? (
            <button
              type="button"
              id="sj-tidak-jalan"
              className={TOMBOL_KEDUA}
              onClick={() => setAksi({ jenis: "Tidak Jalan" })}
            >
              Tidak jalan
            </button>
          ) : null}
          {bolehKelola && item.status === "Berjalan" ? (
            <button
              type="button"
              id="sj-tutup-selesai"
              className={TOMBOL_KEDUA}
              onClick={() => setAksi({ jenis: "Selesai" })}
            >
              Tutup Selesai
            </button>
          ) : null}
          {bolehBatal && item.status === "Berjalan" ? (
            <button
              type="button"
              id="sj-batalkan"
              className={TOMBOL_BAHAYA}
              onClick={() => setAksi({ jenis: "Dibatalkan" })}
            >
              Batalkan perjalanan
            </button>
          ) : null}
          {bolehTarif && item.status === "Selesai" ? (
            <button
              type="button"
              id="sj-pindah-upah"
              className={TOMBOL_KEDUA}
              onClick={() => setAksi({ jenis: "upah" })}
            >
              Pindahkan upah
            </button>
          ) : null}
        </div>

        {item.tanda.length > 0 ? (
          <section aria-labelledby="sj-tanda-judul" className="space-y-2">
            <h3
              id="sj-tanda-judul"
              className="text-sm font-semibold text-amber-100"
            >
              Perlu ditinjau ({item.tanda.length})
            </h3>
            <ul className="space-y-1 text-sm text-amber-100">
              {item.tanda.map((t) => {
                const l = laporan.find((x) => x.id_laporan === t.id);
                const m = muatan.find((x) => x.id_muatan === t.id);
                return (
                  <li
                    key={`${t.kode}:${t.id}`}
                    className="rounded-lg border border-amber-300/25 bg-amber-300/10 px-3 py-2"
                  >
                    {LABEL_TANDA[t.kode]}
                    {l ? ` · ${l.jenis} ${waktuWib(l.waktu_perangkat)}` : ""}
                    {m ? ` · ${m.nama_barang}` : ""}
                    {t.kode === "menunggu_persetujuan" && bolehKelola ? (
                      <span className="ml-2 inline-flex gap-2">
                        <button
                          type="button"
                          id={`sj-setujui-${t.id}`}
                          className="underline"
                          onClick={() =>
                            setAksi({ jenis: "Disetujui", idRef: t.id })
                          }
                        >
                          Setujui
                        </button>
                        <button
                          type="button"
                          id={`sj-tolak-${t.id}`}
                          className="underline"
                          onClick={() =>
                            setAksi({ jenis: "Ditolak", idRef: t.id })
                          }
                        >
                          Tolak
                        </button>
                      </span>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </section>
        ) : null}

        <section aria-labelledby="sj-muatan-judul" className="space-y-2">
          <h3
            id="sj-muatan-judul"
            className="text-sm font-semibold text-slate-100"
          >
            Muatan
          </h3>
          <div className="overflow-x-auto">
            <table className="w-full min-w-160 text-left text-sm text-slate-200">
              <thead className="text-xs text-slate-400">
                <tr>
                  <th className="py-2 pr-3">Tempat muat</th>
                  <th className="py-2 pr-3">Barang</th>
                  <th className="py-2 pr-3 text-right">Rencana</th>
                  <th className="py-2 pr-3 text-right">Dimuat</th>
                  <th className="py-2 pr-3 text-right">Dibongkar</th>
                  <th className="py-2 pr-3">Tempat bongkar</th>
                </tr>
              </thead>
              <tbody>
                {muatan.map((m) => (
                  <tr key={m.id_muatan} className="border-t border-white/10">
                    <td className="py-2 pr-3">{m.tempat_muat}</td>
                    <td className="py-2 pr-3">
                      {m.nama_barang}
                      {m.jenis_barang ? ` · ${m.jenis_barang}` : ""}
                      <span className="block text-xs text-slate-400">
                        {m.satuan}
                        {m.berat_kg_x100 != null
                          ? ` · ${beratKg(m.berat_kg_x100)}`
                          : ""}
                      </span>
                    </td>
                    <td className="py-2 pr-3 text-right">{m.qty}</td>
                    <td className="py-2 pr-3 text-right">
                      {adaKonfirmasi("Selesai Muat", m.id_muatan)
                        ? jumlahPer("Selesai Muat", m.id_muatan)
                        : "-"}
                    </td>
                    <td className="py-2 pr-3 text-right">
                      {adaKonfirmasi("Selesai Bongkar", m.id_muatan)
                        ? jumlahPer("Selesai Bongkar", m.id_muatan)
                        : "-"}
                    </td>
                    <td className="py-2 pr-3">{m.tempat_bongkar ?? "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section aria-labelledby="sj-linimasa-judul" className="space-y-2">
          <h3
            id="sj-linimasa-judul"
            className="text-sm font-semibold text-slate-100"
          >
            Linimasa laporan
          </h3>
          {laporan.length === 0 ? (
            <p className="text-sm text-slate-400">Belum ada laporan.</p>
          ) : (
            <ol className="space-y-3">
              {laporan.map((l) => (
                <BarisLaporan
                  key={l.id_laporan}
                  laporan={l}
                  muatan={muatan}
                  foto={foto[l.id_laporan]}
                  onLihatFoto={() => void lihatFoto(l.id_laporan)}
                  namaPersonil={namaPersonil}
                  platKendaraan={platKendaraan}
                />
              ))}
            </ol>
          )}
        </section>
      </div>

      {aksi ? (
        <DialogAksi
          aksi={aksi}
          rincian={rincian}
          master={master}
          onClose={() => setAksi(null)}
          onSelesai={() => void selesaiAksi()}
        />
      ) : null}
    </Modal>
  );
}

function BarisLaporan({
  laporan: l,
  muatan,
  foto,
  onLihatFoto,
  namaPersonil,
  platKendaraan,
}: {
  laporan: LaporanBaris;
  muatan: RincianPerjalanan["muatan"];
  foto: FotoLaporan | "kosong" | undefined;
  onLihatFoto: () => void;
  namaPersonil: (id: string | null | undefined) => string;
  platKendaraan: (id: string | null | undefined) => string;
}) {
  const pelapor = l.id_karyawan
    ? namaPersonil(l.id_karyawan)
    : `Dispatcher (${l.dilaporkan_oleh})`;
  return (
    <li className="rounded-lg border border-white/10 p-3 text-sm text-slate-200">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <strong className="text-slate-100">
          {l.jenis}
          {l.mode_ganti && l.mode_ganti !== "Langsung"
            ? ` (${l.mode_ganti})`
            : ""}
        </strong>
        <span className="text-xs text-slate-400">
          {waktuWib(l.waktu_perangkat)}
        </span>
      </div>
      <p className="text-xs text-slate-400">
        {pelapor}
        {l.diterima_cloud
          ? ` · diterima server ${waktuWib(l.diterima_cloud)}`
          : " · belum sampai server"}
      </p>
      {l.nama_lokasi ? <p>Tempat: {l.nama_lokasi}</p> : null}
      {l.lat != null && l.lng != null ? (
        <p>
          {l.lat.toFixed(5)}, {l.lng.toFixed(5)}
          {l.akurasi_m != null ? ` (±${Math.round(l.akurasi_m)} m)` : ""} ·{" "}
          <a
            href={tautanMaps(l.lat, l.lng)}
            target="_blank"
            rel="noreferrer"
            className="text-sky-300 underline"
          >
            Buka di Maps
          </a>
        </p>
      ) : null}
      {l.jenis_kendala ? (
        <p>
          Kendala: {l.jenis_kendala}
          {l.terlambat_menit != null
            ? ` · perkiraan terlambat ${l.terlambat_menit} menit`
            : ""}
        </p>
      ) : null}
      {l.id_karyawan_baru ? (
        <p>Driver baru: {namaPersonil(l.id_karyawan_baru)}</p>
      ) : null}
      {l.id_kendaraan_baru ? (
        <p>Kendaraan baru: {platKendaraan(l.id_kendaraan_baru)}</p>
      ) : null}
      {l.keterangan ? <p>Keterangan: {l.keterangan}</p> : null}
      {l.muatan.length > 0 ? (
        <ul className="mt-1 list-disc pl-5">
          {l.muatan.map((m) => (
            <li key={m.id_muatan}>
              {muatan.find((x) => x.id_muatan === m.id_muatan)?.nama_barang ??
                m.id_muatan}
              : {m.qty}
            </li>
          ))}
        </ul>
      ) : null}
      {l.foto_sha256 ? (
        <div className="mt-2">
          {foto === undefined ? (
            <button
              type="button"
              id={`foto-${l.id_laporan}`}
              className={TOMBOL_KEDUA}
              onClick={onLihatFoto}
            >
              Lihat foto
            </button>
          ) : foto === "kosong" ? (
            <p className="text-xs text-slate-400">
              Foto belum sampai di server, sudah dihapus (lebih dari 90 hari),
              atau perangkat sedang offline.
            </p>
          ) : (
            // biome-ignore lint/performance/noImgElement: sumbernya data URI dari database, bukan aset statis
            <img
              src={`data:${foto.mime_type};base64,${foto.data_base64}`}
              alt={`Foto laporan ${l.jenis}`}
              className="max-h-96 rounded-lg border border-white/10"
            />
          )}
        </div>
      ) : null}
    </li>
  );
}

function DialogAksi({
  aksi,
  rincian,
  master,
  onClose,
  onSelesai,
}: {
  aksi: Aksi;
  rincian: RincianPerjalanan;
  master: MasterPerjalanan;
  onClose: () => void;
  onSelesai: () => void;
}) {
  const { item } = rincian;
  const [pilihan, setPilihan] = useState(
    aksi.jenis === "upah" ? (item.id_karyawan_upah ?? "") : "",
  );
  const [alasan, setAlasan] = useState("");
  const [galat, setGalat] = useState<string | null>(null);
  const [menyimpan, setMenyimpan] = useState(false);
  const isSubmittingRef = useRef(false);

  const butuhPilihan =
    aksi.jenis === "Ganti Kendaraan" || aksi.jenis === "Ganti Driver";
  const butuhAlasan =
    aksi.jenis === "Ditolak" ||
    aksi.jenis === "Tidak Jalan" ||
    aksi.jenis === "Dibatalkan" ||
    aksi.jenis === "Selesai";

  async function kirim(event: FormEvent) {
    event.preventDefault();
    if (isSubmittingRef.current) return;
    setGalat(null);
    isSubmittingRef.current = true;
    setMenyimpan(true);
    try {
      if (aksi.jenis === "upah") {
        await aturPenerimaUpah(item.id_perjalanan, pilihan || null);
      } else {
        await catatLaporanDispatcher({
          id_laporan: crypto.randomUUID(),
          id_perjalanan: item.id_perjalanan,
          jenis: aksi.jenis,
          id_ref: "idRef" in aksi ? aksi.idRef : null,
          id_kendaraan_baru: aksi.jenis === "Ganti Kendaraan" ? pilihan : null,
          id_karyawan_baru: aksi.jenis === "Ganti Driver" ? pilihan : null,
          keterangan: alasan || null,
          waktu_perangkat: sekarangUtc(),
        });
      }
      onSelesai();
    } catch (error) {
      setGalat(pesanGalat(error, "Tindakan tidak bisa disimpan."));
    } finally {
      isSubmittingRef.current = false;
      setMenyimpan(false);
    }
  }

  return (
    <Modal
      isOpen
      title={JUDUL_AKSI[aksi.jenis]}
      titleId="aksi-perjalanan-title"
      subtitle={item.nomor}
      onClose={onClose}
    >
      <form id="form-aksi-perjalanan" onSubmit={kirim} className="space-y-4">
        {aksi.jenis === "Dibatalkan" ? (
          <p className="text-sm text-amber-100">
            Surat jalan yang dibatalkan tidak dibayar.
          </p>
        ) : null}
        {butuhPilihan || aksi.jenis === "upah" ? (
          <div>
            <label className={LABEL} htmlFor="aksi-pilihan">
              {aksi.jenis === "Ganti Kendaraan"
                ? "Kendaraan pengganti"
                : aksi.jenis === "Ganti Driver"
                  ? "Driver pengganti"
                  : "Penerima upah"}
            </label>
            <PilihCari
              id="aksi-pilihan"
              className={INPUT}
              value={pilihan}
              onChange={(e) => setPilihan(e.target.value)}
            >
              <option value="">
                {aksi.jenis === "upah"
                  ? "Aturan bawaan (driver yang menutup Selesai)"
                  : "Pilih"}
              </option>
              {aksi.jenis === "Ganti Kendaraan"
                ? master.kendaraan
                    .filter(
                      (k) =>
                        k.status_aktif === 1 &&
                        k.id_kendaraan !== item.id_kendaraan,
                    )
                    .map((k) => (
                      <option key={k.id_kendaraan} value={k.id_kendaraan}>
                        {k.identitas}
                      </option>
                    ))
                : master.personil
                    .filter(
                      (p) =>
                        aksi.jenis === "upah" || p.id_unik !== item.id_karyawan,
                    )
                    .map((p) => (
                      <option key={p.id_unik} value={p.id_unik}>
                        {p.nama} · {p.divisi}
                      </option>
                    ))}
            </PilihCari>
          </div>
        ) : null}
        {aksi.jenis !== "upah" ? (
          <div>
            <label className={LABEL} htmlFor="aksi-alasan">
              {butuhAlasan ? "Alasan" : "Keterangan (opsional)"}
            </label>
            <textarea
              id="aksi-alasan"
              className={INPUT}
              rows={3}
              maxLength={500}
              value={alasan}
              onChange={(e) => setAlasan(e.target.value)}
            />
          </div>
        ) : null}
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
            id="aksi-simpan"
            className={
              aksi.jenis === "Dibatalkan" ? TOMBOL_BAHAYA : TOMBOL_UTAMA
            }
            disabled={menyimpan}
          >
            {menyimpan ? "Menyimpan..." : JUDUL_AKSI[aksi.jenis]}
          </button>
        </div>
      </form>
    </Modal>
  );
}
