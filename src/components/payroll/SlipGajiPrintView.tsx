"use client";

import { BRANDING } from "@/lib/constants/branding";
import type { PayrollItemRow, PayrollRunRow } from "@/lib/gateways/payroll";

interface SlipGajiPrintViewProps {
  run: PayrollRunRow;
  item: PayrollItemRow;
  companyName?: string;
  branchName?: string;
  address?: string;
  phone?: string;
}

interface ComponentItem {
  id: string;
  name: string;
  category: "ALLOWANCE" | "DEDUCTION";
  calc_type: string;
  rate: number;
  nominal: number;
}

interface BpjsItem {
  code: string;
  name: string;
  rate: number;
  wage_cap: number | null;
  nominal: number;
  is_employee: boolean;
}

interface BreakdownSnapshot {
  rate_per_hour?: number;
  regular_hours?: number;
  overtime_hours?: number;
  overtime_index?: number;
  basic_salary?: number;
  overtime_salary?: number;
  components?: ComponentItem[];
  bpjs?: BpjsItem[];
  tax?: {
    method?: string;
    category?: string;
    ptkp_status?: string;
    rate_percentage?: number;
    pph21_amount?: number;
  };
}

const IDR = new Intl.NumberFormat("id-ID", {
  style: "currency",
  currency: "IDR",
  maximumFractionDigits: 0,
});

