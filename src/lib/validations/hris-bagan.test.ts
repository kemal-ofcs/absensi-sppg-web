import { describe, expect, test } from "bun:test";
import {
  bukaRantai,
  kelompokUnit,
  kotakBagan,
  MAKS_NAMA_KELOMPOK,
  rantaiBagan,
  susunBagan,
  TANPA_CABANG,
  TANPA_DIVISI,
  terbukaBawaan,
} from "@/lib/validations/hris-bagan";

const k = (
  id: string,
  nama: string,
  idAtasan: string | null = null,
  lain: Record<string, unknown> = {},
) => ({
  id_unik: id,
  nama,
  id_atasan: idAtasan,
  status_aktif: "Aktif",
  divisi: "Gudang",
  jabatan_status: "Staf",
  id_cabang: "cab-1",
  ...lain,
});

const cabang = new Map([["cab-1", "Pusat"]]);

describe("susunBagan", () => {
  test("lingkaran dari dua perangkat menjadi akar bertanda, tanpa berputar", () => {
    // Perangkat 1 menulis A → B, perangkat 2 menulis B → A, keduanya offline.
    const bagan = susunBagan(
      [k("a", "Ani", "b"), k("b", "Budi", "a"), k("c", "Cici", "a")],
      [],
      cabang,
    );
    expect(bagan.akar).toEqual(["a", "b"]);
    expect(bagan.simpul.get("a")?.tanda).toEqual(["atasan_siklus"]);
    expect(bagan.simpul.get("b")?.tanda).toEqual(["atasan_siklus"]);
    expect(bagan.simpul.get("a")?.anak).toEqual(["c"]);
    expect(bagan.simpul.get("c")?.induk).toBe("a");
    expect(rantaiBagan(bagan, "c")).toEqual(["a", "c"]);
  });

  test("daftar siklus dari organisasi ikut ditandai", () => {
    const bagan = susunBagan(
      [k("a", "Ani"), k("b", "Budi", "a")],
      ["b", "hilang"],
      cabang,
    );
    expect(bagan.simpul.get("b")?.tanda).toEqual(["atasan_siklus"]);
    expect(bagan.simpul.get("b")?.induk).toBeNull();
    expect(bagan.akar).toEqual(["b"]);
  });

  test("atasan nonaktif atau tidak dikenal menjadi akar bertanda", () => {
    const bagan = susunBagan(
      [
        k("bos", "Bos", null, { status_aktif: "Nonaktif" }),
        k("a", "Ani", "bos"),
        k("b", "Budi", "tidak-ada"),
        k("c", "Cici", "a"),
      ],
      [],
      cabang,
    );
    expect(bagan.simpul.has("bos")).toBe(false);
    expect(bagan.akar).toEqual(["a", "b"]);
    expect(bagan.simpul.get("a")?.tanda).toEqual(["atasan_nonaktif"]);
    expect(bagan.simpul.get("b")?.tanda).toEqual(["atasan_nonaktif"]);
    expect(bagan.simpul.get("c")?.tanda).toEqual([]);
  });

  test("tanpa atasan dan tanpa bawahan masuk kelompok per divisi, bukan kotak", () => {
    const bagan = susunBagan(
      [
        k("bos", "Bos"),
        k("a", "Ani", "bos"),
        k("x", "Xena", null, { divisi: "Keuangan" }),
        k("y", "Yuda", null, { divisi: "" }),
        k("z", "Zaki", null, { divisi: "Keuangan" }),
        k("w", "Wati"),
      ],
      [],
      cabang,
    );
    expect(bagan.akar).toEqual(["bos"]);
    expect(bagan.tanpaAtasan).toEqual([
      { nama: "Gudang", jumlah: 1, id: ["w"] },
      { nama: "Keuangan", jumlah: 2, id: ["x", "z"] },
      { nama: TANPA_DIVISI, jumlah: 1, id: ["y"] },
    ]);
    // Tetap ada di peta simpul, supaya cari dan Fokus bisa memilihnya.
    expect(bagan.simpul.get("x")?.induk).toBeNull();
  });

  test("kelompok tanpa atasan memuat paling banyak 200 nama, jumlah utuh", () => {
    const banyak = Array.from({ length: 250 }, (_, i) =>
      k(`k${String(i).padStart(3, "0")}`, `Nama ${String(i).padStart(3, "0")}`),
    );
    const [kelompok] = susunBagan(banyak, [], cabang).tanpaAtasan;
    expect(kelompok.jumlah).toBe(250);
    expect(kelompok.id).toHaveLength(MAKS_NAMA_KELOMPOK);
    expect(kelompok.id[0]).toBe("k000");
  });

  test("urutan anak stabil menurut nama lalu id", () => {
    const data = [
      k("bos", "Bos"),
      k("3", "budi", "bos"),
      k("2", "Ani", "bos"),
      k("1", "Budi", "bos"),
      k("4", "Citra", "bos"),
    ];
    const maju = susunBagan(data, [], cabang).simpul.get("bos")?.anak;
    const mundur = susunBagan([...data].reverse(), [], cabang).simpul.get(
      "bos",
    )?.anak;
    expect(maju).toEqual(["2", "1", "3", "4"]);
    expect(mundur).toEqual(maju);
  });

  test("jumlah bawahan langsung dan total, isi kotak", () => {
    const bagan = susunBagan(
      [
        k("bos", "Bos", null, { id_cabang: "cab-x" }),
        k("a", "Ani", "bos"),
        k("b", "Budi", "a"),
        k("c", "Cici", "a"),
      ],
      [],
      cabang,
    );
    const bos = bagan.simpul.get("bos");
    expect(bos?.langsung).toBe(1);
    expect(bos?.total).toBe(3);
    expect(bos?.cabang).toBeNull();
    expect(bagan.simpul.get("a")).toMatchObject({
      nama: "Ani",
      jabatan: "Staf",
      divisi: "Gudang",
      cabang: "Pusat",
      langsung: 2,
      total: 2,
      kedalaman: 1,
    });
    expect(bagan.simpul.get("c")?.kedalaman).toBe(2);
  });
});

