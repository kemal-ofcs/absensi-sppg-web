"use client";

import { type FormEvent, type ReactNode, useRef, useState } from "react";
import {
  INPUT,
  LABEL,
  pesanGalat,
  TOMBOL_KEDUA,
  TOMBOL_UTAMA,
} from "@/components/inventory/gaya";
import { konfirmasiData } from "@/components/ui/KonfirmasiData";
import { Modal } from "@/components/ui/Modal";
import { hasPermission } from "@/lib/auth/access";
import { getCurrentCoordinates } from "@/lib/client/geolocation";
import { useAuth } from "@/lib/context/AuthContext";
import {
  type MasterPerjalanan,
  simpanJenisKendaraan,
  simpanKategoriTujuan,
  simpanKendaraan,
  simpanLokasi,
  simpanPrefixSuratJalan,
} from "@/lib/gateways/driver";
import { formatRupiah } from "@/lib/validations/accounting";
import {
  formatNomorSuratJalan,
  JENIS_LOKASI,
  normalisasiPrefix,
} from "@/lib/validations/driver";

/**
 * Master armada: awalan nomor surat jalan, daftar tarif (jenis kendaraan dan
 * kategori tujuan), kendaraan, dan lokasi terdaftar. Tarif hanya bisa diubah
 * pemegang `trip.tariff`; backend tetap menolaknya tanpa izin itu.
 */

type Feedback = { tone: "success" | "error"; message: string } | null;

type Form =
  | { jenis: "jenis"; baris: MasterPerjalanan["jenis"][number] | null }
  | { jenis: "kategori"; baris: MasterPerjalanan["kategori"][number] | null }
  | { jenis: "kendaraan"; baris: MasterPerjalanan["kendaraan"][number] | null }
  | { jenis: "lokasi"; baris: MasterPerjalanan["lokasi"][number] | null };

const GALAT_KOTAK =
  "p-3 rounded-lg border border-rose-500/30 bg-rose-500/20 text-sm text-rose-100";

function bacaRupiah(teks: string): number {
  const digit = teks.replace(/\D/g, "");
  return digit ? Number(digit) : 0;
}

function bacaKoordinat(teks: string): number {
  return Number(teks.trim().replace(",", "."));
}

