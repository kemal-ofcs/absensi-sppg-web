import { describe, expect, test } from "bun:test";
import type { KolomFormat, SusunanTransfer } from "@/lib/validations/transfer";
import vektor from "@/lib/validations/transfer.vektor.json";
import {
  berkasFormat,
  berkasUmum,
  type FormatRender,
  nominalTeks,
  renderTeks,
  renderXlsx,
  selFormat,
} from "./berkas-transfer";
import { readWorkbookTable } from "./xlsx";

// Langkah 6 §27.8. Masukan = susunan hasil `susunTransfer` di vektor bersama,
// jadi yang dirender sama dengan yang dihitung backend Rust dan Web.

const kasus = (nama: string) =>
  vektor.susun.kasus.find((k) => k.nama === nama)
    ?.harapan as unknown as SusunanTransfer;
const umum = kasus("Excel umum");
const run = {
  period_start: "2026-10-01",
  period_end: "2026-10-31",
  status: "APPROVED",
};
const kolom = (...isian: Array<[KolomFormat["isian"], string, string?]>) =>
  isian.map(([i, judul, teks]) => ({ isian: i, judul, teks: teks ?? null }));
const format = (isi: Partial<FormatRender>): FormatRender => ({
  nama: "Uji",
  jenis: "csv",
  pemisah: ",",
  pakai_judul: 1,
  kutip: 0,
  desimal: 0,
  kolom: kolom(["no_rekening", "Rekening"], ["nominal", "Nominal"]),
  ...isi,
});
const baca = (data: Uint8Array | string) =>
  readWorkbookTable(new File([data as unknown as BlobPart], "uji.xlsx"));
const berita = "Gaji 2026-10-01 s.d. 2026-10-31";

describe("berkas transfer: CSV/TXT", () => {
  test("pemisah titik koma, kutip, desimal, teks tetap, judul", () => {
    const f = format({
      pemisah: ";",
      kutip: 1,
      desimal: 1,
      kolom: kolom(
        ["nomor_urut", "No"],
        ["no_rekening", "Rekening"],
        ["nama_rekening", "Nama"],
        ["nominal", "Jumlah"],
        ["kode_bank", "Kode"],
        ["berita", "Berita"],
        ["teks_tetap", "Layanan", "PAYROLL"],
        ["teks_tetap", "Kosong", ""],
      ),
    });
    const baris = (
      no: number,
      rek: string,
      nama: string,
      n: string,
      kode: string,
    ) => `${no};"${rek}";"${nama}";${n};"${kode}";"${berita}";"PAYROLL";""\r\n`;
    expect(renderTeks(umum, f)).toBe(
      `"No";"Rekening";"Nama";"Jumlah";"Kode";"Berita";"Layanan";"Kosong"\r\n${baris(
        1,
        "1111111111",
        "ANA",
        "5000000.00",
        "014",
      )}${baris(2, "2222222222", "Siti", "4250000.00", "008")}${baris(
        3,
        "6666666666",
        "Fajar",
        "1500000.00",
        "",
      )}${baris(4, "7777777777", "", "3750000.00", "451")}`,
    );
  });

  test("TXT tab tanpa judul dan tanpa kutip; tanggal dan rekening debet", () => {
    const f = format({
      jenis: "txt",
      pemisah: "\t",
      pakai_judul: 0,
      kolom: kolom(
        ["rekening_debet", "Debet"],
        ["no_rekening", "Rekening"],
        ["nominal", "Nominal"],
        ["tanggal_efektif", "Tanggal"],
      ),
    });
    expect(renderTeks(umum, f).split("\r\n")).toEqual([
      "8800112233\t1111111111\t5000000\t2026-11-02",
      "8800112233\t2222222222\t4250000\t2026-11-02",
      "8800112233\t6666666666\t1500000\t2026-11-02",
      "8800112233\t7777777777\t3750000\t2026-11-02",
      "",
    ]);
  });

  test("tanpa kutip: teks berisi pemisah atau kutip tetap dikutip, kolom tidak bergeser", () => {
    const s: SusunanTransfer = {
      ...umum,
      baris: [
        {
          ...umum.baris[0],
          nama_karyawan: "Ana, S.E.",
        } as SusunanTransfer["baris"][number],
        {
          ...umum.baris[1],
          nama_karyawan: 'Bu"di',
        } as SusunanTransfer["baris"][number],
      ],
    };
    const f = format({
      kolom: kolom(["nama_karyawan", "Nama"], ["nominal", "Nominal"]),
    });
    expect(renderTeks(s, f)).toBe(
      'Nama,Nominal\r\n"Ana, S.E.",5000000\r\n"Bu""di",4250000\r\n',
    );
  });

  test("cakupan dan total: berkas hanya memuat baris masuk, jumlah nominal = total", () => {
    const f = format({ pakai_judul: 0 });
    for (const k of vektor.susun.kasus) {
      const s = k.harapan as unknown as SusunanTransfer;
      const isi = renderTeks(s, f).split("\r\n").filter(Boolean);
      expect(isi).toHaveLength(s.ringkasan.jumlah_baris);
      const total = isi.reduce(
        (t, b) => t + Number.parseInt(b.split(",")[1] ?? "0", 10),
        0,
      );
      expect(total).toBe(s.ringkasan.total);
    }
    // Berkas sesama: hanya Ana (BCA = bank rekening debet).
    expect(renderTeks(kasus("sesama berkode"), f)).toBe(
      "1111111111,5000000\r\n",
    );
    expect(nominalTeks(1_500_000, true)).toBe("1500000.00");
    expect(nominalTeks(0, false)).toBe("0");
  });

  test("pratinjau memakai sel yang sama dengan berkas", () => {
    const f = format({});
    expect(selFormat(umum, f).baris.slice(0, 2)).toEqual([
      ["1111111111", 5_000_000],
      ["2222222222", 4_250_000],
    ]);
  });
});

