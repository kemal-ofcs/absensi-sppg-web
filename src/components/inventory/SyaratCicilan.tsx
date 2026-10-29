"use client";

import { useRef } from "react";
import { formatRupiah } from "@/lib/validations/accounting";
import {
  besaranCicilan,
  MAKS_KREDITUR,
  MAKS_NOMOR_KONTRAK,
  MAKS_TENOR,
  SATUAN_JADWAL,
  type SyaratDraft,
  type SyaratPengajuan,
  susunJadwal,
  syaratDraftSchema,
  validasiSyarat,
} from "@/lib/validations/cicilan";
import { tanggalTampil } from "@/lib/validations/tutup-buku";
import { angka, INPUT, LABEL, TOMBOL_KEDUA } from "./gaya";

/**
 * Isian syarat cicilan (v31) untuk formulir pengajuan dan penerimaan, serta
 * ringkasannya. Hitungan di layar memakai `validasiSyarat` yang sama dengan
 * backend, jadi yang ditampilkan adalah yang akan disimpan. Dipakai
 * Web/Desktop dan Mobile (disalin lewat `filesToCopy`).
 */

type Satuan = (typeof SATUAN_JADWAL)[number];

export interface IsianSyarat {
  kreditur: string;
  nomorKontrak: string;
  uangMuka: string;
  pola: "Berkala" | "Manual";
  pertama: string;
  setiap: string;
  satuan: Satuan;
  tenor: string;
  nominal: string;
  jadwal: { kunci: number; tanggal: string; nominal: string }[];
}

/** Hanya digit yang dibaca; titik pemisah ribuan boleh diketik. */
function bulat(teks: string): number {
  const digit = teks.replace(/\D/g, "");
  return digit ? Number(digit) : 0;
}

export function isianSyaratAwal(
  syarat: SyaratPengajuan | null,
  hariIni: string,
): IsianSyarat {
  if (!syarat) {
    return {
      kreditur: "",
      nomorKontrak: "",
      uangMuka: "",
      pola: "Berkala",
      pertama: hariIni,
      setiap: "1",
      satuan: "Bulan",
      tenor: "",
      nominal: "",
      jadwal: [],
    };
  }
  const angsuran = syarat.jadwal.filter((b) => b.ke > 0);
  return {
    kreditur: syarat.kreditur,
    nomorKontrak: syarat.nomor_kontrak ?? "",
    uangMuka: angka(syarat.uang_muka),
    pola: syarat.pola,
    pertama: angsuran[0]?.jatuh_tempo ?? hariIni,
    setiap: String(syarat.setiap ?? 1),
    satuan: syarat.satuan ?? "Bulan",
    tenor: String(angsuran.length),
    nominal: angka(angsuran[0]?.nominal ?? 0),
    jadwal: angsuran.map((b) => ({
      kunci: b.ke,
      tanggal: b.jatuh_tempo,
      nominal: angka(b.nominal),
    })),
  };
}

export function draftSyarat(isian: IsianSyarat): SyaratDraft {
  return {
    kreditur: isian.kreditur,
    nomor_kontrak: isian.nomorKontrak,
    uang_muka: bulat(isian.uangMuka),
    pola: isian.pola,
    jatuh_tempo_pertama: isian.pertama,
    setiap: bulat(isian.setiap),
    satuan: isian.satuan,
    tenor: bulat(isian.tenor),
    nominal: bulat(isian.nominal),
    jadwal: isian.jadwal.map((b) => ({
      jatuh_tempo: b.tanggal,
      nominal: bulat(b.nominal),
    })),
  };
}

/** Hasil validasi isian, sama dengan yang diperiksa backend saat disimpan. */
export function periksaSyarat(
  isian: IsianSyarat,
  hargaTunai: number,
  tanggalAwal: string,
  tanggalDp: string,
) {
  const draft = syaratDraftSchema.safeParse(draftSyarat(isian));
  if (!draft.success) {
    return { ok: false as const, error: "Isian syarat belum lengkap." };
  }
  return validasiSyarat(draft.data, hargaTunai, tanggalAwal, tanggalDp);
}

function Ringkas({
  hargaTunai,
  uangMuka,
  totalAngsuran,
  totalBayar,
  bunga,
}: {
  hargaTunai: number;
  uangMuka: number;
  totalAngsuran: number;
  totalBayar: number;
  bunga: number;
}) {
  const baris: [string, number][] = [
    ["Harga tunai", hargaTunai],
    ["Uang muka", uangMuka],
    ["Total angsuran", totalAngsuran],
    ["Total bayar", totalBayar],
    ["Bunga (total bayar − harga tunai)", bunga],
  ];
  return (
    <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-2">
      {baris.map(([label, nilai]) => (
        <div key={label} className="flex justify-between gap-3">
          <dt className="text-slate-400">{label}</dt>
          <dd className="tabular-nums text-slate-100">{formatRupiah(nilai)}</dd>
        </div>
      ))}
    </dl>
  );
}

