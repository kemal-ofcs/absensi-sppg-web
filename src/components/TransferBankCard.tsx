"use client";

// HRIS fase 12: Pengaturan → Transfer Bank (prd-hris.md §27.6). Daftar bank,
// rekening debet perusahaan, dan format berkas kustom. Hanya Web/Desktop dan
// hanya pemegang `payroll.config.manage` (khusus Superadmin, Q-173); backend
// tetap memeriksanya. Rekening debet dan urutan kolom menentukan ke mana uang
// pergi, jadi setiap simpan melewati `konfirmasiData`.

import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  INPUT,
  LABEL,
  pesanGalat,
  TOMBOL_KEDUA,
  TOMBOL_UTAMA,
} from "@/components/inventory/gaya";
import {
  type BarisKonfirmasi,
  konfirmasiData,
} from "@/components/ui/KonfirmasiData";
import { PilihCari } from "@/components/ui/PilihCari";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { renderTeks, selFormat } from "@/lib/client/berkas-transfer";
import {
  ambilPengaturanTransfer,
  type BankTransfer,
  type FormatTransfer,
  type PengaturanTransfer,
  type RekeningDebet,
  simpanPengaturanTransfer,
} from "@/lib/gateways/transfer";
import {
  CAKUPAN,
  ISIAN_TRANSFER,
  type IsianTransfer,
  JENIS_BERKAS,
  type JenisPengaturan,
  LABEL_ISIAN_TRANSFER,
  MAKS_KOLOM_FORMAT,
  PEMISAH,
  type SusunanTransfer,
  validasiBank,
  validasiFormat,
  validasiRekening,
} from "@/lib/validations/transfer";

const LABEL_PEMISAH: Record<(typeof PEMISAH)[number], string> = {
  ",": "Koma (,)",
  ";": "Titik koma (;)",
  "\t": "Tab",
  "|": "Garis tegak (|)",
};
const LABEL_CAKUPAN: Record<(typeof CAKUPAN)[number], string> = {
  semua: "Semua karyawan",
  sesama: "Hanya sesama bank rekening debet",
  antarbank: "Hanya antarbank",
};

/** Data contoh pratinjau format; bukan data karyawan sungguhan. */
const CONTOH: SusunanTransfer = {
  berita: "Gaji 2026-10-01 s.d. 2026-10-31",
  rekening_debet: "8800112233",
  nama_debet: "PT Contoh Sejahtera",
  tanggal_efektif: "2026-11-02",
  baris: [
    {
      nomor_urut: 1,
      id_karyawan: "contoh-1",
      nama_karyawan: "Ana Lestari",
      kode_karyawan: "EMP-001",
      nama_bank: "BCA",
      kode_bank: "014",
      no_rekening: "1234567890",
      nama_rekening: "Ana Lestari",
      nominal: 5_250_000,
      jenis: "sesama",
      tanda: [],
    },
    {
      nomor_urut: 2,
      id_karyawan: "contoh-2",
      nama_karyawan: "Budi Santoso",
      kode_karyawan: "EMP-002",
      nama_bank: "Mandiri",
      kode_bank: "008",
      no_rekening: "1300012345678",
      nama_rekening: "Budi Santoso",
      nominal: 4_100_000,
      jenis: "antarbank",
      tanda: [],
    },
  ],
  manual: [],
  luar_cakupan: [],
  ringkasan: {
    jumlah_baris: 2,
    total: 9_350_000,
    total_run: 9_350_000,
    selisih: 0,
    jumlah_manual: 0,
    total_manual: 0,
    jumlah_luar_cakupan: 0,
    total_luar_cakupan: 0,
    per_bank: [],
    per_jenis: {
      sesama: { jumlah: 1, total: 5_250_000 },
      antarbank: { jumlah: 1, total: 4_100_000 },
    },
  },
};

type Pesan = { tone: "success" | "error"; text: string } | null;

interface KolomIsian {
  isian: IsianTransfer;
  judul: string;
  teks: string;
}

