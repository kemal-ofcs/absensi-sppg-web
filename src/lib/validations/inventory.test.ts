import { describe, expect, test } from "bun:test";
import {
  aksiPindaiOpname,
  angkaDariKetikan,
  angkaDariSelAngka,
  type BarangInfo,
  bacaAtribut,
  bacaLabelInventaris,
  barangDraftSchema,
  formatAngka,
  formatJumlah,
  formatKodeBarang,
  formatKodeUnit,
  type IzinInventaris,
  isAngkaKanonik,
  isiLabelInventaris,
  isValidDate,
  izinUntukAlasan,
  type JenisBeritaAcara,
  jenisBeritaAcara,
  jumlahDariKetikan,
  jumlahDariSelAngka,
  kolomDraftSchema,
  mutasiDraftSchema,
  nomorKodeBerikutnya,
  normalizeKodePrefix,
  normalizeTempat,
  opnameDraftSchema,
  parseKodePrefixes,
  rekapSumberDana,
  type StatusKedaluwarsa,
  statusKedaluwarsa,
  stokMenipis,
  susunPembatalan,
  validasiUnit,
  validasiUnitEdit,
  validateAtribut,
  validateBarang,
  validateKodePrefixes,
  validateKolom,
  validateMutasi,
  validateOpname,
} from "./inventory";

const HARI_INI = "2026-10-07";
const HABIS_PAKAI: BarangInfo = { tipe: "Habis Pakai", bisa_expired: false };
const ASET: BarangInfo = { tipe: "Aset", bisa_expired: false };
const OBAT: BarangInfo = { tipe: "Habis Pakai", bisa_expired: true };

// Vektor kembar dengan `normalize_tempat_vectors` di `inventory.rs`.
const VEKTOR_TEMPAT: [string, string][] = [
  ["  Ruang   TU ", "Ruang TU"],
  ["UKS", "UKS"],
  ["\tGudang\nUtama  ", "Gudang Utama"],
  ["   ", ""],
];

// Vektor kembar dengan `is_valid_date_vectors` di `inventory.rs`.
const VEKTOR_TANGGAL: [string, boolean][] = [
  ["2026-10-07", true],
  ["2024-02-29", true],
  ["2026-02-29", false],
  ["2026-13-01", false],
  ["2026-04-31", false],
  ["2026-1-07", false],
  ["abcd-ef-gh", false],
];