describe("berkas transfer: workbook", () => {
  test("xlsx kustom: nominal sel Angka, rekening tetap teks, tanpa judul", async () => {
    const s: SusunanTransfer = {
      ...umum,
      baris: [
        {
          ...umum.baris[0],
          no_rekening: "0012345678",
        } as SusunanTransfer["baris"][number],
      ],
    };
    const f = format({ jenis: "xlsx", pemisah: null });
    const dengan = await baca(renderXlsx(s, f));
    expect(dengan.rows).toEqual([
      ["Rekening", "Nominal"],
      ["0012345678", "5000000"],
    ]);
    expect(dengan.selAngka[1]).toEqual([false, true]);
    const tanpa = await baca(renderXlsx(s, { ...f, pakai_judul: 0 }));
    expect(tanpa.rows).toEqual([["0012345678", "5000000"]]);
  });

  test("Excel umum: sheet Transfer, Perlu dibayar manual, dan Ringkasan", async () => {
    const berkas = berkasUmum(run, umum);
    expect(berkas.nama).toBe("Transfer_Gaji_2026-10-01_2026-10-31_umum.xlsx");
    const { rows, selAngka } = await baca(berkas.data);
    expect(rows).toHaveLength(5);
    expect(rows[1]?.slice(0, 9)).toEqual([
      "1",
      "EMP-1",
      "Ana",
      "BCA",
      "014",
      "1111111111",
      "ANA",
      "5000000",
      "Sesama bank",
    ]);
    expect(selAngka[1]?.[7]).toBe(true);
    expect(rows[2]?.[13]).toBe("Nama pemilik rekening berbeda");
    const xml = new TextDecoder().decode(berkas.data as Uint8Array);
    expect(xml).toContain('<sheet name="Perlu dibayar manual" sheetId="2"');
    expect(xml).toContain('<sheet name="Ringkasan" sheetId="3"');
    expect(xml).toContain("Rekening belum diisi");
    expect(xml).toContain("Total gaji bersih proses gaji");
    expect(xml).toContain(`<v>${umum.ringkasan.total_run}</v>`);
  });

  test("nama dan jenis berkas format kustom", () => {
    const f = format({ nama: "BCA Payroll (Sesama)" });
    expect(berkasFormat(run, umum, f)).toMatchObject({
      nama: "Transfer_Gaji_2026-10-01_2026-10-31_BCA_Payroll_Sesama.csv",
      mime: "text/csv",
    });
    expect(
      berkasFormat(run, umum, { ...f, jenis: "txt", pemisah: "|" }).mime,
    ).toBe("text/plain");
    expect(
      berkasFormat(run, umum, { ...f, jenis: "xlsx", pemisah: null }).nama,
    ).toMatch(/\.xlsx$/);
  });
});
