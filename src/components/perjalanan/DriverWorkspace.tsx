"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  INPUT,
  LABEL,
  pesanGalat,
  TOMBOL_KEDUA,
  TOMBOL_UTAMA,
} from "@/components/inventory/gaya";
import { Modal } from "@/components/ui/Modal";
import {
  ambilPosisi,
  type FotoTerstempel,
  lokasiTerdekat,
  type PosisiLaporan,
  potretTerstempel,
  utcTeks,
  waktuStempel,
} from "@/lib/client/foto-laporan";
import { openFaceCamera, stopVideoStream } from "@/lib/client/scan-photo";
import { getCompanyBranding } from "@/lib/gateways/company-profile";
import {
  catatLaporanDriver,
  daftarPerjalananSaya,
  type PerjalananSaya,
  type RincianPerjalanan,
  rincianPerjalananSaya,
} from "@/lib/gateways/driver";
import {
  getSyncStatus,
  requestSyncNow,
  subscribeSyncCompleted,
} from "@/lib/gateways/sync-status";
import { isDesktopRuntime } from "@/lib/runtime/app-runtime";
import {
  AKURASI_PERINGATAN_M,
  JENIS_KENDALA,
  laporanDraftSchema,
  periksaUrutan,
  titikTerbuka,
  validateLaporan,
} from "@/lib/validations/driver";
import { WARNA_STATUS, waktuWib } from "./tampilan";

/**
 * Layar driver (Mobile; juga jalan di Desktop). Satu tombol besar untuk
 * langkah berikutnya. Laporan disimpan di HP lebih dulu (outbox), jadi tetap
 * bisa dikirim tanpa sinyal. Urutan diperiksa di sini dan di backend
 * perangkat; cloud tidak pernah menolak karena urutan.
 */

type JenisDriver =
  | "Berangkat"
  | "Tiba Muat"
  | "Selesai Muat"
  | "Tiba Bongkar"
  | "Selesai Bongkar"
  | "Kendala"
  | "Ganti Kendaraan"
  | "Ganti Driver"
  | "Selesai";

interface Lapor {
  jenis: JenisDriver;
  idPerjalanan: string;
  nomor: string;
  /** Ambil alih: Ganti Driver atas nama driver yang login. */
  ambilAlih?: boolean;
}

const LABEL_TOMBOL: Record<JenisDriver, string> = {
  Berangkat: "Berangkat dari pool",
  "Tiba Muat": "Tiba di tempat muat",
  "Selesai Muat": "Selesai muat",
  "Tiba Bongkar": "Tiba di tempat bongkar",
  "Selesai Bongkar": "Selesai bongkar",
  Kendala: "Lapor kendala",
  "Ganti Kendaraan": "Ganti kendaraan",
  "Ganti Driver": "Serahkan ke driver lain",
  Selesai: "Selesai pengiriman",
};

const GALAT_KOTAK =
  "p-3 rounded-lg border border-rose-500/30 bg-rose-500/20 text-sm text-rose-100";
const TOMBOL_BESAR =
  "w-full min-h-16 rounded-2xl bg-sky-600 px-4 py-4 text-lg font-bold text-white hover:bg-sky-500 disabled:opacity-60 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-300";

function tanggalWib(selisihHari: number): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta" }).format(
    new Date(Date.now() + selisihHari * 86_400_000),
  );
}