// Vektor kembar dengan `validate_mutation_vectors` di `inventory.rs`.
const VEKTOR_MUTASI: [BarangInfo, Record<string, unknown>, string | null][] = [
  [
    HABIS_PAKAI,
    {
      id_barang: "b",
      jenis: "Masuk",
      alasan: "Pengadaan",
      jumlah: 10,
      tempat_tujuan: "Gudang",
    },
    null,
  ],
  [
    HABIS_PAKAI,
    {
      id_barang: "b",
      jenis: "Hapus",
      alasan: "Pengadaan",
      jumlah: 10,
      tempat_tujuan: "Gudang",
    },
    "Jenis mutasi tidak dikenal.",
  ],
  [
    HABIS_PAKAI,
    {
      id_barang: "b",
      jenis: "Masuk",
      alasan: "Pemakaian",
      jumlah: 10,
      tempat_tujuan: "Gudang",
    },
    "Alasan tidak berlaku untuk jenis mutasi ini.",
  ],
  [
    HABIS_PAKAI,
    {
      id_barang: "b",
      jenis: "Masuk",
      alasan: "Pengadaan",
      jumlah: 0,
      tempat_tujuan: "Gudang",
    },
    "Jumlah harus bilangan bulat 1 sampai 1.000.000.000.",
  ],
  [
    HABIS_PAKAI,
    {
      id_barang: "b",
      jenis: "Masuk",
      alasan: "Pengadaan",
      jumlah: 1_000_000_001,
      tempat_tujuan: "Gudang",
    },
    "Jumlah harus bilangan bulat 1 sampai 1.000.000.000.",
  ],
  [
    HABIS_PAKAI,
    {
      id_barang: "b",
      jenis: "Masuk",
      alasan: "Pengadaan",
      jumlah: 1_000_000_000,
      tempat_tujuan: "Gudang",
      harga_satuan: 1_000_000_000,
    },
    null,
  ],
  [
    HABIS_PAKAI,
    {
      id_barang: "b",
      jenis: "Masuk",
      alasan: "Pengadaan",
      jumlah: 1_000_000_000,
      tempat_tujuan: "Gudang",
      harga_satuan: 1_000_000_001,
    },
    "Nilai mutasi (jumlah × harga satuan) terlalu besar.",
  ],
  [
    HABIS_PAKAI,
    {
      id_barang: "b",
      jenis: "Masuk",
      alasan: "Pengadaan",
      jumlah: 10,
      tempat_tujuan: "Gudang",
      tanggal: "2026-10-08",
    },
    "Tanggal tidak boleh melewati hari ini.",
  ],
  [
    HABIS_PAKAI,
    {
      id_barang: "b",
      jenis: "Masuk",
      alasan: "Pengadaan",
      jumlah: 10,
      tempat_tujuan: "Gudang",
      tanggal: "2026-02-30",
    },
    "Tanggal tidak valid.",
  ],
  [
    HABIS_PAKAI,
    {
      id_barang: "b",
      jenis: "Masuk",
      alasan: "Pengadaan",
      jumlah: 10,
      tempat_tujuan: "   ",
    },
    "Tempat tujuan wajib diisi.",
  ],
  [
    HABIS_PAKAI,
    {
      id_barang: "b",
      jenis: "Keluar",
      alasan: "Pemakaian",
      jumlah: 1,
      penerima_tipe: "Umum",
      keperluan: "Ujian",
    },
    "Tempat asal wajib diisi.",
  ],
  [
    HABIS_PAKAI,
    {
      id_barang: "b",
      jenis: "Keluar",
      alasan: "Pemakaian",
      jumlah: 1,
      tempat_asal: "Gudang",
      keperluan: "Ujian",
    },
    "Pilih tipe penerima.",
  ],
  [
    HABIS_PAKAI,
    {
      id_barang: "b",
      jenis: "Keluar",
      alasan: "Pemakaian",
      jumlah: 1,
      tempat_asal: "Gudang",
      penerima_tipe: "Tamu",
      keperluan: "Ujian",
    },
    "Tipe penerima tidak dikenal.",
  ],
  [
    HABIS_PAKAI,
    {
      id_barang: "b",
      jenis: "Keluar",
      alasan: "Pemakaian",
      jumlah: 1,
      tempat_asal: "Gudang",
      penerima_tipe: "Personil",
      keperluan: "Ujian",
    },
    "Pilih penerima.",
  ],
  [
    HABIS_PAKAI,
    {
      id_barang: "b",
      jenis: "Keluar",
      alasan: "Pemakaian",
      jumlah: 1,
      tempat_asal: "Gudang",
      penerima_tipe: "Unit",
      keperluan: "Ujian",
    },
    "Nama unit penerima wajib diisi.",
  ],
  [
    HABIS_PAKAI,
    {
      id_barang: "b",
      jenis: "Keluar",
      alasan: "Pemakaian",
      jumlah: 1,
      tempat_asal: "Gudang",
      penerima_tipe: "Divisi",
      keperluan: "Rapat",
    },
    "Pilih divisi penerima.",
  ],
  [
    HABIS_PAKAI,
    {
      id_barang: "b",
      jenis: "Keluar",
      alasan: "Pemakaian",
      jumlah: 1,
      tempat_asal: "Gudang",
      penerima_tipe: "Umum",
      keperluan: "  ",
    },
    "Keperluan wajib diisi.",
  ],
  [
    HABIS_PAKAI,
    {
      id_barang: "b",
      jenis: "Keluar",
      alasan: "Pemakaian",
      jumlah: 1,
      tempat_asal: "Gudang",
      penerima_tipe: "Umum",
      keperluan: "Ujian",
    },
    null,
  ],
  [
    ASET,
    {
      id_barang: "b",
      jenis: "Pindah",
      alasan: "Distribusi",
      jumlah: 1,
      tempat_asal: "Gudang",
      tempat_tujuan: "gudang",
    },
    "Tempat atau kondisi tujuan harus berbeda dari asal.",
  ],
  [
    ASET,
    {
      id_barang: "b",
      jenis: "Pindah",
      alasan: "Perubahan Kondisi",
      jumlah: 1,
      tempat_asal: "Gudang",
      tempat_tujuan: "gudang",
      kondisi_tujuan: "Rusak Ringan",
    },
    null,
  ],
  [
    ASET,
    {
      id_barang: "b",
      jenis: "Masuk",
      alasan: "Hibah",
      jumlah: 1,
      tempat_tujuan: "Gudang",
      kondisi_tujuan: "Patah",
    },
    "Kondisi barang tidak dikenal.",
  ],
  [
    OBAT,
    {
      id_barang: "b",
      jenis: "Masuk",
      alasan: "Pengadaan",
      jumlah: 5,
      tempat_tujuan: "UKS",
    },
    "Tanggal kedaluwarsa wajib diisi untuk barang ini.",
  ],
  [
    OBAT,
    {
      id_barang: "b",
      jenis: "Masuk",
      alasan: "Pengadaan",
      jumlah: 5,
      tempat_tujuan: "UKS",
      tanggal_expired: "2027-15-01",
    },
    "Tanggal kedaluwarsa tidak valid.",
  ],
  [
    OBAT,
    {
      id_barang: "b",
      jenis: "Pindah",
      alasan: "Distribusi",
      jumlah: 5,
      tempat_asal: "Gudang",
      tempat_tujuan: "UKS",
    },
    "Pilih batch barang yang dikeluarkan.",
  ],
  [
    HABIS_PAKAI,
    {
      id_barang: "b",
      jenis: "Masuk",
      alasan: "Pengadaan",
      jumlah: 1,
      tempat_tujuan: "Gudang",
      harga_satuan: -5,
    },
    "Harga satuan tidak valid.",
  ],
];

