import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as P from "./hr-pelatihan";
import {
  idPeserta,
  JENIS_SERTIFIKAT,
  PESAN_PELATIHAN_BATAL,
  PESAN_PESERTA_BERSERTIFIKAT,
  PESAN_SERTIFIKAT_NONAKTIF,
  statusPelatihan,
  validasiBatalPelatihan,
  validasiPelatihan,
  validasiPeserta,
} from "./hr-pelatihan";

// Vektor yang sama diuji di `desktop/hr_pelatihan.rs` (modul `tests`).

const HARI = "2026-11-12";
const gagal = (pesan: string) => ({ ok: false as const, pesan });

describe("hr-pelatihan (cermin tes Rust)", () => {
  test("pelatihan: validasi dan status", () => {
    const sah = validasiPelatihan({
      nama: " K3  Dasar ",
      tanggal_mulai: "2026-12-01",
      tanggal_selesai: "2026-12-02",
      biaya: 3_000_000,
    });
    expect(
      sah.ok && [sah.nilai.nama, sah.nilai.biaya, sah.nilai.lokasi],
    ).toEqual(["K3 Dasar", 3_000_000, null]);
    const tanpaBiaya = validasiPelatihan({
      nama: "K3",
      tanggal_mulai: "2026-12-01",
      tanggal_selesai: "2026-12-01",
    });
    expect(tanpaBiaya.ok && tanpaBiaya.nilai.biaya).toBe(0);
    const dasar = (biaya: unknown, selesai: string) =>
      validasiPelatihan({
        nama: "K3",
        tanggal_mulai: "2026-12-01",
        tanggal_selesai: selesai,
        biaya,
      });
    for (const biaya of [-1, 1.5, 1_000_000_001, "5000"]) {
      expect(dasar(biaya, "2026-12-01")).toEqual(
        gagal("Biaya harus bilangan bulat 0–1.000.000.000."),
      );
    }
    expect(dasar(0, "2026-11-30")).toEqual(
      gagal("Tanggal selesai tidak boleh sebelum tanggal mulai."),
    );
    expect(
      validasiPelatihan({
        tanggal_mulai: "2026-12-01",
        tanggal_selesai: "2026-12-01",
      }),
    ).toEqual(gagal("Nama pelatihan wajib diisi."));
    expect(
      validasiPelatihan({
        nama: "K3",
        tanggal_mulai: "2026-02-30",
        tanggal_selesai: "2026-12-01",
      }),
    ).toEqual(gagal("Tanggal mulai tidak valid."));
    expect(
      validasiPelatihan({
        nama: "K3",
        tanggal_mulai: "2026-12-01",
        tanggal_selesai: "2026-12-01",
        lokasi: "a".repeat(101),
      }),
    ).toEqual(gagal("Lokasi maksimal 100 karakter."));

    expect(statusPelatihan("2026-11-13", "2026-11-14", false, HARI)).toBe(
      "Dijadwalkan",
    );
    expect(statusPelatihan("2026-11-12", "2026-11-12", false, HARI)).toBe(
      "Berlangsung",
    );
    expect(statusPelatihan("2026-11-10", "2026-11-11", false, HARI)).toBe(
      "Selesai",
    );
    expect(statusPelatihan("2026-11-10", "2026-11-11", true, HARI)).toBe(
      "Dibatalkan",
    );
  });

  test("peserta dan batal", () => {
    expect(idPeserta("plt-1", "EMP_A")).toBe("plt-1:EMP_A");
    expect(validasiPeserta({ id_karyawan: "EMP_A", hasil: "Lulus" })).toEqual({
      ok: true,
      nilai: { id_karyawan: "EMP_A", hasil: "Lulus", catatan: null },
    });
    expect(validasiPeserta({ id_karyawan: "EMP_A", hasil: "Gagal" })).toEqual(
      gagal("Hasil pelatihan tidak dikenal."),
    );
    expect(validasiPeserta({ hasil: "Lulus" })).toEqual(
      gagal("Karyawan wajib dipilih."),
    );
    expect(validasiBatalPelatihan({ alasan: " Ditunda " }, false)).toEqual({
      ok: true,
      nilai: "Ditunda",
    });
    expect(validasiBatalPelatihan({}, false)).toEqual(
      gagal("Alasan pembatalan wajib diisi."),
    );
    expect(validasiBatalPelatihan({ alasan: "x" }, true)).toEqual(
      gagal(PESAN_PELATIHAN_BATAL),
    );
  });

  test("SQL, pesan, dan konstanta disalin harfiah ke hr_pelatihan.rs (Desktop dan Mobile)", () => {
    let diperiksa = 0;
    for (const dir of ["desktop", "mobile"]) {
      const lokasi = [
        join(import.meta.dir, `../../../src-tauri/src/${dir}/hr_pelatihan.rs`),
        join(
          import.meta.dir,
          `../../../../mobile/src-tauri/src/${dir}/hr_pelatihan.rs`,
        ),
      ].find(existsSync);
      if (!lokasi) continue;
      diperiksa++;
      const rust = readFileSync(lokasi, "utf8").replaceAll("\r\n", "\n");
      for (const teks of [
        `"${JENIS_SERTIFIKAT}"`,
        `"${PESAN_SERTIFIKAT_NONAKTIF}"`,
        `"${PESAN_PELATIHAN_BATAL}"`,
        PESAN_PESERTA_BERSERTIFIKAT,
        P.DAFTAR_PELATIHAN_SQL,
        P.PESERTA_SQL,
        P.BERKAS_PESERTA_SQL,
        P.RIWAYAT_SQL,
        P.INSERT_PELATIHAN_SQL,
        P.UBAH_PELATIHAN_SQL,
        P.BATAL_PELATIHAN_SQL,
        P.TAMBAH_PESERTA_SQL,
        P.LEPAS_PESERTA_SQL,
        P.HASIL_PESERTA_SQL,
        P.TAUT_SERTIFIKAT_SQL,
        P.BERKAS_SERTIFIKAT_SQL,
      ]) {
        expect(rust).toContain(teks);
      }
    }
    expect(diperiksa).toBeGreaterThan(0);
  });
});
