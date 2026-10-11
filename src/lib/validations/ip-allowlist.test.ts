import { describe, expect, test } from "bun:test";
import {
  ipMatchesAllowlist,
  normalizeIpEntry,
  parseIpAllowlist,
  serializeIpAllowlist,
  validateIpAllowlistEntries,
} from "@/lib/validations/ip-allowlist";

/**
 * Vektor di bawah dieja ULANG PERSIS pada modul test `scanner.rs`.
 *
 * Itulah satu-satunya cara paritas dua implementasi ini dijaga: daftar IP yang
 * sama dibaca server Web (TypeScript) dan terminal Desktop/Mobile (Rust), dan
 * perbedaan penilaian sekecil apa pun akan tampak sebagai "scan yang sama
 * diterima di satu terminal, ditolak di terminal lain" tanpa pesan apa pun.
 */
describe("normalizeIpEntry", () => {
  test("menerima alamat dan blok yang sah", () => {
    expect(normalizeIpEntry("192.168.1.20")).toBe("192.168.1.20");
    expect(normalizeIpEntry("  10.0.0.5  ")).toBe("10.0.0.5");
    expect(normalizeIpEntry("192.168.1.0/24")).toBe("192.168.1.0/24");
    expect(normalizeIpEntry("0.0.0.0/0")).toBe("0.0.0.0/0");
    expect(normalizeIpEntry("2001:DB8::1")).toBe("2001:db8::1");
    expect(normalizeIpEntry("2001:db8:0:0:0:0:0:1/64")).toBe("2001:db8::1/64");
    expect(normalizeIpEntry("::ffff:192.168.1.1")).toBe("::ffff:192.168.1.1");
    expect(normalizeIpEntry("::")).toBe("::");
    expect(normalizeIpEntry("::1")).toBe("::1");
    // Rust modern hanya memendekkan alamat IPv4-MAPPED; alamat IPv4-compatible
    // tetap ditulis heksadesimal. Diverifikasi lewat vektor kembar di scanner.rs.
    expect(normalizeIpEntry("::c0a8:101")).toBe("::c0a8:101");
  });

  test("menolak bentuk yang tidak valid", () => {
    expect(normalizeIpEntry("")).toBeNull();
    expect(normalizeIpEntry("   ")).toBeNull();
    expect(normalizeIpEntry("bukan-ip")).toBeNull();
    expect(normalizeIpEntry("256.1.1.1")).toBeNull();
    expect(normalizeIpEntry("192.168.1")).toBeNull();
    // Angka berawalan nol ditolak Rust, jadi ditolak juga di sini.
    expect(normalizeIpEntry("01.2.3.4")).toBeNull();
    expect(normalizeIpEntry("192.168.1.0/33")).toBeNull();
    expect(normalizeIpEntry("2001:db8::1/129")).toBeNull();
    expect(normalizeIpEntry("fe80::1%eth0")).toBeNull();
  });
});

describe("parseIpAllowlist", () => {
  test("membaca JSON array dan membuang entri sampah", () => {
    expect(
      parseIpAllowlist('["192.168.1.0/24","bukan-ip","10.0.0.5","10.0.0.5"]'),
    ).toEqual(["192.168.1.0/24", "10.0.0.5"]);
  });

  test("membaca teks bebas dipisah koma atau baris", () => {
    expect(parseIpAllowlist("192.168.1.20, 10.0.0.5\n172.16.0.0/12")).toEqual([
      "192.168.1.20",
      "10.0.0.5",
      "172.16.0.0/12",
    ]);
  });

  test("nilai kosong menghasilkan daftar kosong", () => {
    expect(parseIpAllowlist("")).toEqual([]);
    expect(parseIpAllowlist(null)).toEqual([]);
    expect(parseIpAllowlist("[]")).toEqual([]);
  });
});

describe("ipMatchesAllowlist", () => {
  const allowlist = ["192.168.1.0/24", "10.0.0.5", "2001:db8::/32"];

  test("cocok pada alamat tunggal dan di dalam blok", () => {
    expect(ipMatchesAllowlist(["192.168.1.77"], allowlist)).toBe(true);
    expect(ipMatchesAllowlist(["10.0.0.5"], allowlist)).toBe(true);
    expect(ipMatchesAllowlist(["2001:db8:1234::9"], allowlist)).toBe(true);
  });

  test("tidak cocok di luar blok, beda keluarga, atau daftar kosong", () => {
    expect(ipMatchesAllowlist(["192.168.2.77"], allowlist)).toBe(false);
    expect(ipMatchesAllowlist(["10.0.0.6"], allowlist)).toBe(false);
    expect(ipMatchesAllowlist(["2001:dbf::1"], allowlist)).toBe(false);
    // IPv4 tidak boleh cocok dengan blok IPv6 dan sebaliknya.
    expect(ipMatchesAllowlist(["192.168.1.77"], ["2001:db8::/32"])).toBe(false);
    expect(ipMatchesAllowlist(["2001:db8::1"], ["192.168.1.0/24"])).toBe(false);
    // Fail-closed: tanpa alamat terdeteksi atau tanpa daftar, tidak ada yang lolos.
    expect(ipMatchesAllowlist([], allowlist)).toBe(false);
    expect(ipMatchesAllowlist(["192.168.1.77"], [])).toBe(false);
  });

  test("cukup satu alamat perangkat yang cocok", () => {
    expect(ipMatchesAllowlist(["203.0.113.9", "192.168.1.77"], allowlist)).toBe(
      true,
    );
  });

  test("prefix /0 mencakup seluruh keluarga alamatnya", () => {
    expect(ipMatchesAllowlist(["203.0.113.9"], ["0.0.0.0/0"])).toBe(true);
    expect(ipMatchesAllowlist(["2001:db8::1"], ["0.0.0.0/0"])).toBe(false);
  });
});

describe("serializeIpAllowlist", () => {
  test("menyimpan bentuk kanonik tanpa duplikat", () => {
    expect(
      serializeIpAllowlist(["192.168.1.20", " 192.168.1.20 ", "bukan-ip"]),
    ).toBe('["192.168.1.20"]');
  });
});

describe("validateIpAllowlistEntries", () => {
  test("menandai entri yang salah dengan indeksnya", () => {
    const errors = validateIpAllowlistEntries(["192.168.1.20", "salah"]);
    expect(errors["entry-0"]).toBeUndefined();
    expect(errors["entry-1"]).toContain("Format IP tidak valid");
  });
});