// Vektor kembar dengan `validate_barang_vectors` di `inventory.rs`.
const VEKTOR_BARANG: [Record<string, unknown>, string | null][] = [
  [{ nama_barang: "Spidol", tipe: "Habis Pakai", satuan: "pcs" }, null],
  [
    { nama_barang: "  ", tipe: "Habis Pakai", satuan: "pcs" },
    "Nama barang wajib diisi.",
  ],
  [
    { nama_barang: "Spidol", tipe: "Medis", satuan: "pcs" },
    "Tipe barang tidak dikenal.",
  ],
  [{ nama_barang: "Spidol", tipe: "Aset", satuan: "" }, "Satuan wajib diisi."],
  [
    { nama_barang: "Spidol", tipe: "Aset", satuan: "pcs", stok_minimum: -1 },
    "Stok minimum tidak valid.",
  ],
  [
    {
      nama_barang: "Spidol",
      tipe: "Aset",
      satuan: "pcs",
      kode_barang: "K".repeat(31),
    },
    "Kode barang maksimal 30 karakter.",
  ],
  [
    { nama_barang: "Beras", tipe: "Habis Pakai", satuan: "kg", desimal: true },
    null,
  ],
  [
    { nama_barang: "Laptop", tipe: "Aset", satuan: "unit", desimal: true },
    "Jumlah desimal hanya untuk barang Habis Pakai.",
  ],
];