export function ArmadaPanel({
  master,
  onBerubah,
}: {
  master: MasterPerjalanan;
  onBerubah: () => Promise<void>;
}) {
  const { user } = useAuth();
  const bolehArmada = hasPermission(user, "fleet.manage");
  const bolehTarif = hasPermission(user, "trip.tariff");
  const bolehPrefix = hasPermission(user, "trip.manage");
  const [form, setForm] = useState<Form | null>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);

  async function tersimpan(pesan: string) {
    setForm(null);
    setFeedback({ tone: "success", message: pesan });
    await onBerubah();
  }

  return (
    <div className="space-y-6">
      {feedback ? (
        <div
          role={feedback.tone === "error" ? "alert" : "status"}
          className={
            feedback.tone === "error"
              ? GALAT_KOTAK
              : "p-3 rounded-lg border border-emerald-500/30 bg-emerald-500/15 text-sm text-emerald-100"
          }
        >
          {feedback.message}
        </div>
      ) : null}

      {bolehPrefix ? (
        <FormPrefix
          prefix={master.prefix}
          onTersimpan={(pesan) => void tersimpan(pesan)}
        />
      ) : null}

      <Bagian
        judul="Jenis kendaraan"
        keterangan="Tarif jenis kendaraan + tarif kategori tujuan = upah per surat jalan."
        tombol={
          bolehArmada ? (
            <button
              type="button"
              id="jenis-tambah"
              className={TOMBOL_KEDUA}
              onClick={() => setForm({ jenis: "jenis", baris: null })}
            >
              Tambah jenis
            </button>
          ) : null
        }
      >
        {master.jenis.map((j) => (
          <Baris
            key={j.id_jenis}
            judul={j.nama}
            rincian={formatRupiah(j.tarif)}
            aktif={j.status_aktif === 1}
            onUbah={
              bolehArmada
                ? () => setForm({ jenis: "jenis", baris: j })
                : undefined
            }
          />
        ))}
      </Bagian>

      <Bagian
        judul="Kategori tujuan"
        keterangan="Misalnya Antar Kota, Luar Kota, Beda Pulau."
        tombol={
          bolehArmada ? (
            <button
              type="button"
              id="kategori-tambah"
              className={TOMBOL_KEDUA}
              onClick={() => setForm({ jenis: "kategori", baris: null })}
            >
              Tambah kategori
            </button>
          ) : null
        }
      >
        {master.kategori.map((k) => (
          <Baris
            key={k.id_kategori}
            judul={k.nama}
            rincian={formatRupiah(k.tarif)}
            aktif={k.status_aktif === 1}
            onUbah={
              bolehArmada
                ? () => setForm({ jenis: "kategori", baris: k })
                : undefined
            }
          />
        ))}
      </Bagian>

      <Bagian
        judul="Kendaraan"
        keterangan="Plat atau nomor kendaraan tidak boleh kembar."
        tombol={
          bolehArmada ? (
            <button
              type="button"
              id="kendaraan-tambah"
              className={TOMBOL_KEDUA}
              disabled={master.jenis.length === 0}
              title={
                master.jenis.length === 0
                  ? "Tambahkan jenis kendaraan lebih dulu"
                  : undefined
              }
              onClick={() => setForm({ jenis: "kendaraan", baris: null })}
            >
              Tambah kendaraan
            </button>
          ) : null
        }
      >
        {master.kendaraan.map((k) => (
          <Baris
            key={k.id_kendaraan}
            judul={k.identitas}
            rincian={[
              master.jenis.find((j) => j.id_jenis === k.id_jenis)?.nama,
              k.nama,
            ]
              .filter(Boolean)
              .join(" · ")}
            aktif={k.status_aktif === 1}
            onUbah={
              bolehArmada
                ? () => setForm({ jenis: "kendaraan", baris: k })
                : undefined
            }
          />
        ))}
      </Bagian>

      <Bagian
        judul="Lokasi terdaftar"
        keterangan="Pool, gudang, dan pelanggan. Laporan di luar radius ditandai Perlu ditinjau."
        tombol={
          bolehArmada ? (
            <button
              type="button"
              id="lokasi-tambah"
              className={TOMBOL_KEDUA}
              onClick={() => setForm({ jenis: "lokasi", baris: null })}
            >
              Tambah lokasi
            </button>
          ) : null
        }
      >
        {master.lokasi.map((l) => (
          <Baris
            key={l.id_lokasi}
            judul={l.nama}
            rincian={`${l.jenis} · radius ${l.radius_m} m`}
            aktif={l.status_aktif === 1}
            onUbah={
              bolehArmada
                ? () => setForm({ jenis: "lokasi", baris: l })
                : undefined
            }
          />
        ))}
      </Bagian>

      {form?.jenis === "jenis" || form?.jenis === "kategori" ? (
        <FormDaftarTarif
          jenis={form.jenis}
          baris={form.baris}
          bolehTarif={bolehTarif}
          onClose={() => setForm(null)}
          onTersimpan={(pesan) => void tersimpan(pesan)}
        />
      ) : null}
      {form?.jenis === "kendaraan" ? (
        <FormKendaraan
          master={master}
          baris={form.baris}
          onClose={() => setForm(null)}
          onTersimpan={(pesan) => void tersimpan(pesan)}
        />
      ) : null}
      {form?.jenis === "lokasi" ? (
        <FormLokasi
          baris={form.baris}
          onClose={() => setForm(null)}
          onTersimpan={(pesan) => void tersimpan(pesan)}
        />
      ) : null}
    </div>
  );
}

