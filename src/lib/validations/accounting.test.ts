import { describe, expect, test } from "bun:test";
import {
  AKUN_BAWAAN,
  AKUN_SISTEM_IDS,
  type AkunValid,
  aturanUbahAkun,
  formatNomorJurnal,
  formatRupiah,
  type JurnalDraft,
  jurnalDraftSchema,
  kolomNeracaSaldo,
  saldoAkun,
  saldoBerjalan,
  saldoNormalBawaan,
  susunAktivitas,
  susunArusKas,
  susunPembalik,
  susunPosisiKeuangan,
  validateAkun,
  validateJurnal,
} from "./accounting";

// Vektor kembar `mod tests` di `src-tauri/src/desktop/accounting.rs`. Mengubah
// satu sisi tanpa sisi lain membuat Web dan Desktop menilai jurnal berbeda.

function galatJurnal(draft: JurnalDraft): string | null {
  const hasil = validateJurnal(jurnalDraftSchema.parse(draft));
  return hasil.ok ? null : hasil.error;
}

const DUA_BARIS = [
  { id_akun: "akun-beban-utilitas", debit: 1_500_000 },
  { id_akun: "akun-kas", kredit: 1_500_000 },
];

describe("format", () => {
  test("formatRupiah", () => {
    expect(formatRupiah(0)).toBe("Rp0");
    expect(formatRupiah(999)).toBe("Rp999");
    expect(formatRupiah(1500)).toBe("Rp1.500");
    expect(formatRupiah(1_000_000_000_000)).toBe("Rp1.000.000.000.000");
    expect(formatRupiah(-2500)).toBe("-Rp2.500");
  });

  test("formatNomorJurnal", () => {
    expect(formatNomorJurnal("2026", "WA3F9", 7)).toBe("JU/2026/WA3F9/0007");
    expect(formatNomorJurnal("2026", "WEB", 12345)).toBe("JU/2026/WEB/12345");
  });
});

describe("saldo", () => {
  test("saldoNormalBawaan", () => {
    expect(saldoNormalBawaan("Aset")).toBe("Debit");
    expect(saldoNormalBawaan("Beban")).toBe("Debit");
    expect(saldoNormalBawaan("Kewajiban")).toBe("Kredit");
    expect(saldoNormalBawaan("Ekuitas")).toBe("Kredit");
    expect(saldoNormalBawaan("Pendapatan")).toBe("Kredit");
  });

  test("saldoAkun dan saldoBerjalan", () => {
    expect(saldoAkun("Debit", 500, 200)).toBe(300);
    expect(saldoAkun("Kredit", 500, 200)).toBe(-300);
    expect(
      saldoBerjalan("Debit", 1000, [
        { debit: 100, kredit: 0 },
        { debit: 0, kredit: 300 },
        { debit: 50, kredit: 0 },
      ]),
    ).toEqual([1100, 800, 850]);
    expect(
      saldoBerjalan("Kredit", 0, [
        { debit: 0, kredit: 500 },
        { debit: 200, kredit: 0 },
      ]),
    ).toEqual([500, 300]);
  });

  test("kolomNeracaSaldo", () => {
    expect(kolomNeracaSaldo(700, 200)).toEqual({ debit: 500, kredit: 0 });
    expect(kolomNeracaSaldo(200, 700)).toEqual({ debit: 0, kredit: 500 });
    expect(kolomNeracaSaldo(300, 300)).toEqual({ debit: 0, kredit: 0 });
  });
});

describe("bagan akun bawaan", () => {
  test("24 akun, akun sistem ditandai, saldo normal sesuai kelompok", () => {
    expect(AKUN_BAWAAN.length).toBe(24);
    expect(AKUN_SISTEM_IDS.has("akun-kas")).toBe(true);
    expect(AKUN_SISTEM_IDS.has("akun-peralatan")).toBe(false);
    expect(AKUN_SISTEM_IDS.size).toBe(8);
    for (const akun of AKUN_BAWAAN) {
      expect(akun.saldo_normal).toBe(saldoNormalBawaan(akun.kelompok));
    }
    const ids = new Set(AKUN_BAWAAN.map((akun) => akun.id_akun));
    const kode = new Set(AKUN_BAWAAN.map((akun) => akun.kode));
    expect(ids.size).toBe(AKUN_BAWAAN.length);
    expect(kode.size).toBe(AKUN_BAWAAN.length);
  });
});

