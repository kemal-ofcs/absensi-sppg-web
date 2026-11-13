"use client";

// HRIS fase 12: "Berkas transfer" di rincian proses gaji (prd-hris.md §27.6).
// Satu komponen untuk Web, Desktop, dan Mobile (`filesToCopy`); hanya
// bergantung pada `PilihCari`, `konfirmasiData`, `inventory/gaya`, gateway,
// dan perender `lib/client/berkas-transfer`. Pemanggil menampilkannya hanya
// untuk pemegang kedua izin unduh dan run APPROVED/PAID; backend tetap
// memeriksa keduanya.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  INPUT,
  LABEL,
  pesanGalat,
  TOMBOL_KEDUA,
  TOMBOL_UTAMA,
} from "@/components/inventory/gaya";
import { konfirmasiData } from "@/components/ui/KonfirmasiData";
import { PilihCari } from "@/components/ui/PilihCari";
import {
  berkasFormat,
  berkasUmum,
  ringkasCatatanUnduhan,
  selFormat,
} from "@/lib/client/berkas-transfer";
import { saveFileWithPicker } from "@/lib/client/download";
import {
  ambilBerkasTransfer,
  ambilPengaturanTransfer,
  type BerkasTransfer,
  type PengaturanTransfer,
} from "@/lib/gateways/transfer";
import {
  type BarisTransfer,
  LABEL_JENIS_TRANSFER,
  LABEL_TANDA_TRANSFER,
} from "@/lib/validations/transfer";

const RUPIAH = new Intl.NumberFormat("id-ID", {
  style: "currency",
  currency: "IDR",
  maximumFractionDigits: 0,
});

const JENIS_UNDUH: Record<string, { description: string; ext: string }> = {
  xlsx: { description: "Spreadsheet Excel (.xlsx)", ext: ".xlsx" },
  csv: { description: "File CSV (.csv)", ext: ".csv" },
  txt: { description: "File teks (.txt)", ext: ".txt" },
};

function Tanda({ baris }: { baris: BarisTransfer }) {
  if (baris.tanda.length === 0) return null;
  return (
    <span className="flex flex-wrap gap-1">
      {baris.tanda.map((t) => (
        <span
          key={t}
          className="rounded-md border border-amber-400/30 bg-amber-400/10 px-1.5 py-0.5 text-[11px] font-semibold text-amber-200"
        >
          {LABEL_TANDA_TRANSFER[t]}
        </span>
      ))}
    </span>
  );
}