function Bagian({
  judul,
  keterangan,
  tombol,
  children,
}: {
  judul: string;
  keterangan: string;
  tombol: ReactNode;
  children: ReactNode[];
}) {
  return (
    <section className="space-y-3 rounded-2xl border border-white/10 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-slate-100">{judul}</h3>
          <p className="text-xs text-slate-400">{keterangan}</p>
        </div>
        {tombol}
      </div>
      {children.length === 0 ? (
        <p className="text-sm text-slate-400">Belum ada data.</p>
      ) : (
        <ul className="divide-y divide-white/10">{children}</ul>
      )}
    </section>
  );
}

function Baris({
  judul,
  rincian,
  aktif,
  onUbah,
}: {
  judul: string;
  rincian: string;
  aktif: boolean;
  onUbah?: () => void;
}) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
      <div>
        <span className="font-medium text-slate-100">{judul}</span>
        {aktif ? null : (
          <span className="ml-2 text-xs text-amber-100">Nonaktif</span>
        )}
        <span className="block text-xs text-slate-400">{rincian}</span>
      </div>
      {onUbah ? (
        <button type="button" className={TOMBOL_KEDUA} onClick={onUbah}>
          Ubah
        </button>
      ) : null}
    </li>
  );
}

function useKirim(
  simpan: () => Promise<unknown>,
  onTersimpan: (pesan: string) => void,
  pesan: string,
) {
  const [galat, setGalat] = useState<string | null>(null);
  const [menyimpan, setMenyimpan] = useState(false);
  const isSubmittingRef = useRef(false);
  async function jalankan(rincian: Parameters<typeof konfirmasiData>[0]) {
    if (isSubmittingRef.current) return;
    setGalat(null);
    if (!(await konfirmasiData(rincian))) return;
    isSubmittingRef.current = true;
    setMenyimpan(true);
    try {
      await simpan();
      onTersimpan(pesan);
    } catch (error) {
      setGalat(pesanGalat(error, "Data tidak bisa disimpan."));
    } finally {
      isSubmittingRef.current = false;
      setMenyimpan(false);
    }
  }
  return { galat, setGalat, menyimpan, jalankan };
}

function Galat({ pesan }: { pesan: string | null }) {
  return pesan ? (
    <div className={GALAT_KOTAK} role="alert">
      {pesan}
    </div>
  ) : null;
}

function Tombol({
  onClose,
  menyimpan,
  id,
}: {
  onClose: () => void;
  menyimpan: boolean;
  id: string;
}) {
  return (
    <div className="flex justify-end gap-2">
      <button type="button" className={TOMBOL_KEDUA} onClick={onClose}>
        Batal
      </button>
      <button
        type="submit"
        id={id}
        className={TOMBOL_UTAMA}
        disabled={menyimpan}
      >
        {menyimpan ? "Menyimpan..." : "Simpan"}
      </button>
    </div>
  );
}

function FormPrefix({
  prefix,
  onTersimpan,
}: {
  prefix: string;
  onTersimpan: (pesan: string) => void;
}) {
  const [isian, setIsian] = useState(prefix);
  const contoh = normalisasiPrefix(isian);
  const { galat, setGalat, menyimpan, jalankan } = useKirim(
    () => simpanPrefixSuratJalan(isian),
    onTersimpan,
    "Awalan nomor surat jalan disimpan.",
  );
  return (
    <form
      id="form-prefix-sj"
      className="space-y-3 rounded-2xl border border-white/10 p-4"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        if (!contoh.ok) {
          setGalat(contoh.error);
          return;
        }
        void jalankan([{ label: "Awalan nomor", nilai: contoh.value }]);
      }}
    >
      <h3 className="text-sm font-semibold text-slate-100">
        Awalan nomor surat jalan
      </h3>
      <div className="grid gap-3 sm:grid-cols-[12rem_auto] sm:items-end">
        <div>
          <label className={LABEL} htmlFor="sj-prefix">
            Awalan
          </label>
          <input
            id="sj-prefix"
            className={INPUT}
            value={isian}
            maxLength={9}
            onChange={(e) => setIsian(e.target.value)}
          />
        </div>
        <p className="text-sm text-slate-300">
          Contoh nomor:{" "}
          <strong>
            {contoh.ok
              ? formatNomorSuratJalan(contoh.value, "2026-11-09", "WAB12", 1)
              : "-"}
          </strong>
          . Kode di tengah adalah kode perangkat (Web: WEB), supaya dua komputer
          offline tidak pernah memberi nomor yang sama. Nomor yang sudah ada
          tidak berubah.
        </p>
      </div>
      <Galat pesan={galat} />
      <button
        type="submit"
        id="sj-prefix-simpan"
        className={TOMBOL_UTAMA}
        disabled={menyimpan || isian === prefix}
      >
        Simpan awalan
      </button>
    </form>
  );
}

