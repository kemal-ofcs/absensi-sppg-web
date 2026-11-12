import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as R from "./hr-rekrutmen";
import {
  HAPUS_PELAMAR_LAMA_SQL,
  idDariPelamar,
  KLAIM_PELAMAR_SQL,
  PELAMAR_DIHAPUS_SQL,
  PESAN_SUDAH_KARYAWAN,
  pelamarGanda,
  periksaBatalTahap,
  periksaTahap,
  RETENSI_BULAN_SQL,
  statusLowongan,
  statusPelamar,
  TANGGAL_HAPUS_SQL,
  type TahapRingkas,
  TUTUP_EFEKTIF_SQL,
  tutupEfektif,
  validasiLowongan,
  validasiPelamar,
} from "./hr-rekrutmen";

// Vektor yang sama diuji di `desktop/hr_rekrutmen.rs` (modul `tests`).

const HARI = "2026-11-12";
const t = (
  urutan: number,
  tahap: string,
  dibatalkan: boolean,
): TahapRingkas => ({
  urutan,
  tahap,
  dibatalkan,
});
const gagal = (pesan: string) => ({ ok: false as const, pesan });

describe("hr-rekrutmen (cermin tes Rust)", () => {
  test("lowongan: validasi dan status", () => {
    const sah = validasiLowongan({
      judul: "  Staf   Gudang ",
      jumlah: 2,
      tanggal_buka: "2026-11-01",
      tanggal_tutup: "2026-11-30",
      id_divisi: "div-1",
    });
    expect(
      sah.ok && [
        sah.nilai.judul,
        sah.nilai.jumlah,
        sah.nilai.id_divisi,
        sah.nilai.id_jabatan,
      ],
    ).toEqual(["Staf Gudang", 2, "div-1", null]);
    expect(validasiLowongan({ jumlah: 1, tanggal_buka: "2026-11-01" })).toEqual(
      gagal("Judul lowongan wajib diisi."),
    );
    for (const jumlah of [0, 1.5]) {
      expect(
        validasiLowongan({ judul: "A", jumlah, tanggal_buka: "2026-11-01" }),
      ).toEqual(gagal("Jumlah dibutuhkan harus bilangan bulat 1–999."));
    }
    expect(
      validasiLowongan({ judul: "A", jumlah: 1, tanggal_buka: "2026-11-31" }),
    ).toEqual(gagal("Tanggal buka tidak valid."));
    expect(
      validasiLowongan({
        judul: "A",
        jumlah: 1,
        tanggal_buka: "2026-11-10",
        tanggal_tutup: "2026-11-09",
      }),
    ).toEqual(gagal("Tanggal tutup tidak boleh sebelum tanggal buka."));
    expect(
      validasiLowongan({
        judul: "a".repeat(101),
        jumlah: 1,
        tanggal_buka: "2026-11-01",
      }),
    ).toEqual(gagal("Judul lowongan maksimal 100 karakter."));

    expect(statusLowongan("2026-11-01", null, false, HARI)).toBe("Dibuka");
    expect(statusLowongan("2026-11-13", null, false, HARI)).toBe("Dijadwalkan");
    expect(statusLowongan("2026-11-01", "2026-11-12", false, HARI)).toBe(
      "Dibuka",
    );
    expect(statusLowongan("2026-11-01", "2026-11-11", false, HARI)).toBe(
      "Ditutup",
    );
    expect(statusLowongan("2026-11-13", null, true, HARI)).toBe("Ditutup");

    expect(tutupEfektif(null, null, HARI)).toBeNull();
    expect(tutupEfektif("2026-11-12", null, HARI)).toBeNull();
    expect(tutupEfektif("2026-11-10", null, HARI)).toBe("2026-11-10");
    expect(tutupEfektif("2026-11-20", "2026-11-05", HARI)).toBe("2026-11-05");
    expect(tutupEfektif("2026-11-03", "2026-11-05", HARI)).toBe("2026-11-03");
    expect(tutupEfektif(null, "2026-11-05", HARI)).toBe("2026-11-05");
  });

  test("pelamar: validasi", () => {
    const dasar = {
      id_lowongan: "low-1",
      nama: " Budi  Santoso ",
      no_hp: "0812-3456-7890",
      email: " Budi@Contoh.ID ",
      lp: "L",
      pendidikan: "S1",
      tanggal_lamaran: "2026-11-05",
      sumber: "Jobstreet",
    };
    const sah = validasiPelamar(dasar, "2026-11-01", HARI);
    expect(
      sah.ok && [sah.nilai.nama, sah.nilai.no_hp, sah.nilai.email],
    ).toEqual(["Budi Santoso", "+6281234567890", "budi@contoh.id"]);
    const ubah = (kunci: string, nilai: unknown) =>
      validasiPelamar({ ...dasar, [kunci]: nilai }, "2026-11-01", HARI);
    expect(ubah("id_lowongan", null)).toEqual(gagal("Lowongan wajib dipilih."));
    expect(ubah("nama", "B")).toEqual(
      gagal("Nama pelamar minimal 2 karakter."),
    );
    expect(ubah("no_hp", "12")).toEqual(gagal("Nomor HP tidak valid."));
    expect(ubah("email", "budi@contoh")).toEqual(gagal("Email tidak valid."));
    expect(ubah("lp", "X")).toEqual(gagal("Jenis kelamin tidak dikenal."));
    expect(ubah("tanggal_lahir", "2026-11-13")).toEqual(
      gagal("Tanggal lahir tidak valid."),
    );
    expect(ubah("pendidikan", "SMA")).toEqual(
      gagal("Pendidikan tidak dikenal."),
    );
    expect(ubah("tanggal_lamaran", "2026-11-13")).toEqual(
      gagal("Tanggal lamaran tidak boleh di masa depan."),
    );
    expect(ubah("tanggal_lamaran", "2026-10-31")).toEqual(
      gagal("Tanggal lamaran tidak boleh sebelum lowongan dibuka."),
    );
    expect(ubah("alamat", "a".repeat(256))).toEqual(
      gagal("Alamat maksimal 255 karakter."),
    );
    expect(ubah("sumber", "a".repeat(101))).toEqual(
      gagal("Sumber maksimal 100 karakter."),
    );
    expect(
      validasiPelamar(
        { id_lowongan: "low-1", nama: "Budi", tanggal_lamaran: HARI },
        "2026-11-13",
        HARI,
      ),
    ).toEqual(gagal("Tanggal lamaran tidak boleh sebelum lowongan dibuka."));
  });

  test("tahap: status, urutan, dan batal", () => {
    const riwayat = [
      t(1, "Lamaran", false),
      t(2, "Wawancara", false),
      t(3, "Tes", true),
    ];
    expect(statusPelamar(riwayat)?.tahap).toBe("Wawancara");
    expect(statusPelamar([])).toBeNull();

    const tahap = (nama: string, catatan: unknown) => ({
      tahap: nama,
      tanggal: "2026-11-10",
      catatan,
    });
    expect(
      periksaTahap(tahap("Wawancara", null), "Wawancara", "2026-11-05", HARI)
        .ok,
    ).toBe(true);
    expect(
      periksaTahap(tahap("Lamaran", null), "Tes", "2026-11-05", HARI).ok,
    ).toBe(true);
    expect(
      periksaTahap(tahap("Diterima", null), "Lamaran", "2026-11-05", HARI).ok,
    ).toBe(true);
    expect(
      periksaTahap(tahap("Tes", null), "Ditolak", "2026-11-05", HARI),
    ).toEqual(gagal("Pelamar sudah Ditolak; tahap baru tidak bisa dicatat."));
    expect(
      periksaTahap(tahap("Psikotes", null), "Lamaran", "2026-11-05", HARI),
    ).toEqual(gagal("Tahap tidak dikenal."));
    expect(
      periksaTahap(tahap("Mundur", " "), "Tes", "2026-11-05", HARI),
    ).toEqual(gagal("Catatan wajib diisi untuk tahap Ditolak dan Mundur."));
    expect(
      periksaTahap(
        tahap("Ditolak", "Tidak lulus tes"),
        "Tes",
        "2026-11-05",
        HARI,
      ).ok,
    ).toBe(true);
    expect(
      periksaTahap(tahap("Tes", null), "Lamaran", "2026-11-11", HARI),
    ).toEqual(gagal("Tanggal tahap tidak boleh sebelum tanggal lamaran."));
    expect(
      periksaTahap(
        { tahap: "Tes", tanggal: "2026-11-13" },
        "Lamaran",
        "2026-11-05",
        HARI,
      ),
    ).toEqual(gagal("Tanggal tahap tidak boleh di masa depan."));

    const alasan = { alasan: "Salah tekan" };
    expect(periksaBatalTahap(riwayat, false, alasan)).toEqual({
      ok: true,
      nilai: [2, "Salah tekan"],
    });
    expect(periksaBatalTahap(riwayat, false, {})).toEqual(
      gagal("Alasan pembatalan wajib diisi."),
    );
    expect(periksaBatalTahap(riwayat, true, alasan)).toEqual(
      gagal(PESAN_SUDAH_KARYAWAN),
    );
    expect(periksaBatalTahap([t(1, "Lamaran", false)], false, alasan)).toEqual(
      gagal("Tahap Lamaran tidak bisa dibatalkan."),
    );
  });

  test("id deterministik dan pelamar ganda", () => {
    expect(idDariPelamar("plm-0123456789abcdef0123456789abcdef")).toEqual({
      ok: true,
      nilai: {
        id_unik: "EMP_0123456789AB",
        kode_karyawan: "K89ABCDEF",
        id_kontrak: "ktr-plm-0123456789abcdef0123456789abcdef",
      },
    });
    expect(idDariPelamar("plm-abc")).toEqual(gagal("Id pelamar tidak valid."));
    expect(
      pelamarGanda([
        ["a", "Budi Santoso", "+6281"],
        ["b", " budi  SANTOSO", "+6281"],
        ["c", "Budi Santoso", "+6282"],
        ["d", "Ani", null],
        ["e", "Ani", null],
      ]),
    ).toEqual(["a", "b"]);
  });

  test("SQL dan pesan disalin harfiah ke hr_rekrutmen.rs (Desktop dan Mobile)", () => {
    // Fragmen makro dipecah lebih dulu: sumber Rust menyimpannya sebagai
    // potongan `concat!`, bukan satu string utuh.
    const fragmen = [
      PELAMAR_DIHAPUS_SQL,
      TANGGAL_HAPUS_SQL,
      TUTUP_EFEKTIF_SQL,
      RETENSI_BULAN_SQL,
      R.PILIH_PELAMAR_SQL,
      R.STATUS_PELAMAR_SQL,
    ];
    let potongan: string[] = [
      ...HAPUS_PELAMAR_LAMA_SQL,
      R.DAFTAR_LOWONGAN_SQL,
      R.PERHATIAN_REKRUTMEN_SQL,
      R.STATUS_SEMUA_PELAMAR_SQL,
      R.PELAMAR_LOWONGAN_SQL,
      R.PELAMAR_SATU_SQL,
      ...fragmen,
    ];
    for (const f of fragmen) potongan = potongan.flatMap((p) => p.split(f));
    potongan = potongan.filter((p) => p !== "");
    expect(potongan.length).toBeGreaterThan(8);
    let diperiksa = 0;
    for (const dir of ["desktop", "mobile"]) {
      const lokasi = [
        join(import.meta.dir, `../../../src-tauri/src/${dir}/hr_rekrutmen.rs`),
        join(
          import.meta.dir,
          `../../../../mobile/src-tauri/src/${dir}/hr_rekrutmen.rs`,
        ),
      ].find(existsSync);
      if (!lokasi) continue;
      diperiksa++;
      const rust = readFileSync(lokasi, "utf8").replaceAll("\r\n", "\n");
      for (const teks of [
        TUTUP_EFEKTIF_SQL,
        RETENSI_BULAN_SQL,
        ...KLAIM_PELAMAR_SQL,
        PESAN_SUDAH_KARYAWAN,
        R.STATUS_PELAMAR_SQL,
        R.INSERT_LOWONGAN_SQL,
        R.UBAH_LOWONGAN_SQL,
        R.TUTUP_LOWONGAN_SQL,
        R.BUKA_LOWONGAN_SQL,
        R.INSERT_PELAMAR_SQL,
        R.UBAH_PELAMAR_SQL,
        R.INSERT_TAHAP_SQL,
        R.BATAL_TAHAP_SQL,
        R.INSERT_BERKAS_SQL,
        R.HAPUS_BERKAS_SQL,
        ...potongan,
      ]) {
        expect(rust).toContain(teks);
      }
    }
    expect(diperiksa).toBeGreaterThan(0);
  });
});