describe("aturan inventaris (vektor kembar inventory.rs)", () => {
  test("normalizeTempat", () => {
    for (const [input, expected] of VEKTOR_TEMPAT) {
      expect(normalizeTempat(input)).toBe(expected);
    }
  });

  test("isValidDate", () => {
    for (const [input, expected] of VEKTOR_TANGGAL) {
      expect(isValidDate(input)).toBe(expected);
    }
  });

  test("validateMutasi", () => {
    for (const [barang, raw, expected] of VEKTOR_MUTASI) {
      const result = validateMutasi(
        mutasiDraftSchema.parse(raw),
        barang,
        HARI_INI,
      );
      if (expected === null) {
        expect(result.ok).toBe(true);
      } else {
        expect(result).toEqual({ ok: false, error: expected });
      }
    }
  });

  test("field yang tidak relevan dinormalkan", () => {
    const result = validateMutasi(
      mutasiDraftSchema.parse({
        id_barang: "b",
        jenis: "Masuk",
        alasan: "Pengadaan",
        jumlah: 3,
        tempat_asal: "Gudang",
        tempat_tujuan: "  Ruang   TU ",
        kondisi_tujuan: "Rusak Berat",
        id_batch: "x",
        tanggal_expired: "2027-01-01",
        penerima_tipe: "Umum",
      }),
      HABIS_PAKAI,
      HARI_INI,
    );
    if (!result.ok) throw new Error(result.error);
    expect(result.value.tanggal).toBe(HARI_INI);
    expect(result.value.tempat_asal).toBeNull();
    expect(result.value.tempat_tujuan).toBe("Ruang TU");
    expect(result.value.kondisi_tujuan).toBe("Baik");
    expect(result.value.id_batch).toBeNull();
    expect(result.value.tanggal_expired).toBeNull();
    expect(result.value.penerima_tipe).toBeNull();
  });

  test("validateBarang", () => {
    for (const [raw, expected] of VEKTOR_BARANG) {
      const result = validateBarang(barangDraftSchema.parse(raw));
      if (expected === null) {
        expect(result.ok).toBe(true);
      } else {
        expect(result).toEqual({ ok: false, error: expected });
      }
    }
  });

  test("draft menolak kunci asing seperti dicatat_oleh", () => {
    const parsed = mutasiDraftSchema.safeParse({
      id_barang: "b",
      jenis: "Masuk",
      alasan: "Pengadaan",
      jumlah: 1,
      tempat_tujuan: "Gudang",
      dicatat_oleh: "orang-lain",
    });
    expect(parsed.success).toBe(false);
  });

  // Vektor kembar dengan `build_cancellation_swaps_sides` di `inventory.rs`.
  test("susunPembatalan", () => {
    const asal = {
      id_mutasi: "mts-1",
      jenis: "Pindah",
      alasan: "Distribusi",
      jumlah: 30,
      tempat_asal: "Gudang",
      kondisi_asal: "Baik",
      tempat_tujuan: "Kelas X",
      kondisi_tujuan: "Baik",
      id_batch: null,
    };
    const kebalikan = susunPembatalan(asal);
    if (!kebalikan.ok) throw new Error(kebalikan.error);
    expect(kebalikan.value.id_mutasi).toBe("batal-mts-1");
    expect(kebalikan.value.jenis).toBe("Pindah");
    expect(kebalikan.value.alasan).toBe("Pembatalan");
    expect(kebalikan.value.tempat_asal).toBe("Kelas X");
    expect(kebalikan.value.tempat_tujuan).toBe("Gudang");

    const masuk = susunPembatalan({
      ...asal,
      jenis: "Masuk",
      alasan: "Pengadaan",
      tempat_asal: null,
      kondisi_asal: null,
    });
    expect(masuk.ok && masuk.value.jenis).toBe("Keluar");
    expect(susunPembatalan({ ...asal, alasan: "Pembatalan" })).toEqual({
      ok: false,
      error: "Pembatalan tidak bisa dibatalkan lagi.",
    });
  });

  // Vektor kembar dengan `kode_prefix_vectors` di `inventory.rs`.
  test("awalan kode", () => {
    const vektor: [string, string | null][] = [
      ["uks", "UKS"],
      [" Lab1 ", "LAB1"],
      ["ABCDEFG", null],
      ["", null],
      ["U-K", null],
      ["ÜKS", null],
    ];
    for (const [input, expected] of vektor) {
      expect(normalizeKodePrefix(input)).toBe(expected);
    }
    expect(parseKodePrefixes(null)).toEqual(["BRG"]);
    expect(parseKodePrefixes("bukan json")).toEqual(["BRG"]);
    expect(parseKodePrefixes('["uks","UKS","x-y","lab"]')).toEqual([
      "UKS",
      "LAB",
    ]);
    expect(validateKodePrefixes(["brg", "uks"])).toEqual({
      ok: true,
      value: ["BRG", "UKS"],
    });
    expect(validateKodePrefixes([])).toEqual({
      ok: false,
      error: "Daftarkan minimal satu awalan kode.",
    });
    expect(validateKodePrefixes(["UKS", "uks"])).toEqual({
      ok: false,
      error: 'Awalan "UKS" terdaftar dua kali.',
    });
    expect(validateKodePrefixes(["U K"])).toEqual({
      ok: false,
      error: 'Awalan "U K" tidak valid. Gunakan 1 sampai 6 huruf atau angka.',
    });
  });

  // Vektor kembar dengan `next_kode_number_vectors` di `inventory.rs`.
  test("nomor urut kode", () => {
    expect(nomorKodeBerikutnya("UKS", [])).toBe(1);
    expect(
      nomorKodeBerikutnya("UKS", [
        "UKS-0001",
        "uks-0009",
        "UKS-LEMARI",
        "UKSX-0050",
        "BRG-0100",
      ]),
    ).toBe(10);
    expect(nomorKodeBerikutnya("LAB", ["LAB-12345"])).toBe(12346);
    expect(formatKodeBarang("UKS", 7)).toBe("UKS-0007");
    expect(formatKodeBarang("UKS", 12345)).toBe("UKS-12345");
  });

  // Vektor kembar dengan `phase_two_rule_vectors` di `inventory.rs`.
  test("aturan Fase 2", () => {
    const izin: [string, IzinInventaris][] = [
      ["Pemakaian", "inventory.record"],
      ["Peminjaman", "inventory.record"],
      ["Pengembalian", "inventory.record"],
      ["Rusak/Afkir", "inventory.adjust"],
      ["Hilang", "inventory.adjust"],
      ["Kedaluwarsa", "inventory.adjust"],
      ["Selisih Opname", "inventory.adjust"],
      ["Pembatalan", "inventory.adjust"],
      ["", "inventory.record"],
    ];
    for (const [alasan, hasil] of izin)
      expect(izinUntukAlasan(alasan)).toBe(hasil);
    const status: [number, StatusKedaluwarsa][] = [
      [-1, "Kedaluwarsa"],
      [0, "Waspada"],
      [30, "Waspada"],
      [31, "Aman"],
    ];
    for (const [sisa, hasil] of status)
      expect(statusKedaluwarsa(sisa)).toBe(hasil);
    expect(stokMenipis(4, 5)).toBe(true);
    expect(stokMenipis(5, 5)).toBe(false);
    expect(stokMenipis(0, 0)).toBe(false);

    const kasus: [BarangInfo, Record<string, unknown>, string | null][] = [
      [
        HABIS_PAKAI,
        {
          id_barang: "b",
          jenis: "Masuk",
          alasan: "Pengembalian",
          jumlah: 1,
          tempat_tujuan: "Gudang",
        },
        "Pilih peminjaman yang dikembalikan.",
      ],
      [
        OBAT,
        {
          id_barang: "b",
          jenis: "Masuk",
          alasan: "Pengembalian",
          jumlah: 1,
          tempat_tujuan: "UKS",
          id_ref: "mts-1",
        },
        null,
      ],
      [
        OBAT,
        {
          id_barang: "b",
          jenis: "Masuk",
          alasan: "Selisih Opname",
          jumlah: 1,
          tempat_tujuan: "UKS",
        },
        "Pilih batch tujuan barang ini.",
      ],
      [
        HABIS_PAKAI,
        {
          id_barang: "b",
          jenis: "Keluar",
          alasan: "Peminjaman",
          jumlah: 1,
          tempat_asal: "Gudang",
          keperluan: "KBM",
        },
        "Pilih tipe penerima.",
      ],
      [
        ASET,
        {
          id_barang: "b",
          jenis: "Keluar",
          alasan: "Hilang",
          jumlah: 1,
          tempat_asal: "Gudang",
        },
        null,
      ],
    ];
    for (const [barang, raw, expected] of kasus) {
      const result = validateMutasi(
        mutasiDraftSchema.parse(raw),
        barang,
        HARI_INI,
      );
      if (expected === null) expect(result.ok).toBe(true);
      else expect(result).toEqual({ ok: false, error: expected });
    }
  });

  // Vektor kembar dengan `validate_opname_vectors` di `inventory.rs`.
  test("validateOpname", () => {
    const kasus: [Record<string, unknown>, string | null][] = [
      [{ tempat: " Gudang ", baris: [{ id_barang: "b", fisik: 3 }] }, null],
      [
        { tempat: "", baris: [{ id_barang: "b", fisik: 3 }] },
        "Pilih tempat yang diopname.",
      ],
      [{ tempat: "Gudang", baris: [] }, "Belum ada barang yang dihitung."],
      [
        { tempat: "Gudang", baris: [{ id_barang: " ", fisik: 3 }] },
        "Barang pada baris opname tidak valid.",
      ],
      [
        {
          tempat: "Gudang",
          baris: [{ id_barang: "b", kondisi: "Patah", fisik: 3 }],
        },
        "Kondisi barang tidak dikenal.",
      ],
      [
        { tempat: "Gudang", baris: [{ id_barang: "b", fisik: -1 }] },
        "Jumlah fisik harus 0 sampai 1.000.000.000.",
      ],
      [
        {
          tempat: "Gudang",
          baris: [
            { id_barang: "b", fisik: 1 },
            { id_barang: "b", kondisi: "Baik", fisik: 2 },
          ],
        },
        "Barang yang sama tercatat dua kali dalam opname ini.",
      ],
    ];
    for (const [raw, expected] of kasus) {
      const result = validateOpname(opnameDraftSchema.parse(raw));
      if (expected === null) expect(result.ok).toBe(true);
      else expect(result).toEqual({ ok: false, error: expected });
    }
  });

  // Vektor kembar dengan `phase_three_rule_vectors` di `inventory.rs`.
  test("aturan Fase 3", () => {
    const jenis: [string, JenisBeritaAcara | null][] = [
      ["Pemakaian", "Serah Terima"],
      ["Peminjaman", "Serah Terima"],
      ["Distribusi", "Serah Terima"],
      ["Kedaluwarsa", "Pemusnahan"],
      ["Rusak/Afkir", "Pemusnahan"],
      ["Hilang", "Pemusnahan"],
      ["Selisih Opname", "Opname"],
      ["Pengadaan", null],
      ["Pembatalan", null],
    ];
    for (const [alasan, hasil] of jenis)
      expect(jenisBeritaAcara(alasan)).toBe(hasil);
    expect(
      rekapSumberDana([
        { sumber_dana: "BOSP Reguler", nilai: 50_000, tanpa_harga: false },
        { sumber_dana: "", nilai: 0, tanpa_harga: true },
        { sumber_dana: "BOSP Reguler", nilai: 25_000, tanpa_harga: false },
        { sumber_dana: "  ", nilai: 10_000, tanpa_harga: false },
        { sumber_dana: "Komite", nilai: 0, tanpa_harga: true },
      ]),
    ).toEqual([
      { sumber_dana: "BOSP Reguler", baris: 2, nilai: 75_000, tanpa_harga: 0 },
      {
        sumber_dana: "Tanpa sumber dana",
        baris: 2,
        nilai: 10_000,
        tanpa_harga: 1,
      },
      { sumber_dana: "Komite", baris: 1, nilai: 0, tanpa_harga: 1 },
    ]);
  });
});