export function FormSyarat({
  idAwal,
  isian,
  onChange,
  hargaTunai,
  tanggalAwal,
  tanggalDp,
}: {
  idAwal: string;
  isian: IsianSyarat;
  onChange: (isian: IsianSyarat) => void;
  hargaTunai: number;
  tanggalAwal: string;
  tanggalDp: string;
}) {
  const kunciRef = useRef(1000);
  const ubah = (isi: Partial<IsianSyarat>) => onChange({ ...isian, ...isi });
  const hasil = periksaSyarat(isian, hargaTunai, tanggalAwal, tanggalDp);

  const keManual = () => {
    const susun = susunJadwal(
      isian.pertama,
      bulat(isian.setiap),
      isian.satuan,
      bulat(isian.tenor),
      bulat(isian.nominal),
    );
    ubah({
      pola: "Manual",
      jadwal: susun.ok
        ? susun.value.map((b) => {
            kunciRef.current += 1;
            return {
              kunci: kunciRef.current,
              tanggal: b.jatuh_tempo,
              nominal: angka(b.nominal),
            };
          })
        : isian.jadwal,
    });
  };

  const ubahBaris = (
    kunci: number,
    isi: Partial<IsianSyarat["jadwal"][number]>,
  ) =>
    ubah({
      jadwal: isian.jadwal.map((b) =>
        b.kunci === kunci ? { ...b, ...isi } : b,
      ),
    });

  return (
    <fieldset className="space-y-3 rounded-lg border border-slate-800 bg-slate-950/40 p-3">
      <legend className="px-1 text-sm font-semibold text-slate-100">
        Syarat cicilan
      </legend>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor={`${idAwal}-kreditur`} className={LABEL}>
            Kreditur (toko atau leasing)
          </label>
          <input
            id={`${idAwal}-kreditur`}
            required
            maxLength={MAKS_KREDITUR}
            value={isian.kreditur}
            onChange={(e) => ubah({ kreditur: e.target.value })}
            className={INPUT}
          />
        </div>
        <div>
          <label htmlFor={`${idAwal}-kontrak`} className={LABEL}>
            Nomor kontrak (boleh menyusul)
          </label>
          <input
            id={`${idAwal}-kontrak`}
            maxLength={MAKS_NOMOR_KONTRAK}
            value={isian.nomorKontrak}
            onChange={(e) => ubah({ nomorKontrak: e.target.value })}
            className={INPUT}
          />
        </div>
        <div>
          <label htmlFor={`${idAwal}-dp`} className={LABEL}>
            Uang muka / DP (Rp)
          </label>
          <input
            id={`${idAwal}-dp`}
            inputMode="numeric"
            autoComplete="off"
            placeholder="0"
            value={isian.uangMuka}
            onChange={(e) => ubah({ uangMuka: e.target.value })}
            className={INPUT}
          />
        </div>
        <div>
          <label htmlFor={`${idAwal}-pola`} className={LABEL}>
            Jadwal angsuran
          </label>
          <select
            id={`${idAwal}-pola`}
            value={isian.pola}
            onChange={(e) =>
              e.target.value === "Manual"
                ? keManual()
                : ubah({ pola: "Berkala" })
            }
            className={INPUT}
          >
            <option value="Berkala">Berkala (nominal sama)</option>
            <option value="Manual">Manual (diketik per baris)</option>
          </select>
        </div>
      </div>

      {isian.pola === "Berkala" ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor={`${idAwal}-pertama`} className={LABEL}>
              Jatuh tempo angsuran pertama
            </label>
            <input
              id={`${idAwal}-pertama`}
              type="date"
              min={tanggalAwal}
              value={isian.pertama}
              onChange={(e) => ubah({ pertama: e.target.value })}
              className={INPUT}
            />
          </div>
          <div className="flex items-end gap-2">
            <div className="w-24">
              <label htmlFor={`${idAwal}-setiap`} className={LABEL}>
                Setiap
              </label>
              <input
                id={`${idAwal}-setiap`}
                inputMode="numeric"
                autoComplete="off"
                value={isian.setiap}
                onChange={(e) => ubah({ setiap: e.target.value })}
                className={INPUT}
              />
            </div>
            <div className="min-w-0 flex-1">
              <label htmlFor={`${idAwal}-satuan`} className={LABEL}>
                Satuan
              </label>
              <select
                id={`${idAwal}-satuan`}
                value={isian.satuan}
                onChange={(e) => ubah({ satuan: e.target.value as Satuan })}
                className={INPUT}
              >
                {SATUAN_JADWAL.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div>
            <label htmlFor={`${idAwal}-tenor`} className={LABEL}>
              Tenor (kali, 1–{MAKS_TENOR})
            </label>
            <input
              id={`${idAwal}-tenor`}
              inputMode="numeric"
              autoComplete="off"
              value={isian.tenor}
              onChange={(e) => ubah({ tenor: e.target.value })}
              className={INPUT}
            />
          </div>
          <div>
            <label htmlFor={`${idAwal}-nominal`} className={LABEL}>
              Nominal per angsuran (Rp)
            </label>
            <input
              id={`${idAwal}-nominal`}
              inputMode="numeric"
              autoComplete="off"
              value={isian.nominal}
              onChange={(e) => ubah({ nominal: e.target.value })}
              className={INPUT}
            />
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          {isian.jadwal.map((b, indeks) => (
            <div key={b.kunci} className="flex flex-wrap items-end gap-2">
              <div className="min-w-36 flex-1">
                <label htmlFor={`${idAwal}-tgl-${b.kunci}`} className={LABEL}>
                  Angsuran {indeks + 1}: jatuh tempo
                </label>
                <input
                  id={`${idAwal}-tgl-${b.kunci}`}
                  type="date"
                  value={b.tanggal}
                  onChange={(e) =>
                    ubahBaris(b.kunci, { tanggal: e.target.value })
                  }
                  className={INPUT}
                />
              </div>
              <div className="min-w-36 flex-1">
                <label htmlFor={`${idAwal}-nom-${b.kunci}`} className={LABEL}>
                  Nominal (Rp)
                </label>
                <input
                  id={`${idAwal}-nom-${b.kunci}`}
                  inputMode="numeric"
                  autoComplete="off"
                  value={b.nominal}
                  onChange={(e) =>
                    ubahBaris(b.kunci, { nominal: e.target.value })
                  }
                  className={INPUT}
                />
              </div>
              <button
                type="button"
                onClick={() =>
                  ubah({
                    jadwal: isian.jadwal.filter((x) => x.kunci !== b.kunci),
                  })
                }
                aria-label={`Hapus angsuran ${indeks + 1}`}
                className={TOMBOL_KEDUA}
              >
                Hapus
              </button>
            </div>
          ))}
          {isian.jadwal.length < MAKS_TENOR ? (
            <button
              type="button"
              onClick={() => {
                kunciRef.current += 1;
                ubah({
                  jadwal: [
                    ...isian.jadwal,
                    { kunci: kunciRef.current, tanggal: "", nominal: "" },
                  ],
                });
              }}
              className={TOMBOL_KEDUA}
            >
              Tambah angsuran
            </button>
          ) : null}
        </div>
      )}

      {hasil.ok ? (
        <Ringkas {...ringkasDari(hargaTunai, hasil.value.jadwal)} />
      ) : (
        <p className="text-sm text-amber-300" aria-live="polite">
          {hasil.error}
        </p>
      )}
    </fieldset>
  );
}