function FormDaftarTarif({
  jenis,
  baris,
  bolehTarif,
  onClose,
  onTersimpan,
}: {
  jenis: "jenis" | "kategori";
  baris:
    | MasterPerjalanan["jenis"][number]
    | MasterPerjalanan["kategori"][number]
    | null;
  bolehTarif: boolean;
  onClose: () => void;
  onTersimpan: (pesan: string) => void;
}) {
  const label = jenis === "jenis" ? "jenis kendaraan" : "kategori tujuan";
  const id = baris
    ? "id_jenis" in baris
      ? baris.id_jenis
      : baris.id_kategori
    : null;
  const [nama, setNama] = useState(baris?.nama ?? "");
  const [tarif, setTarif] = useState(String(baris?.tarif ?? 0));
  const [aktif, setAktif] = useState(baris ? baris.status_aktif === 1 : true);
  const draft = {
    id,
    nama,
    tarif: bacaRupiah(tarif),
    status_aktif: aktif,
  };
  const { galat, menyimpan, jalankan } = useKirim(
    () =>
      jenis === "jenis"
        ? simpanJenisKendaraan(draft)
        : simpanKategoriTujuan(draft),
    onTersimpan,
    `Data ${label} disimpan.`,
  );
  return (
    <Modal
      isOpen
      title={baris ? `Ubah ${label}` : `Tambah ${label}`}
      titleId="form-tarif-title"
      onClose={onClose}
    >
      <form
        id="form-daftar-tarif"
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          void jalankan([
            { label: "Nama", nilai: nama },
            { label: "Tarif", nilai: formatRupiah(draft.tarif) },
            {
              label: "Tarif berubah",
              nilai:
                baris && baris.tarif !== draft.tarif
                  ? "Hanya berlaku untuk surat jalan baru"
                  : null,
              peringatan: true,
            },
            { label: "Status", nilai: aktif ? "Aktif" : "Nonaktif" },
          ]);
        }}
      >
        <div>
          <label className={LABEL} htmlFor="tarif-nama">
            Nama
          </label>
          <input
            id="tarif-nama"
            className={INPUT}
            value={nama}
            maxLength={60}
            onChange={(e) => setNama(e.target.value)}
          />
        </div>
        <div>
          <label className={LABEL} htmlFor="tarif-nilai">
            Tarif (Rp)
          </label>
          <input
            id="tarif-nilai"
            className={INPUT}
            inputMode="numeric"
            value={tarif}
            disabled={!bolehTarif}
            onChange={(e) => setTarif(e.target.value)}
          />
          {bolehTarif ? null : (
            <p className="mt-1 text-xs text-slate-400">
              Mengubah tarif butuh izin tarif surat jalan.
            </p>
          )}
        </div>
        <label className="flex items-center gap-2 text-sm text-slate-200">
          <input
            id="tarif-aktif"
            type="checkbox"
            checked={aktif}
            onChange={(e) => setAktif(e.target.checked)}
          />
          Aktif (nonaktif = disembunyikan dari pilihan surat jalan baru)
        </label>
        <Galat pesan={galat} />
        <Tombol onClose={onClose} menyimpan={menyimpan} id="tarif-simpan" />
      </form>
    </Modal>
  );
}