// Hanya UI yang membaca label, jadi aturan ini tidak punya cermin Rust.
describe("label QR inventaris", () => {
  const barang = [
    { id_barang: "brg-a", kode_barang: "BRG-0001" },
    { id_barang: "brg-b", kode_barang: "UKS-0001" },
    { id_barang: "brg-c", kode_barang: "UKS-0001" },
  ];

  test("isi label tanpa karakter | yang dibaca scanner absensi", () => {
    expect(isiLabelInventaris("brg-a")).toBe("INV:brg-a");
    expect(isiLabelInventaris("brg-a")).not.toContain("|");
  });

  test("membaca label, kode ketikan, dan menolak yang lain", () => {
    expect(bacaLabelInventaris(" INV:brg-a ", barang)).toEqual({
      ok: true,
      value: { barang: barang[0], id_unit: null },
    });
    expect(bacaLabelInventaris("inv:brg-b", barang).ok).toBe(true);
    expect(bacaLabelInventaris("brg-0001", barang)).toEqual({
      ok: true,
      value: { barang: barang[0], id_unit: null },
    });
    const tidakDikenal = bacaLabelInventaris("INV:brg-x", barang);
    expect(tidakDikenal.ok).toBe(false);
    const kembar = bacaLabelInventaris("UKS-0001", barang);
    expect(!kembar.ok && kembar.error).toContain("lebih dari satu barang");
    const absensi = bacaLabelInventaris("sis-1|token", barang);
    expect(!absensi.ok && absensi.error).toContain("kartu absensi");
    expect(bacaLabelInventaris("  ", barang).ok).toBe(false);
  });

  test("label dan kode unit", () => {
    const laptop = {
      id_barang: "lap",
      kode_barang: "LAP-0001",
      posisi: [
        { id_batch: "mts-u1", kode_unit: "LAP-0001-01" },
        { id_batch: null, kode_unit: null },
      ],
    };
    expect(bacaLabelInventaris("INV:mts-u1", [laptop])).toEqual({
      ok: true,
      value: { barang: laptop, id_unit: "mts-u1" },
    });
    expect(bacaLabelInventaris("lap-0001-01", [laptop])).toEqual({
      ok: true,
      value: { barang: laptop, id_unit: "mts-u1" },
    });
    expect(bacaLabelInventaris("LAP-0001", [laptop])).toEqual({
      ok: true,
      value: { barang: laptop, id_unit: null },
    });
    expect(bacaLabelInventaris("INV:mts-hilang", [laptop]).ok).toBe(false);

    const aset = {
      id_barang: "lap",
      tipe: "Aset" as const,
      dilacak_unit: true,
    };
    const baris = [
      {
        kunci: "u1",
        barang: aset,
        kondisi: "Baik",
        id_batch: "mts-u1",
        fisik: "1",
        dipindai: false,
      },
    ];
    expect(aksiPindaiOpname(baris, aset, "mts-u1")).toEqual({
      jenis: "unit",
      kunci: "u1",
      sudah: false,
    });
    expect(
      aksiPindaiOpname([{ ...baris[0], dipindai: true }], aset, "mts-u1"),
    ).toEqual({
      jenis: "unit",
      kunci: "u1",
      sudah: true,
    });
    expect(aksiPindaiOpname(baris, aset, "mts-u9")).toEqual({
      jenis: "unit-lain",
    });
    expect(aksiPindaiOpname(baris, aset)).toEqual({
      jenis: "pakai-label-unit",
    });
  });

  test("aksi pindai opname", () => {
    const aset = { id_barang: "kursi", tipe: "Aset" as const };
    const obat = { id_barang: "obat", tipe: "Habis Pakai" as const };
    const baris = [
      {
        kunci: "k-rusak",
        barang: aset,
        kondisi: "Rusak Ringan",
        id_batch: null,
        fisik: "2",
        dipindai: false,
      },
      {
        kunci: "k-baik",
        barang: aset,
        kondisi: "Baik",
        id_batch: null,
        fisik: "30",
        dipindai: false,
      },
      {
        kunci: "o-1",
        barang: obat,
        kondisi: "Baik",
        id_batch: null,
        fisik: "10",
        dipindai: false,
      },
    ];
    // Pindaian pertama memulai dari 1, bukan dari saldo sistem 30.
    expect(aksiPindaiOpname(baris, aset)).toEqual({
      jenis: "hitung",
      kunci: "k-baik",
      fisik: 1,
    });
    const sudah = baris.map((b) =>
      b.kunci === "k-baik" ? { ...b, fisik: "7", dipindai: true } : b,
    );
    expect(aksiPindaiOpname(sudah, aset)).toEqual({
      jenis: "hitung",
      kunci: "k-baik",
      fisik: 8,
    });
    expect(aksiPindaiOpname(baris, obat)).toEqual({
      jenis: "fokus",
      kunci: "o-1",
    });
    expect(aksiPindaiOpname(baris.slice(0, 1), aset)).toEqual({
      jenis: "baru",
    });
    expect(
      aksiPindaiOpname(baris, { id_barang: "meja", tipe: "Aset" }),
    ).toEqual({ jenis: "baru" });
  });
});