function ringkasDari(hargaTunai: number, jadwal: SyaratPengajuan["jadwal"]) {
  const b = besaranCicilan(hargaTunai, jadwal);
  return {
    hargaTunai: b.harga_tunai,
    uangMuka: b.uang_muka,
    totalAngsuran: b.total_angsuran,
    totalBayar: b.total_bayar,
    bunga: b.bunga,
  };
}

/** Ringkasan syarat yang tersimpan (daftar pengajuan dan persetujuan). */
export function RingkasanSyarat({
  syarat,
  hargaTunai,
}: {
  syarat: SyaratPengajuan;
  hargaTunai: number;
}) {
  const angsuran = syarat.jadwal.filter((b) => b.ke > 0);
  return (
    <div className="space-y-2 rounded-lg border border-slate-800 bg-slate-950/40 p-3 text-sm">
      <p className="text-slate-300 wrap-break-word">
        Cicilan ke {syarat.kreditur}
        {syarat.nomor_kontrak ? ` · kontrak ${syarat.nomor_kontrak}` : ""} ·{" "}
        {angsuran.length}× angsuran
        {syarat.pola === "Berkala" && syarat.setiap && syarat.satuan
          ? ` setiap ${syarat.setiap} ${syarat.satuan.toLowerCase()}`
          : " (jadwal manual)"}
      </p>
      <Ringkas {...ringkasDari(hargaTunai, syarat.jadwal)} />
      {syarat.total_disetujui !== null ? (
        <p className="text-xs text-slate-400">
          Total bayar yang di-ACC {formatRupiah(syarat.total_disetujui)}
        </p>
      ) : null}
      <details>
        <summary className="min-h-11 cursor-pointer py-2 text-slate-300">
          Jadwal angsuran
        </summary>
        <ol className="space-y-1 text-slate-400">
          {syarat.jadwal.map((b) => (
            <li key={b.ke} className="flex justify-between gap-3">
              <span>
                {b.ke === 0 ? "Uang muka" : `Angsuran ${b.ke}`} ·{" "}
                {tanggalTampil(b.jatuh_tempo)}
              </span>
              <span className="tabular-nums">{formatRupiah(b.nominal)}</span>
            </li>
          ))}
        </ol>
      </details>
    </div>
  );
}
