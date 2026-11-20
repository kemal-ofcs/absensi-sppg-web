import { describe, expect, test } from "bun:test";
import { eventImportKembar } from "./import-kembar";

describe("eventImportKembar", () => {
  const baris = (event_key: string, ubah: Record<string, unknown> = {}) => ({
    event_key,
    tanggal: "2026-11-18",
    id_unik: "K001",
    jam_masuk: "07:00",
    jam_pulang: "15:00",
    status_kehadiran: "Hadir",
    status_proses: "Sudah Diproses",
    ...ubah,
  });

  test("dua baris berhasil yang identik ditandai keduanya", () => {
    expect([...eventImportKembar([baris("A"), baris("B")])].sort()).toEqual([
      "A",
      "B",
    ]);
  });

  test("jam berbeda, baris gagal, atau baris tunggal tidak ditandai", () => {
    const hasil = eventImportKembar([
      baris("A"),
      baris("B", { jam_pulang: "16:00" }),
      baris("C", { status_proses: "Gagal" }),
    ]);
    expect(hasil.size).toBe(0);
  });
});