interface DraftFormat {
  nama: string;
  id_bank: string;
  jenis: (typeof JENIS_BERKAS)[number];
  pemisah: (typeof PEMISAH)[number];
  pakai_judul: boolean;
  kutip: boolean;
  desimal: boolean;
  cakupan: (typeof CAKUPAN)[number];
  maks_berita: string;
  is_aktif: boolean;
  kolom: KolomIsian[];
}

const FORMAT_KOSONG: DraftFormat = {
  nama: "",
  id_bank: "",
  jenis: "csv",
  pemisah: ",",
  pakai_judul: true,
  kutip: false,
  desimal: false,
  cakupan: "semua",
  maks_berita: "",
  is_aktif: true,
  kolom: [
    { isian: "no_rekening", judul: "No Rekening", teks: "" },
    { isian: "nama_rekening", judul: "Nama", teks: "" },
    { isian: "nominal", judul: "Nominal", teks: "" },
  ],
};

/** Isian yang dikirim ke backend: hanya kunci yang dikenal validator. */
function kirimFormat(d: DraftFormat) {
  const xlsx = d.jenis === "xlsx";
  return {
    nama: d.nama,
    id_bank: d.id_bank || null,
    jenis: d.jenis,
    pemisah: xlsx ? null : d.pemisah,
    pakai_judul: d.pakai_judul,
    kutip: xlsx ? false : d.kutip,
    desimal: xlsx ? false : d.desimal,
    cakupan: d.cakupan,
    kolom: d.kolom.map((k) =>
      k.isian === "teks_tetap"
        ? { isian: k.isian, judul: k.judul, teks: k.teks }
        : { isian: k.isian, judul: k.judul },
    ),
    maks_berita: d.maks_berita.trim() === "" ? null : Number(d.maks_berita),
    is_aktif: d.is_aktif,
  };
}

function draftDariFormat(f: FormatTransfer): DraftFormat {
  return {
    nama: f.nama,
    id_bank: f.id_bank ?? "",
    jenis: f.jenis,
    pemisah: (f.pemisah ?? ",") as DraftFormat["pemisah"],
    pakai_judul: f.pakai_judul === 1,
    kutip: f.kutip === 1,
    desimal: f.desimal === 1,
    cakupan: f.cakupan,
    maks_berita: f.maks_berita === null ? "" : String(f.maks_berita),
    is_aktif: f.is_aktif === 1,
    kolom: (f.kolom ?? FORMAT_KOSONG.kolom).map((k) => ({
      isian: k.isian,
      judul: k.judul,
      teks: k.teks ?? "",
    })),
  };
}

function Bagian({
  judul,
  keterangan,
  children,
}: {
  judul: string;
  keterangan: string;
  children: ReactNode;
}) {
  return (
    <section className="space-y-3 rounded-2xl border border-white/10 p-4">
      <div>
        <h3 className="text-sm font-black text-white">{judul}</h3>
        <p className="mt-1 text-xs leading-5 text-slate-400">{keterangan}</p>
      </div>
      {children}
    </section>
  );
}