// Vektor kembar dengan `unit_rule_vectors` dan
// `registration_rows_cannot_be_cancelled` di `inventory.rs`.
describe("registri aset per unit", () => {
  const cek = (
    dilacak: boolean,
    per_unit: boolean,
    tipe: string,
    bisa_expired: boolean,
    jenis: string,
    alasan: string,
    jumlah: number,
    unit: string[] = [],
  ) =>
    validasiUnit({
      dilacak,
      per_unit,
      tipe,
      bisa_expired,
      jenis,
      alasan,
      jumlah,
      unit,
    });
  const galat = (error: string) => ({ ok: false as const, error });
  const lingkup =
    "Pencatatan per unit hanya untuk aset tanpa kedaluwarsa yang dicatat masuk.";

  test("aturan unit", () => {
    expect(cek(false, false, "Aset", false, "Keluar", "Pemakaian", 1)).toEqual({
      ok: true,
      value: [],
    });
    expect(
      cek(false, false, "Aset", false, "Keluar", "Pemakaian", 1, ["u1"]),
    ).toEqual(galat("Barang ini tidak dicatat per unit."));
    expect(
      cek(false, true, "Habis Pakai", false, "Masuk", "Pengadaan", 1),
    ).toEqual(galat(lingkup));
    expect(cek(false, true, "Aset", true, "Masuk", "Pengadaan", 1)).toEqual(
      galat(lingkup),
    );
    expect(cek(false, true, "Aset", false, "Keluar", "Pemakaian", 1)).toEqual(
      galat(lingkup),
    );
    expect(cek(false, true, "Aset", false, "Masuk", "Pengadaan", 3)).toEqual({
      ok: true,
      value: [],
    });
    expect(cek(true, false, "Aset", false, "Masuk", "Pengadaan", 201)).toEqual(
      galat("Paling banyak 200 unit sekali catat."),
    );
    expect(
      cek(true, false, "Aset", false, "Masuk", "Pengadaan", 1, ["u1"]),
    ).toEqual(galat("Unit baru dibuat otomatis saat barang masuk."));
    expect(cek(true, false, "Aset", false, "Masuk", "Pengembalian", 1)).toEqual(
      { ok: true, value: [] },
    );
    expect(cek(true, false, "Aset", false, "Keluar", "Peminjaman", 1)).toEqual(
      galat("Pilih unit yang dicatat."),
    );
    expect(
      cek(true, false, "Aset", false, "Pindah", "Distribusi", 2, [
        "u1",
        " u1 ",
      ]),
    ).toEqual(galat("Unit yang sama dipilih dua kali."));
    expect(
      cek(true, false, "Aset", false, "Keluar", "Hilang", 3, ["u1", "u2"]),
    ).toEqual(galat("Jumlah harus sama dengan banyaknya unit yang dipilih."));
    expect(
      cek(true, false, "Aset", false, "Keluar", "Hilang", 2, [
        " u1",
        "u2 ",
        "",
      ]),
    ).toEqual({
      ok: true,
      value: ["u1", "u2"],
    });

    expect(formatKodeUnit("LAP-0003", 2)).toBe("LAP-0003-02");
    expect(formatKodeUnit("LAP-0003", 120)).toBe("LAP-0003-120");

    const edit = (nomor_seri: string | null, catatan: string | null) =>
      validasiUnitEdit({ id_unit: "u1", nomor_seri, catatan });
    expect(edit("  SN-01 ", " ")).toEqual({
      ok: true,
      value: { nomor_seri: "SN-01", catatan: null },
    });
    expect(edit("x".repeat(61), null)).toEqual(
      galat("Nomor seri maksimal 60 karakter."),
    );
    expect(edit(null, "x".repeat(201))).toEqual(
      galat("Catatan unit maksimal 200 karakter."),
    );
  });

  test("baris pendaftaran unit tidak bisa dibatalkan", () => {
    const asal = (jenis: string) => ({
      id_mutasi: "m1",
      jenis,
      alasan: "Distribusi",
      jumlah: 1,
      tempat_asal: null,
      kondisi_asal: null,
      tempat_tujuan: null,
      kondisi_tujuan: null,
      id_batch: null,
    });
    expect(susunPembatalan(asal("Keluar"))).toEqual(
      galat("Pendaftaran unit tidak bisa dibatalkan."),
    );
    expect(susunPembatalan(asal("Masuk"))).toEqual(
      galat("Pendaftaran unit tidak bisa dibatalkan."),
    );
    expect(susunPembatalan(asal("Pindah")).ok).toBe(true);
  });
});

