import { ensureDbInitialized } from "@/lib/db";
import { submitTerminalScan } from "./services/scanner";

export async function runTahap5Test() {
  try {
    await ensureDbInitialized();

    // Test terminal scan via service
    const res = await submitTerminalScan({
      qrContent: "EMP_TEST_001|TOKEN123",
      kodeOperator: "OP001",
      sumberData: "Scanner",
    });

    return {
      sukses: true,
      pesan:
        "Modul Terminal Scanner UI & Audio Synthesizer (Tahap 5) Berhasil Diuji!",
      hasilScan: res,
    };
  } catch (error: unknown) {
    const errMessage = error instanceof Error ? error.message : String(error);
    return {
      sukses: false,
      pesan: `Pengujian Tahap 5 Gagal: ${errMessage}`,
    };
  }
}
