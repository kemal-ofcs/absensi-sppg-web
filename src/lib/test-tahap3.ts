import { ensureDbInitialized } from "@/lib/db";
import {
  getDaftarKaryawan,
  getKaryawanById,
  tambahKaryawan,
} from "./services/employee";
import { getDaftarIdCard, updateStatusIdCard } from "./services/idcard";
import { verifikasiLoginOperator } from "./services/operator";
import { getDaftarShift, tambahShift } from "./services/shift";

export async function runTahap3Test() {
  try {
    await ensureDbInitialized();

    // 1. Test Master Karyawan (Tambah & Query)
    const newEmpId = "EMP_TEST_002";
    await tambahKaryawan({
      id_unik: newEmpId,
      kode_karyawan: "K002",
      nama: "Siti Aminah (Test)",
      divisi: "Keuangan",
      jabatan_status: "Staff Finance",
      no_hp: "08198765432",
      lp: "P",
      id_shift: 1,
      status_aktif: "Aktif",
    });

    const empData = await getKaryawanById(newEmpId);
    const allEmps = await getDaftarKaryawan();

    // 2. Test Shift Settings (Tambah Shift 5)
    await tambahShift({
      kode_shift: 5,
      nama_shift: "Shift 5 - Khusus Lembur",
      jam_masuk: "18:00",
      jam_pulang: "02:00",
      jam_kerja_normal_menit: 480,
    });
    const allShifts = await getDaftarShift();

    // 3. Test Operator Auth
    const authResult = await verifikasiLoginOperator("admin", "admin123");

    // 4. Test ID Card Status Update
    await updateStatusIdCard({
      id_unik: newEmpId,
      idcard_status: "Berhasil",
      idcard_pdf_url: "https://storage.sppg.app/idcards/EMP_TEST_002.pdf",
      link_qr_png:
        "https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=EMP_TEST_002|TEST",
      idcard_catatan: "Generate sukses Tahap 3",
    });
    const allIdCards = await getDaftarIdCard();

    return {
      sukses: true,
      pesan:
        "Modul Master Karyawan, Shift, Operator, & ID Card (Tahap 3) Berhasil Diuji!",
      karyawanBaru: empData,
      totalKaryawan: allEmps.length,
      totalShift: allShifts.length,
      loginAdminTest: authResult,
      totalIdCard: allIdCards.length,
    };
  } catch (error: unknown) {
    const errMessage = error instanceof Error ? error.message : String(error);
    return {
      sukses: false,
      pesan: `Pengujian Tahap 3 Gagal: ${errMessage}`,
    };
  }
}
