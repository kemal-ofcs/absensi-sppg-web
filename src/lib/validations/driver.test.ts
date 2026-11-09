import { describe, expect, test } from "bun:test";
import {
  AKURASI_PERINGATAN_M,
  daftarTarifDraftSchema,
  detikUtc,
  formatNomorSuratJalan,
  gantiMenunggu,
  idMuatan,
  jarakMeter,
  kendaraanDraftSchema,
  type Laporan,
  laporanDraftSchema,
  lokasiDraftSchema,
  MAKS_FOTO_BASE64,
  normalisasiIdentitas,
  normalisasiPrefix,
  penerimaUpah,
  penugasan,
  periksaUrutan,
  perjalananDraftSchema,
  prefixTersimpan,
  statusPerjalanan,
  tandaTinjau,
  titikTerbuka,
  upahSuratJalan,
  validateDaftarTarif,
  validateFotoLaporan,
  validateKendaraan,
  validateKeputusan,
  validateLaporan,
  validateLokasi,
  validatePerjalanan,
} from "@/lib/validations/driver";
import type { Hasil } from "@/lib/validations/inventory";

// Vektor yang sama dengan `mod tests` di `desktop/driver.rs`.

function lap(id: string, jenis: string, waktu: string): Laporan {
  return { id_laporan: id, jenis, waktu_perangkat: waktu };
}

function galatnya<T>(hasil: Hasil<T>): string {
  if (hasil.ok) throw new Error("diharapkan galat");
  return hasil.error;
}

function nilainya<T>(hasil: Hasil<T>): T {
  if (!hasil.ok) throw new Error(hasil.error);
  return hasil.value;
}

