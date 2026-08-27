import { describe, expect, test } from "bun:test";

import {
  describeProvider,
  isPrivateNetworkHost,
  normalizeProvider,
  reviewDatabaseEndpoint,
} from "@/lib/validations/database-endpoint";

describe("isPrivateNetworkHost", () => {
  test("mengenali seluruh rentang jaringan privat yang lazim di kantor", () => {
    for (const host of [
      "localhost",
      "127.0.0.1",
      "10.0.2.2",
      "10.1.2.3",
      "192.168.1.10",
      "172.16.0.1",
      "172.31.255.254",
      "169.254.1.1",
      "nas.local",
      "server.lan",
      "::1",
    ]) {
      expect(isPrivateNetworkHost(host)).toBe(true);
    }
  });

  test("tidak menganggap alamat publik sebagai jaringan privat", () => {
    // 172.32.x.x berada tepat di luar blok RFC1918 /12 — batas inilah yang
    // paling sering salah diimplementasikan.
    for (const host of [
      "db.turso.io",
      "203.0.113.10",
      "172.32.0.1",
      "172.15.255.255",
      "8.8.8.8",
      "192.169.1.1",
    ]) {
      expect(isPrivateNetworkHost(host)).toBe(false);
    }
  });
});

describe("reviewDatabaseEndpoint", () => {
  test("menerima alamat LAN ber-HTTP untuk server sendiri", () => {
    const review = reviewDatabaseEndpoint(
      "http://192.168.1.10:8080",
      "self_hosted",
    );
    expect(review.valid).toBe(true);
    expect(review.privateNetwork).toBe(true);
    expect(review.plaintext).toBe(true);
    // Server libSQL di LAN lazim berjalan tanpa autentikasi sama sekali.
    expect(review.tokenRequired).toBe(false);
  });

  test("menolak HTTP publik untuk server sendiri sampai pengguna mengizinkannya", () => {
    const blocked = reviewDatabaseEndpoint(
      "http://203.0.113.10:8080",
      "self_hosted",
    );
    expect(blocked.valid).toBe(false);
    expect(blocked.issue?.code).toBe("INSECURE_PUBLIC");

    const allowed = reviewDatabaseEndpoint(
      "http://203.0.113.10:8080",
      "self_hosted",
      true,
    );
    expect(allowed.valid).toBe(true);
  });

  test("izin transport tidak berlaku untuk Turso terkelola", () => {
    const review = reviewDatabaseEndpoint(
      "http://203.0.113.10:8080",
      "turso",
      true,
    );
    expect(review.valid).toBe(false);
  });

  test("server sendiri ber-HTTPS publik tetap mewajibkan token", () => {
    const review = reviewDatabaseEndpoint(
      "https://db.kantor-anda.com",
      "self_hosted",
    );
    expect(review.valid).toBe(true);
    expect(review.tokenRequired).toBe(true);
  });

  test("menerima ejaan libsql:// dan ws:// sebagai endpoint yang sama", () => {
    expect(reviewDatabaseEndpoint("libsql://db.turso.io", "turso").valid).toBe(
      true,
    );
    expect(
      reviewDatabaseEndpoint("ws://192.168.1.10:8080", "self_hosted").valid,
    ).toBe(true);
    expect(
      reviewDatabaseEndpoint("wss://db.kantor-anda.com", "self_hosted").valid,
    ).toBe(true);
  });

  test("menolak URL kosong, skema asing, dan kredensial tertanam", () => {
    expect(reviewDatabaseEndpoint("   ", "turso").issue?.code).toBe("EMPTY");
    expect(
      reviewDatabaseEndpoint("ftp://db.turso.io", "turso").issue?.code,
    ).toBe("SCHEME");
    expect(
      reviewDatabaseEndpoint("https://user:rahasia@db.turso.io", "turso").issue
        ?.code,
    ).toBe("CREDENTIALS");
  });
});

describe("normalizeProvider", () => {
  test("nilai asing jatuh ke provider dengan aturan paling ketat", () => {
    expect(normalizeProvider("self_hosted")).toBe("self_hosted");
    expect(normalizeProvider("turso")).toBe("turso");
    expect(normalizeProvider(undefined)).toBe("turso");
    expect(normalizeProvider("postgres")).toBe("turso");
  });

  test("deskripsi provider selalu tersedia", () => {
    expect(describeProvider("self_hosted").tokenAlwaysRequired).toBe(false);
    expect(describeProvider("turso").tokenAlwaysRequired).toBe(true);
  });
});