describe("Fokus dan Bagan", () => {
  // Rantai 15 tingkat: r → n1 → … → n14.
  const rantai = [k("r", "Akar")];
  for (let i = 1; i < 15; i++) {
    rantai.push(k(`n${i}`, `Tingkat ${i}`, i === 1 ? "r" : `n${i - 1}`));
  }
  const panjang = susunBagan(rantai, [], cabang);

  test("rantai Fokus sampai akar", () => {
    const hasil = rantaiBagan(panjang, "n14");
    expect(hasil).toHaveLength(15);
    expect(hasil[0]).toBe("r");
    expect(hasil.at(-1)).toBe("n14");
    expect(rantaiBagan(panjang, "tidak-ada")).toEqual([]);
  });

  test("Bagan tidak menurunkan lebih dari 12 tingkat", () => {
    const semua = new Set(panjang.simpul.keys());
    const { tampil, dipersempit } = kotakBagan(panjang, semua);
    expect(dipersempit).toBe(false);
    expect(tampil.has("n12")).toBe(true);
    expect(tampil.has("n13")).toBe(false);
  });

  test("bukaRantai membuka semua atasan sampai orang yang dicari", () => {
    const terbuka = bukaRantai(new Set(), panjang, "n5");
    expect([...terbuka].sort()).toEqual(["n1", "n2", "n3", "n4", "r"]);
    expect(kotakBagan(panjang, terbuka).tampil.has("n5")).toBe(true);
  });

  test("dua tingkat pertama terbuka bila muat", () => {
    const bagan = susunBagan(
      [k("r", "Akar"), k("a", "Ani", "r"), k("b", "Budi", "a")],
      [],
      cabang,
    );
    const { terbuka, dipersempit } = terbukaBawaan(bagan);
    expect(dipersempit).toBe(false);
    expect([...terbuka]).toEqual(["r"]);
    expect([...kotakBagan(bagan, terbuka).tampil]).toEqual(["r", "a"]);
  });

  test("batas kotak: tingkat terbuka dikurangi, lalu dipotong", () => {
    const data = [k("r1", "Akar 1"), k("r2", "Akar 2")];
    for (let i = 0; i < 10; i++) data.push(k(`a${i}`, `Anak ${i}`, "r1"));
    data.push(k("b", "Budi", "r2"));
    const bagan = susunBagan(data, [], cabang);
    expect(terbukaBawaan(bagan, 13)).toMatchObject({ dipersempit: false });
    expect(terbukaBawaan(bagan, 13).terbuka.size).toBe(2);
    expect(terbukaBawaan(bagan, 12)).toEqual({
      terbuka: new Set(),
      dipersempit: true,
    });
    // Dua akar + sebelas anak tidak muat dalam 5 kotak: hanya akar.
    const sempit = terbukaBawaan(bagan, 5).terbuka;
    expect(sempit.size).toBe(0);
    expect(kotakBagan(bagan, sempit, 5)).toEqual({
      tampil: new Set(["r1", "r2"]),
      dipersempit: false,
    });
    // Dibuka paksa melewati batas: tingkat atas utuh, sisanya dipotong.
    const paksa = kotakBagan(bagan, new Set(["r1"]), 5);
    expect(paksa.dipersempit).toBe(true);
    expect(paksa.tampil.size).toBe(5);
    expect(paksa.tampil.has("r1")).toBe(true);
  });
});

describe("kelompokUnit", () => {
  test("cabang → divisi → karyawan, kelompok tanpa di akhir", () => {
    const bagan = susunBagan(
      [
        k("a", "Ani", null, { divisi: "" }),
        k("b", "Budi", "a", { id_cabang: "" }),
        k("c", "Cici", null, { divisi: "Admin" }),
        k("d", "Dodi", null),
        k("e", "Eka", null, { status_aktif: "Nonaktif" }),
      ],
      [],
      cabang,
    );
    expect(kelompokUnit(bagan)).toEqual([
      {
        nama: "Pusat",
        jumlah: 3,
        divisi: [
          { nama: "Admin", jumlah: 1, id: ["c"] },
          { nama: "Gudang", jumlah: 1, id: ["d"] },
          { nama: TANPA_DIVISI, jumlah: 1, id: ["a"] },
        ],
      },
      {
        nama: TANPA_CABANG,
        jumlah: 1,
        divisi: [{ nama: "Gudang", jumlah: 1, id: ["b"] }],
      },
    ]);
  });
});
