import { formatTarif, PAJAK_BAWAAN } from "@/lib/validations/pajak";

const IDR = new Intl.NumberFormat("id-ID", {
  style: "currency",
  currency: "IDR",
  maximumFractionDigits: 0,
});

/**
 * PTKP, biaya jabatan, dan TER harian dari `pajak-bawaan.json` (Q-187 (a)):
 * konstanta di kode, bukan tarif yang bisa disunting (§29.7).
 */
export function KartuKonstantaPajak() {
  const { ptkp, biaya_jabatan, ter_harian } = PAJAK_BAWAAN;
  const baris: [string, string][] = [
    ["PTKP dasar (TK/0)", IDR.format(ptkp.dasar)],
    ["Tambahan kawin", IDR.format(ptkp.kawin)],
    [
      `Tambahan per tanggungan (maks ${ptkp.maks_tanggungan})`,
      IDR.format(ptkp.per_tanggungan),
    ],
    [
      "Biaya jabatan (masa terakhir)",
      `${formatTarif(biaya_jabatan.basis)}, maks ${IDR.format(biaya_jabatan.maks_per_masa)} per bulan`,
    ],
    [
      "TER harian pegawai tidak tetap",
      `0% s.d. ${IDR.format(ter_harian.batas_nol)}/hari; ${formatTarif(ter_harian.basis)} s.d. ${IDR.format(ter_harian.batas_tarif)}/hari; di atasnya Pasal 17 atas ${formatTarif(ter_harian.basis_dasar_pasal_17)} bruto`,
    ],
  ];
  return (
    <section
      id="kartu-konstanta-pajak"
      aria-labelledby="judul-konstanta-pajak"
      className="mb-4 rounded-xl border border-slate-800 bg-slate-900/60 p-4"
    >
      <h2
        id="judul-konstanta-pajak"
        className="text-sm font-semibold text-slate-200"
      >
        Konstanta PPh 21 (tidak bisa disunting)
      </h2>
      <dl className="mt-2 grid gap-x-4 gap-y-1 text-xs sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)]">
        {baris.map(([label, nilai]) => (
          <div key={label} className="contents">
            <dt className="text-slate-400">{label}</dt>
            <dd className="min-w-0 font-mono text-slate-200">{nilai}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-2 text-xs text-slate-500">
        Pajak dihitung per masa (bulan tanggal mulai proses gaji). Desember,
        atau bulan karyawan keluar, menghitung ulang setahun dengan Pasal 17.
      </p>
    </section>
  );
}

/** Catatan di halaman BPJS (§29.7): batas upah JP diperbarui setiap Maret. */
export function CatatanBatasJp() {
  return (
    <p
      id="catatan-batas-jp"
      className="mb-4 rounded-lg border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-xs text-amber-100"
    >
      Batas upah Jaminan Pensiun berubah setiap Maret menurut surat BPJS
      Ketenagakerjaan; perbarui baris JP_EMP dan JP_CO. BPJS dihitung per bulan
      atas gaji pokok ditambah tunjangan yang ditandai tetap.
    </p>
  );
}