export function SlipGajiPrintView({
  run,
  item,
  companyName = BRANDING.defaultCompanyName,
  branchName = BRANDING.defaultBranchName,
  address = BRANDING.defaultAddress,
  phone = BRANDING.defaultPhone,
}: SlipGajiPrintViewProps) {
  let breakdown: BreakdownSnapshot = {};
  try {
    breakdown = JSON.parse(
      item.breakdown_snapshot || "{}",
    ) as BreakdownSnapshot;
  } catch {
    breakdown = {};
  }

  const components: ComponentItem[] = breakdown.components || [];
  const allowances = components.filter((c) => c.category === "ALLOWANCE");
  const deductions = components.filter((c) => c.category === "DEDUCTION");
  const bpjsList: BpjsItem[] = (breakdown.bpjs || []).filter(
    (b) => b.is_employee,
  );

  return (
    <div className="bg-white text-slate-900 p-8 max-w-2xl mx-auto border border-slate-300 rounded-lg shadow-sm print:border-none print:shadow-none print:p-0 print:m-0 print:max-w-full font-sans text-sm">
      {/* Header */}
      <div className="border-b-2 border-slate-800 pb-4 mb-4 flex justify-between items-start">
        <div>
          <h1 className="text-xl font-bold tracking-tight uppercase text-slate-900">
            {companyName}
          </h1>
          <p className="text-xs text-slate-600">{branchName}</p>
          <p className="text-xs text-slate-500">
            {address} | Telp: {phone}
          </p>
        </div>
        <div className="text-right">
          <span className="inline-block px-3 py-1 bg-slate-100 border border-slate-300 text-xs font-bold uppercase rounded">
            SLIP GAJI
          </span>
          <p className="text-xs text-slate-500 mt-1 font-mono">{run.id}</p>
        </div>
      </div>

      {/* Info Karyawan & Periode */}
      <div className="grid grid-cols-2 gap-4 mb-6 bg-slate-50 p-4 rounded border border-slate-200 text-xs">
        <div className="space-y-1">
          <div>
            <span className="text-slate-500">Nama:</span>{" "}
            <strong className="text-slate-800 text-sm">
              {item.nama_karyawan}
            </strong>
          </div>
          <div>
            <span className="text-slate-500">ID / NIP:</span>{" "}
            <span className="font-mono text-slate-700">{item.id_karyawan}</span>
          </div>
          <div>
            <span className="text-slate-500">Divisi / Unit:</span>{" "}
            <span className="text-slate-700">{item.divisi}</span>
          </div>
        </div>
        <div className="space-y-1 text-right sm:text-left">
          <div>
            <span className="text-slate-500">Periode:</span>{" "}
            <strong className="text-slate-800">
              {run.period_start} s.d. {run.period_end}
            </strong>
          </div>
          <div>
            <span className="text-slate-500">Status PTKP:</span>{" "}
            <span className="font-semibold text-slate-700">
              {item.ptkp_status}
            </span>
          </div>
          <div>
            <span className="text-slate-500">Jam Kerja:</span>{" "}
            <span className="font-mono text-slate-700">
              {`${Number(item.total_regular_hours.toFixed(2))} Jam (Lembur: ${Number(item.total_overtime_hours.toFixed(2))} Jam, Hari Libur: ${Number(item.total_holiday_hours.toFixed(2))} Jam)`}
            </span>
          </div>
        </div>
      </div>

      {/* Rincian Finansial 2 Kolom */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
        {/* Kolom Penghasilan */}
        <div>
          <h2 className="text-xs font-bold uppercase border-b border-slate-300 pb-1 mb-2 text-emerald-800">
            A. Penghasilan
          </h2>
          <table className="w-full text-xs">
            <tbody className="divide-y divide-slate-100">
              <tr>
                <td className="py-1 text-slate-600">
                  {`Gaji Pokok (${Number(item.total_regular_hours.toFixed(2))}j)`}
                </td>
                <td className="py-1 text-right font-mono font-medium">
                  {IDR.format(item.basic_salary)}
                </td>
              </tr>
              {item.overtime_salary > 0 && (
                <tr>
                  <td className="py-1 text-slate-600">
                    {`Upah Lembur (${Number(item.total_overtime_index.toFixed(2))} idx hari kerja + ${Number(item.total_holiday_overtime_index.toFixed(2))} idx hari libur)`}
                  </td>
                  <td className="py-1 text-right font-mono font-medium">
                    {IDR.format(item.overtime_salary)}
                  </td>
                </tr>
              )}
              {allowances.map((a) => (
                <tr key={a.id}>
                  <td className="py-1 text-slate-600">{a.name}</td>
                  <td className="py-1 text-right font-mono font-medium">
                    {IDR.format(a.nominal)}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-slate-300 font-bold">
                <td className="pt-2 text-slate-800">Total Penghasilan Kotor</td>
                <td className="pt-2 text-right font-mono text-emerald-700">
                  {IDR.format(item.gross_salary)}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>

        {/* Kolom Potongan */}
        <div>
          <h2 className="text-xs font-bold uppercase border-b border-slate-300 pb-1 mb-2 text-rose-800">
            B. Potongan
          </h2>
          <table className="w-full text-xs">
            <tbody className="divide-y divide-slate-100">
              {bpjsList.map((b) => (
                <tr key={b.code}>
                  <td className="py-1 text-slate-600">{b.name}</td>
                  <td className="py-1 text-right font-mono text-rose-600 font-medium">
                    {IDR.format(b.nominal)}
                  </td>
                </tr>
              ))}
              {item.pph21_amount > 0 && (
                <tr>
                  <td className="py-1 text-slate-600">
                    PPh 21 (TER {item.ptkp_status})
                  </td>
                  <td className="py-1 text-right font-mono text-rose-600 font-medium">
                    {IDR.format(item.pph21_amount)}
                  </td>
                </tr>
              )}
              {deductions.map((d) => (
                <tr key={d.id}>
                  <td className="py-1 text-slate-600">{d.name}</td>
                  <td className="py-1 text-right font-mono text-rose-600 font-medium">
                    {IDR.format(d.nominal)}
                  </td>
                </tr>
              ))}
              {bpjsList.length === 0 &&
                item.pph21_amount === 0 &&
                deductions.length === 0 && (
                  <tr>
                    <td colSpan={2} className="py-1 text-slate-400 italic">
                      Tidak ada potongan.
                    </td>
                  </tr>
                )}
            </tbody>
            <tfoot>
              <tr className="border-t border-slate-300 font-bold">
                <td className="pt-2 text-slate-800">Total Potongan</td>
                <td className="pt-2 text-right font-mono text-rose-700">
                  {IDR.format(
                    item.total_deductions +
                      item.bpjs_employee_total +
                      item.pph21_amount,
                  )}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>

      {/* Total Bersih (Take Home Pay) */}
      <div className="bg-slate-900 text-white p-4 rounded-lg flex justify-between items-center mb-8 print:bg-slate-100 print:text-slate-900 print:border-2 print:border-slate-800">
        <div>
          <span className="text-xs uppercase font-semibold text-slate-400 print:text-slate-600 block">
            Gaji Bersih Diterima (Take Home Pay)
          </span>
          <span className="text-xs italic text-slate-500 print:text-slate-500">
            Ditransfer ke rekening terdaftar
          </span>
        </div>
        <div className="text-2xl font-bold font-mono text-emerald-400 print:text-slate-900">
          {IDR.format(item.net_salary)}
        </div>
      </div>

      {/* Tanda Tangan */}
      <div className="grid grid-cols-2 gap-8 text-center text-xs pt-4 border-t border-slate-200">
        <div>
          <p className="text-slate-500 mb-12">Penerima,</p>
          <p className="font-bold border-b border-slate-400 inline-block px-8 pb-1 text-slate-800">
            {item.nama_karyawan}
          </p>
        </div>
        <div>
          <p className="text-slate-500 mb-12">Bagian Keuangan / HRD,</p>
          <p className="font-bold border-b border-slate-400 inline-block px-8 pb-1 text-slate-800">
            {run.created_by}
          </p>
        </div>
      </div>
    </div>
  );
}