describe("validateAkun", () => {
  const sah = {
    kode: " 5-1700 ",
    nama: " Beban Transport ",
    kelompok: "Beban",
    saldo_normal: "Debit",
  };

  test("draft sah dirapikan", () => {
    const hasil = validateAkun({ ...sah, is_aktif: true });
    expect(hasil).toEqual({
      ok: true,
      value: {
        kode: "5-1700",
        nama: "Beban Transport",
        kelompok: "Beban",
        saldo_normal: "Debit",
        is_aktif: true,
      },
    });
  });

  test("penolakan", () => {
    const galat = (ubah: Partial<typeof sah>) => {
      const hasil = validateAkun({ ...sah, ...ubah, is_aktif: true });
      return hasil.ok ? null : hasil.error;
    };
    expect(galat({ kode: "  " })).toBe("Kode akun wajib diisi.");
    expect(galat({ kode: "1".repeat(21) })).toBe(
      "Kode akun maksimal 20 karakter.",
    );
    expect(galat({ nama: "" })).toBe("Nama akun wajib diisi.");
    expect(galat({ nama: "n".repeat(81) })).toBe(
      "Nama akun maksimal 80 karakter.",
    );
    expect(galat({ kelompok: "Aset Neto" })).toBe(
      "Kelompok akun tidak dikenal.",
    );
    expect(galat({ saldo_normal: "debit" })).toBe(
      "Saldo normal harus Debit atau Kredit.",
    );
  });
});

describe("aturanUbahAkun", () => {
  const baru = (ubah: Partial<AkunValid>): AkunValid => ({
    kode: "1-1100",
    nama: "Kas Kecil",
    kelompok: "Aset",
    saldo_normal: "Debit",
    is_aktif: true,
    ...ubah,
  });
  const galat = (
    lama: { sistem: boolean; punya_jurnal: boolean },
    ubah: Partial<AkunValid>,
  ) => {
    const hasil = aturanUbahAkun(
      { kelompok: "Aset", saldo_normal: "Debit", ...lama },
      baru(ubah),
    );
    return hasil.ok ? null : hasil.error;
  };

  test("akun sistem hanya boleh diganti nama", () => {
    const sistem = { sistem: true, punya_jurnal: false };
    expect(galat(sistem, {})).toBeNull();
    expect(galat(sistem, { kelompok: "Beban" })).toBe(
      "Kelompok dan saldo normal akun sistem tidak bisa diubah.",
    );
    expect(galat(sistem, { is_aktif: false })).toBe(
      "Akun sistem tidak bisa dinonaktifkan.",
    );
  });

  test("akun yang sudah dipakai jurnal terkunci strukturnya", () => {
    const dipakai = { sistem: false, punya_jurnal: true };
    expect(galat(dipakai, { saldo_normal: "Kredit" })).toBe(
      "Kelompok dan saldo normal tidak bisa diubah setelah akun dipakai jurnal.",
    );
    expect(galat(dipakai, { is_aktif: false })).toBeNull();
    expect(
      galat({ sistem: false, punya_jurnal: false }, { kelompok: "Beban" }),
    ).toBeNull();
  });
});