// Vektor kembar dengan `kolom_tambahan_vectors` di `inventory.rs`.
const VEKTOR_KOLOM: [Record<string, unknown>, string | null][] = [
  [{ nama: "  Merek   Barang ", tipe: "Teks" }, null],
  [{ nama: "Berat", tipe: "Angka", is_aktif: false }, null],
  [{ nama: "   ", tipe: "Teks" }, "Nama kolom wajib diisi."],
  [{ nama: "M".repeat(41), tipe: "Teks" }, "Nama kolom maksimal 40 karakter."],
  [
    { nama: "nama BARANG", tipe: "Teks" },
    "Nama kolom sudah dipakai kolom bawaan.",
  ],
  [{ nama: "Saldo", tipe: "Angka" }, "Nama kolom sudah dipakai kolom bawaan."],
  [{ nama: "Warna", tipe: "Tanggal" }, "Tipe kolom tidak dikenal."],
];

const VEKTOR_ANGKA: [string, boolean][] = [
  ["0", true],
  ["7", true],
  ["1250.5", true],
  ["0.0001", true],
  ["999999999999", true],
  ["1000000000000", false],
  ["007", false],
  ["2.50", false],
  ["0.00001", false],
  ["1.", false],
  [".5", false],
  ["-1", false],
  ["1,5", false],
  ["", false],
];

const KOLOM_UJI = [
  { id_kolom: "kol-a1", nama: "Merek", tipe: "Teks" as const },
  { id_kolom: "kol-b2", nama: "Berat", tipe: "Angka" as const },
  { id_kolom: "kol-c3", nama: "Warna", tipe: "Angka" as const, dihapus: true },
];

const VEKTOR_ATRIBUT: [
  Record<string, string>,
  Record<string, string> | string,
][] = [
  [
    { "kol-b2": "2.5", "kol-a1": "  Pilot ", "kol-ff": "dari perangkat lain" },
    { "kol-a1": "Pilot", "kol-b2": "2.5", "kol-ff": "dari perangkat lain" },
  ],
  [{ "kol-a1": "   " }, {}],
  // Kolom yang dihapus: isinya dibuang, tidak divalidasi.
  [{ "kol-a1": "Pilot", "kol-c3": "bukan angka" }, { "kol-a1": "Pilot" }],
  [{ "kol-b2": "2,5" }, "Isi kolom Berat harus angka."],
  [{ "kol-a1": "x".repeat(201) }, "Isi kolom Merek maksimal 200 karakter."],
  [{ "kol-ff": "x".repeat(201) }, "Isi kolom tambahan maksimal 200 karakter."],
  [{ merek: "Pilot" }, "Kolom tambahan tidak valid."],
];