function FormKendaraan({
  master,
  baris,
  onClose,
  onTersimpan,
}: {
  master: MasterPerjalanan;
  baris: MasterPerjalanan["kendaraan"][number] | null;
  onClose: () => void;
  onTersimpan: (pesan: string) => void;
}) {
  const [idJenis, setIdJenis] = useState(baris?.id_jenis ?? "");
  const [identitas, setIdentitas] = useState(baris?.identitas ?? "");
  const [nama, setNama] = useState(baris?.nama ?? "");
  const [catatan, setCatatan] = useState(baris?.catatan ?? "");
  const [aktif, setAktif] = useState(baris ? baris.status_aktif === 1 : true);
  const { galat, menyimpan, jalankan } = useKirim(
    () =>
      simpanKendaraan({
        id_kendaraan: baris?.id_kendaraan ?? null,
        id_jenis: idJenis,
        identitas,
        nama: nama || null,
        catatan: catatan || null,
        status_aktif: aktif,
      }),
    onTersimpan,
    "Data kendaraan disimpan.",
  );
  return (
    <Modal
      isOpen
      title={baris ? "Ubah kendaraan" : "Tambah kendaraan"}
      titleId="form-kendaraan-title"
      onClose={onClose}
    >
      <form
        id="form-kendaraan"
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          void jalankan([
            {
              label: "Jenis",
              nilai: master.jenis.find((j) => j.id_jenis === idJenis)?.nama,
            },
            { label: "Plat / nomor", nilai: identitas },
            { label: "Nama", nilai: nama },
            { label: "Status", nilai: aktif ? "Aktif" : "Nonaktif" },
          ]);
        }}
      >
        <div>
          <label className={LABEL} htmlFor="kendaraan-jenis">
            Jenis kendaraan
          </label>
          <select
            id="kendaraan-jenis"
            className={INPUT}
            value={idJenis}
            onChange={(e) => setIdJenis(e.target.value)}
          >
            <option value="">Pilih jenis</option>
            {master.jenis
              .filter((j) => j.status_aktif === 1 || j.id_jenis === idJenis)
              .map((j) => (
                <option key={j.id_jenis} value={j.id_jenis}>
                  {j.nama}
                </option>
              ))}
          </select>
        </div>
        <div>
          <label className={LABEL} htmlFor="kendaraan-identitas">
            Plat atau nomor kendaraan
          </label>
          <input
            id="kendaraan-identitas"
            className={INPUT}
            value={identitas}
            maxLength={20}
            onChange={(e) => setIdentitas(e.target.value)}
          />
        </div>
        <div>
          <label className={LABEL} htmlFor="kendaraan-nama">
            Nama (opsional, misalnya "Truk Hijau")
          </label>
          <input
            id="kendaraan-nama"
            className={INPUT}
            value={nama}
            maxLength={60}
            onChange={(e) => setNama(e.target.value)}
          />
        </div>
        <div>
          <label className={LABEL} htmlFor="kendaraan-catatan">
            Catatan (opsional)
          </label>
          <input
            id="kendaraan-catatan"
            className={INPUT}
            value={catatan}
            maxLength={500}
            onChange={(e) => setCatatan(e.target.value)}
          />
        </div>
        <label className="flex items-center gap-2 text-sm text-slate-200">
          <input
            id="kendaraan-aktif"
            type="checkbox"
            checked={aktif}
            onChange={(e) => setAktif(e.target.checked)}
          />
          Aktif
        </label>
        <Galat pesan={galat} />
        <Tombol onClose={onClose} menyimpan={menyimpan} id="kendaraan-simpan" />
      </form>
    </Modal>
  );
}

