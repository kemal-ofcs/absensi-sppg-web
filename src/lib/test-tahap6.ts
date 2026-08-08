import { ensureDbInitialized } from "@/lib/db";
import {
  getDashboardMetrics,
  getRekapBulanan,
  getRekapHarian,
} from "./services/report";

export async function runTahap6Test() {
  try {
    await ensureDbInitialized();

    const metrics = await getDashboardMetrics();
    const rekapHarian = await getRekapHarian();
    const rekapBulanan = await getRekapBulanan();

    return {
      sukses: true,
      pesan:
        "Modul Dashboard Analytics & Rekapitulasi Laporan (Tahap 6) Berhasil Diuji!",
      metrics,
      totalRekapHarian: rekapHarian.length,
      totalRekapBulanan: rekapBulanan.length,
    };
  } catch (error: unknown) {
    const errMessage = error instanceof Error ? error.message : String(error);
    return {
      sukses: false,
      pesan: `Pengujian Tahap 6 Gagal: ${errMessage}`,
    };
  }
}