describe("kolom tambahan (vektor kembar inventory.rs)", () => {
  test("validateKolom", () => {
    for (const [raw, expected] of VEKTOR_KOLOM) {
      const result = validateKolom(kolomDraftSchema.parse(raw));
      if (expected === null) {
        expect(result.ok).toBe(true);
      } else {
        expect(result).toEqual({ ok: false, error: expected });
      }
    }
    expect(
      validateKolom(
        kolomDraftSchema.parse({ nama: " Merek   Barang ", tipe: "Teks" }),
      ),
    ).toEqual({
      ok: true,
      value: { nama: "Merek Barang", tipe: "Teks", is_aktif: true },
    });
  });

  test("isAngkaKanonik", () => {
    for (const [value, expected] of VEKTOR_ANGKA) {
      expect(isAngkaKanonik(value)).toBe(expected);
    }
  });

  test("validateAtribut", () => {
    for (const [raw, expected] of VEKTOR_ATRIBUT) {
      const result = validateAtribut(raw, KOLOM_UJI);
      if (typeof expected === "string") {
        expect(result).toEqual({ ok: false, error: expected });
      } else {
        expect(result).toEqual({ ok: true, value: expected });
      }
    }
    const banyak = Object.fromEntries(
      Array.from({ length: 101 }, (_, i) => [`kol-${i.toString(16)}`, "x"]),
    );
    expect(validateAtribut(banyak, [])).toEqual({
      ok: false,
      error: "Kolom tambahan terlalu banyak.",
    });
  });
});

describe("angka kolom tambahan", () => {
  test("ketikan berformat Indonesia", () => {
    const vektor: [string, string | null][] = [
      ["2,5", "2.5"],
      ["1.000", "1000"],
      ["1.250,75", "1250.75"],
      [" 12 ", "12"],
      ["0,50", "0.5"],
      ["2.5", null],
      ["1.00", null],
      ["1,2,3", null],
      ["1,23456", null],
      ["-3", null],
      ["abc", null],
    ];
    for (const [raw, expected] of vektor) {
      expect(angkaDariKetikan(raw)).toBe(expected);
    }
  });

  test("sel Angka Excel bertitik desimal", () => {
    expect(angkaDariSelAngka("1.234")).toBe("1.234");
    expect(angkaDariSelAngka("1000")).toBe("1000");
    expect(angkaDariSelAngka("0.30000000000000004")).toBe("0.3");
    expect(angkaDariSelAngka("1E-3")).toBe("0.001");
    expect(angkaDariSelAngka("-1")).toBeNull();
  });

  test("formatAngka dan bacaAtribut", () => {
    expect(formatAngka("1250.5")).toBe("1.250,5");
    expect(formatAngka("1234567")).toBe("1.234.567");
    expect(formatAngka("12")).toBe("12");
    expect(bacaAtribut('{"kol-a":"x","kol-b":3}')).toEqual({ "kol-a": "x" });
    expect(bacaAtribut("bukan json")).toEqual({});
    expect(bacaAtribut(null)).toEqual({});
  });
});

describe("jumlah desimal per barang", () => {
  test("ketikan berformat Indonesia menjadi jumlah tersimpan", () => {
    const vektor: [string, boolean, number | null][] = [
      ["250", true, 25000],
      ["254", true, 25400],
      ["254,5", true, 25450],
      ["10,25", true, 1025],
      ["0,05", true, 5],
      ["1.350.000", true, 135000000],
      ["1.350.000,75", true, 135000075],
      [" 7 ", true, 700],
      ["10,255", true, null],
      ["10.25", true, null],
      ["1.0000", true, null],
      ["-1", true, null],
      ["", true, null],
      ["254", false, 254],
      ["10.000", false, 10000],
      ["10.000,00", false, 10000],
      ["15,0", false, 15],
      ["10,22", false, null],
    ];
    for (const [teks, desimal, expected] of vektor) {
      expect([teks, jumlahDariKetikan(teks, desimal)]).toEqual([
        teks,
        expected,
      ]);
    }
  });

  test("sel Angka Excel: titik desimal, sisa pembulatan dirapikan", () => {
    expect(jumlahDariSelAngka("10.25", true)).toBe(1025);
    expect(jumlahDariSelAngka("10.250000000000002", true)).toBe(1025);
    expect(jumlahDariSelAngka("1350000", true)).toBe(135000000);
    expect(jumlahDariSelAngka("10.255", true)).toBeNull();
    expect(jumlahDariSelAngka("10.5", false)).toBeNull();
    expect(jumlahDariSelAngka("10500", false)).toBe(10500);
  });

  test("formatJumlah bisa diketik ulang apa adanya", () => {
    const vektor: [number, boolean, string][] = [
      [25000, true, "250"],
      [25450, true, "254,50"],
      [1025, true, "10,25"],
      [5, true, "0,05"],
      [135000075, true, "1.350.000,75"],
      [-1025, true, "-10,25"],
      [1000000, false, "1.000.000"],
      [-1000, false, "-1.000"],
    ];
    for (const [nilai, desimal, teks] of vektor) {
      expect(formatJumlah(nilai, desimal)).toBe(teks);
      if (nilai >= 0) expect(jumlahDariKetikan(teks, desimal)).toBe(nilai);
    }
  });
});
