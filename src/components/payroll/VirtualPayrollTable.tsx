"use client";

import { useMemo, useState } from "react";
import { Modal } from "@/components/ui/Modal";
import type { PayrollRecapRow } from "@/lib/gateways/payroll";

interface VirtualPayrollTableProps {
  data: PayrollRecapRow[];
  isLoading?: boolean;
  periodStart?: string;
  periodEnd?: string;
}

const IDR = new Intl.NumberFormat("id-ID", {
  style: "currency",
  currency: "IDR",
  maximumFractionDigits: 0,
});

export function VirtualPayrollTable({
  data,
  isLoading,
  periodStart,
  periodEnd,
}: VirtualPayrollTableProps) {
  const [search, setSearch] = useState("");
  const [divisiFilter, setDivisiFilter] = useState("ALL");
  const [selectedRow, setSelectedRow] = useState<PayrollRecapRow | null>(null);

  const divisiList = useMemo(() => {
    const set = new Set<string>();
    for (const row of data) {
      if (row.divisi) set.add(row.divisi);
    }
    return Array.from(set).sort();
  }, [data]);

  const filtered = useMemo(() => {
    return data.filter((row) => {
      const matchSearch =
        search.trim() === "" ||
        row.nama_karyawan.toLowerCase().includes(search.toLowerCase()) ||
        row.id_karyawan.toLowerCase().includes(search.toLowerCase());
      const matchDivisi = divisiFilter === "ALL" || row.divisi === divisiFilter;
      return matchSearch && matchDivisi;
    });
  }, [data, search, divisiFilter]);

  const totals = useMemo(() => {
    let hadir = 0;
    let regHours = 0;
    let otHours = 0;
    let gross = 0;
    let net = 0;

    for (const r of filtered) {
      hadir += r.total_hadir;
      regHours += r.total_regular_hours;
      otHours += r.total_overtime_hours;
      gross += r.est_gross_salary;
      net += r.est_net_salary;
    }

    return { hadir, regHours, otHours, gross, net };
  }, [filtered]);

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row gap-3 justify-between items-center">
        <div className="flex flex-wrap gap-2 w-full sm:w-auto">
          <input
            type="text"
            placeholder="Cari karyawan / ID..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="px-3 py-1.5 text-sm bg-slate-800 border border-slate-700 rounded-lg text-slate-200 focus:outline-none focus:border-sky-500 w-full sm:w-64"
          />
          <select
            value={divisiFilter}
            onChange={(e) => setDivisiFilter(e.target.value)}
            className="px-3 py-1.5 text-sm bg-slate-800 border border-slate-700 rounded-lg text-slate-200 focus:outline-none focus:border-sky-500"
          >
            <option value="ALL">Semua Divisi</option>
            {divisiList.map((div) => (
              <option key={div} value={div}>
                {div}
              </option>
            ))}
          </select>
        </div>
        <div className="text-xs text-slate-400 font-medium">
          Menampilkan{" "}
          <strong className="text-slate-200">{filtered.length}</strong> dari{" "}
          {data.length} karyawan
        </div>
      </div>

      <div className="overflow-x-auto rounded-xl border border-slate-800 bg-slate-900/60 shadow-lg">
        <table className="w-full text-left text-sm text-slate-300">
          <thead className="bg-slate-800/80 text-xs font-semibold uppercase text-slate-400 border-b border-slate-700/60">
            <tr>
              <th className="py-3 px-4">Karyawan</th>
              <th className="py-3 px-4">Divisi / PTKP</th>
              <th className="py-3 px-4 text-center">Hadir</th>
              <th className="py-3 px-4 text-right">Jam Reguler</th>
              <th className="py-3 px-4 text-right">Jam Lembur</th>
              <th className="py-3 px-4 text-right">Rate / Jam</th>
              <th className="py-3 px-4 text-right">Gaji Pokok</th>
              <th className="py-3 px-4 text-right">Upah Lembur</th>
              <th className="py-3 px-4 text-right">Est. Take Home</th>
              <th className="py-3 px-4 text-center">Aksi</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800">
            {isLoading ? (
              <tr>
                <td colSpan={10} className="py-8 text-center text-slate-500">
                  Memuat data rekap payroll...
                </td>
              </tr>
            ) : filtered.length === 0 ? (
              <tr>
                <td colSpan={10} className="py-8 text-center text-slate-500">
                  Tidak ada data karyawan yang cocok.
                </td>
              </tr>
            ) : (
              filtered.map((row) => (
                <tr
                  key={row.id_karyawan}
                  className="hover:bg-slate-800/40 transition-colors"
                >
                  <td className="py-3 px-4 font-medium text-slate-200">
                    <div>{row.nama_karyawan}</div>
                    <div className="text-xs text-slate-500">
                      {row.id_karyawan}
                    </div>
                  </td>
                  <td className="py-3 px-4">
                    <div className="text-slate-300">{row.divisi}</div>
                    <span className="inline-block px-1.5 py-0.5 text-[10px] font-semibold bg-slate-800 border border-slate-700 rounded text-slate-400">
                      {row.ptkp_status}
                    </span>
                  </td>
                  <td className="py-3 px-4 text-center font-semibold text-slate-200">
                    {row.total_hadir} hr
                  </td>
                  <td className="py-3 px-4 text-right font-mono text-slate-300">
                    {row.total_regular_hours.toFixed(1)} j
                  </td>
                  <td className="py-3 px-4 text-right font-mono text-amber-400 font-semibold">
                    {row.total_overtime_hours.toFixed(1)} j
                  </td>
                  <td className="py-3 px-4 text-right font-mono text-slate-400">
                    {IDR.format(row.rate_per_hour)}
                  </td>
                  <td className="py-3 px-4 text-right font-mono text-slate-200">
                    {IDR.format(row.est_basic_salary)}
                  </td>
                  <td className="py-3 px-4 text-right font-mono text-amber-400">
                    {IDR.format(row.est_overtime_salary)}
                  </td>
                  <td className="py-3 px-4 text-right font-mono font-bold text-emerald-400">
                    {IDR.format(row.est_net_salary)}
                  </td>
                  <td className="py-3 px-4 text-center">
                    <button
                      type="button"
                      onClick={() => setSelectedRow(row)}
                      className="px-2.5 py-1 text-xs font-semibold bg-sky-500/20 hover:bg-sky-500/30 text-sky-300 rounded-lg border border-sky-500/30 transition active:scale-95"
                    >
                      Detail / Slip
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
          {filtered.length > 0 && (
            <tfoot className="bg-slate-800/90 font-bold border-t-2 border-slate-700 text-slate-200 text-sm">
              <tr>
                <td
                  colSpan={2}
                  className="py-3 px-4 text-right uppercase text-xs text-slate-400"
                >
                  Total Ringkasan:
                </td>
                <td className="py-3 px-4 text-center">{totals.hadir} hr</td>
                <td className="py-3 px-4 text-right font-mono">
                  {totals.regHours.toFixed(1)} j
                </td>
                <td className="py-3 px-4 text-right font-mono text-amber-400">
                  {totals.otHours.toFixed(1)} j
                </td>
                <td className="py-3 px-4 text-right">-</td>
                <td className="py-3 px-4 text-right font-mono">-</td>
                <td className="py-3 px-4 text-right font-mono">-</td>
                <td className="py-3 px-4 text-right font-mono text-emerald-400 text-base">
                  {IDR.format(totals.net)}
                </td>
                <td className="py-3 px-4 text-center">-</td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>

      {/* Modal Detail Slip Estimasi */}
      {selectedRow && (
        <Modal
          title={`Rincian Estimasi Upah — ${selectedRow.nama_karyawan}`}
          titleId="modal-slip-estimasi-title"
          onClose={() => setSelectedRow(null)}
        >
          <div className="space-y-4 text-xs">
            <div className="p-3.5 rounded-2xl bg-slate-950/60 border border-slate-800 space-y-2">
              <div className="grid grid-cols-2 gap-2 text-slate-300">
                <div>
                  <span className="text-slate-500 text-[10px] block">
                    NAMA KARYAWAN
                  </span>
                  <span className="font-bold text-white text-sm">
                    {selectedRow.nama_karyawan}
                  </span>
                </div>
                <div>
                  <span className="text-slate-500 text-[10px] block">
                    DIVISI
                  </span>
                  <span className="font-medium text-slate-200">
                    {selectedRow.divisi}
                  </span>
                </div>
                <div>
                  <span className="text-slate-500 text-[10px] block">
                    PERIODE
                  </span>
                  <span className="font-mono text-slate-200">
                    {periodStart || "-"} s.d. {periodEnd || "-"}
                  </span>
                </div>
                <div>
                  <span className="text-slate-500 text-[10px] block">
                    STATUS PTKP / TARIF
                  </span>
                  <span className="font-medium text-slate-200">
                    {selectedRow.ptkp_status} ·{" "}
                    {IDR.format(selectedRow.rate_per_hour)}/jam
                  </span>
                </div>
              </div>
            </div>

            <div className="p-3 rounded-xl bg-white/[0.02] border border-white/5 grid grid-cols-4 gap-2 text-center">
              <div>
                <span className="text-[10px] text-slate-400 block">
                  Total Hadir
                </span>
                <span className="font-bold text-white text-sm">
                  {selectedRow.total_hadir} Hari
                </span>
              </div>
              <div>
                <span className="text-[10px] text-slate-400 block">
                  Jam Reguler
                </span>
                <span className="font-bold text-white text-sm">
                  {selectedRow.total_regular_hours.toFixed(2)}j
                </span>
              </div>
              <div>
                <span className="text-[10px] text-amber-400 block">
                  Jam Lembur
                </span>
                <span className="font-bold text-amber-300 text-sm">
                  {selectedRow.total_overtime_hours.toFixed(2)}j
                </span>
              </div>
              <div>
                <span className="text-[10px] text-rose-400 block">
                  Jam Hari Libur
                </span>
                <span className="font-bold text-rose-300 text-sm">
                  {selectedRow.total_holiday_hours.toFixed(2)}j
                </span>
              </div>
            </div>

            {/* Bagian I: Penghasilan */}
            <div className="space-y-1.5">
              <div className="font-bold text-sky-400 uppercase tracking-wider text-[11px] pb-1 border-b border-sky-500/20">
                I. Penghasilan Kotor
              </div>
              <div className="flex justify-between py-1 border-b border-white/5">
                <span className="text-slate-300">Gaji Pokok (Reguler)</span>
                <span className="font-mono font-medium text-white">
                  {IDR.format(selectedRow.est_basic_salary)}
                </span>
              </div>
              <div className="flex justify-between py-1 border-b border-white/5">
                <span className="text-slate-300">
                  Upah Lembur (Indeks Hari Kerja{" "}
                  {selectedRow.total_overtime_index.toFixed(2)} + Hari Libur{" "}
                  {selectedRow.total_holiday_overtime_index.toFixed(2)})
                </span>
                <span className="font-mono font-medium text-amber-300">
                  {IDR.format(selectedRow.est_overtime_salary)}
                </span>
              </div>
              {selectedRow.est_total_allowance > 0 && (
                <div className="flex justify-between py-1 border-b border-white/5">
                  <span className="text-slate-300">Tunjangan Tambahan</span>
                  <span className="font-mono font-medium text-emerald-300">
                    {IDR.format(selectedRow.est_total_allowance)}
                  </span>
                </div>
              )}
              <div className="flex justify-between py-1.5 font-bold text-slate-100 bg-white/[0.03] px-2 rounded-lg">
                <span>Total Penghasilan Kotor</span>
                <span className="font-mono text-sky-300">
                  {IDR.format(selectedRow.est_gross_salary)}
                </span>
              </div>
            </div>

            {/* Bagian II: Pemotongan */}
            <div className="space-y-1.5">
              <div className="font-bold text-rose-400 uppercase tracking-wider text-[11px] pb-1 border-b border-rose-500/20">
                II. Pemotongan
              </div>
              {selectedRow.est_bpjs_employee > 0 && (
                <div className="flex justify-between py-1 border-b border-white/5">
                  <span className="text-slate-300">Iuran BPJS Pekerja</span>
                  <span className="font-mono text-rose-400">
                    {IDR.format(selectedRow.est_bpjs_employee)}
                  </span>
                </div>
              )}
              {selectedRow.est_pph21 > 0 && (
                <div className="flex justify-between py-1 border-b border-white/5">
                  <span className="text-slate-300">
                    Pajak PPh 21 (TER {selectedRow.ptkp_status})
                  </span>
                  <span className="font-mono text-rose-400">
                    {IDR.format(selectedRow.est_pph21)}
                  </span>
                </div>
              )}
              {selectedRow.est_total_deduction > 0 && (
                <div className="flex justify-between py-1 border-b border-white/5">
                  <span className="text-slate-300">Potongan Tambahan</span>
                  <span className="font-mono text-rose-400">
                    {IDR.format(selectedRow.est_total_deduction)}
                  </span>
                </div>
              )}
              <div className="flex justify-between py-1.5 font-bold text-slate-100 bg-white/[0.03] px-2 rounded-lg">
                <span>Total Seluruh Potongan</span>
                <span className="font-mono text-rose-400">
                  {IDR.format(
                    selectedRow.est_total_deduction +
                      selectedRow.est_bpjs_employee +
                      selectedRow.est_pph21,
                  )}
                </span>
              </div>
            </div>

            {/* Bagian III: Take Home Pay */}
            <div className="p-4 rounded-2xl bg-gradient-to-r from-sky-500/20 via-sky-500/10 to-transparent border border-sky-500/30 flex items-center justify-between">
              <div>
                <span className="text-[10px] uppercase font-bold text-sky-400 block">
                  Gaji Bersih Diterima (Take Home Pay)
                </span>
                <span className="text-xl font-black text-white">
                  {IDR.format(selectedRow.est_net_salary)}
                </span>
              </div>
              <button
                type="button"
                onClick={() => setSelectedRow(null)}
                className="px-4 py-2 rounded-xl bg-sky-500 hover:bg-sky-400 text-slate-950 font-black text-xs transition"
              >
                Tutup
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
