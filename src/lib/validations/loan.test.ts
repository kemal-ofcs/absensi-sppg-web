import { describe, expect, test } from "bun:test";
import {
  aturanKeputusan,
  idAngsuranGaji,
  idTunda,
  isValidPeriode,
  komponenKasbon,
  type PinjamanDraft,
  pinjamanDraftSchema,
  potongKasbon,
  susunJurnalPayroll,
  validatePelunasan,
  validatePinjaman,
} from "./loan";

// Vektor kembar `mod tests` di `src-tauri/src/desktop/loan.rs`.

const hasil = <T>(h: { ok: true; value: T } | { ok: false; error: string }) =>
  h.ok ? h.value : h.error;

describe("periode dan id", () => {
  test("isValidPeriode", () => {
    expect(isValidPeriode("2026-10")).toBe(true);
    expect(isValidPeriode("2026-13")).toBe(false);
    expect(isValidPeriode("2026-1")).toBe(false);
    expect(isValidPeriode("1899-01")).toBe(false);
  });

  test("id deterministik", () => {
    expect(idTunda("pjm-1", "2026-11")).toBe("tunda-pjm-1-2026-11");
    expect(idAngsuranGaji("PR-1-K01", "pjm-1")).toBe("ang-PR-1-K01-pjm-1");
  });
});

describe("validatePinjaman", () => {
  const sah: PinjamanDraft = {
    id_karyawan: " K-01 ",
    pokok: 3_000_000,
    cicilan: 500_000,
    mulai_potong: "2026-11",
    keterangan: " Biaya berobat anak ",
  };
  const galat = (ubah: Partial<PinjamanDraft>) =>
    hasil(validatePinjaman(pinjamanDraftSchema.parse({ ...sah, ...ubah })));

  test("draft sah dirapikan", () => {
    expect(galat({})).toEqual({
      id_karyawan: "K-01",
      pokok: 3_000_000,
      cicilan: 500_000,
      mulai_potong: "2026-11",
      keterangan: "Biaya berobat anak",
    });
  });

  test("penolakan", () => {
    expect(galat({ id_karyawan: " " })).toBe("Karyawan wajib dipilih.");
    expect(galat({ pokok: 0 })).toBe(
      "Pokok pinjaman harus rupiah bulat lebih dari nol.",
    );
    expect(galat({ pokok: 1500.5 })).toBe(
      "Pokok pinjaman harus rupiah bulat lebih dari nol.",
    );
    expect(galat({ pokok: 1_000_000_001 })).toBe(
      "Pokok pinjaman maksimal Rp1.000.000.000.",
    );
    expect(galat({ cicilan: -1 })).toBe(
      "Cicilan harus rupiah bulat lebih dari nol.",
    );
    expect(galat({ cicilan: 3_000_001 })).toBe(
      "Cicilan tidak boleh melebihi pokok pinjaman.",
    );
    expect(galat({ mulai_potong: "2026-13" })).toBe(
      "Bulan mulai potong tidak valid.",
    );
    expect(galat({ keterangan: "k".repeat(101) })).toBe(
      "Keterangan maksimal 100 karakter.",
    );
  });
});

describe("aturanKeputusan", () => {
  test("transisi sah dan yang ditolak", () => {
    expect(hasil(aturanKeputusan("Diajukan", "setujui", false))).toBe(
      "Disetujui",
    );
    expect(hasil(aturanKeputusan("Diajukan", "tolak", false))).toBe("Ditolak");
    expect(hasil(aturanKeputusan("Disetujui", "setujui", false))).toBe(
      "Hanya pengajuan yang bisa disetujui atau ditolak.",
    );
    expect(hasil(aturanKeputusan("Disetujui", "batalkan", false))).toBe(
      "Dibatalkan",
    );
    expect(hasil(aturanKeputusan("Disetujui", "batalkan", true))).toBe(
      "Pinjaman yang sudah diangsur tidak bisa dibatalkan.",
    );
    expect(hasil(aturanKeputusan("Diajukan", "batalkan", false))).toBe(
      "Hanya pinjaman yang sudah disetujui yang bisa dibatalkan.",
    );
    expect(hasil(aturanKeputusan("Diajukan", "hapus", false))).toBe(
      "Aksi tidak dikenal.",
    );
  });
});