describe("validateJurnal", () => {
  test("jurnal seimbang diterima", () => {
    const hasil = validateJurnal(
      jurnalDraftSchema.parse({
        tanggal: "2026-10-12",
        keterangan: " Bayar listrik ",
        baris: [{ ...DUA_BARIS[0], keterangan: "  " }, DUA_BARIS[1]],
      }),
    );
    expect(hasil).toEqual({
      ok: true,
      value: {
        tanggal: "2026-10-12",
        keterangan: "Bayar listrik",
        baris: [
          {
            id_akun: "akun-beban-utilitas",
            debit: 1_500_000,
            kredit: 0,
            keterangan: null,
          },
          {
            id_akun: "akun-kas",
            debit: 0,
            kredit: 1_500_000,
            keterangan: null,
          },
        ],
        total: 1_500_000,
      },
    });
  });

  test("penolakan", () => {
    const dasar = { tanggal: "2026-10-12", keterangan: "Bayar listrik" };
    expect(
      galatJurnal({ ...dasar, tanggal: "2026-02-30", baris: DUA_BARIS }),
    ).toBe("Tanggal jurnal tidak valid.");
    expect(galatJurnal({ ...dasar, keterangan: "  ", baris: DUA_BARIS })).toBe(
      "Keterangan jurnal wajib diisi.",
    );
    expect(
      galatJurnal({ ...dasar, keterangan: "k".repeat(201), baris: DUA_BARIS }),
    ).toBe("Keterangan jurnal maksimal 200 karakter.");
    expect(galatJurnal({ ...dasar, baris: [DUA_BARIS[0]] })).toBe(
      "Jurnal minimal dua baris.",
    );
    expect(
      galatJurnal({
        ...dasar,
        baris: Array.from({ length: 101 }, () => DUA_BARIS[0]),
      }),
    ).toBe("Jurnal maksimal 100 baris.");
    expect(
      galatJurnal({
        ...dasar,
        baris: [DUA_BARIS[0], { id_akun: " ", kredit: 1 }],
      }),
    ).toBe("Baris 2: akun wajib dipilih.");
    expect(
      galatJurnal({
        ...dasar,
        baris: [{ id_akun: "a", debit: 10.5 }, DUA_BARIS[1]],
      }),
    ).toBe("Baris 1: nominal harus rupiah bulat dan tidak negatif.");
    expect(
      galatJurnal({
        ...dasar,
        baris: [{ id_akun: "a", debit: -5 }, DUA_BARIS[1]],
      }),
    ).toBe("Baris 1: nominal harus rupiah bulat dan tidak negatif.");
    expect(
      galatJurnal({
        ...dasar,
        baris: [{ id_akun: "a", debit: 5, kredit: 5 }, DUA_BARIS[1]],
      }),
    ).toBe("Baris 1: isi debit atau kredit, salah satu saja.");
    expect(
      galatJurnal({ ...dasar, baris: [{ id_akun: "a" }, DUA_BARIS[1]] }),
    ).toBe("Baris 1: isi debit atau kredit, salah satu saja.");
    expect(
      galatJurnal({
        ...dasar,
        baris: [
          { id_akun: "a", debit: 1_000_000_000_001 },
          { id_akun: "b", kredit: 1_000_000_000_001 },
        ],
      }),
    ).toBe("Baris 1: nominal maksimal Rp1.000.000.000.000.");
    expect(
      galatJurnal({
        ...dasar,
        baris: [
          { id_akun: "a", debit: 1000, keterangan: "k".repeat(201) },
          { id_akun: "b", kredit: 1000 },
        ],
      }),
    ).toBe("Baris 1: keterangan maksimal 200 karakter.");
    expect(
      galatJurnal({
        ...dasar,
        baris: [
          { id_akun: "a", debit: 1000 },
          { id_akun: "b", kredit: 900 },
        ],
      }),
    ).toBe("Total debit Rp1.000 tidak sama dengan total kredit Rp900.");
  });
});