function DaftarBaris({
  judul,
  keterangan,
  baris,
}: {
  judul: string;
  keterangan: string;
  baris: BarisTransfer[];
}) {
  if (baris.length === 0) return null;
  return (
    <section className="space-y-2">
      <div>
        <h4 className="text-sm font-bold text-slate-100">
          {judul} ({baris.length})
        </h4>
        <p className="text-xs text-slate-400">{keterangan}</p>
      </div>
      <div className="overflow-x-auto rounded-xl border border-slate-800">
        <table className="w-full min-w-[640px] text-left text-xs text-slate-300">
          <thead className="bg-slate-800/80 text-[11px] uppercase text-slate-400">
            <tr>
              <th className="px-3 py-2">No</th>
              <th className="px-3 py-2">Karyawan</th>
              <th className="px-3 py-2">Bank</th>
              <th className="px-3 py-2">Rekening</th>
              <th className="px-3 py-2 text-right">Nominal</th>
              <th className="px-3 py-2">Catatan</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800">
            {baris.map((b) => (
              <tr key={b.id_karyawan}>
                <td className="px-3 py-2 font-mono">{b.nomor_urut ?? "-"}</td>
                <td className="px-3 py-2">
                  <div className="font-semibold text-slate-100">
                    {b.nama_karyawan}
                  </div>
                  <div className="text-slate-500">{b.kode_karyawan ?? ""}</div>
                </td>
                <td className="px-3 py-2">
                  <div>{b.nama_bank ?? "-"}</div>
                  <div className="text-slate-500">
                    {b.kode_bank ?? ""}
                    {b.jenis ? ` · ${LABEL_JENIS_TRANSFER[b.jenis]}` : ""}
                  </div>
                </td>
                <td className="px-3 py-2">
                  <div className="font-mono">{b.no_rekening ?? "-"}</div>
                  <div className="text-slate-500">{b.nama_rekening ?? ""}</div>
                </td>
                <td className="px-3 py-2 text-right font-mono text-emerald-300">
                  {RUPIAH.format(b.nominal)}
                </td>
                <td className="px-3 py-2">
                  <Tanda baris={b} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function BerkasTransferPanel({
  runId,
  status,
}: {
  runId: string;
  status: string;
}) {
  const [pengaturan, setPengaturan] = useState<PengaturanTransfer | null>(null);
  const [idRekening, setIdRekening] = useState("");
  const [idFormat, setIdFormat] = useState("");
  const [tanggal, setTanggal] = useState("");
  const [hasil, setHasil] = useState<BerkasTransfer | null>(null);
  const [sibuk, setSibuk] = useState<"muat" | "unduh" | null>(null);
  const [pesan, setPesan] = useState<{
    tone: "success" | "error";
    text: string;
  } | null>(null);
  const isSubmittingRef = useRef(false);

  useEffect(() => {
    let batal = false;
    ambilPengaturanTransfer()
      .then((p) => {
        if (batal) return;
        setPengaturan(p);
        if (p.rekening.length === 1) setIdRekening(p.rekening[0].id_rekening);
      })
      .catch((error: unknown) => {
        if (!batal) {
          setPesan({
            tone: "error",
            text: pesanGalat(error, "Pengaturan transfer gagal dimuat."),
          });
        }
      });
    return () => {
      batal = true;
    };
  }, []);

  const debet = pengaturan?.rekening.find((r) => r.id_rekening === idRekening);
  // Format bank lain tidak ditawarkan: kolomnya disusun untuk bank itu.
  const formatCocok = (pengaturan?.format ?? []).filter(
    (f) => f.kolom !== null && (!f.id_bank || f.id_bank === debet?.id_bank),
  );
  const format = formatCocok.find((f) => f.id_format === idFormat) ?? null;

  // Pilihan berubah = susunan lama tidak berlaku lagi.
  // biome-ignore lint/correctness/useExhaustiveDependencies: dipicu oleh pilihan
  useEffect(() => {
    setHasil(null);
  }, [idRekening, idFormat, tanggal]);
  useEffect(() => {
    if (idFormat && !format) setIdFormat("");
  }, [idFormat, format]);

  const draft = useCallback(
    (catat: boolean) => ({
      run_id: runId,
      id_rekening: idRekening,
      id_format: idFormat || null,
      tanggal_efektif: tanggal || null,
      catat,
    }),
    [runId, idRekening, idFormat, tanggal],
  );

  const tampilkan = async () => {
    if (isSubmittingRef.current || !idRekening) return;
    isSubmittingRef.current = true;
    setSibuk("muat");
    setPesan(null);
    try {
      setHasil(await ambilBerkasTransfer(draft(false)));
    } catch (error) {
      setPesan({
        tone: "error",
        text: pesanGalat(error, "Berkas transfer gagal disusun."),
      });
    } finally {
      isSubmittingRef.current = false;
      setSibuk(null);
    }
  };

  const unduh = async () => {
    if (!hasil || isSubmittingRef.current) return;
    const r = hasil.susunan.ringkasan;
    const peringatan = [
      status === "PAID" ? "Proses gaji ini sudah ditandai dibayar." : null,
      hasil.riwayat.length > 0
        ? `Berkas sudah pernah diunduh ${hasil.riwayat.length} kali, terakhir ${hasil.riwayat[0]?.created_at} UTC oleh ${hasil.riwayat[0]?.performed_by}. Pastikan tidak diunggah dua kali.`
        : null,
    ]
      .filter(Boolean)
      .join(" ");
    const lanjut = await konfirmasiData([
      { label: "Format", nilai: format?.nama ?? "Excel umum" },
      {
        label: "Rekening debet",
        nilai: `${hasil.debet.nama_bank ?? ""} ${hasil.debet.no_rekening} a.n. ${hasil.debet.nama_rekening}`,
      },
      { label: "Tanggal efektif", nilai: hasil.susunan.tanggal_efektif },
      {
        label: "Masuk berkas",
        nilai: `${r.jumlah_baris} karyawan, ${RUPIAH.format(r.total)}`,
      },
      {
        label: "Perlu dibayar manual",
        nilai: `${r.jumlah_manual} karyawan, ${RUPIAH.format(r.total_manual)}`,
      },
      { label: "Peringatan", nilai: peringatan, peringatan: true },
    ]);
    if (!lanjut) return;
    isSubmittingRef.current = true;
    setSibuk("unduh");
    setPesan(null);
    try {
      // Disusun ulang dan dicatat backend; berkas dirender dari hasil ini.
      const segar = await ambilBerkasTransfer(draft(true));
      const run = {
        period_start: segar.run.period_start,
        period_end: segar.run.period_end,
        status: segar.run.status,
      };
      const berkas = segar.format?.kolom
        ? berkasFormat(run, segar.susunan, {
            ...segar.format,
            kolom: segar.format.kolom,
          })
        : berkasUmum(run, segar.susunan);
      const jenis = JENIS_UNDUH[berkas.nama.split(".").pop() ?? "xlsx"];
      const hasilSimpan = await saveFileWithPicker(
        new Blob([berkas.data as BlobPart], { type: berkas.mime }),
        berkas.nama,
        jenis
          ? {
              description: jenis.description,
              accept: { [berkas.mime]: [jenis.ext] },
            }
          : undefined,
      );
      setHasil({
        ...segar,
        riwayat: [
          {
            id: "baru",
            performed_by: "Anda",
            notes: null,
            created_at: "baru saja",
          },
          ...segar.riwayat,
        ],
      });
      setPesan(
        hasilSimpan.sukses
          ? {
              tone: "success",
              text: `Berkas ${berkas.nama} tersimpan. Tandai Dibayar setelah transfer di bank berhasil.`,
            }
          : {
              tone: "error",
              text: "Berkas tidak disimpan. Unduhan tetap tercatat di audit trail.",
            },
      );
    } catch (error) {
      setPesan({
        tone: "error",
        text: pesanGalat(error, "Berkas transfer gagal diunduh."),
      });
    } finally {
      isSubmittingRef.current = false;
      setSibuk(null);
    }
  };

  const pratinjau = hasil
    ? format?.kolom
      ? selFormat(hasil.susunan, { kolom: format.kolom })
      : {
          judul: ["No", "Nama", "Bank", "Rekening", "Nominal"],
          baris: hasil.susunan.baris.map((b) => [
            b.nomor_urut ?? 0,
            b.nama_karyawan,
            b.nama_bank ?? "",
            b.no_rekening ?? "",
            RUPIAH.format(b.nominal),
          ]),
        }
    : null;
  const r = hasil?.susunan.ringkasan;

  return (
    <div className="space-y-5 rounded-xl border border-slate-800 bg-slate-900 p-4 sm:p-6">
      <div>
        <h3 className="text-base font-black text-white">Berkas transfer</h3>
        <p className="mt-1 max-w-3xl text-sm leading-6 text-slate-400">
          Aplikasi menyiapkan berkas untuk diunggah ke internet banking, tidak
          mentransfer. Nominal = gaji bersih proses gaji ini; rekening karyawan
          dibaca dari profil saat ini. Tandai Dibayar setelah transfer di bank
          berhasil.
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

      {pengaturan && pengaturan.rekening.length === 0 ? (
        <p className="rounded-xl border border-amber-400/30 bg-amber-400/10 p-3 text-sm text-amber-200">
          Belum ada rekening debet aktif. Superadmin menambahkannya di
          Pengaturan, tab Transfer Bank.
        </p>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-3">
        <div className="min-w-0">
          <label htmlFor="transfer-rekening" className={LABEL}>
            Rekening debet
          </label>
          <PilihCari
            id="transfer-rekening"
            value={idRekening}
            onChange={(e) => setIdRekening(e.target.value)}
            className={INPUT}
          >
            <option value="">Pilih rekening</option>
            {(pengaturan?.rekening ?? []).map((rek) => (
              <option key={rek.id_rekening} value={rek.id_rekening}>
                {`${rek.nama_bank ?? ""} ${rek.no_rekening} a.n. ${rek.nama_rekening}`}
              </option>
            ))}
          </PilihCari>
        </div>
        <div className="min-w-0">
          <label htmlFor="transfer-format" className={LABEL}>
            Bentuk berkas
          </label>
          <select
            id="transfer-format"
            value={idFormat}
            onChange={(e) => setIdFormat(e.target.value)}
            className={INPUT}
          >
            <option value="">Excel umum</option>
            {formatCocok.map((f) => (
              <option key={f.id_format} value={f.id_format}>
                {`${f.nama} (${f.jenis.toUpperCase()})`}
              </option>
            ))}
          </select>
        </div>
        <div className="min-w-0">
          <label htmlFor="transfer-tanggal" className={LABEL}>
            Tanggal efektif
          </label>
          <input
            id="transfer-tanggal"
            type="date"
            value={tanggal}
            onChange={(e) => setTanggal(e.target.value)}
            className={INPUT}
          />
          <p className="mt-1 text-[11px] text-slate-500">
            Kosong = hari ini (WIB).
          </p>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={tampilkan}
          disabled={sibuk !== null || !idRekening}
          className={TOMBOL_KEDUA}
        >
          {sibuk === "muat" ? "Menyusun..." : "Tampilkan baris"}
        </button>
        <button
          type="button"
          onClick={unduh}
          disabled={
            sibuk !== null || !hasil || hasil.susunan.baris.length === 0
          }
          className={TOMBOL_UTAMA}
        >
          {sibuk === "unduh" ? "Mengunduh..." : "Unduh berkas"}
        </button>
      </div>

      {hasil && r ? (
        <div className="space-y-5">
          {status === "PAID" || hasil.riwayat.length > 0 ? (
            <div className="rounded-xl border border-amber-400/30 bg-amber-400/10 p-3 text-sm text-amber-200">
              {status === "PAID" ? (
                <p>Proses gaji ini sudah ditandai dibayar.</p>
              ) : null}
              {hasil.riwayat.length > 0 ? (
                <>
                  <p>
                    Berkas sudah pernah diunduh {hasil.riwayat.length} kali.
                    Aplikasi tidak bisa mencegah unggahan ganda di internet
                    banking.
                  </p>
                  <ul className="mt-1 list-disc pl-5 text-xs">
                    {hasil.riwayat.slice(0, 5).map((u) => (
                      <li key={u.id}>
                        {u.created_at} · {u.performed_by}
                        {u.notes ? ` · ${ringkasCatatanUnduhan(u.notes)}` : ""}
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}
            </div>
          ) : null}

          <dl className="grid grid-cols-2 gap-3 text-sm lg:grid-cols-4">
            {(
              [
                ["Masuk berkas", r.jumlah_baris, r.total],
                ["Perlu dibayar manual", r.jumlah_manual, r.total_manual],
                [
                  "Di luar cakupan format",
                  r.jumlah_luar_cakupan,
                  r.total_luar_cakupan,
                ],
                ["Gaji bersih proses gaji", null, r.total_run],
              ] as const
            ).map(([label, jumlah, total]) => (
              <div
                key={label}
                className="rounded-xl border border-slate-800 bg-slate-950/60 p-3"
              >
                <dt className="text-xs text-slate-400">{label}</dt>
                <dd className="mt-1 font-mono font-bold text-slate-100">
                  {RUPIAH.format(total)}
                </dd>
                {jumlah !== null ? (
                  <dd className="text-xs text-slate-500">{jumlah} karyawan</dd>
                ) : null}
              </div>
            ))}
          </dl>

          {pratinjau && pratinjau.baris.length > 0 ? (
            <section className="space-y-2">
              <h4 className="text-sm font-bold text-slate-100">
                Pratinjau 5 baris pertama ({format?.nama ?? "Excel umum"})
              </h4>
              <div className="overflow-x-auto rounded-xl border border-slate-800">
                <table className="w-full text-left text-xs text-slate-300">
                  <thead className="bg-slate-800/80 text-[11px] text-slate-400">
                    <tr>
                      {pratinjau.judul.map((j, i) => (
                        // biome-ignore lint/suspicious/noArrayIndexKey: judul boleh kembar
                        <th key={i} className="whitespace-nowrap px-3 py-2">
                          {j}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800 font-mono">
                    {pratinjau.baris.slice(0, 5).map((isi, i) => (
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
            </section>
          ) : null}

          <DaftarBaris
            judul="Masuk berkas"
            keterangan="Tanda di sini hanya peringatan; barisnya tetap ditransfer."
            baris={hasil.susunan.baris}
          />
          <DaftarBaris
            judul="Perlu dibayar manual"
            keterangan="Tidak masuk berkas bank. Lengkapi profil keuangannya atau bayar di luar berkas."
            baris={hasil.susunan.manual}
          />
          <DaftarBaris
            judul="Di luar cakupan format ini"
            keterangan="Masuk berkas jenis transfer yang lain (sesama bank atau antarbank)."
            baris={hasil.susunan.luar_cakupan}
          />
        </div>
      ) : null}
    </div>
  );
}