describe("validatePelunasan", () => {
  test("batas sisa", () => {
    expect(hasil(validatePelunasan(0, 100))).toBe(
      "Jumlah pelunasan harus rupiah bulat lebih dari nol.",
    );
    expect(hasil(validatePelunasan(150, 100))).toBe(
      "Jumlah pelunasan melebihi sisa pinjaman Rp100.",
    );
    expect(hasil(validatePelunasan(10, -5))).toBe(
      "Jumlah pelunasan melebihi sisa pinjaman Rp0.",
    );
    expect(hasil(validatePelunasan(100, 100))).toBe(100);
  });
});

describe("potongKasbon", () => {
  const pinjaman = [
    { id_pinjaman: "a", cicilan: 300_000, sisa_efektif: 1_000_000 },
    { id_pinjaman: "b", cicilan: 500_000, sisa_efektif: 200_000 },
    { id_pinjaman: "c", cicilan: 100_000, sisa_efektif: 0 },
  ];

  test("cukup gaji: setiap cicilan dibatasi sisanya", () => {
    expect(potongKasbon(1_000_000, pinjaman)).toEqual({
      total: 500_000,
      rincian: [
        { id_pinjaman: "a", jumlah: 300_000, sebagian: false },
        { id_pinjaman: "b", jumlah: 200_000, sebagian: false },
      ],
    });
  });

  test("gaji tidak cukup: dipotong sebagian, tidak pernah minus", () => {
    expect(potongKasbon(400_000, pinjaman)).toEqual({
      total: 400_000,
      rincian: [
        { id_pinjaman: "a", jumlah: 300_000, sebagian: false },
        { id_pinjaman: "b", jumlah: 100_000, sebagian: true },
      ],
    });
    expect(potongKasbon(0, pinjaman)).toEqual({ total: 0, rincian: [] });
    expect(potongKasbon(-50, pinjaman)).toEqual({ total: 0, rincian: [] });
  });

  test("komponen slip", () => {
    expect(
      komponenKasbon([{ id_pinjaman: "b", jumlah: 100_000, sebagian: true }]),
    ).toEqual([
      {
        id: "kasbon-b",
        name: "Cicilan Kasbon (dipotong sebagian)",
        category: "DEDUCTION",
        calc_type: "KASBON",
        rate: 0,
        nominal: 100_000,
      },
    ]);
  });
});

describe("susunJurnalPayroll", () => {
  test("seimbang, potongan komponen adalah selisihnya", () => {
    expect(
      susunJurnalPayroll(
        [
          {
            gross: 5_000_000,
            net: 4_000_000,
            pph21: 150_000,
            bpjs_karyawan: 200_000,
            bpjs_perusahaan: 300_000,
            kasbon: 500_000,
          },
          {
            gross: 3_000_000,
            net: 2_800_000,
            pph21: 0,
            bpjs_karyawan: 100_000,
            bpjs_perusahaan: 150_000,
            kasbon: 0,
          },
        ],
        "akun-bank",
      ),
    ).toEqual([
      { id_akun: "akun-beban-gaji", debit: 8_000_000, kredit: 0 },
      { id_akun: "akun-beban-bpjs", debit: 450_000, kredit: 0 },
      { id_akun: "akun-bank", debit: 0, kredit: 6_800_000 },
      { id_akun: "akun-utang-pph21", debit: 0, kredit: 150_000 },
      { id_akun: "akun-utang-bpjs", debit: 0, kredit: 750_000 },
      { id_akun: "akun-piutang-karyawan", debit: 0, kredit: 500_000 },
      { id_akun: "akun-potongan-gaji", debit: 0, kredit: 250_000 },
    ]);
  });

  test("selisih negatif menjadi debit, baris nol dibuang", () => {
    expect(
      susunJurnalPayroll(
        [
          {
            gross: 100,
            net: 0,
            pph21: 0,
            bpjs_karyawan: 150,
            bpjs_perusahaan: 0,
            kasbon: 0,
          },
        ],
        "akun-kas",
      ),
    ).toEqual([
      { id_akun: "akun-beban-gaji", debit: 100, kredit: 0 },
      { id_akun: "akun-utang-bpjs", debit: 0, kredit: 150 },
      { id_akun: "akun-potongan-gaji", debit: 50, kredit: 0 },
    ]);
  });
});