export function DriverWorkspace() {
  const [data, setData] = useState<PerjalananSaya | null>(null);
  const [dipilih, setDipilih] = useState<string | null>(null);
  const [rincian, setRincian] = useState<RincianPerjalanan | null>(null);
  const [galat, setGalat] = useState<string | null>(null);
  const [pesan, setPesan] = useState<string | null>(null);
  const [tertunda, setTertunda] = useState(0);
  const [lapor, setLapor] = useState<Lapor | null>(null);
  const [perusahaan, setPerusahaan] = useState<string>("");

  const muat = useCallback(async () => {
    setGalat(null);
    try {
      const hasil = await daftarPerjalananSaya(tanggalWib(-2), tanggalWib(2));
      setData(hasil);
      if (dipilih) {
        setRincian(
          hasil.saya.some((s) => s.id_perjalanan === dipilih)
            ? await rincianPerjalananSaya(dipilih)
            : null,
        );
      }
      setTertunda((await getSyncStatus())?.pending ?? 0);
    } catch (error) {
      setGalat(pesanGalat(error, "Perjalanan tidak bisa dimuat."));
    }
  }, [dipilih]);

  useEffect(() => {
    void muat();
  }, [muat]);
  useEffect(() => subscribeSyncCompleted(() => void muat()), [muat]);
  useEffect(() => {
    getCompanyBranding()
      .then((b) => setPerusahaan(b.company_name ?? ""))
      .catch(() => undefined);
  }, []);

  if (!isDesktopRuntime()) {
    return (
      <p className="rounded-2xl border border-white/10 bg-slate-900/60 p-4 text-sm text-slate-300">
        Laporan perjalanan dikirim dari aplikasi di HP, karena butuh kamera dan
        GPS dan harus tetap bisa dicatat tanpa sinyal.
      </p>
    );
  }

  const item = data?.saya.find((s) => s.id_perjalanan === dipilih) ?? null;

  return (
    <div className="space-y-4">
      {tertunda > 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-300/30 bg-amber-300/10 p-3 text-sm text-amber-100">
          <span>{tertunda} data belum terkirim ke server.</span>
          <button
            type="button"
            id="driver-kirim-sekarang"
            className={TOMBOL_KEDUA}
            onClick={() => requestSyncNow()}
          >
            Kirim sekarang
          </button>
        </div>
      ) : null}
      {galat ? (
        <div className={GALAT_KOTAK} role="alert">
          {galat}
        </div>
      ) : null}
      {pesan ? (
        <output className="block rounded-lg border border-emerald-500/30 bg-emerald-500/15 p-3 text-sm text-emerald-100">
          {pesan}
        </output>
      ) : null}

      {item && rincian ? (
        <RincianDriver
          rincian={rincian}
          onKembali={() => {
            setDipilih(null);
            setRincian(null);
          }}
          onLapor={(jenis) =>
            setLapor({
              jenis,
              idPerjalanan: item.id_perjalanan,
              nomor: item.nomor,
            })
          }
        />
      ) : (
        <DaftarSaya
          data={data}
          onPilih={(id) => {
            setPesan(null);
            setDipilih(id);
          }}
          onAmbilAlih={(idPerjalanan, nomor) =>
            setLapor({
              jenis: "Ganti Driver",
              idPerjalanan,
              nomor,
              ambilAlih: true,
            })
          }
        />
      )}

      {lapor && data ? (
        <DialogLapor
          lapor={lapor}
          data={data}
          rincian={lapor.ambilAlih ? null : rincian}
          perusahaan={perusahaan}
          onClose={() => setLapor(null)}
          onTerkirim={(teks) => {
            setLapor(null);
            setPesan(teks);
            if (lapor.ambilAlih) setDipilih(lapor.idPerjalanan);
            void muat();
            requestSyncNow();
          }}
        />
      ) : null}
    </div>
  );
}