function FormLokasi({
  baris,
  onClose,
  onTersimpan,
}: {
  baris: MasterPerjalanan["lokasi"][number] | null;
  onClose: () => void;
  onTersimpan: (pesan: string) => void;
}) {
  const [nama, setNama] = useState(baris?.nama ?? "");
  const [jenis, setJenis] = useState(baris?.jenis ?? "Muat");
  const [lat, setLat] = useState(baris ? String(baris.lat) : "");
  const [lng, setLng] = useState(baris ? String(baris.lng) : "");
  const [radius, setRadius] = useState(String(baris?.radius_m ?? 200));
  const [aktif, setAktif] = useState(baris ? baris.status_aktif === 1 : true);
  const [mencari, setMencari] = useState(false);
  const { galat, setGalat, menyimpan, jalankan } = useKirim(
    () =>
      simpanLokasi({
        id_lokasi: baris?.id_lokasi ?? null,
        nama,
        jenis,
        lat: bacaKoordinat(lat),
        lng: bacaKoordinat(lng),
        radius_m: Number(radius.replace(/\D/g, "") || 0),
        status_aktif: aktif,
      }),
    onTersimpan,
    "Lokasi disimpan.",
  );

  async function ambilKoordinat() {
    setMencari(true);
    setGalat(null);
    try {
      const posisi = await getCurrentCoordinates();
      if (!posisi) {
        setGalat(
          "Lokasi perangkat tidak bisa dibaca. Izinkan akses lokasi lalu coba lagi.",
        );
        return;
      }
      setLat(posisi.lat.toFixed(6));
      setLng(posisi.lng.toFixed(6));
    } finally {
      setMencari(false);
    }
  }

  return (
    <Modal
      isOpen
      title={baris ? "Ubah lokasi" : "Tambah lokasi"}
      titleId="form-lokasi-title"
      onClose={onClose}
    >
      <form
        id="form-lokasi"
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          void jalankan([
            { label: "Nama", nilai: nama },
            { label: "Jenis", nilai: jenis },
            { label: "Koordinat", nilai: `${lat}, ${lng}` },
            { label: "Radius", nilai: `${radius} m` },
            { label: "Status", nilai: aktif ? "Aktif" : "Nonaktif" },
          ]);
        }}
      >
        <div>
          <label className={LABEL} htmlFor="lokasi-nama">
            Nama lokasi
          </label>
          <input
            id="lokasi-nama"
            className={INPUT}
            value={nama}
            maxLength={120}
            onChange={(e) => setNama(e.target.value)}
          />
        </div>
        <div>
          <label className={LABEL} htmlFor="lokasi-jenis">
            Jenis lokasi
          </label>
          <select
            id="lokasi-jenis"
            className={INPUT}
            value={jenis}
            onChange={(e) => setJenis(e.target.value)}
          >
            {JENIS_LOKASI.map((j) => (
              <option key={j} value={j}>
                {j}
              </option>
            ))}
          </select>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className={LABEL} htmlFor="lokasi-lat">
              Latitude
            </label>
            <input
              id="lokasi-lat"
              className={INPUT}
              inputMode="decimal"
              value={lat}
              onChange={(e) => setLat(e.target.value)}
            />
          </div>
          <div>
            <label className={LABEL} htmlFor="lokasi-lng">
              Longitude
            </label>
            <input
              id="lokasi-lng"
              className={INPUT}
              inputMode="decimal"
              value={lng}
              onChange={(e) => setLng(e.target.value)}
            />
          </div>
        </div>
        <button
          type="button"
          id="lokasi-ambil-koordinat"
          className={TOMBOL_KEDUA}
          disabled={mencari}
          onClick={() => void ambilKoordinat()}
        >
          {mencari ? "Mencari lokasi..." : "Ambil koordinat dari perangkat ini"}
        </button>
        <div>
          <label className={LABEL} htmlFor="lokasi-radius">
            Radius (meter, 10–10.000)
          </label>
          <input
            id="lokasi-radius"
            className={INPUT}
            inputMode="numeric"
            value={radius}
            onChange={(e) => setRadius(e.target.value)}
          />
        </div>
        <label className="flex items-center gap-2 text-sm text-slate-200">
          <input
            id="lokasi-aktif"
            type="checkbox"
            checked={aktif}
            onChange={(e) => setAktif(e.target.checked)}
          />
          Aktif
        </label>
        <Galat pesan={galat} />
        <Tombol onClose={onClose} menyimpan={menyimpan} id="lokasi-simpan" />
      </form>
    </Modal>
  );
}