describe("driver", () => {
  test("nomor, prefix, dan upah", () => {
    expect(formatNomorSuratJalan("KRS", "2026-11-09", "WAB12", 7)).toBe(
      "KRS-2611-WAB12-007",
    );
    expect(formatNomorSuratJalan("SJ", "2027-01-31", "WEB", 1234)).toBe(
      "SJ-2701-WEB-1234",
    );
    expect(nilainya(normalisasiPrefix(" krs- "))).toBe("KRS");
    expect(galatnya(normalisasiPrefix("-"))).toBe(
      "Awalan nomor surat jalan wajib diisi.",
    );
    expect(galatnya(normalisasiPrefix("KR S"))).toBe(
      "Awalan nomor surat jalan hanya huruf dan angka, maksimal 8 karakter.",
    );
    expect(normalisasiPrefix("ABCDEFGHI").ok).toBe(false);
    expect(prefixTersimpan("kos")).toBe("KOS");
    expect(prefixTersimpan("rusak!")).toBe("SJ");
    expect(prefixTersimpan(null)).toBe("SJ");
    expect(idMuatan("trp-1", 3)).toBe("trp-1-3");
    expect(upahSuratJalan(150_000, 200_000)).toBe(350_000);
  });

  test("status dan penugasan", () => {
    expect(statusPerjalanan([])).toBe("Direncanakan");
    expect(statusPerjalanan([lap("a", "Kendala", "2026-11-09 01:00:00")])).toBe(
      "Direncanakan",
    );
    expect(
      statusPerjalanan([lap("a", "Berangkat", "2026-11-09 01:00:00")]),
    ).toBe("Berjalan");
    expect(
      statusPerjalanan([
        lap("a", "Berangkat", "2026-11-09 01:00:00"),
        lap("b", "Selesai", "2026-11-09 05:00:00"),
        lap("c", "Dibatalkan", "2026-11-09 04:00:00"),
      ]),
    ).toBe("Dibatalkan");

    const ganti: Laporan[] = [
      {
        ...lap("g1", "Ganti Kendaraan", "2026-11-09 02:00:00"),
        mode_ganti: "Langsung",
        id_kendaraan_baru: "k2",
      },
      {
        ...lap("g2", "Ganti Driver", "2026-11-09 03:00:00"),
        mode_ganti: "Minta Izin",
        id_karyawan_baru: "d2",
      },
      {
        ...lap("g3", "Ganti Kendaraan", "2026-11-09 04:00:00"),
        mode_ganti: "Darurat",
        id_kendaraan_baru: "k3",
      },
    ];
    expect(penugasan("d1", "k1", ganti)).toEqual({
      id_karyawan: "d1",
      id_kendaraan: "k3",
    });
    expect(gantiMenunggu(ganti)).toEqual(["g2", "g3"]);

    const disetujui: Laporan[] = [
      ...ganti,
      { ...lap("s1", "Disetujui", "2026-11-09 03:30:00"), id_ref: "g2" },
      { ...lap("s2", "Ditolak", "2026-11-09 04:30:00"), id_ref: "g3" },
    ];
    expect(penugasan("d1", "k1", disetujui).id_karyawan).toBe("d2");
    // Darurat yang ditolak tetap berlaku sampai dispatcher mencatat ganti baru.
    expect(penugasan("d1", "k1", disetujui).id_kendaraan).toBe("k3");
    expect(gantiMenunggu(disetujui)).toEqual([]);
    expect(galatnya(validateKeputusan(disetujui, "g2"))).toBe(
      "Ganti ini sudah diputuskan.",
    );
    expect(galatnya(validateKeputusan(ganti, "g1"))).toBe(
      "Ganti ini tidak memerlukan persetujuan.",
    );
    expect(galatnya(validateKeputusan(ganti, "x"))).toBe(
      "Laporan ganti tidak ditemukan.",
    );
    expect(validateKeputusan(ganti, "g2").ok).toBe(true);

    const selesai: Laporan[] = [
      { ...lap("a", "Berangkat", "2026-11-09 01:00:00"), id_karyawan: "d1" },
      { ...lap("b", "Selesai", "2026-11-09 05:00:00"), id_karyawan: "d2" },
    ];
    expect(penerimaUpah("Selesai", null, selesai, "d9")).toBe("d2");
    expect(penerimaUpah("Selesai", "d5", selesai, "d9")).toBe("d5");
    expect(
      penerimaUpah(
        "Selesai",
        null,
        [lap("b", "Selesai", "2026-11-09 05:00:00")],
        "d9",
      ),
    ).toBe("d9");
    expect(penerimaUpah("Dibatalkan", "d5", selesai, "d9")).toBeNull();
  });

  test("urutan di perangkat", () => {
    const l: Laporan[] = [];
    expect(galatnya(periksaUrutan(l, "Tiba Muat"))).toBe(
      "Laporkan Berangkat lebih dulu.",
    );
    expect(galatnya(periksaUrutan(l, "Dibatalkan"))).toBe(
      "Perjalanan belum berangkat. Pakai Tidak Jalan.",
    );
    expect(periksaUrutan(l, "Tidak Jalan").ok).toBe(true);
    expect(periksaUrutan(l, "Kendala").ok).toBe(true);
    l.push(lap("a", "Berangkat", "2026-11-09 01:00:00"));
    expect(galatnya(periksaUrutan(l, "Berangkat"))).toBe(
      "Perjalanan sudah berangkat.",
    );
    expect(galatnya(periksaUrutan(l, "Tidak Jalan"))).toBe(
      "Perjalanan yang sudah berangkat tidak bisa ditandai Tidak Jalan. Pakai Dibatalkan.",
    );
    expect(galatnya(periksaUrutan(l, "Selesai Muat"))).toBe(
      "Laporkan Tiba Muat lebih dulu.",
    );
    l.push(lap("b", "Tiba Muat", "2026-11-09 02:00:00"));
    expect(titikTerbuka(l)).toBe("muat");
    expect(galatnya(periksaUrutan(l, "Tiba Bongkar"))).toBe(
      "Selesaikan dulu titik muat yang sedang terbuka.",
    );
    expect(galatnya(periksaUrutan(l, "Selesai"))).toBe(
      "Selesaikan dulu titik muat yang sedang terbuka.",
    );
    expect(galatnya(periksaUrutan(l, "Selesai Bongkar"))).toBe(
      "Laporkan Tiba Bongkar lebih dulu.",
    );
    expect(periksaUrutan(l, "Selesai Muat").ok).toBe(true);
    l.push(lap("c", "Selesai Muat", "2026-11-09 03:00:00"));
    expect(titikTerbuka(l)).toBeNull();
    expect(periksaUrutan(l, "Tiba Muat").ok).toBe(true);
    expect(periksaUrutan(l, "Selesai").ok).toBe(true);
    l.push(lap("d", "Selesai", "2026-11-09 04:00:00"));
    expect(galatnya(periksaUrutan(l, "Kendala"))).toBe(
      "Perjalanan sudah ditutup.",
    );
    expect(periksaUrutan(l, "Disetujui").ok).toBe(true);
  });

  test("waktu dan jarak", () => {
    expect(detikUtc("1970-01-01 00:00:00")).toBe(0);
    expect(detikUtc("2026-11-09 07:30:15")).toBe(1_794_209_415);
    expect(detikUtc("2024-02-29 23:59:59")).toBe(1_709_251_199);
    expect(detikUtc("2026-02-29 00:00:00")).toBeNull();
    expect(detikUtc("2026-11-09T07:30:15")).toBeNull();
    expect(detikUtc("2026-11-09 24:00:00")).toBeNull();
    // Monas → Bundaran HI ±2,2 km.
    const jarak = jarakMeter(-6.175392, 106.827153, -6.194988, 106.82305);
    expect(Math.abs(jarak - 2226)).toBeLessThan(5);
    expect(jarakMeter(-6.2, 106.8, -6.2, 106.8)).toBe(0);
  });

  test("tanda tinjau", () => {
    const titik = (
      id: string,
      jenis: string,
      waktu: string,
      lat: number,
      lng: number,
      akurasi: number,
    ): Laporan => ({
      ...lap(id, jenis, waktu),
      id_karyawan: "d1",
      foto_sha256: "f",
      lat,
      lng,
      akurasi_m: akurasi,
    });
    const laporan: Laporan[] = [
      titik("a", "Berangkat", "2026-11-09 01:00:00", -6.2, 106.8, 10),
      // Jam mundur: Selesai Muat lebih awal dari Tiba Muat-nya.
      {
        ...titik("c", "Selesai Muat", "2026-11-09 01:30:00", -6.2, 106.8, 0),
        id_lokasi: "gudang",
      },
      titik("b", "Tiba Muat", "2026-11-09 02:00:00", -6.2, 106.8, 150),
      // 2,2 km dalam 10 detik.
      titik(
        "d",
        "Tiba Bongkar",
        "2026-11-09 02:00:10",
        -6.219596,
        106.795897,
        10,
      ),
      {
        ...titik("e", "Selesai Bongkar", "2026-11-09 02:30:00", 0, 0, 5),
        diterima_cloud: "2026-11-09 02:00:00",
        foto_sha256: null,
        lat: null,
        lng: null,
      },
      titik("f", "Selesai", "2026-11-09 03:00:00", -6.219596, 106.795897, 5),
    ];
    const hasil = tandaTinjau(
      laporan,
      [{ id_lokasi: "gudang", lat: -6.21, lng: 106.8, radius_m: 200 }],
      [
        { id_muatan: "m1", qty: 10 },
        { id_muatan: "m2", qty: 5 },
      ],
      [
        { id_laporan: "c", id_muatan: "m1", qty: 10 },
        { id_laporan: "c", id_muatan: "m2", qty: 4 },
        { id_laporan: "e", id_muatan: "m1", qty: 10 },
        { id_laporan: "e", id_muatan: "m2", qty: 3 },
      ],
      AKURASI_PERINGATAN_M,
    ).map((t) => `${t.kode}:${t.id}`);
    expect(hasil).toEqual([
      "urutan_janggal:c",
      "urutan_janggal:d",
      "akurasi_nol:c",
      "luar_radius:c",
      "akurasi_buruk:b",
      "jam_maju:e",
      "tanpa_gps:e",
      "tanpa_foto:e",
      "kecepatan_mustahil:d",
      "muat_beda:m2",
      "sisa_muatan:m2",
    ]);
  });

  test("validasi laporan", () => {
    const dasar = {
      id_perjalanan: "trp-1",
      jenis: "Tiba Muat",
      nama_lokasi: " Gudang A ",
      lat: -6.2,
      lng: 106.8,
      akurasi_m: 12.5,
      waktu_perangkat: "2026-11-09 01:00:00",
    };
    const ok = nilainya(
      validateLaporan(laporanDraftSchema.parse(dasar), true, true),
    );
    expect(ok.nama_lokasi).toBe("Gudang A");
    expect(ok.mode_ganti).toBeNull();

    const galat = (
      patch: Record<string, unknown>,
      driver: boolean,
      foto: boolean,
    ) =>
      galatnya(
        validateLaporan(
          laporanDraftSchema.parse({ ...dasar, ...patch }),
          driver,
          foto,
        ),
      );
    expect(galat({ jenis: "Pulang" }, true, true)).toBe(
      "Jenis laporan tidak dikenal.",
    );
    expect(galat({ jenis: "Disetujui" }, true, true)).toBe(
      "Jenis laporan ini hanya untuk dispatcher.",
    );
    expect(galat({}, false, false)).toBe(
      "Jenis laporan ini hanya dari HP driver.",
    );
    expect(galat({ lat: null }, true, true)).toBe(
      "Lokasi GPS belum didapat. Nyalakan GPS lalu coba lagi.",
    );
    expect(galat({ lat: 91 }, true, true)).toBe("Koordinat tidak valid.");
    expect(galat({ akurasi_m: -1 }, true, true)).toBe(
      "Akurasi GPS tidak valid.",
    );
    expect(galat({ nama_lokasi: "  " }, true, true)).toBe(
      "Nama tempat wajib diisi.",
    );
    expect(galat({ waktu_perangkat: "2026-11-09" }, true, true)).toBe(
      "Waktu laporan tidak valid.",
    );
    expect(galat({}, true, false)).toBe("Ambil foto lebih dulu.");
    expect(galat({ muatan: [{ id_muatan: "m1", qty: 1 }] }, true, true)).toBe(
      "Rincian muatan hanya untuk Selesai Muat atau Selesai Bongkar.",
    );
    expect(galat({ jenis: "Selesai Muat" }, true, true)).toBe(
      "Konfirmasi jumlah barang yang dimuat.",
    );
    expect(
      galat(
        {
          jenis: "Selesai Bongkar",
          muatan: [
            { id_muatan: "m1", qty: 1 },
            { id_muatan: "m1", qty: 2 },
          ],
        },
        true,
        true,
      ),
    ).toBe("Barang yang sama tercatat dua kali.");
    expect(galat({ jenis: "Kendala" }, true, true)).toBe(
      "Pilih jenis kendala.",
    );
    expect(
      galat({ jenis: "Kendala", jenis_kendala: "Lainnya" }, true, true),
    ).toBe("Keterangan kendala wajib diisi.");
    expect(
      galat(
        { jenis: "Kendala", jenis_kendala: "Macet", terlambat_menit: 10081 },
        true,
        true,
      ),
    ).toBe("Perkiraan terlambat 0 sampai 10080 menit.");
    expect(galat({ jenis: "Ganti Driver" }, true, true)).toBe(
      "Pilih Darurat atau Minta Izin.",
    );
    expect(
      galat({ jenis: "Ganti Driver", mode_ganti: "Darurat" }, true, true),
    ).toBe("Pilih driver pengganti.");
    expect(
      galat(
        {
          jenis: "Ganti Driver",
          mode_ganti: "Darurat",
          id_karyawan_baru: "d2",
        },
        true,
        true,
      ),
    ).toBe("Alasan wajib diisi.");
    expect(galat({ jenis: "Ditolak" }, false, false)).toBe(
      "Laporan yang diputuskan wajib dipilih.",
    );
    expect(galat({ jenis: "Tidak Jalan" }, false, false)).toBe(
      "Alasan wajib diisi.",
    );

    // Dispatcher: tanpa GPS dan foto; mode ganti selalu Langsung.
    const dispatcher = nilainya(
      validateLaporan(
        laporanDraftSchema.parse({
          id_perjalanan: "trp-1",
          jenis: "Ganti Kendaraan",
          mode_ganti: "Darurat",
          id_kendaraan_baru: "k2",
          lat: -6.2,
          lng: 106.8,
          waktu_perangkat: "2026-11-09 01:00:00",
        }),
        false,
        false,
      ),
    );
    expect(dispatcher.mode_ganti).toBe("Langsung");
    expect([dispatcher.lat, dispatcher.lng]).toEqual([null, null]);

    expect(galatnya(validateFotoLaporan("image/png", "AAAA"))).toBe(
      "Foto harus JPEG.",
    );
    expect(
      galatnya(
        validateFotoLaporan("image/jpeg", "A".repeat(MAKS_FOTO_BASE64 + 4)),
      ),
    ).toBe("Foto terlalu besar. Ambil ulang.");
    expect(galatnya(validateFotoLaporan("image/jpeg", "AA="))).toBe(
      "Foto tidak terbaca.",
    );
    expect(validateFotoLaporan("image/jpeg", "/9j/").ok).toBe(true);
  });

  test("validasi master dan perjalanan", () => {
    const tarif = (v: unknown) => daftarTarifDraftSchema.parse(v);
    expect(
      galatnya(validateDaftarTarif(tarif({ nama: " " }), "jenis kendaraan")),
    ).toBe("Nama jenis kendaraan wajib diisi.");
    expect(
      galatnya(
        validateDaftarTarif(
          tarif({ nama: "Truk", tarif: -1 }),
          "jenis kendaraan",
        ),
      ),
    ).toBe("Tarif harus 0 sampai Rp100.000.000.");
    expect(
      nilainya(
        validateDaftarTarif(
          tarif({ nama: " Truk ", tarif: 150000 }),
          "jenis kendaraan",
        ),
      ),
    ).toEqual({ nama: "Truk", tarif: 150_000, status_aktif: true });

    expect(normalisasiIdentitas("  b 1234\txyz ")).toBe("B 1234 XYZ");
    const kendaraan = (v: unknown) => kendaraanDraftSchema.parse(v);
    expect(galatnya(validateKendaraan(kendaraan({ identitas: "B 1" })))).toBe(
      "Pilih jenis kendaraan.",
    );
    expect(
      galatnya(
        validateKendaraan(kendaraan({ id_jenis: "j1", identitas: " " })),
      ),
    ).toBe("Plat atau nomor kendaraan wajib diisi.");
    expect(
      nilainya(
        validateKendaraan(kendaraan({ id_jenis: "j1", identitas: "b  1 x" })),
      ).identitas,
    ).toBe("B 1 X");

    const lokasi = (v: unknown) => lokasiDraftSchema.parse(v);
    expect(
      galatnya(validateLokasi(lokasi({ nama: "Pool", jenis: "Pool" }))),
    ).toBe("Ambil koordinat lokasi lebih dulu.");
    expect(
      galatnya(
        validateLokasi(
          lokasi({ nama: "Pool", jenis: "Kantor", lat: -6.2, lng: 106.8 }),
        ),
      ),
    ).toBe("Pilih jenis lokasi.");
    expect(
      galatnya(
        validateLokasi(
          lokasi({
            nama: "Pool",
            jenis: "Pool",
            lat: -6.2,
            lng: 106.8,
            radius_m: 5,
          }),
        ),
      ),
    ).toBe("Radius 10 sampai 10.000 meter.");
    expect(
      nilainya(
        validateLokasi(
          lokasi({ nama: "Pool", jenis: "Pool", lat: -6.2, lng: 106.8 }),
        ),
      ).radius_m,
    ).toBe(200);

    const dasar = {
      tanggal: "2026-11-09",
      id_karyawan: "d1",
      id_kendaraan: "k1",
      id_kategori: "t1",
      muatan: [
        {
          tempat_muat: "Gudang A",
          nama_barang: "Semen",
          qty: 10,
          satuan: "sak",
          berat_kg_x100: 50000,
        },
      ],
    };
    const perjalanan = (v: unknown) =>
      validatePerjalanan(perjalananDraftSchema.parse(v));
    expect(nilainya(perjalanan(dasar)).muatan).toHaveLength(1);
    expect(galatnya(perjalanan({ ...dasar, muatan: [] }))).toBe(
      "Isi minimal satu barang muatan.",
    );
    expect(
      galatnya(
        perjalanan({ ...dasar, muatan: [{ ...dasar.muatan[0], qty: 0 }] }),
      ),
    ).toBe("Baris 1: jumlah harus lebih dari 0.");
    expect(
      galatnya(
        perjalanan({
          ...dasar,
          muatan: [{ ...dasar.muatan[0], satuan: "x".repeat(21) }],
        }),
      ),
    ).toBe("Baris 1: satuan maksimal 20 karakter.");
    expect(galatnya(perjalanan({ ...dasar, id_kategori: null }))).toBe(
      "Pilih kategori tujuan.",
    );
  });
});