function Centang({
  label,
  nilai,
  onUbah,
}: {
  label: string;
  nilai: boolean;
  onUbah: (v: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-xs font-semibold text-slate-300">
      <input
        type="checkbox"
        checked={nilai}
        onChange={(e) => onUbah(e.target.checked)}
        className="size-4"
      />
      {label}
    </label>
  );
}

export function TransferBankCard() {
  const [data, setData] = useState<PengaturanTransfer | null>(null);
  const [pesan, setPesan] = useState<Pesan>(null);
  const [sibuk, setSibuk] = useState(false);
  const isSubmittingRef = useRef(false);

  const [idBank, setIdBank] = useState<string | null>(null);
  const [bank, setBank] = useState({
    nama: "",
    kode: "",
    alias: "",
    is_aktif: true,
  });
  const [idRekening, setIdRekening] = useState<string | null>(null);
  const [rekening, setRekening] = useState({
    id_bank: "",
    no_rekening: "",
    nama_rekening: "",
    keterangan: "",
    is_aktif: true,
  });
  const [idFormat, setIdFormat] = useState<string | null>(null);
  const [format, setFormat] = useState<DraftFormat>(FORMAT_KOSONG);

  const muat = useCallback(() => {
    ambilPengaturanTransfer()
      .then(setData)
      .catch((error: unknown) =>
        setPesan({
          tone: "error",
          text: pesanGalat(error, "Pengaturan transfer gagal dimuat."),
        }),
      );
  }, []);
  useEffect(muat, [muat]);

  const simpan = async (
    jenis: JenisPengaturan,
    id: string | null,
    draft: Record<string, unknown>,
    rincian: BarisKonfirmasi[],
    selesai: () => void,
  ) => {
    if (isSubmittingRef.current) return;
    const lanjut = await konfirmasiData(rincian);
    if (!lanjut) return;
    isSubmittingRef.current = true;
    setSibuk(true);
    setPesan(null);
    try {
      await simpanPengaturanTransfer(jenis, id, draft);
      setPesan({ tone: "success", text: "Pengaturan transfer tersimpan." });
      selesai();
      muat();
    } catch (error) {
      setPesan({ tone: "error", text: pesanGalat(error, "Gagal menyimpan.") });
    } finally {
      isSubmittingRef.current = false;
      setSibuk(false);
    }
  };

  const tolak = (text: string) => setPesan({ tone: "error", text });

  // ── Bank ──
  const ubahBank = (b: BankTransfer) => {
    setIdBank(b.id_bank);
    setBank({
      nama: b.nama,
      kode: b.kode ?? "",
      alias: b.alias.join("\n"),
      is_aktif: b.is_aktif === 1,
    });
  };
  const resetBank = () => {
    setIdBank(null);
    setBank({ nama: "", kode: "", alias: "", is_aktif: true });
  };
  const simpanBank = () => {
    const draft = {
      nama: bank.nama,
      kode: bank.kode,
      alias: bank.alias.split("\n"),
      is_aktif: bank.is_aktif,
    };
    const lama = data?.bank.find((b) => b.id_bank === idBank)?.nama ?? null;
    const sah = validasiBank(draft, lama);
    if (!sah.ok) return tolak(sah.pesan);
    void simpan(
      "bank",
      idBank,
      draft,
      [
        { label: "Nama", nilai: sah.nilai.nama },
        { label: "Kode BI", nilai: sah.nilai.kode ?? "" },
        { label: "Alias", nilai: sah.nilai.alias.join(", ") },
        { label: "Aktif", nilai: sah.nilai.is_aktif ? "Ya" : "Tidak" },
      ],
      resetBank,
    );
  };

  // ── Rekening debet ──
  const ubahRekening = (r: RekeningDebet) => {
    setIdRekening(r.id_rekening);
    setRekening({
      id_bank: r.id_bank,
      no_rekening: r.no_rekening,
      nama_rekening: r.nama_rekening,
      keterangan: r.keterangan ?? "",
      is_aktif: r.is_aktif === 1,
    });
  };
  const resetRekening = () => {
    setIdRekening(null);
    setRekening({
      id_bank: "",
      no_rekening: "",
      nama_rekening: "",
      keterangan: "",
      is_aktif: true,
    });
  };
  const simpanRekening = () => {
    const sah = validasiRekening(rekening);
    if (!sah.ok) return tolak(sah.pesan);
    const namaBank =
      data?.bank.find((b) => b.id_bank === sah.nilai.id_bank)?.nama ?? "";
    void simpan(
      "rekening",
      idRekening,
      rekening,
      [
        { label: "Bank", nilai: namaBank },
        { label: "Nomor rekening", nilai: sah.nilai.no_rekening },
        { label: "Atas nama", nilai: sah.nilai.nama_rekening },
        { label: "Keterangan", nilai: sah.nilai.keterangan ?? "" },
        { label: "Aktif", nilai: sah.nilai.is_aktif ? "Ya" : "Tidak" },
      ],
      resetRekening,
    );
  };

  // ── Format ──
  const formatSah = validasiFormat(kirimFormat(format));
  const ubahKolom = (i: number, isi: Partial<KolomIsian>) =>
    setFormat((f) => ({
      ...f,
      kolom: f.kolom.map((k, j) => (j === i ? { ...k, ...isi } : k)),
    }));
  const geserKolom = (i: number, arah: -1 | 1) =>
    setFormat((f) => {
      const kolom = [...f.kolom];
      const j = i + arah;
      if (j < 0 || j >= kolom.length) return f;
      [kolom[i], kolom[j]] = [kolom[j] as KolomIsian, kolom[i] as KolomIsian];
      return { ...f, kolom };
    });
  const resetFormat = () => {
    setIdFormat(null);
    setFormat(FORMAT_KOSONG);
  };
  const simpanFormat = () => {
    if (!formatSah.ok) return tolak(formatSah.pesan);
    const v = formatSah.nilai;
    void simpan(
      "format",
      idFormat,
      kirimFormat(format),
      [
        { label: "Nama", nilai: v.nama },
        {
          label: "Bank sasaran",
          nilai:
            data?.bank.find((b) => b.id_bank === v.id_bank)?.nama ?? "Umum",
        },
        {
          label: "Jenis",
          nilai: `${v.jenis.toUpperCase()}${v.pemisah ? `, pemisah ${LABEL_PEMISAH[v.pemisah as (typeof PEMISAH)[number]]}` : ""}`,
        },
        { label: "Cakupan", nilai: LABEL_CAKUPAN[v.cakupan] },
        {
          label: "Urutan kolom",
          nilai: v.kolom
            .map(
              (k, i) =>
                `${i + 1}. ${k.judul} (${LABEL_ISIAN_TRANSFER[k.isian]})`,
            )
            .join("; "),
        },
        { label: "Aktif", nilai: v.is_aktif ? "Ya" : "Tidak" },
      ],
      resetFormat,
    );
  };

  const bankAktif = (data?.bank ?? []).filter((b) => b.is_aktif === 1);

  return (
    <section className="app-panel space-y-5 rounded-3xl p-5 sm:p-7">
      <div>
        <h2 className="text-base font-black text-white">Transfer Bank</h2>
        <p className="mt-1 max-w-3xl text-sm leading-6 text-slate-400">
          Bank, rekening debet perusahaan, dan bentuk berkas transfer gaji.
          Rekening debet dan urutan kolom menentukan ke mana uang pergi: uji
          setiap format baru dengan transfer bernilai kecil sebelum dipakai
          untuk gaji.
        </p>
      </div>

      {pesan ? (
        <p
          role={pesan.tone === "error" ? "alert" : "status"}
          className={`rounded-xl border p-3 text-sm ${
            pesan.tone === "success"
              ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-200"
              : "border-rose-500/30 bg-rose-500/10 text-rose-200"
          }`}
        >
          {pesan.text}
        </p>
      ) : null}

      <Bagian
        judul="Rekening debet"
        keterangan="Rekening perusahaan sumber transfer gaji. Boleh lebih dari satu (Q-175)."
      >
        <ul className="grid gap-2">
          {(data?.rekening ?? []).map((r) => (
            <li
              key={r.id_rekening}
              className="flex flex-wrap items-center gap-2 rounded-xl border border-white/10 p-3 text-sm text-slate-200"
            >
              <span className="min-w-0 flex-1 break-words">
                <span className="font-semibold">
                  {r.nama_bank ?? r.id_bank}
                </span>{" "}
                <span className="font-mono">{r.no_rekening}</span> a.n.{" "}
                {r.nama_rekening}
                {r.keterangan ? (
                  <span className="block text-xs text-slate-500">
                    {r.keterangan}
                  </span>
                ) : null}
              </span>
              {r.is_aktif !== 1 || r.bank_aktif !== 1 ? (
                <StatusBadge tone="warning">Nonaktif</StatusBadge>
              ) : null}
              <button
                type="button"
                onClick={() => ubahRekening(r)}
                className={TOMBOL_KEDUA}
              >
                Ubah
              </button>
            </li>
          ))}
        </ul>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="min-w-0">
            <label htmlFor="rekening-bank" className={LABEL}>
              Bank
            </label>
            <PilihCari
              id="rekening-bank"
              value={rekening.id_bank}
              onChange={(e) =>
                setRekening((r) => ({ ...r, id_bank: e.target.value }))
              }
              className={INPUT}
            >
              <option value="">Pilih bank</option>
              {(data?.bank ?? [])
                .filter(
                  (b) => b.is_aktif === 1 || b.id_bank === rekening.id_bank,
                )
                .map((b) => (
                  <option key={b.id_bank} value={b.id_bank}>
                    {b.nama}
                  </option>
                ))}
            </PilihCari>
          </div>
          <div className="min-w-0">
            <label htmlFor="rekening-nomor" className={LABEL}>
              Nomor rekening
            </label>
            <input
              id="rekening-nomor"
              inputMode="numeric"
              value={rekening.no_rekening}
              onChange={(e) =>
                setRekening((r) => ({ ...r, no_rekening: e.target.value }))
              }
              className={`${INPUT} font-mono`}
            />
          </div>
          <div className="min-w-0">
            <label htmlFor="rekening-nama" className={LABEL}>
              Atas nama
            </label>
            <input
              id="rekening-nama"
              value={rekening.nama_rekening}
              onChange={(e) =>
                setRekening((r) => ({ ...r, nama_rekening: e.target.value }))
              }
              className={INPUT}
            />
          </div>
          <div className="min-w-0">
            <label htmlFor="rekening-keterangan" className={LABEL}>
              Keterangan
            </label>
            <input
              id="rekening-keterangan"
              value={rekening.keterangan}
              onChange={(e) =>
                setRekening((r) => ({ ...r, keterangan: e.target.value }))
              }
              className={INPUT}
            />
          </div>
        </div>
        <Centang
          label="Aktif"
          nilai={rekening.is_aktif}
          onUbah={(v) => setRekening((r) => ({ ...r, is_aktif: v }))}
        />
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={simpanRekening}
            disabled={sibuk}
            className={TOMBOL_UTAMA}
          >
            {idRekening ? "Simpan perubahan rekening" : "Tambah rekening"}
          </button>
          {idRekening ? (
            <button
              type="button"
              onClick={resetRekening}
              className={TOMBOL_KEDUA}
            >
              Batal ubah
            </button>
          ) : null}
        </div>
      </Bagian>

      <Bagian
        judul="Format berkas kustom"
        keterangan="Susun kolom sesuai contoh berkas dari bank. Excel umum selalu tersedia tanpa format. Format berbank hanya ditawarkan untuk rekening debet bank itu."
      >
        <ul className="grid gap-2">
          {(data?.format ?? []).map((f) => (
            <li
              key={f.id_format}
              className="flex flex-wrap items-center gap-2 rounded-xl border border-white/10 p-3 text-sm text-slate-200"
            >
              <span className="min-w-0 flex-1 break-words">
                <span className="font-semibold">{f.nama}</span>{" "}
                <span className="text-xs text-slate-400">
                  {f.jenis.toUpperCase()} · {f.nama_bank ?? "Umum"} ·{" "}
                  {LABEL_CAKUPAN[f.cakupan]}
                </span>
              </span>
              {f.kolom === null ? (
                <StatusBadge tone="danger">Kolom rusak</StatusBadge>
              ) : null}
              {f.is_aktif !== 1 ? (
                <StatusBadge tone="warning">Nonaktif</StatusBadge>
              ) : null}
              <button
                type="button"
                onClick={() => {
                  setIdFormat(f.id_format);
                  setFormat(draftDariFormat(f));
                }}
                className={TOMBOL_KEDUA}
              >
                Ubah
              </button>
            </li>
          ))}
        </ul>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <div className="min-w-0">
            <label htmlFor="format-nama" className={LABEL}>
              Nama format
            </label>
            <input
              id="format-nama"
              value={format.nama}
              onChange={(e) =>
                setFormat((f) => ({ ...f, nama: e.target.value }))
              }
              className={INPUT}
            />
          </div>
          <div className="min-w-0">
            <label htmlFor="format-bank" className={LABEL}>
              Bank sasaran
            </label>
            <PilihCari
              id="format-bank"
              value={format.id_bank}
              onChange={(e) =>
                setFormat((f) => ({ ...f, id_bank: e.target.value }))
              }
              className={INPUT}
            >
              <option value="">Umum (semua bank)</option>
              {(data?.bank ?? [])
                .filter((b) => b.is_aktif === 1 || b.id_bank === format.id_bank)
                .map((b) => (
                  <option key={b.id_bank} value={b.id_bank}>
                    {b.nama}
                  </option>
                ))}
            </PilihCari>
          </div>
          <div className="min-w-0">
            <label htmlFor="format-jenis" className={LABEL}>
              Jenis berkas
            </label>
            <select
              id="format-jenis"
              value={format.jenis}
              onChange={(e) =>
                setFormat((f) => ({
                  ...f,
                  jenis: e.target.value as DraftFormat["jenis"],
                }))
              }
              className={INPUT}
            >
              {JENIS_BERKAS.map((j) => (
                <option key={j} value={j}>
                  {j.toUpperCase()}
                </option>
              ))}
            </select>
          </div>
          {format.jenis !== "xlsx" ? (
            <div className="min-w-0">
              <label htmlFor="format-pemisah" className={LABEL}>
                Pemisah kolom
              </label>
              <select
                id="format-pemisah"
                value={format.pemisah}
                onChange={(e) =>
                  setFormat((f) => ({
                    ...f,
                    pemisah: e.target.value as DraftFormat["pemisah"],
                  }))
                }
                className={INPUT}
              >
                {PEMISAH.map((p) => (
                  <option key={p} value={p}>
                    {LABEL_PEMISAH[p]}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
          <div className="min-w-0">
            <label htmlFor="format-cakupan" className={LABEL}>
              Cakupan
            </label>
            <select
              id="format-cakupan"
              value={format.cakupan}
              onChange={(e) =>
                setFormat((f) => ({
                  ...f,
                  cakupan: e.target.value as DraftFormat["cakupan"],
                }))
              }
              className={INPUT}
            >
              {CAKUPAN.map((c) => (
                <option key={c} value={c}>
                  {LABEL_CAKUPAN[c]}
                </option>
              ))}
            </select>
          </div>
          <div className="min-w-0">
            <label htmlFor="format-berita" className={LABEL}>
              Panjang berita maksimal
            </label>
            <input
              id="format-berita"
              inputMode="numeric"
              value={format.maks_berita}
              placeholder="Tanpa batas"
              onChange={(e) =>
                setFormat((f) => ({ ...f, maks_berita: e.target.value }))
              }
              className={INPUT}
            />
          </div>
        </div>
        <div className="flex flex-wrap gap-4">
          <Centang
            label="Baris judul"
            nilai={format.pakai_judul}
            onUbah={(v) => setFormat((f) => ({ ...f, pakai_judul: v }))}
          />
          {format.jenis !== "xlsx" ? (
            <>
              <Centang
                label="Teks dibungkus kutip ganda"
                nilai={format.kutip}
                onUbah={(v) => setFormat((f) => ({ ...f, kutip: v }))}
              />
              <Centang
                label="Nominal dengan .00"
                nilai={format.desimal}
                onUbah={(v) => setFormat((f) => ({ ...f, desimal: v }))}
              />
            </>
          ) : null}
          <Centang
            label="Aktif"
            nilai={format.is_aktif}
            onUbah={(v) => setFormat((f) => ({ ...f, is_aktif: v }))}
          />
        </div>

        <div className="space-y-2">
          <p className="text-xs font-bold text-slate-300">
            Kolom ({format.kolom.length}/{MAKS_KOLOM_FORMAT}), urut dari kiri
          </p>
          <ol className="grid gap-2">
            {format.kolom.map((k, i) => (
              <li
                // biome-ignore lint/suspicious/noArrayIndexKey: kolom tanpa id, urutan adalah identitasnya
                key={i}
                className="grid gap-2 rounded-xl border border-white/10 p-2 sm:grid-cols-[2rem_1fr_1fr_1fr_auto] sm:items-center"
              >
                <span className="font-mono text-xs text-slate-500">
                  {i + 1}
                </span>
                <select
                  aria-label={`Isian kolom ${i + 1}`}
                  value={k.isian}
                  onChange={(e) =>
                    ubahKolom(i, { isian: e.target.value as IsianTransfer })
                  }
                  className={INPUT}
                >
                  {ISIAN_TRANSFER.map((isian) => (
                    <option key={isian} value={isian}>
                      {LABEL_ISIAN_TRANSFER[isian]}
                    </option>
                  ))}
                </select>
                <input
                  aria-label={`Judul kolom ${i + 1}`}
                  value={k.judul}
                  placeholder="Judul kolom"
                  onChange={(e) => ubahKolom(i, { judul: e.target.value })}
                  className={INPUT}
                />
                {k.isian === "teks_tetap" ? (
                  <input
                    aria-label={`Teks tetap kolom ${i + 1}`}
                    value={k.teks}
                    placeholder="Isi tetap (boleh kosong)"
                    onChange={(e) => ubahKolom(i, { teks: e.target.value })}
                    className={INPUT}
                  />
                ) : (
                  <span className="hidden sm:block" />
                )}
                <span className="flex gap-1">
                  <button
                    type="button"
                    aria-label={`Naikkan kolom ${i + 1}`}
                    onClick={() => geserKolom(i, -1)}
                    disabled={i === 0}
                    className={TOMBOL_KEDUA}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    aria-label={`Turunkan kolom ${i + 1}`}
                    onClick={() => geserKolom(i, 1)}
                    disabled={i === format.kolom.length - 1}
                    className={TOMBOL_KEDUA}
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    aria-label={`Hapus kolom ${i + 1}`}
                    onClick={() =>
                      setFormat((f) => ({
                        ...f,
                        kolom: f.kolom.filter((_, j) => j !== i),
                      }))
                    }
                    className={TOMBOL_KEDUA}
                  >
                    Hapus
                  </button>
                </span>
              </li>
            ))}
          </ol>
          <button
            type="button"
            disabled={format.kolom.length >= MAKS_KOLOM_FORMAT}
            onClick={() =>
              setFormat((f) => ({
                ...f,
                kolom: [...f.kolom, { isian: "nominal", judul: "", teks: "" }],
              }))
            }
            className={TOMBOL_KEDUA}
          >
            Tambah kolom
          </button>
        </div>

        <div className="space-y-2">
          <p className="text-xs font-bold text-slate-300">
            Pratinjau dari data contoh
          </p>
          {formatSah.ok ? (
            formatSah.nilai.jenis === "xlsx" ? (
              <div className="overflow-x-auto rounded-xl border border-white/10">
                <table className="w-full text-left font-mono text-xs text-slate-300">
                  {formatSah.nilai.pakai_judul === 1 ? (
                    <thead className="bg-slate-800/80 text-slate-400">
                      <tr>
                        {formatSah.nilai.kolom.map((k, i) => (
                          // biome-ignore lint/suspicious/noArrayIndexKey: judul boleh kembar
                          <th key={i} className="whitespace-nowrap px-3 py-2">
                            {k.judul}
                          </th>
                        ))}
                      </tr>
                    </thead>
                  ) : null}
                  <tbody className="divide-y divide-white/10">
                    {selFormat(CONTOH, formatSah.nilai).baris.map((isi, i) => (
                      // biome-ignore lint/suspicious/noArrayIndexKey: urutan tetap
                      <tr key={i}>
                        {isi.map((v, j) => (
                          // biome-ignore lint/suspicious/noArrayIndexKey: urutan tetap
                          <td key={j} className="whitespace-nowrap px-3 py-2">
                            {String(v)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <pre className="overflow-x-auto rounded-xl border border-white/10 bg-slate-950 p-3 text-xs text-slate-200">
                {renderTeks(CONTOH, formatSah.nilai).replaceAll("\t", " ⇥ ")}
              </pre>
            )
          ) : (
            <p className="text-xs text-amber-200">{formatSah.pesan}</p>
          )}
          {format.jenis !== "xlsx" && format.pemisah === "\t" ? (
            <p className="text-xs text-slate-500">⇥ menandai tab.</p>
          ) : null}
        </div>

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={simpanFormat}
            disabled={sibuk}
            className={TOMBOL_UTAMA}
          >
            {idFormat ? "Simpan perubahan format" : "Tambah format"}
          </button>
          {idFormat ? (
            <button
              type="button"
              onClick={resetFormat}
              className={TOMBOL_KEDUA}
            >
              Batal ubah
            </button>
          ) : null}
        </div>
      </Bagian>

      <Bagian
        judul="Bank"
        keterangan="Nama dipakai isian bank di profil keuangan karyawan. Alias menampung ejaan lama (satu per baris); ganti nama menambahkan nama lama ke alias. Bank tidak bisa dihapus, hanya dinonaktifkan."
      >
        <div className="max-h-80 overflow-y-auto rounded-xl border border-white/10">
          <ul className="divide-y divide-white/10">
            {(data?.bank ?? []).map((b) => (
              <li
                key={b.id_bank}
                className="flex flex-wrap items-center gap-2 p-3 text-sm text-slate-200"
              >
                <span className="min-w-0 flex-1 break-words">
                  <span className="font-semibold">{b.nama}</span>{" "}
                  <span className="font-mono text-xs text-slate-400">
                    {b.kode ?? "tanpa kode"}
                  </span>
                  {b.alias.length > 0 ? (
                    <span className="block text-xs text-slate-500">
                      {b.alias.join(", ")}
                    </span>
                  ) : null}
                </span>
                {b.is_aktif !== 1 ? (
                  <StatusBadge tone="warning">Nonaktif</StatusBadge>
                ) : null}
                <button
                  type="button"
                  onClick={() => ubahBank(b)}
                  className={TOMBOL_KEDUA}
                >
                  Ubah
                </button>
              </li>
            ))}
          </ul>
        </div>
        <p className="text-xs text-slate-500">
          {bankAktif.length} bank aktif dari {data?.bank.length ?? 0}.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="min-w-0">
            <label htmlFor="bank-nama" className={LABEL}>
              Nama bank
            </label>
            <input
              id="bank-nama"
              value={bank.nama}
              onChange={(e) => setBank((b) => ({ ...b, nama: e.target.value }))}
              className={INPUT}
            />
          </div>
          <div className="min-w-0">
            <label htmlFor="bank-kode" className={LABEL}>
              Kode bank BI (3 digit)
            </label>
            <input
              id="bank-kode"
              inputMode="numeric"
              maxLength={3}
              value={bank.kode}
              onChange={(e) => setBank((b) => ({ ...b, kode: e.target.value }))}
              className={`${INPUT} font-mono`}
            />
          </div>
          <div className="min-w-0 sm:col-span-2">
            <label htmlFor="bank-alias" className={LABEL}>
              Alias (satu per baris)
            </label>
            <textarea
              id="bank-alias"
              rows={3}
              value={bank.alias}
              onChange={(e) =>
                setBank((b) => ({ ...b, alias: e.target.value }))
              }
              className={INPUT}
            />
          </div>
        </div>
        <Centang
          label="Aktif"
          nilai={bank.is_aktif}
          onUbah={(v) => setBank((b) => ({ ...b, is_aktif: v }))}
        />
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={simpanBank}
            disabled={sibuk}
            className={TOMBOL_UTAMA}
          >
            {idBank ? "Simpan perubahan bank" : "Tambah bank"}
          </button>
          {idBank ? (
            <button type="button" onClick={resetBank} className={TOMBOL_KEDUA}>
              Batal ubah
            </button>
          ) : null}
        </div>
      </Bagian>
    </section>
  );
}
