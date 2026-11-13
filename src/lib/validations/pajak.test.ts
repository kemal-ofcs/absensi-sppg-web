import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as P from "./pajak";
import vektor from "./pajak.vektor.json";
import { TARIF_BPJS_BAWAAN, TARIF_PAJAK_BAWAAN } from "./tarif-bawaan";

// Vektor yang sama diuji di `desktop/payroll/pajak.rs` (modul `tests`).

describe("pajak (cermin pajak.rs)", () => {
  test("persen ke basis, status, PTKP, bulan penuh", () => {
    for (const [persen, basis] of vektor.persen_ke_basis) {
      expect(P.persenKeBasis(persen as number)).toBe(basis);
    }
    for (const [jenis, gaji, status] of vektor.status) {
      expect(P.statusPph(jenis, gaji as string)).toBe(status as P.StatusPph);
    }
    for (const [status, kategori, nilai] of vektor.ptkp) {
      expect<(string | number)[]>([
        P.kategoriTer(status as string),
        P.nilaiPtkp(status as string),
      ]).toEqual([kategori, nilai]);
    }
    for (const [awal, akhir, penuh] of vektor.bulan_penuh) {
      expect(P.bulanPenuh(awal as string, akhir as string)).toBe(
        penuh as boolean,
      );
    }
  });

  test("vektor PPh 21 V1-V12 dan tepi", () => {
    for (const k of vektor.pph) {
      const masukan = {
        ...vektor.bawaan.masukan,
        ...k.masukan,
      } as P.MasukanPph;
      const lapis =
        "lapis_kosong" in k && k.lapis_kosong ? [] : TARIF_PAJAK_BAWAAN;
      expect({ nama: k.nama, hasil: P.hitungPph(masukan, lapis) }).toEqual({
        nama: k.nama,
        hasil: { ...vektor.bawaan.harapan, ...k.harapan } as P.HasilPph,
      });
    }
  });

  test("vektor BPJS per masa", () => {
    for (const k of vektor.bpjs) {
      const hasil = P.hitungBpjsMasa(
        k.masukan.dasar_run,
        k.masukan.dasar_masa_sebelum,
        TARIF_BPJS_BAWAAN,
        k.masukan.sudah as Record<string, number>,
      );
      expect({
        nama: k.nama,
        karyawan: hasil.karyawan,
        perusahaan: hasil.perusahaan,
        dasar_masa: hasil.dasar_masa,
        nominal: Object.fromEntries(
          hasil.rincian.map((r) => [r.code, r.nominal]),
        ),
        premi: P.jumlahKode(hasil.rincian, P.KODE_PREMI),
        iuran_pensiun: P.jumlahKode(hasil.rincian, P.KODE_IURAN_PENSIUN),
        tanda: hasil.tanda,
      }).toEqual({ nama: k.nama, ...k.harapan });
    }
  });

  test("vektor ringkasan run pembanding", () => {
    for (const k of vektor.pembanding) {
      expect({
        nama: k.nama,
        hasil: P.ringkasPembanding(k.items, k.masa, k.status as P.StatusPph),
      }).toEqual({ nama: k.nama, hasil: k.harapan as P.Pembanding });
    }
  });

  test("label PPh di slip: metode, kategori, pengembalian, item lama", () => {
    expect([
      P.formatTarif(125),
      P.formatTarif(50),
      P.formatTarif(2100),
    ]).toEqual(["1,25%", "0,5%", "21%"]);
    const v1 = {
      ...vektor.bawaan.masukan,
      ptkp_status: "K/0",
      gross: 10_000_000,
    };
    const hasil = P.hitungPph(v1 as P.MasukanPph, TARIF_PAJAK_BAWAAN);
    expect(P.labelPph(hasil, hasil.pph, "K/0")).toBe("PPh 21 TER A 2%");
    expect(P.bacaPajakSnapshot(JSON.stringify({ pajak: hasil }))).toEqual(
      hasil,
    );
    expect(P.bacaPajakSnapshot('{"tax":{}}')).toBeNull();
    expect(P.bacaPajakSnapshot("rusak")).toBeNull();
    expect(P.labelPph(null, 50_000, "TK/0")).toBe("PPh 21 (TER TK/0)");
    expect(P.labelPph(hasil, -3_620_000, "K/0")).toBe("Pengembalian PPh 21");
  });

  test("pembulatan BigInt titik tengah menjauhi nol", () => {
    expect(P.kaliBasis(1, 5_000)).toBe(1);
    expect(P.kaliBasis(-1, 5_000)).toBe(-1);
    expect(P.kaliBasis(65_605_059, 2_100)).toBe(13_777_062);
    expect(() => P.kaliBasis(0.5, 100)).toThrow();
  });

  test("konstanta disalin harfiah ke pajak.rs (Desktop dan Mobile)", () => {
    const larik = (nama: string, isi: readonly string[]) =>
      `${nama}:[&str;${isi.length}]=[${isi.map((s) => JSON.stringify(s)).join(",")}];`;
    let diperiksa = 0;
    for (const [dir, sub] of [
      ["desktop", "payroll"],
      ["mobile", "payroll_admin"],
    ]) {
      const lokasi = [
        join(import.meta.dir, `../../../src-tauri/src/${dir}/${sub}/pajak.rs`),
        join(
          import.meta.dir,
          `../../../../mobile/src-tauri/src/${dir}/${sub}/pajak.rs`,
        ),
      ].find(existsSync);
      if (!lokasi) continue;
      diperiksa++;
      // Tanpa spasi dan koma penutup larik, supaya rustfmt tidak menggagalkannya.
      const rust = readFileSync(lokasi, "utf8")
        .replace(/\s+/g, "")
        .replaceAll(",]", "]");
      for (const teks of [
        `VERSI_PAJAK:i64=${P.VERSI_PAJAK};`,
        `STATUS_TETAP:&str=${JSON.stringify(P.STATUS_TETAP)};`,
        `STATUS_TIDAK_TETAP:&str=${JSON.stringify(P.STATUS_TIDAK_TETAP)};`,
        `METODE_TER_BULANAN:&str=${JSON.stringify(P.METODE_TER_BULANAN)};`,
        `METODE_TER_HARIAN:&str=${JSON.stringify(P.METODE_TER_HARIAN)};`,
        `METODE_PASAL_17_HARIAN:&str=${JSON.stringify(P.METODE_PASAL_17_HARIAN)};`,
        `METODE_PASAL_17_TERAKHIR:&str=${JSON.stringify(P.METODE_PASAL_17_TERAKHIR)};`,
        `TANDA_BPJS_TARIF_TIDAK_SAH:&str=${JSON.stringify(P.TANDA_BPJS_TARIF_TIDAK_SAH)};`,
        `PESAN_TARIF_TIDAK_SAH:&str=${JSON.stringify(P.PESAN_TARIF_TIDAK_SAH)};`.replace(
          /\s+/g,
          "",
        ),
        larik("KODE_PREMI", P.KODE_PREMI),
        larik("KODE_IURAN_PENSIUN", P.KODE_IURAN_PENSIUN),
        larik("TANDA_PAJAK", P.TANDA_PAJAK),
        `RUN_TAHUN_SQL:&str=${JSON.stringify(P.RUN_TAHUN_SQL)};`.replace(
          /\s+/g,
          "",
        ),
        `KOLOM_PAJAK_SQL:&str=${JSON.stringify(P.KOLOM_PAJAK_SQL)};`.replace(
          /\s+/g,
          "",
        ),
      ]) {
        expect(rust).toContain(teks);
      }
    }
    expect(diperiksa).toBeGreaterThan(0);
  });
});