function DaftarSaya({
  data,
  onPilih,
  onAmbilAlih,
}: {
  data: PerjalananSaya | null;
  onPilih: (id: string) => void;
  onAmbilAlih: (idPerjalanan: string, nomor: string) => void;
}) {
  const [bukaLain, setBukaLain] = useState(false);
  if (!data) return <p className="text-sm text-slate-400">Memuat...</p>;
  const aktif = data.saya.filter(
    (s) => s.status === "Direncanakan" || s.status === "Berjalan",
  );
  const lewat = data.saya.filter((s) => !aktif.includes(s));
  return (
    <div className="space-y-4">
      <h2 className="text-sm font-semibold text-slate-100">Perjalanan saya</h2>
      {aktif.length === 0 ? (
        <p className="rounded-xl border border-white/10 p-4 text-sm text-slate-300">
          Tidak ada surat jalan yang ditugaskan kepada Anda. Minta dispatcher
          membuatnya, lalu tarik ke bawah atau tunggu sinkronisasi.
        </p>
      ) : null}
      <ul className="space-y-2">
        {[...aktif, ...lewat].map((s) => (
          <li key={s.id_perjalanan}>
            <button
              type="button"
              id={`driver-surat-${s.id_perjalanan}`}
              className="w-full rounded-2xl border border-white/10 bg-slate-900/60 p-4 text-left"
              onClick={() => onPilih(s.id_perjalanan)}
            >
              <div className="flex flex-wrap items-center gap-2">
                <strong className="text-base text-slate-100">{s.nomor}</strong>
                <span
                  className={`rounded-full border px-2 py-0.5 text-xs font-semibold ${WARNA_STATUS[s.status]}`}
                >
                  {s.status}
                </span>
              </div>
              <p className="mt-1 text-sm text-slate-300">
                {s.tanggal} · {s.identitas_kendaraan ?? "-"} ·{" "}
                {s.nama_kategori ?? "-"}
              </p>
            </button>
          </li>
        ))}
      </ul>
      {data.lain.length > 0 ? (
        <section className="space-y-2">
          <button
            type="button"
            id="driver-ambil-alih-buka"
            className={TOMBOL_KEDUA}
            aria-expanded={bukaLain}
            onClick={() => setBukaLain((v) => !v)}
          >
            Ambil alih perjalanan driver lain (darurat)
          </button>
          {bukaLain ? (
            <ul className="space-y-2">
              {data.lain.map((l) => (
                <li
                  key={l.id_perjalanan}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-white/10 p-3 text-sm text-slate-200"
                >
                  <span>
                    {l.nomor} · {l.nama_karyawan ?? "-"} ·{" "}
                    {l.identitas_kendaraan ?? "-"}
                  </span>
                  <button
                    type="button"
                    id={`driver-ambil-alih-${l.id_perjalanan}`}
                    className={TOMBOL_KEDUA}
                    onClick={() => onAmbilAlih(l.id_perjalanan, l.nomor)}
                  >
                    Ambil alih
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}

function RincianDriver({
  rincian,
  onKembali,
  onLapor,
}: {
  rincian: RincianPerjalanan;
  onKembali: () => void;
  onLapor: (jenis: JenisDriver) => void;
}) {
  const { item, laporan } = rincian;
  const terbuka = titikTerbuka(laporan);
  const ditutup = item.status !== "Direncanakan" && item.status !== "Berjalan";
  const menunggu = laporan.filter((l) =>
    item.menunggu_persetujuan.includes(l.id_laporan),
  );

  let utama: JenisDriver[] = [];
  if (item.status === "Direncanakan") utama = ["Berangkat"];
  else if (terbuka === "muat") utama = ["Selesai Muat"];
  else if (terbuka === "bongkar") utama = ["Selesai Bongkar"];
  else if (item.status === "Berjalan") {
    utama = ["Tiba Muat", "Tiba Bongkar", "Selesai"];
  }

  return (
    <div className="space-y-4">
      <button
        type="button"
        id="driver-kembali"
        className={TOMBOL_KEDUA}
        onClick={onKembali}
      >
        Kembali ke daftar
      </button>
      <div className="rounded-2xl border border-white/10 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <strong className="text-lg text-slate-100">{item.nomor}</strong>
          <span
            className={`rounded-full border px-2 py-0.5 text-xs font-semibold ${WARNA_STATUS[item.status]}`}
          >
            {item.status}
          </span>
        </div>
        <p className="mt-1 text-sm text-slate-300">
          {item.identitas_kendaraan ?? "-"} · {item.nama_kategori ?? "-"}
        </p>
        {terbuka ? (
          <p className="mt-1 text-sm text-sky-100">
            Sedang di tempat {terbuka}.
          </p>
        ) : null}
      </div>

      {ditutup ? (
        <p className="rounded-xl border border-white/10 p-4 text-sm text-slate-300">
          Perjalanan ini sudah ditutup ({item.status}).
        </p>
      ) : (
        <div className="space-y-2">
          {utama.map((jenis, i) => (
            <button
              key={jenis}
              type="button"
              id={`driver-lapor-${jenis.toLowerCase().replaceAll(" ", "-")}`}
              className={
                i === 0 ? TOMBOL_BESAR : `${TOMBOL_UTAMA} w-full min-h-14`
              }
              onClick={() => onLapor(jenis)}
            >
              {LABEL_TOMBOL[jenis]}
            </button>
          ))}
          <div className="grid grid-cols-1 gap-2 pt-2 sm:grid-cols-3">
            {(["Kendala", "Ganti Kendaraan", "Ganti Driver"] as const).map(
              (jenis) => (
                <button
                  key={jenis}
                  type="button"
                  id={`driver-lapor-${jenis.toLowerCase().replaceAll(" ", "-")}`}
                  className={`${TOMBOL_KEDUA} w-full`}
                  onClick={() => onLapor(jenis)}
                >
                  {LABEL_TOMBOL[jenis]}
                </button>
              ),
            )}
          </div>
        </div>
      )}

      {menunggu.length > 0 ? (
        <p className="rounded-xl border border-amber-300/30 bg-amber-300/10 p-3 text-sm text-amber-100">
          Menunggu keputusan dispatcher:{" "}
          {menunggu.map((l) => `${l.jenis} (${l.mode_ganti})`).join(", ")}.
        </p>
      ) : null}

      <section className="space-y-2">
        <h3 className="text-sm font-semibold text-slate-100">
          Riwayat laporan
        </h3>
        {laporan.length === 0 ? (
          <p className="text-sm text-slate-400">Belum ada laporan.</p>
        ) : (
          <ol className="space-y-1 text-sm text-slate-300">
            {[...laporan].reverse().map((l) => (
              <li
                key={l.id_laporan}
                className="rounded-lg border border-white/10 px-3 py-2"
              >
                <strong className="text-slate-100">{l.jenis}</strong>
                {l.nama_lokasi ? ` · ${l.nama_lokasi}` : ""}
                <span className="block text-xs text-slate-400">
                  {waktuWib(l.waktu_perangkat)}
                  {l.diterima_cloud ? "" : " · belum terkirim"}
                </span>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}

interface BarisMuatan {
  id_muatan: string;
  nama: string;
  ikut: boolean;
  qty: string;
}

/** Baris konfirmasi muat/bongkar, terisi dari rencana dispatcher (Q-23, Q-27). */
function barisAwal(
  jenis: JenisDriver,
  rincian: RincianPerjalanan | null,
): BarisMuatan[] {
  if (!rincian || (jenis !== "Selesai Muat" && jenis !== "Selesai Bongkar")) {
    return [];
  }
  const { muatan, laporan } = rincian;
  const total = (j: string, id: string) =>
    laporan
      .filter((l) => l.jenis === j)
      .flatMap((l) => l.muatan)
      .filter((m) => m.id_muatan === id)
      .reduce((s, m) => s + m.qty, 0);
  const tiba = [...laporan]
    .reverse()
    .find(
      (l) =>
        l.jenis === (jenis === "Selesai Muat" ? "Tiba Muat" : "Tiba Bongkar"),
    );
  const tempat = tiba?.nama_lokasi?.trim().toLowerCase() ?? "";
  const baris = muatan.map((m) => {
    const dimuat = total("Selesai Muat", m.id_muatan);
    const sisa =
      jenis === "Selesai Muat"
        ? Math.max(m.qty - dimuat, 0)
        : Math.max(dimuat - total("Selesai Bongkar", m.id_muatan), 0);
    const tempatBaris = (
      jenis === "Selesai Muat" ? m.tempat_muat : (m.tempat_bongkar ?? "")
    )
      .trim()
      .toLowerCase();
    return {
      id_muatan: m.id_muatan,
      nama: `${m.nama_barang} (${m.satuan})`,
      cocok: tempat !== "" && tempatBaris === tempat,
      sisa,
    };
  });
  const adaCocok = baris.some((b) => b.cocok && b.sisa > 0);
  return baris
    .filter((b) => b.sisa > 0)
    .map((b) => ({
      id_muatan: b.id_muatan,
      nama: b.nama,
      ikut: adaCocok ? b.cocok : true,
      qty: String(b.sisa),
    }));
}

function DialogLapor({
  lapor,
  data,
  rincian,
  perusahaan,
  onClose,
  onTerkirim,
}: {
  lapor: Lapor;
  data: PerjalananSaya;
  rincian: RincianPerjalanan | null;
  perusahaan: string;
  onClose: () => void;
  onTerkirim: (pesan: string) => void;
}) {
  const { jenis } = lapor;
  const item = rincian?.item ?? null;
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const isSubmittingRef = useRef(false);
  // Sekali per penekanan tombol lapor: kiriman ulang tidak mencatat dua kali.
  const idLaporan = useMemo(() => `lap-${crypto.randomUUID()}`, []);

  const [posisi, setPosisi] = useState<PosisiLaporan | null>(null);
  const [galatGps, setGalatGps] = useState<string | null>(null);
  const [mencariGps, setMencariGps] = useState(false);
  const [namaTempat, setNamaTempat] = useState("");
  const [idLokasi, setIdLokasi] = useState<string | null>(null);
  const [jenisKendala, setJenisKendala] = useState("");
  const [terlambat, setTerlambat] = useState("");
  const [keterangan, setKeterangan] = useState("");
  const [mode, setMode] = useState<"Darurat" | "Minta Izin">("Darurat");
  const [pengganti, setPengganti] = useState(
    lapor.ambilAlih ? data.id_karyawan : "",
  );
  const [baris, setBaris] = useState<BarisMuatan[]>(() =>
    barisAwal(jenis, rincian),
  );
  const [foto, setFoto] = useState<(FotoTerstempel & { waktu: Date }) | null>(
    null,
  );
  const [kameraSiap, setKameraSiap] = useState(false);
  const [galat, setGalat] = useState<string | null>(null);
  const [mengirim, setMengirim] = useState(false);

  const cariGps = useCallback(async () => {
    setMencariGps(true);
    setGalatGps(null);
    try {
      const hasil = await ambilPosisi();
      setPosisi(hasil);
      const dekat = lokasiTerdekat(hasil, data.lokasi);
      setIdLokasi(dekat?.id_lokasi ?? null);
      if (dekat) setNamaTempat((lama) => lama || dekat.nama);
    } catch (error) {
      setGalatGps(pesanGalat(error, "Lokasi GPS belum didapat."));
    } finally {
      setMencariGps(false);
    }
  }, [data.lokasi]);

  useEffect(() => {
    void cariGps();
  }, [cariGps]);

  const nyalakanKamera = useCallback(async () => {
    const video = videoRef.current;
    if (!video || video.srcObject) return;
    try {
      video.srcObject = await openFaceCamera("environment");
      await video.play();
      setKameraSiap(true);
    } catch (error) {
      setGalat(pesanGalat(error, "Kamera tidak bisa dibuka."));
    }
  }, []);

  useEffect(() => {
    if (!foto) void nyalakanKamera();
  }, [foto, nyalakanKamera]);

  // Aturan 14: kamera dilepas saat dialog ditutup, di efek terpisah tanpa dependensi.
  useEffect(() => {
    const video = videoRef.current;
    return () => stopVideoStream(video);
  }, []);

  // Aplikasi ke latar belakang: lepaskan kamera, nyalakan lagi saat kembali.
  useEffect(() => {
    const ubah = () => {
      if (document.visibilityState === "hidden") {
        stopVideoStream(videoRef.current);
        setKameraSiap(false);
      } else if (!foto) {
        void nyalakanKamera();
      }
    };
    document.addEventListener("visibilitychange", ubah);
    return () => document.removeEventListener("visibilitychange", ubah);
  }, [foto, nyalakanKamera]);

  const kendaraanSaatIni = data.kendaraan.find(
    (k) => k.id_kendaraan === item?.id_kendaraan,
  );

  function potret() {
    setGalat(null);
    if (!posisi) {
      setGalat("Tunggu lokasi GPS didapat sebelum mengambil foto.");
      return;
    }
    const video = videoRef.current;
    if (!video) return;
    try {
      const waktu = new Date();
      const hasil = potretTerstempel(video, [
        perusahaan || "Perusahaan",
        `${jenis} · ${namaTempat || "-"}`,
        `${data.nama ?? data.id_karyawan} · ${[kendaraanSaatIni?.nama_jenis, item?.identitas_kendaraan].filter(Boolean).join(" ") || lapor.nomor}`,
        `${posisi.lat.toFixed(5)}, ${posisi.lng.toFixed(5)} (±${Math.round(posisi.akurasi)} m)`,
        waktuStempel(waktu),
      ]);
      setFoto({ ...hasil, waktu });
      stopVideoStream(video);
      setKameraSiap(false);
    } catch (error) {
      setGalat(pesanGalat(error, "Foto tidak bisa diambil."));
    }
  }

  async function kirim() {
    if (isSubmittingRef.current || !foto || !posisi) return;
    setGalat(null);
    const draft = laporanDraftSchema.parse({
      id_laporan: idLaporan,
      id_perjalanan: lapor.idPerjalanan,
      jenis,
      mode_ganti: jenis.startsWith("Ganti ") ? mode : null,
      jenis_kendala: jenis === "Kendala" ? jenisKendala || null : null,
      terlambat_menit:
        jenis === "Kendala" && terlambat
          ? Number(terlambat.replace(/\D/g, ""))
          : null,
      id_lokasi: idLokasi,
      nama_lokasi: namaTempat || null,
      lat: posisi.lat,
      lng: posisi.lng,
      akurasi_m: posisi.akurasi,
      waktu_perangkat: utcTeks(foto.waktu),
      waktu_gps: posisi.waktuGps,
      id_karyawan_baru: jenis === "Ganti Driver" ? pengganti || null : null,
      id_kendaraan_baru: jenis === "Ganti Kendaraan" ? pengganti || null : null,
      keterangan: keterangan || null,
      muatan: baris
        .filter((b) => b.ikut)
        .map((b) => ({
          id_muatan: b.id_muatan,
          qty: Number(b.qty.replace(/\D/g, "") || 0),
        })),
    });
    const lokal = validateLaporan(draft, true, true);
    if (!lokal.ok) {
      setGalat(lokal.error);
      return;
    }
    if (rincian) {
      const urutan = periksaUrutan(rincian.laporan, jenis);
      if (!urutan.ok) {
        setGalat(urutan.error);
        return;
      }
    }
    isSubmittingRef.current = true;
    setMengirim(true);
    try {
      await catatLaporanDriver(draft, {
        mime_type: foto.mime_type,
        data_base64: foto.data_base64,
      });
      onTerkirim(
        `${jenis} tersimpan. Laporan terkirim otomatis saat ada sinyal.`,
      );
    } catch (error) {
      setGalat(pesanGalat(error, "Laporan tidak bisa disimpan."));
    } finally {
      isSubmittingRef.current = false;
      setMengirim(false);
    }
  }

  const butuhTempat = jenis === "Tiba Muat" || jenis === "Tiba Bongkar";

  return (
    <Modal
      isOpen
      title={lapor.ambilAlih ? "Ambil alih perjalanan" : LABEL_TOMBOL[jenis]}
      titleId="lapor-driver-title"
      subtitle={lapor.nomor}
      onClose={onClose}
      maxWidth="max-w-2xl"
    >
      <div className="space-y-4">
        <section className="space-y-1 text-sm">
          <p className="font-semibold text-slate-100">1. Lokasi</p>
          {posisi ? (
            <p className="text-slate-300">
              {posisi.lat.toFixed(5)}, {posisi.lng.toFixed(5)} (±
              {Math.round(posisi.akurasi)} m)
            </p>
          ) : (
            <p className="text-slate-400">
              {mencariGps ? "Mencari lokasi GPS..." : "Lokasi belum didapat."}
            </p>
          )}
          {posisi && posisi.akurasi > AKURASI_PERINGATAN_M ? (
            <p className="text-amber-100">
              Akurasi GPS kurang baik. Bila bisa, pindah ke tempat terbuka lalu
              cari ulang.
            </p>
          ) : null}
          {galatGps ? <p className="text-rose-100">{galatGps}</p> : null}
          <button
            type="button"
            id="lapor-cari-gps"
            className={TOMBOL_KEDUA}
            disabled={mencariGps}
            onClick={() => void cariGps()}
          >
            Cari ulang lokasi
          </button>
        </section>

        <div>
          <label className={LABEL} htmlFor="lapor-tempat">
            Nama tempat{butuhTempat ? "" : " (opsional)"}
          </label>
          <input
            id="lapor-tempat"
            className={INPUT}
            value={namaTempat}
            maxLength={120}
            onChange={(e) => {
              setNamaTempat(e.target.value);
              setFoto(null);
            }}
          />
          {idLokasi ? (
            <p className="mt-1 text-xs text-slate-400">
              Dalam radius lokasi terdaftar.
            </p>
          ) : null}
        </div>

        {jenis === "Kendala" ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className={LABEL} htmlFor="lapor-kendala">
                Jenis kendala
              </label>
              <select
                id="lapor-kendala"
                className={INPUT}
                value={jenisKendala}
                onChange={(e) => setJenisKendala(e.target.value)}
              >
                <option value="">Pilih jenis kendala</option>
                {JENIS_KENDALA.map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className={LABEL} htmlFor="lapor-terlambat">
                Perkiraan terlambat (menit, opsional)
              </label>
              <input
                id="lapor-terlambat"
                className={INPUT}
                inputMode="numeric"
                value={terlambat}
                onChange={(e) => setTerlambat(e.target.value)}
              />
            </div>
          </div>
        ) : null}

        {jenis === "Ganti Kendaraan" ||
        (jenis === "Ganti Driver" && !lapor.ambilAlih) ? (
          <div>
            <label className={LABEL} htmlFor="lapor-pengganti">
              {jenis === "Ganti Kendaraan"
                ? "Kendaraan pengganti"
                : "Driver pengganti"}
            </label>
            <select
              id="lapor-pengganti"
              className={INPUT}
              value={pengganti}
              onChange={(e) => setPengganti(e.target.value)}
            >
              <option value="">Pilih</option>
              {jenis === "Ganti Kendaraan"
                ? data.kendaraan
                    .filter((k) => k.id_kendaraan !== item?.id_kendaraan)
                    .map((k) => (
                      <option key={k.id_kendaraan} value={k.id_kendaraan}>
                        {k.identitas}
                        {k.nama_jenis ? ` · ${k.nama_jenis}` : ""}
                      </option>
                    ))
                : data.personil
                    .filter((p) => p.id_unik !== data.id_karyawan)
                    .map((p) => (
                      <option key={p.id_unik} value={p.id_unik}>
                        {p.nama}
                      </option>
                    ))}
            </select>
          </div>
        ) : null}

        {jenis.startsWith("Ganti ") ? (
          <fieldset className="space-y-2 text-sm text-slate-200">
            <legend className={LABEL}>Cara ganti</legend>
            <label className="flex items-start gap-2">
              <input
                type="radio"
                id="lapor-mode-darurat"
                name="lapor-mode"
                checked={mode === "Darurat"}
                onChange={() => setMode("Darurat")}
              />
              Darurat: langsung berlaku, dispatcher meninjau belakangan (tanpa
              sinyal pun bisa).
            </label>
            <label className="flex items-start gap-2">
              <input
                type="radio"
                id="lapor-mode-izin"
                name="lapor-mode"
                checked={mode === "Minta Izin"}
                onChange={() => setMode("Minta Izin")}
              />
              Minta izin dulu: baru berlaku setelah dispatcher menyetujui.
            </label>
          </fieldset>
        ) : null}

        {baris.length > 0 ? (
          <fieldset className="space-y-2">
            <legend className="text-sm font-semibold text-slate-100">
              {jenis === "Selesai Muat"
                ? "Barang yang dimuat di sini"
                : "Barang yang diturunkan di sini"}
            </legend>
            {baris.map((b, i) => (
              <div key={b.id_muatan} className="flex items-center gap-3">
                <input
                  type="checkbox"
                  id={`lapor-muatan-${i}-ikut`}
                  checked={b.ikut}
                  onChange={(e) =>
                    setBaris((lama) =>
                      lama.map((x, j) =>
                        j === i ? { ...x, ikut: e.target.checked } : x,
                      ),
                    )
                  }
                />
                <label
                  htmlFor={`lapor-muatan-${i}-ikut`}
                  className="flex-1 text-sm text-slate-200"
                >
                  {b.nama}
                </label>
                <label className="sr-only" htmlFor={`lapor-muatan-${i}-qty`}>
                  Jumlah {b.nama}
                </label>
                <input
                  id={`lapor-muatan-${i}-qty`}
                  className={`${INPUT} w-24`}
                  inputMode="numeric"
                  value={b.qty}
                  disabled={!b.ikut}
                  onChange={(e) =>
                    setBaris((lama) =>
                      lama.map((x, j) =>
                        j === i ? { ...x, qty: e.target.value } : x,
                      ),
                    )
                  }
                />
              </div>
            ))}
          </fieldset>
        ) : null}

        <div>
          <label className={LABEL} htmlFor="lapor-keterangan">
            {jenis.startsWith("Ganti ")
              ? "Alasan"
              : jenis === "Kendala"
                ? "Keterangan (wajib bila Lainnya)"
                : "Keterangan (opsional)"}
          </label>
          <textarea
            id="lapor-keterangan"
            className={INPUT}
            rows={2}
            maxLength={500}
            value={keterangan}
            onChange={(e) => setKeterangan(e.target.value)}
          />
        </div>

        <section className="space-y-2">
          <p className="text-sm font-semibold text-slate-100">2. Foto</p>
          {/* Satu elemen video sepanjang dialog: pembersihan saat ditutup selalu
              mengenai stream yang aktif (aturan 14). */}
          <video
            ref={videoRef}
            className={`w-full rounded-xl border border-white/10 bg-black ${foto ? "hidden" : ""}`}
            playsInline
            muted
          />
          {foto ? (
            <>
              {/* biome-ignore lint/performance/noImgElement: hasil kamera berupa data URI, bukan aset statis */}
              <img
                src={foto.dataUrl}
                alt="Pratinjau foto laporan"
                className="w-full rounded-xl border border-white/10"
              />
              <button
                type="button"
                id="lapor-ulang-foto"
                className={TOMBOL_KEDUA}
                onClick={() => setFoto(null)}
              >
                Ambil ulang
              </button>
            </>
          ) : (
            <button
              type="button"
              id="lapor-ambil-foto"
              className={TOMBOL_UTAMA}
              disabled={!kameraSiap || !posisi}
              onClick={potret}
            >
              Ambil foto
            </button>
          )}
        </section>

        {galat ? (
          <div className={GALAT_KOTAK} role="alert">
            {galat}
          </div>
        ) : null}

        <button
          type="button"
          id="lapor-kirim"
          className={TOMBOL_BESAR}
          disabled={!foto || !posisi || mengirim}
          onClick={() => void kirim()}
        >
          {mengirim ? "Menyimpan..." : "Kirim laporan"}
        </button>
      </div>
    </Modal>
  );
}
