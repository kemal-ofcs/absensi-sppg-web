import { describe, expect, test } from "bun:test";
import {
  alihkanSatu,
  alihkanSemuaTampil,
  type KolomMassal,
  kalimatKonfirmasiMassal,
  terapkanKolomMassal,
  validasiNilaiMassal,
} from "./aturanUbahMassal";

const SHIFT: KolomMassal = {
  key: "id_shift",
  label: "Shift",
  jenis: "angka",
  opsi: [
    { value: "1", label: "Pagi (07:00–15:00)" },
    { value: "2", label: "Malam (23:00–07:00)" },
  ],
};
const MULAI: KolomMassal = {
  key: "tanggal_mulai_aktif",
  label: "Mulai aktif",
  jenis: "tanggal",
};
const DIVISI: KolomMassal = { key: "divisi", label: "Divisi", jenis: "teks" };

describe("aturanUbahMassal", () => {
  test("nilai kosong, di luar pilihan, dan format salah ditolak", () => {
    expect(validasiNilaiMassal(DIVISI, " ")).toBe("Divisi wajib diisi.");
    expect(validasiNilaiMassal(SHIFT, "9")).toBe(
      "Pilihan Shift tidak dikenal.",
    );
    expect(validasiNilaiMassal(SHIFT, "2")).toBeNull();
    expect(validasiNilaiMassal(MULAI, "01/07/2026")).toBe(
      "Mulai aktif harus berupa tanggal.",
    );
    expect(validasiNilaiMassal(MULAI, "2026-07-01")).toBeNull();
  });

  test("hanya field yang dipilih yang berganti, field lain utuh", () => {
    const draft = {
      id_unik: "K-1",
      nama: "Budi",
      divisi: "Kantor",
      no_hp: "0812",
      catatan: "lama",
      id_shift: 1,
    };
    expect(terapkanKolomMassal(draft, SHIFT, " 2 ")).toEqual({
      ...draft,
      id_shift: 2,
    });
    expect(terapkanKolomMassal(draft, DIVISI, " Gudang ")).toEqual({
      ...draft,
      divisi: "Gudang",
    });
  });

  test("kalimat konfirmasi memakai label pilihan dan memotong nama", () => {
    expect(
      kalimatKonfirmasiMassal(
        SHIFT,
        "1",
        ["Budi", "Ani", "Cici", "Dodi", "Eka"],
        "karyawan",
      ),
    ).toBe(
      'Ubah Shift menjadi "Pagi (07:00–15:00)" untuk 5 karyawan (Budi, Ani, Cici, dan 2 lainnya)?',
    );
  });

  test("pilih semua yang tampil, lalu lepas hanya yang tampil", () => {
    expect(alihkanSemuaTampil(["Z"], ["A", "B"])).toEqual(["Z", "A", "B"]);
    expect(alihkanSemuaTampil(["Z", "A", "B"], ["A", "B"])).toEqual(["Z"]);
    expect(alihkanSemuaTampil(["A"], [])).toEqual(["A"]);
    expect(alihkanSatu(["A", "B"], "A")).toEqual(["B"]);
    expect(alihkanSatu(["B"], "A")).toEqual(["B", "A"]);
  });
});