describe("susunPembalik", () => {
  const asal = {
    id_jurnal: "jrn-1",
    nomor: "JU/2026/WEB/0001",
    sumber: "Manual",
    baris: [
      {
        id_baris: "jb-1",
        id_akun: "akun-beban-atk",
        debit: 250_000,
        kredit: 0,
        keterangan: "Kertas",
        urutan: 1,
      },
      {
        id_baris: "jb-2",
        id_akun: "akun-kas",
        debit: 0,
        kredit: 250_000,
        keterangan: null,
        urutan: 2,
      },
    ],
  };

  test("debit dan kredit ditukar, id deterministik", () => {
    expect(susunPembalik(asal, " Salah akun ")).toEqual({
      ok: true,
      value: {
        id_jurnal: "batal-jrn-1",
        keterangan: "Pembatalan JU/2026/WEB/0001: Salah akun",
        baris: [
          {
            id_baris: "batal-jb-1",
            id_akun: "akun-beban-atk",
            debit: 0,
            kredit: 250_000,
            keterangan: "Kertas",
            urutan: 1,
          },
          {
            id_baris: "batal-jb-2",
            id_akun: "akun-kas",
            debit: 250_000,
            kredit: 0,
            keterangan: null,
            urutan: 2,
          },
        ],
      },
    });
  });

  test("penolakan", () => {
    const galat = (sumber: string, alasan: string) => {
      const hasil = susunPembalik({ ...asal, sumber }, alasan);
      return hasil.ok ? null : hasil.error;
    };
    expect(galat("Pembatalan", "x")).toBe(
      "Jurnal pembalik tidak bisa dibatalkan lagi.",
    );
    expect(galat("Payroll", "x")).toBe(
      "Jurnal dari modul Payroll dibatalkan dari modulnya.",
    );
    expect(galat("Manual", "  ")).toBe("Alasan pembatalan wajib diisi.");
    expect(galat("Manual", "a".repeat(151))).toBe(
      "Alasan pembatalan maksimal 150 karakter.",
    );
  });
});

// Vektor kembar `laporan_isak35_kembar` di `desktop/accounting.rs`.
describe("laporan keuangan perusahaan", () => {
  test("posisi keuangan, aktivitas, dan arus kas", () => {
    const a = (
      id: string,
      kelompok: string,
      saldo_normal: string,
      debit: number,
      kredit: number,
    ) => ({
      id_akun: id,
      kode: id,
      nama: id,
      kelompok,
      saldo_normal,
      debit,
      kredit,
    });
    const akun = [
      a("kas", "Aset", "Debit", 900_000, 300_000),
      a("piutang", "Aset", "Debit", 500_000, 200_000),
      a("bangunan", "Aset", "Debit", 0, 0),
      a("titipan", "Kewajiban", "Kredit", 0, 50_000),
      a("ekuitas", "Ekuitas", "Kredit", 0, 400_000),
      a("spp", "Pendapatan", "Kredit", 0, 700_000),
      a("gaji", "Beban", "Debit", 300_000, 0),
    ];
    const posisi = susunPosisiKeuangan(akun);
    expect(posisi.total_aset).toBe(900_000);
    expect(posisi.aset.length).toBe(2);
    expect(posisi.total_kewajiban).toBe(50_000);
    expect(posisi.laba_berjalan).toBe(400_000);
    expect(posisi.total_ekuitas).toBe(800_000);
    expect(posisi.selisih).toBe(50_000);

    const aktivitas = susunAktivitas(akun);
    expect(aktivitas.total_pendapatan).toBe(700_000);
    expect(aktivitas.total_beban).toBe(300_000);
    expect(aktivitas.laba_bersih).toBe(400_000);
    expect(aktivitas.beban[0]?.saldo).toBe(300_000);

    const arus = susunArusKas(100_000, [
      { sumber: "Payroll", debit: 0, kredit: 250_000 },
      { sumber: "Manual", debit: 600_000, kredit: 50_000 },
      { sumber: "Kasbon", debit: 0, kredit: 0 },
    ]);
    expect(arus.kelompok.length).toBe(2);
    // Urutan mengikuti `SUMBER_JURNAL`.
    expect(arus.kelompok[0]?.label).toBe("Jurnal umum");
    expect(arus.kelompok[0]?.bersih).toBe(550_000);
    expect(arus.kelompok[1]?.label).toBe("Pembayaran gaji");
    expect(arus.total_masuk).toBe(600_000);
    expect(arus.total_keluar).toBe(300_000);
    expect(arus.saldo_akhir).toBe(400_000);
  });
});
