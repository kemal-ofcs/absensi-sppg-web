import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as T from "./transfer";
import vektor from "./transfer.vektor.json";

// Vektor yang sama diuji di `desktop/transfer.rs` (modul `tests`).

describe("transfer (cermin tes Rust)", () => {
  test("bank bawaan: BCA, Mandiri, BSI ada; kode unik; nama dan alias tidak bentrok", () => {
    const kode = T.BANK_BAWAAN.map((b) => b.kode);
    for (const k of ["014", "008", "451"]) expect(kode).toContain(k);
    expect(new Set(kode).size).toBe(T.BANK_BAWAAN.length);
    const baris = T.BANK_BAWAAN.map((b) => ({
      id_bank: b.id_bank,
      nama: b.nama,
      kode: b.kode,
      alias: JSON.stringify(b.alias),
      is_aktif: 1,
    }));
    for (const b of T.BANK_BAWAAN) {
      expect(b.id_bank).toBe(`bnk-${b.kode}`);
      const sah = T.validasiBank(
        { nama: b.nama, kode: b.kode, alias: b.alias },
        null,
      );
      expect(sah.ok).toBe(true);
      if (sah.ok) expect(T.bankBentrok(b.id_bank, sah.nilai, baris)).toBeNull();
    }
  });

  test("validasi bank, rekening, format: vektor bersama", () => {
    for (const k of vektor.bank) {
      expect(T.validasiBank(k.masukan, k.nama_lama)).toEqual(
        k.harapan as never,
      );
    }
    for (const k of vektor.rekening) {
      expect(T.validasiRekening(k.masukan)).toEqual(k.harapan as never);
    }
    for (const k of vektor.format) {
      expect(T.validasiFormat(k.masukan)).toEqual(k.harapan as never);
    }
    for (const k of vektor.pilihan) {
      expect(T.validasiPilihanTransfer(k.masukan)).toEqual(k.harapan as never);
    }
    for (const k of vektor.kolom_teks) {
      const kolom = T.validasiKolom(k.kolom);
      expect(kolom.ok && T.kolomTeks(kolom.nilai)).toBe(k.harapan);
    }
  });

  test("cocokBank, bankBentrok, rekeningBentrok: vektor bersama", () => {
    const bank = vektor.cocok.bank;
    for (const k of vektor.cocok.kasus) {
      expect(T.cocokBank(k.teks, bank)?.id_bank ?? null).toBe(k.harapan);
    }
    for (const k of vektor.cocok.bentrok) {
      const sah = T.validasiBank(k.masukan, null);
      expect(sah.ok && T.bankBentrok(k.id, sah.nilai, bank)).toBe(k.harapan);
    }
    for (const k of vektor.rekening_bentrok.kasus) {
      const sah = T.validasiRekening(k.masukan);
      expect(
        sah.ok &&
          T.rekeningBentrok(k.id, sah.nilai, vektor.rekening_bentrok.rekening),
      ).toBe(k.harapan);
    }
    expect(T.bacaAlias("bukan json")).toEqual([]);
    expect(T.bacaAlias('["A", 1, "B"]')).toEqual(["A", "B"]);
    expect(T.bacaAlias(null)).toEqual([]);
  });

  test("susunTransfer: vektor bersama, setiap rupiah run ada di salah satu daftar", () => {
    const s = vektor.susun;
    for (const k of s.kasus) {
      const susunan = T.susunTransfer({
        run: s.run,
        item: s.item,
        bank: s.bank,
        debet: s.debet,
        format: k.format,
        tanggal_efektif: s.tanggal_efektif,
      });
      expect(susunan).toEqual(k.harapan as never);
      const r = susunan.ringkasan;
      expect(susunan.baris.reduce((t, b) => t + b.nominal, 0)).toBe(r.total);
      expect(r.total + r.total_manual + r.total_luar_cakupan).toBe(r.total_run);
      expect(susunan.baris.map((b) => b.nomor_urut)).toEqual(
        susunan.baris.map((_, i) => i + 1),
      );
    }
  });

  test("SQL, konstanta, dan tanda disalin harfiah ke transfer.rs (Desktop dan Mobile)", () => {
    const daftarRust = (nama: string, isi: readonly string[]) =>
      `${nama}: [&str; ${isi.length}] = [${isi.map((s) => JSON.stringify(s)).join(", ")}];`;
    let diperiksa = 0;
    for (const dir of ["desktop", "mobile"]) {
      const lokasi = [
        join(import.meta.dir, `../../../src-tauri/src/${dir}/transfer.rs`),
        join(
          import.meta.dir,
          `../../../../mobile/src-tauri/src/${dir}/transfer.rs`,
        ),
      ].find(existsSync);
      if (!lokasi) continue;
      diperiksa++;
      const rust = readFileSync(lokasi, "utf8").replaceAll("\r\n", "\n");
      for (const teks of [
        T.SEED_BANK_SQL,
        T.BANK_SQL,
        T.REKENING_SQL,
        T.FORMAT_SQL,
        T.SIMPAN_BANK_SQL,
        T.SIMPAN_REKENING_SQL,
        T.SIMPAN_FORMAT_SQL,
        T.RUN_TRANSFER_SQL,
        T.BARIS_TRANSFER_SQL,
        T.CATAT_UNDUH_SQL,
        T.RIWAYAT_UNDUH_SQL,
        `MAKS_ALIAS: usize = ${T.MAKS_ALIAS};`,
        `MAKS_KOLOM_FORMAT: usize = ${T.MAKS_KOLOM_FORMAT};`,
        `MAKS_JUDUL_KOLOM: usize = ${T.MAKS_JUDUL_KOLOM};`,
        `MAKS_TEKS_KOLOM: usize = ${T.MAKS_TEKS_KOLOM};`,
        `MAKS_PANJANG_BERITA: i64 = ${T.MAKS_PANJANG_BERITA};`,
        daftarRust("JENIS_BERKAS", T.JENIS_BERKAS),
        daftarRust("PEMISAH", T.PEMISAH),
        daftarRust("CAKUPAN", T.CAKUPAN),
        daftarRust("ISIAN_TRANSFER", T.ISIAN_TRANSFER),
        daftarRust("IZIN_UNDUH", T.IZIN_UNDUH),
        daftarRust("JENIS_PENGATURAN", T.JENIS_PENGATURAN),
        `IZIN_PENGATURAN: &str = "${T.IZIN_PENGATURAN}";`,
        daftarRust("STATUS_RUN_TRANSFER", T.STATUS_RUN_TRANSFER),
        ...[
          T.PESAN_STATUS_RUN,
          T.PESAN_DEBET_NONAKTIF,
          T.PESAN_FORMAT_NONAKTIF,
          T.PESAN_REKENING_GANDA,
          T.PESAN_FORMAT_GANDA,
        ].map((p) => `"${p}"`),
        T.pesanBankGanda("{nama}"),
        ...[...T.TANDA_MANUAL, ...T.TANDA_PERINGATAN].map(
          (t) => `tanda.push("${t}")`,
        ),
      ]) {
        expect(rust).toContain(teks);
      }
    }
    expect(diperiksa).toBeGreaterThan(0);
  });
});
